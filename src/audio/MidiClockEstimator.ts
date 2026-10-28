/** Pure estimator for MIDI Timing Clock (F8), whose nominal resolution is 24 PPQN.
 *
 * This class estimates tick period and a relative phase from timestamped clock
 * pulses. It has no MIDI, audio, or Transport side effects. MIDI Clock has no
 * start/position marker here, so phase is relative to the first accepted pulse;
 * it does not identify a musical downbeat or establish synchronization.
 */
export type MidiClockEstimateState = 'waiting' | 'acquiring' | 'locked' | 'stale';
export type MidiClockEstimateStability = 'insufficient-data' | 'stable' | 'unstable';

export interface MidiClockEstimatorOptions {
  /** Valid estimated tempo range. Pulses outside it are not used for acquisition. */
  readonly minBpm?: number;
  readonly maxBpm?: number;
  /** Number of normalized intervals required before the estimator can lock. */
  readonly lockAfterIntervals?: number;
  readonly historySize?: number;
  /** Largest missing-tick run that may be inferred while already tracking. */
  readonly maxGapTicks?: number;
  /** Relative deviation accepted into the robust interval window. */
  readonly maxIntervalDeviation?: number;
  /** Consecutive rejected intervals before restarting acquisition. */
  readonly rejectedIntervalsBeforeReset?: number;
}

export interface MidiClockEstimateSnapshot {
  readonly state: MidiClockEstimateState;
  readonly stability: MidiClockEstimateStability;
  readonly ppqn: 24;
  readonly bpm: number | null;
  readonly tickPeriodMs: number | null;
  readonly phaseLocked: boolean;
  /** Position in ticks relative to the first accepted pulse; null unless locked and live. */
  readonly phaseTicks: number | null;
  /** Relative phase within one quarter note, in [0, 1); not a downbeat marker. */
  readonly beatPhase: number | null;
  readonly lastPulseAtMs: number | null;
  readonly acceptedIntervals: number;
  readonly requiredIntervals: number;
  readonly inferredMissingTicks: number;
  readonly rejectedIntervals: number;
  readonly sourceKey: string | null;
}

const PPQN = 24 as const;
const DEFAULT_MIN_BPM = 30;
const DEFAULT_MAX_BPM = 300;
const DEFAULT_LOCK_AFTER = 6;
const DEFAULT_HISTORY_SIZE = 24;
const DEFAULT_MAX_GAP_TICKS = 8;
const DEFAULT_MAX_INTERVAL_DEVIATION = 0.2;
const DEFAULT_REJECT_RESET_COUNT = 3;
const STALE_TICK_MULTIPLIER = 4;
const MIN_STALE_MS = 500;
const STABILITY_RELATIVE_MAD = 0.04;

/**
 * Accepts one timestamp per F8 pulse from one source at a time. Call reset or
 * change sourceKey to discard phase and tempo evidence when selecting a source.
 */
export class MidiClockEstimator {
  private readonly minPeriodMs: number;
  private readonly maxPeriodMs: number;
  private readonly lockAfterIntervals: number;
  private readonly historySize: number;
  private readonly maxGapTicks: number;
  private readonly maxIntervalDeviation: number;
  private readonly rejectedIntervalsBeforeReset: number;
  private sourceKey: string | null = null;
  private firstPulseAtMs: number | null = null;
  private lastPulseAtMs: number | null = null;
  private intervals: number[] = [];
  private pulsePosition = 0;
  private inferredMissingTicks = 0;
  private rejectedIntervals = 0;
  private consecutiveRejects = 0;

  constructor(options: MidiClockEstimatorOptions = {}) {
    const minBpm = options.minBpm ?? DEFAULT_MIN_BPM;
    const maxBpm = options.maxBpm ?? DEFAULT_MAX_BPM;
    this.lockAfterIntervals = options.lockAfterIntervals ?? DEFAULT_LOCK_AFTER;
    this.historySize = options.historySize ?? DEFAULT_HISTORY_SIZE;
    this.maxGapTicks = options.maxGapTicks ?? DEFAULT_MAX_GAP_TICKS;
    this.maxIntervalDeviation = options.maxIntervalDeviation ?? DEFAULT_MAX_INTERVAL_DEVIATION;
    this.rejectedIntervalsBeforeReset = options.rejectedIntervalsBeforeReset ?? DEFAULT_REJECT_RESET_COUNT;
    if (!(minBpm > 0 && maxBpm > minBpm)) throw new RangeError('BPM range must be positive and increasing');
    if (!Number.isInteger(this.lockAfterIntervals) || this.lockAfterIntervals < 2) throw new RangeError('lockAfterIntervals must be an integer >= 2');
    if (!Number.isInteger(this.historySize) || this.historySize < this.lockAfterIntervals) throw new RangeError('historySize must be >= lockAfterIntervals');
    if (!Number.isInteger(this.maxGapTicks) || this.maxGapTicks < 2) throw new RangeError('maxGapTicks must be an integer >= 2');
    if (!(this.maxIntervalDeviation > 0 && this.maxIntervalDeviation < 1)) throw new RangeError('maxIntervalDeviation must be in (0, 1)');
    if (!Number.isInteger(this.rejectedIntervalsBeforeReset) || this.rejectedIntervalsBeforeReset < 1) throw new RangeError('rejectedIntervalsBeforeReset must be a positive integer');
    this.minPeriodMs = 60_000 / (maxBpm * PPQN);
    this.maxPeriodMs = 60_000 / (minBpm * PPQN);
  }

  /** Add a pulse timestamp in milliseconds, along with its selected source identity. */
  push(timestampMs: number, sourceKey: string): MidiClockEstimateSnapshot {
    if (!Number.isFinite(timestampMs)) return this.getSnapshot(this.lastPulseAtMs ?? 0);
    if (!sourceKey) throw new TypeError('sourceKey must be non-empty');
    if (this.sourceKey !== sourceKey) {
      this.clearEvidence();
      this.sourceKey = sourceKey;
    }
    if (this.lastPulseAtMs === null) {
      this.startAt(timestampMs);
      return this.getSnapshot(timestampMs);
    }

    const delta = timestampMs - this.lastPulseAtMs;
    if (!(delta > 0)) {
      this.clearEvidence(sourceKey, true);
      this.rejectedIntervals += 1;
      this.startAt(timestampMs);
      return this.getSnapshot(timestampMs);
    }

    const period = this.median(this.intervals);
    const staleAfterMs = Math.max(MIN_STALE_MS, period > 0 ? period * STALE_TICK_MULTIPLIER : MIN_STALE_MS);
    if (delta > staleAfterMs) {
      // A long silence invalidates phase. Use this pulse only as a fresh anchor.
      this.clearEvidence(sourceKey, true);
      this.startAt(timestampMs);
      return this.getSnapshot(timestampMs);
    }

    let tickAdvance = 1;
    let normalizedInterval = delta;
    if (period > 0) {
      tickAdvance = Math.max(1, Math.round(delta / period));
      if (tickAdvance > this.maxGapTicks) {
        this.clearEvidence(sourceKey, true);
        this.startAt(timestampMs);
        return this.getSnapshot(timestampMs);
      }
      normalizedInterval = delta / tickAdvance;
      const relativeError = Math.abs(normalizedInterval - period) / period;
      if (relativeError > this.maxIntervalDeviation) {
        this.rejectedIntervals += 1;
        if (!this.isLocked()) {
          // During acquisition, an inconsistent interval makes the old anchor
          // ambiguous. Drop that phase evidence instead of carrying a guessed
          // fractional tick into a later lock.
          this.clearEvidence(sourceKey, true);
          this.startAt(timestampMs);
          return this.getSnapshot(timestampMs);
        }
        this.consecutiveRejects += 1;
        if (this.consecutiveRejects >= this.rejectedIntervalsBeforeReset) {
          this.clearEvidence(sourceKey, true);
          this.startAt(timestampMs);
          return this.getSnapshot(timestampMs);
        }
        // Preserve the phase estimate through an isolated timing outlier, but
        // do not let it poison the robust period history.
        this.pulsePosition += delta / period;
        this.lastPulseAtMs = timestampMs;
        return this.getSnapshot(timestampMs);
      }
      this.inferredMissingTicks += tickAdvance - 1;
    }

    if (normalizedInterval < this.minPeriodMs || normalizedInterval > this.maxPeriodMs) {
      this.rejectedIntervals += 1;
      if (!this.isLocked()) {
        this.clearEvidence(sourceKey, true);
        this.startAt(timestampMs);
        return this.getSnapshot(timestampMs);
      }
      this.consecutiveRejects += 1;
      if (this.consecutiveRejects >= this.rejectedIntervalsBeforeReset) {
        this.clearEvidence(sourceKey, true);
        this.startAt(timestampMs);
        return this.getSnapshot(timestampMs);
      }
      if (period > 0) this.pulsePosition += delta / period;
      this.lastPulseAtMs = timestampMs;
      return this.getSnapshot(timestampMs);
    }

    this.consecutiveRejects = 0;
    this.intervals.push(normalizedInterval);
    if (this.intervals.length > this.historySize) this.intervals.shift();
    this.pulsePosition += tickAdvance;
    this.lastPulseAtMs = timestampMs;
    return this.getSnapshot(timestampMs);
  }

  /** Clear all history and phase. */
  reset(): void {
    this.clearEvidence();
  }

  getSnapshot(nowMs: number): MidiClockEstimateSnapshot {
    if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
    const period = this.median(this.intervals);
    const state = this.getState(nowMs, period);
    const stable = this.isStable();
    const locked = state === 'locked' && stable;
    let phaseTicks: number | null = null;
    if (locked && period > 0 && this.firstPulseAtMs !== null && this.lastPulseAtMs !== null) {
      const elapsedTicks = Math.max(0, (nowMs - this.lastPulseAtMs) / period);
      phaseTicks = this.pulsePosition + elapsedTicks;
    }
    const beatPhase = phaseTicks === null ? null : ((phaseTicks % PPQN) + PPQN) % PPQN / PPQN;
    return Object.freeze({
      state,
      stability: this.intervals.length < this.lockAfterIntervals ? 'insufficient-data' : stable ? 'stable' : 'unstable',
      ppqn: PPQN,
      bpm: period > 0 ? 60_000 / (period * PPQN) : null,
      tickPeriodMs: period > 0 ? period : null,
      phaseLocked: locked,
      phaseTicks,
      beatPhase,
      lastPulseAtMs: this.lastPulseAtMs,
      acceptedIntervals: this.intervals.length,
      requiredIntervals: this.lockAfterIntervals,
      inferredMissingTicks: this.inferredMissingTicks,
      rejectedIntervals: this.rejectedIntervals,
      sourceKey: this.sourceKey,
    });
  }

  private getState(nowMs: number, period: number): MidiClockEstimateState {
    if (this.lastPulseAtMs === null) return 'waiting';
    if (nowMs - this.lastPulseAtMs > Math.max(MIN_STALE_MS, period * STALE_TICK_MULTIPLIER)) return 'stale';
    if (this.intervals.length >= this.lockAfterIntervals && this.isStable()) return 'locked';
    return 'acquiring';
  }

  private isStable(): boolean {
    if (this.intervals.length < this.lockAfterIntervals) return false;
    const median = this.median(this.intervals);
    if (!(median > 0)) return false;
    const deviations = this.intervals.map((interval) => Math.abs(interval - median));
    return this.median(deviations) / median <= STABILITY_RELATIVE_MAD
      && this.intervals.every((interval) => Math.abs(interval - median) / median <= this.maxIntervalDeviation);
  }

  private isLocked(): boolean {
    return this.intervals.length >= this.lockAfterIntervals && this.isStable();
  }

  private startAt(timestampMs: number): void {
    this.firstPulseAtMs = timestampMs;
    this.lastPulseAtMs = timestampMs;
    this.pulsePosition = 0;
  }

  private clearEvidence(sourceKey = this.sourceKey ?? undefined, preserveRejectedIntervals = false): void {
    const rejectedIntervals = preserveRejectedIntervals ? this.rejectedIntervals : 0;
    this.sourceKey = sourceKey ?? null;
    this.firstPulseAtMs = null;
    this.lastPulseAtMs = null;
    this.intervals = [];
    this.pulsePosition = 0;
    this.inferredMissingTicks = 0;
    this.rejectedIntervals = rejectedIntervals;
    this.consecutiveRejects = 0;
  }

  private median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const lower = sorted[middle - 1];
    const upper = sorted[middle];
    return sorted.length % 2 === 0 && lower !== undefined && upper !== undefined
      ? (lower + upper) / 2
      : sorted[middle] ?? 0;
  }
}
