import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
const bridge = 'http://127.0.0.1:18755';
test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the no-hardware Native simulation host.');

test('Classic ALL controls recover one exact five-track batch without replay', async ({ page }) => {
  if (!simulationHost) return;
  let host: ChildProcess | undefined;
  let startError: Error | undefined;
  const requests: string[] = [];
  try {
    host = spawn(simulationHost, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' },
      stdio: ['ignore', 'ignore', 'pipe'] });
    host.once('error', error => { startError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (startError) throw startError;
      if (host.exitCode !== null) throw new Error(`Simulation host exited with ${host.exitCode}`);
      try { ready = (await fetch(`${bridge}/health`)).ok; if (ready) break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    expect(ready).toBe(true);
    await page.goto('/?audio=native');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY');

    const imported = await page.evaluate(async (hostUrl) => {
      const load = (specifier: string) => (new Function('s', 'return import(s)') as (s: string) => Promise<any>)(specifier);
      const { encodeProjectArchive } = await load('/src/audio/projectArchive.ts');
      const status = await fetch(`${hostUrl}/v1/status`).then(response => response.json());
      const tracks = Array.from({ length: 5 }, (_, index) => {
        const frameCount = 4096 + index * 67;
        const left = new Float32Array(frameCount);
        const right = new Float32Array(frameCount);
        for (let frame = 0; frame < frameCount; frame += 1) {
          left[frame] = Math.sin((frame + 1) * (index + 1) * 0.013) * 0.15;
          right[frame] = Math.cos((frame + 1) * (index + 1) * 0.017) * 0.12;
        }
        return { sampleRate: status.sampleRate, frameCount, channels: 2, channelData: [left, right] };
      });
      const archive = await encodeProjectArchive({ name: 'ALL recovery fixture', bpm: 120, tracks,
        transport: { masterTrackId: null, measureLengthSeconds: 0, masterLoopLengthSamples: 0,
          timeSignatureNumerator: 4, timeSignatureDenominator: 4 } });
      const response = await fetch(`${hostUrl}/v1/project/import?expectedContentRevision=${status.projectContentRevision}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
          'X-Native-Host-Incarnation': status.hostIncarnationId, 'X-Native-Operation-Id': crypto.randomUUID().replaceAll('-', '') },
        body: archive,
      });
      if (response.status !== 202) throw new Error(`Import rejected: ${response.status} ${await response.text()}`);
      const { generation } = await response.json();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const value = await fetch(`${hostUrl}/v1/project/import/status?generation=${generation}`,
          { headers: { 'X-Native-Host-Incarnation': status.hostIncarnationId } }).then(result => result.json());
        if (value.state === 'committed') return tracks.map(track => track.frameCount);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Five-track import did not commit');
    }, bridge);
    expect(imported).toEqual([4096, 4163, 4230, 4297, 4364]);
    await expect.poll(async () => {
      const status = await fetch(`${bridge}/v1/status`).then(response => response.json());
      return status.nativeTracks.map((track: { state: string; loopLengthSamples: number }) => [track.state, track.loopLengthSamples]);
    }).toEqual(imported.map(frameCount => ['Stopped', frameCount]));

    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/v1/transport/batch-schedule')) requests.push(request.postData() ?? '');
    });
    let blockReceipt = true;
    await page.route('**/v1/transport/batch-status', route => blockReceipt ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: 'Start all tracks' }).click();
    await expect.poll(() => requests.length).toBe(1);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('webrc.nativeTransportBatchReceipt.v1'))).not.toBeNull();
    const retained = await page.evaluate(() => JSON.parse(sessionStorage.getItem('webrc.nativeTransportBatchReceipt.v1')!));
    expect(retained).toMatchObject({ action: 'play', trackMask: 31 });
    await expect(page.getByTestId('start-audio')).toBeEnabled();
    await expect(page.getByTestId('start-audio')).toHaveText('RETRY AUDIO');
    blockReceipt = false;
    await page.getByTestId('start-audio').click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('webrc.nativeTransportBatchReceipt.v1'))).toBeNull();
    await expect.poll(async () => {
      const status = await fetch(`${bridge}/v1/status`).then(response => response.json());
      return status.nativeTracks.map((track: { state: string }) => track.state);
    }).toEqual(Array(5).fill('Playing'));
    expect(requests).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Stop all tracks' })).toBeEnabled();
    await page.getByRole('button', { name: 'Stop all tracks' }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect.poll(async () => {
      const status = await fetch(`${bridge}/v1/status`).then(response => response.json());
      return status.nativeTracks.map((track: { state: string }) => track.state);
    }).toEqual(Array(5).fill('Stopped'));
    const status = await fetch(`${bridge}/v1/status`).then(response => response.json());
    const members = status.nativeLoopFrameScheduling.requests;
    expect(members).toHaveLength(5);
    expect(members.map((member: { trackIndex: number }) => member.trackIndex + 1).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(members.map((member: { batchId: number }) => member.batchId)).size).toBe(1);
    expect(members.every((member: { batchId: number; batchMask: number }) => member.batchId > 0 && member.batchMask === 31)).toBe(true);
    expect(new Set(members.map((member: { appliedAbsoluteFrame: number }) => member.appliedAbsoluteFrame)).size).toBe(1);
    expect(members.every((member: { requestedRevision: number; appliedRevision: number; requestedAction: string }) =>
      member.requestedAction === 'stop' && member.appliedRevision === member.requestedRevision)).toBe(true);
    expect(requests.map(value => JSON.parse(value).trackMask)).toEqual([31, 31]);
  } finally {
    if (host && host.exitCode === null) host.kill();
  }
});
