import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { NativeAutoRecTriggerWonCancelError, NativeBridgeClient, type NativeStatus } from '../../src/audio/NativeBridgeClient';
import { NativeTrackProxy } from '../../src/audio/NativeTrackProxy';
import { TrackState } from '../../src/core/types';
import { resolveRc505TrackControls } from '../../src/ui/rc505/Rc505ControlStateResolver';

const host = 'a'.repeat(32);
const intent = 'b'.repeat(32);
function autoStatus(overrides: Partial<NativeStatus['nativeAutoRec']> = {}, trackOverrides: Record<string, unknown> = {}): NativeStatus {
  return { ok: true, hostIncarnationId: host, nativeMemory: { version: 1, loopTransports: [], autoRec: { enabled: true, sensitivity: 50 } },
    nativeAutoRec: { available: true, detectorModel: 'raw-peak-dbfs-v1',
      settings: { enabled: true, sensitivity: 50, requestedRevision: 2, appliedRevision: 2 },
      tracks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, intentId: '', armRequestedRevision: 0,
        armAppliedRevision: 0, triggerAppliedRevision: 0, triggerContentRevision: 0, cancelAppliedRevision: 0, armed: false,
        ...(index === 0 ? trackOverrides : {}) })), ...overrides } } as unknown as NativeStatus;
}
const response = (value: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => value }) as Response;
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('Native AUTO REC client protocol and acknowledged UI state', () => {
  it('submits one settings CAS with host incarnation and verifies the applied revision', async () => {
    const status = autoStatus({ settings: { enabled: false, sensitivity: 50, requestedRevision: 4, appliedRevision: 4 } });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (String(_url).endsWith('/v1/status')) return response(status);
      const request = JSON.parse(String(init?.body));
      expect(request).toEqual({ enabled: true, sensitivity: 50, expectedRevision: 4 });
      expect(new Headers(init?.headers).get('X-Native-Host-Incarnation')).toBe(host);
      status.nativeAutoRec!.settings = { ...status.nativeAutoRec!.settings, enabled: true, requestedRevision: 5, appliedRevision: 5 };
      status.nativeMemory!.autoRec = { enabled: true, sensitivity: 50 };
      return response(status);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new NativeBridgeClient().setNativeAutoRecSettings({ enabled: true, sensitivity: 50 }, 4, host);
    expect(result.nativeAutoRec?.settings).toMatchObject({ enabled: true, requestedRevision: 5, appliedRevision: 5 });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps the last applied setting visible while the request is pending, then accepts new values only after callback apply', async () => {
    const pending = autoStatus({ settings: { enabled: false, sensitivity: 50, requestedRevision: 4, appliedRevision: 3 } });
    const applied = autoStatus({ settings: { enabled: true, sensitivity: 77, requestedRevision: 4, appliedRevision: 4 } });
    pending.nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: true, recAction: 'REC->DUB',
      quantize: 'OFF', requestedRevision: 1, appliedRevision: 1 };
    applied.nativeRecordPlay = pending.nativeRecordPlay;
    const bridge = { reconcileNativeAutoRecSettings: vi.fn(() => 'clear'), setNativeAutoRecSettings: vi.fn(async () => pending), getStatus: vi.fn(async () => applied) };
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, { latestStatus: { ...pending, nativeAutoRec: { ...pending.nativeAutoRec!, settings: { enabled: false,
      sensitivity: 50, requestedRevision: 3, appliedRevision: 3 } } }, bridge,
      dispatchStatusRequest: async (request: () => Promise<NativeStatus>) => {
        const status = await request(); (engine as any).latestStatus = status; return status;
      }, applyStatus: (status: NativeStatus) => { (engine as any).latestStatus = status; },
      hasUnresolvedNativeAutoRecOperation: () => false });
    expect(engine.getNativeAutoRecSettings()).toEqual({ enabled: false, sensitivity: 50 });
    Object.assign(engine, { latestStatus: pending });
    expect(engine.getNativeAutoRecSettings()).toEqual({ enabled: false, sensitivity: 50 });
    expect(engine.isNativeAutoRecSettingsPending()).toBe(true);
    (engine as any).latestStatus = { ...pending, nativeAutoRec: { ...pending.nativeAutoRec!, settings: { enabled: false, sensitivity: 50, requestedRevision: 3, appliedRevision: 3 } } };
    await engine.setNativeAutoRecSettings({ enabled: true, sensitivity: 77 });
    expect(bridge.setNativeAutoRecSettings).toHaveBeenCalledWith({ enabled: true, sensitivity: 77 }, 3, host);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    expect(engine.getNativeAutoRecSettings()).toEqual({ enabled: true, sensitivity: 77 });
  });

  it('retains a lost settings CAS across clients and reconciles only after revision advances', async () => {
    const status = autoStatus({ settings: { enabled: false, sensitivity: 50, requestedRevision: 4, appliedRevision: 4 } });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('response lost');
      return response(status);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().setNativeAutoRecSettings({ enabled: true, sensitivity: 77 }, 4, host)).rejects.toThrow();
    const reloaded = new NativeBridgeClient();
    expect(reloaded.reconcileNativeAutoRecSettings(status)).toBe('unknown');
    await expect(reloaded.setNativeAutoRecSettings({ enabled: true, sensitivity: 77 }, 4, host)).rejects.toThrow(/unknown/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    status.nativeAutoRec!.settings = { enabled: true, sensitivity: 77, requestedRevision: 5, appliedRevision: 5 };
    expect(reloaded.reconcileNativeAutoRecSettings(status)).toBe('confirmed');
    expect(reloaded.reconcileNativeAutoRecSettings(status)).toBe('clear');
  });

  it('fails closed on corrupt settings identity and reports an advanced different value as superseded', async () => {
    const status = autoStatus();
    const client = new NativeBridgeClient();
    sessionStorage.setItem('webrc.nativeAutoRecSettingsReceipt.v1', '{bad');
    expect(client.reconcileNativeAutoRecSettings(status)).toBe('unknown');
    vi.stubGlobal('fetch', vi.fn(async () => response(status)));
    await expect(client.armNativeAutoRecTrack(1)).rejects.toThrow(/settings outcome is unknown/);
    sessionStorage.setItem('webrc.nativeAutoRecSettingsReceipt.v1', JSON.stringify({ hostIncarnationId: host, baseline: 1, enabled: false, sensitivity: 33 }));
    expect(client.reconcileNativeAutoRecSettings(status)).toBe('superseded');
  });

  it('uses an intent receipt for arm, never marks a request-only or unrelated arm as this client ACK', async () => {
    const initial = autoStatus();
    const target = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1, armed: true });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/status')) return response(initial);
      expect(String(url)).toContain('/v1/transport/record/auto-rec?trackId=1');
      expect(new Headers(init?.headers).get('X-Native-Host-Incarnation')).toBe(host);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ expectedArmRevision: 0 });
      expect(body.intentId).toMatch(/^[0-9a-f]{32}$/);
      target.nativeAutoRec!.tracks[0]!.intentId = body.intentId;
      return response(target);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const armed = await client.armNativeAutoRecTrack(1);
    expect(armed.nativeAutoRec?.tracks[0]).toMatchObject({ armRequestedRevision: 1, armAppliedRevision: 1, armed: true });
    expect(client.isNativeAutoRecArmConfirmed(1, armed)).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)[0]).toMatchObject({ operation: 'arm', hostIncarnationId: host, armRevision: 1 });
  });

  it('reconciles a lost arm response against its exact generation and never resends the POST', async () => {
    const initial = autoStatus();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => response(initial))
      .mockRejectedValueOnce(new Error('connection dropped after submit'))
      .mockImplementationOnce(async () => {
        const receipt = JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)[0];
        return response(autoStatus({}, { intentId: receipt.intentId, armRequestedRevision: 1, armAppliedRevision: 1, armed: true }));
      });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const reconciled = await client.armNativeAutoRecTrack(1);
    expect(client.isNativeAutoRecArmConfirmed(1, reconciled)).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('retains an unresolved late arm identity and blocks another POST when status has not caught up', async () => {
    const initial = autoStatus();
    const fetchMock = vi.fn().mockImplementationOnce(async () => response(initial))
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockImplementationOnce(async () => response(initial))
      .mockImplementationOnce(async () => response(initial));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    await expect(client.armNativeAutoRecTrack(1)).rejects.toThrow(/identity .* retained/);
    await expect(client.armNativeAutoRecTrack(1)).rejects.toThrow(/outcome is unknown/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)).toHaveLength(1);
  });

  it('blocks arm before POST for corrupt storage, storage write failure, and an old host receipt', async () => {
    const initial = autoStatus();
    const getOnly = vi.fn(async () => response(initial)); vi.stubGlobal('fetch', getOnly);
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', '{corrupt');
    await expect(new NativeBridgeClient().armNativeAutoRecTrack(1)).rejects.toThrow(/identity is invalid/);
    expect(getOnly.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    sessionStorage.clear();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
    await expect(new NativeBridgeClient().armNativeAutoRecTrack(1)).rejects.toThrow(/could not be retained/);
    expect(getOnly.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    vi.restoreAllMocks();

    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([{ operation: 'arm', trackId: 1,
      hostIncarnationId: 'c'.repeat(32), intentId: intent, expectedArmRevision: 0, armRevision: 1 }]));
    await expect(new NativeBridgeClient().armNativeAutoRecTrack(1)).rejects.toThrow(/outcome is unknown/);
    expect(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')).toContain('c'.repeat(32));
    expect(getOnly.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('cancels only the armed generation and treats a trigger race as triggered, not cancelled', async () => {
    const receipt = { operation: 'arm', trackId: 1, hostIncarnationId: host, intentId: intent, expectedArmRevision: 0, armRevision: 1 };
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([receipt]));
    const armed = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1, armed: true });
    const cancelled = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1, cancelAppliedRevision: 1, armed: false });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/status')) return response(armed);
      expect(String(url)).toContain('/v1/transport/record/auto-rec/cancel?trackId=1');
      expect(JSON.parse(String(init?.body))).toEqual({ intentId: intent, armRevision: 1 });
      expect(new Headers(init?.headers).get('X-Native-Host-Incarnation')).toBe(host);
      return response(cancelled);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().cancelNativeAutoRecTrack(1)).resolves.toMatchObject({
      nativeAutoRec: { tracks: expect.arrayContaining([expect.objectContaining({ cancelAppliedRevision: 1, armed: false })]) },
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')).toBeNull();
  });

  it('surfaces a trigger-winning cancel race and does not call it a successful cancel', async () => {
    const receipt = { operation: 'arm', trackId: 1, hostIncarnationId: host, intentId: intent, expectedArmRevision: 0, armRevision: 1 };
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([receipt]));
    const armed = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1, armed: true });
    const triggered = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false });
    triggered.nativeTracks = [{ trackId: 1, state: 'Recording', contentRevision: 9 }];
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/v1/status') ? response(armed) : response(triggered));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().cancelNativeAutoRecTrack(1)).rejects.toBeInstanceOf(NativeAutoRecTriggerWonCancelError);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)[0]).toMatchObject({ operation: 'arm', armRevision: 1 });
  });

  it('stops the exact trigger take through the conditional route and records its stop identity before POST', async () => {
    const armReceipt = { operation: 'arm', trackId: 1, hostIncarnationId: host, intentId: intent, expectedArmRevision: 0, armRevision: 1 };
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([armReceipt]));
    const before = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false });
    before.nativeTracks = [{ trackId: 1, state: 'Recording', contentRevision: 9 }];
    const after = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false, stopReceipt: { intentId: '', armRevision: 1, expectedContentRevision: 9,
        requestedRevision: 1, appliedRevision: 1, rejectedRevision: 0, appliedContentRevision: 10 } });
    after.nativeTracks = [{ trackId: 1, state: 'Stopped', contentRevision: 10 }];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/status')) return response(before);
      const stored = JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)[0];
      const body = JSON.parse(String(init?.body));
      expect(String(url)).toContain('/v1/transport/record/auto-rec/stop?trackId=1');
      expect(new Headers(init?.headers).get('X-Native-Host-Incarnation')).toBe(host);
      expect(body).toMatchObject({ intentId: intent, armRevision: 1, expectedContentRevision: 9, stopIntentId: stored.stopIntentId });
      expect(stored).toMatchObject({ operation: 'stop', hostIncarnationId: host, expectedContentRevision: 9 });
      after.nativeAutoRec!.tracks[0]!.stopReceipt!.intentId = body.stopIntentId;
      return response(after);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().stopNativeAutoRecTriggeredTrack(1, 9)).resolves.toMatchObject({
      nativeTracks: [{ state: 'Stopped', contentRevision: 10 }],
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')).toBeNull();
  });

  it('keeps a pending conditional STOP receipt and never replays it after a lost response', async () => {
    const armReceipt = { operation: 'arm', trackId: 1, hostIncarnationId: host, intentId: intent, expectedArmRevision: 0, armRevision: 1 };
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([armReceipt]));
    const before = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false });
    before.nativeTracks = [{ trackId: 1, state: 'Recording', contentRevision: 9 }];
    const pendingStatus = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false, stopReceipt: { intentId: '', armRevision: 1, expectedContentRevision: 9,
        requestedRevision: 1, appliedRevision: 0, rejectedRevision: 0, appliedContentRevision: 0 } });
    pendingStatus.nativeTracks = before.nativeTracks;
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => response(before))
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockImplementationOnce(async () => {
        const stored = JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)[0];
        pendingStatus.nativeAutoRec!.tracks[0]!.stopReceipt!.intentId = stored.stopIntentId;
        return response(pendingStatus);
      })
      .mockImplementationOnce(async () => response(pendingStatus));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    await expect(client.stopNativeAutoRecTriggeredTrack(1, 9)).rejects.toThrow(/identity .* retained/);
    await expect(client.stopNativeAutoRecTriggeredTrack(1, 9)).rejects.toThrow(/unresolved/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('webrc.nativeAutoRecArmReceipts.v1')!)[0]).toMatchObject({ operation: 'stop', expectedContentRevision: 9 });
  });

  it('does not stop a newer take and reconciles a completed stop after reload using GET only', async () => {
    const receipt = { operation: 'stop', trackId: 1, hostIncarnationId: host, intentId: intent,
      expectedArmRevision: 0, armRevision: 1, stopIntentId: 'c'.repeat(32), expectedContentRevision: 9 };
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([receipt]));
    const status = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false, stopReceipt: { intentId: receipt.stopIntentId, armRevision: 1,
        expectedContentRevision: 9, requestedRevision: 1, appliedRevision: 1, rejectedRevision: 0, appliedContentRevision: 10 } });
    status.nativeTracks = [{ trackId: 1, state: 'Stopped', contentRevision: 10 }];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(status));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().stopNativeAutoRecTriggeredTrack(1, 9)).resolves.toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([{ ...receipt, operation: 'arm', stopIntentId: undefined, expectedContentRevision: undefined }]));
    status.nativeTracks = [{ trackId: 1, state: 'Recording', contentRevision: 11 }];
    await expect(new NativeBridgeClient().stopNativeAutoRecTriggeredTrack(1, 11)).rejects.toThrow(/exact-take STOP refused/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a trigger-winning cancel race with one callback-CAS STOP for that same take', async () => {
    const receipt = { operation: 'arm', trackId: 1, hostIncarnationId: host, intentId: intent, expectedArmRevision: 0, armRevision: 1 };
    const triggerStatus = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false });
    triggerStatus.nativeTracks = [{ trackId: 1, state: 'Recording', contentRevision: 9 }];
    const typed = new NativeAutoRecTriggerWonCancelError(triggerStatus, receipt as never);
    const stopped = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false, stopReceipt: { intentId: 'c'.repeat(32), armRevision: 1,
        expectedContentRevision: 9, requestedRevision: 1, appliedRevision: 1, rejectedRevision: 0, appliedContentRevision: 10 } });
    stopped.nativeTracks = [{ trackId: 1, state: 'Stopped', contentRevision: 10 }];
    const bridge = { cancelNativeAutoRecTrack: vi.fn(async () => { throw typed; }),
      stopNativeAutoRecTriggeredTrack: vi.fn(async () => stopped), stopTrack: vi.fn() };
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, { latestStatus: autoStatus({}, { ...receipt, armed: true }), bridge,
      assertNoUnresolvedNativeTransportBatch: () => true, assertTempoRecoveryClear: () => undefined,
      assertPublishedProjectTempoCleanup: () => undefined, emitAll: vi.fn(),
      applyStatus: (status: NativeStatus) => { (engine as any).latestStatus = status; } });
    await expect(engine.stopTrack(1)).resolves.toBeUndefined();
    expect(bridge.stopNativeAutoRecTriggeredTrack).toHaveBeenCalledWith(1, 9);
    expect(bridge.stopTrack).not.toHaveBeenCalled();
    expect((engine as any).latestStatus.nativeTracks[0].state).toBe('Stopped');
  });

  it('uses conditional STOP for a normally triggered recording', async () => {
    const status = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1,
      triggerAppliedRevision: 1, triggerContentRevision: 9, armed: false });
    status.nativeTracks = [{ trackId: 1, state: 'Recording', contentRevision: 9 }];
    const bridge = { hasUnresolvedNativeAutoRecOperation: () => false,
      stopNativeAutoRecTriggeredTrack: vi.fn(async () => status), stopTrack: vi.fn() };
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, { latestStatus: status, bridge, assertNoUnresolvedNativeTransportBatch: () => true,
      assertTempoRecoveryClear: () => undefined, assertPublishedProjectTempoCleanup: () => undefined,
      applyStatus: vi.fn() });
    await engine.stopTrack(1);
    expect(bridge.stopNativeAutoRecTriggeredTrack).toHaveBeenCalledWith(1, 9);
    expect(bridge.stopTrack).not.toHaveBeenCalled();
  });

  it('renders acknowledged local arms as standby, unknown host arms as unverified, and repeats REC as one exact cancel', async () => {
    const status = autoStatus({}, { intentId: intent, armRequestedRevision: 1, armAppliedRevision: 1, armed: true });
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    const bridge = new NativeBridgeClient();
    Object.assign(engine, { latestStatus: status, bridge, isNativeReady: () => true,
      updateTrackTelemetry: vi.fn(), stopTrack: vi.fn(async () => undefined) });
    const proxy = new NativeTrackProxy(engine, 1);
    proxy.syncNativeState('Empty', 0);
    expect(proxy.state).toBe(TrackState.REC_STANDBY);
    expect(proxy.autoRecArmed).toBe(false);
    expect(proxy.disabledReason).toMatch(/cannot confirm its arm intent/i);
    proxy.triggerRecord();
    expect(engine.stopTrack).toHaveBeenCalledTimes(1);

    const applied = { operation: 'arm', trackId: 1, hostIncarnationId: host, intentId: intent, expectedArmRevision: 0, armRevision: 1 };
    sessionStorage.setItem('webrc.nativeAutoRecArmReceipts.v1', JSON.stringify([applied]));
    const confirmed = new NativeTrackProxy(engine, 1);
    confirmed.syncNativeState('Empty', 0);
    expect(confirmed.autoRecArmed).toBe(true);
  });

  it('keeps unsupported or stale Native capabilities unavailable to the settings UI', () => {
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, { latestStatus: { ok: true, nativeAutoRec: { available: false } } });
    expect(engine.getNativeAutoRecSettings()).toBeNull();
    expect(engine.getNativeAutoRecStatus()).toBeNull();
  });

  it('keeps unconfirmed standby visually unverified rather than showing the confirmed Auto Rec blink', () => {
    const controls = resolveRc505TrackControls({ state: 'REC_STANDBY', hasPhrase: false, selected: false,
      available: true, ready: true, autoRecArmed: false, layer: 'NORMAL',
      history: { canUndo: false, canRedo: false, busy: false } });
    expect(controls.record.blink).toBe('UNVERIFIED');
    expect(controls.record.ledColor).not.toBe('red');
  });
});

  it('clears only definite settings and arm 409 rejections, retaining 400 outcomes', async () => {
    const status = autoStatus();
    let code = 409;
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? response({ error: 'rejected' }, code) : response(status)));
    const client = new NativeBridgeClient();
    await expect(client.setNativeAutoRecSettings({ enabled: true, sensitivity: 50 }, 2, host)).rejects.toThrow();
    expect(client.reconcileNativeAutoRecSettings(status)).toBe('clear');
    code = 400;
    await expect(client.setNativeAutoRecSettings({ enabled: true, sensitivity: 50 }, 2, host)).rejects.toThrow();
    expect(client.reconcileNativeAutoRecSettings(status)).toBe('unknown');
    sessionStorage.clear(); code = 409;
    await expect(client.armNativeAutoRecTrack(1)).rejects.toThrow();
    expect(client.hasUnresolvedNativeAutoRecOperation(1, status)).toBe(false);
    code = 400;
    await expect(client.armNativeAutoRecTrack(1)).rejects.toThrow();
    expect(client.hasUnresolvedNativeAutoRecOperation(1, status)).toBe(true);
  });

  it('preserves another track and a newer same-track owner when old arm responses reject', async () => {
    const status = autoStatus();
    const pending: Array<(value: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(status);
      return new Promise<Response>((resolve) => pending.push(resolve));
    }));
    const client = new NativeBridgeClient();
    const first = client.armNativeAutoRecTrack(1);
    const second = client.armNativeAutoRecTrack(2);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const key = 'webrc.nativeAutoRecArmReceipts.v1';
    const receipts = JSON.parse(sessionStorage.getItem(key)!);
    expect(receipts).toHaveLength(2);
    pending[0]!(response({ error: 'conflict' }, 409));
    await expect(first).rejects.toThrow();
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual([receipts[1]]);
    const newer = { ...receipts[1], intentId: 'c'.repeat(32), expectedArmRevision: 1, armRevision: 2 };
    sessionStorage.setItem(key, JSON.stringify([newer]));
    pending[1]!(response({ error: 'conflict' }, 409));
    await expect(second).rejects.toThrow();
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual([newer]);
  });

  it('permits settings changes with mixed LOOP SYNC and can turn AUTO REC off', async () => {
    const status = autoStatus();
    status.nativeMemory!.loopSync = [true, false, false, false, false];
    status.nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: false, recAction: 'REC->PLAY',
      quantize: 'OFF', requestedRevision: 1, appliedRevision: 1 };
    const applied = structuredClone(status);
    applied.nativeAutoRec!.settings = { enabled: false, sensitivity: 50, requestedRevision: 3, appliedRevision: 3 };
    const bridge = { reconcileNativeAutoRecSettings: vi.fn(() => 'clear'), hasUnresolvedNativeAutoRecOperation: () => false,
      setNativeAutoRecSettings: vi.fn(async () => applied), getStatus: vi.fn(async () => applied) };
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, { latestStatus: status, bridge, dispatchStatusRequest: (fn: () => Promise<NativeStatus>) => fn(), applyStatus: () => {} });
    await engine.setNativeAutoRecSettings({ enabled: false, sensitivity: 50 });
    expect(bridge.setNativeAutoRecSettings).toHaveBeenCalledOnce();
  });

  it('blocks unsupported AUTO REC before scheduling and checks per-track sync on a counterfactual OFF snapshot', async () => {
    const status = autoStatus();
    status.nativeMemory!.loopSync = [true, false, false, false, false];
    status.nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: false, recAction: 'REC->PLAY',
      quantize: 'MEASURE', requestedRevision: 1, appliedRevision: 1 };
    const bridge = { hasUnresolvedNativeAutoRecOperation: () => false, armNativeAutoRecTrack: vi.fn(async () => status), recordTrack: vi.fn() };
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    const schedule = vi.fn();
    Object.assign(engine, { latestStatus: status, bridge, tracks: [{ trackId: 1, state: TrackState.EMPTY }, { trackId: 2, state: TrackState.EMPTY }],
      assertNoUnresolvedNativeTransportBatch: () => true, assertTempoRecoveryClear: () => {}, assertPublishedProjectTempoCleanup: () => {},
      scheduleNativeRhythmAction: schedule, applyStatus: () => {}, isNativeTrackAvailable: () => true, isNativeReady: () => true });
    await expect(engine.recordTrack(1)).rejects.toThrow(/LOOP SYNC OFF/);
    await expect(engine.recordTrack(2)).rejects.toThrow(/QUANTIZE OFF/);
    expect(schedule).not.toHaveBeenCalled();
    expect(bridge.armNativeAutoRecTrack).not.toHaveBeenCalled();
    const proxy = new NativeTrackProxy(engine, 1);
    expect(proxy.transportEnabled).toBe(false);
    expect(proxy.disabledReason).toMatch(/LOOP SYNC OFF/);
    status.nativeRecordPlay.quantize = 'OFF';
    await engine.recordTrack(2);
    expect(bridge.armNativeAutoRecTrack).toHaveBeenCalledExactlyOnceWith(2);
    expect(schedule).not.toHaveBeenCalled();
    proxy.state = TrackState.STOPPED;
    expect(proxy.transportEnabled).toBe(true);
  });
