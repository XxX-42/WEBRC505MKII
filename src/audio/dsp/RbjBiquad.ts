export type RbjBiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'low-shelf' | 'high-shelf';

/** Normalized RBJ coefficients: a0 is already divided out. */
export interface RbjBiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Computes normalized coefficients using Robert Bristow-Johnson's cookbook
 * equations. This is a control-rate helper; coefficient object allocation is
 * deliberately kept out of the sample processing path.
 */
export function designRbjBiquad(
  type: RbjBiquadType,
  sampleRate: number,
  frequencyHz: number,
  q = Math.SQRT1_2,
  gainDb = 0,
): RbjBiquadCoefficients {
  const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const safeFrequency = Number.isFinite(frequencyHz)
    ? Math.max(0, Math.min(safeSampleRate * 0.499, frequencyHz))
    : 1000;
  const safeQ = Number.isFinite(q) && q > 0 ? Math.min(1000, q) : Math.SQRT1_2;
  const safeGainDb = Number.isFinite(gainDb) ? Math.max(-120, Math.min(120, gainDb)) : 0;

  const omega = (2 * Math.PI * safeFrequency) / safeSampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = sine / (2 * safeQ);
  const a0 = 1 + alpha;
  const inverseA0 = 1 / a0;

  let b0: number;
  let b1: number;
  let b2: number;
  let a1: number;
  let a2: number;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cosine) * 0.5;
      b1 = 1 - cosine;
      b2 = (1 - cosine) * 0.5;
      a1 = -2 * cosine;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cosine) * 0.5;
      b1 = -(1 + cosine);
      b2 = (1 + cosine) * 0.5;
      a1 = -2 * cosine;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a1 = -2 * cosine;
      a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cosine;
      b2 = 1;
      a1 = -2 * cosine;
      a2 = 1 - alpha;
      break;
    case 'peaking': {
      const amplitude = 10 ** (safeGainDb / 40);
      const peakA0 = 1 + alpha / amplitude;
      const inversePeakA0 = 1 / peakA0;
      return {
        b0: (1 + (alpha * amplitude)) * inversePeakA0,
        b1: (-2 * cosine) * inversePeakA0,
        b2: (1 - (alpha * amplitude)) * inversePeakA0,
        a1: (-2 * cosine) * inversePeakA0,
        a2: (1 - (alpha / amplitude)) * inversePeakA0,
      };
    }
    case 'low-shelf':
    case 'high-shelf': {
      const amplitude = 10 ** (safeGainDb / 40);
      // RBJ cookbook shelf with slope S=1.0; safe for low/high gains including 0 dB.
      const shelfAlpha = sine * Math.SQRT1_2;
      const beta = 2 * Math.sqrt(amplitude) * shelfAlpha;
      const plus = amplitude + 1;
      const minus = amplitude - 1;
      if (type === 'low-shelf') {
        const shelfA0 = plus + minus * cosine + beta;
        const inverseShelfA0 = 1 / shelfA0;
        return {
          b0: amplitude * (plus - minus * cosine + beta) * inverseShelfA0,
          b1: 2 * amplitude * (minus - plus * cosine) * inverseShelfA0,
          b2: amplitude * (plus - minus * cosine - beta) * inverseShelfA0,
          a1: -2 * (minus + plus * cosine) * inverseShelfA0,
          a2: (plus + minus * cosine - beta) * inverseShelfA0,
        };
      }
      const shelfA0 = plus - minus * cosine + beta;
      const inverseShelfA0 = 1 / shelfA0;
      return {
        b0: amplitude * (plus + minus * cosine + beta) * inverseShelfA0,
        b1: -2 * amplitude * (minus + plus * cosine) * inverseShelfA0,
        b2: amplitude * (plus + minus * cosine - beta) * inverseShelfA0,
        a1: 2 * (minus - plus * cosine) * inverseShelfA0,
        a2: (plus - minus * cosine - beta) * inverseShelfA0,
      };
    }
  }

  return {
    b0: b0 * inverseA0,
    b1: b1 * inverseA0,
    b2: b2 * inverseA0,
    a1: a1 * inverseA0,
    a2: a2 * inverseA0,
  };
}

/** Direct Form II Transposed biquad with no allocation in processSample. */
export class RbjBiquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(coefficients?: RbjBiquadCoefficients) {
    if (coefficients) this.setCoefficients(coefficients);
  }

  setCoefficients(coefficients: RbjBiquadCoefficients): boolean {
    if (
      !Number.isFinite(coefficients.b0) ||
      !Number.isFinite(coefficients.b1) ||
      !Number.isFinite(coefficients.b2) ||
      !Number.isFinite(coefficients.a1) ||
      !Number.isFinite(coefficients.a2)
    ) {
      return false;
    }
    return this.setCoefficientsValues(coefficients.b0, coefficients.b1, coefficients.b2, coefficients.a1, coefficients.a2);
  }

  /** Update normalized coefficients without allocating a coefficient object. */
  setCoefficientsValues(b0: number, b1: number, b2: number, a1: number, a2: number): boolean {
    if (!Number.isFinite(b0) || !Number.isFinite(b1) || !Number.isFinite(b2) || !Number.isFinite(a1) || !Number.isFinite(a2)) {
      return false;
    }
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    return true;
  }

  setRbjParameters(
    type: RbjBiquadType,
    sampleRate: number,
    frequencyHz: number,
    q = Math.SQRT1_2,
    gainDb = 0,
  ): void {
    this.setCoefficients(designRbjBiquad(type, sampleRate, frequencyHz, q, gainDb));
  }

  processSample(input: number): number {
    const output = this.b0 * input + this.z1;
    this.z1 = this.b1 * input - this.a1 * output + this.z2;
    this.z2 = this.b2 * input - this.a2 * output;
    return output;
  }

  processBuffer(input: Float32Array, output: Float32Array, length = Math.min(input.length, output.length)): void {
    const count = Math.max(0, Math.min(Math.floor(length), input.length, output.length));
    for (let index = 0; index < count; index += 1) {
      output[index] = this.processSample(input[index] ?? 0);
    }
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}
