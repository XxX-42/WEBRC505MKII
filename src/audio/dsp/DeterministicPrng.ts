/** Small deterministic xorshift32 generator suitable for repeatable DSP tests. */
export class DeterministicPrng {
  private state: number;

  constructor(seed = 0x6d2b79f5) {
    this.state = this.normalizeSeed(seed);
  }

  setSeed(seed: number): void {
    this.state = this.normalizeSeed(seed);
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  /** Uniform value in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Uniform value in [-1, 1). */
  nextBipolar(): number {
    return this.nextFloat() * 2 - 1;
  }

  fillFloat32(output: Float32Array, bipolar = false): void {
    if (bipolar) {
      for (let index = 0; index < output.length; index += 1) output[index] = this.nextBipolar();
    } else {
      for (let index = 0; index < output.length; index += 1) output[index] = this.nextFloat();
    }
  }

  private normalizeSeed(seed: number): number {
    const value = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
    return value === 0 ? 0x6d2b79f5 : value;
  }
}
