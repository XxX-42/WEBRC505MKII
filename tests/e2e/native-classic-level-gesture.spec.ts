import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { findLcdField } from './uiHelpers';

const executable = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
test.skip(!executable, 'Requires the isolated Native simulation bridge.');

test('TRACK LEVEL retains encoder deltas through a delayed Native ACK', async ({ page }) => {
  let host: ChildProcess | undefined;
  let release: (() => void) | undefined;
  try {
    host = spawn(executable!, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, windowsHide: true, stdio: 'ignore' });
    await expect.poll(async () => { try { return (await fetch('http://127.0.0.1:18755/health')).ok; } catch { return false; } }).toBe(true);
    await page.goto('/?audio=native&ui=classic');
    await expect(page.locator('.status-pill')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });
    await page.locator('[data-track-id="1"] [data-track-control="select"]').click();
    const field = await findLcdField(page, 'track-level');
    await expect(field.locator('input')).toHaveValue('100');
    const writes: number[] = [];
    await page.route('**/v1/mixer/level', async route => {
      const body = route.request().postDataJSON();
      if (body.channel === 2) {
        writes.push(body.percent);
        if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
      }
      await route.continue();
    });
    const knob = page.locator('[data-panel-control="screen-encoder-1"]');
    await knob.focus(); await page.keyboard.press('ArrowUp');
    await expect.poll(() => writes).toEqual([101]);
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await expect(knob).toHaveAttribute('aria-disabled', 'false');
    await expect(field.locator('input')).toHaveValue('100');
    expect(writes).toEqual([101]);
    release!();
    await expect(field.locator('input')).toHaveValue('103');
    expect(writes).toEqual([101, 103]);
    const status = await (await fetch('http://127.0.0.1:18755/v1/status')).json();
    expect(status.mixerLevels[2]).toBe(103);
  } finally { release?.(); host?.kill(); }
});
