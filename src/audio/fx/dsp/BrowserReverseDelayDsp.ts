export interface BrowserReverseDelayParameters {
  bpm?: number;
  segmentBeats?: number;
  feedback?: number;
  crossfadeMs?: number;
}

const SEGMENT_BEAT_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

/**
 * Bounded, sample-clocked reverse-segment delay. Each input segment is stored
 * in one of two preallocated stereo buffers, then read backward while the
 * other buffer captures the next segment. The small fixed overlap scratch
 * retains the outgoing segment tail so adjacent reverse reads can crossfade
 * while the old segment buffer is reused for capture. This is a clean-room
 * functional reconstruction, not a Roland topology or sound-quality claim.
 */
export class BrowserReverseDelayDsp {
  readonly sampleRate: number;
  readonly maxSegmentFrames: number;

  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  boundaryCount = 0;
  crossfadeCount = 0;

  private readonly leftBuffers: readonly [Float32Array, Float32Array];
  private readonly rightBuffers: readonly [Float32Array, Float32Array];
  private readonly outgoingTailLeft: Float32Array;
  private readonly outgoingTailRight: Float32Array;
  private captureBufferIndex = 0;
  private playbackBufferIndex = -1;
  private captureFrames = 0;
  private playbackLength = 0;
  private playbackDurationFrames = 0;
  private playbackElapsedFrames = 0;
  private activeSegmentFrames: number;
  private currentBpm: number;
  private currentSegmentBeats: number;
  private currentFeedback: number;
  private currentCrossfadeMs: number;
  private pendingBpm: number;
  private pendingSegmentBeats: number;
  private pendingFeedback: number;
  private pendingCrossfadeMs: number;
  private overlapFrames = 0;
  private outgoingTailFrames = 0;
  private hasCapturedSegment = false;
  private hasPreviousTail = false;

  constructor(sampleRate: number, parameters: BrowserReverseDelayParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    // Catalog bounds: no more than four beats at the minimum 40 BPM.
    this.maxSegmentFrames = Math.ceil(this.sampleRate * (60 / 40) * 4);
    this.leftBuffers = [new Float32Array(this.maxSegmentFrames), new Float32Array(this.maxSegmentFrames)];
    this.rightBuffers = [new Float32Array(this.maxSegmentFrames), new Float32Array(this.maxSegmentFrames)];
    // The overlap is at most half the shortest segment and is capped by the
    // 100 ms control range, so these arrays are bounded for every sample rate.
    const maxOverlapFrames = Math.max(1, Math.floor(this.sampleRate * 0.1));
    this.outgoingTailLeft = new Float32Array(maxOverlapFrames);
    this.outgoingTailRight = new Float32Array(maxOverlapFrames);

    this.currentBpm = this.pendingBpm = this.clampBpm(Number.isFinite(parameters.bpm) ? parameters.bpm as number : 120);
    this.currentSegmentBeats = this.pendingSegmentBeats = this.quantizeBeats(Number.isFinite(parameters.segmentBeats) ? parameters.segmentBeats as number : 1);
    this.currentFeedback = this.pendingFeedback = this.clampFeedback(Number.isFinite(parameters.feedback) ? parameters.feedback as number : 0.2);
    this.currentCrossfadeMs = this.pendingCrossfadeMs = this.clampCrossfade(Number.isFinite(parameters.crossfadeMs) ? parameters.crossfadeMs as number : 20);
    this.activeSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
    this.overlapFrames = this.computeOverlapFrames(this.activeSegmentFrames, this.currentCrossfadeMs);
  }

  /** A read-only view for deterministic tempo, segment, and crossfade tests. */
  get diagnostics(): Readonly<{
    framesProcessed: number;
    boundaryCount: number;
    crossfadeCount: number;
    activeBpm: number;
    activeSegmentBeats: number;
    activeSegmentFrames: number;
    pendingBpm: number;
    pendingSegmentBeats: number;
    remainingFramesToBoundary: number;
    playbackElapsedFrames: number;
    playbackDurationFrames: number;
    overlapFrames: number;
    maxSegmentFrames: number;
    hasCapturedSegment: boolean;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      boundaryCount: this.boundaryCount,
      crossfadeCount: this.crossfadeCount,
      activeBpm: this.currentBpm,
      activeSegmentBeats: this.currentSegmentBeats,
      activeSegmentFrames: this.activeSegmentFrames,
      pendingBpm: this.pendingBpm,
      pendingSegmentBeats: this.pendingSegmentBeats,
      remainingFramesToBoundary: this.activeSegmentFrames - this.captureFrames,
      playbackElapsedFrames: this.playbackElapsedFrames,
      playbackDurationFrames: this.playbackDurationFrames,
      overlapFrames: this.overlapFrames,
      maxSegmentFrames: this.maxSegmentFrames,
      hasCapturedSegment: this.hasCapturedSegment,
    };
  }

  /**
   * A complete source segment must be buffered before reverse playback begins.
   * The reported sample-clocked segment-buffering latency is deliberately one
   * full segment (the catalog's lower bound is one half segment); the reverse
   * mapping itself is position-dependent, and the dry mix remains immediate.
   */
  get latencySamples(): number {
    return this.activeSegmentFrames;
  }

  get hasCaptured(): boolean {
    return this.hasCapturedSegment;
  }

  setParameters(parameters: BrowserReverseDelayParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.segmentBeats)) this.pendingSegmentBeats = this.quantizeBeats(parameters.segmentBeats as number);
    if (Number.isFinite(parameters.feedback)) this.pendingFeedback = this.clampFeedback(parameters.feedback as number);
    if (Number.isFinite(parameters.crossfadeMs)) this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs as number);
  }

  /** Mutates wetLeft/wetRight; storage is fixed and no callback allocations occur. */
  processSample(left: number, right: number): void {
    let wetLeft = 0;
    let wetRight = 0;
    if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
      const sourceOffset = this.reverseSourceOffset(this.playbackElapsedFrames);
      const playbackLeft = this.leftBuffers[this.playbackBufferIndex]!;
      const playbackRight = this.rightBuffers[this.playbackBufferIndex]!;
      wetLeft = playbackLeft[sourceOffset] ?? 0;
      wetRight = playbackRight[sourceOffset] ?? 0;

      const activeOverlapFrames = Math.min(this.overlapFrames, this.outgoingTailFrames);
      if (this.hasPreviousTail && this.playbackElapsedFrames < activeOverlapFrames) {
        const position = activeOverlapFrames <= 1
          ? 1
          : this.playbackElapsedFrames / (activeOverlapFrames - 1);
        wetLeft = this.outgoingTailLeft[this.playbackElapsedFrames]! * Math.cos(position * Math.PI / 2)
          + wetLeft * Math.sin(position * Math.PI / 2);
        wetRight = this.outgoingTailRight[this.playbackElapsedFrames]! * Math.cos(position * Math.PI / 2)
          + wetRight * Math.sin(position * Math.PI / 2);
      }
    }

    if (!Number.isFinite(wetLeft)) wetLeft = 0;
    if (!Number.isFinite(wetRight)) wetRight = 0;
    this.wetLeft = wetLeft;
    this.wetRight = wetRight;

    const captureLeft = this.leftBuffers[this.captureBufferIndex]!;
    const captureRight = this.rightBuffers[this.captureBufferIndex]!;
    const feedback = this.currentFeedback;
    captureLeft[this.captureFrames] = this.boundCapture(left + (feedback * this.boundFeedback(wetLeft)));
    captureRight[this.captureFrames] = this.boundCapture(right + (feedback * this.boundFeedback(wetRight)));

    this.captureFrames += 1;
    if (this.hasCapturedSegment) this.playbackElapsedFrames += 1;
    this.framesProcessed += 1;

    if (this.captureFrames >= this.activeSegmentFrames) this.onBoundary();
  }

  reset(): void {
    this.leftBuffers[0].fill(0);
    this.leftBuffers[1].fill(0);
    this.rightBuffers[0].fill(0);
    this.rightBuffers[1].fill(0);
    this.outgoingTailLeft.fill(0);
    this.outgoingTailRight.fill(0);
    this.captureBufferIndex = 0;
    this.playbackBufferIndex = -1;
    this.captureFrames = 0;
    this.playbackLength = 0;
    this.playbackDurationFrames = 0;
    this.playbackElapsedFrames = 0;
    this.currentBpm = this.pendingBpm;
    this.currentSegmentBeats = this.pendingSegmentBeats;
    this.currentFeedback = this.pendingFeedback;
    this.currentCrossfadeMs = this.pendingCrossfadeMs;
    this.activeSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
    this.overlapFrames = this.computeOverlapFrames(this.activeSegmentFrames, this.currentCrossfadeMs);
    this.outgoingTailFrames = 0;
    this.hasCapturedSegment = false;
    this.hasPreviousTail = false;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.framesProcessed = 0;
    this.boundaryCount = 0;
    this.crossfadeCount = 0;
  }

  private onBoundary(): void {
    this.currentBpm = this.pendingBpm;
    this.currentSegmentBeats = this.pendingSegmentBeats;
    this.currentFeedback = this.pendingFeedback;
    this.currentCrossfadeMs = this.pendingCrossfadeMs;
    this.activeSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
    this.overlapFrames = this.computeOverlapFrames(this.activeSegmentFrames, this.currentCrossfadeMs);

    if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
      const copyFrames = Math.min(this.overlapFrames, this.playbackDurationFrames);
      for (let frame = 0; frame < copyFrames; frame += 1) {
        const offset = this.reverseSourceOffset(this.playbackDurationFrames - copyFrames + frame);
        this.outgoingTailLeft[frame] = this.leftBuffers[this.playbackBufferIndex]![offset] ?? 0;
        this.outgoingTailRight[frame] = this.rightBuffers[this.playbackBufferIndex]![offset] ?? 0;
      }
      this.outgoingTailFrames = copyFrames;
      this.hasPreviousTail = copyFrames > 0;
      if (this.hasPreviousTail) this.crossfadeCount += 1;
    } else {
      this.outgoingTailLeft.fill(0);
      this.outgoingTailRight.fill(0);
      // The first captured segment has no outgoing audio to overlap with, so
      // crossfade from silence over the same bounded overlap window.
      this.outgoingTailFrames = this.overlapFrames;
      this.hasPreviousTail = this.overlapFrames > 0;
    }

    this.playbackBufferIndex = this.captureBufferIndex;
    this.playbackLength = Math.min(this.captureFrames, this.maxSegmentFrames);
    this.captureBufferIndex = 1 - this.captureBufferIndex;
    this.captureFrames = 0;
    this.hasCapturedSegment = this.playbackLength > 0;
    this.boundaryCount += 1;

    // The completed segment is time-mapped across the next active interval if
    // BPM or segment length changed, so both alternating buffers stay in sync.
    this.playbackDurationFrames = this.activeSegmentFrames;
    this.playbackElapsedFrames = 0;
  }

  private reverseSourceOffset(elapsedFrames: number): number {
    if (this.playbackLength <= 1 || this.playbackDurationFrames <= 1) return Math.max(0, this.playbackLength - 1);
    const reversePosition = Math.max(0, this.playbackDurationFrames - 1 - elapsedFrames);
    return Math.min(this.playbackLength - 1,
      Math.floor((reversePosition * this.playbackLength) / this.playbackDurationFrames));
  }

  private segmentFrames(bpm: number, beats: number): number {
    return Math.max(1, Math.min(this.maxSegmentFrames, Math.round(this.sampleRate * (60 / bpm) * beats)));
  }

  private computeOverlapFrames(segmentFrames: number, crossfadeMs: number): number {
    const requested = Math.max(1, Math.round(this.sampleRate * crossfadeMs / 1000));
    return Math.max(1, Math.min(requested, Math.floor(segmentFrames / 2), this.outgoingTailLeft.length));
  }

  private quantizeBeats(value: number): number {
    if (!Number.isFinite(value)) return 1;
    let nearest: number = SEGMENT_BEAT_OPTIONS[0];
    let distance = Math.abs(value - nearest);
    for (let index = 1; index < SEGMENT_BEAT_OPTIONS.length; index += 1) {
      const candidate = SEGMENT_BEAT_OPTIONS[index]!;
      const candidateDistance = Math.abs(value - candidate);
      if (candidateDistance < distance) {
        nearest = candidate;
        distance = candidateDistance;
      }
    }
    return nearest;
  }

  private clampBpm(value: number): number { return Number.isFinite(value) ? Math.max(40, Math.min(300, value)) : 120; }
  private clampFeedback(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(0.95, value)) : 0.2; }
  private clampCrossfade(value: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 20; }
  private boundFeedback(value: number): number { return Math.max(-1, Math.min(1, value)); }
  private boundCapture(value: number): number { return Math.max(-8, Math.min(8, Number.isFinite(value) ? value : 0)); }
}
