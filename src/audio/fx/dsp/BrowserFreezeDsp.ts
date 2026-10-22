/**
 * Clean-room, micro-loop-only FREEZE processor for the browser runtime.
 *
 * It continuously keeps a fixed-size stereo history. Setting `frozen: true`
 * swaps the two preallocated stereo ring pairs in O(1): the captured ring is
 * held for playback while the other ring starts collecting fresh history for
 * a later capture. The loop is read with a short linear overlap at its seam;
 * correlated adjacent samples therefore do not receive a 3 dB equal-power
 * boost. `pitchSemitones` controls
 * varispeed playback, so it changes both pitch and repeat duration.
 * This is not STFT/spectral freeze and does not claim Roland factory DSP.
 *
 * Both stereo ring pairs are allocated in the constructor. Capture does not
 * copy audio on the render callback. `processSample` and `processBlock` use
 * scalar state and caller-owned arrays only; blocks may have any length, and
 * neither processing method allocates.
 */
export interface BrowserFreezeParameters {
  captureLengthMs?: number;
  pitchSemitones?: number;
  /** A false-to-true transition captures; a true-to-false transition releases. */
  frozen?: boolean;
}

/** RC-505mkII panel values. BALANCE belongs to the outer dry/wet mixer. */
export interface BrowserFreezeOfficialParameters {
  attack?: number;
  release?: number;
  decay?: number;
  sustain?: number;
}

type FreezeEnvelopeStage = 'idle' | 'attack' | 'decay' | 'sustain' | 'release';

const MIN_CAPTURE_MS = 2;
const MAX_CAPTURE_MS = 2000;
const MIN_PITCH_SEMITONES = -24;
const MAX_PITCH_SEMITONES = 24;
const MIN_SAMPLE_RATE = 8000;
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CAPTURE_MS = 250;
const DEFAULT_PITCH_SEMITONES = 0;
const RELEASE_FADE_MS = 5;
const MAX_LOOP_SEAM_MS = 5;
const PITCH_SMOOTHING_MS = 15;
const MAX_ABS_SAMPLE = 8;
const DEFAULT_OFFICIAL_ENVELOPE_VALUE = 30;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteSample(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_ABS_SAMPLE, MAX_ABS_SAMPLE) : 0;
}

function onePoleAlpha(timeMs: number, sampleRate: number): number {
  return Math.exp(-1 / (Math.max(0.001, timeMs) * 0.001 * sampleRate));
}

/** Fixed-capacity stereo history / loop reader. */
export class BrowserFreezeDsp {
  readonly sampleRate: number;
  readonly maxCaptureFrames: number;

  outputLeft = 0;
  outputRight = 0;
  framesProcessed = 0;

  private historyLeft: Float32Array;
  private historyRight: Float32Array;
  private loopLeft: Float32Array;
  private loopRight: Float32Array;
  private readonly fadeStep: number;
  private readonly pitchSmoothingAlpha: number;
  private captureLengthMs = DEFAULT_CAPTURE_MS;
  private captureLengthFrames: number;
  private targetPitchSemitones = DEFAULT_PITCH_SEMITONES;
  private targetPlaybackRate = 1;
  private playbackRate = 1;
  private targetFrozen = false;
  private capturePending = false;
  private frozenBufferActive = false;
  private activationGain = 0;
  private writePosition = 0;
  private historyFrames = 0;
  private loopStart = 0;
  private loopLength = 0;
  private loopCrossfadeFrames = 0;
  private loopPhase = 0;
  private officialMode = false;
  private attackFrames: number;
  private decayFrames: number;
  private releaseFrames: number;
  private sustainGain = DEFAULT_OFFICIAL_ENVELOPE_VALUE / 100;
  private envelopeStage: FreezeEnvelopeStage = 'idle';
  private envelopeElapsed = 0;
  private envelopeDuration = 1;
  private envelopeStartGain = 0;
  private envelopeTargetGain = 0;

  constructor(sampleRate: number, parameters: BrowserFreezeParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= MIN_SAMPLE_RATE
      ? sampleRate
      : DEFAULT_SAMPLE_RATE;
    this.maxCaptureFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_MS / 1000);
    this.historyLeft = new Float32Array(this.maxCaptureFrames);
    this.historyRight = new Float32Array(this.maxCaptureFrames);
    this.loopLeft = new Float32Array(this.maxCaptureFrames);
    this.loopRight = new Float32Array(this.maxCaptureFrames);
    this.captureLengthFrames = this.framesForCapture(DEFAULT_CAPTURE_MS);
    this.fadeStep = 1 / Math.max(1, Math.round(this.sampleRate * RELEASE_FADE_MS / 1000));
    this.pitchSmoothingAlpha = onePoleAlpha(PITCH_SMOOTHING_MS, this.sampleRate);
    this.attackFrames = this.framesForOfficialTime(DEFAULT_OFFICIAL_ENVELOPE_VALUE, 2, 2000);
    this.decayFrames = this.framesForOfficialTime(DEFAULT_OFFICIAL_ENVELOPE_VALUE, 10, 2000);
    this.releaseFrames = this.framesForOfficialTime(DEFAULT_OFFICIAL_ENVELOPE_VALUE, 2, 5000);
    this.setParameters(parameters);
  }

  /** Target capture state; when false, its release fade may still be active. */
  get isFrozen(): boolean {
    return this.targetFrozen;
  }

  /** True while the captured audio remains held, including its release fade. */
  get hasFrozenBuffer(): boolean {
    return this.frozenBufferActive;
  }

  /** Maximum tail length for the outer activation/bypass lifecycle. */
  get officialReleaseFrames(): number {
    return this.releaseFrames;
  }

  /**
   * Enables a wet-only, amplitude-ADSR path with the official 0..100 controls.
   * The manual specifies the controls, not their millisecond transfer curves:
   * these exponential mappings (A: 2..2000 ms, D: 10..2000 ms, R: 2..5000 ms)
   * are authored clean-room behavior, not a claim of Roland factory DSP.
   * Stage amplitudes use linear ramps; SUSTAIN maps directly to 0..100% gain.
   * Calling this method with an empty object enables the official defaults (30).
   * Never calling it preserves the original mixed-output micro-loop behavior.
   */
  setOfficialParameters(parameters: BrowserFreezeOfficialParameters): void {
    const previousAttackFrames = this.attackFrames;
    const previousDecayFrames = this.decayFrames;
    const previousReleaseFrames = this.releaseFrames;
    const previousSustainGain = this.sustainGain;
    if (Number.isFinite(parameters.attack)) {
      this.attackFrames = this.framesForOfficialTime(parameters.attack as number, 2, 2000);
    }
    if (Number.isFinite(parameters.decay)) {
      this.decayFrames = this.framesForOfficialTime(parameters.decay as number, 10, 2000);
    }
    if (Number.isFinite(parameters.release)) {
      this.releaseFrames = this.framesForOfficialTime(parameters.release as number, 2, 5000);
    }
    if (Number.isFinite(parameters.sustain)) {
      this.sustainGain = clamp(parameters.sustain as number, 0, 100) / 100;
    }

    if (!this.officialMode) {
      this.officialMode = true;
      // If enabled during a legacy hold, preserve its current wet amplitude.
      this.activationGain = Math.sin(this.activationGain * Math.PI / 2);
      if (this.frozenBufferActive) {
        if (this.targetFrozen && !this.capturePending) {
          this.startEnvelopeStage('attack', 1, this.attackFrames);
        } else {
          this.startEnvelopeStage('release', 0, this.releaseFrames);
        }
      }
      return;
    }

    // Parameter edits cannot restart the envelope when values are unchanged.
    // A changed active ramp starts from the current gain, avoiding a jump.
    if (this.envelopeStage === 'attack' && this.attackFrames !== previousAttackFrames) {
      this.startEnvelopeStage('attack', 1, this.attackFrames);
    } else if (this.envelopeStage === 'decay') {
      if (this.decayFrames !== previousDecayFrames) {
        this.startEnvelopeStage('decay', this.sustainGain, this.decayFrames);
      } else if (this.sustainGain !== previousSustainGain) {
        this.startEnvelopeStage('decay', this.sustainGain, this.envelopeDuration - this.envelopeElapsed);
      }
    } else if (this.envelopeStage === 'release' && this.releaseFrames !== previousReleaseFrames) {
      this.startEnvelopeStage('release', 0, this.releaseFrames);
    }
  }

  /** Controls and capture length latch at the next freeze activation. */
  setParameters(parameters: BrowserFreezeParameters): void {
    if (Number.isFinite(parameters.captureLengthMs)) {
      this.captureLengthMs = clamp(parameters.captureLengthMs as number, MIN_CAPTURE_MS, MAX_CAPTURE_MS);
      this.captureLengthFrames = this.framesForCapture(this.captureLengthMs);
    }
    if (Number.isFinite(parameters.pitchSemitones)) {
      this.targetPitchSemitones = clamp(parameters.pitchSemitones as number, MIN_PITCH_SEMITONES, MAX_PITCH_SEMITONES);
      this.targetPlaybackRate = Math.pow(2, this.targetPitchSemitones / 12);
    }
    if (typeof parameters.frozen === 'boolean' && parameters.frozen !== this.targetFrozen) {
      this.setFrozen(parameters.frozen);
    }
  }

  /** Processes one frame and exposes its stereo result through outputLeft/Right. */
  processSample(inputLeft: number, inputRight: number): void {
    const left = finiteSample(inputLeft);
    const right = finiteSample(inputRight);

    this.writeHistory(left, right);

    const targetLoopRate = this.loopLength > this.loopCrossfadeFrames && this.loopLength > 0
      ? this.targetPlaybackRate * ((this.loopLength - this.loopCrossfadeFrames) / this.loopLength)
      : this.targetPlaybackRate;
    this.playbackRate += (targetLoopRate - this.playbackRate) * (1 - this.pitchSmoothingAlpha);
    if (this.capturePending
      && this.historyFrames >= this.captureLengthFrames
      && (!this.frozenBufferActive || this.activationGain === 0)) {
      this.captureHistory();
      this.capturePending = false;
    }
    // If a fresh capture is pending while an old loop is fading out, finish
    // that release before swapping rings. This avoids replacing the samples
    // under an active reader and causing a discontinuity on a fast retrigger.
    if (this.officialMode) {
      this.advanceOfficialEnvelope();
    } else {
      const fadeTarget = this.targetFrozen && this.frozenBufferActive && !this.capturePending ? 1 : 0;
      this.activationGain = this.moveToward(this.activationGain, fadeTarget, this.fadeStep);
    }

    let frozenLeft = 0;
    let frozenRight = 0;
    if (this.frozenBufferActive) {
      frozenLeft = this.readFrozenChannel(this.loopLeft);
      frozenRight = this.readFrozenChannel(this.loopRight);
    }

    if (this.officialMode) {
      // The outer core owns BALANCE; adding dry here would count it twice.
      this.outputLeft = this.activationGain > 0 ? finiteSample(frozenLeft * this.activationGain) : 0;
      this.outputRight = this.activationGain > 0 ? finiteSample(frozenRight * this.activationGain) : 0;
    } else {
      const dryGain = Math.cos(this.activationGain * Math.PI / 2);
      const frozenGain = Math.sin(this.activationGain * Math.PI / 2);
      this.outputLeft = finiteSample((left * dryGain) + (frozenLeft * frozenGain));
      this.outputRight = finiteSample((right * dryGain) + (frozenRight * frozenGain));
    }

    if (this.frozenBufferActive) this.advanceLoop();
    if (this.frozenBufferActive && !this.targetFrozen && this.activationGain === 0) {
      this.frozenBufferActive = false;
    }
    this.framesProcessed += 1;
  }

  /**
   * Processes the common prefix of the supplied arrays. Input/output arrays
   * may be the same channel arrays for in-place operation.
   */
  processBlock(
    inputLeft: Float32Array,
    inputRight: Float32Array,
    outputLeft: Float32Array,
    outputRight: Float32Array,
  ): void {
    const frameCount = Math.min(inputLeft.length, inputRight.length, outputLeft.length, outputRight.length);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const left = inputLeft[frame] ?? 0;
      const right = inputRight[frame] ?? 0;
      this.processSample(left, right);
      outputLeft[frame] = this.outputLeft;
      outputRight[frame] = this.outputRight;
    }
  }

  /** Clears ring and loop state without allocating new storage. */
  reset(): void {
    this.historyLeft.fill(0);
    this.historyRight.fill(0);
    this.loopLeft.fill(0);
    this.loopRight.fill(0);
    this.writePosition = 0;
    this.historyFrames = 0;
    this.loopStart = 0;
    this.loopLength = 0;
    this.loopCrossfadeFrames = 0;
    this.loopPhase = 0;
    this.targetFrozen = false;
    this.capturePending = false;
    this.frozenBufferActive = false;
    this.activationGain = 0;
    this.envelopeStage = 'idle';
    this.envelopeElapsed = 0;
    this.envelopeDuration = 1;
    this.envelopeStartGain = 0;
    this.envelopeTargetGain = 0;
    this.playbackRate = this.targetPlaybackRate;
    this.outputLeft = 0;
    this.outputRight = 0;
    this.framesProcessed = 0;
  }

  /** Snapshot diagnostics allocate only when explicitly read, outside processing. */
  get diagnostics(): Readonly<{
    sampleRate: number;
    maxCaptureFrames: number;
    requestedCaptureLengthMs: number;
    requestedCaptureLengthFrames: number;
    activeCaptureLengthFrames: number;
    activeCrossfadeFrames: number;
    historyFrames: number;
    writePosition: number;
    loopPhase: number;
    targetPitchSemitones: number;
    playbackRate: number;
    targetFrozen: boolean;
    capturePending: boolean;
    hasFrozenBuffer: boolean;
    activationGain: number;
    framesProcessed: number;
  }> {
    return {
      sampleRate: this.sampleRate,
      maxCaptureFrames: this.maxCaptureFrames,
      requestedCaptureLengthMs: this.captureLengthMs,
      requestedCaptureLengthFrames: this.captureLengthFrames,
      activeCaptureLengthFrames: this.loopLength,
      activeCrossfadeFrames: this.loopCrossfadeFrames,
      historyFrames: this.historyFrames,
      writePosition: this.writePosition,
      loopPhase: this.loopPhase,
      targetPitchSemitones: this.targetPitchSemitones,
      playbackRate: this.playbackRate,
      targetFrozen: this.targetFrozen,
      capturePending: this.capturePending,
      hasFrozenBuffer: this.frozenBufferActive,
      activationGain: this.activationGain,
      framesProcessed: this.framesProcessed,
    };
  }

  private setFrozen(frozen: boolean): void {
    if (frozen) {
      // A new false-to-true edge always snapshots the latest rolling history,
      // including when a prior release fade is still in flight.
      this.targetFrozen = true;
      if (this.frozenBufferActive && this.activationGain > 0) {
        // Keep the active loop intact through its release ramp; the other ring
        // continues to collect the new generation until it is ready to swap.
        this.capturePending = true;
        if (this.officialMode && this.envelopeStage !== 'release') {
          this.startEnvelopeStage('release', 0, this.releaseFrames);
        }
      } else if (this.historyFrames >= this.captureLengthFrames) {
        this.captureHistory();
        this.capturePending = false;
      } else {
        // Wait until enough pre-roll exists rather than capturing zero-filled
        // startup history. Legacy mode passes dry input; official mode is wet-only.
        this.capturePending = true;
      }
      return;
    }
    this.targetFrozen = false;
    this.capturePending = false;
    if (this.officialMode && this.frozenBufferActive && this.envelopeStage !== 'release') {
      this.startEnvelopeStage('release', 0, this.releaseFrames);
    }
  }

  private captureHistory(): void {
    this.loopLength = this.captureLengthFrames;
    this.loopStart = this.wrapHistoryIndex(this.writePosition - this.loopLength);
    const nextHistoryLeft = this.loopLeft;
    const nextHistoryRight = this.loopRight;
    this.loopLeft = this.historyLeft;
    this.loopRight = this.historyRight;
    this.historyLeft = nextHistoryLeft;
    this.historyRight = nextHistoryRight;
    // The other ring may contain a previous capture. It is a new generation:
    // only samples recorded after this swap are eligible for the next freeze.
    this.writePosition = 0;
    this.historyFrames = 0;
    this.loopCrossfadeFrames = Math.min(
      Math.max(1, Math.floor(this.loopLength / 4)),
      Math.max(1, Math.min(
        Math.round(this.sampleRate * MAX_LOOP_SEAM_MS / 1000),
        Math.floor(this.loopLength * 0.01),
      )),
    );
    this.loopPhase = this.loopCrossfadeFrames;
    this.frozenBufferActive = true;
    if (this.officialMode) {
      this.activationGain = 0;
      this.startEnvelopeStage('attack', 1, this.attackFrames);
    }
  }

  private startEnvelopeStage(stage: FreezeEnvelopeStage, target: number, duration: number): void {
    this.envelopeStage = stage;
    this.envelopeElapsed = 0;
    this.envelopeDuration = Math.max(1, duration);
    this.envelopeStartGain = this.activationGain;
    this.envelopeTargetGain = target;
  }

  private advanceOfficialEnvelope(): void {
    if (!this.frozenBufferActive) {
      this.activationGain = 0;
      this.envelopeStage = 'idle';
      return;
    }
    if (this.envelopeStage === 'idle') return;
    if (this.envelopeStage === 'sustain') {
      this.activationGain = this.sustainGain;
      return;
    }

    this.envelopeElapsed += 1;
    if (this.envelopeElapsed < this.envelopeDuration) {
      this.activationGain = this.envelopeStartGain
        + ((this.envelopeTargetGain - this.envelopeStartGain) * this.envelopeElapsed / this.envelopeDuration);
      return;
    }

    // Exact endpoints avoid an asymptotic release that never frees the loop.
    this.activationGain = this.envelopeTargetGain;
    if (this.envelopeStage === 'attack') {
      this.startEnvelopeStage('decay', this.sustainGain, this.decayFrames);
    } else if (this.envelopeStage === 'decay') {
      this.envelopeStage = 'sustain';
    } else {
      this.envelopeStage = 'idle';
    }
  }

  private writeHistory(left: number, right: number): void {
    this.historyLeft[this.writePosition] = left;
    this.historyRight[this.writePosition] = right;
    this.writePosition += 1;
    if (this.writePosition >= this.maxCaptureFrames) this.writePosition = 0;
    if (this.historyFrames < this.maxCaptureFrames) this.historyFrames += 1;
  }

  private readFrozenChannel(buffer: Float32Array): number {
    const seamStart = this.loopLength - this.loopCrossfadeFrames;
    if (this.loopPhase + this.playbackRate >= seamStart) {
      // Include the next read step in the blend position so high varispeed
      // settings cannot jump completely over the short overlap window.
      const seamPosition = clamp(
        (this.loopPhase - seamStart + this.playbackRate) / this.loopCrossfadeFrames,
        0,
        1,
      );
      const oldGain = 1 - seamPosition;
      const newGain = seamPosition;
      const outgoing = this.readLoopPosition(buffer, this.loopPhase);
      const incoming = this.readLoopPosition(buffer, clamp(this.loopPhase - seamStart, 0, this.loopCrossfadeFrames));
      return finiteSample((outgoing * oldGain) + (incoming * newGain));
    }
    return this.readLoopPosition(buffer, this.loopPhase);
  }

  private readLoopPosition(buffer: Float32Array, position: number): number {
    const bounded = clamp(position, 0, this.loopLength - 1);
    const firstFrame = Math.floor(bounded);
    const secondFrame = Math.min(firstFrame + 1, this.loopLength - 1);
    const fraction = bounded - firstFrame;
    const firstIndex = (this.loopStart + firstFrame) % this.maxCaptureFrames;
    const secondIndex = (this.loopStart + secondFrame) % this.maxCaptureFrames;
    const firstSample = buffer[firstIndex] ?? 0;
    const secondSample = buffer[secondIndex] ?? 0;
    return firstSample + ((secondSample - firstSample) * fraction);
  }

  private advanceLoop(): void {
    this.loopPhase += this.playbackRate;
    if (this.loopPhase >= this.loopLength) {
      // The overlapped end-to-start seam shortens the repeat cycle by its window.
      this.loopPhase -= this.loopLength - this.loopCrossfadeFrames;
    }
  }

  private framesForCapture(milliseconds: number): number {
    return clamp(Math.round(this.sampleRate * milliseconds / 1000), 1, this.maxCaptureFrames);
  }

  private framesForOfficialTime(value: number, minimumMs: number, maximumMs: number): number {
    const milliseconds = minimumMs * Math.pow(maximumMs / minimumMs, clamp(value, 0, 100) / 100);
    return Math.max(1, Math.round(this.sampleRate * milliseconds / 1000));
  }

  private wrapHistoryIndex(index: number): number {
    let wrapped = index % this.maxCaptureFrames;
    if (wrapped < 0) wrapped += this.maxCaptureFrames;
    return wrapped;
  }

  private moveToward(value: number, target: number, amount: number): number {
    if (value < target) return target - value <= amount ? target : value + amount;
    if (value > target) return value - target <= amount ? target : value - amount;
    return value;
  }
}
