/**
 * Clean-room Browser implementation of the catalogued SUSTAINER function.
 * Attack and gate details are authored provisional behavior: a 2 ms
 * stereo-linked peak-envelope attack, a user-controlled compressor release,
 * and a hysteretic gate that opens at threshold -18 dB and closes at
 * threshold -24 dB. Gate gain opens over 1 ms and closes over 60 ms. The
 * static level law compresses both sides of threshold toward it by `ratio`;
 * output gain is followed by a linked peak limiter with instantaneous attack,
 * 60 ms release, and a bounded -0.3 dBFS ceiling. There is no
 * lookahead or added latency, and no Roland source or code is used.
 */
export interface BrowserSustainerParameters {
  thresholdDb?: number;
  ratio?: number;
  releaseMs?: number;
  outputDb?: number;
}

const MIN_THRESHOLD_DB = -60;
const MAX_THRESHOLD_DB = 0;
const MIN_RATIO = 1;
const MAX_RATIO = 20;
const MIN_RELEASE_MS = 10;
const MAX_RELEASE_MS = 1000;
const DEFAULT_THRESHOLD_DB = -24;
const DEFAULT_RATIO = 4;
const DEFAULT_RELEASE_MS = 180;
const DEFAULT_OUTPUT_DB = 0;
const ENVELOPE_FLOOR = 1e-9;
const GATE_CLOSE_OFFSET_DB = 24;
const GATE_OPEN_OFFSET_DB = 18;
const LIMITER_CEILING = 0.9660508789898133; // -0.3 dBFS

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function onePoleAlpha(timeMs: number, sampleRate: number): number {
  return Math.exp(-1 / (Math.max(0.001, timeMs) * 0.001 * sampleRate));
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** A compact parameter smoother kept private to this sample-frame processor. */
class ParameterSmoother {
  private current: number;
  private target: number;
  private readonly oneMinusAlpha: number;

  constructor(sampleRate: number, initialValue: number) {
    this.current = initialValue;
    this.target = initialValue;
    this.oneMinusAlpha = 1 - Math.exp(-1 / (sampleRate * 0.015));
  }

  setTarget(value: number): void {
    this.target = value;
  }

  next(): number {
    this.current += (this.target - this.current) * this.oneMinusAlpha;
    return this.current;
  }
}

/** Stereo-linked upward/downward leveler with a hysteretic noise gate. */
export class BrowserSustainerDsp {
  readonly sampleRate: number;
  outputLeft = 0;
  outputRight = 0;

  private readonly threshold: ParameterSmoother;
  private readonly ratio: ParameterSmoother;
  private readonly release: ParameterSmoother;
  private readonly outputDb: ParameterSmoother;
  private envelope = 0;
  private gateEnvelope = 0;
  private gateGain = 0;
  private gateIsOpen = false;
  private attackAlpha = 0;
  private releaseAlpha = 0;
  private gateEnvelopeAttackAlpha: number;
  private gateEnvelopeReleaseAlpha: number;
  private gateOpenAlpha: number;
  private gateCloseAlpha: number;
  private readonly limiterReleaseAlpha: number;
  private limiterGain = 1;
  private controlsCountdown = 0;

  constructor(sampleRate: number, parameters: BrowserSustainerParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.threshold = new ParameterSmoother(this.sampleRate, clamp(parameters.thresholdDb ?? DEFAULT_THRESHOLD_DB, MIN_THRESHOLD_DB, MAX_THRESHOLD_DB));
    this.ratio = new ParameterSmoother(this.sampleRate, clamp(parameters.ratio ?? DEFAULT_RATIO, MIN_RATIO, MAX_RATIO));
    this.release = new ParameterSmoother(this.sampleRate, clamp(parameters.releaseMs ?? DEFAULT_RELEASE_MS, MIN_RELEASE_MS, MAX_RELEASE_MS));
    this.outputDb = new ParameterSmoother(this.sampleRate, clamp(parameters.outputDb ?? DEFAULT_OUTPUT_DB, -24, 12));
    this.gateEnvelopeAttackAlpha = onePoleAlpha(1, this.sampleRate);
    this.gateEnvelopeReleaseAlpha = onePoleAlpha(60, this.sampleRate);
    this.gateOpenAlpha = onePoleAlpha(1, this.sampleRate);
    this.gateCloseAlpha = onePoleAlpha(60, this.sampleRate);
    this.limiterReleaseAlpha = onePoleAlpha(60, this.sampleRate);
    this.refreshCompressorCoefficients(parameters.releaseMs ?? DEFAULT_RELEASE_MS);
  }

  setParameters(parameters: BrowserSustainerParameters): void {
    if (Number.isFinite(parameters.thresholdDb)) this.threshold.setTarget(clamp(parameters.thresholdDb as number, MIN_THRESHOLD_DB, MAX_THRESHOLD_DB));
    if (Number.isFinite(parameters.ratio)) this.ratio.setTarget(clamp(parameters.ratio as number, MIN_RATIO, MAX_RATIO));
    if (Number.isFinite(parameters.releaseMs)) this.release.setTarget(clamp(parameters.releaseMs as number, MIN_RELEASE_MS, MAX_RELEASE_MS));
    if (Number.isFinite(parameters.outputDb)) this.outputDb.setTarget(clamp(parameters.outputDb as number, -24, 12));
  }

  /** Advances one stereo frame; all computation uses fixed scalar state. */
  processSample(inputLeft: number, inputRight: number): void {
    const thresholdDb = this.threshold.next();
    const ratio = this.ratio.next();
    const releaseMs = this.release.next();
    const outputDb = this.outputDb.next();

    if (this.controlsCountdown <= 0) {
      this.refreshCompressorCoefficients(releaseMs);
      this.controlsCountdown = 15;
    } else {
      this.controlsCountdown -= 1;
    }

    // Maximum linked peak means a loud transient in either channel controls
    // gain equally for L/R and never collapses stereo balance.
    const peak = Math.max(Math.abs(inputLeft), Math.abs(inputRight));
    const compressorCoefficient = peak > this.envelope ? this.attackAlpha : this.releaseAlpha;
    this.envelope = peak + compressorCoefficient * (this.envelope - peak);
    const gateEnvelopeCoefficient = peak > this.gateEnvelope ? this.gateEnvelopeAttackAlpha : this.gateEnvelopeReleaseAlpha;
    this.gateEnvelope = peak + gateEnvelopeCoefficient * (this.gateEnvelope - peak);

    const gateDb = 20 * Math.log10(Math.max(this.gateEnvelope, ENVELOPE_FLOOR));
    if (this.gateIsOpen) {
      if (gateDb <= thresholdDb - GATE_CLOSE_OFFSET_DB) this.gateIsOpen = false;
    } else if (gateDb >= thresholdDb - GATE_OPEN_OFFSET_DB) {
      this.gateIsOpen = true;
    }
    const gateTarget = this.gateIsOpen ? 1 : 0;
    const gateCoefficient = this.gateIsOpen ? this.gateOpenAlpha : this.gateCloseAlpha;
    this.gateGain = gateTarget + gateCoefficient * (this.gateGain - gateTarget);

    const envelopeDb = 20 * Math.log10(Math.max(this.envelope, ENVELOPE_FLOOR));
    const compressedDb = thresholdDb + ((envelopeDb - thresholdDb) / ratio);
    const linkedGain = dbToLinear(compressedDb - envelopeDb) * this.gateGain * dbToLinear(outputDb);
    const rawLeft = inputLeft * linkedGain;
    const rawRight = inputRight * linkedGain;
    const outputPeak = Math.max(Math.abs(rawLeft), Math.abs(rawRight));
    if (outputPeak > LIMITER_CEILING) {
      // Zero lookahead: apply enough linked gain to contain the current frame.
      this.limiterGain = LIMITER_CEILING / outputPeak;
    } else {
      // Release smoothly back to unity without exceeding the safety ceiling.
      this.limiterGain = 1 + this.limiterReleaseAlpha * (this.limiterGain - 1);
    }
    this.outputLeft = rawLeft * this.limiterGain;
    this.outputRight = rawRight * this.limiterGain;
  }

  reset(): void {
    this.envelope = 0;
    this.gateEnvelope = 0;
    this.gateGain = 0;
    this.gateIsOpen = false;
    this.limiterGain = 1;
    this.outputLeft = 0;
    this.outputRight = 0;
    this.controlsCountdown = 0;
  }

  private refreshCompressorCoefficients(releaseMs: number): void {
    this.attackAlpha = onePoleAlpha(2, this.sampleRate);
    this.releaseAlpha = onePoleAlpha(clamp(releaseMs, MIN_RELEASE_MS, MAX_RELEASE_MS), this.sampleRate);
  }
}
