import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';

/**
 * Provisional controls for the clean-room Browser SYNTH reconstruction.
 * Ranges/defaults match the local catalog descriptors; they are not Roland
 * specifications. No Roland source, samples, or proprietary code are used.
 */
export interface BrowserSynthParameters {
  sensitivity?: number;
  waveform?: number;
  octave?: number;
  tone?: number;
  mix?: number;
  /** Blend between measured F0 and its nearest equal-tempered semitone. */
  pitchSnapPercent?: number;
  /** Optional oscillator subvoice level; SYNTH defaults to 14%, G2B pins it off. */
  subMixPercent?: number;
}

const DEFAULT_SENSITIVITY = 60;
const DEFAULT_WAVEFORM = 0;
const DEFAULT_OCTAVE = 0;
const DEFAULT_TONE_HZ = 4_000;
const DEFAULT_MIX_PERCENT = 50;
const DEFAULT_SUB_MIX_PERCENT = 14;

const MINIMUM_F0_HZ = 55;
const MAXIMUM_F0_HZ = 1_000;
const ANALYSIS_HOP_SECONDS = 0.005;
const PARAMETER_RAMP_SECONDS = 0.02;
const FILTER_CONTROL_INTERVAL = 16;
const FILTER_RESONANCE_Q = 1.25;
const MAX_INPUT_MAGNITUDE = 4;
const MAX_OUTPUT_MAGNITUDE = 4;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cleanNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, minimum, maximum)
    : fallback;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function onePoleAlpha(seconds: number, sampleRate: number): number {
  return Math.exp(-1 / (Math.max(0.001, seconds) * sampleRate));
}

/**
 * Fixed-memory YIN detector for an already decimated mono stream. It performs
 * a two-period difference analysis, uses a sensitivity-dependent CMND
 * threshold, parabolic lag refinement, and two-frame voiced/unvoiced
 * hysteresis. All rings and analysis work arrays are allocated in construction.
 */
class SynthYinTracker {
  readonly sampleRate: number;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
  readonly frameSamples: number;
  readonly hopSamples: number;

  private readonly ring: Float32Array;
  private readonly differences: Float64Array;
  private readonly normalizedDifferences: Float64Array;
  private readonly ringMask: number;
  private readonly minimumLag: number;
  private readonly maximumLag: number;
  private readonly analysisWindowSamples: number;
  private writeIndex = 0;
  private sampleCount = 0;
  private nextAnalysisSample: number;
  private sensitivity = DEFAULT_SENSITIVITY;
  private confidenceValue = 0;
  private frequencyValue = 0;
  private voicedValue = false;
  private goodFrames = 0;
  private badFrames = 0;
  private logFrequency = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.minimumFrequencyHz = Math.min(MINIMUM_F0_HZ, sampleRate * 0.08);
    this.maximumFrequencyHz = Math.min(MAXIMUM_F0_HZ, sampleRate * 0.4);
    this.minimumLag = Math.max(2, Math.floor(sampleRate / this.maximumFrequencyHz));
    this.maximumLag = Math.ceil(sampleRate / this.minimumFrequencyHz);
    this.frameSamples = Math.max(64, this.maximumLag * 3);
    this.hopSamples = Math.max(1, Math.round(sampleRate * ANALYSIS_HOP_SECONDS));
    this.analysisWindowSamples = this.frameSamples - this.maximumLag;
    const ringLength = nextPowerOfTwo(this.frameSamples * 2);
    this.ring = new Float32Array(ringLength);
    this.differences = new Float64Array(this.maximumLag + 1);
    this.normalizedDifferences = new Float64Array(this.maximumLag + 1);
    this.ringMask = ringLength - 1;
    this.nextAnalysisSample = this.frameSamples;
  }

  get frequencyHz(): number {
    return this.voicedValue ? this.frequencyValue : 0;
  }

  get confidence(): number {
    return this.confidenceValue;
  }

  get voiced(): boolean {
    return this.voicedValue;
  }

  setSensitivity(value: number): void {
    if (Number.isFinite(value)) this.sensitivity = clamp(value, 0, 100);
  }

  pushSample(sample: number, sensitivity = this.sensitivity): void {
    this.setSensitivity(sensitivity);
    this.ring[this.writeIndex] = Number.isFinite(sample) ? sample : 0;
    this.writeIndex = (this.writeIndex + 1) & this.ringMask;
    this.sampleCount += 1;
    if (this.sampleCount < this.nextAnalysisSample) return;
    this.analyzeFrame();
    this.nextAnalysisSample += this.hopSamples;
  }

  reset(): void {
    this.ring.fill(0);
    this.differences.fill(0);
    this.normalizedDifferences.fill(0);
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.nextAnalysisSample = this.frameSamples;
    this.confidenceValue = 0;
    this.frequencyValue = 0;
    this.voicedValue = false;
    this.goodFrames = 0;
    this.badFrames = 0;
    this.logFrequency = 0;
  }

  private analyzeFrame(): void {
    let frameStart = this.writeIndex - this.frameSamples;
    if (frameStart < 0) frameStart += this.ring.length;

    let energy = 0;
    for (let index = 0; index < this.frameSamples; index += 1) {
      let ringIndex = frameStart + index;
      if (ringIndex >= this.ring.length) ringIndex -= this.ring.length;
      const sample = this.ring[ringIndex]!;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / this.frameSamples);

    this.differences[0] = 0;
    for (let lag = 1; lag <= this.maximumLag; lag += 1) {
      let difference = 0;
      for (let index = 0; index < this.analysisWindowSamples; index += 1) {
        let first = frameStart + index;
        if (first >= this.ring.length) first -= this.ring.length;
        let second = first + lag;
        if (second >= this.ring.length) second -= this.ring.length;
        const delta = this.ring[first]! - this.ring[second]!;
        difference += delta * delta;
      }
      this.differences[lag] = difference;
    }

    let cumulativeDifference = 0;
    for (let lag = 1; lag <= this.maximumLag; lag += 1) {
      cumulativeDifference += this.differences[lag]!;
      this.normalizedDifferences[lag] = cumulativeDifference > 1e-15
        ? (this.differences[lag]! * lag) / cumulativeDifference
        : 1;
    }

    // Higher sensitivity accepts weaker/lower-confidence periodic inputs.
    const sensitivity = this.sensitivity / 100;
    const threshold = 0.23 - (0.09 * sensitivity);
    const activeThreshold = this.voicedValue ? Math.min(0.32, threshold + 0.055) : threshold;
    let bestLag = 0;
    let bestValue = Number.POSITIVE_INFINITY;
    for (let lag = this.minimumLag; lag <= this.maximumLag; lag += 1) {
      const value = this.normalizedDifferences[lag]!;
      if (value < bestValue) {
        bestValue = value;
        bestLag = lag;
      }
      if (
        value < activeThreshold &&
        (lag === this.maximumLag || value <= this.normalizedDifferences[lag + 1]!)
      ) {
        bestLag = lag;
        while (
          bestLag < this.maximumLag &&
          this.normalizedDifferences[bestLag + 1]! < this.normalizedDifferences[bestLag]!
        ) {
          bestLag += 1;
        }
        bestValue = this.normalizedDifferences[bestLag]!;
        break;
      }
    }

    this.confidenceValue = Number.isFinite(bestValue)
      ? clamp(1 - bestValue, 0, 1)
      : 0;
    const amplitudeThreshold = 0.003 + ((1 - sensitivity) * 0.035);
    const candidate = rms >= amplitudeThreshold && bestLag > 0 && bestValue < activeThreshold;
    if (candidate) {
      this.goodFrames += 1;
      this.badFrames = 0;
      let refinedLag = bestLag;
      if (bestLag > this.minimumLag && bestLag < this.maximumLag) {
        const left = this.normalizedDifferences[bestLag - 1]!;
        const center = this.normalizedDifferences[bestLag]!;
        const right = this.normalizedDifferences[bestLag + 1]!;
        const denominator = left - (2 * center) + right;
        if (Math.abs(denominator) > 1e-12) {
          refinedLag += clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
        }
      }
      const measuredLogFrequency = Math.log(this.sampleRate / refinedLag);
      if (this.goodFrames === 1 || this.frequencyValue <= 0) {
        this.logFrequency = measuredLogFrequency;
      } else {
        this.logFrequency += (measuredLogFrequency - this.logFrequency) * 0.35;
      }
      this.frequencyValue = Math.exp(this.logFrequency);
      if (this.goodFrames >= 2) this.voicedValue = true;
    } else {
      this.goodFrames = 0;
      this.badFrames += 1;
      if (this.badFrames >= 2) this.voicedValue = false;
    }
  }
}

/**
 * Clean-room monophonic Browser SYNTH kernel. Stereo input is linked for a
 * mono YIN analysis and envelope follower. The analysis stream is boxcar/
 * one-pole decimated to at most 12 kHz; YIN runs every 5 ms. A polyBLEP saw
 * or square drives the authored waveform selector, with an integrated
 * polyBLEP square for triangle and a fixed 14% octave-down square sub voice.
 * A resonant TPT-SVF low-pass (Q 1.25) supplies the tone control. Those
 * oscillator/subvoice, resonance, envelope, fallback and smoothing values are
 * explicit clean-room choices, not claims about Roland hardware.
 */
export class BrowserSynthDsp {
  readonly sampleRate: number;
  outputLeft = 0;
  outputRight = 0;

  private readonly detector: SynthYinTracker;
  private readonly decimation: number;
  private readonly decimatorAlpha: number;
  private readonly sensitivity: LinearParameterSmoother;
  private readonly waveform: LinearParameterSmoother;
  private readonly octave: LinearParameterSmoother;
  private readonly toneHz: LinearParameterSmoother;
  private readonly mixPercent: LinearParameterSmoother;
  private readonly pitchSnapPercent: LinearParameterSmoother;
  private readonly subMixPercent: LinearParameterSmoother;
  private readonly filter: TptStateVariableFilter;
  private readonly envelopeAttackAlpha: number;
  private readonly envelopeReleaseAlpha: number;
  private readonly trackingAttackAlpha: number;
  private readonly trackingReleaseAlpha: number;
  private readonly pitchSmoothingAlpha: number;

  private decimatorCount = 0;
  private decimatorFiltered = 0;
  private inputEnvelopeValue = 0;
  private trackingBlend = 0;
  private targetFrequencyHz = 0;
  private oscillatorFrequencyHz = 0;
  private oscillatorPhase = 0;
  private subOscillatorPhase = 0;
  private triangleState = 0;
  private controlsCountdown = 0;

  constructor(sampleRate: number, parameters: BrowserSynthParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    this.decimation = Math.max(1, Math.ceil(this.sampleRate / 12_000));
    const detectorRate = this.sampleRate / this.decimation;
    this.detector = new SynthYinTracker(detectorRate);
    // This one-pole anti-aliases the decimated analysis path; the tracker is
    // not in the audio path and therefore adds no audio sample delay.
    this.decimatorAlpha = this.decimation > 1
      ? 1 - Math.exp((-2 * Math.PI * (detectorRate * 0.42)) / this.sampleRate)
      : 1;

    const sensitivity = cleanNumber(parameters.sensitivity, DEFAULT_SENSITIVITY, 0, 100);
    const waveform = Math.round(cleanNumber(parameters.waveform, DEFAULT_WAVEFORM, 0, 2));
    const octave = cleanNumber(parameters.octave, DEFAULT_OCTAVE, -24, 24);
    const tone = cleanNumber(parameters.tone, DEFAULT_TONE_HZ, 100, 16_000);
    const mix = cleanNumber(parameters.mix, DEFAULT_MIX_PERCENT, 0, 100);
    const pitchSnapPercent = cleanNumber(parameters.pitchSnapPercent, 0, 0, 100);
    const subMix = cleanNumber(parameters.subMixPercent, DEFAULT_SUB_MIX_PERCENT, 0, 100);
    this.sensitivity = new LinearParameterSmoother(sensitivity);
    this.waveform = new LinearParameterSmoother(waveform);
    this.octave = new LinearParameterSmoother(octave);
    this.toneHz = new LinearParameterSmoother(tone);
    this.mixPercent = new LinearParameterSmoother(mix);
    this.pitchSnapPercent = new LinearParameterSmoother(pitchSnapPercent);
    this.subMixPercent = new LinearParameterSmoother(subMix);
    this.filter = new TptStateVariableFilter(this.sampleRate, tone, FILTER_RESONANCE_Q);

    this.envelopeAttackAlpha = onePoleAlpha(0.004, this.sampleRate);
    this.envelopeReleaseAlpha = onePoleAlpha(0.075, this.sampleRate);
    this.trackingAttackAlpha = onePoleAlpha(0.008, this.sampleRate);
    this.trackingReleaseAlpha = onePoleAlpha(0.022, this.sampleRate);
    this.pitchSmoothingAlpha = 1 - onePoleAlpha(0.018, this.sampleRate);
  }

  /** Most recent YIN periodicity confidence, from 0 (weak) to 1 (strong). */
  get detectorConfidence(): number {
    return this.detector.confidence;
  }

  /** Latest accepted monophonic F0, or zero while the detector is unvoiced. */
  get detectedFrequencyHz(): number {
    return this.detector.frequencyHz;
  }

  get isVoiced(): boolean {
    return this.detector.voiced;
  }

  /** When unvoiced, the effect's wet branch follows the input as a safe fallback. */
  get fallbackActive(): boolean {
    return !this.detector.voiced;
  }

  get inputEnvelope(): number {
    return this.inputEnvelopeValue;
  }

  /** Current clamped targets are exposed for diagnostics and deterministic tests. */
  get targetSensitivityPercent(): number {
    return this.sensitivity.targetValue;
  }

  get targetWaveform(): number {
    return this.waveform.targetValue;
  }

  get targetOctaveSemitones(): number {
    return this.octave.targetValue;
  }

  get targetToneHz(): number {
    return this.toneHz.targetValue;
  }

  get targetMixPercent(): number {
    return this.mixPercent.targetValue;
  }

  /** Latest pitch target driving the oscillator, after the snap blend. */
  get targetPitchHz(): number {
    return this.targetFrequencyHz;
  }

  get targetPitchSnapPercent(): number {
    return this.pitchSnapPercent.targetValue;
  }

  get targetSubMixPercent(): number {
    return this.subMixPercent.targetValue;
  }

  setParameters(parameters: BrowserSynthParameters): void {
    const rampFrames = Math.max(1, Math.round(this.sampleRate * PARAMETER_RAMP_SECONDS));
    if (Number.isFinite(parameters.sensitivity)) {
      this.sensitivity.setTarget(clamp(parameters.sensitivity as number, 0, 100), rampFrames);
    }
    if (Number.isFinite(parameters.waveform)) {
      this.waveform.setTarget(Math.round(clamp(parameters.waveform as number, 0, 2)), rampFrames);
    }
    if (Number.isFinite(parameters.octave)) {
      this.octave.setTarget(clamp(parameters.octave as number, -24, 24), rampFrames);
    }
    if (Number.isFinite(parameters.tone)) {
      this.toneHz.setTarget(clamp(parameters.tone as number, 100, 16_000), rampFrames);
    }
    if (Number.isFinite(parameters.mix)) {
      this.mixPercent.setTarget(clamp(parameters.mix as number, 0, 100), rampFrames);
    }
    if (Number.isFinite(parameters.pitchSnapPercent)) {
      this.pitchSnapPercent.setTarget(clamp(parameters.pitchSnapPercent as number, 0, 100), rampFrames);
    }
    if (Number.isFinite(parameters.subMixPercent)) {
      this.subMixPercent.setTarget(clamp(parameters.subMixPercent as number, 0, 100), rampFrames);
    }
  }

  /** Advances one stereo frame; the processor has no block-size-dependent state. */
  processSample(inputLeft: number, inputRight: number): void {
    const left = Number.isFinite(inputLeft)
      ? clamp(inputLeft, -MAX_INPUT_MAGNITUDE, MAX_INPUT_MAGNITUDE)
      : 0;
    const right = Number.isFinite(inputRight)
      ? clamp(inputRight, -MAX_INPUT_MAGNITUDE, MAX_INPUT_MAGNITUDE)
      : 0;
    const peak = Math.max(Math.abs(left), Math.abs(right));
    const envelopeAlpha = peak > this.inputEnvelopeValue
      ? this.envelopeAttackAlpha
      : this.envelopeReleaseAlpha;
    this.inputEnvelopeValue = peak + envelopeAlpha * (this.inputEnvelopeValue - peak);

    const sensitivity = this.sensitivity.next();
    const waveform = this.waveform.next();
    const octave = this.octave.next();
    const tone = this.toneHz.next();
    const mix = this.mixPercent.next() / 100;
    const pitchSnap = this.pitchSnapPercent.next() / 100;
    const subMix = this.subMixPercent.next() / 100;

    if (this.decimation > 1) {
      const mono = (left + right) * 0.5;
      this.decimatorFiltered += (mono - this.decimatorFiltered) * this.decimatorAlpha;
      this.decimatorCount += 1;
      if (this.decimatorCount >= this.decimation) {
        this.detector.pushSample(this.decimatorFiltered, sensitivity);
        this.decimatorCount = 0;
      }
    } else {
      this.detector.pushSample((left + right) * 0.5, sensitivity);
    }

    const voiced = this.detector.voiced;
    const confidence = this.detector.confidence;
    const trackingTarget = voiced ? clamp((confidence - 0.2) / 0.8, 0, 1) : 0;
    const trackingAlpha = trackingTarget > this.trackingBlend
      ? this.trackingAttackAlpha
      : this.trackingReleaseAlpha;
    this.trackingBlend = trackingTarget + trackingAlpha * (this.trackingBlend - trackingTarget);

    if (this.controlsCountdown <= 0) {
      if (voiced && this.detector.frequencyHz > 0) {
        const octaveRatio = Math.pow(2, octave / 12);
        const measuredFrequency = this.detector.frequencyHz;
        const midiNote = 69 + (12 * Math.log2(measuredFrequency / 440));
        const quantizedFrequency = 440 * Math.pow(2, (Math.round(midiNote) - 69) / 12);
        const snappedFrequency = Math.exp(
          Math.log(measuredFrequency)
          + ((Math.log(quantizedFrequency) - Math.log(measuredFrequency)) * pitchSnap),
        );
        this.targetFrequencyHz = clamp(
          snappedFrequency * octaveRatio,
          10,
          this.sampleRate * 0.45,
        );
      }
      this.filter.setParameters(Math.min(tone, this.sampleRate * 0.45), FILTER_RESONANCE_Q);
      this.controlsCountdown = FILTER_CONTROL_INTERVAL - 1;
    } else {
      this.controlsCountdown -= 1;
    }

    if (this.targetFrequencyHz > 0) {
      this.oscillatorFrequencyHz +=
        (this.targetFrequencyHz - this.oscillatorFrequencyHz) * this.pitchSmoothingAlpha;
    }

    let oscillator = 0;
    if (this.oscillatorFrequencyHz > 0) {
      const dt = clamp(this.oscillatorFrequencyHz / this.sampleRate, 1e-5, 0.45);
      const subDt = dt * 0.5;
      const saw = (2 * this.oscillatorPhase) - 1 - this.polyBlep(this.oscillatorPhase, dt);
      let square = this.oscillatorPhase < 0.5 ? 1 : -1;
      square += this.polyBlep(this.oscillatorPhase, dt);
      let secondEdge = this.oscillatorPhase + 0.5;
      if (secondEdge >= 1) secondEdge -= 1;
      square -= this.polyBlep(secondEdge, dt);
      this.triangleState = clamp(this.triangleState + square * (4 * dt), -1, 1);

      const subSquareRaw = this.subOscillatorPhase < 0.5 ? 1 : -1;
      let subSquare = subSquareRaw + this.polyBlep(this.subOscillatorPhase, subDt);
      let subSecondEdge = this.subOscillatorPhase + 0.5;
      if (subSecondEdge >= 1) subSecondEdge -= 1;
      subSquare -= this.polyBlep(subSecondEdge, subDt);

      let selectedWave: number;
      if (waveform <= 1) {
        selectedWave = saw + (square - saw) * waveform;
      } else {
        selectedWave = square + (this.triangleState - square) * (waveform - 1);
      }
      oscillator = (selectedWave * (1 - subMix)) + (subSquare * subMix);

      this.oscillatorPhase += dt;
      if (this.oscillatorPhase >= 1) this.oscillatorPhase -= 1;
      this.subOscillatorPhase += subDt;
      if (this.subOscillatorPhase >= 1) this.subOscillatorPhase -= 1;
    }

    const filteredOscillator = this.filter.processSample(oscillator);
    const velocity = clamp(this.inputEnvelopeValue * 2.5, 0, 0.9);
    const synthesized = filteredOscillator * velocity * this.trackingBlend;
    const wetLeft = (left * (1 - this.trackingBlend)) + synthesized;
    const wetRight = (right * (1 - this.trackingBlend)) + synthesized;
    this.outputLeft = clamp((left * (1 - mix)) + (wetLeft * mix), -MAX_OUTPUT_MAGNITUDE, MAX_OUTPUT_MAGNITUDE);
    this.outputRight = clamp((right * (1 - mix)) + (wetRight * mix), -MAX_OUTPUT_MAGNITUDE, MAX_OUTPUT_MAGNITUDE);
  }

  reset(): void {
    this.detector.reset();
    this.decimatorCount = 0;
    this.decimatorFiltered = 0;
    this.inputEnvelopeValue = 0;
    this.trackingBlend = 0;
    this.targetFrequencyHz = 0;
    this.oscillatorFrequencyHz = 0;
    this.oscillatorPhase = 0;
    this.subOscillatorPhase = 0;
    this.triangleState = 0;
    this.controlsCountdown = 0;
    this.filter.reset();
    this.outputLeft = 0;
    this.outputRight = 0;
    this.sensitivity.reset();
    this.waveform.reset();
    this.octave.reset();
    this.toneHz.reset();
    this.mixPercent.reset();
    this.pitchSnapPercent.reset();
    this.subMixPercent.reset();
  }

  private polyBlep(phase: number, dt: number): number {
    if (phase < dt) {
      const normalized = phase / dt;
      return (normalized + normalized) - (normalized * normalized) - 1;
    }
    if (phase > 1 - dt) {
      const normalized = (phase - 1) / dt;
      return (normalized * normalized) + (normalized + normalized) + 1;
    }
    return 0;
  }
}
