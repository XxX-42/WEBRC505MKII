/**
 * A small, standalone real-time monophonic pitch detector and PSOLA shifter.
 *
 * This clean-room LIVE_MONO processor is wired through `liveMonoWorklet.ts` and
 * `liveMonoNode.ts` into Browser `TrackAudio`, and is also reused by the
 * experimental ROBOT worklet. It uses YIN on a boxcar-decimated analysis
 * stream, then pitch-synchronous overlap-add with delayed input, fixed-size
 * rings, and caller-owned input/output buffers. `process()` is sample-streaming,
 * so callers may pass arbitrary block sizes. The route is implemented, but its
 * full perceptual-quality and end-to-end latency acceptance gates remain open.
 */

export interface YinPitchDetectorOptions {
  readonly minimumFrequencyHz?: number;
  readonly maximumFrequencyHz?: number;
  readonly threshold?: number;
  readonly hopSamples?: number;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function finiteInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * YIN F0 tracker for one (already decimated) mono stream.
 *
 * It stores one analysis frame in a power-of-two ring, calculates the squared
 * difference function and cumulative-mean-normalized difference function, and
 * uses the first thresholded local minimum with parabolic lag refinement.
 * Calls to `pushSample` allocate no objects or arrays.
 */
export class YinPitchDetector {
  readonly sampleRate: number;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
  readonly frameSamples: number;
  readonly hopSamples: number;

  private readonly ring: Float32Array;
  private readonly differences: Float64Array;
  private readonly normalizedDifferences: Float64Array;
  private readonly ringMask: number;
  private readonly minimumLag: number;
  private readonly maximumLag: number;
  private readonly threshold: number;
  private readonly analysisWindowSamples: number;
  private writeIndex = 0;
  private sampleCount = 0;
  private nextAnalysisSample: number;
  private currentFrequencyHz = 0;
  private currentConfidence = 0;
  private currentVoiced = false;
  private currentEstimateTimeSamples = 0;
  private analysisSerialValue = 0;
  private goodFrames = 0;
  private badFrames = 0;
  private smoothedLogFrequency = 0;

  constructor(sampleRate: number, options: YinPitchDetectorOptions = {}) {
    if (!finiteInRange(sampleRate, 2_000, 48_000)) {
      throw new RangeError('YIN analysis sample rate must be from 2 kHz through 48 kHz');
    }
    const minimumFrequencyHz = options.minimumFrequencyHz ?? 70;
    const maximumFrequencyHz = options.maximumFrequencyHz ?? 1_200;
    if (
      !finiteInRange(minimumFrequencyHz, 20, sampleRate / 2) ||
      !finiteInRange(maximumFrequencyHz, minimumFrequencyHz + 1, sampleRate / 2)
    ) {
      throw new RangeError('YIN frequency bounds must be finite, ordered and below Nyquist');
    }
    const threshold = options.threshold ?? 0.16;
    if (!finiteInRange(threshold, 0.03, 0.4)) {
      throw new RangeError('YIN threshold must be between 0.03 and 0.4');
    }

    this.sampleRate = sampleRate;
    this.minimumFrequencyHz = minimumFrequencyHz;
    this.maximumFrequencyHz = maximumFrequencyHz;
    this.threshold = threshold;
    this.minimumLag = Math.max(2, Math.floor(sampleRate / maximumFrequencyHz));
    this.maximumLag = Math.ceil(sampleRate / minimumFrequencyHz);
    this.frameSamples = Math.max(64, this.maximumLag * 3);
    this.hopSamples = options.hopSamples ?? Math.max(1, Math.round(sampleRate * 0.005));
    if (!Number.isInteger(this.hopSamples) || this.hopSamples < 1 || this.hopSamples > this.frameSamples) {
      throw new RangeError('YIN hop must be an integer from 1 through the analysis frame length');
    }

    this.analysisWindowSamples = this.frameSamples - this.maximumLag;
    const ringLength = nextPowerOfTwo(this.frameSamples * 2);
    this.ring = new Float32Array(ringLength);
    this.differences = new Float64Array(this.maximumLag + 1);
    this.normalizedDifferences = new Float64Array(this.maximumLag + 1);
    this.ringMask = ringLength - 1;
    this.nextAnalysisSample = this.frameSamples;
  }

  /** Most recent refined F0 estimate, or 0 while unvoiced. */
  get frequencyHz(): number {
    return this.currentVoiced ? this.currentFrequencyHz : 0;
  }

  /** YIN periodicity confidence in [0, 1]. */
  get confidence(): number {
    return this.currentConfidence;
  }

  /** Whether the tracker has met its voiced threshold and two-frame hysteresis. */
  get voiced(): boolean {
    return this.currentVoiced;
  }

  /** Approximate frame-center time, in samples from the first pushed sample. */
  get estimateTimeSamples(): number {
    return this.currentEstimateTimeSamples;
  }

  /** Increments once per completed YIN analysis, for allocation-free polling. */
  get analysisSerial(): number {
    return this.analysisSerialValue;
  }

  /** Push one decimated sample. This method is safe for a real-time callback. */
  pushSample(sample: number): void {
    this.ring[this.writeIndex] = Number.isFinite(sample) ? sample : 0;
    this.writeIndex = (this.writeIndex + 1) & this.ringMask;
    this.sampleCount += 1;
    if (this.sampleCount < this.nextAnalysisSample) return;

    this.analyzeFrame();
    this.nextAnalysisSample += this.hopSamples;
  }

  private analyzeFrame(): void {
    let frameStart = this.writeIndex - this.frameSamples;
    if (frameStart < 0) frameStart += this.ring.length;

    let energy = 0;
    for (let i = 0; i < this.frameSamples; i += 1) {
      let index = frameStart + i;
      if (index >= this.ring.length) index -= this.ring.length;
      const sample = this.ring[index]!;
      energy += sample * sample;
    }
    const rms = Math.sqrt(energy / this.frameSamples);

    this.differences[0] = 0;
    for (let lag = 1; lag <= this.maximumLag; lag += 1) {
      let sum = 0;
      for (let i = 0; i < this.analysisWindowSamples; i += 1) {
        let firstIndex = frameStart + i;
        if (firstIndex >= this.ring.length) firstIndex -= this.ring.length;
        let secondIndex = firstIndex + lag;
        if (secondIndex >= this.ring.length) secondIndex -= this.ring.length;
        const delta = this.ring[firstIndex]! - this.ring[secondIndex]!;
        sum += delta * delta;
      }
      this.differences[lag] = sum;
    }

    let cumulativeDifference = 0;
    for (let lag = 1; lag <= this.maximumLag; lag += 1) {
      const difference = this.differences[lag]!;
      cumulativeDifference += difference;
      this.normalizedDifferences[lag] = cumulativeDifference > 1e-15
        ? (difference * lag) / cumulativeDifference
        : 1;
    }

    let bestLag = 0;
    let bestValue = Number.POSITIVE_INFINITY;
    const activeThreshold = this.currentVoiced ? Math.min(0.28, this.threshold + 0.05) : this.threshold;
    for (let lag = this.minimumLag; lag <= this.maximumLag; lag += 1) {
      const value = this.normalizedDifferences[lag]!;
      if (value < bestValue) {
        bestValue = value;
        bestLag = lag;
      }
      if (
        value < activeThreshold &&
        (lag === this.maximumLag || value <= this.normalizedDifferences[lag + 1]!)
      ) {
        bestLag = lag;
        while (
          bestLag < this.maximumLag &&
          this.normalizedDifferences[bestLag + 1]! < this.normalizedDifferences[bestLag]!
        ) {
          bestLag += 1;
        }
        bestValue = this.normalizedDifferences[bestLag]!;
        break;
      }
    }

    this.currentEstimateTimeSamples = this.sampleCount - (this.frameSamples / 2) - 0.5;
    this.currentConfidence = Number.isFinite(bestValue)
      ? Math.max(0, Math.min(1, 1 - bestValue))
      : 0;

    const candidate = rms >= 1e-4 && bestLag > 0 && bestValue < activeThreshold;
    if (candidate) {
      this.goodFrames += 1;
      this.badFrames = 0;
      let refinedLag = bestLag;
      if (bestLag > this.minimumLag && bestLag < this.maximumLag) {
        const left = this.normalizedDifferences[bestLag - 1]!;
        const center = this.normalizedDifferences[bestLag]!;
        const right = this.normalizedDifferences[bestLag + 1]!;
        const denominator = left - 2 * center + right;
        if (Math.abs(denominator) > 1e-12) {
          refinedLag += Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
        }
      }
      const measuredHz = this.sampleRate / refinedLag;
      if (this.goodFrames === 1 || this.currentFrequencyHz <= 0) {
        this.smoothedLogFrequency = Math.log(measuredHz);
      } else {
        const measuredLogFrequency = Math.log(measuredHz);
        this.smoothedLogFrequency += (measuredLogFrequency - this.smoothedLogFrequency) * 0.35;
      }
      this.currentFrequencyHz = Math.exp(this.smoothedLogFrequency);
      if (this.goodFrames >= 2) this.currentVoiced = true;
    } else {
      this.goodFrames = 0;
      this.badFrames += 1;
      if (this.badFrames >= 2) this.currentVoiced = false;
    }
    this.analysisSerialValue += 1;
  }
}

export interface LiveMonoPitchProcessorOptions {
  readonly sampleRate: number;
  readonly semitones?: number;
  readonly minimumFrequencyHz?: number;
  readonly maximumFrequencyHz?: number;
}

/**
 * Returns the exact fixed latency used by `LiveMonoPitchProcessor` without
 * constructing its signal-history buffers. This lets a main-thread node
 * factory expose the delay before the worklet has rendered its first quantum.
 */
export function getLiveMonoPitchLatencySamples(
  sampleRate: number,
  minimumFrequencyHz = 70,
): number {
  if (!finiteInRange(sampleRate, 8_000, 192_000)) {
    throw new RangeError('sampleRate must be from 8 kHz through 192 kHz');
  }
  const decimation = Math.max(1, Math.ceil(sampleRate / 12_000));
  const detectorRate = sampleRate / decimation;
  if (!finiteInRange(minimumFrequencyHz, 20, detectorRate / 2)) {
    throw new RangeError('minimum F0 must be finite and below the decimated Nyquist rate');
  }

  const maximumLag = Math.ceil(detectorRate / minimumFrequencyHz);
  const frameSamples = Math.max(64, maximumLag * 3);
  const detectorHopSamples = Math.max(1, Math.round(detectorRate * 0.005));
  const maximumPeriodSamples = Math.ceil(sampleRate / minimumFrequencyHz);
  const maximumSearchRadius = Math.ceil(maximumPeriodSamples / 2);
  const detectorDelayRawSamples = Math.ceil(
    (frameSamples / 2 + detectorHopSamples * 2 + 2) * decimation,
  );
  const generationDelaySamples = Math.max(
    detectorDelayRawSamples,
    maximumPeriodSamples + maximumSearchRadius,
  );
  return generationDelaySamples + maximumPeriodSamples;
}

/**
 * Fixed-latency, mono PSOLA pitch shifter for continuous real-time processing.
 *
 * Processing uses no heap allocations: all signal/history storage is allocated
 * once in the constructor. The implementation is bounded to a +/-12-semitone
 * range and a configured F0 interval. It is optimized for sustained monophonic
 * sources; noise/unvoiced regions pass through the same explicit delay, and a
 * short transient detector gives attacks an unshifted delayed path.
 */
export class LiveMonoPitchProcessor {
  readonly sampleRate: number;
  readonly latencySamples: number;
  readonly latencySeconds: number;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
  /** Fixed input/transient/OLA ring slots; independent of callback block size. */
  readonly bufferCapacitySamples: number;

  private readonly detector: YinPitchDetector;
  private readonly decimation: number;
  private readonly detectorHopRawSamples: number;
  private readonly detectorDelayRawSamples: number;
  private readonly maximumPeriodSamples: number;
  private readonly maximumSearchRadius: number;
  private readonly generationDelaySamples: number;
  private readonly inputRing: Float32Array;
  private readonly transientRing: Uint8Array;
  private readonly outputSumRing: Float64Array;
  private readonly outputWeightRing: Float64Array;
  private readonly pitchTimes: Float64Array;
  private readonly pitchFrequencies: Float32Array;
  private readonly pitchConfidences: Float32Array;
  private readonly pitchVoiced: Uint8Array;
  private readonly pitchHistoryMask: number;
  private readonly transientHoldSamples: number;
  private readonly mixSmoothing: number;
  private readonly ratioSmoothing: number;

  private inputSampleCursor = 0;
  private decimatorCount = 0;
  private decimatorSum = 0;
  private detectorSerial = 0;
  private pitchHistoryWrite = 0;
  private pitchHistoryCount = 0;
  private latestPitchHistoryIndex = -1;
  private latestPitchTime = 0;
  private nextSynthesisCenter = 0;
  private currentRatio: number;
  private targetRatio: number;
  private targetSemitones: number;
  private outputMix = 0;
  private previousInput = 0;
  private derivativeEnvelope = 0;
  private transientCountdown = 0;
  private lookupFrequency = 0;
  private lookupConfidence = 0;
  private lookupVoiced = false;

  constructor(options: LiveMonoPitchProcessorOptions) {
    const sampleRate = options.sampleRate;
    if (!finiteInRange(sampleRate, 8_000, 192_000)) {
      throw new RangeError('sampleRate must be from 8 kHz through 192 kHz');
    }
    const minimumFrequencyHz = options.minimumFrequencyHz ?? 70;
    const maximumFrequencyHz = options.maximumFrequencyHz ?? 1_200;
    const decimation = Math.max(1, Math.ceil(sampleRate / 12_000));
    const detectorRate = sampleRate / decimation;
    if (
      !finiteInRange(minimumFrequencyHz, 20, detectorRate / 2) ||
      !finiteInRange(maximumFrequencyHz, minimumFrequencyHz + 1, detectorRate / 2)
    ) {
      throw new RangeError('F0 limits must be finite, ordered and below the decimated Nyquist rate');
    }
    const semitones = options.semitones ?? 0;
    if (!finiteInRange(semitones, -12, 12)) {
      throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
    }

    this.sampleRate = sampleRate;
    this.minimumFrequencyHz = minimumFrequencyHz;
    this.maximumFrequencyHz = maximumFrequencyHz;
    this.decimation = decimation;
    const detectorHopSamples = Math.max(1, Math.round(detectorRate * 0.005));
    this.detectorHopRawSamples = detectorHopSamples * decimation;
    this.detector = new YinPitchDetector(detectorRate, {
      minimumFrequencyHz,
      maximumFrequencyHz,
      hopSamples: detectorHopSamples,
    });

    this.maximumPeriodSamples = Math.ceil(sampleRate / minimumFrequencyHz);
    this.maximumSearchRadius = Math.ceil(this.maximumPeriodSamples / 2);
    this.detectorDelayRawSamples = Math.ceil(
      (this.detector.frameSamples / 2 + detectorHopSamples * 2 + 2) * decimation,
    );
    this.generationDelaySamples = Math.max(
      this.detectorDelayRawSamples,
      this.maximumPeriodSamples + this.maximumSearchRadius,
    );
    this.latencySamples = this.generationDelaySamples + this.maximumPeriodSamples;
    this.latencySeconds = this.latencySamples / sampleRate;

    const inputCapacity = nextPowerOfTwo(this.latencySamples + this.detector.frameSamples * decimation + 16);
    const outputCapacity = nextPowerOfTwo(this.maximumPeriodSamples * 2 + 16);
    this.inputRing = new Float32Array(inputCapacity);
    this.transientRing = new Uint8Array(inputCapacity);
    this.outputSumRing = new Float64Array(outputCapacity);
    this.outputWeightRing = new Float64Array(outputCapacity);
    this.bufferCapacitySamples = inputCapacity * 2 + outputCapacity * 2;

    const pitchHistoryLength = nextPowerOfTwo(
      Math.ceil((this.latencySamples + this.detectorDelayRawSamples) / this.detectorHopRawSamples) + 16,
    );
    this.pitchTimes = new Float64Array(pitchHistoryLength);
    this.pitchFrequencies = new Float32Array(pitchHistoryLength);
    this.pitchConfidences = new Float32Array(pitchHistoryLength);
    this.pitchVoiced = new Uint8Array(pitchHistoryLength);
    this.pitchHistoryMask = pitchHistoryLength - 1;

    this.transientHoldSamples = Math.max(1, Math.round(sampleRate * 0.012));
    this.mixSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.008));
    this.ratioSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.012));
    this.targetSemitones = semitones;
    this.targetRatio = 2 ** (semitones / 12);
    this.currentRatio = this.targetRatio;
    this.nextSynthesisCenter = this.latencySamples;
  }

  /** Current requested transpose in semitones. */
  get semitones(): number {
    return this.targetSemitones;
  }

  /** Most recent YIN voicing decision, suitable for request-driven status reports. */
  get voiced(): boolean {
    return this.detector.voiced;
  }

  /** Most recent YIN F0 estimate in hertz, or 0 while unvoiced. */
  get frequencyHz(): number {
    return this.detector.frequencyHz;
  }

  /** Most recent YIN periodicity confidence in [0, 1]. */
  get confidence(): number {
    return this.detector.confidence;
  }

  /** Change the transpose target. The ratio slews over about 12 ms. */
  setSemitones(semitones: number): void {
    if (!finiteInRange(semitones, -12, 12)) {
      throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
    }
    this.targetSemitones = semitones;
    this.targetRatio = 2 ** (semitones / 12);
  }

  /**
   * Process one mono block into a caller-owned output block.
   *
   * `frameCount`, `inputOffset`, and `outputOffset` permit arbitrary block sizes
   * and non-zero offsets without creating subarrays or temporary buffers. To
   * drain a finite input, keep processing zeroes for at least the reported
   * latency plus one maximum period so pending grains can reach the output.
   */
  process(
    input: Float32Array,
    output: Float32Array,
    frameCount = input.length,
    inputOffset = 0,
    outputOffset = 0,
  ): void {
    if (
      !Number.isInteger(frameCount) || frameCount < 0 ||
      !Number.isInteger(inputOffset) || inputOffset < 0 || inputOffset + frameCount > input.length ||
      !Number.isInteger(outputOffset) || outputOffset < 0 || outputOffset + frameCount > output.length
    ) {
      throw new RangeError('LIVE_MONO block ranges must fit the supplied input and output buffers');
    }

    for (let frame = 0; frame < frameCount; frame += 1) {
      const absoluteSample = this.inputSampleCursor;
      const inputSample = Number.isFinite(input[inputOffset + frame]!) ? input[inputOffset + frame]! : 0;
      const inputIndex = absoluteSample % this.inputRing.length;
      this.inputRing[inputIndex] = inputSample;

      const difference = inputSample - this.previousInput;
      const absoluteDifference = Math.abs(difference);
      this.derivativeEnvelope += (absoluteDifference - this.derivativeEnvelope) * 0.025;
      const transientThreshold = Math.max(0.08, this.derivativeEnvelope * 4.5);
      if (absoluteDifference > transientThreshold) this.transientCountdown = this.transientHoldSamples;
      else if (this.transientCountdown > 0) this.transientCountdown -= 1;
      this.transientRing[inputIndex] = this.transientCountdown > 0 ? 1 : 0;
      this.previousInput = inputSample;

      this.decimatorSum += inputSample;
      this.decimatorCount += 1;
      if (this.decimatorCount >= this.decimation) {
        this.detector.pushSample(this.decimatorSum / this.decimation);
        this.decimatorCount = 0;
        this.decimatorSum = 0;
        if (this.detector.analysisSerial !== this.detectorSerial) {
          this.detectorSerial = this.detector.analysisSerial;
          this.storePitchEstimate(this.detector.estimateTimeSamples * this.decimation);
        }
      }

      this.currentRatio += (this.targetRatio - this.currentRatio) * this.ratioSmoothing;
      const latestSafeCenter = absoluteSample + this.latencySamples - this.generationDelaySamples;
      while (this.nextSynthesisCenter <= latestSafeCenter) {
        this.synthesizePitchGrain(this.nextSynthesisCenter);
      }

      const delayedSample = absoluteSample - this.latencySamples;
      const delayedInput = delayedSample >= 0
        ? this.inputRing[delayedSample % this.inputRing.length]!
        : 0;
      let desiredMix = 0;
      if (
        this.targetSemitones !== 0 &&
        this.lookupPitch(delayedSample) &&
        this.lookupVoiced &&
        this.lookupConfidence >= 0.55
      ) desiredMix = 1;

      const delayedTransient = delayedSample >= 0
        ? this.transientRing[delayedSample % this.transientRing.length] !== 0
        : false;
      const outputIndex = absoluteSample % this.outputSumRing.length;
      const accumulatedWeight = this.outputWeightRing[outputIndex]!;
      const shiftedAvailable = accumulatedWeight > 1e-8;
      const shiftedSample = shiftedAvailable
        ? this.outputSumRing[outputIndex]! / accumulatedWeight
        : delayedInput;
      if (delayedTransient) {
        this.outputMix = 0;
        output[outputOffset + frame] = delayedInput;
      } else {
        this.outputMix += (desiredMix - this.outputMix) * this.mixSmoothing;
        output[outputOffset + frame] = delayedInput + (shiftedSample - delayedInput) * this.outputMix;
      }
      this.outputSumRing[outputIndex] = 0;
      this.outputWeightRing[outputIndex] = 0;
      this.inputSampleCursor += 1;
    }
  }

  private storePitchEstimate(estimateTimeSamples: number): void {
    const index = this.pitchHistoryWrite;
    this.pitchTimes[index] = estimateTimeSamples;
    this.pitchFrequencies[index] = this.detector.frequencyHz;
    this.pitchConfidences[index] = this.detector.confidence;
    this.pitchVoiced[index] = this.detector.voiced ? 1 : 0;
    this.latestPitchHistoryIndex = index;
    this.latestPitchTime = estimateTimeSamples;
    this.pitchHistoryWrite = (index + 1) & this.pitchHistoryMask;
    if (this.pitchHistoryCount < this.pitchTimes.length) this.pitchHistoryCount += 1;
  }

  /** Writes the requested time's nearest pitch estimate into scalar scratch fields. */
  private lookupPitch(timeSamples: number): boolean {
    if (timeSamples < 0 || this.pitchHistoryCount === 0 || this.latestPitchHistoryIndex < 0) {
      this.lookupFrequency = 0;
      this.lookupConfidence = 0;
      this.lookupVoiced = false;
      return false;
    }
    const delta = this.latestPitchTime - timeSamples;
    if (delta < -this.detectorHopRawSamples || delta > this.detectorHopRawSamples * (this.pitchHistoryCount - 1)) {
      this.lookupFrequency = 0;
      this.lookupConfidence = 0;
      this.lookupVoiced = false;
      return false;
    }
    const lag = Math.max(0, Math.round(delta / this.detectorHopRawSamples));
    if (lag >= this.pitchHistoryCount) {
      this.lookupFrequency = 0;
      this.lookupConfidence = 0;
      this.lookupVoiced = false;
      return false;
    }
    const index = (this.latestPitchHistoryIndex - lag) & this.pitchHistoryMask;
    this.lookupFrequency = this.pitchFrequencies[index]!;
    this.lookupConfidence = this.pitchConfidences[index]!;
    this.lookupVoiced = this.pitchVoiced[index] !== 0;
    return true;
  }

  private synthesizePitchGrain(outputCenter: number): void {
    const sourceTime = outputCenter - this.latencySamples;
    if (
      !this.lookupPitch(sourceTime) ||
      !this.lookupVoiced ||
      this.lookupConfidence < 0.55 ||
      this.lookupFrequency <= 0
    ) {
      this.nextSynthesisCenter += this.detectorHopRawSamples;
      return;
    }

    const period = Math.max(
      1,
      Math.min(this.maximumPeriodSamples, this.sampleRate / this.lookupFrequency),
    );
    const radius = Math.max(2, Math.min(this.maximumPeriodSamples, Math.round(period)));
    const searchRadius = Math.min(this.maximumSearchRadius, Math.max(1, Math.floor(period / 2)));
    const sourceCenter = Math.round(sourceTime);
    let peakCenter = sourceCenter;
    let peakValue = Number.NEGATIVE_INFINITY;
    for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
      const candidate = sourceCenter + offset;
      // Lock to one polarity so an equal-amplitude negative half-cycle cannot
      // become an accidental alternate pitch mark on a symmetric waveform.
      const value = this.readInput(candidate);
      if (value > peakValue) {
        peakValue = value;
        peakCenter = candidate;
      }
    }

    // Ceil ensures the earliest grain sample is never before the current
    // callback cursor, even when synthesis marks land between input samples.
    const outputCenterInteger = Math.ceil(outputCenter);
    const angle = Math.PI / (radius + 1);
    const cosineStep = Math.cos(angle);
    let cosineBeforePrevious = 1;
    let cosinePrevious = cosineStep;
    for (let offset = 0; offset <= radius; offset += 1) {
      let cosineValue: number;
      if (offset === 0) {
        cosineValue = 1;
      } else if (offset === 1) {
        cosineValue = cosinePrevious;
      } else {
        const nextCosine = (2 * cosineStep * cosinePrevious) - cosineBeforePrevious;
        cosineBeforePrevious = cosinePrevious;
        cosinePrevious = nextCosine;
        cosineValue = nextCosine;
      }
      const weight = 0.5 + (0.5 * cosineValue);
      const centerSample = this.readInput(peakCenter + offset);
      this.addGrainSample(outputCenterInteger + offset, centerSample, weight);
      if (offset > 0) {
        const oppositeSample = this.readInput(peakCenter - offset);
        this.addGrainSample(outputCenterInteger - offset, oppositeSample, weight);
      }
    }

    const interval = Math.max(1, period / this.currentRatio);
    this.nextSynthesisCenter = outputCenter + interval;
  }

  private addGrainSample(absoluteOutputSample: number, sample: number, weight: number): void {
    if (absoluteOutputSample < this.inputSampleCursor) return;
    const index = absoluteOutputSample % this.outputSumRing.length;
    this.outputSumRing[index] = this.outputSumRing[index]! + sample * weight;
    this.outputWeightRing[index] = this.outputWeightRing[index]! + weight;
  }

  private readInput(absoluteSample: number): number {
    if (absoluteSample < 0 || absoluteSample > this.inputSampleCursor) return 0;
    return this.inputRing[absoluteSample % this.inputRing.length]!;
  }
}
