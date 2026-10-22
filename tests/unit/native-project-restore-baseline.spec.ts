import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeStatus } from '../../src/audio/NativeBridgeClient';

function readyStatus(overrides: Partial<NativeStatus> = {}): NativeStatus {
  return {
    ok: true,
    bridgeHealthy: true,
    engineRunning: true,
    backend: 'WASAPI',
    inputDeviceId: 'input',
    outputDeviceId: 'output',
    inputDeviceName: 'input',
    outputDeviceName: 'output',
    sampleRate: 48_000,
    bufferFrames: 128,
    monitoringEnabled: false,
    state: 'Stopped',
    inputLatencyMs: 0,
    outputLatencyMs: 0,
    roundTripEstimateMs: 0,
    inputPeak: 0,
    outputPeak: 0,
    xrunsOrDropouts: 0,
    lastError: '',
    loopProgress: 0,
    nativeLooperTrackCount: 5,
    nativeLooperMultiTrackImplemented: true,
    projectContentRevision: 42,
    projectContentRevisionSnapshotStable: true,
    nativeTracks: Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      state: 'Stopped' as const,
      loopProgress: 0,
      contentRevision: 4,
      history: { canUndo: false, canRedo: false, retainedPcmBytes: 0, unavailableReason: 'none' as const },
    })),
    ...overrides,
  };
}

function nativeEngine(status: NativeStatus) {
  const getStatus = vi.fn(async () => status);
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  Object.assign(engine, {
    bridge: { getStatus },
    // Deliberately stale UI cache; the operation token must use the fresh host read.
    latestStatus: readyStatus({ projectContentRevision: 3 }),
  });
  return { engine, getStatus };
}

describe('Native project-load operation-start snapshot', () => {
  it('uses a fresh stable five-track host revision rather than the polling cache', async () => {
    const status = readyStatus({ projectContentRevision: 42 });
    const { engine, getStatus } = nativeEngine(status);

    await expect(engine.captureProjectRestoreBaseline()).resolves.toEqual({
      projectContentRevision: 42,
      sampleRate: 48_000,
    });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it('fails closed for missing, unstable, unsafe, or exhausted host revision capability', async () => {
    const missing = readyStatus();
    delete missing.projectContentRevision;
    await expect(nativeEngine(missing).engine.captureProjectRestoreBaseline())
      .rejects.toThrow(/does not provide the operation-start project content revision/);

    await expect(nativeEngine(readyStatus({ projectContentRevisionSnapshotStable: false })).engine.captureProjectRestoreBaseline())
      .rejects.toThrow(/stable project revision\/status snapshot/);

    await expect(nativeEngine(readyStatus({ projectContentRevision: Number.MAX_SAFE_INTEGER + 1 })).engine.captureProjectRestoreBaseline())
      .rejects.toThrow(/operation-start project content revision/);

    await expect(nativeEngine(readyStatus({ projectContentRevision: Number.MAX_SAFE_INTEGER })).engine.captureProjectRestoreBaseline())
      .rejects.toThrow(/safe integer limit/);
  });

  it('rejects active record or overdub before opening any archive read', async () => {
    const recording = readyStatus({ nativeTracks: Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      state: index === 1 ? 'Recording' as const : 'Stopped' as const,
      loopProgress: 0,
      contentRevision: 5,
    })) });
    await expect(nativeEngine(recording).engine.captureProjectRestoreBaseline())
      .rejects.toThrow(/Stop Native Track 2 recording or overdubbing/);
  });
});
