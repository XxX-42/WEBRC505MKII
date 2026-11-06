import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeRecordTempoToken,
  nativeRecordTempoTokenMatches,
  NativeBridgeClient,
  type NativeStatus,
} from '../../src/audio/NativeBridgeClient';
import { Transport } from '../../src/core/Transport';

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('Native REC tempo provenance tokens', () => {
  it('keeps old/unknown hosts and invalid revisions unknown', () => {
    expect(nativeRecordTempoToken(undefined, 120, 1)).toBeUndefined();
    expect(nativeRecordTempoToken({ nativeTempoRecordProvenanceVersion: 2 } as NativeStatus, 120, 1)).toBeUndefined();
    expect(nativeRecordTempoToken({ nativeTempoRecordProvenanceVersion: 1 } as NativeStatus, 301, 1)).toBeUndefined();
    expect(nativeRecordTempoToken({ nativeTempoRecordProvenanceVersion: 1 } as NativeStatus, 120, Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(nativeRecordTempoToken({ nativeTempoRecordProvenanceVersion: 1 } as NativeStatus, 120, 9)).toEqual({ bpm: 120, revision: 9 });
    expect(nativeRecordTempoTokenMatches({ bpm: 120, revision: 9 }, { bpm: 120, revision: 10 })).toBe(false);
    expect(nativeRecordTempoTokenMatches({ bpm: 120, revision: 9 }, { bpm: 120, revision: 9 })).toBe(true);
  });

  it('sends the same-call Transport tempo revision on record and finish, including change-away-and-back', async () => {
    const transport = Transport.getInstance();
    const startingBpm = transport.bpm;
    const transportRevision = transport.projectMutationRevision;
    const requestBodies: Array<{ url: string; body?: string }> = [];
    const status = {
      ok: true, bridgeHealthy: true, engineRunning: true, backend: 'WASAPI',
      inputDeviceId: '', outputDeviceId: '', inputDeviceName: '', outputDeviceName: '',
      sampleRate: 48000, bufferFrames: 128, monitoringEnabled: false, state: 'Playing',
      inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0, inputPeak: 0, outputPeak: 0,
      xrunsOrDropouts: 0, lastError: '', loopProgress: 0,
      nativeTempoRecordProvenanceVersion: 1,
      nativeRecordPlay: { version: 1, recActionAvailable: true, quantizeAvailable: false,
        recAction: 'REC->PLAY', requestedRevision: 1, appliedRevision: 1,
        finishRequested: [1, 0, 0, 0, 0], finishApplied: [1, 0, 0, 0, 0] },
      nativeRecordTempoProvenance: { version: 1, requestedRevision: [1, 0, 0, 0, 0],
        appliedRevision: [1, 0, 0, 0, 0], acceptedRevision: [1, 0, 0, 0, 0], acceptedRequestRevision: 1 },
      nativeTracks: [{ trackId: 1, state: 'Playing', loopProgress: 0 }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : undefined });
      return jsonResponse(status);
    }));
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const token = nativeRecordTempoToken(status as NativeStatus, startingBpm, transportRevision)!;
    await client.recordTrack(1, token);
    transport.bpm = startingBpm === 120 ? 121 : 120;
    transport.bpm = startingBpm;
    const changedBackRevision = transport.projectMutationRevision;
    expect(changedBackRevision).toBeGreaterThan(transportRevision);
    const finishToken = nativeRecordTempoToken(status as NativeStatus, transport.bpm, changedBackRevision)!;
    await client.finishRecordingTrack(1, finishToken);
    await client.confirmTrackTempoProvenance(1, 3, finishToken);
    transport.bpm = startingBpm;
    expect(requestBodies[0]?.url).toContain(`tempoBpm=${startingBpm}`);
    expect(requestBodies[0]?.url).toContain(`tempoRevision=${transportRevision}`);
    expect(JSON.parse(requestBodies[1]?.body ?? '{}')).toMatchObject({
      trackId: 1, tempoBpm: startingBpm, tempoRevision: changedBackRevision,
    });
    expect(JSON.parse(requestBodies[2]?.body ?? '{}')).toMatchObject({
      trackId: 1, expectedContentRevision: 3, tempoBpm: startingBpm, tempoRevision: changedBackRevision,
    });
  });

  it('keeps legacy requests unchanged when no token is available', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return jsonResponse({ ok: true });
    }));
    await new NativeBridgeClient('http://127.0.0.1:17755').recordTrack(1);
    expect(requests[0]).toBe('http://127.0.0.1:17755/v1/transport/record');
  });

  it('waits for a modern host STOP callback ACK and exposes whether it committed recording', async () => {
    const initial = { ok: true, nativeRecordPlay: { acceptedStopRequestRevision: 4,
      stopRequested: [4, 0, 0, 0, 0], stopApplied: [3, 0, 0, 0, 0],
      stopCommittedRevision: [0, 0, 0, 0, 0] } };
    const applied = { ok: true, nativeRecordPlay: { stopRequested: [4, 0, 0, 0, 0], stopApplied: [4, 0, 0, 0, 0],
      stopCommittedRevision: [4, 0, 0, 0, 0] }, nativeTracks: [{ trackId: 1, state: 'Stopped', contentRevision: 8, loopLengthSamples: 0 }] };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(initial)).mockResolvedValueOnce(jsonResponse(applied));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');

    const status = await client.stopTrack(1, { bpm: 120, revision: 7 }, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('tempoBpm=120&tempoRevision=7');
    expect(status.nativeStopTrackAcknowledgement).toEqual({
      trackId: 1, requestedRevision: 4, appliedRevision: 4, committedRevision: 4,
    });
  });

  it('rejects a concurrent STOP that supersedes the request even if its callback committed', async () => {
    const accepted = { ok: true, nativeRecordPlay: { acceptedStopRequestRevision: 9,
      stopRequested: [9, 0, 0, 0, 0], stopApplied: [8, 0, 0, 0, 0], stopCommittedRevision: [0, 0, 0, 0, 0] } };
    const superseded = { ok: true, nativeRecordPlay: { stopRequested: [10, 0, 0, 0, 0],
      stopApplied: [9, 0, 0, 0, 0], stopCommittedRevision: [9, 0, 0, 0, 0] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(accepted)).mockResolvedValueOnce(jsonResponse(superseded)));
    const client = new NativeBridgeClient('http://127.0.0.1:17755');

    await expect(client.stopTrack(1, { bpm: 120, revision: 7 }, true)).rejects.toThrow(/superseded/);
  });

  it('normalizes old-host metadata without a provenance field to null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, trackId: 1, sampleRate: 48000, frameCount: 64, channels: 2 }),
    }) as Response));
    await expect(new NativeBridgeClient().getTrackMetadata(1)).resolves.toMatchObject({ originalTempoBpm: null });
  });

  it('holds BPM mutations behind the callback confirmation barrier', () => {
    const transport = Transport.getInstance();
    const startBpm = transport.bpm;
    const startRevision = transport.tempoMutationRevision;
    const release = transport.beginTempoCommitBarrier();
    transport.setBpm(startBpm === 120 ? 121 : 120);
    expect(transport.bpm).toBe(startBpm);
    expect(transport.tempoMutationRevision).toBe(startRevision);
    release();
    expect(transport.bpm).not.toBe(startBpm);
    expect(transport.tempoMutationRevision).toBeGreaterThan(startRevision);
    transport.setBpm(startBpm);
  });
});
