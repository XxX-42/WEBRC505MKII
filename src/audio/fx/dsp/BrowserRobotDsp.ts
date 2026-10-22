/**
 * Provisional clean-room ROBOT controller for the Browser worklet. Its
 * sample-clocked YIN tracker emits timestamped quantized targets for the host
 * Signalsmith fallback and selects the fixed-memory LIVE_MONO PSOLA-lite path
 * only for sufficiently stable, high-confidence estimates in its admitted
 * range (130–1000 Hz, ±12 semitones, formant control at zero). Every other
 * state selects Signalsmith, including unvoiced input. Stability/confidence is
 * a conservative gate, not a reliable polyphony detector: chords can still
 * contain a strong periodic substructure and may be misclassified. No Roland
 * source or firmware behavior is claimed, and sound-quality admission remains
 * incomplete.
 *
 * `latencyFrames` is the analyzer's window/hop acquisition estimate. The
 * separate PSOLA processor has a declared fixed engine latency; Signalsmith
 * reports its own algorithmic latency. These figures are not a measured total
 * end-to-end delay.
 */

import { LiveMonoPitchProcessor } from '../../pitch/liveMono';

export interface BrowserRobotParameters {
  /** Fixed semitone offset applied before equal-tempered target rounding. */
  pitch?: number;
  /** Official fixed target pitch class; -1 restores the legacy chromatic quantizer. */
  note?: number;
  /** Nonzero independent shift keeps ROBOT on the Signalsmith path. */
  formant?: number;
}

export interface BrowserRobotDiagnostics {
  readonly pitchEstimateHz: number;
  readonly pitchEstimateMidi: number;
  readonly pitchConfidence: number;
  readonly hasPitch: boolean;
  readonly targetMidi: number;
  readonly targetSemitones: number;
  readonly latencyFrames: number;
  readonly queueDepth: number;
  readonly queueOverflowCount: number;
  readonly framesProcessed: number;
}

export type BrowserRobotProcessingMode = 'psola' | 'signalsmith';
export type BrowserRobotModeReason =
  | 'stable-voiced'
  | 'unvoiced'
  | 'unstable-f0'
  | 'low-confidence'
  | 'source-frequency-out-of-range'
  | 'target-shift-out-of-range'
  | 'formant-control-active';

const DECIMATION_FACTOR = 4;
const YIN_RING_LENGTH = 1024;
const YIN_RING_MASK = YIN_RING_LENGTH - 1;
const YIN_CMND_LENGTH = 256;
const YIN_MIN_F0_HZ = 80;
const YIN_MAX_F0_HZ = 1_000;
const YIN_HOP_DECIMATED = 64;
const YIN_RMS_FLOOR = 0.0008;
const YIN_THRESHOLD = 0.16;
const PITCH_CONFIDENCE_THRESHOLD = 0.62;
const QUEUE_CAPACITY = 32;
const QUEUE_MASK = QUEUE_CAPACITY - 1;
const TARGET_CHANGE_DEADBAND = 0.035;
const NOTE_CHANGE_HYSTERESIS = 0.05;
const PSOLA_MIN_F0_HZ = 130;
const PSOLA_MAX_F0_HZ = 1_000;
const PSOLA_STABLE_CENTS = 65;
const PSOLA_STABLE_ANALYSES = 3;
const PSOLA_CONFIDENCE_THRESHOLD = 0.82;

/** Fixed-size analysis state and fixed-capacity event queue. */
export class BrowserRobotDsp {
  readonly sampleRate: number;
  readonly latencyFrames: number;

  pitchEstimateHz = 0;
  pitchEstimateMidi = 0;
  pitchConfidence = 0;
  hasPitch = false;
  targetMidi = 0;
  targetSemitones = 0;
  framesProcessed = 0;
  queueOverflowCount = 0;
  lastTargetFrame = -1;
  lastTargetSemitones = 0;
  lastTargetSourceMidi = 0;
  lastTargetMidi = 0;
  lastTargetHz = 0;
  lastTargetConfidence = 0;
  lastTargetVoiced = false;
  psolaOutputSample = 0;
  processingMode: BrowserRobotProcessingMode = 'signalsmith';
  modeReason: BrowserRobotModeReason = 'unvoiced';
  modeFrame = 0;
  modeRevision = 0;

  private readonly decimatedRate: number;
  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly yinWindow: number;
  private readonly yinRing = new Float32Array(YIN_RING_LENGTH);
  private readonly yinAnalysisFrame: Float32Array;
  private readonly yinCmnd = new Float32Array(YIN_CMND_LENGTH);
  private readonly queueFrames = new Float64Array(QUEUE_CAPACITY);
  private readonly queueSemitones = new Float32Array(QUEUE_CAPACITY);
  private readonly queueSourceMidi = new Float32Array(QUEUE_CAPACITY);
  private readonly queueTargetMidi = new Float32Array(QUEUE_CAPACITY);
  private readonly queueHz = new Float32Array(QUEUE_CAPACITY);
  private readonly queueConfidence = new Float32Array(QUEUE_CAPACITY);
  private readonly queueVoiced = new Uint8Array(QUEUE_CAPACITY);
  private psolaProcessor: LiveMonoPitchProcessor;
  private readonly psolaInput = new Float32Array(1);
  private readonly psolaOutput = new Float32Array(1);
  private queueHead = 0;
  private queueTail = 0;
  private queueCount = 0;
  private decimationSum = 0;
  private decimationCount = 0;
  private decimatedSamples = 0;
  private analysisCountdown = YIN_HOP_DECIMATED;
  private totalSinceReset = 0;
  private invalidAnalyses = 0;
  private targetOffsetSemitones: number;
  private targetFormantSemitones = 0;
  private targetNote = -1;
  private targetMidiInitialized = false;
  private lastFrame = 0;
  private lastQueuedVoiced = false;
  private lastQueuedSemitones = Number.NaN;
  private previousStableFrequencyHz = 0;
  private stableAnalysisCount = 0;

  constructor(sampleRate: number, parameters: BrowserRobotParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 ? sampleRate : 48_000;
    this.decimatedRate = this.sampleRate / DECIMATION_FACTOR;
    this.maxLag = Math.max(2, Math.min(YIN_CMND_LENGTH - 2, Math.floor(this.decimatedRate / YIN_MIN_F0_HZ)));
    this.minLag = Math.max(2, Math.floor(this.decimatedRate / YIN_MAX_F0_HZ));
    this.yinWindow = Math.min(256, Math.max(64, this.maxLag * 2));
    this.yinAnalysisFrame = new Float32Array(this.yinWindow + this.maxLag);
    this.latencyFrames = (this.yinWindow + this.maxLag + YIN_HOP_DECIMATED) * DECIMATION_FACTOR;
    this.targetOffsetSemitones = this.clampPitch(parameters.pitch ?? 0);
    this.psolaProcessor = this.createPsolaProcessor();
    this.setParameters(parameters);
  }

  get queueDepth(): number { return this.queueCount; }

  get psolaLatencySamples(): number { return this.psolaProcessor.latencySamples; }

  get diagnostics(): BrowserRobotDiagnostics {
    return {
      pitchEstimateHz: this.pitchEstimateHz,
      pitchEstimateMidi: this.pitchEstimateMidi,
      pitchConfidence: this.pitchConfidence,
      hasPitch: this.hasPitch,
      targetMidi: this.targetMidi,
      targetSemitones: this.targetSemitones,
      latencyFrames: this.latencyFrames,
      queueDepth: this.queueCount,
      queueOverflowCount: this.queueOverflowCount,
      framesProcessed: this.framesProcessed,
    };
  }

  setParameters(parameters: BrowserRobotParameters): void {
    let changed = false;
    if (parameters.note !== undefined) {
      if (!Number.isInteger(parameters.note) || parameters.note < -1 || parameters.note > 11) throw new RangeError('ROBOT note must be -1 (legacy) or a pitch class from 0 to 11.');
      this.targetNote = parameters.note;
      this.targetMidiInitialized = false;
      changed = true;
    }
    if (parameters.pitch !== undefined) {
      if (!Number.isFinite(parameters.pitch)) throw new RangeError('ROBOT pitch must be finite.');
      if (parameters.pitch < -24 || parameters.pitch > 24) throw new RangeError('ROBOT pitch must be between -24 and +24 semitones.');
      this.targetOffsetSemitones = parameters.pitch;
      changed = true;
    }
    if (parameters.formant !== undefined) {
      if (!Number.isFinite(parameters.formant) || parameters.formant < -12 || parameters.formant > 12) {
        throw new RangeError('ROBOT formant must be between -12 and +12 semitones.');
      }
      this.targetFormantSemitones = parameters.formant;
      changed = true;
    }
    if (changed && this.hasPitch) this.updateTarget(this.lastFrame + 1, true);
    else if (changed) this.updateProcessingMode(this.lastFrame + 1);
  }

  /** Process one mono frame using only construction-time storage. */
  processSample(input: number, frame: number): void {
    const sampleFrame = Number.isSafeInteger(frame) && frame >= 0 ? frame : this.framesProcessed;
    const sample = Number.isFinite(input) ? Math.max(-8, Math.min(8, input)) : 0;
    this.psolaInput[0] = sample;
    this.psolaProcessor.process(this.psolaInput, this.psolaOutput, 1, 0, 0);
    const psolaSample = this.psolaOutput[0] ?? 0;
    this.psolaOutputSample = Number.isFinite(psolaSample) ? psolaSample : 0;
    this.lastFrame = sampleFrame;
    this.framesProcessed += 1;

    this.decimationSum += sample;
    this.decimationCount += 1;
    if (this.decimationCount >= DECIMATION_FACTOR) {
      this.pushDecimatedSample(this.decimationSum / DECIMATION_FACTOR);
      this.decimationSum = 0;
      this.decimationCount = 0;
    }
  }

  processStereoSample(left: number, right: number, frame: number): void {
    const l = Number.isFinite(left) ? left : 0;
    const r = Number.isFinite(right) ? right : 0;
    this.processSample((l + r) * 0.5, frame);
  }

  /** Pop one primitive event into mutable `lastTarget*` fields. */
  tryPopTargetChange(): boolean {
    if (this.queueCount <= 0) return false;
    this.lastTargetFrame = this.queueFrames[this.queueHead]!;
    this.lastTargetSemitones = this.queueSemitones[this.queueHead]!;
    this.lastTargetSourceMidi = this.queueSourceMidi[this.queueHead]!;
    this.lastTargetMidi = this.queueTargetMidi[this.queueHead]!;
    this.lastTargetHz = this.queueHz[this.queueHead]!;
    this.lastTargetConfidence = this.queueConfidence[this.queueHead]!;
    this.lastTargetVoiced = this.queueVoiced[this.queueHead] !== 0;
    this.queueHead = (this.queueHead + 1) & QUEUE_MASK;
    this.queueCount -= 1;
    return true;
  }

  reset(): void {
    this.yinRing.fill(0);
    this.yinCmnd.fill(0);
    this.queueFrames.fill(0);
    this.queueSemitones.fill(0);
    this.queueSourceMidi.fill(0);
    this.queueTargetMidi.fill(0);
    this.queueHz.fill(0);
    this.queueConfidence.fill(0);
    this.queueVoiced.fill(0);
    this.queueHead = 0;
    this.queueTail = 0;
    this.queueCount = 0;
    this.decimationSum = 0;
    this.decimationCount = 0;
    this.decimatedSamples = 0;
    this.analysisCountdown = YIN_HOP_DECIMATED;
    this.totalSinceReset = 0;
    this.invalidAnalyses = 0;
    this.lastFrame = 0;
    this.lastQueuedVoiced = false;
    this.lastQueuedSemitones = Number.NaN;
    this.targetMidiInitialized = false;
    this.pitchEstimateHz = 0;
    this.pitchEstimateMidi = 0;
    this.pitchConfidence = 0;
    this.hasPitch = false;
    this.targetMidi = 0;
    this.targetSemitones = 0;
    this.targetMidiInitialized = false;
    this.framesProcessed = 0;
    this.queueOverflowCount = 0;
    this.lastTargetFrame = -1;
    this.lastTargetSemitones = 0;
    this.lastTargetSourceMidi = 0;
    this.lastTargetMidi = 0;
    this.lastTargetHz = 0;
    this.lastTargetConfidence = 0;
    this.lastTargetVoiced = false;
    this.psolaProcessor = this.createPsolaProcessor();
    this.psolaInput[0] = 0;
    this.psolaOutput[0] = 0;
    this.psolaOutputSample = 0;
    this.previousStableFrequencyHz = 0;
    this.stableAnalysisCount = 0;
    this.setProcessingMode('signalsmith', 'unvoiced', 0);
  }

  private pushDecimatedSample(sample: number): void {
    this.yinRing[this.decimatedSamples & YIN_RING_MASK] = sample;
    this.decimatedSamples += 1;
    this.totalSinceReset += 1;
    this.analysisCountdown -= 1;
    if (this.analysisCountdown > 0) return;
    this.analysisCountdown = YIN_HOP_DECIMATED;
    if (this.totalSinceReset >= this.yinWindow + this.maxLag) this.analyzePitch();
  }

  private analyzePitch(): void {
    const newest = this.decimatedSamples - 1;
    let energy = 0;
    for (let i = 0; i < this.yinWindow; i += 1) {
      const sample = this.yinRing[(newest - i) & YIN_RING_MASK]!;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / this.yinWindow);
    if (!Number.isFinite(rms) || rms < YIN_RMS_FLOOR) {
      this.rejectPitch();
      return;
    }

    for (let i = 0; i < this.yinAnalysisFrame.length; i += 1) {
      this.yinAnalysisFrame[i] = this.yinRing[(newest - i) & YIN_RING_MASK]!;
    }

    let cumulative = 0;
    let bestLag = -1;
    let bestCmnd = 1;
    let firstThresholdLag = -1;
    for (let lag = 1; lag <= this.maxLag; lag += 1) {
      let difference = 0;
      for (let i = 0; i < this.yinWindow; i += 1) {
        const a = this.yinAnalysisFrame[i]!;
        const b = this.yinAnalysisFrame[i + lag]!;
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
      if (lag >= this.minLag && firstThresholdLag < 0 && normalized < YIN_THRESHOLD) {
        firstThresholdLag = lag;
      }
      // Threshold detection still uses the original double normalized value;
      // the trough comparison still uses Float32 CMND, as the selection loop does.
      if (firstThresholdLag >= 0 && lag > firstThresholdLag
        && this.yinCmnd[lag]! >= this.yinCmnd[lag - 1]!) break;
    }

    if (firstThresholdLag >= 0) {
      let lag = firstThresholdLag;
      while (lag < this.maxLag && this.yinCmnd[lag + 1]! < this.yinCmnd[lag]!) lag += 1;
      bestLag = lag;
      bestCmnd = this.yinCmnd[lag]!;
    }
    if (bestLag < this.minLag || bestLag > this.maxLag || bestCmnd > 0.45) {
      this.rejectPitch();
      return;
    }

    const before = this.yinCmnd[bestLag - 1] ?? bestCmnd;
    const center = this.yinCmnd[bestLag] ?? bestCmnd;
    const after = this.yinCmnd[bestLag + 1] ?? center;
    const denominator = before - (2 * center) + after;
    const correction = Math.abs(denominator) > 1e-8
      ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator))
      : 0;
    const frequency = this.decimatedRate / (bestLag + correction);
    if (!Number.isFinite(frequency) || frequency < YIN_MIN_F0_HZ || frequency > YIN_MAX_F0_HZ) {
      this.rejectPitch();
      return;
    }

    const midi = 69 + (12 * Math.log2(frequency / 440));
    const confidence = Math.max(0, Math.min(1, 1 - bestCmnd));
    if (!Number.isFinite(midi) || confidence < PITCH_CONFIDENCE_THRESHOLD) {
      this.rejectPitch();
      return;
    }

    this.invalidAnalyses = 0;
    this.pitchEstimateHz = frequency;
    this.pitchEstimateMidi = midi;
    this.pitchConfidence = confidence;
    this.hasPitch = true;
    const driftCents = this.previousStableFrequencyHz > 0
      ? Math.abs(1_200 * Math.log2(frequency / this.previousStableFrequencyHz))
      : Number.POSITIVE_INFINITY;
    this.stableAnalysisCount = driftCents <= PSOLA_STABLE_CENTS ? this.stableAnalysisCount + 1 : 1;
    this.previousStableFrequencyHz = frequency;
    this.updateTarget(this.lastFrame, false);
  }

  private rejectPitch(): void {
    this.invalidAnalyses += 1;
    if (this.invalidAnalyses < 2 || !this.hasPitch) return;
    this.hasPitch = false;
    this.pitchEstimateHz = 0;
    this.pitchEstimateMidi = 0;
    this.pitchConfidence = 0;
    this.targetMidi = 0;
    this.targetSemitones = 0;
    this.targetMidiInitialized = false;
    this.previousStableFrequencyHz = 0;
    this.stableAnalysisCount = 0;
    this.updateProcessingMode(this.lastFrame);
    this.enqueueTarget(this.lastFrame, 0, 0, 0, 0, 0, false);
  }

  private updateTarget(frame: number, force: boolean): void {
    if (!this.hasPitch) return;
    const shiftedMidi = this.pitchEstimateMidi + this.targetOffsetSemitones;
    let targetMidi = this.targetNote >= 0 ? 60 + this.targetNote : Math.round(shiftedMidi);
    if (this.targetNote < 0 && this.targetMidiInitialized) {
      if (targetMidi > this.targetMidi && shiftedMidi < this.targetMidi + 0.5 + NOTE_CHANGE_HYSTERESIS) {
        targetMidi = this.targetMidi;
      } else if (targetMidi < this.targetMidi && shiftedMidi > this.targetMidi - 0.5 - NOTE_CHANGE_HYSTERESIS) {
        targetMidi = this.targetMidi;
      }
    }
    this.targetMidiInitialized = true;
    const semitones = this.targetNote >= 0
      ? Math.max(-36, Math.min(48, targetMidi - this.pitchEstimateMidi))
      : Math.max(-24, Math.min(24, targetMidi - this.pitchEstimateMidi));
    this.targetMidi = targetMidi;
    this.targetSemitones = semitones;
    this.updateProcessingMode(frame);
    const changed = !this.lastQueuedVoiced || !Number.isFinite(this.lastQueuedSemitones)
      || Math.abs(semitones - this.lastQueuedSemitones) >= TARGET_CHANGE_DEADBAND;
    if (force || changed) {
      this.enqueueTarget(frame, semitones, this.pitchEstimateMidi, targetMidi, this.pitchEstimateHz, this.pitchConfidence, true);
    }
  }

  private enqueueTarget(
    frame: number,
    semitones: number,
    sourceMidi: number,
    targetMidi: number,
    hz: number,
    confidence: number,
    voiced: boolean,
  ): void {
    if (this.queueCount > 0) {
      const previousIndex = (this.queueTail - 1) & QUEUE_MASK;
      if (this.queueFrames[previousIndex] === frame) {
        this.writeTarget(previousIndex, semitones, sourceMidi, targetMidi, hz, confidence, voiced);
        this.lastQueuedVoiced = voiced;
        this.lastQueuedSemitones = voiced ? semitones : Number.NaN;
        return;
      }
    }
    if (this.queueCount >= QUEUE_CAPACITY) {
      this.queueOverflowCount += 1;
      return;
    }
    const index = this.queueTail;
    this.queueFrames[index] = frame;
    this.writeTarget(index, semitones, sourceMidi, targetMidi, hz, confidence, voiced);
    this.queueTail = (this.queueTail + 1) & QUEUE_MASK;
    this.queueCount += 1;
    this.lastQueuedVoiced = voiced;
    this.lastQueuedSemitones = voiced ? semitones : Number.NaN;
  }

  private writeTarget(index: number, semitones: number, sourceMidi: number, targetMidi: number, hz: number, confidence: number, voiced: boolean): void {
    this.queueSemitones[index] = semitones;
    this.queueSourceMidi[index] = sourceMidi;
    this.queueTargetMidi[index] = targetMidi;
    this.queueHz[index] = hz;
    this.queueConfidence[index] = confidence;
    this.queueVoiced[index] = voiced ? 1 : 0;
  }

  private clampPitch(value: number): number { return Math.max(-24, Math.min(24, value)); }

  private createPsolaProcessor(): LiveMonoPitchProcessor {
    return new LiveMonoPitchProcessor({
      sampleRate: this.sampleRate,
      minimumFrequencyHz: PSOLA_MIN_F0_HZ,
      maximumFrequencyHz: PSOLA_MAX_F0_HZ,
    });
  }

  private updateProcessingMode(frame: number): void {
    let mode: BrowserRobotProcessingMode = 'signalsmith';
    let reason: BrowserRobotModeReason = 'unvoiced';
    if (this.hasPitch) {
      if (this.pitchConfidence < PSOLA_CONFIDENCE_THRESHOLD) reason = 'low-confidence';
      else if (this.pitchEstimateHz < PSOLA_MIN_F0_HZ || this.pitchEstimateHz > PSOLA_MAX_F0_HZ) {
        reason = 'source-frequency-out-of-range';
      } else if (Math.abs(this.targetSemitones) > 12) reason = 'target-shift-out-of-range';
      else if (Math.abs(this.targetFormantSemitones) > 1e-6) reason = 'formant-control-active';
      else if (this.stableAnalysisCount < PSOLA_STABLE_ANALYSES) reason = 'unstable-f0';
      else {
        mode = 'psola';
        reason = 'stable-voiced';
      }
    }
    this.psolaProcessor.setSemitones(mode === 'psola' ? this.targetSemitones : 0);
    this.setProcessingMode(mode, reason, frame);
  }

  private setProcessingMode(mode: BrowserRobotProcessingMode, reason: BrowserRobotModeReason, frame: number): void {
    if (mode === this.processingMode && reason === this.modeReason) return;
    this.processingMode = mode;
    this.modeReason = reason;
    this.modeFrame = Number.isSafeInteger(frame) && frame >= 0 ? frame : 0;
    this.modeRevision += 1;
  }
}
