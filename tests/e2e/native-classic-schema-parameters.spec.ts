import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { activateEnhancedAction, openEnhancedTools, findLcdField, openClassicFxEditor, openLcdPage, selectLcdEnum, setLcdBoolean, setLcdRange } from './uiHelpers';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-audio Native simulation host.');

test('default Classic LCD exposes Native Input and shared Track named controls with restart and ACK status', async ({ page }) => {
  // Cold loading and both FX banks must fit the default 30-second test budget.
  if (!simulationHost) return;
  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  const hostStderr: string[] = [];
  const browserErrors: string[] = [];
  try {
    host = spawn(simulationHost, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, stdio: ['ignore', 'ignore', 'pipe'] });
    host.stderr?.on('data', (chunk: Buffer) => hostStderr.push(chunk.toString()));
    host.once('error', (error) => { hostStartError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (hostStartError) throw hostStartError;
      if (host.exitCode !== null) throw new Error(`Native simulation host exited early with code ${host.exitCode}`);
      try {
        const response = await fetch('http://127.0.0.1:18755/health');
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(ready, 'Native simulation host did not start on 127.0.0.1:18755').toBe(true);
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
    await page.goto('/?audio=native');
    await expect(page.locator('.app-root')).toHaveAttribute('data-ui-style', 'classic');
    await expect(page.getByTestId('rc505-physical-face')).toBeVisible();
    await expect(page.locator('.top-panel')).toHaveCount(0);
    await expect(page.locator('.status-pill')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    for (const location of ['input', 'track'] as const) {
      for (const slot of ['a', 'b', 'c', 'd']) {
        await expect(page.getByTestId(`${location}-fx-slot-${slot}`)).toHaveAttribute('data-led-on', 'false');
      }
    }

    const readRuntime = (path: 'input' | 'track') => page.evaluate(async (target) => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      return AudioEngine.getInstance().getNativeCatalogFxSlotStatus(target, 0);
    }, path);
    const stored = (path: 'input' | 'track') => page.evaluate((target) => {
      const state = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}');
      const bank = target === 'input' ? state.inputSlots : state.trackSlots;
      return bank?.[0]?.namedParametersByType?.PHASER ?? null;
    }, path);

    await openClassicFxEditor(page, 'input');
    await selectLcdEnum(page, 'type', 'PHASER');
    await setLcdBoolean(page, 'active', true);
    await expect.poll(async () => (await readRuntime('input'))?.pendingRestart).toBe(true);
    await expect(page.locator('.lcd-status')).toContainText('APPLY IN ENHANCED');

    const screen = page.getByTestId('rc505-lcd-screen');
    const firstFxRow = screen.locator('.lcd-data-row').first();
    await page.locator('[data-panel-control="exit"]').click();
    await expect(screen).toHaveAttribute('data-classic-screen', 'memory-number');
    for (let index = 0; index < 5; index += 1) await page.locator('[data-panel-control="page-next"]').click();
    await expect(screen).toHaveAttribute('data-classic-screen', 'input-fx');
    await expect(firstFxRow).toContainText('RESTART');
    await expect(firstFxRow).not.toContainText(/PHASER|\bON\b/);

    await openClassicFxEditor(page, 'track');
    await expect(screen.locator('[data-field-key="target"]')).toHaveCount(0);
    await selectLcdEnum(page, 'type', 'PHASER');
    await setLcdBoolean(page, 'active', true);
    await expect.poll(async () => (await readRuntime('track'))?.pendingRestart).toBe(true);
    await expect(page.locator('.lcd-status')).toContainText('APPLY IN ENHANCED');

    await page.locator('[data-panel-control="exit"]').click();
    await expect(screen).toHaveAttribute('data-classic-screen', 'input-fx');
    await page.locator('[data-panel-control="page-next"]').click();
    await expect(screen).toHaveAttribute('data-classic-screen', 'track-fx');
    await expect(firstFxRow).toContainText('RESTART');
    await expect(firstFxRow).not.toContainText(/PHASER|\bON\b/);

    const tools = await openEnhancedTools(page, 'PROJECT / TOOLS');
    await activateEnhancedAction(page, 'restart-native');
    await expect(page.locator('.status-pill')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    await expect.poll(async () => {
      const input = await readRuntime('input');
      const track = await readRuntime('track');
      return Boolean(input?.acknowledged && input.acknowledgedEffectId === 'phaser' && !input.pendingApply &&
        track?.acknowledged && track.acknowledgedEffectId === 'phaser' && !track.pendingApply);
    }, { timeout: 20_000 }).toBe(true);

    await tools.getByRole('button', { name: 'CLOSE', exact: true }).click();
    await expect(tools).toHaveCount(0);
    await expect(screen).toHaveAttribute('data-classic-screen', 'track-fx');
    await expect(firstFxRow).toContainText('PHASER');
    await expect(firstFxRow).toContainText('ACK');
    for (const location of ['input', 'track'] as const) {
      const activeSlot = page.getByTestId(`${location}-fx-slot-a`);
      await expect(activeSlot).toHaveAttribute('data-led-on', 'true');
      await expect(activeSlot).toHaveAttribute('data-led-color', 'pink');
    }
    await openLcdPage(page, 'input-fx-edit-button');
    await expect(await findLcdField(page, 'native-input-0-rate_hz')).toBeVisible();
    expect(await stored('input')).toBeNull();
    await setLcdRange(page, 'native-input-0-rate_hz', 2.5);
    await expect.poll(async () => (await readRuntime('input'))?.acknowledgedParameters?.rate_hz, { timeout: 10_000 }).toBe(2.5);
    await expect.poll(async () => stored('input'), { timeout: 10_000 }).toEqual({ rate_hz: 2.5 });

    await openLcdPage(page, 'track-fx-edit-button');
    await expect(await findLcdField(page, 'native-track-0-rate_hz')).toBeVisible();
    expect(await stored('track')).toBeNull();
    await setLcdRange(page, 'native-track-0-rate_hz', 3);
    await expect.poll(async () => (await readRuntime('track'))?.acknowledgedParameters?.rate_hz, { timeout: 10_000 }).toBe(3);
    await expect.poll(async () => stored('track'), { timeout: 10_000 }).toEqual({ rate_hz: 3 });
    await expect(page.locator('.lcd-status')).toContainText('ACKNOWLEDGED');
    await expect(page.locator('.lcd-status')).not.toContainText('FX BANK ERROR');
    const sidecarRate = (location: 'input' | 'track') => page.evaluate((target) => {
      const bank = JSON.parse(localStorage.getItem(`webrc505_fx_preset_banks_v1_native_${target}`) ?? '{}');
      return bank.banks?.A?.slots?.[0]?.namedParametersByType?.PHASER?.rate_hz;
    }, location);
    await expect.poll(() => sidecarRate('input')).toBe(2.5);
    await expect.poll(() => sidecarRate('track')).toBe(3);
    await expect.poll(() => page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const engine = AudioEngine.getInstance();
      return (['input', 'track'] as const).every((location) => Array.from({ length: 4 }, (_, index) => {
        const status = engine.getNativeCatalogFxSlotStatus(location, index);
        return !!status?.acknowledged && !status.pendingApply && !status.pendingRestart && !status.error;
      }).every(Boolean));
    })).toBe(true);
    expect(browserErrors).toEqual([]);
    expect(host.exitCode, `Native host exited unexpectedly: ${hostStderr.join('')}`).toBeNull();
  } catch (error) {
    const runtimeDiagnostics = await page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      const { useRc505Controls } = await import('/src/composables/useRc505Controls.ts');
      const engine = AudioEngine.getInstance();
      const slots = (['input', 'track'] as const).map((location) => ({
        location,
        slots: Array.from({ length: 4 }, (_, index) => ({
          index,
          status: engine.getNativeCatalogFxSlotStatus(location, index),
          parameters: engine.getNativeCatalogFxParameterSnapshot(location, index, 0),
        })),
      }));
      return {
        controls: JSON.parse(JSON.stringify(useRc505Controls().state)), slots,
        storage: Object.fromEntries([
          'webrc505_fx_preset_banks_v1_native_input',
          'webrc505_fx_preset_banks_v1_native_track',
          'webrc505_native_fx_catalog',
        ].map((key) => [key, localStorage.getItem(key)])),
      };
    }).catch((diagnosticError) => ({ error: String(diagnosticError) }));
    await test.info().attach('native-classic-schema-controls-diagnostics.json', {
      body: JSON.stringify({ hostStartError: hostStartError?.message, hostExitCode: host?.exitCode, hostStderr, browserErrors, runtimeDiagnostics }, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    if (host && host.exitCode === null) host.kill();
  }
});
