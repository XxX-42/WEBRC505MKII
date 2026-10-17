export interface BrowserVinylFlickParameters {
  /** Signed platter offset: -100 is stopped, 0 is nominal 1x, +100 is 2x. */
  speed?: number;
  /** Motor response time in seconds, clamped to 0.05..10. */
  returnTimeSeconds?: number;
  /** Viscous damping percentage; higher values reduce overshoot. */
  brakePercent?: number;
}

const MAX_HISTORY_SECONDS = 4;
const LOOKAHEAD_SAMPLES = 2;
const MIN_RETURN_SECONDS = 0.05;
const MAX_RETURN_SECONDS = 10;
const MAX_RATE = 2;
const MAX_ABS_ACCELERATION = 2_000;
const MIN_PHASE_SLIP_FRAMES = 32;
const PHASE_SLIP_SECONDS = 0.01;

/**
 * Clean-room inertial platter and bounded variable-rate stereo history reader.
 * The capped second-order motor targets playback 0..2x from speed -100..100,
 * with zero as nominal 1x and -100 as a stopped platter. Braking inertia can
 * delay recovery, but the platter never enters reverse playback. Since this is
 * attached to a causal live stream, targets above 1x can only be transient:
 * the reader catches the writer and is safely clamped to available input. A
 * sustained >1x track/loop speed requires a source-aware read-ahead path.
 * Four-point Lagrange interpolation uses a two-sample lookahead; the dry path
 * receives the same two samples of delay to avoid a wet/dry comb at 1x. A fixed
 * 4-second ring bounds memory. A 10 ms linear phase-slip crossfade reanchors
 * slow/stalled reads before the ring edge is overwritten, so sustained controls
 * remain finite and audible instead of falling silent. Storage is preallocated;
 * processSample performs no allocation.
 */
export class BrowserVinylFlickDsp {
  readonly sampleRate: number;
  readonly maxHistoryFrames: number;
  readonly algorithmicLatencySamples = LOOKAHEAD_SAMPLES;
  readonly phaseSlipFrames: number;

  wetLeft = 0;
  wetRight = 0;
  dryLeft = 0;
  dryRight = 0;
  framesProcessed = 0;
  historyEdgeHits = 0;
  phaseSlipCount = 0;

  private readonly historyLeft: Float32Array;
  private readonly historyRight: Float32Array;
  private speedTarget = 0;
  private returnTimeSeconds = 1.5;
  private brakePercent = 35;
  private motorRate = 1;
  private motorVelocity = 0;
  private writeFrame = 0;
  private readPosition = -LOOKAHEAD_SAMPLES;
  private phaseSlipRemaining = 0;

  constructor(sampleRate: number, parameters: BrowserVinylFlickParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.maxHistoryFrames = Math.max(16, Math.ceil(this.sampleRate * MAX_HISTORY_SECONDS));
    this.phaseSlipFrames = Math.max(MIN_PHASE_SLIP_FRAMES, Math.round(this.sampleRate * PHASE_SLIP_SECONDS));
    this.historyLeft = new Float32Array(this.maxHistoryFrames);
    this.historyRight = new Float32Array(this.maxHistoryFrames);
    this.setParameters(parameters);
  }

  get diagnostics(): Readonly<{
    framesProcessed: number;
    readPosition: number;
    motorRate: number;
    motorVelocity: number;
    speedTargetRate: number;
    returnTimeSeconds: number;
    brakePercent: number;
    maxHistoryFrames: number;
    historyEdgeHits: number;
    phaseSlipCount: number;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      readPosition: this.readPosition,
      motorRate: this.motorRate,
      motorVelocity: this.motorVelocity,
      speedTargetRate: this.speedForControl(this.speedTarget),
      returnTimeSeconds: this.returnTimeSeconds,
      brakePercent: this.brakePercent,
      maxHistoryFrames: this.maxHistoryFrames,
      historyEdgeHits: this.historyEdgeHits,
      phaseSlipCount: this.phaseSlipCount,
    };
  }

  setParameters(parameters: BrowserVinylFlickParameters): void {
    if (Number.isFinite(parameters.speed)) {
      this.speedTarget = Math.max(-100, Math.min(100, parameters.speed as number));
    }
    if (Number.isFinite(parameters.returnTimeSeconds)) {
      this.returnTimeSeconds = Math.max(MIN_RETURN_SECONDS, Math.min(MAX_RETURN_SECONDS, parameters.returnTimeSeconds as number));
    }
    if (Number.isFinite(parameters.brakePercent)) {
      this.brakePercent = Math.max(0, Math.min(100, parameters.brakePercent as number));
    }
  }

  /** Mutates output fields and retains bounded stereo input history. */
  processSample(left: number, right: number): void {
    const frame = this.writeFrame;
    const writeIndex = frame % this.maxHistoryFrames;
    this.historyLeft[writeIndex] = Number.isFinite(left) ? left : 0;
    this.historyRight[writeIndex] = Number.isFinite(right) ? right : 0;

    const dryFrame = frame - LOOKAHEAD_SAMPLES;
    if (dryFrame >= 0) {
      const dryIndex = dryFrame % this.maxHistoryFrames;
      this.dryLeft = this.historyLeft[dryIndex] ?? 0;
      this.dryRight = this.historyRight[dryIndex] ?? 0;
    } else {
      this.dryLeft = 0;
      this.dryRight = 0;
    }

    this.advanceMotor();

    let oldestFrame = frame - this.maxHistoryFrames + 1;
    if (oldestFrame < 0) oldestFrame = 0;
    const latestReadPosition = frame - LOOKAHEAD_SAMPLES;
    if (frame >= LOOKAHEAD_SAMPLES) {
      if (this.readPosition > latestReadPosition) this.readPosition = latestReadPosition;
      const distanceToOldest = this.readPosition - oldestFrame;
      const slipGuard = Math.ceil(Math.max(0, 1 - this.motorRate) * this.phaseSlipFrames) + 2;
      if (oldestFrame > 0 && this.phaseSlipRemaining === 0 && distanceToOldest <= slipGuard) {
        this.phaseSlipRemaining = this.phaseSlipFrames;
        this.historyEdgeHits += 1;
        this.phaseSlipCount += 1;
      }

      let readPosition = this.readPosition;
      if (readPosition < oldestFrame) readPosition = oldestFrame;
      if (readPosition > latestReadPosition) readPosition = latestReadPosition;
      const oldLeft = this.readHistory(this.historyLeft, readPosition, oldestFrame, frame);
      const oldRight = this.readHistory(this.historyRight, readPosition, oldestFrame, frame);
      if (this.phaseSlipRemaining > 0) {
        const progress = (this.phaseSlipFrames - this.phaseSlipRemaining + 1) / this.phaseSlipFrames;
        // A linear crossfade avoids the +3 dB bump of an equal-power curve
        // when the old and re-anchored reads are strongly correlated.
        const oldGain = 1 - progress;
        const liveGain = progress;
        const liveLeft = this.readHistory(this.historyLeft, latestReadPosition, oldestFrame, frame);
        const liveRight = this.readHistory(this.historyRight, latestReadPosition, oldestFrame, frame);
        this.wetLeft = (oldLeft * oldGain) + (liveLeft * liveGain);
        this.wetRight = (oldRight * oldGain) + (liveRight * liveGain);
        this.phaseSlipRemaining -= 1;
        if (this.phaseSlipRemaining === 0) {
          this.readPosition = latestReadPosition + this.motorRate;
          this.clampNextReadPosition(frame);
        } else {
          this.readPosition += this.motorRate;
        }
      } else {
        this.wetLeft = oldLeft;
        this.wetRight = oldRight;
        this.readPosition += this.motorRate;
      }
    } else {
      this.wetLeft = 0;
      this.wetRight = 0;
      this.readPosition += this.motorRate;
    }

    if (!Number.isFinite(this.wetLeft)) this.wetLeft = 0;
    if (!Number.isFinite(this.wetRight)) this.wetRight = 0;
    this.clampNextReadPosition(frame);
    this.writeFrame += 1;
    this.framesProcessed += 1;
  }

  reset(): void {
    this.historyLeft.fill(0);
    this.historyRight.fill(0);
    this.motorRate = 1;
    this.motorVelocity = 0;
    this.writeFrame = 0;
    this.readPosition = -LOOKAHEAD_SAMPLES;
    this.phaseSlipRemaining = 0;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.dryLeft = 0;
    this.dryRight = 0;
    this.framesProcessed = 0;
    this.historyEdgeHits = 0;
    this.phaseSlipCount = 0;
  }

  private advanceMotor(): void {
    const targetRate = this.speedForControl(this.speedTarget);
    const naturalFrequency = Math.min(80, 4 / this.returnTimeSeconds);
    const dampingRatio = 0.55 + (1.65 * (this.brakePercent / 100));
    const acceleration = (naturalFrequency * naturalFrequency * (targetRate - this.motorRate))
      - (2 * dampingRatio * naturalFrequency * this.motorVelocity);
    const boundedAcceleration = Math.max(-MAX_ABS_ACCELERATION, Math.min(MAX_ABS_ACCELERATION, acceleration));
    this.motorVelocity += boundedAcceleration / this.sampleRate;
    this.motorVelocity = Math.max(-200, Math.min(200, this.motorVelocity));
    this.motorRate += this.motorVelocity / this.sampleRate;
    this.motorRate = Math.max(0, Math.min(MAX_RATE, this.motorRate));
    if (!Number.isFinite(this.motorRate) || !Number.isFinite(this.motorVelocity)) {
      this.motorRate = 1;
      this.motorVelocity = 0;
    }
  }

  private speedForControl(speed: number): number {
    return 1 + (speed / 100);
  }

  private clampNextReadPosition(frame: number): void {
    const maximumRead = frame + 1 - LOOKAHEAD_SAMPLES;
    if (this.readPosition > maximumRead) this.readPosition = maximumRead;
  }

  private readHistory(buffer: Float32Array, position: number, oldestFrame: number, latestFrame: number): number {
    const baseFrame = Math.floor(position);
    const fraction = position - baseFrame;
    const sampleMinusOne = this.readFrame(buffer, baseFrame - 1, oldestFrame, latestFrame);
    const sampleZero = this.readFrame(buffer, baseFrame, oldestFrame, latestFrame);
    const samplePlusOne = this.readFrame(buffer, baseFrame + 1, oldestFrame, latestFrame);
    const samplePlusTwo = this.readFrame(buffer, baseFrame + 2, oldestFrame, latestFrame);
    const cMinusOne = -(fraction * (fraction - 1) * (fraction - 2)) / 6;
    const cZero = ((fraction + 1) * (fraction - 1) * (fraction - 2)) / 2;
    const cPlusOne = -((fraction + 1) * fraction * (fraction - 2)) / 2;
    const cPlusTwo = ((fraction + 1) * fraction * (fraction - 1)) / 6;
    return (cMinusOne * sampleMinusOne) + (cZero * sampleZero) + (cPlusOne * samplePlusOne) + (cPlusTwo * samplePlusTwo);
  }

  private readFrame(buffer: Float32Array, frame: number, oldestFrame: number, latestFrame: number): number {
    if (frame < oldestFrame || frame > latestFrame) return 0;
    return buffer[frame % this.maxHistoryFrames] ?? 0;
  }
}
