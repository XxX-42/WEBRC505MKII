import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

/** Provisional clean-room controls for catalog MOD DELAY (source ID 39). */
export interface BrowserModDelayParameters {
  timeMs?: number;
  rateHz?: number;
  depthMs?: number;
  feedbackPercent?: number;
}

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_TIME_MS = 10;
const MAX_TIME_MS = 2000;
const MAX_DEPTH_MS = 50;
const MIN_RATE_HZ = 0.05;
const MAX_RATE_HZ = 10;
const MAX_FEEDBACK_PERCENT = 95;
const PARAMETER_SMOOTHING_SECONDS = 0.015;
const TWO_PI = 2 * Math.PI;
const MAX_SAMPLE_MAGNITUDE = 8;
// Lagrange4's worst-case absolute coefficient sum is 1.25. Keep the feedback
// loop contractive at the provisional 95% upper bound.
const FEEDBACK_STABILITY_SCALE = 0.78;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteBounded(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_SAMPLE_MAGNITUDE, MAX_SAMPLE_MAGNITUDE) : 0;
}

/** Four-point backward Lagrange read relative to an unwritten write slot. */
function readLagrange(buffer: Float32Array, writeIndex: number, delaySamples: number): number {
  const whole = Math.floor(delaySamples);
  const fraction = delaySamples - whole;
  const oneMinus = 1 - fraction;
  const c0 = oneMinus * (2 - fraction) * (3 - fraction) / 6;
  const c1 = fraction * (2 - fraction) * (3 - fraction) / 2;
  const c2 = -fraction * oneMinus * (3 - fraction) / 2;
  const c3 = fraction * oneMinus * (2 - fraction) / 6;
  const length = buffer.length;
  let index = writeIndex - whole;
  index %= length;
  if (index < 0) index += length;
  const x0 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const x1 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const x2 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const x3 = buffer[index] ?? 0;
  return c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3;
}

/**
 * Fixed-memory stereo modulated delay. The independent stereo lines have a
 * quarter-cycle LFO offset, four-point fractional reads, one-pole feedback
 * filtering, and bounded saturated feedback. Controls are smoothed; no
 * allocations or callback-size assumptions occur in processSample/processBlock.
 */
export class BrowserModDelayDsp {
  readonly sampleRate: number;
  private readonly buffers: readonly [Float32Array, Float32Array];
  private readonly writeIndices = new Int32Array(2);
  private readonly feedbackFilter = new Float64Array(2);
  private readonly rateHz: LinearParameterSmoother;
  private readonly timeMs: LinearParameterSmoother;
  private readonly depthMs: LinearParameterSmoother;
  private readonly feedbackPercent: LinearParameterSmoother;
  private readonly parameterRampFrames: number;
  private readonly feedbackToneAlpha: number;
  private phase = 0;
  private outputLeft = 0;
  private outputRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserModDelayParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;
    const capacity = Math.ceil((MAX_TIME_MS + MAX_DEPTH_MS) * this.sampleRate / 1000) + 8;
    this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
    this.rateHz = new LinearParameterSmoother(clamp(parameters.rateHz ?? 0.3, MIN_RATE_HZ, MAX_RATE_HZ));
    this.timeMs = new LinearParameterSmoother(clamp(parameters.timeMs ?? 500, MIN_TIME_MS, MAX_TIME_MS));
    this.depthMs = new LinearParameterSmoother(clamp(parameters.depthMs ?? 10, 0, MAX_DEPTH_MS));
    this.feedbackPercent = new LinearParameterSmoother(clamp(parameters.feedbackPercent ?? 25, 0, MAX_FEEDBACK_PERCENT));
    this.parameterRampFrames = Math.max(1, Math.round(this.sampleRate * PARAMETER_SMOOTHING_SECONDS));
    const feedbackCutoff = Math.min(8000, this.sampleRate * 0.45);
    this.feedbackToneAlpha = 1 - Math.exp(-TWO_PI * feedbackCutoff / this.sampleRate);
  }

  get wetLeft(): number { return this.outputLeft; }
  get wetRight(): number { return this.outputRight; }

  setParameters(parameters: BrowserModDelayParameters): void {
    if (Number.isFinite(parameters.timeMs)) {
      this.timeMs.setTarget(clamp(parameters.timeMs as number, MIN_TIME_MS, MAX_TIME_MS), this.parameterRampFrames);
    }
    if (Number.isFinite(parameters.rateHz)) {
      this.rateHz.setTarget(clamp(parameters.rateHz as number, MIN_RATE_HZ, MAX_RATE_HZ), this.parameterRampFrames);
    }
    if (Number.isFinite(parameters.depthMs)) {
      this.depthMs.setTarget(clamp(parameters.depthMs as number, 0, MAX_DEPTH_MS), this.parameterRampFrames);
    }
    if (Number.isFinite(parameters.feedbackPercent)) {
      this.feedbackPercent.setTarget(clamp(parameters.feedbackPercent as number, 0, MAX_FEEDBACK_PERCENT), this.parameterRampFrames);
    }
  }

  processSample(inputLeft: number, inputRight: number): void {
    const rate = clamp(this.rateHz.next(), MIN_RATE_HZ, MAX_RATE_HZ);
    const timeMs = clamp(this.timeMs.next(), MIN_TIME_MS, MAX_TIME_MS);
    const requestedDepthMs = clamp(this.depthMs.next(), 0, MAX_DEPTH_MS);
    const depthMs = Math.min(requestedDepthMs, timeMs - MIN_TIME_MS, MAX_TIME_MS + MAX_DEPTH_MS - timeMs);
    const feedback = clamp(this.feedbackPercent.next(), 0, MAX_FEEDBACK_PERCENT) * 0.01 * FEEDBACK_STABILITY_SCALE;

    this.outputLeft = this.processChannel(inputLeft, 0, this.phase, timeMs, depthMs, feedback);
    this.outputRight = this.processChannel(inputRight, 1, this.phase + Math.PI * 0.5, timeMs, depthMs, feedback);
    this.phase += TWO_PI * rate / this.sampleRate;
    if (this.phase >= TWO_PI) this.phase -= TWO_PI;
  }

  processBlock(
    inputLeft: Float32Array,
    inputRight: Float32Array | null,
    outputLeft: Float32Array,
    outputRight: Float32Array | null,
    frameCount?: number,
  ): void {
    let frames = Math.min(inputLeft.length, outputLeft.length);
    if (inputRight) frames = Math.min(frames, inputRight.length);
    if (outputRight) frames = Math.min(frames, outputRight.length);
    if (frameCount !== undefined && Number.isFinite(frameCount)) {
      frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));
    }
    for (let frame = 0; frame < frames; frame += 1) {
      const left = inputLeft[frame] ?? 0;
      const right = inputRight ? (inputRight[frame] ?? 0) : left;
      this.processSample(left, right);
      if (outputLeft) outputLeft[frame] = this.outputLeft;
      if (outputRight) outputRight[frame] = this.outputRight;
    }
  }

  reset(): void {
    this.buffers[0].fill(0);
    this.buffers[1].fill(0);
    this.writeIndices.fill(0);
    this.feedbackFilter.fill(0);
    this.phase = 0;
    this.rateHz.reset();
    this.timeMs.reset();
    this.depthMs.reset();
    this.feedbackPercent.reset();
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  private processChannel(input: number, channel: 0 | 1, phase: number, timeMs: number, depthMs: number, feedback: number): number {
    const buffer = this.buffers[channel];
    const writeIndex = this.writeIndices[channel] ?? 0;
    const delayMs = clamp(timeMs + depthMs * Math.sin(phase), MIN_TIME_MS, MAX_TIME_MS + MAX_DEPTH_MS);
    const delaySamples = clamp(delayMs * this.sampleRate / 1000, 2, buffer.length - 6);
    const delayed = readLagrange(buffer, writeIndex, delaySamples);
    const previousFiltered = this.feedbackFilter[channel] ?? 0;
    const filtered = previousFiltered + this.feedbackToneAlpha * (delayed - previousFiltered);
    this.feedbackFilter[channel] = Number.isFinite(filtered) ? filtered : 0;
    buffer[writeIndex] = finiteBounded(finiteBounded(input) + feedback * Math.tanh(filtered));
    this.writeIndices[channel] = writeIndex + 1 >= buffer.length ? 0 : writeIndex + 1;
    return finiteBounded(delayed);
  }
}
