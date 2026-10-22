import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

export interface BrowserVibratoParameters {
  /** LFO rate in Hz, 0.05..20. */
  rateHz?: number;
  /** Modulation depth as percent, 0..100. */
  depthPercent?: number;
  /** Center delay in milliseconds, 0.2..10. */
  delayMs?: number;
}

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_RATE_HZ = 0.05;
const MAX_RATE_HZ = 20;
const MIN_DEPTH_PERCENT = 0;
const MAX_DEPTH_PERCENT = 100;
const MIN_DELAY_MS = 0.2;
const MAX_DELAY_MS = 10;
const MAX_MODULATION_FACTOR = 0.9;
const PARAMETER_SMOOTHING_SECONDS = 0.015;
const TWO_PI = 2 * Math.PI;
const MAX_SAMPLE_MAGNITUDE = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteBounded(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_SAMPLE_MAGNITUDE, MAX_SAMPLE_MAGNITUDE) : 0;
}

/** Four-point backward Lagrange read from an as-yet-unwritten slot. */
function readLagrange(buffer: Float32Array, writeIndex: number, delaySamples: number): number {
  const wholeDelay = Math.floor(delaySamples);
  const fraction = delaySamples - wholeDelay;
  const oneMinus = 1 - fraction;
  const coefficient0 = (oneMinus * (2 - fraction) * (3 - fraction)) / 6;
  const coefficient1 = (fraction * (2 - fraction) * (3 - fraction)) / 2;
  const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
  const coefficient3 = (fraction * oneMinus * (2 - fraction)) / 6;
  const length = buffer.length;
  let index = writeIndex - wholeDelay;
  index %= length;
  if (index < 0) index += length;
  const sample0 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const sample1 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const sample2 = buffer[index] ?? 0;
  index = index > 0 ? index - 1 : length - 1;
  const sample3 = buffer[index] ?? 0;
  return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
}

/**
 * Clean-room wet-only vibrato using one four-point Lagrange modulated delay
 * voice per channel. A quarter-cycle right-channel offset creates a gentle
 * stereo spread; this is an authored choice, not a device topology claim.
 * State buffers are fixed at construction and processing does not allocate.
 */
export class BrowserVibratoDsp {
  readonly sampleRate: number;
  readonly algorithmicLatencySamples = 0;
  private readonly buffers: readonly [Float32Array, Float32Array];
  private readonly writeIndices = new Int32Array(2);
  private readonly rateHz: LinearParameterSmoother;
  private readonly depthPercent: LinearParameterSmoother;
  private readonly delayMs: LinearParameterSmoother;
  private readonly parameterRampFrames: number;
  private phase = 0;
  private officialColor = 0;
  private officialRateActive = false;
  private outputLeft = 0;
  private outputRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserVibratoParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;
    const capacity = Math.ceil(MAX_DELAY_MS * (1 + MAX_MODULATION_FACTOR) * this.sampleRate / 1000) + 8;
    this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
    this.rateHz = new LinearParameterSmoother(clamp(parameters.rateHz ?? 5, MIN_RATE_HZ, MAX_RATE_HZ));
    this.depthPercent = new LinearParameterSmoother(clamp(parameters.depthPercent ?? 35, MIN_DEPTH_PERCENT, MAX_DEPTH_PERCENT));
    this.delayMs = new LinearParameterSmoother(clamp(parameters.delayMs ?? 2, MIN_DELAY_MS, MAX_DELAY_MS));
    this.parameterRampFrames = Math.round(this.sampleRate * PARAMETER_SMOOTHING_SECONDS);
  }

  get wetLeft(): number { return this.outputLeft; }
  get wetRight(): number { return this.outputRight; }
  get currentRateHz(): number { return this.rateHz.currentValue; }
  get currentDepthPercent(): number { return this.depthPercent.currentValue; }
  get currentDelayMs(): number { return this.delayMs.currentValue; }

  setParameters(parameters: BrowserVibratoParameters): void {
    if (Number.isFinite(parameters.rateHz)) {
      this.rateHz.setTarget(clamp(parameters.rateHz as number, MIN_RATE_HZ, MAX_RATE_HZ), this.parameterRampFrames);
    }
    if (Number.isFinite(parameters.depthPercent)) {
      this.depthPercent.setTarget(clamp(parameters.depthPercent as number, MIN_DEPTH_PERCENT, MAX_DEPTH_PERCENT), this.parameterRampFrames);
    }
    if (Number.isFinite(parameters.delayMs)) {
      this.delayMs.setTarget(clamp(parameters.delayMs as number, MIN_DELAY_MS, MAX_DELAY_MS), this.parameterRampFrames);
    }
  }

  processSample(inputLeft: number, inputRight: number): void {
    const rate = clamp(this.rateHz.next(), this.officialRateActive ? 0 : MIN_RATE_HZ, this.officialRateActive ? 160 : MAX_RATE_HZ);
    const depth = clamp(this.depthPercent.next() / 100, 0, 1) * MAX_MODULATION_FACTOR;
    const baseDelaySamples = clamp(this.delayMs.next(), MIN_DELAY_MS, MAX_DELAY_MS) * this.sampleRate / 1000;
    const left = this.processChannel(inputLeft, 0, this.phase, baseDelaySamples, depth);
    const right = this.processChannel(inputRight, 1, this.phase + Math.PI * 0.5, baseDelaySamples, depth);
    this.outputLeft = left;
    this.outputRight = right;
    this.phase += TWO_PI * rate / this.sampleRate;
    if (this.phase >= TWO_PI) this.phase -= TWO_PI;
  }

  setOfficialParameters(parameters: { color?: number; rateHz?: number }): void {
    if (Number.isFinite(parameters.color)) this.officialColor = clamp(parameters.color as number, 0, 100) / 100;
    if (Number.isFinite(parameters.rateHz)) { this.officialRateActive = true; this.rateHz.setTarget(clamp(parameters.rateHz as number, 0, 160), this.parameterRampFrames); }
  }

  reset(): void {
    this.buffers[0].fill(0);
    this.buffers[1].fill(0);
    this.writeIndices.fill(0);
    this.phase = 0;
    this.rateHz.reset();
    this.depthPercent.reset();
    this.delayMs.reset();
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  private processChannel(input: number, channel: 0 | 1, phase: number, baseDelaySamples: number, depth: number): number {
    const buffer = this.buffers[channel];
    const writeIndex = this.writeIndices[channel] ?? 0;
    const delaySamples = clamp(
      baseDelaySamples * (1 + depth * ((1 - this.officialColor * 0.5) * Math.sin(phase)
        + this.officialColor * 0.3 * Math.sin(2 * phase + 0.4) + this.officialColor * 0.2 * Math.sin(3 * phase + 0.8))),
      2,
      buffer.length - 6,
    );
    const delayed = readLagrange(buffer, writeIndex, delaySamples);
    buffer[writeIndex] = finiteBounded(input);
    let nextWriteIndex = writeIndex + 1;
    if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
    this.writeIndices[channel] = nextWriteIndex;
    return finiteBounded(delayed);
  }
}
