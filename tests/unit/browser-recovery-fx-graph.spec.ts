import { describe, expect, it } from 'vitest';
import type { BrowserRecoveryFxSlot, BrowserRecoverySnapshot } from '../../src/audio/BrowserRecoverySnapshot';
import { MAX_RECOVERY_CANDIDATE_KNOWN_PAYLOAD_BYTES, planBrowserRecoveryFxGraph } from '../../src/audio/BrowserRecoveryFxGraph';
import { SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES, SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES, SIGNALSMITH_LIVE_WASM_BUDGET_BYTES } from '../../src/audio/pitch/signalsmithWasmBudget';

const slotNames = ['A', 'B', 'C', 'D'] as const;
const emptySlot = (index: number): BrowserRecoveryFxSlot => ({
  slot: slotNames[index]!, type: null, requestedType: null, active: false, requestedActive: null,
  state: 'empty', amount: null, parameters: {}, parametersCaptured: true, error: null,
});

function snapshotWith(typeForIndex: (bankIndex: number, slotIndex: number) => string | null): BrowserRecoverySnapshot {
  const bank = (bankIndex: number) => slotNames.map((_, slotIndex) => {
    const type = typeForIndex(bankIndex, slotIndex);
    return type === null ? emptySlot(slotIndex) : {
      slot: slotNames[slotIndex]!, type, requestedType: null, active: true, requestedActive: null,
      state: 'ready' as const, amount: null, parameters: {}, parametersCaptured: true, error: null,
    };
  });
  return {
    schemaVersion: 2,
    source: { contextState: 'closed', sampleRate: 48_000 },
    tracks: Array.from({ length: 5 }, (_, index) => ({
      trackId: index + 1,
      pitch: {
        mode: 'off',
        liveMono: { semitones: 0, minimumFrequencyHz: 70, maximumFrequencyHz: 1_200 },
        livePoly: { semitones: 0, playbackRate: 1, tonalityLimitHz: 8_000 },
      },
    })),
    fx: {
      input: bank(0), sharedTrack: bank(1), privateTracks: Array.from({ length: 5 }, (_, index) => bank(index + 2)),
      sourceOverrides: [], outputDsp: { algorithm: null, parameters: {}, enabled: false },
    },
  } as unknown as BrowserRecoverySnapshot;
}

describe('Browser recovery FX graph admission plan', () => {
  it('charges source PCM plus the second full PCM copy and each planned Signalsmith node', () => {
    const sourcePcmBytes = 3 * 1024 * 1024;
    const snapshot = snapshotWith((_bankIndex, slotIndex) => slotIndex === 0 ? 'OCTAVE' : null);
    const plan = planBrowserRecoveryFxGraph(snapshot, sourcePcmBytes);
    expect(plan).toMatchObject({
      estimatedSourcePcmBytes: sourcePcmBytes,
      estimatedCandidatePcmBytes: sourcePcmBytes,
      estimatedSignalsmithWasmBytes: 5 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      estimatedKnownPeakBytes: 2 * sourcePcmBytes + 15 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      signalsmithProcessorCount: 15,
      hasUnboundedBrowserOverhead: true,
    });
    expect(plan.estimatedKnownPeakBytes).toBeLessThan(MAX_RECOVERY_CANDIDATE_KNOWN_PAYLOAD_BYTES);
  });

  it('admits the full 20-slot private Track graph within the actual 128 MiB context ledger cap', () => {
    const snapshot = snapshotWith((bankIndex) => bankIndex >= 2 ? 'OCTAVE' : null);
    const plan = planBrowserRecoveryFxGraph(snapshot, 0);
    expect(plan.signalsmithProcessorCount).toBe(5 * 4 * 3);
    expect(plan.estimatedSignalsmithWasmBytes).toBe(5 * 4 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES);
    expect(plan.estimatedSignalsmithWasmBytes).toBeLessThan(SIGNALSMITH_LIVE_WASM_BUDGET_BYTES);
  });

  it('rejects a candidate whose doubled PCM plus reserved WASM exceeds the known-payload cap', () => {
    const snapshot = snapshotWith((_bankIndex, slotIndex) => slotIndex === 0 ? 'OCTAVE' : null);
    const sourcePcmBytes = Math.floor(MAX_RECOVERY_CANDIDATE_KNOWN_PAYLOAD_BYTES / 2) + 1;
    expect(() => planBrowserRecoveryFxGraph(snapshot, sourcePcmBytes)).toThrow(/known PCM\/WASM\/legacy-IR peak .* exceeds/);
  });

  it('preflights all 28 saved shared and private slots against one context ledger', () => {
    const snapshot = snapshotWith(() => 'OCTAVE');
    const plan = planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true });
    expect(plan).toMatchObject({
      estimatedInputSignalsmithWasmBytes: 4 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      estimatedSharedTrackSignalsmithWasmBytes: 4 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      estimatedPrivateTrackSignalsmithWasmBytes: 20 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      estimatedSignalsmithWasmBytes: 28 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      signalsmithProcessorCount: 28 * 3,
      materializesSharedFx: true,
    });
    expect(plan.estimatedSignalsmithWasmBytes).toBe(105 * 1024 * 1024);
    expect(plan.estimatedSignalsmithWasmBytes).toBeLessThan(SIGNALSMITH_LIVE_WASM_BUDGET_BYTES);
  });

  it('reserves the maximum 84 LIVE_FX + five LIVE_POLY shape as 125 MiB with only 3 MiB headroom', () => {
    const snapshot = snapshotWith(() => 'OCTAVE');
    for (const track of (snapshot as any).tracks) track.pitch.mode = 'LIVE_POLY';
    const plan = planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true });
    expect(plan).toMatchObject({
      estimatedSignalsmithWasmBytes: 105 * 1024 * 1024,
      livePolyPitchProcessorCount: 5,
      estimatedLivePolyWasmBytes: 20 * 1024 * 1024,
      estimatedCombinedSignalsmithWasmBytes: 125 * 1024 * 1024,
      availableSignalsmithWasmHeadroomBytes: 3 * 1024 * 1024,
    });
  });

  it('reports that maximum steady-state headroom cannot cover one more LIVE_POLY processor', () => {
    const snapshot = snapshotWith(() => 'OCTAVE') as any;
    for (const track of snapshot.tracks) track.pitch.mode = 'LIVE_POLY';
    const plan = planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true });
    expect(plan.availableSignalsmithWasmHeadroomBytes).toBe(3 * 1024 * 1024);
    expect(SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES).toBe(4 * 1024 * 1024);
    expect(plan.availableSignalsmithWasmHeadroomBytes).toBeLessThan(SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES);
  });

  it('rejects the aggregate shared-plus-private candidate before allocation when the budget is exceeded', () => {
    const snapshot = snapshotWith(() => 'OCTAVE');
    const requestedBytes = 28 * 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
    expect(() => planBrowserRecoveryFxGraph(snapshot, 0, {
      includeSharedBanks: true,
      signalsmithBudgetBytes: requestedBytes - 1,
    })).toThrow(/above the .* candidate budget .* old graph remains available/);
  });

  it('keeps shared source-readhead slots explicit metadata and does not count them as postmix processors', () => {
    const snapshot = snapshotWith((bankIndex, slotIndex) => bankIndex === 1 && slotIndex === 0 ? 'BEAT SHIFT' : null);
    const plan = planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true });
    expect(plan.metadataOnlySourceReaderCount).toBe(1);
    expect(plan.estimatedSignalsmithWasmBytes).toBe(0);
  });

  it('counts the legacy REVERB impulse buffers in known candidate memory', () => {
    const snapshot = snapshotWith((bankIndex, slotIndex) => bankIndex === 0 && slotIndex === 0 ? 'REVERB' : null) as any;
    snapshot.fx.input[0] = {
      ...snapshot.fx.input[0],
      parameters: { decay: 0.5, mix: 0.25 },
    };
    const plan = planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true });
    expect(plan.estimatedLegacyReverbPeakBytes).toBeGreaterThan(0);
    expect(plan.estimatedKnownPeakBytes).toBe(plan.estimatedLegacyReverbPeakBytes);
  });

  it('rejects legacy shared FX values outside the original controls instead of silently clamping them', () => {
    const filterSnapshot = snapshotWith((bankIndex, slotIndex) => bankIndex === 0 && slotIndex === 0 ? 'FILTER' : null) as any;
    filterSnapshot.fx.input[0] = {
      ...filterSnapshot.fx.input[0], parameters: { frequency: 1.1, resonance: 0.5 },
    };
    expect(() => planBrowserRecoveryFxGraph(filterSnapshot, 0, { includeSharedBanks: true }))
      .toThrow(/FILTER parameter frequency is outside the saved control range 0–1/);

    const slicerSnapshot = snapshotWith((bankIndex, slotIndex) => bankIndex === 1 && slotIndex === 0 ? 'SLICER' : null) as any;
    slicerSnapshot.fx.sharedTrack[0] = {
      ...slicerSnapshot.fx.sharedTrack[0], parameters: { rate: 101, depth: 50, bypassed: 0 },
    };
    expect(() => planBrowserRecoveryFxGraph(slicerSnapshot, 0, { includeSharedBanks: true }))
      .toThrow(/SLICER parameter rate is outside the saved control range 0–100/);
  });

  it('rejects a source-readhead effect in a serial private A–D slot instead of silently changing topology', () => {
    const snapshot = snapshotWith((bankIndex, slotIndex) => bankIndex === 2 && slotIndex === 0 ? 'BEAT SHIFT' : null);
    expect(() => planBrowserRecoveryFxGraph(snapshot, 1024)).toThrow(/cannot reconstruct Track 1 BEAT SHIFT in slot A as an ordered A–D insert/);
  });

  it('rejects a nonnumeric or unknown persisted parameter before candidate allocation', () => {
    const snapshot = snapshotWith((bankIndex, slotIndex) => bankIndex === 2 && slotIndex === 0 ? 'DSP HPF' : null) as any;
    snapshot.fx.privateTracks[0][0] = {
      ...snapshot.fx.privateTracks[0][0],
      parameters: { cutoffHz: 400, legacyUnknown: 1 },
    };
    expect(() => planBrowserRecoveryFxGraph(snapshot, 1024)).toThrow(/cannot be restored/);
  });
});


describe('recovery internal host clock metadata', () => {
  it('accepts bounded BPM/meter on every worklet route without exposing a user control', () => {
    const snapshot = snapshotWith((_bank, slotIndex) => slotIndex === 0 ? 'DSP LPF' : null) as any;
    for (const bank of [snapshot.fx.input, snapshot.fx.sharedTrack, ...snapshot.fx.privateTracks]) {
      bank[0].parameters = { bpm: 107, quarterNotesPerMeasure: 3.5, official_cutoff: 30 };
    }
    expect(() => planBrowserRecoveryFxGraph(snapshot, 0, { includeSharedBanks: true })).not.toThrow();
  });
  it.each([{ bpm: 0 }, { bpm: 301 }, { quarterNotesPerMeasure: 0 }, { quarterNotesPerMeasure: 129 }, { quarterNotesPerMeasure: NaN }])('rejects out-of-domain clock metadata %j before creating nodes', parameters => {
    const snapshot = snapshotWith((_bank, slotIndex) => slotIndex === 0 ? 'DSP LPF' : null) as any;
    snapshot.fx.privateTracks[0][0].parameters = parameters;
    expect(() => planBrowserRecoveryFxGraph(snapshot, 0)).toThrow(/parameter/);
  });
});
