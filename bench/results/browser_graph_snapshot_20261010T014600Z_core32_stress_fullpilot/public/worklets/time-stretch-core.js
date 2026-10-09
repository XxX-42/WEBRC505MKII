const SAFE_SPEED_MIN = 0.25;
const SAFE_SPEED_MAX = 4;
const AUTO_RESET_UNDERRUN_HOPS = 3;
const TWO_PI = 2 * Math.PI;

// 21.3 ms analysis window and 10.7 ms output hop at 48 kHz. Keep the same
// frame constants in the real-time and OfflineAudioContext paths.
export const TIME_STRETCH_WINDOW_FRAMES = 1024;
export const TIME_STRETCH_HOP_FRAMES = 512;

/** Allocate all FFT, phase and overlap-add storage once for a streaming track. */
export function createTimeStretchState(windowFrames, hopFrames) {
  if (!Number.isInteger(windowFrames) || windowFrames < 16 || (windowFrames & (windowFrames - 1)) !== 0) {
    throw new RangeError('windowFrames must be a power-of-two integer of at least 16.');
  }
  if (!Number.isInteger(hopFrames) || hopFrames < 4 || hopFrames >= windowFrames) {
    throw new RangeError('hopFrames must be at least 4 and smaller than the analysis window.');
  }

  const binCount = windowFrames / 2 + 1;
  const window = new Float32Array(windowFrames);
  const binAngles = new Float64Array(binCount);
  const bitReverse = new Uint32Array(windowFrames);
  const twiddleReal = new Float64Array(windowFrames / 2);
  const twiddleImag = new Float64Array(windowFrames / 2);
  for (let index = 0; index < windowFrames; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(TWO_PI * index / (windowFrames - 1));
    bitReverse[index] = reverseBits(index, Math.log2(windowFrames));
  }
  for (let bin = 0; bin < binCount; bin += 1) {
    binAngles[bin] = TWO_PI * bin / windowFrames;
  }
  for (let index = 0; index < windowFrames / 2; index += 1) {
    const angle = TWO_PI * index / windowFrames;
    twiddleReal[index] = Math.cos(angle);
    twiddleImag[index] = Math.sin(angle);
  }

  return {
    windowFrames,
    hopFrames,
    binCount,
    window,
    binAngles,
    bitReverse,
    twiddleReal,
    twiddleImag,
    realLeft: new Float64Array(windowFrames),
    imagLeft: new Float64Array(windowFrames),
    previousPhaseLeft: new Float64Array(binCount),
    previousPhaseRight: new Float64Array(binCount),
    currentPhaseLeft: new Float64Array(binCount),
    currentPhaseRight: new Float64Array(binCount),
    magnitudeLeft: new Float64Array(binCount),
    magnitudeRight: new Float64Array(binCount),
    synthesisPhaseLeft: new Float64Array(binCount),
    synthesisPhaseRight: new Float64Array(binCount),
    overlapLeft: new Float32Array(windowFrames),
    overlapRight: new Float32Array(windowFrames),
    overlapWeight: new Float32Array(windowFrames),
    pendingLeft: new Float32Array(hopFrames),
    pendingRight: new Float32Array(hopFrames),
    nextPendingLeft: new Float32Array(hopFrames),
    nextPendingRight: new Float32Array(hopFrames),
    pendingIndex: hopFrames,
    nextPendingIndex: 0,
    nextReady: false,
    nextSourceFrame: 0,
    previousAnalysisHop: hopFrames,
    previousReverse: false,
    phaseInitialized: false,
    firstHop: true,
    speed: 1,
    playbackFrame: 0,
    underruns: 0,
    consecutiveUnderrunHops: 0,
    autoResets: 0,
    readUnderrun: false,
    outLeft: 0,
    outRight: 0,
  };
}

/** Reset phase and overlap history without replacing preallocated buffers. */
export function resetTimeStretchState(state, sourceFrame = 0, playbackFrame = 0) {
  if (!Number.isFinite(sourceFrame) || !Number.isFinite(playbackFrame)) {
    throw new RangeError('Time-stretch reset positions must be finite.');
  }
  state.realLeft.fill(0);
  state.imagLeft.fill(0);
  state.previousPhaseLeft.fill(0);
  state.previousPhaseRight.fill(0);
  state.currentPhaseLeft.fill(0);
  state.currentPhaseRight.fill(0);
  state.magnitudeLeft.fill(0);
  state.magnitudeRight.fill(0);
  state.synthesisPhaseLeft.fill(0);
  state.synthesisPhaseRight.fill(0);
  state.overlapLeft.fill(0);
  state.overlapRight.fill(0);
  state.overlapWeight.fill(0);
  state.pendingLeft.fill(0);
  state.pendingRight.fill(0);
  state.nextPendingLeft.fill(0);
  state.nextPendingRight.fill(0);
  state.pendingIndex = state.hopFrames;
  state.nextPendingIndex = 0;
  state.nextReady = false;
  state.nextSourceFrame = sourceFrame;
  state.previousAnalysisHop = state.hopFrames;
  state.previousReverse = false;
  state.phaseInitialized = false;
  state.firstHop = true;
  state.speed = 1;
  state.playbackFrame = playbackFrame;
  state.underruns = 0;
  state.consecutiveUnderrunHops = 0;
  state.autoResets = 0;
  state.readUnderrun = false;
  state.outLeft = 0;
  state.outRight = 0;
}

/**
 * Produce one stereo sample using a shared analysis timeline and independent
 * per-channel phase estimates. A packed complex FFT analyzes and synthesizes
 * both real channels with two transforms per hop rather than four. Readers accept absolute fractional frame
 * positions; `loopFrames > 0` wraps them here, while one-shot readers receive
 * out-of-range positions and must return zero.
 *
 * FFT, phase, overlap-add and pending-output storage is allocated in the
 * constructor. Each call writes `outLeft`/`outRight`; transforms run only at
 * output-hop boundaries. Synthesis uses a Hann analysis/synthesis window and
 * per-sample COLA normalization. The actual Worklet graph should bypass this
 * processor for the normal 1x keep-pitch fast path.
 */
export function processTimeStretchFrame(state, loopFrames, speed, reverse, readLeft, readRight) {
  const safeSpeed = Number.isFinite(speed)
    ? Math.max(SAFE_SPEED_MIN, Math.min(SAFE_SPEED_MAX, speed))
    : 1;
  if (state.pendingIndex >= state.hopFrames) {
    if (state.nextReady) {
      const consumedLeft = state.pendingLeft;
      const consumedRight = state.pendingRight;
      state.pendingLeft = state.nextPendingLeft;
      state.pendingRight = state.nextPendingRight;
      state.nextPendingLeft = consumedLeft;
      state.nextPendingRight = consumedRight;
      state.pendingIndex = state.nextPendingIndex;
      state.nextPendingIndex = 0;
      state.nextReady = false;
    } else {
      generateHop(state, loopFrames, safeSpeed, Boolean(reverse), readLeft, readRight);
    }
  }

  const pendingIndex = state.pendingIndex;
  state.outLeft = state.pendingLeft[pendingIndex];
  state.outRight = state.pendingRight[pendingIndex];
  state.pendingIndex = pendingIndex + 1;
  state.playbackFrame += 1;
}

/**
 * Prepare the hop after the currently buffered samples. This may be called by
 * the Worklet's cross-track scheduler in a later quantum; it does not consume
 * or advance the current output sample clock. `resetTimeStretchState` clears
 * a prepared hop when its track parameters or playback position change.
 */
export function prepareTimeStretchHop(state, loopFrames, speed, reverse, readLeft, readRight) {
  if (state.nextReady || state.pendingIndex >= state.hopFrames) return false;
  const currentPendingLeft = state.pendingLeft;
  const currentPendingRight = state.pendingRight;
  const currentPendingIndex = state.pendingIndex;
  state.pendingLeft = state.nextPendingLeft;
  state.pendingRight = state.nextPendingRight;
  try {
    generateHop(
      state,
      loopFrames,
      Number.isFinite(speed) ? Math.max(SAFE_SPEED_MIN, Math.min(SAFE_SPEED_MAX, speed)) : 1,
      Boolean(reverse),
      readLeft,
      readRight,
    );
    state.nextPendingLeft = state.pendingLeft;
    state.nextPendingRight = state.pendingRight;
    state.nextPendingIndex = state.pendingIndex;
    state.nextReady = true;
  } finally {
    state.pendingLeft = currentPendingLeft;
    state.pendingRight = currentPendingRight;
    state.pendingIndex = currentPendingIndex;
  }
  return true;
}

function generateHop(state, loopFrames, speed, reverse, readLeft, readRight) {
  const frameCount = state.windowFrames;
  const hopFrames = state.hopFrames;
  const direction = reverse ? -1 : 1;
  const analysisStart = state.nextSourceFrame;
  const analysisHop = state.phaseInitialized ? state.previousAnalysisHop : speed * hopFrames;
  const reverseChanged = state.phaseInitialized && state.previousReverse !== reverse;
  const expectedSign = !reverseChanged;
  const positiveHop = Math.max(1, analysisHop);

  if (reverseChanged) {
    state.overlapLeft.fill(0);
    state.overlapRight.fill(0);
    state.overlapWeight.fill(0);
  }

  state.readUnderrun = false;
  let leftHasSignal = false;
  let rightHasSignal = false;
  const canIncrementWrappedFrame = Number.isFinite(loopFrames) && loopFrames >= 1;
  let wrappedSourceFrame = canIncrementWrappedFrame
    ? wrapFrame(analysisStart, loopFrames)
    : analysisStart;
  for (let index = 0; index < frameCount; index += 1) {
    const sourceFrame = canIncrementWrappedFrame
      ? wrappedSourceFrame
      : analysisStart + index * direction;
    const windowValue = state.window[index];
    const leftSample = canIncrementWrappedFrame
      ? readSampleAt(state, readLeft, sourceFrame)
      : readSample(state, readLeft, sourceFrame, loopFrames);
    const rightSample = canIncrementWrappedFrame
      ? readSampleAt(state, readRight, sourceFrame)
      : readSample(state, readRight, sourceFrame, loopFrames);
    leftHasSignal ||= leftSample !== 0;
    rightHasSignal ||= rightSample !== 0;
    state.realLeft[index] = leftSample * windowValue;
    state.imagLeft[index] = rightSample * windowValue;
    if (canIncrementWrappedFrame) {
      wrappedSourceFrame += direction;
      if (wrappedSourceFrame >= loopFrames) wrappedSourceFrame -= loopFrames;
      else if (wrappedSourceFrame < 0) wrappedSourceFrame += loopFrames;
    }
  }

  fft(state.realLeft, state.imagLeft, false, state);

  for (let bin = 0; bin < state.binCount; bin += 1) {
    const mirror = bin === 0 || bin === frameCount / 2 ? bin : frameCount - bin;
    const packedReal = state.realLeft[bin];
    const packedImag = state.imagLeft[bin];
    const mirrorReal = state.realLeft[mirror];
    const mirrorImag = state.imagLeft[mirror];
    const realL = 0.5 * (packedReal + mirrorReal);
    const imagL = 0.5 * (packedImag - mirrorImag);
    const realR = 0.5 * (packedImag + mirrorImag);
    const imagR = 0.5 * (mirrorReal - packedReal);
    const phaseL = Math.atan2(imagL, realL);
    const phaseR = Math.atan2(imagR, realR);
    const binAngle = state.binAngles[bin];
    const expected = binAngle * positiveHop;
    const synthBase = binAngle * hopFrames;
    const magnitudeL = Math.hypot(realL, imagL);
    const magnitudeR = Math.hypot(realR, imagR);

    state.currentPhaseLeft[bin] = phaseL;
    state.currentPhaseRight[bin] = phaseR;
    state.magnitudeLeft[bin] = magnitudeL;
    state.magnitudeRight[bin] = magnitudeR;

    if (state.phaseInitialized && expectedSign) {
      const deltaL = wrapPhase(phaseL - state.previousPhaseLeft[bin] - expected);
      const deltaR = wrapPhase(phaseR - state.previousPhaseRight[bin] - expected);
      state.synthesisPhaseLeft[bin] += synthBase + deltaL * hopFrames / positiveHop;
      state.synthesisPhaseRight[bin] += synthBase + deltaR * hopFrames / positiveHop;
    } else {
      state.synthesisPhaseLeft[bin] = phaseL;
      state.synthesisPhaseRight[bin] = phaseR;
    }
    state.previousPhaseLeft[bin] = phaseL;
    state.previousPhaseRight[bin] = phaseR;
  }

  // Identity phase locking keeps the relative phase of each spectral peak's
  // neighboring bins, reducing the phasiness and sidebands of musical tones.
  // The left/right channels choose anchors independently while sharing the
  // exact same analysis frame and source-time advance.
  for (let bin = 0; bin < state.binCount; bin += 1) {
    const lockedLeft = phaseLockedSynthesisPhase(state, bin, true);
    const lockedRight = phaseLockedSynthesisPhase(state, bin, false);
    state.synthesisPhaseLeft[bin] = lockedLeft;
    state.synthesisPhaseRight[bin] = lockedRight;

    const phaseLeft = lockedLeft;
    const phaseRight = lockedRight;
    const magnitudeL = state.magnitudeLeft[bin];
    const magnitudeR = state.magnitudeRight[bin];
    const leftReal = magnitudeL * Math.cos(phaseLeft);
    const leftImag = magnitudeL * Math.sin(phaseLeft);
    const rightReal = magnitudeR * Math.cos(phaseRight);
    const rightImag = magnitudeR * Math.sin(phaseRight);
    const mirror = frameCount - bin;
    state.realLeft[bin] = leftReal - rightImag;
    state.imagLeft[bin] = leftImag + rightReal;
    if (bin > 0 && bin < frameCount / 2) {
      state.realLeft[mirror] = leftReal + rightImag;
      state.imagLeft[mirror] = -leftImag + rightReal;
    }
  }

  fft(state.realLeft, state.imagLeft, true, state);
  const inverseScale = 1 / frameCount;
  for (let index = 0; index < frameCount; index += 1) {
    const windowValue = state.window[index];
    if (leftHasSignal) state.overlapLeft[index] += state.realLeft[index] * inverseScale * windowValue;
    if (rightHasSignal) state.overlapRight[index] += state.imagLeft[index] * inverseScale * windowValue;
    state.overlapWeight[index] += windowValue * windowValue;
  }

  for (let index = 0; index < hopFrames; index += 1) {
    const weight = state.overlapWeight[index];
    state.pendingLeft[index] = weight > 1e-8 ? state.overlapLeft[index] / weight : 0;
    state.pendingRight[index] = weight > 1e-8 ? state.overlapRight[index] / weight : 0;
  }
  if (state.firstHop) {
    preserveStartupTransient(state, analysisStart, speed, direction, loopFrames, readLeft, readRight);
    state.firstHop = false;
  }
  shiftOverlap(state);

  if (state.readUnderrun) {
    state.underruns += 1;
    state.consecutiveUnderrunHops += 1;
  } else {
    state.consecutiveUnderrunHops = 0;
  }
  let didAutoReset = false;
  if (state.consecutiveUnderrunHops >= AUTO_RESET_UNDERRUN_HOPS) {
    state.autoResets += 1;
    didAutoReset = true;
    state.phaseInitialized = false;
    state.consecutiveUnderrunHops = 0;
    state.previousPhaseLeft.fill(0);
    state.previousPhaseRight.fill(0);
    state.synthesisPhaseLeft.fill(0);
    state.synthesisPhaseRight.fill(0);
    state.overlapLeft.fill(0);
    state.overlapRight.fill(0);
    state.overlapWeight.fill(0);
  }

  state.phaseInitialized = !didAutoReset && !state.readUnderrun;
  state.previousReverse = reverse;
  state.previousAnalysisHop = speed * hopFrames;
  state.speed = speed;
  state.nextSourceFrame = analysisStart + speed * hopFrames * direction;
  if (loopFrames > 0) state.nextSourceFrame = wrapFrame(state.nextSourceFrame, loopFrames);
  state.pendingIndex = 0;
}

/**
 * Phase vocoder windows have zero weight at their leading edge, which can
 * erase or delay the first few samples of a newly-started loop. Blend a short
 * shared-time-domain attack into the already-rendered PV hop to preserve that
 * onset. For speeds above 1, average a small set of points across each output
 * sample's source interval so a one-frame transient is not skipped. The same
 * source positions and blend coefficient are used for both channels, keeping
 * anti-phase and stereo transient relationships intact. This path runs once
 * per reset and performs no extra FFTs or allocations.
 */
function preserveStartupTransient(state, sourceStart, speed, direction, loopFrames, readLeft, readRight) {
  const frames = Math.min(32, state.hopFrames);
  const sampleCount = Math.max(1, Math.ceil(speed));
  const sourceStep = speed / sampleCount;
  for (let index = 0; index < frames; index += 1) {
    const progress = frames <= 1 ? 1 : index / (frames - 1);
    const blendToVocoder = progress * progress * (3 - 2 * progress);
    let directLeft = 0;
    let directRight = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const sourceFrame = sourceStart + sampleIndex * sourceStep * direction + index * speed * direction;
      directLeft += readSample(state, readLeft, sourceFrame, loopFrames);
      directRight += readSample(state, readRight, sourceFrame, loopFrames);
    }
    directLeft /= sampleCount;
    directRight /= sampleCount;
    state.pendingLeft[index] = directLeft * (1 - blendToVocoder) + state.pendingLeft[index] * blendToVocoder;
    state.pendingRight[index] = directRight * (1 - blendToVocoder) + state.pendingRight[index] * blendToVocoder;
  }
}

function phaseLockedSynthesisPhase(state, bin, left) {
  if (bin === 0 || bin === state.binCount - 1) {
    return left ? state.synthesisPhaseLeft[bin] : state.synthesisPhaseRight[bin];
  }
  const magnitude = left ? state.magnitudeLeft : state.magnitudeRight;
  const currentPhase = left ? state.currentPhaseLeft : state.currentPhaseRight;
  const synthesisPhase = left ? state.synthesisPhaseLeft : state.synthesisPhaseRight;
  const firstCandidate = Math.max(1, bin - 3);
  const lastCandidate = Math.min(state.binCount - 2, bin + 3);
  let anchor = bin;
  let anchorDistance = 4;
  let anchorMagnitude = -1;
  for (let candidate = firstCandidate; candidate <= lastCandidate; candidate += 1) {
    const candidateMagnitude = magnitude[candidate];
    if (candidateMagnitude < magnitude[candidate - 1] || candidateMagnitude < magnitude[candidate + 1]) continue;
    const distance = Math.abs(candidate - bin);
    if (distance < anchorDistance || (distance === anchorDistance && candidateMagnitude > anchorMagnitude)) {
      anchor = candidate;
      anchorDistance = distance;
      anchorMagnitude = candidateMagnitude;
    }
  }
  return anchor === bin
    ? synthesisPhase[bin]
    : synthesisPhase[anchor] + wrapPhase(currentPhase[bin] - currentPhase[anchor]);
}

function shiftOverlap(state) {
  const keepFrames = state.windowFrames - state.hopFrames;
  for (let index = 0; index < keepFrames; index += 1) {
    const source = index + state.hopFrames;
    state.overlapLeft[index] = state.overlapLeft[source];
    state.overlapRight[index] = state.overlapRight[source];
    state.overlapWeight[index] = state.overlapWeight[source];
  }
  for (let index = keepFrames; index < state.windowFrames; index += 1) {
    state.overlapLeft[index] = 0;
    state.overlapRight[index] = 0;
    state.overlapWeight[index] = 0;
  }
}

function fft(real, imag, inverse, state) {
  const length = state.windowFrames;
  const bitReverse = state.bitReverse;
  for (let index = 0; index < length; index += 1) {
    const reverse = bitReverse[index];
    if (reverse > index) {
      const realValue = real[index];
      const imagValue = imag[index];
      real[index] = real[reverse];
      imag[index] = imag[reverse];
      real[reverse] = realValue;
      imag[reverse] = imagValue;
    }
  }

  const twiddleReal = state.twiddleReal;
  const twiddleImag = state.twiddleImag;
  for (let blockSize = 2; blockSize <= length; blockSize *= 2) {
    const halfSize = blockSize / 2;
    const twiddleStep = length / blockSize;
    for (let start = 0; start < length; start += blockSize) {
      for (let offset = 0; offset < halfSize; offset += 1) {
        const even = start + offset;
        const odd = even + halfSize;
        const twiddleIndex = offset * twiddleStep;
        const wr = twiddleReal[twiddleIndex];
        const wi = inverse ? twiddleImag[twiddleIndex] : -twiddleImag[twiddleIndex];
        const oddReal = real[odd] * wr - imag[odd] * wi;
        const oddImag = real[odd] * wi + imag[odd] * wr;
        const evenReal = real[even];
        const evenImag = imag[even];
        real[even] = evenReal + oddReal;
        imag[even] = evenImag + oddImag;
        real[odd] = evenReal - oddReal;
        imag[odd] = evenImag - oddImag;
      }
    }
  }
}

function readSample(state, reader, frame, loopFrames) {
  const sample = reader(loopFrames > 0 ? wrapFrame(frame, loopFrames) : frame);
  return validateSample(state, sample);
}

function readSampleAt(state, reader, frame) {
  return validateSample(state, reader(frame));
}

function validateSample(state, sample) {
  if (typeof sample !== 'number' || !Number.isFinite(sample)) {
    state.readUnderrun = true;
    return 0;
  }
  return sample;
}

function wrapFrame(frame, loopFrames) {
  const wrapped = frame % loopFrames;
  return wrapped < 0 ? wrapped + loopFrames : wrapped;
}

function wrapPhase(phase) {
  while (phase > Math.PI) phase -= TWO_PI;
  while (phase < -Math.PI) phase += TWO_PI;
  return phase;
}

function reverseBits(value, bitCount) {
  let reversed = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    reversed = (reversed << 1) | (value & 1);
    value >>>= 1;
  }
  return reversed;
}
