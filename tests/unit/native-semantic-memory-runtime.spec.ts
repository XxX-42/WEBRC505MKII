import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { resolveNativeFxReadback } from '../../src/ui/rc505/Rc505FxReadback';
import { createNativeRc505MemoryRuntime } from '../../src/audio/NativeRc505MemoryRuntime';
import { Rc505MemoryCommittedError, decodeRc505Memory } from '../../src/audio/Rc505Memory';
import { encodeProjectArchive } from '../../src/audio/projectArchive';
import { Transport } from '../../src/core/Transport';
import { ProjectMemoryStore } from '../../src/audio/projectMemoryStore';
import type { NativeBridgeClient, NativeStatus } from '../../src/audio/NativeBridgeClient';

function fixture(archiveBpm = 120) {
  const hostIncarnationId = 'a'.repeat(32);
  const slots = () => ['A', 'B', 'C', 'D'].map((slot) => ({ slot, effectId: '', parameters: {}, bypassed: false,
    appliedBypassed: false, requestedRevision: 0, appliedRevision: 0, controlFaulted: false, processingFaulted: false, prepared: false }));
  let status = {
    hostIncarnationId,
    mixerLevels: [80, 90, 100, 110, 120, 130, 140],
    engineRunning: true, projectContentRevision: 7, projectContentRevisionSnapshotStable: true,
    nativeTracks: Array.from({ length: 5 }, (_, index) => ({ trackId: index + 1, state: 'Empty', contentRevision: 0,
      loopTransportRequestedRevision: 0, loopTransportAppliedRevision: 0, loopTransportFaultRevision: 0,
      loopTransportAppliedOneShot: false,
      dubMode: { requested: ['REPLACE1', 'OVERDUB', 'REPLACE2', 'OVERDUB', 'REPLACE1'][index],
        applied: ['REPLACE1', 'OVERDUB', 'REPLACE2', 'OVERDUB', 'REPLACE1'][index], requestedRevision: 1, appliedRevision: 1 } })),
    nativeMemory: { version: 1, dubModes: ['REPLACE1', 'OVERDUB', 'REPLACE2', 'OVERDUB', 'REPLACE1'],
      loopTransports: Array.from({ length: 5 }, () => ({ mode: 0, beatOffsetBeats: 0, bpm: 120,
      oneShot: false, crossfadeMs: 5, vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 })),
      bounce: { bounceSw: true, bounceIn: [true, false, true, false, false], bounceTrack: [false, true, true, false, false] } },
    nativeBounce: { version: 1, bounceSw: true, bounceIn: [true, false, true, false, false], bounceTrack: [false, true, true, false, false],
      requestedRevision: 3, appliedRevision: 3, sourceTap: 'pre-track-insert', hardwareFxPlacementVerified: false },
    nativeRhythm: { available: true, enabled: false, bpm: 120, kitIndex: 1, patternIndex: 1, variation: 'A', section: 'main', quantizeGrid: '1/16', swingPercent: 50, volume: 50 },
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
    beginProjectArchiveImport: vi.fn(async (_archive: unknown, _revision: number, _host: string, operationId: string) => ({ generation: 19, hostIncarnationId, operationId })),
    getProjectArchiveImportStatusByOperationId: vi.fn(async (operationId: string) => ({ ok: true, generation: 12,
      state: 'pending' as const, operationId, hostIncarnationId, expectedProjectContentRevision: 7, archiveSha256: 'b'.repeat(64) })),
    commitPreparedMemory: vi.fn(async () => { status = { ...status, projectContentRevision: 8 }; }),
    waitForProjectArchiveImport: vi.fn(async () => ({ state: 'committed', hostIncarnationId })),
    cancelProjectArchiveImport: vi.fn(async () => undefined),
  };
  const install = vi.fn();
  const committed = vi.fn();
  let persistedIntent: { operationId: string; hostIncarnationId: string; expectedProjectContentRevision: number; archiveSha256: string } | null = null;
  const persistOperationIntent = vi.fn(async (operationId: string, boundHost: string, expectedProjectContentRevision: number, archiveSha256: string) => {
    persistedIntent = { operationId, hostIncarnationId: boundHost, expectedProjectContentRevision, archiveSha256 };
  });
  const readOperationIntent = vi.fn(async () => persistedIntent);
  const listOperationIntents = vi.fn(async () => persistedIntent ? [persistedIntent] : []);
  const clearOperationIntent = vi.fn(async (operationId: string) => { if (persistedIntent?.operationId === operationId) persistedIntent = null; });
  const publish = vi.fn((value: NativeStatus) => { cached = value; });
  const syncRhythmBpm = vi.fn(async (bpm: number) => {
    status = { ...status, nativeRhythm: { ...status.nativeRhythm!, bpm } };
    return true;
  });
  const runtime = createNativeRc505MemoryRuntime({ bridge: bridge as unknown as NativeBridgeClient,
    status: () => cached, editRevision: () => String(edits), publish, install, committed, syncRhythmBpm,
    persistOperationIntent, readOperationIntent, clearOperationIntent, listOperationIntents,
    archive: () => encodeProjectArchive({ name: '', bpm: archiveBpm, tracks: [null, null, null, null, null] }) });
  return { runtime, bridge, install, committed, persistOperationIntent, readOperationIntent, clearOperationIntent, listOperationIntents, publish, syncRhythmBpm, hostStatus: () => status,
    restartHost: (hostIncarnationId: string) => { status = { ...status, hostIncarnationId }; cached = status; },
    edit: () => { edits += 1; }, hostEdit: () => { status = { ...status, projectContentRevision: 9 }; } };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  const intents = new Map<string, { operationId: string; hostIncarnationId: string; expectedProjectContentRevision: number; archiveSha256: string }>();
  vi.spyOn(ProjectMemoryStore.prototype, 'persistNativeImportOperationIntent').mockImplementation(async (operationId, hostIncarnationId, expectedProjectContentRevision, archiveSha256) => {
    intents.set(operationId, { operationId, hostIncarnationId, expectedProjectContentRevision, archiveSha256 });
  });
  vi.spyOn(ProjectMemoryStore.prototype, 'readNativeImportOperationIntent').mockImplementation(async (operationId) => intents.get(operationId) ?? null);
  vi.spyOn(ProjectMemoryStore.prototype, 'clearNativeImportOperationIntent').mockImplementation(async (operationId) => { intents.delete(operationId); });
  vi.spyOn(ProjectMemoryStore.prototype, 'listNativeImportOperationIntents').mockImplementation(async () => [...intents.values()]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const transport = Transport.getInstance();
  transport.stop(); transport.resetMasterTrack(); transport.timeSignature = [4, 4];
  transport.measureLength = 0; transport.masterLoopLengthSamples = 0; transport.setBpm(120);
});

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
  it('captures and validates Native Rhythm REC QUANTIZE and per-track LOOP SYNC in Memory', async () => {
    const h = fixture();
    h.hostStatus().nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: true,
      recAction: 'REC->PLAY', quantize: 'MEASURE', requestedRevision: 1, appliedRevision: 1,
      finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0] };
    h.hostStatus().nativeMemory!.recQuantize = 'MEASURE';
    h.hostStatus().nativeMemory!.loopSync = [false, true, false, false, false];
    const document = await h.runtime.capture();
    expect((document.extensions.WEBRC.nativeMemory as any)).toMatchObject({ recQuantize: 'MEASURE',
      loopSync: [false, true, false, false, false] });
    expect(document.semantics.fields['record.quantize']).toEqual({ availability: 'supported', value: 'MEASURE' });
    expect(document.semantics.fields['track.2.loopSync']).toEqual({ availability: 'supported', value: 'ON' });
    document.semantics.fields['track.2.loopSync']!.value = 'OFF';
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/inconsistent/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('rejects REC->DUB plus LOOP SYNC both at capture and when Memory fields are merged', async () => {
    const captureCase = fixture();
    captureCase.hostStatus().nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: true,
      recAction: 'REC->DUB', quantize: 'MEASURE', requestedRevision: 1, appliedRevision: 1,
      finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0] };
    captureCase.hostStatus().nativeMemory!.recQuantize = 'MEASURE';
    captureCase.hostStatus().nativeMemory!.loopSync = [false, true, false, false, false];
    await expect(captureCase.runtime.capture()).rejects.toThrow(/REC->DUB.*LOOP SYNC/);

    const importCase = fixture();
    importCase.hostStatus().nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: true,
      recAction: 'REC->PLAY', quantize: 'MEASURE', requestedRevision: 1, appliedRevision: 1,
      finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0] };
    importCase.hostStatus().nativeMemory!.recQuantize = 'MEASURE';
    importCase.hostStatus().nativeMemory!.loopSync = [false, true, false, false, false];
    const document = await importCase.runtime.capture();
    const settings = document.extensions.WEBRC.nativeMemory as any;
    settings.recAction = 'REC->DUB';
    document.semantics.fields['record.recAction']!.value = 'REC->DUB';
    await expect(importCase.runtime.prepare(document, importCase.runtime.revision())).rejects.toThrow(/REC->DUB.*LOOP SYNC/);
    expect(importCase.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('refuses a committed Memory whose REC QUANTIZE or any LOOP SYNC value fails same-host readback', async () => {
    const h = fixture();
    h.hostStatus().nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: false,
      recAction: 'REC->PLAY', quantize: 'MEASURE', requestedRevision: 1, appliedRevision: 1,
      finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0] };
    h.hostStatus().nativeMemory!.recQuantize = 'MEASURE';
    h.hostStatus().nativeMemory!.loopSync = [false, true, false, false, false];
    const document = await h.runtime.capture();
    const prepared = await h.runtime.prepare(document, h.runtime.revision());
    h.bridge.commitPreparedMemory.mockImplementationOnce(async () => {
      const status = h.hostStatus();
      status.projectContentRevision = 8;
      status.nativeRecordPlay!.quantize = 'OFF';
      status.nativeMemory!.recQuantize = 'OFF';
      status.nativeMemory!.loopSync = [false, false, false, false, false];
    });
    await expect(prepared.commit()).rejects.toMatchObject({
      committed: true, generation: 19, message: expect.stringContaining('REC QUANTIZE failed same-host readback'),
    });
    expect(h.bridge.cancelProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('rejects LOOP SYNC-only Memory when its current REC QUANTIZE is OFF', async () => {
    const h = fixture();
    h.hostStatus().nativeRecordPlay = { version: 1, recActionAvailable: true, quantizeAvailable: false,
      recAction: 'REC->PLAY', quantize: 'OFF', requestedRevision: 1, appliedRevision: 1,
      finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0] };
    h.hostStatus().nativeMemory!.recQuantize = 'OFF';
    const document = await h.runtime.capture();
    const settings = document.extensions.WEBRC.nativeMemory as any;
    delete settings.recQuantize;
    settings.loopSync = [false, true, false, false, false];
    document.semantics.fields['record.quantize'] = { availability: 'unsupported', value: null, reason: 'Archive omits REC QUANTIZE.' };
    document.semantics.fields['track.2.loopSync'] = { availability: 'supported', value: 'ON' };
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/cannot combine REC QUANTIZE OFF/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
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
    expect((document.extensions.WEBRC.nativeMemory as any).dubModes).toEqual(['REPLACE1', 'OVERDUB', 'REPLACE2', 'OVERDUB', 'REPLACE1']);
    expect(document.semantics.fields['track.3.dubMode']).toEqual({ availability: 'supported', value: 'REPLACE2' });
  });
  it('requires acknowledged per-track DUB MODE readback and matching semantics for Memory', async () => {
    const h = fixture();
    const document = await h.runtime.capture();
    document.semantics.fields['track.3.dubMode']!.value = 'OVERDUB';
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/DUB MODE semantic field/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
    document.semantics.fields['track.3.dubMode']!.value = 'REPLACE2';
    h.hostStatus().nativeTracks![2]!.dubMode!.appliedRevision = 0;
    await expect(h.runtime.capture()).rejects.toThrow(/DUB MODE callback acknowledgement/);
  });
  it('keeps old Memory documents compatible by defaulting absent DUB MODE metadata', async () => {
    const { runtime, bridge } = fixture();
    const document = await runtime.capture();
    const settings = document.extensions.WEBRC.nativeMemory as any;
    delete settings.dubModes;
    for (let track = 1; track <= 5; track += 1) delete document.semantics.fields[`track.${track}.dubMode`];
    const prepared = await runtime.prepare(document, runtime.revision());
    const bytes = bridge.beginProjectArchiveImport.mock.calls[0]![0] as Uint8Array;
    expect((await decodeRc505Memory(bytes)).extensions.WEBRC.nativeMemory).not.toHaveProperty('dubModes');
    await prepared.dispose();
    expect(bridge.cancelProjectArchiveImport).toHaveBeenCalledExactlyOnceWith(19, 'a'.repeat(32));
  });
  it('refuses Memory capture until the full Bounce request has been callback-applied', async () => {
    const h = fixture();
    h.hostStatus().nativeBounce!.appliedRevision = 2;
    await expect(h.runtime.capture()).rejects.toThrow(/Bounce callback acknowledgement/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it.each([
    ['pending', { loopTransportRequestedRevision: 4, loopTransportAppliedRevision: 3, loopTransportFaultRevision: 0 }],
    ['faulted', { loopTransportRequestedRevision: 3, loopTransportAppliedRevision: 3, loopTransportFaultRevision: 3 }],
  ] as const)('refuses Memory capture for a %s Native loop transport state', async (_state, revisions) => {
    const h = fixture();
    Object.assign(h.hostStatus().nativeTracks![2]!, revisions);
    await expect(h.runtime.capture()).rejects.toThrow(/loop transport callback acknowledgement/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('refuses capture and import when an older host cannot expose loop transport acknowledgements', async () => {
    const h = fixture();
    delete (h.hostStatus().nativeTracks![2] as any).loopTransportAppliedRevision;
    await expect(h.runtime.capture()).rejects.toThrow(/lacks complete loop transport revision\/readback capability/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();

    const legacy = fixture();
    const document = await legacy.runtime.capture();
    delete (legacy.hostStatus().nativeTracks![2] as any).loopTransportAppliedRevision;
    await expect(legacy.runtime.prepare(document, legacy.runtime.revision())).rejects.toThrow(/lacks complete loop transport revision\/readback capability/);
    expect(legacy.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('keeps Memory capture compatible with older hosts that lack 1SHOT but expose transport revisions', async () => {
    const h = fixture();
    for (let index = 0; index < 5; index += 1) {
      delete (h.hostStatus().nativeTracks![index] as any).loopTransportAppliedOneShot;
      delete (h.hostStatus().nativeMemory!.loopTransports[index] as any).oneShot;
    }
    const document = await h.runtime.capture();
    expect((document.extensions.WEBRC.nativeMemory as any).loopTransports.every((transport: any) => !('oneShot' in transport))).toBe(true);
  });
  it('preserves import compatibility for legacy Memory settings without an explicit 1SHOT field', async () => {
    const h = fixture();
    const document = await h.runtime.capture();
    for (const transport of (document.extensions.WEBRC.nativeMemory as any).loopTransports) delete transport.oneShot;
    const prepared = await h.runtime.prepare(document, h.runtime.revision());
    expect(h.bridge.beginProjectArchiveImport).toHaveBeenCalledOnce();
    const operationId = h.bridge.beginProjectArchiveImport.mock.calls[0]![3];
    expect(operationId).toMatch(/^[0-9a-f]{32}$/);
    expect(h.persistOperationIntent).toHaveBeenCalledOnce();
    expect(h.persistOperationIntent.mock.calls[0]!.slice(0, 3)).toEqual([operationId, 'a'.repeat(32), 7]);
    expect(h.persistOperationIntent.mock.calls[0]![3]).toMatch(/^[0-9a-f]{64}$/);
    expect(h.readOperationIntent).toHaveBeenCalledExactlyOnceWith(operationId);
    await prepared.dispose();
  });
  it('does not upload when operation intent persistence or readback fails', async () => {
    const h = fixture();
    const document = await h.runtime.capture();
    h.persistOperationIntent.mockRejectedValueOnce(new Error('IndexedDB write failed'));
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/IndexedDB write failed/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
    h.persistOperationIntent.mockResolvedValueOnce(undefined);
    h.readOperationIntent.mockResolvedValueOnce(null);
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/did not round-trip from durable storage/);
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
  });
  it('blocks a new Native Memory upload while a prior operation intent is unresolved', async () => {
    const h = fixture();
    const document = await h.runtime.capture();
    h.listOperationIntents.mockResolvedValueOnce([{ operationId: 'f'.repeat(32), hostIncarnationId: 'a'.repeat(32),
      expectedProjectContentRevision: 7, archiveSha256: 'b'.repeat(64) }]);
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/remains pending/);
    expect(h.bridge.getProjectArchiveImportStatusByOperationId).toHaveBeenCalledExactlyOnceWith('f'.repeat(32), 'a'.repeat(32));
    expect(h.bridge.beginProjectArchiveImport).not.toHaveBeenCalled();
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
    expect(bridge.commitPreparedMemory).toHaveBeenCalledExactlyOnceWith(19, 'a'.repeat(32));
    expect(bridge.cancelProjectArchiveImport).not.toHaveBeenCalled();
    await expect(prepared.commit()).rejects.toThrow(/stale/);
  });
  it('preserves a user transport mutation that arrives during Memory ACK polling', async () => {
    const h = fixture();
    const transport = Transport.getInstance();
    transport.stop(); transport.resetMasterTrack(); transport.timeSignature = [4, 4];
    transport.measureLength = 0; transport.masterLoopLengthSamples = 0; transport.setBpm(120);
    const document = await h.runtime.capture();
    const prepared = await h.runtime.prepare(document, h.runtime.revision());
    h.bridge.getStatus.mockImplementationOnce(async () => {
      transport.setBpm(133);
      return h.hostStatus();
    });
    await expect(prepared.commit()).rejects.toThrow(/transport changed during callback acknowledgement.*archive BPM was not synchronized/i);
    expect(transport.bpm).toBe(133);
    expect(transport.timeSignature).toEqual([4, 4]);
    expect(h.syncRhythmBpm).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    await prepared.dispose();
  });
  it('synchronizes archive BPM to Native rhythm before applying archive transport', async () => {
    const h = fixture(90);
    h.hostStatus().nativeRhythm = { ...h.hostStatus().nativeRhythm!, available: true, bpm: 120 };
    const transport = Transport.getInstance();
    transport.stop(); transport.resetMasterTrack(); transport.timeSignature = [4, 4];
    transport.measureLength = 0; transport.masterLoopLengthSamples = 0; transport.setBpm(90);
    const document = await h.runtime.capture();
    expect(document.semantics.tempo).toBe(90);
    const prepared = await h.runtime.prepare(document, h.runtime.revision());
    await prepared.commit();
    expect(h.syncRhythmBpm).toHaveBeenCalledExactlyOnceWith(90, 'a'.repeat(32));
    expect(h.hostStatus().nativeRhythm?.bpm).toBe(90);
    expect(transport.bpm).toBe(90);
    await prepared.dispose();
  });
  it('refuses to install Memory semantics when the host restarts after commit ACK', async () => {
    const h = fixture();
    const document = await h.runtime.capture();
    const prepared = await h.runtime.prepare(document, h.runtime.revision());
    h.bridge.commitPreparedMemory.mockImplementationOnce(async () => {
      h.hostStatus().hostIncarnationId = 'c'.repeat(32);
    });
    await expect(prepared.commit()).rejects.toThrow(/host restarted during Memory readback/i);
    expect(h.install).not.toHaveBeenCalled();
    await prepared.dispose();
  });
  it('does not preserve opaque Memory semantics if the host restarts between ACK poll and final readback', async () => {
    const h = fixture();
    const { runtime, bridge, install } = h;
    const document = await runtime.capture();
    document.extensions.WEBRC.vendorOpaque = { stale: true };
    const prepared = await runtime.prepare(document, runtime.revision());
    let readsAfterPrepare = 0;
    bridge.getStatus.mockImplementation(async () => {
      readsAfterPrepare += 1;
      return { ...h.hostStatus(), hostIncarnationId: readsAfterPrepare >= 2 ? 'c'.repeat(32) : 'a'.repeat(32) } as NativeStatus;
    });
    await expect(prepared.commit()).rejects.toThrow(/restarted before Memory installation/i);
    expect(install).not.toHaveBeenCalled();
    await prepared.dispose();
    expect((await runtime.capture()).extensions.WEBRC.vendorOpaque).toBeUndefined();
  });
  it('disposes an uncommitted candidate through cancellation without activating it', async () => {
    const { runtime, bridge } = fixture();
    const document = await runtime.capture();
    const prepared = await runtime.prepare(document, runtime.revision());
    await prepared.dispose();
    expect(bridge.cancelProjectArchiveImport).toHaveBeenCalledExactlyOnceWith(19, 'a'.repeat(32));
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
  it('drops preserved opaque semantics when capture observes a different host incarnation', async () => {
    const h = fixture();
    const document = await h.runtime.capture();
    document.extensions.WEBRC.vendorOpaque = { sourceHost: 'first' };
    document.semantics.fields['track.1.pan'] = { availability: 'unknown', value: null, reason: 'first-host-specific metadata' };
    const prepared = await h.runtime.prepare(document, h.runtime.revision());
    await prepared.commit();
    await prepared.dispose();
    expect((await h.runtime.capture()).extensions.WEBRC.vendorOpaque).toEqual({ sourceHost: 'first' });
    expect((await h.runtime.capture()).semantics.fields['track.1.pan']?.reason).toBe('first-host-specific metadata');

    h.restartHost('c'.repeat(32));
    const afterRestart = await h.runtime.capture();
    expect(afterRestart.extensions.WEBRC.vendorOpaque).toBeUndefined();
    expect(afterRestart.semantics.fields['track.1.pan']?.reason).toBe('Native host does not implement this hardware setting.');
  });
  it('replaces preserved opaque semantics at committed ACK even if later readback fails', async () => {
    const h = fixture();
    const first = await h.runtime.capture();
    first.extensions.WEBRC.vendorOpaque = { project: 'A' };
    const firstCandidate = await h.runtime.prepare(first, h.runtime.revision());
    await firstCandidate.commit(); await firstCandidate.dispose();
    expect((await h.runtime.capture()).extensions.WEBRC.vendorOpaque).toEqual({ project: 'A' });

    const second = await h.runtime.capture();
    second.extensions.WEBRC.vendorOpaque = { project: 'B' };
    const secondCandidate = await h.runtime.prepare(second, h.runtime.revision());
    h.bridge.getStatus.mockRejectedValueOnce(new Error('post-commit status read failed'));
    await expect(secondCandidate.commit()).rejects.toMatchObject({ committed: true });
    await secondCandidate.dispose();

    expect((await h.runtime.capture()).extensions.WEBRC.vendorOpaque).toEqual({ project: 'B' });
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
