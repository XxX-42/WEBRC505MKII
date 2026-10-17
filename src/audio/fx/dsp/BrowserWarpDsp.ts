/**
 * Experimental clean-room WARP kernel (catalog source #42).
 *
 * This lower-tier path combines a tempo-sized stereo capture with a fixed
 * pool of Hann-windowed grains and an eight-line feedback delay network.
 * Capture toggles swap two preallocated history banks; grain launches and
 * feedback processing are sample-clocked and have fixed work per frame.
 * Spectral freeze is deliberately unsupported. The matrix's perceptual
 * topology inference is not represented as recovered Roland behavior.
 */

export interface BrowserWarpParameters {
  bpm?: number;
  captureBeats?: number;
  smearPercent?: number;
  pitchSemitones?: number;
  feedbackPercent?: number;
  frozen?: boolean;
}

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_BPM = 30;
const MAX_BPM = 300;
const CAPTURE_BEATS = [0.25, 0.5, 1, 2, 4] as const;
const MAX_CAPTURE_SECONDS = 8;
const GRAIN_COUNT = 8;
const WINDOW_TABLE_SIZE = 1024;
const GRAIN_WINDOW_MS = 160;
const MAX_FEEDBACK = 0.8;
const MAX_SAMPLE = 8;
const TWO_PI = Math.PI * 2;
const FDN_DELAY_SECONDS = [0.0297, 0.0371, 0.0411, 0.0533, 0.0617, 0.0719, 0.0797, 0.0893] as const;

const BPM = 0;
const CAPTURE = 1;
const SMEAR = 2;
const PITCH = 3;
const FEEDBACK = 4;

type StereoBank = readonly [Float32Array, Float32Array];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteBounded(value: number): number {
  return Number.isFinite(value) ? clamp(value, -MAX_SAMPLE, MAX_SAMPLE) : 0;
}

function quantizeBeats(value: number): number {
  let chosen: number = CAPTURE_BEATS[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const option of CAPTURE_BEATS) {
    const currentDistance = Math.abs(option - value);
    if (currentDistance < distance) {
      chosen = option;
      distance = currentDistance;
    }
  }
  return chosen;
}

/** Bounded two-bank granular capture and normalized Hadamard FDN8. */
export class BrowserWarpDsp {
  readonly sampleRate: number;
  readonly maxCaptureFrames: number;
  wetLeft = 0;
  wetRight = 0;
  framesProcessed = 0;
  captureCount = 0;
  private readonly banks: readonly [StereoBank, StereoBank];
  private readonly window: Float32Array;
  private readonly ageFrames = new Int32Array(GRAIN_COUNT);
  private readonly lengthFrames = new Int32Array(GRAIN_COUNT);
  private readonly readPositions = new Float64Array(GRAIN_COUNT);
  private readonly readSteps = new Float64Array(GRAIN_COUNT);
  private readonly fdnLines: Float32Array[];
  private readonly fdnWrite = new Uint32Array(8);
  private readonly fdnDamping = new Float64Array(8);
  private readonly fdnRead = new Float64Array(8);
  private readonly fdnTransform = new Float64Array(8);
  private readonly hadamard = new Int8Array(64);
  private readonly current = new Float64Array(5);
  private readonly target = new Float64Array(5);
  private readonly parameterAlpha: number;
  private readonly dampingAlpha: number;
  private writerBank = 0;
  private writerPosition = 0;
  private validFrames = 0;
  private frozenBank = -1;
  private frozenStart = 0;
  private frozenLength = 0;
  private freezeRequested = false;
  private freezePending = false;
  private freezeActive = false;
  private spawnPhase = 1;
  private nextVoice = 0;
  private randomState = 0x57415250;
  private lastFdnLeft = 0;
  private lastFdnRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserWarpParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;
    this.maxCaptureFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_SECONDS);
    const makeBank = (): StereoBank => [
      new Float32Array(this.maxCaptureFrames),
      new Float32Array(this.maxCaptureFrames),
    ];
    this.banks = [makeBank(), makeBank()];
    this.window = new Float32Array(WINDOW_TABLE_SIZE + 1);
    for (let index = 0; index <= WINDOW_TABLE_SIZE; index += 1) {
      this.window[index] = 0.5 - (0.5 * Math.cos(TWO_PI * index / WINDOW_TABLE_SIZE));
    }
    this.fdnLines = FDN_DELAY_SECONDS.map((seconds) => new Float32Array(
      Math.max(1, Math.round(seconds * this.sampleRate)),
    ));
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        let parity = 0;
        let bits = row & column;
        while (bits !== 0) {
          parity ^= bits & 1;
          bits >>>= 1;
        }
        this.hadamard[(row * 8) + column] = parity === 0 ? 1 : -1;
      }
    }
    this.parameterAlpha = 1 - Math.exp(-1 / (0.015 * this.sampleRate));
    this.dampingAlpha = 1 - Math.exp(-TWO_PI * 6500 / this.sampleRate);
    const bpm = Number.isFinite(parameters.bpm) ? clamp(parameters.bpm as number, MIN_BPM, MAX_BPM) : 120;
    const capture = Number.isFinite(parameters.captureBeats)
      ? quantizeBeats(parameters.captureBeats as number)
      : 1;
    const smear = Number.isFinite(parameters.smearPercent)
      ? clamp(parameters.smearPercent as number, 0, 100)
      : 30;
    const pitch = Number.isFinite(parameters.pitchSemitones)
      ? clamp(parameters.pitchSemitones as number, -24, 24)
      : 0;
    const feedback = Number.isFinite(parameters.feedbackPercent)
      ? clamp(parameters.feedbackPercent as number, 0, 95)
      : 20;
    this.current.set([bpm, capture, smear, pitch, feedback]);
    this.target.set(this.current);
    this.setParameters(parameters);
  }

  get isFrozen(): boolean { return this.freezeActive; }
  get hasPendingFreeze(): boolean { return this.freezePending; }
  get activeCaptureFrames(): number { return this.frozenLength; }

  setParameters(parameters: BrowserWarpParameters): void {
    if (Number.isFinite(parameters.bpm)) this.target[BPM] = clamp(parameters.bpm as number, MIN_BPM, MAX_BPM);
    if (Number.isFinite(parameters.captureBeats)) this.target[CAPTURE] = quantizeBeats(parameters.captureBeats as number);
    if (Number.isFinite(parameters.smearPercent)) this.target[SMEAR] = clamp(parameters.smearPercent as number, 0, 100);
    if (Number.isFinite(parameters.pitchSemitones)) this.target[PITCH] = clamp(parameters.pitchSemitones as number, -24, 24);
    if (Number.isFinite(parameters.feedbackPercent)) this.target[FEEDBACK] = clamp(parameters.feedbackPercent as number, 0, 95);
    if (typeof parameters.frozen === 'boolean' && parameters.frozen !== this.freezeRequested) {
      this.freezeRequested = parameters.frozen;
      if (this.freezeRequested && !this.freezeActive) this.freezePending = true;
      if (!this.freezeRequested) this.releaseCapture();
    }
  }

  processSample(inputLeft: number, inputRight: number): void {
    for (let index = 0; index < this.current.length; index += 1) {
      this.current[index] = (this.current[index] ?? 0)
        + this.parameterAlpha * ((this.target[index] ?? 0) - (this.current[index] ?? 0));
    }
    const left = finiteBounded(inputLeft);
    const right = finiteBounded(inputRight);
    const feedback = Math.min(MAX_FEEDBACK, (this.current[FEEDBACK] ?? 20) * 0.01);
    const bank = this.banks[this.writerBank]!;
    bank[0][this.writerPosition] = finiteBounded(left + feedback * this.lastFdnLeft);
    bank[1][this.writerPosition] = finiteBounded(right + feedback * this.lastFdnRight);
    this.writerPosition = (this.writerPosition + 1) % this.maxCaptureFrames;
    this.validFrames = Math.min(this.validFrames + 1, this.maxCaptureFrames);

    if (this.freezePending) this.tryCapture();
    const smear = clamp(this.current[SMEAR] ?? 30, 0, 100) * 0.01;
    const density = 6 + (smear * 34);
    this.spawnPhase += density / this.sampleRate;
    if (this.spawnPhase >= 1) {
      this.spawnPhase -= 1;
      this.spawnGrain(smear);
    }

    let grainLeft = 0;
    let grainRight = 0;
    let windowSum = 0;
    for (let voice = 0; voice < GRAIN_COUNT; voice += 1) {
      const length = this.lengthFrames[voice] ?? 0;
      const age = this.ageFrames[voice] ?? 0;
      if (length < 2 || age >= length) continue;
      const windowPosition = (age / (length - 1)) * WINDOW_TABLE_SIZE;
      const tableIndex = Math.min(WINDOW_TABLE_SIZE - 1, Math.floor(windowPosition));
      const fraction = windowPosition - tableIndex;
      const envelope = (this.window[tableIndex] ?? 0)
        + (((this.window[tableIndex + 1] ?? 0) - (this.window[tableIndex] ?? 0)) * fraction);
      const position = this.readPositions[voice] ?? 0;
      const source = this.freezeActive ? this.frozenBank : this.writerBank;
      const sourceLeft = this.readSource(this.banks[source]![0], position);
      const sourceRight = this.readSource(this.banks[source]![1], position);
      grainLeft += sourceLeft * envelope;
      grainRight += sourceRight * envelope;
      windowSum += envelope;
      let next = position + (this.readSteps[voice] ?? 1);
      if (this.freezeActive) {
        const relative = this.wrap(next - this.frozenStart, this.frozenLength);
        next = this.frozenStart + relative;
      } else {
        next = this.wrap(next, this.maxCaptureFrames);
      }
      this.readPositions[voice] = next;
      this.ageFrames[voice] = age + 1;
    }
    if (windowSum > 1e-8) {
      grainLeft /= windowSum;
      grainRight /= windowSum;
    } else {
      grainLeft = 0;
      grainRight = 0;
    }

    this.processFdn(grainLeft, grainRight, feedback);
    this.wetLeft = finiteBounded(grainLeft + this.lastFdnLeft);
    this.wetRight = finiteBounded(grainRight + this.lastFdnRight);
    this.framesProcessed += 1;
  }

  processBlock(
    inputLeft: Float32Array,
    inputRight: Float32Array,
    outputLeft: Float32Array,
    outputRight: Float32Array,
  ): void {
    const frames = Math.min(inputLeft.length, inputRight.length, outputLeft.length, outputRight.length);
    for (let frame = 0; frame < frames; frame += 1) {
      this.processSample(inputLeft[frame] ?? 0, inputRight[frame] ?? 0);
      outputLeft[frame] = this.wetLeft;
      outputRight[frame] = this.wetRight;
    }
  }

  reset(): void {
    // Capture banks are large (up to 23.44 MiB together at 192 kHz). They do
    // not need clearing: validFrames and the grain-history gate below prevent
    // stale samples from being observed after a reset without a long RT fill.
    for (const line of this.fdnLines) line.fill(0);
    this.fdnWrite.fill(0);
    this.fdnDamping.fill(0);
    this.ageFrames.fill(0);
    this.lengthFrames.fill(0);
    this.readPositions.fill(0);
    this.readSteps.fill(0);
    this.current.set(this.target);
    this.writerBank = 0;
    this.writerPosition = 0;
    this.validFrames = 0;
    this.frozenBank = -1;
    this.frozenStart = 0;
    this.frozenLength = 0;
    this.freezePending = this.freezeRequested;
    this.freezeActive = false;
    this.spawnPhase = 1;
    this.nextVoice = 0;
    this.randomState = 0x57415250;
    this.lastFdnLeft = 0;
    this.lastFdnRight = 0;
    this.wetLeft = 0;
    this.wetRight = 0;
    this.framesProcessed = 0;
    this.captureCount = 0;
  }

  private captureFramesForCurrentTempo(): number {
    const framesPerBeat = this.sampleRate * 60 / clamp(this.current[BPM] ?? 120, MIN_BPM, MAX_BPM);
    return Math.max(32, Math.min(this.maxCaptureFrames, Math.round(framesPerBeat * (this.current[CAPTURE] ?? 1))));
  }

  private tryCapture(): void {
    const length = this.captureFramesForCurrentTempo();
    if (this.validFrames < length) return;
    this.frozenBank = this.writerBank;
    this.frozenLength = length;
    this.frozenStart = this.wrap(this.writerPosition - length, this.maxCaptureFrames);
    this.writerBank = 1 - this.frozenBank;
    this.writerPosition = 0;
    this.validFrames = 0;
    this.freezePending = false;
    this.freezeActive = true;
    this.captureCount += 1;
  }

  private releaseCapture(): void {
    this.freezePending = false;
    if (!this.freezeActive) return;
    this.freezeActive = false;
    this.writerBank = this.frozenBank < 0 ? this.writerBank : this.frozenBank;
    this.writerPosition = this.wrap(this.frozenStart + this.frozenLength, this.maxCaptureFrames);
    this.validFrames = this.frozenLength;
    this.frozenBank = -1;
    this.frozenLength = 0;
    this.ageFrames.fill(0);
  }

  private spawnGrain(smear: number): void {
    const voice = this.nextVoice;
    this.nextVoice = (voice + 1) % GRAIN_COUNT;
    this.lengthFrames[voice] = 0;
    this.ageFrames[voice] = 0;
    const beatFrames = this.sampleRate * 60 / clamp(this.current[BPM] ?? 120, MIN_BPM, MAX_BPM);
    const captureLength = this.freezeActive ? this.frozenLength : Math.max(32, this.validFrames);
    const length = Math.max(32, Math.min(
      Math.round(this.sampleRate * GRAIN_WINDOW_MS * 0.001),
      Math.round(beatFrames * (this.current[CAPTURE] ?? 0.5) / 4),
      captureLength,
    ));
    const pitchJitter = this.nextRandomSigned() * smear * 4;
    const pitch = clamp((this.current[PITCH] ?? 0) + pitchJitter, -24, 24);
    const step = 2 ** (pitch / 12);
    const jitterFrames = Math.round(smear * length * 0.25 * this.nextRandomSigned());
    let position: number;
    if (this.freezeActive && this.frozenLength > 0) {
      const offset = this.nextRandomUnit() * Math.max(1, this.frozenLength - length);
      position = this.frozenStart + offset + jitterFrames;
      position = this.frozenStart + this.wrap(position - this.frozenStart, this.frozenLength);
    } else {
      const age = Math.min(this.maxCaptureFrames - 4, Math.max(4, Math.ceil(length * Math.max(1, step)) + Math.abs(jitterFrames) + 4));
      // After reset, only launch from history written in the current epoch.
      if (this.validFrames < age) return;
      position = this.wrap(this.writerPosition - age + jitterFrames, this.maxCaptureFrames);
    }
    this.readPositions[voice] = position;
    this.readSteps[voice] = step;
    this.ageFrames[voice] = 0;
    this.lengthFrames[voice] = length;
  }

  private processFdn(inputLeft: number, inputRight: number, feedback: number): void {
    const scale = 0.3535533905932738;
    for (let lineIndex = 0; lineIndex < 8; lineIndex += 1) {
      const line = this.fdnLines[lineIndex]!;
      const index = this.fdnWrite[lineIndex] ?? 0;
      const delayed = line[index] ?? 0;
      const damped = (this.fdnDamping[lineIndex] ?? 0)
        + this.dampingAlpha * (delayed - (this.fdnDamping[lineIndex] ?? 0));
      this.fdnDamping[lineIndex] = Number.isFinite(damped) ? damped : 0;
      this.fdnRead[lineIndex] = this.fdnDamping[lineIndex] ?? 0;
    }
    for (let row = 0; row < 8; row += 1) {
      let sum = 0;
      for (let column = 0; column < 8; column += 1) {
        sum += (this.hadamard[(row * 8) + column] ?? 1) * (this.fdnRead[column] ?? 0);
      }
      this.fdnTransform[row] = sum * scale;
    }
    const feedbackGain = Math.min(MAX_FEEDBACK, feedback);
    for (let lineIndex = 0; lineIndex < 8; lineIndex += 1) {
      const line = this.fdnLines[lineIndex]!;
      const injection = lineIndex < 4 ? inputLeft * 0.25 : inputRight * 0.25;
      const value = finiteBounded(injection + (this.fdnTransform[lineIndex] ?? 0) * feedbackGain);
      const index = this.fdnWrite[lineIndex] ?? 0;
      line[index] = value;
      this.fdnWrite[lineIndex] = (index + 1) % line.length;
    }
    this.lastFdnLeft = finiteBounded(((this.fdnRead[0] ?? 0) + (this.fdnRead[1] ?? 0)
      + (this.fdnRead[2] ?? 0) + (this.fdnRead[3] ?? 0)) * 0.5);
    this.lastFdnRight = finiteBounded(((this.fdnRead[4] ?? 0) + (this.fdnRead[5] ?? 0)
      + (this.fdnRead[6] ?? 0) + (this.fdnRead[7] ?? 0)) * 0.5);
  }

  private readSource(buffer: Float32Array, position: number): number {
    const base = Math.floor(position);
    const fraction = position - base;
    const a = buffer[this.readIndex(base - 1, buffer.length)] ?? 0;
    const b = buffer[this.readIndex(base, buffer.length)] ?? 0;
    const c = buffer[this.readIndex(base + 1, buffer.length)] ?? 0;
    const d = buffer[this.readIndex(base + 2, buffer.length)] ?? 0;
    return b + (0.5 * fraction * (c - a))
      + (fraction * fraction * (a - (2.5 * b) + (2 * c) - (0.5 * d)))
      + (0.5 * fraction * fraction * fraction * (d - a + (3 * (b - c))));
  }

  private readIndex(index: number, capacity: number): number {
    let wrapped = this.wrap(index, capacity);
    if (this.freezeActive && this.frozenLength > 0) {
      wrapped = this.wrap(this.frozenStart + this.wrap(wrapped - this.frozenStart, this.frozenLength), capacity);
    }
    return wrapped;
  }

  private nextRandom(): number {
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return this.randomState;
  }

  private nextRandomUnit(): number { return this.nextRandom() / 0x1_0000_0000; }
  private nextRandomSigned(): number { return (this.nextRandomUnit() * 2) - 1; }

  private wrap(value: number, length: number): number {
    if (length <= 0) return 0;
    const wrapped = value % length;
    return wrapped < 0 ? wrapped + length : wrapped;
  }
}
