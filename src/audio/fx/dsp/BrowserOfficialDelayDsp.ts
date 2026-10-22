import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

export type BrowserOfficialDelayAlgorithm = 'delay' | 'panning-delay' | 'reverse-delay' | 'mod-delay';

/** Native manual values, not the legacy delay's feedback-percent controls. */
export interface BrowserOfficialDelayParameters {
  /** Positive milliseconds (1..2000), or negative quarter-note beat counts (up to 2). */
  time?: number;
  /** Number of repeated echoes, 1..16. There is deliberately no recursive feedback. */
  feedback?: number;
  modDepth?: number;
  bpm?: number;
}

const MAX_REPEATS = 16;
const MAX_NUMERIC_TIME_SECONDS = 2;
const MAX_SYNC_BEATS = 2;
const MIN_BPM = 40;
const MAX_BPM = 300;
const MAX_SYNC_TIME_SECONDS = MAX_SYNC_BEATS * 60 / MIN_BPM;
const REPEAT_DECAY = 0.65;
const MAX_MAGNITUDE = 8;
const MOD_RATE_HZ = 0.37;
const TWO_PI = Math.PI * 2;
const OFF = -1000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function bounded(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_MAGNITUDE, MAX_MAGNITUDE) : 0;
}

/**
 * Clean-room implementations of the manual's four counted-repeat delays.
 *
 * The manual specifies FEEDBACK as 1..16 repeats, not a feedback gain. All
 * echoes therefore read the input-only ring through finitely many feedforward
 * taps. Their authored amplitude law is 0.65 ** (repeat - 1); this and the
 * modulation/crossfade laws are not claims about Roland's proprietary DSP.
 *
 * Reverse plays the previous completed segment, with one segment of deliberate
 * buffering latency. Each repeat crossfades through silence over a short edge
 * window, rather than borrowing another segment (which could create repeat
 * N+1). Source samples at the edges retain a nonzero window weight. Changes to
 * reverse TIME/BPM apply at capture boundaries; older captured segments are
 * linearly resampled into the new duration, preserving their complete contents.
 *
 * The native numeric TIME ceiling is two seconds; synchronized TIME is not
 * constrained by that numeric range. The host's supported 40..300 BPM interval
 * permits a half-note (two-quarter-note) delay of up to three seconds.
 *
 * Storage starts at 34 seconds per stereo source ring (about 13 MB at 48 kHz)
 * and grows, only in setParameters, when a slower synchronized time needs more
 * history. The three-second maximum needs 51 seconds (about 19.6 MB at 48 kHz).
 * setParameters may allocate on the worklet message thread: this path is NOT
 * a strict-real-time allocation-free configuration implementation.
 * Growing preserves chronological source history and reverse-segment indices.
 * No output feeds the ring, no process call allocates, and timing uses only
 * sample clocks. Storage never shrinks during the instance's lifetime.
 */
export class BrowserOfficialDelayDsp {
  readonly algorithm: BrowserOfficialDelayAlgorithm;
  readonly sampleRate: number;
  wetLeft = 0;
  wetRight = 0;

  private sourceLeft: Float32Array;
  private sourceRight: Float32Array;
  private readonly segmentStarts = new Int32Array(MAX_REPEATS);
  private readonly segmentLengths = new Int32Array(MAX_REPEATS);
  private readonly timeSamples: LinearParameterSmoother;
  private readonly depth: LinearParameterSmoother;
  private readonly rampFrames: number;
  private readonly minimumTimeSamples: number;
  private readonly maximumTimeSamples: number;
  private time = 200;
  private bpm = 120;
  private repeats = 16;
  private writeIndex = 0;
  private phase = 0;
  private activeSegmentFrames: number;
  private segmentPosition = 0;
  private captureStart = 0;
  private completedSegments = 0;
  private segmentHead = -1;

  constructor(
    algorithm: BrowserOfficialDelayAlgorithm,
    sampleRate = 48000,
    parameters: BrowserOfficialDelayParameters = {},
  ) {
    this.algorithm = algorithm;
    this.sampleRate = Number.isFinite(sampleRate) ? clamp(sampleRate, 8000, 192000) : 48000;
    this.minimumTimeSamples = this.sampleRate / 1000;
    this.maximumTimeSamples = MAX_SYNC_TIME_SECONDS * this.sampleRate;
    const capacity = Math.ceil((MAX_REPEATS + 1) * MAX_NUMERIC_TIME_SECONDS * this.sampleRate) + 4;
    this.sourceLeft = new Float32Array(capacity);
    this.sourceRight = new Float32Array(capacity);
    this.rampFrames = Math.max(1, Math.round(this.sampleRate * 0.015));
    this.timeSamples = new LinearParameterSmoother(0.2 * this.sampleRate);
    this.depth = new LinearParameterSmoother(50);
    this.activeSegmentFrames = Math.round(this.timeSamples.currentValue);
    this.setParameters(parameters);
    this.timeSamples.reset();
    this.depth.reset();
    this.activeSegmentFrames = Math.round(this.timeSamples.currentValue);
  }

  get latencySamples(): number {
    return this.algorithm === 'reverse-delay' ? this.activeSegmentFrames : 0;
  }

  get bufferCapacitySamples(): number { return this.sourceLeft.length; }

  setParameters(parameters: BrowserOfficialDelayParameters): void {
    // TIME has no OFF selection. Ignore OFF, zero and nonfinite updates rather
    // than turning them into an unrelated two-second or one-millisecond delay.
    if (Number.isFinite(parameters.time) && parameters.time !== 0 && parameters.time !== OFF) {
      const requested = parameters.time as number;
      this.time = requested > 0 ? clamp(requested, 1, 2000) : -Math.min(MAX_SYNC_BEATS, Math.abs(requested));
    }
    if (Number.isFinite(parameters.bpm)) this.bpm = clamp(parameters.bpm as number, MIN_BPM, MAX_BPM);
    if (Number.isFinite(parameters.feedback)) {
      this.repeats = Math.round(clamp(parameters.feedback as number, 1, MAX_REPEATS));
    }
    if (Number.isFinite(parameters.modDepth)) {
      const target = clamp(parameters.modDepth as number, 0, 100);
      if (target !== this.depth.targetValue) this.depth.setTarget(target, this.rampFrames);
    }
    const seconds = this.time > 0 ? this.time / 1000 : Math.abs(this.time) * 60 / this.bpm;
    const samples = clamp(seconds * this.sampleRate, this.minimumTimeSamples, this.maximumTimeSamples);
    this.ensureCapacity(Math.ceil((MAX_REPEATS + 1) * samples) + 4);
    if (samples !== this.timeSamples.targetValue) this.timeSamples.setTarget(samples, this.rampFrames);
  }

  /** Returns this reusable result, also exposed as wetLeft/wetRight fields. */
  processSample(left: number, right: number): this {
    this.sourceLeft[this.writeIndex] = bounded(left);
    this.sourceRight[this.writeIndex] = bounded(right);
    const time = this.timeSamples.next();
    const depth = this.depth.next() / 100;
    let wetLeft = 0;
    let wetRight = 0;
    let gain = 1;

    if (this.algorithm === 'reverse-delay') {
      const position = this.segmentPosition / Math.max(1, this.activeSegmentFrames - 1);
      // Crossfade through zero between reversed segments. The half-sample edge
      // convention keeps an impulse at either end audible, including TIME=1ms.
      const edgeFrames = Math.min(this.sampleRate * 0.003, this.activeSegmentFrames * 0.125);
      const edge = Math.min(1, (this.segmentPosition + 0.5) / edgeFrames,
        (this.activeSegmentFrames - this.segmentPosition - 0.5) / edgeFrames);
      const window = Math.sin(Math.PI * 0.5 * edge);
      const count = Math.min(this.repeats, this.completedSegments);
      for (let repeat = 0; repeat < count; repeat += 1) {
        const slot = (this.segmentHead - repeat + MAX_REPEATS) % MAX_REPEATS;
        const offset = (this.segmentLengths[slot]! - 1) * (1 - position);
        const readPosition = this.segmentStarts[slot]! + offset;
        wetLeft += gain * this.readAt(this.sourceLeft, readPosition);
        wetRight += gain * this.readAt(this.sourceRight, readPosition);
        gain *= REPEAT_DECAY;
      }
      wetLeft *= window;
      wetRight *= window;
    } else {
      // Symmetric modulation stays within the selected numeric/sync domain.
      // The common per-repeat excursion also keeps successive echoes ordered.
      const maximumTime = this.time > 0 ? MAX_NUMERIC_TIME_SECONDS * this.sampleRate : this.maximumTimeSamples;
      const excursion = this.algorithm === 'mod-delay'
        ? depth * Math.max(0, Math.min(this.sampleRate * 0.012, time * 0.25,
          time - this.minimumTimeSamples, maximumTime - time))
        : 0;
      const leftTime = time + excursion * Math.sin(this.phase);
      const rightTime = time + excursion * Math.cos(this.phase);
      for (let repeat = 1; repeat <= this.repeats; repeat += 1) {
        const delayedLeft = this.readAt(this.sourceLeft, this.writeIndex - repeat * leftTime);
        const delayedRight = this.readAt(this.sourceRight, this.writeIndex - repeat * rightTime);
        if (this.algorithm === 'panning-delay') {
          // Alternating hard-panned repeats of the equal-weight stereo sum.
          const mono = (delayedLeft + delayedRight) * 0.5;
          if (repeat % 2 === 1) wetLeft += gain * mono;
          else wetRight += gain * mono;
        } else {
          wetLeft += gain * delayedLeft;
          wetRight += gain * delayedRight;
        }
        gain *= REPEAT_DECAY;
      }
    }

    this.wetLeft = bounded(wetLeft);
    this.wetRight = bounded(wetRight);
    this.phase += TWO_PI * MOD_RATE_HZ / this.sampleRate;
    if (this.phase >= TWO_PI) this.phase -= TWO_PI;
    this.writeIndex += 1;
    if (this.writeIndex >= this.sourceLeft.length) this.writeIndex = 0;

    if (this.algorithm === 'reverse-delay') {
      this.segmentPosition += 1;
      if (this.segmentPosition >= this.activeSegmentFrames) {
        this.segmentHead = (this.segmentHead + 1) % MAX_REPEATS;
        this.segmentStarts[this.segmentHead] = this.captureStart;
        this.segmentLengths[this.segmentHead] = this.activeSegmentFrames;
        this.completedSegments = Math.min(MAX_REPEATS, this.completedSegments + 1);
        this.captureStart = this.writeIndex;
        this.segmentPosition = 0;
        this.activeSegmentFrames = Math.round(this.timeSamples.targetValue);
      }
    }
    return this;
  }

  reset(): void {
    this.sourceLeft.fill(0);
    this.sourceRight.fill(0);
    this.segmentStarts.fill(0);
    this.segmentLengths.fill(0);
    this.timeSamples.reset();
    this.depth.reset();
    this.writeIndex = 0;
    this.phase = 0;
    this.activeSegmentFrames = Math.round(this.timeSamples.currentValue);
    this.segmentPosition = 0;
    this.captureStart = 0;
    this.completedSegments = 0;
    this.segmentHead = -1;
    this.wetLeft = 0;
    this.wetRight = 0;
  }

  /** Grow only on the control path; moving history cannot alter its sample age. */
  private ensureCapacity(capacity: number): void {
    const oldLength = this.sourceLeft.length;
    if (capacity <= oldLength) return;
    const left = new Float32Array(capacity);
    const right = new Float32Array(capacity);
    const oldWrite = this.writeIndex;
    // The old unwritten slot is the oldest retained position. Put all retained
    // history before the new write slot so both fractional taps and reverse
    // segments keep exactly the same temporal interpretation after growth.
    left.set(this.sourceLeft.subarray(oldWrite));
    left.set(this.sourceLeft.subarray(0, oldWrite), oldLength - oldWrite);
    right.set(this.sourceRight.subarray(oldWrite));
    right.set(this.sourceRight.subarray(0, oldWrite), oldLength - oldWrite);
    for (let slot = 0; slot < MAX_REPEATS; slot += 1) {
      this.segmentStarts[slot] = (this.segmentStarts[slot]! - oldWrite + oldLength) % oldLength;
    }
    // At a capture boundary the start denotes the NEXT sample, not the oldest
    // sample. This also handles construction with a long synchronized TIME.
    this.captureStart = this.segmentPosition === 0
      ? oldLength
      : (this.captureStart - oldWrite + oldLength) % oldLength;
    this.sourceLeft = left;
    this.sourceRight = right;
    this.writeIndex = oldLength;
  }

  /** Linear interpolation is convex: it cannot overshoot the bounded source. */
  private readAt(buffer: Float32Array, position: number): number {
    position %= buffer.length;
    if (position < 0) position += buffer.length;
    const index = Math.floor(position);
    const next = index + 1 === buffer.length ? 0 : index + 1;
    const fraction = position - index;
    return buffer[index]! * (1 - fraction) + buffer[next]! * fraction;
  }
}
