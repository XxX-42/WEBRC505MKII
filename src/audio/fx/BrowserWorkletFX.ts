import type { FXBase } from './FXBase';
import type { BrowserFxAlgorithm, BrowserFxParameters } from './dsp/BrowserFxDspCore';

export const BROWSER_WORKLET_FX_TYPES = {
  'DSP LPF': 'lpf',
  'DSP BPF': 'bpf',
  'DSP HPF': 'hpf',
  FLANGER: 'flanger',
  'RING.MOD': 'ring-mod',
  DELAY: 'delay',
  'MOD DELAY': 'mod-delay',
  'PANNING DELAY': 'panning-delay',
  CHORUS: 'chorus',
  PHASER: 'phaser',
  TREMOLO: 'tremolo',
  'AUTO PAN': 'auto-pan',
  DIST: 'distortion',
  PREAMP: 'preamp',
  SYNTH: 'synth',
  G2B: 'g2b',
  DYNAMICS: 'dynamics',
  SUSTAINER: 'sustainer',
  'FDN8 REVERB': 'reverb',
  'GATE REVERB': 'gate-reverb',
  'BEAT REPEAT': 'beat-repeat',
  'BEAT SCATTER': 'beat-scatter',
  ROLL: 'roll',
  FREEZE: 'freeze',
  WARP: 'warp',
  'WARP (EXPERIMENTAL)': 'warp',
  'BEAT SHIFT': 'beat-shift',
  'REVERSE DELAY': 'reverse-delay',
  'REVERSE REVERB': 'reverse-reverb',
  'PATTERN SLICER': 'pattern-slicer',
  'STEP SLICER': 'step-slicer',
  'STEREO ENHANCE': 'stereo-enhance',
  'LO-FI': 'lo-fi',
  EQ: 'eq',
  'MANUAL PAN': 'manual-pan',
  'TAPE ECHO': 'tape-echo',
  TWIST: 'twist',
  'GRANULAR DELAY': 'granular-delay',
  RADIO: 'radio',
  VIBRATO: 'vibrato',
  'SLOW GEAR': 'slow-gear',
  ISOLATOR: 'isolator',
  'VINYL FLICK': 'vinyl-flick',
  VOCODER: 'vocoder',
  ELECTRIC: 'electric',
  'OSC VOC (M)': 'osc-voc',
  'OSC BOT': 'osc-bot',
} as const satisfies Readonly<Record<string, BrowserFxAlgorithm>>;

export type BrowserWorkletFxName = keyof typeof BROWSER_WORKLET_FX_TYPES;

interface BrowserMidiNoteMessage {
  readonly type: 'midi-note-on' | 'midi-note-off';
  readonly channel: number;
  readonly note: number;
  readonly frame: number;
  readonly velocity?: number;
}

const MAX_PENDING_MIDI_EVENTS = 256;

const amountParameters = (algorithm: BrowserFxAlgorithm, value: number): BrowserFxParameters => {
  const amount = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  switch (algorithm) {
    case 'lpf':
    case 'bpf':
    case 'hpf':
      return { cutoffHz: 20 * (1000 ** amount) };
    case 'flanger':
      return { flangerDepth: amount, mix: amount };
    case 'ring-mod':
      return { ringModDepth: amount };
    case 'reverb':
    case 'gate-reverb':
    case 'reverse-reverb':
      return { mix: amount };
    case 'delay':
    case 'panning-delay':
    case 'mod-delay':
      return { mix: amount };
    case 'chorus':
      return { mix: amount };
    case 'phaser':
      return { phaserDepth: amount, mix: amount };
    case 'tremolo':
      return { tremoloDepth: amount, mix: 1 };
    case 'auto-pan':
      return { autoPanDepth: amount, mix: 1 };
    case 'distortion':
      return { driveDb: 36 * amount, outputDb: 0, mix: amount };
    case 'preamp':
      return { preampGainPercent: amount * 100 };
    case 'synth':
      return { synthMixPercent: amount * 100 };
    case 'vocoder':
      return { vocoderBands: 16, vocoderCarrier: 1, mix: amount };
    case 'electric':
      return { mix: amount };
    case 'osc-voc':
      return { oscVocWaveform: 0, oscVocMidiChannel: 1, oscVocOctave: 0, oscVocBands: 16, mix: amount };
    case 'osc-bot':
      return { mix: amount };
    case 'g2b':
      return { g2bBlendPercent: amount * 100 };
    case 'dynamics':
      // A unity ratio is transparent at amount 0; increasing the macro raises
      // compression ratio while leaving the wet signal fully engaged.
      return { thresholdDb: -18, ratio: 1 + (19 * amount), kneeDb: 6, attackMs: 10, releaseMs: 120, mix: 1 };
    case 'sustainer':
      return { thresholdDb: -24, ratio: 1 + (19 * amount), releaseMs: 180, outputDb: 0, mix: 1 };
    case 'beat-repeat':
    case 'beat-scatter':
    case 'roll':
    case 'freeze':
    case 'warp':
    case 'reverse-delay':
      return { mix: amount };
    case 'pattern-slicer':
      return { patternSlicerDepthPercent: amount * 100 };
    case 'step-slicer':
      return { stepSlicerDepthPercent: amount * 100 };
    case 'beat-shift':
      // Beat Shift is an all-shifted-read-head operation, not a wet/dry mix.
      return {};
    case 'stereo-enhance':
      return { stereoWidth: amount * 2 };
    case 'lo-fi':
      return { mix: amount };
    case 'eq':
      // The generic panel amount controls a broad tilt from flat to +/-12 dB.
      return { eqLowGainDb: amount * 12, eqHighGainDb: -amount * 12, mix: 1 };
    case 'manual-pan':
      return { manualPanPosition: (amount * 2) - 1, mix: 1 };
    case 'tape-echo':
      return { mix: amount };
    case 'twist':
      return { twistAmount: (amount * 200) - 100 };
    case 'granular-delay':
      return { mix: amount };
    case 'radio':
      return { radioDrive: amount * 100, mix: amount };
    case 'vibrato':
      return { vibratoDepthPercent: amount * 100, mix: 1 };
    case 'slow-gear':
      // The generic bank macro is the effect mix; attack and sensitivity are
      // explicit catalog controls exposed through setParam().
      return { mix: amount };
    case 'isolator':
      // Use the generic bank macro for the rhythm gate depth; band gains and
      // gate rate remain independently addressable through setParam().
      return { isolatorGateDepthPercent: amount * 100 };
    case 'vinyl-flick':
      // Coarse macro: center is nominal 1x platter speed; zero is fully dry.
      return { vinylFlickSpeed: (amount * 200) - 100, mix: amount };
  }
  return {};
};

/**
 * FXBase adapter for the real variable-quantum Browser DSP AudioWorklet.
 * It starts as an exact wire-through and swaps to the processor only after the
 * module is ready, so a missing/failed module never silently mutes the chain.
 */
export class BrowserWorkletFX implements FXBase {
  readonly name: BrowserWorkletFxName;
  readonly algorithm: BrowserFxAlgorithm;
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly context: AudioContext;
  private readonly ensureModule: () => Promise<void>;
  private readonly onFailure?: (error: Error) => void;
  private node: AudioWorkletNode | null = null;
  private parameters: BrowserFxParameters = {};
  private pendingMidiMessages: BrowserMidiNoteMessage[] = [];
  private bypassed = true;
  private disposed = false;
  private amount = 0.5;
  public error = '';
  /** Settles after the processor is installed or its failure has been reported. */
  public readonly ready: Promise<void>;

  get processorReady(): boolean { return this.node !== null && !this.disposed && !this.error; }

  constructor(
    context: AudioContext,
    name: BrowserWorkletFxName,
    ensureModule: () => Promise<void>,
    onFailure?: (error: Error) => void,
    initialParameters: BrowserFxParameters = {},
  ) {
    this.context = context;
    this.name = name;
    this.algorithm = BROWSER_WORKLET_FX_TYPES[name];
    this.ensureModule = ensureModule;
    this.onFailure = onFailure;
    this.parameters = { ...initialParameters };
    this.input = context.createGain();
    this.output = context.createGain();
    this.input.connect(this.output);

    this.ready = this.installProcessor(onFailure);
  }

  setAmount(value: number): void {
    if (!Number.isFinite(value)) return;
    this.amount = Math.max(0, Math.min(1, value));
    this.parameters = { ...this.parameters, ...amountParameters(this.algorithm, this.amount) };
    this.node?.port.postMessage({ type: 'configure', parameters: this.parameters });
  }

  setParam(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.algorithm === 'beat-shift' && (key === 'mix' || key === 'beat-shift.mix')) return;
    if (this.algorithm === 'preamp' && (key === 'mix' || key === 'preamp.mix')) return;
    if (key === 'amount') {
      this.setAmount(value);
      return;
    }

    let parameterKey = key;
    let parameterValue = (this.algorithm === 'beat-repeat' || this.algorithm === 'roll') && key === 'mix' && value > 1
      ? value / 100
      : value;
    if (this.algorithm === 'roll') {
      const rollKeys: Record<string, string> = {
        slice: 'rollSliceBeats', 'roll-slice': 'rollSliceBeats', 'roll.slice': 'rollSliceBeats', slice_beats: 'rollSliceBeats', rollSliceBeats: 'rollSliceBeats',
        decay: 'rollDecayPercent', 'roll-decay': 'rollDecayPercent', 'roll.decay': 'rollDecayPercent', decay_percent: 'rollDecayPercent', rollDecayPercent: 'rollDecayPercent',
        pitch: 'rollPitchSemitones', 'roll-pitch': 'rollPitchSemitones', 'roll.pitch': 'rollPitchSemitones', pitch_semitones: 'rollPitchSemitones', rollPitchSemitones: 'rollPitchSemitones',
        direction: 'rollDirection', 'roll-direction': 'rollDirection', 'roll.direction': 'rollDirection', rollDirection: 'rollDirection',
      };
      parameterKey = rollKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'freeze') {
      const freezeKeys: Record<string, string> = {
        capture_ms: 'freezeCaptureLengthMs', capture_length_ms: 'freezeCaptureLengthMs', captureLengthMs: 'freezeCaptureLengthMs',
        pitch: 'freezePitchSemitones', pitch_semitones: 'freezePitchSemitones', pitchSemitones: 'freezePitchSemitones',
        freeze: 'freezeEnabled', frozen: 'freezeEnabled', freezeEnabled: 'freezeEnabled',
        mode: 'freezeMode', freezeMode: 'freezeMode', mix: 'mix',
      };
      parameterKey = freezeKeys[key] ?? key;
      if (parameterKey === 'freezeMode' && value !== 0) {
        this.reportError('Spectral FREEZE mode is unavailable; only micro-loop mode is wired.');
        return;
      }
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'warp') {
      if (key === 'mode' || key === 'spectral' || key === 'spectral_mode' || key === 'high_tier_mode') {
        this.reportError('WARP spectral mode is unavailable; only the experimental granular/FDN8 path is wired.');
        return;
      }
      const warpKeys: Record<string, string> = {
        capture: 'warpCaptureBeats', capture_beats: 'warpCaptureBeats', 'warp.capture': 'warpCaptureBeats',
        smear: 'warpSmearPercent', smear_percent: 'warpSmearPercent', 'warp.smear': 'warpSmearPercent',
        pitch: 'warpPitchSemitones', pitch_semitones: 'warpPitchSemitones', 'warp.pitch': 'warpPitchSemitones',
        feedback: 'warpFeedbackPercent', feedback_percent: 'warpFeedbackPercent', 'warp.feedback': 'warpFeedbackPercent',
        freeze: 'warpFreezeEnabled', frozen: 'warpFreezeEnabled', 'warp.freeze': 'warpFreezeEnabled',
        mix: 'mix', mix_percent: 'mix', 'warp.mix': 'mix', bpm: 'bpm', tempo: 'bpm',
      };
      parameterKey = warpKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'stereo-enhance') {
      if (key === 'width') {
        parameterKey = 'stereoWidth';
        parameterValue = value / 100;
      } else if (key === 'low-mono-cutoff' || key === 'lowMonoCutoffHz') {
        parameterKey = 'stereoLowMonoCutoffHz';
      } else if (key === 'decorrelation') {
        parameterKey = 'stereoDecorrelation';
        parameterValue = value / 100;
      } else if (key === 'mix' && value > 1) {
        parameterValue = value / 100;
      }
    } else if (this.algorithm === 'lo-fi') {
      if (key === 'bit-depth' || key === 'bit_depth') parameterKey = 'loFiBitDepth';
      else if (key === 'sample-rate' || key === 'sample_rate_hz') parameterKey = 'loFiSampleRateHz';
      else if (key === 'filter' || key === 'filter_hz') parameterKey = 'loFiFilterHz';
      else if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'vocoder') {
      if (key === 'bands') parameterKey = 'vocoderBands';
      else if (key === 'carrier') parameterKey = 'vocoderCarrier';
      else if (key === 'formant' || key === 'formantSemitones') {
        this.setBypass(true);
        this.reportError('VOCODER formant shifting is unsupported and rejected.');
        return;
      } else if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'electric') {
      const electricKeys: Record<string, string> = {
        character: 'electricCharacter', 'electric.character': 'electricCharacter', electricCharacter: 'electricCharacter',
        'pitch-snap': 'electricPitchSnapPercent', pitch_snap: 'electricPitchSnapPercent', pitchSnapPercent: 'electricPitchSnapPercent',
        tone: 'electricToneHz', tone_hz: 'electricToneHz', toneHz: 'electricToneHz',
        mix: 'mix', mix_percent: 'mix', 'electric.mix': 'mix',
      };
      parameterKey = electricKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'osc-bot') {
      if (key === 'waveform') parameterKey = 'oscBotWaveform';
      else if (key === 'pattern') parameterKey = 'oscBotPattern';
      else if (key === 'tone' || key === 'toneHz') parameterKey = 'oscBotToneHz';
      else if (key === 'bpm' || key === 'tempo') parameterKey = 'bpm';
      else if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'osc-voc') {
      const oscVocKeys: Record<string, string> = {
        waveform: 'oscVocWaveform',
        channel: 'oscVocMidiChannel', 'midi-channel': 'oscVocMidiChannel', midiChannel: 'oscVocMidiChannel',
        octave: 'oscVocOctave', 'octave-semitones': 'oscVocOctave',
        bands: 'oscVocBands',
        mix: 'mix',
      };
      parameterKey = oscVocKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'eq') {
      const eqParameterKeys: Record<string, string> = {
        'low-frequency': 'eqLowFrequencyHz', 'low_frequency_hz': 'eqLowFrequencyHz',
        'low-gain': 'eqLowGainDb', 'low_gain_db': 'eqLowGainDb',
        'mid-1-frequency': 'eqMid1FrequencyHz', 'mid_1_frequency_hz': 'eqMid1FrequencyHz',
        'mid-1-q': 'eqMid1Q', 'mid_1_q': 'eqMid1Q',
        'mid-1-gain': 'eqMid1GainDb', 'mid_1_gain_db': 'eqMid1GainDb',
        'mid-2-frequency': 'eqMid2FrequencyHz', 'mid_2_frequency_hz': 'eqMid2FrequencyHz',
        'mid-2-q': 'eqMid2Q', 'mid_2_q': 'eqMid2Q',
        'mid-2-gain': 'eqMid2GainDb', 'mid_2_gain_db': 'eqMid2GainDb',
        'high-frequency': 'eqHighFrequencyHz', 'high_frequency_hz': 'eqHighFrequencyHz',
        'high-gain': 'eqHighGainDb', 'high_gain_db': 'eqHighGainDb',
        mix: 'mix',
      };
      parameterKey = eqParameterKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'manual-pan') {
      if (key === 'position' || key === 'position_percent') {
        parameterKey = 'manualPanPosition';
        parameterValue = value / 100;
      }
    } else if (this.algorithm === 'tape-echo') {
      const tapeEchoKeys: Record<string, string> = {
        time: 'tapeEchoTimeMs', time_ms: 'tapeEchoTimeMs', 'delay-time': 'tapeEchoTimeMs',
        feedback: 'tapeEchoFeedback', wow: 'tapeEchoWow', 'wow-flutter': 'tapeEchoWow',
        saturation: 'tapeEchoSaturation', tone: 'tapeEchoToneHz', tone_hz: 'tapeEchoToneHz',
      };
      parameterKey = tapeEchoKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'twist') {
      const twistKeys: Record<string, string> = {
        amount_percent: 'twistAmount', 'twist.amount': 'twistAmount', twistAmount: 'twistAmount',
        trajectory: 'twistTrajectory', 'twist.trajectory': 'twistTrajectory', twistTrajectory: 'twistTrajectory',
        mix_percent: 'mix', 'twist.mix': 'mix',
      };
      parameterKey = twistKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'granular-delay') {
      const granularKeys: Record<string, string> = {
        'grain-size': 'granularGrainSizeMs', 'grain-size-ms': 'granularGrainSizeMs', grain_size_ms: 'granularGrainSizeMs', grainSizeMs: 'granularGrainSizeMs',
        density: 'granularDensityHz', density_hz: 'granularDensityHz', densityHz: 'granularDensityHz',
        pitch: 'granularPitchSemitones', pitch_semitones: 'granularPitchSemitones', pitchSemitones: 'granularPitchSemitones',
        jitter: 'granularPositionJitterPercent', 'position-jitter': 'granularPositionJitterPercent', position_jitter: 'granularPositionJitterPercent', positionJitterPercent: 'granularPositionJitterPercent',
        feedback: 'granularFeedbackPercent', feedback_percent: 'granularFeedbackPercent', feedbackPercent: 'granularFeedbackPercent',
      };
      parameterKey = granularKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'radio') {
      const radioKeys: Record<string, string> = {
        band: 'radioBand', radio_band: 'radioBand', radioBand: 'radioBand',
        drive: 'radioDrive', drive_percent: 'radioDrive', radioDrive: 'radioDrive',
        noise: 'radioNoise', noise_percent: 'radioNoise', radioNoise: 'radioNoise',
      };
      parameterKey = radioKeys[key] ?? key;
      if (parameterKey !== 'radioBand' && parameterKey !== 'mix') parameterValue = Math.max(0, Math.min(100, value));
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'vibrato') {
      const vibratoKeys: Record<string, string> = {
        rate: 'vibratoRateHz', rate_hz: 'vibratoRateHz', vibratoRateHz: 'vibratoRateHz',
        depth: 'vibratoDepthPercent', depth_percent: 'vibratoDepthPercent', vibratoDepthPercent: 'vibratoDepthPercent',
        delay: 'vibratoDelayMs', delay_ms: 'vibratoDelayMs', 'base-delay': 'vibratoDelayMs', baseDelayMs: 'vibratoDelayMs',
      };
      parameterKey = vibratoKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'slow-gear') {
      const slowGearKeys: Record<string, string> = {
        attack: 'slowGearAttackMs', 'attack-time': 'slowGearAttackMs', attack_ms: 'slowGearAttackMs', attackMs: 'slowGearAttackMs',
        sensitivity: 'slowGearSensitivityPercent', 'sensitivity-percent': 'slowGearSensitivityPercent', sensitivity_percent: 'slowGearSensitivityPercent', sensitivityPercent: 'slowGearSensitivityPercent',
        mix: 'mix',
      };
      parameterKey = slowGearKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'isolator') {
      const isolatorKeys: Record<string, string> = {
        low: 'isolatorLowGainDb', 'low-gain': 'isolatorLowGainDb', low_gain_db: 'isolatorLowGainDb', lowGainDb: 'isolatorLowGainDb',
        mid: 'isolatorMidGainDb', 'mid-gain': 'isolatorMidGainDb', mid_gain_db: 'isolatorMidGainDb', midGainDb: 'isolatorMidGainDb',
        high: 'isolatorHighGainDb', 'high-gain': 'isolatorHighGainDb', high_gain_db: 'isolatorHighGainDb', highGainDb: 'isolatorHighGainDb',
        'gate-rate': 'isolatorGateRateBeats', gate_rate: 'isolatorGateRateBeats', gate_rate_beats: 'isolatorGateRateBeats', gateRateBeats: 'isolatorGateRateBeats',
        'gate-depth': 'isolatorGateDepthPercent', gate_depth: 'isolatorGateDepthPercent', gate_depth_percent: 'isolatorGateDepthPercent', gateDepthPercent: 'isolatorGateDepthPercent',
        bpm: 'bpm', mix: 'mix',
      };
      parameterKey = isolatorKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'beat-scatter') {
      const beatScatterKeys: Record<string, string> = {
        slice: 'beatScatterSliceBeats', 'slice-beats': 'beatScatterSliceBeats', slice_beats: 'beatScatterSliceBeats', sliceBeats: 'beatScatterSliceBeats',
        scatter: 'beatScatterScatterPercent', 'scatter-amount': 'beatScatterScatterPercent', scatter_amount: 'beatScatterScatterPercent', scatter_percent: 'beatScatterScatterPercent', scatterPercent: 'beatScatterScatterPercent',
        pitch: 'beatScatterPitchSemitones', pitch_semitones: 'beatScatterPitchSemitones', pitchSemitones: 'beatScatterPitchSemitones',
        repeats: 'beatScatterRepeats', repeat_count: 'beatScatterRepeats', repeatCount: 'beatScatterRepeats',
        bpm: 'bpm', mix: 'mix',
      };
      parameterKey = beatScatterKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'beat-shift') {
      const beatShiftKeys: Record<string, string> = {
        offset: 'beatShiftOffsetBeats', 'beat-offset': 'beatShiftOffsetBeats',
        'offset-beats': 'beatShiftOffsetBeats', 'beat-shift.offset': 'beatShiftOffsetBeats',
        beatShiftOffsetBeats: 'beatShiftOffsetBeats',
        crossfade: 'beatShiftCrossfadeMs', 'crossfade-ms': 'beatShiftCrossfadeMs',
        'beat-shift.crossfade': 'beatShiftCrossfadeMs', crossfadeMs: 'beatShiftCrossfadeMs',
        bpm: 'bpm',
      };
      parameterKey = beatShiftKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'reverse-delay') {
      const reverseDelayKeys: Record<string, string> = {
        time: 'reverseDelaySegmentBeats', segment: 'reverseDelaySegmentBeats',
        'segment-beats': 'reverseDelaySegmentBeats', segment_beats: 'reverseDelaySegmentBeats',
        'reverse-delay.time': 'reverseDelaySegmentBeats', reverseDelaySegmentBeats: 'reverseDelaySegmentBeats',
        feedback: 'reverseDelayFeedback', 'reverse-delay.feedback': 'reverseDelayFeedback', reverseDelayFeedback: 'reverseDelayFeedback',
        crossfade: 'reverseDelayCrossfadeMs', 'crossfade-ms': 'reverseDelayCrossfadeMs',
        'reverse-delay.crossfade': 'reverseDelayCrossfadeMs', reverseDelayCrossfadeMs: 'reverseDelayCrossfadeMs',
        bpm: 'bpm', mix: 'mix', 'reverse-delay.mix': 'mix',
      };
      parameterKey = reverseDelayKeys[key] ?? key;
      if ((parameterKey === 'mix' || parameterKey === 'reverseDelayFeedback') && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'reverse-reverb') {
      const reverseReverbKeys: Record<string, string> = {
        bpm: 'bpm', tempo: 'bpm',
        segment: 'reverseReverbSegmentBeats', 'segment-beats': 'reverseReverbSegmentBeats', segment_beats: 'reverseReverbSegmentBeats',
        segmentBeats: 'reverseReverbSegmentBeats', reverseReverbSegmentBeats: 'reverseReverbSegmentBeats',
        feedback: 'reverseReverbFeedbackPercent', 'feedback-percent': 'reverseReverbFeedbackPercent', feedback_percent: 'reverseReverbFeedbackPercent',
        feedbackPercent: 'reverseReverbFeedbackPercent', reverseReverbFeedbackPercent: 'reverseReverbFeedbackPercent',
        crossfade: 'reverseReverbCrossfadeMs', 'crossfade-ms': 'reverseReverbCrossfadeMs', crossfade_ms: 'reverseReverbCrossfadeMs',
        crossfadeMs: 'reverseReverbCrossfadeMs', reverseReverbCrossfadeMs: 'reverseReverbCrossfadeMs',
        decay: 'reverseReverbDecaySeconds', decay_seconds: 'reverseReverbDecaySeconds', decaySeconds: 'reverseReverbDecaySeconds',
        damping: 'reverseReverbDampingCutoffHz', damping_cutoff_hz: 'reverseReverbDampingCutoffHz', dampingCutoffHz: 'reverseReverbDampingCutoffHz',
        mix: 'mix', mix_percent: 'mix',
      };
      parameterKey = reverseReverbKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
      if (key === 'feedback' && value >= 0 && value <= 1) parameterValue = value * 100;
    } else if (this.algorithm === 'pattern-slicer') {
      const patternSlicerKeys: Record<string, string> = {
        pattern: 'patternSlicerPattern', 'pattern-slicer.pattern': 'patternSlicerPattern', pattern_index: 'patternSlicerPattern', patternIndex: 'patternSlicerPattern',
        rate: 'patternSlicerRateBeats', 'step-rate': 'patternSlicerRateBeats', 'rate-beats': 'patternSlicerRateBeats', rate_beats: 'patternSlicerRateBeats', rateBeats: 'patternSlicerRateBeats',
        depth: 'patternSlicerDepthPercent', 'gate-depth': 'patternSlicerDepthPercent', depth_percent: 'patternSlicerDepthPercent', depthPercent: 'patternSlicerDepthPercent',
        edge: 'patternSlicerEdgeMs', 'edge-smoothing': 'patternSlicerEdgeMs', 'edge-ms': 'patternSlicerEdgeMs', edge_ms: 'patternSlicerEdgeMs', edgeMs: 'patternSlicerEdgeMs',
        bpm: 'bpm',
      };
      parameterKey = patternSlicerKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'step-slicer') {
      const stepSlicerKeys: Record<string, string> = {
        'step-count': 'stepSlicerStepCount', step_count: 'stepSlicerStepCount', stepCount: 'stepSlicerStepCount',
        rate: 'stepSlicerRateBeats', 'step-rate': 'stepSlicerRateBeats', 'rate-beats': 'stepSlicerRateBeats', rate_beats: 'stepSlicerRateBeats',
        depth: 'stepSlicerDepthPercent', 'gate-depth': 'stepSlicerDepthPercent', depth_percent: 'stepSlicerDepthPercent',
        'pan-depth': 'stepSlicerPanDepthPercent', pan_depth: 'stepSlicerPanDepthPercent', pan_depth_percent: 'stepSlicerPanDepthPercent',
        filter: 'stepSlicerFilterHz', 'filter-hz': 'stepSlicerFilterHz', filter_hz: 'stepSlicerFilterHz',
        bpm: 'bpm',
      };
      parameterKey = stepSlicerKeys[key] ?? key;
      for (let index = 1; index <= 16; index += 1) {
        const suffix = String(index).padStart(2, '0');
        if (key === `step_${suffix}` || key === `step-${suffix}` || key === `stepSlicerStep${suffix}`) {
          parameterKey = `stepSlicerStep${suffix}`;
          break;
        }
      }
      if ((parameterKey === 'stepSlicerDepthPercent' || parameterKey === 'stepSlicerPanDepthPercent') && value > 1 && value <= 100) {
        parameterValue = value;
      }
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'sustainer') {
      const sustainerKeys: Record<string, string> = {
        threshold: 'thresholdDb', threshold_db: 'thresholdDb', thresholdDb: 'thresholdDb',
        ratio: 'ratio',
        release: 'releaseMs', release_ms: 'releaseMs', releaseMs: 'releaseMs',
        output: 'outputDb', output_db: 'outputDb', outputDb: 'outputDb',
        mix: 'mix',
      };
      parameterKey = sustainerKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'preamp') {
      const preampKeys: Record<string, string> = {
        model: 'preampModel', 'preamp.model': 'preampModel', preampModel: 'preampModel',
        gain: 'preampGainPercent', 'preamp.gain': 'preampGainPercent', gainPercent: 'preampGainPercent',
        bass: 'preampBassDb', 'preamp.bass': 'preampBassDb', bassDb: 'preampBassDb',
        middle: 'preampMiddleDb', mid: 'preampMiddleDb', 'preamp.middle': 'preampMiddleDb', middleDb: 'preampMiddleDb',
        treble: 'preampTrebleDb', 'preamp.treble': 'preampTrebleDb', trebleDb: 'preampTrebleDb',
        level: 'preampLevelDb', 'preamp.level': 'preampLevelDb', levelDb: 'preampLevelDb',
      };
      parameterKey = preampKeys[key] ?? key;
    } else if (this.algorithm === 'synth') {
      const synthKeys: Record<string, string> = {
        sensitivity: 'synthSensitivity', 'synth.sensitivity': 'synthSensitivity', synthSensitivity: 'synthSensitivity',
        waveform: 'synthWaveform', 'synth.waveform': 'synthWaveform', synthWaveform: 'synthWaveform',
        octave: 'synthOctave', 'synth.octave': 'synthOctave', synthOctave: 'synthOctave',
        tone: 'synthToneHz', 'synth.tone': 'synthToneHz', toneHz: 'synthToneHz', synthToneHz: 'synthToneHz',
        mix: 'synthMixPercent', 'synth.mix': 'synthMixPercent', mixPercent: 'synthMixPercent', synthMixPercent: 'synthMixPercent',
      };
      parameterKey = synthKeys[key] ?? key;
    } else if (this.algorithm === 'g2b') {
      const g2bKeys: Record<string, string> = {
        tracking: 'g2bTrackingPercent', tracking_percent: 'g2bTrackingPercent', trackingPercent: 'g2bTrackingPercent',
        blend: 'g2bBlendPercent', blend_percent: 'g2bBlendPercent', blendPercent: 'g2bBlendPercent',
        body: 'g2bBodyHz', body_hz: 'g2bBodyHz', bodyHz: 'g2bBodyHz',
        mix: 'g2bBlendPercent', 'g2b.mix': 'g2bBlendPercent',
      };
      parameterKey = g2bKeys[key] ?? key;
      if (key === 'mix' || key === 'g2b.mix') parameterValue = value <= 1 ? value * 100 : value;
    } else if (this.algorithm === 'gate-reverb') {
      const gateReverbKeys: Record<string, string> = {
        decay: 'decaySeconds', decay_seconds: 'decaySeconds', decaySeconds: 'decaySeconds',
        threshold: 'gateThresholdDb', gate_threshold: 'gateThresholdDb', gateThresholdDb: 'gateThresholdDb',
        hold: 'gateHoldMs', gate_hold: 'gateHoldMs', gateHoldMs: 'gateHoldMs',
        release: 'gateReleaseMs', gate_release: 'gateReleaseMs', gateReleaseMs: 'gateReleaseMs',
        mix: 'mix',
      };
      parameterKey = gateReverbKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'panning-delay') {
      const panningDelayKeys: Record<string, string> = {
        time: 'panningDelayTimeMs', time_ms: 'panningDelayTimeMs', 'delay-time': 'panningDelayTimeMs',
        feedback: 'panningDelayFeedback', pan: 'panningDelayPan', 'repeat-pan': 'panningDelayPan',
      };
      parameterKey = panningDelayKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'mod-delay') {
      const modDelayKeys: Record<string, string> = {
        time: 'modDelayTimeMs', time_ms: 'modDelayTimeMs', 'delay-time': 'modDelayTimeMs',
        rate: 'modDelayRateHz', rate_hz: 'modDelayRateHz', 'modulation-rate': 'modDelayRateHz',
        depth: 'modDelayDepthMs', depth_ms: 'modDelayDepthMs', 'modulation-depth': 'modDelayDepthMs',
        feedback: 'modDelayFeedbackPercent', feedback_percent: 'modDelayFeedbackPercent',
      };
      parameterKey = modDelayKeys[key] ?? key;
      if (key === 'mix' && value > 1) parameterValue = value / 100;
    } else if (this.algorithm === 'vinyl-flick') {
      const vinylFlickKeys: Record<string, string> = {
        speed: 'vinylFlickSpeed', 'vinyl-flick.speed': 'vinylFlickSpeed', vinylFlickSpeed: 'vinylFlickSpeed',
        'return-time': 'vinylFlickReturnTimeSeconds', return_time_seconds: 'vinylFlickReturnTimeSeconds',
        returnTimeSeconds: 'vinylFlickReturnTimeSeconds', 'vinyl-flick.return-time': 'vinylFlickReturnTimeSeconds',
        brake: 'vinylFlickBrakePercent', brake_percent: 'vinylFlickBrakePercent',
        brakePercent: 'vinylFlickBrakePercent', 'vinyl-flick.brake': 'vinylFlickBrakePercent',
        mix: 'mix', 'vinyl-flick.mix': 'mix',
      };
      parameterKey = vinylFlickKeys[key] ?? key;
      if (parameterKey === 'mix' && value > 1) parameterValue = value / 100;
    }
    this.parameters = { ...this.parameters, [parameterKey]: parameterValue };
    this.node?.port.postMessage({ type: 'configure', parameters: { [parameterKey]: parameterValue } });
  }

  /** Return a copy of the canonical authored controls for source-aware routes. */
  getParameterSnapshot(): Readonly<BrowserFxParameters> {
    return { ...this.parameters };
  }

  setBypass(bypass: boolean): void {
    if ((this.algorithm === 'beat-repeat' || this.algorithm === 'beat-scatter' || this.algorithm === 'roll' || this.algorithm === 'pattern-slicer' || this.algorithm === 'step-slicer') && this.bypassed && !bypass) {
      // Activation starts a fresh local tempo phase for these sample-clocked
      // effects rather than resuming stale state.
      this.node?.port.postMessage({ type: 'reset' });
    }
    this.bypassed = bypass;
    this.node?.port.postMessage({ type: 'set-bypass', value: bypass, rampFrames: 128 });
  }

  /** Send a bounded, absolute-frame MIDI note event to this OSC VOC slot. */
  sendMidiNote(event: { channel: number; note: number; velocity: number; noteOn: boolean; frame: number }): boolean {
    if (this.algorithm !== 'osc-voc' || this.disposed) return false;
    if (!Number.isInteger(event.channel) || event.channel < 1 || event.channel > 16
        || !Number.isInteger(event.note) || event.note < 0 || event.note > 127
        || !Number.isSafeInteger(event.frame) || event.frame < 0
        || (event.noteOn && (!Number.isInteger(event.velocity) || event.velocity < 0 || event.velocity > 127))) {
      this.reportError('OSC VOC MIDI event fields are invalid.');
      return false;
    }
    const message: BrowserMidiNoteMessage = event.noteOn
      ? { type: 'midi-note-on', channel: event.channel, note: event.note, velocity: event.velocity, frame: event.frame }
      : { type: 'midi-note-off', channel: event.channel, note: event.note, frame: event.frame };
    if (this.node) {
      this.node.port.postMessage(message);
      return true;
    }
    if (this.pendingMidiMessages.length >= MAX_PENDING_MIDI_EVENTS) {
      this.reportError(`OSC VOC MIDI queue is full (${MAX_PENDING_MIDI_EVENTS} events).`);
      return false;
    }
    this.pendingMidiMessages.push(message);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.input.disconnect();
    this.node?.disconnect();
    this.output.disconnect();
    this.node = null;
  }

  private async installProcessor(onFailure?: (error: Error) => void): Promise<void> {
    if (!this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') return;
    try {
      await this.ensureModule();
      if (this.disposed) return;

      const node = new AudioWorkletNode(this.context, 'rc505-fx-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: {
          algorithm: this.algorithm,
          sampleRate: this.context.sampleRate,
          parameters: this.parameters,
          bypassed: this.bypassed,
        },
      });
      this.input.disconnect(this.output);
      this.input.connect(node);
      node.connect(this.output);
      this.node = node;
      node.onprocessorerror = () => {
        if (this.disposed || this.node !== node) return;
        // A dead processor cannot respond to a bypass message. Restore a
        // direct audible wire and surface the failed route to its host.
        this.input.disconnect();
        node.disconnect();
        this.input.connect(this.output);
        this.node = null;
        this.reportError(`Browser ${this.name} AudioWorklet processor failed; slot is bypassed.`);
      };
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: unknown; message?: unknown } | null;
        if (message?.type === 'error' && typeof message.message === 'string') this.reportError(message.message);
      };

      // Preserve any fader or activation changes made while the module loaded.
      node.port.postMessage({ type: 'configure', parameters: this.parameters });
      node.port.postMessage({ type: 'set-bypass', value: this.bypassed, rampFrames: 0 });
      this.flushPendingMidiMessages();
    } catch (unknownError) {
      // Keep the direct dry route as the safe, audible fallback. The hosting
      // engine's primary DSP API surfaces module failures to its caller.
      this.error = unknownError instanceof Error ? unknownError.message : String(unknownError);
      onFailure?.(new Error(this.error));
    }
  }

  private reportError(message: string): void {
    this.error = message;
    this.onFailure?.(new Error(message));
  }

  private flushPendingMidiMessages(): void {
    const node = this.node;
    if (!node || this.pendingMidiMessages.length === 0) return;
    const firstRequestedFrame = this.pendingMidiMessages.reduce(
      (minimum, event) => Math.min(minimum, event.frame), Number.MAX_SAFE_INTEGER,
    );
    const safeFrame = Math.ceil((this.context.currentTime * this.context.sampleRate) + this.context.sampleRate * 0.03);
    const shift = Math.max(0, safeFrame - firstRequestedFrame);
    for (const event of this.pendingMidiMessages) {
      node.port.postMessage({ ...event, frame: event.frame + shift });
    }
    this.pendingMidiMessages = [];
  }
}
