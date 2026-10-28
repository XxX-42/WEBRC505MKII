import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeRecordTempoToken,
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
    transport.bpm = startingBpm;
    expect(requestBodies[0]?.url).toContain(`tempoBpm=${startingBpm}`);
    expect(requestBodies[0]?.url).toContain(`tempoRevision=${transportRevision}`);
    expect(JSON.parse(requestBodies[1]?.body ?? '{}')).toMatchObject({
      trackId: 1, tempoBpm: startingBpm, tempoRevision: changedBackRevision,
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
});
