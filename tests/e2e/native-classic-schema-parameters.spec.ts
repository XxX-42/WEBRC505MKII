import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { findLcdField, openLcdPage, selectLcdEnum, setLcdRange } from './uiHelpers';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-audio Native simulation host.');

test('default Classic LCD exposes Native Input and shared Track named controls with restart and ACK status', async ({ page }) => {
  if (!simulationHost) return;
  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  const hostStderr: string[] = [];
  const browserErrors: string[] = [];
  try {
    host = spawn(simulationHost, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    host.stderr?.on('data', (chunk: Buffer) => hostStderr.push(chunk.toString()));
    host.once('error', (error) => { hostStartError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (hostStartError) throw hostStartError;
      if (host.exitCode !== null) throw new Error(`Native simulation host exited early with code ${host.exitCode}`);
      try {
        const response = await fetch('http://127.0.0.1:17755/health');
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(ready, 'Native simulation host did not start on 127.0.0.1:17755').toBe(true);
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
    await page.goto('/?audio=native');
    await expect(page.locator('.app-root')).toHaveAttribute('data-ui-style', 'classic');
    await expect(page.getByTestId('rc505-physical-face')).toBeVisible();
    await expect(page.locator('.top-panel')).toHaveCount(0);
    await expect(page.locator('.status-pill')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    const readRuntime = (path: 'input' | 'track') => page.evaluate(async (target) => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      return AudioEngine.getInstance().getNativeCatalogFxSlotStatus(target, 0);
    }, path);
    const stored = (path: 'input' | 'track') => page.evaluate((target) => {
      const state = JSON.parse(localStorage.getItem('webrc505_native_fx_catalog') ?? '{}');
      const bank = target === 'input' ? state.inputSlots : state.trackSlots;
      return bank?.[0]?.namedParametersByType?.PHASER ?? null;
    }, path);

    await openLcdPage(page, 'input-fx-edit-button');
    await selectLcdEnum(page, 'type', 'PHASER');
    await expect.poll(async () => (await readRuntime('input'))?.pendingRestart).toBe(true);
    await expect(page.locator('.lcd-status')).toContainText('APPLY FX');

    await openLcdPage(page, 'track-fx-edit-button');
    await selectLcdEnum(page, 'target', 'SHARED BANK');
    await selectLcdEnum(page, 'type', 'PHASER');
    await expect.poll(async () => (await readRuntime('track'))?.pendingRestart).toBe(true);
    await expect(page.locator('.lcd-status')).toContainText('APPLY FX');

    const appMenu = page.locator('details.app-menu');
    await appMenu.locator(':scope > summary').click();
    await appMenu.getByRole('button', { name: 'RESTART NATIVE / APPLY FX' }).click();
    await expect(page.locator('.status-pill')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    await expect.poll(async () => {
      const input = await readRuntime('input');
      const track = await readRuntime('track');
      return Boolean(input?.acknowledged && input.acknowledgedEffectId === 'phaser' && !input.pendingApply &&
        track?.acknowledged && track.acknowledgedEffectId === 'phaser' && !track.pendingApply);
    }, { timeout: 20_000 }).toBe(true);

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
    expect(browserErrors).toEqual([]);
    expect(host.exitCode, `Native host exited unexpectedly: ${hostStderr.join('')}`).toBeNull();
  } catch (error) {
    await test.info().attach('native-classic-schema-controls-diagnostics.json', {
      body: JSON.stringify({ hostStartError: hostStartError?.message, hostExitCode: host?.exitCode, hostStderr, browserErrors }, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    if (host && host.exitCode === null) host.kill();
  }
});
