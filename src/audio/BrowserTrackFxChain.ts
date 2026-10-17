import { BROWSER_WORKLET_FX_TYPES, BrowserWorkletFX, type BrowserWorkletFxName } from './fx/BrowserWorkletFX';

/** These need source-reader or external MIDI/host adapters, not a serial stream insert. */
export const BROWSER_PER_TRACK_FX_UNSUPPORTED = {
  'BEAT SHIFT': 'BEAT SHIFT is not an A–D insert; use the separate experimental per-loop source-transport route (currently controlled from the legacy bank).',
  'VINYL FLICK': 'VINYL FLICK is not an A–D insert; use the separate experimental per-loop source-transport route (currently controlled from the legacy bank).',
  'OSC VOC (M)': 'Per-track MIDI targeting is not implemented; use an explicitly selected shared-bank MIDI slot.',
  'AUTO RIFF': 'The AUTO RIFF host-pitch adapter is not admitted on the per-track insert path.',
  TRANSPOSE: 'The TRANSPOSE host-pitch adapter is not admitted on the per-track insert path.',
  'PITCH BEND': 'The PITCH BEND host-pitch adapter is not admitted on the per-track insert path.',
  ROBOT: 'The ROBOT host-pitch adapter is not admitted on the per-track insert path.',
  'HRM MANUAL': 'The manual harmonist host-pitch adapter is not admitted on the per-track insert path.',
  'HRM AUTO (M)': 'The MIDI harmonist host-pitch adapter is not admitted on the per-track insert path.',
  OCTAVE: 'The OCTAVE host-pitch adapter is not admitted on the per-track insert path.',
} as const;

/** Executable adapters only. This list is the UI/runtime coverage matrix, not catalog metadata. */
export const BROWSER_PER_TRACK_FX_TYPES: readonly string[] = Object.freeze([
  ...Object.keys(BROWSER_WORKLET_FX_TYPES).filter((type) => !(type in BROWSER_PER_TRACK_FX_UNSUPPORTED)),
  'REVERSE REVERB (EXPERIMENTAL)',
]);

const TEMPO_ALGORITHMS = new Set(['beat-repeat', 'beat-scatter', 'roll', 'warp', 'reverse-delay', 'reverse-reverb', 'pattern-slicer', 'step-slicer', 'isolator', 'osc-bot']);

/** Canonical numeric controls admitted on this bounded insert path. Unknown controls fail explicitly. */
export const BROWSER_PER_TRACK_PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = {
  lpf: ['cutoffHz', 'q', 'mix'], bpf: ['cutoffHz', 'q', 'mix'], hpf: ['cutoffHz', 'q', 'mix'],
  flanger: ['flangerDelayMs', 'flangerRateHz', 'flangerDepth', 'flangerFeedback', 'mix'],
  'ring-mod': ['ringModHz', 'ringModDepth', 'mix'],
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
};

export interface BrowserTrackFxSlotStatus {
  readonly slotIndex: number;
  readonly slot: 'A' | 'B' | 'C' | 'D';
  readonly type: string | null;
  readonly active: boolean;
  readonly bypassed: boolean;
  readonly state: 'empty' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
}

export interface BrowserTrackFxStatus {
  readonly trackId: number;
  readonly available: true;
  readonly routeMode: 'per-track-pre-mix';
  readonly perTrackFxChainAvailable: true;
  readonly legacySharedPostmix: true;
  readonly slots: readonly BrowserTrackFxSlotStatus[];
}

interface Slot {
  type: string | null;
  effect: BrowserWorkletFX | null;
  active: boolean;
  error: string | null;
}

/** One real stereo A → B → C → D chain. No processor instance is shared by tracks. */
export class BrowserTrackFxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onChange: () => void;
  private readonly getBpm: () => number;
  private readonly slots: Slot[] = Array.from({ length: 4 }, () => ({ type: null, effect: null, active: false, error: null }));

  constructor(
    context: AudioContext,
    ensureModule: () => Promise<void>,
    onChange: () => void = () => {},
    getBpm: () => number = () => 120,
  ) {
    this.context = context;
    this.ensureModule = ensureModule;
    this.onChange = onChange;
    this.getBpm = getBpm;
    this.input = context.createGain();
    this.output = context.createGain();
    this.input.connect(this.output);
  }

  setType(slotIndex: number, rawType: string): boolean {
    const slot = this.slot(slotIndex);
    if (!slot || typeof rawType !== 'string') return false;
    const type = rawType.trim().toUpperCase();
    if (slot.type === type && slot.effect && !slot.error && !slot.effect.error) return true;
    if (!type || type === 'NONE') {
      this.replace(slotIndex, null, null, null);
      return true;
    }
    const unsupported = BROWSER_PER_TRACK_FX_UNSUPPORTED[type as keyof typeof BROWSER_PER_TRACK_FX_UNSUPPORTED];
    if (!BROWSER_PER_TRACK_FX_TYPES.includes(type)) {
      this.replace(slotIndex, type, null, unsupported ?? `Unsupported Browser per-track FX type: ${type}. No shared-bank fallback was applied.`);
      return false;
    }
    if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      this.replace(slotIndex, type, null, 'AudioWorklet is unavailable; this per-track slot is bypassed.');
      return false;
    }
    const name = (type === 'REVERSE REVERB (EXPERIMENTAL)' ? 'REVERSE REVERB' : type) as BrowserWorkletFxName;
    const effect = new BrowserWorkletFX(this.context, name, this.ensureModule, (error) => {
      if (this.slots[slotIndex]?.effect !== effect) return;
      const current = this.slots[slotIndex]!;
      current.error = error.message;
      current.active = false;
      effect.setBypass(true);
      this.onChange();
    }, TEMPO_ALGORITHMS.has(BROWSER_WORKLET_FX_TYPES[name]) ? { bpm: this.getBpm() } : {});
    effect.setBypass(true);
    this.replace(slotIndex, type, effect, null);
    void effect.ready.then(() => {
      if (this.slots[slotIndex]?.effect === effect) this.onChange();
    });
    return true;
  }

  setParameter(slotIndex: number, value: number): boolean {
    const slot = this.slot(slotIndex);
    if (!slot?.effect || slot.error || !Number.isFinite(value)) return false;
    if (slot.effect.algorithm === 'electric') slot.effect.setParam('mix', Math.max(0, Math.min(100, value)) / 100);
    else slot.effect.setAmount(Math.max(0, Math.min(100, value)) / 100);
    return !slot.effect.error;
  }

  /** Canonical numeric BrowserFxParameters only; no data is sent to another track. */
  setNamedParameters(slotIndex: number, parameters: Readonly<Record<string, number>>): boolean {
    const slot = this.slot(slotIndex);
    if (!slot?.effect || slot.error || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    const entries = Object.entries(parameters);
    const admitted = BROWSER_PER_TRACK_PARAMETER_KEYS[slot.effect.algorithm] ?? [];
    const invalid = entries.find(([key, value]) => !admitted.includes(key) || !Number.isFinite(value));
    if (invalid) {
      slot.error = `Unsupported or non-finite ${slot.type} per-track parameter: ${invalid[0]}. Slot bypassed.`;
      slot.active = false;
      slot.effect.setBypass(true);
      this.onChange();
      return false;
    }
    for (const [key, value] of entries) slot.effect.setParam(key, value);
    return !slot.effect.error;
  }

  setActive(slotIndex: number, active: boolean): boolean {
    const slot = this.slot(slotIndex);
    if (!slot?.effect || slot.error || slot.effect.error || typeof active !== 'boolean') return false;
    slot.active = active;
    slot.effect.setBypass(!active);
    this.onChange();
    return true;
  }

  setBpm(bpm: number): void {
    for (const slot of this.slots) {
      if (slot.effect && TEMPO_ALGORITHMS.has(slot.effect.algorithm)) slot.effect.setParam('bpm', bpm);
    }
  }

  getStatus(trackId: number): BrowserTrackFxStatus {
    return {
      trackId,
      available: true,
      routeMode: 'per-track-pre-mix',
      perTrackFxChainAvailable: true,
      legacySharedPostmix: true,
      slots: this.slots.map((slot, index) => {
        const error = slot.error || slot.effect?.error || null;
        const ready = Boolean(slot.effect?.processorReady);
        return {
          slotIndex: index,
          slot: ['A', 'B', 'C', 'D'][index] as BrowserTrackFxSlotStatus['slot'],
          type: slot.type,
          active: slot.active && !error,
          bypassed: !slot.active || !ready || Boolean(error),
          state: error ? 'error' : slot.effect ? ready ? 'ready' : 'loading' : 'empty',
          error,
        };
      }),
    };
  }

  dispose(): void {
    this.input.disconnect();
    for (const slot of this.slots) slot.effect?.dispose();
    this.output.disconnect();
  }

  private slot(index: number): Slot | undefined {
    return Number.isInteger(index) && index >= 0 && index < 4 ? this.slots[index] : undefined;
  }

  private replace(index: number, type: string | null, effect: BrowserWorkletFX | null, error: string | null): void {
    this.input.disconnect();
    for (const slot of this.slots) slot.effect?.output.disconnect();
    this.slots[index]?.effect?.dispose();
    this.slots[index] = { type, effect, active: false, error };
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
