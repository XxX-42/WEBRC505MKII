import { RbjBiquad, designRbjBiquad, type RbjBiquadCoefficients } from '../../dsp/RbjBiquad';

export interface EqualizerDspParameters {
  lowFrequencyHz?: number;
  lowGainDb?: number;
  mid1FrequencyHz?: number;
  mid1Q?: number;
  mid1GainDb?: number;
  mid2FrequencyHz?: number;
  mid2Q?: number;
  mid2GainDb?: number;
  highFrequencyHz?: number;
  highGainDb?: number;
}

const COEFFICIENTS_PER_SECTION = 5;
const SECTION_COUNT = 4;
const DEFAULT_RAMP_SECONDS = 0.02;

/**
 * Four-band clean-room EQ: low/high RBJ shelves and two peaking sections.
 * Coefficients are designed on control changes; sample processing only updates
 * fixed arrays/scalars and allocates no objects. No Roland topology is claimed.
 */
export class EqualizerDsp {
  readonly sampleRate: number;
  private readonly filtersLeft: readonly [RbjBiquad, RbjBiquad, RbjBiquad, RbjBiquad];
  private readonly filtersRight: readonly [RbjBiquad, RbjBiquad, RbjBiquad, RbjBiquad];
  private readonly currentCoefficients = new Float64Array(SECTION_COUNT * COEFFICIENTS_PER_SECTION);
  private readonly targetCoefficients = new Float64Array(SECTION_COUNT * COEFFICIENTS_PER_SECTION);
  private lowFrequencyHz = 100;
  private lowGainDb = 0;
  private mid1FrequencyHz = 500;
  private mid1Q = 1;
  private mid1GainDb = 0;
  private mid2FrequencyHz = 2500;
  private mid2Q = 1;
  private mid2GainDb = 0;
  private highFrequencyHz = 8000;
  private highGainDb = 0;
  private remainingRampFrames = 0;
  private wetLeft = 0;
  private wetRight = 0;

  constructor(sampleRate: number, parameters: EqualizerDspParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.filtersLeft = [new RbjBiquad(), new RbjBiquad(), new RbjBiquad(), new RbjBiquad()];
    this.filtersRight = [new RbjBiquad(), new RbjBiquad(), new RbjBiquad(), new RbjBiquad()];
    this.setParameters(parameters, 0);
  }

  get outputLeft(): number { return this.wetLeft; }
  get outputRight(): number { return this.wetRight; }

  setParameters(parameters: EqualizerDspParameters, rampFrames = Math.round(this.sampleRate * DEFAULT_RAMP_SECONDS)): void {
    const nyquist = this.sampleRate * 0.45;
    if (Number.isFinite(parameters.lowFrequencyHz)) this.lowFrequencyHz = clamp(parameters.lowFrequencyHz as number, 20, Math.min(500, nyquist));
    if (Number.isFinite(parameters.lowGainDb)) this.lowGainDb = clamp(parameters.lowGainDb as number, -15, 15);
    if (Number.isFinite(parameters.mid1FrequencyHz)) this.mid1FrequencyHz = clamp(parameters.mid1FrequencyHz as number, 80, Math.min(8000, nyquist));
    if (Number.isFinite(parameters.mid1Q)) this.mid1Q = clamp(parameters.mid1Q as number, 0.1, 12);
    if (Number.isFinite(parameters.mid1GainDb)) this.mid1GainDb = clamp(parameters.mid1GainDb as number, -15, 15);
    if (Number.isFinite(parameters.mid2FrequencyHz)) this.mid2FrequencyHz = clamp(parameters.mid2FrequencyHz as number, 80, Math.min(12000, nyquist));
    if (Number.isFinite(parameters.mid2Q)) this.mid2Q = clamp(parameters.mid2Q as number, 0.1, 12);
    if (Number.isFinite(parameters.mid2GainDb)) this.mid2GainDb = clamp(parameters.mid2GainDb as number, -15, 15);
    if (Number.isFinite(parameters.highFrequencyHz)) this.highFrequencyHz = clamp(parameters.highFrequencyHz as number, 1000, Math.min(20000, nyquist));
    if (Number.isFinite(parameters.highGainDb)) this.highGainDb = clamp(parameters.highGainDb as number, -15, 15);
    this.designTargets();

    const frames = Math.max(0, Math.floor(Number.isFinite(rampFrames) ? rampFrames : 0));
    this.remainingRampFrames = frames;
    if (frames === 0) {
      this.currentCoefficients.set(this.targetCoefficients);
      this.applyCoefficients();
    }
  }

  /** Mutates output state; safe for one stereo sample in an audio render loop. */
  process(inputLeft: number, inputRight: number): void {
    if (this.remainingRampFrames > 0) {
      const inverseRemaining = 1 / this.remainingRampFrames;
      for (let index = 0; index < this.currentCoefficients.length; index += 1) {
        const current = this.currentCoefficients[index] ?? 0;
        const target = this.targetCoefficients[index] ?? current;
        this.currentCoefficients[index] = current + (target - current) * inverseRemaining;
      }
      this.remainingRampFrames -= 1;
      if (this.remainingRampFrames === 0) this.currentCoefficients.set(this.targetCoefficients);
      this.applyCoefficients();
    }

    let left = inputLeft;
    let right = inputRight;
    for (let section = 0; section < SECTION_COUNT; section += 1) {
      left = this.filtersLeft[section]!.processSample(left);
      right = this.filtersRight[section]!.processSample(right);
    }
    this.wetLeft = left;
    this.wetRight = right;
  }

  reset(): void {
    for (let section = 0; section < SECTION_COUNT; section += 1) {
      this.filtersLeft[section]!.reset();
      this.filtersRight[section]!.reset();
    }
    this.remainingRampFrames = 0;
    this.currentCoefficients.set(this.targetCoefficients);
    this.applyCoefficients();
    this.wetLeft = 0;
    this.wetRight = 0;
  }

  private designTargets(): void {
    this.writeTarget(0, designRbjBiquad('low-shelf', this.sampleRate, this.lowFrequencyHz, Math.SQRT1_2, this.lowGainDb));
    this.writeTarget(1, designRbjBiquad('peaking', this.sampleRate, this.mid1FrequencyHz, this.mid1Q, this.mid1GainDb));
    this.writeTarget(2, designRbjBiquad('peaking', this.sampleRate, this.mid2FrequencyHz, this.mid2Q, this.mid2GainDb));
    this.writeTarget(3, designRbjBiquad('high-shelf', this.sampleRate, this.highFrequencyHz, Math.SQRT1_2, this.highGainDb));
  }

  private writeTarget(section: number, coefficients: RbjBiquadCoefficients): void {
    const offset = section * COEFFICIENTS_PER_SECTION;
    this.targetCoefficients[offset] = coefficients.b0;
    this.targetCoefficients[offset + 1] = coefficients.b1;
    this.targetCoefficients[offset + 2] = coefficients.b2;
    this.targetCoefficients[offset + 3] = coefficients.a1;
    this.targetCoefficients[offset + 4] = coefficients.a2;
  }

  private applyCoefficients(): void {
    for (let section = 0; section < SECTION_COUNT; section += 1) {
      const offset = section * COEFFICIENTS_PER_SECTION;
      const b0 = this.currentCoefficients[offset] ?? 1;
      const b1 = this.currentCoefficients[offset + 1] ?? 0;
      const b2 = this.currentCoefficients[offset + 2] ?? 0;
      const a1 = this.currentCoefficients[offset + 3] ?? 0;
      const a2 = this.currentCoefficients[offset + 4] ?? 0;
      this.filtersLeft[section]!.setCoefficientsValues(b0, b1, b2, a1, a2);
      this.filtersRight[section]!.setCoefficientsValues(b0, b1, b2, a1, a2);
    }
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
