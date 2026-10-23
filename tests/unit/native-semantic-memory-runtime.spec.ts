import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeRc505MemoryRuntime } from '../../src/audio/NativeRc505MemoryRuntime';
import { decodeRc505Memory } from '../../src/audio/Rc505Memory';
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
      crossfadeMs: 5, vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 })) },
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
  const runtime = createNativeRc505MemoryRuntime({ bridge: bridge as unknown as NativeBridgeClient,
    status: () => cached, editRevision: () => String(edits), publish: (value) => { cached = value; },
    archive: () => encodeProjectArchive({ name: '', bpm: 120, tracks: [null, null, null, null, null] }) });
  return { runtime, bridge, edit: () => { edits += 1; }, hostEdit: () => { status = { ...status, projectContentRevision: 9 }; } };
}

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('Native semantic Memory runtime', () => {
  it('captures real banks/gates/output state and marks TrackProxy placeholders unavailable', async () => {
    const { runtime } = fixture();
    const document = await runtime.capture();
    expect(document.semantics.fields['track.1.pan']).toMatchObject({ availability: 'unsupported', value: null });
    expect(document.semantics.fields['track.2.level']).toEqual({ availability: 'supported', value: 110 });
    expect(document.semantics.fields['track.1.fxApply']).toEqual({ availability: 'supported', value: true });
    expect(document.semantics.fields['track.2.fxApply']).toEqual({ availability: 'supported', value: false });
    expect(document.extensions.WEBRC.nativeOutputState).toMatchObject({ pitch: { enabled: true, semitones: 3 }, fx: { outputReverbEnabled: true } });
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
});
