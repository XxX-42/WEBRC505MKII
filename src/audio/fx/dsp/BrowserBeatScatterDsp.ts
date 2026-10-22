export interface BrowserBeatScatterParameters {
  bpm?: number;
  sliceBeats?: number;
  scatterPercent?: number;
  pitchSemitones?: number;
  repeats?: number;
}

/**
 * Deterministic, bounded stereo grain scatter. Each tempo-defined slice is
 * captured into one of two fixed buffers while the previous captured slice is
 * read. The completed slice is partitioned into quantized grains; a local
 * seeded PRNG reorders those read heads according to the scatter control.
 * This is a clean-room functional reconstruction, not a Roland implementation.
 */
export class BrowserBeatScatterDsp {
  readonly sampleRate: number;
  readonly maxSliceFrames: number;

  wetLeft = 0;
  wetRight = 0;
  boundaryCount = 0;
  framesProcessed = 0;
  lastBoundaryFrame = -1;

  private readonly leftBuffers: readonly [Float32Array, Float32Array];
  private readonly rightBuffers: readonly [Float32Array, Float32Array];
  private readonly grainStarts = new Int32Array(16);
  private readonly grainLengths = new Int32Array(16);
  private captureBufferIndex = 0;
  private playbackBufferIndex = -1;
  private captureFrames = 0;
  private playbackLength = 0;
  private playbackElapsedFrames = 0;
  private framesUntilBoundary: number;
  private activeIntervalFrames: number;
  private currentBpm: number;
  private currentSliceBeats: number;
  private currentScatterPercent: number;
  private currentPitchSemitones: number;
  private pitchRatio = 1;
  private currentRepeats: number;
  private pendingBpm: number;
  private pendingSliceBeats: number;
  private pendingScatterPercent: number;
  private pendingPitchSemitones: number;
  private pendingRepeats: number;
  private randomState = 0x6d2b79f5;
  private previousWetLeft = 0;
  private previousWetRight = 0;
  private hasSlice = false;

  constructor(sampleRate: number, parameters: BrowserBeatScatterParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    // The catalog's largest slice is four beats. At 40 BPM that is six seconds.
    this.maxSliceFrames = Math.ceil(this.sampleRate * 6) + 2;
    this.leftBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
    this.rightBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];

    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentSliceBeats = this.pendingSliceBeats = this.clampSliceBeats(parameters.sliceBeats ?? 0.25);
    this.currentScatterPercent = this.pendingScatterPercent = this.clampPercent(parameters.scatterPercent ?? 50);
    this.currentPitchSemitones = this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones ?? 0);
    this.pitchRatio = 2 ** (this.currentPitchSemitones / 12);
    this.currentRepeats = this.pendingRepeats = this.clampRepeats(parameters.repeats ?? 4);
    this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
    this.framesUntilBoundary = this.activeIntervalFrames;
  }

  get hasCapturedSlice(): boolean {
    return this.hasSlice;
  }

  get activeBpm(): number { return this.currentBpm; }
  get activeSliceBeats(): number { return this.currentSliceBeats; }
  get activeScatterPercent(): number { return this.currentScatterPercent; }
  get activePitchSemitones(): number { return this.currentPitchSemitones; }
  get activeRepeats(): number { return this.currentRepeats; }
  get activeSliceFrames(): number { return this.playbackLength; }
  get remainingFramesToBoundary(): number { return this.framesUntilBoundary; }

  /** Exact documented note lengths, including 1/32 note; legacy quantization is unchanged. */
  setOfficialLengthBeats(beats: number, initial = false): void {
    if (!Number.isFinite(beats) || beats < 0.125 || beats > 4) return;
    this.pendingSliceBeats = beats;
    if (initial) {
      this.currentSliceBeats = beats;
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, beats);
      this.framesUntilBoundary = this.activeIntervalFrames;
    }
  }

  setParameters(parameters: BrowserBeatScatterParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.sliceBeats)) this.pendingSliceBeats = this.clampSliceBeats(parameters.sliceBeats as number);
    if (Number.isFinite(parameters.scatterPercent)) this.pendingScatterPercent = this.clampPercent(parameters.scatterPercent as number);
    if (Number.isFinite(parameters.pitchSemitones)) this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones as number);
    if (Number.isFinite(parameters.repeats)) this.pendingRepeats = this.clampRepeats(parameters.repeats as number);
  }

  /** Mutates wetLeft/wetRight; no allocations occur in the audio callback. */
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
      this.renderGrain();
    }

    this.captureFrames = Math.min(this.captureFrames + 1, this.maxSliceFrames);
    this.framesUntilBoundary -= 1;
    this.framesProcessed += 1;
    if (this.framesUntilBoundary <= 0) this.onBoundary();
  }

  reset(): void {
    // Buffer contents are hidden by hasSlice until a complete slice is captured.
    this.captureBufferIndex = 0;
    this.playbackBufferIndex = -1;
    this.captureFrames = 0;
    this.playbackLength = 0;
    this.playbackElapsedFrames = 0;
    this.currentBpm = this.pendingBpm;
    this.currentSliceBeats = this.pendingSliceBeats;
    this.currentScatterPercent = this.pendingScatterPercent;
    this.currentPitchSemitones = this.pendingPitchSemitones;
    this.pitchRatio = 2 ** (this.currentPitchSemitones / 12);
    this.currentRepeats = this.pendingRepeats;
    this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
    this.framesUntilBoundary = this.activeIntervalFrames;
    this.randomState = 0x6d2b79f5;
    this.previousWetLeft = 0;
    this.previousWetRight = 0;
    this.hasSlice = false;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.boundaryCount = 0;
    this.framesProcessed = 0;
    this.lastBoundaryFrame = -1;
  }

  private renderGrain(): void {
    const repeats = this.currentRepeats;
    const segmentIndex = Math.min(
      repeats - 1,
      Math.floor((this.playbackElapsedFrames * repeats) / this.activeIntervalFrames),
    );
    const outputSegmentStart = Math.floor((segmentIndex * this.activeIntervalFrames) / repeats);
    const outputSegmentEnd = Math.floor(((segmentIndex + 1) * this.activeIntervalFrames) / repeats);
    const outputSegmentFrames = Math.max(1, outputSegmentEnd - outputSegmentStart);
    const outputOffset = this.playbackElapsedFrames - outputSegmentStart;
    const sourceStart = this.grainStarts[segmentIndex] ?? 0;
    const sourceLength = Math.max(1, this.grainLengths[segmentIndex] ?? 1);
    const sourcePosition = ((outputOffset / outputSegmentFrames) * sourceLength * this.pitchRatio) % sourceLength;
    const sourceIndexOffset = Math.floor(sourcePosition);
    const fraction = sourcePosition - sourceIndexOffset;
    const firstIndex = sourceStart + sourceIndexOffset;
    const secondIndex = sourceStart + ((sourceIndexOffset + 1) % sourceLength);
    const playbackLeft = this.leftBuffers[this.playbackBufferIndex]!;
    const playbackRight = this.rightBuffers[this.playbackBufferIndex]!;
    let left = (playbackLeft[firstIndex] ?? 0) + ((playbackLeft[secondIndex] ?? 0) - (playbackLeft[firstIndex] ?? 0)) * fraction;
    let right = (playbackRight[firstIndex] ?? 0) + ((playbackRight[secondIndex] ?? 0) - (playbackRight[firstIndex] ?? 0)) * fraction;

    // A short, bounded transition softens read-head jumps without adding delay.
    const fadeFrames = Math.min(16, Math.floor(outputSegmentFrames / 2));
    if (fadeFrames > 1 && outputOffset < fadeFrames) {
      const fadeIn = (outputOffset + 1) / fadeFrames;
      left = this.previousWetLeft * (1 - fadeIn) + left * fadeIn;
      right = this.previousWetRight * (1 - fadeIn) + right * fadeIn;
    }

    this.wetLeft = left;
    this.wetRight = right;
    this.previousWetLeft = left;
    this.previousWetRight = right;
    this.playbackElapsedFrames += 1;
  }

  private onBoundary(): void {
    this.boundaryCount += 1;
    this.lastBoundaryFrame = this.framesProcessed - 1;
    const validFrames = Math.min(this.captureFrames, this.maxSliceFrames);
    if (validFrames > 0) {
      this.playbackBufferIndex = this.captureBufferIndex;
      this.captureBufferIndex = 1 - this.captureBufferIndex;
      this.playbackLength = validFrames;
      this.hasSlice = true;
    }

    this.captureFrames = 0;
    this.playbackElapsedFrames = 0;
    this.currentBpm = this.pendingBpm;
    this.currentSliceBeats = this.pendingSliceBeats;
    this.currentScatterPercent = this.pendingScatterPercent;
    this.currentPitchSemitones = this.pendingPitchSemitones;
    this.pitchRatio = 2 ** (this.currentPitchSemitones / 12);
    this.currentRepeats = this.pendingRepeats;
    this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
    this.framesUntilBoundary = this.activeIntervalFrames;
    if (this.hasSlice) this.prepareGrains();
  }

  private prepareGrains(): void {
    const repeats = this.currentRepeats;
    const scatter = this.currentScatterPercent / 100;
    for (let index = 0; index < repeats; index += 1) {
      const randomBucket = this.nextRandom() % repeats;
      const bucket = Math.round(index + ((randomBucket - index) * scatter));
      const start = Math.floor((bucket * this.playbackLength) / repeats);
      const end = Math.floor(((bucket + 1) * this.playbackLength) / repeats);
      this.grainStarts[index] = start;
      this.grainLengths[index] = Math.max(1, end - start);
    }
  }

  private nextRandom(): number {
    // xorshift32: deterministic per instance and bounded integer state.
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState;
  }

  private intervalFrames(bpm: number, sliceBeats: number): number {
    const rawFrames = (60 * this.sampleRate * sliceBeats) / bpm;
    return Math.max(1, Math.min(this.maxSliceFrames, Math.round(rawFrames)));
  }

  private clampBpm(value: number): number {
    return Math.max(40, Math.min(300, value));
  }

  private clampSliceBeats(value: number): number {
    const options = [0.25, 0.5, 1, 2, 4];
    let nearest = 0.25;
    let distance = Math.abs(value - nearest);
    for (let index = 1; index < options.length; index += 1) {
      const option = options[index]!;
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

  private clampRepeats(value: number): number {
    return Math.round(Math.max(1, Math.min(16, value)));
  }
}
