import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test as base, expect, type Page } from '@playwright/test';
import { setLcdBoolean, setLcdRange } from './uiHelpers';

const executable = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
const url = 'http://127.0.0.1:18755';
const status = async () => {
  const response = await fetch(`${url}/v1/status`);
  expect(response.ok).toBe(true);
  return response.json();
};
const test = base.extend<{ nativeHost: void }>({
  nativeHost: async ({ page }, use) => {
    expect(await fetch(`${url}/health`).then(() => true).catch(() => false), 'Isolated bridge port must be free').toBe(false);
    let child: ChildProcess | undefined;
    try {
      child = spawn(executable!, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, stdio: 'ignore', windowsHide: true });
      let startError: Error | undefined;
      child.on('error', error => { startError = error; });
      await expect.poll(async () => {
        if (startError) throw startError;
        if (child!.exitCode !== null) throw new Error(`Simulation host exited: ${child!.exitCode}`);
        return fetch(`${url}/health`).then(response => response.ok).catch(() => false);
      }).toBe(true);
      await page.goto('/?audio=native&ui=classic');
      await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY');
      expect((await status()).nativeAutoRec?.available).toBe(true);
      // Fixture setup uses real bridge writes; the AUTO REC journey below uses Classic controls.
      for (let trackId = 1; trackId <= 5; trackId += 1) {
        if (!(await status()).nativeMemory.loopSync[trackId - 1]) continue;
        const response = await fetch(`${url}/v1/record/loop-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId, enabled: false }) });
        expect(response.ok).toBe(true);
        await expect.poll(async () => (await status()).nativeMemory.loopSync[trackId - 1]).toBe(false);
      }
      if ((await status()).nativeRecordPlay.quantize !== 'OFF') {
        expect((await fetch(`${url}/v1/record/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantize: 'OFF' }) })).ok).toBe(true);
      }
      await expect.poll(async () => (await status()).nativeRecordPlay.quantize).toBe('OFF');
      await use();
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  },
});
test.skip(!executable, 'Requires a current-source no-hardware Native simulation host.');

async function configure(page: Page, sensitivity: number) {
  await page.getByRole('button', { name: 'Open loop settings', exact: true }).click();
  await page.locator('[data-panel-control="screen-encoder-2"]').click();
  await setLcdBoolean(page, 'auto-rec-sw', true);
  await setLcdRange(page, 'auto-rec-sens', sensitivity);
  await expect.poll(async () => {
    const settings = (await status()).nativeAutoRec.settings;
    return [settings.enabled, settings.sensitivity, settings.requestedRevision === settings.appliedRevision];
  }).toEqual([true, sensitivity, true]);
}

test('Classic Native AUTO REC waits below threshold and cancels its exact arm without PCM', async ({ page, nativeHost }) => {
  void nativeHost;
  await configure(page, 1); // Simulation input peak 0.1 is below the 0.251 software threshold.
  const strip = page.locator('.track-strip[data-track-id="1"]');
  await strip.locator('[data-panel-control="record-play"]').click();
  await expect(strip.locator('.track-state')).toHaveText('STANDBY');
  const armed = (await status()).nativeAutoRec.tracks[0];
  expect(armed.armRequestedRevision).toBeGreaterThan(0);
  expect(armed.armAppliedRevision).toBe(armed.armRequestedRevision);
  expect(armed.armed).toBe(true);
  const before = await status();
  expect(before.nativeTracks[0].state).toBe('Empty');
  expect(before.nativeTracks[0].loopLengthSamples).toBe(0);
  await strip.locator('.stop-disc').click();
  await expect(strip.locator('.track-state')).toHaveText('EMPTY');
  await expect.poll(async () => {
    const value = (await status()).nativeAutoRec.tracks[0];
    return [value.armed, value.cancelAppliedRevision];
  }).toEqual([false, armed.armRequestedRevision]);
  expect((await status()).nativeTracks.every((track: any) => track.state === 'Empty' && track.loopLengthSamples === 0)).toBe(true);
});

test('Classic Native AUTO REC triggers on simulation input and stops one captured take', async ({ page, nativeHost }) => {
  void nativeHost;
  await configure(page, 100);
  const strip = page.locator('.track-strip[data-track-id="1"]');
  await strip.locator('[data-panel-control="record-play"]').click();
  await expect(strip.locator('.track-state')).toHaveText('RECORD');
  const triggered = (await status()).nativeAutoRec.tracks[0];
  expect(triggered.triggerAppliedRevision).toBe(triggered.armRequestedRevision);
  expect(triggered.triggerAppliedRevision).toBeGreaterThan(0);
  expect(triggered.armed).toBe(false);
  await strip.locator('.stop-disc').click();
  await expect(strip.locator('.track-state')).toHaveText('STOP');
  const stopped = await status();
  expect(stopped.nativeTracks[0].loopLengthSamples).toBeGreaterThan(0);
  expect(stopped.nativeTracks.slice(1).every((track: any) => track.state === 'Empty')).toBe(true);
  const snapshot = await page.evaluate(async (host) => {
    const load = new Function('s', 'return import(s)') as (specifier: string) => Promise<any>;
    const { NativeBridgeClient } = await load('/src/audio/NativeBridgeClient.ts');
    const value = await new NativeBridgeClient(host).getLoopSnapshot(1);
    let peak = 0;
    let finite = true;
    for (const sample of value.samples) { finite &&= Number.isFinite(sample); peak = Math.max(peak, Math.abs(sample)); }
    return { frames: value.frameCount, channels: value.channels, finite, peak };
  }, url);
  expect(snapshot.frames).toBeGreaterThan(0);
  expect(snapshot.channels).toBe(2);
  expect(snapshot.finite).toBe(true);
  expect(snapshot.peak).toBeGreaterThan(0.01);
});
