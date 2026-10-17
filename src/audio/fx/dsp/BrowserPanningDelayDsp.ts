/**
 * Standalone clean-room Browser PANNING DELAY kernel (catalog FX #37).
 *
 * The supplied provisional catalog defines time (1..2000 ms, default 500),
 * feedback (0..95%, default 30), repeat pan (-100..100%, default 70), and wet
 * mix (0..100%, default 25). It describes two delay lines, cross-feedback,
 * equal-power repeat panning, and a stable 2x2 feedback matrix with Lagrange
 * taps. It does not specify the exact matrix, pan law, or parameter smoothing.
 *
 * This functional reconstruction uses two independent stereo delay lines,
 * cross-coupled feedback (the energy-preserving channel-swap matrix), and a
 * single equal-power panner on the downmixed repeat signal. The pan control
 * moves that repeat image from hard left to hard right. Four-point backward
 * Lagrange interpolation supports fractional sample times. A conservative
 * feedback scale of 0.78 keeps the 0..95% control below unity even under the
 * interpolator's 1.25 worst-case absolute coefficient sum. A 15 ms one-pole
 * smoothing ramp is used for all controls. These are authored reconstruction
 * choices, not claims about Roland's hidden DSP.
 *
 * All storage is allocated by the constructor. Processing methods use no
 * per-block or per-sample allocations and do not assume a fixed block size.
 */

export interface BrowserPanningDelayParameters {
  /** Delay time in milliseconds, 1..2000. */
  timeMs?: number;
  /** Feedback amount in percent, 0..95. */
  feedback?: number;
  /** Repeat pan position in percent, -100 (left)..100 (right). */
  pan?: number;
  /** Wet mix in percent, 0..100. */
  mix?: number;
}

const QUARTER_PI = Math.PI * 0.25;
const INV_SQRT_TWO = Math.SQRT1_2;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_DELAY_MS = 1;
const MAX_DELAY_MS = 2000;
const MAX_INPUT_MAGNITUDE = 8;
const PARAMETER_SMOOTHING_SECONDS = 0.015;
// Sup_mu sum_k |h_k(mu)| = 1.25 for the four-point Lagrange interpolator.
// 0.95 * 0.78 * 1.25 = 0.92625, below unity for the orthogonal channel-swap
// feedback matrix used here.
const FEEDBACK_STABILITY_SCALE = 0.78;

const TIME = 0;
const FEEDBACK = 1;
const PAN = 2;
const MIX = 3;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteBounded(value: number, maximumMagnitude: number): number {
  return Number.isFinite(value) ? clamp(value, -maximumMagnitude, maximumMagnitude) : 0;
}

/** Four-point backward Lagrange read relative to an as-yet-unwritten slot. */
function readLagrangeFromWriteHead(buffer: Float32Array, writeIndex: number, delaySamples: number): number {
  const wholeDelay = Math.floor(delaySamples);
  const fraction = delaySamples - wholeDelay;
  const oneMinus = 1 - fraction;
  const coefficient0 = (oneMinus * (2 - fraction) * (3 - fraction)) / 6;
  const coefficient1 = (fraction * (2 - fraction) * (3 - fraction)) / 2;
  const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
  const coefficient3 = (fraction * oneMinus * (2 - fraction)) / 6;
  const length = buffer.length;
  let index = writeIndex - wholeDelay;
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
 * Two-line cross-feedback delay with equal-power repeat panning.
 *
 * `inputRight` and `outputRight` may be null for mono operation. Mono input is
 * copied to the right delay line when no right input is supplied.
 */
export class BrowserPanningDelayDsp {
  readonly sampleRate: number;
  private readonly buffers: readonly [Float32Array, Float32Array];
  private readonly writeIndices = new Int32Array(2);
  private readonly current = new Float64Array(4);
  private readonly target = new Float64Array(4);
  private readonly smoothingCoefficient: number;
  private lastDryLeft = 0;
  private lastDryRight = 0;
  private lastWetLeft = 0;
  private lastWetRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserPanningDelayParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;
    const capacity = Math.ceil(MAX_DELAY_MS * this.sampleRate / 1000) + 8;
    this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
    this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS * this.sampleRate));

    const initialTime = Number.isFinite(parameters.timeMs)
      ? clamp(parameters.timeMs as number, MIN_DELAY_MS, MAX_DELAY_MS)
      : 500;
    const initialFeedback = Number.isFinite(parameters.feedback)
      ? clamp(parameters.feedback as number, 0, 95)
      : 30;
    const initialPan = Number.isFinite(parameters.pan)
      ? clamp(parameters.pan as number, -100, 100)
      : 70;
    const initialMix = Number.isFinite(parameters.mix)
      ? clamp(parameters.mix as number, 0, 100)
      : 25;

    this.current[TIME] = this.target[TIME] = initialTime;
    this.current[FEEDBACK] = this.target[FEEDBACK] = initialFeedback;
    this.current[PAN] = this.target[PAN] = initialPan;
    this.current[MIX] = this.target[MIX] = initialMix;
  }

  /** Update smoothed targets; invalid individual controls are ignored. */
  setParameters(parameters: BrowserPanningDelayParameters): void {
    if (Number.isFinite(parameters.timeMs)) this.target[TIME] = clamp(parameters.timeMs as number, MIN_DELAY_MS, MAX_DELAY_MS);
    if (Number.isFinite(parameters.feedback)) this.target[FEEDBACK] = clamp(parameters.feedback as number, 0, 95);
    if (Number.isFinite(parameters.pan)) this.target[PAN] = clamp(parameters.pan as number, -100, 100);
    if (Number.isFinite(parameters.mix)) this.target[MIX] = clamp(parameters.mix as number, 0, 100);
  }

  /** Clear delay history and restore the smoothed controls to their targets. */
  reset(): void {
    this.buffers[0].fill(0);
    this.buffers[1].fill(0);
    this.writeIndices.fill(0);
    this.lastDryLeft = 0;
    this.lastDryRight = 0;
    this.lastWetLeft = 0;
    this.lastWetRight = 0;
    for (let index = 0; index < this.current.length; index += 1) this.current[index] = this.target[index] ?? 0;
  }

  /** Process one frame and expose its wet-only panned repeat. */
  processSample(inputLeft: number, inputRight: number): void {
    this.processFrameSample(inputLeft, inputRight);
  }

  /** Last wet-only output from processSample() or the most recent block frame. */
  get wetOutputLeft(): number {
    return this.lastWetLeft;
  }

  get wetOutputRight(): number {
    return this.lastWetRight;
  }

  /** Process planar audio without block-size assumptions or typed-array allocation. */
  processBlock(
    inputLeft: Float32Array,
    inputRight: Float32Array | null,
    outputLeft: Float32Array,
    outputRight: Float32Array | null,
    frameCount?: number,
  ): void {
    let frames = Math.min(inputLeft.length, outputLeft.length);
    if (inputRight !== null) frames = Math.min(frames, inputRight.length);
    if (outputRight !== null) frames = Math.min(frames, outputRight.length);
    if (frameCount !== undefined && Number.isFinite(frameCount)) {
      frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));
    }

    for (let frame = 0; frame < frames; frame += 1) {
      const inputL = inputLeft[frame] ?? 0;
      const inputR = inputRight === null ? inputL : inputRight[frame] ?? 0;
      this.processFrameSample(inputL, inputR);
      const mix = (this.current[MIX] ?? 0) * 0.01;
      outputLeft[frame] = finiteBounded(this.lastDryLeft * (1 - mix) + this.lastWetLeft * mix, MAX_INPUT_MAGNITUDE);
      if (outputRight !== null) {
        outputRight[frame] = finiteBounded(this.lastDryRight * (1 - mix) + this.lastWetRight * mix, MAX_INPUT_MAGNITUDE);
      }
    }
  }

  private processFrameSample(inputLeft: number, inputRight: number): void {
    this.current[TIME] = (this.current[TIME] ?? 0) + this.smoothingCoefficient * ((this.target[TIME] ?? 0) - (this.current[TIME] ?? 0));
    this.current[FEEDBACK] = (this.current[FEEDBACK] ?? 0) + this.smoothingCoefficient * ((this.target[FEEDBACK] ?? 0) - (this.current[FEEDBACK] ?? 0));
    this.current[PAN] = (this.current[PAN] ?? 0) + this.smoothingCoefficient * ((this.target[PAN] ?? 0) - (this.current[PAN] ?? 0));
    this.current[MIX] = (this.current[MIX] ?? 0) + this.smoothingCoefficient * ((this.target[MIX] ?? 0) - (this.current[MIX] ?? 0));

    const dryLeft = finiteBounded(inputLeft, MAX_INPUT_MAGNITUDE);
    const dryRight = finiteBounded(inputRight, MAX_INPUT_MAGNITUDE);
    this.lastDryLeft = dryLeft;
    this.lastDryRight = dryRight;

    const rawDelay = (this.current[TIME] ?? 500) * this.sampleRate * 0.001;
    const delaySamples = clamp(rawDelay, 2, this.buffers[0].length - 6);
    const writeLeft = this.writeIndices[0] ?? 0;
    const writeRight = this.writeIndices[1] ?? 0;
    const delayedLeft = readLagrangeFromWriteHead(this.buffers[0], writeLeft, delaySamples);
    const delayedRight = readLagrangeFromWriteHead(this.buffers[1], writeRight, delaySamples);

    const feedback = ((this.current[FEEDBACK] ?? 0) * 0.01) * FEEDBACK_STABILITY_SCALE;
    // An orthogonal channel swap: each line receives the other line's repeat.
    this.buffers[0][writeLeft] = finiteBounded(dryLeft + feedback * delayedRight, MAX_INPUT_MAGNITUDE);
    this.buffers[1][writeRight] = finiteBounded(dryRight + feedback * delayedLeft, MAX_INPUT_MAGNITUDE);
    const nextLeft = writeLeft + 1 >= this.buffers[0].length ? 0 : writeLeft + 1;
    const nextRight = writeRight + 1 >= this.buffers[1].length ? 0 : writeRight + 1;
    this.writeIndices[0] = nextLeft;
    this.writeIndices[1] = nextRight;

    // Combine the two repeat paths at unity power for duplicated mono input,
    // then apply a constant-power pan from left (0 rad) to right (pi/2 rad).
    const repeatMono = (delayedLeft + delayedRight) * INV_SQRT_TWO;
    const panRadians = ((this.current[PAN] ?? 0) + 100) * (QUARTER_PI / 100);
    this.lastWetLeft = finiteBounded(repeatMono * Math.cos(panRadians), MAX_INPUT_MAGNITUDE);
    this.lastWetRight = finiteBounded(repeatMono * Math.sin(panRadians), MAX_INPUT_MAGNITUDE);
  }
}
