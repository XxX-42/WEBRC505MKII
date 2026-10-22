/** Native manual controls; the host owns the direct/effect BALANCE. */
export interface BrowserOfficialRollParameters {
  variant?: 1 | 2;
  /** 1..1000 milliseconds, or negative quarter-note beats (1/8..2). */
  time?: number;
  /** ROLL1 FEEDBACK / ROLL2 REPEAT: 1..100; ROLL2 also accepts INF=-1000. */
  repeats?: number;
  /** OFF=0, 1/2=1, 1/4=2, 1/8=3, 1/16=4. */
  roll?: number;
  bpm?: number;
}

const INFINITE = -1000;
const MIN_BPM = 40;
const MAX_BPM = 300;
const MAX_SYNC_BEATS = 2;
const MIN_SYNC_BEATS = 0.125;
const MAX_CAPTURE_SECONDS = MAX_SYNC_BEATS * 60 / MIN_BPM;
const MAX_MAGNITUDE = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function bounded(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_MAGNITUDE, MAX_MAGNITUDE) : 0;
}

/**
 * Clean-room implementation of the documented ROLL1/ROLL2 control contract.
 * The manual distinguishes previous/new algorithms but does not disclose their
 * DSP. Both use this authored capture/repeat engine; no factory parity is claimed.
 *
 * OFF initially listens silently. An OFF->ON transition snapshots the latest
 * complete TIME interval. When there is not enough pre-roll, output stays silent
 * until a complete interval is available; playback starts on the following sample.
 * ON loops the first 1/2, 1/4, 1/8 or 1/16 of that snapshot indefinitely. Changing
 * the division restarts the selected fraction without replacing captured audio.
 * OFF restarts the last selected fraction for exactly FEEDBACK/REPEAT complete
 * cycles, then silences wet output; only ROLL2 permits an infinite release tail.
 * Releasing a pending, incomplete capture cancels it without inventing audio.
 *
 * TIME/BPM edits restart playback and linearly resample the same captured audio
 * into the new duration. This changes pitch, rather than doing time stretching.
 * Repeat counts are counted cycles, never recursive feedback gains. Edits to a
 * running release count change its total budget, not the number already played.
 * Unity gain, first-fraction selection and these transition rules are explicit
 * implementation choices, not undocumented claims about the original hardware.
 *
 * Source history stays live during held and released playback for the next ON.
 * The four fixed stereo-history/snapshot arrays are allocated in the constructor;
 * even capture transitions allocate nothing in processSample or setParameters.
 * Snapshot copying is bounded by three seconds (half note at 40 BPM). All timing
 * is sample-clocked and independent of host block sizes and time signature.
 */
export class BrowserOfficialRollDsp {
  readonly sampleRate: number;
  readonly maxCaptureFrames: number;
  wetLeft = 0;
  wetRight = 0;

  private readonly sourceLeft: Float32Array;
  private readonly sourceRight: Float32Array;
  private readonly capturedLeft: Float32Array;
  private readonly capturedRight: Float32Array;
  private variant: 1 | 2 = 1;
  private time = -1;
  private bpm = 120;
  private repeats = 50;
  private finiteRepeats = 50;
  private roll = 0;
  private playbackDivision = 1;
  private sourceWriteIndex = 0;
  private sourceFrames = 0;
  private capturedFrames = 0;
  private baseFrames: number;
  private fragmentFrames = 0;
  private cycleFrames = 0;
  private cyclePosition = 0;
  private completedReleaseRepeats = 0;
  private pendingCapture = false;
  private playing = false;

  constructor(sampleRate = 48000, parameters: BrowserOfficialRollParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate) ? clamp(sampleRate, 8000, 192000) : 48000;
    this.maxCaptureFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_SECONDS);
    this.sourceLeft = new Float32Array(this.maxCaptureFrames);
    this.sourceRight = new Float32Array(this.maxCaptureFrames);
    this.capturedLeft = new Float32Array(this.maxCaptureFrames);
    this.capturedRight = new Float32Array(this.maxCaptureFrames);
    this.baseFrames = Math.round(this.sampleRate * 0.5);
    this.setParameters(parameters);
  }

  get hasCapturedSlice(): boolean { return this.capturedFrames > 0; }
  get isCapturePending(): boolean { return this.pendingCapture; }
  get isPlaying(): boolean { return this.playing; }
  /** Undivided TIME duration, including synchronized values above 1000 ms. */
  get timeFrames(): number { return this.baseFrames; }
  get activeCycleFrames(): number { return this.cycleFrames; }

  setParameters(parameters: BrowserOfficialRollParameters): void {
    const previousRoll = this.roll;
    const previousFrames = this.baseFrames;
    if (parameters.variant === 1 || parameters.variant === 2) this.variant = parameters.variant;
    if (this.variant === 1 && this.repeats === INFINITE) this.repeats = this.finiteRepeats;
    if (Number.isFinite(parameters.repeats)) {
      const repeats = parameters.repeats as number;
      if (repeats === INFINITE && this.variant === 2) this.repeats = INFINITE;
      else if (repeats > 0) this.repeats = this.finiteRepeats = Math.round(clamp(repeats, 1, 100));
    }
    // TIME has no OFF/INF selection. Ignore invalid sentinel/zero updates.
    if (Number.isFinite(parameters.time) && parameters.time !== 0 && parameters.time !== INFINITE) {
      const time = parameters.time as number;
      this.time = time > 0 ? clamp(time, 1, 1000) : -clamp(Math.abs(time), MIN_SYNC_BEATS, MAX_SYNC_BEATS);
    }
    if (Number.isFinite(parameters.bpm)) this.bpm = clamp(parameters.bpm as number, MIN_BPM, MAX_BPM);
    if (Number.isFinite(parameters.roll)) this.roll = Math.round(clamp(parameters.roll as number, 0, 4));
    const seconds = this.time > 0 ? this.time / 1000 : -this.time * 60 / this.bpm;
    this.baseFrames = Math.max(1, Math.min(this.maxCaptureFrames, Math.round(seconds * this.sampleRate)));

    if (previousRoll === 0 && this.roll !== 0) {
      this.capturedFrames = 0;
      this.playing = false;
      this.pendingCapture = true;
      this.completedReleaseRepeats = 0;
      this.playbackDivision = 2 ** this.roll;
      this.cyclePosition = 0;
      this.updateCycle();
      this.captureIfReady();
    } else if (previousRoll !== 0 && this.roll === 0) {
      this.pendingCapture = false;
      this.completedReleaseRepeats = 0;
      this.cyclePosition = 0;
      // Keep the previously selected fraction, but use any simultaneous TIME edit.
      this.updateCycle();
    } else if (this.roll !== 0) {
      this.playbackDivision = 2 ** this.roll;
      if (previousRoll !== this.roll || previousFrames !== this.baseFrames) {
        this.cyclePosition = 0;
        this.updateCycle();
      }
      if (this.pendingCapture) this.captureIfReady();
    } else if (previousFrames !== this.baseFrames) {
      this.cyclePosition = 0;
      this.updateCycle();
    }
    if (this.roll === 0 && this.repeats !== INFINITE && this.completedReleaseRepeats >= this.repeats) {
      this.playing = false;
    }
  }

  /** Returns the reusable instance; no allocation occurs in this audio path. */
  processSample(left: number, right: number): this {
    this.wetLeft = 0;
    this.wetRight = 0;
    if (this.playing && this.fragmentFrames > 0 && this.cycleFrames > 0) {
      const sourcePosition = this.cyclePosition * this.fragmentFrames / this.cycleFrames;
      const first = Math.floor(sourcePosition);
      const second = first + 1 < this.fragmentFrames ? first + 1 : 0;
      const fraction = sourcePosition - first;
      this.wetLeft = bounded(this.capturedLeft[first]! * (1 - fraction) + this.capturedLeft[second]! * fraction);
      this.wetRight = bounded(this.capturedRight[first]! * (1 - fraction) + this.capturedRight[second]! * fraction);
      this.cyclePosition += 1;
      if (this.cyclePosition >= this.cycleFrames) {
        this.cyclePosition = 0;
        if (this.roll === 0) {
          this.completedReleaseRepeats += 1;
          if (this.repeats !== INFINITE && this.completedReleaseRepeats >= this.repeats) this.playing = false;
        }
      }
    }

    this.sourceLeft[this.sourceWriteIndex] = bounded(left);
    this.sourceRight[this.sourceWriteIndex] = bounded(right);
    this.sourceWriteIndex += 1;
    if (this.sourceWriteIndex >= this.maxCaptureFrames) this.sourceWriteIndex = 0;
    this.sourceFrames = Math.min(this.maxCaptureFrames, this.sourceFrames + 1);
    // Capture after rendering: the final sample of a pending capture belongs to
    // the input interval, not also to its first repeated playback cycle.
    if (this.pendingCapture) this.captureIfReady();
    return this;
  }

  /** Retain controls and storage, discard all signal history and release counts. */
  reset(): void {
    this.sourceLeft.fill(0);
    this.sourceRight.fill(0);
    this.capturedLeft.fill(0);
    this.capturedRight.fill(0);
    this.sourceWriteIndex = 0;
    this.sourceFrames = 0;
    this.capturedFrames = 0;
    this.cyclePosition = 0;
    this.completedReleaseRepeats = 0;
    this.pendingCapture = this.roll !== 0;
    this.playing = false;
    if (this.roll !== 0) this.playbackDivision = 2 ** this.roll;
    this.updateCycle();
    this.wetLeft = 0;
    this.wetRight = 0;
  }

  private updateCycle(): void {
    this.cycleFrames = Math.max(1, Math.round(this.baseFrames / this.playbackDivision));
    this.fragmentFrames = this.capturedFrames > 0
      ? Math.max(1, Math.round(this.capturedFrames / this.playbackDivision)) : 0;
  }

  private captureIfReady(): void {
    if (!this.pendingCapture || this.sourceFrames < this.baseFrames) return;
    let source = this.sourceWriteIndex - this.baseFrames;
    if (source < 0) source += this.maxCaptureFrames;
    for (let frame = 0; frame < this.baseFrames; frame += 1) {
      this.capturedLeft[frame] = this.sourceLeft[source]!;
      this.capturedRight[frame] = this.sourceRight[source]!;
      source += 1;
      if (source >= this.maxCaptureFrames) source = 0;
    }
    this.capturedFrames = this.baseFrames;
    this.pendingCapture = false;
    this.playing = true;
    this.cyclePosition = 0;
    this.updateCycle();
  }
}
