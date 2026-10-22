import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;

test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware bridge simulation target.');

test('Native ProjectMemory import resolves after host commit and leaves imported PCM stopped', async ({ page }) => {
  if (!simulationHost) return;

  let host: ChildProcess | undefined;
  let hostStartError: Error | undefined;
  let hostExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const hostStderr: string[] = [];
  try {
    host = spawn(simulationHost, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    host.stderr?.on('data', (chunk: Buffer) => hostStderr.push(chunk.toString()));
    host.once('error', (error) => { hostStartError = error; });
    host.once('exit', (code, signal) => { hostExit = { code, signal }; });

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
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    const result = await page.evaluate(async () => {
      const loadModule = (specifier: string) =>
        (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
      const [{ AudioEngine }, { ProjectMemory }, { encodeProjectArchive }] = await Promise.all([
        loadModule('/src/audio/AudioEngine.ts'),
        loadModule('/src/audio/projectMemory.ts'),
        loadModule('/src/audio/projectArchive.ts'),
      ]);
      const root = document.querySelector('.app-root') as (HTMLElement & { __vueParentComponent?: any }) | null;
      const engine = root?.__vueParentComponent?.setupState?.engine ?? AudioEngine.getInstance();
      if (engine.getMode() !== 'native') throw new Error(`Expected Native audio mode, got ${engine.getMode()}`);

      const originalFetch = window.fetch.bind(window);
      const importTransitions: Array<{ generation: number; state: string }> = [];
      const timeline: string[] = [];
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await originalFetch(input, init);
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes('/v1/project/import/status?')) {
          const payload = await response.clone().json() as { generation?: number; state?: string };
          if (Number.isSafeInteger(payload.generation) && typeof payload.state === 'string') {
            const generation = payload.generation as number;
            importTransitions.push({ generation, state: payload.state });
            if (payload.state === 'committed') timeline.push(`host-committed:${generation}`);
          }
        }
        return response;
      };

      const initialResponse = await originalFetch('http://127.0.0.1:17755/v1/status');
      if (!initialResponse.ok) throw new Error(`Native host status failed with HTTP ${initialResponse.status}`);
      const initial = await initialResponse.json() as {
        engineRunning: boolean;
        sampleRate: number;
        nativeTracks: Array<{ trackId: number; state: string; contentRevision: number }>;
      };
      if (!initial.engineRunning || !Number.isInteger(initial.sampleRate) || initial.nativeTracks.length !== 5) {
        throw new Error('Native simulation host did not report a running five-track engine');
      }

      const frameCount = 4_117;
      const left = new Float32Array(frameCount);
      const right = new Float32Array(frameCount);
      const interleaved = new Float32Array(frameCount * 2);
      for (let frame = 0; frame < frameCount; frame += 1) {
        left[frame] = Math.fround(Math.sin((frame + 1) * 0.0173) * 0.31);
        right[frame] = Math.fround(Math.cos((frame + 1) * 0.0231) * 0.27);
        interleaved[frame * 2] = left[frame]!;
        interleaved[frame * 2 + 1] = right[frame]!;
      }
      const archive = await encodeProjectArchive({
        name: 'Native Import E2E',
        bpm: 113,
        transport: {
          masterTrackId: null,
          measureLengthSeconds: 0,
          masterLoopLengthSamples: 0,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
        },
        tracks: [
          { sampleRate: initial.sampleRate, frameCount, channels: 2, channelData: [left, right] },
          null,
          null,
          null,
          null,
        ],
      });
      const exactArchive = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
      const file = new File([exactArchive], 'native-import.rc505proj', { type: 'application/x-rc505-project' });
      const expectedDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(interleaved.buffer));
      const expectedHash = Array.from(new Uint8Array(expectedDigest), (value) => value.toString(16).padStart(2, '0')).join('');

      timeline.push('import-started');
      const imported = await new ProjectMemory(engine).importFile(file);
      timeline.push('import-resolved');

      const statusResponse = await originalFetch('http://127.0.0.1:17755/v1/status');
      const status = await statusResponse.json() as {
        nativeTracks: Array<{ trackId: number; state: string; contentRevision: number }>;
      };
      const snapshotResponse = await originalFetch('http://127.0.0.1:17755/v1/export/loop-snapshot?trackId=1');
      if (!snapshotResponse.ok) throw new Error(`Imported Native snapshot failed with HTTP ${snapshotResponse.status}`);
      const actualFrameCount = Number(snapshotResponse.headers.get('X-Native-Loop-Frame-Count'));
      const actualChannels = Number(snapshotResponse.headers.get('X-Native-Loop-Channels'));
      const actualDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(await snapshotResponse.arrayBuffer()));
      const actualHash = Array.from(new Uint8Array(actualDigest), (value) => value.toString(16).padStart(2, '0')).join('');
      timeline.push('snapshot-verified');

      const latest = importTransitions.at(-1);
      const committedIndex = timeline.findIndex((entry) => entry === `host-committed:${latest?.generation}`);
      const resolvedIndex = timeline.indexOf('import-resolved');
      const beforeRevision = initial.nativeTracks.find((track) => track.trackId === 1)?.contentRevision;
      const afterTrack = status.nativeTracks.find((track) => track.trackId === 1);
      return {
        imported,
        expectedHash,
        actualHash,
        expectedFrameCount: frameCount,
        actualFrameCount,
        actualChannels,
        transitions: importTransitions,
        timeline,
        committedBeforeImportResolved: committedIndex >= 0 && resolvedIndex > committedIndex,
        beforeRevision,
        afterTrack,
        otherTrackStates: status.nativeTracks.filter((track) => track.trackId !== 1).map((track) => track.state),
        states: status.nativeTracks.map((track) => track.state),
      };
    });

    expect(result.imported).toEqual({ name: 'Native Import E2E', bpm: 113, tracksWithAudio: 1 });
    expect(result.transitions.length).toBeGreaterThan(0);
    expect(result.transitions.at(-1)?.state).toBe('committed');
    expect(result.committedBeforeImportResolved).toBe(true);
    expect(result.afterTrack?.contentRevision).toBeGreaterThan(result.beforeRevision ?? -1);
    expect(result.actualFrameCount).toBe(result.expectedFrameCount);
    expect(result.actualChannels).toBe(2);
    expect(result.actualHash).toBe(result.expectedHash);
    expect(result.afterTrack?.state).toBe('Stopped');
    expect(result.otherTrackStates).toEqual(['Empty', 'Empty', 'Empty', 'Empty']);
    expect(result.states.some((state) => ['Playing', 'Recording', 'Overdubbing'].includes(state))).toBe(false);
    expect(hostExit, 'Native host exited during project import').toBeUndefined();
  } catch (error) {
    await test.info().attach('native-import-diagnostics.json', {
      body: JSON.stringify({ hostExit, hostStderr }, null, 2),
      contentType: 'application/json',
    });
    throw error;
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
