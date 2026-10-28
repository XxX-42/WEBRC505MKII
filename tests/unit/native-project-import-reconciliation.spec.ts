import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { Transport } from '../../src/core/Transport';

function hostStatus(projectContentRevision: number, rhythmBpm: number) {
  return {
    hostIncarnationId: 'a'.repeat(32),
    engineRunning: true,
    projectContentRevision,
    projectContentRevisionSnapshotStable: true,
    nativeTracks: Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1, state: 'Stopped', contentRevision: index === 0 ? 9 : 0,
    })),
    nativeRhythm: { available: true, bpm: rhythmBpm, tempoRequestedRevision: 2, tempoAppliedRevision: 2, tempoAppliedValid: true },
  } as any;
}

describe('Native project import reconciliation after transport sync failure', () => {
  it('does not apply imported transport when BPM ACK races a Native host restart', async () => {
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();
    transport.timeSignature = [4, 4];
    transport.measureLength = 0;
    transport.masterLoopLengthSamples = 0;
    transport.setBpm(120);
    const before = { bpm: transport.bpm, revision: transport.projectMutationRevision,
      masterTrackId: transport.masterTrackId, measureLength: transport.measureLength };
    let reads = 0;
    const newHost = { ...hostStatus(2, 120), hostIncarnationId: 'c'.repeat(32) };
    const instance = Object.create(NativeAudioEngine.prototype) as any;
    instance.bridge = { getStatus: vi.fn(async () => ++reads === 1 ? hostStatus(2, 120) : newHost) };
    instance.rhythmEngine = { available: true, settings: { bpm: 120 }, setBpm: vi.fn(async () => true) };
    instance.syncingNativeRhythmBpm = false;
    instance.pendingProjectImportSync = new Map([[58, {
      hostIncarnationId: 'a'.repeat(32),
      bpm: 110,
      transport: { masterTrackId: 2, measureLengthSeconds: 8, masterLoopLengthSamples: 384_000,
        timeSignatureNumerator: 4, timeSignatureDenominator: 4 },
      operationStartTransport: {
        bpm: before.bpm, state: transport.state, masterTrackId: before.masterTrackId,
        measureLengthSeconds: before.measureLength, masterLoopLengthSamples: transport.masterLoopLengthSamples,
        timeSignatureNumerator: transport.timeSignature[0], timeSignatureDenominator: transport.timeSignature[1],
      },
      operationStartTransportRevision: before.revision,
      synchronizationStarted: false,
    }]]);
    instance.applyStatus = vi.fn();

    await expect(instance.synchronizeCommittedProjectArchive(58, 2)).rejects.toMatchObject({
      generation: 58, name: 'NativeProjectImportIndeterminateError',
    });
    expect(transport).toMatchObject({ bpm: 120, projectMutationRevision: before.revision, masterTrackId: null, measureLength: 0 });
    expect(instance.pendingProjectImportSync.has(58)).toBe(true);
  });

  it('preserves a user transport edit made while the imported BPM request is awaiting ACK', async () => {
    const transport = Transport.getInstance();
    transport.stop(); transport.resetMasterTrack(); transport.timeSignature = [4, 4];
    transport.measureLength = 0; transport.masterLoopLengthSamples = 0; transport.setBpm(120);
    const operationStartTransport = {
      bpm: transport.bpm, state: transport.state, masterTrackId: transport.masterTrackId,
      measureLengthSeconds: transport.measureLength, masterLoopLengthSamples: transport.masterLoopLengthSamples,
      timeSignatureNumerator: transport.timeSignature[0], timeSignatureDenominator: transport.timeSignature[1],
    };
    const operationStartTransportRevision = transport.projectMutationRevision;
    const instance = Object.create(NativeAudioEngine.prototype) as any;
    instance.bridge = { getStatus: vi.fn(async () => hostStatus(2, 120)) };
    instance.rhythmEngine = { available: true, settings: { bpm: 120 }, setBpm: vi.fn(async () => {
      transport.setBpm(133);
      return true;
    }) };
    instance.syncingNativeRhythmBpm = false;
    instance.pendingProjectImportSync = new Map([[59, {
      hostIncarnationId: 'a'.repeat(32), bpm: 110,
      transport: { masterTrackId: 2, measureLengthSeconds: 8, masterLoopLengthSamples: 384_000,
        timeSignatureNumerator: 7, timeSignatureDenominator: 8 },
      operationStartTransport, operationStartTransportRevision, synchronizationStarted: false,
    }]]);
    instance.applyStatus = vi.fn();

    await expect(instance.synchronizeCommittedProjectArchive(59, 2)).rejects.toMatchObject({
      archiveCommitted: true, generation: 59, recoveryUnavailable: true,
    });
    expect(transport.bpm).toBe(133);
    expect(transport.timeSignature).toEqual([4, 4]);
    expect(transport.masterTrackId).toBeNull();
  });

  it('resolves an exact committed generation without applying stale metadata when transport changed during import', async () => {
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();
    transport.timeSignature = [4, 4];
    transport.measureLength = 0;
    transport.masterLoopLengthSamples = 0;
    transport.setBpm(120);
    const operationStartTransport = {
      bpm: transport.bpm, state: transport.state, masterTrackId: transport.masterTrackId,
      measureLengthSeconds: transport.measureLength, masterLoopLengthSamples: transport.masterLoopLengthSamples,
      timeSignatureNumerator: transport.timeSignature[0], timeSignatureDenominator: transport.timeSignature[1],
    };
    const operationStartTransportRevision = transport.projectMutationRevision;
    transport.setBpm(133);
    const instance = Object.create(NativeAudioEngine.prototype) as any;
    const applyStatus = vi.fn();
    instance.bridge = {
      getStatus: vi.fn(async () => hostStatus(2, 120)),
      getProjectArchiveImportStatus: vi.fn(async (generation: number) => ({
        ok: true, generation, state: 'committed', hostIncarnationId: 'a'.repeat(32), projectContentRevision: 2,
      })),
    };
    instance.rhythmEngine = { available: true, settings: { bpm: 120 }, setBpm: vi.fn(async () => true) };
    instance.syncingNativeRhythmBpm = false;
    instance.pendingProjectImportSync = new Map([[56, {
      hostIncarnationId: 'a'.repeat(32),
      bpm: 110,
      transport: { masterTrackId: null, measureLengthSeconds: 0, masterLoopLengthSamples: 0,
        timeSignatureNumerator: 4, timeSignatureDenominator: 4 },
      operationStartTransport,
      operationStartTransportRevision,
      synchronizationStarted: false,
    }]]);
    instance.applyStatus = applyStatus;

    await expect(instance.synchronizeCommittedProjectArchive(56, 2)).rejects.toMatchObject({
      archiveCommitted: true, generation: 56, recoveryUnavailable: true,
    });
    expect(transport.bpm).toBe(133);
    expect(instance.rhythmEngine.setBpm).not.toHaveBeenCalled();
    expect(instance.pendingProjectImportSync.has(56)).toBe(false);
    expect(applyStatus).toHaveBeenCalledWith(expect.anything(), false);

    const status = await instance.getProjectArchiveImportStatus(56);
    expect(status).toMatchObject({ state: 'unavailable', generation: 56, projectContentRevision: 2, hostIncarnationMismatch: true });
  });

  it.each(['track', 'transport'] as const)('marks a post-sync %s change as recovery unavailable', async (changed) => {
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();
    transport.timeSignature = [4, 4];
    transport.measureLength = 0;
    transport.masterLoopLengthSamples = 0;
    transport.setBpm(120);
    const synchronizedTransportRevision = transport.projectMutationRevision;
    if (changed === 'transport') transport.setBpm(133);
    const callbackSnapshot = hostStatus(2, 120).nativeTracks;
    const currentHostStatus = hostStatus(2, 120);
    if (changed === 'track') currentHostStatus.nativeTracks[0].contentRevision = 10;
    const instance = Object.create(NativeAudioEngine.prototype) as any;
    instance.bridge = {
      getStatus: vi.fn(async () => currentHostStatus),
      getProjectArchiveImportStatus: vi.fn(async (generation: number) => ({
        ok: true, generation, state: 'committed', hostIncarnationId: 'a'.repeat(32), projectContentRevision: 2,
      })),
    };
    instance.rhythmEngine = { available: false, settings: null, setBpm: vi.fn(async () => true) };
    instance.syncingNativeRhythmBpm = false;
    instance.pendingProjectImportSync = new Map([[57, {
      hostIncarnationId: 'a'.repeat(32),
      bpm: 120,
      transport: { masterTrackId: null, measureLengthSeconds: 0, masterLoopLengthSamples: 0,
        timeSignatureNumerator: 4, timeSignatureDenominator: 4 },
      operationStartTransport: {
        bpm: 120, state: transport.state, masterTrackId: transport.masterTrackId,
        measureLengthSeconds: transport.measureLength, masterLoopLengthSamples: transport.masterLoopLengthSamples,
        timeSignatureNumerator: transport.timeSignature[0], timeSignatureDenominator: transport.timeSignature[1],
      },
      operationStartTransportRevision: synchronizedTransportRevision,
      synchronizationStarted: true,
      callbackTrackSnapshot: callbackSnapshot,
      synchronizedTransportRevision,
    }]]);
    instance.applyStatus = vi.fn();

    await expect(instance.getProjectArchiveImportStatus(57)).rejects.toMatchObject({
      archiveCommitted: true, generation: 57, recoveryUnavailable: true,
    });
    expect(instance.pendingProjectImportSync.has(57)).toBe(false);
  });

  it('retries BPM ACK/readback from the recorded loop revisions instead of requiring the old callback epoch', async () => {
    const transport = Transport.getInstance();
    transport.stop();
    transport.resetMasterTrack();
    transport.timeSignature = [4, 4];
    transport.measureLength = 0;
    transport.masterLoopLengthSamples = 0;
    transport.setBpm(120);
    const operationStartTransport = {
      bpm: transport.bpm, state: transport.state, masterTrackId: transport.masterTrackId,
      measureLengthSeconds: transport.measureLength, masterLoopLengthSamples: transport.masterLoopLengthSamples,
      timeSignatureNumerator: transport.timeSignature[0], timeSignatureDenominator: transport.timeSignature[1],
    };
    const operationStartTransportRevision = transport.projectMutationRevision;
    let readbackBpm = 120;
    let hostReads = 0;
    const setBpm = vi.fn(async () => {
      if (setBpm.mock.calls.length === 1) return false;
      readbackBpm = 110;
      return true;
    });
    const instance = Object.create(NativeAudioEngine.prototype) as any;
    instance.bridge = {
      getStatus: vi.fn(async () => {
        hostReads += 1;
        if (hostReads === 1) return hostStatus(2, 120);
        if (hostReads <= 3) return hostStatus(3, readbackBpm);
        if (hostReads === 4) return hostStatus(3, readbackBpm);
        return hostStatus(3, readbackBpm);
      }),
      getProjectArchiveImportStatus: vi.fn(async (generation: number) => ({
        ok: true, generation, state: 'committed', hostIncarnationId: 'a'.repeat(32), projectContentRevision: 2,
      })),
    };
    instance.rhythmEngine = { available: true, settings: { bpm: 120 }, setBpm };
    instance.syncingNativeRhythmBpm = false;
    instance.pendingProjectImportSync = new Map([[55, {
      hostIncarnationId: 'a'.repeat(32),
      bpm: 110,
      transport: { masterTrackId: null, measureLengthSeconds: 0, masterLoopLengthSamples: 0,
        timeSignatureNumerator: 4, timeSignatureDenominator: 4 },
      operationStartTransport,
      operationStartTransportRevision,
      synchronizationStarted: false,
    }]]);
    instance.applyStatus = vi.fn();

    await expect(instance.synchronizeCommittedProjectArchive(55, 2)).rejects.toMatchObject({
      archiveCommitted: true, generation: 55, recoveryUnavailable: false,
    });
    expect(instance.pendingProjectImportSync.get(55).synchronizationStarted).toBe(true);

    const reconciled = await instance.getProjectArchiveImportStatus(55);
    expect(reconciled).toMatchObject({ state: 'committed', generation: 55,
      committedProjectContentRevision: 2, projectContentRevision: 3,
      projectTransportMutationRevision: transport.projectMutationRevision });
    expect(setBpm).toHaveBeenCalledTimes(2);
    expect(instance.pendingProjectImportSync.has(55)).toBe(false);
  });
});
