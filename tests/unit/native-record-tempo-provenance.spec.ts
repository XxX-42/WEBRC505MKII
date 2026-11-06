import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeRecordTempoToken,
  nativeRecordTempoTokenMatches,
  NativeBridgeClient,
  type NativeStatus,
} from '../../src/audio/NativeBridgeClient';
import { Transport } from '../../src/core/Transport';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

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
      ok: true, hostIncarnationId: 'a'.repeat(32), bridgeHealthy: true, engineRunning: true, backend: 'WASAPI',
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
      if (String(input).endsWith('/record-tempo/receipts')) return jsonResponse({ ok: true, hostIncarnationId: 'a'.repeat(32), receipts: [{ identity: JSON.parse(sessionStorage.getItem('rc505.native.tempo-confirmation.1')!), revision: 1, state: 1 }] });
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
    expect(JSON.parse(requestBodies.find(item => item.url.endsWith('/record-tempo/confirm'))?.body ?? '{}')).toMatchObject({
      trackId: 1, expectedContentRevision: 3, tempoBpm: startingBpm, tempoRevision: changedBackRevision,
    });
  });

  it('queries the persisted exact receipt after a lost POST response without resending', async () => {
    const status = { ok: true, hostIncarnationId: 'a'.repeat(32), nativeRecordTempoProvenance: { requestedRevision: [0, 0, 0, 0, 0] } };
    let confirmCalls = 0;
    let receiptCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/record-tempo/confirm')) { confirmCalls += 1; throw new Error('response lost'); }
      if (url.endsWith('/record-tempo/receipts')) {
        receiptCalls += 1;
        if (receiptCalls === 1) throw new Error('offline');
        return jsonResponse({ ok: true, hostIncarnationId: 'a'.repeat(32), receipts: [{ identity: JSON.parse(sessionStorage.getItem('rc505.native.tempo-confirmation.1')!), revision: 9, state: 1 }] });
      }
      return jsonResponse(status);
    }));
    const first = new NativeBridgeClient('http://127.0.0.1:17755');
    await expect(first.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7)).rejects.toThrow(/outcome is unknown/);
    const second = new NativeBridgeClient('http://127.0.0.1:17755');
    await expect(second.confirmTrackTempoProvenance(1, 9, { bpm: 120, revision: 3 }, 7)).rejects.toThrow(/different Native tempo/);
    await second.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7);
    expect(confirmCalls).toBe(1);
    expect(receiptCalls).toBe(2);
    await second.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7);
    expect(confirmCalls).toBe(1);
    expect(receiptCalls).toBe(3);
  });

  it('retries only release after its response is lost and verifies the same host', async () => {
    const key = 'rc505.native.tempo-confirmation.1';
    const identity = { trackId: 1, expectedContentRevision: 8, tempoBpm: 120, tempoRevision: 3,
      stopRevision: 7, expectedConfirmationRevision: 0, hostIncarnationId: 'a'.repeat(32), operationId: 'b'.repeat(32) };
    sessionStorage.setItem(key, JSON.stringify(identity));
    sessionStorage.setItem(`${key}.confirmed`, identity.operationId);
    let releases = 0;
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); paths.push(url);
      if (url.endsWith('/release')) {
        if (++releases === 1) throw new Error('response lost');
        return { ok: false, status: 410, json: async () => ({ ok: false, error: 'released' }) } as Response;
      }
      return jsonResponse({ ok: true, hostIncarnationId: identity.hostIncarnationId });
    }));
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    await expect(client.releaseTrackTempoConfirmation(1)).rejects.toThrow();
    expect(sessionStorage.getItem(`${key}.releasePending`)).toBe(identity.operationId);
    await expect(client.reconcileTrackTempoConfirmation(1)).rejects.toThrow(/release is pending/);
    await client.releaseTrackTempoConfirmation(1);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(paths.filter(path => path.endsWith('/release'))).toHaveLength(2);
    expect(paths.some(path => path.endsWith('/confirm'))).toBe(false);
  });

  it('clears only a definite capacity rejection and refuses unknown receipt identities', async () => {
    let capacity = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/confirm')) {
        if (capacity) return { ok: false, status: 429, json: async () => ({ ok: false, error: 'full; no submission' }) } as Response;
        throw new Error('response lost');
      }
      if (url.endsWith('/receipts')) return jsonResponse({ ok: true, hostIncarnationId: 'a'.repeat(32), receipts: [{ identity: { ...JSON.parse(sessionStorage.getItem('rc505.native.tempo-confirmation.1')!), stopRevision: 999 }, revision: 1, state: 1 }] });
      return jsonResponse({ ok: true, hostIncarnationId: 'a'.repeat(32), nativeRecordTempoProvenance: { requestedRevision: [0, 0, 0, 0, 0] } });
    }));
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    await expect(client.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7)).rejects.toThrow(/full/);
    expect(sessionStorage.getItem('rc505.native.tempo-confirmation.1')).toBeNull();
    capacity = false;
    await expect(client.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7)).rejects.toThrow(/exact identity/);
    expect(sessionStorage.getItem('rc505.native.tempo-confirmation.1')).not.toBeNull();
  });

  it('rejects an old host before writing a confirmation identity or submitting', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    await expect(client.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7)).rejects.toThrow(/host incarnation/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('rc505.native.tempo-confirmation.1')).toBeNull();
  });

  it('retains a rejected callback receipt without resubmitting it', async () => {
    let confirms = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/confirm')) { confirms += 1; return jsonResponse({ ok: true }); }
      if (url.endsWith('/receipts')) return jsonResponse({ ok: true, hostIncarnationId: 'a'.repeat(32), receipts: [{ identity: JSON.parse(sessionStorage.getItem('rc505.native.tempo-confirmation.1')!), revision: 2, state: 2 }] });
      return jsonResponse({ ok: true, hostIncarnationId: 'a'.repeat(32), nativeRecordTempoProvenance: { requestedRevision: [1, 0, 0, 0, 0] } });
    }));
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    await expect(client.confirmTrackTempoProvenance(1, 8, { bpm: 120, revision: 3 }, 7)).rejects.toThrow(/rejected/);
    await expect(client.reconcileTrackTempoConfirmation(1)).rejects.toThrow(/rejected/);
    expect(confirms).toBe(1);
    expect(sessionStorage.getItem('rc505.native.tempo-confirmation.1')).not.toBeNull();
  });

  it('hands off and releases each single-track confirmation in sequence', async () => {
    const transport = Transport.getInstance();
    const token = { bpm: transport.bpm, revision: transport.tempoMutationRevision };
    const order: string[] = [];
    const engine = Object.create(NativeAudioEngine.prototype) as any;
    engine.latestStatus = { nativeTempoRecordProvenanceVersion: 1 };
    engine.bridge = {
      confirmTrackTempoProvenance: vi.fn(async () => { order.push('confirm'); return { ok: true }; }),
      releaseTrackTempoConfirmation: vi.fn(async () => { order.push('release'); }),
      getRetainedTrackTempoConfirmations: vi.fn(() => []),
    };
    engine.dispatchStatusRequest = async (request: () => Promise<unknown>) => {
      const result = await request(); order.push('apply'); return result;
    };
    engine.emitAll = vi.fn();
    await engine.confirmCommittedTakeTempo(1, token, 8, 7);
    await engine.confirmCommittedTakeTempo(1, token, 12, 9);
    expect(order).toEqual(['confirm', 'apply', 'release', 'confirm', 'apply', 'release']);
    engine.bridge.releaseTrackTempoConfirmation.mockRejectedValueOnce(new Error('offline'));
    await engine.confirmCommittedTakeTempo(1, token, 16, 11);
    expect(engine.lastError).toContain('tempo was confirmed');
    expect(engine.lastError).toContain('receipt release remains unresolved');
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
