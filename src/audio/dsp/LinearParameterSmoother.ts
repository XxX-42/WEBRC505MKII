/**
 * A sample-count based linear ramp for a scalar DSP parameter.
 *
 * `setTarget` changes the target without allocating. Call `next` once per
 * sample to advance the ramp. A zero (or omitted) ramp is an immediate change.
 */
export class LinearParameterSmoother {
  private current: number;
  private target: number;
  private step = 0;
  private remaining = 0;

  constructor(initialValue = 0) {
    const value = Number.isFinite(initialValue) ? initialValue : 0;
    this.current = value;
    this.target = value;
  }

  get currentValue(): number {
    return this.current;
  }

  get targetValue(): number {
    return this.target;
  }

  get remainingFrames(): number {
    return this.remaining;
  }

  /** Returns false and leaves the current ramp untouched for invalid values. */
  setTarget(value: number, rampFrames = 0): boolean {
    if (!Number.isFinite(value) || !Number.isFinite(rampFrames)) return false;

    this.target = value;
    const frames = Math.max(0, Math.floor(rampFrames));
    if (frames === 0 || value === this.current) {
      this.current = value;
      this.step = 0;
      this.remaining = 0;
      return true;
    }

    this.remaining = frames;
    this.step = (value - this.current) / frames;
    return true;
  }

  /** Returns the current sample value and advances the ramp by one frame. */
  next(): number {
    if (this.remaining > 0) {
      this.current += this.step;
      this.remaining -= 1;
      if (this.remaining === 0) {
        // Avoid accumulated floating-point error at the end of a long ramp.
        this.current = this.target;
        this.step = 0;
      }
    }
    return this.current;
  }

  reset(value = this.target): void {
    const safeValue = Number.isFinite(value) ? value : 0;
    this.current = safeValue;
    this.target = safeValue;
    this.step = 0;
    this.remaining = 0;
  }
}
