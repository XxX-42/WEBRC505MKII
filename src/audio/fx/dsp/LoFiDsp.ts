import { DeterministicPrng } from '../../dsp/DeterministicPrng';
import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

export interface LoFiDspParameters {
  bitDepth?: number;
  sampleRateHz?: number;
  filterHz?: number;
}

const TWO_PI = 2 * Math.PI;
const LEFT_SEED = 0x9e3779b9;
const RIGHT_SEED = 0xd1b54a35;

/** Clean-room sample-rate reduction, TPDF-dithered quantization and post-LPF. */
export class LoFiDsp {
  readonly sampleRate: number;
  private readonly bitDepth: LinearParameterSmoother;
  private readonly reducedRateHz: LinearParameterSmoother;
  private readonly filterHz: LinearParameterSmoother;
  private readonly randomLeft: DeterministicPrng;
  private readonly randomRight: DeterministicPrng;
  private holdPhase = 0;
  private heldLeft = 0;
  private heldRight = 0;
  private lowpassLeft = 0;
  private lowpassRight = 0;
  private lowpassAlpha = 1;
  private framesSinceCoefficientUpdate = 0;
  private hasHeldSample = false;
  private outputLeft = 0;
  private outputRight = 0;

  constructor(sampleRate: number, parameters: LoFiDspParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.bitDepth = new LinearParameterSmoother(clamp(parameters.bitDepth ?? 12, 4, 24));
    this.reducedRateHz = new LinearParameterSmoother(clamp(parameters.sampleRateHz ?? 12000, 500, this.sampleRate));
    this.filterHz = new LinearParameterSmoother(clamp(parameters.filterHz ?? 12000, 20, 20000));
    this.randomLeft = new DeterministicPrng(LEFT_SEED);
    this.randomRight = new DeterministicPrng(RIGHT_SEED);
    this.updateLowpass(this.filterHz.currentValue);
  }

  setParameters(parameters: LoFiDspParameters, rampFrames = Math.round(this.sampleRate * 0.02)): void {
    const ramp = Math.max(0, Math.floor(rampFrames));
    if (Number.isFinite(parameters.bitDepth)) this.bitDepth.setTarget(clamp(parameters.bitDepth as number, 4, 24), ramp);
    if (Number.isFinite(parameters.sampleRateHz)) {
      this.reducedRateHz.setTarget(clamp(parameters.sampleRateHz as number, 500, this.sampleRate), ramp);
    }
    if (Number.isFinite(parameters.filterHz)) this.filterHz.setTarget(clamp(parameters.filterHz as number, 20, Math.min(20000, this.sampleRate * 0.45)), ramp);
  }

  get wetLeft(): number { return this.outputLeft; }
  get wetRight(): number { return this.outputRight; }

  process(inputLeft: number, inputRight: number): void {
    const bits = Math.round(this.bitDepth.next());
    const reducedRate = clamp(this.reducedRateHz.next(), 500, this.sampleRate);
    const cutoff = clamp(this.filterHz.next(), 20, this.sampleRate * 0.45);
    if (this.framesSinceCoefficientUpdate === 0) this.updateLowpass(cutoff);
    this.framesSinceCoefficientUpdate += 1;
    if (this.framesSinceCoefficientUpdate >= 16) this.framesSinceCoefficientUpdate = 0;

    let capture = !this.hasHeldSample;
    if (!capture) {
      this.holdPhase += reducedRate / this.sampleRate;
      if (this.holdPhase >= 1) {
        this.holdPhase -= Math.floor(this.holdPhase);
        capture = true;
      }
    }
    if (capture) {
      this.heldLeft = this.quantize(inputLeft, bits, this.randomLeft);
      this.heldRight = this.quantize(inputRight, bits, this.randomRight);
      this.hasHeldSample = true;
    }

    this.lowpassLeft += this.lowpassAlpha * (this.heldLeft - this.lowpassLeft);
    this.lowpassRight += this.lowpassAlpha * (this.heldRight - this.lowpassRight);
    this.outputLeft = this.lowpassLeft;
    this.outputRight = this.lowpassRight;
  }

  reset(): void {
    this.holdPhase = 0;
    this.heldLeft = 0;
    this.heldRight = 0;
    this.lowpassLeft = 0;
    this.lowpassRight = 0;
    this.framesSinceCoefficientUpdate = 0;
    this.hasHeldSample = false;
    this.outputLeft = 0;
    this.outputRight = 0;
    this.randomLeft.setSeed(LEFT_SEED);
    this.randomRight.setSeed(RIGHT_SEED);
    this.updateLowpass(this.filterHz.currentValue);
  }

  private quantize(input: number, bits: number, random: DeterministicPrng): number {
    const scale = 2 ** (bits - 1);
    const dither = random.nextFloat() - random.nextFloat();
    const scaled = clamp(input, -1, 1) * scale + dither;
    const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
    return clamp(rounded / scale, -1, 1);
  }

  private updateLowpass(cutoffHz: number): void {
    const cutoff = clamp(cutoffHz, 20, this.sampleRate * 0.45);
    this.lowpassAlpha = 1 - Math.exp(-TWO_PI * cutoff / this.sampleRate);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
