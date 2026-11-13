import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { NativeBridgeClient, type NativeStatus } from '../../src/audio/NativeBridgeClient';
const host = 'a'.repeat(32);
function status(requested = 0, applied = 0, requestedRevision = 0, appliedRevision = 0, acceptedRevision?: number): NativeStatus {
  return { ok: true, engineRunning: true, hostIncarnationId: host, nativeTracks: [{ trackId: 3, pan: { requested, applied, requestedRevision, appliedRevision, law: 'webaudio-stereo-v1', ...(acceptedRevision === undefined ? {} : { acceptedRevision }) } }], nativeMemory: { version: 1, loopTransports: [], trackPans: [0, 0, requested, 0, 0] } } as unknown as NativeStatus;
}
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });
function engineFor(bridge: object) {
  Object.assign(bridge, { hasUnresolvedNativeTrackPanOperation: () => false });
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  Object.assign(engine, { bridge, pendingTrackPans: new Set(), nativeMemoryReadbackGeneration: null, latestStatus: null,
    emitAll: () => {}, applyStatus: (s: NativeStatus) => { (engine as any).latestStatus = s; } });
  return engine;
}
describe('Native track PAN acknowledgement', () => {
  it('sends the host and expected revision, then waits for callback readback', async () => {
    const bridge = { getStatus: vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(35, 35, 1, 1)), setTrackPan: vi.fn().mockResolvedValue(status(35, 0, 1, 0, 1)) };
    const engine = engineFor(bridge);
    await engine.setNativeTrackPan(3, 35);
    expect(bridge.setTrackPan).toHaveBeenCalledOnce(); expect(bridge.setTrackPan).toHaveBeenCalledWith(3, 35, 0, host);
    expect(engine.getNativeTrackPanStatus(3)?.applied).toBe(35);
  });
  it('reconciles lost POST with GET only and preserves applied value', async () => {
    const bridge = { getStatus: vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(35, 0, 1, 0)), setTrackPan: vi.fn().mockRejectedValue(new Error('response lost')) };
    const engine = engineFor(bridge);
    await expect(engine.setNativeTrackPan(3, 35)).rejects.toThrow('outcome is unknown');
    expect(bridge.setTrackPan).toHaveBeenCalledOnce(); expect(engine.getNativeTrackPanStatus(3)?.applied).toBe(0);
    expect(engine.hasPendingNativeTrackPanChanges()).toBe(true);
  });
  it('rejects supersession and never sends to an old host', async () => {
    const bridge = { getStatus: vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(40, 40, 2, 2)), setTrackPan: vi.fn().mockResolvedValue(status(35, 0, 1, 0, 1)) };
    const engine = engineFor(bridge);
    await expect(engine.setNativeTrackPan(3, 35)).rejects.toThrow(/superseded/);
    const old = engineFor({ getStatus: vi.fn().mockResolvedValue({ ok: true }), setTrackPan: vi.fn() });
    await expect(old.setNativeTrackPan(3, 35)).rejects.toThrow(/unavailable/);
  });
  it('persists a lost-before-submit receipt across clients until a newer callback revision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network lost')));
    const client = new NativeBridgeClient();
    await expect(client.setTrackPan(3, 10, 0, host)).rejects.toThrow();
    const reloaded = new NativeBridgeClient();
    expect(reloaded.hasUnresolvedNativeTrackPanOperation(3, status())).toBe(true);
    expect(reloaded.hasUnresolvedNativeTrackPanOperation(3, status(20, 0, 1, 0))).toBe(true);
    expect(reloaded.hasUnresolvedNativeTrackPanOperation(3, status(20, 20, 1, 1))).toBe(false);
    expect(new NativeBridgeClient().hasUnresolvedNativeTrackPanOperation(3, status())).toBe(false);
  });
  it('allows a fresh manual CAS while preserving an older uncertain receipt on rejection', async () => {
    const client = new NativeBridgeClient();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, error: 'conflict' }) }));
    await expect(client.setTrackPan(3, 10, 0, host)).rejects.toThrow();
    await expect(client.setTrackPan(3, 20, 0, host)).rejects.toThrow('conflict');
    expect(client.hasUnresolvedNativeTrackPanOperation(3, status())).toBe(true);
    expect(client.hasUnresolvedNativeTrackPanOperation(3, status(20, 20, 1, 1))).toBe(false);
  });
  it('retains the receipt on a 400 after the host may have accepted the mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: 'serialization failure' }) }));
    const client = new NativeBridgeClient();
    await expect(client.setTrackPan(3, 10, 0, host)).rejects.toThrow('serialization failure');
    expect(new NativeBridgeClient().hasUnresolvedNativeTrackPanOperation(3, status())).toBe(true);
    const malformed = status(10, 10, 1, 1);
    malformed.nativeTracks![0]!.pan!.requested = 100;
    expect(client.hasUnresolvedNativeTrackPanOperation(3, malformed)).toBe(true);
    expect(client.hasUnresolvedNativeTrackPanOperation(3, status(10, 10, 1, 1))).toBe(false);
  });
  it('clears only the rejected request receipt when another request is in flight', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first).mockRejectedValueOnce(new Error('lost second')));
    const client = new NativeBridgeClient();
    const pending = client.setTrackPan(3, 10, 0, host);
    await expect(client.setTrackPan(3, 20, 0, host)).rejects.toThrow();
    resolveFirst({ ok: false, status: 409, json: async () => ({ ok: false, error: 'conflict' }) } as Response); await expect(pending).rejects.toThrow('conflict');
    expect(client.hasUnresolvedNativeTrackPanOperation(3, status())).toBe(true);
    expect(client.hasUnresolvedNativeTrackPanOperation(3, status(20, 20, 1, 1))).toBe(false);
  });
  it('rejects stale host or revision edit contexts before POST', async () => {
    for (const context of [{ hostIncarnationId: 'b'.repeat(32), expectedRevision: 0 }, { hostIncarnationId: host, expectedRevision: 1 }]) {
      const bridge = { getStatus: vi.fn().mockResolvedValue(status()), setTrackPan: vi.fn() };
      await expect(engineFor(bridge).setNativeTrackPan(3, 10, context)).rejects.toThrow(/edit context changed/);
      expect(bridge.setTrackPan).not.toHaveBeenCalled();
    }
  });
  it('does not POST when Native audio is stopped', async () => {
    const stopped = { ...status(), engineRunning: false };
    const bridge = { getStatus: vi.fn().mockResolvedValue(stopped), setTrackPan: vi.fn() };
    await expect(engineFor(bridge).setNativeTrackPan(3, 10)).rejects.toThrow(/no request was submitted/);
    expect(bridge.setTrackPan).not.toHaveBeenCalled();
  });
  it('encodes CAS and incarnation in the bridge POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => status(10, 0, 1, 0, 1) }); vi.stubGlobal('fetch', fetchMock);
    try { await new NativeBridgeClient().setTrackPan(3, 10, 0, host);
      const [, init] = fetchMock.mock.calls[0]!; expect(JSON.parse(init.body)).toEqual({ trackId: 3, pan: 10, expectedRevision: 0 });
      expect(new Headers(init.headers).get('X-Native-Host-Incarnation')).toBe(host);
    } finally { vi.unstubAllGlobals(); }
  });
});
