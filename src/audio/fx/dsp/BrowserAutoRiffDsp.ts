/**
 * Clean-room, provisional AUTO RIFF analysis and pitch-command sequencer.
 * This class analyzes a caller-provided mono stream (or averages stereo in
 * processStereoSample) and queues quantized pitch-shift commands. Its optional
 * HOLD captures a bounded periodic source waveform; ATTACK adds a decaying
 * phrase accent before the host pitch shifter. These authored controls are
 * not a reconstruction of BOSS DSP or the undocumented P1–P30 phrases.
 * Storage is fixed at construction; the sample callback allocates nothing.
 */

export type BrowserAutoRiffScale = 0 | 1 | 2 | 3 | 4;
export type BrowserAutoRiffBeatStepRate = 0.25 | 0.5 | 1 | 2 | 4;

export interface BrowserAutoRiffParameters {
  bpm?: number;
  quarterNotesPerMeasure?: number;
  beatStepRate?: number;
  scale?: BrowserAutoRiffScale;
  /** 0..1; larger values detect quieter and less abrupt attacks. */
  onsetSensitivity?: number;
  /** Official 0..100 scale, or negative beat duration. Authored manual curve. */
  officialTempo?: number;
  /** 0/1: latch a periodic source waveform so input silence does not end it. */
  hold?: number;
  /** 0..100: added phrase-onset loudness, not an envelope rise-time control. */
  attack?: number;
  /** 0/1: repeat the existing authored eight-step pattern, not a BOSS phrase. */
  loop?: number;
  /** 0..11: use a major-key tonic closest to the acquired input note. */
  key?: number;
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
  activeOfficialTempo: number | undefined;
  activeHold: boolean;
  sourceHeld: boolean;
  activeAttack: number;
  activeLoop: boolean;
  activeKey: number | undefined;
  attackGain: number;
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
const SOURCE_BUFFER_SIZE = 8192;
const SOURCE_BUFFER_MASK = SOURCE_BUFFER_SIZE - 1;
const OFFICIAL_BEAT_DURATIONS = [16, 8, 4, 2, 1, 0.125] as const;

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
  /** Source audio to feed to the host pitch shifter. Legacy controls pass through. */
  wetLeft = 0;
  wetRight = 0;
  attackGain = 1;

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
  private currentOfficialTempo: number | undefined;
  private currentQuarterNotesPerMeasure = 4;
  private currentHold = false;
  private currentAttack = 0;
  private currentLoop = false;
  private currentKey: number | undefined;
  private readonly sourceLeft = new Float32Array(SOURCE_BUFFER_SIZE);
  private readonly sourceRight = new Float32Array(SOURCE_BUFFER_SIZE);
  private sourceWrite = 0;
  private sourceCount = 0;
  private heldPeriod = 0;
  private heldRead = 0;
  private heldStart = 0;
  private heldSourceMidi = 0;
  private phraseAttack = 0;
  private readonly phraseAttackDecay: number;

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
    this.phraseAttackDecay = Math.exp(-1 / (0.030 * this.sampleRate));
    this.currentBpm = this.clampBpm(parameters.bpm ?? 120);
    this.currentBeatStepRate = this.clampRate(parameters.beatStepRate ?? 0.5);
    this.currentScale = this.clampScale(parameters.scale ?? 0);
    this.currentOnsetSensitivity = this.clampSensitivity(parameters.onsetSensitivity ?? 0.65);
    this.setParameters(parameters);
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
  get activeOfficialTempo(): number | undefined { return this.currentOfficialTempo; }
  get activeHold(): boolean { return this.currentHold; }
  get sourceHeld(): boolean { return this.heldPeriod > 0; }
  get activeAttack(): number { return this.currentAttack; }
  get activeLoop(): boolean { return this.currentLoop; }
  get activeKey(): number | undefined { return this.currentKey; }
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
      activeOfficialTempo: this.currentOfficialTempo,
      activeHold: this.currentHold,
      sourceHeld: this.sourceHeld,
      activeAttack: this.currentAttack,
      activeLoop: this.currentLoop,
      activeKey: this.currentKey,
      attackGain: this.attackGain,
    };
  }

  setParameters(parameters: BrowserAutoRiffParameters): void {
    if (Number.isFinite(parameters.bpm)) this.currentBpm = this.clampBpm(parameters.bpm as number);
    if (Number.isFinite(parameters.quarterNotesPerMeasure) && parameters.quarterNotesPerMeasure! >= 0.125 && parameters.quarterNotesPerMeasure! <= 128) this.currentQuarterNotesPerMeasure = parameters.quarterNotesPerMeasure!;
    if (Number.isFinite(parameters.beatStepRate)) {
      this.currentBeatStepRate = this.clampRate(parameters.beatStepRate as number);
      this.currentOfficialTempo = undefined; // explicit legacy rate resumes legacy units
    }
    if (Number.isFinite(parameters.scale)) {
      this.currentScale = this.clampScale(parameters.scale as number);
      this.currentKey = undefined; // explicit legacy scale resumes root-relative operation
    }
    if (Number.isFinite(parameters.onsetSensitivity)) {
      this.currentOnsetSensitivity = this.clampSensitivity(parameters.onsetSensitivity as number);
    }
    const tempo = parameters.officialTempo;
    if (typeof tempo === 'number' && ((Number.isInteger(tempo) && tempo >= 0 && tempo <= 100)
      || OFFICIAL_BEAT_DURATIONS.some(beats => tempo === -beats))) this.currentOfficialTempo = tempo;
    if (parameters.hold === 0 || parameters.hold === 1) {
      this.currentHold = parameters.hold === 1;
      if (!this.currentHold) this.heldPeriod = 0;
      else this.captureHeldSource();
    }
    if (Number.isInteger(parameters.attack) && parameters.attack! >= 0 && parameters.attack! <= 100) this.currentAttack = parameters.attack!;
    if (parameters.loop === 0 || parameters.loop === 1) this.currentLoop = parameters.loop === 1;
    if (Number.isInteger(parameters.key) && parameters.key! >= 0 && parameters.key! <= 11) this.currentKey = parameters.key;
  }

  setTempo(bpm: number, beatStepRate: number): void {
    if (Number.isFinite(bpm)) this.currentBpm = this.clampBpm(bpm);
    if (Number.isFinite(beatStepRate)) {
      this.currentBeatStepRate = this.clampRate(beatStepRate);
      this.currentOfficialTempo = undefined;
    }
  }

  setScale(scale: number): void {
    if (Number.isFinite(scale)) {
      this.currentScale = this.clampScale(scale);
      this.currentKey = undefined;
    }
  }

  setOnsetSensitivity(sensitivity: number): void {
    if (Number.isFinite(sensitivity)) this.currentOnsetSensitivity = this.clampSensitivity(sensitivity);
  }

  /**
   * Analyze caller-provided mono input. Pass the absolute audio frame so
   * sequence edges remain sample-clocked across variable callback segments.
   */
  processSample(input: number, frame: number): void {
    this.processStereoSample(input, input, frame);
  }

  /** Both analysis and optional source hold/accent are sample-clocked. */
  processStereoSample(left: number, right: number, frame: number): void {
    const l = Number.isFinite(left) ? Math.max(-8, Math.min(8, left)) : 0;
    const r = Number.isFinite(right) ? Math.max(-8, Math.min(8, right)) : 0;
    if (!this.sourceHeld) {
      this.sourceLeft[this.sourceWrite] = l;
      this.sourceRight[this.sourceWrite] = r;
      this.sourceWrite = (this.sourceWrite + 1) & SOURCE_BUFFER_MASK;
      this.sourceCount = Math.min(SOURCE_BUFFER_SIZE, this.sourceCount + 1);
    }
    this.analyzeSample((l + r) * 0.5, frame);
    if (this.currentHold && !this.sourceHeld) this.captureHeldSource();
    this.attackGain = 1 + this.currentAttack / 100 * this.phraseAttack;
    this.phraseAttack *= this.phraseAttackDecay;
    if (this.sourceHeld) {
      // Interpolation over one detected period preserves the tracked F0.
      // Fixed ring history is frozen, so silence can never overwrite the hold.
      const position = this.heldStart + this.heldRead;
      const base = Math.floor(position);
      const fraction = position - base;
      const index = base & SOURCE_BUFFER_MASK;
      const next = (base + 1) & SOURCE_BUFFER_MASK;
      this.wetLeft = (this.sourceLeft[index]! + fraction * (this.sourceLeft[next]! - this.sourceLeft[index]!)) * this.attackGain;
      this.wetRight = (this.sourceRight[index]! + fraction * (this.sourceRight[next]! - this.sourceRight[index]!)) * this.attackGain;
      this.heldRead = (this.heldRead + 1) % this.heldPeriod;
    } else {
      this.wetLeft = l * this.attackGain;
      this.wetRight = r * this.attackGain;
    }
  }

  private analyzeSample(input: number, frame: number): void {
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

    if (!this.hasPitch && !this.sourceHeld) {
      this.sequenceActive = false;
      this.step = -1;
      if (this.pendingOnset && sampleFrame - this.pendingOnsetFrame > this.pendingOnsetFrames()) {
        this.pendingOnset = false;
      }
    } else if (this.pendingOnset) {
      this.startSequence(sampleFrame);
    }

    if (this.sequenceActive && (this.hasPitch || this.sourceHeld) && sampleFrame >= this.nextSequenceFrame) {
      this.emitSequenceCommand(sampleFrame);
    }
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
    this.sourceLeft.fill(0);
    this.sourceRight.fill(0);
    this.sourceWrite = 0;
    this.sourceCount = 0;
    this.heldPeriod = 0;
    this.heldRead = 0;
    this.heldStart = 0;
    this.heldSourceMidi = 0;
    this.phraseAttack = 0;
    this.attackGain = 1;
    this.wetLeft = 0;
    this.wetRight = 0;
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
    if (!this.sourceHeld && this.onsetArmed && frame >= this.nextOnsetFrame && rising && this.fastEnergy >= threshold) {
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
    if (!this.sourceHeld) {
      this.sequenceActive = false;
      this.step = -1;
    }
  }

  private captureHeldSource(): void {
    if (this.sourceHeld || !this.hasPitch || this.pitchEstimateHz <= 0 || this.onsetCount === 0) return;
    const period = this.sampleRate / this.pitchEstimateHz;
    if (period < 2 || period + 2 >= SOURCE_BUFFER_SIZE || this.sourceCount < Math.ceil(period) + 2) return;
    this.heldPeriod = period;
    this.heldStart = this.sourceWrite - period - 1;
    this.heldRead = 0;
    this.heldSourceMidi = this.pitchEstimateMidi;
  }

  private startSequence(frame: number): void {
    this.pendingOnset = false;
    if (frame - this.pendingOnsetFrame > this.pendingOnsetFrames()) return;
    this.riffRootMidi = Math.round(this.sourceHeld ? this.heldSourceMidi : this.pitchEstimateMidi);
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
    // A single explicitly authored pattern, never labelled P1–P30. With KEY
    // selected, use major scale degrees around the closest tonic. Subtract
    // current source pitch so a moving input cannot transpose the whole key.
    let interval = this.intervalForDegree(degree, this.currentKey === undefined ? this.currentScale : 1);
    if (this.currentKey !== undefined) {
      const tonic = this.currentKey + 12 * Math.round((this.riffRootMidi - this.currentKey) / 12);
      const source = this.sourceHeld ? this.heldSourceMidi : this.pitchEstimateMidi;
      interval += tonic - Math.round(source);
    }
    const semitones = Math.max(-24, Math.min(24, interval));
    if (this.sequenceStep === 0) this.phraseAttack = 1;
    this.enqueuePitchChange(frame, semitones);
    this.sequenceStep += 1;
    if (this.sequenceStep >= RIFF_DEGREES.length) {
      if (this.currentLoop) this.sequenceStep = 0;
      else {
        this.sequenceActive = false;
        this.step = -1;
        this.nextSequenceFrame = -1;
        return;
      }
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
    if (this.currentOfficialTempo !== undefined) {
      // The guide does not publish the manual 0..100 transfer curve. This
      // clean-room curve spans 2 s to 50 ms per step; notes follow current BPM.
      const seconds = this.currentOfficialTempo < 0
        ? -this.currentOfficialTempo * (this.currentOfficialTempo <= -4 ? this.currentQuarterNotesPerMeasure / 4 : 1) * 60 / this.currentBpm
        : 2 * Math.pow(0.025, this.currentOfficialTempo / 100);
      return Math.max(1, Math.round(seconds * this.sampleRate));
    }
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
