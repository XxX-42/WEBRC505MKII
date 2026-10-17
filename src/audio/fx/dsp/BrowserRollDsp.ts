export type BrowserRollDirection = 'forward' | 'reverse' | 'alternate';

export interface BrowserRollParameters {
  bpm?: number;
  sliceBeats?: number;
  decayPercent?: number;
  pitchSemitones?: number;
  direction?: BrowserRollDirection;
}

const MIN_BPM = 40;
const MAX_BPM = 300;
const MAX_SLICE_BEATS = 4;
const MAX_CAPTURE_SECONDS = (60 * MAX_SLICE_BEATS) / MIN_BPM;
const EVENT_FADE_FRAMES = 16;
const SLICE_DIVISIONS = [0.25, 0.5, 1, 2, 4] as const;
const HALF_PI = Math.PI * 0.5;
const MAX_STORED_SAMPLE = 4;
const MAX_OUTPUT_SAMPLE = 8;

/**
 * Clean-room, sample-clocked stereo ROLL primitive. It records the incoming
 * beat-quantized slice into one of two fixed buffers while retriggering the
 * previously completed slice from the other. Playback-rate pitch spans +/-24
 * semitones and changes source traversal duration (it is not pitch-shifted
 * time-stretching). Slice changes, decay, and direction edits latch at a beat
 * boundary; forward/reverse/alternate playback and equal-power event/seam
 * fades are implementation choices. This has no Roland firmware dependency,
 * and makes no sound-quality acceptance claim.
 *
 * Constructor-owned storage is fixed for the instance's lifetime. The audio
 * callback path is sample-by-sample and allocates no objects or buffers.
 */
export class BrowserRollDsp {
  readonly sampleRate: number;
  readonly maxSliceFrames: number;

  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  boundaryCount = 0;
  lastBoundaryFrame = -1;

  private readonly leftBuffers: readonly [Float32Array, Float32Array];
  private readonly rightBuffers: readonly [Float32Array, Float32Array];
  private readonly fadeTailLeft = new Float32Array(EVENT_FADE_FRAMES);
  private readonly fadeTailRight = new Float32Array(EVENT_FADE_FRAMES);
  private captureBufferIndex = 0;
  private playbackBufferIndex = -1;
  private captureFrames = 0;
  private playbackLength = 0;
  private playbackPosition = 0;
  private playbackDirectionSign = 1;
  private playbackRate = 1;
  private gain = 1;
  private tailWriteIndex = 0;
  private tailFrames = 0;
  private fadeTailStart = 0;
  private fadeFrames = 0;
  private fadePosition = 0;
  private framesUntilBoundary: number;
  private activeIntervalFrames: number;
  private currentBpm: number;
  private currentSliceBeats: number;
  private currentDecayPercent: number;
  private currentPitchSemitones: number;
  private currentDirection: BrowserRollDirection;
  private pendingBpm: number;
  private pendingSliceBeats: number;
  private pendingDecayPercent: number;
  private pendingPitchSemitones: number;
  private pendingDirection: BrowserRollDirection;
  private hasSlice = false;

  constructor(sampleRate: number, parameters: BrowserRollParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    this.maxSliceFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_SECONDS) + 2;
    this.leftBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
    this.rightBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];

    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentSliceBeats = this.pendingSliceBeats = this.quantizeSliceBeats(parameters.sliceBeats ?? 0.5);
    this.currentDecayPercent = this.pendingDecayPercent = this.clampPercent(parameters.decayPercent ?? 20);
    this.currentPitchSemitones = this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones ?? 0);
    this.currentDirection = this.pendingDirection = this.clampDirection(parameters.direction ?? 'forward');
    this.playbackRate = this.rateForSemitones(this.currentPitchSemitones);
    this.playbackDirectionSign = this.currentDirection === 'reverse' ? -1 : 1;
    this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
    this.framesUntilBoundary = this.activeIntervalFrames;
  }

  get hasCapturedSlice(): boolean {
    return this.hasSlice;
  }

  get activeSliceFrames(): number {
    return this.playbackLength;
  }

  get remainingFramesToBoundary(): number {
    return this.framesUntilBoundary;
  }

  get diagnostics(): Readonly<{
    framesProcessed: number;
    boundaryCount: number;
    lastBoundaryFrame: number;
    activeBpm: number;
    activeSliceBeats: number;
    activeSliceFrames: number;
    activeDecayPercent: number;
    activePitchSemitones: number;
    playbackRate: number;
    activeDirection: BrowserRollDirection;
    remainingFramesToBoundary: number;
    capturedSlice: boolean;
    currentGain: number;
    fadeRemainingFrames: number;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      boundaryCount: this.boundaryCount,
      lastBoundaryFrame: this.lastBoundaryFrame,
      activeBpm: this.currentBpm,
      activeSliceBeats: this.currentSliceBeats,
      activeSliceFrames: this.playbackLength,
      activeDecayPercent: this.currentDecayPercent,
      activePitchSemitones: this.currentPitchSemitones,
      playbackRate: this.playbackRate,
      activeDirection: this.currentDirection,
      remainingFramesToBoundary: this.framesUntilBoundary,
      capturedSlice: this.hasSlice,
      currentGain: this.gain,
      fadeRemainingFrames: Math.max(0, this.fadeFrames - this.fadePosition),
    };
  }

  setParameters(parameters: BrowserRollParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.sliceBeats)) {
      this.pendingSliceBeats = this.quantizeSliceBeats(parameters.sliceBeats as number);
    }
    if (Number.isFinite(parameters.decayPercent)) {
      this.pendingDecayPercent = this.clampPercent(parameters.decayPercent as number);
    }
    if (Number.isFinite(parameters.pitchSemitones)) {
      this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones as number);
    }
    if (parameters.direction === 'forward' || parameters.direction === 'reverse' || parameters.direction === 'alternate') {
      this.pendingDirection = parameters.direction;
    }
  }

  /** Writes one stereo frame. No allocation occurs in this audio callback. */
  processSample(left: number, right: number): void {
    const captureLeft = this.leftBuffers[this.captureBufferIndex]!;
    const captureRight = this.rightBuffers[this.captureBufferIndex]!;
    if (this.captureFrames < this.maxSliceFrames) {
      captureLeft[this.captureFrames] = this.sanitizeInput(left);
      captureRight[this.captureFrames] = this.sanitizeInput(right);
    }

    if (!this.hasSlice || this.playbackBufferIndex < 0 || this.playbackLength <= 0) {
      this.wetLeft = 0;
      this.wetRight = 0;
    } else {
      this.renderPlayback();
    }

    this.recordFadeTail();
    if (this.hasSlice && this.playbackLength > 0) this.advancePlayback();

    this.captureFrames = Math.min(this.captureFrames + 1, this.maxSliceFrames);
    this.framesUntilBoundary -= 1;
    this.framesProcessed += 1;

    if (this.framesUntilBoundary <= 0) {
      this.onBoundary();
    }
  }

  /** Reset signal history while retaining constructor-allocated buffers. */
  reset(): void {
    this.captureBufferIndex = 0;
    this.playbackBufferIndex = -1;
    this.captureFrames = 0;
    this.playbackLength = 0;
    this.playbackPosition = 0;
    this.gain = 1;
    this.tailWriteIndex = 0;
    this.tailFrames = 0;
    this.fadeTailStart = 0;
    this.fadeFrames = 0;
    this.fadePosition = 0;
    this.fadeTailLeft.fill(0);
    this.fadeTailRight.fill(0);
    this.currentBpm = this.pendingBpm;
    this.currentSliceBeats = this.pendingSliceBeats;
    this.currentDecayPercent = this.pendingDecayPercent;
    this.currentPitchSemitones = this.pendingPitchSemitones;
    this.currentDirection = this.pendingDirection;
    this.playbackRate = this.rateForSemitones(this.currentPitchSemitones);
    this.playbackDirectionSign = this.currentDirection === 'reverse' ? -1 : 1;
    this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
    this.framesUntilBoundary = this.activeIntervalFrames;
    this.hasSlice = false;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.framesProcessed = 0;
    this.boundaryCount = 0;
    this.lastBoundaryFrame = -1;
  }

  private renderPlayback(): void {
    const leftBuffer = this.leftBuffers[this.playbackBufferIndex]!;
    const rightBuffer = this.rightBuffers[this.playbackBufferIndex]!;
    let left = this.readFourPoint(leftBuffer, this.playbackPosition) * this.gain;
    let right = this.readFourPoint(rightBuffer, this.playbackPosition) * this.gain;

    if (this.fadePosition < this.fadeFrames) {
      const position = this.fadeFrames <= 1 ? 1 : this.fadePosition / (this.fadeFrames - 1);
      const tailIndex = (this.fadeTailStart + this.fadePosition) % EVENT_FADE_FRAMES;
      const fadeOut = Math.cos(position * HALF_PI);
      const fadeIn = Math.sin(position * HALF_PI);
      left = this.fadeTailLeft[tailIndex]! * fadeOut + left * fadeIn;
      right = this.fadeTailRight[tailIndex]! * fadeOut + right * fadeIn;
      this.fadePosition += 1;
    }

    this.wetLeft = this.sanitizeOutput(left);
    this.wetRight = this.sanitizeOutput(right);
  }

  private advancePlayback(): void {
    const nextPosition = this.playbackPosition + (this.playbackDirectionSign * this.playbackRate);
    let wrapped = false;
    if (nextPosition >= this.playbackLength || nextPosition < 0) {
      this.playbackPosition = nextPosition % this.playbackLength;
      if (this.playbackPosition < 0) this.playbackPosition += this.playbackLength;
      wrapped = true;
    } else {
      this.playbackPosition = nextPosition;
    }
    if (wrapped) {
      // A playback wrap on the exact beat boundary is one retrigger event;
      // onBoundary applies the newly latched decay for it. Earlier wraps in
      // this beat decay immediately using the active parameters.
      if (this.framesUntilBoundary > 1) {
        this.gain *= 1 - (this.currentDecayPercent / 100);
      }
      this.beginEventFade();
    }
  }

  private recordFadeTail(): void {
    this.fadeTailLeft[this.tailWriteIndex] = this.wetLeft;
    this.fadeTailRight[this.tailWriteIndex] = this.wetRight;
    this.tailWriteIndex = (this.tailWriteIndex + 1) % EVENT_FADE_FRAMES;
    this.tailFrames = Math.min(EVENT_FADE_FRAMES, this.tailFrames + 1);
  }

  private beginEventFade(): void {
    this.fadeFrames = Math.min(EVENT_FADE_FRAMES, this.tailFrames);
    this.fadePosition = 0;
    this.fadeTailStart = (this.tailWriteIndex - this.fadeFrames + EVENT_FADE_FRAMES) % EVENT_FADE_FRAMES;
  }

  private onBoundary(): void {
    this.boundaryCount += 1;
    this.lastBoundaryFrame = this.framesProcessed - 1;

    const validFrames = Math.min(this.captureFrames, this.maxSliceFrames);
    const hadSlice = this.hasSlice;
    if (validFrames > 0) {
      this.playbackBufferIndex = this.captureBufferIndex;
      this.captureBufferIndex = 1 - this.captureBufferIndex;
      this.playbackLength = validFrames;
      this.hasSlice = true;
    }

    this.captureFrames = 0;
    this.currentBpm = this.pendingBpm;
    this.currentSliceBeats = this.pendingSliceBeats;
    this.currentDecayPercent = this.pendingDecayPercent;
    this.currentPitchSemitones = this.pendingPitchSemitones;
    this.currentDirection = this.pendingDirection;
    this.playbackRate = this.rateForSemitones(this.currentPitchSemitones);
    if (this.hasSlice) {
      // Decay is the amount lost per retrigger. A 20% decay retains 80% gain,
      // matching the Native processor and the percentage shown in the editor.
      // The final wrap on this boundary is deferred here and counted once.
      if (hadSlice) this.gain *= 1 - (this.pendingDecayPercent / 100);
      this.updatePlaybackDirection(hadSlice);
      this.playbackPosition = this.playbackDirectionSign > 0 ? 0 : this.playbackLength - 1;
      this.beginEventFade();
    }

    this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
    this.framesUntilBoundary = this.activeIntervalFrames;
  }

  private updatePlaybackDirection(hadSlice: boolean): void {
    if (this.currentDirection === 'forward') {
      this.playbackDirectionSign = 1;
    } else if (this.currentDirection === 'reverse') {
      this.playbackDirectionSign = -1;
    } else if (!hadSlice) {
      this.playbackDirectionSign = 1;
    } else {
      this.playbackDirectionSign *= -1;
    }
  }

  /** Four-point Lagrange interpolation, with every neighboring tap wrapped. */
  private readFourPoint(buffer: Float32Array, position: number): number {
    const length = this.playbackLength;
    if (length <= 1) return buffer[0] ?? 0;

    const base = Math.floor(position);
    const fraction = position - base;
    const previous = this.readWrapped(buffer, base - 1, length);
    const current = this.readWrapped(buffer, base, length);
    const next = this.readWrapped(buffer, base + 1, length);
    const afterNext = this.readWrapped(buffer, base + 2, length);
    const weightPrevious = -(fraction * (fraction - 1) * (fraction - 2)) / 6;
    const weightCurrent = ((fraction + 1) * (fraction - 1) * (fraction - 2)) / 2;
    const weightNext = -((fraction + 1) * fraction * (fraction - 2)) / 2;
    const weightAfterNext = ((fraction + 1) * fraction * (fraction - 1)) / 6;
    return (previous * weightPrevious)
      + (current * weightCurrent)
      + (next * weightNext)
      + (afterNext * weightAfterNext);
  }

  private readWrapped(buffer: Float32Array, index: number, length: number): number {
    let wrappedIndex = index % length;
    if (wrappedIndex < 0) wrappedIndex += length;
    return buffer[wrappedIndex] ?? 0;
  }

  private intervalFrames(bpm: number, sliceBeats: number): number {
    const rawFrames = (60 * this.sampleRate * sliceBeats) / bpm;
    return Math.max(1, Math.min(this.maxSliceFrames, Math.round(rawFrames)));
  }

  private rateForSemitones(semitones: number): number {
    return 2 ** (semitones / 12);
  }

  private clampBpm(value: number): number {
    return Math.max(MIN_BPM, Math.min(MAX_BPM, value));
  }

  private quantizeSliceBeats(value: number): number {
    let nearest: number = SLICE_DIVISIONS[0];
    let distance = Math.abs(value - nearest);
    for (let index = 1; index < SLICE_DIVISIONS.length; index += 1) {
      const option = SLICE_DIVISIONS[index]!;
      const nextDistance = Math.abs(value - option);
      if (nextDistance < distance) {
        nearest = option;
        distance = nextDistance;
      }
    }
    return nearest;
  }

  private clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value));
  }

  private clampPitch(value: number): number {
    return Math.max(-24, Math.min(24, value));
  }

  private clampDirection(value: BrowserRollDirection): BrowserRollDirection {
    return value === 'reverse' || value === 'alternate' ? value : 'forward';
  }

  private sanitizeInput(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-MAX_STORED_SAMPLE, Math.min(MAX_STORED_SAMPLE, value));
  }

  private sanitizeOutput(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-MAX_OUTPUT_SAMPLE, Math.min(MAX_OUTPUT_SAMPLE, value));
  }
}
