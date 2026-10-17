/**
 * Ring-buffer delay with four-point (third-order) backward Lagrange
 * interpolation. The maximum delay and ring storage are fixed at construction
 * so processing does not allocate.
 */
export class LagrangeFractionalDelay {
  readonly maxDelaySamples: number;
  readonly capacity: number;

  private readonly buffer: Float32Array;
  private writeIndex = 0;
  private lastWrittenIndex = -1;

  constructor(maxDelaySamples: number) {
    if (!Number.isFinite(maxDelaySamples) || maxDelaySamples < 0) {
      throw new RangeError('maxDelaySamples must be a finite non-negative number');
    }
    this.maxDelaySamples = maxDelaySamples;
    this.capacity = Math.max(4, Math.ceil(maxDelaySamples) + 4);
    this.buffer = new Float32Array(this.capacity);
  }

  /** Writes an input sample and returns the delayed/interpolated result. */
  processSample(input: number, delaySamples: number): number {
    this.buffer[this.writeIndex] = Number.isFinite(input) ? input : 0;
    this.lastWrittenIndex = this.writeIndex;
    this.writeIndex += 1;
    if (this.writeIndex === this.capacity) this.writeIndex = 0;
    return this.readSample(delaySamples);
  }

  /** Reads relative to the most recently written sample. Returns silence before the first write. */
  readSample(delaySamples: number): number {
    if (this.lastWrittenIndex < 0) return 0;
    const delay = Number.isFinite(delaySamples)
      ? Math.max(0, Math.min(this.maxDelaySamples, delaySamples))
      : 0;
    const wholeDelay = Math.floor(delay);
    const fraction = delay - wholeDelay;
    const oneMinus = 1 - fraction;
    const coefficient0 = (oneMinus * (2 - fraction) * (3 - fraction)) / 6;
    const coefficient1 = (fraction * (2 - fraction) * (3 - fraction)) / 2;
    const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
    const coefficient3 = (fraction * oneMinus * (2 - fraction)) / 6;

    let index = this.lastWrittenIndex - wholeDelay;
    if (index < 0) index += this.capacity;
    const sample0 = this.buffer[index] ?? 0;
    index -= 1;
    if (index < 0) index += this.capacity;
    const sample1 = this.buffer[index] ?? 0;
    index -= 1;
    if (index < 0) index += this.capacity;
    const sample2 = this.buffer[index] ?? 0;
    index -= 1;
    if (index < 0) index += this.capacity;
    const sample3 = this.buffer[index] ?? 0;

    return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
  }

  clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.lastWrittenIndex = -1;
  }
}
