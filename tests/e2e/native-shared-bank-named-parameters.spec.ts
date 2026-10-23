import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-audio Native simulation host.');

test('Native Input and shared Track banks expose schema-backed controls and persist only after host ACK', async ({ page }) => {
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
    // The parameter banks live in the Tech FX panels; the default app shell is
    // the Classic LCD faceplate, which intentionally does not mount these
    // controls. Exercise the supported Tech shell explicitly.
    await page.goto('/?audio=native&ui=tech');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    const inputPanel = page.locator('.top-panel .fx-section.input-fx');
    const inputType = inputPanel.locator('.fx-slot-shell').nth(0).locator('select.fx-select');
    await inputType.selectOption('PHASER');
    const inputEditor = inputPanel.locator('[data-native-catalog-parameters]');
    await expect(inputEditor).toBeVisible();

    const trackPanel = page.locator('.top-panel .fx-section.track-fx');
    const trackType = trackPanel.locator('.fx-slot-shell').nth(0).locator('select.fx-select');
    await trackType.selectOption('PHASER');
    const trackEditor = trackPanel.locator('[data-native-catalog-parameters]');
    await expect(trackEditor).toBeVisible();

    // Native keeps type changes pending until the explicit restart action;
    // named controls must then apply to the now-acknowledged processors.
    await page.locator('.app-menu summary').click();
    await page.getByRole('button', { name: 'RESTART NATIVE / APPLY FX' }).click();
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    const readRuntime = (path: 'input' | 'track') => page.evaluate(async (target) => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      return AudioEngine.getInstance().getNativeCatalogFxSlotStatus(target, 0);
    }, path);
    // The top-level engine-ready signal precedes per-slot processor ACKs.
    // Wait for both configured banks before allowing named edits.
    await expect.poll(async () => {
      const input = await readRuntime('input');
      const track = await readRuntime('track');
      return Boolean(input?.acknowledged && input.acknowledgedEffectId === 'phaser' && !input.pendingApply &&
        track?.acknowledged && track.acknowledgedEffectId === 'phaser' && !track.pendingApply);
    }, { timeout: 20_000 }).toBe(true);
    expect(host?.exitCode, `Native host exited after restart: ${hostStderr.join('')}`).toBeNull();
    expect((await fetch('http://127.0.0.1:18755/health').then((response) => response.ok).catch(() => false)),
      `Native health failed after restart; stderr=${hostStderr.join('')}`).toBe(true);
    await inputEditor.locator('summary').click();
    await page.waitForTimeout(500);
    const healthBeforeFill = await fetch('http://127.0.0.1:18755/health').then((response) => response.ok).catch(() => false);
    expect(healthBeforeFill, `Native host unavailable before fill; stderr=${hostStderr.join('')}`).toBe(true);
    const inputRate = inputEditor.getByLabel('INPUT A · PHASER rate_hz');
    await inputRate.fill('1.75');
    // The Native host polls status continuously. A few poll cycles must not
    // reset an unsubmitted draft or persist it before an exact parameter ACK.
    await page.waitForTimeout(450);
    expect(await inputRate.inputValue()).toBe('1.75');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}')
      .inputSlots?.[0]?.namedParametersByType?.PHASER ?? null)).toBeNull();
    await inputRate.fill('2.5');
    expect(await inputRate.inputValue()).toBe('2.5');
    await inputEditor.getByRole('button', { name: 'Apply named controls' }).click();
    await expect.poll(async () => (await readRuntime('input'))?.requestedParameters.rate_hz, { timeout: 10_000 }).toBe(2.5);
    await expect.poll(async () => {
      const runtime = await readRuntime('input');
      return Boolean(runtime?.acknowledged && runtime.acknowledgedEffectId === 'phaser' && runtime.acknowledgedParameters?.rate_hz === 2.5);
    }, { timeout: 10_000 }).toBe(true);
    await expect(inputPanel.getByRole('alert')).toHaveCount(0);
    await expect(inputEditor.locator('.native-catalog-status')).toHaveText(/^NATIVE ACK/);
    await expect.poll(async () => await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}');
      return saved.inputSlots?.[0]?.namedParametersByType?.PHASER ?? null;
    }), { timeout: 10_000 }).toEqual({ rate_hz: 2.5 });

    const inputRuntime = await readRuntime('input');
    expect(inputRuntime).toMatchObject({ acknowledged: true, error: '', acknowledgedParameters: { rate_hz: 2.5 } });
    const persistedInput = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}');
      return saved.inputSlots?.[0]?.namedParametersByType?.PHASER;
    });
    expect(persistedInput).toEqual({ rate_hz: 2.5 });

    await trackEditor.locator('summary').click();
    await trackEditor.getByLabel('SHARED TRACK A · PHASER rate_hz').fill('3');
    expect(await trackEditor.getByLabel('SHARED TRACK A · PHASER rate_hz').inputValue()).toBe('3');
    await trackEditor.getByRole('button', { name: 'Apply named controls' }).click();
    await expect.poll(async () => (await readRuntime('track'))?.requestedParameters.rate_hz, { timeout: 10_000 }).toBe(3);
    await expect.poll(async () => {
      const runtime = await readRuntime('track');
      return Boolean(runtime?.acknowledged && runtime.acknowledgedEffectId === 'phaser' && runtime.acknowledgedParameters?.rate_hz === 3);
    }, { timeout: 10_000 }).toBe(true);
    await expect(trackEditor.locator('.native-catalog-status')).toHaveText(/^NATIVE ACK/);
    await expect.poll(async () => await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}');
      return saved.trackSlots?.[0]?.namedParametersByType?.PHASER ?? null;
    }), { timeout: 10_000 }).toEqual({ rate_hz: 3 });

    const trackRuntime = await readRuntime('track');
    expect(trackRuntime).toMatchObject({ acknowledged: true, error: '', acknowledgedParameters: { rate_hz: 3 } });
    const persistedBanks = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}');
      return {
        input: saved.inputSlots?.[0]?.namedParametersByType?.PHASER,
        track: saved.trackSlots?.[0]?.namedParametersByType?.PHASER,
      };
    });
    expect(persistedBanks).toEqual({ input: { rate_hz: 2.5 }, track: { rate_hz: 3 } });
    expect(browserErrors).toEqual([]);
    expect(host.exitCode).toBeNull();
  } catch (error) {
    await test.info().attach('native-shared-schema-controls-diagnostics.json', {
      body: JSON.stringify({ hostStartError: hostStartError?.message, hostExitCode: host?.exitCode, hostStderr, browserErrors }, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    if (host && host.exitCode === null) host.kill();
  }
});
