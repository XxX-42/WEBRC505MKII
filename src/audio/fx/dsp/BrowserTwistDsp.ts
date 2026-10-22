import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

/**
 * Clean-room TWIST kernel (catalog source #43).
 *
 * The source describes one nonlinear macro coupling delay/rate, feedback,
 * filtering and pan. Its matrix CSV is not present in this checkout, so this
 * is an authored functional mapping, not a recovered device law: amount is a
 * signed macro position, and Smooth/Rise/Fall/Stepped are four deterministic
 * transfer curves over that position. Automating amount moves a stereo
 * four-point Lagrange read head, producing the expected Doppler pitch sweep.
 * The feedback record path uses tanh and a conservative Lagrange gain margin;
 * cutoff and stereo balance follow the same macro position.
 *
 * All trajectory tables and delay storage are prepared in the constructor.
 * processSample is allocation-free and independent of render-block size.
 */

export interface BrowserTwistParameters {
  /** Signed macro position, -100..100. */
  amount?: number;
  /** 0 Smooth, 1 Rise, 2 Fall, 3 Stepped. */
  trajectory?: number;
}

const TWO_PI = Math.PI * 2;
const MAX_SAMPLE_RATE = 192_000;
const MAX_DELAY_MS = 300;
const MIN_DELAY_MS = 30;
const CENTER_DELAY_MS = 120;
const PARAMETER_SMOOTHING_SECONDS = 0.02;
const MAX_INPUT_MAGNITUDE = 8;
const FEEDBACK_STABILITY_MARGIN = 0.72;
const TABLE_POINTS = 1024;
const TABLE_STRIDE = 5; // mapped position, positive/negative delay, feedback, one-pole alpha

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteBounded(value: number, maxMagnitude: number): number {
  return Number.isFinite(value) ? clamp(value, -maxMagnitude, maxMagnitude) : 0;
}

function transfer(amount: number, trajectory: number): number {
  const magnitude = Math.abs(amount);
  let shaped: number;
  switch (trajectory) {
    case 1: shaped = Math.sqrt(magnitude); break; // quick initial rise, then eases
    case 2: shaped = magnitude * magnitude; break; // eases in, then falls faster
    case 3: shaped = Math.round(magnitude * 8) / 8; break;
    default: shaped = magnitude * magnitude * (3 - (2 * magnitude)); break; // smoothstep
  }
  return Math.sign(amount) * shaped;
}

/** Bounded stereo variable-rate delay with coupled filter, feedback and pan. */
export class BrowserTwistDsp {
  readonly sampleRate: number;
  private readonly buffers: readonly [Float32Array, Float32Array];
  /** Four precomputed trajectory tables, each with TABLE_POINTS + endpoint. */
  private readonly trajectories: readonly [Float32Array, Float32Array, Float32Array, Float32Array];
  private writeFrame = 0;
  private readonly feedbackFilter = new Float64Array(2);
  private readonly smoothingCoefficient: number;
  private amountCurrent = 0;
  private amountTarget = 0;
  private trajectoryCurrent = 0;
  private trajectoryTarget = 0;
  private lastWetLeft = 0;
  private lastWetRight = 0;
  private lastDelayMs = CENTER_DELAY_MS;
  private lastFeedback = 0.16;
  private officialEnabled = false;
  private officialActive = false;
  private officialRise = 50;
  private officialFall = 50;
  private officialRelease = 0;
  private officialPhase = 0;
  private officialFadeRemaining = 0;
  private readonly officialRotation = new LinearParameterSmoother(0);

  /** Authored continuous rotation, unlike the legacy manually positioned macro. */
  setOfficialParameters(parameters: { rise?: number; fall?: number; release?: number }): void {
    const first = !this.officialEnabled;
    this.officialEnabled = true;
    if (Number.isFinite(parameters.rise)) this.officialRise = clamp(parameters.rise!, 0, 100);
    if (Number.isFinite(parameters.fall)) this.officialFall = clamp(parameters.fall!, 0, 100);
    if (Number.isFinite(parameters.release)) this.officialRelease = parameters.release === 1 ? 1 : 0;
    if (first) this.setOfficialActive(true);
  }

  get officialReleaseFrames(): number {
    return this.officialRelease === 1 ? Math.max(1, Math.round(this.sampleRate * 0.002 * 2500 ** (this.officialFall / 100))) : 16;
  }

  setOfficialActive(active: boolean): void {
    if (!this.officialEnabled || active === this.officialActive) return;
    this.officialActive = active;
    if (active) {
      this.officialPhase = 0;
      this.officialRotation.reset(0);
      this.officialRotation.setTarget(1, Math.round(this.sampleRate * 0.002 * 1000 ** (this.officialRise / 100)));
      this.officialFadeRemaining = 0;
    } else if (this.officialRelease === 1) {
      this.officialFadeRemaining = this.officialReleaseFrames;
    } else {
      this.officialRotation.reset(0);
      this.officialFadeRemaining = 0;
    }
  }

  constructor(sampleRate = 48_000, parameters: BrowserTwistParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, 8_000, MAX_SAMPLE_RATE)
      : 48_000;
    const capacity = Math.ceil((MAX_DELAY_MS * this.sampleRate) / 1000) + 8;
    this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
    this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS * this.sampleRate));
    this.trajectories = [
      new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
      new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
      new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
      new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
    ];
    this.buildTrajectoryTables();
    this.setParameters(parameters);
    this.amountCurrent = this.amountTarget;
    this.trajectoryCurrent = this.trajectoryTarget;
  }

  private buildTrajectoryTables(): void {
    for (let mode = 0; mode < this.trajectories.length; mode += 1) {
      const table = this.trajectories[mode]!;
      for (let point = 0; point <= TABLE_POINTS; point += 1) {
        const magnitude = point / TABLE_POINTS;
        const mappedMagnitude = transfer(magnitude, mode);
        const positiveDelay = CENTER_DELAY_MS * Math.pow(MIN_DELAY_MS / CENTER_DELAY_MS, mappedMagnitude);
        const negativeDelay = CENTER_DELAY_MS * Math.pow(MAX_DELAY_MS / CENTER_DELAY_MS, mappedMagnitude);
        const feedback = 0.16 + (0.66 * Math.pow(mappedMagnitude, 1.15));
        const cutoffHz = 7_800 * Math.pow(0.1, mappedMagnitude);
        const alpha = 1 - Math.exp(-TWO_PI * Math.min(cutoffHz, this.sampleRate * 0.45) / this.sampleRate);
        const offset = point * TABLE_STRIDE;
        table[offset] = mappedMagnitude;
        table[offset + 1] = positiveDelay;
        table[offset + 2] = negativeDelay;
        table[offset + 3] = feedback;
        table[offset + 4] = alpha;
      }
    }
  }

  /** Update bounded smoothed targets; discrete trajectory changes are also smoothed. */
  setParameters(parameters: BrowserTwistParameters): void {
    if (Number.isFinite(parameters.amount)) this.amountTarget = clamp(parameters.amount as number, -100, 100);
    if (Number.isFinite(parameters.trajectory)) this.trajectoryTarget = Math.round(clamp(parameters.trajectory as number, 0, 3));
  }

  /** Process one stereo frame and expose wet-only samples through the getters. */
  processSample(inputLeft: number, inputRight: number): void {
    this.amountCurrent += this.smoothingCoefficient * (this.amountTarget - this.amountCurrent);
    this.trajectoryCurrent += this.smoothingCoefficient * (this.trajectoryTarget - this.trajectoryCurrent);
    let signedMacro = clamp(this.amountCurrent / 100, -1, 1);
    if (this.officialEnabled) {
      const rotation = this.officialRotation.next();
      if (this.officialActive || this.officialFadeRemaining > 0) {
        this.officialPhase = (this.officialPhase + TWO_PI * (0.4 + 7.6 * rotation * rotation) / this.sampleRate) % TWO_PI;
        if (!this.officialActive) this.officialFadeRemaining -= 1;
      }
      signedMacro = rotation * Math.sin(this.officialPhase);
    }
    const tablePosition = Math.abs(signedMacro) * TABLE_POINTS;
    const point = Math.min(TABLE_POINTS - 1, Math.floor(tablePosition));
    const fraction = tablePosition - point;
    const modeA = this.officialEnabled ? 0 : Math.floor(this.trajectoryCurrent);
    const modeB = Math.min(3, modeA + 1);
    const modeBlend = this.officialEnabled ? 0 : this.trajectoryCurrent - modeA;
    const tableA = this.trajectories[modeA as 0 | 1 | 2 | 3]!;
    const tableB = this.trajectories[modeB as 0 | 1 | 2 | 3]!;
    const offset0 = point * TABLE_STRIDE;
    const offset1 = (point + 1) * TABLE_STRIDE;
    let mappedMagnitude = 0;
    let positiveDelayMs = CENTER_DELAY_MS;
    let negativeDelayMs = CENTER_DELAY_MS;
    let feedback = 0.16;
    let alpha = 0.5;
    for (let control = 0; control < TABLE_STRIDE; control += 1) {
      const a0 = tableA[offset0 + control] ?? 0;
      const a1 = tableA[offset1 + control] ?? 0;
      const b0 = tableB[offset0 + control] ?? a0;
      const b1 = tableB[offset1 + control] ?? a1;
      const curveA = a0 + ((a1 - a0) * fraction);
      const curveB = b0 + ((b1 - b0) * fraction);
      const value = curveA + ((curveB - curveA) * modeBlend);
      if (control === 0) mappedMagnitude = value;
      else if (control === 1) positiveDelayMs = value;
      else if (control === 2) negativeDelayMs = value;
      else if (control === 3) feedback = value;
      else if (control === 4) alpha = value;
    }
    const mapped = signedMacro < 0 ? -mappedMagnitude : mappedMagnitude;
    const delayMs = signedMacro < 0 ? negativeDelayMs : positiveDelayMs;

    const delayFrames = clamp((delayMs * this.sampleRate) / 1000, 4, this.buffers[0].length - 3);
    const delay = Math.floor(delayFrames);
    const fractionDelay = delayFrames - delay;
    const dryLeft = finiteBounded(inputLeft, MAX_INPUT_MAGNITUDE);
    const dryRight = finiteBounded(inputRight, MAX_INPUT_MAGNITUDE);
    const delayedLeft = this.readFractional(this.buffers[0], delay, fractionDelay);
    const delayedRight = this.readFractional(this.buffers[1], delay, fractionDelay);
    const leftFeedbackState = this.feedbackFilter[0] ?? 0;
    const rightFeedbackState = this.feedbackFilter[1] ?? 0;
    const leftFilter = leftFeedbackState + alpha * (delayedLeft - leftFeedbackState);
    const rightFilter = rightFeedbackState + alpha * (delayedRight - rightFeedbackState);
    this.feedbackFilter[0] = finiteBounded(leftFilter, MAX_INPUT_MAGNITUDE);
    this.feedbackFilter[1] = finiteBounded(rightFilter, MAX_INPUT_MAGNITUDE);
    const boundedFeedback = clamp(feedback, 0, 0.84) * FEEDBACK_STABILITY_MARGIN;
    const writeLeft = dryLeft + (boundedFeedback * Math.tanh(this.feedbackFilter[0] * 1.5));
    const writeRight = dryRight + (boundedFeedback * Math.tanh(this.feedbackFilter[1] * 1.5));
    const capacity = this.buffers[0].length;
    const writeIndex = this.writeFrame;
    this.buffers[0][writeIndex] = finiteBounded(writeLeft, MAX_INPUT_MAGNITUDE);
    this.buffers[1][writeIndex] = finiteBounded(writeRight, MAX_INPUT_MAGNITUDE);
    this.writeFrame = writeIndex + 1 === capacity ? 0 : writeIndex + 1;

    const pan = clamp(mapped, -1, 1);
    const leftGain = pan > 0 ? Math.cos(pan * Math.PI * 0.5) : 1;
    const rightGain = pan < 0 ? Math.cos(-pan * Math.PI * 0.5) : 1;
    this.lastWetLeft = finiteBounded(this.feedbackFilter[0] * leftGain, MAX_INPUT_MAGNITUDE);
    this.lastWetRight = finiteBounded(this.feedbackFilter[1] * rightGain, MAX_INPUT_MAGNITUDE);
    this.lastDelayMs = delayMs;
    this.lastFeedback = boundedFeedback;
  }

  private readFractional(buffer: Float32Array, delay: number, fraction: number): number {
    const capacity = buffer.length;
    const indexMinus1 = (this.writeFrame - delay + 1 + capacity) % capacity;
    const index0 = (this.writeFrame - delay + capacity) % capacity;
    const indexPlus1 = (this.writeFrame - delay - 1 + capacity) % capacity;
    const indexPlus2 = (this.writeFrame - delay - 2 + capacity) % capacity;
    return lagrange4(
      buffer[indexMinus1] ?? 0,
      buffer[index0] ?? 0,
      buffer[indexPlus1] ?? 0,
      buffer[indexPlus2] ?? 0,
      fraction,
    );
  }

  get wetOutputLeft(): number { return this.lastWetLeft; }
  get wetOutputRight(): number { return this.lastWetRight; }
  /** Read-only test/diagnostic values; these do not change DSP state. */
  get currentDelayMs(): number { return this.lastDelayMs; }
  get currentFeedbackGain(): number { return this.lastFeedback; }

  reset(): void {
    this.buffers[0].fill(0);
    this.buffers[1].fill(0);
    this.writeFrame = 0;
    this.feedbackFilter.fill(0);
    this.lastWetLeft = 0;
    this.lastWetRight = 0;
    this.amountCurrent = this.amountTarget;
    this.trajectoryCurrent = this.trajectoryTarget;
    this.lastDelayMs = CENTER_DELAY_MS;
    this.lastFeedback = 0.16;
    this.officialPhase = 0;
    this.officialFadeRemaining = 0;
    this.officialRotation.reset(0);
    if (this.officialActive) this.officialRotation.setTarget(1, Math.round(this.sampleRate * 0.002 * 1000 ** (this.officialRise / 100)));
  }
}

function lagrange4(xMinus1: number, x0: number, xPlus1: number, xPlus2: number, fraction: number): number {
  const mu = clamp(fraction, 0, 1);
  const cMinus1 = -mu * (mu - 1) * (mu - 2) / 6;
  const c0 = (mu + 1) * (mu - 1) * (mu - 2) / 2;
  const cPlus1 = -(mu + 1) * mu * (mu - 2) / 2;
  const cPlus2 = (mu + 1) * mu * (mu - 1) / 6;
  return xMinus1 * cMinus1 + x0 * c0 + xPlus1 * cPlus1 + xPlus2 * cPlus2;
}
