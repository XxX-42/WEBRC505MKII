import { BrowserOfficialReverseReverbDsp } from './BrowserOfficialReverseReverbDsp';
import { officialDynamicsProfile } from './OfficialDynamicsProfiles';
import { BrowserOfficialRollDsp } from './BrowserOfficialRollDsp';
import { BrowserOfficialStepSlicerDsp } from './BrowserOfficialStepSlicerDsp';
import { BrowserOfficialDelayDsp } from './BrowserOfficialDelayDsp';
import { OfficialBrowserControlState, officialRateHz } from './OfficialBrowserParameters';
import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';
import { equalPowerFadeInGain, equalPowerFadeOutGain } from '../../dsp/equalPowerCrossfade';
import { BeatRepeatDsp } from './BeatRepeatDsp';
import { LoFiDsp, type LoFiDspParameters } from './LoFiDsp';
import { EqualizerDsp, type EqualizerDspParameters } from './EqualizerDsp';
import { BrowserPanningDelayDsp } from './BrowserPanningDelayDsp';
import { BrowserModDelayDsp } from './BrowserModDelayDsp';
import { BrowserTapeEchoDsp } from './BrowserTapeEchoDsp';
import { BrowserTwistDsp } from './BrowserTwistDsp';
import { BrowserGranularDelayDsp } from './BrowserGranularDelayDsp';
import { BrowserRadioDsp } from './BrowserRadioDsp';
import { BrowserVibratoDsp } from './BrowserVibratoDsp';
import { BrowserSustainerDsp } from './BrowserSustainerDsp';
import { BrowserIsolatorDsp } from './BrowserIsolatorDsp';
import { BrowserSlowGearDsp } from './BrowserSlowGearDsp';
import { BrowserBeatScatterDsp } from './BrowserBeatScatterDsp';
import { BrowserBeatShiftDsp } from './BrowserBeatShiftDsp';
import { BrowserReverseDelayDsp } from './BrowserReverseDelayDsp';
import { BrowserReverseReverbDsp } from './BrowserReverseReverbDsp';
import { BrowserAutoRiffDsp } from './BrowserAutoRiffDsp';
import { BrowserHrmAutoDsp } from './BrowserHrmAutoDsp';
import { BrowserRobotDsp } from './BrowserRobotDsp';
import { BrowserPatternSlicerDsp } from './BrowserPatternSlicerDsp';
import { BrowserStepSlicerDsp } from './BrowserStepSlicerDsp';
import { BrowserVinylFlickDsp } from './BrowserVinylFlickDsp';
import { BrowserPreampDsp } from './BrowserPreampDsp';
import { BrowserSynthDsp } from './BrowserSynthDsp';
import { BrowserG2bDsp } from './BrowserG2bDsp';
import { BrowserVocoderCore } from '../vocoder/BrowserVocoderCore';
import { BrowserOscBotCore } from '../BrowserOscBotCore';
import { BrowserOscVocCore } from '../BrowserOscVocCore';
import { BrowserRollDsp } from './BrowserRollDsp';
import { BrowserFreezeDsp } from './BrowserFreezeDsp';
import { BrowserWarpDsp } from './BrowserWarpDsp';
import { BrowserElectricDsp } from './BrowserElectricDsp';

/**
 * Deliberately limited, clean-room browser DSP core. The implemented catalog
 * functions are LPF/BPF/HPF (matrix IDs 1–3), FLANGER (ID 5), RING.MOD
 * (ID 9), DIST (ID 24), DYNAMICS (ID 25), DELAY (ID 36), CHORUS (ID 46),
 * PHASER (ID 4), AUTO PAN (ID 29), TREMOLO (ID 32), REVERB (ID 47), GATE
 * REVERB (ID 48), and
 * BEAT REPEAT (ID 51), LO-FI (ID 7), EQ (ID 26), MANUAL PAN (ID 30),
 * TAPE ECHO (ID 40), PANNING DELAY (ID 37), GRANULAR DELAY (ID 41),
 * RADIO (ID 8), SUSTAINER (ID 11), VIBRATO (ID 33), SLOW GEAR (ID 13),
 * and ISOLATOR (three-band crossover plus tempo-rate gate), PATTERN SLICER
 * (sample-clocked preset gate tables with raised-cosine step edges), STEP SLICER
 * (editable sample-clocked 16-value amplitude sequence with optional pan/filter), REVERSE DELAY
 * (beat-quantized reverse-segment capture with overlap crossfade), experimental
 * REVERSE REVERB (segmented reverse-source feed into a 16-line stereo FDN), BEAT SCATTER
 * (bounded tempo-slice capture with deterministic quantized grain read heads),
 * experimental VINYL FLICK (bounded causal live-stream platter reader), and
 * PREAMP (2x anti-aliased nonlinear stage, tone stack and analytic cabinet FIR),
 * SYNTH (decimated monophonic YIN tracker, polyBLEP resynthesis and TPT-SVF),
 * G2B (decimated YIN tracker, fixed octave-down square resynthesis and body SVF),
 * and ELECTRIC (pitch-snap/classic, sine ring-mod/metallic, ERB vocoder, or
 * sample-rate-held/bit-quantized character paths).
 * This is not a Roland topology/factory-DSP reproduction.
 *
 * Provenance and algorithmic latency:
 * - LPF/BPF/HPF: supplied contract formulas F01/F03; existing project
 *   TptStateVariableFilter primitive; 0 samples algorithmic latency.
 * - RING.MOD: supplied report formula F29, y=(1-m)x+m*x*carrier(phi), with
 *   sine retained as the bit-exact default and a crossfaded, harmonic-limited
 *   triangle option; 0 samples algorithmic latency. The triangle table uses
 *   fixed Fourier tiers and is not a complete quality/alias acceptance.
 * - DIST: catalog ID 24. Four-times zero-stuffed, Blackman-windowed sinc FIR
 *   interpolation and decimation around first-order ADAA; three analytic,
 *   clean-room curves (tanh overdrive, hard clip, asymmetric fuzz), with F01
 *   control smoothing. The paired 65-tap linear-phase filters give 16 samples
 *   of algorithmic latency. No WDF, Roland source, or proprietary/GPL code.
 * - PREAMP: catalog ID 23. Two-times Blackman-windowed sinc interpolation and
 *   decimation around an analytic asymmetric ADAA transfer, followed by a
 *   smoothed RBJ low/mid/high tone stack and a clean-room 129-tap FIR generated
 *   from authored analytic causal/minimum-phase-style speaker sections. The oversampling pair
 *   contributes 16 samples of fixed group delay; cabinet phase is frequency
 *   dependent. No measured cabinet IR, Roland source, or code.
 * - FLANGER: ID 5, supplied F01/F05/F06/F14 functional formulas; stereo
 *   4-point Lagrange modulated delay, sine LFO, low-pass/tanh-limited feedback;
 *   <1 sample interpolation latency, with intentional audible delay only.
 * - DYNAMICS: ID 25, supplied F01/F08 clean-room compressor; stereo-linked
 *   peak/RMS detector with attack/release smoothing and a log soft knee; no
 *   lookahead and 0 samples algorithmic latency.
 * - SUSTAINER: ID 11, clean-room stereo-linked peak leveler, hysteretic noise
 *   gate and bounded output limiter. A 2 ms attack, threshold-relative
 *   -18/-24 dB gate hysteresis, and 1/60 ms gate opening/closing are explicit
 *   provisional laws; user release controls compressor release. No lookahead
 *   or algorithmic latency.
 * - DELAY: ID 36, supplied F01/F05/F14/F20 functional formulas; fixed-memory
 *   stereo circular buffers, 4-point Lagrange read, one-pole feedback damping
 *   and bounded tanh feedback. Intentional delay only; no added fixed latency.
 * - PANNING DELAY: ID 37, supplied F05/F14/F20/F21 functional reconstruction;
 *   two 4-point Lagrange lines, orthogonal channel-swap cross-feedback, and an
 *   equal-power repeat panner. Intentional delay only, with no fixed latency.
 * - CHORUS: ID 46, supplied F01/F05/F06/F21 formulas; two decorrelated stereo
 *   4-point Lagrange delay voices by default (four selectable), smoothed LFO,
 *   filtered/bounded feedback; intentional 5–30 ms delay only, no added fixed
 *   latency. All chorus DSP is a clean-room functional reconstruction.
 * - PHASER: ID 4, supplied F01/F04/F06 functional formulas; clean-room cascade
 *   of 4 or 8 first-order all-pass sections with a stereo-quadrature LFO sweep
 *   and bounded feedback. 0 samples algorithmic latency; no BI-PHASE claim.
 * - TREMOLO: ID 32, supplied F01/F06 functional formulas; smoothed amplitude
 *   LFO with sine/triangle/band-limited square shapes and bounded 0..1 gain.
 *   0 samples algorithmic latency; no tempo-sync claim.
 * - AUTO PAN: ID 29, supplied F01/F06/F21 functional formulas; equal-power
 *   mono pan and stereo mid/side panning with a smoothed sine/triangle/
 *   band-limited-square LFO. 0 samples latency; no tempo-sync claim.
 * - VIBRATO: ID 33, supplied F01/F05/F06 functional contract; wet-only stereo
 *   modulated delay with four-point Lagrange reads, smoothed sine LFO and an
 *   authored quadrature channel offset. The base delay is intentional; no
 *   fixed algorithmic latency, no Roland source or code.
 * - REVERB: supplied contract F17, normalized Householder-orthogonal FDN8,
 *   per-line RT60 gains, one-pole damping, sub-sample delay modulation, plus an
 *   authored 7-tap sparse early-reflection FIR; 0 samples algorithmic latency
 *   (reflection delays are part of the modeled room response). The design is
 *   clean-room and uses no Roland
 *   source, samples, measured impulse response, or proprietary/GPL code.
 * - GATE REVERB: supplied F01/F08/F17 functional contract; reuses the clean-room
 *   FDN8 return above and applies a bounded stereo-linked input-sidechain peak
 *   gate with threshold hysteresis, hold, and exponential release. Controls
 *   and gate law are provisional authored choices; no Roland source or code.
 * - BEAT REPEAT: supplied functional reconstruction; fixed dual-buffer slice
 *   capture, sample-clock retrigger, direction/decay controls and authored
 *   equal-power loop-boundary crossfades. Routed only through Browser Track FX.
 * - BEAT SCATTER: clean-room fixed dual-buffer tempo-slice capture with seeded
 *   PRNG ordering of quantized grains, slice-latched read/pitch controls and a
 *   bounded short read-head transition. The one-slice capture latency is
 *   intentional; the provisional controls are not Roland specifications.
 * - STEREO ENHANCE: F01/F04/F22 clean-room mid/side width, low-frequency side
 *   protection and two first-order all-pass side decorrelators. A side limiter
 *   protects inter-channel polarity when widening. No fixed latency.
 * - SLOW GEAR: F01/F27 clean-room short-window energy onset detector with an
 *   adaptive inactive baseline and raised-cosine attack ramp. The current
 *   sample participates in detection, so there are 0 fixed pipeline samples;
 *   the selected attack duration is intentional. No Roland source or code.
 * - ISOLATOR: F01/F03/F16/F20 clean-room LR4-style TPT crossover branches,
 *   complementary mid residual, smoothed band gains and sample-clocked
 *   BPM-following gate. Gate phase is local/free-running; no Roland source or
 *   code.
 * - REVERSE DELAY: F14/F20/F25 clean-room alternating fixed stereo segments,
 *   beat-quantized capture, backward reads and equal-power overlap transitions.
 *   A full segment is captured before reverse playback; the reported buffering
 *   latency is one segment at the active tempo. No Roland source or code.
 * - REVERSE REVERB: experimental F17/F18/F25 clean-room beat-quantized source
 *   segments read backward through an independent stereo FDN16, with bounded
 *   feedback and equal-power segment overlap. One captured segment adds
 *   tempo-dependent pre-delay; the return is provisional and not quality-
 *   accepted. No factory-firmware claim, Roland source, or code.
 *
 * All buffers are allocated during construction. `processBlock` only loops
 * over caller-owned channel arrays and its fixed internal state; it does not
 * allocate, grow memory, create nodes, log, or depend on a fixed render size.
 */

export type BrowserFxAlgorithm = 'lpf' | 'bpf' | 'hpf' | 'flanger' | 'ring-mod' | 'reverb' | 'gate-reverb' | 'distortion' | 'dynamics' | 'sustainer' | 'delay' | 'panning-delay' | 'mod-delay' | 'chorus' | 'phaser' | 'tremolo' | 'auto-pan' | 'beat-repeat' | 'beat-scatter' | 'roll' | 'freeze' | 'warp' | 'beat-shift' | 'reverse-delay' | 'reverse-reverb' | 'pattern-slicer' | 'step-slicer' | 'stereo-enhance' | 'lo-fi' | 'eq' | 'manual-pan' | 'tape-echo' | 'twist' | 'granular-delay' | 'radio' | 'vibrato' | 'slow-gear' | 'isolator' | 'vinyl-flick' | 'preamp' | 'synth' | 'g2b' | 'vocoder' | 'osc-voc' | 'osc-bot' | 'electric' | 'auto-riff' | 'hrm-auto' | 'robot';
export type BrowserDistortionMode = 'overdrive' | 'hard-clip' | 'fuzz';
export type BrowserDynamicsDetector = 'peak' | 'rms';
export type BrowserTremoloWaveform = 'sine' | 'triangle' | 'square';

export interface BrowserFxParameters {
  /** Manual-aligned controls; admitted keys are in BROWSER_OFFICIAL_PARAMETER_KEYS. */
  [key: `official_${string}`]: number | undefined;
  cutoffHz?: number;
  q?: number;
  /** LPF/HPF catalog control in percent; mapped to the project's SVF Q curve. */
  filterResonancePercent?: number;
  mix?: number;
  decaySeconds?: number;
  dampingHz?: number;
  gateThresholdDb?: number;
  gateHoldMs?: number;
  gateReleaseMs?: number;
  ringModHz?: number;
  ringModDepth?: number;
  /** 0 = sine (default), 1 = band-limited triangle carrier. */
  ringModWaveform?: number;
  driveDb?: number;
  outputDb?: number;
  distortionMode?: BrowserDistortionMode;
  flangerDelayMs?: number;
  flangerRateHz?: number;
  flangerDepth?: number;
  flangerFeedback?: number;
  thresholdDb?: number;
  ratio?: number;
  kneeDb?: number;
  attackMs?: number;
  releaseMs?: number;
  dynamicsDetector?: BrowserDynamicsDetector;
  delayTimeMs?: number;
  delayFeedback?: number;
  delayToneHz?: number;
  modDelayTimeMs?: number;
  modDelayRateHz?: number;
  modDelayDepthMs?: number;
  modDelayFeedbackPercent?: number;
  panningDelayTimeMs?: number;
  panningDelayFeedback?: number;
  panningDelayPan?: number;
  chorusDelayMs?: number;
  chorusRateHz?: number;
  chorusDepthMs?: number;
  chorusVoices?: number;
  chorusFeedback?: number;
  chorusToneHz?: number;
  phaserRateHz?: number;
  phaserDepth?: number;
  phaserFeedback?: number;
  phaserStages?: number;
  tremoloRateHz?: number;
  tremoloDepth?: number;
  tremoloWaveform?: BrowserTremoloWaveform;
  autoPanRateHz?: number;
  autoPanDepth?: number;
  autoPanWaveform?: BrowserTremoloWaveform;
  /** Beat-repeat clock and slice controls; clocked values latch at a slice boundary. */
  bpm?: number;
  /** Host meter metadata. Never opts a legacy patch into official DSP. */
  quarterNotesPerMeasure?: number;
  division?: number;
  decay?: number;
  direction?: number;
  /** Beat-scatter clock and grain controls; changes latch at a slice boundary. */
  beatScatterSliceBeats?: number;
  beatScatterScatterPercent?: number;
  beatScatterPitchSemitones?: number;
  beatScatterRepeats?: number;
  /** ROLL sample clock and controls; changes latch at a slice boundary. */
  rollSliceBeats?: number;
  rollDecayPercent?: number;
  rollPitchSemitones?: number;
  rollDirection?: number;
  /** FREEZE micro-loop mode only. Spectral mode is explicitly unsupported. */
  freezeCaptureLengthMs?: number;
  freezePitchSemitones?: number;
  freezeEnabled?: number;
  freezeMode?: number;
  /** Experimental WARP granular capture and normalized FDN8 controls. */
  warpCaptureBeats?: number;
  warpSmearPercent?: number;
  warpPitchSemitones?: number;
  warpFeedbackPercent?: number;
  warpFreezeEnabled?: number;
  /** App-level BEAT SHIFT contract; bounds are provisional, not Roland limits. */
  beatShiftOffsetBeats?: number;
  beatShiftCrossfadeMs?: number;
  reverseDelaySegmentBeats?: number;
  reverseDelayFeedback?: number;
  reverseDelayCrossfadeMs?: number;
  /** Experimental REVERSE REVERB controls; bounds are provisional. */
  reverseReverbSegmentBeats?: number;
  reverseReverbFeedbackPercent?: number;
  reverseReverbCrossfadeMs?: number;
  reverseReverbDecaySeconds?: number;
  reverseReverbDampingCutoffHz?: number;
  /** PATTERN SLICER authored table and tempo-synchronized gate controls. */
  patternSlicerPattern?: number;
  patternSlicerRateBeats?: number;
  patternSlicerDepthPercent?: number;
  patternSlicerEdgeMs?: number;
  /** STEP SLICER authored editable-sequence controls; step count accepts 0..2 enum or 4/8/16. */
  stepSlicerStepCount?: number;
  stepSlicerRateBeats?: number;
  stepSlicerDepthPercent?: number;
  stepSlicerPanDepthPercent?: number;
  stepSlicerFilterHz?: number;
  stepSlicerStep01?: number;
  stepSlicerStep02?: number;
  stepSlicerStep03?: number;
  stepSlicerStep04?: number;
  stepSlicerStep05?: number;
  stepSlicerStep06?: number;
  stepSlicerStep07?: number;
  stepSlicerStep08?: number;
  stepSlicerStep09?: number;
  stepSlicerStep10?: number;
  stepSlicerStep11?: number;
  stepSlicerStep12?: number;
  stepSlicerStep13?: number;
  stepSlicerStep14?: number;
  stepSlicerStep15?: number;
  stepSlicerStep16?: number;
  /** STEREO ENHANCE controls: width is a 0..2 mid/side scale. */
  stereoWidth?: number;
  stereoLowMonoCutoffHz?: number;
  stereoDecorrelation?: number;
  loFiBitDepth?: number;
  loFiSampleRateHz?: number;
  loFiFilterHz?: number;
  eqLowFrequencyHz?: number;
  eqLowGainDb?: number;
  eqMid1FrequencyHz?: number;
  eqMid1Q?: number;
  eqMid1GainDb?: number;
  eqMid2FrequencyHz?: number;
  eqMid2Q?: number;
  eqMid2GainDb?: number;
  eqHighFrequencyHz?: number;
  eqHighGainDb?: number;
  manualPanPosition?: number;
  tapeEchoTimeMs?: number;
  tapeEchoFeedback?: number;
  tapeEchoWow?: number;
  tapeEchoSaturation?: number;
  tapeEchoToneHz?: number;
  /** TWIST signed macro position and stepped trajectory (0 Smooth, 1 Rise, 2 Fall, 3 Stepped). */
  twistAmount?: number;
  twistTrajectory?: number;
  granularGrainSizeMs?: number;
  granularDensityHz?: number;
  granularPitchSemitones?: number;
  granularPositionJitterPercent?: number;
  granularFeedbackPercent?: number;
  radioBand?: number;
  radioDrive?: number;
  radioNoise?: number;
  vibratoRateHz?: number;
  vibratoDepthPercent?: number;
  vibratoDelayMs?: number;
  slowGearAttackMs?: number;
  slowGearSensitivityPercent?: number;
  isolatorLowGainDb?: number;
  isolatorMidGainDb?: number;
  isolatorHighGainDb?: number;
  isolatorGateRateBeats?: number;
  isolatorGateDepthPercent?: number;
  /** VINYL FLICK provisional controls. speed 0 is nominal 1x, -100 stop, +100 2x. */
  vinylFlickSpeed?: number;
  vinylFlickReturnTimeSeconds?: number;
  vinylFlickBrakePercent?: number;
  preampModel?: number;
  preampGainPercent?: number;
  preampBassDb?: number;
  preampMiddleDb?: number;
  preampTrebleDb?: number;
  preampLevelDb?: number;
  synthSensitivity?: number;
  synthWaveform?: number;
  synthOctave?: number;
  synthToneHz?: number;
  synthMixPercent?: number;
  /** ELECTRIC source #17 clean-room character-bank controls. */
  electricCharacter?: number;
  electricPitchSnapPercent?: number;
  electricToneHz?: number;
  g2bTrackingPercent?: number;
  g2bBlendPercent?: number;
  g2bBodyHz?: number;
  /** Browser VOCODER clean-room controls; `mix` remains the shared 0..1 wet mix. */
  vocoderBands?: number;
  vocoderCarrier?: number;
  /** MIDI oscillator carrier through the reusable VOCODER filterbank. */
  oscVocWaveform?: number;
  oscVocMidiChannel?: number;
  oscVocOctave?: number;
  oscVocBands?: number;
  /** OSC BOT authored carrier-bank and step-sequence controls. */
  oscBotWaveform?: number;
  oscBotPattern?: number;
  oscBotToneHz?: number;
  /** AUTO RIFF experiment analysis and sample-clocked Signalsmith commands. */
  autoRiffOfficialTempo?: number;
  autoRiffHold?: number;
  autoRiffAttack?: number;
  autoRiffLoop?: number;
  autoRiffKey?: number;
  hrmAutoOfficialManualVoice?: number;
  hrmAutoOfficialVoice?: number;
  hrmAutoOfficialHrmMode?: number;
  robotNote?: number;
  autoRiffScale?: number;
  autoRiffRateBeats?: number;
  autoRiffSensitivityPercent?: number;
  /** Experimental HRM AUTO (M) interval selection and MIDI channel. */
  hrmAutoKey?: number;
  hrmAutoScale?: number;
  hrmAutoMidiChannel?: number;
  hrmAutoMixPercent?: number;
  /** Experimental ROBOT quantized fixed semitone offset; formant is host-side. */
  robotPitch?: number;
  robotFormantSemitones?: number;
  /** Generic amount remains a wet mix; these are dedicated ROLL controls. */
}

export interface BrowserFxAlgorithmInfo {
  readonly catalogFunction: string;
  readonly formulaIds: readonly string[];
  /** Reference latency in samples (48 kHz, default controls) where it is control-dependent. */
  readonly algorithmicLatencySamples: number;
  /** Optional full-system impulse peak in samples at 48 kHz; distinct from fixed algorithmic group delay. */
  readonly impulseResponsePeakSamplesAt48k?: number;
  /** Declares an effect-specific lack of wet/dry control even though the shared parameter bag has `mix`. */
  readonly supportsDryWetMix?: false;
  /** Optional quality gate; experimental algorithms must not be counted as accepted contracts. */
  readonly implementationStatus?: 'experimental' | 'quality-accepted';
  readonly cleanRoomProvenance: string;
}

export const BROWSER_FX_ALGORITHM_INFO: Readonly<Record<BrowserFxAlgorithm, BrowserFxAlgorithmInfo>> = {
  lpf: {
    catalogFunction: 'LPF (catalog ID 1)',
    formulaIds: ['F01', 'F03'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Supplied formula contract plus the repository TptStateVariableFilter primitive; no Roland source or code.',
  },
  bpf: {
    catalogFunction: 'BPF (catalog ID 2)',
    formulaIds: ['F01', 'F03'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Supplied formula contract plus the repository TptStateVariableFilter primitive; no Roland source or code.',
  },
  hpf: {
    catalogFunction: 'HPF (catalog ID 3)',
    formulaIds: ['F01', 'F03'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Supplied formula contract plus the repository TptStateVariableFilter primitive; no Roland source or code.',
  },
  'ring-mod': {
    catalogFunction: 'RING.MOD (catalog ID 9)',
    formulaIds: ['F01', 'F06', 'F29'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Supplied report F29 sine-carrier equation with a sine default and selectable, harmonic-limited triangle wavetable; no Roland source or code. Triangle alias/quality acceptance remains open.',
  },
  distortion: {
    catalogFunction: 'DIST (catalog ID 24)',
    formulaIds: ['F01', 'F07'],
    algorithmicLatencySamples: 16,
    cleanRoomProvenance: 'Clean-room tanh/hard-clip/asymmetric ADAA curves inside 4x Blackman-windowed sinc FIR interpolation/decimation; no Roland source, WDF model, or external DSP code.',
  },
  preamp: {
    catalogFunction: 'PREAMP (catalog ID 23)',
    formulaIds: ['F02', 'F07', 'F18', 'F23'],
    algorithmicLatencySamples: 16,
    impulseResponsePeakSamplesAt48k: 18,
    supportsDryWetMix: false,
    cleanRoomProvenance: 'Clean-room 2x Blackman-windowed sinc oversampling with antiderivative anti-aliased asymmetric soft clipping, smoothed three-band tone stack and authored analytic causal/minimum-phase-style 129-tap cabinet response. The oversampling pair contributes 16 fixed samples; cabinet phase moves the full impulse peak to sample 18 at 48 kHz with default controls. PREAMP has no wet/dry control, so dry-path alignment is not part of its contract. Amp styles and cabinet voicing are provisional; no Roland source, measured IR, or code.',
  },
  synth: {
    catalogFunction: 'SYNTH (catalog ID 6)',
    formulaIds: ['F03', 'F06', 'F10', 'F27'],
    algorithmicLatencySamples: 2_868,
    supportsDryWetMix: false,
    cleanRoomProvenance: 'Clean-room decimated YIN-style monophonic F0 analysis, onset/envelope following, polyBLEP saw/square and integrated triangle, fixed octave-down sub voice, and TPT state-variable filter. At 48 kHz the lowest 55 Hz note needs a ~54.8 ms analysis frame plus one 5 ms hop and two-frame voiced confirmation (about 59.8 ms before synthesized attack); no original Roland source, code, or hardware behavior is claimed.',
  },
  g2b: {
    catalogFunction: 'G2B (catalog ID 10)',
    formulaIds: ['F09', 'F10', 'F11'],
    algorithmicLatencySamples: 2_868,
    cleanRoomProvenance: 'Clean-room decimated YIN-style mono F0 analysis, fixed -12 semitone square/polyBLEP resynthesis and TPT-SVF body cutoff; a user blend control crossfades resynthesized bass with input. No TD-PSOLA, original hardware topology/source/code, or quality acceptance; at 48 kHz a 55 Hz source needs about 60 ms for acquisition before smoothing.',
  },
  vocoder: {
    catalogFunction: 'VOCODER (catalog source #20)',
    formulaIds: ['F01', 'F03', 'F13'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room ERB-spaced 8–24 band TPT analysis/resynthesis bank with bounded attack/release envelope followers and polyBLEP saw/square internal carriers. Formant shift is explicitly unsupported; no Roland source, code, or sound-quality acceptance.',
  },
  electric: {
    catalogFunction: 'ELECTRIC (catalog source ID 17)',
    formulaIds: ['F03', 'F09', 'F10', 'F13', 'F28', 'F29'],
    algorithmicLatencySamples: 2_868,
    cleanRoomProvenance: 'Clean-room four-path character bank: decimated YIN/polyBLEP quantized resynthesis, pitch-tracked sine ring modulation, reusable ERB/TPT vocoder, and Lo-Fi sample-rate-hold/quantization with a TPT tone low-pass. Voiced Classic/Metallic paths fail dry until pitch acquisition; controls and topology are provisional perceptual inferences with no Roland source, firmware, topology, or sound-quality acceptance claim.',
  },
  'osc-voc': {
    catalogFunction: 'OSC VOC (M) (catalog source #21)',
    formulaIds: ['F03', 'F06', 'F13', 'F20'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room mono MIDI carrier uses polyBLEP saw/square/pulse through the same ERB analysis/envelope and per-band carrier filterbank as VOCODER and OSC BOT; fixed 16-band default and bounded 256-event sample-frame scheduler. No Roland source/code, stereo-unison, or sound-quality acceptance is claimed.',
  },
  'osc-bot': {
    catalogFunction: 'OSC BOT (catalog source #22)',
    formulaIds: ['F03', 'F06', 'F13', 'F20', 'F27'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room 16-band-default ERB carrier bank reuses the VOCODER analysis/envelope and per-band carrier filters, with polyBLEP saw/square and integrated BLEP-triangle oscillators, eight authored semitone sequences at a sample-clocked sixteenth-note cadence, and a resonant TPT low-pass. Patterns/topology are perceptual reconstructions; no Roland source/code or sound-quality acceptance is claimed.',
  },
  flanger: {
    catalogFunction: 'FLANGER (catalog ID 5)',
    formulaIds: ['F01', 'F05', 'F06', 'F14'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room 4-point Lagrange modulated delay, sine LFO, one-pole feedback damping and tanh feedback limiter from supplied functional formulas; no Roland source or code.',
  },
  dynamics: {
    catalogFunction: 'DYNAMICS (catalog ID 25)',
    formulaIds: ['F01', 'F08'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room stereo-linked peak/RMS compressor with attack/release detection and the supplied F08 logarithmic soft-knee curve; no lookahead, Roland source or code.',
  },
  sustainer: {
    catalogFunction: 'SUSTAINER (catalog ID 11)',
    formulaIds: ['F01', 'F08'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room stereo-linked peak envelope, threshold-relative upward/downward compression, hysteretic noise gate and bounded no-lookahead safety limiter; 2 ms attack and gate thresholds/times are provisional authored laws, with no Roland source or code.',
  },
  delay: {
    catalogFunction: 'DELAY (catalog ID 36)',
    formulaIds: ['F01', 'F05', 'F14', 'F20'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room stereo circular buffer with four-point Lagrange fractional reads, smoothed time, one-pole feedback damping and tanh-limited feedback from supplied functional formulas; no Roland source or code.',
  },
  'mod-delay': {
    catalogFunction: 'MOD DELAY (catalog ID 39)',
    formulaIds: ['F01', 'F05', 'F06', 'F14'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room long stereo fractional delay with smoothed LFO-modulated four-point Lagrange reads, filtered contractive feedback and bounded saturation; parameters are provisional and no Roland source or code is used.',
  },
  'panning-delay': {
    catalogFunction: 'PANNING DELAY (FX #37)',
    formulaIds: ['F05', 'F14', 'F20', 'F21'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room two-line cross-feedback delay with four-point Lagrange reads and equal-power repeat panning; matrix and pan interpretation are authored because the catalog gives only functional behavior; no Roland source or code.',
  },
  chorus: {
    catalogFunction: 'CHORUS (catalog ID 46)',
    formulaIds: ['F01', 'F05', 'F06', 'F21'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room two-voice stereo modulated fractional delay (four-point Lagrange) with phase-decorrelated LFOs and filtered, bounded feedback from supplied functional formulas; no Roland source or code.',
  },
  phaser: {
    catalogFunction: 'PHASER (catalog ID 4)',
    formulaIds: ['F01', 'F04', 'F06'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room four/eight-stage first-order all-pass cascade with stereo-quadrature sinusoidal coefficient sweep and bounded feedback from supplied functional formulas; no BI-PHASE mode, Roland source or code.',
  },
  tremolo: {
    catalogFunction: 'TREMOLO (catalog ID 32)',
    formulaIds: ['F01', 'F06'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room smoothed amplitude modulation with sine, triangle and polyBLEP band-limited square LFO shapes from supplied functional formulas; no tempo sync, Roland source or code.',
  },
  'auto-pan': {
    catalogFunction: 'AUTO PAN (catalog ID 29)',
    formulaIds: ['F01', 'F06', 'F21'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room equal-power mono panner and stereo mid/side autopan driven by smoothed sine, triangle or polyBLEP band-limited square LFO; no tempo sync, Roland source or code.',
  },
  reverb: {
    catalogFunction: 'REVERB (catalog ID 47)',
    formulaIds: ['F01', 'F17'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Supplied contract F17 with a normalized Householder FDN8 and authored sparse early-reflection FIR; no factory IR, Roland source, or code.',
  },
  'gate-reverb': {
    catalogFunction: 'GATE REVERB (catalog ID 48)',
    formulaIds: ['F01', 'F08', 'F17'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room normalized FDN8 reverb return with an input-sidechain stereo-linked peak gate, threshold hysteresis, hold and bounded release; gate law is provisional, with no Roland source or code.',
  },
  'beat-repeat': {
    catalogFunction: 'BEAT REPEAT (catalog ID 51)',
    formulaIds: ['F15', 'F20', 'F25'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room sample-clock capture/retrigger in bounded dual stereo buffers with authored equal-power loop crossfades; no Roland source or code.',
  },
  'beat-scatter': {
    catalogFunction: 'BEAT SCATTER (catalog ID 50)',
    formulaIds: ['F05', 'F09', 'F15', 'F20', 'F25'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room two-buffer tempo-slice capture with deterministic PRNG-ordered quantized grains, bounded linear pitch resampling and a short authored read-head transition; slice latency is intentional, with no Roland source or code.',
  },
  roll: {
    catalogFunction: 'ROLL (catalog ID 44)',
    formulaIds: ['F05', 'F15', 'F20', 'F25'],
    algorithmicLatencySamples: 12_000,
    cleanRoomProvenance: 'Clean-room sample-clocked stereo dual-buffer slice capture/retrigger with bounded four-point fractional playback-rate resampling, decay and direction controls. The default 0.5-beat slice is 12,000 reference samples at 48 kHz / 120 BPM; pitch changes playback rate and slice duration. Capture latency is intentional; no Roland source/code or sound-quality acceptance.',
  },
  freeze: {
    catalogFunction: 'FREEZE (catalog ID 45)',
    formulaIds: ['F12', 'F19', 'F25'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room bounded stereo micro-loop snapshot with a rolling pre-capture history, equal-power activation transition, linear seam overlap and varispeed loop playback. Spectral STFT mode is explicitly unsupported; captured audio is volatile and resets on reload. A complete history window is needed at startup or after reconfiguration, but there is no fixed pipeline latency. Pitch changes loop duration. It uses no Roland source/code and has no sound-quality acceptance.',
  },
  warp: {
    catalogFunction: 'WARP (catalog source ID 42)',
    formulaIds: ['F12', 'F15', 'F17', 'F19', 'F20'],
    algorithmicLatencySamples: 0,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental lower-tier clean-room tempo-sized stereo capture, bounded Hann-windowed granular pitch-smear reader and normalized Hadamard FDN8. The spectral mode is unavailable; startup/freeze waits for the selected capture window and is intentional rather than a fixed pipeline delay. Catalog topology is explicitly an authored perceptual inference, with no Roland source, code, fidelity, or sound-quality acceptance claim.',
  },
  'beat-shift': {
    catalogFunction: 'BEAT SHIFT (catalog source ID 52)',
    formulaIds: ['F20', 'F25'],
    algorithmicLatencySamples: 72_000,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental prototype; not quality-accepted as the contract FX. Clean-room shared stereo postmix buffer with a signed beat-offset read head and equal-power transition crossfades. Supporting live advances up to +4 beats requires a four-beat look-ahead baseline: offset 0 adds four beats of delay at the active BPM, while the provisional default +1 beat adds three beats (72,000 reference samples at 48 kHz / 120 BPM). Actual latency scales with sample rate, BPM and signed offset; the shared postmix path therefore adds multi-beat live output latency. Effect output uses only the shifted head; there is no independently time-aligned dry mix. Positive=toward FUTURE and negative=toward PAST are authored app conventions; the Roland/BOSS guide only confirms FUTURE/PAST and beat-length shift. No per-loop-track targeting; no Roland DSP source or code. Proper loop-playback read-head integration remains an implementation gap.',
  },
  'reverse-delay': {
    catalogFunction: 'REVERSE DELAY (catalog ID 38)',
    formulaIds: ['F14', 'F20', 'F25'],
    algorithmicLatencySamples: 24_000,
    cleanRoomProvenance: 'Clean-room alternating fixed stereo segments, beat-quantized timing, backward reads and equal-power crossfades; the default one-beat segment is fully captured before playback. Latency scales with BPM, segment length and sample rate; no Roland source or code.',
  },
  'reverse-reverb': {
    catalogFunction: 'REVERSE REVERB (catalog ID 49)',
    formulaIds: ['F17', 'F18', 'F25'],
    algorithmicLatencySamples: 12_000,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental clean-room prototype: beat-quantized stereo segments are read backward into an independent eight-line-per-channel FDN16 tail with one-pole damping and equal-power source-segment overlaps. Default 0.5-beat capture at 120 BPM contributes 250 ms of buffering pre-delay; actual segment latency scales with BPM, segment size and sample rate. FDN tail and quality remain provisional; no measured IR, factory-firmware topology, Roland source/code, or sound-quality acceptance is claimed.',
  },
  'vinyl-flick': {
    catalogFunction: 'VINYL FLICK (catalog source ID 53)',
    formulaIds: ['F05', 'F09', 'F26'],
    algorithmicLatencySamples: 2,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental clean-room second-order platter-speed model with a fixed 4-second stereo ring and four-point Lagrange variable-rate resampler; two samples of matched dry/wet lookahead plus periodic 10 ms phase-slip crossfades keep sustained slow/stalled reads audible. Because this is a causal live-stream insert, >1x targets are transient and clamp at available input; sustained >1x requires a source-aware read-ahead path. Controls and response are provisional, not quality-accepted; no Roland source or code.',
  },
  'pattern-slicer': {
    catalogFunction: 'PATTERN SLICER (catalog source ID 34)',
    formulaIds: ['F16', 'F20'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Sample-clocked, authored 16-step gate tables with tempo-selected step intervals and raised-cosine edge smoothing from the supplied functional description; presets and ranges are provisional, with no Roland source or code.',
  },
  'step-slicer': {
    catalogFunction: 'STEP SLICER (catalog source ID 35)',
    formulaIds: ['F01', 'F16', 'F20', 'F21'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room sample-clocked 16-value amplitude sequence with a 2 ms raised-cosine step transition, optional alternating stereo balance and one-pole low-pass; provisional authored controls, no Roland source or code.',
  },
  'stereo-enhance': {
    catalogFunction: 'STEREO ENHANCE (catalog ID 31)',
    formulaIds: ['F01', 'F04', 'F22'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room mid/side width with low-frequency side attenuation, two stable first-order all-pass decorrelators and a width-only polarity safety limiter; no Roland source or code.',
  },
  'lo-fi': {
    catalogFunction: 'LO-FI (catalog ID 7)',
    formulaIds: ['F28'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room fractional sample-rate hold with deterministic TPDF dithered quantization and one-pole post-filter; no Roland source or code.',
  },
  eq: {
    catalogFunction: 'EQ (catalog ID 26)',
    formulaIds: ['F01', 'F02'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room cascade of low/high RBJ shelves and two RBJ peaking biquads with coefficient ramps; no Roland source or code.',
  },
  'manual-pan': {
    catalogFunction: 'MANUAL PAN (catalog ID 30)',
    formulaIds: ['F01', 'F21'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room static equal-power mono pan and smoothed stereo balance; no Roland source or code.',
  },
  'tape-echo': {
    catalogFunction: 'TAPE ECHO (catalog ID 40)',
    formulaIds: ['F02', 'F05', 'F06', 'F07', 'F14', 'F20'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room three-head Lagrange tape delay, wow/flutter modulation, 2x ADAA record saturation, filtered hiss, frequency-dependent loss and contractive feedback; no Roland source or code; head delay is intentional.',
  },
  twist: {
    catalogFunction: 'TWIST (catalog source ID 43)',
    formulaIds: ['F01', 'F03', 'F05', 'F06', 'F07', 'F14', 'F21'],
    algorithmicLatencySamples: 0,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Clean-room signed macro curve drives a stereo four-point Lagrange variable-rate delay, contractive saturated feedback, one-pole tone and stereo balance. Amount automation creates the pitch trajectory; the four curve laws and parameter ranges are provisional because the referenced matrix is not present in this checkout. This prototype has no Roland source, code, or hardware-fidelity claim.',
  },
  'granular-delay': {
    catalogFunction: 'GRANULAR DELAY (catalog ID 41)',
    formulaIds: ['F05', 'F09', 'F15', 'F20'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room stereo Hann-windowed, fixed-pool granular resampling with four-point Lagrange history reads, deterministic position jitter and contractive feedback; no Roland source or code.',
  },
  radio: {
    catalogFunction: 'RADIO (catalog ID 8)',
    formulaIds: ['F02', 'F07', 'F28'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room TPT AM-narrow/AM-wide/FM band limits, midpoint 2x ADAA tanh saturation, deterministic colored noise and stochastic dropout; controls and noise character are authored provisional choices, with no Roland source or code.',
  },
  vibrato: {
    catalogFunction: 'VIBRATO (catalog ID 33)',
    formulaIds: ['F01', 'F05', 'F06'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room wet-only stereo modulated delay with four-point Lagrange reads, sine LFO, smoothed rate/depth/base delay and an authored quadrature channel offset; no Roland source or code.',
  },
  'slow-gear': {
    catalogFunction: 'SLOW GEAR (catalog ID 13)',
    formulaIds: ['F01', 'F27'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room short-window energy onset detector with an adaptive inactive baseline and a raised-cosine attack ramp; attack is intentional, with no fixed pipeline samples or Roland source/code.',
  },
  isolator: {
    catalogFunction: 'ISOLATOR (three-band crossover and rhythm gate)',
    formulaIds: ['F01', 'F03', 'F16', 'F20'],
    algorithmicLatencySamples: 0,
    cleanRoomProvenance: 'Clean-room LR4-style TPT crossover, residual mid band, smoothed gains and sample-clocked BPM-following gate; gate phase is local/free-running, with no Roland source or code.',
  },
  'auto-riff': {
    catalogFunction: 'AUTO RIFF (catalog ID 12)',
    formulaIds: ['F09', 'F10', 'F11', 'F16', 'F20'],
    algorithmicLatencySamples: 0,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental sample-clocked onset/F0 analyzer with a bounded YIN tracker and authored eight-step scale sequence, driving the separately pinned Signalsmith LIVE_FX shifter in the host. Detector and onset performance require a representative pitch/latency/aliasing admission suite; no Roland source, code, or sound-quality acceptance is claimed.',
  },
  'hrm-auto': {
    catalogFunction: 'HRM AUTO (M) (catalog ID 19)',
    formulaIds: ['F09', 'F10', 'F11'],
    algorithmicLatencySamples: 0,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental sample-clocked monophonic YIN analysis and bounded MIDI chord/scale target assignment driving separately pinned Signalsmith LIVE_FX shifters in the host. Polyphonic source tracking, voice-leading semantics, tuning and quality acceptance remain unverified; no Roland source, code or sound-quality acceptance is claimed.',
  },
  robot: {
    catalogFunction: 'ROBOT (catalog ID 16)',
    formulaIds: ['F09', 'F10', 'F11', 'F12'],
    // Default 48 kHz PSOLA core reference; the instance getter follows sample rate.
    algorithmicLatencySamples: 1_416,
    implementationStatus: 'experimental',
    cleanRoomProvenance: 'Experimental sample-clocked monophonic decimated-YIN tracking and semitone target quantization with a fixed-latency PSOLA-lite core and a separately pinned Signalsmith LIVE_FX fallback in the host. The core latency excludes tracker acquisition; BrowserRobotFX aligns both paths to max(PSOLA, Signalsmith) latency, not measured physical end-to-end delay. Polyphonic and unvoiced pitch tracking are unsupported; vendor formant compensation is enabled and anchored to tracked source F0, with zero shift expressing preserve intent and nonzero shift expressing independent envelope movement. Quality acceptance remains unverified and no Roland source or firmware semantics are asserted.',
  },
};

const TWO_PI = Math.PI * 2;
const DEFAULT_SMOOTHING_SECONDS = 0.015;
const FILTER_RESONANCE_PERCENT_CURVE_EXPONENT = 2.117350426267045;
export function filterResonancePercentToQ(percent: number): number {
  const normalized = clamp(percent, 0, 100) / 100;
  // Preserve the historical default coefficient exactly at the authored 15% default.
  if (normalized === 0.15) return Math.SQRT1_2;
  return 0.5 + 11.5 * (normalized ** FILTER_RESONANCE_PERCENT_CURVE_EXPONENT);
}
const RING_MOD_WAVETABLE_SIZE = 2048;
const RING_MOD_TRIANGLE_HARMONIC_TIERS = [63, 31, 15, 7, 3, 1] as const;

function createRingModTriangleTables(): readonly Float64Array[] {
  return RING_MOD_TRIANGLE_HARMONIC_TIERS.map((maximumHarmonic) => {
    const table = new Float64Array(RING_MOD_WAVETABLE_SIZE);
    for (let sample = 0; sample < table.length; sample += 1) {
      const phase = TWO_PI * sample / table.length;
      let value = 0;
      for (let harmonic = 1; harmonic <= maximumHarmonic; harmonic += 2) {
        const alternating = ((harmonic - 1) / 2) % 2 === 0 ? 1 : -1;
        value += alternating * Math.sin(harmonic * phase) / (harmonic * harmonic);
      }
      table[sample] = value;
    }
    let peak = 0;
    for (let sample = 0; sample < table.length; sample += 1) peak = Math.max(peak, Math.abs(table[sample] ?? 0));
    if (peak > 0) for (let sample = 0; sample < table.length; sample += 1) table[sample] = (table[sample] ?? 0) / peak;
    return table;
  });
}

// Built during module initialization, never from an AudioWorklet callback.
const RING_MOD_TRIANGLE_TABLES = createRingModTriangleTables();
const DEFAULT_DELAY_SECONDS = [0.0297, 0.0335, 0.0361, 0.0397, 0.0431, 0.0473, 0.0527, 0.0579] as const;
const EARLY_REFLECTION_DELAYS_SECONDS = [0, 0.0067, 0.0113, 0.0169, 0.0227, 0.0289, 0.0341] as const;
const EARLY_REFLECTION_GAINS_LEFT = [0.13, 0.068, -0.047, 0.035, -0.026, 0.021, -0.014] as const;
const EARLY_REFLECTION_GAINS_RIGHT = [0.13, -0.061, 0.052, -0.032, 0.024, -0.019, 0.016] as const;
const HOUSEHOLDER_ROW_SUM_FACTOR = 2 / 8;
const FDN_INJECTION_GAIN = 0.18 / Math.sqrt(8);
const FDN_OUTPUT_GAIN = 0.72 / Math.sqrt(8);
const EARLY_OUTPUT_GAIN = 0.65;
const MIN_STATE_MAGNITUDE = 1e-24;
const FDN_MODULATION_DEPTH_SAMPLES = 0.35;
const DISTORTION_OVERSAMPLE_FACTOR = 4;
const DISTORTION_FIR_TAPS = 65;
const DISTORTION_UPSAMPLE_INPUT_HISTORY = Math.ceil(DISTORTION_FIR_TAPS / DISTORTION_OVERSAMPLE_FACTOR);
const DISTORTION_INTERPOLATION_TAPS_BY_PHASE = [
  DISTORTION_UPSAMPLE_INPUT_HISTORY,
  DISTORTION_UPSAMPLE_INPUT_HISTORY - 1,
  DISTORTION_UPSAMPLE_INPUT_HISTORY - 1,
  DISTORTION_UPSAMPLE_INPUT_HISTORY - 1,
] as const;
const DISTORTION_FIR_CENTER = (DISTORTION_FIR_TAPS - 1) / 2;
const DISTORTION_CUTOFF_CYCLES_PER_OVERSAMPLE_SAMPLE = 0.117;
const DISTORTION_MODE_CROSSFADE_OVERSAMPLED_SAMPLES = 256;
const DISTORTION_DRY_DELAY_SAMPLES = 16;
const DISTORTION_BIAS = 0.12;
const FUZZ_SHARPNESS = 2.2;
// Fixed transfer-function bias; evaluate the identical value once per module.
const FUZZ_BIAS_TANH = Math.tanh(FUZZ_SHARPNESS * DISTORTION_BIAS);
const FLANGER_MAX_DELAY_MILLISECONDS = 10;
const FLANGER_MIN_DELAY_MILLISECONDS = 0.2;
const FLANGER_MAX_DEPTH_MILLISECONDS = 5;
const FLANGER_DEFAULT_DELAY_MILLISECONDS = 3;
const FLANGER_DEFAULT_RATE_HZ = 0.3;
const FLANGER_DEFAULT_DEPTH = 0.6;
const FLANGER_DEFAULT_FEEDBACK = 0.25;
const FLANGER_FEEDBACK_FILTER_HZ = 6000;
const DYNAMICS_DEFAULT_THRESHOLD_DB = -18;
const DYNAMICS_DEFAULT_RATIO = 4;
const DYNAMICS_DEFAULT_KNEE_DB = 6;
const DYNAMICS_DEFAULT_ATTACK_MS = 10;
const DYNAMICS_DEFAULT_RELEASE_MS = 120;
const DYNAMICS_ENVELOPE_FLOOR = 1e-9;
const GATE_REVERB_DEFAULT_THRESHOLD_DB = -24;
const GATE_REVERB_DEFAULT_HOLD_MS = 250;
const GATE_REVERB_DEFAULT_RELEASE_MS = 150;
const GATE_REVERB_DETECTOR_RELEASE_MS = 8;
const GATE_REVERB_HYSTERESIS_RATIO = 0.7071067811865476;
const GATE_REVERB_RELEASE_DB = 60;
const DELAY_MAX_TIME_MILLISECONDS = 2000;
const DELAY_MIN_TIME_MILLISECONDS = 1;
const DELAY_DEFAULT_TIME_MILLISECONDS = 500;
const DELAY_DEFAULT_FEEDBACK = 0.3;
const DELAY_DEFAULT_TONE_HZ = 8000;
const DELAY_DEFAULT_MIX = 0.25;
const CHORUS_MIN_DELAY_MILLISECONDS = 5;
const CHORUS_MAX_DELAY_MILLISECONDS = 30;
const CHORUS_DEFAULT_DELAY_MILLISECONDS = 15;
const CHORUS_DEFAULT_RATE_HZ = 0.8;
const CHORUS_DEFAULT_DEPTH_MILLISECONDS = 5;
const CHORUS_DEFAULT_VOICES = 2;
const CHORUS_DEFAULT_FEEDBACK = 0;
const CHORUS_DEFAULT_TONE_HZ = 8000;
const CHORUS_FEEDBACK_MAX = 0.5;
const PHASER_DEFAULT_RATE_HZ = 0.5;
const PHASER_DEFAULT_DEPTH = 0.65;
const PHASER_DEFAULT_FEEDBACK = 0.2;
const PHASER_DEFAULT_STAGES = 8;
const PHASER_FEEDBACK_MAX = 0.95;
const PHASER_MIN_FREQUENCY_HZ = 120;
const PHASER_MAX_FREQUENCY_HZ = 3000;
const PHASER_FEEDBACK_FILTER_HZ = 7000;
const PHASER_MAX_STAGES = 12;
const TREMOLO_DEFAULT_RATE_HZ = 4;
const TREMOLO_DEFAULT_DEPTH = 0.5;
const TREMOLO_MIN_RATE_HZ = 0.05;
const TREMOLO_MAX_RATE_HZ = 20;
const AUTO_PAN_DEFAULT_RATE_HZ = 0.5;
const AUTO_PAN_DEFAULT_DEPTH = 0.7;

function sinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function createDistortionFilters(): { interpolation: Float64Array; decimation: Float64Array } {
  const interpolation = new Float64Array(DISTORTION_FIR_TAPS);
  let coefficientSum = 0;
  for (let tap = 0; tap < DISTORTION_FIR_TAPS; tap += 1) {
    const centered = tap - DISTORTION_FIR_CENTER;
    const normalized = tap / (DISTORTION_FIR_TAPS - 1);
    const blackman = 0.42 - 0.5 * Math.cos(TWO_PI * normalized) + 0.08 * Math.cos(2 * TWO_PI * normalized);
    const coefficient = DISTORTION_OVERSAMPLE_FACTOR
      * 2
      * DISTORTION_CUTOFF_CYCLES_PER_OVERSAMPLE_SAMPLE
      * sinc(2 * DISTORTION_CUTOFF_CYCLES_PER_OVERSAMPLE_SAMPLE * centered)
      * blackman;
    interpolation[tap] = coefficient;
    coefficientSum += coefficient;
  }
  // The zero-stuffed interpolation stage needs gain L; this sets its DC sum to 4.
  const normalization = DISTORTION_OVERSAMPLE_FACTOR / coefficientSum;
  const decimation = new Float64Array(DISTORTION_FIR_TAPS);
  for (let tap = 0; tap < DISTORTION_FIR_TAPS; tap += 1) {
    interpolation[tap] = (interpolation[tap] ?? 0) * normalization;
    decimation[tap] = (interpolation[tap] ?? 0) / DISTORTION_OVERSAMPLE_FACTOR;
  }
  return { interpolation, decimation };
}

// Static coefficient storage is created once at module load, outside process().
const DISTORTION_FILTERS = createDistortionFilters();

function logCosh(value: number): number {
  const absolute = Math.abs(value);
  return absolute + Math.log1p(Math.exp(-2 * absolute)) - Math.LN2;
}

function distortionFunction(mode: BrowserDistortionMode, value: number): number {
  switch (mode) {
    case 'hard-clip':
      return clamp(value, -1, 1);
    case 'fuzz':
      return Math.tanh(FUZZ_SHARPNESS * (value + DISTORTION_BIAS))
        - FUZZ_BIAS_TANH;
    case 'overdrive':
      return Math.tanh(value);
  }
}

function distortionAntiderivative(mode: BrowserDistortionMode, value: number): number {
  switch (mode) {
    case 'hard-clip': {
      const absolute = Math.abs(value);
      return absolute <= 1 ? 0.5 * value * value : absolute - 0.5;
    }
    case 'fuzz':
      return logCosh(FUZZ_SHARPNESS * (value + DISTORTION_BIAS)) / FUZZ_SHARPNESS
        - value * FUZZ_BIAS_TANH;
    case 'overdrive':
      return logCosh(value);
  }
}

function antiderivativeAntialiasSample(mode: BrowserDistortionMode, current: number, previous: number): number {
  const difference = current - previous;
  if (Math.abs(difference) < 1e-8) return distortionFunction(mode, 0.5 * (current + previous));
  return (distortionAntiderivative(mode, current) - distortionAntiderivative(mode, previous)) / difference;
}

function isDistortionMode(value: unknown): value is BrowserDistortionMode {
  return value === 'overdrive' || value === 'hard-clip' || value === 'fuzz';
}

/** Exponential parameter smoothing implementing F01 without per-sample objects. */
class ExponentialParameterSmoother {
  private current: number;
  private target: number;
  private readonly oneMinusAlpha: number;
  private settled = false;

  constructor(sampleRate: number, initialValue: number, smoothingSeconds = DEFAULT_SMOOTHING_SECONDS) {
    this.current = initialValue;
    this.target = initialValue;
    this.oneMinusAlpha = 1 - Math.exp(-1 / (sampleRate * smoothingSeconds));
  }

  get isSettled(): boolean {
    return this.settled;
  }

  setTarget(value: number): void {
    if (!Object.is(this.target, value)) {
      this.target = value;
      this.settled = false;
    }
  }

  next(): number {
    if (this.settled) return this.current;
    const previous = this.current;
    this.current += (this.target - this.current) * this.oneMinusAlpha;
    // Once one recurrence rounds back to the exact same IEEE-754 value, the
    // unchanged target and coefficient make every later recurrence identical.
    if (Object.is(this.current, previous)) this.settled = true;
    return this.current;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  // The common in-range path is already its own clamped value. Keep zero on
  // the original path to preserve Math.min/max signed-zero behavior; NaN,
  // reversed bounds and out-of-range values also take that exact fallback.
  if (value !== 0 && value >= minimum && value <= maximum) return value;
  return Math.max(minimum, Math.min(maximum, value));
}

function validateBrowserVocoderParameters(parameters: BrowserFxParameters): void {
  const supported = ['mix', 'vocoderBands', 'vocoderCarrier'];
  for (const key of Object.keys(parameters)) {
    if (!supported.includes(key) && key !== 'bpm' && key !== 'quarterNotesPerMeasure' && !key.startsWith('official_')) {
      throw new RangeError(key === 'formant' || key === 'vocoderFormantSemitones'
        ? 'Browser VOCODER formant shifting is unsupported; no formant remapping is applied.'
        : `Browser VOCODER does not support the ${key} parameter.`);
    }
  }
  if (parameters.mix !== undefined && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
    throw new RangeError('Browser VOCODER mix must be between 0 and 1.');
  }
  if (parameters.vocoderBands !== undefined
      && (!Number.isInteger(parameters.vocoderBands) || parameters.vocoderBands < 8 || parameters.vocoderBands > 24)) {
    throw new RangeError('Browser VOCODER bands must be an integer from 8 to 24.');
  }
  if (parameters.vocoderCarrier !== undefined
      && (!Number.isInteger(parameters.vocoderCarrier) || parameters.vocoderCarrier < 0 || parameters.vocoderCarrier > 2)) {
    throw new RangeError('Browser VOCODER carrier must be 0 (voice input), 1 (saw), or 2 (square).');
  }
}

function validateBrowserElectricParameters(parameters: BrowserFxParameters): void {
  const supported = ['mix', 'electricCharacter', 'electricPitchSnapPercent', 'electricToneHz'];
  for (const key of Object.keys(parameters)) {
    if (!supported.includes(key) && key !== 'bpm' && key !== 'quarterNotesPerMeasure' && !key.startsWith('official_')) {
      throw new RangeError(`Browser ELECTRIC does not support the ${key} parameter.`);
    }
  }
  if (parameters.mix !== undefined && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
    throw new RangeError('Browser ELECTRIC mix must be between 0 and 1.');
  }
  if (parameters.electricCharacter !== undefined
      && (!Number.isInteger(parameters.electricCharacter) || parameters.electricCharacter < 0 || parameters.electricCharacter > 3)) {
    throw new RangeError('Browser ELECTRIC character must be an integer from 0 to 3.');
  }
  if (parameters.electricPitchSnapPercent !== undefined
      && (!Number.isFinite(parameters.electricPitchSnapPercent) || parameters.electricPitchSnapPercent < 0 || parameters.electricPitchSnapPercent > 100)) {
    throw new RangeError('Browser ELECTRIC pitch snap must be from 0 to 100 percent.');
  }
  if (parameters.electricToneHz !== undefined
      && (!Number.isFinite(parameters.electricToneHz) || parameters.electricToneHz < 100 || parameters.electricToneHz > 16_000)) {
    throw new RangeError('Browser ELECTRIC tone cutoff must be from 100 to 16000 Hz.');
  }
}

function validateBrowserOscBotParameters(parameters: BrowserFxParameters, sampleRate: number): void {
  const supported = ['mix', 'oscBotWaveform', 'oscBotPattern', 'oscBotToneHz', 'bpm'];
  for (const key of Object.keys(parameters)) {
    if (!supported.includes(key) && key !== 'bpm' && key !== 'quarterNotesPerMeasure' && !key.startsWith('official_')) {
      throw new RangeError(`Browser OSC BOT does not support the ${key} parameter.`);
    }
  }
  if (parameters.mix !== undefined && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
    throw new RangeError('Browser OSC BOT mix must be between 0 and 1.');
  }
  if (parameters.oscBotWaveform !== undefined
      && (!Number.isInteger(parameters.oscBotWaveform) || parameters.oscBotWaveform < 0 || parameters.oscBotWaveform > 2)) {
    throw new RangeError('Browser OSC BOT waveform must be 0 (saw), 1 (square), or 2 (triangle).');
  }
  if (parameters.oscBotPattern !== undefined
      && (!Number.isInteger(parameters.oscBotPattern) || parameters.oscBotPattern < 0 || parameters.oscBotPattern > 7)) {
    throw new RangeError('Browser OSC BOT pattern must be an integer from 0 to 7.');
  }
  if (parameters.oscBotToneHz !== undefined
      && (!Number.isFinite(parameters.oscBotToneHz) || parameters.oscBotToneHz < 100 || parameters.oscBotToneHz > 16000 || parameters.oscBotToneHz >= sampleRate * 0.49)) {
    throw new RangeError('Browser OSC BOT tone cutoff must be from 100 to 16000 Hz and below 0.49 of sample rate.');
  }
  if (parameters.bpm !== undefined && (!Number.isFinite(parameters.bpm) || parameters.bpm < 30 || parameters.bpm > 300)) {
    throw new RangeError('Browser OSC BOT tempo must be from 30 to 300 BPM.');
  }
}

function validateBrowserOscVocParameters(parameters: BrowserFxParameters): void {
  const supported = ['mix', 'oscVocWaveform', 'oscVocMidiChannel', 'oscVocOctave', 'oscVocBands'];
  for (const key of Object.keys(parameters)) {
    if (!supported.includes(key) && key !== 'bpm' && key !== 'quarterNotesPerMeasure' && !key.startsWith('official_')) throw new RangeError(`Browser OSC VOC (M) does not support the ${key} parameter.`);
  }
  if (parameters.mix !== undefined && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
    throw new RangeError('Browser OSC VOC (M) mix must be between 0 and 1.');
  }
  if (parameters.oscVocWaveform !== undefined && (!Number.isInteger(parameters.oscVocWaveform) || parameters.oscVocWaveform < 0 || parameters.oscVocWaveform > 2)) {
    throw new RangeError('Browser OSC VOC (M) waveform must be 0 (saw), 1 (square), or 2 (pulse).');
  }
  if (parameters.oscVocMidiChannel !== undefined && (!Number.isInteger(parameters.oscVocMidiChannel) || parameters.oscVocMidiChannel < 1 || parameters.oscVocMidiChannel > 16)) {
    throw new RangeError('Browser OSC VOC (M) MIDI channel must be an integer from 1 to 16.');
  }
  if (parameters.oscVocOctave !== undefined && (!Number.isFinite(parameters.oscVocOctave) || parameters.oscVocOctave < -24 || parameters.oscVocOctave > 24)) {
    throw new RangeError('Browser OSC VOC (M) octave transpose must be from -24 to 24 semitones.');
  }
  if (parameters.oscVocBands !== undefined && (!Number.isInteger(parameters.oscVocBands) || parameters.oscVocBands < 8 || parameters.oscVocBands > 24)) {
    throw new RangeError('Browser OSC VOC (M) bands must be an integer from 8 to 24.');
  }
}

function isTremoloWaveform(value: unknown): value is BrowserTremoloWaveform {
  return value === 'sine' || value === 'triangle' || value === 'square';
}

function firstOrderAllpassCoefficient(frequencyHz: number, sampleRate: number): number {
  const frequency = clamp(frequencyHz, 20, sampleRate * 0.45);
  const tangent = Math.tan(Math.PI * frequency / sampleRate);
  return clamp((tangent - 1) / (tangent + 1), -0.9995, 0.9995);
}

/** Polynomial band-limited step correction for the square-wave LFO. */
function polyBlep(phase: number, phaseStep: number): number {
  if (phase < phaseStep) {
    const scaled = phase / phaseStep;
    return scaled + scaled - scaled * scaled - 1;
  }
  if (phase > 1 - phaseStep) {
    const scaled = (phase - 1) / phaseStep;
    return scaled * scaled + scaled + scaled + 1;
  }
  return 0;
}

/** Four-point backward Lagrange read relative to an as-yet-unwritten slot. */
function readLagrangeFromWriteHead(buffer: Float32Array, writeIndex: number, delaySamples: number): number {
  const wholeDelay = Math.floor(delaySamples);
  const fraction = delaySamples - wholeDelay;
  const oneMinus = 1 - fraction;
  const coefficient0 = (oneMinus * (2 - fraction) * (3 - fraction)) / 6;
  const coefficient1 = (fraction * (2 - fraction) * (3 - fraction)) / 2;
  const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
  const coefficient3 = (fraction * oneMinus * (2 - fraction)) / 6;
  const length = buffer.length;
  // All callers clamp delay to the buffer's valid range. This difference is
  // therefore in (-length, length), so one correction is equivalent to
  // positive modulo without a floating/integer remainder in the sample loop.
  let index = writeIndex - wholeDelay;
  if (index < 0) index += length;
  const sample0 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const sample1 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const sample2 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const sample3 = buffer[index] ?? 0;
  return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
}

export class BrowserFxDspCore {
  readonly sampleRate: number;
  readonly algorithm: BrowserFxAlgorithm;
  get algorithmicLatencySamples(): number {
    if (this.algorithm === 'distortion' || this.algorithm === 'preamp') return DISTORTION_DRY_DELAY_SAMPLES;
    if (this.algorithm === 'synth' || this.algorithm === 'g2b' || this.algorithm === 'electric') return 2_868;
    if (this.algorithm === 'beat-shift') return this.beatShift?.latencySamples ?? 0;
    if (this.algorithm === 'reverse-delay') return this.reverseDelay?.latencySamples ?? 0;
    if (this.algorithm === 'reverse-reverb') return this.officialReverseReverb?.latencySamples ?? this.reverseReverb?.latencySamples ?? 0;
    if (this.algorithm === 'vinyl-flick') return this.vinylFlick?.algorithmicLatencySamples ?? 0;
    // The active core renders PSOLA, including its delayed unvoiced path.
    // This is its declared engine delay, not a pitch-dependent waveform peak.
    // Host PSOLA/Signalsmith alignment and tracker acquisition are separate.
    if (this.algorithm === 'robot') return this.robot?.psolaLatencySamples ?? 0;
    return 0;
  }

  blocksProcessed = 0;
  framesProcessed = 0;
  nonFiniteInputSamples = 0;
  nonFiniteOutputSamples = 0;

  private readonly filterLeft: TptStateVariableFilter;
  private readonly filterRight: TptStateVariableFilter;
  private readonly cutoff: ExponentialParameterSmoother;
  private readonly q: ExponentialParameterSmoother;
  private readonly wet: ExponentialParameterSmoother;
  private readonly decaySeconds: ExponentialParameterSmoother;
  private readonly dampingHz: ExponentialParameterSmoother;
  private readonly gateThresholdDb: ExponentialParameterSmoother;
  private readonly gateHoldMs: ExponentialParameterSmoother;
  private readonly gateReleaseMs: ExponentialParameterSmoother;
  private gateDetectorEnvelope = 0;
  private gateHoldRemainingSamples = 0;
  private gateGain = 0;
  private readonly gateDetectorRelease: number;
  private gateThresholdKey = Number.NaN;
  private gateThresholdLinear = 0;
  private gateHoldKey = Number.NaN;
  private gateHoldSamples = 1;
  private gateReleaseKey = Number.NaN;
  private gateReleaseCoefficient = 0;
  private readonly ringModHz: ExponentialParameterSmoother;
  private readonly ringModDepth: ExponentialParameterSmoother;
  private readonly ringModWaveform: ExponentialParameterSmoother;
  private readonly driveDb: ExponentialParameterSmoother;
  private readonly outputDb: ExponentialParameterSmoother;
  private readonly flangerDelayMs: ExponentialParameterSmoother;
  private readonly flangerRateHz: ExponentialParameterSmoother;
  private readonly flangerDepth: ExponentialParameterSmoother;
  private readonly flangerFeedback: ExponentialParameterSmoother;
  private readonly dynamicsThreshold: ExponentialParameterSmoother;
  private readonly dynamicsRatio: ExponentialParameterSmoother;
  private readonly dynamicsKnee: ExponentialParameterSmoother;
  private readonly dynamicsAttackMs: ExponentialParameterSmoother;
  private readonly dynamicsReleaseMs: ExponentialParameterSmoother;
  private readonly delayTimeMs: ExponentialParameterSmoother;
  private readonly delayFeedback: ExponentialParameterSmoother;
  private readonly delayToneHz: ExponentialParameterSmoother;
  private readonly panningDelay: BrowserPanningDelayDsp | null;
  private readonly modDelay: BrowserModDelayDsp | null;
  private readonly chorusDelayMs: ExponentialParameterSmoother;
  private readonly chorusRateHz: ExponentialParameterSmoother;
  private readonly chorusDepthMs: ExponentialParameterSmoother;
  private readonly chorusFeedback: ExponentialParameterSmoother;
  private readonly chorusToneHz: ExponentialParameterSmoother;
  private readonly phaserRateHz: ExponentialParameterSmoother;
  private readonly phaserDepth: ExponentialParameterSmoother;
  private readonly phaserFeedback: ExponentialParameterSmoother;
  private readonly tremoloRateHz: ExponentialParameterSmoother;
  private readonly tremoloDepth: ExponentialParameterSmoother;
  private tremoloWaveformOld: BrowserTremoloWaveform;
  private tremoloWaveformTarget: BrowserTremoloWaveform;
  private readonly tremoloWaveformBlend = new LinearParameterSmoother(1);
  private tremoloWaveformBlendValue = 1;
  private readonly autoPanRateHz: ExponentialParameterSmoother;
  private readonly autoPanDepth: ExponentialParameterSmoother;
  private readonly stereoWidth: ExponentialParameterSmoother;
  private readonly stereoLowMonoCutoffHz: ExponentialParameterSmoother;
  private readonly stereoDecorrelation: ExponentialParameterSmoother;
  private stereoLowpassState = 0;
  private stereoAllpass1Input = 0;
  private stereoAllpass1Output = 0;
  private stereoAllpass2Input = 0;
  private stereoAllpass2Output = 0;
  private stereoLowpassAlpha = 0;
  private stereoAllpass1Coefficient = 0;
  private stereoAllpass2Coefficient = 0;
  private stereoWetLeft = 0;
  private stereoWetRight = 0;
  private autoPanWaveformOld: BrowserTremoloWaveform;
  private autoPanWaveformTarget: BrowserTremoloWaveform;
  private readonly autoPanWaveformBlend = new LinearParameterSmoother(1);
  private autoPanWaveformBlendValue = 1;
  private autoPanWetLeft = 0;
  private autoPanWetRight = 0;
  private readonly bypassMix = new LinearParameterSmoother(0);
  // Cache the exact equal-power coefficients while mix/bypass controls are
  // stationary. Values are refreshed from the existing helpers whenever the
  // sample-position changes, so automation retains the original equations.
  private cachedWetPosition = Number.NaN;
  private cachedWetDryGain = 1;
  private cachedWetGain = 0;
  private cachedBypassPosition = Number.NaN;
  private cachedBypassActiveGain = 1;
  private cachedBypassGain = 0;
  private readonly distortionModeBlend = new LinearParameterSmoother(1);
  private distortionModeOld: BrowserDistortionMode;
  private distortionModeTarget: BrowserDistortionMode;
  private driveLinear = 1;
  private outputLinear = 1;
  // Duplicate each circular history so processDistortionSample can read a
  // contiguous window without a wrap branch for every FIR tap.
  private readonly upsampleHistory = new Float64Array(DISTORTION_UPSAMPLE_INPUT_HISTORY * 4);
  private readonly upsampleWriteIndices = new Int32Array(2);
  private readonly previousDrivenInput = new Float64Array(2);
  private readonly distortionPreviousPrimitive = new Float64Array(2);
  private readonly distortionPrimitiveValid = new Uint8Array(2);
  private readonly waveshapedHistory = new Float64Array(DISTORTION_FIR_TAPS * 4);
  private readonly waveshapedWriteIndices = new Int32Array(2);
  private readonly dryDelayBuffers: Float32Array[] = [
    new Float32Array(DISTORTION_DRY_DELAY_SAMPLES),
    new Float32Array(DISTORTION_DRY_DELAY_SAMPLES),
  ];
  private readonly dryDelayWriteIndices = new Int32Array(2);
  private readonly fdnBuffers: Array<Float32Array | undefined>;
  private readonly delayLengths: Int32Array;
  private readonly fdnWriteIndices: Int32Array;
  private readonly delayFeedbackGains: Float64Array;
  private readonly delayModPhases: Float64Array;
  private readonly delayModPhaseSteps: Float64Array;
  private readonly delayDampingStates: Float64Array;
  private readonly delayReadScratch: Float64Array;
  private readonly earlyBuffers: Array<Float32Array | undefined>;
  private readonly flangerBuffers: Array<Float32Array | undefined>;
  private readonly flangerWriteIndices: Int32Array;
  private readonly flangerPhases: Float64Array;
  private readonly flangerFeedbackStates: Float64Array;
  private readonly delayBuffers: Array<Float32Array | undefined>;
  private readonly delayWriteIndices: Int32Array;
  private readonly delayToneStates: Float64Array;
  private delayToneAlpha = 1;
  private readonly chorusBuffers: Array<Float32Array | undefined>;
  private readonly chorusWriteIndices: Int32Array;
  private readonly chorusFeedbackStates: Float64Array;
  private chorusToneAlpha = 1;
  private chorusVoiceCount = CHORUS_DEFAULT_VOICES;
  private chorusPhase = 0;
  private chorusPhaseStep = 0;
  private readonly phaserInputStates: Float64Array;
  private readonly phaserOutputStates: Float64Array;
  private readonly phaserFeedbackStates: Float64Array;
  private phaserToneAlpha = 1;
  private phaserStageCount = PHASER_DEFAULT_STAGES;
  private phaserPhase = 0;
  private phaserPhaseStep = 0;
  private tremoloPhase = 0;
  private tremoloPhaseStep = 0;
  private autoPanPhase = 0;
  private autoPanPhaseStep = 0;
  private dynamicsDetector: BrowserDynamicsDetector;
  private dynamicsPeakEnvelope = 0;
  private dynamicsRmsMeanSquare = 0;
  private dynamicsGain = 1;
  private dynamicsAttackAlpha = 0;
  private dynamicsReleaseAlpha = 0;
  private readonly earlyDelays: Int32Array;
  private readonly earlyWriteIndices = new Int32Array(2);
  private readonly dampingAlpha: Float64Array;
  private readonly currentControls: Float64Array;
  private readonly beatRepeat: BeatRepeatDsp | null;
  private readonly roll: BrowserRollDsp | null;
  private readonly freeze: BrowserFreezeDsp | null;
  private readonly warp: BrowserWarpDsp | null;
  private readonly beatScatter: BrowserBeatScatterDsp | null;
  private readonly beatShift: BrowserBeatShiftDsp | null;
  private readonly reverseDelay: BrowserReverseDelayDsp | null;
  private readonly reverseReverb: BrowserReverseReverbDsp | null;
  private readonly autoRiff: BrowserAutoRiffDsp | null;
  private readonly hrmAuto: BrowserHrmAutoDsp | null;
  private readonly robot: BrowserRobotDsp | null;
  private readonly patternSlicer: BrowserPatternSlicerDsp | null;
  private readonly stepSlicer: BrowserStepSlicerDsp | null;
  private readonly loFi: LoFiDsp | null;
  private readonly equalizer: EqualizerDsp | null;
  private readonly tapeEcho: BrowserTapeEchoDsp | null;
  private readonly twist: BrowserTwistDsp | null;
  private readonly granularDelay: BrowserGranularDelayDsp | null;
  private readonly radio: BrowserRadioDsp | null;
  private readonly vibrato: BrowserVibratoDsp | null;
  private readonly sustainer: BrowserSustainerDsp | null;
  private readonly preamp: BrowserPreampDsp | null;
  private readonly synth: BrowserSynthDsp | null;
  private readonly g2b: BrowserG2bDsp | null;
  private readonly vocoder: BrowserVocoderCore | null;
  private readonly electric: BrowserElectricDsp | null;
  private readonly oscVoc: BrowserOscVocCore | null;
  private readonly oscBot: BrowserOscBotCore | null;
  private readonly slowGear: BrowserSlowGearDsp | null;
  private readonly isolator: BrowserIsolatorDsp | null;
  private readonly vinylFlick: BrowserVinylFlickDsp | null;
  private readonly manualPanPosition: LinearParameterSmoother;
  private readonly manualPanLeftTable: Float32Array;
  private readonly manualPanRightTable: Float32Array;
  private manualPanWetLeft = 0;
  private manualPanWetRight = 0;
  private phase = 0;
  private phaseStep = 0;
  private dcBlockInput = new Float64Array(2);
  private dcBlockOutput = new Float64Array(2);
  private readonly dcBlockCoefficient: number;
  private readonly flangerDampingAlpha: number;
  private readonly earlyRingLength: number;
  private controlUpdateCountdown = 0;
  // `advanceControls` updates a fixed set of smoothed values every audio
  // sample. Once every smoother and waveform crossfade has reached its exact
  // terminal value, the values and their derived coefficients are immutable
  // until the next control message. A short scan cadence detects that state
  // without adding work to every sample; the coefficient refresh after the
  // final ramp is required before the fast path can become active.
  private controlsSteady = false;
  private controlSettleScanCountdown = 0;
  private controlSmoothersSettled = false;
  // Test-only differential reference switch; production instances keep this
  // enabled and it never changes DSP parameters or audio state.
  private settledControlFastPathEnabled = true;
  private currentAudioFrame = 0;
  private readonly official: OfficialBrowserControlState;
  private officialDelay: BrowserOfficialDelayDsp | null = null;
  private officialRoll: BrowserOfficialRollDsp | null = null;
  private officialReverseReverb: BrowserOfficialReverseReverbDsp | null = null;
  private officialStepSlicer: BrowserOfficialStepSlicerDsp | null = null;
  private readonly officialDirectGain = new LinearParameterSmoother(1);
  private readonly officialEffectGain = new LinearParameterSmoother(1);
  private readonly officialLevelGain = new LinearParameterSmoother(1);
  private officialIndependentMix = false;
  private officialModulation = false;
  private officialFilterPhase = 0;
  private officialStepPhase = 1;
  private officialLfoLeft = 0;
  private officialLfoRight = 0;
  private officialBiPhase = false;
  private officialToneEq: EqualizerDsp | null = null;
  private readonly officialLowCutLeft: TptStateVariableFilter;
  private readonly officialLowCutRight: TptStateVariableFilter;
  private readonly officialHighCutLeft: TptStateVariableFilter;
  private readonly officialHighCutRight: TptStateVariableFilter;
  private officialHasLowCut = false;
  private officialHasHighCut = false;
  private readonly officialPreDelayBuffers: readonly [Float32Array, Float32Array] | null;
  private officialPreDelayWrite = 0;
  private officialPreDelaySamples = 0;
  private officialInitPhase = NaN;
  private officialLastVariant = 0;

  constructor(algorithm: BrowserFxAlgorithm, sampleRate = 48000, parameters: BrowserFxParameters = {}, initialFrame = 0) {
    this.official = new OfficialBrowserControlState(algorithm, sampleRate);
    parameters = this.official.translate(parameters);
    if (algorithm === 'vocoder') validateBrowserVocoderParameters(parameters);
    if (algorithm === 'electric') validateBrowserElectricParameters(parameters);
    if (algorithm === 'osc-voc') validateBrowserOscVocParameters(parameters);
    this.algorithm = algorithm;
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.officialLowCutLeft = new TptStateVariableFilter(this.sampleRate);
    this.officialLowCutRight = new TptStateVariableFilter(this.sampleRate);
    this.officialHighCutLeft = new TptStateVariableFilter(this.sampleRate);
    this.officialHighCutRight = new TptStateVariableFilter(this.sampleRate);
    this.officialPreDelayBuffers = algorithm === 'reverb' || algorithm === 'gate-reverb'
      ? [new Float32Array(Math.ceil(this.sampleRate * 0.5) + 1), new Float32Array(Math.ceil(this.sampleRate * 0.5) + 1)] : null;
    this.gateDetectorRelease = algorithm === 'gate-reverb'
      ? Math.exp(-1 / (GATE_REVERB_DETECTOR_RELEASE_MS * 0.001 * this.sampleRate)) : 0;
    this.currentAudioFrame = Number.isSafeInteger(initialFrame) && initialFrame >= 0 ? Math.floor(initialFrame) : 0;

    const nyquist = this.sampleRate * 0.499;
    const initialCutoff = clamp(parameters.cutoffHz ?? 1200, 20, nyquist);
    const mappedFilterResonance = (algorithm === 'lpf' || algorithm === 'hpf') && Number.isFinite(parameters.filterResonancePercent)
      ? filterResonancePercentToQ(parameters.filterResonancePercent as number)
      : undefined;
    const initialQ = clamp(mappedFilterResonance ?? parameters.q ?? Math.SQRT1_2, 0.1, 30);
    if (algorithm === 'osc-bot') validateBrowserOscBotParameters(parameters, this.sampleRate);
    const initialWet = clamp(parameters.mix ?? (algorithm === 'vocoder' || algorithm === 'osc-voc' || algorithm === 'osc-bot' || algorithm === 'electric' ? 0.7 : (
      algorithm === 'delay' || algorithm === 'panning-delay' || algorithm === 'mod-delay' ? DELAY_DEFAULT_MIX : algorithm === 'chorus' ? 0.4 : algorithm === 'phaser' || algorithm === 'beat-repeat' || algorithm === 'beat-scatter' || algorithm === 'roll' || algorithm === 'twist' ? 0.5 : algorithm === 'lo-fi' || algorithm === 'radio' ? 0.7 : algorithm === 'tape-echo' || algorithm === 'gate-reverb' || algorithm === 'reverse-delay' ? 0.3 : algorithm === 'reverse-reverb' ? 0.35 : algorithm === 'granular-delay' ? 0.35 : algorithm === 'warp' ? 0.4 : 1
    )), 0, 1);
    if (algorithm === 'freeze' && Number.isFinite(parameters.freezeMode) && parameters.freezeMode !== 0) {
      throw new RangeError('Spectral FREEZE mode is unavailable; only micro-loop mode is wired.');
    }
    const initialDecay = clamp(parameters.decaySeconds ?? (algorithm === 'gate-reverb' || algorithm === 'reverse-reverb' ? 2 : 2.4), 0.1, 20);
    const initialDamping = clamp(parameters.dampingHz ?? 9000, 200, nyquist);
    const initialGateThresholdDb = clamp(parameters.gateThresholdDb ?? GATE_REVERB_DEFAULT_THRESHOLD_DB, -60, 0);
    const initialGateHoldMs = clamp(parameters.gateHoldMs ?? GATE_REVERB_DEFAULT_HOLD_MS, 5, 2000);
    const initialGateReleaseMs = clamp(parameters.gateReleaseMs ?? GATE_REVERB_DEFAULT_RELEASE_MS, 10, 2000);
    const initialRingModHz = clamp(parameters.ringModHz ?? 440, 0, Math.min(8000, this.sampleRate * 0.45));
    const initialRingModDepth = clamp(parameters.ringModDepth ?? 1, 0, 1);
    const initialRingModWaveform = parameters.ringModWaveform === 1 ? 1 : 0;
    const initialDriveDb = clamp(parameters.driveDb ?? 18, 0, 36);
    const initialOutputDb = clamp(parameters.outputDb ?? 0, -24, 12);
    const initialDistortionMode = isDistortionMode(parameters.distortionMode) ? parameters.distortionMode : 'overdrive';
    const initialFlangerDelayMs = clamp(parameters.flangerDelayMs ?? FLANGER_DEFAULT_DELAY_MILLISECONDS, FLANGER_MIN_DELAY_MILLISECONDS, FLANGER_MAX_DELAY_MILLISECONDS);
    const initialFlangerRateHz = clamp(parameters.flangerRateHz ?? FLANGER_DEFAULT_RATE_HZ, 0.05, 20);
    const initialFlangerDepth = clamp(parameters.flangerDepth ?? FLANGER_DEFAULT_DEPTH, 0, 1);
    const initialFlangerFeedback = clamp(parameters.flangerFeedback ?? FLANGER_DEFAULT_FEEDBACK, -0.95, 0.95);
    const initialThresholdDb = clamp(parameters.thresholdDb ?? DYNAMICS_DEFAULT_THRESHOLD_DB, -60, 0);
    const initialRatio = clamp(parameters.ratio ?? DYNAMICS_DEFAULT_RATIO, 1, 20);
    const initialKneeDb = clamp(parameters.kneeDb ?? DYNAMICS_DEFAULT_KNEE_DB, 0, 24);
    const initialAttackMs = clamp(parameters.attackMs ?? DYNAMICS_DEFAULT_ATTACK_MS, 0.1, 100);
    const initialReleaseMs = clamp(parameters.releaseMs ?? DYNAMICS_DEFAULT_RELEASE_MS, 5, 1000);
    const initialDelayTimeMs = clamp(parameters.delayTimeMs ?? DELAY_DEFAULT_TIME_MILLISECONDS, DELAY_MIN_TIME_MILLISECONDS, DELAY_MAX_TIME_MILLISECONDS);
    const initialDelayFeedback = clamp(parameters.delayFeedback ?? DELAY_DEFAULT_FEEDBACK, 0, 0.95);
    const initialDelayToneHz = clamp(parameters.delayToneHz ?? DELAY_DEFAULT_TONE_HZ, 100, Math.min(16000, nyquist));
    const initialChorusDelayMs = clamp(parameters.chorusDelayMs ?? CHORUS_DEFAULT_DELAY_MILLISECONDS, CHORUS_MIN_DELAY_MILLISECONDS, CHORUS_MAX_DELAY_MILLISECONDS);
    const initialChorusRateHz = clamp(parameters.chorusRateHz ?? CHORUS_DEFAULT_RATE_HZ, 0.05, 10);
    const initialChorusDepthMs = clamp(parameters.chorusDepthMs ?? CHORUS_DEFAULT_DEPTH_MILLISECONDS, 0.2, 20);
    const initialChorusVoices = Math.round(clamp(parameters.chorusVoices ?? CHORUS_DEFAULT_VOICES, 2, 4));
    const initialChorusFeedback = clamp(parameters.chorusFeedback ?? CHORUS_DEFAULT_FEEDBACK, 0, CHORUS_FEEDBACK_MAX);
    const initialChorusToneHz = clamp(parameters.chorusToneHz ?? CHORUS_DEFAULT_TONE_HZ, 100, Math.min(16000, nyquist));
    const initialPhaserRateHz = clamp(parameters.phaserRateHz ?? PHASER_DEFAULT_RATE_HZ, 0.05, 20);
    const initialPhaserDepth = clamp(parameters.phaserDepth ?? PHASER_DEFAULT_DEPTH, 0, 1);
    const initialPhaserFeedback = clamp(parameters.phaserFeedback ?? PHASER_DEFAULT_FEEDBACK, 0, PHASER_FEEDBACK_MAX);
    const initialPhaserStages = clamp(parameters.phaserStages ?? PHASER_DEFAULT_STAGES, 4, PHASER_MAX_STAGES) < 6 ? 4 : 8;
    const initialTremoloRateHz = clamp(parameters.tremoloRateHz ?? TREMOLO_DEFAULT_RATE_HZ, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ);
    const initialTremoloDepth = clamp(parameters.tremoloDepth ?? TREMOLO_DEFAULT_DEPTH, 0, 1);
    const initialTremoloWaveform = isTremoloWaveform(parameters.tremoloWaveform) ? parameters.tremoloWaveform : 'sine';
    const initialAutoPanRateHz = clamp(parameters.autoPanRateHz ?? AUTO_PAN_DEFAULT_RATE_HZ, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ);
    const initialAutoPanDepth = clamp(parameters.autoPanDepth ?? AUTO_PAN_DEFAULT_DEPTH, 0, 1);
    const initialStereoWidth = clamp(parameters.stereoWidth ?? 1, 0, 2);
    const initialStereoLowMonoCutoffHz = clamp(parameters.stereoLowMonoCutoffHz ?? 120, 20, Math.min(1000, nyquist));
    const initialStereoDecorrelation = clamp(parameters.stereoDecorrelation ?? 0.25, 0, 1);
    const initialAutoPanWaveform = isTremoloWaveform(parameters.autoPanWaveform) ? parameters.autoPanWaveform : 'sine';
    this.tremoloWaveformOld = initialTremoloWaveform;
    this.tremoloWaveformTarget = initialTremoloWaveform;
    this.autoPanWaveformOld = initialAutoPanWaveform;
    this.autoPanWaveformTarget = initialAutoPanWaveform;
    this.dynamicsDetector = parameters.dynamicsDetector === 'rms' ? 'rms' : 'peak';

    this.cutoff = new ExponentialParameterSmoother(this.sampleRate, initialCutoff);
    this.q = new ExponentialParameterSmoother(this.sampleRate, initialQ);
    this.wet = new ExponentialParameterSmoother(this.sampleRate, initialWet);
    this.decaySeconds = new ExponentialParameterSmoother(this.sampleRate, initialDecay);
    this.dampingHz = new ExponentialParameterSmoother(this.sampleRate, initialDamping);
    this.gateThresholdDb = new ExponentialParameterSmoother(this.sampleRate, initialGateThresholdDb);
    this.gateHoldMs = new ExponentialParameterSmoother(this.sampleRate, initialGateHoldMs);
    this.gateReleaseMs = new ExponentialParameterSmoother(this.sampleRate, initialGateReleaseMs);
    this.ringModHz = new ExponentialParameterSmoother(this.sampleRate, initialRingModHz);
    this.ringModDepth = new ExponentialParameterSmoother(this.sampleRate, initialRingModDepth);
    this.ringModWaveform = new ExponentialParameterSmoother(this.sampleRate, initialRingModWaveform, 0.020);
    this.driveDb = new ExponentialParameterSmoother(this.sampleRate, initialDriveDb);
    this.outputDb = new ExponentialParameterSmoother(this.sampleRate, initialOutputDb);
    this.flangerDelayMs = new ExponentialParameterSmoother(this.sampleRate, initialFlangerDelayMs);
    this.flangerRateHz = new ExponentialParameterSmoother(this.sampleRate, initialFlangerRateHz);
    this.flangerDepth = new ExponentialParameterSmoother(this.sampleRate, initialFlangerDepth);
    this.flangerFeedback = new ExponentialParameterSmoother(this.sampleRate, initialFlangerFeedback);
    this.dynamicsThreshold = new ExponentialParameterSmoother(this.sampleRate, initialThresholdDb);
    this.dynamicsRatio = new ExponentialParameterSmoother(this.sampleRate, initialRatio);
    this.dynamicsKnee = new ExponentialParameterSmoother(this.sampleRate, initialKneeDb);
    this.dynamicsAttackMs = new ExponentialParameterSmoother(this.sampleRate, initialAttackMs);
    this.dynamicsReleaseMs = new ExponentialParameterSmoother(this.sampleRate, initialReleaseMs);
    this.delayTimeMs = new ExponentialParameterSmoother(this.sampleRate, initialDelayTimeMs);
    this.delayFeedback = new ExponentialParameterSmoother(this.sampleRate, initialDelayFeedback);
    this.delayToneHz = new ExponentialParameterSmoother(this.sampleRate, initialDelayToneHz);
    this.chorusDelayMs = new ExponentialParameterSmoother(this.sampleRate, initialChorusDelayMs);
    this.chorusRateHz = new ExponentialParameterSmoother(this.sampleRate, initialChorusRateHz);
    this.chorusDepthMs = new ExponentialParameterSmoother(this.sampleRate, initialChorusDepthMs);
    this.chorusFeedback = new ExponentialParameterSmoother(this.sampleRate, initialChorusFeedback);
    this.chorusToneHz = new ExponentialParameterSmoother(this.sampleRate, initialChorusToneHz);
    this.phaserRateHz = new ExponentialParameterSmoother(this.sampleRate, initialPhaserRateHz);
    this.phaserDepth = new ExponentialParameterSmoother(this.sampleRate, initialPhaserDepth);
    this.phaserFeedback = new ExponentialParameterSmoother(this.sampleRate, initialPhaserFeedback);
    this.tremoloRateHz = new ExponentialParameterSmoother(this.sampleRate, initialTremoloRateHz);
    this.tremoloDepth = new ExponentialParameterSmoother(this.sampleRate, initialTremoloDepth);
    this.autoPanRateHz = new ExponentialParameterSmoother(this.sampleRate, initialAutoPanRateHz);
    this.autoPanDepth = new ExponentialParameterSmoother(this.sampleRate, initialAutoPanDepth);
    this.stereoWidth = new ExponentialParameterSmoother(this.sampleRate, initialStereoWidth);
    this.stereoLowMonoCutoffHz = new ExponentialParameterSmoother(this.sampleRate, initialStereoLowMonoCutoffHz);
    this.stereoDecorrelation = new ExponentialParameterSmoother(this.sampleRate, initialStereoDecorrelation);
    this.distortionModeOld = initialDistortionMode;
    this.distortionModeTarget = initialDistortionMode;
    this.driveLinear = Math.pow(10, initialDriveDb / 20);
    this.outputLinear = Math.pow(10, initialOutputDb / 20);
    this.filterLeft = new TptStateVariableFilter(this.sampleRate, initialCutoff, initialQ);
    this.filterRight = new TptStateVariableFilter(this.sampleRate, initialCutoff, initialQ);
    this.phaseStep = TWO_PI * initialRingModHz / this.sampleRate;
    this.dcBlockCoefficient = Math.exp(-TWO_PI * 10 / this.sampleRate);
    this.flangerDampingAlpha = 1 - Math.exp(-TWO_PI * FLANGER_FEEDBACK_FILTER_HZ / this.sampleRate);

    this.fdnBuffers = new Array<Float32Array>(16);
    this.delayLengths = new Int32Array(16);
    this.fdnWriteIndices = new Int32Array(16);
    this.delayFeedbackGains = new Float64Array(16);
    this.delayModPhases = new Float64Array(16);
    this.delayModPhaseSteps = new Float64Array(16);
    this.delayDampingStates = new Float64Array(16);
    this.delayReadScratch = new Float64Array(16);
    this.dampingAlpha = new Float64Array(16);
    this.currentControls = new Float64Array(37);
    this.currentControls[0] = initialCutoff;
    this.currentControls[1] = initialQ;
    this.currentControls[2] = initialWet;
    this.currentControls[3] = initialDecay;
    this.currentControls[4] = initialDamping;
    this.currentControls[5] = initialRingModHz;
    this.currentControls[6] = initialRingModDepth;
    this.currentControls[36] = initialRingModWaveform;
    this.currentControls[7] = initialDriveDb;
    this.currentControls[8] = initialOutputDb;
    this.currentControls[9] = initialFlangerDelayMs;
    this.currentControls[10] = initialFlangerDepth;
    this.currentControls[11] = initialFlangerRateHz;
    this.currentControls[12] = initialFlangerFeedback;
    this.currentControls[13] = initialThresholdDb;
    this.currentControls[14] = initialRatio;
    this.currentControls[15] = initialKneeDb;
    this.currentControls[16] = initialAttackMs;
    this.currentControls[17] = initialReleaseMs;
    this.currentControls[18] = initialDelayTimeMs;
    this.currentControls[19] = initialDelayFeedback;
    this.currentControls[20] = initialDelayToneHz;
    this.currentControls[21] = initialChorusDelayMs;
    this.currentControls[22] = initialChorusRateHz;
    this.currentControls[23] = initialChorusDepthMs;
    this.currentControls[24] = initialChorusFeedback;
    this.currentControls[25] = initialChorusToneHz;
    this.currentControls[26] = initialPhaserRateHz;
    this.currentControls[27] = initialPhaserDepth;
    this.currentControls[28] = initialPhaserFeedback;
    this.currentControls[29] = initialTremoloRateHz;
    this.currentControls[30] = initialTremoloDepth;
    this.currentControls[31] = initialAutoPanRateHz;
    this.currentControls[32] = initialAutoPanDepth;
    this.currentControls[33] = initialStereoWidth;
    this.currentControls[34] = initialStereoLowMonoCutoffHz;
    this.currentControls[35] = initialStereoDecorrelation;
    this.beatRepeat = algorithm === 'beat-repeat'
      ? new BeatRepeatDsp(this.sampleRate, parameters)
      : null;
    this.roll = algorithm === 'roll'
      ? new BrowserRollDsp(this.sampleRate, {
        bpm: parameters.bpm,
        sliceBeats: parameters.rollSliceBeats,
        decayPercent: parameters.rollDecayPercent,
        pitchSemitones: parameters.rollPitchSemitones,
        direction: parameters.rollDirection === 1 ? 'reverse' : parameters.rollDirection === 2 ? 'alternate' : 'forward',
      })
      : null;
    this.freeze = algorithm === 'freeze'
      ? new BrowserFreezeDsp(this.sampleRate, {
        captureLengthMs: parameters.freezeCaptureLengthMs,
        pitchSemitones: parameters.freezePitchSemitones,
        frozen: parameters.freezeEnabled === 1,
      })
      : null;
    this.warp = algorithm === 'warp'
      ? new BrowserWarpDsp(this.sampleRate, {
        bpm: parameters.bpm,
        captureBeats: parameters.warpCaptureBeats,
        smearPercent: parameters.warpSmearPercent,
        pitchSemitones: parameters.warpPitchSemitones,
        feedbackPercent: parameters.warpFeedbackPercent,
        frozen: Number.isFinite(parameters.warpFreezeEnabled) ? parameters.warpFreezeEnabled! >= 0.5 : undefined,
      })
      : null;
    this.beatScatter = algorithm === 'beat-scatter'
      ? new BrowserBeatScatterDsp(this.sampleRate, {
        bpm: parameters.bpm,
        sliceBeats: parameters.beatScatterSliceBeats,
        scatterPercent: parameters.beatScatterScatterPercent,
        pitchSemitones: parameters.beatScatterPitchSemitones,
        repeats: parameters.beatScatterRepeats,
      })
      : null;
    this.beatShift = algorithm === 'beat-shift'
      ? new BrowserBeatShiftDsp(this.sampleRate, {
        bpm: parameters.bpm,
        offsetBeats: parameters.beatShiftOffsetBeats,
        crossfadeMs: parameters.beatShiftCrossfadeMs,
      })
      : null;
    this.reverseDelay = algorithm === 'reverse-delay'
      ? new BrowserReverseDelayDsp(this.sampleRate, {
        bpm: parameters.bpm,
        segmentBeats: parameters.reverseDelaySegmentBeats,
        feedback: parameters.reverseDelayFeedback,
        crossfadeMs: parameters.reverseDelayCrossfadeMs,
      })
      : null;
    this.reverseReverb = algorithm === 'reverse-reverb'
      ? new BrowserReverseReverbDsp(this.sampleRate, {
        bpm: parameters.bpm,
        segmentBeats: parameters.reverseReverbSegmentBeats,
        feedbackPercent: parameters.reverseReverbFeedbackPercent,
        crossfadeMs: parameters.reverseReverbCrossfadeMs,
        decaySeconds: parameters.reverseReverbDecaySeconds ?? initialDecay,
        dampingCutoffHz: parameters.reverseReverbDampingCutoffHz,
      })
      : null;
    this.autoRiff = algorithm === 'auto-riff'
      ? new BrowserAutoRiffDsp(this.sampleRate, {
        bpm: parameters.bpm,
        scale: parameters.autoRiffScale as 0 | 1 | 2 | 3 | 4 | undefined,
        beatStepRate: parameters.autoRiffRateBeats,
        officialTempo: parameters.autoRiffOfficialTempo,
        quarterNotesPerMeasure: parameters.quarterNotesPerMeasure,
        hold: parameters.autoRiffHold,
        attack: parameters.autoRiffAttack,
        loop: parameters.autoRiffLoop,
        key: parameters.autoRiffKey,
        onsetSensitivity: Number.isFinite(parameters.autoRiffSensitivityPercent)
          ? (parameters.autoRiffSensitivityPercent as number) / 100
          : undefined,
      })
      : null;
    this.hrmAuto = algorithm === 'hrm-auto'
      ? new BrowserHrmAutoDsp(this.sampleRate, {
        key: parameters.hrmAutoKey,
        scale: parameters.hrmAutoScale,
        midiChannel: parameters.hrmAutoMidiChannel,
        mix: parameters.hrmAutoMixPercent,
        officialManualVoice: parameters.hrmAutoOfficialManualVoice,
        officialAutoVoice: parameters.hrmAutoOfficialVoice,
        officialHrmMode: parameters.hrmAutoOfficialHrmMode,
        voices: 2,
      })
      : null;
    this.robot = algorithm === 'robot'
      ? new BrowserRobotDsp(this.sampleRate, { pitch: parameters.robotPitch, note: parameters.robotNote })
      : null;
    this.patternSlicer = algorithm === 'pattern-slicer'
      ? new BrowserPatternSlicerDsp(this.sampleRate, {
        bpm: parameters.bpm,
        pattern: parameters.patternSlicerPattern,
        rateBeats: parameters.patternSlicerRateBeats,
        depthPercent: parameters.patternSlicerDepthPercent,
        edgeMs: parameters.patternSlicerEdgeMs,
      })
      : null;
    this.stepSlicer = algorithm === 'step-slicer'
      ? new BrowserStepSlicerDsp(this.sampleRate, {
        bpm: parameters.bpm,
        stepCount: parameters.stepSlicerStepCount,
        rateBeats: parameters.stepSlicerRateBeats,
        depthPercent: parameters.stepSlicerDepthPercent,
        panDepthPercent: parameters.stepSlicerPanDepthPercent,
        filterHz: parameters.stepSlicerFilterHz,
        step01: parameters.stepSlicerStep01,
        step02: parameters.stepSlicerStep02,
        step03: parameters.stepSlicerStep03,
        step04: parameters.stepSlicerStep04,
        step05: parameters.stepSlicerStep05,
        step06: parameters.stepSlicerStep06,
        step07: parameters.stepSlicerStep07,
        step08: parameters.stepSlicerStep08,
        step09: parameters.stepSlicerStep09,
        step10: parameters.stepSlicerStep10,
        step11: parameters.stepSlicerStep11,
        step12: parameters.stepSlicerStep12,
        step13: parameters.stepSlicerStep13,
        step14: parameters.stepSlicerStep14,
        step15: parameters.stepSlicerStep15,
        step16: parameters.stepSlicerStep16,
      })
      : null;
    const loFiParameters: LoFiDspParameters = {
      bitDepth: parameters.loFiBitDepth,
      sampleRateHz: parameters.loFiSampleRateHz,
      filterHz: parameters.loFiFilterHz,
    };
    this.loFi = algorithm === 'lo-fi' ? new LoFiDsp(this.sampleRate, loFiParameters) : null;
    const equalizerParameters: EqualizerDspParameters = {
      lowFrequencyHz: parameters.eqLowFrequencyHz,
      lowGainDb: parameters.eqLowGainDb,
      mid1FrequencyHz: parameters.eqMid1FrequencyHz,
      mid1Q: parameters.eqMid1Q,
      mid1GainDb: parameters.eqMid1GainDb,
      mid2FrequencyHz: parameters.eqMid2FrequencyHz,
      mid2Q: parameters.eqMid2Q,
      mid2GainDb: parameters.eqMid2GainDb,
      highFrequencyHz: parameters.eqHighFrequencyHz,
      highGainDb: parameters.eqHighGainDb,
    };
    this.equalizer = algorithm === 'eq' ? new EqualizerDsp(this.sampleRate, equalizerParameters) : null;
    this.tapeEcho = algorithm === 'tape-echo'
      ? new BrowserTapeEchoDsp(this.sampleRate, {
        timeMs: parameters.tapeEchoTimeMs,
        feedback: parameters.tapeEchoFeedback,
        wow: parameters.tapeEchoWow,
        saturation: parameters.tapeEchoSaturation,
        toneHz: parameters.tapeEchoToneHz,
      })
      : null;
    this.twist = algorithm === 'twist'
      ? new BrowserTwistDsp(this.sampleRate, {
        amount: parameters.twistAmount,
        trajectory: parameters.twistTrajectory,
      })
      : null;
    this.granularDelay = algorithm === 'granular-delay'
      ? new BrowserGranularDelayDsp(this.sampleRate, {
        grainSizeMs: parameters.granularGrainSizeMs,
        densityHz: parameters.granularDensityHz,
        pitchSemitones: parameters.granularPitchSemitones,
        positionJitterPercent: parameters.granularPositionJitterPercent,
        feedbackPercent: parameters.granularFeedbackPercent,
      })
      : null;
    this.radio = algorithm === 'radio'
      ? new BrowserRadioDsp(this.sampleRate, {
        band: parameters.radioBand,
        drive: parameters.radioDrive,
        noise: parameters.radioNoise,
      })
      : null;
    this.vibrato = algorithm === 'vibrato'
      ? new BrowserVibratoDsp(this.sampleRate, {
        rateHz: parameters.vibratoRateHz,
        depthPercent: parameters.vibratoDepthPercent,
        delayMs: parameters.vibratoDelayMs,
      })
      : null;
    this.sustainer = algorithm === 'sustainer'
      ? new BrowserSustainerDsp(this.sampleRate, {
        attackMs: parameters.attackMs,
        thresholdDb: parameters.thresholdDb,
        ratio: parameters.ratio,
        releaseMs: parameters.releaseMs,
        outputDb: parameters.outputDb,
      })
      : null;
    this.preamp = algorithm === 'preamp'
      ? new BrowserPreampDsp(this.sampleRate, {
        model: parameters.preampModel,
        gainPercent: parameters.preampGainPercent,
        bassDb: parameters.preampBassDb,
        middleDb: parameters.preampMiddleDb,
        trebleDb: parameters.preampTrebleDb,
        levelDb: parameters.preampLevelDb,
      })
      : null;
    this.synth = algorithm === 'synth'
      ? new BrowserSynthDsp(this.sampleRate, {
        sensitivity: parameters.synthSensitivity,
        waveform: parameters.synthWaveform,
        octave: parameters.synthOctave,
        tone: parameters.synthToneHz,
        mix: parameters.synthMixPercent,
      })
      : null;
    this.g2b = algorithm === 'g2b'
      ? new BrowserG2bDsp(this.sampleRate, {
        tracking: parameters.g2bTrackingPercent,
        blend: parameters.g2bBlendPercent,
        body: parameters.g2bBodyHz,
      })
      : null;
    this.vocoder = algorithm === 'vocoder'
      ? new BrowserVocoderCore(this.sampleRate, {
        bands: parameters.vocoderBands,
        carrier: parameters.vocoderCarrier,
      })
      : null;
    this.electric = algorithm === 'electric'
      ? new BrowserElectricDsp(this.sampleRate, {
        character: parameters.electricCharacter,
        pitchSnapPercent: parameters.electricPitchSnapPercent,
        toneHz: parameters.electricToneHz,
      })
      : null;
    this.oscVoc = algorithm === 'osc-voc'
      ? new BrowserOscVocCore(this.sampleRate, {
        waveform: parameters.oscVocWaveform,
        midiChannel: parameters.oscVocMidiChannel,
        octave: parameters.oscVocOctave,
        bands: parameters.oscVocBands,
      }, initialFrame)
      : null;
    this.oscBot = algorithm === 'osc-bot'
      ? new BrowserOscBotCore(this.sampleRate, {
        waveform: parameters.oscBotWaveform as 0 | 1 | 2 | undefined,
        pattern: parameters.oscBotPattern,
        toneCutoffHz: parameters.oscBotToneHz,
        tempoBpm: parameters.bpm,
        mix: 1,
      })
      : null;
    this.slowGear = algorithm === 'slow-gear'
      ? new BrowserSlowGearDsp(this.sampleRate, {
        attackMs: parameters.slowGearAttackMs,
        sensitivityPercent: parameters.slowGearSensitivityPercent,
      })
      : null;
    this.isolator = algorithm === 'isolator'
      ? new BrowserIsolatorDsp(this.sampleRate, {
        lowGainDb: parameters.isolatorLowGainDb,
        midGainDb: parameters.isolatorMidGainDb,
        highGainDb: parameters.isolatorHighGainDb,
        gateRateBeats: parameters.isolatorGateRateBeats,
        gateDepthPercent: parameters.isolatorGateDepthPercent,
        bpm: parameters.bpm,
      })
      : null;
    this.vinylFlick = algorithm === 'vinyl-flick'
      ? new BrowserVinylFlickDsp(this.sampleRate, {
        speed: parameters.vinylFlickSpeed,
        returnTimeSeconds: parameters.vinylFlickReturnTimeSeconds,
        brakePercent: parameters.vinylFlickBrakePercent,
      })
      : null;
    this.panningDelay = algorithm === 'panning-delay'
      ? new BrowserPanningDelayDsp(this.sampleRate, {
        timeMs: parameters.panningDelayTimeMs,
        feedback: parameters.panningDelayFeedback,
        pan: parameters.panningDelayPan,
        mix: 100,
      })
      : null;
    this.modDelay = algorithm === 'mod-delay'
      ? new BrowserModDelayDsp(this.sampleRate, {
        timeMs: parameters.modDelayTimeMs,
        rateHz: parameters.modDelayRateHz,
        depthMs: parameters.modDelayDepthMs,
        feedbackPercent: parameters.modDelayFeedbackPercent,
      })
      : null;
    this.manualPanPosition = new LinearParameterSmoother(clamp(parameters.manualPanPosition ?? 0, -1, 1));
    this.manualPanLeftTable = new Float32Array(2049);
    this.manualPanRightTable = new Float32Array(2049);
    for (let index = 0; index < this.manualPanLeftTable.length; index += 1) {
      const angle = (index / (this.manualPanLeftTable.length - 1)) * (Math.PI / 2);
      this.manualPanLeftTable[index] = Math.cos(angle);
      this.manualPanRightTable[index] = Math.sin(angle);
    }

    if (this.algorithm === 'reverb' || this.algorithm === 'gate-reverb') {
      for (let index = 0; index < 16; index += 1) {
        const channel = index < 8 ? 0 : 1;
        const line = index & 7;
        const stereoScale = channel === 0 ? 1 : 1.013;
        const samples = Math.max(2, Math.round((DEFAULT_DELAY_SECONDS[line] ?? DEFAULT_DELAY_SECONDS[0]) * this.sampleRate * stereoScale));
        this.delayLengths[index] = samples;
        this.fdnBuffers[index] = new Float32Array(samples + 6);
        this.delayModPhases[index] = channel === 0 ? line * 0.37 : 0.19 + line * 0.41;
        this.delayModPhaseSteps[index] = TWO_PI * (0.071 + line * 0.013) / this.sampleRate;
      }
      this.earlyRingLength = Math.max(2, Math.ceil(this.sampleRate * 0.035) + 1);
      this.earlyBuffers = [new Float32Array(this.earlyRingLength), new Float32Array(this.earlyRingLength)];
    } else {
      this.earlyRingLength = 0;
      this.earlyBuffers = [undefined, undefined];
    }
    this.flangerWriteIndices = new Int32Array(2);
    this.flangerPhases = new Float64Array([0, Math.PI]);
    this.flangerFeedbackStates = new Float64Array(2);
    if (this.algorithm === 'flanger') {
      const capacity = Math.ceil((FLANGER_MAX_DELAY_MILLISECONDS * this.sampleRate) / 1000) + 8;
      this.flangerBuffers = [new Float32Array(capacity), new Float32Array(capacity)];
    } else {
      this.flangerBuffers = [undefined, undefined];
    }
    this.delayWriteIndices = new Int32Array(2);
    this.delayToneStates = new Float64Array(2);
    this.delayToneAlpha = 1 - Math.exp(-TWO_PI * initialDelayToneHz / this.sampleRate);
    if (this.algorithm === 'delay') {
      const capacity = Math.ceil((DELAY_MAX_TIME_MILLISECONDS * this.sampleRate) / 1000) + 8;
      this.delayBuffers = [new Float32Array(capacity), new Float32Array(capacity)];
    } else {
      this.delayBuffers = [undefined, undefined];
    }
    this.chorusWriteIndices = new Int32Array(8);
    this.chorusFeedbackStates = new Float64Array(8);
    this.chorusVoiceCount = initialChorusVoices;
    this.chorusToneAlpha = 1 - Math.exp(-TWO_PI * initialChorusToneHz / this.sampleRate);
    this.chorusPhaseStep = TWO_PI * initialChorusRateHz / this.sampleRate;
    if (this.algorithm === 'chorus') {
      const capacity = Math.ceil((CHORUS_MAX_DELAY_MILLISECONDS * this.sampleRate) / 1000) + 8;
      this.chorusBuffers = new Array<Float32Array | undefined>(8);
      for (let index = 0; index < this.chorusBuffers.length; index += 1) {
        this.chorusBuffers[index] = new Float32Array(capacity);
      }
    } else {
      this.chorusBuffers = new Array<Float32Array | undefined>(8);
    }
    this.phaserInputStates = new Float64Array(2 * PHASER_MAX_STAGES);
    this.phaserOutputStates = new Float64Array(2 * PHASER_MAX_STAGES);
    this.phaserFeedbackStates = new Float64Array(2);
    this.phaserToneAlpha = 1 - Math.exp(-TWO_PI * Math.min(PHASER_FEEDBACK_FILTER_HZ, nyquist) / this.sampleRate);
    this.phaserStageCount = initialPhaserStages;
    this.phaserPhaseStep = TWO_PI * initialPhaserRateHz / this.sampleRate;
    this.tremoloPhaseStep = initialTremoloRateHz / this.sampleRate;
    this.autoPanPhaseStep = initialAutoPanRateHz / this.sampleRate;
    this.earlyDelays = new Int32Array(EARLY_REFLECTION_DELAYS_SECONDS.length);
    if (this.algorithm === 'reverb' || this.algorithm === 'gate-reverb') {
      for (let index = 0; index < EARLY_REFLECTION_DELAYS_SECONDS.length; index += 1) {
        this.earlyDelays[index] = Math.min(
          this.earlyRingLength - 1,
          Math.round((EARLY_REFLECTION_DELAYS_SECONDS[index] ?? 0) * this.sampleRate),
        );
      }
      this.refreshTimeVariantCoefficients(initialDecay, initialDamping);
    }
    this.applyOfficialControls(true);
  }

  /**
   * Update targets from outside the render loop. Invalid individual values
   * are ignored; ranges are authored safety limits, not device-manufacturer
   * parameter claims.
   */
  setParameters(parameters: BrowserFxParameters): void {
    const previousCarrier = this.official.get('carrier', -1);
    parameters = this.official.translate(parameters);
    if (this.algorithm === 'vocoder' && this.official.get('carrier', -1) !== previousCarrier) this.vocoder?.reset();
    const nyquist = this.sampleRate * 0.499;
    if (this.algorithm === 'vocoder') {
      validateBrowserVocoderParameters(parameters);
      if (parameters.vocoderBands !== undefined || parameters.vocoderCarrier !== undefined) {
        this.vocoder?.setParameters({ bands: parameters.vocoderBands, carrier: parameters.vocoderCarrier });
      }
    }
    if (this.algorithm === 'electric') {
      validateBrowserElectricParameters(parameters);
      this.electric?.setParameters({
        character: parameters.electricCharacter,
        pitchSnapPercent: parameters.electricPitchSnapPercent,
        toneHz: parameters.electricToneHz,
      });
    }
    if (this.algorithm === 'osc-bot') {
      validateBrowserOscBotParameters(parameters, this.sampleRate);
      this.oscBot?.setParameters({
        waveform: parameters.oscBotWaveform as 0 | 1 | 2 | undefined,
        pattern: parameters.oscBotPattern,
        toneCutoffHz: parameters.oscBotToneHz,
        tempoBpm: parameters.bpm,
      });
    }
    if (this.algorithm === 'osc-voc') {
      validateBrowserOscVocParameters(parameters);
      this.oscVoc?.setParameters({
        waveform: parameters.oscVocWaveform,
        midiChannel: parameters.oscVocMidiChannel,
        octave: parameters.oscVocOctave,
        bands: parameters.oscVocBands,
      });
    }
    if (this.algorithm === 'freeze' && Number.isFinite(parameters.freezeMode) && parameters.freezeMode !== 0) {
      throw new RangeError('Spectral FREEZE mode is unavailable; only micro-loop mode is wired.');
    }
    this.controlsSteady = false;
    this.controlSmoothersSettled = false;
    this.controlSettleScanCountdown = 0;
    if (Number.isFinite(parameters.cutoffHz)) this.cutoff.setTarget(clamp(parameters.cutoffHz as number, 20, nyquist));
    if ((this.algorithm === 'lpf' || this.algorithm === 'hpf') && Number.isFinite(parameters.filterResonancePercent)) {
      this.q.setTarget(filterResonancePercentToQ(parameters.filterResonancePercent as number));
    } else if (Number.isFinite(parameters.q)) {
      this.q.setTarget(clamp(parameters.q as number, 0.1, 30));
    }
    if (Number.isFinite(parameters.mix)) this.wet.setTarget(clamp(parameters.mix as number, 0, 1));
    if (Number.isFinite(parameters.decaySeconds)) this.decaySeconds.setTarget(clamp(parameters.decaySeconds as number, 0.1, 20));
    if (Number.isFinite(parameters.dampingHz)) this.dampingHz.setTarget(clamp(parameters.dampingHz as number, 200, nyquist));
    if (Number.isFinite(parameters.gateThresholdDb)) this.gateThresholdDb.setTarget(clamp(parameters.gateThresholdDb as number, -60, 0));
    if (Number.isFinite(parameters.gateHoldMs)) this.gateHoldMs.setTarget(clamp(parameters.gateHoldMs as number, 5, 2000));
    if (Number.isFinite(parameters.gateReleaseMs)) this.gateReleaseMs.setTarget(clamp(parameters.gateReleaseMs as number, 10, 2000));
    if (Number.isFinite(parameters.ringModHz)) this.ringModHz.setTarget(clamp(parameters.ringModHz as number, 0, Math.min(8000, this.sampleRate * 0.45)));
    if (Number.isFinite(parameters.ringModDepth)) this.ringModDepth.setTarget(clamp(parameters.ringModDepth as number, 0, 1));
    if (parameters.ringModWaveform === 0 || parameters.ringModWaveform === 1) this.ringModWaveform.setTarget(parameters.ringModWaveform);
    if (Number.isFinite(parameters.driveDb)) this.driveDb.setTarget(clamp(parameters.driveDb as number, 0, 36));
    if (Number.isFinite(parameters.outputDb)) this.outputDb.setTarget(clamp(parameters.outputDb as number, -24, 12));
    if (isDistortionMode(parameters.distortionMode)) this.requestDistortionMode(parameters.distortionMode);
    if (Number.isFinite(parameters.flangerDelayMs)) this.flangerDelayMs.setTarget(clamp(parameters.flangerDelayMs as number, FLANGER_MIN_DELAY_MILLISECONDS, FLANGER_MAX_DELAY_MILLISECONDS));
    if (Number.isFinite(parameters.flangerRateHz)) this.flangerRateHz.setTarget(clamp(parameters.flangerRateHz as number, 0.05, 20));
    if (Number.isFinite(parameters.flangerDepth)) this.flangerDepth.setTarget(clamp(parameters.flangerDepth as number, 0, 1));
    if (Number.isFinite(parameters.flangerFeedback)) this.flangerFeedback.setTarget(clamp(parameters.flangerFeedback as number, -0.95, 0.95));
    if (Number.isFinite(parameters.thresholdDb)) this.dynamicsThreshold.setTarget(clamp(parameters.thresholdDb as number, -60, 0));
    if (Number.isFinite(parameters.ratio)) this.dynamicsRatio.setTarget(clamp(parameters.ratio as number, 1, 20));
    if (Number.isFinite(parameters.kneeDb)) this.dynamicsKnee.setTarget(clamp(parameters.kneeDb as number, 0, 24));
    if (Number.isFinite(parameters.attackMs)) this.dynamicsAttackMs.setTarget(clamp(parameters.attackMs as number, 0.1, 100));
    if (Number.isFinite(parameters.releaseMs)) this.dynamicsReleaseMs.setTarget(clamp(parameters.releaseMs as number, 5, 1000));
    if (parameters.dynamicsDetector === 'peak' || parameters.dynamicsDetector === 'rms') this.dynamicsDetector = parameters.dynamicsDetector;
    if (Number.isFinite(parameters.delayTimeMs)) this.delayTimeMs.setTarget(clamp(parameters.delayTimeMs as number, DELAY_MIN_TIME_MILLISECONDS, DELAY_MAX_TIME_MILLISECONDS));
    if (Number.isFinite(parameters.delayFeedback)) this.delayFeedback.setTarget(clamp(parameters.delayFeedback as number, 0, 0.95));
    if (Number.isFinite(parameters.delayToneHz)) this.delayToneHz.setTarget(clamp(parameters.delayToneHz as number, 100, Math.min(16000, this.sampleRate * 0.499)));
    if (this.algorithm === 'mod-delay') {
      this.modDelay?.setParameters({
        timeMs: parameters.modDelayTimeMs,
        rateHz: parameters.modDelayRateHz,
        depthMs: parameters.modDelayDepthMs,
        feedbackPercent: parameters.modDelayFeedbackPercent,
      });
    }
    if (this.algorithm === 'panning-delay') {
      this.panningDelay?.setParameters({
        timeMs: parameters.panningDelayTimeMs,
        feedback: parameters.panningDelayFeedback,
        pan: parameters.panningDelayPan,
      });
    }
    if (Number.isFinite(parameters.chorusDelayMs)) this.chorusDelayMs.setTarget(clamp(parameters.chorusDelayMs as number, CHORUS_MIN_DELAY_MILLISECONDS, CHORUS_MAX_DELAY_MILLISECONDS));
    if (Number.isFinite(parameters.chorusRateHz)) this.chorusRateHz.setTarget(clamp(parameters.chorusRateHz as number, 0.05, 10));
    if (Number.isFinite(parameters.chorusDepthMs)) this.chorusDepthMs.setTarget(clamp(parameters.chorusDepthMs as number, 0.2, 20));
    if (Number.isFinite(parameters.chorusVoices)) this.chorusVoiceCount = Math.round(clamp(parameters.chorusVoices as number, 2, 4));
    if (Number.isFinite(parameters.chorusFeedback)) this.chorusFeedback.setTarget(clamp(parameters.chorusFeedback as number, 0, CHORUS_FEEDBACK_MAX));
    if (Number.isFinite(parameters.chorusToneHz)) this.chorusToneHz.setTarget(clamp(parameters.chorusToneHz as number, 100, Math.min(16000, this.sampleRate * 0.499)));
    if (Number.isFinite(parameters.phaserRateHz)) this.phaserRateHz.setTarget(clamp(parameters.phaserRateHz as number, 0.05, 20));
    if (Number.isFinite(parameters.phaserDepth)) this.phaserDepth.setTarget(clamp(parameters.phaserDepth as number, 0, 1));
    if (Number.isFinite(parameters.phaserFeedback)) this.phaserFeedback.setTarget(clamp(parameters.phaserFeedback as number, 0, PHASER_FEEDBACK_MAX));
    if (Number.isFinite(parameters.phaserStages)) this.phaserStageCount = clamp(parameters.phaserStages as number, 4, PHASER_MAX_STAGES) < 6 ? 4 : 8;
    if (Number.isFinite(parameters.tremoloRateHz)) this.tremoloRateHz.setTarget(clamp(parameters.tremoloRateHz as number, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ));
    if (Number.isFinite(parameters.tremoloDepth)) this.tremoloDepth.setTarget(clamp(parameters.tremoloDepth as number, 0, 1));
    if (isTremoloWaveform(parameters.tremoloWaveform)) this.requestTremoloWaveform(parameters.tremoloWaveform);
    if (Number.isFinite(parameters.autoPanRateHz)) this.autoPanRateHz.setTarget(clamp(parameters.autoPanRateHz as number, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ));
    if (Number.isFinite(parameters.autoPanDepth)) this.autoPanDepth.setTarget(clamp(parameters.autoPanDepth as number, 0, 1));
    if (isTremoloWaveform(parameters.autoPanWaveform)) this.requestAutoPanWaveform(parameters.autoPanWaveform);
    if (Number.isFinite(parameters.stereoWidth)) this.stereoWidth.setTarget(clamp(parameters.stereoWidth as number, 0, 2));
    if (Number.isFinite(parameters.stereoLowMonoCutoffHz)) this.stereoLowMonoCutoffHz.setTarget(clamp(parameters.stereoLowMonoCutoffHz as number, 20, Math.min(1000, this.sampleRate * 0.499)));
    if (Number.isFinite(parameters.stereoDecorrelation)) this.stereoDecorrelation.setTarget(clamp(parameters.stereoDecorrelation as number, 0, 1));
    if (this.algorithm === 'beat-repeat') this.beatRepeat?.setParameters(parameters);
    if (this.algorithm === 'roll') {
      this.roll?.setParameters({
        bpm: parameters.bpm,
        sliceBeats: parameters.rollSliceBeats,
        decayPercent: parameters.rollDecayPercent,
        pitchSemitones: parameters.rollPitchSemitones,
        direction: parameters.rollDirection === 1 ? 'reverse' : parameters.rollDirection === 2 ? 'alternate' : 'forward',
      });
    }
    if (this.algorithm === 'freeze') {
      this.freeze?.setParameters({
        captureLengthMs: parameters.freezeCaptureLengthMs,
        pitchSemitones: parameters.freezePitchSemitones,
        frozen: Number.isFinite(parameters.freezeEnabled) ? (parameters.freezeEnabled as number) >= 0.5 : undefined,
      });
    }
    if (this.algorithm === 'warp') {
      this.warp?.setParameters({
        bpm: parameters.bpm,
        captureBeats: parameters.warpCaptureBeats,
        smearPercent: parameters.warpSmearPercent,
        pitchSemitones: parameters.warpPitchSemitones,
        feedbackPercent: parameters.warpFeedbackPercent,
        frozen: Number.isFinite(parameters.warpFreezeEnabled)
          ? (parameters.warpFreezeEnabled as number) >= 0.5
          : undefined,
      });
    }
    if (this.algorithm === 'beat-scatter') {
      this.beatScatter?.setParameters({
        bpm: parameters.bpm,
        sliceBeats: parameters.beatScatterSliceBeats,
        scatterPercent: parameters.beatScatterScatterPercent,
        pitchSemitones: parameters.beatScatterPitchSemitones,
        repeats: parameters.beatScatterRepeats,
      });
    }
    if (this.algorithm === 'beat-shift') {
      this.beatShift?.setParameters({
        bpm: parameters.bpm,
        offsetBeats: parameters.beatShiftOffsetBeats,
        crossfadeMs: parameters.beatShiftCrossfadeMs,
      });
    }
    if (this.algorithm === 'reverse-delay') {
      this.reverseDelay?.setParameters({
        bpm: parameters.bpm,
        segmentBeats: parameters.reverseDelaySegmentBeats,
        feedback: parameters.reverseDelayFeedback,
        crossfadeMs: parameters.reverseDelayCrossfadeMs,
      });
    }
    if (this.algorithm === 'reverse-reverb') {
      this.reverseReverb?.setParameters({
        bpm: parameters.bpm,
        segmentBeats: parameters.reverseReverbSegmentBeats,
        feedbackPercent: parameters.reverseReverbFeedbackPercent,
        crossfadeMs: parameters.reverseReverbCrossfadeMs,
        decaySeconds: parameters.reverseReverbDecaySeconds ?? parameters.decaySeconds,
        dampingCutoffHz: parameters.reverseReverbDampingCutoffHz ?? parameters.dampingHz,
      });
    }
    if (this.algorithm === 'auto-riff') {
      this.autoRiff?.setParameters({
        bpm: parameters.bpm,
        scale: Number.isFinite(parameters.autoRiffScale) ? parameters.autoRiffScale as 0 | 1 | 2 | 3 | 4 : undefined,
        beatStepRate: parameters.autoRiffRateBeats,
        officialTempo: parameters.autoRiffOfficialTempo,
        quarterNotesPerMeasure: parameters.quarterNotesPerMeasure,
        hold: parameters.autoRiffHold,
        attack: parameters.autoRiffAttack,
        loop: parameters.autoRiffLoop,
        key: parameters.autoRiffKey,
        onsetSensitivity: Number.isFinite(parameters.autoRiffSensitivityPercent)
          ? (parameters.autoRiffSensitivityPercent as number) / 100
          : undefined,
      });
    }
    if (this.algorithm === 'hrm-auto') {
      this.hrmAuto?.setParameters({
        key: parameters.hrmAutoKey,
        scale: parameters.hrmAutoScale,
        midiChannel: parameters.hrmAutoMidiChannel,
        mix: parameters.hrmAutoMixPercent,
        officialManualVoice: parameters.hrmAutoOfficialManualVoice,
        officialAutoVoice: parameters.hrmAutoOfficialVoice,
        officialHrmMode: parameters.hrmAutoOfficialHrmMode,
      });
    }
    if (this.algorithm === 'robot') {
      this.robot?.setParameters({ pitch: parameters.robotPitch, formant: parameters.robotFormantSemitones, note: parameters.robotNote });
    }
    if (this.algorithm === 'pattern-slicer') {
      this.patternSlicer?.setParameters({
        bpm: parameters.bpm,
        pattern: parameters.patternSlicerPattern,
        rateBeats: parameters.patternSlicerRateBeats,
        depthPercent: parameters.patternSlicerDepthPercent,
        edgeMs: parameters.patternSlicerEdgeMs,
      });
    }
    if (this.algorithm === 'step-slicer') {
      this.stepSlicer?.setParameters({
        bpm: parameters.bpm,
        stepCount: parameters.stepSlicerStepCount,
        rateBeats: parameters.stepSlicerRateBeats,
        depthPercent: parameters.stepSlicerDepthPercent,
        panDepthPercent: parameters.stepSlicerPanDepthPercent,
        filterHz: parameters.stepSlicerFilterHz,
        step01: parameters.stepSlicerStep01,
        step02: parameters.stepSlicerStep02,
        step03: parameters.stepSlicerStep03,
        step04: parameters.stepSlicerStep04,
        step05: parameters.stepSlicerStep05,
        step06: parameters.stepSlicerStep06,
        step07: parameters.stepSlicerStep07,
        step08: parameters.stepSlicerStep08,
        step09: parameters.stepSlicerStep09,
        step10: parameters.stepSlicerStep10,
        step11: parameters.stepSlicerStep11,
        step12: parameters.stepSlicerStep12,
        step13: parameters.stepSlicerStep13,
        step14: parameters.stepSlicerStep14,
        step15: parameters.stepSlicerStep15,
        step16: parameters.stepSlicerStep16,
      });
    }
    if (this.algorithm === 'sustainer') this.sustainer?.setParameters(parameters);
    if (this.algorithm === 'preamp') {
      this.preamp?.setParameters({
        model: parameters.preampModel,
        gainPercent: parameters.preampGainPercent,
        bassDb: parameters.preampBassDb,
        middleDb: parameters.preampMiddleDb,
        trebleDb: parameters.preampTrebleDb,
        levelDb: parameters.preampLevelDb,
      });
    }
    if (this.algorithm === 'synth') {
      this.synth?.setParameters({
        sensitivity: parameters.synthSensitivity,
        waveform: parameters.synthWaveform,
        octave: parameters.synthOctave,
        tone: parameters.synthToneHz,
        mix: parameters.synthMixPercent,
      });
    }
    if (this.algorithm === 'g2b') {
      this.g2b?.setParameters({
        tracking: parameters.g2bTrackingPercent,
        blend: parameters.g2bBlendPercent,
        body: parameters.g2bBodyHz,
      });
    }
    if (this.algorithm === 'slow-gear') {
      this.slowGear?.setParameters({
        attackMs: parameters.slowGearAttackMs,
        sensitivityPercent: parameters.slowGearSensitivityPercent,
      });
    }
    if (this.algorithm === 'isolator') {
      this.isolator?.setParameters({
        lowGainDb: parameters.isolatorLowGainDb,
        midGainDb: parameters.isolatorMidGainDb,
        highGainDb: parameters.isolatorHighGainDb,
        gateRateBeats: parameters.isolatorGateRateBeats,
        gateDepthPercent: parameters.isolatorGateDepthPercent,
        bpm: parameters.bpm,
      });
    }
    if (this.algorithm === 'vinyl-flick') {
      this.vinylFlick?.setParameters({
        speed: parameters.vinylFlickSpeed,
        returnTimeSeconds: parameters.vinylFlickReturnTimeSeconds,
        brakePercent: parameters.vinylFlickBrakePercent,
      });
    }
    if (this.algorithm === 'lo-fi') {
      this.loFi?.setParameters({
        bitDepth: parameters.loFiBitDepth,
        sampleRateHz: parameters.loFiSampleRateHz,
        filterHz: parameters.loFiFilterHz,
      });
    }
    if (this.algorithm === 'eq') {
      this.equalizer?.setParameters({
        lowFrequencyHz: parameters.eqLowFrequencyHz,
        lowGainDb: parameters.eqLowGainDb,
        mid1FrequencyHz: parameters.eqMid1FrequencyHz,
        mid1Q: parameters.eqMid1Q,
        mid1GainDb: parameters.eqMid1GainDb,
        mid2FrequencyHz: parameters.eqMid2FrequencyHz,
        mid2Q: parameters.eqMid2Q,
        mid2GainDb: parameters.eqMid2GainDb,
        highFrequencyHz: parameters.eqHighFrequencyHz,
        highGainDb: parameters.eqHighGainDb,
      });
    }
    if (this.algorithm === 'tape-echo') {
      this.tapeEcho?.setParameters({
        timeMs: parameters.tapeEchoTimeMs,
        feedback: parameters.tapeEchoFeedback,
        wow: parameters.tapeEchoWow,
        saturation: parameters.tapeEchoSaturation,
        toneHz: parameters.tapeEchoToneHz,
      });
    }
    if (this.algorithm === 'twist') {
      this.twist?.setParameters({
        amount: parameters.twistAmount,
        trajectory: parameters.twistTrajectory,
      });
    }
    if (this.algorithm === 'granular-delay') {
      this.granularDelay?.setParameters({
        grainSizeMs: parameters.granularGrainSizeMs,
        densityHz: parameters.granularDensityHz,
        pitchSemitones: parameters.granularPitchSemitones,
        positionJitterPercent: parameters.granularPositionJitterPercent,
        feedbackPercent: parameters.granularFeedbackPercent,
      });
    }
    if (this.algorithm === 'radio') {
      this.radio?.setParameters({
        band: parameters.radioBand,
        drive: parameters.radioDrive,
        noise: parameters.radioNoise,
      });
    }
    if (this.algorithm === 'vibrato') {
      this.vibrato?.setParameters({
        rateHz: parameters.vibratoRateHz,
        depthPercent: parameters.vibratoDepthPercent,
        delayMs: parameters.vibratoDelayMs,
      });
    }
    if (Number.isFinite(parameters.manualPanPosition)) {
      this.manualPanPosition.setTarget(clamp(parameters.manualPanPosition as number, -1, 1), Math.round(this.sampleRate * DEFAULT_SMOOTHING_SECONDS));
    }
    this.applyOfficialControls(false);
  }

  /** Small read-only diagnostics for deterministic clock tests and host status. */
  get beatRepeatDiagnostics(): Readonly<{
    boundaryCount: number;
    framesProcessed: number;
    lastBoundaryFrame: number;
    activeBpm: number;
    activeDivision: number;
    activeDirection: number;
    activeSliceFrames: number;
    remainingFramesToBoundary: number;
    maxSliceFrames: number;
  }> | null {
    const dsp = this.beatRepeat;
    if (!dsp) return null;
    return {
      boundaryCount: dsp.boundaryCount,
      framesProcessed: dsp.framesProcessed,
      lastBoundaryFrame: dsp.lastBoundaryFrame,
      activeBpm: dsp.activeBpm,
      activeDivision: dsp.activeDivision,
      activeDirection: dsp.activeDirection,
      activeSliceFrames: dsp.activeSliceFrames,
      remainingFramesToBoundary: dsp.remainingFramesToBoundary,
      maxSliceFrames: dsp.maxSliceFrames,
    };
  }

  /** Small read-only diagnostics for deterministic grain-clock tests. */
  get beatScatterDiagnostics(): Readonly<{
    boundaryCount: number;
    framesProcessed: number;
    lastBoundaryFrame: number;
    activeBpm: number;
    activeSliceBeats: number;
    activeScatterPercent: number;
    activePitchSemitones: number;
    activeRepeats: number;
    activeSliceFrames: number;
    remainingFramesToBoundary: number;
    maxSliceFrames: number;
    hasCapturedSlice: boolean;
  }> | null {
    const scatter = this.beatScatter;
    if (!scatter) return null;
    return {
      boundaryCount: scatter.boundaryCount,
      framesProcessed: scatter.framesProcessed,
      lastBoundaryFrame: scatter.lastBoundaryFrame,
      activeBpm: scatter.activeBpm,
      activeSliceBeats: scatter.activeSliceBeats,
      activeScatterPercent: scatter.activeScatterPercent,
      activePitchSemitones: scatter.activePitchSemitones,
      activeRepeats: scatter.activeRepeats,
      activeSliceFrames: scatter.activeSliceFrames,
      remainingFramesToBoundary: scatter.remainingFramesToBoundary,
      maxSliceFrames: scatter.maxSliceFrames,
      hasCapturedSlice: scatter.hasCapturedSlice,
    };
  }

  /** Diagnostics for the fixed-capacity signed beat-shift buffer. */
  get beatShiftDiagnostics(): BrowserBeatShiftDsp['diagnostics'] | null {
    return this.beatShift?.diagnostics ?? null;
  }

  /** Diagnostics for the bounded beat-synchronous reverse segment buffers. */
  get reverseDelayDiagnostics(): BrowserReverseDelayDsp['diagnostics'] | null {
    return this.reverseDelay?.diagnostics ?? null;
  }

  /** Diagnostics for the experimental segmented reverse-FDN-tail processor. */
  get reverseReverbDiagnostics(): BrowserReverseReverbDsp['diagnostics'] | null {
    return this.reverseReverb?.diagnostics ?? null;
  }

  /** Pop one bounded AUTO RIFF pitch event for host scheduling. */
  tryPopAutoRiffPitchChange(): boolean {
    return this.autoRiff?.tryPopPitchChange() ?? false;
  }

  get lastAutoRiffPitchFrame(): number { return this.autoRiff?.lastPoppedFrame ?? -1; }
  get lastAutoRiffPitchSemitones(): number { return this.autoRiff?.lastPoppedSemitones ?? 0; }

  /** Pop one bounded HRM AUTO MIDI/analysis target update for host scheduling. */
  tryPopHrmAutoStateChange(): boolean {
    return this.hrmAuto?.tryPopStateChange() ?? false;
  }

  get lastHrmAutoStateFrame(): number { return this.hrmAuto?.lastStateChangeFrame ?? -1; }
  get lastHrmAutoStateReason(): number { return this.hrmAuto?.lastStateChangeReason ?? 0; }
  get lastHrmAutoStateNote(): number { return this.hrmAuto?.lastStateChangeNote ?? -1; }
  get lastHrmAutoStateNoteOn(): boolean { return this.hrmAuto?.lastStateChangeNoteOn ?? false; }
  get lastHrmAutoActiveNoteCount(): number { return this.hrmAuto?.lastStateChangeActiveCount ?? 0; }
  get lastHrmAutoVoiceCount(): number { return this.hrmAuto?.lastStateChangeVoiceCount ?? 0; }
  get lastHrmAutoTarget1(): number { return this.hrmAuto?.lastStateChangeTarget1 ?? -128; }
  get lastHrmAutoTarget2(): number { return this.hrmAuto?.lastStateChangeTarget2 ?? -128; }
  get hrmAutoMidiOverflowCount(): number { return this.hrmAuto?.midiOverflowCount ?? 0; }
  get hrmAutoStateOverflowCount(): number { return this.hrmAuto?.stateOverflowCount ?? 0; }

  /** Pop one bounded ROBOT pitch/F0 state event for host scheduling. */
  tryPopRobotTargetChange(): boolean {
    return this.robot?.tryPopTargetChange() ?? false;
  }

  get lastRobotTargetFrame(): number { return this.robot?.lastTargetFrame ?? -1; }
  get lastRobotTargetSemitones(): number { return this.robot?.lastTargetSemitones ?? 0; }
  get lastRobotTargetSourceMidi(): number { return this.robot?.lastTargetSourceMidi ?? 0; }
  get lastRobotTargetMidi(): number { return this.robot?.lastTargetMidi ?? 0; }
  get lastRobotTargetHz(): number { return this.robot?.lastTargetHz ?? 0; }
  get lastRobotTargetConfidence(): number { return this.robot?.lastTargetConfidence ?? 0; }
  get lastRobotTargetVoiced(): boolean { return this.robot?.lastTargetVoiced ?? false; }
  get lastRobotProcessingMode(): BrowserRobotDsp['processingMode'] { return this.robot?.processingMode ?? 'signalsmith'; }
  get lastRobotModeReason(): BrowserRobotDsp['modeReason'] { return this.robot?.modeReason ?? 'unvoiced'; }
  get lastRobotModeFrame(): number { return this.robot?.modeFrame ?? 0; }
  get robotModeRevision(): number { return this.robot?.modeRevision ?? 0; }
  get robotPsolaLatencySamples(): number { return this.robot?.psolaLatencySamples ?? 0; }
  get robotTrackerAcquisitionFrames(): number { return this.robot?.latencyFrames ?? 0; }

  /** Diagnostics for the sample-clocked PATTERN SLICER table and step phase. */
  get patternSlicerDiagnostics(): BrowserPatternSlicerDsp['diagnostics'] | null {
    return this.patternSlicer?.diagnostics ?? null;
  }

  /** Diagnostics for the editable, sample-clocked STEP SLICER sequence. */
  get stepSlicerDiagnostics(): BrowserStepSlicerDsp['diagnostics'] | null {
    return this.stepSlicer?.diagnostics ?? null;
  }

  setBypass(bypassed: boolean, rampFrames = 0): void {
    if (this.algorithm === 'freeze' && Object.keys(this.official.values).length > 0) {
      this.freeze?.setParameters({ frozen: !bypassed });
      if (bypassed) rampFrames = this.freeze?.officialReleaseFrames ?? rampFrames;
    }
    if (this.algorithm === 'twist' && Object.keys(this.official.values).length > 0) {
      this.twist?.setOfficialActive(!bypassed);
      if (bypassed) rampFrames = this.twist?.officialReleaseFrames ?? rampFrames;
    }
    this.bypassMix.setTarget(bypassed ? 1 : 0, rampFrames);
  }

  get bypassed(): boolean {
    return this.bypassMix.targetValue === 1;
  }

  /** True only after an optional bypass crossfade has reached its endpoint. */
  get fullyBypassed(): boolean {
    return this.bypassMix.currentValue === 1 && this.bypassMix.targetValue === 1 && this.bypassMix.remainingFrames === 0;
  }

  /** Align the MIDI effect scheduler with the host AudioWorklet sample clock. */
  synchronizeFrame(frame: number): void {
    if (Number.isSafeInteger(frame) && frame >= 0) this.currentAudioFrame = Math.floor(frame);
    if (this.algorithm === 'osc-voc') this.oscVoc?.synchronizeFrame(frame);
  }

  scheduleMidiNoteOn(channel: number, note: number, velocity: number, frame: number): void {
    if (this.algorithm === 'osc-voc' && this.oscVoc) {
      this.oscVoc.noteOn(channel, note, velocity, frame);
      return;
    }
    if (this.algorithm === 'hrm-auto' && this.hrmAuto) {
      if (!this.hrmAuto.enqueueMidiEvent('noteOn', channel, note, velocity, frame)) {
        throw new RangeError('HRM AUTO (M) rejected MIDI note-on (invalid event or bounded queue full).');
      }
      return;
    }
    throw new RangeError('MIDI note events are only supported by OSC VOC (M) and HRM AUTO (M).');
  }

  scheduleMidiNoteOff(channel: number, note: number, frame: number): void {
    if (this.algorithm === 'osc-voc' && this.oscVoc) {
      this.oscVoc.noteOff(channel, note, frame);
      return;
    }
    if (this.algorithm === 'hrm-auto' && this.hrmAuto) {
      if (!this.hrmAuto.enqueueMidiEvent('noteOff', channel, note, 0, frame)) {
        throw new RangeError('HRM AUTO (M) rejected MIDI note-off (invalid event or bounded queue full).');
      }
      return;
    }
    throw new RangeError('MIDI note events are only supported by OSC VOC (M) and HRM AUTO (M).');
  }

  scheduleMidiAllNotesOff(frame: number): void {
    if (this.algorithm !== 'osc-voc' || !this.oscVoc) {
      throw new RangeError(`${this.algorithm} does not accept OSC VOC MIDI all-notes-off.`);
    }
    this.oscVoc.allNotesOff(frame);
  }

  /**
   * Process up to two channels. Null input is silence; a mono-to-stereo caller
   * may deliberately pass the same left input for both input channels. Arrays
   * are not retained and no output storage is created by this method.
   */
  processBlock(
    inputLeft: Float32Array | null,
    inputRight: Float32Array | null,
    outputLeft: Float32Array | null,
    outputRight: Float32Array | null,
    frameCount?: number,
    inputIsMono = inputRight === null,
    carrierLeft: Float32Array | null = null,
    carrierRight: Float32Array | null = null,
  ): void {
    this.blocksProcessed += 1;
    const frames = Math.max(0, Math.floor(frameCount ?? Math.max(outputLeft?.length ?? 0, outputRight?.length ?? 0)));
    const inputLeftLength = inputLeft?.length ?? 0;
    const inputRightLength = inputRight?.length ?? 0;
    const outputLeftLength = outputLeft?.length ?? 0;
    const outputRightLength = outputRight?.length ?? 0;

    const monoAutoPanInput = this.algorithm === 'auto-pan' && (!inputRight || inputRightLength === 0);
    const monoStereoEnhanceInput = this.algorithm === 'stereo-enhance' && (!inputRight || inputRightLength === 0);
    const monoManualPanInput = this.algorithm === 'manual-pan' && inputIsMono;
    // BEAT SHIFT, REVERSE DELAY, REVERSE REVERB, VINYL FLICK, and FREEZE keep bounded histories
    // warm while bypassed. Output still stays exact-dry, so a later activation
    // or capture edge has the input history it needs.
    if (this.fullyBypassed && !this.officialRoll && this.algorithm !== 'beat-shift' && this.algorithm !== 'reverse-delay' && this.algorithm !== 'reverse-reverb' && this.algorithm !== 'vinyl-flick' && this.algorithm !== 'freeze' && this.algorithm !== 'osc-voc' && this.algorithm !== 'hrm-auto') {
      // Web Audio's usual equal-size channels can use a native copy without
      // subarray views or per-sample bounds checks. Keep the general path for
      // partial blocks, missing inputs, and deliberately mismatched arrays.
      const bypassRightInput = monoAutoPanInput || monoManualPanInput || monoStereoEnhanceInput
        ? inputLeft : inputRight;
      if (outputLeft && inputLeft && outputLeftLength === frames && inputLeftLength === frames
        && outputLeft.buffer !== inputLeft.buffer
        && (!outputRight || outputLeft.buffer !== outputRight.buffer)
        && (!bypassRightInput || outputLeft.buffer !== bypassRightInput.buffer)
        && (!outputRight || (outputRight.buffer !== inputLeft.buffer && outputRight.buffer !== bypassRightInput?.buffer))
        && ((!outputRight) || (bypassRightInput && outputRightLength === frames && bypassRightInput.length === frames))) {
        outputLeft.set(inputLeft);
        if (outputRight && bypassRightInput) outputRight.set(bypassRightInput);
        this.framesProcessed += frames;
        this.currentAudioFrame += frames;
        return;
      }
      for (let frame = 0; frame < frames; frame += 1) {
        if (frame < outputLeftLength && outputLeft) outputLeft[frame] = frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0;
        if (frame < outputRightLength && outputRight) {
          outputRight[frame] = monoAutoPanInput || monoManualPanInput
            ? (frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0)
            : monoStereoEnhanceInput
              ? (frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0)
            : (frame < inputRightLength ? (inputRight?.[frame] ?? 0) : 0);
        }
      }
      this.framesProcessed += frames;
      this.currentAudioFrame += frames;
      return;
    }

    for (let frame = 0; frame < frames; frame += 1) {
      let dryLeft = frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0;
      let dryRight = monoAutoPanInput || monoStereoEnhanceInput || monoManualPanInput
        ? (frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0)
        : (frame < inputRightLength ? (inputRight?.[frame] ?? 0) : 0);
      if (!Number.isFinite(dryLeft)) {
        dryLeft = 0;
        this.nonFiniteInputSamples += 1;
      }
      if (!Number.isFinite(dryRight)) {
        dryRight = 0;
        this.nonFiniteInputSamples += 1;
      }
      if (Math.abs(dryLeft) < MIN_STATE_MAGNITUDE) dryLeft = 0;
      if (Math.abs(dryRight) < MIN_STATE_MAGNITUDE) dryRight = 0;

      this.advanceControls();
      if (this.officialModulation) this.advanceOfficialModulation();
      if (this.algorithm === 'dynamics') this.updateDynamicsDetector(dryLeft, dryRight);
      if (this.algorithm === 'gate-reverb' && !this.official.has('threshold')) this.updateGateReverbEnvelope(dryLeft, dryRight);
      const wetPosition = this.algorithm === 'electric' && this.electric?.requiresVoicedInput && !this.electric.isVoiced
        ? 0
        : this.algorithm === 'preamp' || this.algorithm === 'synth' || this.algorithm === 'g2b'
        ? 1
        : (this.algorithm === 'beat-repeat' && !this.beatRepeat?.hasCapturedSlice)
        || (this.algorithm === 'roll' && !(this.officialRoll ? this.officialRoll.hasCapturedSlice : this.roll?.hasCapturedSlice))
        || (this.algorithm === 'beat-scatter' && !this.beatScatter?.hasCapturedSlice)
        || (this.algorithm === 'reverse-delay' && !this.reverseDelay?.hasCaptured)
        ? 0
        : this.algorithm === 'beat-shift'
          // This is a read-head position effect, not a delay/effect-send blend.
          // Keep the active output on the shifted head only; bypass remains an
          // explicit click-safe host transition and the prototype has no mix control.
          ? (this.beatShift?.mixAvailability ?? 0)
          : this.algorithm === 'pattern-slicer' || this.algorithm === 'step-slicer'
            ? 1
          : (this.currentControls[2] ?? 1);
      if (wetPosition !== this.cachedWetPosition) {
        this.cachedWetPosition = wetPosition;
        this.cachedWetDryGain = equalPowerFadeOutGain(wetPosition);
        this.cachedWetGain = equalPowerFadeInGain(wetPosition);
      }
      const wetDryGain = this.officialIndependentMix ? this.officialDirectGain.next() : this.cachedWetDryGain;
      const wetGain = this.officialIndependentMix ? this.officialEffectGain.next() : this.cachedWetGain;
      let mixDryLeft = this.algorithm === 'distortion' ? this.processDistortionDryDelay(dryLeft, 0) : dryLeft;
      let mixDryRight = this.algorithm === 'distortion' ? this.processDistortionDryDelay(dryRight, 1) : dryRight;
      let wetLeft: number;
      let wetRight: number;
      if (this.officialReverseReverb) {
        this.officialReverseReverb.processSample(dryLeft, dryRight);
        wetLeft = this.officialReverseReverb.wetLeft; wetRight = this.officialReverseReverb.wetRight;
      } else if (this.officialStepSlicer) {
        this.officialStepSlicer.processSample(dryLeft, dryRight);
        wetLeft = this.officialStepSlicer.wetLeft;
        wetRight = this.officialStepSlicer.wetRight;
      } else if (this.officialRoll) {
        this.officialRoll.processSample(dryLeft, dryRight);
        wetLeft = this.officialRoll.wetLeft;
        wetRight = this.officialRoll.wetRight;
      } else if (this.officialDelay) {
        this.officialDelay.processSample(dryLeft, dryRight);
        wetLeft = this.officialDelay.wetLeft;
        wetRight = this.officialDelay.wetRight;
      } else if (this.algorithm === 'vinyl-flick') {
        this.vinylFlick?.processSample(dryLeft, dryRight);
        wetLeft = this.vinylFlick?.wetLeft ?? dryLeft;
        wetRight = this.vinylFlick?.wetRight ?? dryRight;
        mixDryLeft = this.vinylFlick?.dryLeft ?? dryLeft;
        mixDryRight = this.vinylFlick?.dryRight ?? dryRight;
      } else if (this.algorithm === 'auto-pan') {
        this.processAutoPan(dryLeft, dryRight, monoAutoPanInput);
        wetLeft = this.autoPanWetLeft;
        wetRight = this.autoPanWetRight;
      } else if (this.algorithm === 'beat-repeat') {
        this.beatRepeat?.processSample(dryLeft, dryRight);
        wetLeft = this.beatRepeat?.wetLeft ?? 0;
        wetRight = this.beatRepeat?.wetRight ?? 0;
      } else if (this.algorithm === 'roll') {
        this.roll?.processSample(dryLeft, dryRight);
        wetLeft = this.roll?.wetLeft ?? 0;
        wetRight = this.roll?.wetRight ?? 0;
      } else if (this.algorithm === 'freeze') {
        this.freeze?.processSample(dryLeft, dryRight);
        wetLeft = this.freeze?.outputLeft ?? dryLeft;
        wetRight = this.freeze?.outputRight ?? dryRight;
      } else if (this.algorithm === 'warp') {
        this.warp?.processSample(dryLeft, dryRight);
        wetLeft = this.warp?.wetLeft ?? 0;
        wetRight = this.warp?.wetRight ?? 0;
      } else if (this.algorithm === 'beat-scatter') {
        this.beatScatter?.processSample(dryLeft, dryRight);
        wetLeft = this.beatScatter?.wetLeft ?? 0;
        wetRight = this.beatScatter?.wetRight ?? 0;
      } else if (this.algorithm === 'beat-shift') {
        this.beatShift?.processSample(dryLeft, dryRight);
        wetLeft = this.beatShift?.wetLeft ?? dryLeft;
        wetRight = this.beatShift?.wetRight ?? dryRight;
      } else if (this.algorithm === 'reverse-delay') {
        this.reverseDelay?.processSample(dryLeft, dryRight);
        wetLeft = this.reverseDelay?.wetLeft ?? 0;
        wetRight = this.reverseDelay?.wetRight ?? 0;
      } else if (this.algorithm === 'reverse-reverb') {
        this.reverseReverb?.processSample(dryLeft, dryRight);
        wetLeft = this.reverseReverb?.wetLeft ?? 0;
        wetRight = this.reverseReverb?.wetRight ?? 0;
      } else if (this.algorithm === 'auto-riff') {
        this.autoRiff?.processStereoSample(dryLeft, dryRight, this.currentAudioFrame + frame);
        // Pitch resynthesis is downstream; official HOLD/ATTACK shape this source.
        wetLeft = this.autoRiff?.wetLeft ?? dryLeft;
        wetRight = this.autoRiff?.wetRight ?? dryRight;
      } else if (this.algorithm === 'hrm-auto') {
        this.hrmAuto?.processSample((dryLeft + dryRight) * 0.5, this.currentAudioFrame + frame);
        // Analysis and MIDI voicing only. Host-pinned Signalsmith LIVE_FX
        // nodes perform the actual interval shifts downstream.
        wetLeft = dryLeft;
        wetRight = dryRight;
      } else if (this.algorithm === 'robot') {
        this.robot?.processStereoSample(dryLeft, dryRight, this.currentAudioFrame + frame);
        // Stable voiced monophonic material is synthesized by the bounded
        // fixed-latency PSOLA-lite path. The adapter selects Signalsmith for
        // unstable/polyphonic, unvoiced, out-of-range, and formant-control cases.
        wetLeft = this.robot?.psolaOutputSample ?? 0;
        wetRight = wetLeft;
      } else if (this.algorithm === 'pattern-slicer') {
        this.patternSlicer?.processSample(dryLeft, dryRight);
        wetLeft = this.patternSlicer?.wetLeft ?? dryLeft;
        wetRight = this.patternSlicer?.wetRight ?? dryRight;
      } else if (this.algorithm === 'step-slicer') {
        this.stepSlicer?.processSample(dryLeft, dryRight);
        wetLeft = this.stepSlicer?.wetLeft ?? dryLeft;
        wetRight = this.stepSlicer?.wetRight ?? dryRight;
      } else if (this.algorithm === 'stereo-enhance') {
        this.processStereoEnhance(dryLeft, dryRight);
        wetLeft = this.stereoWetLeft;
        wetRight = this.stereoWetRight;
      } else if (this.algorithm === 'lo-fi') {
        this.loFi?.process(dryLeft, dryRight);
        wetLeft = this.loFi?.wetLeft ?? 0;
        wetRight = this.loFi?.wetRight ?? 0;
      } else if (this.algorithm === 'eq') {
        this.equalizer?.process(dryLeft, dryRight);
        wetLeft = this.equalizer?.outputLeft ?? dryLeft;
        wetRight = this.equalizer?.outputRight ?? dryRight;
      } else if (this.algorithm === 'manual-pan') {
        this.processManualPan(dryLeft, dryRight, monoManualPanInput);
        wetLeft = this.manualPanWetLeft;
        wetRight = this.manualPanWetRight;
      } else if (this.algorithm === 'tape-echo') {
        this.tapeEcho?.processSample(dryLeft, dryRight);
        wetLeft = this.tapeEcho?.wetOutputLeft ?? dryLeft;
        wetRight = this.tapeEcho?.wetOutputRight ?? dryRight;
      } else if (this.algorithm === 'twist') {
        this.twist?.processSample(dryLeft, dryRight);
        wetLeft = this.twist?.wetOutputLeft ?? 0;
        wetRight = this.twist?.wetOutputRight ?? 0;
      } else if (this.algorithm === 'granular-delay') {
        this.granularDelay?.processSample(dryLeft, dryRight);
        wetLeft = this.granularDelay?.wetOutputLeft ?? 0;
        wetRight = this.granularDelay?.wetOutputRight ?? 0;
      } else if (this.algorithm === 'radio') {
        this.radio?.processSample(dryLeft, dryRight);
        wetLeft = this.radio?.wetLeft ?? dryLeft;
        wetRight = this.radio?.wetRight ?? dryRight;
      } else if (this.algorithm === 'vibrato') {
        this.vibrato?.processSample(dryLeft, dryRight);
        wetLeft = this.vibrato?.wetLeft ?? 0;
        wetRight = this.vibrato?.wetRight ?? 0;
      } else if (this.algorithm === 'sustainer') {
        this.sustainer?.processSample(dryLeft, dryRight);
        wetLeft = this.sustainer?.outputLeft ?? dryLeft;
        wetRight = this.sustainer?.outputRight ?? dryRight;
      } else if (this.algorithm === 'preamp') {
        this.preamp?.processSample(dryLeft, dryRight);
        wetLeft = this.preamp?.outputLeft ?? dryLeft;
        wetRight = this.preamp?.outputRight ?? dryRight;
      } else if (this.algorithm === 'synth') {
        this.synth?.processSample(dryLeft, dryRight);
        wetLeft = this.synth?.outputLeft ?? dryLeft;
        wetRight = this.synth?.outputRight ?? dryRight;
      } else if (this.algorithm === 'g2b') {
        this.g2b?.processSample(dryLeft, dryRight);
        wetLeft = this.g2b?.outputLeft ?? dryLeft;
        wetRight = this.g2b?.outputRight ?? dryRight;
      } else if (this.algorithm === 'vocoder') {
        if (this.official.has('carrier')) {
          // A disconnected/empty playback source is silence, never a fallback
          // oscillator or a copy of the modulator. Stereo tracks are summed
          // to the existing mono ERB carrier bank at the same audio frame.
          const rawCarrierL = carrierLeft?.[frame] ?? 0;
          const rawCarrierR = carrierRight?.[frame] ?? rawCarrierL;
          const carrierL = Number.isFinite(rawCarrierL) ? rawCarrierL : 0;
          const carrierR = Number.isFinite(rawCarrierR) ? rawCarrierR : 0;
          wetLeft = this.vocoder?.processWithCarrier((dryLeft + dryRight) * 0.5, (carrierL + carrierR) * 0.5) ?? 0;
          wetRight = wetLeft;
        } else {
          this.vocoder?.processSample(dryLeft, dryRight);
          wetLeft = this.vocoder?.outputLeft ?? 0;
          wetRight = this.vocoder?.outputRight ?? 0;
        }
      } else if (this.algorithm === 'electric') {
        this.electric?.processSample(dryLeft, dryRight);
        wetLeft = this.electric?.outputLeft ?? dryLeft;
        wetRight = this.electric?.outputRight ?? dryRight;
      } else if (this.algorithm === 'osc-voc') {
        this.oscVoc?.processSample(dryLeft, dryRight);
        wetLeft = this.oscVoc?.outputLeft ?? 0;
        wetRight = this.oscVoc?.outputRight ?? 0;
      } else if (this.algorithm === 'osc-bot') {
        const modulator = (dryLeft + dryRight) * 0.5;
        const wet = this.oscBot?.processSample(modulator) ?? 0;
        wetLeft = wet;
        wetRight = wet;
      } else if (this.algorithm === 'slow-gear') {
        const envelope = this.slowGear?.processSample(dryLeft, dryRight) ?? 1;
        wetLeft = dryLeft * envelope;
        wetRight = dryRight * envelope;
      } else if (this.algorithm === 'isolator') {
        this.isolator?.processSample(dryLeft, dryRight);
        wetLeft = this.isolator?.outputLeft ?? dryLeft;
        wetRight = this.isolator?.outputRight ?? dryRight;
      } else if (this.algorithm === 'panning-delay') {
        this.panningDelay?.processSample(dryLeft, dryRight);
        wetLeft = this.panningDelay?.wetOutputLeft ?? 0;
        wetRight = this.panningDelay?.wetOutputRight ?? 0;
      } else if (this.algorithm === 'mod-delay') {
        this.modDelay?.processSample(dryLeft, dryRight);
        wetLeft = this.modDelay?.wetLeft ?? 0;
        wetRight = this.modDelay?.wetRight ?? 0;
      } else {
        let effectLeft = dryLeft, effectRight = dryRight;
        if (this.officialPreDelayBuffers) {
          const [leftBuffer, rightBuffer] = this.officialPreDelayBuffers;
          leftBuffer[this.officialPreDelayWrite] = dryLeft;
          rightBuffer[this.officialPreDelayWrite] = dryRight;
          const readIndex = (this.officialPreDelayWrite - this.officialPreDelaySamples + leftBuffer.length) % leftBuffer.length;
          effectLeft = leftBuffer[readIndex]!;
          effectRight = rightBuffer[readIndex]!;
          this.officialPreDelayWrite = (this.officialPreDelayWrite + 1) % leftBuffer.length;
        }
        wetLeft = this.processEffectSample(effectLeft, 0);
        wetRight = this.processEffectSample(effectRight, 1);
      }
      if (this.officialHasLowCut) {
        this.officialLowCutLeft.processSample(wetLeft); this.officialLowCutRight.processSample(wetRight);
        wetLeft = this.officialLowCutLeft.highpass; wetRight = this.officialLowCutRight.highpass;
      }
      if (this.officialHasHighCut) {
        this.officialHighCutLeft.processSample(wetLeft); this.officialHighCutRight.processSample(wetRight);
        wetLeft = this.officialHighCutLeft.lowpass; wetRight = this.officialHighCutRight.lowpass;
      }
      if (this.officialToneEq) {
        this.officialToneEq.process(wetLeft, wetRight);
        wetLeft = this.officialToneEq.outputLeft;
        wetRight = this.officialToneEq.outputRight;
      }
      if (!Number.isFinite(wetLeft)) {
        wetLeft = 0;
        this.nonFiniteOutputSamples += 1;
      }
      if (!Number.isFinite(wetRight)) {
        wetRight = 0;
        this.nonFiniteOutputSamples += 1;
      }
      if (this.algorithm === 'gate-reverb') {
        if (this.official.has('threshold')) this.updateGateReverbEnvelope(wetLeft, wetRight);
        wetLeft *= this.gateGain;
        wetRight *= this.gateGain;
      }

      const officialLevel = this.officialLevelGain.next();
      let mixedLeft = (mixDryLeft * wetDryGain + wetLeft * wetGain) * officialLevel;
      let mixedRight = (mixDryRight * wetDryGain + wetRight * wetGain) * officialLevel;
      const bypassPosition = this.bypassMix.next();
      if (bypassPosition >= 1) {
        // Preserve bit-exact identity at the bypass endpoint.
        mixedLeft = dryLeft;
        mixedRight = dryRight;
      } else {
        if (bypassPosition !== this.cachedBypassPosition) {
          this.cachedBypassPosition = bypassPosition;
          this.cachedBypassActiveGain = equalPowerFadeOutGain(bypassPosition);
          this.cachedBypassGain = equalPowerFadeInGain(bypassPosition);
        }
        const activeGain = this.cachedBypassActiveGain;
        const bypassGain = this.cachedBypassGain;
        mixedLeft = mixedLeft * activeGain + dryLeft * bypassGain;
        mixedRight = mixedRight * activeGain + dryRight * bypassGain;
      }
      if ((this.algorithm === 'beat-shift' || this.algorithm === 'vinyl-flick') && bypassPosition >= 1) {
        // The beat-shift ring still warms while bypassed, but the dry endpoint
        // bypasses the core's denormal clamp/sanitization for true wire-through.
        if (frame < outputLeftLength && outputLeft) {
          outputLeft[frame] = frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0;
        }
        if (frame < outputRightLength && outputRight) {
          outputRight[frame] = monoAutoPanInput || monoManualPanInput || monoStereoEnhanceInput || inputIsMono
            ? (frame < inputLeftLength ? (inputLeft?.[frame] ?? 0) : 0)
            : (frame < inputRightLength ? (inputRight?.[frame] ?? 0) : 0);
        }
        continue;
      }
      if (this.algorithm === 'ring-mod') {
        this.phase += this.phaseStep;
        if (this.phase >= TWO_PI) this.phase -= TWO_PI;
      }
      if (this.algorithm === 'chorus') {
        this.chorusPhase += this.chorusPhaseStep;
        if (this.chorusPhase >= TWO_PI) this.chorusPhase -= TWO_PI;
      }
      if (this.algorithm === 'phaser') {
        this.phaserPhase += this.phaserPhaseStep;
        if (this.phaserPhase >= TWO_PI) this.phaserPhase -= TWO_PI;
      }
      if (this.algorithm === 'tremolo') {
        this.tremoloPhase += this.tremoloPhaseStep;
        if (this.tremoloPhase >= 1) this.tremoloPhase -= 1;
      }
      if (this.algorithm === 'auto-pan') {
        this.autoPanPhase += this.autoPanPhaseStep;
        if (this.autoPanPhase >= 1) this.autoPanPhase -= 1;
      }

      if (this.algorithm === 'slow-gear') {
        mixedLeft = clamp(mixedLeft, -4, 4);
        mixedRight = clamp(mixedRight, -4, 4);
      }

      if (!Number.isFinite(mixedLeft)) {
        mixedLeft = 0;
        this.nonFiniteOutputSamples += 1;
      }
      if (!Number.isFinite(mixedRight)) {
        mixedRight = 0;
        this.nonFiniteOutputSamples += 1;
      }
      if (Math.abs(mixedLeft) < MIN_STATE_MAGNITUDE) mixedLeft = 0;
      if (Math.abs(mixedRight) < MIN_STATE_MAGNITUDE) mixedRight = 0;
      if (frame < outputLeftLength && outputLeft) outputLeft[frame] = mixedLeft;
      if (frame < outputRightLength && outputRight) outputRight[frame] = mixedRight;
    }
    this.framesProcessed += frames;
    this.currentAudioFrame += frames;
  }

  reset(): void {
    this.controlsSteady = false;
    this.controlSmoothersSettled = false;
    this.controlSettleScanCountdown = 0;
    this.filterLeft.reset();
    this.filterRight.reset();
    for (let index = 0; index < this.fdnBuffers.length; index += 1) {
      this.fdnBuffers[index]?.fill(0);
      this.fdnWriteIndices[index] = 0;
      this.delayDampingStates[index] = 0;
    }
    this.delayModPhases.fill(0);
    this.earlyBuffers[0]?.fill(0);
    this.earlyBuffers[1]?.fill(0);
    this.earlyWriteIndices.fill(0);
    this.dcBlockInput.fill(0);
    this.dcBlockOutput.fill(0);
    this.upsampleHistory.fill(0);
    this.upsampleWriteIndices.fill(0);
    this.previousDrivenInput.fill(0);
    this.distortionPreviousPrimitive.fill(0);
    this.distortionPrimitiveValid.fill(0);
    this.waveshapedHistory.fill(0);
    this.waveshapedWriteIndices.fill(0);
    this.dryDelayBuffers[0]?.fill(0);
    this.dryDelayBuffers[1]?.fill(0);
    this.dryDelayWriteIndices.fill(0);
    this.flangerBuffers[0]?.fill(0);
    this.flangerBuffers[1]?.fill(0);
    this.flangerWriteIndices.fill(0);
    this.flangerPhases[0] = 0;
    this.flangerPhases[1] = Math.PI;
    this.flangerFeedbackStates.fill(0);
    this.dynamicsPeakEnvelope = 0;
    this.dynamicsRmsMeanSquare = 0;
    this.dynamicsGain = 1;
    this.gateDetectorEnvelope = 0;
    this.gateHoldRemainingSamples = 0;
    this.gateGain = 0;
    this.delayWriteIndices.fill(0);
    this.delayToneStates.fill(0);
    this.delayBuffers[0]?.fill(0);
    this.delayBuffers[1]?.fill(0);
    for (let index = 0; index < this.chorusBuffers.length; index += 1) this.chorusBuffers[index]?.fill(0);
    this.chorusWriteIndices.fill(0);
    this.chorusFeedbackStates.fill(0);
    this.chorusPhase = 0;
    this.phaserInputStates.fill(0);
    this.phaserOutputStates.fill(0);
    this.phaserFeedbackStates.fill(0);
    this.phaserPhase = 0;
    this.officialFilterPhase = 0;
    this.officialStepPhase = 1;
    this.officialLfoLeft = 0;
    this.officialLfoRight = 0;
    this.officialToneEq?.reset();
    this.officialLowCutLeft.reset(); this.officialLowCutRight.reset();
    this.officialHighCutLeft.reset(); this.officialHighCutRight.reset();
    this.officialPreDelayBuffers?.[0].fill(0); this.officialPreDelayBuffers?.[1].fill(0);
    this.officialPreDelayWrite = 0;
    this.tremoloPhase = 0;
    this.tremoloWaveformOld = this.tremoloWaveformTarget;
    this.tremoloWaveformBlend.reset(1);
    this.tremoloWaveformBlendValue = 1;
    this.autoPanPhase = Number.isFinite(this.officialInitPhase) ? clamp(this.officialInitPhase, 0, 180) / 360 : 0;
    this.autoPanWaveformOld = this.autoPanWaveformTarget;
    this.autoPanWaveformBlend.reset(1);
    this.autoPanWaveformBlendValue = 1;
    this.stereoLowpassState = 0;
    this.stereoAllpass1Input = 0;
    this.stereoAllpass1Output = 0;
    this.stereoAllpass2Input = 0;
    this.stereoAllpass2Output = 0;
    this.stereoWetLeft = 0;
    this.stereoWetRight = 0;
    this.distortionModeOld = this.distortionModeTarget;
    this.distortionModeBlend.reset(1);
    this.phase = 0;
    this.controlUpdateCountdown = 0;
    this.beatRepeat?.reset();
    this.roll?.reset();
    this.freeze?.reset();
    if (this.algorithm === 'freeze' && Object.keys(this.official.values).length > 0) this.freeze?.setParameters({ frozen: !this.bypassed });
    this.warp?.reset();
    this.beatScatter?.reset();
    this.beatShift?.reset();
    this.reverseDelay?.reset();
    this.officialDelay?.reset();
    this.officialRoll?.reset();
    this.officialStepSlicer?.reset();
    this.officialReverseReverb?.reset();
    this.reverseReverb?.reset();
    this.autoRiff?.reset();
    this.hrmAuto?.reset();
    this.robot?.reset();
    this.patternSlicer?.reset();
    this.stepSlicer?.reset();
    this.loFi?.reset();
    this.equalizer?.reset();
    this.tapeEcho?.reset();
    this.twist?.reset();
    this.granularDelay?.reset();
    this.radio?.reset();
    this.vibrato?.reset();
    this.sustainer?.reset();
    this.preamp?.reset();
    this.synth?.reset();
    this.g2b?.reset();
    this.vocoder?.reset();
    this.electric?.reset();
    this.oscVoc?.reset();
    this.oscBot?.reset();
    this.slowGear?.reset();
    this.isolator?.reset();
    this.vinylFlick?.reset();
    this.panningDelay?.reset();
    this.modDelay?.reset();
    this.manualPanPosition.reset();
    this.manualPanWetLeft = 0;
    this.manualPanWetRight = 0;
  }

  private applyOfficialControls(initial: boolean): void {
    const c = this.official;
    const ramp = initial ? 0 : Math.round(this.sampleRate * 0.02);
    const isCountedDelay = this.algorithm === 'delay' || this.algorithm === 'panning-delay' || this.algorithm === 'reverse-delay' || this.algorithm === 'mod-delay';
    const hasOfficial = Object.keys(c.values).length > 0;
    const isOfficialTape = this.algorithm === 'tape-echo' && c.has('variant');
    if (hasOfficial) {
      if (this.algorithm === 'electric') this.electric?.setOfficialParameters({ shift: c.get('shift'), formant: c.get('formant'), speed: c.get('speed', 5), stability: c.get('stability', 0), scale: c.get('scale') });
      if (this.algorithm === 'vocoder') this.vocoder?.setOfficialParameters({ tone: c.get('tone'), attack: c.get('attack', 50), mod_sens: c.get('mod_sens') });
      if (this.algorithm === 'osc-voc') this.oscVoc?.setOfficialParameters({ carrier: c.get('carrier'), tone: c.get('tone'), attack: c.get('attack', 50), octave: c.get('octave', 2), mod_sens: c.get('mod_sens'), release: c.get('release', 50) });
      if (this.algorithm === 'osc-bot') this.oscBot?.setOfficialParameters({ osc: c.get('osc'), tone: c.get('tone'), attack: c.get('attack', 50), note: c.get('note', 36), mod_sens: c.get('mod_sens') });
      if (this.algorithm === 'preamp') this.preamp?.setOfficialParameters({ ampType: c.get('amp_type', 3), spkType: c.get('spk_type', 1), gain: c.get('gain', 50), tComp: c.get('t_comp'), bass: c.get('bass', 50), middle: c.get('middle', 50), treble: c.get('treble', 50), presence: c.get('presence', 50), micType: c.get('mic_type'), micDis: c.get('mic_dis'), micPos: c.get('mic_pos') });
    }
    if (this.algorithm === 'dynamics' && hasOfficial) {
      const profile = officialDynamicsProfile(c.get('type', 0));
      this.officialToneEq ??= new EqualizerDsp(this.sampleRate);
      this.officialToneEq.setOfficialParameters({ lowGainDb: profile.low, highGainDb: profile.high }, ramp);
      this.officialHasLowCut = profile.lowCut > 0; this.officialHasHighCut = profile.highCut > 0;
      if (this.officialHasLowCut) { this.officialLowCutLeft.setParameters(profile.lowCut, Math.SQRT1_2); this.officialLowCutRight.setParameters(profile.lowCut, Math.SQRT1_2); }
      if (this.officialHasHighCut) { this.officialHighCutLeft.setParameters(Math.min(this.sampleRate * 0.45, profile.highCut), Math.SQRT1_2); this.officialHighCutRight.setParameters(Math.min(this.sampleRate * 0.45, profile.highCut), Math.SQRT1_2); }
    }
    if (this.algorithm === 'beat-scatter' && c.has('length')) this.beatScatter?.setOfficialLengthBeats(c.get('length') === -1000 ? 1 : Math.abs(c.get('length')), initial);
    if (this.algorithm === 'reverse-reverb' && hasOfficial) {
      const values = { timeSeconds: c.get('time', 3), preDelayMs: c.get('pre_delay', 500), gateTimeSeconds: c.get('gate_time', .5), lowCutHz: c.get('low_cut', -1000), highCutHz: c.get('high_cut', -1000) };
      this.officialReverseReverb ??= new BrowserOfficialReverseReverbDsp(this.sampleRate, values);
      this.officialReverseReverb.setParameters(values);
    }
    if (this.algorithm === 'pattern-slicer' && hasOfficial) this.patternSlicer?.setOfficialParameters({ rateHz: officialRateHz(c.get('rate', -1), c.bpm, c.quarterNotesPerMeasure), duty: c.get('duty', 50), attack: c.get('attack', 35), depth: c.get('depth', 100), compThreshold: c.get('comp_threshold', -30), compGain: c.get('comp_gain', 2) });
    if (this.algorithm === 'step-slicer' && hasOfficial) {
      const values = { rateHz: officialRateHz(c.get('rate', -1), c.bpm, c.quarterNotesPerMeasure), stepMax: c.get('step_max', 16), stepLength: c.get('step_length', 50), depth: c.get('depth', 100), compThreshold: c.get('comp_threshold', -30), compGain: c.get('comp_gain', 6), levels: Array.from({ length: 16 }, (_, i) => c.get(`step_level_${i + 1}`, 100)) };
      this.officialStepSlicer ??= new BrowserOfficialStepSlicerDsp(this.sampleRate, values);
      this.officialStepSlicer.setParameters(values);
    }
    if (this.algorithm === 'roll' && c.has('variant')) {
      const variant = c.get('variant') as 1 | 2;
      if (variant !== this.officialLastVariant) { this.officialRoll?.reset(); this.officialLastVariant = variant; }
      const values = { variant, time: c.get('time', -1), repeats: c.get(variant === 1 ? 'feedback' : 'repeat', 50), roll: c.get('roll', 0), bpm: c.bpm };
      this.officialRoll ??= new BrowserOfficialRollDsp(this.sampleRate, values);
      this.officialRoll.setParameters(values);
    }
    if (isOfficialTape) {
      const variant = c.get('variant');
      if (variant !== this.officialLastVariant) {
        this.officialLastVariant = variant;
        this.officialHasLowCut = false; this.officialHasHighCut = false;
        this.officialToneEq = null;
      }
      const repeatRate = c.get('repeat_rate', variant === 1 ? 50 : 200);
      const time = variant === 1 ? 2000 * 0.0005 ** (clamp(repeatRate, 0, 100) / 100)
        : repeatRate < 0 ? Math.min(4, Math.abs(repeatRate)) * 60000 / clamp(c.bpm, 40, 300) : clamp(repeatRate, 1, 2000);
      this.tapeEcho?.setOfficialTimeMs(time, initial);
      if (variant === 1 && (c.has('bass') || c.has('treble'))) {
        this.officialToneEq ??= new EqualizerDsp(this.sampleRate);
        this.officialToneEq.setOfficialParameters({ lowGainDb: clamp(c.get('bass'), -50, 50) * 0.4, highGainDb: clamp(c.get('treble'), -50, 50) * 0.4 }, ramp);
      }
    }
    if (isCountedDelay && hasOfficial) {
      const values = { time: c.get('time', 200), feedback: c.get('feedback', 16), modDepth: c.get('mod_depth', 50), bpm: c.bpm };
      this.officialDelay ??= new BrowserOfficialDelayDsp(this.algorithm as 'delay' | 'panning-delay' | 'reverse-delay' | 'mod-delay', this.sampleRate, values);
      this.officialDelay.setParameters(values);
    }
    if ((isCountedDelay && hasOfficial) || isOfficialTape || c.has('d_level') || c.has('e_level') || ((this.algorithm === 'warp' || this.algorithm === 'twist') && c.has('level'))) {
      this.officialIndependentMix = true;
      this.officialDirectGain.setTarget(this.algorithm === 'preamp' ? 0 : clamp(c.get('d_level', 100), 0, 100) / 100, ramp);
      const effectLevel = this.algorithm === 'warp' || this.algorithm === 'twist' ? c.get('level', 50) : c.get('e_level', isCountedDelay || isOfficialTape ? 50 : 100);
      this.officialEffectGain.setTarget(clamp(effectLevel, 0, isCountedDelay || isOfficialTape ? 120 : 100) / 100, ramp);
    }
    if (c.has('level') && this.algorithm !== 'warp' && this.algorithm !== 'twist') this.officialLevelGain.setTarget(clamp(c.get('level', 100), 0, 100) / 100, ramp);
    if (this.algorithm === 'lpf' || this.algorithm === 'bpf' || this.algorithm === 'hpf' || this.algorithm === 'phaser' || this.algorithm === 'flanger' || this.algorithm === 'auto-pan') {
      this.officialModulation = c.has('rate') || c.has('depth') || c.has('step_rate') || c.has('separation');
    }
    if (c.has('rate')) {
      const rate = officialRateHz(c.get('rate'), c.bpm, c.quarterNotesPerMeasure);
      if (this.algorithm === 'phaser') this.phaserRateHz.setTarget(rate);
      if (this.algorithm === 'flanger') this.flangerRateHz.setTarget(rate);
      if (this.algorithm === 'tremolo') this.tremoloRateHz.setTarget(rate);
      if (this.algorithm === 'auto-pan') this.autoPanRateHz.setTarget(rate);
      if (this.algorithm === 'chorus') this.chorusRateHz.setTarget(rate);
    }
    if (c.has('low_cut') && !this.officialReverseReverb) {
      this.officialHasLowCut = c.get('low_cut') !== -1000;
      const frequency = clamp(c.get('low_cut'), 20, Math.min(12500, this.sampleRate * 0.45));
      this.officialLowCutLeft.setParameters(frequency, Math.SQRT1_2);
      this.officialLowCutRight.setParameters(frequency, Math.SQRT1_2);
    }
    if (c.has('high_cut') && !this.officialReverseReverb) {
      this.officialHasHighCut = c.get('high_cut') !== -1000;
      const frequency = clamp(c.get('high_cut'), 20, Math.min(12500, this.sampleRate * 0.45));
      this.officialHighCutLeft.setParameters(frequency, Math.SQRT1_2);
      this.officialHighCutRight.setParameters(frequency, Math.SQRT1_2);
    }
    if (c.has('pre_delay')) this.officialPreDelaySamples = Math.round(clamp(c.get('pre_delay'), 0, 500) * this.sampleRate / 1000);
    if (this.algorithm === 'auto-pan' && c.has('init_phase') && c.get('init_phase') !== this.officialInitPhase) {
      this.officialInitPhase = c.get('init_phase');
      this.autoPanPhase = clamp(this.officialInitPhase, 0, 180) / 360;
    }
    if (this.algorithm === 'freeze' && hasOfficial) {
      this.freeze?.setOfficialParameters({ attack: c.get('attack', 30), release: c.get('release', 30), decay: c.get('decay', 30), sustain: c.get('sustain', 30) });
      this.freeze?.setParameters({ frozen: !this.bypassed });
    }
    if (this.algorithm === 'twist' && hasOfficial) {
      this.twist?.setOfficialParameters({ rise: c.get('rise', 50), fall: c.get('fall', 50), release: c.get('release', 0) });
      this.twist?.setOfficialActive(!this.bypassed);
    }
    if (this.algorithm === 'vibrato') this.vibrato?.setOfficialParameters({
      color: c.has('color') ? c.get('color') : undefined,
      rateHz: c.has('rate') ? officialRateHz(c.get('rate'), c.bpm, c.quarterNotesPerMeasure) : undefined,
    });
    if (this.algorithm === 'synth') this.synth?.setOfficialParameters({
      frequencyHz: c.has('frequency') ? 20 * 1000 ** (clamp(c.get('frequency'), 0, 100) / 100) : undefined,
      resonanceQ: c.has('resonance') ? 0.5 * 40 ** (clamp(c.get('resonance'), 0, 100) / 100) : undefined,
      decayMs: c.has('decay') ? 10 * 200 ** (clamp(c.get('decay'), 0, 100) / 100) : undefined,
    });
    if (this.algorithm === 'isolator' && Object.keys(c.values).length > 0) this.isolator?.setOfficialParameters({
      band: c.get('band', 0), rateHz: officialRateHz(c.get('rate', -1), c.bpm, c.quarterNotesPerMeasure), bandLevel: c.get('band_level', 50),
      depth: c.get('depth', 50), stepRateHz: officialRateHz(c.get('step_rate', -1000), c.bpm, c.quarterNotesPerMeasure), waveform: c.get('waveform', 0),
    });
    if (this.algorithm === 'phaser' && c.has('stage')) {
      const stage = c.get('stage');
      this.officialBiPhase = stage === -1;
      this.phaserStageCount = stage === 12 ? 12 : stage === 8 || stage === -1 ? 8 : 4;
    }
    if (this.algorithm === 'lo-fi') {
      this.loFi?.setOfficialParameters({ bitDepth: c.has('bitdepth') ? c.get('bitdepth') : undefined,
        sampleRateDivisor: c.has('samplerate') ? c.get('samplerate') : undefined });
    }
    if (this.algorithm === 'eq') this.equalizer?.setOfficialParameters({
      lowGainDb: c.has('lo') ? c.get('lo') : undefined, mid1GainDb: c.has('lo_mid') ? c.get('lo_mid') : undefined,
      mid1FrequencyHz: c.has('lo_mid_freq') ? c.get('lo_mid_freq') : undefined, mid1Q: c.has('lo_mid_q') ? c.get('lo_mid_q') : undefined,
      mid2GainDb: c.has('hi_mid') ? c.get('hi_mid') : undefined, mid2FrequencyHz: c.has('hi_mid_freq') ? c.get('hi_mid_freq') : undefined,
      mid2Q: c.has('hi_mid_q') ? c.get('hi_mid_q') : undefined, highGainDb: c.has('high') ? c.get('high') : undefined,
    }, ramp);
    if ((this.algorithm === 'sustainer' && (c.has('low_gain') || c.has('hi_gain')))
      || (this.algorithm === 'distortion' && (c.has('tone') || c.has('type')))) {
      this.officialToneEq ??= new EqualizerDsp(this.sampleRate);
      if (this.algorithm === 'sustainer') this.officialToneEq.setOfficialParameters({ lowGainDb: c.get('low_gain'), highGainDb: c.get('hi_gain') }, ramp);
      else {
        const tone = clamp(c.get('tone'), -50, 50) / 50;
        const type = Math.round(clamp(c.get('type', 2), 0, 5));
        // Authored vocal/boost/OD/DS/metal/fuzz profiles, not factory models.
        this.officialToneEq.setOfficialParameters({ lowGainDb: -tone * 12 + [ -3, 0, 1, 2, 5, 3 ][type]!,
          highGainDb: tone * 12 + [ -2, 0, -3, 1, 4, -5 ][type]!,
          mid1FrequencyHz: 900, mid1GainDb: [ 4, 0, 3, 0, -6, -2 ][type]! }, ramp);
      }
    }
  }

  private advanceOfficialModulation(): void {
    const c = this.official;
    const isFilter = this.algorithm === 'lpf' || this.algorithm === 'bpf' || this.algorithm === 'hpf';
    const phase = isFilter ? this.officialFilterPhase : this.algorithm === 'phaser' ? this.phaserPhase : this.algorithm === 'auto-pan' ? TWO_PI * this.autoPanPhase : this.flangerPhases[0] ?? 0;
    const offset = this.algorithm === 'flanger' ? Math.PI * clamp(c.get('separation', 100), 0, 100) / 100 : this.algorithm === 'phaser' ? Math.PI * 0.5 : 0;
    const stepRate = officialRateHz(c.get('step_rate', -1000), c.bpm, c.quarterNotesPerMeasure);
    if (stepRate === 0 || this.officialStepPhase >= 1) {
      this.officialLfoLeft = Math.sin(phase);
      this.officialLfoRight = Math.sin(phase + offset);
      this.officialStepPhase %= 1;
    }
    this.officialStepPhase += stepRate / this.sampleRate;
    if (isFilter) {
      const rate = officialRateHz(c.get('rate', -1), c.bpm, c.quarterNotesPerMeasure);
      this.officialFilterPhase = (this.officialFilterPhase + TWO_PI * rate / this.sampleRate) % TWO_PI;
      if (this.controlUpdateCountdown === 15) {
        const base = this.currentControls[0] ?? 1200;
        const modulated = clamp(base * 2 ** (5 * clamp(c.get('depth', 50), 0, 100) / 100 * this.officialLfoLeft), 20, this.sampleRate * 0.45);
        const q = this.currentControls[1] ?? Math.SQRT1_2;
        this.filterLeft.setParameters(modulated, q);
        this.filterRight.setParameters(modulated, q);
      }
    }
  }

  private advanceControls(): void {
    if (this.settledControlFastPathEnabled && this.controlsSteady) {
      // Keep the established 16-sample coefficient-refresh phase even while
      // values are steady. A later parameter message must resume the legacy
      // ramp on the same sample boundary as the reference path.
      if (this.controlUpdateCountdown <= 0) {
        this.refreshControlDependentCoefficients();
        this.controlUpdateCountdown = 15;
      } else {
        this.controlUpdateCountdown -= 1;
      }
      return;
    }

    const refreshedCoefficients = this.controlUpdateCountdown <= 0;
    this.currentControls[0] = this.cutoff.next();
    this.currentControls[1] = this.q.next();
    this.currentControls[2] = this.wet.next();
    this.currentControls[3] = this.decaySeconds.next();
    this.currentControls[4] = this.dampingHz.next();
    this.currentControls[5] = this.ringModHz.next();
    this.currentControls[6] = this.ringModDepth.next();
    this.currentControls[36] = this.ringModWaveform.next();
    this.currentControls[7] = this.driveDb.next();
    this.currentControls[8] = this.outputDb.next();
    this.currentControls[9] = this.flangerDelayMs.next();
    this.currentControls[10] = this.flangerDepth.next();
    this.currentControls[11] = this.flangerRateHz.next();
    this.currentControls[12] = this.flangerFeedback.next();
    this.currentControls[13] = this.dynamicsThreshold.next();
    this.currentControls[14] = this.dynamicsRatio.next();
    this.currentControls[15] = this.dynamicsKnee.next();
    this.currentControls[16] = this.dynamicsAttackMs.next();
    this.currentControls[17] = this.dynamicsReleaseMs.next();
    this.currentControls[18] = this.delayTimeMs.next();
    this.currentControls[19] = this.delayFeedback.next();
    this.currentControls[20] = this.delayToneHz.next();
    this.currentControls[21] = this.chorusDelayMs.next();
    this.currentControls[22] = this.chorusRateHz.next();
    this.currentControls[23] = this.chorusDepthMs.next();
    this.currentControls[24] = this.chorusFeedback.next();
    this.currentControls[25] = this.chorusToneHz.next();
    this.currentControls[26] = this.phaserRateHz.next();
    this.currentControls[27] = this.phaserDepth.next();
    this.currentControls[28] = this.phaserFeedback.next();
    this.currentControls[29] = this.tremoloRateHz.next();
    this.currentControls[30] = this.tremoloDepth.next();
    this.tremoloWaveformBlendValue = this.tremoloWaveformBlend.next();
    this.currentControls[31] = this.autoPanRateHz.next();
    this.currentControls[32] = this.autoPanDepth.next();
    this.autoPanWaveformBlendValue = this.autoPanWaveformBlend.next();
    this.currentControls[33] = this.stereoWidth.next();
    this.currentControls[34] = this.stereoLowMonoCutoffHz.next();
    this.currentControls[35] = this.stereoDecorrelation.next();
    if (this.algorithm === 'distortion') {
      this.driveLinear = Math.pow(10, (this.currentControls[7] ?? 18) / 20);
      this.outputLinear = Math.pow(10, (this.currentControls[8] ?? 0) / 20);
    } else if (this.algorithm === 'dynamics' || this.algorithm === 'delay') {
      this.outputLinear = Math.pow(10, (this.currentControls[8] ?? 0) / 20);
    }

    if (refreshedCoefficients) {
      this.refreshControlDependentCoefficients();
      this.controlUpdateCountdown = 15;
    } else {
      this.controlUpdateCountdown -= 1;
    }
    if (this.algorithm === 'ring-mod') this.phaseStep = TWO_PI * (this.currentControls[5] ?? 440) / this.sampleRate;
    if (this.algorithm === 'chorus') this.chorusPhaseStep = TWO_PI * (this.currentControls[22] ?? CHORUS_DEFAULT_RATE_HZ) / this.sampleRate;
    if (this.algorithm === 'phaser') this.phaserPhaseStep = TWO_PI * (this.currentControls[26] ?? PHASER_DEFAULT_RATE_HZ) / this.sampleRate;
    if (this.algorithm === 'tremolo') this.tremoloPhaseStep = (this.currentControls[29] ?? TREMOLO_DEFAULT_RATE_HZ) / this.sampleRate;
    if (this.algorithm === 'auto-pan') this.autoPanPhaseStep = (this.currentControls[31] ?? AUTO_PAN_DEFAULT_RATE_HZ) / this.sampleRate;

    if (this.controlSettleScanCountdown <= 0) {
      this.controlSettleScanCountdown = 15;
      if (this.advanceControlSmoothersSettled()) this.controlSmoothersSettled = true;
    } else {
      this.controlSettleScanCountdown -= 1;
    }
    if (this.controlSmoothersSettled && refreshedCoefficients) this.controlsSteady = true;
  }

  private refreshControlDependentCoefficients(): void {
    const cutoffHz = this.currentControls[0] ?? 1200;
    const resonanceQ = this.currentControls[1] ?? Math.SQRT1_2;
    if (this.algorithm === 'lpf' || this.algorithm === 'bpf' || this.algorithm === 'hpf') {
      this.filterLeft.setParameters(cutoffHz, resonanceQ);
      this.filterRight.setParameters(cutoffHz, resonanceQ);
    } else if (this.algorithm === 'reverb' || this.algorithm === 'gate-reverb') {
      this.refreshTimeVariantCoefficients(this.currentControls[3] ?? 2.4, this.currentControls[4] ?? 9000);
    } else if (this.algorithm === 'dynamics') {
      this.dynamicsAttackAlpha = Math.exp(-1 / (Math.max(0.1, this.currentControls[16] ?? DYNAMICS_DEFAULT_ATTACK_MS) * 0.001 * this.sampleRate));
      this.dynamicsReleaseAlpha = Math.exp(-1 / (Math.max(5, this.currentControls[17] ?? DYNAMICS_DEFAULT_RELEASE_MS) * 0.001 * this.sampleRate));
    } else if (this.algorithm === 'delay') {
      this.delayToneAlpha = 1 - Math.exp(-TWO_PI * Math.min(this.currentControls[20] ?? DELAY_DEFAULT_TONE_HZ, this.sampleRate * 0.499) / this.sampleRate);
    } else if (this.algorithm === 'chorus') {
      this.chorusToneAlpha = 1 - Math.exp(-TWO_PI * Math.min(this.currentControls[25] ?? CHORUS_DEFAULT_TONE_HZ, this.sampleRate * 0.499) / this.sampleRate);
    } else if (this.algorithm === 'stereo-enhance') {
      this.refreshStereoEnhanceCoefficients(this.currentControls[34] ?? 120);
    }
  }

  private advanceControlSmoothersSettled(): boolean {
    return this.cutoff.isSettled
      && this.q.isSettled
      && this.wet.isSettled
      && this.decaySeconds.isSettled
      && this.dampingHz.isSettled
      && this.ringModHz.isSettled
      && this.ringModDepth.isSettled
      && this.ringModWaveform.isSettled
      && this.driveDb.isSettled
      && this.outputDb.isSettled
      && this.flangerDelayMs.isSettled
      && this.flangerDepth.isSettled
      && this.flangerRateHz.isSettled
      && this.flangerFeedback.isSettled
      && this.dynamicsThreshold.isSettled
      && this.dynamicsRatio.isSettled
      && this.dynamicsKnee.isSettled
      && this.dynamicsAttackMs.isSettled
      && this.dynamicsReleaseMs.isSettled
      && this.delayTimeMs.isSettled
      && this.delayFeedback.isSettled
      && this.delayToneHz.isSettled
      && this.chorusDelayMs.isSettled
      && this.chorusRateHz.isSettled
      && this.chorusDepthMs.isSettled
      && this.chorusFeedback.isSettled
      && this.chorusToneHz.isSettled
      && this.phaserRateHz.isSettled
      && this.phaserDepth.isSettled
      && this.phaserFeedback.isSettled
      && this.tremoloRateHz.isSettled
      && this.tremoloDepth.isSettled
      && this.autoPanRateHz.isSettled
      && this.autoPanDepth.isSettled
      && this.stereoWidth.isSettled
      && this.stereoLowMonoCutoffHz.isSettled
      && this.stereoDecorrelation.isSettled
      && this.tremoloWaveformBlendValue === 1
      && this.autoPanWaveformBlendValue === 1;
  }

  /** Stereo-linked gate control for the FDN8 return; allocated state is scalar-only. */
  private updateGateReverbEnvelope(left: number, right: number): void {
    const linkedPeak = Math.max(Math.abs(left), Math.abs(right));
    if (linkedPeak >= this.gateDetectorEnvelope) {
      // Instant peak attack keeps a sharp transient from being missed.
      this.gateDetectorEnvelope = linkedPeak;
    } else {
      this.gateDetectorEnvelope *= this.gateDetectorRelease;
    }

    // Advance every smoother on every sample, including while the gate is shut.
    // Only memoize exact derived values; neither the envelope nor control rate changes.
    const thresholdDb = this.gateThresholdDb.next();
    if (thresholdDb !== this.gateThresholdKey) {
      this.gateThresholdKey = thresholdDb;
      this.gateThresholdLinear = Math.pow(10, thresholdDb / 20);
    }
    const threshold = this.gateThresholdLinear;
    const holdMs = this.gateHoldMs.next();
    if (holdMs !== this.gateHoldKey) {
      this.gateHoldKey = holdMs;
      this.gateHoldSamples = Math.max(1, Math.round(holdMs * 0.001 * this.sampleRate));
    }
    const holdSamples = this.gateHoldSamples;
    const releaseMs = this.gateReleaseMs.next();
    const closeThreshold = threshold * GATE_REVERB_HYSTERESIS_RATIO;
    if (this.gateDetectorEnvelope >= threshold) {
      this.gateGain = 1;
      this.gateHoldRemainingSamples = holdSamples;
    } else if (this.gateDetectorEnvelope >= closeThreshold && this.gateGain > 0) {
      this.gateHoldRemainingSamples = holdSamples;
    } else if (this.gateHoldRemainingSamples > 0) {
      this.gateHoldRemainingSamples -= 1;
    } else if (this.gateGain > 0) {
      // Define the release control as approximately the time to -60 dB.
      if (releaseMs !== this.gateReleaseKey) {
        this.gateReleaseKey = releaseMs;
        this.gateReleaseCoefficient = Math.exp(-
          (GATE_REVERB_RELEASE_DB * Math.LN10 / 20)
          / (Math.max(10, releaseMs) * 0.001 * this.sampleRate),
        );
      }
      this.gateGain *= this.gateReleaseCoefficient;
      if (this.gateGain < 1e-4) this.gateGain = 0;
    }
  }

  private requestTremoloWaveform(waveform: BrowserTremoloWaveform): void {
    if (waveform === this.tremoloWaveformTarget) return;
    this.tremoloWaveformOld = this.tremoloWaveformTarget;
    this.tremoloWaveformTarget = waveform;
    this.tremoloWaveformBlend.reset(0);
    this.tremoloWaveformBlend.setTarget(1, Math.max(1, Math.round(this.sampleRate * 0.02)));
  }

  private requestAutoPanWaveform(waveform: BrowserTremoloWaveform): void {
    if (waveform === this.autoPanWaveformTarget) return;
    this.autoPanWaveformOld = this.autoPanWaveformTarget;
    this.autoPanWaveformTarget = waveform;
    this.autoPanWaveformBlend.reset(0);
    this.autoPanWaveformBlend.setTarget(1, Math.max(1, Math.round(this.sampleRate * 0.02)));
  }

  private requestDistortionMode(mode: BrowserDistortionMode): void {
    if (mode === this.distortionModeTarget) return;
    this.distortionPrimitiveValid.fill(0);
    this.distortionModeOld = this.distortionModeTarget;
    this.distortionModeTarget = mode;
    this.distortionModeBlend.reset(0);
    this.distortionModeBlend.setTarget(1, DISTORTION_MODE_CROSSFADE_OVERSAMPLED_SAMPLES);
  }

  private refreshTimeVariantCoefficients(decaySeconds: number, dampingHz: number): void {
    const cutoff = clamp(dampingHz, 200, this.sampleRate * 0.499);
    const alpha = 1 - Math.exp(-TWO_PI * cutoff / this.sampleRate);
    for (let index = 0; index < 16; index += 1) {
      const lineSamples = this.delayLengths[index] ?? 1;
      this.delayFeedbackGains[index] = Math.pow(10, (-3 * lineSamples) / (Math.max(0.1, decaySeconds) * this.sampleRate));
      this.dampingAlpha[index] = alpha;
    }
  }

  /** Recomputed outside the inner DSP path when the smoothed cutoff moves. */
  private refreshStereoEnhanceCoefficients(lowMonoCutoffHz: number): void {
    const nyquist = this.sampleRate * 0.499;
    const cutoff = clamp(lowMonoCutoffHz, 20, Math.min(1000, nyquist));
    this.stereoLowpassAlpha = 1 - Math.exp(-TWO_PI * cutoff / this.sampleRate);
    this.stereoAllpass1Coefficient = firstOrderAllpassCoefficient(Math.min(650, this.sampleRate * 0.12), this.sampleRate);
    this.stereoAllpass2Coefficient = firstOrderAllpassCoefficient(Math.min(2300, this.sampleRate * 0.36), this.sampleRate);
  }

  /** M/S width with LF mono protection and a phase-decorrelated side path. */
  private processStereoEnhance(inputLeft: number, inputRight: number): void {
    const mid = 0.5 * (inputLeft + inputRight);
    const side = 0.5 * (inputLeft - inputRight);

    this.stereoLowpassState += this.stereoLowpassAlpha * (side - this.stereoLowpassState);
    const highSide = side - this.stereoLowpassState;
    const allpass1 = -this.stereoAllpass1Coefficient * highSide
      + this.stereoAllpass1Input
      + this.stereoAllpass1Coefficient * this.stereoAllpass1Output;
    this.stereoAllpass1Input = highSide;
    this.stereoAllpass1Output = allpass1;
    const allpass2 = -this.stereoAllpass2Coefficient * allpass1
      + this.stereoAllpass2Input
      + this.stereoAllpass2Coefficient * this.stereoAllpass2Output;
    this.stereoAllpass2Input = allpass1;
    this.stereoAllpass2Output = allpass2;

    const decorrelation = this.currentControls[35] ?? 0.25;
    const width = this.currentControls[33] ?? 1;
    let outputSide = (highSide + decorrelation * (allpass2 - highSide)) * width;

    // Only limit newly expanded width, so unity/contracted width preserves an
    // intentionally wide source. At >100% width this keeps L/R polarity
    // aligned sample-by-sample whenever widening would otherwise invert it.
    if (width > 1) {
      const sideLimit = Math.abs(mid);
      if (Math.abs(outputSide) > sideLimit) outputSide = outputSide < 0 ? -sideLimit : sideLimit;
    }

    this.stereoWetLeft = mid + outputSide;
    this.stereoWetRight = mid - outputSide;
  }

  /** Static equal-power pan for mono sources; smooth balance for stereo input. */
  private processManualPan(inputLeft: number, inputRight: number, monoInput: boolean): void {
    const position = clamp(this.manualPanPosition.next(), -1, 1);
    const tablePosition = (position + 1) * 1024;
    const index = Math.min(2047, Math.floor(tablePosition));
    const fraction = tablePosition - index;
    const leftStart = this.manualPanLeftTable[index] ?? 0.707;
    const rightStart = this.manualPanRightTable[index] ?? 0.707;
    const leftGain = leftStart + ((this.manualPanLeftTable[index + 1] ?? 0) - leftStart) * fraction;
    const rightGain = rightStart + ((this.manualPanRightTable[index + 1] ?? 0) - rightStart) * fraction;

    if (monoInput) {
      this.manualPanWetLeft = inputLeft * leftGain;
      this.manualPanWetRight = inputLeft * rightGain;
    } else if (position > 0) {
      this.manualPanWetLeft = inputLeft * leftGain * Math.SQRT2;
      this.manualPanWetRight = inputRight;
    } else if (position < 0) {
      this.manualPanWetLeft = inputLeft;
      this.manualPanWetRight = inputRight * rightGain * Math.SQRT2;
    } else {
      this.manualPanWetLeft = inputLeft;
      this.manualPanWetRight = inputRight;
    }
  }

  private processEffectSample(input: number, channel: 0 | 1): number {
    switch (this.algorithm) {
      case 'lpf':
        if (channel === 0) {
          this.filterLeft.processSample(input);
          return this.filterLeft.lowpass;
        }
        this.filterRight.processSample(input);
        return this.filterRight.lowpass;
      case 'bpf':
        if (channel === 0) {
          this.filterLeft.processSample(input);
          return this.filterLeft.bandpass;
        }
        this.filterRight.processSample(input);
        return this.filterRight.bandpass;
      case 'hpf':
        if (channel === 0) {
          this.filterLeft.processSample(input);
          return this.filterLeft.highpass;
        }
        this.filterRight.processSample(input);
        return this.filterRight.highpass;
      case 'ring-mod':
        return this.processRingMod(input, channel);
      case 'flanger':
        return this.processFlanger(input, channel);
      case 'dynamics':
        return input * this.dynamicsGain;
      case 'delay':
        return this.processDelay(input, channel);
      case 'mod-delay':
        // The stereo frame shares one modulated-delay clock in processBlock.
        return input;
      case 'chorus':
        return this.processChorus(input, channel);
      case 'phaser':
        return this.processPhaser(input, channel);
      case 'tremolo':
        return this.processTremolo(input);
      case 'auto-pan':
        return input;
      case 'reverb':
      case 'gate-reverb':
        return this.processReverb(input, channel);
      case 'distortion':
        return this.processDistortionSample(input, channel);
      case 'beat-repeat':
        // The stereo frame shares one clock and is handled by processBlock.
        return 0;
      case 'roll':
        // Capture/retrigger and playback share one stereo-frame clock.
        return input;
      case 'freeze':
        // The frozen stereo loop and live input share one frame clock.
        return input;
      case 'warp':
        // Grain capture and FDN8 state share the stereo frame clock.
        return input;
      case 'beat-scatter':
        // Grain capture and read heads share one stereo-frame clock in processBlock.
        return input;
      case 'beat-shift':
        // The paired read heads share one stereo-frame clock in processBlock.
        return input;
      case 'reverse-delay':
        // Segment capture and reverse reads share one stereo-frame clock.
        return input;
      case 'reverse-reverb':
        // Reverse-segment capture and stereo FDN16 state share processBlock's frame clock.
        return input;
      case 'pattern-slicer':
        // Gate state and stereo samples share one frame clock in processBlock.
        return input;
      case 'step-slicer':
        // Per-step level/pan and the filter share one stereo sample clock.
        return input;
      case 'stereo-enhance':
        // The stereo frame shares mid/side state in processBlock.
        return input;
      case 'lo-fi':
        // The stereo frame shares the sample-rate hold clock in processBlock.
        return input;
      case 'eq':
        // The full four-section cascade is shared across stereo in processBlock.
        return input;
      case 'manual-pan':
        // Equal-power panning is a shared stereo-frame operation in processBlock.
        return input;
      case 'tape-echo':
        // Multi-head stereo delay state is shared by processBlock samples.
        return input;
      case 'twist':
        // The signed macro, stereo read heads, and feedback share processBlock's frame clock.
        return input;
      case 'granular-delay':
        // Grain triggers and stereo overlap are shared by processBlock samples.
        return input;
      case 'radio':
        // Band limiting, saturation, and stochastic noise share one frame clock.
        return input;
      case 'vibrato':
        // Modulated stereo delay is advanced by the shared frame path.
        return input;
      case 'sustainer':
        // The linked detector and limiter are shared across stereo in processBlock.
        return input;
      case 'slow-gear':
        // The onset detector and envelope share one clock in processBlock.
        return input;
      case 'isolator':
        // The crossover and rhythm gate share one stereo-frame clock in processBlock.
        return input;
      case 'vinyl-flick':
        // Variable-rate stereo history is advanced together in processBlock.
        return input;
      case 'preamp':
        // The stereo-frame oversampled amp path is handled by processBlock.
        return input;
      case 'synth':
        // Pitch tracking and resynthesis share one stereo-frame clock.
        return input;
      case 'g2b':
        // Pitch tracking and octave-down resynthesis share one stereo-frame clock.
        return input;
      case 'vocoder':
        // Carrier generation and all envelope followers share one stereo-frame clock.
        return input;
      case 'electric':
        // Pitch tracking, character DSP and tone filtering share one stereo-frame clock.
        return input;
      case 'osc-voc':
        // MIDI frame queue, carrier oscillator and VOCODER filterbank advance together.
        return input;
      case 'osc-bot':
        // The oscillator bank and filterbank envelope share the sample path in processBlock.
        return input;
      case 'auto-riff':
        // Analysis and command generation are shared across stereo in processBlock.
        return input;
      case 'hrm-auto':
        // MIDI chord parsing, pitch analysis and targets share one frame clock.
        return input;
      case 'robot':
        // Mono YIN analysis and semitone targets share one frame clock.
        return input;
      case 'panning-delay':
        // The two delay lines are advanced together in processBlock samples.
        return input;
    }
  }

  private processDistortionDryDelay(input: number, channel: 0 | 1): number {
    const buffer = this.dryDelayBuffers[channel];
    const index = this.dryDelayWriteIndices[channel] ?? 0;
    if (!buffer) return 0;
    const delayed = buffer[index] ?? 0;
    buffer[index] = input;
    let nextIndex = index + 1;
    if (nextIndex >= DISTORTION_DRY_DELAY_SAMPLES) nextIndex = 0;
    this.dryDelayWriteIndices[channel] = nextIndex;
    return delayed;
  }

  /** 4x zero-stuffed sinc oversampling, ADAA waveshaping and FIR decimation. */
  /** Exact ADAA primitive reuse for a settled mode, never across a mode fade. */
  private processCachedDistortionSample(mode: BrowserDistortionMode, current: number, previous: number, channel: 0 | 1): number {
    const difference = current - previous;
    if (Math.abs(difference) < 1e-8) {
      this.distortionPrimitiveValid[channel] = 0;
      return distortionFunction(mode, 0.5 * (current + previous));
    }
    const currentPrimitive = distortionAntiderivative(mode, current);
    const previousPrimitive = this.distortionPrimitiveValid[channel]
      ? this.distortionPreviousPrimitive[channel]!
      : distortionAntiderivative(mode, previous);
    this.distortionPreviousPrimitive[channel] = currentPrimitive;
    this.distortionPrimitiveValid[channel] = 1;
    return (currentPrimitive - previousPrimitive) / difference;
  }

  private processDistortionSample(input: number, channel: 0 | 1): number {
    const inputHistoryBase = channel * DISTORTION_UPSAMPLE_INPUT_HISTORY * 2;
    const waveshapedHistoryBase = channel * DISTORTION_FIR_TAPS * 2;
    const upsampleHistory = this.upsampleHistory;
    const waveshapedHistory = this.waveshapedHistory;
    const interpolation = DISTORTION_FILTERS.interpolation;
    const decimation = DISTORTION_FILTERS.decimation;
    let upWriteIndex = this.upsampleWriteIndices[channel] ?? 0;
    let downWriteIndex = this.waveshapedWriteIndices[channel] ?? 0;
    let output = 0;
    const upWriteOffset = inputHistoryBase + upWriteIndex;
    upsampleHistory[upWriteOffset] = input;
    upsampleHistory[upWriteOffset + DISTORTION_UPSAMPLE_INPUT_HISTORY] = input;

    for (let subSample = 0; subSample < DISTORTION_OVERSAMPLE_FACTOR; subSample += 1) {
      let reconstructed = 0;
      let inputHistoryIndex = upWriteOffset + DISTORTION_UPSAMPLE_INPUT_HISTORY;
      const phaseTapCount = DISTORTION_INTERPOLATION_TAPS_BY_PHASE[subSample]!;
      for (let inputTap = 0; inputTap < phaseTapCount; inputTap += 1) {
        const coefficientIndex = subSample + DISTORTION_OVERSAMPLE_FACTOR * inputTap;
        reconstructed += upsampleHistory[inputHistoryIndex]! * interpolation[coefficientIndex]!;
        inputHistoryIndex -= 1;
      }

      const driven = reconstructed * this.driveLinear;
      let shaped: number;
      if (this.distortionModeOld === this.distortionModeTarget) {
        shaped = this.processCachedDistortionSample(this.distortionModeTarget, driven, this.previousDrivenInput[channel] ?? 0, channel);
      } else {
        // Preserve the existing dual-mode crossfade and ensure its last
        // oversample cannot leave a cached primitive from the previous mode.
        this.distortionPrimitiveValid[channel] = 0;
        const oldModeOutput = antiderivativeAntialiasSample(
          this.distortionModeOld,
          driven,
          this.previousDrivenInput[channel] ?? 0,
        );
        const newModeOutput = antiderivativeAntialiasSample(
          this.distortionModeTarget,
          driven,
          this.previousDrivenInput[channel] ?? 0,
        );
        const modePosition = this.distortionModeBlend.next();
        shaped = oldModeOutput * equalPowerFadeOutGain(modePosition)
          + newModeOutput * equalPowerFadeInGain(modePosition);
        if (this.distortionModeBlend.remainingFrames === 0) {
          this.distortionModeOld = this.distortionModeTarget;
          this.distortionModeBlend.reset(1);
        }
      }
      this.previousDrivenInput[channel] = driven;
      const boundedShaped = Number.isFinite(shaped * this.outputLinear) ? shaped * this.outputLinear : 0;
      const downWriteOffset = waveshapedHistoryBase + downWriteIndex;
      waveshapedHistory[downWriteOffset] = boundedShaped;
      waveshapedHistory[downWriteOffset + DISTORTION_FIR_TAPS] = boundedShaped;

      if (subSample === 0) {
        let decimated = 0;
        let historyIndex = downWriteOffset + DISTORTION_FIR_TAPS;
        for (let tap = 0; tap < DISTORTION_FIR_TAPS; tap += 1) {
          decimated += waveshapedHistory[historyIndex]! * decimation[tap]!;
          historyIndex -= 1;
        }
        output = decimated;
      }
      downWriteIndex += 1;
      if (downWriteIndex >= DISTORTION_FIR_TAPS) downWriteIndex = 0;
    }

    upWriteIndex += 1;
    if (upWriteIndex >= DISTORTION_UPSAMPLE_INPUT_HISTORY) upWriteIndex = 0;
    this.upsampleWriteIndices[channel] = upWriteIndex;
    this.waveshapedWriteIndices[channel] = downWriteIndex;
    return output;
  }

  private processRingMod(input: number, channel: 0 | 1): number {
    const sineCarrier = Math.sin(this.phase);
    const waveformBlend = this.currentControls[36] ?? 0;
    const carrier = waveformBlend <= 0
      ? sineCarrier
      : waveformBlend >= 1
        ? this.ringModTriangle(this.phase, this.currentControls[5] ?? 440)
        : sineCarrier + (this.ringModTriangle(this.phase, this.currentControls[5] ?? 440) - sineCarrier) * waveformBlend;
    const depth = this.currentControls[6] ?? 1;
    const modulated = input * ((1 - depth) + depth * carrier);

    const dcBlocked = modulated - (this.dcBlockInput[channel] ?? 0) + this.dcBlockCoefficient * (this.dcBlockOutput[channel] ?? 0);
    this.dcBlockInput[channel] = modulated;
    this.dcBlockOutput[channel] = Math.abs(dcBlocked) < MIN_STATE_MAGNITUDE ? 0 : dcBlocked;
    return this.dcBlockOutput[channel] ?? 0;
  }

  private ringModTriangle(phaseRadians: number, carrierHz: number): number {
    const harmonicBudget = (this.sampleRate * 0.45) / Math.max(carrierHz, 1e-9);
    let tier = RING_MOD_TRIANGLE_TABLES.length - 1;
    for (let index = 0; index < RING_MOD_TRIANGLE_HARMONIC_TIERS.length; index += 1) {
      if (RING_MOD_TRIANGLE_HARMONIC_TIERS[index]! <= harmonicBudget) {
        tier = index;
        break;
      }
    }
    const table = RING_MOD_TRIANGLE_TABLES[tier]!;
    const position = (phaseRadians / TWO_PI) * table.length;
    const baseIndex = Math.floor(position);
    const fraction = position - baseIndex;
    const first = table[baseIndex % table.length] ?? 0;
    const second = table[(baseIndex + 1) % table.length] ?? 0;
    return first + (second - first) * fraction;
  }

  /** Smoothed sine-LFO flanger with a four-point Lagrange read head. */
  private processFlanger(input: number, channel: 0 | 1): number {
    const buffer = this.flangerBuffers[channel];
    if (!buffer || buffer.length < 4) return input;
    const writeIndex = this.flangerWriteIndices[channel] ?? 0;
    const phase = this.flangerPhases[channel] ?? 0;
    const baseDelayMs = this.currentControls[9] ?? FLANGER_DEFAULT_DELAY_MILLISECONDS;
    const depth = this.currentControls[10] ?? FLANGER_DEFAULT_DEPTH;
    const rateHz = this.currentControls[11] ?? FLANGER_DEFAULT_RATE_HZ;
    const feedback = clamp(this.currentControls[12] ?? FLANGER_DEFAULT_FEEDBACK, -0.95, 0.95);
    const excursionMs = depth * FLANGER_MAX_DEPTH_MILLISECONDS;
    const delayMs = clamp(
      baseDelayMs + excursionMs * (this.officialModulation ? (channel === 0 ? this.officialLfoLeft : this.officialLfoRight) : Math.sin(phase)),
      FLANGER_MIN_DELAY_MILLISECONDS,
      FLANGER_MAX_DELAY_MILLISECONDS,
    );
    const delaySamples = Math.max(2, (delayMs * this.sampleRate) / 1000);
    const delayed = readLagrangeFromWriteHead(buffer, writeIndex, delaySamples);

    const damping = this.flangerFeedbackStates[channel] ?? 0;
    const filteredFeedback = damping + this.flangerDampingAlpha * (delayed - damping);
    this.flangerFeedbackStates[channel] = Number.isFinite(filteredFeedback) ? filteredFeedback : 0;
    const writeSample = input + feedback * Math.tanh(filteredFeedback * 1.5);
    buffer[writeIndex] = Number.isFinite(writeSample) ? clamp(writeSample, -4, 4) : 0;
    let nextWriteIndex = writeIndex + 1;
    if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
    this.flangerWriteIndices[channel] = nextWriteIndex;

    let nextPhase = phase + TWO_PI * rateHz / this.sampleRate;
    if (nextPhase >= TWO_PI) nextPhase -= TWO_PI;
    this.flangerPhases[channel] = nextPhase;
    // This is a feed-forward comb blend; output gain is bounded by a gentle
    // normalization before the core's outer wet/dry equal-power mixer.
    return this.officialIndependentMix ? delayed : 0.5 * (input + delayed);
  }

  /** Stereo-linked peak/RMS envelope and the clean-room F08 soft-knee curve. */
  private updateDynamicsDetector(left: number, right: number): void {
    const linkedMagnitude = Math.max(Math.abs(left), Math.abs(right));
    let envelope: number;
    if (this.dynamicsDetector === 'rms') {
      const power = linkedMagnitude * linkedMagnitude;
      const previousPower = this.dynamicsRmsMeanSquare;
      const coefficient = power > previousPower ? this.dynamicsAttackAlpha : this.dynamicsReleaseAlpha;
      this.dynamicsRmsMeanSquare = coefficient * previousPower + (1 - coefficient) * power;
      envelope = Math.sqrt(Math.max(0, this.dynamicsRmsMeanSquare));
    } else {
      const previousEnvelope = this.dynamicsPeakEnvelope;
      const coefficient = linkedMagnitude > previousEnvelope ? this.dynamicsAttackAlpha : this.dynamicsReleaseAlpha;
      this.dynamicsPeakEnvelope = coefficient * previousEnvelope + (1 - coefficient) * linkedMagnitude;
      envelope = this.dynamicsPeakEnvelope;
    }

    const levelDb = 20 * Math.log10(Math.max(DYNAMICS_ENVELOPE_FLOOR, envelope));
    const thresholdDb = this.currentControls[13] ?? DYNAMICS_DEFAULT_THRESHOLD_DB;
    const ratio = Math.max(1, this.currentControls[14] ?? DYNAMICS_DEFAULT_RATIO);
    const kneeDb = Math.max(0, this.currentControls[15] ?? DYNAMICS_DEFAULT_KNEE_DB);
    const slope = (1 / ratio) - 1;
    let gainReductionDb = 0;
    if (kneeDb <= 1e-6) {
      if (levelDb > thresholdDb) gainReductionDb = slope * (levelDb - thresholdDb);
    } else {
      const lowerKnee = thresholdDb - (kneeDb * 0.5);
      const upperKnee = thresholdDb + (kneeDb * 0.5);
      if (levelDb >= upperKnee) {
        gainReductionDb = slope * (levelDb - thresholdDb);
      } else if (levelDb > lowerKnee) {
        const kneePosition = levelDb - lowerKnee;
        gainReductionDb = slope * kneePosition * kneePosition / (2 * kneeDb);
      }
    }
    const gain = Math.pow(10, gainReductionDb / 20) * this.outputLinear;
    this.dynamicsGain = Number.isFinite(gain) ? clamp(gain, 0, 16) : 0;
  }

  /** Fixed-capacity stereo delay line with smoothed fractional read and feedback. */
  private processDelay(input: number, channel: 0 | 1): number {
    const buffer = this.delayBuffers[channel];
    if (!buffer || buffer.length < 4) return input;
    const writeIndex = this.delayWriteIndices[channel] ?? 0;
    const delaySamples = Math.max(
      2,
      Math.min(buffer.length - 6, ((this.currentControls[18] ?? DELAY_DEFAULT_TIME_MILLISECONDS) * this.sampleRate) / 1000),
    );
    const delayed = readLagrangeFromWriteHead(buffer, writeIndex, delaySamples);
    const previousTone = this.delayToneStates[channel] ?? 0;
    const filtered = previousTone + this.delayToneAlpha * (delayed - previousTone);
    this.delayToneStates[channel] = Number.isFinite(filtered) ? filtered : 0;
    const feedback = clamp(this.currentControls[19] ?? DELAY_DEFAULT_FEEDBACK, 0, 0.95);
    const writeSample = input + feedback * Math.tanh(filtered);
    buffer[writeIndex] = Number.isFinite(writeSample) ? clamp(writeSample, -4, 4) : 0;
    let nextWriteIndex = writeIndex + 1;
    if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
    this.delayWriteIndices[channel] = nextWriteIndex;
    return delayed * this.outputLinear;
  }

  /** Two-to-four decorrelated delay voices per channel, all preallocated. */
  private processChorus(input: number, channel: 0 | 1): number {
    const voices = this.chorusVoiceCount;
    const baseDelayMs = this.currentControls[21] ?? CHORUS_DEFAULT_DELAY_MILLISECONDS;
    const depthMs = this.currentControls[23] ?? CHORUS_DEFAULT_DEPTH_MILLISECONDS;
    const feedback = clamp(this.currentControls[24] ?? CHORUS_DEFAULT_FEEDBACK, 0, CHORUS_FEEDBACK_MAX);
    const channelBase = channel * 4;
    let sum = 0;

    for (let voice = 0; voice < voices; voice += 1) {
      const index = channelBase + voice;
      const buffer = this.chorusBuffers[index];
      if (!buffer) continue;
      const writeIndex = this.chorusWriteIndices[index] ?? 0;
      const phase = this.chorusPhase + (TWO_PI * voice / voices) + (channel === 0 ? 0 : Math.PI * 0.5);
      const delayMs = clamp(
        baseDelayMs + depthMs * Math.sin(phase),
        CHORUS_MIN_DELAY_MILLISECONDS,
        CHORUS_MAX_DELAY_MILLISECONDS,
      );
      const delaySamples = Math.max(2, Math.min(buffer.length - 6, delayMs * this.sampleRate / 1000));
      const delayed = readLagrangeFromWriteHead(buffer, writeIndex, delaySamples);
      const previousTone = this.chorusFeedbackStates[index] ?? 0;
      const filtered = previousTone + this.chorusToneAlpha * (delayed - previousTone);
      this.chorusFeedbackStates[index] = Number.isFinite(filtered) ? filtered : 0;
      const writeSample = input + feedback * Math.tanh(filtered);
      buffer[writeIndex] = Number.isFinite(writeSample) ? clamp(writeSample, -4, 4) : 0;
      let nextWriteIndex = writeIndex + 1;
      if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
      this.chorusWriteIndices[index] = nextWriteIndex;
      sum += delayed;
    }

    return sum / voices;
  }

  /** Four/eight cascaded all-pass sections with a quadrature stereo sweep. */
  private processPhaser(input: number, channel: 0 | 1): number {
    const depth = clamp(this.currentControls[27] ?? PHASER_DEFAULT_DEPTH, 0, 1);
    const feedback = clamp(this.currentControls[28] ?? PHASER_DEFAULT_FEEDBACK, 0, PHASER_FEEDBACK_MAX);
    const phase = this.phaserPhase + (channel === 0 ? 0 : Math.PI * 0.5);
    const lfo = this.officialModulation ? (channel === 0 ? this.officialLfoLeft : this.officialLfoRight) : Math.sin(phase);
    const manual = this.official.has('manual') ? clamp(this.official.get('manual'), 0, 100) / 100 : 0.5;
    const sweepPosition = clamp(manual + 0.5 * depth * lfo, 0, 1);
    const maximumFrequency = Math.min(PHASER_MAX_FREQUENCY_HZ, this.sampleRate * 0.45);
    const baseFrequency = PHASER_MIN_FREQUENCY_HZ
      * Math.pow(maximumFrequency / PHASER_MIN_FREQUENCY_HZ, sweepPosition);
    const channelOffset = channel * PHASER_MAX_STAGES;
    const feedbackSource = this.phaserFeedbackStates[channel] ?? 0;
    let stageInput = input + feedback * Math.tanh(feedbackSource);

    for (let stage = 0; stage < this.phaserStageCount; stage += 1) {
      // Slight stage-to-stage spread makes the cascade's phase rotation broad
      // rather than a set of coincident first-order sections.
      const stageScale = 0.72 + stage * 0.08;
      // BI-PHASE is a clean-room dual four-stage sweep: the second bank runs
      // opposite to the first, rather than pretending it is another stage count.
      const secondBankFrequency = this.officialBiPhase && stage >= 4
        ? PHASER_MIN_FREQUENCY_HZ * Math.pow(maximumFrequency / PHASER_MIN_FREQUENCY_HZ, clamp(manual - 0.5 * depth * lfo, 0, 1))
        : baseFrequency;
      const cutoff = clamp(secondBankFrequency * stageScale, 20, maximumFrequency);
      const tangent = Math.tan(Math.PI * cutoff / this.sampleRate);
      const coefficient = (tangent - 1) / (tangent + 1);
      const stateIndex = channelOffset + stage;
      const previousInput = this.phaserInputStates[stateIndex] ?? 0;
      const previousOutput = this.phaserOutputStates[stateIndex] ?? 0;
      const stageOutput = coefficient * stageInput + previousInput - coefficient * previousOutput;
      this.phaserInputStates[stateIndex] = stageInput;
      this.phaserOutputStates[stateIndex] = Number.isFinite(stageOutput) ? stageOutput : 0;
      stageInput = this.phaserOutputStates[stateIndex] ?? 0;
    }

    const previousFeedback = this.phaserFeedbackStates[channel] ?? 0;
    const filteredFeedback = previousFeedback + this.phaserToneAlpha * (stageInput - previousFeedback);
    this.phaserFeedbackStates[channel] = Number.isFinite(filteredFeedback) ? filteredFeedback : 0;
    // A 50/50 dry/all-pass sum produces the moving phase-cancellation notches;
    // the outer mix control then blends this effect with untouched dry input.
    return this.officialIndependentMix ? stageInput : 0.5 * (input + stageInput);
  }

  private lfoValue(waveform: BrowserTremoloWaveform, phase: number, phaseStep: number): number {
    if (waveform === 'sine') return Math.sin(TWO_PI * phase);
    if (waveform === 'triangle') return 1 - (4 * Math.abs(phase - 0.5));

    let square = phase < 0.5 ? 1 : -1;
    square += polyBlep(phase, phaseStep);
    const fallingEdgePhase = phase < 0.5 ? phase + 0.5 : phase - 0.5;
    square -= polyBlep(fallingEdgePhase, phaseStep);
    return clamp(square, -1, 1);
  }

  /** Stereo-linked amplitude modulation with a click-safe band-limited square LFO. */
  private processTremolo(input: number): number {
    const depth = clamp(this.currentControls[30] ?? TREMOLO_DEFAULT_DEPTH, 0, 1);
    const oldLfo = this.lfoValue(this.tremoloWaveformOld, this.tremoloPhase, this.tremoloPhaseStep);
    const targetLfo = this.tremoloWaveformOld === this.tremoloWaveformTarget
      ? oldLfo
      : this.lfoValue(this.tremoloWaveformTarget, this.tremoloPhase, this.tremoloPhaseStep);
    const blend = this.tremoloWaveformBlendValue;
    const lfo = this.official.has('waveform')
      ? this.officialWaveform(Math.sin(TWO_PI * this.tremoloPhase))
      : oldLfo + (targetLfo - oldLfo) * blend;
    const gain = 1 - depth * 0.5 * (1 - lfo);
    return input * gain;
  }

  /** Equal-power mono pan and stereo mid/side autopan share one bounded LFO. */
  private processAutoPan(inputLeft: number, inputRight: number, monoInput: boolean): void {
    const depth = clamp(this.currentControls[32] ?? AUTO_PAN_DEFAULT_DEPTH, 0, 1);
    const oldLfo = this.lfoValue(this.autoPanWaveformOld, this.autoPanPhase, this.autoPanPhaseStep);
    const targetLfo = this.autoPanWaveformOld === this.autoPanWaveformTarget
      ? oldLfo
      : this.lfoValue(this.autoPanWaveformTarget, this.autoPanPhase, this.autoPanPhaseStep);
    const blend = this.autoPanWaveformBlendValue;
    const rawLfo = this.officialModulation ? this.officialLfoLeft : oldLfo + (targetLfo - oldLfo) * blend;
    const lfo = this.official.has('waveform') ? this.officialWaveform(rawLfo) : rawLfo;
    const pan = clamp(depth * lfo, -1, 1);
    const angle = (pan + 1) * Math.PI * 0.25;
    const leftGain = Math.cos(angle);
    const rightGain = Math.sin(angle);

    if (monoInput) {
      this.autoPanWetLeft = inputLeft * leftGain;
      this.autoPanWetRight = inputLeft * rightGain;
      return;
    }

    const mid = 0.5 * (inputLeft + inputRight);
    const side = 0.5 * (inputLeft - inputRight);
    const sideGain = 1 - depth * Math.abs(lfo);
    this.autoPanWetLeft = mid * leftGain * Math.SQRT2 + side * sideGain;
    this.autoPanWetRight = mid * rightGain * Math.SQRT2 - side * sideGain;
  }

  /** Normalized tanh continuously sharpens sine toward square without discontinuities. */
  private officialWaveform(sine: number): number {
    const sharpness = 0.25 * 80 ** (clamp(this.official.get('waveform', 50), 0, 100) / 100);
    return Math.tanh(sharpness * sine) / Math.tanh(sharpness);
  }

  private processReverb(input: number, channel: 0 | 1): number {
    const lineStart = channel === 0 ? 0 : 8;
    let feedbackSum = 0;
    let outputSum = 0;

    const earlyBuffer = this.earlyBuffers[channel];
    let earlyIndex = this.earlyWriteIndices[channel] ?? 0;
    if (earlyBuffer) earlyBuffer[earlyIndex] = input;
    const earlyCoefficients = channel === 0 ? EARLY_REFLECTION_GAINS_LEFT : EARLY_REFLECTION_GAINS_RIGHT;
    let early = input * (earlyCoefficients[0] ?? 0);
    const density = this.official.has('density') ? clamp(this.official.get('density'), 1, 10) : 10;
    const earlyTapCount = Math.max(2, Math.ceil(EARLY_REFLECTION_DELAYS_SECONDS.length * density / 10));
    for (let tap = 1; tap < earlyTapCount; tap += 1) {
      if (!earlyBuffer) continue;
      const delay = this.earlyDelays[tap] ?? 0;
      // earlyIndex and delay are both bounded to [0, earlyRingLength), so a
      // negative difference wraps at most once.
      let readIndex = earlyIndex - delay;
      if (readIndex < 0) readIndex += this.earlyRingLength;
      early += (earlyBuffer[readIndex] ?? 0) * (earlyCoefficients[tap] ?? 0);
    }
    earlyIndex += 1;
    if (earlyIndex >= this.earlyRingLength) earlyIndex = 0;
    this.earlyWriteIndices[channel] = earlyIndex;

    for (let line = 0; line < 8; line += 1) {
      const index = lineStart + line;
      const buffer = this.fdnBuffers[index];
      const writeIndex = this.fdnWriteIndices[index] ?? 0;
      const modulationPhase = this.delayModPhases[index] ?? 0;
      const modulatedDelay = (this.delayLengths[index] ?? 1) + FDN_MODULATION_DEPTH_SAMPLES * Math.sin(modulationPhase);
      const raw = buffer ? readLagrangeFromWriteHead(buffer, writeIndex, modulatedDelay) : 0;
      let nextModulationPhase = modulationPhase + (this.delayModPhaseSteps[index] ?? 0);
      if (nextModulationPhase >= TWO_PI) nextModulationPhase -= TWO_PI;
      this.delayModPhases[index] = nextModulationPhase;
      const damping = this.delayDampingStates[index] ?? 0;
      const alpha = this.dampingAlpha[index] ?? 1;
      const damped = damping + alpha * (raw - damping);
      const dampedState = Math.abs(damped) < MIN_STATE_MAGNITUDE ? 0 : damped;
      this.delayDampingStates[index] = dampedState;
      const feedback = dampedState * (this.delayFeedbackGains[index] ?? 0);
      this.delayReadScratch[index] = feedback;
      feedbackSum += feedback;
      outputSum += dampedState * (line % 2 === 0 ? 1 : -1);
    }

    for (let line = 0; line < 8; line += 1) {
      const index = lineStart + line;
      const buffer = this.fdnBuffers[index];
      if (!buffer) continue;
      const feedback = this.delayReadScratch[index] ?? 0;
      const householderOutput = feedback - HOUSEHOLDER_ROW_SUM_FACTOR * feedbackSum;
      const injectionSign = (line & 1) === 0 ? 1 : -1;
      const injectionWeight = this.official.has('density') ? clamp(density * 0.8 - line, 0, 1) : 1;
      let next = householderOutput + input * FDN_INJECTION_GAIN * injectionSign * injectionWeight;
      if (!Number.isFinite(next) || Math.abs(next) < MIN_STATE_MAGNITUDE) next = 0;
      const writeIndex = this.fdnWriteIndices[index] ?? 0;
      buffer[writeIndex] = next;
      let advancedIndex = writeIndex + 1;
      if (advancedIndex >= buffer.length) advancedIndex = 0;
      this.fdnWriteIndices[index] = advancedIndex;
    }

    const wet = early * EARLY_OUTPUT_GAIN + outputSum * FDN_OUTPUT_GAIN;
    return wet;
  }
}

// Export the numerical contract for direct exceptional-value regression tests.
export { clamp as clampBrowserFxValue };
