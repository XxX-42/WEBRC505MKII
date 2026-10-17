import { equalPowerFadeInGain, equalPowerFadeOutGain } from '../../dsp/equalPowerCrossfade';

export interface BeatRepeatParameters {
  bpm?: number;
  division?: number;
  decay?: number;
  direction?: number;
}

/**
 * Fixed-capacity stereo beat-repeat capture/retrigger engine.  The first
 * subdivision is passed through while it is captured; subsequent subdivisions
 * are captured into the alternate buffer and retriggered at sample-clock
 * boundaries.  All audio storage is allocated once in the constructor.
 */
export class BeatRepeatDsp {
  readonly maxSliceFrames: number;
  readonly sampleRate: number;

  wetLeft = 0;
  wetRight = 0;
  boundaryCount = 0;
  framesProcessed = 0;
  lastBoundaryFrame = -1;

  private readonly leftBuffers: readonly [Float32Array, Float32Array];
  private readonly rightBuffers: readonly [Float32Array, Float32Array];
  private captureBufferIndex = 0;
  private playbackBufferIndex = -1;
  private captureFrames = 0;
  private playbackLength = 0;
  private playbackPosition = 0;
  private framesUntilBoundary: number;
  private currentBpm: number;
  private currentDivision: number;
  private currentDecay: number;
  private currentDirection: number;
  private pendingBpm: number;
  private pendingDivision: number;
  private pendingDecay: number;
  private pendingDirection: number;
  private directionReverse = false;
  private repeatGain = 1;
  private hasSlice = false;

  constructor(sampleRate: number, parameters: BeatRepeatParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    // Catalog bounds: 4 beats at 40 BPM = a fixed maximum 6-second slice.
    this.maxSliceFrames = Math.ceil(this.sampleRate * 6) + 2;
    this.leftBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
    this.rightBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];

    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentDivision = this.pendingDivision = this.clampDivision(parameters.division ?? 0.5);
    this.currentDecay = this.pendingDecay = this.clampDecay(parameters.decay ?? 15);
    this.currentDirection = this.pendingDirection = this.clampDirection(parameters.direction ?? 0);
    this.framesUntilBoundary = this.intervalFrames(this.currentBpm, this.currentDivision);
  }

  get hasCapturedSlice(): boolean {
    return this.hasSlice;
  }

  get activeBpm(): number {
    return this.currentBpm;
  }

  get activeDivision(): number {
    return this.currentDivision;
  }

  get activeDirection(): number {
    return this.currentDirection;
  }

  get activeSliceFrames(): number {
    return this.playbackLength;
  }

  get remainingFramesToBoundary(): number {
    return this.framesUntilBoundary;
  }

  setParameters(parameters: BeatRepeatParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.division)) this.pendingDivision = this.clampDivision(parameters.division as number);
    if (Number.isFinite(parameters.decay)) this.pendingDecay = this.clampDecay(parameters.decay as number);
    if (Number.isFinite(parameters.direction)) this.pendingDirection = this.clampDirection(parameters.direction as number);
  }

  /** Mutates wetLeft/wetRight and does not allocate. */
  processSample(left: number, right: number): void {
    const captureLeft = this.leftBuffers[this.captureBufferIndex]!;
    const captureRight = this.rightBuffers[this.captureBufferIndex]!;
    if (this.captureFrames < this.maxSliceFrames) {
      captureLeft[this.captureFrames] = left;
      captureRight[this.captureFrames] = right;
    }

    if (!this.hasSlice || this.playbackBufferIndex < 0 || this.playbackLength <= 0) {
      this.wetLeft = 0;
      this.wetRight = 0;
    } else {
      this.renderPlayback(captureLeft, captureRight);
    }

    this.captureFrames += 1;
    this.framesUntilBoundary -= 1;
    this.framesProcessed += 1;
    if (this.framesUntilBoundary <= 0) this.onBoundary();
  }

  reset(): void {
    // The capture length gates every read, so stale capacity beyond the next
    // completed slice is unreachable and does not need a full-buffer clear.
    this.captureBufferIndex = 0;
    this.playbackBufferIndex = -1;
    this.captureFrames = 0;
    this.playbackLength = 0;
    this.playbackPosition = 0;
    this.currentBpm = this.pendingBpm;
    this.currentDivision = this.pendingDivision;
    this.currentDecay = this.pendingDecay;
    this.currentDirection = this.pendingDirection;
    this.framesUntilBoundary = this.intervalFrames(this.currentBpm, this.currentDivision);
    this.directionReverse = false;
    this.repeatGain = 1;
    this.hasSlice = false;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.boundaryCount = 0;
    this.framesProcessed = 0;
    this.lastBoundaryFrame = -1;
  }

  private renderPlayback(nextLeft: Float32Array, nextRight: Float32Array): void {
    const bufferIndex = this.playbackBufferIndex;
    const fadeFrames = this.crossfadeFrames(this.playbackLength);
    const fadeToNextSlice = fadeFrames > 0
      && !this.directionReverse
      && this.currentDirection === 0
      && this.pendingDirection === 0
      && this.framesUntilBoundary <= fadeFrames;
    const fadePosition = fadeToNextSlice ? fadeFrames - this.framesUntilBoundary : 0;
    let readIndex = this.playbackPosition;
    if (readIndex < 0) readIndex = 0;
    else if (readIndex >= this.playbackLength) readIndex = this.playbackLength - 1;

    let left = this.leftBuffers[bufferIndex]![readIndex] ?? 0;
    let right = this.rightBuffers[bufferIndex]![readIndex] ?? 0;

    if (fadeToNextSlice && this.captureFrames > fadePosition) {
      let incomingIndex = fadePosition;
      if (incomingIndex < 0) incomingIndex = 0;
      if (incomingIndex >= this.maxSliceFrames) incomingIndex = this.maxSliceFrames - 1;
      const position = (fadePosition + 1) / fadeFrames;
      const oldGain = equalPowerFadeOutGain(position);
      const newGain = equalPowerFadeInGain(position);
      left = left * oldGain + (nextLeft[incomingIndex] ?? 0) * newGain;
      right = right * oldGain + (nextRight[incomingIndex] ?? 0) * newGain;
    } else if (fadeFrames > 0 && this.isAtLoopTail(readIndex, fadeFrames)) {
      // Equal-power seam crossfade for a slice that loops before the next
      // event (possible immediately after a BPM/subdivision change).
      const position = this.directionReverse
        ? (fadeFrames - readIndex) / fadeFrames
        : (readIndex - (this.playbackLength - fadeFrames) + 1) / fadeFrames;
      const nextIndex = this.directionReverse
        ? this.playbackLength - 1 - (fadeFrames - 1 - readIndex)
        : readIndex - (this.playbackLength - fadeFrames);
      const oldGain = equalPowerFadeOutGain(position);
      const newGain = equalPowerFadeInGain(position);
      left = left * oldGain + (this.leftBuffers[bufferIndex]![nextIndex] ?? 0) * newGain;
      right = right * oldGain + (this.rightBuffers[bufferIndex]![nextIndex] ?? 0) * newGain;
    }

    this.wetLeft = left * this.repeatGain;
    this.wetRight = right * this.repeatGain;
    this.advancePlaybackPosition();
  }

  private isAtLoopTail(readIndex: number, fadeFrames: number): boolean {
    return this.directionReverse
      ? readIndex < fadeFrames
      : readIndex >= this.playbackLength - fadeFrames;
  }

  private advancePlaybackPosition(): void {
    if (this.directionReverse) {
      this.playbackPosition -= 1;
      if (this.playbackPosition < 0) {
        this.playbackPosition = Math.max(0, this.playbackLength - this.crossfadeFrames(this.playbackLength) - 1);
        if (this.framesUntilBoundary > 1) this.onRetrigger();
      }
    } else {
      this.playbackPosition += 1;
      if (this.playbackPosition >= this.playbackLength) {
        this.playbackPosition = Math.min(this.playbackLength - 1, this.crossfadeFrames(this.playbackLength));
        if (this.framesUntilBoundary > 1) this.onRetrigger();
      }
    }
  }

  private onRetrigger(): void {
    this.repeatGain *= 1 - (this.currentDecay / 100);
    if (this.repeatGain < 1e-6) this.repeatGain = 0;
  }

  private onBoundary(): void {
    this.boundaryCount += 1;
    this.lastBoundaryFrame = this.framesProcessed - 1;
    const validFrames = Math.min(this.captureFrames, this.maxSliceFrames);

    if (validFrames > 0) {
      const previousReadBuffer = this.playbackBufferIndex;
      const replacingExistingSlice = this.hasSlice;
      const eventCrossfadeApplied = replacingExistingSlice
        && !this.directionReverse
        && this.currentDirection === 0
        && this.pendingDirection === 0;
      if (!this.hasSlice) {
        this.repeatGain = 1;
        this.directionReverse = this.currentDirection === 1;
      } else {
        this.onRetrigger();
        if (this.pendingDirection === 2) {
          this.directionReverse = !this.directionReverse;
        } else {
          this.directionReverse = this.pendingDirection === 1;
        }
      }
      this.playbackBufferIndex = this.captureBufferIndex;
      this.captureBufferIndex = previousReadBuffer >= 0 ? previousReadBuffer : 1 - this.captureBufferIndex;
      this.playbackLength = validFrames;
      this.hasSlice = true;
      const fadeFrames = this.crossfadeFrames(validFrames);
      this.playbackPosition = this.directionReverse
        ? Math.max(0, validFrames - 1)
        : Math.min(validFrames - 1, eventCrossfadeApplied ? fadeFrames : 0);
    }

    this.captureFrames = 0;
    this.currentBpm = this.pendingBpm;
    this.currentDivision = this.pendingDivision;
    this.currentDecay = this.pendingDecay;
    this.currentDirection = this.pendingDirection;
    this.framesUntilBoundary = this.intervalFrames(this.currentBpm, this.currentDivision);
  }

  private intervalFrames(bpm: number, division: number): number {
    const rawFrames = (60 * this.sampleRate * division) / bpm;
    return Math.max(1, Math.min(this.maxSliceFrames, Math.round(rawFrames)));
  }

  private crossfadeFrames(sliceFrames: number): number {
    return Math.min(Math.floor(sliceFrames / 2), Math.max(1, Math.round(this.sampleRate * 0.005)));
  }

  private clampBpm(value: number): number {
    return Math.max(40, Math.min(300, value));
  }

  private clampDivision(value: number): number {
    const options = [0.25, 0.5, 1, 2, 4];
    let nearest = options[0] ?? 0.25;
    let nearestDistance = Math.abs(value - nearest);
    for (let index = 1; index < options.length; index += 1) {
      const option = options[index] ?? nearest;
      const distance = Math.abs(value - option);
      if (distance < nearestDistance) {
        nearest = option;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private clampDecay(value: number): number {
    return Math.max(0, Math.min(100, value));
  }

  private clampDirection(value: number): number {
    return Math.max(0, Math.min(2, Math.round(value)));
  }
}
