import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { NativeBridgeClient } from '../../src/audio/NativeBridgeClient';

function setup() {
  const engine = new (NativeAudioEngine as unknown as { new(): NativeAudioEngine })() as any;
  const old = { ok: true, hostIncarnationId: 'a'.repeat(32), engineRunning: true, marker: 'old-take' };
  const current = { ok: true, hostIncarnationId: 'a'.repeat(32), engineRunning: true, marker: 'new-take' };
  let entries = [{ trackId: 1, releasePending: false, rejected: false }];
  const bridge = {
    health: vi.fn(async () => ({ ok: true })),
    getStatus: vi.fn(async () => current),
    getPendingNativeTransportBatch: vi.fn(() => null),
    getRetainedTrackTempoConfirmations: vi.fn(() => entries),
    reconcileTrackTempoConfirmation: vi.fn(async () => current),
    releaseTrackTempoConfirmation: vi.fn(async () => { entries = []; }),
    confirmTrackTempoProvenance: vi.fn(),
    recordTrack: vi.fn(),
  };
  engine.bridge = bridge;
  const applied: any[] = [];
  engine.applyStatus = (status: any) => { applied.push(status); engine.latestStatus = status;
    engine.bridgeAvailable = true; engine.engineRunning = status.engineRunning; };
  engine.refreshCatalog = vi.fn(async () => undefined);
  engine.reconcileRhythmScheduleForInit = vi.fn(async (status: any) => ({ status }));
  engine.hydrateNativeCatalogFromStatus = vi.fn();
  engine.syncNativeFxCatalogSlots = vi.fn(async () => undefined);
  engine.refreshStatus = vi.fn(async () => undefined);
  engine.startPolling = vi.fn();
  engine.emitAll = vi.fn();
  return { engine, bridge, old, current, applied, setEntries: (value: typeof entries) => { entries = value; } };
}

describe('Native tempo recovery through init and retry', () => {
  it('reports a recovery block from synchronous ALL controls without throwing', () => {
    const { engine } = setup();
    engine.nativeTempoRecoveryError = 'Native tempo receipt recovery is unresolved.';
    expect(() => engine.stopAllTracks()).not.toThrow();
    expect(() => engine.playAllTracks()).not.toThrow();
    expect(engine.lastError).toContain('recovery is unresolved');
  });
  it('waits for the active batch owner before checking for its durable receipt', async () => {
    const { engine, bridge } = setup();
    let settle!: () => void;
    engine.nativeTransportBatchPending = true;
    engine.nativeTransportBatchSettled = new Promise<void>(resolve => { settle = resolve; });
    const recovery = engine.recoverNativeBatchBeforeTempo();
    expect(bridge.getPendingNativeTransportBatch).not.toHaveBeenCalled();
    engine.nativeTransportBatchPending = false;
    settle();
    await expect(recovery).resolves.toBe('');
    expect(bridge.getPendingNativeTransportBatch).toHaveBeenCalledOnce();
  });
  it('reconciles the exact receipt and hands off fresh current status before release', async () => {
    const { engine, bridge, old, current, applied } = setup();
    bridge.reconcileTrackTempoConfirmation.mockResolvedValueOnce(current);
    await engine.init();
    expect(bridge.reconcileTrackTempoConfirmation).toHaveBeenCalledOnce();
    expect(bridge.releaseTrackTempoConfirmation).toHaveBeenCalledOnce();
    expect(bridge.confirmTrackTempoProvenance).not.toHaveBeenCalled();
    expect(applied).not.toContain(old);
    expect(engine.latestStatus.marker).toBe('new-take');
    expect(engine.isNativeReady()).toBe(true);
  });

  it('uses the real client on reconnect and never applies the historical take', async () => {
    const { engine, current, applied } = setup();
    const identity = { trackId: 1, expectedContentRevision: 8, tempoBpm: 120, tempoRevision: 3,
      stopRevision: 7, expectedConfirmationRevision: 0, hostIncarnationId: 'a'.repeat(32), operationId: 'b'.repeat(32) };
    sessionStorage.setItem('rc505.native.tempo-confirmation.1', JSON.stringify(identity));
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'; calls.push({ url, method });
      let payload: unknown = { ...current, ok: true };
      if (url.endsWith('/health')) payload = { ok: true };
      if (url.endsWith('/receipts')) payload = { ok: true, hostIncarnationId: identity.hostIncarnationId,
        receipts: [{ identity, revision: 1, state: 1 }] };
      if (url.endsWith('/release')) payload = { ok: true, identity };
      return { ok: true, status: 200, json: async () => payload } as Response;
    }));
    try {
      engine.bridge = new NativeBridgeClient('http://127.0.0.1:18756');
      await engine.init();
      expect(calls.filter(call => call.url.endsWith('/receipts'))).toEqual([
        { url: 'http://127.0.0.1:18756/v1/transport/record-tempo/receipts', method: 'GET' },
      ]);
      expect(calls.some(call => call.url.endsWith('/confirm'))).toBe(false);
      expect(calls.filter(call => call.url.endsWith('/release'))).toHaveLength(1);
      expect(applied.every(status => status.marker === 'new-take')).toBe(true);
      expect(sessionStorage.getItem('rc505.native.tempo-confirmation.1')).toBeNull();
    } finally { vi.unstubAllGlobals(); sessionStorage.clear(); }
  });

  it('blocks transport after a network failure, then retry queries without resending', async () => {
    const { engine, bridge } = setup();
    bridge.reconcileTrackTempoConfirmation.mockRejectedValueOnce(new Error('offline'));
    await expect(engine.init()).rejects.toThrow(/recovery is unresolved/);
    expect(engine.getUiStatus()).toMatchObject({ ready: false, message: 'NATIVE TEMPO RECEIPT NEEDS REVIEW' });
    await expect(engine.recordTrack(1)).rejects.toThrow(/recovery is unresolved/);
    expect(bridge.recordTrack).not.toHaveBeenCalled();
    await engine.init();
    expect(bridge.reconcileTrackTempoConfirmation).toHaveBeenCalledTimes(2);
    expect(bridge.confirmTrackTempoProvenance).not.toHaveBeenCalled();
    expect(engine.isNativeReady()).toBe(true);
  });

  it('retries a lost release without querying or repeating confirmation', async () => {
    const { engine, bridge, setEntries } = setup();
    bridge.releaseTrackTempoConfirmation.mockImplementationOnce(async () => {
      setEntries([{ trackId: 1, releasePending: true, rejected: false }]);
      throw new Error('release response lost');
    });
    await expect(engine.init()).rejects.toThrow(/recovery is unresolved/);
    await engine.init();
    expect(bridge.reconcileTrackTempoConfirmation).toHaveBeenCalledTimes(1);
    expect(bridge.releaseTrackTempoConfirmation).toHaveBeenCalledTimes(2);
    expect(bridge.confirmTrackTempoProvenance).not.toHaveBeenCalled();
    expect(engine.isNativeReady()).toBe(true);
  });

  it('releases a callback-rejected receipt and reports unknown tempo', async () => {
    const { engine, bridge, setEntries } = setup();
    bridge.reconcileTrackTempoConfirmation.mockImplementationOnce(async () => {
      setEntries([{ trackId: 1, releasePending: false, rejected: true }]);
      throw new Error('Native REC tempo confirmation was rejected');
    });
    await engine.init();
    expect(bridge.releaseTrackTempoConfirmation).toHaveBeenCalledOnce();
    expect(bridge.confirmTrackTempoProvenance).not.toHaveBeenCalled();
    expect(engine.lastError).toContain('unknown tempo provenance');
    expect(engine.isNativeReady()).toBe(true);
  });

  it('finishes batch recovery before reconciling other retained tempo identities', async () => {
    const { engine, bridge, current } = setup();
    let pending = true;
    const order: string[] = [];
    bridge.getPendingNativeTransportBatch.mockImplementation(() => pending ? { batchId: 1 } as never : null);
    (bridge as any).reconcilePendingNativeTransportBatch = vi.fn(async () => { order.push('batch'); return current; });
    engine.completeNativeBatchTempoHandoff = vi.fn(async () => { order.push('handoff'); pending = false; });
    bridge.reconcileTrackTempoConfirmation.mockImplementation(async () => { order.push('single'); return current; });
    await engine.init();
    expect(order).toEqual(['batch', 'handoff', 'single']);
    expect(bridge.releaseTrackTempoConfirmation).toHaveBeenCalledOnce();
    expect(engine.isNativeReady()).toBe(true);
  });
});
