import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { NativeBridgeHttpError, NativeRhythmScheduleOutcomeUnknownError, NativeRhythmScheduleTerminalError, type NativeBridgeClient,
  type NativeRhythmScheduleReceipt, type NativeStatus } from '../../src/audio/NativeBridgeClient';

function createEngine(ownerReceipt: NativeRhythmScheduleReceipt | null, reconcile: () => Promise<NativeStatus>) {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine & {
    bridge: NativeBridgeClient;
    reconcileRhythmScheduleForInit(status: NativeStatus): Promise<{ status: NativeStatus; terminalNotice?: string }>;
  };
  const reconcilePendingRhythmSchedule = vi.fn(reconcile);
  engine.bridge = {
    getPendingRhythmSchedule: vi.fn(() => ownerReceipt),
    reconcilePendingRhythmSchedule,
  } as unknown as NativeBridgeClient;
  return { engine, reconcilePendingRhythmSchedule };
}

describe('Native Rhythm schedule initialization reconciliation', () => {
  it('rejects ALL START and ALL STOP before dispatch while a LOOP SYNC track is enabled', () => {
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    engine.latestStatus = { nativeMemory: { loopSync: [false, true, false, false, false] } };
    engine.tracks = [{ trackId: 1 }, { trackId: 2 }];
    engine.lastError = '';
    engine.emitAll = vi.fn();
    engine.playTrack = vi.fn();
    engine.stopTrack = vi.fn();
    engine.playAllTracks();
    engine.stopAllTracks();
    expect(engine.playTrack).not.toHaveBeenCalled();
    expect(engine.stopTrack).not.toHaveBeenCalled();
    expect(engine.lastError).toMatch(/ALL STOP is unavailable/);
    expect(engine.emitAll).toHaveBeenCalledTimes(2);
  });

  it('uses the acknowledged PCM-preserving emergency STOP when LOOP SYNC loses its phase', async () => {
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    const stopTrack = vi.fn();
    const emergencyStopTrack = vi.fn(async () => ({ nativeTracks: [{ trackId: 1, state: 'Stopped', contentRevision: 2,
      loopLengthSamples: 4096 }], nativeStopTrackAcknowledgement: { trackId: 1, requestedRevision: 1,
        appliedRevision: 1, committedRevision: 1 } }));
    engine.latestStatus = { nativeMemory: { loopSync: [true, false, false, false, false] },
      nativeTracks: [{ trackId: 1, state: 'Recording', contentRevision: 1 }],
      nativeRhythm: { phase: { available: false, snapshotStable: true } } };
    engine.bridge = { stopTrack, emergencyStopTrack };
    engine.applyStatus = vi.fn((status: unknown) => { engine.latestStatus = status; });
    engine.emitAll = vi.fn();
    engine.lastError = '';
    await engine.stopTrack(1);
    expect(stopTrack).not.toHaveBeenCalled();
    expect(emergencyStopTrack).toHaveBeenCalledOnce();
    expect(engine.lastError).toMatch(/emergency STOP retained the captured PCM/);
    expect(engine.lastError).toMatch(/4096 frames/);
  });

  it('preserves the last Recording status when the emergency endpoint rejects a recovered phase', async () => {
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    const before = { nativeMemory: { loopSync: [true, false, false, false, false] },
      nativeTracks: [{ trackId: 1, state: 'Recording', contentRevision: 1 }],
      nativeRhythm: { phase: { available: false, snapshotStable: true } } };
    engine.latestStatus = before;
    engine.bridge = { emergencyStopTrack: vi.fn(async () => { throw new NativeBridgeHttpError('measure phase is available', 409); }) };
    engine.applyStatus = vi.fn();
    engine.emitAll = vi.fn();
    engine.lastError = '';
    await expect(engine.stopTrack(1)).rejects.toThrow(/measure phase is available/);
    expect(engine.latestStatus).toBe(before);
    expect(engine.applyStatus).not.toHaveBeenCalled();
    expect(engine.lastError).toMatch(/last Native track state is retained/);
  });

  it('preserves the confirmed Recording state when a scheduled measure STOP gets a host 409', async () => {
    const before = { nativeMemory: { loopSync: [true, false, false, false, false] },
      nativeTracks: [{ trackId: 1, state: 'Recording', contentRevision: 1, loopLengthSamples: 2048 }],
      nativeRhythm: { enabled: true, tempoAppliedRevision: 7, phase: { available: true, snapshotStable: true,
        frameSchedulingAvailable: true, nextMeasureFrame: 8192, epoch: 3 } },
      hostIncarnationId: '1'.repeat(32) } as unknown as NativeStatus;
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    engine.latestStatus = before;
    engine.bridge = { scheduleRhythmRecordOrStop: vi.fn(async () => {
      throw new NativeBridgeHttpError('measure phase changed before STOP was accepted', 409);
    }) };
    engine.applyStatus = vi.fn();
    engine.emitAll = vi.fn();
    engine.lastError = '';
    await expect(engine.stopTrack(1)).rejects.toThrow(/measure phase changed/);
    expect(engine.latestStatus).toBe(before);
    expect(engine.applyStatus).not.toHaveBeenCalled();
    expect(engine.lastError).toMatch(/measure phase changed/);
  });

  it('routes the REC/PLAY finish action for synchronized recording through measure STOP', async () => {
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    engine.latestStatus = { nativeMemory: { loopSync: [true, false, false, false, false] },
      nativeTracks: [{ trackId: 1, state: 'Recording', contentRevision: 1 }] };
    engine.stopTrack = vi.fn(async () => undefined);
    const finishRecordingTrack = vi.fn();
    engine.bridge = { finishRecordingTrack };
    await engine.finishRecordingTrack(1);
    expect(engine.stopTrack).toHaveBeenCalledOnce();
    expect(engine.stopTrack).toHaveBeenCalledWith(1);
    expect(finishRecordingTrack).not.toHaveBeenCalled();
  });

  it('keeps synchronized playback disabled until track PCM has retained phase provenance', () => {
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    engine.latestStatus = { sampleRate: 48_000, nativeMemory: { loopSync: [true, false, false, false, false] },
      nativeTracks: [{ trackId: 1, state: 'Stopped', loopLengthSamples: 38_400 }],
      nativeRhythm: { enabled: true, bpm: 300, phase: { available: true, snapshotStable: true, frameSchedulingAvailable: true,
        epoch: 1, nextMeasureFrame: 48_000, measureStartFrame: 9_600, meterNumerator: 4, meterDenominator: 4 } } };
    expect(engine.getRhythmSyncPlayAvailability(1).available).toBe(false);
    expect(engine.getRhythmSyncPlayAvailability(1).reason).toMatch(/phase provenance/);
    engine.latestStatus.nativeTracks[0].loopLengthSamples = 38_000;
    expect(engine.getRhythmSyncPlayAvailability(1).available).toBe(false);
    expect(engine.getRhythmSyncPlayAvailability(1).reason).toMatch(/phase provenance/);
  });

  it.each([
    ['cancelled', { appliedRevision: 0, cancelledRevision: 9, faultRevision: 0 }],
    ['fault', { appliedRevision: 0, cancelledRevision: 0, faultRevision: 9, fault: 2 }],
  ] as const)('preserves known owner %s outcome and reports it as terminal, not unknown', async (outcome, terminalFields) => {
    const ownerReceipt: NativeRhythmScheduleReceipt = { trackId: 1, action: 'record', revision: 9,
      baselineRevision: 8, absoluteFrame: 48_000, phaseEpoch: 3, settingsRevision: 4,
      hostIncarnationId: 'a'.repeat(32), intentId: 'b'.repeat(32) };
    const status = { nativeLoopFrameScheduling: { requests: [{ requestedRevision: 9, ...terminalFields }] } } as NativeStatus;
    const terminal = new NativeRhythmScheduleTerminalError(ownerReceipt, status, outcome, new Error(`known ${outcome}`));
    const { engine, reconcilePendingRhythmSchedule } = createEngine(ownerReceipt, async () => { throw terminal; });

    await expect((engine as any).reconcileRhythmScheduleForInit(status)).resolves.toEqual({ status, terminalNotice: terminal.message });
    expect(reconcilePendingRhythmSchedule).toHaveBeenCalledOnce();
  });

  it('delegates an orphan pending status to the read-only client recovery path', async () => {
    const status = { nativeLoopFrameScheduling: { requests: [{ requestedRevision: 5, appliedRevision: 0,
      cancelledRevision: 0, faultRevision: 0 }] } } as NativeStatus;
    const receipt: NativeRhythmScheduleReceipt = { trackId: 1, action: 'stop', revision: 5,
      baselineRevision: 4, absoluteFrame: 24_000, phaseEpoch: 2, settingsRevision: 3,
      hostIncarnationId: 'c'.repeat(32), intentId: 'd'.repeat(32) };
    const unknown = new NativeRhythmScheduleOutcomeUnknownError(receipt, status, new Error('pending receipt has no local owner'));
    const { engine, reconcilePendingRhythmSchedule } = createEngine(null, async () => { throw unknown; });

    await expect((engine as any).reconcileRhythmScheduleForInit(status)).rejects.toBe(unknown);
    expect(reconcilePendingRhythmSchedule).toHaveBeenCalledOnce();
  });

  it('keeps orphan status visible and Native transport blocked during initialization', async () => {
    const hostIncarnationId = 'e'.repeat(32);
    const receipt: NativeRhythmScheduleReceipt = { trackId: 2, action: 'record', revision: 6,
      baselineRevision: 5, absoluteFrame: 24_000, phaseEpoch: 2, settingsRevision: 3,
      hostIncarnationId, intentId: 'f'.repeat(32) };
    const status = { hostIncarnationId, engineRunning: true, bridgeHealthy: true,
      nativeLoopFrameScheduling: { requests: [{}, { requestedRevision: 6, appliedRevision: 0,
        cancelledRevision: 0, faultRevision: 0 }] } } as NativeStatus;
    const unknown = new NativeRhythmScheduleOutcomeUnknownError(receipt, status, new Error('orphan pending'));
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    engine.bridgeAvailable = false;
    engine.bridge = {
      health: vi.fn(async () => ({})), getStatus: vi.fn(async () => status),
      getDevices: vi.fn(async () => ({})), getPendingRhythmSchedule: vi.fn(() => null),
      reconcilePendingRhythmSchedule: vi.fn(async () => { throw unknown; }),
    };
    engine.refreshCatalog = vi.fn(async () => {});
    let published: NativeStatus | null = null;
    engine.applyStatus = vi.fn((value: NativeStatus) => {
      published = value; engine.latestStatus = value; engine.engineRunning = value.engineRunning;
    });
    engine.emitAll = vi.fn();

    await expect(engine.initializeNative()).rejects.toBe(unknown);

    expect(published).toBe(status);
    expect(engine.latestStatus).toBe(status);
    expect(engine.nativeRhythmScheduleRecoveryBlocked).toBe(true);
    expect(engine.getUiStatus()).toMatchObject({ ready: false, message: 'NATIVE RHYTHM SCHEDULE NEEDS REVIEW' });
    expect(engine.isNativeReady()).toBe(false);
  });
});
