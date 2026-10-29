import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, NATIVE_BRIDGE_REQUEST_TIMEOUT_MS, type NativeStatus } from '../../src/audio/NativeBridgeClient';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

function status(action: 'REC->PLAY' | 'REC->DUB' = 'REC->PLAY', applied = 1, state = 'Playing'): NativeStatus {
  return { ok: true, nativeRecordPlay: { version: 1, recActionAvailable: true, quantizeAvailable: false,
    recAction: action, requestedRevision: 1, appliedRevision: applied,
    finishRequested: [1, 0, 0, 0, 0], finishApplied: [applied, 0, 0, 0, 0] },
    nativeTracks: [{ trackId: 1, state }],
  } as unknown as NativeStatus;
}
const response = (value: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => value }) as Response;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Native REC ACTION provider and atomic completion', () => {
  it('exposes REC ACTION independently from unsupported recording quantization and older hosts', async () => {
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, { latestStatus: status('REC->DUB') });
    expect(engine.getRecordPlaySettings()).toMatchObject({ available: true, recActionAvailable: true,
      quantizeAvailable: false, recAction: 'REC->DUB', quantize: null });
    await expect(engine.setRecordPlaySettings({ quantize: 'OFF' })).rejects.toThrow(/REC QUANTIZE requires the Native Rhythm measure source/);
    Object.assign(engine, { latestStatus: { ok: true } });
    expect(engine.getRecordPlaySettings()).toMatchObject({ available: false, recAction: null, quantize: null });
    await expect(engine.setRecordPlaySettings({ recAction: 'REC->PLAY' })).rejects.toThrow(/unavailable/);
  });
  it('waits for the exact REC ACTION callback revision without resending the setting', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValueOnce(response(status('REC->DUB', 0))).mockResolvedValue(response(status('REC->DUB')));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new NativeBridgeClient().setRecordAction('REC->DUB');
    const accepted = expect(pending).resolves.toMatchObject({ nativeRecordPlay: { recAction: 'REC->DUB', appliedRevision: 1 } });
    await vi.advanceTimersByTimeAsync(20); await accepted;
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v1/record/settings');
  });
  it('uses one atomic completion command and waits for actual Overdubbing instead of accepted Recording', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().mockResolvedValueOnce(response(status('REC->DUB', 0, 'Recording')))
      .mockResolvedValue(response(status('REC->DUB', 1, 'Overdubbing')));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new NativeBridgeClient().finishRecordingTrack(1);
    const accepted = expect(pending).resolves.toMatchObject({ nativeTracks: [{ state: 'Overdubbing' }] });
    await vi.advanceTimersByTimeAsync(20); await accepted;
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toContain('/v1/transport/finish-record');
    expect(posts[0]?.[1]?.body).toBe(JSON.stringify({ trackId: 1 }));
    expect(fetchMock.mock.calls.some(([url]) => /\/transport\/(stop|play)$/.test(String(url)))).toBe(false);
  });
  it('never accepts an ACK without the target track state and never retries its write', async () => {
    vi.useFakeTimers();
    const malformed = status(); malformed.nativeTracks = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(malformed)); vi.stubGlobal('fetch', fetchMock);
    const rejection = expect(new NativeBridgeClient().finishRecordingTrack(1)).rejects.toThrow(/acknowledgement timed out/);
    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_REQUEST_TIMEOUT_MS + 20); await rejection;
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('forces emergency STOP ACK polling without a tempo token and requires committed PCM readback', async () => {
    vi.useFakeTimers();
    const accepted: NativeStatus = { ok: true, nativeRecordPlay: { acceptedStopRequestRevision: 4,
      stopRequested: [0, 4, 0, 0, 0], stopApplied: [0, 0, 0, 0, 0], stopCommittedRevision: [0, 0, 0, 0, 0] },
      nativeTracks: [{ trackId: 2, state: 'Recording', contentRevision: 8, loopLengthSamples: 1024 }] } as unknown as NativeStatus;
    const committed: NativeStatus = { ok: true, nativeRecordPlay: { acceptedStopRequestRevision: 4,
      stopRequested: [0, 4, 0, 0, 0], stopApplied: [0, 4, 0, 0, 0], stopCommittedRevision: [0, 4, 0, 0, 0] },
      nativeTracks: [{ trackId: 2, state: 'Stopped', contentRevision: 9, loopLengthSamples: 1088 }] } as unknown as NativeStatus;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response(accepted)).mockResolvedValueOnce(response(committed));
    vi.stubGlobal('fetch', fetchMock);
    const pending = new NativeBridgeClient().emergencyStopTrack(2);
    const resolved = expect(pending).resolves.toMatchObject({
      nativeTracks: [{ trackId: 2, state: 'Stopped', contentRevision: 9, loopLengthSamples: 1088 }],
      nativeStopTrackAcknowledgement: { trackId: 2, requestedRevision: 4, appliedRevision: 4, committedRevision: 4 },
    });
    await vi.advanceTimersByTimeAsync(20);
    await resolved;
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v1/transport/emergency-stop?trackId=2');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/status'))).toBe(true);
  });
  it('surfaces a phase-token cancellation while retaining the Recording state', async () => {
    vi.useFakeTimers();
    const accepted: NativeStatus = { ok: true, nativeRecordPlay: { acceptedStopRequestRevision: 5,
      stopRequested: [0, 5, 0, 0, 0], stopApplied: [0, 0, 0, 0, 0], stopCommittedRevision: [0, 0, 0, 0, 0],
      stopCancelled: [0, 0, 0, 0, 0] },
      nativeTracks: [{ trackId: 2, state: 'Recording', contentRevision: 8, loopLengthSamples: 1024 }] } as unknown as NativeStatus;
    const cancelled: NativeStatus = { ok: true, nativeRecordPlay: { acceptedStopRequestRevision: 5,
      stopRequested: [0, 5, 0, 0, 0], stopApplied: [0, 5, 0, 0, 0], stopCommittedRevision: [0, 0, 0, 0, 0],
      stopCancelled: [0, 5, 0, 0, 0] },
      nativeTracks: [{ trackId: 2, state: 'Recording', contentRevision: 8, loopLengthSamples: 1024 }] } as unknown as NativeStatus;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response(accepted)).mockResolvedValueOnce(response(cancelled));
    vi.stubGlobal('fetch', fetchMock);
    const pending = expect(new NativeBridgeClient().emergencyStopTrack(2)).rejects.toThrow(/recording is retained/);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/v1/status'))).toBe(true);
  });
  it('reports cancellation during runtime reset without resending a completed command', async () => {
    const cancelled = status('REC->PLAY', 0, 'Recording');
    cancelled.nativeRecordPlay!.finishCancelled = [1, 0, 0, 0, 0];
    const fetchMock = vi.fn(async () => response(cancelled)); vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().finishRecordingTrack(1)).rejects.toThrow(/cancelled by a runtime reset/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('preserves a real host rejection instead of falling back to stop/play', async () => {
    const fetchMock = vi.fn(async () => response({ ok: false, error: 'snapshot budget exhausted' }, 409));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().finishRecordingTrack(1)).rejects.toThrow(/snapshot budget exhausted/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
