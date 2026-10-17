/**
 * Standalone clean-room Browser TAPE ECHO kernel (source FX #40).
 *
 * Descriptor controls and ranges are taken from the supplied provisional
 * catalog: time 20..2000 ms, feedback 0..95%, wow 0..100%, saturation
 * 0..100%, tone 500..16000 Hz, and wet mix 0..100%. These ranges are marked
 * provisional in the source descriptor, not official Roland specifications.
 *
 * The implementation uses three 4-point Lagrange playback heads at 1x, 2x,
 * and 3x the smoothed base time, weighted 0.55/0.30/0.15. Record/repro
 * coloration is a clean-room two-times midpoint-upsampled ADAA soft saturator
 * followed by a one-pole repro loss filter. Feedback is damped and its maximum
 * gain is conservatively scaled for the Lagrange interpolator's worst-case
 * absolute coefficient sum; the saturator has slope <= 1, so the loop stays
 * contractive. A low-level deterministic, band-limited tape hiss is mixed into
 * the record path.
 *
 * Authored reconstruction choices, not descriptor metadata: three head ratios
 * and weights, 15 ms one-pole parameter smoothing, 0.4% maximum wow/flutter
 * excursion with 0.63 Hz / 6.1 Hz oscillators, 75/25 wow/flutter weighting,
 * feedback safety scale 0.78, the ADAA curve, 2x linear-midpoint interpolation
 * and two-phase averaging, and fixed 0.00008 hiss amplitude with 350 Hz / 12
 * kHz band limits. These are functional choices, not claims about Roland's
 * hidden implementation.
 *
 * All buffers are allocated in the constructor. processBlock() uses only
 * preallocated storage and caller-owned arrays; it creates no per-block or
 * per-sample arrays, views, closures, or objects.
 */

export interface BrowserTapeEchoParameters {
  /** Head delay in milliseconds, from the provisional descriptor range. */
  timeMs?: number;
  /** Feedback as a percentage, 0..95. */
  feedback?: number;
  /** Wow/flutter amount as a percentage, 0..100. */
  wow?: number;
  /** Tape saturation amount as a percentage, 0..100. */
  saturation?: number;
  /** Tape-loss cutoff in Hz, 500..16000 before Nyquist limiting. */
  toneHz?: number;
  /** Wet mix as a percentage, 0..100. */
  mix?: number;
}

const TWO_PI = Math.PI * 2;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MAX_INPUT_MAGNITUDE = 8;
const MAX_WOW_FRACTION = 0.004;
const WOW_RATE_HZ = 0.63;
const FLUTTER_RATE_HZ = 6.1;
const PARAMETER_SMOOTHING_SECONDS = 0.015;
const HEAD_WEIGHTS_1 = 0.55;
const HEAD_WEIGHTS_2 = 0.3;
const HEAD_WEIGHTS_3 = 0.15;
// For the F05 cubic coefficients, sup_mu Σ|h_k(mu)| = 1.25 (at μ = 0.5).
// Thus the largest descriptor feedback setting gives 0.95 * 0.78 * 1.25 =
// 0.92625 as a conservative linear loop-gain bound before the unity-bounded
// one-pole filter and the slope-<=1 saturation stage.
const FEEDBACK_STABILITY_SCALE = 0.78;
const HISS_AMPLITUDE = 0.00008;
const LOG_TWO = Math.LN2;

const TIME = 0;
const FEEDBACK = 1;
const WOW = 2;
const SATURATION = 3;
const TONE_ALPHA = 4;
const MIX = 5;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteBounded(value: number, maximumMagnitude: number): number {
  return Number.isFinite(value) ? clamp(value, -maximumMagnitude, maximumMagnitude) : 0;
}

function coefficientForTone(toneHz: number, sampleRate: number): number {
  const cutoff = clamp(toneHz, 500, Math.min(16000, sampleRate * 0.45));
  return 1 - Math.exp(-TWO_PI * cutoff / sampleRate);
}

/**
 * Three-head tape echo with fixed-capacity stereo delay lines.
 *
 * `inputRight` and `outputRight` may be null for mono operation. A mono input
 * is copied into the right processing path when stereo output is requested.
 */
export class BrowserTapeEchoDsp {
  readonly sampleRate: number;
  private readonly buffers: readonly [Float32Array, Float32Array];
  private readonly writeIndices = new Int32Array(2);
  private readonly phases = new Float64Array(4);
  private readonly feedbackToneStates = new Float64Array(2);
  private readonly reproToneStates = new Float64Array(2);
  private readonly previousRecordInputs = new Float64Array(2);
  private readonly previousAdAaInputs = new Float64Array(2);
  private readonly hissLowStates = new Float64Array(2);
  private readonly hissBandStates = new Float64Array(2);
  private readonly randomStates = new Uint32Array(2);
  private readonly current = new Float64Array(6);
  private readonly target = new Float64Array(6);
  private readonly smoothingCoefficient: number;
  private readonly wowPhaseIncrement: number;
  private readonly flutterPhaseIncrement: number;
  private readonly hissLowAlpha: number;
  private readonly hissHighAlpha: number;
  private lastDryLeft = 0;
  private lastDryRight = 0;
  private lastWetLeft = 0;
  private lastWetRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserTapeEchoParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;
    const capacity = Math.ceil(
      3 * 2000 * (1 + MAX_WOW_FRACTION) * this.sampleRate / 1000,
    ) + 8;
    this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
    this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS * this.sampleRate));
    this.wowPhaseIncrement = TWO_PI * WOW_RATE_HZ / this.sampleRate;
    this.flutterPhaseIncrement = TWO_PI * FLUTTER_RATE_HZ / this.sampleRate;
    this.hissLowAlpha = 1 - Math.exp(-TWO_PI * 350 / this.sampleRate);
    this.hissHighAlpha = 1 - Math.exp(-TWO_PI * Math.min(12000, this.sampleRate * 0.45) / this.sampleRate);

    const initialTime = Number.isFinite(parameters.timeMs) ? clamp(parameters.timeMs as number, 20, 2000) : 350;
    const initialFeedback = Number.isFinite(parameters.feedback) ? clamp(parameters.feedback as number, 0, 95) : 35;
    const initialWow = Number.isFinite(parameters.wow) ? clamp(parameters.wow as number, 0, 100) : 15;
    const initialSaturation = Number.isFinite(parameters.saturation) ? clamp(parameters.saturation as number, 0, 100) : 25;
    const initialTone = Number.isFinite(parameters.toneHz) ? clamp(parameters.toneHz as number, 500, 16000) : 6000;
    const initialMix = Number.isFinite(parameters.mix) ? clamp(parameters.mix as number, 0, 100) : 30;

    this.current[TIME] = this.target[TIME] = initialTime;
    this.current[FEEDBACK] = this.target[FEEDBACK] = initialFeedback;
    this.current[WOW] = this.target[WOW] = initialWow;
    this.current[SATURATION] = this.target[SATURATION] = initialSaturation;
    this.current[TONE_ALPHA] = this.target[TONE_ALPHA] = coefficientForTone(initialTone, this.sampleRate);
    this.current[MIX] = this.target[MIX] = initialMix;
    this.randomStates[0] = 0x13579bdf;
    this.randomStates[1] = 0x2468ace1;
    this.phases[0] = 0;
    this.phases[1] = Math.PI * 0.23;
    this.phases[2] = Math.PI * 0.37;
    this.phases[3] = Math.PI * 0.71;
  }

  /** Update smoothed targets; invalid individual controls are ignored. */
  setParameters(parameters: BrowserTapeEchoParameters): void {
    if (Number.isFinite(parameters.timeMs)) this.target[TIME] = clamp(parameters.timeMs as number, 20, 2000);
    if (Number.isFinite(parameters.feedback)) this.target[FEEDBACK] = clamp(parameters.feedback as number, 0, 95);
    if (Number.isFinite(parameters.wow)) this.target[WOW] = clamp(parameters.wow as number, 0, 100);
    if (Number.isFinite(parameters.saturation)) this.target[SATURATION] = clamp(parameters.saturation as number, 0, 100);
    if (Number.isFinite(parameters.toneHz)) this.target[TONE_ALPHA] = coefficientForTone(parameters.toneHz as number, this.sampleRate);
    if (Number.isFinite(parameters.mix)) this.target[MIX] = clamp(parameters.mix as number, 0, 100);
  }

  /** Clear delay and filter history while retaining parameter targets. */
  reset(): void {
    this.buffers[0].fill(0);
    this.buffers[1].fill(0);
    this.writeIndices.fill(0);
    this.feedbackToneStates.fill(0);
    this.reproToneStates.fill(0);
    this.previousRecordInputs.fill(0);
    this.previousAdAaInputs.fill(0);
    this.hissLowStates.fill(0);
    this.hissBandStates.fill(0);
    this.phases[0] = 0;
    this.phases[1] = Math.PI * 0.23;
    this.phases[2] = Math.PI * 0.37;
    this.phases[3] = Math.PI * 0.71;
    this.randomStates[0] = 0x13579bdf;
    this.randomStates[1] = 0x2468ace1;
    this.lastDryLeft = 0;
    this.lastDryRight = 0;
    this.lastWetLeft = 0;
    this.lastWetRight = 0;
    for (let index = 0; index < this.current.length; index += 1) this.current[index] = this.target[index] ?? 0;
  }

  /**
   * Process one frame and expose the colored echo signal without dry/wet mix.
   * The returned wet sample is read via `wetOutputLeft` / `wetOutputRight`.
   */
  processSample(inputLeft: number, inputRight: number): void {
    this.processFrameSample(inputLeft, inputRight);
  }

  /** Last wet-only output from processSample() or the most recent block frame. */
  get wetOutputLeft(): number {
    return this.lastWetLeft;
  }

  /** Last wet-only right output from processSample() or the most recent block frame. */
  get wetOutputRight(): number {
    return this.lastWetRight;
  }

  /**
   * Process planar audio. The loop has no block-size assumptions and contains
   * no typed audio-buffer allocations; caller arrays may alias their outputs.
   */
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
    if (frameCount !== undefined && Number.isFinite(frameCount)) frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));

    for (let frame = 0; frame < frames; frame += 1) {
      this.processFrameSample(inputLeft[frame] ?? 0, inputRight === null ? inputLeft[frame] ?? 0 : inputRight[frame] ?? 0);
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
    this.current[WOW] = (this.current[WOW] ?? 0) + this.smoothingCoefficient * ((this.target[WOW] ?? 0) - (this.current[WOW] ?? 0));
    this.current[SATURATION] = (this.current[SATURATION] ?? 0) + this.smoothingCoefficient * ((this.target[SATURATION] ?? 0) - (this.current[SATURATION] ?? 0));
    this.current[TONE_ALPHA] = (this.current[TONE_ALPHA] ?? 0) + this.smoothingCoefficient * ((this.target[TONE_ALPHA] ?? 0) - (this.current[TONE_ALPHA] ?? 0));
    this.current[MIX] = (this.current[MIX] ?? 0) + this.smoothingCoefficient * ((this.target[MIX] ?? 0) - (this.current[MIX] ?? 0));

    const timeMs = this.current[TIME] ?? 350;
    const feedback = ((this.current[FEEDBACK] ?? 0) * 0.01) * FEEDBACK_STABILITY_SCALE;
    const wow = (this.current[WOW] ?? 0) * 0.01;
    const saturation = (this.current[SATURATION] ?? 0) * 0.01;
    const toneAlpha = this.current[TONE_ALPHA] ?? 0;
    const baseDelay = timeMs * this.sampleRate * 0.001;
    const lfoLeft = 0.75 * Math.sin(this.phases[0] ?? 0) + 0.25 * Math.sin(this.phases[2] ?? 0);
    const lfoRight = 0.75 * Math.sin(this.phases[1] ?? 0) + 0.25 * Math.sin(this.phases[3] ?? 0);
    const dryLeft = finiteBounded(inputLeft, MAX_INPUT_MAGNITUDE);
    const dryRight = finiteBounded(inputRight, MAX_INPUT_MAGNITUDE);
    this.lastDryLeft = dryLeft;
    this.lastDryRight = dryRight;

    const writeLeft = this.writeIndices[0] ?? 0;
    const writeRight = this.writeIndices[1] ?? 0;
    const modulation1Left = baseDelay * MAX_WOW_FRACTION * wow * lfoLeft;
    const modulation1Right = baseDelay * MAX_WOW_FRACTION * wow * lfoRight;
    const head1Left = this.readFractional(this.buffers[0], writeLeft, baseDelay + modulation1Left);
    const head2Left = this.readFractional(this.buffers[0], writeLeft, 2 * baseDelay + 2 * modulation1Left);
    const head3Left = this.readFractional(this.buffers[0], writeLeft, 3 * baseDelay + 3 * modulation1Left);
    const head1Right = this.readFractional(this.buffers[1], writeRight, baseDelay + modulation1Right);
    const head2Right = this.readFractional(this.buffers[1], writeRight, 2 * baseDelay + 2 * modulation1Right);
    const head3Right = this.readFractional(this.buffers[1], writeRight, 3 * baseDelay + 3 * modulation1Right);

    let feedbackToneLeft = (this.feedbackToneStates[0] ?? 0) + toneAlpha * (head1Left - (this.feedbackToneStates[0] ?? 0));
    let feedbackToneRight = (this.feedbackToneStates[1] ?? 0) + toneAlpha * (head1Right - (this.feedbackToneStates[1] ?? 0));
    feedbackToneLeft = finiteBounded(feedbackToneLeft, MAX_INPUT_MAGNITUDE);
    feedbackToneRight = finiteBounded(feedbackToneRight, MAX_INPUT_MAGNITUDE);
    this.feedbackToneStates[0] = feedbackToneLeft;
    this.feedbackToneStates[1] = feedbackToneRight;

    this.buffers[0][writeLeft] = this.recordWithHiss(dryLeft + feedback * feedbackToneLeft, 0, saturation);
    this.buffers[1][writeRight] = this.recordWithHiss(dryRight + feedback * feedbackToneRight, 1, saturation);

    const rawWetLeft = HEAD_WEIGHTS_1 * head1Left + HEAD_WEIGHTS_2 * head2Left + HEAD_WEIGHTS_3 * head3Left;
    const rawWetRight = HEAD_WEIGHTS_1 * head1Right + HEAD_WEIGHTS_2 * head2Right + HEAD_WEIGHTS_3 * head3Right;
    let reproLeft = (this.reproToneStates[0] ?? 0) + toneAlpha * (rawWetLeft - (this.reproToneStates[0] ?? 0));
    let reproRight = (this.reproToneStates[1] ?? 0) + toneAlpha * (rawWetRight - (this.reproToneStates[1] ?? 0));
    reproLeft = finiteBounded(reproLeft, MAX_INPUT_MAGNITUDE);
    reproRight = finiteBounded(reproRight, MAX_INPUT_MAGNITUDE);
    this.reproToneStates[0] = reproLeft;
    this.reproToneStates[1] = reproRight;
    this.lastWetLeft = reproLeft;
    this.lastWetRight = reproRight;

    let nextWriteLeft = writeLeft + 1;
    let nextWriteRight = writeRight + 1;
    const capacity = this.buffers[0].length;
    if (nextWriteLeft >= capacity) nextWriteLeft = 0;
    if (nextWriteRight >= capacity) nextWriteRight = 0;
    this.writeIndices[0] = nextWriteLeft;
    this.writeIndices[1] = nextWriteRight;

    let wowLeft = (this.phases[0] ?? 0) + this.wowPhaseIncrement;
    let wowRight = (this.phases[1] ?? 0) + this.wowPhaseIncrement;
    let flutterLeft = (this.phases[2] ?? 0) + this.flutterPhaseIncrement;
    let flutterRight = (this.phases[3] ?? 0) + this.flutterPhaseIncrement;
    if (wowLeft >= TWO_PI) wowLeft -= TWO_PI;
    if (wowRight >= TWO_PI) wowRight -= TWO_PI;
    if (flutterLeft >= TWO_PI) flutterLeft -= TWO_PI;
    if (flutterRight >= TWO_PI) flutterRight -= TWO_PI;
    this.phases[0] = wowLeft;
    this.phases[1] = wowRight;
    this.phases[2] = flutterLeft;
    this.phases[3] = flutterRight;
  }

  private readFractional(buffer: Float32Array, writeIndex: number, requestedDelay: number): number {
    const delay = clamp(requestedDelay, 2, buffer.length - 3);
    const integerDelay = Math.floor(delay);
    const fraction = delay - integerDelay;
    let indexMinus1 = writeIndex - integerDelay + 1;
    let index0 = writeIndex - integerDelay;
    let indexPlus1 = writeIndex - integerDelay - 1;
    let indexPlus2 = writeIndex - integerDelay - 2;
    if (indexMinus1 < 0) indexMinus1 += buffer.length;
    if (index0 < 0) index0 += buffer.length;
    if (indexPlus1 < 0) indexPlus1 += buffer.length;
    if (indexPlus2 < 0) indexPlus2 += buffer.length;

    const hMinus1 = -(fraction * (fraction - 1) * (fraction - 2)) / 6;
    const h0 = ((fraction + 1) * (fraction - 1) * (fraction - 2)) / 2;
    const hPlus1 = -((fraction + 1) * fraction * (fraction - 2)) / 2;
    const hPlus2 = ((fraction + 1) * fraction * (fraction - 1)) / 6;
    return hMinus1 * (buffer[indexMinus1] ?? 0) +
      h0 * (buffer[index0] ?? 0) +
      hPlus1 * (buffer[indexPlus1] ?? 0) +
      hPlus2 * (buffer[indexPlus2] ?? 0);
  }

  private recordWithHiss(input: number, channel: number, saturation: number): number {
    const white = this.nextNoise(channel);
    const lowState = (this.hissLowStates[channel] ?? 0) + this.hissLowAlpha * (white - (this.hissLowStates[channel] ?? 0));
    this.hissLowStates[channel] = lowState;
    const highPassed = white - lowState;
    const bandState = (this.hissBandStates[channel] ?? 0) + this.hissHighAlpha * (highPassed - (this.hissBandStates[channel] ?? 0));
    this.hissBandStates[channel] = bandState;
    const boundedInput = finiteBounded(input + bandState * HISS_AMPLITUDE, MAX_INPUT_MAGNITUDE);

    if (saturation <= 1e-6) {
      this.previousRecordInputs[channel] = boundedInput;
      this.previousAdAaInputs[channel] = boundedInput;
      return boundedInput;
    }

    const previous = this.previousRecordInputs[channel] ?? 0;
    const midpoint = 0.5 * (previous + boundedInput);
    const midpointSaturated = this.adaa(midpoint, channel, saturation);
    const currentSaturated = this.adaa(boundedInput, channel, saturation);
    this.previousRecordInputs[channel] = boundedInput;
    return finiteBounded(0.5 * (midpointSaturated + currentSaturated), MAX_INPUT_MAGNITUDE);
  }

  private adaa(input: number, channel: number, saturation: number): number {
    const previous = this.previousAdAaInputs[channel] ?? 0;
    const delta = input - previous;
    this.previousAdAaInputs[channel] = input;
    if (Math.abs(delta) < 1e-5) return this.softSaturator(0.5 * (input + previous), saturation);
    return (this.saturationPrimitive(input, saturation) - this.saturationPrimitive(previous, saturation)) / delta;
  }

  private softSaturator(input: number, saturation: number): number {
    if (saturation <= 1e-6) return input;
    const drive = 1 + 7 * saturation;
    return (1 - saturation) * input + saturation * Math.tanh(drive * input) / drive;
  }

  private saturationPrimitive(input: number, saturation: number): number {
    if (saturation <= 1e-6) return 0.5 * input * input;
    const drive = 1 + 7 * saturation;
    const magnitude = Math.abs(drive * input);
    const logCosh = magnitude + Math.log1p(Math.exp(-2 * magnitude)) - LOG_TWO;
    return 0.5 * (1 - saturation) * input * input + saturation * logCosh / (drive * drive);
  }

  private nextNoise(channel: number): number {
    let state = this.randomStates[channel] ?? 1;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    this.randomStates[channel] = state;
    return (state / 0x7fffffff) - 1;
  }
}
