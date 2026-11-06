import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { NativeBridgeClient, NativeBridgeHttpError } from '../../src/audio/NativeBridgeClient';
import { Transport } from '../../src/core/Transport';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

const hostA = 'a'.repeat(32), hostB = 'b'.repeat(32);
const intentA = '1'.repeat(32), intentB = '2'.repeat(32), intentExternal = '3'.repeat(32);
function status(host: string, bpm: number, revision: number, intent: string) {
  const base = nativeRhythmStatus({ bpm });
  return { ...base, hostIncarnationId: host, nativeRhythm: { ...base.nativeRhythm!,
    tempoRequestReceiptVersion: 1, tempoRequestIntentId: intent, tempoRequestedRevision: revision,
    tempoAppliedRevision: revision, tempoAppliedValid: true } };
}

const engines: any[] = [];
afterEach(() => {
  const transport = Transport.getInstance();
  for (const engine of engines.splice(0)) {
    transport.off('bpm-change', engine.onTransportBpmChange);
    transport.off('time-signature-change', engine.onTransportBpmChange);
  }
  transport.setBpm(120);
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function setup() {
  const transport = Transport.getInstance();
  transport.setBpm(120);
  const engine = new (NativeAudioEngine as unknown as { new(): NativeAudioEngine })() as any;
  engines.push(engine);
  engine.scheduleNativeFxSync = vi.fn();
  engine.emitAll = vi.fn();
  const requests: Array<{ bpm: number; resolve: (status: any) => void; reject: (error: Error) => void }> = [];
  let retained: { host: string; intent: string; baseline: number } | null = null;
  const bridge = {
    getPendingRhythmTempoIdentity: vi.fn(() => retained),
    releaseSupersededRhythmTempoIdentity: vi.fn(() => true),
    setRhythm: vi.fn((config: { bpm: number }) => new Promise((resolve, reject) => requests.push({ bpm: config.bpm, resolve, reject }))),
    getPendingNativeTransportBatch: vi.fn(() => null),
  };
  engine.bridge = bridge;
  const initial = status(hostA, 120, 0, '0'.repeat(32));
  engine.bindTempoHostFromConnection(initial);
  engine.applyStatus(initial);
  return { engine, transport, requests, bridge, setRetained: (value: typeof retained) => { retained = value; } };
}

describe('Native user BPM intent and confirmed revision', () => {
  it('keeps 128 when 126 ACK arrives and rejects a later older poll after 128 ACK', async () => {
    const { engine, transport, requests } = setup();
    transport.setBpm(126);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    transport.setBpm(128);
    requests[0]!.resolve(status(hostA, 126, 1, intentA));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(transport.bpm).toBe(128);
    requests[1]!.resolve(status(hostA, 128, 2, intentB));
    await vi.waitFor(() => expect(engine.localTempoIntent).toBeNull());
    engine.applyStatus(status(hostA, 126, 1, intentA));
    expect(transport.bpm).toBe(128);
    expect(engine.latestStatus.nativeRhythm.bpm).toBe(128);
    engine.applyStatus(status(hostA, 130, 3, intentExternal));
    expect(transport.bpm).toBe(130);
  });

  it('preserves a failed local intention against its own late ACK and accepts a higher external ACK', async () => {
    const { engine, transport, requests, setRetained } = setup();
    transport.setBpm(128);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setRetained({ host: hostA, intent: intentB, baseline: 0 });
    requests[0]!.reject(new Error('confirmation response lost'));
    await vi.waitFor(() => expect(engine.localTempoIntent?.state).toBe('failed'));
    engine.applyStatus(status(hostA, 126, 0, '0'.repeat(32)));
    engine.applyStatus(status(hostA, 128, 1, intentB));
    expect(transport.bpm).toBe(128);
    expect(engine.localTempoIntent?.state).toBe('failed');
    engine.applyStatus(status(hostA, 130, 2, intentExternal));
    expect(transport.bpm).toBe(130);
    expect(engine.localTempoIntent).toBeNull();
  });

  it('restores the last confirmed BPM after a definite 4xx without a newer edit', async () => {
    const { engine, transport, requests } = setup();
    engine.applyStatus(status(hostA, 137, 1, intentExternal));
    expect(transport.bpm).toBe(137);
    transport.setBpm(149);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]!.reject(new NativeBridgeHttpError('BPM rejected before submission', 409));
    await vi.waitFor(() => expect(engine.localTempoIntent).toBeNull());
    expect(transport.bpm).toBe(137);
    expect(engine.getUiStatus().lastError).toContain('BPM change was rejected');
    engine.applyStatus(status(hostA, 137, 1, intentExternal));
    expect(engine.getUiStatus().lastError).toContain('BPM change was rejected');
  });

  it('does not roll back a newer 150 edit when an earlier 149 request is rejected', async () => {
    const { engine, transport, requests } = setup();
    transport.setBpm(149);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    transport.setBpm(150);
    requests[0]!.reject(new NativeBridgeHttpError('BPM rejected before submission', 409));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(transport.bpm).toBe(150);
    requests[1]!.resolve(status(hostA, 150, 1, intentB));
    await vi.waitFor(() => expect(engine.localTempoIntent).toBeNull());
    expect(transport.bpm).toBe(150);
  });

  it('keeps an unknown intent and visible error when a later status read returns 4xx', async () => {
    const { engine, transport, requests, setRetained } = setup();
    transport.setBpm(149);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setRetained({ host: hostA, intent: intentB, baseline: 0 });
    requests[0]!.reject(new NativeBridgeHttpError('receipt unavailable', 404));
    await vi.waitFor(() => expect(engine.localTempoIntent?.state).toBe('failed'));
    expect(transport.bpm).toBe(149);
    expect(engine.getUiStatus()).toMatchObject({ ready: false, message: 'NATIVE BPM OUTCOME UNKNOWN' });
    engine.applyStatus(status(hostA, 120, 0, '0'.repeat(32)));
    expect(transport.bpm).toBe(149);
    expect(engine.getUiStatus().lastError).toContain('outcome is unknown');
    await expect(engine.recordTrack(1)).rejects.toThrow(/BPM intent/);
  });

  it('resolves an unknown intent through its exact read-only receipt on retry', async () => {
    const { engine, transport, requests, bridge, setRetained } = setup();
    transport.setBpm(149);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setRetained({ host: hostA, intent: intentB, baseline: 0 });
    requests[0]!.reject(new Error('response lost'));
    await vi.waitFor(() => expect(engine.localTempoIntent?.state).toBe('failed'));
    (bridge as any).reconcilePendingRhythmTempo = vi.fn().mockResolvedValue(status(hostA, 149, 1, intentB));
    await engine.reconcileLocalTempoIntent();
    expect((bridge as any).reconcilePendingRhythmTempo).toHaveBeenCalledWith(149, hostA, null);
    expect(requests).toHaveLength(1);
    expect(engine.localTempoIntent).toBeNull();
    expect(transport.bpm).toBe(149);
  });

  it('restores a retained ordinary request as unknown after reload and only queries it', async () => {
    const { engine, transport, requests, bridge } = setup();
    (bridge.getPendingRhythmTempoIdentity as any).mockReturnValue({ host: hostA, intent: intentB, baseline: 0, owner: null, bpm: 149 });
    (bridge as any).reconcilePendingRhythmTempo = vi.fn().mockResolvedValue(status(hostA, 149, 1, intentB));
    let finish!: () => void;
    engine.initializeNative = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const initializing = engine.init();
    expect(transport.bpm).toBe(149);
    expect(engine.getUiStatus()).toMatchObject({ ready: false, message: 'NATIVE BPM OUTCOME UNKNOWN' });
    finish();
    await initializing;
    expect(engine.localTempoIntent).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('retires only an ordinary request proven superseded by a later different confirmed intent', () => {
    const key = 'rc505.native.rhythm-tempo-request';
    const rhythm = nativeRhythmStatus({ bpm: 128 }).nativeRhythm!;
    const config = { enabled: rhythm.enabled, bpm: rhythm.bpm, kitIndex: rhythm.kitIndex, patternIndex: rhythm.patternIndex,
      variation: rhythm.variation, section: rhythm.section, swingPercent: rhythm.swingPercent,
      quantizeGrid: rhythm.quantizeGrid, volume: rhythm.volume };
    const pending = { host: hostA, intent: intentB, baseline: 0, baselineConfig: 0, baselineBpm: 120,
      baselineTempoIntent: '0'.repeat(32), owner: null, config };
    sessionStorage.setItem(key, JSON.stringify(pending));
    const client = new NativeBridgeClient();
    expect(client.releaseSupersededRhythmTempoIdentity(hostA, 1, intentExternal)).toBe(false);
    expect(client.releaseSupersededRhythmTempoIdentity(hostA, 2, intentB)).toBe(false);
    expect(client.releaseSupersededRhythmTempoIdentity(hostB, 2, intentExternal)).toBe(false);
    sessionStorage.setItem(key, JSON.stringify({ ...pending, owner: 'import:7' }));
    expect(client.releaseSupersededRhythmTempoIdentity(hostA, 2, intentExternal)).toBe(false);
    sessionStorage.setItem(key, JSON.stringify(pending));
    expect(client.releaseSupersededRhythmTempoIdentity(hostA, 2, intentExternal)).toBe(true);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('does not bind a new host from polling and ignores retired-host replies after explicit binding', () => {
    const { engine, transport } = setup();
    engine.applyStatus(status(hostB, 135, 0, '0'.repeat(32)));
    expect(transport.bpm).toBe(120);
    expect(engine.getUiStatus()).toMatchObject({ ready: false, message: 'NATIVE HOST CHANGED' });
    engine.bindTempoHostFromConnection(status(hostB, 135, 0, '0'.repeat(32)));
    engine.applyStatus(status(hostB, 135, 0, '0'.repeat(32)));
    expect(transport.bpm).toBe(135);
    engine.applyStatus(status(hostA, 120, 10, intentA));
    expect(transport.bpm).toBe(135);
    expect(engine.latestStatus.hostIncarnationId).toBe(hostB);
  });

  it('binds a new incarnation only through health-checked Native init', async () => {
    const { engine, bridge, transport } = setup();
    const next = status(hostB, 135, 0, '0'.repeat(32));
    engine.applyStatus(next);
    expect(transport.bpm).toBe(120);
    Object.assign(bridge, { health: vi.fn(async () => ({ ok: true })), getStatus: vi.fn(async () => next),
      getRetainedTrackTempoConfirmations: vi.fn(() => []) });
    engine.refreshCatalog = vi.fn(async () => undefined);
    engine.recoverNativeReceipts = vi.fn(async () => '');
    engine.reconcileRhythmScheduleForInit = vi.fn(async (value: any) => ({ status: value }));
    engine.hydrateNativeCatalogFromStatus = vi.fn();
    engine.syncNativeFxCatalogSlots = vi.fn(async () => undefined);
    engine.refreshStatus = vi.fn(async () => undefined);
    engine.startPolling = vi.fn();
    await engine.init();
    expect((bridge as any).health).toHaveBeenCalledOnce();
    expect(engine.boundTempoHost).toBe(hostB);
    expect(transport.bpm).toBe(135);
    engine.applyStatus(status(hostA, 120, 10, intentA));
    expect(transport.bpm).toBe(135);
  });

  it('does not adopt an unacknowledged requested BPM', () => {
    const { engine, transport } = setup();
    const pending = status(hostA, 125, 1, intentExternal);
    pending.nativeRhythm.tempoAppliedRevision = 0;
    engine.applyStatus(pending);
    expect(transport.bpm).toBe(120);
    engine.applyStatus(status(hostA, 125, 1, intentExternal));
    expect(transport.bpm).toBe(125);
  });

  it('preserves an unknown old-host user intent after a newly verified host', async () => {
    const { engine, transport, requests, setRetained } = setup();
    transport.setBpm(128);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    setRetained({ host: hostA, intent: intentB, baseline: 0 });
    requests[0]!.reject(new Error('confirmation response lost'));
    await vi.waitFor(() => expect(engine.localTempoIntent?.state).toBe('failed'));
    engine.bindTempoHostFromConnection(status(hostB, 135, 0, '0'.repeat(32)));
    engine.applyStatus(status(hostB, 135, 0, '0'.repeat(32)));
    expect(transport.bpm).toBe(128);
    expect(engine.localTempoIntent?.state).toBe('failed');
  });

  it('keeps local BPM after failed init and later poll, then adopts after successful retry', async () => {
    const { engine, transport } = setup();
    engine.initializeNative = vi.fn().mockRejectedValueOnce(new Error('recovery failed')).mockResolvedValueOnce(undefined);
    await expect(engine.init()).rejects.toThrow('recovery failed');
    engine.applyStatus(status(hostA, 125, 1, intentExternal));
    expect(transport.bpm).toBe(120);
    await engine.init();
    expect(transport.bpm).toBe(125);
  });

  it('keeps a user edit made during init and dispatches it only after recovery', async () => {
    const { engine, transport, requests } = setup();
    let finish!: () => void;
    engine.initializeNative = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const initializing = engine.init();
    transport.setBpm(126);
    engine.applyStatus(status(hostA, 120, 0, '0'.repeat(32)));
    expect(transport.bpm).toBe(126);
    expect(requests).toHaveLength(0);
    finish();
    await initializing;
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    engine.applyStatus(status(hostA, 120, 0, '0'.repeat(32)));
    expect(transport.bpm).toBe(126);
    requests[0]!.resolve(status(hostA, 126, 1, intentA));
    await vi.waitFor(() => expect(engine.localTempoIntent).toBeNull());
    expect(transport.bpm).toBe(126);
  });
});
