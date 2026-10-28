import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { resolveNativeFxReadback } from '../../src/ui/rc505/Rc505FxReadback';
import { createNativeRc505MemoryRuntime } from '../../src/audio/NativeRc505MemoryRuntime';
import { Rc505MemoryCommittedError, decodeRc505Memory } from '../../src/audio/Rc505Memory';
import { encodeProjectArchive } from '../../src/audio/projectArchive';
import type { NativeBridgeClient, NativeStatus } from '../../src/audio/NativeBridgeClient';

function fixture() {
  const slots = () => ['A', 'B', 'C', 'D'].map((slot) => ({ slot, effectId: '', parameters: {}, bypassed: false,
    appliedBypassed: false, requestedRevision: 0, appliedRevision: 0, controlFaulted: false, processingFaulted: false, prepared: false }));
  let status = {
    mixerLevels: [80, 90, 100, 110, 120, 130, 140],
    engineRunning: true, projectContentRevision: 7, projectContentRevisionSnapshotStable: true,
    nativeTracks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, state: 'Empty', contentRevision: 0 })),
    nativeMemory: { version: 1, loopTransports: Array.from({ length: 5 }, () => ({ mode: 0, beatOffsetBeats: 0, bpm: 120,
      crossfadeMs: 5, vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 })),
      bounce: { bounceSw: true, bounceIn: [true, false, true, false, false], bounceTrack: [false, true, true, false, false] } },
    nativeBounce: { version: 1, bounceSw: true, bounceIn: [true, false, true, false, false], bounceTrack: [false, true, true, false, false],
      requestedRevision: 3, appliedRevision: 3, sourceTap: 'pre-track-insert', hardwareFxPlacementVerified: false },
    nativeRhythm: { enabled: false, bpm: 120, kitIndex: 1, patternIndex: 1, variation: 'A', section: 'main', quantizeGrid: '1/16', swingPercent: 50, volume: 50 },
    nativePitch: { enabled: true, semitones: 3 },
    nativeFx: { inputCatalogSlots: slots(), catalogSlots: slots(), perTrackCatalogBanks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, slots: slots() })),
      outputReverbEnabled: true, outputReverbWetMix: .4,
      trackFxApply: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, requested: index % 2 === 0, applied: index % 2 === 0,
        requestedRevision: 2, appliedRevision: 2, semanticRevision: 2, controlFaulted: false })) },
  } as unknown as NativeStatus;
  let cached = status;
  let edits = 0;
  const bridge = {
    getStatus: vi.fn(async () => status),
    beginProjectArchiveImport: vi.fn(async () => 19),
    commitPreparedMemory: vi.fn(async () => { status = { ...status, projectContentRevision: 8 }; }),
    waitForProjectArchiveImport: vi.fn(async () => ({ state: 'committed' })),
    cancelProjectArchiveImport: vi.fn(async () => undefined),
  };
  const install = vi.fn();
  const committed = vi.fn();
  const runtime = createNativeRc505MemoryRuntime({ bridge: bridge as unknown as NativeBridgeClient,
    status: () => cached, editRevision: () => String(edits), publish: (value) => { cached = value; }, install, committed,
    archive: () => encodeProjectArchive({ name: '', bpm: 120, tracks: [null, null, null, null, null] }) });
  return { runtime, bridge, install, committed, hostStatus: () => status, edit: () => { edits += 1; }, hostEdit: () => { status = { ...status, projectContentRevision: 9 }; } };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('Native semantic Memory runtime', () => {
  it.each([false, true])('invalidates every old engine bank/gate/Mark ACK at host commit (network failure: %s)', async (failReadback) => {
    const h = fixture();
    const status = h.hostStatus();
    const banks = [status.nativeFx!.inputCatalogSlots!, status.nativeFx!.catalogSlots!,
      ...status.nativeFx!.perTrackCatalogBanks!.map((bank) => bank.slots)];
    for (const bank of banks) for (const slot of bank) Object.assign(slot, {
      effectId: 'filter.lpf', parameters: { cutoffHz: 1000 }, prepared: true,
    });
    Object.assign(status, { nativeLooperMultiTrackImplemented: true, nativeLooperTrackCount: 5 });
    status.nativeFx!.trackFxApplyAvailable = true;
    (NativeAudioEngine as any).instance = null;
    const engine = NativeAudioEngine.getInstance();
    const internal = engine as any;
    internal.bridge = h.bridge;
    internal.applyStatus(status);
    internal.hydrateNativeCatalogFromStatus(status);
    engine.exportProjectArchive = () => encodeProjectArchive({ name: '', bpm: 120, tracks: [null, null, null, null, null] });
    const targets = [{ path: 'input' as const, trackId: 0 }, { path: 'track' as const, trackId: 0 },
      ...[1, 2, 3, 4, 5].map((trackId) => ({ path: 'track' as const, trackId }))];
    for (const target of targets) for (let index = 0; index < 4; index++) {
      expect(resolveNativeFxReadback(engine.getCatalogFxSlotStatus(target.path, index, target.trackId)).activeLabel).toBe('ON');
    }
    const runtime = engine.createRc505MemoryRuntime();
    const document = await runtime.capture();
    const candidate = await runtime.prepare(document, runtime.revision());
    const freshReadback = h.bridge.getStatus.getMockImplementation()!;
    h.bridge.getStatus.mockImplementationOnce(async () => {
      for (const target of targets) for (let index = 0; index < 4; index++) {
        const slot = engine.getCatalogFxSlotStatus(target.path, index, target.trackId);
        expect(slot).toMatchObject({ acknowledged: false, outcomeUnknown: true, acknowledgedParameters: null });
        expect(resolveNativeFxReadback(slot)).toMatchObject({ state: 'UNKNOWN', activeLabel: '—' });
      }
      expect(engine.getTrackFxApply().every((gate) => !gate.available && !gate.applied)).toBe(true);
      expect(engine.getMarkState(1)).toMatchObject({ supported: false, exists: false, canSet: false, canClear: false,
        unavailableReason: expect.stringContaining('waiting for fresh Native MARK readback') });
      // Even another status publication cannot resurrect cached ACKs before installation.
      internal.applyStatus(status);
      expect(resolveNativeFxReadback(engine.getCatalogFxSlotStatus('input', 0)).state).toBe('UNKNOWN');
      if (failReadback) throw new Error('post-ACK network failure');
      return freshReadback();
    });
    if (failReadback) {
      await expect(candidate.commit()).rejects.toMatchObject({ committed: true, generation: 19 });
      for (const target of targets) for (let index = 0; index < 4; index++) {
        expect(resolveNativeFxReadback(engine.getCatalogFxSlotStatus(target.path, index, target.trackId)).state).toBe('UNKNOWN');
      }
    } else {
      await candidate.commit();
      for (const target of targets) for (let index = 0; index < 4; index++) {
        expect(engine.getCatalogFxSlotStatus(target.path, index, target.trackId)).toMatchObject({
          acknowledged: true, acknowledgedEffectId: 'filter.lpf', acknowledgedParameters: { cutoffHz: 1000 }, outcomeUnknown: false,
        });
      }
      expect(engine.getTrackFxApply(1)[0]).toMatchObject({ available: true, applied: true });
    }
    await candidate.dispose();
    expect(h.bridge.cancelProjectArchiveImport).not.toHaveBeenCalled();
  });

  it('captures and independently validates acknowledged Native REC ACTION in the atomic envelope', async () => {
    const h = fixture();
    h.hostStatus().nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: false,
      recAction: 'REC->DUB', requestedRevision: 3, appliedRevision: 3,
      finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0] };
    const document = await h.runtime.capture();
    expect((document.extensions.WEBRC.nativeMemory as any).recAction).toBe('REC->DUB');
    expect(document.semantics.fields['record.recAction']).toEqual({ availability: 'supported', value: 'REC->DUB' });
    document.semantics.fields['record.recAction']!.value = 'REC->PLAY';
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/inconsistent/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
    h.hostStatus().nativeRecordPlay!.appliedRevision = 2;
    await expect(h.runtime.capture()).rejects.toThrow(/REC ACTION/);
  });
  it('captures real banks/gates/output state and marks TrackProxy placeholders unavailable', async () => {
    const { runtime } = fixture();
    const document = await runtime.capture();
    expect(document.semantics.fields['track.1.pan']).toMatchObject({ availability: 'unsupported', value: null });
    expect(document.semantics.fields['track.2.level']).toEqual({ availability: 'supported', value: 110 });
    expect(document.semantics.fields['track.1.fxApply']).toEqual({ availability: 'supported', value: true });
    expect(document.semantics.fields['track.2.fxApply']).toEqual({ availability: 'supported', value: false });
    expect(document.extensions.WEBRC.nativeOutputState).toMatchObject({ pitch: { enabled: true, semitones: 3 }, fx: { outputReverbEnabled: true } });
    expect((document.extensions.WEBRC.nativeMemory as any).bounce).toEqual({ bounceSw: true,
      bounceIn: [true, false, true, false, false], bounceTrack: [false, true, true, false, false] });
    expect(document.semantics.fields['record.bounceSw']).toEqual({ availability: 'supported', value: true });
    expect(document.semantics.fields['track.3.bounceTrack']).toEqual({ availability: 'supported', value: true });
  });
  it('prepares an intact envelope, commits once, and leaves ACK reclamation to the host', async () => {
    const { runtime, bridge } = fixture();
    const document = await runtime.capture();
    const prepared = await runtime.prepare(document, runtime.revision());
    expect(bridge.commitPreparedMemory).not.toHaveBeenCalled();
    const [bytes, expected] = bridge.beginProjectArchiveImport.mock.calls[0] as unknown as [Uint8Array, number];
    expect(expected).toBe(7);
    expect((await decodeRc505Memory(bytes)).archive).toEqual(document.archive);
    await prepared.commit();
    await prepared.dispose();
    expect(bridge.commitPreparedMemory).toHaveBeenCalledExactlyOnceWith(19);
    expect(bridge.cancelProjectArchiveImport).not.toHaveBeenCalled();
    await expect(prepared.commit()).rejects.toThrow(/stale/);
  });
  it('disposes an uncommitted candidate through cancellation without activating it', async () => {
    const { runtime, bridge } = fixture();
    const document = await runtime.capture();
    const prepared = await runtime.prepare(document, runtime.revision());
    await prepared.dispose();
    expect(bridge.cancelProjectArchiveImport).toHaveBeenCalledExactlyOnceWith(19);
    expect(bridge.commitPreparedMemory).not.toHaveBeenCalled();
  });
  it('detects local edit-and-revert and fresh host edits against a stale cached baseline', async () => {
    const { runtime, bridge, edit, hostEdit } = fixture();
    const document = await runtime.capture();
    const revision = runtime.revision();
    edit(); edit();
    await expect(runtime.prepare(document, revision)).rejects.toThrow(/changed/);
    const newRevision = runtime.revision();
    hostEdit();
    await expect(runtime.prepare(document, newRevision)).rejects.toThrow(/changed on the host/);
    expect(bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('rejects conflicting supported metadata before publishing any generation', async () => {
    const { runtime, bridge } = fixture();
    const document = await runtime.capture();
    document.semantics.fields['track.1.fxApply']!.value = false;
    await expect(runtime.prepare(document, runtime.revision())).rejects.toThrow(/inconsistent/);
    expect(bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('reports readback failure after host ACK as committed and never cancels the installed generation', async () => {
    const { runtime, bridge, committed } = fixture();
    const document = await runtime.capture();
    const prepared = await runtime.prepare(document, runtime.revision());
    bridge.getStatus.mockRejectedValueOnce(new Error('network readback unavailable'));
    await expect(prepared.commit()).rejects.toMatchObject({
      committed: true, generation: 19, message: expect.stringContaining('generation 19 committed'),
      cause: expect.objectContaining({ message: 'network readback unavailable' }),
    });
    expect(committed).toHaveBeenCalledExactlyOnceWith(19);
    await prepared.dispose();
    expect(bridge.cancelProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('classifies authored-control installation failure after ACK without claiming a rollback', async () => {
    const { runtime, bridge, install } = fixture();
    const document = await runtime.capture();
    const prepared = await runtime.prepare(document, runtime.revision());
    install.mockImplementationOnce(() => { throw new Error('UI installation failed'); });
    const outcome = prepared.commit();
    await expect(outcome).rejects.toBeInstanceOf(Rc505MemoryCommittedError);
    await expect(outcome).rejects.toMatchObject({ committed: true, generation: 19,
      message: expect.stringContaining('application synchronization failed: UI installation failed') });
    await prepared.dispose();
    expect(bridge.cancelProjectArchiveImport).not.toHaveBeenCalled();
  });

  it('round-trips opaque extensions and unavailable fields while capturing real current Native values', async () => {
    const { runtime } = fixture();
    const document = await runtime.capture();
    document.extensions.WEBRC.vendorOpaque = { nested: [1, { keep: true }] };
    document.semantics.fields['assign.vendorMode'] = { availability: 'unknown', value: null, reason: 'Foreign provider owns this field.' };
    document.semantics.fields['track.1.pan'] = { availability: 'unknown', value: null, reason: 'Unknown on original provider.' };
    const prepared = await runtime.prepare(document, runtime.revision());
    await prepared.commit(); await prepared.dispose();
    const recaptured = await runtime.capture();
    expect(recaptured.extensions.WEBRC.vendorOpaque).toEqual(document.extensions.WEBRC.vendorOpaque);
    expect(recaptured.semantics.fields['assign.vendorMode']).toEqual(document.semantics.fields['assign.vendorMode']);
    expect(recaptured.semantics.fields['track.1.pan']).toEqual(document.semantics.fields['track.1.pan']);
    expect(recaptured.semantics.fields['track.2.level']).toEqual({ availability: 'supported', value: 110 });
    expect(recaptured.archive).toEqual(document.archive);
  });
  it('adopts opaque target metadata on host ACK even when subsequent UI installation fails', async () => {
    const { runtime, install } = fixture();
    const document = await runtime.capture();
    document.extensions.WEBRC.vendorOpaque = { committedMetadata: true };
    const prepared = await runtime.prepare(document, runtime.revision());
    install.mockImplementationOnce(() => { throw new Error('UI unavailable'); });
    await expect(prepared.commit()).rejects.toMatchObject({ committed: true });
    await prepared.dispose();
    expect((await runtime.capture()).extensions.WEBRC.vendorOpaque).toEqual({ committedMetadata: true });
  });
  it('does not adopt opaque metadata from a cancelled candidate', async () => {
    const { runtime } = fixture();
    const document = await runtime.capture();
    document.extensions.WEBRC.vendorOpaque = { neverInstalled: true };
    const prepared = await runtime.prepare(document, runtime.revision());
    await prepared.dispose();
    expect((await runtime.capture()).extensions.WEBRC.vendorOpaque).toBeUndefined();
  });

});
