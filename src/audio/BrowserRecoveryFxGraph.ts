import { BrowserTrackFxChain, BROWSER_PER_TRACK_FX_TYPES, BROWSER_PER_TRACK_PARAMETER_KEYS, validateBrowserFxInternalParameter, type BrowserTrackFxStatus } from './BrowserTrackFxChain';
import { fxCatalogIdForDisplayLabel } from './fx/fxTypeIdentity';
import {
  SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
  SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES,
  SIGNALSMITH_LIVE_WASM_BUDGET_BYTES,
  signalsmithLiveWasmSnapshot,
} from './pitch/signalsmithWasmBudget';
import type { BrowserRecoveryFxSlot, BrowserRecoverySnapshot } from './BrowserRecoverySnapshot';
import {
  createBrowserRecoverySharedFxBank,
  type BrowserRecoverySharedFxBank,
  type BrowserRecoverySharedFxSlotStatus,
} from './BrowserRecoverySharedFxBank';
import {
  buildBrowserRecoveryOutputDsp,
  validateBrowserRecoveryOutputDspSnapshot,
  type BrowserRecoveryOutputDsp,
} from './BrowserRecoveryOutputDsp';

const SLOT_NAMES = ['A', 'B', 'C', 'D'] as const;
const GRAPH_READY_TIMEOUT_MS = 12_000;
const MODULE_URL = '/worklets/fx-processor.js';

/** The only candidate allocation charged here is known PCM/WASM payload, not browser RSS. */
export const MAX_RECOVERY_CANDIDATE_KNOWN_PAYLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export interface BrowserRecoveryFxGraphPlan {
  readonly estimatedSourcePcmBytes: number;
  readonly estimatedCandidatePcmBytes: number;
  readonly estimatedSignalsmithWasmBytes: number;
  readonly livePolyPitchProcessorCount: number;
  readonly estimatedLivePolyWasmBytes: number;
  readonly estimatedCombinedSignalsmithWasmBytes: number;
  readonly availableSignalsmithWasmHeadroomBytes: number;
  readonly estimatedInputSignalsmithWasmBytes: number;
  readonly estimatedSharedTrackSignalsmithWasmBytes: number;
  readonly estimatedPrivateTrackSignalsmithWasmBytes: number;
  readonly estimatedLegacyReverbPeakBytes: number;
  readonly estimatedKnownPeakBytes: number;
  readonly signalsmithProcessorCount: number;
  readonly materializesSharedFx: boolean;
  readonly outputDspAlgorithm: string | null;
  readonly metadataOnlySourceReaderCount: number;
  readonly hasUnboundedBrowserOverhead: true;
}

export interface BrowserRecoveryFxGraph {
  readonly privateTrackBanks: readonly BrowserTrackFxChain[];
  readonly inputBank: BrowserRecoverySharedFxBank | null;
  readonly sharedTrackBank: BrowserRecoverySharedFxBank | null;
  readonly outputDsp: BrowserRecoveryOutputDsp | null;
  readonly metadataOnly: Readonly<{
    sourceReaderOverrides: BrowserRecoverySnapshot['fx']['sourceOverrides'];
    rhythm: BrowserRecoverySnapshot['rhythm'];
    midiTarget: BrowserRecoverySnapshot['midi']['target'];
    midiInputState: 'disconnected';
  }>;
  readonly plan: BrowserRecoveryFxGraphPlan;
  dispose(): void;
  getStatuses(): readonly BrowserTrackFxStatus[];
  getSharedStatuses(): Readonly<{
    input: readonly BrowserRecoverySharedFxSlotStatus[];
    sharedTrack: readonly BrowserRecoverySharedFxSlotStatus[];
  }>;
}

export type RecoveryFxModuleLoader = (context: AudioContext) => Promise<void>;

export interface BrowserRecoveryFxGraphPlanOptions {
  readonly includeSharedBanks?: boolean;
  /** Test seam for verifying that all role reservations share the context-wide cap. */
  readonly signalsmithBudgetBytes?: number;
}

function normalized(type: string): string {
  return type.trim().toUpperCase().replace(/ \(EXPERIMENTAL\)$/, '');
}

function reservationsForType(type: string): number {
  switch (normalized(type)) {
    case 'TRANSPOSE':
    case 'PITCH BEND':
    case 'ROBOT':
    case 'AUTO RIFF':
      return SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
    case 'HRM MANUAL':
      return 2 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
    case 'OCTAVE':
      return 3 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
    case 'HRM AUTO (M)':
      return 2 * SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
    default:
      return 0;
  }
}

function parameterSchemaForType(type: string): string | null {
  const canonical = normalized(type);
  if (canonical === 'DSP LPF') return 'lpf';
  if (canonical === 'DSP BPF') return 'bpf';
  if (canonical === 'DSP HPF') return 'hpf';
  if (canonical === 'FDN8 REVERB') return 'reverb';
  const catalogId = fxCatalogIdForDisplayLabel(type);
  if (catalogId === 'dist') return 'distortion';
  if (catalogId === 'hrm-auto-m') return 'hrm-auto';
  if (catalogId === 'osc-voc-m') return 'osc-voc';
  return catalogId;
}

const LEGACY_SHARED_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  FILTER: ['frequency', 'resonance'], REVERB: ['decay', 'mix'], SLICER: ['rate', 'depth', 'bypassed'],
});
const LEGACY_SHARED_PARAMETER_RANGES: Readonly<Record<string, Readonly<Record<string, readonly [number, number]>>>> = Object.freeze({
  FILTER: { frequency: [0, 1], resonance: [0, 1] },
  REVERB: { decay: [0, 1], mix: [0, 1] },
  SLICER: { rate: [0, 100], depth: [0, 100], bypassed: [0, 1] },
});

function sourceReaderType(type: string): boolean {
  return normalized(type) === 'BEAT SHIFT' || normalized(type) === 'VINYL FLICK';
}

function estimateLegacyReverbPeakBytes(slot: BrowserRecoveryFxSlot, sampleRate: number): number {
  const initialIr = Math.ceil(sampleRate * 2 * 2 * Float32Array.BYTES_PER_ELEMENT);
  const decay = typeof slot.parameters.decay === 'number' ? slot.parameters.decay : 0.475;
  if (!Number.isFinite(decay) || decay < 0 || decay > 1) throw new Error(`Recovery legacy REVERB ${slot.slot} has invalid decay.`);
  const configuredIr = Math.ceil(sampleRate * (0.1 + decay * 4) * 2 * Float32Array.BYTES_PER_ELEMENT);
  return initialIr + configuredIr;
}

function validateSharedSlot(
  slot: BrowserRecoveryFxSlot,
  index: number,
  location: 'input' | 'sharedTrack',
  sampleRate: number,
): { reservationBytes: number; reverbBytes: number; sourceReader: boolean } {
  if (slot.slot !== SLOT_NAMES[index]) throw new Error(`Recovery ${location} FX slot ${index} has an invalid A–D identity.`);
  if (slot.state !== 'empty' && slot.state !== 'ready') {
    throw new Error(`Shared ${location} FX ${slot.type ?? slot.requestedType ?? 'slot'} is ${slot.state}; settle or clear it before recovery.`);
  }
  if (slot.type === null) {
    if (slot.state !== 'empty' || slot.active || slot.requestedActive !== null) throw new Error(`Empty ${location} FX slot ${slot.slot} contains inconsistent active state.`);
    return { reservationBytes: 0, reverbBytes: 0, sourceReader: false };
  }
  if (slot.state !== 'ready' || slot.requestedType !== null || !slot.parametersCaptured) {
    throw new Error(`Shared ${location} FX ${slot.type} in slot ${slot.slot} does not have a complete acknowledged parameter snapshot.`);
  }
  const canonical = normalized(slot.type);
  const sourceReader = sourceReaderType(slot.type);
  if (sourceReader && location === 'input') throw new Error(`${slot.type} cannot be restored on the Browser shared Input route; it is a per-loop source-reader effect.`);
  if (location === 'input' && (canonical === 'BEAT REPEAT' || canonical === 'BEAT SCATTER')) {
    throw new Error(`${slot.type} is not supported on the Browser Input bank.`);
  }
  const legacySchema = LEGACY_SHARED_PARAMETERS[canonical];
  const executable = legacySchema !== undefined || BROWSER_PER_TRACK_FX_TYPES.includes(canonical) || canonical === 'AUTO RIFF';
  if (!sourceReader && !executable) throw new Error(`Recovery cannot reconstruct shared ${location} ${slot.type} in slot ${slot.slot}; the old graph remains available.`);
  if (slot.amount !== null && !Number.isFinite(slot.amount)) throw new Error(`Shared ${location} FX ${slot.type} has a non-finite amount.`);
  for (const [key, value] of Object.entries(slot.parameters)) {
    if (sourceReader) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Source-reader ${slot.type} metadata has a non-finite ${key} value.`);
      continue;
    }
    const allowed = legacySchema ?? BROWSER_PER_TRACK_PARAMETER_KEYS[parameterSchemaForType(slot.type) ?? ''];
    if (legacySchema && key === 'bypassed' && canonical === 'SLICER') {
      if (typeof value !== 'number' || (value !== 0 && value !== 1)) throw new Error(`Legacy SLICER ${slot.slot} has an invalid bypass snapshot.`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)
      || !(validateBrowserFxInternalParameter(parameterSchemaForType(slot.type) ?? '', key, value) ?? allowed?.includes(key))) {
      throw new Error(`Shared ${location} FX ${slot.type} parameter ${key} cannot be restored by the Browser candidate graph.`);
    }
    const range = LEGACY_SHARED_PARAMETER_RANGES[canonical]?.[key];
    if (range && (value < range[0] || value > range[1])) {
      throw new Error(`Legacy shared ${location} FX ${slot.type} parameter ${key} is outside the saved control range ${range[0]}–${range[1]}.`);
    }
  }
  return {
    reservationBytes: sourceReader ? 0 : reservationsForType(slot.type),
    reverbBytes: canonical === 'REVERB' ? estimateLegacyReverbPeakBytes(slot, sampleRate) : 0,
    sourceReader,
  };
}

/** Preflight all requested FX reservations before creating a candidate context or cloning PCM. */
export function planBrowserRecoveryFxGraph(
  snapshot: BrowserRecoverySnapshot,
  sourcePcmBytes: number,
  options: BrowserRecoveryFxGraphPlanOptions = {},
): BrowserRecoveryFxGraphPlan {
  if (!Number.isSafeInteger(sourcePcmBytes) || sourcePcmBytes < 0) {
    throw new Error('Recovery FX graph received an invalid source PCM estimate.');
  }
  if (snapshot.fx.privateTracks.length !== 5 || snapshot.fx.privateTracks.some((bank) => bank.length !== 4)) {
    throw new Error('Recovery private FX graph requires all five A–D banks.');
  }
  const includeSharedBanks = options.includeSharedBanks === true;
  if (includeSharedBanks && (snapshot.fx.input.length !== 4 || snapshot.fx.sharedTrack.length !== 4)) {
    throw new Error('Recovery shared FX graph requires four Input and four postmix Track slots.');
  }
  const policyBudget = options.signalsmithBudgetBytes ?? SIGNALSMITH_LIVE_WASM_BUDGET_BYTES;
  if (!Number.isSafeInteger(policyBudget) || policyBudget < 0 || policyBudget > SIGNALSMITH_LIVE_WASM_BUDGET_BYTES) {
    throw new Error('Recovery Signalsmith candidate budget is invalid or exceeds the 128 MiB per-context cap.');
  }
  let signalsmithProcessorCount = 0;
  let estimatedPrivateTrackSignalsmithWasmBytes = 0;
  let estimatedInputSignalsmithWasmBytes = 0;
  let estimatedSharedTrackSignalsmithWasmBytes = 0;
  let estimatedLegacyReverbPeakBytes = 0;
  let metadataOnlySourceReaderCount = 0;
  const livePolyPitchProcessorCount = snapshot.tracks.filter((track) => track.pitch.mode === 'LIVE_POLY').length;
  const estimatedLivePolyWasmBytes = livePolyPitchProcessorCount * SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES;
  const estimateSharedBank = (bank: readonly BrowserRecoveryFxSlot[], location: 'input' | 'sharedTrack') => {
    for (let index = 0; index < bank.length; index += 1) {
      const checked = validateSharedSlot(bank[index]!, index, location, snapshot.source.sampleRate);
      if (checked.sourceReader) metadataOnlySourceReaderCount += 1;
      estimatedLegacyReverbPeakBytes += checked.reverbBytes;
      signalsmithProcessorCount += checked.reservationBytes / SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
      if (location === 'input') estimatedInputSignalsmithWasmBytes += checked.reservationBytes;
      else estimatedSharedTrackSignalsmithWasmBytes += checked.reservationBytes;
    }
  };
  if (includeSharedBanks) {
    estimateSharedBank(snapshot.fx.input, 'input');
    estimateSharedBank(snapshot.fx.sharedTrack, 'sharedTrack');
  }
  for (const [bankIndex, bank] of snapshot.fx.privateTracks.entries()) {
    for (let index = 0; index < bank.length; index += 1) {
      const slot = bank[index]!;
      if (slot.slot !== SLOT_NAMES[index]) throw new Error('Recovery FX snapshot has an invalid A–D slot identity.');
      if (slot.state !== 'empty' && slot.state !== 'ready') {
        throw new Error(`FX ${slot.type ?? slot.requestedType ?? 'slot'} is ${slot.state}; settle or clear it before rebuilding the candidate graph.`);
      }
      if (slot.type === null) {
        if (slot.state !== 'empty' || slot.active || slot.requestedActive !== null) {
          throw new Error(`Empty FX slot ${slot.slot} contains inconsistent active state.`);
        }
        continue;
      }
      if (slot.state !== 'ready' || slot.requestedType !== null || !slot.parametersCaptured) {
        throw new Error(`Track ${bankIndex + 1} FX ${slot.type} in slot ${slot.slot} does not have a complete acknowledged parameter snapshot.`);
      }
      const canonical = normalized(slot.type);
      if (!BROWSER_PER_TRACK_FX_TYPES.includes(canonical) && canonical !== 'AUTO RIFF') {
        throw new Error(`Recovery cannot reconstruct Track ${bankIndex + 1} ${slot.type} in slot ${slot.slot} as an ordered A–D insert; the old graph remains available.`);
      }
      if (slot.amount !== null && !Number.isFinite(slot.amount)) throw new Error(`FX ${slot.type} has a non-finite amount.`);
      for (const [key, value] of Object.entries(slot.parameters)) {
        const acceptedKeys = BROWSER_PER_TRACK_PARAMETER_KEYS[parameterSchemaForType(slot.type) ?? ''];
        if (typeof value !== 'number' || !Number.isFinite(value)
          || !(validateBrowserFxInternalParameter(parameterSchemaForType(slot.type) ?? '', key, value) ?? acceptedKeys?.includes(key))) {
          throw new Error(`FX ${slot.type} parameter ${key} cannot be restored by the Browser candidate graph.`);
        }
      }
      if (slot.active && typeof slot.active !== 'boolean') throw new Error(`FX ${slot.type} has invalid active state.`);
      const reservation = reservationsForType(slot.type);
      signalsmithProcessorCount += reservation / SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;
      estimatedPrivateTrackSignalsmithWasmBytes += reservation;
    }
  }
  const estimatedSignalsmithWasmBytes = estimatedPrivateTrackSignalsmithWasmBytes
    + estimatedInputSignalsmithWasmBytes + estimatedSharedTrackSignalsmithWasmBytes;
  const estimatedCombinedSignalsmithWasmBytes = estimatedSignalsmithWasmBytes + estimatedLivePolyWasmBytes;
  const availableSignalsmithWasmHeadroomBytes = policyBudget - estimatedCombinedSignalsmithWasmBytes;
  if (!Number.isSafeInteger(estimatedCombinedSignalsmithWasmBytes)
    || estimatedCombinedSignalsmithWasmBytes > policyBudget) {
    throw new Error(
      `Recovery FX and LIVE_POLY runtime requires ${estimatedCombinedSignalsmithWasmBytes} bytes of reserved Signalsmith WASM memory, above the ${policyBudget}-byte candidate budget (128 MiB per-context cap); the old graph remains available.`,
    );
  }
  if (includeSharedBanks) validateBrowserRecoveryOutputDspSnapshot(snapshot.fx.outputDsp);
  const estimatedCandidatePcmBytes = sourcePcmBytes;
  const knownPeak = sourcePcmBytes + estimatedCandidatePcmBytes + estimatedCombinedSignalsmithWasmBytes + estimatedLegacyReverbPeakBytes;
  if (!Number.isSafeInteger(knownPeak) || knownPeak > MAX_RECOVERY_CANDIDATE_KNOWN_PAYLOAD_BYTES) {
    throw new Error(
      `Recovery candidate known PCM/WASM/legacy-IR peak ${knownPeak} bytes exceeds the ${MAX_RECOVERY_CANDIDATE_KNOWN_PAYLOAD_BYTES}-byte admission cap; the old graph remains available.`,
    );
  }
  return Object.freeze({
    estimatedSourcePcmBytes: sourcePcmBytes,
    estimatedCandidatePcmBytes,
    estimatedSignalsmithWasmBytes,
    livePolyPitchProcessorCount,
    estimatedLivePolyWasmBytes,
    estimatedCombinedSignalsmithWasmBytes,
    availableSignalsmithWasmHeadroomBytes,
    estimatedInputSignalsmithWasmBytes,
    estimatedSharedTrackSignalsmithWasmBytes,
    estimatedPrivateTrackSignalsmithWasmBytes,
    estimatedLegacyReverbPeakBytes,
    estimatedKnownPeakBytes: knownPeak,
    signalsmithProcessorCount,
    materializesSharedFx: includeSharedBanks,
    outputDspAlgorithm: includeSharedBanks ? snapshot.fx.outputDsp.algorithm : null,
    metadataOnlySourceReaderCount,
    hasUnboundedBrowserOverhead: true,
  });
}

function restoreBank(
  chain: BrowserTrackFxChain,
  slots: readonly BrowserRecoveryFxSlot[],
): void {
  for (let index = 0; index < slots.length; index += 1) {
    const saved = slots[index]!;
    if (!saved.type) continue;
    if (!chain.setType(index, saved.type)) throw new Error(`Recovery FX graph rejected ${saved.type} in slot ${saved.slot}.`);
    if (saved.amount !== null && !chain.setParameter(index, saved.amount)) {
      throw new Error(`Recovery FX graph could not restore amount for ${saved.type} in slot ${saved.slot}.`);
    }
    const parameters: Record<string, number> = {};
    for (const [key, value] of Object.entries(saved.parameters)) {
      if (typeof value !== 'number') throw new Error(`Recovery FX graph cannot restore non-numeric ${saved.type} parameter ${key}.`);
      parameters[key] = value;
    }
    if (Object.keys(parameters).length > 0 && !chain.setNamedParameters(index, parameters)) {
      throw new Error(`Recovery FX graph could not restore named parameters for ${saved.type} in slot ${saved.slot}.`);
    }
    if (!chain.setActive(index, saved.active)) throw new Error(`Recovery FX graph could not restore active state for ${saved.type} in slot ${saved.slot}.`);
  }
}

/**
 * Rebuild persisted FX on a suspended candidate context. Shared Input and
 * postmix/output stages are optional for backward-compatible private-only
 * callers. No source, device, rhythm clock, or old engine graph is connected.
 */
export async function buildBrowserRecoveryFxGraph(
  context: AudioContext,
  silentSink: GainNode,
  snapshot: BrowserRecoverySnapshot,
  plan: BrowserRecoveryFxGraphPlan,
  loadModule: RecoveryFxModuleLoader = (target) => {
    if (!target.audioWorklet) return Promise.reject(new Error('Recovery AudioWorklet is unavailable.'));
    return target.audioWorklet.addModule(MODULE_URL);
  },
  includeSharedBanks = false,
): Promise<BrowserRecoveryFxGraph> {
  if (context.state !== 'suspended' || silentSink.gain.value !== 0) {
    throw new Error('Recovery FX graph requires a suspended context and a muted sink.');
  }
  let modulePromise: Promise<void> | null = null;
  const ensureModule = () => modulePromise ?? (modulePromise = loadModule(context));
  const chains: BrowserTrackFxChain[] = [];
  // This graph is inspection-only, with no source or adoptable engine. Its
  // empty playback endpoints validate official carrier selection silently.
  // Production adoption constructs a fresh BrowserAudioEngine whose callback
  // binds its own TrackAudio.playbackSourceOutput buses instead.
  const silentCarrierSources = Array.from({ length: 5 }, () => context.createGain());
  const getCarrierSource = (trackId: number): AudioNode | null => silentCarrierSources[trackId - 1] ?? null;
  const getQuarterNotesPerMeasure = () => {
    const signature = snapshot.transport.timeSignature;
    return signature ? signature[0] * 4 / signature[1] : 4;
  };
  let inputBank: BrowserRecoverySharedFxBank | null = null;
  let sharedTrackBank: BrowserRecoverySharedFxBank | null = null;
  let outputDsp: BrowserRecoveryOutputDsp | null = null;
  let disposed = false;
  try {
    if (plan.materializesSharedFx !== includeSharedBanks) {
      throw new Error('Recovery FX graph options do not match the preflight reservation plan.');
    }
    const privateTrackBanks = Array.from({ length: 5 }, () => new BrowserTrackFxChain(context, ensureModule, () => {}, () => snapshot.transport.bpm, getQuarterNotesPerMeasure, getCarrierSource));
    chains.push(...privateTrackBanks);
    for (const bank of chains) bank.output.connect(silentSink);

    for (let trackIndex = 0; trackIndex < privateTrackBanks.length; trackIndex += 1) {
      restoreBank(privateTrackBanks[trackIndex]!, snapshot.fx.privateTracks[trackIndex]!);
    }

    if (includeSharedBanks) {
      inputBank = createBrowserRecoverySharedFxBank(context, 'input', snapshot.fx.input, ensureModule, () => snapshot.transport.bpm, getQuarterNotesPerMeasure, getCarrierSource);
      sharedTrackBank = createBrowserRecoverySharedFxBank(context, 'sharedTrack', snapshot.fx.sharedTrack, ensureModule, () => snapshot.transport.bpm, getQuarterNotesPerMeasure, getCarrierSource);
      inputBank.output.connect(silentSink);
      outputDsp = await buildBrowserRecoveryOutputDsp(
        context,
        silentSink,
        snapshot.fx.outputDsp,
        ensureModule,
      );
      if (outputDsp) sharedTrackBank.output.connect(outputDsp.node);
      else sharedTrackBank.output.connect(silentSink);
    }

    const deadline = Date.now() + GRAPH_READY_TIMEOUT_MS;
    while (true) {
      const statuses = privateTrackBanks.map((bank, index) => bank.getStatus(index + 1));
      const slots = statuses.flatMap((status) => status.slots);
      const failed = slots.find((slot) => slot.state === 'error');
      if (failed) throw new Error(`Recovery FX graph failed for ${failed.type ?? failed.requestedEffectId ?? failed.slot}: ${failed.error ?? 'processor did not become ready'}`);
      const sharedSlots = [
        ...(inputBank?.getStatuses() ?? []),
        ...(sharedTrackBank?.getStatuses() ?? []),
      ];
      const failedShared = sharedSlots.find((slot) => slot.state === 'error');
      if (failedShared) throw new Error(`Recovery shared FX graph failed for ${failedShared.type ?? failedShared.slot}: ${failedShared.error ?? 'processor did not become ready'}`);
      const waiting = slots.some((slot) => slot.state === 'loading') || sharedSlots.some((slot) => slot.state === 'loading');
      if (!waiting) break;
      if (Date.now() >= deadline) throw new Error(`Recovery FX graph did not become ready within ${GRAPH_READY_TIMEOUT_MS} ms.`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (context.state !== 'suspended') throw new Error('Recovery candidate context left suspended state while preparing FX; old graph remains available.');
    }

    const actual = signalsmithLiveWasmSnapshot(context);
    if (actual.reservedBytes !== plan.estimatedSignalsmithWasmBytes
      || actual.reservedBytes > actual.budgetBytes
      || actual.pendingCount !== 0
      || actual.releaseUnconfirmedCount !== 0) {
      throw new Error('Recovery FX graph Signalsmith reservation did not match its preflight or still has an unconfirmed allocation.');
    }
    if (actual.processorCount !== plan.signalsmithProcessorCount) {
      throw new Error(`Recovery FX graph materialized ${actual.processorCount} Signalsmith processors but preflight reserved ${plan.signalsmithProcessorCount}.`);
    }
    return Object.freeze({
      privateTrackBanks: Object.freeze(privateTrackBanks),
      inputBank,
      sharedTrackBank,
      outputDsp,
      metadataOnly: Object.freeze({
        sourceReaderOverrides: snapshot.fx.sourceOverrides,
        rhythm: snapshot.rhythm,
        midiTarget: snapshot.midi.target,
        midiInputState: 'disconnected' as const,
      }),
      plan,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const chain of chains) chain.dispose();
        inputBank?.dispose();
        sharedTrackBank?.dispose();
        outputDsp?.dispose();
        for (const source of silentCarrierSources) source.disconnect();
      },
      getStatuses() {
        return Object.freeze(privateTrackBanks.map((bank, index) => bank.getStatus(index + 1)));
      },
      getSharedStatuses() {
        return Object.freeze({
          input: inputBank?.getStatuses() ?? Object.freeze([]),
          sharedTrack: sharedTrackBank?.getStatuses() ?? Object.freeze([]),
        });
      },
    });
  } catch (error) {
    for (const chain of chains) chain.dispose();
    inputBank?.dispose();
    sharedTrackBank?.dispose();
    outputDsp?.dispose();
    for (const source of silentCarrierSources) source.disconnect();
    throw error;
  }
}
