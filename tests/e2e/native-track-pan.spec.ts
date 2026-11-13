import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { findLcdField, setLcdRange } from './uiHelpers';

const executable = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
const host = 'http://127.0.0.1:18755';
const status = async () => {
  const response = await fetch(`${host}/v1/status`);
  expect(response.ok).toBe(true);
  return response.json();
};
const test = base.extend<{ nativeHost: void }>({
  nativeHost: async ({ page }, use) => {
    expect(await fetch(`${host}/health`).then(() => true).catch(() => false)).toBe(false);
    let child: ChildProcess | undefined;
    try {
      child = spawn(executable!, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, stdio: 'ignore', windowsHide: true });
      let startError: Error | undefined;
      child.on('error', error => { startError = error; });
      await expect.poll(async () => {
        if (startError) throw startError;
        if (child!.exitCode !== null) throw new Error(`Simulation host exited ${child!.exitCode}`);
        return fetch(`${host}/health`).then(response => response.ok).catch(() => false);
      }).toBe(true);
      await page.goto('/?audio=native&ui=classic');
      await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY');
      expect((await status()).nativeTracks.every((track: any) => track.pan?.law === 'webaudio-stereo-v1')).toBe(true);
      await use();
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit'); child.kill(); await exited;
      }
    }
  },
});
test.skip(!executable, 'Requires the current-source no-device Native simulation host.');

async function openPan(page: Page, trackId: number) {
  await page.locator(`.track-strip[data-track-id="${trackId}"] [data-track-control="select"]`).click();
  return findLcdField(page, 'track-pan');
}
async function pcmHash() {
  const response = await fetch(`${host}/v1/export/loop-snapshot?trackId=1`);
  expect(response.ok).toBe(true);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);
  return createHash('sha256').update(bytes).digest('hex');
}

test('Classic Native PAN confirms the selected track and Memory restores PAN without modifying recorded PCM', async ({ page, nativeHost }) => {
  void nativeHost;
  await page.setViewportSize({ width: 1920, height: 1080 });
  if ((await status()).nativeMemory.loopSync[0]) {
    const response = await fetch(`${host}/v1/record/loop-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: 1, enabled: false }) });
    expect(response.ok, await response.text()).toBe(true);
  }
  if ((await status()).nativeRecordPlay.quantize !== 'OFF') {
    const response = await fetch(`${host}/v1/record/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantize: 'OFF' }) });
    expect(response.ok, await response.text()).toBe(true);
  }
  await expect.poll(async () => (await status()).nativeMemory.loopSync[0]).toBe(false);
  const strip = page.locator('.track-strip[data-track-id="1"]');
  await strip.locator('[data-panel-control="record-play"]').click();
  await expect(strip.locator('.track-state')).toHaveText('RECORD');
  await strip.locator('.stop-disc').click();
  await expect(strip.locator('.track-state')).toHaveText('STOP');
  const before = await pcmHash();
  const first = await openPan(page, 1);
  await setLcdRange(page, 'track-pan', 35);
  await expect.poll(async () => {
    const pan = (await status()).nativeTracks[0].pan;
    return [pan.applied, pan.requestedRevision === pan.appliedRevision];
  }).toEqual([35, true]);
  await expect(first).toContainText('R35');
  const second = await openPan(page, 2);
  await setLcdRange(page, 'track-pan', -25);
  await expect.poll(async () => (await status()).nativeMemory.trackPans).toEqual([35, -25, 0, 0, 0]);
  await expect(second).toContainText('L25');
  expect(await pcmHash()).toBe(before);
  const restored = await page.evaluate(async () => {
    const load = new Function('s', 'return import(s)') as (specifier: string) => Promise<any>;
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    const facade = AudioEngine.getInstance();
    const runtime = facade.nativeEngine.createRc505MemoryRuntime();
    const saved = await runtime.capture();
    if (saved.semantics.fields['track.1.pan'].value !== 35 || saved.semantics.fields['track.2.pan'].value !== -25) throw new Error('PAN was not captured from acknowledged readback.');
    await facade.setNativeTrackPan(1, 0); await facade.setNativeTrackPan(2, 0);
    const prepared = await runtime.prepare(saved, runtime.revision());
    try { await prepared.commit(); } finally { await prepared.dispose(); }
    return [facade.getNativeTrackPanStatus(1)?.applied, facade.getNativeTrackPanStatus(2)?.applied];
  });
  expect(restored).toEqual([35, -25]);
  expect(await pcmHash()).toBe(before);
  expect((await status()).nativeTracks[0].state).toBe('Stopped');
  await expect(await openPan(page, 1)).toContainText('R35');
  await page.screenshot({ path: path.join(tmpdir(), 'rc505-pan-native-simulation-1920.png'), fullPage: true });
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(await findLcdField(page, 'track-pan')).toContainText('R35');
  expect((await status()).nativeMemory.trackPans).toEqual([35, -25, 0, 0, 0]);
  await page.screenshot({ path: path.join(tmpdir(), 'rc505-pan-native-simulation-1366.png'), fullPage: true });
});

test('a lost PAN submission blocks Memory across reload and only an explicit new edit resolves it', async ({ page, nativeHost }) => {
  void nativeHost;
  let submissions = 0;
  await page.route('**/v1/native-track-pan/config', async route => { submissions += 1; await route.abort('failed'); });
  const field = await openPan(page, 1);
  await field.locator('input[type="range"]').evaluate(element => {
    const input = element as HTMLInputElement; input.value = '-30';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => submissions).toBe(1);
  await expect(page.locator('.lcd-status')).toContainText(/unknown/i);
  expect((await status()).nativeTracks[0].pan.applied).toBe(0);
  const canSwitch = async () => page.evaluate(async () => {
    const load = new Function('s', 'return import(s)') as (specifier: string) => Promise<any>;
    const { AudioEngine } = await load('/src/audio/AudioEngine.ts');
    return AudioEngine.getInstance().nativeEngine.createRc505MemoryRuntime().canSwitch().allowed;
  });
  expect(await canSwitch()).toBe(false);
  await page.reload();
  await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY');
  expect(await canSwitch()).toBe(false);
  expect(submissions).toBe(1);
  await page.unroute('**/v1/native-track-pan/config');
  await openPan(page, 1);
  await setLcdRange(page, 'track-pan', 20);
  await expect.poll(async () => (await status()).nativeTracks[0].pan.applied).toBe(20);
  await expect.poll(canSwitch).toBe(true);
});
