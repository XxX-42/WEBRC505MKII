/**
 * Clean-room, provisional AUTO RIFF analysis and pitch-command sequencer.
 * This class analyzes a caller-provided mono stream (or averages stereo in
 * processStereoSample) and queues quantized pitch-shift commands. It does not
 * resynthesize audio and is not sound-quality accepted. All analysis/queue
 * storage is fixed at construction; the sample callback allocates nothing.
 */

export type BrowserAutoRiffScale = 0 | 1 | 2 | 3 | 4;
export type BrowserAutoRiffBeatStepRate = 0.25 | 0.5 | 1 | 2 | 4;

export interface BrowserAutoRiffParameters {
  bpm?: number;
  beatStepRate?: number;
  scale?: BrowserAutoRiffScale;
  /** 0..1; larger values detect quieter and less abrupt attacks. */
  onsetSensitivity?: number;
}

export interface BrowserAutoRiffDiagnostics {
  pitchEstimateHz: number;
  pitchEstimateMidi: number;
  pitchConfidence: number;
  hasPitch: boolean;
  step: number;
  onset: boolean;
  onsetCount: number;
  lastOnsetFrame: number;
  queueDepth: number;
  queueOverflowCount: number;
  latencyFrames: number;
  activeBpm: number;
  activeBeatStepRate: number;
  activeScale: BrowserAutoRiffScale;
  framesProcessed: number;
}

const BEAT_STEP_RATES: readonly BrowserAutoRiffBeatStepRate[] = [0.25, 0.5, 1, 2, 4];
const SCALE_INTERVALS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic
  [0, 2, 4, 5, 7, 9, 11], // major
  [0, 2, 3, 5, 7, 8, 10], // natural minor
  [0, 2, 3, 5, 7, 8, 11], // harmonic minor
  [0, 2, 4, 7, 9], // major pentatonic
];
// Ascending arpeggio, return, then a lower scale-degree pickup.
const RIFF_DEGREES = [0, 2, 4, 6, 4, 2, 0, -2] as const;
const DECIMATION_FACTOR = 4;
const YIN_BUFFER_SIZE = 2048;
const YIN_BUFFER_MASK = YIN_BUFFER_SIZE - 1;
const YIN_MIN_F0_HZ = 55;
const YIN_MAX_F0_HZ = 1100;
const YIN_HOP_DECIMATED = 64;
const PITCH_CONFIDENCE_THRESHOLD = 0.62;
const QUEUE_CAPACITY = 32;
const QUEUE_MASK = QUEUE_CAPACITY - 1;
const ONSET_REFRACTORY_MS = 90;
const PENDING_ONSET_MAX_MS = 300;

export class BrowserAutoRiffDsp {
  readonly sampleRate: number;

  /** Most recent valid YIN estimate; 0 when no periodic pitch is tracked. */
  pitchEstimateHz = 0;
  pitchEstimateMidi = 0;
  pitchConfidence = 0;
  hasPitch = false;

  /** Index 0..7 while playing, otherwise -1. */
  step = -1;
  /** True only on the sample where an onset is reported. */
  onset = false;
  onsetCount = 0;
  lastOnsetFrame = -1;
  queueOverflowCount = 0;
  framesProcessed = 0;
  lastPoppedFrame = -1;
  lastPoppedSemitones = 0;

  private readonly decimatedRate: number;
  private readonly onsetAttackAlpha: number;
  private readonly onsetReleaseAlpha: number;
  private readonly onsetBaselineAlpha: number;
  private readonly maxLag: number;
  private readonly minLag: number;
  private readonly yinWindow: number;
  private readonly yinRing = new Float32Array(YIN_BUFFER_SIZE);
  private readonly yinCmnd = new Float32Array(256);
  private readonly queueFrames = new Float64Array(QUEUE_CAPACITY);
  private readonly queueSemitones = new Int8Array(QUEUE_CAPACITY);
  private queueHead = 0;
  private queueTail = 0;
  private queueCount = 0;
  private decimationSum = 0;
  private decimationCount = 0;
  private decimatedSamples = 0;
  private analysisCountdown = YIN_HOP_DECIMATED;
  private totalSinceReset = 0;
  private failedPitchAnalyses = 0;
  private fastEnergy = 0;
  private slowEnergy = 0;
  private previousFastEnergy = 0;
  private onsetArmed = true;
  private nextOnsetFrame = 0;
  private pendingOnset = false;
  private pendingOnsetFrame = -1;
  private nextSequenceFrame = -1;
  private sequenceStep = 0;
  private sequenceActive = false;
  private riffRootMidi = 0;
  private currentBpm: number;
  private currentBeatStepRate: BrowserAutoRiffBeatStepRate;
  private currentScale: BrowserAutoRiffScale;
  private currentOnsetSensitivity: number;

  constructor(sampleRate: number, parameters: BrowserAutoRiffParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    // A fixed factor of four is adequate for the supported 8 kHz and higher
    // rates; lag bounds are derived from the resulting analysis rate.
    this.decimatedRate = this.sampleRate / DECIMATION_FACTOR;
    this.onsetAttackAlpha = 1 - Math.exp(-1 / (0.004 * this.sampleRate));
    this.onsetReleaseAlpha = 1 - Math.exp(-1 / (0.080 * this.sampleRate));
    this.onsetBaselineAlpha = 1 - Math.exp(-1 / (0.45 * this.sampleRate));
    this.maxLag = Math.min(255, Math.floor(this.decimatedRate / YIN_MIN_F0_HZ));
    this.minLag = Math.max(2, Math.floor(this.decimatedRate / YIN_MAX_F0_HZ));
    this.yinWindow = Math.min(384, Math.max(64, this.maxLag * 2));
    this.currentBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentBeatStepRate = this.clampRate(parameters.beatStepRate ?? 0.5);
    this.currentScale = this.clampScale(parameters.scale ?? 0);
    this.currentOnsetSensitivity = this.clampSensitivity(parameters.onsetSensitivity ?? 0.65);
    this.updateOnsetClock(0);
  }

  get latencyFrames(): number {
    // Upper-bound acquisition delay: enough decimated history plus one hop.
    return (this.yinWindow + this.maxLag + YIN_HOP_DECIMATED) * DECIMATION_FACTOR;
  }

  get activeBpm(): number { return this.currentBpm; }
  get activeBeatStepRate(): BrowserAutoRiffBeatStepRate { return this.currentBeatStepRate; }
  get activeScale(): BrowserAutoRiffScale { return this.currentScale; }
  get activeOnsetSensitivity(): number { return this.currentOnsetSensitivity; }
  get queueDepth(): number { return this.queueCount; }
  get stepFrames(): number { return this.intervalFrames(); }

  get diagnostics(): BrowserAutoRiffDiagnostics {
    return {
      pitchEstimateHz: this.pitchEstimateHz,
      pitchEstimateMidi: this.pitchEstimateMidi,
      pitchConfidence: this.pitchConfidence,
      hasPitch: this.hasPitch,
      step: this.step,
      onset: this.onset,
      onsetCount: this.onsetCount,
      lastOnsetFrame: this.lastOnsetFrame,
      queueDepth: this.queueCount,
      queueOverflowCount: this.queueOverflowCount,
      latencyFrames: this.latencyFrames,
      activeBpm: this.currentBpm,
      activeBeatStepRate: this.currentBeatStepRate,
      activeScale: this.currentScale,
      framesProcessed: this.framesProcessed,
    };
  }

  setParameters(parameters: BrowserAutoRiffParameters): void {
    if (Number.isFinite(parameters.bpm)) this.currentBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.beatStepRate)) this.currentBeatStepRate = this.clampRate(parameters.beatStepRate as number);
    if (Number.isFinite(parameters.scale)) this.currentScale = this.clampScale(parameters.scale as number);
    if (Number.isFinite(parameters.onsetSensitivity)) {
      this.currentOnsetSensitivity = this.clampSensitivity(parameters.onsetSensitivity as number);
    }
  }

  setTempo(bpm: number, beatStepRate: number): void {
    if (Number.isFinite(bpm)) this.currentBpm = this.clampBpm(bpm);
    if (Number.isFinite(beatStepRate)) this.currentBeatStepRate = this.clampRate(beatStepRate);
  }

  setScale(scale: number): void {
    if (Number.isFinite(scale)) this.currentScale = this.clampScale(scale);
  }

  setOnsetSensitivity(sensitivity: number): void {
    if (Number.isFinite(sensitivity)) this.currentOnsetSensitivity = this.clampSensitivity(sensitivity);
  }

  /**
   * Analyze caller-provided mono input. Pass the absolute audio frame so
   * sequence edges remain sample-clocked across variable callback segments.
   */
  processSample(input: number, frame: number): void {
    const sampleFrame = Number.isFinite(frame) ? Math.floor(frame) : this.framesProcessed;
    const sample = Number.isFinite(input) ? Math.max(-8, Math.min(8, input)) : 0;
    this.framesProcessed += 1;
    this.onset = false;

    this.updateOnset(sample, sampleFrame);

    this.decimationSum += sample;
    this.decimationCount += 1;
    if (this.decimationCount >= DECIMATION_FACTOR) {
      this.pushDecimatedSample(this.decimationSum / DECIMATION_FACTOR);
      this.decimationSum = 0;
      this.decimationCount = 0;
    }

    if (!this.hasPitch) {
      this.sequenceActive = false;
      this.step = -1;
      if (this.pendingOnset && sampleFrame - this.pendingOnsetFrame > this.pendingOnsetFrames()) {
        this.pendingOnset = false;
      }
    } else if (this.pendingOnset) {
      this.startSequence(sampleFrame);
    }

    if (this.sequenceActive && this.hasPitch && sampleFrame >= this.nextSequenceFrame) {
      this.emitSequenceCommand(sampleFrame);
    }
  }

  /** Average stereo to mono without creating an intermediate sample object. */
  processStereoSample(left: number, right: number, frame: number): void {
    const l = Number.isFinite(left) ? left : 0;
    const r = Number.isFinite(right) ? right : 0;
    this.processSample((l + r) * 0.5, frame);
  }

  /** Pop one fixed-capacity primitive command into the mutable lastPopped* fields. */
  tryPopPitchChange(): boolean {
    if (this.queueCount <= 0) return false;
    this.lastPoppedFrame = this.queueFrames[this.queueHead]!;
    this.lastPoppedSemitones = this.queueSemitones[this.queueHead]!;
    this.queueHead = (this.queueHead + 1) & QUEUE_MASK;
    this.queueCount -= 1;
    return true;
  }

  reset(): void {
    this.yinRing.fill(0);
    this.yinCmnd.fill(0);
    this.queueFrames.fill(0);
    this.queueSemitones.fill(0);
    this.queueHead = 0;
    this.queueTail = 0;
    this.queueCount = 0;
    this.decimationSum = 0;
    this.decimationCount = 0;
    this.decimatedSamples = 0;
    this.analysisCountdown = YIN_HOP_DECIMATED;
    this.totalSinceReset = 0;
    this.failedPitchAnalyses = 0;
    this.fastEnergy = 0;
    this.slowEnergy = 0;
    this.previousFastEnergy = 0;
    this.onsetArmed = true;
    this.nextOnsetFrame = 0;
    this.pendingOnset = false;
    this.pendingOnsetFrame = -1;
    this.nextSequenceFrame = -1;
    this.sequenceStep = 0;
    this.sequenceActive = false;
    this.riffRootMidi = 0;
    this.pitchEstimateHz = 0;
    this.pitchEstimateMidi = 0;
    this.pitchConfidence = 0;
    this.hasPitch = false;
    this.step = -1;
    this.onset = false;
    this.onsetCount = 0;
    this.lastOnsetFrame = -1;
    this.queueOverflowCount = 0;
    this.framesProcessed = 0;
    this.lastPoppedFrame = -1;
    this.lastPoppedSemitones = 0;
    this.updateOnsetClock(0);
  }

  private updateOnset(sample: number, frame: number): void {
    const energy = sample * sample;
    const alpha = energy > this.fastEnergy ? this.onsetAttackAlpha : this.onsetReleaseAlpha;
    this.fastEnergy += alpha * (energy - this.fastEnergy);
    this.slowEnergy += this.onsetBaselineAlpha * (energy - this.slowEnergy);

    const sensitivity = this.currentOnsetSensitivity;
    const absoluteFloor = 0.0065 - (0.0057 * sensitivity);
    const ratio = 2.1 - sensitivity;
    const threshold = Math.max(absoluteFloor * absoluteFloor, this.slowEnergy * ratio * ratio);
    const rising = this.fastEnergy > this.previousFastEnergy * 1.00015;
    this.previousFastEnergy = this.fastEnergy;
    if (!this.onsetArmed && this.fastEnergy < Math.max(absoluteFloor * absoluteFloor * 4, this.slowEnergy * 0.35)) {
      this.onsetArmed = true;
    }
    if (this.onsetArmed && frame >= this.nextOnsetFrame && rising && this.fastEnergy >= threshold) {
      this.onset = true;
      this.onsetCount += 1;
      this.lastOnsetFrame = frame;
      this.pendingOnset = true;
      this.pendingOnsetFrame = frame;
      this.sequenceActive = false;
      this.step = -1;
      this.onsetArmed = false;
      this.updateOnsetClock(frame);
    }
  }

  private updateOnsetClock(frame: number): void {
    this.nextOnsetFrame = frame + Math.max(1, Math.round((ONSET_REFRACTORY_MS * this.sampleRate) / 1000));
  }

  private pushDecimatedSample(sample: number): void {
    this.yinRing[this.decimatedSamples & YIN_BUFFER_MASK] = sample;
    this.decimatedSamples += 1;
    this.totalSinceReset += 1;
    this.analysisCountdown -= 1;
    if (this.analysisCountdown <= 0) {
      this.analysisCountdown = YIN_HOP_DECIMATED;
      if (this.totalSinceReset >= this.yinWindow + this.maxLag) this.analyzePitch();
    }
  }

  private analyzePitch(): void {
    const newest = this.decimatedSamples - 1;
    let energy = 0;
    for (let i = 0; i < this.yinWindow; i += 1) {
      const sample = this.yinRing[(newest - i) & YIN_BUFFER_MASK]!;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / this.yinWindow);
    if (!Number.isFinite(rms) || rms < 0.0008) {
      this.clearPitch();
      return;
    }

    let cumulative = 0;
    let bestLag = -1;
    let bestCmnd = 1;
    let firstThresholdLag = -1;
    const yinThreshold = 0.16;
    for (let lag = 1; lag <= this.maxLag; lag += 1) {
      let difference = 0;
      for (let i = 0; i < this.yinWindow; i += 1) {
        const a = this.yinRing[(newest - i) & YIN_BUFFER_MASK]!;
        const b = this.yinRing[(newest - i - lag) & YIN_BUFFER_MASK]!;
        const delta = a - b;
        difference += delta * delta;
      }
      cumulative += difference;
      const normalized = lag === 1 || cumulative <= 1e-20
        ? 1
        : (difference * lag) / cumulative;
      this.yinCmnd[lag] = normalized;
      if (lag >= this.minLag && normalized < bestCmnd) {
        bestCmnd = normalized;
        bestLag = lag;
      }
      if (lag >= this.minLag && firstThresholdLag < 0 && normalized < yinThreshold) {
        firstThresholdLag = lag;
      }
    }

    if (firstThresholdLag >= 0) {
      let lag = firstThresholdLag;
      while (lag < this.maxLag && this.yinCmnd[lag + 1]! < this.yinCmnd[lag]!) lag += 1;
      bestLag = lag;
      bestCmnd = this.yinCmnd[lag]!;
    }
    if (bestLag < this.minLag || bestLag > this.maxLag || bestCmnd > (firstThresholdLag >= 0 ? 0.45 : 0.25)) {
      this.failedPitchAnalyses += 1;
      if (this.failedPitchAnalyses >= 2) this.clearPitch();
      return;
    }

    const before = this.yinCmnd[bestLag - 1] ?? bestCmnd;
    const center = this.yinCmnd[bestLag] ?? bestCmnd;
    const after = this.yinCmnd[bestLag + 1] ?? center;
    const denominator = before - (2 * center) + after;
    const correction = Math.abs(denominator) > 1e-8
      ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator))
      : 0;
    const period = bestLag + correction;
    const frequency = this.decimatedRate / period;
    if (!Number.isFinite(frequency) || frequency < YIN_MIN_F0_HZ || frequency > YIN_MAX_F0_HZ) {
      this.failedPitchAnalyses += 1;
      if (this.failedPitchAnalyses >= 2) this.clearPitch();
      return;
    }
    this.failedPitchAnalyses = 0;
    this.pitchEstimateHz = frequency;
    this.pitchEstimateMidi = 69 + (12 * Math.log2(frequency / 440));
    this.pitchConfidence = Math.max(0, Math.min(1, 1 - bestCmnd));
    this.hasPitch = this.pitchConfidence >= PITCH_CONFIDENCE_THRESHOLD;
    if (!this.hasPitch) this.clearPitch();
  }

  private clearPitch(): void {
    this.pitchEstimateHz = 0;
    this.pitchEstimateMidi = 0;
    this.pitchConfidence = 0;
    this.hasPitch = false;
    this.failedPitchAnalyses = 0;
    this.sequenceActive = false;
    this.step = -1;
  }

  private startSequence(frame: number): void {
    this.pendingOnset = false;
    if (frame - this.pendingOnsetFrame > this.pendingOnsetFrames()) return;
    this.riffRootMidi = Math.round(this.pitchEstimateMidi);
    const interval = this.intervalFrames();
    let firstFrame = Math.ceil(this.pendingOnsetFrame / interval) * interval;
    if (firstFrame < frame) firstFrame = Math.ceil(frame / interval) * interval;
    this.nextSequenceFrame = firstFrame;
    this.sequenceStep = 0;
    this.sequenceActive = true;
    this.step = 0;
  }

  private emitSequenceCommand(frame: number): void {
    const degree = RIFF_DEGREES[this.sequenceStep] ?? 0;
    const interval = this.intervalForDegree(degree, this.currentScale);
    const semitones = Math.max(-24, Math.min(24, interval));
    this.enqueuePitchChange(frame, semitones);
    this.sequenceStep += 1;
    if (this.sequenceStep >= RIFF_DEGREES.length) {
      this.sequenceActive = false;
      this.step = -1;
      this.nextSequenceFrame = -1;
      return;
    }
    this.step = this.sequenceStep;
    this.nextSequenceFrame += this.intervalFrames();
    // If the caller skipped whole audio segments, do at most one command per
    // processSample call and advance to the next future grid edge.
    const duration = this.intervalFrames();
    if (this.nextSequenceFrame <= frame) {
      const skipped = Math.floor((frame - this.nextSequenceFrame) / duration) + 1;
      this.nextSequenceFrame += skipped * duration;
    }
  }

  private intervalForDegree(degree: number, scale: BrowserAutoRiffScale): number {
    const intervals = SCALE_INTERVALS[scale] ?? SCALE_INTERVALS[0]!;
    const size = intervals.length;
    const octave = Math.floor(degree / size);
    const index = degree - (octave * size);
    const relativeSemitones = (intervals[index] ?? 0) + (12 * octave);
    // Keep the chosen target close to the sequence root before final safety clamp.
    const root = this.riffRootMidi;
    const target = root + relativeSemitones;
    return Math.round(target - root);
  }

  private enqueuePitchChange(frame: number, semitones: number): void {
    if (this.queueCount >= QUEUE_CAPACITY) {
      this.queueOverflowCount += 1;
      return;
    }
    this.queueFrames[this.queueTail] = frame;
    this.queueSemitones[this.queueTail] = semitones;
    this.queueTail = (this.queueTail + 1) & QUEUE_MASK;
    this.queueCount += 1;
  }

  private intervalFrames(): number {
    return Math.max(1, Math.round((this.sampleRate * 60 * this.currentBeatStepRate) / this.currentBpm));
  }

  private pendingOnsetFrames(): number {
    return Math.max(1, Math.round((PENDING_ONSET_MAX_MS * this.sampleRate) / 1000));
  }

  private clampBpm(value: number): number { return Math.max(30, Math.min(300, value)); }

  private clampRate(value: number): BrowserAutoRiffBeatStepRate {
    let nearest = BEAT_STEP_RATES[0]!;
    let difference = Math.abs(value - nearest);
    for (let i = 1; i < BEAT_STEP_RATES.length; i += 1) {
      const candidate = BEAT_STEP_RATES[i]!;
      const candidateDifference = Math.abs(value - candidate);
      if (candidateDifference < difference) {
        nearest = candidate;
        difference = candidateDifference;
      }
    }
    return nearest;
  }

  private clampScale(value: number): BrowserAutoRiffScale {
    return Math.max(0, Math.min(4, Math.round(value))) as BrowserAutoRiffScale;
  }

  private clampSensitivity(value: number): number { return Math.max(0, Math.min(1, value)); }
}
