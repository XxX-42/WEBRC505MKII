import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';
import { TptStateVariableFilter } from '../../dsp/TptStateVariableFilter';

export interface BrowserOfficialReverseReverbParameters {
  /** TIME, 0.1..10 seconds. */
  timeSeconds?: number;
  /** PRE DELAY, 0..500 milliseconds, independent of GATE TIME. */
  preDelayMs?: number;
  /** GATE TIME, 0.1..1 seconds before the rising tail starts. */
  gateTimeSeconds?: number;
  /** LOW CUT, 20..12500 Hz; -1000 selects FLAT. */
  lowCutHz?: number;
  /** HIGH CUT, 20..12500 Hz; -1000 selects FLAT. */
  highCutHz?: number;
}

const FLAT = -1000;
const TAP_COUNT = 128;
const LINE_COUNT = 16;
const MAX_MAGNITUDE = 8;
const DIFFUSER_RT60_SECONDS = 0.15;
const DIFFUSER_RT60_CALIBRATION = 1.14;
const REFERENCE_DELAY_FRAMES = [
  1493, 1747, 2011, 2267, 2521, 2777, 3037, 3299,
  3557, 3821, 4073, 4327, 4583, 4861, 5099, 5351,
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function bounded(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_MAGNITUDE, MAX_MAGNITUDE) : 0;
}

function nextPrime(value: number): number {
  if (value <= 2) return 2;
  let candidate = value % 2 === 0 ? value + 1 : value;
  for (;;) {
    let prime = true;
    for (let divisor = 3; divisor * divisor <= candidate; divisor += 2) {
      if (candidate % divisor === 0) { prime = false; break; }
    }
    if (prime) return candidate;
    candidate += 2;
  }
}

/**
 * Clean-room implementation of the manual's fading-IN gated REVERSE REVERB.
 * This never captures or reverses source segments. A true input pre-delay
 * feeds a short, orthogonal 16-line stereo FDN diffuser (0.15 s RT60), followed
 * by a finite rising kernel and wet-only low/high cuts. D.LEVEL and E.LEVEL
 * belong to the host: this primitive emits only the wet return.
 *
 * The authored kernel agrees with NativeOfficialReverseReverb: 128 taps at
 * GATE TIME + TIME * i/127, with weights proportional to .0125 + (i/127)^2,
 * energy normalization and independently signed stereo projections. TIME
 * controls the kernel duration, not source-buffer length or feedback decay.
 * The upstream diffuser contributes a short residual tail after the final
 * tap. The topology, signs and gain law are not claims of factory-tone parity.
 *
 * Storage is allocated only at construction: 11 seconds of stereo tap history,
 * 500 ms stereo pre-delay, fixed FDN lines and reusable scalar/filter state.
 * Processing and parameter updates allocate no arrays and never clear source
 * history. Changes ramp for 15 ms; unchanged updates do not restart ramps.
 * reset() alone clears all audible state and snaps controls to their targets.
 */
export class BrowserOfficialReverseReverbDsp {
  readonly sampleRate: number;
  readonly maxBufferSamples: number;
  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;

  private readonly historyLeft: Float32Array;
  private readonly historyRight: Float32Array;
  private readonly preDelayLeft: Float32Array;
  private readonly preDelayRight: Float32Array;
  private readonly lines: readonly Float32Array[];
  private readonly lineIndices = new Int32Array(LINE_COUNT);
  private readonly dampingStates = new Float64Array(LINE_COUNT);
  private readonly feedbackGains = new Float64Array(LINE_COUNT);
  private readonly feedbackScratch = new Float64Array(LINE_COUNT);
  private readonly tapOffsets = new Float64Array(TAP_COUNT);
  private readonly weightsLeft = new Float64Array(TAP_COUNT);
  private readonly weightsRight = new Float64Array(TAP_COUNT);
  private readonly lowCutLeft: TptStateVariableFilter;
  private readonly lowCutRight: TptStateVariableFilter;
  private readonly highCutLeft: TptStateVariableFilter;
  private readonly highCutRight: TptStateVariableFilter;
  private readonly time = new LinearParameterSmoother(3);
  private readonly gate = new LinearParameterSmoother(0.5);
  // 500 ms is the visually verified manual default, not an inferred zero.
  private readonly preDelay = new LinearParameterSmoother(500);
  private readonly lowCut = new LinearParameterSmoother(20);
  private readonly highCut = new LinearParameterSmoother(12500);
  private readonly rampFrames: number;
  private readonly dampingAlpha: number;
  private lowCutFlat = true;
  private highCutFlat = true;
  private writeIndex = 0;
  private preDelayWriteIndex = 0;
  private diffuseLeft = 0;
  private diffuseRight = 0;

  constructor(sampleRate: number, parameters: BrowserOfficialReverseReverbParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) ? Math.round(clamp(sampleRate, 8000, 192000)) : 48000;
    this.rampFrames = Math.max(1, Math.round(this.sampleRate * 0.015));
    const historyCapacity = Math.ceil(11 * this.sampleRate) + 4;
    this.historyLeft = new Float32Array(historyCapacity);
    this.historyRight = new Float32Array(historyCapacity);
    const preDelayCapacity = Math.ceil(this.sampleRate * 0.5) + 2;
    this.preDelayLeft = new Float32Array(preDelayCapacity);
    this.preDelayRight = new Float32Array(preDelayCapacity);
    this.lines = REFERENCE_DELAY_FRAMES.map((frames) => new Float32Array(
      nextPrime(Math.max(2, Math.round(frames * this.sampleRate / 48000))),
    ));
    this.dampingAlpha = Math.exp(-2 * Math.PI * Math.min(8000, this.sampleRate * 0.45) / this.sampleRate);
    let lineSamples = 0;
    for (let line = 0; line < LINE_COUNT; line += 1) {
      const length = this.lines[line]!.length;
      lineSamples += length;
      this.feedbackGains[line] = Math.pow(0.001,
        length / this.sampleRate / (DIFFUSER_RT60_SECONDS * DIFFUSER_RT60_CALIBRATION));
    }
    this.maxBufferSamples = 2 * (historyCapacity + preDelayCapacity) + lineSamples
      + 4 * LINE_COUNT + 3 * TAP_COUNT;
    this.lowCutLeft = new TptStateVariableFilter(this.sampleRate, 20);
    this.lowCutRight = new TptStateVariableFilter(this.sampleRate, 20);
    this.highCutLeft = new TptStateVariableFilter(this.sampleRate, Math.min(12500, this.sampleRate * 0.45));
    this.highCutRight = new TptStateVariableFilter(this.sampleRate, Math.min(12500, this.sampleRate * 0.45));
    this.initializeWeights();
    this.setParameters(parameters);
    this.reset();
  }

  /** Earliest impulse onset once the configured timing controls have settled. */
  get latencySamples(): number {
    return Math.floor(this.preDelay.targetValue * this.sampleRate / 1000)
      + Math.floor(this.gate.targetValue * this.sampleRate) + this.lines[0]!.length;
  }

  get bufferCapacitySamples(): number { return this.historyLeft.length; }

  setParameters(parameters: BrowserOfficialReverseReverbParameters): void {
    this.setTarget(this.time, parameters.timeSeconds, 0.1, 10);
    this.setTarget(this.gate, parameters.gateTimeSeconds, 0.1, 1);
    this.setTarget(this.preDelay, parameters.preDelayMs, 0, 500);
    if (Number.isFinite(parameters.lowCutHz)) {
      this.lowCutFlat = parameters.lowCutHz === FLAT;
      if (!this.lowCutFlat) this.setTarget(this.lowCut, parameters.lowCutHz, 20, 12500);
    }
    if (Number.isFinite(parameters.highCutHz)) {
      this.highCutFlat = parameters.highCutHz === FLAT;
      if (!this.highCutFlat) this.setTarget(this.highCut, parameters.highCutHz, 20, 12500);
    }
  }

  /** Mutates and returns this reusable wet result; there are no render allocations. */
  processSample(left: number, right: number): this {
    const duration = this.time.next();
    const onset = this.gate.next();
    const preDelayFrames = this.preDelay.next() * this.sampleRate / 1000;
    const lowHz = this.lowCut.next();
    const highHz = this.highCut.next();
    if ((this.framesProcessed % 8) === 0) {
      this.updateTapOffsets(duration, onset);
      this.updateFilters(lowHz, highHz);
    }

    this.preDelayLeft[this.preDelayWriteIndex] = bounded(left);
    this.preDelayRight[this.preDelayWriteIndex] = bounded(right);
    const delayedLeft = this.readDelay(this.preDelayLeft, this.preDelayWriteIndex, preDelayFrames);
    const delayedRight = this.readDelay(this.preDelayRight, this.preDelayWriteIndex, preDelayFrames);
    this.processDiffuser(delayedLeft, delayedRight);
    this.historyLeft[this.writeIndex] = this.diffuseLeft;
    this.historyRight[this.writeIndex] = this.diffuseRight;

    let wetLeft = 0;
    let wetRight = 0;
    for (let tap = 0; tap < TAP_COUNT; tap += 1) {
      const offset = this.tapOffsets[tap]!;
      const l = this.readDelay(this.historyLeft, this.writeIndex, offset);
      const r = this.readDelay(this.historyRight, this.writeIndex, offset);
      wetLeft += (0.85 * l + 0.15 * r) * this.weightsLeft[tap]!;
      wetRight += (0.85 * r + 0.15 * l) * this.weightsRight[tap]!;
    }
    // Keep bypassed filter histories live, so selecting FLAT is a true bypass
    // and later re-enabling a cut does not revive stale, unrelated audio.
    this.lowCutLeft.processSample(wetLeft);
    this.lowCutRight.processSample(wetRight);
    if (!this.lowCutFlat) {
      wetLeft = this.lowCutLeft.highpass;
      wetRight = this.lowCutRight.highpass;
    }
    this.highCutLeft.processSample(wetLeft);
    this.highCutRight.processSample(wetRight);
    if (!this.highCutFlat) {
      wetLeft = this.highCutLeft.lowpass;
      wetRight = this.highCutRight.lowpass;
    }
    this.wetLeft = bounded(wetLeft);
    this.wetRight = bounded(wetRight);
    this.writeIndex += 1;
    if (this.writeIndex === this.historyLeft.length) this.writeIndex = 0;
    this.preDelayWriteIndex += 1;
    if (this.preDelayWriteIndex === this.preDelayLeft.length) this.preDelayWriteIndex = 0;
    this.framesProcessed += 1;
    return this;
  }

  reset(): void {
    this.historyLeft.fill(0);
    this.historyRight.fill(0);
    this.preDelayLeft.fill(0);
    this.preDelayRight.fill(0);
    for (const line of this.lines) line.fill(0);
    this.lineIndices.fill(0);
    this.dampingStates.fill(0);
    this.feedbackScratch.fill(0);
    this.lowCutLeft.reset();
    this.lowCutRight.reset();
    this.highCutLeft.reset();
    this.highCutRight.reset();
    this.time.reset();
    this.gate.reset();
    this.preDelay.reset();
    this.lowCut.reset();
    this.highCut.reset();
    this.updateTapOffsets(this.time.currentValue, this.gate.currentValue);
    this.updateFilters(this.lowCut.currentValue, this.highCut.currentValue);
    this.writeIndex = 0;
    this.preDelayWriteIndex = 0;
    this.diffuseLeft = 0;
    this.diffuseRight = 0;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.framesProcessed = 0;
  }

  private setTarget(smoother: LinearParameterSmoother, value: number | undefined, minimum: number, maximum: number): void {
    if (value === undefined || !Number.isFinite(value)) return;
    const target = clamp(value, minimum, maximum);
    if (target !== smoother.targetValue) smoother.setTarget(target, this.rampFrames);
  }

  private initializeWeights(): void {
    let energy = 0;
    let random = 0x52565242;
    for (let tap = 0; tap < TAP_COUNT; tap += 1) {
      const position = tap / (TAP_COUNT - 1);
      const weight = 0.0125 + position * position;
      energy += weight * weight;
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      this.weightsLeft[tap] = (random & 0x10000) !== 0 ? weight : -weight;
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      this.weightsRight[tap] = (random & 0x10000) !== 0 ? weight : -weight;
    }
    const normalization = 1 / Math.sqrt(energy);
    for (let tap = 0; tap < TAP_COUNT; tap += 1) {
      this.weightsLeft[tap] = this.weightsLeft[tap]! * normalization;
      this.weightsRight[tap] = this.weightsRight[tap]! * normalization;
    }
  }

  private updateTapOffsets(duration: number, onset: number): void {
    for (let tap = 0; tap < TAP_COUNT; tap += 1) {
      this.tapOffsets[tap] = (onset + duration * tap / (TAP_COUNT - 1)) * this.sampleRate;
    }
  }

  private updateFilters(lowHz: number, highHz: number): void {
    const low = Math.min(lowHz, this.sampleRate * 0.45);
    const high = Math.min(highHz, this.sampleRate * 0.45);
    this.lowCutLeft.setParameters(low);
    this.lowCutRight.setParameters(low);
    this.highCutLeft.setParameters(high);
    this.highCutRight.setParameters(high);
  }

  private readDelay(buffer: Float32Array, writeIndex: number, delay: number): number {
    const whole = Math.floor(delay);
    const fraction = delay - whole;
    let first = writeIndex - whole;
    if (first < 0) first += buffer.length;
    const second = first === 0 ? buffer.length - 1 : first - 1;
    const a = buffer[first]!;
    return a + (buffer[second]! - a) * fraction;
  }

  private processDiffuser(left: number, right: number): void {
    let wetLeft = 0;
    let wetRight = 0;
    for (let line = 0; line < LINE_COUNT; line += 1) {
      const sample = this.lines[line]![this.lineIndices[line]!]!;
      let damped = (1 - this.dampingAlpha) * sample + this.dampingAlpha * this.dampingStates[line]!;
      if (Math.abs(damped) < 1e-20) damped = 0;
      this.dampingStates[line] = damped;
      this.feedbackScratch[line] = damped;
      const outputLeftSign = (line & 2) === 0 ? 1 : -1;
      const outputRightSign = ((line & 1) !== 0) !== ((line & 2) !== 0) ? -1 : 1;
      wetLeft += sample * outputLeftSign * 0.25;
      wetRight += sample * outputRightSign * 0.25;
    }
    // In-place orthogonal H16 butterfly, normalized by 1/sqrt(16) on write.
    for (let width = 1; width < LINE_COUNT; width *= 2) {
      for (let block = 0; block < LINE_COUNT; block += width * 2) {
        for (let offset = 0; offset < width; offset += 1) {
          const first = this.feedbackScratch[block + offset]!;
          const second = this.feedbackScratch[block + offset + width]!;
          this.feedbackScratch[block + offset] = first + second;
          this.feedbackScratch[block + offset + width] = first - second;
        }
      }
    }
    for (let line = 0; line < LINE_COUNT; line += 1) {
      const inputRightSign = (line & 1) === 0 ? 1 : -1;
      const value = 0.25 * (left + inputRightSign * right)
        + this.feedbackGains[line]! * this.feedbackScratch[line]! * 0.25;
      const buffer = this.lines[line]!;
      const index = this.lineIndices[line]!;
      buffer[index] = bounded(value);
      this.lineIndices[line] = index + 1 === buffer.length ? 0 : index + 1;
    }
    this.diffuseLeft = bounded(wetLeft);
    this.diffuseRight = bounded(wetRight);
  }
}
