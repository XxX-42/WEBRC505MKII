import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeBridgeClient,
  NativeTrackFxApplyAcknowledgementError,
  NATIVE_BRIDGE_REQUEST_TIMEOUT_MS,
  type NativeStatus,
} from '../../src/audio/NativeBridgeClient';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

function statusSnapshot(overrides: Partial<NativeStatus> = {}): NativeStatus {
  return {
    ok: true,
    bridgeHealthy: true,
    engineRunning: true,
    backend: 'WASAPI',
    inputDeviceId: 'input',
    outputDeviceId: 'output',
    inputDeviceName: 'Input',
    outputDeviceName: 'Output',
    sampleRate: 48000,
    bufferFrames: 64,
    monitoringEnabled: false,
    state: 'Playing',
    inputLatencyMs: 0,
    outputLatencyMs: 0,
    roundTripEstimateMs: 0,
    inputPeak: 0,
    outputPeak: 0,
    xrunsOrDropouts: 0,
    lastError: '',
    loopProgress: 0,
    nativeLooperMultiTrackImplemented: true,
    nativeLooperTrackCount: 5,
    nativeTracks: [1, 2, 3, 4, 5].map((trackId) => ({ trackId, state: 'Playing', loopProgress: 0.25 })),
    nativeFx: {
      trackFxApplyAvailable: true,
      trackFxApply: [1, 2, 3, 4, 5].map((trackId) => ({
        trackId, requested: true, applied: true, requestedRevision: 0, appliedRevision: 0,
        semanticRevision: 0, controlFaulted: false, peak: 0.5, rms: 0.25,
      })),
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, httpStatus = 200): Response {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Native per-track shared Track FX apply acknowledgement', () => {
  it('sends one request and accepts only the callback-applied revision', async () => {
    const applied = statusSnapshot();
    applied.nativeFx!.trackFxApply![0] = {
      trackId: 1, requested: false, applied: false, requestedRevision: 8, appliedRevision: 8,
      semanticRevision: 1, controlFaulted: false, peak: 0.4, rms: 0.2,
    };
    const fetchMock = vi.fn(async () => jsonResponse(applied));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().setTrackFxApply(1, false)).resolves.toMatchObject(applied);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17755/v1/native-track-fx/apply', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ trackId: 1, enabled: false }),
    }));
  });

  it('rejects a success response that has not applied the requested route', async () => {
    const mismatch = statusSnapshot();
    mismatch.nativeFx!.trackFxApply![0] = {
      trackId: 1, requested: false, applied: true, requestedRevision: 8, appliedRevision: 7,
      semanticRevision: 0, controlFaulted: false, peak: 0, rms: 0,
    };
    const fetchMock = vi.fn(async () => jsonResponse(mismatch));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NativeBridgeClient().setTrackFxApply(1, false)).rejects.toBeInstanceOf(NativeTrackFxApplyAcknowledgementError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads status once after HTTP timeout and never resends the gate command', async () => {
    vi.useFakeTimers();
    const readback = statusSnapshot();
    let rejectWrite!: (reason: Error) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/status')) return Promise.resolve(jsonResponse(readback));
      return new Promise<Response>((_resolve, reject) => { rejectWrite = reject; });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = new NativeBridgeClient().setTrackFxApply(2, false);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'NativeTrackFxApplyAcknowledgementError',
      reconciledStatus: readback,
    });
    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_REQUEST_TIMEOUT_MS);
    rejectWrite(new Error('aborted'));
    await rejection;

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/native-track-fx/apply'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/status'))).toHaveLength(1);
  });

  it.each([NaN, Infinity, 8.5, 9, undefined])('rejects malformed or superseded applied revision %s', async (revision) => {
    const malformed = statusSnapshot();
    Object.assign(malformed.nativeFx!.trackFxApply![0]!, {
      requested: false, applied: false, requestedRevision: 8, appliedRevision: revision,
    });
    const fetchMock = vi.fn(async () => jsonResponse(malformed));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().setTrackFxApply(1, false)).rejects.toBeInstanceOf(NativeTrackFxApplyAcknowledgementError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports old hosts as unavailable before attempting a setter', async () => {
    const engine = new (NativeAudioEngine as unknown as { new(): NativeAudioEngine })();
    (engine as unknown as { latestStatus: NativeStatus | null }).latestStatus = statusSnapshot({ nativeFx: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(engine.getTrackFxApply(1)).toMatchObject([{ trackId: 1, available: false, applied: false }]);
    await expect(engine.setTrackFxApply(1, false)).rejects.toThrow(/does not expose callback-acknowledged/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
