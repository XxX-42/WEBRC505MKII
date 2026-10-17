/**
 * Clean-room stereo granular delay for Browser FX #41.
 *
 * Each trigger captures a position in a fixed circular history and starts a
 * Hann-windowed, four-point Lagrange read. Sixteen fixed voices overlap; the
 * grain duration is bounded by both the user's size and the voice budget at
 * the requested density, so a high-density/long-grain combination cannot
 * allocate or steal a still-live voice. Position jitter is deterministic and
 * bounded to +/- 25% of the grain size. Pitch is resampled over the grain
 * lifetime. A contractive wet-feedback tap regenerates into the same history.
 *
 * All memory is allocated in the constructor. Callback processing uses only
 * bounded loops and fixed typed arrays, and is invariant to block boundaries.
 */

export interface BrowserGranularDelayParameters {
  /** Grain length in milliseconds, 10..1000. */
  grainSizeMs?: number;
  /** Grain starts per second, 1..80. */
  densityHz?: number;
  /** Resampling shift in semitones, -24..24. */
  pitchSemitones?: number;
  /** Position jitter, percent 0..100. */
  positionJitterPercent?: number;
  /** Regeneration, percent 0..95. */
  feedbackPercent?: number;
}

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;
const MIN_GRAIN_MS = 10;
const MAX_GRAIN_MS = 1000;
const MIN_DENSITY_HZ = 1;
const MAX_DENSITY_HZ = 80;
const MAX_PITCH_SEMITONES = 24;
const MAX_JITTER_FRACTION = 0.25;
const MAX_FEEDBACK_PERCENT = 95;
const FEEDBACK_STABILITY_SCALE = 0.75;
const MAX_SAMPLE_MAGNITUDE = 8;
const PARAMETER_SMOOTHING_SECONDS = 0.015;
const GRAIN_VOICE_COUNT = 16;
const WINDOW_TABLE_LENGTH = 2049;
const SAFE_READ_MARGIN_SAMPLES = 4;
const TWO_PI = Math.PI * 2;

const GRAIN_SIZE = 0;
const DENSITY = 1;
const PITCH = 2;
const JITTER = 3;
const FEEDBACK = 4;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteBounded(value: number, maximumMagnitude = MAX_SAMPLE_MAGNITUDE): number {
  return Number.isFinite(value) ? clamp(value, -maximumMagnitude, maximumMagnitude) : 0;
}

function positiveModulo(value: number, modulus: number): number {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
}

/** Four-point Lagrange interpolation at an absolute fractional history index. */
function readLagrange(buffer: Float32Array, position: number): number {
  const whole = Math.floor(position);
  const fraction = position - whole;
  const fMinusOne = fraction - 1;
  const fMinusTwo = fraction - 2;
  const fPlusOne = fraction + 1;
  const coefficientMinusOne = -(fraction * fMinusOne * fMinusTwo) / 6;
  const coefficientZero = (fPlusOne * fMinusOne * fMinusTwo) / 2;
  const coefficientPlusOne = -(fPlusOne * fraction * fMinusTwo) / 2;
  const coefficientPlusTwo = (fPlusOne * fraction * fMinusOne) / 6;
  const length = buffer.length;
  const minusOne = buffer[positiveModulo(whole - 1, length)] ?? 0;
  const zero = buffer[positiveModulo(whole, length)] ?? 0;
  const plusOne = buffer[positiveModulo(whole + 1, length)] ?? 0;
  const plusTwo = buffer[positiveModulo(whole + 2, length)] ?? 0;
  return coefficientMinusOne * minusOne
    + coefficientZero * zero
    + coefficientPlusOne * plusOne
    + coefficientPlusTwo * plusTwo;
}

/** Fixed-storage, sample-clock granular processor with synchronized stereo grains. */
export class BrowserGranularDelayDsp {
  readonly sampleRate: number;
  private readonly buffers: readonly [Float32Array, Float32Array];
  private readonly windowTable: Float32Array;
  private readonly ageFrames = new Int32Array(GRAIN_VOICE_COUNT);
  private readonly lengthFrames = new Int32Array(GRAIN_VOICE_COUNT);
  private readonly sourcePositions = new Float64Array(GRAIN_VOICE_COUNT);
  private readonly playbackRates = new Float64Array(GRAIN_VOICE_COUNT);
  private readonly current = new Float64Array(5);
  private readonly target = new Float64Array(5);
  private readonly smoothingCoefficient: number;
  private frameCounter = 0;
  private spawnPhase = 1;
  private nextVoice = 0;
  private randomState = 0x6d2b79f5;
  private lastWetLeft = 0;
  private lastWetRight = 0;

  constructor(sampleRate = 48000, parameters: BrowserGranularDelayParameters = {}) {
    this.sampleRate = Number.isFinite(sampleRate)
      ? clamp(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE)
      : 48000;

    // Full-scale pitch range uses at most 4.5 seconds of historical audio
    // (4x pitch span plus the maximum symmetric jitter range).
    const historyCapacity = Math.ceil(4500 * this.sampleRate / 1000) + 16;
    this.buffers = [new Float32Array(historyCapacity), new Float32Array(historyCapacity)];
    this.windowTable = new Float32Array(WINDOW_TABLE_LENGTH);
    for (let index = 0; index < WINDOW_TABLE_LENGTH; index += 1) {
      const phase = index / (WINDOW_TABLE_LENGTH - 1);
      this.windowTable[index] = 0.5 - 0.5 * Math.cos(TWO_PI * phase);
    }
    this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS * this.sampleRate));

    const grainSizeMs = Number.isFinite(parameters.grainSizeMs)
      ? clamp(parameters.grainSizeMs as number, MIN_GRAIN_MS, MAX_GRAIN_MS)
      : 120;
    const densityHz = Number.isFinite(parameters.densityHz)
      ? clamp(parameters.densityHz as number, MIN_DENSITY_HZ, MAX_DENSITY_HZ)
      : 12;
    const pitchSemitones = Number.isFinite(parameters.pitchSemitones)
      ? clamp(parameters.pitchSemitones as number, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES)
      : 0;
    const positionJitterPercent = Number.isFinite(parameters.positionJitterPercent)
      ? clamp(parameters.positionJitterPercent as number, 0, 100)
      : 15;
    const feedbackPercent = Number.isFinite(parameters.feedbackPercent)
      ? clamp(parameters.feedbackPercent as number, 0, MAX_FEEDBACK_PERCENT)
      : 15;

    this.current[GRAIN_SIZE] = this.target[GRAIN_SIZE] = grainSizeMs;
    this.current[DENSITY] = this.target[DENSITY] = densityHz;
    this.current[PITCH] = this.target[PITCH] = pitchSemitones;
    this.current[JITTER] = this.target[JITTER] = positionJitterPercent;
    this.current[FEEDBACK] = this.target[FEEDBACK] = feedbackPercent;
  }

  /** Change grain controls with short smoothing; invalid controls are ignored. */
  setParameters(parameters: BrowserGranularDelayParameters): void {
    if (Number.isFinite(parameters.grainSizeMs)) this.target[GRAIN_SIZE] = clamp(parameters.grainSizeMs as number, MIN_GRAIN_MS, MAX_GRAIN_MS);
    if (Number.isFinite(parameters.densityHz)) this.target[DENSITY] = clamp(parameters.densityHz as number, MIN_DENSITY_HZ, MAX_DENSITY_HZ);
    if (Number.isFinite(parameters.pitchSemitones)) this.target[PITCH] = clamp(parameters.pitchSemitones as number, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES);
    if (Number.isFinite(parameters.positionJitterPercent)) this.target[JITTER] = clamp(parameters.positionJitterPercent as number, 0, 100);
    if (Number.isFinite(parameters.feedbackPercent)) this.target[FEEDBACK] = clamp(parameters.feedbackPercent as number, 0, MAX_FEEDBACK_PERCENT);
  }

  /** Clear all grain/history state and reset deterministic trigger scheduling. */
  reset(): void {
    this.buffers[0].fill(0);
    this.buffers[1].fill(0);
    this.ageFrames.fill(0);
    this.lengthFrames.fill(0);
    this.sourcePositions.fill(0);
    this.playbackRates.fill(0);
    this.frameCounter = 0;
    this.spawnPhase = 1;
    this.nextVoice = 0;
    this.randomState = 0x6d2b79f5;
    this.lastWetLeft = 0;
    this.lastWetRight = 0;
    for (let index = 0; index < this.current.length; index += 1) this.current[index] = this.target[index] ?? 0;
  }

  /** Process one stereo frame; output is read from wetOutputLeft/Right. */
  processSample(inputLeft: number, inputRight: number): void {
    this.current[GRAIN_SIZE] = (this.current[GRAIN_SIZE] ?? 120) + this.smoothingCoefficient * ((this.target[GRAIN_SIZE] ?? 120) - (this.current[GRAIN_SIZE] ?? 120));
    this.current[DENSITY] = (this.current[DENSITY] ?? 12) + this.smoothingCoefficient * ((this.target[DENSITY] ?? 12) - (this.current[DENSITY] ?? 12));
    this.current[PITCH] = (this.current[PITCH] ?? 0) + this.smoothingCoefficient * ((this.target[PITCH] ?? 0) - (this.current[PITCH] ?? 0));
    this.current[JITTER] = (this.current[JITTER] ?? 0) + this.smoothingCoefficient * ((this.target[JITTER] ?? 0) - (this.current[JITTER] ?? 0));
    this.current[FEEDBACK] = (this.current[FEEDBACK] ?? 0) + this.smoothingCoefficient * ((this.target[FEEDBACK] ?? 0) - (this.current[FEEDBACK] ?? 0));

    const dryLeft = finiteBounded(inputLeft);
    const dryRight = finiteBounded(inputRight);
    const historyIndex = this.frameCounter % this.buffers[0].length;
    const regeneration = (this.current[FEEDBACK] ?? 0) * 0.01 * FEEDBACK_STABILITY_SCALE;
    this.buffers[0][historyIndex] = finiteBounded(dryLeft + regeneration * this.lastWetLeft);
    this.buffers[1][historyIndex] = finiteBounded(dryRight + regeneration * this.lastWetRight);

    const densityHz = clamp(this.current[DENSITY] ?? 12, MIN_DENSITY_HZ, MAX_DENSITY_HZ);
    this.spawnPhase += densityHz / this.sampleRate;
    if (this.spawnPhase >= 1) {
      this.spawnPhase -= 1;
      this.startGrain();
    }

    let wetLeftSum = 0;
    let wetRightSum = 0;
    let windowSum = 0;
    for (let voice = 0; voice < GRAIN_VOICE_COUNT; voice += 1) {
      const age = this.ageFrames[voice] ?? 0;
      const length = this.lengthFrames[voice] ?? 0;
      if (length < 2 || age >= length) continue;

      const windowPosition = (age / (length - 1)) * (WINDOW_TABLE_LENGTH - 1);
      const tableIndex = Math.min(WINDOW_TABLE_LENGTH - 2, Math.floor(windowPosition));
      const fraction = windowPosition - tableIndex;
      const windowStart = this.windowTable[tableIndex] ?? 0;
      const windowEnd = this.windowTable[tableIndex + 1] ?? 0;
      const window = windowStart + (windowEnd - windowStart) * fraction;
      const sourcePosition = this.sourcePositions[voice] ?? 0;
      wetLeftSum += readLagrange(this.buffers[0], sourcePosition) * window;
      wetRightSum += readLagrange(this.buffers[1], sourcePosition) * window;
      windowSum += window;
      this.sourcePositions[voice] = sourcePosition + (this.playbackRates[voice] ?? 1);
      this.ageFrames[voice] = age + 1;
    }

    const normalization = windowSum > 1e-6 ? 1 / windowSum : 0;
    this.lastWetLeft = finiteBounded(wetLeftSum * normalization);
    this.lastWetRight = finiteBounded(wetRightSum * normalization);
    this.frameCounter += 1;
  }

  /** Process planar arrays without a fixed quantum or callback allocation. */
  processBlock(
    inputLeft: Float32Array,
    inputRight: Float32Array | null,
    outputLeft: Float32Array,
    outputRight: Float32Array | null,
    frameCount?: number,
  ): void {
    let frames = Math.min(inputLeft.length, outputLeft.length);
    if (inputRight !== null) frames = Math.min(frames, inputRight.length);
    if (outputRight !== null) frames = Math.min(frames, outputRight.length);
    if (frameCount !== undefined && Number.isFinite(frameCount)) {
      frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));
    }

    for (let frame = 0; frame < frames; frame += 1) {
      const inputL = inputLeft[frame] ?? 0;
      const inputR = inputRight === null ? inputL : inputRight[frame] ?? 0;
      this.processSample(inputL, inputR);
      if (frame < outputLeft.length) outputLeft[frame] = this.lastWetLeft;
      if (outputRight !== null && frame < outputRight.length) outputRight[frame] = this.lastWetRight;
    }
  }

  get wetOutputLeft(): number {
    return this.lastWetLeft;
  }

  get wetOutputRight(): number {
    return this.lastWetRight;
  }

  private startGrain(): void {
    const voice = this.nextVoice;
    this.nextVoice = voice + 1 >= GRAIN_VOICE_COUNT ? 0 : voice + 1;

    const requestedLength = Math.max(2, Math.round((this.current[GRAIN_SIZE] ?? 120) * this.sampleRate * 0.001));
    const densityHz = clamp(this.current[DENSITY] ?? 12, MIN_DENSITY_HZ, MAX_DENSITY_HZ);
    const periodFrames = this.sampleRate / densityHz;
    // The fixed voice budget remains safe even at maximum density. The user's
    // duration is honored until it would require more than sixteen overlaps.
    const maxLengthForVoiceBudget = Math.max(2, Math.floor(periodFrames * GRAIN_VOICE_COUNT) - 1);
    const length = Math.min(requestedLength, maxLengthForVoiceBudget);
    const pitch = clamp(this.current[PITCH] ?? 0, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES);
    const playbackRate = Math.pow(2, pitch / 12);
    const jitter = (clamp(this.current[JITTER] ?? 0, 0, 100) * 0.01) * MAX_JITTER_FRACTION * length;
    // Center the random offset around the minimum safe source age, leaving a
    // four-sample read margin at the end of upward-pitched grains.
    const sourceAge = Math.max(1, playbackRate) * length + jitter + SAFE_READ_MARGIN_SAMPLES;
    const jitterOffset = (this.nextRandom() * 2 - 1) * jitter;

    this.ageFrames[voice] = 0;
    this.lengthFrames[voice] = length;
    this.sourcePositions[voice] = this.frameCounter - sourceAge + jitterOffset;
    this.playbackRates[voice] = playbackRate;
  }

  private nextRandom(): number {
    let state = this.randomState;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.randomState = state >>> 0;
    return this.randomState / 0x100000000;
  }
}
