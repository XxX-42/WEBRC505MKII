import { TptStateVariableFilter } from '../dsp/TptStateVariableFilter';
import { BrowserVocoderCore } from './vocoder/BrowserVocoderCore';

export type BrowserOscBotWaveform = 0 | 1 | 2;

export interface BrowserOscBotParameters {
  bands?: number;
  waveform?: BrowserOscBotWaveform;
  pattern?: number;
  toneCutoffHz?: number;
  mix?: number;
  /** Project tempo, supplied by the host. Each pattern step is a sixteenth note. */
  tempoBpm?: number;
}

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_BANDS = 8;
const MAX_BANDS = 24;
const DEFAULT_BANDS = 16;
const MIN_TEMPO_BPM = 30;
const MAX_TEMPO_BPM = 300;
const MAX_OUTPUT_MAGNITUDE = 4;
const MAX_INPUT_MAGNITUDE = 8;
const DEFAULT_TONE_HZ = 3000;
const FILTER_Q = 2.2;
const MAX_OSC_FREQUENCY_RATIO = 0.45;

// Authored clean-room step sequences. They are semitone offsets and make no
// claim to reproduce the unavailable factory pattern ROM/topology.
const STEP_PATTERNS: readonly (readonly number[])[] = [
  [0, 0, 7, 0, 12, 0, 7, 0],
  [0, 3, 7, 10, 12, 10, 7, 3],
  [0, 0, 0, 7, 0, 0, 12, 7],
  [0, 5, 7, 12, 7, 5, 3, 0],
  [0, 12, 7, 5, 0, 12, 10, 7],
  [0, 0, 5, 7, 10, 7, 5, 3],
  [0, 4, 7, 11, 12, 11, 7, 4],
  [0, -5, 0, 7, 0, -5, 12, 7],
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function bounded(value: number, magnitude: number): number {
  return Number.isFinite(value) ? clamp(value, -magnitude, magnitude) : 0;
}

function polyBlep(phase: number, increment: number): number {
  if (increment <= 0 || increment >= 0.5) return 0;
  if (phase < increment) {
    const t = phase / increment;
    return (2 * t) - (t * t) - 1;
  }
  if (phase > 1 - increment) {
    const t = (phase - 1) / increment;
    return (t * t) + (2 * t) + 1;
  }
  return 0;
}

/** One fixed-state anti-aliased oscillator. Triangle integrates a BLEP square. */
class Oscillator {
  private readonly sampleRate: number;
  private frequencyHz = 110;
  private phase = 0;
  private triangle = 0;
  private waveform: BrowserOscBotWaveform = 1;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  set(frequencyHz: number, waveform: BrowserOscBotWaveform): void {
    this.frequencyHz = clamp(frequencyHz, 1, this.sampleRate * MAX_OSC_FREQUENCY_RATIO);
    this.waveform = waveform;
  }

  reset(): void {
    this.phase = 0;
    this.triangle = 0;
  }

  processSample(): number {
    const increment = this.frequencyHz / this.sampleRate;
    let square = this.phase < 0.5 ? 1 : -1;
    square += polyBlep(this.phase, increment);
    const shiftedPhase = this.phase < 0.5 ? this.phase + 0.5 : this.phase - 0.5;
    square -= polyBlep(shiftedPhase, increment);

    let output = square;
    if (this.waveform === 0) {
      output = (2 * this.phase) - 1 - polyBlep(this.phase, increment);
    } else if (this.waveform === 2) {
      // Integrating a band-limited square yields a substantially lower-alias
      // triangle than the discontinuous naive triangle waveform.
      this.triangle = clamp((this.triangle * 0.99999) + (4 * increment * square), -1, 1);
      output = this.triangle;
    }

    this.phase += increment;
    if (this.phase >= 1) this.phase -= 1;
    return output;
  }
}

/**
 * Clean-room OSC BOT synthesis core. A fixed oscillator is assigned to each
 * ERB carrier band. The shared VOCODER filterbank supplies the real input
 * envelope and band-selective carrier shaping; an eight-step sample-clocked
 * semitone sequence moves the carrier bank, then a resonant TPT low-pass sets
 * tone. The authored patterns and topology are reconstructions, not Roland
 * firmware or factory sound claims.
 */
export class BrowserOscBotCore {
  readonly sampleRate: number;
  readonly algorithmicLatencySamples = 0;
  private readonly vocoder: BrowserVocoderCore;
  private readonly oscillators: Oscillator[];
  private readonly bandCarriers: Float32Array;
  private readonly toneFilter: TptStateVariableFilter;
  private activeBands: number;
  private waveform: BrowserOscBotWaveform;
  private patternIndex: number;
  private toneCutoffHz: number;
  private mix: number;
  private tempoValue: number;
  private currentStepFrames: number;
  private framesUntilStep: number;
  private activeStep = 0;
  private frame = 0;
  private currentOutput = 0;

  constructor(sampleRate = 48000, parameters: BrowserOscBotParameters = {}, initialFrame = 0) {
    if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
      throw new RangeError(`Browser OSC BOT sample rate must be from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} Hz.`);
    }
    BrowserOscBotCore.validateFrame(initialFrame);
    this.sampleRate = sampleRate;
    this.activeBands = BrowserOscBotCore.validateBands(parameters.bands ?? DEFAULT_BANDS);
    this.waveform = BrowserOscBotCore.validateWaveform(parameters.waveform ?? 1);
    this.patternIndex = BrowserOscBotCore.validatePattern(parameters.pattern ?? 0);
    this.toneCutoffHz = BrowserOscBotCore.validateTone(parameters.toneCutoffHz ?? DEFAULT_TONE_HZ, sampleRate);
    this.mix = BrowserOscBotCore.validateMix(parameters.mix ?? 1);
    this.tempoValue = BrowserOscBotCore.validateTempo(parameters.tempoBpm ?? 120);
    this.currentStepFrames = BrowserOscBotCore.computeStepFrames(sampleRate, this.tempoValue);
    this.framesUntilStep = this.currentStepFrames;
    this.frame = initialFrame;
    this.vocoder = new BrowserVocoderCore(sampleRate, { bands: this.activeBands, carrier: 0 });
    this.bandCarriers = new Float32Array(MAX_BANDS);
    this.oscillators = Array.from({ length: MAX_BANDS }, () => new Oscillator(sampleRate));
    this.toneFilter = new TptStateVariableFilter(sampleRate, this.toneCutoffHz, FILTER_Q);
    this.updateCarrierBank();
  }

  get outputLeft(): number { return this.currentOutput; }
  get outputRight(): number { return this.currentOutput; }
  get bands(): number { return this.activeBands; }
  get pattern(): number { return this.patternIndex; }
  get tempoBpm(): number { return this.tempoValue; }
  get stepIndex(): number { return this.activeStep; }
  get stepFrames(): number { return this.currentStepFrames; }
  get currentFrame(): number { return this.frame; }
  getEnvelopeLevel(band: number): number { return this.vocoder.getEnvelopeLevel(band); }
  getBandCenterFrequencyHz(band: number): number { return this.vocoder.getBandCenterFrequencyHz(band); }

  setParameters(parameters: BrowserOscBotParameters): void {
    for (const key of Object.keys(parameters)) {
      if (key !== 'bands' && key !== 'waveform' && key !== 'pattern' && key !== 'toneCutoffHz' && key !== 'mix' && key !== 'tempoBpm') {
        throw new RangeError(`Browser OSC BOT does not support the ${key} parameter.`);
      }
    }

    const nextBands = parameters.bands === undefined ? this.activeBands : BrowserOscBotCore.validateBands(parameters.bands);
    const nextWaveform = parameters.waveform === undefined ? this.waveform : BrowserOscBotCore.validateWaveform(parameters.waveform);
    const nextPattern = parameters.pattern === undefined ? this.patternIndex : BrowserOscBotCore.validatePattern(parameters.pattern);
    const nextTone = parameters.toneCutoffHz === undefined
      ? this.toneCutoffHz : BrowserOscBotCore.validateTone(parameters.toneCutoffHz, this.sampleRate);
    const nextMix = parameters.mix === undefined ? this.mix : BrowserOscBotCore.validateMix(parameters.mix);
    const nextTempo = parameters.tempoBpm === undefined ? this.tempoValue : BrowserOscBotCore.validateTempo(parameters.tempoBpm);
    const bandsChanged = nextBands !== this.activeBands;
    const tempoChanged = nextTempo !== this.tempoValue;
    this.activeBands = nextBands;
    this.waveform = nextWaveform;
    this.patternIndex = nextPattern;
    this.toneCutoffHz = nextTone;
    this.mix = nextMix;
    this.tempoValue = nextTempo;
    if (bandsChanged) this.vocoder.setParameters({ bands: nextBands });
    if (tempoChanged) {
      const oldStepFrames = this.currentStepFrames;
      this.currentStepFrames = BrowserOscBotCore.computeStepFrames(this.sampleRate, this.tempoValue);
      const elapsed = oldStepFrames - this.framesUntilStep;
      const phase = oldStepFrames > 0 ? clamp(elapsed / oldStepFrames, 0, 1) : 0;
      this.framesUntilStep = Math.max(1, Math.round(this.currentStepFrames * (1 - phase)));
    }
    this.toneFilter.setParameters(this.toneCutoffHz, FILTER_Q);
    this.updateCarrierBank();
  }

  setTempoBpm(tempoBpm: number): void {
    this.setParameters({ tempoBpm });
  }

  processSample(modulatorSample: number): number {
    const modulator = bounded(modulatorSample, MAX_INPUT_MAGNITUDE);
    const filtered = this.processWet(modulator);
    this.currentOutput = bounded((modulator * (1 - this.mix)) + (filtered * this.mix), MAX_OUTPUT_MAGNITUDE);
    return this.currentOutput;
  }

  private processWet(modulator: number): number {
    if (this.framesUntilStep <= 0) {
      this.activeStep = (this.activeStep + 1) & 7;
      this.framesUntilStep = this.stepFrames;
      this.updateCarrierBank();
    }
    for (let band = 0; band < this.activeBands; band += 1) {
      this.bandCarriers[band] = this.oscillators[band]?.processSample() ?? 0;
    }
    const vocoded = this.vocoder.processWithCarrierBank(modulator, this.bandCarriers);
    const filtered = this.toneFilter.processSample(vocoded);
    this.frame += 1;
    this.framesUntilStep -= 1;
    return bounded(filtered, MAX_OUTPUT_MAGNITUDE);
  }

  processBlock(
    inputLeft: Float32Array,
    inputRight: Float32Array,
    outputLeft: Float32Array,
    outputRight: Float32Array,
    frames = Math.min(inputLeft.length, inputRight.length, outputLeft.length, outputRight.length),
  ): void {
    const count = Math.max(0, Math.min(Math.floor(frames), inputLeft.length, inputRight.length, outputLeft.length, outputRight.length));
    for (let index = 0; index < count; index += 1) {
      const left = inputLeft[index] ?? 0;
      const right = inputRight[index] ?? 0;
      const modulator = bounded((bounded(left, MAX_INPUT_MAGNITUDE) + bounded(right, MAX_INPUT_MAGNITUDE)) * 0.5, MAX_INPUT_MAGNITUDE);
      const wet = this.processWet(modulator);
      const boundedLeft = bounded(left, MAX_INPUT_MAGNITUDE);
      const boundedRight = bounded(right, MAX_INPUT_MAGNITUDE);
      outputLeft[index] = bounded((boundedLeft * (1 - this.mix)) + (wet * this.mix), MAX_OUTPUT_MAGNITUDE);
      outputRight[index] = bounded((boundedRight * (1 - this.mix)) + (wet * this.mix), MAX_OUTPUT_MAGNITUDE);
      this.currentOutput = (outputLeft[index]! + outputRight[index]!) * 0.5;
    }
  }

  reset(initialFrame = 0): void {
    BrowserOscBotCore.validateFrame(initialFrame);
    this.frame = initialFrame;
    this.activeStep = 0;
    this.framesUntilStep = this.currentStepFrames;
    this.currentOutput = 0;
    this.vocoder.reset();
    this.toneFilter.reset();
    for (const oscillator of this.oscillators) oscillator.reset();
    this.updateCarrierBank();
  }

  private updateCarrierBank(): void {
    const pattern = STEP_PATTERNS[this.patternIndex] ?? STEP_PATTERNS[0]!;
    const semitones = pattern[this.activeStep] ?? 0;
    const transpose = 2 ** (semitones / 12);
    for (let band = 0; band < this.activeBands; band += 1) {
      const center = this.vocoder.getBandCenterFrequencyHz(band);
      this.oscillators[band]?.set(center * transpose, this.waveform);
    }
  }

  private static computeStepFrames(sampleRate: number, tempoBpm: number): number {
    // One step is a sixteenth note: four equal steps per beat.
    return Math.max(1, Math.round((sampleRate * 60) / (tempoBpm * 4)));
  }

  private static validateBands(value: number): number {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_BANDS || value > MAX_BANDS) {
      throw new RangeError(`Browser OSC BOT bands must be an integer from ${MIN_BANDS} to ${MAX_BANDS}.`);
    }
    return value;
  }

  private static validateWaveform(value: number): BrowserOscBotWaveform {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 2) {
      throw new RangeError('Browser OSC BOT waveform must be 0 (saw), 1 (square), or 2 (triangle).');
    }
    return value as BrowserOscBotWaveform;
  }

  private static validatePattern(value: number): number {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value >= STEP_PATTERNS.length) {
      throw new RangeError(`Browser OSC BOT pattern must be an integer from 0 to ${STEP_PATTERNS.length - 1}.`);
    }
    return value;
  }

  private static validateTone(value: number, sampleRate: number): number {
    if (!Number.isFinite(value) || value < 100 || value > 16000 || value >= sampleRate * 0.49) {
      throw new RangeError('Browser OSC BOT tone cutoff must be from 100 to 16000 Hz and below 0.49 of sample rate.');
    }
    return value;
  }

  private static validateMix(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('Browser OSC BOT mix must be between 0 and 1.');
    }
    return value;
  }

  private static validateTempo(value: number): number {
    if (!Number.isFinite(value) || value < MIN_TEMPO_BPM || value > MAX_TEMPO_BPM) {
      throw new RangeError(`Browser OSC BOT tempo must be from ${MIN_TEMPO_BPM} to ${MAX_TEMPO_BPM} BPM.`);
    }
    return value;
  }

  private static validateFrame(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('Browser OSC BOT frame must be a non-negative safe integer.');
    }
  }
}
