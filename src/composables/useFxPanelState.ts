import { sameNativeControlSnapshot } from '../audio/nativeFxParameterSnapshots';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { FX_CATALOG } from '../audio/fx/catalog';
import { nativeCatalogEffectId, nativeCatalogMacroParameters, NATIVE_CATALOG_EMPTY_LABEL } from '../audio/nativeFxCatalog';
import { createDefaultPreampParameters, sanitizePreampParameters, type PreampParameters } from '../audio/preampParameters';
import { createDefaultSynthParameters, sanitizeSynthParameters, type SynthParameters } from '../audio/synthParameters';
import { createDefaultG2bParameters, sanitizeG2bParameters, toCatalogG2bParameters, type G2bParameters } from '../audio/g2bParameters';
import { createDefaultRollParameters, sanitizeRollParameters, toCatalogRollParameters, type RollParameters } from '../audio/rollParameters';
import { createDefaultFreezeParameters, sanitizeFreezeParameters, toCatalogFreezeParameters, type FreezeParameters } from '../audio/freezeParameters';
import { createDefaultNativeStepSlicerParameters, sanitizeNativeStepSlicerParameters, type NativeStepSlicerParameters } from '../audio/nativeStepSlicerParameters';
import { createDefaultPitchBendParameters, sanitizePitchBendParameters, toCatalogPitchBendParameters, type PitchBendParameters } from '../audio/pitchBendParameters';
import { createDefaultManualHarmonistParameters, sanitizeManualHarmonistParameters, toCatalogManualHarmonistParameters, type ManualHarmonistParameters } from '../audio/manualHarmonistParameters';
import { createDefaultOctaveParameters, sanitizeOctaveParameters, toCatalogOctaveParameters, type OctaveParameters } from '../audio/octaveParameters';
import { createDefaultVocoderParameters, sanitizeVocoderParameters, toCatalogVocoderParameters, type VocoderParameters } from '../audio/vocoderParameters';
import { createDefaultOscVocParameters, sanitizeOscVocParameters, toCatalogOscVocParameters, type OscVocParameters } from '../audio/oscVocParameters';
import { createDefaultAutoRiffParameters, sanitizeAutoRiffParameters, toCatalogAutoRiffParameters, type AutoRiffParameters } from '../audio/autoRiffParameters';
import { createDefaultRobotFxParameters, sanitizeRobotFxParameters, toCatalogRobotParameters, type RobotFxParameters } from '../audio/robotFxParameters';
import { createDefaultHrmAutoParameters, sanitizeHrmAutoParameters, toCatalogHrmAutoParameters, type HrmAutoParameters } from '../audio/hrmAutoParameters';
import { createDefaultElectricParameters, sanitizeElectricParameters, toBrowserElectricParameters, toNativeElectricParameters, type ElectricParameters } from '../audio/electricParameters';
import { getBrowserInputFxControls, getBrowserTrackFxControls, sanitizeBrowserTrackFxParameters } from './browserTrackFxParameters';
import { type FxLocation, type FxSlotId, usePanelFocus } from './usePanelFocus';
import { adoptCommittedBrowserTrackFxState, ensureBrowserTrackFxStateInitialized } from './useBrowserTrackFxState';
import type { BrowserMemoryConfiguration } from '../audio/BrowserRc505Memory';
import type { BrowserRecoveryFxSlot } from '../audio/BrowserRecoverySnapshot';
import { adoptCommittedNativeTrackFxState, readConfirmedNativeFxUiBank } from './useNativeTrackFxState';

export interface FxSlotState {
  id: FxSlotId;
  type: string;
  value: number;
  active: boolean;
  stepSlicerParameters?: NativeStepSlicerParameters;
  preampParameters?: PreampParameters;
  synthParameters?: SynthParameters;
  g2bParameters?: G2bParameters;
  rollParameters?: RollParameters;
  freezeParameters?: FreezeParameters;
  pitchBendParameters?: PitchBendParameters;
  manualHarmonistParameters?: ManualHarmonistParameters;
  octaveParameters?: OctaveParameters;
  vocoderParameters?: VocoderParameters;
  oscVocParameters?: OscVocParameters;
  autoRiffParameters?: AutoRiffParameters;
  robotParameters?: RobotFxParameters;
  hrmAutoParameters?: HrmAutoParameters;
  electricParameters?: ElectricParameters;
  /** Named overrides, kept separately for each slot and effect type. */
  namedParametersByType?: Record<string, Record<string, number>>;
}

const STORAGE_KEY = 'webrc505_top_panel';
const NATIVE_STORAGE_KEY = 'webrc505_native_fx_catalog';
// Keep the two older WebAudio fallback processors selectable for saved/user
// projects, but derive all catalog DSP options from actual Browser routing.
// This makes a newly wired effect visible without maintaining a second list and
// keeps metadata-only / experimental processors out of the production menu.
const legacyBrowserFxOptions = ['FILTER', 'REVERB', 'SLICER'] as const;
const browserCatalogFxName = (displayName: string) => {
  switch (displayName) {
    case 'LPF': return 'DSP LPF';
    case 'BPF': return 'DSP BPF';
    case 'HPF': return 'DSP HPF';
    case 'REVERB': return 'FDN8 REVERB';
    default: return displayName;
  }
};
// REVERSE REVERB has an executable, end-to-end-routed prototype in both
// Browser banks. Keep the other experimental prototypes hidden while this
// one is explicitly identified to users as experimental.
const browserSelectableExperimentalIds = new Set(['reverse-reverb', 'auto-riff', 'hrm-auto-m', 'robot', 'warp']);
const browserFxOptionsFor = (location: FxLocation) => {
  const runtimeTarget = location === 'input' ? 'input-bank-slot' : 'track-bank-slot';
  const wiredCatalogOptions = FX_CATALOG
    .filter((effect) => effect.implementationStatus === 'implemented'
      && effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === runtimeTarget))
    .map((effect) => browserCatalogFxName(effect.displayName));
  const experimentalOptions = FX_CATALOG
    .filter((effect) => browserSelectableExperimentalIds.has(effect.id)
      && effect.implementationStatus === 'experimental'
      && effect.runtimeImplementations?.some((item) => item.runtime === 'browser' && item.target === runtimeTarget))
    .map((effect) => `${browserCatalogFxName(effect.displayName)} (EXPERIMENTAL)`);
  return [...new Set([...legacyBrowserFxOptions, ...wiredCatalogOptions, ...experimentalOptions])];
};
const robotTypeNames = ['ROBOT', 'ROBOT (EXPERIMENTAL)'];
const isRobotFxType = (type: string) => robotTypeNames.includes(type);
const isHrmAutoFxType = (type: string) => type === 'HRM AUTO (M)' || type === 'HRM AUTO (M) (EXPERIMENTAL)';
const dedicatedInputEditorTypes = new Set([
  'PREAMP', 'SYNTH', 'G2B', 'ROLL', 'FREEZE', 'PITCH BEND', 'HRM MANUAL',
  'OCTAVE', 'VOCODER', 'OSC VOC (M)', 'AUTO RIFF', 'AUTO RIFF (EXPERIMENTAL)',
  'ROBOT', 'ROBOT (EXPERIMENTAL)', 'HRM AUTO (M)', 'HRM AUTO (M) (EXPERIMENTAL)',
  'ELECTRIC', 'STEP SLICER',
]);
function hasRobotRuntimeRoute(location: FxLocation, type: string): boolean {
  if (!isRobotFxType(type)) return false;
  const options = engine.getMode() === 'browser'
    ? browserFxOptionsFor(location)
    : engine.getNativeCatalogFxOptions(location);
  return options.some((option) => robotTypeNames.includes(option));
}
const engine = AudioEngine.getInstance();
const focus = usePanelFocus();

const defaultInputSlots: FxSlotState[] = [
  { id: 'A', type: 'FILTER', value: 0, active: false },
  { id: 'B', type: 'DELAY', value: 0, active: false },
  { id: 'C', type: 'REVERB', value: 0, active: false },
  { id: 'D', type: 'SLICER', value: 0, active: false },
];

const defaultTrackSlots: FxSlotState[] = [
  { id: 'A', type: 'FILTER', value: 0, active: false },
  { id: 'B', type: 'DELAY', value: 0, active: false },
  { id: 'C', type: 'REVERB', value: 0, active: false },
  { id: 'D', type: 'SLICER', value: 0, active: false },
];

const state = reactive({
  inputSlots: structuredClone(defaultInputSlots) as FxSlotState[],
  trackSlots: structuredClone(defaultTrackSlots) as FxSlotState[],
});

// Native has its own status-reported Input and Track catalog banks. Keep them
// distinct from Browser's A–D bank so selecting an unavailable Native effect
// can never masquerade as a working Browser implementation.
const nativeFxState = reactive<{ inputSlots: FxSlotState[]; trackSlots: FxSlotState[] }>({
  inputSlots: Array.from({ length: 4 }, (_, index) => ({
    id: ['A', 'B', 'C', 'D'][index] as FxSlotId, type: '', value: 0, active: false,
  })),
  trackSlots: Array.from({ length: 4 }, (_, index) => ({
    id: ['A', 'B', 'C', 'D'][index] as FxSlotId, type: '', value: 0, active: false,
  })),
});
const nativeStatusRevision = ref(0);
interface PendingNativeNamedParameters {
  location: FxLocation;
  slotIndex: number;
  effectId: string;
  overrides: Record<string, number>;
  expectedParameters: Record<string, number>;
  previousRevision: number | null;
  removedKeys: string[];
}
const pendingNativeNamedParameters = new Map<string, PendingNativeNamedParameters>();
let nativeMemoryHydrating = 0;
const nativeNamedParameterKey = (location: FxLocation, slotIndex: number) => `${location}:${slotIndex}`;
function nativeNamedSubmission(location: FxLocation, index: number, overrides: Record<string, number>, removedKeys: readonly string[] = []): Record<string, number> {
  const slot = (location === 'input' ? nativeFxState.inputSlots : nativeFxState.trackSlots)[index]!;
  const complete = engine.getNativeCatalogFxParameterSnapshot?.(location, index, 0, overrides)
    ?? { ...nativeCatalogMacroParameters(slot.type, slot.value), ...overrides };
  // Named edits are patches over the confirmed complete authored snapshot.
  // Only an explicit reset removes previously authored named keys; the host
  // retains its requiresRestart policy for that removal.
  for (const key of removedKeys) delete complete[key];
  return complete;
}
function reconcileNativeNamedParameters() {
  if (nativeMemoryHydrating) return;
  if (engine.getMode() !== 'native' || pendingNativeNamedParameters.size === 0) return;
  let changed = false;
  for (const [key, pending] of pendingNativeNamedParameters) {
    const runtime = engine.getNativeCatalogFxSlotStatus(pending.location, pending.slotIndex);
    if (!runtime || runtime.outcomeUnknown || runtime.pendingApply) continue;
    const requestedNewRevision = runtime.trackId === 0 || (runtime.requestedRevision !== null &&
      runtime.requestedRevision !== pending.previousRevision);
    if (runtime.acknowledged && requestedNewRevision &&
        runtime.acknowledgedEffectId === pending.effectId &&
        sameNativeControlSnapshot(runtime.acknowledgedParameters, pending.expectedParameters, pending.effectId, pending.overrides)) {
      const slot = (pending.location === 'input' ? nativeFxState.inputSlots : nativeFxState.trackSlots)[pending.slotIndex];
      if (slot && nativeCatalogEffectId(slot.type) === pending.effectId) {
        slot.namedParametersByType ??= {};
        if (Object.keys(pending.overrides).length) slot.namedParametersByType[slot.type] = { ...pending.overrides };
        else delete slot.namedParametersByType[slot.type];
        if (slot.namedParametersByType && Object.keys(slot.namedParametersByType).length === 0) {
          slot.namedParametersByType = undefined;
        }
        changed = true;
      }
      pendingNativeNamedParameters.delete(key);
      continue;
    }
    if (requestedNewRevision && runtime.error && !runtime.acknowledged && !runtime.pendingRestart) {
      // Keep the last acknowledged override map on definite host rejection.
      pendingNativeNamedParameters.delete(key);
    }
  }
  if (changed) persistNativeFxSlots();
}
engine.onStatusChange(() => {
  reconcileNativeNamedParameters();
  nativeStatusRevision.value += 1;
});

let initialized = false;
let memoryHydrating = 0;
interface AdoptedSlotControls { type: string; value: number; active: boolean; typed: Record<string, number>; named: Record<string, number> }
const adoptedControls = new WeakMap<FxSlotState, AdoptedSlotControls>();

function typedControls(slot: FxSlotState): Record<string, number> {
  return {
    ...(slot.preampParameters ? { model: slot.preampParameters.model, gain: slot.preampParameters.gainPercent, bass: slot.preampParameters.bassDb, middle: slot.preampParameters.middleDb, treble: slot.preampParameters.trebleDb, level: slot.preampParameters.levelDb } : {}),
    ...(slot.synthParameters ?? {}),
    ...(slot.g2bParameters ? toCatalogG2bParameters(slot.g2bParameters) : {}),
    ...(slot.rollParameters ? toCatalogRollParameters(slot.rollParameters) : {}),
    ...(slot.freezeParameters ? toCatalogFreezeParameters(slot.freezeParameters) : {}),
    ...(slot.pitchBendParameters ? toCatalogPitchBendParameters(slot.pitchBendParameters) : {}),
    ...(slot.manualHarmonistParameters ? toCatalogManualHarmonistParameters(slot.manualHarmonistParameters) : {}),
    ...(slot.octaveParameters ? toCatalogOctaveParameters(slot.octaveParameters) : {}),
    ...(slot.vocoderParameters ? toCatalogVocoderParameters(slot.vocoderParameters) : {}),
    ...(slot.oscVocParameters ? toCatalogOscVocParameters(slot.oscVocParameters) : {}),
    ...(slot.autoRiffParameters ? toCatalogAutoRiffParameters(slot.autoRiffParameters) : {}),
    ...(slot.robotParameters ? toCatalogRobotParameters(slot.robotParameters) : {}),
    ...(slot.hrmAutoParameters ? toCatalogHrmAutoParameters(slot.hrmAutoParameters) : {}),
    ...(slot.electricParameters ? engine.getMode() === 'native' ? toNativeElectricParameters(slot.electricParameters) : toBrowserElectricParameters(slot.electricParameters) : {}),
    ...(slot.stepSlicerParameters ?? {}),
  };
}

function adoptedSnapshot(slot: FxSlotState): AdoptedSlotControls {
  return { type: slot.type, value: slot.value, active: slot.active, typed: typedControls(slot), named: { ...slot.namedParametersByType?.[slot.type] } };
}

function slotFromReadback(saved: BrowserRecoveryFxSlot): FxSlotState {
  const p = Object.fromEntries(Object.entries(saved.parameters).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  const n = (fallback: number, ...keys: string[]): number => {
    for (const key of keys) if (p[key] !== undefined) return p[key]!;
    return fallback;
  };
  const slot: FxSlotState = { id: saved.slot, type: saved.type ?? '', value: saved.amount ?? 0, active: saved.active,
    namedParametersByType: saved.type ? { [saved.type]: p } : undefined };
  switch (slot.type.replace(' (EXPERIMENTAL)', '')) {
    case 'PREAMP': slot.preampParameters = sanitizePreampParameters({ model: n(0, 'preampModel', 'model'), gainPercent: n(35, 'preampGainPercent', 'gain'), bassDb: n(0, 'preampBassDb', 'bass'), middleDb: n(0, 'preampMiddleDb', 'middle'), trebleDb: n(0, 'preampTrebleDb', 'treble'), levelDb: n(0, 'preampLevelDb', 'level') }); break;
    case 'SYNTH': slot.synthParameters = sanitizeSynthParameters({ sensitivity: n(50, 'synthSensitivity', 'sensitivity'), waveform: n(0, 'synthWaveform', 'waveform'), octave: n(0, 'synthOctave', 'octave'), tone: n(2000, 'synthToneHz', 'tone'), mix: n(50, 'synthMixPercent', 'mix') }); break;
    case 'G2B': slot.g2bParameters = sanitizeG2bParameters({ tracking: n(50, 'g2bTrackingPercent', 'tracking_percent'), blend: n(50, 'g2bBlendPercent', 'blend_percent'), body: n(200, 'g2bBodyHz', 'body_hz') }); break;
    case 'ROLL': slot.rollParameters = sanitizeRollParameters({ sliceBeats: n(0.25, 'rollSliceBeats', 'slice_beats'), decayPercent: n(100, 'rollDecayPercent', 'decay_percent'), pitchSemitones: n(0, 'rollPitchSemitones', 'pitch_semitones'), direction: n(0, 'rollDirection', 'direction') }); break;
    case 'FREEZE': slot.freezeParameters = sanitizeFreezeParameters({ captureLengthMs: n(500, 'freezeCaptureLengthMs', 'capture_ms'), pitchSemitones: n(0, 'freezePitchSemitones', 'pitch_semitones'), frozen: n(0, 'freezeEnabled', 'freeze') !== 0 }); break;
    case 'PITCH BEND': slot.pitchBendParameters = sanitizePitchBendParameters({ rangeSemitones: n(12, 'range'), timeMs: n(500, 'time_ms'), direction: n(0, 'direction'), mixPercent: n(100, 'mix_percent') }); break;
    case 'HRM MANUAL': slot.manualHarmonistParameters = sanitizeManualHarmonistParameters({ voice1Interval: n(0, 'voice_1_interval'), voice2Interval: n(0, 'voice_2_interval'), panPercent: n(0, 'pan_percent'), mixPercent: n(100, 'mix_percent') }); break;
    case 'OCTAVE': slot.octaveParameters = sanitizeOctaveParameters({ minus24Level: n(0, 'minus_24_level'), minus12Level: n(0, 'minus_12_level'), plus12Level: n(0, 'plus_12_level'), mixPercent: n(100, 'mix_percent') }); break;
    case 'VOCODER': slot.vocoderParameters = sanitizeVocoderParameters({ bands: n(16, 'vocoderBands', 'bands'), carrier: n(0, 'vocoderCarrier', 'carrier') as VocoderParameters['carrier'], mixPercent: n(100, 'mix') }); break;
    case 'OSC VOC (M)': slot.oscVocParameters = sanitizeOscVocParameters({ waveform: n(0, 'oscVocWaveform', 'waveform') as OscVocParameters['waveform'], midiChannel: n(1, 'oscVocMidiChannel', 'midi-channel'), octaveSemitones: n(0, 'oscVocOctave', 'octave'), mixPercent: n(70, 'mix') }); break;
    case 'AUTO RIFF': slot.autoRiffParameters = sanitizeAutoRiffParameters({ scale: n(0, 'scale'), rateBeats: n(0.5, 'rate_beats'), sensitivityPercent: n(55, 'sensitivity_percent'), mixPercent: n(65, 'mix_percent') }); break;
    case 'ROBOT': slot.robotParameters = sanitizeRobotFxParameters({ targetPitchSemitones: n(0, 'pitch', 'pitch_semitones'), formantShiftSemitones: n(0, 'formant', 'formant_semitones'), mixPercent: n(100, 'mix', 'mix_percent') }); break;
    case 'HRM AUTO (M)': slot.hrmAutoParameters = sanitizeHrmAutoParameters({ key: n(0, 'key') as HrmAutoParameters['key'], scale: n(0, 'scale') as HrmAutoParameters['scale'], midiChannel: n(1, 'midi-channel'), mixPercent: n(70, 'mix') }); break;
    case 'ELECTRIC': slot.electricParameters = sanitizeElectricParameters({ character: n(0, 'electricCharacter') as ElectricParameters['character'], pitchSnapPercent: n(0, 'electricPitchSnapPercent'), toneHz: n(2000, 'electricToneHz'), mixPercent: n(1, 'mix') * 100 }); break;
    case 'STEP SLICER': slot.stepSlicerParameters = sanitizeNativeStepSlicerParameters({
      step_count: n(16, 'stepSlicerStepCount'), rate_beats: n(0.25, 'stepSlicerRateBeats'), depth_percent: n(100, 'stepSlicerDepthPercent'),
      pan_depth_percent: n(0, 'stepSlicerPanDepthPercent'), filter_hz: n(20000, 'stepSlicerFilterHz'),
      ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => { const suffix = String(index + 1).padStart(2, '0'); return [`step_${suffix}`, n(100, `stepSlicerStep${suffix}`)]; })),
    }); break;
  }
  if (saved.amount === null) {
    slot.value = slot.preampParameters?.gainPercent ?? slot.synthParameters?.mix ?? slot.g2bParameters?.blend
      ?? (slot.pitchBendParameters ? slot.pitchBendParameters.rangeSemitones / 24 * 100
        : n(0, 'mix') * (slot.type === 'VOCODER' || slot.type.includes('(M)') ? 1 : 100));
  }
  return slot;
}

/** Hydrate mounted Browser editors from the successfully published Memory, without replaying DSP writes. */
export async function adoptCommittedBrowserFxState(configuration: BrowserMemoryConfiguration): Promise<void> {
  memoryHydrating += 1;
  try {
    adoptCommittedBrowserTrackFxState(configuration);
    ensureInitialized();
    state.inputSlots.splice(0, 4, ...configuration.fx.input.map(slotFromReadback));
    state.trackSlots.splice(0, 4, ...configuration.fx.sharedTrack.map(slotFromReadback));
    for (const slot of [...state.inputSlots, ...state.trackSlots]) adoptedControls.set(slot, adoptedSnapshot(slot));
    await nextTick();
    persistSlots();
  } finally { memoryHydrating -= 1; }
}

/** Hydrate seven Native banks only from acknowledged host snapshots. */
export async function adoptCommittedNativeFxState(): Promise<void> {
  const input = readConfirmedNativeFxUiBank('input'), shared = readConfirmedNativeFxUiBank('track');
  const privateBanks = Array.from({ length: 5 }, (_, index) => readConfirmedNativeFxUiBank('track', index + 1));
  const rows = (slots: typeof input) => slots.map((saved): FxSlotState => {
    const parameters = { ...saved.parameters };
    if (saved.type === 'VOCODER') parameters.mix = parameters.mix_percent ?? parameters.mix ?? 100;
    if (saved.type === 'ELECTRIC') Object.assign(parameters, { electricCharacter: parameters.character, electricPitchSnapPercent: parameters['pitch-snap'], electricToneHz: parameters.tone, mix: (parameters.mix ?? 100) / 100 });
    if (saved.type === 'STEP SLICER') {
      Object.assign(parameters, { stepSlicerStepCount: parameters.step_count, stepSlicerRateBeats: parameters.rate_beats, stepSlicerDepthPercent: parameters.depth_percent, stepSlicerPanDepthPercent: parameters.pan_depth_percent, stepSlicerFilterHz: parameters.filter_hz });
      for (let index = 1; index <= 16; index++) { const suffix = String(index).padStart(2, '0'); parameters[`stepSlicerStep${suffix}`] = parameters[`step_${suffix}`]!; }
    }
    const slot = slotFromReadback({ slot: saved.id, type: saved.type === NATIVE_CATALOG_EMPTY_LABEL ? null : saved.type,
      active: saved.active, amount: saved.value, parameters, parametersCaptured: true, requestedType: null, requestedActive: null, state: saved.type === NATIVE_CATALOG_EMPTY_LABEL ? 'empty' : 'ready', error: null });
    slot.type = saved.type; slot.namedParametersByType = saved.type === NATIVE_CATALOG_EMPTY_LABEL ? undefined : { [saved.type]: { ...saved.parameters } };
    return slot;
  });
  nativeMemoryHydrating += 1;
  try {
    pendingNativeNamedParameters.clear();
    await adoptCommittedNativeTrackFxState(privateBanks);
    ensureInitialized(); pendingNativeNamedParameters.clear();
    nativeFxState.inputSlots.splice(0, 4, ...rows(input)); nativeFxState.trackSlots.splice(0, 4, ...rows(shared));
    for (const slot of [...nativeFxState.inputSlots, ...nativeFxState.trackSlots]) adoptedControls.set(slot, adoptedSnapshot(slot));
    nativeStatusRevision.value += 1; await nextTick(); persistNativeFxSlots();
  } finally { nativeMemoryHydrating -= 1; }
}

function sanitizeValue(rawValue: number) {
  if (typeof rawValue !== 'number' || Number.isNaN(rawValue) || !Number.isFinite(rawValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, rawValue));
}

function syncSlotToEngine(location: FxLocation, index: number, slot: FxSlotState) {
  if (nativeMemoryHydrating && engine.getMode() === 'native') return;
  if (memoryHydrating && engine.getMode() === 'browser') return;
  const adopted = adoptedControls.get(slot);
  if (adopted?.type === slot.type) {
    const current = adoptedSnapshot(slot);
    if (current.value !== adopted.value) engine.setFxParam(location, index, sanitizeValue(current.value));
    const typedPatch = Object.fromEntries(Object.entries(current.typed).filter(([key, value]) => adopted.typed[key] !== value));
    const namedPatch = Object.fromEntries(Object.entries(current.named).filter(([key, value]) => adopted.named[key] !== value));
    if (Object.keys(typedPatch).length || Object.keys(namedPatch).length) engine.setCatalogFxParameters(location, index, { ...typedPatch, ...namedPatch });
    if (current.active !== adopted.active) engine.setFxActive(location, index, current.active);
    adoptedControls.set(slot, current);
    return;
  }
  adoptedControls.delete(slot);
  if (engine.getMode() === 'native') {
    const key = nativeNamedParameterKey(location, index);
    const pending = pendingNativeNamedParameters.get(key);
    if (pending && pending.effectId !== nativeCatalogEffectId(slot.type)) {
      pendingNativeNamedParameters.delete(key);
      nativeStatusRevision.value += 1;
    }
  }
  const isRobotSlot = isRobotFxType(slot.type);
  const isElectricSlot = slot.type === 'ELECTRIC';
  if (slot.type === 'PREAMP') {
    slot.preampParameters = sanitizePreampParameters(slot.preampParameters ?? createDefaultPreampParameters());
    slot.value = slot.preampParameters.gainPercent;
  }
  if (slot.type === 'SYNTH') {
    slot.synthParameters = sanitizeSynthParameters(slot.synthParameters ?? createDefaultSynthParameters());
    slot.value = slot.synthParameters.mix;
  }
  if (slot.type === 'G2B') {
    slot.g2bParameters = sanitizeG2bParameters(slot.g2bParameters ?? createDefaultG2bParameters());
    slot.value = slot.g2bParameters.blend;
  }
  if (slot.type === 'ROLL') {
    slot.rollParameters = sanitizeRollParameters(slot.rollParameters ?? createDefaultRollParameters());
  }
  if (slot.type === 'FREEZE') {
    slot.freezeParameters = sanitizeFreezeParameters(slot.freezeParameters ?? createDefaultFreezeParameters());
  }
  if (slot.type === 'PITCH BEND') {
    slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters ?? createDefaultPitchBendParameters());
    slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
  }
  if (slot.type === 'HRM MANUAL') {
    slot.manualHarmonistParameters = sanitizeManualHarmonistParameters(
      slot.manualHarmonistParameters ?? createDefaultManualHarmonistParameters(),
    );
    slot.value = slot.manualHarmonistParameters.mixPercent;
  }
  engine.setFxType(location, index, slot.type);
  // ROBOT and ELECTRIC accept only catalog-namespaced named controls; skip the
  // generic amount alias so it cannot be rejected by their runtime contracts.
  if (!isRobotSlot && !isElectricSlot) engine.setFxParam(location, index, sanitizeValue(slot.value));
  if (slot.type === 'PREAMP' && slot.preampParameters) {
    engine.setPreampParameters(location, index, slot.preampParameters);
  }
  if (slot.type === 'SYNTH' && slot.synthParameters) {
    engine.setCatalogFxParameters(location, index, { ...slot.synthParameters });
  }
  if (slot.type === 'G2B' && slot.g2bParameters) {
    engine.setCatalogFxParameters(location, index, toCatalogG2bParameters(slot.g2bParameters));
  }
  if (slot.type === 'ROLL' && slot.rollParameters) {
    engine.setCatalogFxParameters(location, index, toCatalogRollParameters(slot.rollParameters));
  }
  if (slot.type === 'FREEZE' && slot.freezeParameters) {
    engine.setCatalogFxParameters(location, index, toCatalogFreezeParameters(slot.freezeParameters));
  }
  if (slot.type === 'PITCH BEND' && slot.pitchBendParameters) {
    engine.setCatalogFxParameters(location, index, toCatalogPitchBendParameters(slot.pitchBendParameters));
  }
  if (slot.type === 'HRM MANUAL' && slot.manualHarmonistParameters) {
    engine.setCatalogFxParameters(location, index, toCatalogManualHarmonistParameters(slot.manualHarmonistParameters));
  }
  if (slot.type === 'OCTAVE') {
    slot.octaveParameters = sanitizeOctaveParameters(slot.octaveParameters ?? createDefaultOctaveParameters());
    slot.value = slot.octaveParameters.mixPercent;
    engine.setCatalogFxParameters(location, index, toCatalogOctaveParameters(slot.octaveParameters));
  }
  if (slot.type === 'VOCODER') {
    slot.vocoderParameters = sanitizeVocoderParameters(slot.vocoderParameters ?? createDefaultVocoderParameters());
    slot.value = slot.vocoderParameters.mixPercent;
    engine.setCatalogFxParameters(location, index, toCatalogVocoderParameters(slot.vocoderParameters));
  }
  if (slot.type === 'OSC VOC (M)') {
    slot.oscVocParameters = sanitizeOscVocParameters(slot.oscVocParameters ?? createDefaultOscVocParameters());
    slot.value = slot.oscVocParameters.mixPercent;
    engine.setCatalogFxParameters(location, index, toCatalogOscVocParameters(slot.oscVocParameters));
  }
  if (slot.type === 'AUTO RIFF' || slot.type === 'AUTO RIFF (EXPERIMENTAL)') {
    slot.autoRiffParameters = sanitizeAutoRiffParameters(slot.autoRiffParameters ?? createDefaultAutoRiffParameters());
    slot.value = slot.autoRiffParameters.mixPercent;
    engine.setCatalogFxParameters(location, index, toCatalogAutoRiffParameters(slot.autoRiffParameters));
  }
  if (isRobotSlot) {
    slot.robotParameters = sanitizeRobotFxParameters(slot.robotParameters ?? createDefaultRobotFxParameters());
    slot.value = slot.robotParameters.mixPercent;
    if (hasRobotRuntimeRoute(location, slot.type)) {
      engine.setCatalogFxParameters(location, index, toCatalogRobotParameters(slot.robotParameters));
    }
  }
  if (isHrmAutoFxType(slot.type)) {
    slot.hrmAutoParameters = sanitizeHrmAutoParameters(slot.hrmAutoParameters ?? createDefaultHrmAutoParameters());
    slot.value = slot.hrmAutoParameters.mixPercent;
    engine.setCatalogFxParameters(location, index, toCatalogHrmAutoParameters(slot.hrmAutoParameters));
  }
  if (isElectricSlot) {
    slot.electricParameters = sanitizeElectricParameters(slot.electricParameters ?? createDefaultElectricParameters());
    slot.value = slot.electricParameters.mixPercent;
    engine.setCatalogFxParameters(
      location,
      index,
      engine.getMode() === 'native'
        ? toNativeElectricParameters(slot.electricParameters)
        : toBrowserElectricParameters(slot.electricParameters),
    );
  }
  if (slot.type === 'STEP SLICER') {
    slot.stepSlicerParameters ??= createDefaultNativeStepSlicerParameters();
    engine.setNativeStepSlicerParameters(location, index, slot.stepSlicerParameters);
  }
  // Apply explicit Browser Input named overrides after the amount macro and
  // typed editor values, matching the Track-bank rule that authored named
  // controls win when both target the same DSP parameter.
  if (engine.getMode() === 'browser' && slot.type) {
    const named = slot.namedParametersByType?.[slot.type];
    if (named && Object.keys(named).length) engine.setCatalogFxParameters(location, index, named);
  }
  if (engine.getMode() === 'native' && slot.type) {
    const key = nativeNamedParameterKey(location, index);
    const pending = pendingNativeNamedParameters.get(key);
    if (pending && pending.effectId === nativeCatalogEffectId(slot.type)) {
      // A normal amount/active edit must not replay the persisted old controls
      // over a pending reset (including a host requiresRestart response).
      pending.expectedParameters = nativeNamedSubmission(location, index, pending.overrides, pending.removedKeys);
      engine.setCatalogFxParameters(location, index, { ...pending.expectedParameters });
    } else {
      if (pending) pendingNativeNamedParameters.delete(key);
      const named = nativeNamedOverridesForSync(location, slot.type, slot.namedParametersByType?.[slot.type], index);
      if (named && Object.keys(named).length) engine.setCatalogFxParameters(location, index, nativeNamedSubmission(location, index, named));
    }
  }
  // Install all named controls before enabling a one-shot effect. For PITCH
  // BEND the activation transition is itself the retrigger event.
  engine.setFxActive(location, index, slot.active);
}

function persistSlots() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    inputSlots: state.inputSlots.map((slot) => slot.freezeParameters
      ? { ...slot, freezeParameters: { ...slot.freezeParameters, frozen: false } }
      : slot),
    trackSlots: state.trackSlots.map((slot) => slot.freezeParameters
      ? { ...slot, freezeParameters: { ...slot.freezeParameters, frozen: false } }
      : slot),
  }));
}

function loadSlots() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return;
  }

  try {
    const parsed = JSON.parse(saved) as Partial<typeof state>;
    if (Array.isArray(parsed.inputSlots)) {
      state.inputSlots = parsed.inputSlots as FxSlotState[];
      state.inputSlots.forEach((slot, index) => {
        slot.namedParametersByType = sanitizeBrowserInputNamedPresets(slot.namedParametersByType, 'input', index);
        if (slot?.type === 'PREAMP') slot.preampParameters = sanitizePreampParameters(slot.preampParameters);
        if (slot?.type === 'SYNTH') slot.synthParameters = sanitizeSynthParameters(slot.synthParameters);
        if (slot?.type === 'G2B') slot.g2bParameters = sanitizeG2bParameters(slot.g2bParameters);
        if (slot?.type === 'ROLL') slot.rollParameters = sanitizeRollParameters(slot.rollParameters);
        if (slot?.type === 'FREEZE') slot.freezeParameters = { ...sanitizeFreezeParameters(slot.freezeParameters), frozen: false };
        if (slot?.type === 'PITCH BEND') slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters);
        if (slot?.type === 'HRM MANUAL') slot.manualHarmonistParameters = sanitizeManualHarmonistParameters(slot.manualHarmonistParameters);
        if (slot?.type === 'OCTAVE') slot.octaveParameters = sanitizeOctaveParameters(slot.octaveParameters);
        if (slot?.type === 'VOCODER') slot.vocoderParameters = sanitizeVocoderParameters(slot.vocoderParameters);
        if (slot?.type === 'OSC VOC (M)') slot.oscVocParameters = sanitizeOscVocParameters(slot.oscVocParameters);
        if (slot?.type === 'AUTO RIFF' || slot?.type === 'AUTO RIFF (EXPERIMENTAL)') {
          slot.autoRiffParameters = sanitizeAutoRiffParameters(slot.autoRiffParameters);
        }
        if (slot?.type && isRobotFxType(slot.type)) slot.robotParameters = sanitizeRobotFxParameters(slot.robotParameters);
        if (slot?.type && isHrmAutoFxType(slot.type)) {
          slot.hrmAutoParameters = sanitizeHrmAutoParameters(slot.hrmAutoParameters);
        }
        if (slot?.type === 'ELECTRIC') slot.electricParameters = sanitizeElectricParameters(slot.electricParameters);
      });
    }
    if (Array.isArray(parsed.trackSlots)) {
      state.trackSlots = parsed.trackSlots as FxSlotState[];
      state.trackSlots.forEach((slot, index) => {
        slot.namedParametersByType = sanitizeBrowserInputNamedPresets(slot.namedParametersByType, 'track', index);
        if (slot?.type === 'PREAMP') slot.preampParameters = sanitizePreampParameters(slot.preampParameters);
        if (slot?.type === 'SYNTH') slot.synthParameters = sanitizeSynthParameters(slot.synthParameters);
        if (slot?.type === 'G2B') slot.g2bParameters = sanitizeG2bParameters(slot.g2bParameters);
        if (slot?.type === 'ROLL') slot.rollParameters = sanitizeRollParameters(slot.rollParameters);
        if (slot?.type === 'FREEZE') slot.freezeParameters = { ...sanitizeFreezeParameters(slot.freezeParameters), frozen: false };
        if (slot?.type === 'PITCH BEND') slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters);
        if (slot?.type === 'HRM MANUAL') slot.manualHarmonistParameters = sanitizeManualHarmonistParameters(slot.manualHarmonistParameters);
        if (slot?.type === 'OCTAVE') slot.octaveParameters = sanitizeOctaveParameters(slot.octaveParameters);
        if (slot?.type === 'VOCODER') slot.vocoderParameters = sanitizeVocoderParameters(slot.vocoderParameters);
        if (slot?.type === 'OSC VOC (M)') slot.oscVocParameters = sanitizeOscVocParameters(slot.oscVocParameters);
        if (slot?.type === 'AUTO RIFF' || slot?.type === 'AUTO RIFF (EXPERIMENTAL)') {
          slot.autoRiffParameters = sanitizeAutoRiffParameters(slot.autoRiffParameters);
        }
        if (slot?.type && isRobotFxType(slot.type)) slot.robotParameters = sanitizeRobotFxParameters(slot.robotParameters);
        if (slot?.type && isHrmAutoFxType(slot.type)) {
          slot.hrmAutoParameters = sanitizeHrmAutoParameters(slot.hrmAutoParameters);
        }
        if (slot?.type === 'ELECTRIC') slot.electricParameters = sanitizeElectricParameters(slot.electricParameters);
      });
    }
  } catch (error) {
    console.error('Failed to load FX panel settings', error);
  }
}

function ensureInitialized() {
  if (initialized) {
    return;
  }

  initialized = true;
  ensureBrowserTrackFxStateInitialized();
  loadSlots();
  loadNativeFxSlots();
  if (engine.getMode() === 'browser') {
    if (!memoryHydrating) {
      state.inputSlots.forEach((slot, index) => syncSlotToEngine('input', index, slot));
      state.trackSlots.forEach((slot, index) => syncSlotToEngine('track', index, slot));
    }
  } else if (!nativeMemoryHydrating) {
    nativeFxState.inputSlots.forEach((slot, index) => syncSlotToEngine('input', index, slot));
    nativeFxState.trackSlots.forEach((slot, index) => syncSlotToEngine('track', index, slot));
  }

  const scope = effectScope(true);
  scope.run(() => {
    // A slot's previous active state belongs to its previous effect. Selecting
    // capture-based beat FX never opts it in implicitly; the user must press
    // the slot's activation button after choosing it.
    watch(() => state.trackSlots.map((slot) => slot.type), (newTypes, oldTypes) => {
      if (memoryHydrating) return;
      newTypes.forEach((type, index) => {
        if (oldTypes[index] === type) return;
        const slot = state.trackSlots[index];
        if (!slot) return;
        if (type === 'TRANSPOSE') slot.value = 50;
        if (type === 'PITCH BEND') {
          slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters ?? createDefaultPitchBendParameters());
          slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
          slot.active = false;
        }
        if (type === 'BEAT REPEAT' || type === 'BEAT SCATTER' || type === 'ROLL' || type === 'FREEZE') {
          slot.active = false;
          if (type === 'FREEZE') slot.freezeParameters = createDefaultFreezeParameters();
        }
      });
    });
    watch(() => state.inputSlots.map((slot) => slot.type), (newTypes, oldTypes) => {
      if (memoryHydrating) return;
      newTypes.forEach((type, index) => {
        if (oldTypes[index] === type) return;
        const slot = state.inputSlots[index];
        if (!slot) return;
        if (type === 'TRANSPOSE') slot.value = 50;
        if (type === 'PITCH BEND') {
          slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters ?? createDefaultPitchBendParameters());
          slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
          slot.active = false;
        }
        if (type === 'ROLL' || type === 'FREEZE') {
          slot.active = false;
          if (type === 'FREEZE') slot.freezeParameters = createDefaultFreezeParameters();
        }
      });
    });

    watch(() => nativeFxState.inputSlots.map((slot) => slot.type), (newTypes, oldTypes) => {
      if (nativeMemoryHydrating) return;
      newTypes.forEach((type, index) => {
        if (oldTypes[index] !== type && pendingNativeNamedParameters.delete(nativeNamedParameterKey('input', index))) nativeStatusRevision.value += 1;
        if ((type !== 'TRANSPOSE' && type !== 'PITCH BEND') || oldTypes[index] === type) return;
        const slot = nativeFxState.inputSlots[index];
        if (!slot) return;
        if (type === 'TRANSPOSE') slot.value = 50;
        if (type === 'PITCH BEND') {
          slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters ?? createDefaultPitchBendParameters());
          slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
          slot.active = false;
        }
      });
    });
    watch(() => nativeFxState.trackSlots.map((slot) => slot.type), (newTypes, oldTypes) => {
      if (nativeMemoryHydrating) return;
      newTypes.forEach((type, index) => {
        if (oldTypes[index] !== type && pendingNativeNamedParameters.delete(nativeNamedParameterKey('track', index))) nativeStatusRevision.value += 1;
        if ((type !== 'TRANSPOSE' && type !== 'PITCH BEND') || oldTypes[index] === type) return;
        const slot = nativeFxState.trackSlots[index];
        if (!slot) return;
        if (type === 'TRANSPOSE') slot.value = 50;
        if (type === 'PITCH BEND') {
          slot.pitchBendParameters = sanitizePitchBendParameters(slot.pitchBendParameters ?? createDefaultPitchBendParameters());
          slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
          slot.active = false;
        }
      });
    });

    // Snapshot the fields consumed by the FX factory. Deep watchers receive
    // the same object for oldValue/newValue after an in-place slot edit, so
    // comparing those object references misses type changes and leaves the
    // previous processor installed.
    const slotControlSnapshot = (slot: FxSlotState, includeNamedParameters = true) => [
      slot.type, slot.value, slot.active,
      JSON.stringify(typedControls(slot)),
      includeNamedParameters ? JSON.stringify(slot.namedParametersByType ?? {}) : '',
      slot.pitchBendParameters?.rangeSemitones ?? null,
      slot.pitchBendParameters?.timeMs ?? null,
      slot.pitchBendParameters?.direction ?? null,
      slot.pitchBendParameters?.mixPercent ?? null,
      slot.manualHarmonistParameters?.voice1Interval ?? null,
      slot.manualHarmonistParameters?.voice2Interval ?? null,
      slot.manualHarmonistParameters?.panPercent ?? null,
      slot.manualHarmonistParameters?.mixPercent ?? null,
      slot.octaveParameters?.minus24Level ?? null,
      slot.octaveParameters?.minus12Level ?? null,
      slot.octaveParameters?.plus12Level ?? null,
      slot.octaveParameters?.mixPercent ?? null,
      slot.vocoderParameters?.bands ?? null,
      slot.vocoderParameters?.carrier ?? null,
      slot.vocoderParameters?.mixPercent ?? null,
      slot.oscVocParameters?.waveform ?? null,
      slot.oscVocParameters?.midiChannel ?? null,
      slot.oscVocParameters?.octaveSemitones ?? null,
      slot.oscVocParameters?.mixPercent ?? null,
      slot.autoRiffParameters?.scale ?? null,
      slot.autoRiffParameters?.rateBeats ?? null,
      slot.autoRiffParameters?.sensitivityPercent ?? null,
      slot.autoRiffParameters?.mixPercent ?? null,
      slot.robotParameters?.targetPitchSemitones ?? null,
      slot.robotParameters?.formantShiftSemitones ?? null,
      slot.robotParameters?.mixPercent ?? null,
      slot.hrmAutoParameters?.key ?? null,
      slot.hrmAutoParameters?.scale ?? null,
      slot.hrmAutoParameters?.midiChannel ?? null,
      slot.hrmAutoParameters?.mixPercent ?? null,
      slot.electricParameters?.character ?? null,
      slot.electricParameters?.pitchSnapPercent ?? null,
      slot.electricParameters?.toneHz ?? null,
      slot.electricParameters?.mixPercent ?? null,
    ] as const;
    watch(() => state.inputSlots.map((slot) => slotControlSnapshot(slot)), (newValues, oldValues) => {
      if (engine.getMode() !== 'browser' || memoryHydrating) return;
      state.inputSlots.forEach((slot, index) => {
        const previous = oldValues?.[index];
        const current = newValues[index];
        if (previous && current && JSON.stringify(previous) === JSON.stringify(current)) return;
        syncSlotToEngine('input', index, slot);
      });
    });
    watch(() => state.inputSlots, persistSlots, { deep: true });

    watch(() => state.trackSlots.map((slot) => slotControlSnapshot(slot)), (newValues, oldValues) => {
      if (engine.getMode() !== 'browser' || memoryHydrating) return;
      state.trackSlots.forEach((slot, index) => {
        const previous = oldValues?.[index];
        const current = newValues[index];
        if (previous && current && JSON.stringify(previous) === JSON.stringify(current)) return;
        syncSlotToEngine('track', index, slot);
      });
    });
    watch(() => state.trackSlots, persistSlots, { deep: true });

    watch(() => nativeFxState.inputSlots.map((slot) => slotControlSnapshot(slot, false)), (newValues, oldValues) => {
      if (engine.getMode() !== 'native' || nativeMemoryHydrating) return;
      nativeFxState.inputSlots.forEach((slot, index) => {
        if (JSON.stringify(newValues[index]) === JSON.stringify(oldValues?.[index])) return;
        syncSlotToEngine('input', index, slot);
      });
    });
    watch(() => nativeFxState.inputSlots, persistNativeFxSlots, { deep: true });

    watch(() => nativeFxState.trackSlots.map((slot) => slotControlSnapshot(slot, false)), (newValues, oldValues) => {
      if (engine.getMode() !== 'native' || nativeMemoryHydrating) return;
      nativeFxState.trackSlots.forEach((slot, index) => {
        if (JSON.stringify(newValues[index]) === JSON.stringify(oldValues?.[index])) return;
        syncSlotToEngine('track', index, slot);
      });
    });
    watch(() => nativeFxState.trackSlots, persistNativeFxSlots, { deep: true });
  });
}

function sanitizeBrowserInputNamedPresets(raw: unknown, location: FxLocation = 'input', slotIndex = 0): Record<string, Record<string, number>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const presets: Record<string, Record<string, number>> = {};
  for (const [type, parameters] of Object.entries(raw as Record<string, unknown>)) {
    const controls = location === 'input' ? getBrowserInputFxControls(type, {}, slotIndex) : getBrowserTrackFxControls(type, {}, slotIndex, 'shared');
    // Effects with purpose-built Input editors keep their typed, validated
    // parameter models as the source of truth.
    if (!controls.length) continue;
    const sanitized = sanitizeBrowserTrackFxParameters(type, parameters);
    if (dedicatedInputEditorTypes.has(type)) {
      for (const key of Object.keys(sanitized)) if (!key.startsWith('official_')) delete sanitized[key];
    }
    if (Object.keys(sanitized).length) presets[type] = sanitized;
  }
  return Object.keys(presets).length ? presets : undefined;
}

function sanitizeNativeNamedPresets(raw: unknown): Record<string, Record<string, number>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const presets: Record<string, Record<string, number>> = {};
  for (const [type, rawParameters] of Object.entries(raw as Record<string, unknown>)) {
    if (!type || !rawParameters || typeof rawParameters !== 'object' || Array.isArray(rawParameters)) continue;
    const parameters: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawParameters as Record<string, unknown>)) {
      if (key && typeof value === 'number' && Number.isFinite(value)) parameters[key] = value;
    }
    if (Object.keys(parameters).length) presets[type] = parameters;
  }
  return Object.keys(presets).length ? presets : undefined;
}

function nativeNamedOverridesForSync(location: FxLocation, type: string, raw?: Record<string, number>, slotIndex = 0) {
  if (!raw || Object.keys(raw).length === 0) return null;
  const schema = engine.getNativeCatalogFxParameterSchema(type, location, 0, raw, slotIndex);
  if (!schema) return null;
  const descriptors = new Map([...schema.parameters, ...schema.legacyAliases].map((descriptor) => [descriptor.id, descriptor]));
  for (const [key, value] of Object.entries(raw)) {
    const descriptor = descriptors.get(key);
    if (!descriptor || !Number.isFinite(value) || value < descriptor.minimum || value > descriptor.maximum ||
        (descriptor.discrete && !descriptor.discreteValues?.includes(value))) return null;
  }
  return raw;
}

function parseNativeSlots(raw: unknown, target: FxSlotState[]) {
  if (!Array.isArray(raw)) return;
  for (let index = 0; index < Math.min(raw.length, target.length); index += 1) {
    const source = raw[index] as Partial<FxSlotState> | null;
    const slot = target[index];
    if (!source || !slot) continue;
    if (typeof source.type === 'string') slot.type = source.type;
    if (typeof source.value === 'number' && Number.isFinite(source.value)) slot.value = Math.max(0, Math.min(100, source.value));
    if (typeof source.active === 'boolean') slot.active = source.active;
    slot.namedParametersByType = sanitizeNativeNamedPresets(source.namedParametersByType);
    if (source.stepSlicerParameters !== undefined) {
      slot.stepSlicerParameters = sanitizeNativeStepSlicerParameters(source.stepSlicerParameters);
    }
    if (source.preampParameters !== undefined) {
      slot.preampParameters = sanitizePreampParameters(source.preampParameters);
    }
    if (source.synthParameters !== undefined) {
      slot.synthParameters = sanitizeSynthParameters(source.synthParameters);
    }
    if (source.g2bParameters !== undefined) {
      slot.g2bParameters = sanitizeG2bParameters(source.g2bParameters);
    }
    if (source.rollParameters !== undefined) {
      slot.rollParameters = sanitizeRollParameters(source.rollParameters);
    }
    if (source.freezeParameters !== undefined) {
      slot.freezeParameters = { ...sanitizeFreezeParameters(source.freezeParameters), frozen: false };
    }
    if (source.pitchBendParameters !== undefined) {
      slot.pitchBendParameters = sanitizePitchBendParameters(source.pitchBendParameters);
    }
    if (source.manualHarmonistParameters !== undefined) {
      slot.manualHarmonistParameters = sanitizeManualHarmonistParameters(source.manualHarmonistParameters);
    }
    if (source.octaveParameters !== undefined) {
      slot.octaveParameters = sanitizeOctaveParameters(source.octaveParameters);
    }
    if (source.vocoderParameters !== undefined) {
      slot.vocoderParameters = sanitizeVocoderParameters(source.vocoderParameters);
    }
    if (source.oscVocParameters !== undefined) {
      slot.oscVocParameters = sanitizeOscVocParameters(source.oscVocParameters);
    }
    if (source.autoRiffParameters !== undefined) {
      slot.autoRiffParameters = sanitizeAutoRiffParameters(source.autoRiffParameters);
    }
    if (source.robotParameters !== undefined) {
      slot.robotParameters = sanitizeRobotFxParameters(source.robotParameters);
    }
    if (source.hrmAutoParameters !== undefined) {
      slot.hrmAutoParameters = sanitizeHrmAutoParameters(source.hrmAutoParameters);
    }
    if (source.electricParameters !== undefined) {
      slot.electricParameters = sanitizeElectricParameters(source.electricParameters);
    }
  }
}

function loadNativeFxSlots() {
  try {
    const saved = localStorage.getItem(NATIVE_STORAGE_KEY);
    if (!saved) {
      migrateLegacyNativeSlot();
      return;
    }
    const parsed = JSON.parse(saved) as { inputSlots?: unknown; trackSlots?: unknown };
    parseNativeSlots(parsed.inputSlots, nativeFxState.inputSlots);
    parseNativeSlots(parsed.trackSlots, nativeFxState.trackSlots);
  } catch (error) {
    console.error('Failed to load Native catalog FX settings', error);
  }
}

function migrateLegacyNativeSlot() {
  const saved = localStorage.getItem(`${STORAGE_KEY}_native_track_fx`)
    ?? localStorage.getItem(`${STORAGE_KEY}_native_delay`);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved) as { type?: unknown; value?: unknown; active?: unknown };
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (type === 'DELAY' || type === 'DYNAMICS' || type === 'CHORUS') {
      nativeFxState.trackSlots[0]!.type = type;
    }
    if (typeof parsed.value === 'number' && Number.isFinite(parsed.value)) {
      nativeFxState.trackSlots[0]!.value = Math.max(0, Math.min(100, parsed.value));
    }
    if (typeof parsed.active === 'boolean') nativeFxState.trackSlots[0]!.active = parsed.active;
  } catch (error) {
    console.error('Failed to migrate Native catalog FX settings', error);
  }
}

function persistNativeFxSlots() {
  localStorage.setItem(NATIVE_STORAGE_KEY, JSON.stringify({
    inputSlots: nativeFxState.inputSlots.map((slot) => slot.freezeParameters
      ? { ...slot, freezeParameters: { ...slot.freezeParameters, frozen: false } }
      : slot),
    trackSlots: nativeFxState.trackSlots.map((slot) => slot.freezeParameters
      ? { ...slot, freezeParameters: { ...slot.freezeParameters, frozen: false } }
      : slot),
  }));
}

export function useFxPanelState(location: FxLocation) {
  ensureInitialized();

  const capabilities = computed(() => {
    nativeStatusRevision.value;
    return engine.getCapabilities();
  });
  const fxDisabled = computed(() => location === 'input'
    ? !capabilities.value.supportsInputFx
    : !capabilities.value.supportsTrackFx);
  const fxUnavailableReason = computed(() => {
    if (nativeTrackMode.value) {
      if (location === 'input' && !capabilities.value.supportsInputFx) return capabilities.value.fxReason;
      if (location === 'track' && !capabilities.value.supportsTrackFx) return capabilities.value.fxReason;
      return '';
    }
    return capabilities.value.fxReason;
  });
  const nativeTrackMode = computed(() => engine.getMode() === 'native');
  const slots = computed(() => nativeTrackMode.value
    ? location === 'input' ? nativeFxState.inputSlots : nativeFxState.trackSlots
    : location === 'input' ? state.inputSlots : state.trackSlots);
  const options = computed(() => {
    if (!nativeTrackMode.value) return browserFxOptionsFor(location);
    nativeStatusRevision.value;
    return [NATIVE_CATALOG_EMPTY_LABEL, ...engine.getNativeCatalogFxOptions(location)];
  });
  const activeSlot = computed(() => location === 'input'
    ? focus.state.activeInputFxSlot
    : focus.state.activeTrackFxSlot);
  const runtimeStatus = computed(() => {
    nativeStatusRevision.value;
    const slotIndex = slots.value.findIndex((slot) => slot.id === activeSlot.value);
    return nativeTrackMode.value && slotIndex >= 0
      ? engine.getNativeCatalogFxSlotStatus(location, slotIndex)
      : null;
  });
  const nativeNamedParametersPending = computed(() => {
    nativeStatusRevision.value;
    const slotIndex = slots.value.findIndex((slot) => slot.id === activeSlot.value);
    return slotIndex >= 0 && pendingNativeNamedParameters.has(nativeNamedParameterKey(location, slotIndex));
  });

  const selectSlot = (slotId: FxSlotId) => {
    focus.setActiveFxSlot(location, slotId);
  };

  function setNativeNamedParameters(slotIndex: number, parameters: Record<string, number>): boolean {
    if (engine.getMode() !== 'native' || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 4 ||
        !parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
        Object.entries(parameters).some(([key, value]) => !key || !Number.isFinite(value))) return false;
    const slot = slots.value[slotIndex];
    if (!slot || !slot.type) return false;
    const effectId = nativeCatalogEffectId(slot.type);
    const schema = engine.getNativeCatalogFxParameterSchema(slot.type, location, 0, parameters, slotIndex);
    const pendingKey = nativeNamedParameterKey(location, slotIndex);
    if (!effectId || !schema || pendingNativeNamedParameters.has(pendingKey)) return false;
    const descriptors = new Map([...schema.parameters, ...schema.legacyAliases].map((descriptor) => [descriptor.id, descriptor]));
    for (const [key, value] of Object.entries(parameters)) {
      const descriptor = descriptors.get(key);
      if (!descriptor || value < descriptor.minimum || value > descriptor.maximum ||
          (descriptor.discrete && !descriptor.discreteValues?.includes(value))) return false;
    }
    const runtime = engine.getNativeCatalogFxSlotStatus(location, slotIndex);
    if (!runtime) return false;
    const effectiveOverrides = adoptedControls.has(slot) && Object.keys(parameters).length
      ? { ...slot.namedParametersByType?.[slot.type], ...parameters } : parameters;
    const removedKeys = Object.keys(slot.namedParametersByType?.[slot.type] ?? {})
      .filter(key => !Object.prototype.hasOwnProperty.call(effectiveOverrides, key));
    const expectedParameters = nativeNamedSubmission(location, slotIndex, effectiveOverrides, removedKeys);
    pendingNativeNamedParameters.set(pendingKey, {
      location,
      slotIndex,
      effectId,
      overrides: { ...effectiveOverrides },
      expectedParameters,
      previousRevision: runtime.requestedRevision,
      removedKeys,
    });
    engine.setCatalogFxParameters(location, slotIndex, { ...expectedParameters });
    reconcileNativeNamedParameters();
    nativeStatusRevision.value += 1;
    return true;
  }

  return {
    slots,
    fxOptions: options,
    fxDisabled,
    fxUnavailableReason,
    runtimeStatus,
    activeSlot,
    selectSlot,
    setNativeNamedParameters,
    nativeNamedParametersPending,
  };
}
