import { isOfficialFxSlotAllowed } from './fx/official/parameters';
import { BROWSER_OFFICIAL_PARAMETER_KEYS as BROWSER_OFFICIAL_STREAM_KEYS } from './fx/dsp/OfficialBrowserParameters';
import { findOfficialRuntimeParameter, resolveOfficialEffect, isOfficialRuntimeValueValid } from './fx/official/parameters';
import { BROWSER_OFFICIAL_PARAMETER_KEYS } from './fx/official/browserBindings';
import { BROWSER_WORKLET_FX_TYPES, BrowserWorkletFX, type BrowserWorkletFxName, type BrowserVocoderCarrierSource } from './fx/BrowserWorkletFX';
import { BrowserPitchBendFX } from './fx/BrowserPitchBendFX';
import { BrowserRobotFX } from './fx/BrowserRobotFX';
import { BrowserTransposeFX } from './fx/BrowserTransposeFX';
import { BrowserManualHarmonistFX } from './fx/BrowserManualHarmonistFX';
import { BrowserOctaveFX } from './fx/BrowserOctaveFX';
import { BrowserAutoRiffFX } from './fx/BrowserAutoRiffFX';
import { BrowserHrmAutoFX } from './fx/BrowserHrmAutoFX';
import { fxCatalogIdForDisplayLabel } from './fx/fxTypeIdentity';
import { SIGNALSMITH_LIVE_WASM_BUDGET_BYTES, signalsmithLiveWasmSnapshot } from './pitch/signalsmithWasmBudget';
import { copyRecoveryFxParameters, type BrowserRecoveryFxSlot } from './BrowserRecoverySnapshot';

/** These need source-reader or external MIDI/host adapters, not a serial stream insert. */
export const BROWSER_PER_TRACK_FX_UNSUPPORTED = {
  'BEAT SHIFT': 'BEAT SHIFT is not an A–D insert; use the separate experimental per-loop source-transport route (currently controlled from the legacy bank).',
  'VINYL FLICK': 'VINYL FLICK is not an A–D insert; use the separate experimental per-loop source-transport route (currently controlled from the legacy bank).',
} as const;

/** Executable adapters only. This list is the UI/runtime coverage matrix, not catalog metadata. */
export const BROWSER_PER_TRACK_FX_TYPES: readonly string[] = Object.freeze([
  ...Object.keys(BROWSER_WORKLET_FX_TYPES).filter((type) => !(type in BROWSER_PER_TRACK_FX_UNSUPPORTED)),
  'TRANSPOSE',
  'PITCH BEND',
  'ROBOT',
  'HRM MANUAL',
  'OCTAVE',
  'AUTO RIFF',
  'HRM AUTO (M)',
  'OSC VOC (M)',
  'REVERSE REVERB (EXPERIMENTAL)',
]);

const TEMPO_ALGORITHMS = new Set(['beat-repeat', 'beat-scatter', 'roll', 'warp', 'reverse-delay', 'reverse-reverb', 'pattern-slicer', 'step-slicer', 'isolator', 'osc-bot', 'auto-riff']);

/** Internal host clock metadata is restorable without becoming a user FX knob.
 * null means this is not a clock key; false means the key/value is invalid. */
export function validateBrowserFxHostClockParameter(algorithm: string, key: string, value: number): boolean | null {
  if (key !== 'bpm' && key !== 'quarterNotesPerMeasure') return null;
  if (!Number.isFinite(value)) return false;
  const supported = key === 'bpm'
    ? TEMPO_ALGORITHMS.has(algorithm) || !!BROWSER_OFFICIAL_STREAM_KEYS[algorithm]
    : algorithm === 'auto-riff' || !!BROWSER_OFFICIAL_STREAM_KEYS[algorithm];
  return supported && (key === 'bpm' ? value >= 40 && value <= 300 : value >= 0.125 && value <= 128);
}

/** Canonical snapshot fields accepted internally, separate from published controls. */
export function validateBrowserFxInternalParameter(algorithm: string, key: string, value: number): boolean | null {
  const clockValid = validateBrowserFxHostClockParameter(algorithm, key, value);
  if (clockValid !== null) return clockValid;
  if (algorithm !== 'osc-voc') return null;
  switch (key) {
    case 'oscVocWaveform': return Number.isInteger(value) && value >= 0 && value <= 2;
    case 'oscVocMidiChannel': return Number.isInteger(value) && value >= 1 && value <= 16;
    case 'oscVocOctave': return Number.isFinite(value) && value >= -24 && value <= 24;
    case 'oscVocBands': return Number.isInteger(value) && value >= 8 && value <= 24;
    default: return null;
  }
}

/** Canonical numeric controls admitted on this bounded insert path. Unknown controls fail explicitly. */
const LEGACY_PER_TRACK_PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = {
  lpf: ['cutoffHz', 'q', 'filterResonancePercent', 'mix'], bpf: ['cutoffHz', 'q', 'mix'], hpf: ['cutoffHz', 'q', 'filterResonancePercent', 'mix'],
  flanger: ['flangerDelayMs', 'flangerRateHz', 'flangerDepth', 'flangerFeedback', 'mix'],
  'ring-mod': ['ringModHz', 'ringModDepth', 'ringModWaveform', 'mix'],
  reverb: ['decaySeconds', 'dampingHz', 'mix'],
  'gate-reverb': ['decaySeconds', 'dampingHz', 'gateThresholdDb', 'gateHoldMs', 'gateReleaseMs', 'mix'],
  distortion: ['driveDb', 'outputDb', 'mix'],
  dynamics: ['thresholdDb', 'ratio', 'kneeDb', 'attackMs', 'releaseMs', 'outputDb', 'mix'],
  sustainer: ['thresholdDb', 'ratio', 'releaseMs', 'outputDb', 'mix'],
  delay: ['delayTimeMs', 'delayFeedback', 'delayToneHz', 'mix'],
  'panning-delay': ['panningDelayTimeMs', 'panningDelayFeedback', 'panningDelayPan', 'mix'],
  'mod-delay': ['modDelayTimeMs', 'modDelayRateHz', 'modDelayDepthMs', 'modDelayFeedbackPercent', 'mix'],
  chorus: ['chorusDelayMs', 'chorusRateHz', 'chorusDepthMs', 'chorusVoices', 'chorusFeedback', 'chorusToneHz', 'mix'],
  phaser: ['phaserRateHz', 'phaserDepth', 'phaserFeedback', 'phaserStages', 'mix'],
  tremolo: ['tremoloRateHz', 'tremoloDepth', 'mix'], 'auto-pan': ['autoPanRateHz', 'autoPanDepth', 'mix'],
  'beat-repeat': ['bpm', 'division', 'decay', 'direction', 'mix'],
  'beat-scatter': ['bpm', 'beatScatterSliceBeats', 'beatScatterScatterPercent', 'beatScatterPitchSemitones', 'beatScatterRepeats', 'mix'],
  roll: ['bpm', 'rollSliceBeats', 'rollDecayPercent', 'rollPitchSemitones', 'rollDirection', 'mix'],
  freeze: ['freezeCaptureLengthMs', 'freezePitchSemitones', 'freezeEnabled', 'freezeMode', 'mix'],
  warp: ['bpm', 'warpCaptureBeats', 'warpSmearPercent', 'warpPitchSemitones', 'warpFeedbackPercent', 'warpFreezeEnabled', 'mix'],
  'reverse-delay': ['bpm', 'reverseDelaySegmentBeats', 'reverseDelayFeedback', 'reverseDelayCrossfadeMs', 'mix'],
  'reverse-reverb': ['bpm', 'reverseReverbSegmentBeats', 'reverseReverbFeedbackPercent', 'reverseReverbCrossfadeMs', 'reverseReverbDecaySeconds', 'reverseReverbDampingCutoffHz', 'mix'],
  'pattern-slicer': ['bpm', 'patternSlicerPattern', 'patternSlicerRateBeats', 'patternSlicerDepthPercent', 'patternSlicerEdgeMs', 'mix'],
  'step-slicer': ['bpm', 'stepSlicerStepCount', 'stepSlicerRateBeats', 'stepSlicerDepthPercent', 'stepSlicerPanDepthPercent', 'stepSlicerFilterHz', 'mix', ...Array.from({ length: 16 }, (_, index) => `stepSlicerStep${String(index + 1).padStart(2, '0')}`)],
  'stereo-enhance': ['stereoWidth', 'stereoLowMonoCutoffHz', 'stereoDecorrelation', 'mix'],
  'lo-fi': ['loFiBitDepth', 'loFiSampleRateHz', 'loFiFilterHz', 'mix'],
  eq: ['eqLowFrequencyHz', 'eqLowGainDb', 'eqMid1FrequencyHz', 'eqMid1Q', 'eqMid1GainDb', 'eqMid2FrequencyHz', 'eqMid2Q', 'eqMid2GainDb', 'eqHighFrequencyHz', 'eqHighGainDb', 'mix'],
  'manual-pan': ['manualPanPosition', 'mix'],
  'tape-echo': ['tapeEchoTimeMs', 'tapeEchoFeedback', 'tapeEchoWow', 'tapeEchoSaturation', 'tapeEchoToneHz', 'mix'],
  twist: ['twistAmount', 'twistTrajectory', 'mix'],
  'granular-delay': ['granularGrainSizeMs', 'granularDensityHz', 'granularPitchSemitones', 'granularPositionJitterPercent', 'granularFeedbackPercent', 'mix'],
  radio: ['radioBand', 'radioDrive', 'radioNoise', 'mix'],
  vibrato: ['vibratoRateHz', 'vibratoDepthPercent', 'vibratoDelayMs', 'mix'],
  'slow-gear': ['slowGearAttackMs', 'slowGearSensitivityPercent', 'mix'],
  isolator: ['bpm', 'isolatorLowGainDb', 'isolatorMidGainDb', 'isolatorHighGainDb', 'isolatorGateRateBeats', 'isolatorGateDepthPercent', 'mix'],
  preamp: ['preampModel', 'preampGainPercent', 'preampBassDb', 'preampMiddleDb', 'preampTrebleDb', 'preampLevelDb'],
  synth: ['synthSensitivity', 'synthWaveform', 'synthOctave', 'synthToneHz', 'synthMixPercent'],
  g2b: ['g2bTrackingPercent', 'g2bBlendPercent', 'g2bBodyHz'],
  vocoder: ['vocoderBands', 'vocoderCarrier', 'mix'],
  electric: ['electricCharacter', 'electricPitchSnapPercent', 'electricToneHz', 'mix'],
  'osc-bot': ['oscBotWaveform', 'oscBotPattern', 'oscBotToneHz', 'bpm', 'mix'],
  transpose: ['shift', 'mix'],
  'pitch-bend': ['range', 'time_ms', 'direction', 'mix_percent'],
  robot: ['pitch', 'formant', 'mix'],
  'hrm-manual': ['voice_1_interval', 'voice_2_interval', 'pan_percent', 'mix_percent'],
  octave: ['minus_24_level', 'minus_12_level', 'plus_12_level', 'mix_percent'],
  'auto-riff': ['scale', 'rate_beats', 'sensitivity_percent', 'mix_percent'],
  'hrm-auto': ['key', 'scale', 'midi-channel', 'mix'],
  'osc-voc': ['waveform', 'midi-channel', 'octave', 'mix'],
};

export const BROWSER_PER_TRACK_PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(LEGACY_PER_TRACK_PARAMETER_KEYS).map(([algorithm, legacy]) => [algorithm, [...legacy, ...(BROWSER_OFFICIAL_PARAMETER_KEYS[algorithm] ?? [])]]),
);

export interface BrowserTrackFxSlotStatus {
  readonly slotIndex: number;
  readonly slot: 'A' | 'B' | 'C' | 'D';
  readonly type: string | null;
  readonly active: boolean;
  readonly bypassed: boolean;
  readonly state: 'empty' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly warning: string | null;
  readonly resourceNote: string | null;
  readonly pendingApply: boolean;
  readonly requestedEffectId: string | null;
  readonly acknowledgedEffectId: string | null;
}

export interface BrowserTrackFxStatus {
  readonly trackId: number;
  readonly available: true;
  readonly routeMode: 'per-track-pre-mix';
  readonly perTrackFxChainAvailable: true;
  readonly legacySharedPostmix: true;
  readonly slots: readonly BrowserTrackFxSlotStatus[];
}

type TrackFxEffect = BrowserWorkletFX | BrowserPitchBendFX | BrowserRobotFX | BrowserTransposeFX | BrowserManualHarmonistFX | BrowserOctaveFX | BrowserAutoRiffFX | BrowserHrmAutoFX;

interface PendingReplacement {
  readonly generation: number;
  readonly type: string;
  readonly effect: TrackFxEffect;
  active: boolean;
  amount: number | null;
  namedParameters: Record<string, number>;
  cancel: () => void;
}

interface Slot {
  type: string | null;
  effect: TrackFxEffect | null;
  active: boolean;
  error: string | null;
  warning: string | null;
  generation: number;
  pending: PendingReplacement | null;
  amount: number | null;
  namedParameters: Record<string, number>;
}

const emptySlot = (): Slot => ({ type: null, effect: null, active: false, error: null, warning: null, generation: 0, pending: null, amount: null, namedParameters: {} });
const READY_TIMEOUT_MS = 10_000;
const experimentalSuffix = ' (EXPERIMENTAL)';

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
}

const SIGNALSMITH_FX_TYPES = new Set([
  'TRANSPOSE', 'PITCH BEND', 'ROBOT', 'HRM MANUAL', 'OCTAVE', 'AUTO RIFF',
  'AUTO RIFF (EXPERIMENTAL)', 'HRM AUTO (M)',
]);
const canonicalType = (type: string): string => type.endsWith(experimentalSuffix)
  ? type.slice(0, -experimentalSuffix.length)
  : type;
const sameType = (left: string | null, right: string): boolean => left !== null
  && canonicalType(left) === canonicalType(right);
const SIGNALSMITH_BACKED_TYPES = new Set(['TRANSPOSE', 'PITCH BEND', 'ROBOT', 'HRM MANUAL', 'OCTAVE', 'AUTO RIFF', 'HRM AUTO (M)']);

/** One real stereo A → B → C → D chain. No processor instance is shared by tracks. */
export class BrowserTrackFxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onChange: () => void;
  private readonly getBpm: () => number;
  private readonly getQuarterNotesPerMeasure: () => number;
  private readonly getVocoderCarrierSource?: BrowserVocoderCarrierSource;
  private readonly legacyVocoderMixPercent: boolean;
  private readonly slots: Slot[] = Array.from({ length: 4 }, emptySlot);

  constructor(
    context: AudioContext,
    ensureModule: () => Promise<void>,
    onChange: () => void = () => {},
    getBpm: () => number = () => 120,
    getQuarterNotesPerMeasure: () => number = () => 4,
    getVocoderCarrierSource?: BrowserVocoderCarrierSource,
    options: { legacyVocoderMixPercent?: boolean } = {},
  ) {
    this.context = context;
    this.ensureModule = ensureModule;
    this.onChange = onChange;
    this.getBpm = getBpm;
    this.getQuarterNotesPerMeasure = getQuarterNotesPerMeasure;
    this.getVocoderCarrierSource = getVocoderCarrierSource;
    this.legacyVocoderMixPercent = options.legacyVocoderMixPercent === true;
    this.input = context.createGain();
    this.output = context.createGain();
    this.input.connect(this.output);
  }

  setType(slotIndex: number, rawType: string): boolean {
    const slot = this.slot(slotIndex);
    if (!slot || typeof rawType !== 'string') return false;
    const type = rawType.trim().toUpperCase();
    if (slot.pending && sameType(slot.pending.type, type)) return true;
    if (sameType(slot.type, type) && slot.effect && !slot.error && !slot.effect.error) {
      if (slot.type !== type) {
        slot.type = type;
        this.onChange();
      }
      if (slot.pending) {
        slot.pending.cancel();
        slot.pending = null;
        slot.generation += 1;
        slot.warning = null;
        this.onChange();
      }
      return true;
    }
    if (!type || type === 'NONE') {
      this.replace(slotIndex, null, null, null);
      return true;
    }
    const unsupported = BROWSER_PER_TRACK_FX_UNSUPPORTED[type as keyof typeof BROWSER_PER_TRACK_FX_UNSUPPORTED];
    const factoryType = canonicalType(type);
    const catalogId = fxCatalogIdForDisplayLabel(type);
    if (!BROWSER_PER_TRACK_FX_TYPES.includes(factoryType) && factoryType !== 'AUTO RIFF') {
      const message = unsupported ?? `Unsupported Browser per-track FX type: ${type}. No shared-bank fallback was applied.`;
      if (slot.effect) {
        slot.warning = `${message} The current ${slot.type} effect was kept.`;
        this.onChange();
      } else {
        this.replace(slotIndex, type, null, message);
      }
      return false;
    }
    // A failed same-type processor requires an explicit clear before retrying;
    // this is a UX guard, separate from the context-wide admission ledger.
    if (SIGNALSMITH_BACKED_TYPES.has(canonicalType(type)) && sameType(slot.type, type) && slot.effect) {
      slot.warning = `${type} could not be retried while its previous processor is resident; clear it before retrying. The WASM reservation remains charged until disposal acknowledgement or context close.`;
      this.onChange();
      return false;
    }
    if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      const message = 'AudioWorklet is unavailable; this per-track slot is bypassed.';
      if (slot.effect) {
        slot.warning = `${message} The current ${slot.type} effect was kept.`;
        this.onChange();
      } else {
        this.replace(slotIndex, type, null, message);
      }
      return false;
    }
    let effect: TrackFxEffect;
    const onFailure = (error: Error) => {
      const current = this.slots[slotIndex];
      if (current?.pending?.effect === effect) {
        this.onChange();
        return;
      }
      if (current?.effect !== effect) return;
      current.error = error.message;
      current.active = false;
      effect.setBypass(true);
      this.onChange();
    };
    if (catalogId === 'robot') {
      effect = new BrowserRobotFX(this.context, this.ensureModule, onFailure);
    } else if (catalogId === 'hrm-auto-m') {
      effect = new BrowserHrmAutoFX(this.context, this.ensureModule, onFailure);
    } else {
      switch (factoryType) {
      case 'TRANSPOSE': effect = new BrowserTransposeFX(this.context, onFailure); break;
      case 'PITCH BEND': effect = new BrowserPitchBendFX(this.context, onFailure); break;
      case 'HRM MANUAL': effect = new BrowserManualHarmonistFX(this.context, onFailure); break;
      case 'OCTAVE': effect = new BrowserOctaveFX(this.context, onFailure); break;
      case 'AUTO RIFF': effect = new BrowserAutoRiffFX(this.context, this.ensureModule, onFailure); effect.setParam('bpm', this.getBpm()); effect.setParam('quarterNotesPerMeasure', this.getQuarterNotesPerMeasure()); break;
      default: {
        const workletType = (factoryType === 'REVERSE REVERB' ? 'REVERSE REVERB' : factoryType) as BrowserWorkletFxName;
        effect = new BrowserWorkletFX(
          this.context,
          workletType,
          this.ensureModule,
          onFailure,
          (TEMPO_ALGORITHMS.has(BROWSER_WORKLET_FX_TYPES[workletType]) || !!BROWSER_OFFICIAL_PARAMETER_KEYS[BROWSER_WORKLET_FX_TYPES[workletType]]) ? { bpm: this.getBpm(), ...(this.getQuarterNotesPerMeasure() !== 4 ? { quarterNotesPerMeasure: this.getQuarterNotesPerMeasure() } : {}) } : {},
          { getVocoderCarrierSource: this.getVocoderCarrierSource, legacyVocoderMixPercent: this.legacyVocoderMixPercent },
        );
      }
      }
    }
    effect.setBypass(true);
    if (slot.pending) {
      slot.pending.cancel();
      slot.pending = null;
    }
    const generation = ++slot.generation;
    const pending: PendingReplacement = { generation, type, effect, active: false, amount: null, namedParameters: {}, cancel: () => {} };
    slot.pending = pending;
    slot.warning = null;
    this.onChange();

    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const current = this.slots[slotIndex];
      if (!current || current.pending?.generation !== generation || current.pending.effect !== effect) {
        effect.dispose();
        return;
      }
      this.rejectCandidate(current, pending, message);
    };
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const current = this.slots[slotIndex];
      if (!current || current.pending?.generation !== generation || current.pending.effect !== effect) {
        effect.dispose();
        return;
      }
      if (timedOut) {
        this.rejectCandidate(current, pending, `FX adapter readiness timed out after ${READY_TIMEOUT_MS} ms.`);
        return;
      }
      if (effect.error || !effect.processorReady) {
        this.rejectCandidate(current, pending, effect.error || `Browser ${type} adapter did not become ready.`);
        return;
      }
      current.pending = null;
      this.replace(slotIndex, type, effect, null, pending.active, pending.amount, pending.namedParameters);
    };
    timeout = setTimeout(() => finish(true), READY_TIMEOUT_MS);
    pending.cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      effect.dispose();
    };
    void effect.ready.then(() => finish(false), (cause: unknown) => fail(cause instanceof Error ? cause.message : String(cause)));
    return true;
  }

  setParameter(slotIndex: number, value: number): boolean {
    const slot = this.slot(slotIndex);
    const effect = slot?.pending?.effect ?? slot?.effect;
    if (!slot || !effect || (slot.error && !slot.pending) || !Number.isFinite(value)) return false;
    const amount = Math.max(0, Math.min(100, value));
    if (effect instanceof BrowserTransposeFX) effect.setParam('shift', (amount / 100 * 48) - 24);
    else if (effect instanceof BrowserPitchBendFX) effect.setAmount(amount / 100);
    else if (effect instanceof BrowserRobotFX) effect.setAmount(amount / 100);
    else if (effect instanceof BrowserManualHarmonistFX) effect.setAmount(amount / 100);
    else if (effect instanceof BrowserOctaveFX) effect.setAmount(amount / 100);
    else if (effect instanceof BrowserHrmAutoFX) effect.setParam('mix', amount);
    else if (effect.algorithm === 'electric') effect.setParam('mix', amount / 100);
    else effect.setAmount(amount / 100);
    if (slot.pending) slot.pending.amount = amount;
    else slot.amount = amount;
    // Explicit official controls remain authoritative over the legacy macro.
    for (const [key, authored] of Object.entries(effect.getParameterSnapshot?.() ?? slot.pending?.namedParameters ?? slot.namedParameters)) {
      if (key.startsWith('official_') && typeof authored === 'number') effect.setParam(key, authored);
    }
    return !effect.error;
  }

  /** Canonical numeric BrowserFxParameters only; no data is sent to another track. */
  setNamedParameters(slotIndex: number, parameters: Readonly<Record<string, number>>): boolean {
    const slot = this.slot(slotIndex);
    const effect = slot?.pending?.effect ?? slot?.effect;
    if (!slot || !effect || (slot.error && !slot.pending) || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    const entries = Object.entries(parameters).sort(([a], [b]) => Number(b === 'official_variant') - Number(a === 'official_variant'));
    const admitted = BROWSER_PER_TRACK_PARAMETER_KEYS[effect.algorithm] ?? [];
    if (entries.some(([key]) => key.startsWith('official_')) && !isOfficialFxSlotAllowed(slot.pending?.type ?? slot.type ?? '', 'track', slotIndex)) return false;
    const officialEffect = resolveOfficialEffect(slot.pending?.type ?? slot.type ?? '', { ...(slot.pending?.namedParameters ?? slot.namedParameters), ...parameters });
    const invalid = entries.find(([key, value]) => {
      const internalValid = validateBrowserFxInternalParameter(effect.algorithm, key, value);
      if (internalValid !== null) return !internalValid;
      if (!admitted.includes(key) || !Number.isFinite(value)) return true;
      if (effect.algorithm === 'vocoder' && key === 'official_carrier' && (value < 6 || value > 10 || !Number.isInteger(value))) return true;
      if (key === 'official_variant') return value !== 1 && value !== 2;
      if (key === 'official_step_index') return !Number.isInteger(value) || value < 1 || value > 16;
      if (!key.startsWith('official_')) return false;
      const parameter = findOfficialRuntimeParameter(officialEffect, key);
      return !parameter || !isOfficialRuntimeValueValid(parameter, value);
    });
    if (invalid) {
      const message = `Unsupported or non-finite ${slot.pending?.type ?? slot.type} per-track parameter: ${invalid[0]}. Slot bypassed.`;
      if (slot.pending) slot.pending.effect.setBypass(true);
      else {
        slot.error = message;
        slot.active = false;
        effect.setBypass(true);
      }
      this.onChange();
      return false;
    }
    for (const [key, value] of entries) effect.setParam(key, value);
    const authored = slot.pending ? slot.pending.namedParameters : slot.namedParameters;
    if (parameters.official_variant !== undefined && parameters.official_variant !== authored.official_variant) {
      for (const key of Object.keys(authored)) if (key.startsWith('official_')) delete authored[key];
    }
    for (const [key, value] of entries) authored[key] = value;
    for (const [key, value] of Object.entries(effect.getParameterSnapshot?.() ?? authored)) {
      if (key.startsWith('official_') && typeof value === 'number') effect.setParam(key, value);
    }
    return !effect.error;
  }

  setActive(slotIndex: number, active: boolean): boolean {
    const slot = this.slot(slotIndex);
    const effect = slot?.pending?.effect ?? slot?.effect;
    if (!slot || !effect || (slot.error && !slot.pending) || effect.error || typeof active !== 'boolean') return false;
    if (slot.pending) slot.pending.active = active;
    else slot.active = active;
    effect.setBypass(!active);
    this.onChange();
    return true;
  }

  /** Send one frame-stamped MIDI event to exactly this private track slot. */
  sendMidiNote(
    slotIndex: number,
    event: { channel: number; note: number; velocity: number; noteOn: boolean; frame: number; timeStampMs?: number },
  ): boolean {
    const effect = this.slot(slotIndex)?.effect;
    if (effect instanceof BrowserHrmAutoFX && !effect.error) {
      return effect.sendMidiNote({ ...event, velocity: Math.max(0, Math.min(127, event.velocity)) / 127, timeStampMs: event.timeStampMs ?? 0 });
    }
    if (!(effect instanceof BrowserWorkletFX) || effect.algorithm !== 'osc-voc' || effect.error) return false;
    return effect.sendMidiNote(event);
  }

  /** Release keys owned by this private slot before a target switch or replacement. */
  clearMidiNotes(slotIndex: number, frame: number): boolean {
    const effect = this.slot(slotIndex)?.effect;
    if (effect instanceof BrowserHrmAutoFX) {
      effect.clearMidiState();
      return true;
    }
    if (!(effect instanceof BrowserWorkletFX) || effect.algorithm !== 'osc-voc') return false;
    return effect.clearMidiNotes(frame);
  }

  canReceiveMidiNotes(slotIndex: number, effectId: 'osc_voc_m' | 'hrm_auto_m' = 'osc_voc_m'): boolean {
    const effect = this.slot(slotIndex)?.effect;
    if (effectId === 'hrm_auto_m') {
      return effect instanceof BrowserHrmAutoFX && effect.processorReady && !effect.error;
    }
    return effect instanceof BrowserWorkletFX && effect.algorithm === 'osc-voc'
      && effect.processorReady && !effect.error;
  }

  setBpm(bpm: number): void {
    for (const slot of this.slots) {
      for (const fx of [slot.effect, slot.pending?.effect]) {
        if (fx && (fx.algorithm === 'auto-riff' || BROWSER_OFFICIAL_STREAM_KEYS[fx.algorithm])) fx.setParam('quarterNotesPerMeasure', this.getQuarterNotesPerMeasure());
      }
      if (slot.effect && (TEMPO_ALGORITHMS.has(slot.effect.algorithm) || !!BROWSER_OFFICIAL_STREAM_KEYS[slot.effect.algorithm])) slot.effect.setParam('bpm', bpm);
      if (slot.pending && (TEMPO_ALGORITHMS.has(slot.pending.effect.algorithm) || !!BROWSER_OFFICIAL_STREAM_KEYS[slot.pending.effect.algorithm])) slot.pending.effect.setParam('bpm', bpm);
    }
  }

  getStatus(trackId: number): BrowserTrackFxStatus {
    const wasm = signalsmithLiveWasmSnapshot(this.context);
    const wasmResourceNote = `Live Signalsmith WASM reserved ${formatMiB(wasm.reservedBytes)} / ${formatMiB(SIGNALSMITH_LIVE_WASM_BUDGET_BYTES)} per AudioContext (${wasm.liveFxProcessorCount} LIVE_FX, ${wasm.livePolyProcessorCount} LIVE_POLY; ${formatMiB(wasm.measuredBytes)} measured linear-memory capacity). Per-node ceilings: 1.25 MiB LIVE_FX, 4 MiB LIVE_POLY. ${wasm.pendingCount} pending; ${wasm.releaseUnconfirmedCount} disposal(s) unconfirmed. The maximum steady graph is 84 LIVE_FX plus five LIVE_POLY processors (125 MiB total), leaving 3 MiB for replacements; larger candidates can be refused while keeping the incumbent. This cap covers WASM linear memory only, not loop buffers, JavaScript heap, browser RSS, HQ export, or realtime performance.`;
    return {
      trackId,
      available: true,
      routeMode: 'per-track-pre-mix',
      perTrackFxChainAvailable: true,
      legacySharedPostmix: true,
      slots: this.slots.map((slot, index) => {
        const pending = slot.pending;
        const requestedError = pending?.effect.error || null;
        const error = pending ? requestedError : slot.error || slot.effect?.error || null;
        const ready = Boolean(slot.effect?.processorReady);
        return {
          slotIndex: index,
          slot: ['A', 'B', 'C', 'D'][index] as BrowserTrackFxSlotStatus['slot'],
          type: slot.type,
          active: pending ? pending.active : slot.active && !error,
          bypassed: pending ? true : !slot.active || !ready || Boolean(error),
          state: pending ? requestedError ? 'error' : 'loading' : error ? 'error' : slot.effect ? ready ? 'ready' : 'loading' : 'empty',
          error,
          warning: pending && slot.effect
            ? `Preparing ${pending.type}; the current ${slot.type} audio remains active until it is ready.`
            : slot.warning,
          resourceNote: SIGNALSMITH_FX_TYPES.has(pending?.type ?? slot.type ?? '') || wasm.processorCount > 0
            ? wasmResourceNote
            : null,
          pendingApply: pending !== null,
          requestedEffectId: pending?.type ?? null,
          acknowledgedEffectId: slot.type,
        };
      }),
    };
  }

  /** Authored settings are reconstructable; transient worklet voices and tails are not. */
  getRecoverySnapshot(): readonly BrowserRecoveryFxSlot[] {
    return Object.freeze(this.slots.map((slot, index) => {
      const effect = slot.pending?.effect ?? slot.effect;
      const parameters = effect?.getParameterSnapshot?.();
      return Object.freeze({
        slot: ['A', 'B', 'C', 'D'][index] as BrowserRecoveryFxSlot['slot'],
        type: slot.type,
        requestedType: slot.pending?.type ?? null,
        active: slot.active,
        requestedActive: slot.pending ? slot.pending.active : null,
        state: slot.pending ? slot.pending.effect.error ? 'error' as const : 'loading' as const
          : slot.error || slot.effect?.error ? 'error' as const
            : slot.effect ? slot.effect.processorReady ? 'ready' as const : 'loading' as const
              : 'empty' as const,
        amount: slot.pending ? slot.pending.amount : slot.amount,
        parameters: copyRecoveryFxParameters(parameters),
        parametersCaptured: Boolean(parameters),
        error: slot.pending?.effect.error || slot.error || slot.effect?.error || null,
      });
    }));
  }

  dispose(): void {
    this.input.disconnect();
    for (const slot of this.slots) {
      slot.generation += 1;
      slot.pending?.cancel();
      slot.effect?.dispose();
    }
    this.output.disconnect();
  }

  private slot(index: number): Slot | undefined {
    return Number.isInteger(index) && index >= 0 && index < 4 ? this.slots[index] : undefined;
  }

  private rejectCandidate(slot: Slot, candidate: PendingReplacement, error: string): void {
    if (slot.pending?.generation !== candidate.generation || slot.pending.effect !== candidate.effect) {
      candidate.effect.dispose();
      return;
    }
    slot.pending = null;
    candidate.effect.dispose();
    if (slot.effect) {
      slot.warning = `FX replacement failed; kept existing ${slot.type}. ${error}`;
      slot.error = slot.effect.error || null;
    } else {
      slot.type = candidate.type;
      slot.active = false;
      slot.error = error;
      slot.warning = null;
      slot.amount = candidate.amount;
      slot.namedParameters = { ...candidate.namedParameters };
    }
    this.onChange();
  }

  private replace(
    index: number,
    type: string | null,
    effect: TrackFxEffect | null,
    error: string | null,
    active = false,
    amount: number | null = null,
    namedParameters: Readonly<Record<string, number>> = {},
  ): void {
    this.input.disconnect();
    for (const slot of this.slots) slot.effect?.output.disconnect();
    const previous = this.slots[index]!;
    previous.generation += 1;
    previous.pending?.cancel();
    previous.effect?.dispose();
    effect?.setBypass(!active);
    this.slots[index] = {
      type, effect, active, error, warning: null, generation: previous.generation, pending: null,
      amount, namedParameters: { ...namedParameters },
    };
    let tail: AudioNode = this.input;
    for (const slot of this.slots) {
      if (!slot.effect) continue;
      tail.connect(slot.effect.input);
      tail = slot.effect.output;
    }
    tail.connect(this.output);
    this.onChange();
  }
}
