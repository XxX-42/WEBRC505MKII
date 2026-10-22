import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { activateLcdAction, findLcdField, lcdScreen } from './uiHelpers';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;

test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware bridge simulation target.');

test('Native LCD saves a revision-consistent PCM project to one of the 99 browser-local slots', async ({ page }) => {
  if (!simulationHost) return;
  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  let hostExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const hostStderr: string[] = [];
  const browserErrors: string[] = [];
  try {
    host = spawn(simulationHost, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    host.stderr?.on('data', (chunk: Buffer) => hostStderr.push(chunk.toString()));
    host.once('error', (error) => { hostStartError = error; });
    host.once('exit', (code, signal) => { hostExit = { code, signal }; });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
    page.on('requestfailed', (request) => browserErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));

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
    await page.goto('/?audio=native');
    const strip = page.locator('[data-track-id="1"]');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    const recordButton = strip.getByLabel('Record or play track');
    await recordButton.evaluate((button: HTMLElement) => button.click());
    await expect(strip.locator('.track-state')).toHaveText('RECORD');
    await page.waitForTimeout(250);
    await recordButton.evaluate((button: HTMLElement) => button.click());
    await expect(strip.locator('.track-state')).toHaveText('STOP');

    const before = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:17755/v1/status');
      const status = await response.json() as { nativeTracks: Array<{ trackId: number; state: string; contentRevision?: number }> };
      return status.nativeTracks.map((track) => ({ ...track }));
    });
    expect(before).toHaveLength(5);
    expect(before[0]).toMatchObject({ trackId: 1, state: 'Stopped' });
    expect(Number.isSafeInteger(before[0]?.contentRevision)).toBe(true);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(lcdScreen(page)).toBeVisible();
    await activateLcdAction(page, 'memory-save');
    await expect(lcdScreen(page)).toContainText(/MEMORY|PROJECT/i);

    page.once('dialog', (dialog) => { void dialog.accept('Native Snapshot'); });
    await activateLcdAction(page, 'memory-name');
    await activateLcdAction(page, 'memory-save-slot');
    try {
      await expect(lcdScreen(page)).toContainText(/SAVED SLOT 01|SAVE FAILED/, { timeout: 20_000 });
    } catch (error) {
      await test.info().attach('native-save-diagnostics.txt', {
        body: JSON.stringify({ hostExit, hostStderr, browserErrors, health: await fetch('http://127.0.0.1:17755/health').then(async (response) => ({ status: response.status, body: await response.text() })).catch((error) => String(error)) }, null, 2),
        contentType: 'application/json',
      });
      throw error;
    }
    expect(hostExit, 'Native host exited while the LCD was saving project memory').toBeUndefined();
    await expect(lcdScreen(page)).toContainText('SAVED SLOT 01 · Native Snapshot');
    await expect(await findLcdField(page, 'memory-load-slot').then((field) => field.locator('button'))).toBeEnabled();

    const saved = await page.evaluate(async () => {
      const open = indexedDB.open('webrc505-project-memory', 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const transaction = database.transaction(['slot-metadata', 'slot-payloads'], 'readonly');
      const metadataRequest = transaction.objectStore('slot-metadata').get(1);
      const payloadRequest = transaction.objectStore('slot-payloads').get(1);
      const [metadata, payload] = await Promise.all([
        new Promise<any>((resolve, reject) => { metadataRequest.onsuccess = () => resolve(metadataRequest.result); metadataRequest.onerror = () => reject(metadataRequest.error); }),
        new Promise<any>((resolve, reject) => { payloadRequest.onsuccess = () => resolve(payloadRequest.result); payloadRequest.onerror = () => reject(payloadRequest.error); }),
      ]);
      database.close();
      const bytes = new Uint8Array(payload.archive as ArrayBuffer);
      const manifestLength = new DataView(bytes.buffer).getUint32(8, true);
      const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLength))) as {
        format: string; version: number; project: { name: string; bpm: number }; tracks: Array<null | { frameCount: number; channels: number; sha256: string }>;
      };
      return {
        metadata,
        byteLength: bytes.byteLength,
        manifest,
        firstTrackHash: manifest.tracks[0]?.sha256,
        firstTrackFrames: manifest.tracks[0]?.frameCount,
      };
    });
    expect(saved.metadata).toMatchObject({ slot: 1, name: 'Native Snapshot', bpm: 120, archiveBytes: saved.byteLength });
    expect(saved.manifest).toMatchObject({ format: 'rc505-project-archive', version: 1, project: { name: 'Native Snapshot', bpm: 120 } });
    expect(saved.manifest.tracks).toHaveLength(5);
    expect(saved.manifest.tracks[0]).toMatchObject({ channels: 2 });
    expect(saved.manifest.tracks[0]?.frameCount).toBeGreaterThan(0);
    expect(saved.manifest.tracks.slice(1)).toEqual([null, null, null, null]);

    const after = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:17755/v1/status');
      return (await response.json()).nativeTracks as Array<{ trackId: number; state: string; contentRevision?: number }>;
    });
    expect(after.map((track) => track.contentRevision)).toEqual(before.map((track) => track.contentRevision));
    expect(after[0]).toMatchObject({ trackId: 1, state: 'Stopped' });

    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(await findLcdField(page, 'memory-load').then((field) => field.locator('button'))).toBeEnabled();
    await activateLcdAction(page, 'memory-load');
    await expect(lcdScreen(page)).toContainText(/MEMORY · PCM\/TEMPO/);

    await page.evaluate(async () => {
      const { AudioEngine } = await import('/src/audio/AudioEngine.ts');
      await AudioEngine.getInstance().clearTrack(1);
    });
    const cleared = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:17755/v1/status');
      return (await response.json()).nativeTracks as Array<{ trackId: number; state: string; contentRevision?: number }>;
    });
    expect(cleared[0]).toMatchObject({ trackId: 1, state: 'Empty' });
    expect(cleared[0]?.contentRevision).toBeGreaterThan(after[0]?.contentRevision ?? -1);

    await activateLcdAction(page, 'memory-load-slot');
    await expect(lcdScreen(page)).toContainText('LOADED Native Snapshot · 1/5 LOOPS', { timeout: 20_000 });
    const restored = await page.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:17755/v1/export/loop-snapshot?trackId=1');
      if (!response.ok) throw new Error(`Restored Native snapshot returned HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      const status = await (await fetch('http://127.0.0.1:17755/v1/status')).json() as {
        nativeTracks: Array<{ trackId: number; state: string; contentRevision?: number }>;
      };
      return {
        hash,
        frames: Number(response.headers.get('X-Native-Loop-Frame-Count')),
        channels: Number(response.headers.get('X-Native-Loop-Channels')),
        track: status.nativeTracks.find((track) => track.trackId === 1),
        otherStates: status.nativeTracks.filter((track) => track.trackId !== 1).map((track) => track.state),
      };
    });
    expect(restored.hash).toBe(saved.firstTrackHash);
    expect(restored.frames).toBe(saved.firstTrackFrames);
    expect(restored.channels).toBe(2);
    expect(restored.track?.state).toBe('Stopped');
    expect(restored.track?.contentRevision).toBeGreaterThan(cleared[0]?.contentRevision ?? -1);
    expect(restored.otherStates).toEqual(['Empty', 'Empty', 'Empty', 'Empty']);
  } finally {
    if (host && host.exitCode === null) {
      host.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        host?.once('exit', () => resolve());
        setTimeout(() => resolve(), 2_000);
      });
    }
  }
});
