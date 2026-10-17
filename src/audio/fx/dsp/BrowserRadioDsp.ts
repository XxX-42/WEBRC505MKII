import { DeterministicPrng } from '../../dsp/DeterministicPrng';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';

/** Provisional, clean-room controls for the RADIO effect. */
export interface BrowserRadioParameters {
  /** 0=AM narrow, 1=AM wide, 2=FM; authored presets, not hardware specifications. */
  band?: number;
  /** Saturation drive, 0..100 percent. */
  drive?: number;
  /** Colored-noise and dropout intensity, 0..100 percent. */
  noise?: number;
}

const TWO_PI = Math.PI * 2;
const PARAM_SMOOTH_SECONDS = 0.015;
const LEFT_SEED = 0x52414431;
const RIGHT_SEED = 0x52414432;
const BAND_HP = [420, 180, 45] as const;
const BAND_LP = [3200, 5200, 14500] as const;
const NOISE_ALPHA_HZ = 1900;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function logCosh(value: number): number {
  const absolute = Math.abs(value);
  return absolute + Math.log1p(Math.exp(-2 * absolute)) - Math.LN2;
}

function adaaTanh(current: number, previous: number): number {
  const difference = current - previous;
  if (Math.abs(difference) < 1e-8) return Math.tanh((current + previous) * 0.5);
  return (logCosh(current) - logCosh(previous)) / difference;
}

/**
 * Stereo clean-room radio coloration: TPT high/low-pass band limits, 2x
 * midpoint ADAA soft saturation, deterministic low-passed noise and short
 * deterministic dropouts. All state and RNGs are constructed up front.
 */
export class BrowserRadioDsp {
  readonly sampleRate: number;
  readonly highpassLeft: TptStateVariableFilter;
  readonly highpassRight: TptStateVariableFilter;
  readonly lowpassLeft: TptStateVariableFilter;
  readonly lowpassRight: TptStateVariableFilter;
  dropoutEvents = 0;
  private readonly randomLeft = new DeterministicPrng(LEFT_SEED);
  private readonly randomRight = new DeterministicPrng(RIGHT_SEED);
  private readonly previousInput = new Float64Array(2);
  private readonly previousDriven = new Float64Array(2);
  private readonly noiseState = new Float64Array(2);
  private readonly dropoutRemaining = new Int32Array(2);
  private readonly dropoutEnvelope = new Float64Array(2);
  private band: 0 | 1 | 2;
  private targetBand: 0 | 1 | 2;
  private drive = 1;
  private targetDrive = 1;
  private noise = 0.08;
  private targetNoise = 0.08;
  private readonly smoothingAlpha: number;
  private readonly noiseAlpha: number;
  private outputLeft = 0;
  private outputRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserRadioParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) ? clamp(sampleRate, 8000, 192000) : 48000;
    this.band = this.targetBand = this.normalizeBand(parameters.band ?? 0);
    this.drive = this.targetDrive = 1 + 11 * clamp(parameters.drive ?? 35, 0, 100) / 100;
    this.noise = this.targetNoise = clamp(parameters.noise ?? 8, 0, 100) / 100;
    this.smoothingAlpha = 1 - Math.exp(-1 / (PARAM_SMOOTH_SECONDS * this.sampleRate));
    this.noiseAlpha = 1 - Math.exp(-TWO_PI * NOISE_ALPHA_HZ / this.sampleRate);
    this.dropoutEnvelope.fill(1);
    this.highpassLeft = new TptStateVariableFilter(this.sampleRate);
    this.highpassRight = new TptStateVariableFilter(this.sampleRate);
    this.lowpassLeft = new TptStateVariableFilter(this.sampleRate);
    this.lowpassRight = new TptStateVariableFilter(this.sampleRate);
    this.updateFilterCoefficients();
  }

  get wetLeft(): number { return this.outputLeft; }
  get wetRight(): number { return this.outputRight; }

  setParameters(parameters: BrowserRadioParameters): void {
    if (Number.isFinite(parameters.band)) this.targetBand = this.normalizeBand(parameters.band as number);
    if (Number.isFinite(parameters.drive)) this.targetDrive = 1 + 11 * clamp(parameters.drive as number, 0, 100) / 100;
    if (Number.isFinite(parameters.noise)) this.targetNoise = clamp(parameters.noise as number, 0, 100) / 100;
  }

  processSample(left: number, right: number): void {
    this.drive += this.smoothingAlpha * (this.targetDrive - this.drive);
    this.noise += this.smoothingAlpha * (this.targetNoise - this.noise);
    if (this.band !== this.targetBand) {
      this.band = this.targetBand;
      this.updateFilterCoefficients();
    }
    this.outputLeft = this.processChannel(left, 0);
    this.outputRight = this.processChannel(right, 1);
  }

  reset(): void {
    this.highpassLeft.reset();
    this.highpassRight.reset();
    this.lowpassLeft.reset();
    this.lowpassRight.reset();
    this.previousInput.fill(0);
    this.previousDriven.fill(0);
    this.noiseState.fill(0);
    this.dropoutRemaining.fill(0);
    this.dropoutEnvelope.fill(1);
    this.randomLeft.setSeed(LEFT_SEED);
    this.randomRight.setSeed(RIGHT_SEED);
    this.drive = this.targetDrive;
    this.noise = this.targetNoise;
    this.band = this.targetBand;
    this.updateFilterCoefficients();
    this.outputLeft = 0;
    this.outputRight = 0;
    this.dropoutEvents = 0;
  }

  private normalizeBand(value: number): 0 | 1 | 2 {
    return Math.round(clamp(value, 0, 2)) as 0 | 1 | 2;
  }

  private updateFilterCoefficients(): void {
    const highpass = Math.min(BAND_HP[this.band] ?? 420, this.sampleRate * 0.42);
    const lowpass = Math.min(BAND_LP[this.band] ?? 3200, this.sampleRate * 0.46);
    this.highpassLeft.setParameters(highpass, Math.SQRT1_2);
    this.highpassRight.setParameters(highpass, Math.SQRT1_2);
    this.lowpassLeft.setParameters(lowpass, Math.SQRT1_2);
    this.lowpassRight.setParameters(lowpass, Math.SQRT1_2);
  }

  private processChannel(input: number, channel: 0 | 1): number {
    const highpass = channel === 0 ? this.highpassLeft : this.highpassRight;
    const lowpass = channel === 0 ? this.lowpassLeft : this.lowpassRight;
    const random = channel === 0 ? this.randomLeft : this.randomRight;
    highpass.processSample(input);
    lowpass.processSample(highpass.highpass);
    const bandLimited = lowpass.lowpass;

    // Linear midpoint interpolation yields two samples per input sample. The
    // divided-difference tanh antiderivative is evaluated at both steps.
    const midpointDriven = ((this.previousInput[channel] ?? 0) + bandLimited) * 0.5 * this.drive;
    const currentDriven = bandLimited * this.drive;
    const first = adaaTanh(midpointDriven, this.previousDriven[channel] ?? 0);
    const second = adaaTanh(currentDriven, midpointDriven);
    this.previousInput[channel] = bandLimited;
    this.previousDriven[channel] = currentDriven;
    const saturated = (first + second) * 0.5;

    const dropoutRemaining = this.dropoutRemaining[channel] ?? 0;
    if (dropoutRemaining > 0) {
      this.dropoutRemaining[channel] = dropoutRemaining - 1;
    } else if (this.noise > 0 && random.nextFloat() < this.noise * 0.000035) {
      this.dropoutRemaining[channel] = Math.round(this.sampleRate * (0.008 + random.nextFloat() * 0.017));
      this.dropoutEvents += 1;
    }
    const dropoutTarget = (this.dropoutRemaining[channel] ?? 0) > 0 ? 0 : 1;
    const dropoutAlpha = dropoutTarget < (this.dropoutEnvelope[channel] ?? 1)
      ? 1 - Math.exp(-1 / (0.0005 * this.sampleRate))
      : 1 - Math.exp(-1 / (0.004 * this.sampleRate));
    let envelope = (this.dropoutEnvelope[channel] ?? 1) + dropoutAlpha * (dropoutTarget - (this.dropoutEnvelope[channel] ?? 1));
    if (envelope < 1e-12) envelope = 0;
    this.dropoutEnvelope[channel] = envelope;

    const coloredNoise = (this.noiseState[channel] ?? 0)
      + this.noiseAlpha * (random.nextBipolar() - (this.noiseState[channel] ?? 0));
    this.noiseState[channel] = coloredNoise;
    // Provisional clean-room intensity: max 0.6% peak-ish hiss, with a
    // conservative stochastic dropout rate. No device-specific noise claim.
    const noiseGain = this.noise * 0.006;
    return saturated * envelope + coloredNoise * noiseGain;
  }
}
