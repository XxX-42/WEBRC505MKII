import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';
import { validateVoiceControls, voiceAttackSeconds, voiceReleaseSeconds } from '../dsp/BrowserOfficialVoiceDsp';

export type BrowserVocoderCarrier = 0 | 1 | 2;

export interface BrowserVocoderParameters {
  /** Number of active ERB-spaced analysis/resynthesis bands, integer 8..24. */
  bands?: number;
  /** 0: input voice, 1: internal polyBLEP saw, 2: internal polyBLEP square. */
  carrier?: number;
}

export interface BrowserVocoderOfficialParameters { tone?: number; attack?: number; mod_sens?: number }
/** Shared voice shaping; formant is ELECTRIC's -50..50 spectral-envelope shift. */
export interface BrowserVocoderShapingParameters extends BrowserVocoderOfficialParameters { release?: number; formant?: number }
const SHAPING_LIMITS = { tone: [-50, 50], attack: [0, 100], mod_sens: [-50, 50], release: [0, 100], formant: [-50, 50] } as const;
const OFFICIAL_LIMITS = { tone: [-50, 50], attack: [0, 100], mod_sens: [-50, 50] } as const;

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_BANDS = 8;
const MAX_BANDS = 24;
const LOWEST_CENTER_HZ = 80;
const HIGHEST_CENTER_HZ = 10500;
const FILTER_Q = 1.15;
const ATTACK_SECONDS = 0.004;
const RELEASE_SECONDS = 0.060;
const INTERNAL_CARRIER_HZ = 110;
const MAX_INPUT_MAGNITUDE = 8;
const MAX_ENVELOPE = 8;
const MAX_OUTPUT_MAGNITUDE = 4;
const ERB_SCALE = 21.4;
const ERB_FACTOR = 0.00437;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function boundedSample(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_INPUT_MAGNITUDE, MAX_INPUT_MAGNITUDE) : 0;
}

function erb(number: number): number {
  return ERB_SCALE * Math.log10(1 + (ERB_FACTOR * number));
}

function inverseErb(value: number): number {
  return (10 ** (value / ERB_SCALE) - 1) / ERB_FACTOR;
}

/** PolyBLEP residual for a normalized phase and phase step. */
function polyBlep(phase: number, step: number): number {
  if (phase < step) {
    const t = phase / step;
    return (2 * t) - (t * t) - 1;
  }
  if (phase > 1 - step) {
    const t = (phase - 1) / step;
    return (t * t) + (2 * t) + 1;
  }
  return 0;
}

/**
 * Clean-room 16-band-default channel vocoder core. The same ERB-spaced TPT
 * analysis bank and bounded envelope followers are used by all carrier modes.
 * Internal carriers are fixed-pitch 110 Hz polyBLEP oscillators; voice mode
 * uses the input as both modulator and carrier. This is a functional vocoder,
 * not a Roland topology or sound-quality claim.
 *
 * `processWithCarrier` is the reusable entry point for a timestamped carrier
 * source (for example, a future MIDI oscillator). Call it once per aligned
 * sample pair; it advances the very same modulator filters and envelopes used
 * by `processSample`, then returns that sample's vocoded output.
 */
export class BrowserVocoderCore {
  readonly sampleRate: number;
  readonly algorithmicLatencySamples = 0;

  private readonly analysisFilters: TptStateVariableFilter[];
  private readonly carrierFilters: TptStateVariableFilter[];
  private readonly envelopes: Float64Array;
  private readonly centerFrequenciesHz: Float64Array;
  private attackCoefficient: number;
  private releaseCoefficient: number;
  private readonly oscillatorStep: number;
  private activeBands: number;
  private carrierMode: BrowserVocoderCarrier;
  private readonly bandGains = new Float64Array(MAX_BANDS).fill(1);
  private toneValue = 0;
  private formantValue = 0;
  private modulatorGain = 1;
  private officialActive = false;
  private phase = 0;
  private currentOutput = 0;

  constructor(sampleRate = 48000, parameters: BrowserVocoderParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;
    this.activeBands = BrowserVocoderCore.validateBands(parameters.bands ?? 16);
    this.carrierMode = BrowserVocoderCore.validateCarrier(parameters.carrier ?? 1);
    this.attackCoefficient = Math.exp(-1 / (ATTACK_SECONDS * this.sampleRate));
    this.releaseCoefficient = Math.exp(-1 / (RELEASE_SECONDS * this.sampleRate));
    this.oscillatorStep = INTERNAL_CARRIER_HZ / this.sampleRate;
    this.envelopes = new Float64Array(MAX_BANDS);
    this.centerFrequenciesHz = new Float64Array(MAX_BANDS);
    this.analysisFilters = new Array<TptStateVariableFilter>(MAX_BANDS);
    this.carrierFilters = new Array<TptStateVariableFilter>(MAX_BANDS);

    const low = Math.min(LOWEST_CENTER_HZ, this.sampleRate * 0.01);
    for (let band = 0; band < MAX_BANDS; band += 1) {
      this.analysisFilters[band] = new TptStateVariableFilter(this.sampleRate, low, FILTER_Q);
      this.carrierFilters[band] = new TptStateVariableFilter(this.sampleRate, low, FILTER_Q);
    }
    this.configureFilterbank(this.activeBands);
  }

  get outputLeft(): number { return this.currentOutput; }
  get outputRight(): number { return this.currentOutput; }
  get bands(): number { return this.activeBands; }
  get carrier(): BrowserVocoderCarrier { return this.carrierMode; }

  /** Center frequency of an active ERB analysis/resynthesis band. */
  getBandCenterFrequencyHz(band: number): number {
    if (!Number.isInteger(band) || band < 0 || band >= this.activeBands) return 0;
    return this.centerFrequenciesHz[band] ?? 0;
  }

  /** Current bounded envelope for diagnostics/tests and future MIDI routing. */
  getEnvelopeLevel(band: number): number {
    if (!Number.isInteger(band) || band < 0 || band >= this.activeBands) return 0;
    return this.envelopes[band] ?? 0;
  }

  setParameters(parameters: BrowserVocoderParameters): void {
    const keys = Object.keys(parameters);
    for (const key of keys) {
      if (key !== 'bands' && key !== 'carrier') {
        throw new RangeError(`Browser VOCODER does not support the ${key} parameter.`);
      }
    }

    const nextBands = parameters.bands === undefined
      ? this.activeBands
      : BrowserVocoderCore.validateBands(parameters.bands);
    const nextCarrier = parameters.carrier === undefined
      ? this.carrierMode
      : BrowserVocoderCore.validateCarrier(parameters.carrier);

    if (nextBands !== this.activeBands) {
      this.activeBands = nextBands;
      this.envelopes.fill(0);
      for (let band = 0; band < MAX_BANDS; band += 1) {
        this.analysisFilters[band]?.reset();
        this.carrierFilters[band]?.reset();
      }
      this.configureFilterbank(nextBands);
    }
    this.carrierMode = nextCarrier;
  }

  /** Only real local controls; physical CARRIER routing and CARRIER THRU remain unsupported. */
  setOfficialParameters(parameters: BrowserVocoderOfficialParameters): void {
    validateVoiceControls(parameters, OFFICIAL_LIMITS, 'VOCODER');
    if (!Object.values(parameters).some(value => value !== undefined)) return;
    if (!this.officialActive) {
      this.setVoiceShapingParameters({ tone: 0, attack: 50, mod_sens: 0 });
      this.officialActive = true;
    }
    this.setVoiceShapingParameters(parameters);
  }

  /** Reusable analysis/resynthesis shaping for ELECTRIC and the OSC effects. */
  setVoiceShapingParameters(parameters: BrowserVocoderShapingParameters): void {
    validateVoiceControls(parameters, SHAPING_LIMITS, 'Voice shaping');
    if (parameters.attack !== undefined) this.attackCoefficient = Math.exp(-1 / (voiceAttackSeconds(parameters.attack) * this.sampleRate));
    if (parameters.release !== undefined) this.releaseCoefficient = Math.exp(-1 / (voiceReleaseSeconds(parameters.release) * this.sampleRate));
    if (parameters.mod_sens !== undefined) this.modulatorGain = 10 ** (parameters.mod_sens * 0.36 / 20);
    if (parameters.tone !== undefined) this.toneValue = parameters.tone;
    if (parameters.formant !== undefined) this.formantValue = parameters.formant;
    if (parameters.tone !== undefined || parameters.formant !== undefined) this.configureFilterbank(this.activeBands);
  }

  getCarrierBandCenterFrequencyHz(band: number): number {
    const center = this.getBandCenterFrequencyHz(band);
    return center > 0 ? Math.min(this.sampleRate * 0.45, center * 2 ** (this.formantValue / 50)) : 0;
  }

  /** Voice-input carrier or internal anti-aliased saw/square carrier mode. */
  processSample(modulatorLeft: number, modulatorRight: number): void {
    const modulator = boundedSample((boundedSample(modulatorLeft) + boundedSample(modulatorRight)) * 0.5);
    let carrier = modulator;
    if (this.carrierMode !== 0) {
      carrier = this.carrierMode === 1 ? this.nextSaw() : this.nextSquare();
    }
    this.currentOutput = this.processWithCarrier(modulator, carrier);
  }

  /**
   * Advance the persistent analysis/envelope bank with a modulator sample and
   * resynthesize it using an externally supplied, sample-aligned carrier.
   */
  processWithCarrier(modulatorSample: number, carrierSample: number): number {
    const modulator = boundedSample(modulatorSample);
    const carrier = boundedSample(carrierSample);
    return this.processWithCarrierInputs(modulator, carrier, null);
  }

  /**
   * Advance the same analysis/envelope filterbank using a distinct carrier
   * sample for each band. This is the shared carrier-bank path used by OSC BOT
   * and other oscillator-bank reconstructions; callers provide a preallocated
   * array and no storage is created on the render path.
   */
  processWithCarrierBank(modulatorSample: number, bandCarriers: ArrayLike<number>): number {
    if (bandCarriers === null || bandCarriers === undefined || bandCarriers.length < this.activeBands) {
      throw new RangeError(`Browser VOCODER carrier bank must contain at least ${this.activeBands} samples.`);
    }
    return this.processWithCarrierInputs(boundedSample(modulatorSample), 0, bandCarriers);
  }

  private processWithCarrierInputs(
    modulator: number,
    scalarCarrier: number,
    bandCarriers: ArrayLike<number> | null,
  ): number {
    let sum = 0;
    for (let band = 0; band < this.activeBands; band += 1) {
      const analysis = this.analysisFilters[band];
      const carrierFilter = this.carrierFilters[band];
      if (!analysis || !carrierFilter) continue;

      analysis.processSample(boundedSample(modulator * this.modulatorGain));
      const carrier = bandCarriers === null
        ? scalarCarrier
        : boundedSample(bandCarriers[band] ?? 0);
      carrierFilter.processSample(carrier);
      const target = clamp(Math.abs(analysis.bandpass), 0, MAX_ENVELOPE);
      const previous = this.envelopes[band] ?? 0;
      const coefficient = target > previous ? this.attackCoefficient : this.releaseCoefficient;
      const envelope = clamp((coefficient * previous) + ((1 - coefficient) * target), 0, MAX_ENVELOPE);
      this.envelopes[band] = envelope;
      sum += envelope * carrierFilter.bandpass * this.bandGains[band]!;
    }

    // Power normalization prevents a band-count change from trivially scaling
    // output; authored gain keeps practical levels usable without a limiter.
    const normalized = (sum * 4) / Math.sqrt(this.activeBands);
    this.currentOutput = Number.isFinite(normalized)
      ? clamp(normalized, -MAX_OUTPUT_MAGNITUDE, MAX_OUTPUT_MAGNITUDE)
      : 0;
    return this.currentOutput;
  }

  reset(): void {
    this.envelopes.fill(0);
    for (let band = 0; band < MAX_BANDS; band += 1) {
      this.analysisFilters[band]?.reset();
      this.carrierFilters[band]?.reset();
    }
    this.phase = 0;
    this.currentOutput = 0;
  }

  private nextSaw(): number {
    const sample = (2 * this.phase) - 1 - polyBlep(this.phase, this.oscillatorStep);
    this.advanceOscillator();
    return sample;
  }

  private nextSquare(): number {
    const halfCyclePhase = this.phase < 0.5 ? this.phase + 0.5 : this.phase - 0.5;
    const sample = (this.phase < 0.5 ? 1 : -1)
      + polyBlep(this.phase, this.oscillatorStep)
      - polyBlep(halfCyclePhase, this.oscillatorStep);
    this.advanceOscillator();
    return sample;
  }

  private advanceOscillator(): void {
    this.phase += this.oscillatorStep;
    if (this.phase >= 1) this.phase -= 1;
  }

  private configureFilterbank(bands: number): void {
    const low = Math.min(LOWEST_CENTER_HZ, this.sampleRate * 0.01);
    const high = Math.max(low * 1.5, Math.min(HIGHEST_CENTER_HZ, this.sampleRate * 0.44));
    const lowErb = erb(low);
    const highErb = erb(high);
    for (let band = 0; band < bands; band += 1) {
      const position = band / (bands - 1);
      const centerHz = inverseErb(lowErb + ((highErb - lowErb) * position));
      this.centerFrequenciesHz[band] = centerHz;
      this.analysisFilters[band]?.setParameters(centerHz, FILTER_Q);
      this.carrierFilters[band]?.setParameters(Math.min(this.sampleRate * 0.45, centerHz * 2 ** (this.formantValue / 50)), FILTER_Q);
      const tiltDb = clamp((this.toneValue / 50) * 6 * Math.log2(centerHz / 1000), -18, 18);
      this.bandGains[band] = 10 ** (tiltDb / 20);
    }
  }

  private static validateBands(value: number): number {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_BANDS || value > MAX_BANDS) {
      throw new RangeError(`Browser VOCODER bands must be an integer from ${MIN_BANDS} to ${MAX_BANDS}.`);
    }
    return value;
  }

  private static validateCarrier(value: number): BrowserVocoderCarrier {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 2) {
      throw new RangeError('Browser VOCODER carrier must be 0 (voice input), 1 (saw), or 2 (square).');
    }
    return value as BrowserVocoderCarrier;
  }
}
