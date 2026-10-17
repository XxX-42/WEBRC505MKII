import { LagrangeFractionalDelay } from '../../dsp/LagrangeFractionalDelay';
import { equalPowerFadeInGain, equalPowerFadeOutGain } from '../../dsp/equalPowerCrossfade';

export interface BrowserBeatShiftParameters {
  bpm?: number;
  offsetBeats?: number;
  crossfadeMs?: number;
}

/**
 * Clean-room postmix beat-shift buffer. The source documents FUTURE/PAST and
 * a beat-length SHIFT control; it does not specify a digital implementation.
 * This bounded implementation maps a signed offset around a four-beat live
 * look-ahead point. Positive offsets read newer material (toward FUTURE),
 * negative offsets read older material (toward PAST). The four-beat baseline
 * is necessary to render up to four beats of advance from a live postmix.
 * Offset/range and crossfade law are application contract choices, not claims
 * about Roland firmware. It is shared postmix processing, not per-loop-track.
 */
export class BrowserBeatShiftDsp {
  readonly sampleRate: number;
  readonly maxDelayFrames: number;

  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  transitionCount = 0;

  private readonly leftDelay: LagrangeFractionalDelay;
  private readonly rightDelay: LagrangeFractionalDelay;
  private currentBpm: number;
  private currentOffsetBeats: number;
  private currentCrossfadeMs: number;
  private pendingBpm: number;
  private pendingOffsetBeats: number;
  private pendingCrossfadeMs: number;
  private currentDelayFrames: number;
  private transitionFromFrames = 0;
  private transitionToFrames = 0;
  private transitionTotalFrames = 0;
  private transitionElapsedFrames = 0;
  private transitioning = false;
  private hasHistory = false;
  private wetAvailability = 0;
  private readyFadeFrames = 0;

  constructor(sampleRate: number, parameters: BrowserBeatShiftParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    // Offset is bounded to +/-4 beats around the four-beat look-ahead point.
    this.maxDelayFrames = Math.ceil(this.sampleRate * (60 / 40) * 8) + 4;
    this.leftDelay = new LagrangeFractionalDelay(this.maxDelayFrames);
    this.rightDelay = new LagrangeFractionalDelay(this.maxDelayFrames);
    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentOffsetBeats = this.pendingOffsetBeats = this.clampOffset(parameters.offsetBeats ?? 1);
    this.currentCrossfadeMs = this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs ?? 5);
    this.currentDelayFrames = this.delayFrames(this.currentBpm, this.currentOffsetBeats);
    this.transitionFromFrames = this.transitionToFrames = this.currentDelayFrames;
  }

  get diagnostics(): Readonly<{
    framesProcessed: number;
    maxDelayFrames: number;
    currentBpm: number;
    currentOffsetBeats: number;
    currentCrossfadeMs: number;
    currentDelayFrames: number;
    transitionCount: number;
    transitionRemainingFrames: number;
    wetAvailability: number;
    hasHistory: boolean;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      maxDelayFrames: this.maxDelayFrames,
      currentBpm: this.currentBpm,
      currentOffsetBeats: this.currentOffsetBeats,
      currentCrossfadeMs: this.currentCrossfadeMs,
      currentDelayFrames: this.currentDelayFrames,
      transitionCount: this.transitionCount,
      transitionRemainingFrames: this.transitioning ? this.transitionTotalFrames - this.transitionElapsedFrames : 0,
      wetAvailability: this.wetAvailability,
      hasHistory: this.hasHistory,
    };
  }

  /** Delay of the currently committed read head, in frames at sampleRate. */
  get latencySamples(): number {
    return this.currentDelayFrames;
  }

  setParameters(parameters: BrowserBeatShiftParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.offsetBeats)) this.pendingOffsetBeats = this.clampOffset(parameters.offsetBeats as number);
    if (Number.isFinite(parameters.crossfadeMs)) this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs as number);
  }

  /** Writes one stereo frame and renders with fixed delay heads. */
  processSample(left: number, right: number): void {
    // A zero-delay write/read provides the fresh frame before the two heads
    // are read; all storage is preallocated and no callback allocations occur.
    this.leftDelay.processSample(left, 0);
    this.rightDelay.processSample(right, 0);
    this.framesProcessed += 1;

    this.maybeBeginTransition();
    if (this.transitioning) {
      const position = this.transitionTotalFrames <= 1
        ? 1
        : this.transitionElapsedFrames / (this.transitionTotalFrames - 1);
      const fromLeft = this.leftDelay.readSample(this.transitionFromFrames);
      const fromRight = this.rightDelay.readSample(this.transitionFromFrames);
      const toLeft = this.leftDelay.readSample(this.transitionToFrames);
      const toRight = this.rightDelay.readSample(this.transitionToFrames);
      this.wetLeft = fromLeft * equalPowerFadeOutGain(position) + toLeft * equalPowerFadeInGain(position);
      this.wetRight = fromRight * equalPowerFadeOutGain(position) + toRight * equalPowerFadeInGain(position);
      this.transitionElapsedFrames += 1;
      if (this.transitionElapsedFrames >= this.transitionTotalFrames) {
        this.currentDelayFrames = this.transitionToFrames;
        this.transitioning = false;
      }
    } else {
      this.wetLeft = this.leftDelay.readSample(this.currentDelayFrames);
      this.wetRight = this.rightDelay.readSample(this.currentDelayFrames);
    }

    if (!this.hasHistory && this.framesProcessed >= Math.ceil(this.currentDelayFrames) + 4) {
      this.hasHistory = true;
      this.readyFadeFrames = Math.max(1, Math.round(this.sampleRate * this.currentCrossfadeMs / 1000));
    }
    if (this.hasHistory && this.wetAvailability < 1) {
      this.wetAvailability = Math.min(1, this.wetAvailability + (1 / Math.max(1, this.readyFadeFrames)));
    }
  }

  /** Amount of shifted signal available for the core's equal-power wet mix. */
  get mixAvailability(): number {
    return this.wetAvailability;
  }

  /** Reset only counters/visibility; ring storage stays fixed and is overwritten in place. */
  reset(): void {
    this.framesProcessed = 0;
    this.transitioning = false;
    this.transitionElapsedFrames = 0;
    this.transitionTotalFrames = 0;
    this.currentBpm = this.pendingBpm;
    this.currentOffsetBeats = this.pendingOffsetBeats;
    this.currentCrossfadeMs = this.pendingCrossfadeMs;
    this.currentDelayFrames = this.delayFrames(this.currentBpm, this.currentOffsetBeats);
    this.transitionFromFrames = this.transitionToFrames = this.currentDelayFrames;
    this.hasHistory = false;
    this.wetAvailability = 0;
    this.readyFadeFrames = 0;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.transitionCount = 0;
  }

  private maybeBeginTransition(): void {
    if (this.transitioning) return;
    const nextDelay = this.delayFrames(this.pendingBpm, this.pendingOffsetBeats);
    const delayChanged = Math.abs(nextDelay - this.currentDelayFrames) >= 0.01;
    const controlsChanged = this.pendingBpm !== this.currentBpm
      || this.pendingOffsetBeats !== this.currentOffsetBeats
      || this.pendingCrossfadeMs !== this.currentCrossfadeMs;
    if (!controlsChanged) return;

    // Keep the previous stable read head until enough fresh postmix exists for
    // the new head. This avoids crossfading into unwritten ring-buffer memory.
    if (delayChanged && this.framesProcessed < Math.ceil(nextDelay) + 4) return;

    this.currentBpm = this.pendingBpm;
    this.currentOffsetBeats = this.pendingOffsetBeats;
    this.currentCrossfadeMs = this.pendingCrossfadeMs;
    if (!delayChanged) return;

    this.transitionFromFrames = this.currentDelayFrames;
    this.transitionToFrames = nextDelay;
    this.transitionTotalFrames = Math.max(1, Math.round(this.sampleRate * this.currentCrossfadeMs / 1000));
    this.transitionElapsedFrames = 0;
    this.transitioning = true;
    this.transitionCount += 1;
  }

  private delayFrames(bpm: number, offsetBeats: number): number {
    // Four-beat look-ahead is the bounded live-stream cost of supporting both
    // FUTURE (advance) and PAST (delay) offsets up to four beats.
    return Math.max(0, Math.min(this.maxDelayFrames - 4,
      (4 - offsetBeats) * (60 / bpm) * this.sampleRate));
  }

  private clampBpm(value: number): number { return Math.max(40, Math.min(300, value)); }
  private clampOffset(value: number): number { return Math.max(-4, Math.min(4, value)); }
  private clampCrossfade(value: number): number { return Math.max(1, Math.min(50, value)); }
}
