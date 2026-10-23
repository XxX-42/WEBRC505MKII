import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

const simulationHost = process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE;

test.skip(!simulationHost, 'Set NATIVE_BRIDGE_SIMULATION_EXECUTABLE to the explicit no-hardware bridge simulation target.');

test('Native project decode refuses to overwrite a recording completed after load began', async ({ page }) => {
  if (!simulationHost) return;

  let host: ChildProcess | undefined;
  try {
    host = spawn(simulationHost, [], { env: { ...process.env, WEBRC_NATIVE_BRIDGE_PORT: '18755' }, stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch('http://127.0.0.1:18755/health');
        ready = response.ok && (await response.json()).ok === true;
        if (ready) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(ready, 'Native simulation host did not start on 127.0.0.1:18755').toBe(true);

    await page.goto('/?audio=native');
    await expect(page.locator('.top-status-strip')).toContainText('NATIVE AUDIO READY', { timeout: 20_000 });

    const result = await page.evaluate(async () => {
      const loadModule = (specifier: string) =>
        (new Function('specifier', 'return import(specifier)') as (value: string) => Promise<any>)(specifier);
      const [{ AudioEngine }, { NativeAudioEngine }, { ProjectMemory }, { encodeProjectArchive }, { Transport }] = await Promise.all([
        loadModule('/src/audio/AudioEngine.ts'),
        loadModule('/src/audio/NativeAudioEngine.ts'),
        loadModule('/src/audio/projectMemory.ts'),
        loadModule('/src/audio/projectArchive.ts'),
        loadModule('/src/core/Transport.ts'),
      ]);
      const engine = AudioEngine.getInstance();
      const memory = new ProjectMemory(engine);
      const originalFetch = window.fetch.bind(window);
      const getStatus = async () => {
        const response = await originalFetch('http://127.0.0.1:18755/v1/status');
        if (!response.ok) throw new Error(`Native status failed with HTTP ${response.status}`);
        return await response.json() as {
          sampleRate: number;
          projectContentRevision?: number;
          nativeTracks: Array<{ trackId: number; state: string; contentRevision: number; history?: { canUndo: boolean; canRedo: boolean } }>;
        };
      };
      const waitForStatus = async (predicate: (status: Awaited<ReturnType<typeof getStatus>>) => boolean) => {
        const deadline = Date.now() + 5_000;
        let status = await getStatus();
        while (!predicate(status) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          status = await getStatus();
        }
        if (!predicate(status)) throw new Error(`Native status did not reach the expected state: ${JSON.stringify(status.nativeTracks)}`);
        return status;
      };
      const makeArchive = async (name: string, bpm: number, firstValue: number) => {
        const sampleRate = (await getStatus()).sampleRate;
        const left = new Float32Array([firstValue, firstValue + 0.1, firstValue + 0.2, firstValue + 0.3]);
        const right = new Float32Array([-firstValue, -firstValue - 0.1, -firstValue - 0.2, -firstValue - 0.3]);
        const archive = await encodeProjectArchive({
          name,
          bpm,
          transport: {
            masterTrackId: null,
            measureLengthSeconds: 0,
            masterLoopLengthSamples: 0,
            timeSignatureNumerator: 4,
            timeSignatureDenominator: 4,
          },
          tracks: [
            { sampleRate, frameCount: left.length, channels: 2, channelData: [left, right] },
            null,
            null,
            null,
            null,
          ],
        });
        const bytes = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
        return { archive: bytes, file: new File([bytes], `${name}.rc505proj`, { type: 'application/x-rc505-project' }) };
      };
      const hashTrack = async (trackId: number) => {
        const response = await originalFetch(`http://127.0.0.1:18755/v1/export/loop-snapshot?trackId=${trackId}`);
        if (!response.ok) throw new Error(`Native Track ${trackId} snapshot failed with HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        return {
          frameCount: Number(response.headers.get('X-Native-Loop-Frame-Count')),
          channels: Number(response.headers.get('X-Native-Loop-Channels')),
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (value) => value.toString(16).padStart(2, '0')).join(''),
        };
      };

      const first = await makeArchive('Native baseline', 113, 0.2);
      await memory.importFile(first.file);
      const baselineTrack1 = await hashTrack(1);
      const beforeRecording = await getStatus();
      const baselineRevision = beforeRecording.nativeTracks.find((track) => track.trackId === 2)!.contentRevision;
      const second = await makeArchive('Stale async load', 127, 0.7);

      let releaseRead!: () => void;
      let markReadStarted!: () => void;
      const waitingForRead = new Promise<void>((resolve) => { markReadStarted = resolve; });
      const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      const delayedFile = {
        name: 'Stale async load.rc505proj',
        size: second.archive.byteLength,
        arrayBuffer: async () => {
          markReadStarted();
          await readGate;
          return second.archive.slice(0);
        },
      } as unknown as File;
      const importPromise = memory.importFile(delayedFile).then(
        (value: unknown) => ({ state: 'resolved' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error: error instanceof Error ? error.message : String(error) }),
      );
      await waitingForRead;

      const nativeEngine = NativeAudioEngine.getInstance();
      await nativeEngine.recordTrack(2);
      const recording = await waitForStatus((status) => status.nativeTracks.find((track) => track.trackId === 2)?.state === 'Recording');
      await new Promise((resolve) => setTimeout(resolve, 60));
      await nativeEngine.stopTrack(2);
      const recorded = await waitForStatus((status) => {
        const track = status.nativeTracks.find((entry) => entry.trackId === 2)!;
        return track.state === 'Stopped' && track.contentRevision > baselineRevision;
      });
      const track2BeforeRelease = await hashTrack(2);
      const bpmChangedDuringRead = 91;
      Transport.getInstance().setBpm(bpmChangedDuringRead);
      if (!await nativeEngine.rhythmEngine.setBpm(bpmChangedDuringRead)) {
        throw new Error('Native rhythm did not acknowledge the BPM edit made during the delayed archive read');
      }
      const bpmBeforeRelease = Transport.getInstance().bpm;

      releaseRead();
      const importOutcome = await importPromise;
      const after = await getStatus();
      const track1After = await hashTrack(1);
      const track2AfterResponse = await originalFetch('http://127.0.0.1:18755/v1/export/loop-snapshot?trackId=2');
      const track2After = track2AfterResponse.ok ? await hashTrack(2) : null;
      const bpmAfterFirstLoad = Transport.getInstance().bpm;

      // Exercise the post-upload window separately. The import request is
      // accepted before this gate; a BPM edit while the host callback is
      // pending must either cancel before claim or preserve the newer BPM and
      // expose the fact that PCM already committed.
      const beforeTransportRace = await hashTrack(1);
      const bpmBeforeTransportRace = Transport.getInstance().bpm;
      const revisionBeforeTransportRace = (await getStatus()).projectContentRevision;
      if (!Number.isSafeInteger(revisionBeforeTransportRace)) throw new Error('Native host did not expose its project revision for the post-submit race fixture');
      const third = await makeArchive('Transport changed during Native load', 127, 0.9);
      let releaseStatus!: () => void;
      let markStatusStarted!: () => void;
      const waitingForStatus = new Promise<void>((resolve) => { markStatusStarted = resolve; });
      const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
      const originalWindowFetch = window.fetch;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/v1/project/import/status?generation=')) {
          markStatusStarted();
          await statusGate;
        }
        return await originalFetch(input, init);
      };
      const transportRacePromise = memory.importFile(third.file).then(
        (value: unknown) => ({ state: 'resolved' as const, value }),
        (error: unknown) => ({
          state: 'rejected' as const,
          error: error instanceof Error ? error.message : String(error),
          archiveCommitted: typeof error === 'object' && error !== null && 'archiveCommitted' in error && error.archiveCommitted === true,
        }),
      );
      await waitingForStatus;
      await waitForStatus((status) => (status.projectContentRevision ?? -1) > revisionBeforeTransportRace!);
      Transport.getInstance().setBpm(83);
      if (!await nativeEngine.rhythmEngine.setBpm(83)) {
        throw new Error('Native rhythm did not acknowledge the BPM edit made while the project import was pending');
      }
      // Return to the operation-start value before the delayed status response.
      // A value-only comparison would miss this ABA edit and apply the archive.
      Transport.getInstance().setBpm(bpmBeforeTransportRace);
      if (!await nativeEngine.rhythmEngine.setBpm(bpmBeforeTransportRace)) {
        throw new Error('Native rhythm did not acknowledge the reverted BPM edit made while the project import was pending');
      }
      const bpmAfterUserEdit = Transport.getInstance().bpm;
      releaseStatus();
      const transportRaceOutcome = await transportRacePromise;
      window.fetch = originalWindowFetch;
      const bpmAfterResolution = Transport.getInstance().bpm;
      const afterTransportRace = await hashTrack(1);
      const pcmResponse = await originalFetch('http://127.0.0.1:18755/v1/export/loop-snapshot?trackId=1');
      const pcmBytes = await pcmResponse.arrayBuffer();
      const pcmSamples = new Float32Array(pcmBytes);
      return {
        importOutcome,
        baselineTrack1,
        track1After,
        track2BeforeRelease,
        track2After,
        track2AfterHttpStatus: track2AfterResponse.status,
        baselineRevision,
        beforeRecordingRevision: beforeRecording.nativeTracks.find((track) => track.trackId === 2)?.contentRevision,
        recordingState: recording.nativeTracks.find((track) => track.trackId === 2)?.state,
        recordedState: recorded.nativeTracks.find((track) => track.trackId === 2)?.state,
        revisionAfterRecord: recorded.nativeTracks.find((track) => track.trackId === 2)?.contentRevision,
        historyAfterRecord: recorded.nativeTracks.find((track) => track.trackId === 2)?.history,
        historyAfterImport: after.nativeTracks.find((track) => track.trackId === 2)?.history,
        bpmBeforeRelease,
        bpmAfterImport: bpmAfterFirstLoad,
        beforeTransportRace,
        afterTransportRace,
        bpmBeforeTransportRace,
        transportRaceOutcome,
        bpmAfterUserEdit,
        bpmAfterResolution,
        transportRacePcmFirstSamples: [pcmSamples[0], pcmSamples[1]],
      };
    });

    expect(result.recordingState).toBe('Recording');
    expect(result.recordedState).toBe('Stopped');
    expect(result.revisionAfterRecord).toBeGreaterThan(result.baselineRevision ?? -1);
    expect(result.track2BeforeRelease.frameCount).toBeGreaterThan(0);
    expect(result.historyAfterRecord?.canUndo).toBe(true);
    expect(result.importOutcome.state).toBe('rejected');
    if (result.importOutcome.state === 'rejected') {
      expect(result.importOutcome.error).toMatch(/project changed|track changed|revision|transport/i);
    }
    expect(result.baselineTrack1).toEqual(result.track1After);
    expect(result.track2After).toEqual(result.track2BeforeRelease);
    expect(result.historyAfterImport).toEqual(result.historyAfterRecord);
    expect(result.bpmAfterImport).toBe(result.bpmBeforeRelease);
    expect(result.bpmAfterResolution).toBe(result.bpmAfterUserEdit);
    // Waited until the host revision proved callback commit before changing
    // BPM, so this path must preserve the newer transport while reporting the
    // already-committed PCM generation explicitly.
    expect(result.transportRaceOutcome.state).toBe('rejected');
    if (result.transportRaceOutcome.state === 'rejected') {
      expect(result.transportRaceOutcome.archiveCommitted).toBe(true);
      expect(result.transportRaceOutcome.error).toMatch(/transport changed while the Native import was pending/i);
    }
    expect(result.afterTransportRace).not.toEqual(result.beforeTransportRace);
    expect(result.transportRacePcmFirstSamples[0]).toBeCloseTo(0.9, 5);
    expect(result.transportRacePcmFirstSamples[1]).toBeCloseTo(-0.9, 5);
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
