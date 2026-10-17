export interface BrowserReverseReverbParameters {
  bpm?: number;
  segmentBeats?: number;
  /** Percentage units, 0..80. */
  feedbackPercent?: number;
  crossfadeMs?: number;
  decaySeconds?: number;
  dampingCutoffHz?: number;
}

const SEGMENT_BEAT_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;
const FDN_DELAY_SECONDS = [0.0297, 0.0371, 0.0411, 0.0533, 0.0617, 0.0719, 0.0797, 0.0893] as const;
const DIFFUSER_DELAY_SECONDS = [0.0037, 0.0053, 0.0071, 0.0113] as const;
const ALLPASS_COEFFICIENTS = [0.68, 0.62, 0.57, 0.53] as const;
const MAX_INTERNAL_SAMPLE = 8;
const MAX_FEEDBACK = 0.8;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Experimental clean-room segmented reverse reverb for the Browser worklet.
 * Alternating bounded stereo buffers capture beat-quantized source segments;
 * each completed segment is played backward through an independent stereo
 * 16-line stereo FDN return (eight decorrelated feedback lines per channel). An authored
 * overlap crossfade softens reverse-segment boundaries. This provisional
 * functional model uses no measured reverse IR, factory firmware topology,
 * Roland source/code, or sound-quality acceptance claim.
 *
 * Memory is allocated only at construction and sized for four beats at the
 * minimum supported 30 BPM. `processSample` is allocation-free and sample-
 * clocked, so it is independent of Browser worklet callback frame sizes.
 */
export class BrowserReverseReverbDsp {
  readonly sampleRate: number;
  readonly maxSegmentFrames: number;
  readonly maxBufferSamples: number;

  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  boundaryCount = 0;
  crossfadeCount = 0;

  private readonly captureLeft: readonly [Float32Array, Float32Array];
  private readonly captureRight: readonly [Float32Array, Float32Array];
  private readonly outgoingTailLeft: Float32Array;
  private readonly outgoingTailRight: Float32Array;
  private readonly diffuserBuffers: readonly [readonly Float32Array[], readonly Float32Array[]];
  private readonly diffuserWriteIndices: [Int32Array, Int32Array];
  private readonly fdnBuffers: readonly [readonly Float32Array[], readonly Float32Array[]];
  private readonly fdnWriteIndices: [Int32Array, Int32Array];
  private readonly fdnDampingStates: [Float64Array, Float64Array];
  private readonly fdnFeedbackGains: [Float64Array, Float64Array];

  private captureBufferIndex = 0;
  private playbackBufferIndex = -1;
  private captureFrames = 0;
  private playbackLength = 0;
  private playbackDurationFrames = 0;
  private playbackElapsedFrames = 0;
  private currentSegmentFrames: number;
  private currentBpm: number;
  private currentSegmentBeats: number;
  private currentFeedback: number;
  private currentCrossfadeMs: number;
  private currentDecaySeconds: number;
  private currentDampingCutoffHz: number;
  private pendingBpm: number;
  private pendingSegmentBeats: number;
  private pendingFeedback: number;
  private pendingCrossfadeMs: number;
  private overlapFrames = 0;
  private outgoingTailFrames = 0;
  private hasCapturedSegment = false;
  private hasPreviousTail = false;
  private dampingAlpha: number;

  constructor(sampleRate: number, parameters: BrowserReverseReverbParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
    // Shared descriptor range supports four beats at 30 BPM (eight seconds).
    this.maxSegmentFrames = Math.ceil(this.sampleRate * (60 / 30) * 4);
    const maxCrossfadeFrames = Math.max(1, Math.round(this.sampleRate * 0.1));
    this.captureLeft = [new Float32Array(this.maxSegmentFrames), new Float32Array(this.maxSegmentFrames)];
    this.captureRight = [new Float32Array(this.maxSegmentFrames), new Float32Array(this.maxSegmentFrames)];
    this.outgoingTailLeft = new Float32Array(Math.min(maxCrossfadeFrames, Math.floor(this.maxSegmentFrames / 2)));
    this.outgoingTailRight = new Float32Array(this.outgoingTailLeft.length);
    this.diffuserBuffers = [this.createDiffusers(0), this.createDiffusers(1)];
    this.diffuserWriteIndices = [new Int32Array(DIFFUSER_DELAY_SECONDS.length), new Int32Array(DIFFUSER_DELAY_SECONDS.length)];
    this.fdnBuffers = [this.createFdnLines(0), this.createFdnLines(1)];
    this.fdnWriteIndices = [new Int32Array(FDN_DELAY_SECONDS.length), new Int32Array(FDN_DELAY_SECONDS.length)];
    this.fdnDampingStates = [new Float64Array(FDN_DELAY_SECONDS.length), new Float64Array(FDN_DELAY_SECONDS.length)];
    this.fdnFeedbackGains = [new Float64Array(FDN_DELAY_SECONDS.length), new Float64Array(FDN_DELAY_SECONDS.length)];

    this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentSegmentBeats = this.pendingSegmentBeats = this.quantizeBeats(parameters.segmentBeats ?? 0.5);
    this.currentFeedback = this.pendingFeedback = this.clampFeedbackPercent(parameters.feedbackPercent ?? 0);
    this.currentCrossfadeMs = this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs ?? 20);
    this.currentDecaySeconds = clamp(finiteOrZero(parameters.decaySeconds ?? 2), 0.1, 10);
    this.currentDampingCutoffHz = clamp(finiteOrZero(parameters.dampingCutoffHz ?? 8000), 500, Math.min(16_000, this.sampleRate * 0.499));
    this.currentSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
    this.dampingAlpha = 1 - Math.exp(-2 * Math.PI * this.currentDampingCutoffHz / this.sampleRate);
    this.refreshFeedbackGains();
    this.overlapFrames = this.computeOverlapFrames(this.currentSegmentFrames, this.currentCrossfadeMs);

    this.maxBufferSamples = this.captureLeft[0].length * 4
      + this.outgoingTailLeft.length * 2
      + this.totalSamples(this.diffuserBuffers)
      + this.totalSamples(this.fdnBuffers)
      + this.diffuserWriteIndices[0].length * 2
      + this.fdnWriteIndices[0].length * 2
      + this.fdnDampingStates[0].length * 4
      + this.fdnFeedbackGains[0].length * 4;
  }

  /** One complete input-segment buffer is the intentional reverse pre-delay. */
  get latencySamples(): number {
    return this.currentSegmentFrames;
  }

  get hasCaptured(): boolean {
    return this.hasCapturedSegment;
  }

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
    effectiveDecaySeconds: number;
    dampingCutoffHz: number;
    maxSegmentFrames: number;
    maxBufferSamples: number;
    hasCapturedSegment: boolean;
  }> {
    return {
      framesProcessed: this.framesProcessed,
      boundaryCount: this.boundaryCount,
      crossfadeCount: this.crossfadeCount,
      activeBpm: this.currentBpm,
      activeSegmentBeats: this.currentSegmentBeats,
      activeSegmentFrames: this.currentSegmentFrames,
      pendingBpm: this.pendingBpm,
      pendingSegmentBeats: this.pendingSegmentBeats,
      remainingFramesToBoundary: this.currentSegmentFrames - this.captureFrames,
      playbackElapsedFrames: this.playbackElapsedFrames,
      playbackDurationFrames: this.playbackDurationFrames,
      overlapFrames: this.overlapFrames,
      effectiveDecaySeconds: this.currentDecaySeconds,
      dampingCutoffHz: this.currentDampingCutoffHz,
      maxSegmentFrames: this.maxSegmentFrames,
      maxBufferSamples: this.maxBufferSamples,
      hasCapturedSegment: this.hasCapturedSegment,
    };
  }

  setParameters(parameters: BrowserReverseReverbParameters): void {
    if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.segmentBeats)) this.pendingSegmentBeats = this.quantizeBeats(parameters.segmentBeats as number);
    if (Number.isFinite(parameters.feedbackPercent)) this.pendingFeedback = this.clampFeedbackPercent(parameters.feedbackPercent as number);
    if (Number.isFinite(parameters.crossfadeMs)) this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs as number);
    if (Number.isFinite(parameters.decaySeconds)) {
      this.currentDecaySeconds = clamp(parameters.decaySeconds as number, 0.1, 10);
      this.refreshFeedbackGains();
    }
    if (Number.isFinite(parameters.dampingCutoffHz)) {
      this.currentDampingCutoffHz = clamp(parameters.dampingCutoffHz as number, 500, Math.min(16_000, this.sampleRate * 0.499));
      this.dampingAlpha = 1 - Math.exp(-2 * Math.PI * this.currentDampingCutoffHz / this.sampleRate);
    }
  }

  /** Mutates wetLeft/wetRight without allocating or assuming a block size. */
  processSample(inputLeft: number, inputRight: number): void {
    const safeLeft = clamp(finiteOrZero(inputLeft), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
    const safeRight = clamp(finiteOrZero(inputRight), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
    let reverseInputLeft = 0;
    let reverseInputRight = 0;
    if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
      const sourceOffset = this.reverseSourceOffset(this.playbackElapsedFrames);
      reverseInputLeft = this.captureLeft[this.playbackBufferIndex]![sourceOffset] ?? 0;
      reverseInputRight = this.captureRight[this.playbackBufferIndex]![sourceOffset] ?? 0;
      if (this.hasPreviousTail && this.playbackElapsedFrames < this.outgoingTailFrames) {
        const position = this.outgoingTailFrames <= 1 ? 1 : this.playbackElapsedFrames / (this.outgoingTailFrames - 1);
        const fadeOut = Math.cos(position * Math.PI / 2);
        const fadeIn = Math.sin(position * Math.PI / 2);
        reverseInputLeft = this.outgoingTailLeft[this.playbackElapsedFrames]! * fadeOut + reverseInputLeft * fadeIn;
        reverseInputRight = this.outgoingTailRight[this.playbackElapsedFrames]! * fadeOut + reverseInputRight * fadeIn;
      }
    }

    this.wetLeft = this.processFdn(reverseInputLeft, reverseInputRight, 0);
    this.wetRight = this.processFdn(reverseInputRight, reverseInputLeft, 1);

    const captureLeft = this.captureLeft[this.captureBufferIndex]!;
    const captureRight = this.captureRight[this.captureBufferIndex]!;
    captureLeft[this.captureFrames] = clamp(finiteOrZero(safeLeft + this.currentFeedback * this.wetLeft), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
    captureRight[this.captureFrames] = clamp(finiteOrZero(safeRight + this.currentFeedback * this.wetRight), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);

    this.captureFrames += 1;
    if (this.hasCapturedSegment) this.playbackElapsedFrames += 1;
    this.framesProcessed += 1;
    if (this.captureFrames >= this.currentSegmentFrames) this.onBoundary();
  }

  reset(): void {
    this.captureLeft[0].fill(0);
    this.captureLeft[1].fill(0);
    this.captureRight[0].fill(0);
    this.captureRight[1].fill(0);
    this.outgoingTailLeft.fill(0);
    this.outgoingTailRight.fill(0);
    for (let channel = 0; channel < 2; channel += 1) {
      const diffusers = this.diffuserBuffers[channel as 0 | 1];
      const lines = this.fdnBuffers[channel as 0 | 1];
      for (const buffer of diffusers) buffer.fill(0);
      for (const buffer of lines) buffer.fill(0);
      this.diffuserWriteIndices[channel as 0 | 1].fill(0);
      this.fdnWriteIndices[channel as 0 | 1].fill(0);
      this.fdnDampingStates[channel as 0 | 1].fill(0);
    }
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
    this.currentSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
    this.overlapFrames = this.computeOverlapFrames(this.currentSegmentFrames, this.currentCrossfadeMs);
    this.outgoingTailFrames = 0;
    this.hasCapturedSegment = false;
    this.hasPreviousTail = false;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.framesProcessed = 0;
    this.boundaryCount = 0;
    this.crossfadeCount = 0;
  }

  private createDiffusers(channel: 0 | 1): Float32Array[] {
    const channelScale = channel === 0 ? 1 : 1.071;
    return DIFFUSER_DELAY_SECONDS.map((seconds) => new Float32Array(
      Math.max(1, Math.round(this.sampleRate * seconds * channelScale)),
    ));
  }

  private createFdnLines(channel: 0 | 1): Float32Array[] {
    const channelScale = channel === 0 ? 1 : 1.037;
    return FDN_DELAY_SECONDS.map((seconds) => new Float32Array(
      Math.max(1, Math.round(this.sampleRate * seconds * channelScale)),
    ));
  }

  private processFdn(input: number, crossInput: number, channel: 0 | 1): number {
    const diffusers = this.diffuserBuffers[channel];
    const diffuserIndices = this.diffuserWriteIndices[channel];
    let diffused = input;
    for (let stage = 0; stage < diffusers.length; stage += 1) {
      const buffer = diffusers[stage]!;
      const writeIndex = diffuserIndices[stage] ?? 0;
      const delayed = buffer[writeIndex] ?? 0;
      const coefficient = ALLPASS_COEFFICIENTS[stage] ?? 0.5;
      const output = delayed - coefficient * diffused;
      buffer[writeIndex] = clamp(finiteOrZero(diffused + coefficient * output), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      diffuserIndices[stage] = writeIndex + 1 >= buffer.length ? 0 : writeIndex + 1;
      diffused = clamp(finiteOrZero(output), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
    }

    const lines = this.fdnBuffers[channel];
    const writeIndices = this.fdnWriteIndices[channel];
    const dampingStates = this.fdnDampingStates[channel];
    const d0 = this.readDamped(lines[0]!, writeIndices, 0, dampingStates);
    const d1 = this.readDamped(lines[1]!, writeIndices, 1, dampingStates);
    const d2 = this.readDamped(lines[2]!, writeIndices, 2, dampingStates);
    const d3 = this.readDamped(lines[3]!, writeIndices, 3, dampingStates);
    const d4 = this.readDamped(lines[4]!, writeIndices, 4, dampingStates);
    const d5 = this.readDamped(lines[5]!, writeIndices, 5, dampingStates);
    const d6 = this.readDamped(lines[6]!, writeIndices, 6, dampingStates);
    const d7 = this.readDamped(lines[7]!, writeIndices, 7, dampingStates);
    const scale = 1 / Math.sqrt(8);
    const h0 = (d0 + d1 + d2 + d3 + d4 + d5 + d6 + d7) * scale;
    const h1 = (d0 - d1 + d2 - d3 + d4 - d5 + d6 - d7) * scale;
    const h2 = (d0 + d1 - d2 - d3 + d4 + d5 - d6 - d7) * scale;
    const h3 = (d0 - d1 - d2 + d3 + d4 - d5 - d6 + d7) * scale;
    const h4 = (d0 + d1 + d2 + d3 - d4 - d5 - d6 - d7) * scale;
    const h5 = (d0 - d1 + d2 - d3 - d4 + d5 - d6 + d7) * scale;
    const h6 = (d0 + d1 - d2 - d3 - d4 - d5 + d6 + d7) * scale;
    const h7 = (d0 - d1 - d2 + d3 - d4 + d5 + d6 - d7) * scale;

    const feedback = this.fdnFeedbackGains[channel];
    const crossPolarity = channel === 0 ? 1 : -1;
    const primaryInput = diffused * 0.18;
    const crossInjection = crossInput * 0.035 * crossPolarity;
    this.writeFdnLine(lines[0]!, writeIndices, 0, primaryInput + crossInjection + h0 * feedback[0]!);
    this.writeFdnLine(lines[1]!, writeIndices, 1, primaryInput - crossInjection + h1 * feedback[1]!);
    this.writeFdnLine(lines[2]!, writeIndices, 2, -primaryInput + crossInjection + h2 * feedback[2]!);
    this.writeFdnLine(lines[3]!, writeIndices, 3, -primaryInput - crossInjection + h3 * feedback[3]!);
    this.writeFdnLine(lines[4]!, writeIndices, 4, primaryInput + crossInjection + h4 * feedback[4]!);
    this.writeFdnLine(lines[5]!, writeIndices, 5, -primaryInput + crossInjection + h5 * feedback[5]!);
    this.writeFdnLine(lines[6]!, writeIndices, 6, -primaryInput - crossInjection + h6 * feedback[6]!);
    this.writeFdnLine(lines[7]!, writeIndices, 7, primaryInput - crossInjection + h7 * feedback[7]!);

    // Alternating output signs decorrelate the two channels while preserving
    // a useful return level after all eight feedback lines are mixed.
    const output = (d0 - d1 + d2 - d3 + d4 - d5 + d6 - d7) * 0.24;
    return clamp(finiteOrZero(output), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
  }

  private readDamped(buffer: Float32Array, writeIndices: Int32Array, line: number, dampingStates: Float64Array): number {
    const delayed = buffer[writeIndices[line] ?? 0] ?? 0;
    const prior = dampingStates[line] ?? 0;
    const state = prior + this.dampingAlpha * (delayed - prior);
    dampingStates[line] = Number.isFinite(state) ? state : 0;
    return dampingStates[line] ?? 0;
  }

  private writeFdnLine(buffer: Float32Array, writeIndices: Int32Array, line: number, value: number): void {
    const writeIndex = writeIndices[line] ?? 0;
    buffer[writeIndex] = clamp(finiteOrZero(value), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
    writeIndices[line] = writeIndex + 1 >= buffer.length ? 0 : writeIndex + 1;
  }

  private refreshFeedbackGains(): void {
    for (let channel = 0; channel < 2; channel += 1) {
      const channelScale = channel === 0 ? 1 : 1.037;
      for (let line = 0; line < FDN_DELAY_SECONDS.length; line += 1) {
        const delaySeconds = (FDN_DELAY_SECONDS[line] ?? 0.03) * channelScale;
        const gain = Math.pow(0.001, delaySeconds / this.currentDecaySeconds);
        this.fdnFeedbackGains[channel as 0 | 1][line] = clamp(gain, 0, 0.995);
      }
    }
  }

  private computeOverlapFrames(segmentFrames: number, crossfadeMs: number): number {
    const requested = Math.round(this.sampleRate * crossfadeMs / 1000);
    return Math.max(1, Math.min(requested, Math.floor(segmentFrames / 2), this.outgoingTailLeft.length));
  }

  private onBoundary(): void {
    this.currentBpm = this.pendingBpm;
    this.currentSegmentBeats = this.pendingSegmentBeats;
    this.currentFeedback = this.pendingFeedback;
    this.currentCrossfadeMs = this.pendingCrossfadeMs;
    this.currentSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
    this.overlapFrames = this.computeOverlapFrames(this.currentSegmentFrames, this.currentCrossfadeMs);

    if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
      const copyFrames = Math.min(this.overlapFrames, this.playbackDurationFrames);
      for (let frame = 0; frame < copyFrames; frame += 1) {
        const offset = this.reverseSourceOffset(this.playbackDurationFrames - copyFrames + frame);
        this.outgoingTailLeft[frame] = this.captureLeft[this.playbackBufferIndex]![offset] ?? 0;
        this.outgoingTailRight[frame] = this.captureRight[this.playbackBufferIndex]![offset] ?? 0;
      }
      this.outgoingTailFrames = copyFrames;
      this.hasPreviousTail = copyFrames > 0;
      if (this.hasPreviousTail) this.crossfadeCount += 1;
    } else {
      this.outgoingTailLeft.fill(0);
      this.outgoingTailRight.fill(0);
      this.outgoingTailFrames = this.overlapFrames;
      this.hasPreviousTail = this.overlapFrames > 0;
    }

    this.playbackBufferIndex = this.captureBufferIndex;
    this.playbackLength = Math.min(this.captureFrames, this.maxSegmentFrames);
    this.captureBufferIndex = 1 - this.captureBufferIndex;
    this.captureFrames = 0;
    this.playbackDurationFrames = this.currentSegmentFrames;
    this.playbackElapsedFrames = 0;
    this.hasCapturedSegment = this.playbackLength > 0;
    this.boundaryCount += 1;
  }

  private reverseSourceOffset(elapsedFrames: number): number {
    if (this.playbackLength <= 1 || this.playbackDurationFrames <= 1) return Math.max(0, this.playbackLength - 1);
    const reversePosition = Math.max(0, this.playbackDurationFrames - 1 - elapsedFrames);
    return Math.min(this.playbackLength - 1, Math.floor((reversePosition * this.playbackLength) / this.playbackDurationFrames));
  }

  private segmentFrames(bpm: number, beats: number): number {
    return Math.max(1, Math.min(this.maxSegmentFrames, Math.round(this.sampleRate * (60 / bpm) * beats)));
  }

  private quantizeBeats(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
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

  private clampBpm(value: number): number {
    return clamp(finiteOrZero(value), 30, 300);
  }

  private clampFeedbackPercent(value: number): number {
    return clamp(finiteOrZero(value), 0, MAX_FEEDBACK * 100) / 100;
  }

  private clampCrossfade(value: number): number {
    return clamp(finiteOrZero(value), 1, 100);
  }

  private totalSamples(buffers: readonly [readonly Float32Array[], readonly Float32Array[]]): number {
    let total = 0;
    for (let channel = 0; channel < 2; channel += 1) {
      for (const buffer of buffers[channel as 0 | 1]) total += buffer.length;
    }
    return total;
  }
}
