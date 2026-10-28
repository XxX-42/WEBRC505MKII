import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;
const bridge = 'http://127.0.0.1:18755';

test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the 8145d4b no-hardware simulation host.');

test('Browser archive v2 survives Native simulation round trip; v1 stays unknown and old capability fails closed', async ({ page }) => {
  if (!simulationHost) return;

  let host: ChildProcess | undefined;
  try {
    host = spawn(simulationHost, [], {
      env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' },
      stdio: 'ignore',
    });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`${bridge}/health`);
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch { /* wait for the local simulation host */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ready, `8145d4b Native simulation host did not start on ${bridge}`).toBe(true);

    await page.goto('/?audio=native');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    const result = await page.evaluate(async () => {
      const loadModule = (specifier: string) =>
        (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
      const [{ AudioEngine }, { decodeProjectArchive, encodeProjectArchive }] = await Promise.all([
        loadModule('/src/audio/AudioEngine.ts'),
        loadModule('/src/audio/projectArchive.ts'),
      ]);
      const engine = AudioEngine.getInstance();
      const originalFetch = window.fetch.bind(window);
      const status = async () => {
        const response = await originalFetch('http://127.0.0.1:18755/v1/status');
        if (!response.ok) throw new Error(`Native status failed with HTTP ${response.status}`);
        return await response.json() as {
          sampleRate: number;
          projectContentRevision: number;
          projectContentRevisionSnapshotStable: boolean;
          projectArchiveV2Supported?: boolean;
          nativeTracks: Array<{ trackId: number; state: string; contentRevision: number }>;
        };
      };
      const waitForStableStopped = async () => {
        const deadline = Date.now() + 5_000;
        let current = await status();
        while (Date.now() < deadline && (!current.projectContentRevisionSnapshotStable
          || current.nativeTracks.some((track) => track.state === 'Recording' || track.state === 'Overdubbing'))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          current = await status();
        }
        if (!current.projectContentRevisionSnapshotStable
          || current.nativeTracks.some((track) => track.state === 'Recording' || track.state === 'Overdubbing')) {
          throw new Error('Native host did not reach a stable stopped state.');
        }
        return current;
      };
      const makeTracks = (seed: number, tempos: Array<number | null>, sampleRate: number) => Array.from({ length: 5 }, (_, index) => {
        const frames = 128 + index * 7;
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame += 1) {
          left[frame] = Math.fround(Math.sin((frame + 1) * (index + 1) * 0.037) * 0.7 + seed * 0.0001);
          right[frame] = Math.fround(Math.cos((frame + 3) * (index + 2) * 0.021) * 0.6 - seed * 0.0001);
        }
        return { sampleRate, frameCount: frames, channels: 2 as const,
          channelData: [left, right], originalTempoBpm: tempos[index]! };
      });
      const makeArchive = async (name: string, tempos: Array<number | null>, version: 1 | 2, seed: number) => {
        const tracks = makeTracks(seed, tempos, (await status()).sampleRate);
        const archive = await encodeProjectArchive({
          name,
          bpm: 121,
          transport: {
            masterTrackId: null,
            measureLengthSeconds: 0,
            masterLoopLengthSamples: 0,
            timeSignatureNumerator: 4,
            timeSignatureDenominator: 4,
          },
          tracks: tracks.map(({ sampleRate, frameCount, channels, channelData, originalTempoBpm }) => ({
            sampleRate, frameCount, channels, channelData, originalTempoBpm,
          })) as any,
        }, { version });
        const exact = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
        const decoded = await decodeProjectArchive(exact);
        return { bytes: exact, decoded, expected: tracks.map((track) => {
          const pcm = new Float32Array(track.frameCount * 2);
          for (let frame = 0; frame < track.frameCount; frame += 1) {
            pcm[frame * 2] = track.channelData[0][frame]!;
            pcm[frame * 2 + 1] = track.channelData[1][frame]!;
          }
          return { pcm: Array.from(pcm), tempo: track.originalTempoBpm };
        }) };
      };
      const importDecoded = async (archive: { bytes: ArrayBuffer; decoded: any }) => {
        const token = await engine.captureProjectRestoreOperationToken();
        await engine.restoreProjectArchive(archive.decoded, archive.bytes, token);
        await waitForStableStopped();
      };
      const exportDecoded = async () => {
        const archiveBytes = await engine.exportProjectArchive('Native v2 round trip');
        return await decodeProjectArchive(archiveBytes);
      };
      const snapshotBytes = async () => {
        const all: number[][] = [];
        for (let trackId = 1; trackId <= 5; trackId += 1) {
          const response = await originalFetch(`http://127.0.0.1:18755/v1/export/loop-snapshot?trackId=${trackId}`);
          if (!response.ok) throw new Error(`Native Track ${trackId} snapshot failed with HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          all.push(Array.from(bytes));
        }
        return all;
      };
      const assertRoundTrip = (decoded: any, expected: Array<{ pcm: number[]; tempo: number | null }>, label: string) => {
        if (decoded.tracks.length !== 5 || decoded.tracks.some((track: any) => track === null)) {
          throw new Error(`${label}: export did not contain all five tracks.`);
        }
        for (let index = 0; index < 5; index += 1) {
          const actual = decoded.tracks[index];
          if (actual.originalTempoBpm !== expected[index]!.tempo) {
            throw new Error(`${label}: Track ${index + 1} BPM was ${actual.originalTempoBpm}, expected ${expected[index]!.tempo}.`);
          }
          if (actual.pcm.length !== expected[index]!.pcm.length
            || actual.pcm.some((sample: number, sampleIndex: number) => sample !== expected[index]!.pcm[sampleIndex])) {
            throw new Error(`${label}: Track ${index + 1} PCM differed after round trip.`);
          }
        }
      };

      const hostBefore = await waitForStableStopped();
      if (hostBefore.projectArchiveV2Supported !== true) {
        throw new Error('The supplied 8145d4b Native host did not advertise v2 support.');
      }
      const v2 = await makeArchive('Browser v2 verified tempo', [87.5, 101, null, 143.25, 216], 2, 31);
      await importDecoded(v2);
      const v2Export = await exportDecoded();
      assertRoundTrip(v2Export, v2.expected, 'Browser→Native→Browser v2');

      const v1 = await makeArchive('Browser v1 unknown tempo', [null, null, null, null, null], 1, 59);
      if (v1.decoded.tracks.some((track: any) => track?.originalTempoBpm !== null)) {
        throw new Error('ProjectArchive v1 did not decode track tempo as unknown.');
      }
      await importDecoded(v1);
      const v1NativeExport = await exportDecoded();
      assertRoundTrip(v1NativeExport, v1.expected, 'Browser v1→Native→Browser');

      // Establish known incumbent Native PCM, then emulate an older host that
      // omits the v2 capability bit. The client must fail before uploading.
      await importDecoded(v2);
      const beforeRefusalStatus = await waitForStableStopped();
      const beforeRefusalPcm = await snapshotBytes();
      let hideCapability = true;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await originalFetch(input, init);
        if (hideCapability && String(input).includes('/v1/status') && response.ok) {
          const payload = await response.json() as Record<string, unknown>;
          delete payload.projectArchiveV2Supported;
          return new Response(JSON.stringify(payload), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      };
      let refusal = '';
      try {
        const token = await engine.captureProjectRestoreOperationToken();
        hideCapability = true;
        await engine.restoreProjectArchive(v2.decoded, v2.bytes, token);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      } finally {
        hideCapability = false;
        window.fetch = originalFetch;
      }
      const afterRefusalStatus = await waitForStableStopped();
      const afterRefusalPcm = await snapshotBytes();
      if (!/does not advertise ProjectArchive v2 support/.test(refusal)) {
        throw new Error(`Old-capability import did not fail closed: ${refusal || 'no error'}`);
      }
      if (afterRefusalStatus.projectContentRevision !== beforeRefusalStatus.projectContentRevision
        || JSON.stringify(afterRefusalPcm) !== JSON.stringify(beforeRefusalPcm)) {
        throw new Error('Old-capability rejection changed the incumbent Native PCM or project revision.');
      }

      return {
        capability: hostBefore.projectArchiveV2Supported,
        v2Version: v2Export.version,
        v2Tempos: v2Export.tracks.map((track: any) => track?.originalTempoBpm ?? null),
        v1ImportTempos: v1.decoded.tracks.map((track: any) => track?.originalTempoBpm ?? null),
        v1NativeExportTempos: v1NativeExport.tracks.map((track: any) => track?.originalTempoBpm ?? null),
        refusal,
        refusalRevisionUnchanged: afterRefusalStatus.projectContentRevision === beforeRefusalStatus.projectContentRevision,
        refusalPcmUnchanged: JSON.stringify(afterRefusalPcm) === JSON.stringify(beforeRefusalPcm),
      };
    });

    expect(result.capability).toBe(true);
    expect(result.v2Version).toBe(2);
    expect(result.v2Tempos).toEqual([87.5, 101, null, 143.25, 216]);
    expect(result.v1ImportTempos).toEqual([null, null, null, null, null]);
    expect(result.v1NativeExportTempos).toEqual([null, null, null, null, null]);
    expect(result.refusal).toMatch(/does not advertise ProjectArchive v2 support/);
    expect(result.refusalRevisionUnchanged).toBe(true);
    expect(result.refusalPcmUnchanged).toBe(true);
  } finally {
    if (host && !host.killed) host.kill();
  }
});
