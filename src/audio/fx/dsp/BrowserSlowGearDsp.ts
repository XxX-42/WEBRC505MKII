import { LinearParameterSmoother } from '../../dsp/LinearParameterSmoother';

/** Provisional clean-room controls for the Browser SLOW GEAR reconstruction. */
export interface BrowserSlowGearParameters {
  attackMs?: number;
  sensitivityPercent?: number;
}

const MIN_ATTACK_MS = 5;
const MAX_ATTACK_MS = 2000;
const DEFAULT_ATTACK_MS = 250;
const MIN_SENSITIVITY_PERCENT = 0;
const MAX_SENSITIVITY_PERCENT = 100;
const DEFAULT_SENSITIVITY_PERCENT = 50;
const ENERGY_WINDOW_SECONDS = 0.004;
const PARAMETER_SMOOTHING_SECONDS = 0.015;
const BASELINE_ATTACK_SECONDS = 0.025;
const BASELINE_RELEASE_SECONDS = 0.35;
const REARM_QUIET_SECONDS = 0.035;
const MINIMUM_BASELINE_ENERGY = 1e-20;
const MAX_DETECTOR_INPUT = 4;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function onePoleAlpha(seconds: number, sampleRate: number): number {
  return Math.exp(-1 / (Math.max(0.001, seconds) * sampleRate));
}

/**
 * Clean-room onset-triggered attack shaper. A rolling short-window mean-square
 * detector compares the current energy with an adaptive inactive baseline.
 * An onset restarts a raised-cosine gain ramp from zero; state advances per
 * sample and is independent of AudioWorklet callback size. The detector uses
 * the current sample directly, so it adds no pipeline samples.
 */
export class BrowserSlowGearDsp {
  readonly sampleRate: number;

  private readonly energyWindow: Float64Array;
  private readonly attackMs: LinearParameterSmoother;
  private readonly sensitivityPercent: LinearParameterSmoother;
  private readonly baselineAttackAlpha: number;
  private readonly baselineReleaseAlpha: number;
  private readonly rearmQuietFrames: number;
  private energyWindowIndex = 0;
  private energyWindowFrames = 0;
  private energyWindowSum = 0;
  private baselineEnergy = 0;
  private activeUntilQuiet = false;
  private quietFrames = 0;
  private rampElapsedFrames = 0;
  private envelope = 0;

  constructor(sampleRate: number, parameters: BrowserSlowGearParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    const initialAttackMs = Number.isFinite(parameters.attackMs)
      ? clamp(parameters.attackMs as number, MIN_ATTACK_MS, MAX_ATTACK_MS)
      : DEFAULT_ATTACK_MS;
    const initialSensitivity = Number.isFinite(parameters.sensitivityPercent)
      ? clamp(parameters.sensitivityPercent as number, MIN_SENSITIVITY_PERCENT, MAX_SENSITIVITY_PERCENT)
      : DEFAULT_SENSITIVITY_PERCENT;
    this.attackMs = new LinearParameterSmoother(initialAttackMs);
    this.sensitivityPercent = new LinearParameterSmoother(initialSensitivity);
    this.energyWindow = new Float64Array(Math.max(1, Math.ceil(this.sampleRate * ENERGY_WINDOW_SECONDS)));
    this.baselineAttackAlpha = onePoleAlpha(BASELINE_ATTACK_SECONDS, this.sampleRate);
    this.baselineReleaseAlpha = onePoleAlpha(BASELINE_RELEASE_SECONDS, this.sampleRate);
    this.rearmQuietFrames = Math.max(1, Math.round(this.sampleRate * REARM_QUIET_SECONDS));
  }

  /** Read-only envelope diagnostic for unit tests. */
  get currentGain(): number {
    return this.envelope;
  }

  setParameters(parameters: BrowserSlowGearParameters): void {
    const smoothingFrames = Math.round(this.sampleRate * PARAMETER_SMOOTHING_SECONDS);
    if (Number.isFinite(parameters.attackMs)) {
      this.attackMs.setTarget(clamp(parameters.attackMs as number, MIN_ATTACK_MS, MAX_ATTACK_MS), smoothingFrames);
    }
    if (Number.isFinite(parameters.sensitivityPercent)) {
      this.sensitivityPercent.setTarget(
        clamp(parameters.sensitivityPercent as number, MIN_SENSITIVITY_PERCENT, MAX_SENSITIVITY_PERCENT),
        smoothingFrames,
      );
    }
  }

  /** Advance one linked stereo frame and return the envelope gain. */
  processSample(inputLeft: number, inputRight: number): number {
    const attackMs = this.attackMs.next();
    const sensitivity = this.sensitivityPercent.next() / 100;
    const safeLeft = Number.isFinite(inputLeft) ? clamp(inputLeft, -MAX_DETECTOR_INPUT, MAX_DETECTOR_INPUT) : 0;
    const safeRight = Number.isFinite(inputRight) ? clamp(inputRight, -MAX_DETECTOR_INPUT, MAX_DETECTOR_INPUT) : 0;
    const frameEnergy = 0.5 * ((safeLeft * safeLeft) + (safeRight * safeRight));

    const oldEnergy = this.energyWindow[this.energyWindowIndex] ?? 0;
    this.energyWindow[this.energyWindowIndex] = frameEnergy;
    this.energyWindowSum += frameEnergy - oldEnergy;
    this.energyWindowIndex += 1;
    if (this.energyWindowIndex >= this.energyWindow.length) this.energyWindowIndex = 0;
    if (this.energyWindowFrames < this.energyWindow.length) this.energyWindowFrames += 1;
    const shortWindowEnergy = Math.max(0, this.energyWindowSum / Math.max(1, this.energyWindowFrames));

    // Sensitivity changes the required signal level and relative energy rise.
    // These are authored ranges, not manufacturer specifications.
    const onsetFloorDb = -64 + ((1 - sensitivity) * 24);
    const onsetFloor = 10 ** (onsetFloorDb / 20);
    const onsetFloorEnergy = onsetFloor * onsetFloor;
    const riseRatio = 1.12 + ((1 - sensitivity) * 2.25);
    const relativeRiseEnergy = Math.max(MINIMUM_BASELINE_ENERGY, this.baselineEnergy * riseRatio * riseRatio);
    const onset = !this.activeUntilQuiet
      && shortWindowEnergy >= onsetFloorEnergy
      && shortWindowEnergy >= relativeRiseEnergy;

    if (onset) {
      this.activeUntilQuiet = true;
      this.quietFrames = 0;
      this.rampElapsedFrames = 0;
    } else if (this.activeUntilQuiet) {
      const quietThreshold = onsetFloor * 0.55;
      if (shortWindowEnergy <= quietThreshold * quietThreshold) {
        this.quietFrames += 1;
        if (this.quietFrames >= this.rearmQuietFrames) {
          this.activeUntilQuiet = false;
          this.quietFrames = 0;
        }
      } else {
        this.quietFrames = 0;
      }
    }

    if (!this.activeUntilQuiet && !onset) {
      const targetAlpha = shortWindowEnergy > this.baselineEnergy
        ? this.baselineAttackAlpha
        : this.baselineReleaseAlpha;
      this.baselineEnergy += (shortWindowEnergy - this.baselineEnergy) * (1 - targetAlpha);
    }

    if (onset) {
      this.envelope = 0;
      // The onset frame itself is the first zero-gain frame. The ramp begins
      // at the next input sample, preserving true zero-sample algorithmic delay.
      this.rampElapsedFrames = 1;
      return 0;
    }

    const attackFrames = Math.max(1, (attackMs * this.sampleRate) / 1000);
    if (this.rampElapsedFrames > 0 && this.rampElapsedFrames < attackFrames) {
      const phase = clamp(this.rampElapsedFrames / attackFrames, 0, 1);
      this.envelope = 0.5 - (0.5 * Math.cos(Math.PI * phase));
      this.rampElapsedFrames += 1;
      return this.envelope;
    }

    this.rampElapsedFrames = 0;
    this.envelope = 1;
    return 1;
  }

  reset(): void {
    this.energyWindow.fill(0);
    this.energyWindowIndex = 0;
    this.energyWindowFrames = 0;
    this.energyWindowSum = 0;
    this.baselineEnergy = 0;
    this.activeUntilQuiet = false;
    this.quietFrames = 0;
    this.rampElapsedFrames = 0;
    this.envelope = 0;
  }
}
