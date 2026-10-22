(() => {
  // src/audio/dsp/LinearParameterSmoother.ts
  var LinearParameterSmoother = class {
    current;
    target;
    step = 0;
    remaining = 0;
    constructor(initialValue = 0) {
      const value = Number.isFinite(initialValue) ? initialValue : 0;
      this.current = value;
      this.target = value;
    }
    get currentValue() {
      return this.current;
    }
    get targetValue() {
      return this.target;
    }
    get remainingFrames() {
      return this.remaining;
    }
    /** Returns false and leaves the current ramp untouched for invalid values. */
    setTarget(value, rampFrames = 0) {
      if (!Number.isFinite(value) || !Number.isFinite(rampFrames)) return false;
      this.target = value;
      const frames = Math.max(0, Math.floor(rampFrames));
      if (frames === 0 || value === this.current) {
        this.current = value;
        this.step = 0;
        this.remaining = 0;
        return true;
      }
      this.remaining = frames;
      this.step = (value - this.current) / frames;
      return true;
    }
    /** Returns the current sample value and advances the ramp by one frame. */
    next() {
      if (this.remaining > 0) {
        this.current += this.step;
        this.remaining -= 1;
        if (this.remaining === 0) {
          this.current = this.target;
          this.step = 0;
        }
      }
      return this.current;
    }
    reset(value = this.target) {
      const safeValue = Number.isFinite(value) ? value : 0;
      this.current = safeValue;
      this.target = safeValue;
      this.step = 0;
      this.remaining = 0;
    }
  };

  // src/audio/dsp/TptStateVariableFilter.ts
  var TptStateVariableFilter = class {
    sampleRate;
    lowpass = 0;
    bandpass = 0;
    highpass = 0;
    integrator1 = 0;
    integrator2 = 0;
    k = Math.SQRT2;
    a1 = 0;
    a2 = 0;
    a3 = 0;
    constructor(sampleRate, cutoffHz = 1e3, q = Math.SQRT1_2) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48e3;
      this.setParameters(cutoffHz, q);
    }
    setParameters(cutoffHz, q = Math.SQRT1_2) {
      if (!Number.isFinite(cutoffHz) || !Number.isFinite(q)) return false;
      const cutoff = Math.max(1e-3, Math.min(this.sampleRate * 0.499, cutoffHz));
      const safeQ = Math.max(0.05, Math.min(100, q));
      const g = Math.tan(Math.PI * cutoff / this.sampleRate);
      const k = 1 / safeQ;
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      this.k = k;
      this.a1 = a1;
      this.a2 = a2;
      this.a3 = g * a2;
      return true;
    }
    processSample(input) {
      const v3 = input - this.integrator2;
      const v1 = this.a1 * this.integrator1 + this.a2 * v3;
      const v2 = this.integrator2 + this.a2 * this.integrator1 + this.a3 * v3;
      this.integrator1 = 2 * v1 - this.integrator1;
      this.integrator2 = 2 * v2 - this.integrator2;
      this.lowpass = v2;
      this.bandpass = v1;
      this.highpass = input - this.k * v1 - v2;
      return this.lowpass;
    }
    processBuffer(input, output, mode = "lowpass", length = Math.min(input.length, output.length)) {
      const count = Math.max(0, Math.min(Math.floor(length), input.length, output.length));
      for (let index = 0; index < count; index += 1) {
        this.processSample(input[index] ?? 0);
        output[index] = mode === "bandpass" ? this.bandpass : mode === "highpass" ? this.highpass : this.lowpass;
      }
    }
    reset() {
      this.integrator1 = 0;
      this.integrator2 = 0;
      this.lowpass = 0;
      this.bandpass = 0;
      this.highpass = 0;
    }
  };

  // src/audio/dsp/equalPowerCrossfade.ts
  var HALF_PI = Math.PI * 0.5;
  function clampPosition(position) {
    if (!Number.isFinite(position)) return 0;
    return Math.max(0, Math.min(1, position));
  }
  function equalPowerFadeOutGain(position) {
    return Math.cos(clampPosition(position) * HALF_PI);
  }
  function equalPowerFadeInGain(position) {
    return Math.sin(clampPosition(position) * HALF_PI);
  }

  // src/audio/fx/dsp/BeatRepeatDsp.ts
  var BeatRepeatDsp = class {
    maxSliceFrames;
    sampleRate;
    wetLeft = 0;
    wetRight = 0;
    boundaryCount = 0;
    framesProcessed = 0;
    lastBoundaryFrame = -1;
    leftBuffers;
    rightBuffers;
    captureBufferIndex = 0;
    playbackBufferIndex = -1;
    captureFrames = 0;
    playbackLength = 0;
    playbackPosition = 0;
    framesUntilBoundary;
    currentBpm;
    currentDivision;
    currentDecay;
    currentDirection;
    pendingBpm;
    pendingDivision;
    pendingDecay;
    pendingDirection;
    directionReverse = false;
    repeatGain = 1;
    hasSlice = false;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.maxSliceFrames = Math.ceil(this.sampleRate * 6) + 2;
      this.leftBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
      this.rightBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
      this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
      this.currentDivision = this.pendingDivision = this.clampDivision(parameters.division ?? 0.5);
      this.currentDecay = this.pendingDecay = this.clampDecay(parameters.decay ?? 15);
      this.currentDirection = this.pendingDirection = this.clampDirection(parameters.direction ?? 0);
      this.framesUntilBoundary = this.intervalFrames(this.currentBpm, this.currentDivision);
    }
    get hasCapturedSlice() {
      return this.hasSlice;
    }
    get activeBpm() {
      return this.currentBpm;
    }
    get activeDivision() {
      return this.currentDivision;
    }
    get activeDirection() {
      return this.currentDirection;
    }
    get activeSliceFrames() {
      return this.playbackLength;
    }
    get remainingFramesToBoundary() {
      return this.framesUntilBoundary;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.division)) this.pendingDivision = this.clampDivision(parameters.division);
      if (Number.isFinite(parameters.decay)) this.pendingDecay = this.clampDecay(parameters.decay);
      if (Number.isFinite(parameters.direction)) this.pendingDirection = this.clampDirection(parameters.direction);
    }
    /** Mutates wetLeft/wetRight and does not allocate. */
    processSample(left, right) {
      const captureLeft = this.leftBuffers[this.captureBufferIndex];
      const captureRight = this.rightBuffers[this.captureBufferIndex];
      if (this.captureFrames < this.maxSliceFrames) {
        captureLeft[this.captureFrames] = left;
        captureRight[this.captureFrames] = right;
      }
      if (!this.hasSlice || this.playbackBufferIndex < 0 || this.playbackLength <= 0) {
        this.wetLeft = 0;
        this.wetRight = 0;
      } else {
        this.renderPlayback(captureLeft, captureRight);
      }
      this.captureFrames += 1;
      this.framesUntilBoundary -= 1;
      this.framesProcessed += 1;
      if (this.framesUntilBoundary <= 0) this.onBoundary();
    }
    reset() {
      this.captureBufferIndex = 0;
      this.playbackBufferIndex = -1;
      this.captureFrames = 0;
      this.playbackLength = 0;
      this.playbackPosition = 0;
      this.currentBpm = this.pendingBpm;
      this.currentDivision = this.pendingDivision;
      this.currentDecay = this.pendingDecay;
      this.currentDirection = this.pendingDirection;
      this.framesUntilBoundary = this.intervalFrames(this.currentBpm, this.currentDivision);
      this.directionReverse = false;
      this.repeatGain = 1;
      this.hasSlice = false;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.boundaryCount = 0;
      this.framesProcessed = 0;
      this.lastBoundaryFrame = -1;
    }
    renderPlayback(nextLeft, nextRight) {
      const bufferIndex = this.playbackBufferIndex;
      const fadeFrames = this.crossfadeFrames(this.playbackLength);
      const fadeToNextSlice = fadeFrames > 0 && !this.directionReverse && this.currentDirection === 0 && this.pendingDirection === 0 && this.framesUntilBoundary <= fadeFrames;
      const fadePosition = fadeToNextSlice ? fadeFrames - this.framesUntilBoundary : 0;
      let readIndex = this.playbackPosition;
      if (readIndex < 0) readIndex = 0;
      else if (readIndex >= this.playbackLength) readIndex = this.playbackLength - 1;
      let left = this.leftBuffers[bufferIndex][readIndex] ?? 0;
      let right = this.rightBuffers[bufferIndex][readIndex] ?? 0;
      if (fadeToNextSlice && this.captureFrames > fadePosition) {
        let incomingIndex = fadePosition;
        if (incomingIndex < 0) incomingIndex = 0;
        if (incomingIndex >= this.maxSliceFrames) incomingIndex = this.maxSliceFrames - 1;
        const position = (fadePosition + 1) / fadeFrames;
        const oldGain = equalPowerFadeOutGain(position);
        const newGain = equalPowerFadeInGain(position);
        left = left * oldGain + (nextLeft[incomingIndex] ?? 0) * newGain;
        right = right * oldGain + (nextRight[incomingIndex] ?? 0) * newGain;
      } else if (fadeFrames > 0 && this.isAtLoopTail(readIndex, fadeFrames)) {
        const position = this.directionReverse ? (fadeFrames - readIndex) / fadeFrames : (readIndex - (this.playbackLength - fadeFrames) + 1) / fadeFrames;
        const nextIndex = this.directionReverse ? this.playbackLength - 1 - (fadeFrames - 1 - readIndex) : readIndex - (this.playbackLength - fadeFrames);
        const oldGain = equalPowerFadeOutGain(position);
        const newGain = equalPowerFadeInGain(position);
        left = left * oldGain + (this.leftBuffers[bufferIndex][nextIndex] ?? 0) * newGain;
        right = right * oldGain + (this.rightBuffers[bufferIndex][nextIndex] ?? 0) * newGain;
      }
      this.wetLeft = left * this.repeatGain;
      this.wetRight = right * this.repeatGain;
      this.advancePlaybackPosition();
    }
    isAtLoopTail(readIndex, fadeFrames) {
      return this.directionReverse ? readIndex < fadeFrames : readIndex >= this.playbackLength - fadeFrames;
    }
    advancePlaybackPosition() {
      if (this.directionReverse) {
        this.playbackPosition -= 1;
        if (this.playbackPosition < 0) {
          this.playbackPosition = Math.max(0, this.playbackLength - this.crossfadeFrames(this.playbackLength) - 1);
          if (this.framesUntilBoundary > 1) this.onRetrigger();
        }
      } else {
        this.playbackPosition += 1;
        if (this.playbackPosition >= this.playbackLength) {
          this.playbackPosition = Math.min(this.playbackLength - 1, this.crossfadeFrames(this.playbackLength));
          if (this.framesUntilBoundary > 1) this.onRetrigger();
        }
      }
    }
    onRetrigger() {
      this.repeatGain *= 1 - this.currentDecay / 100;
      if (this.repeatGain < 1e-6) this.repeatGain = 0;
    }
    onBoundary() {
      this.boundaryCount += 1;
      this.lastBoundaryFrame = this.framesProcessed - 1;
      const validFrames = Math.min(this.captureFrames, this.maxSliceFrames);
      if (validFrames > 0) {
        const previousReadBuffer = this.playbackBufferIndex;
        const replacingExistingSlice = this.hasSlice;
        const eventCrossfadeApplied = replacingExistingSlice && !this.directionReverse && this.currentDirection === 0 && this.pendingDirection === 0;
        if (!this.hasSlice) {
          this.repeatGain = 1;
          this.directionReverse = this.currentDirection === 1;
        } else {
          this.onRetrigger();
          if (this.pendingDirection === 2) {
            this.directionReverse = !this.directionReverse;
          } else {
            this.directionReverse = this.pendingDirection === 1;
          }
        }
        this.playbackBufferIndex = this.captureBufferIndex;
        this.captureBufferIndex = previousReadBuffer >= 0 ? previousReadBuffer : 1 - this.captureBufferIndex;
        this.playbackLength = validFrames;
        this.hasSlice = true;
        const fadeFrames = this.crossfadeFrames(validFrames);
        this.playbackPosition = this.directionReverse ? Math.max(0, validFrames - 1) : Math.min(validFrames - 1, eventCrossfadeApplied ? fadeFrames : 0);
      }
      this.captureFrames = 0;
      this.currentBpm = this.pendingBpm;
      this.currentDivision = this.pendingDivision;
      this.currentDecay = this.pendingDecay;
      this.currentDirection = this.pendingDirection;
      this.framesUntilBoundary = this.intervalFrames(this.currentBpm, this.currentDivision);
    }
    intervalFrames(bpm, division) {
      const rawFrames = 60 * this.sampleRate * division / bpm;
      return Math.max(1, Math.min(this.maxSliceFrames, Math.round(rawFrames)));
    }
    crossfadeFrames(sliceFrames) {
      return Math.min(Math.floor(sliceFrames / 2), Math.max(1, Math.round(this.sampleRate * 5e-3)));
    }
    clampBpm(value) {
      return Math.max(40, Math.min(300, value));
    }
    clampDivision(value) {
      const options = [0.25, 0.5, 1, 2, 4];
      let nearest = options[0] ?? 0.25;
      let nearestDistance = Math.abs(value - nearest);
      for (let index = 1; index < options.length; index += 1) {
        const option = options[index] ?? nearest;
        const distance = Math.abs(value - option);
        if (distance < nearestDistance) {
          nearest = option;
          nearestDistance = distance;
        }
      }
      return nearest;
    }
    clampDecay(value) {
      return Math.max(0, Math.min(100, value));
    }
    clampDirection(value) {
      return Math.max(0, Math.min(2, Math.round(value)));
    }
  };

  // src/audio/dsp/DeterministicPrng.ts
  var DeterministicPrng = class {
    state;
    constructor(seed = 1831565813) {
      this.state = this.normalizeSeed(seed);
    }
    setSeed(seed) {
      this.state = this.normalizeSeed(seed);
    }
    nextUint32() {
      let value = this.state;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      this.state = value >>> 0;
      return this.state;
    }
    /** Uniform value in [0, 1). */
    nextFloat() {
      return this.nextUint32() / 4294967296;
    }
    /** Uniform value in [-1, 1). */
    nextBipolar() {
      return this.nextFloat() * 2 - 1;
    }
    fillFloat32(output, bipolar = false) {
      if (bipolar) {
        for (let index = 0; index < output.length; index += 1) output[index] = this.nextBipolar();
      } else {
        for (let index = 0; index < output.length; index += 1) output[index] = this.nextFloat();
      }
    }
    normalizeSeed(seed) {
      const value = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
      return value === 0 ? 1831565813 : value;
    }
  };

  // src/audio/fx/dsp/LoFiDsp.ts
  var TWO_PI = 2 * Math.PI;
  var LEFT_SEED = 2654435769;
  var RIGHT_SEED = 3518319157;
  var LoFiDsp = class {
    sampleRate;
    bitDepth;
    reducedRateHz;
    filterHz;
    randomLeft;
    randomRight;
    holdPhase = 0;
    heldLeft = 0;
    heldRight = 0;
    lowpassLeft = 0;
    lowpassRight = 0;
    lowpassAlpha = 1;
    framesSinceCoefficientUpdate = 0;
    hasHeldSample = false;
    outputLeft = 0;
    outputRight = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.bitDepth = new LinearParameterSmoother(clamp(parameters.bitDepth ?? 12, 4, 24));
      this.reducedRateHz = new LinearParameterSmoother(clamp(parameters.sampleRateHz ?? 12e3, 500, this.sampleRate));
      this.filterHz = new LinearParameterSmoother(clamp(parameters.filterHz ?? 12e3, 20, 2e4));
      this.randomLeft = new DeterministicPrng(LEFT_SEED);
      this.randomRight = new DeterministicPrng(RIGHT_SEED);
      this.updateLowpass(this.filterHz.currentValue);
    }
    setParameters(parameters, rampFrames = Math.round(this.sampleRate * 0.02)) {
      const ramp = Math.max(0, Math.floor(rampFrames));
      if (Number.isFinite(parameters.bitDepth)) this.bitDepth.setTarget(clamp(parameters.bitDepth, 4, 24), ramp);
      if (Number.isFinite(parameters.sampleRateHz)) {
        this.reducedRateHz.setTarget(clamp(parameters.sampleRateHz, 500, this.sampleRate), ramp);
      }
      if (Number.isFinite(parameters.filterHz)) this.filterHz.setTarget(clamp(parameters.filterHz, 20, Math.min(2e4, this.sampleRate * 0.45)), ramp);
    }
    get wetLeft() {
      return this.outputLeft;
    }
    get wetRight() {
      return this.outputRight;
    }
    process(inputLeft, inputRight) {
      const bits = Math.round(this.bitDepth.next());
      const reducedRate = clamp(this.reducedRateHz.next(), 500, this.sampleRate);
      const cutoff = clamp(this.filterHz.next(), 20, this.sampleRate * 0.45);
      if (this.framesSinceCoefficientUpdate === 0) this.updateLowpass(cutoff);
      this.framesSinceCoefficientUpdate += 1;
      if (this.framesSinceCoefficientUpdate >= 16) this.framesSinceCoefficientUpdate = 0;
      let capture = !this.hasHeldSample;
      if (!capture) {
        this.holdPhase += reducedRate / this.sampleRate;
        if (this.holdPhase >= 1) {
          this.holdPhase -= Math.floor(this.holdPhase);
          capture = true;
        }
      }
      if (capture) {
        this.heldLeft = this.quantize(inputLeft, bits, this.randomLeft);
        this.heldRight = this.quantize(inputRight, bits, this.randomRight);
        this.hasHeldSample = true;
      }
      this.lowpassLeft += this.lowpassAlpha * (this.heldLeft - this.lowpassLeft);
      this.lowpassRight += this.lowpassAlpha * (this.heldRight - this.lowpassRight);
      this.outputLeft = this.lowpassLeft;
      this.outputRight = this.lowpassRight;
    }
    reset() {
      this.holdPhase = 0;
      this.heldLeft = 0;
      this.heldRight = 0;
      this.lowpassLeft = 0;
      this.lowpassRight = 0;
      this.framesSinceCoefficientUpdate = 0;
      this.hasHeldSample = false;
      this.outputLeft = 0;
      this.outputRight = 0;
      this.randomLeft.setSeed(LEFT_SEED);
      this.randomRight.setSeed(RIGHT_SEED);
      this.updateLowpass(this.filterHz.currentValue);
    }
    quantize(input, bits, random) {
      const scale = 2 ** (bits - 1);
      const dither = random.nextFloat() - random.nextFloat();
      const scaled = clamp(input, -1, 1) * scale + dither;
      const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
      return clamp(rounded / scale, -1, 1);
    }
    updateLowpass(cutoffHz) {
      const cutoff = clamp(cutoffHz, 20, this.sampleRate * 0.45);
      this.lowpassAlpha = 1 - Math.exp(-TWO_PI * cutoff / this.sampleRate);
    }
  };
  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  // src/audio/dsp/RbjBiquad.ts
  function designRbjBiquad(type, sampleRate, frequencyHz, q = Math.SQRT1_2, gainDb = 0) {
    const safeSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48e3;
    const safeFrequency = Number.isFinite(frequencyHz) ? Math.max(0, Math.min(safeSampleRate * 0.499, frequencyHz)) : 1e3;
    const safeQ = Number.isFinite(q) && q > 0 ? Math.min(1e3, q) : Math.SQRT1_2;
    const safeGainDb = Number.isFinite(gainDb) ? Math.max(-120, Math.min(120, gainDb)) : 0;
    const omega = 2 * Math.PI * safeFrequency / safeSampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const alpha = sine / (2 * safeQ);
    const a0 = 1 + alpha;
    const inverseA0 = 1 / a0;
    let b0;
    let b1;
    let b2;
    let a1;
    let a2;
    switch (type) {
      case "lowpass":
        b0 = (1 - cosine) * 0.5;
        b1 = 1 - cosine;
        b2 = (1 - cosine) * 0.5;
        a1 = -2 * cosine;
        a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + cosine) * 0.5;
        b1 = -(1 + cosine);
        b2 = (1 + cosine) * 0.5;
        a1 = -2 * cosine;
        a2 = 1 - alpha;
        break;
      case "bandpass":
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a1 = -2 * cosine;
        a2 = 1 - alpha;
        break;
      case "notch":
        b0 = 1;
        b1 = -2 * cosine;
        b2 = 1;
        a1 = -2 * cosine;
        a2 = 1 - alpha;
        break;
      case "peaking": {
        const amplitude = 10 ** (safeGainDb / 40);
        const peakA0 = 1 + alpha / amplitude;
        const inversePeakA0 = 1 / peakA0;
        return {
          b0: (1 + alpha * amplitude) * inversePeakA0,
          b1: -2 * cosine * inversePeakA0,
          b2: (1 - alpha * amplitude) * inversePeakA0,
          a1: -2 * cosine * inversePeakA0,
          a2: (1 - alpha / amplitude) * inversePeakA0
        };
      }
      case "low-shelf":
      case "high-shelf": {
        const amplitude = 10 ** (safeGainDb / 40);
        const shelfAlpha = sine * Math.SQRT1_2;
        const beta = 2 * Math.sqrt(amplitude) * shelfAlpha;
        const plus = amplitude + 1;
        const minus = amplitude - 1;
        if (type === "low-shelf") {
          const shelfA02 = plus + minus * cosine + beta;
          const inverseShelfA02 = 1 / shelfA02;
          return {
            b0: amplitude * (plus - minus * cosine + beta) * inverseShelfA02,
            b1: 2 * amplitude * (minus - plus * cosine) * inverseShelfA02,
            b2: amplitude * (plus - minus * cosine - beta) * inverseShelfA02,
            a1: -2 * (minus + plus * cosine) * inverseShelfA02,
            a2: (plus + minus * cosine - beta) * inverseShelfA02
          };
        }
        const shelfA0 = plus - minus * cosine + beta;
        const inverseShelfA0 = 1 / shelfA0;
        return {
          b0: amplitude * (plus + minus * cosine + beta) * inverseShelfA0,
          b1: -2 * amplitude * (minus + plus * cosine) * inverseShelfA0,
          b2: amplitude * (plus + minus * cosine - beta) * inverseShelfA0,
          a1: 2 * (minus - plus * cosine) * inverseShelfA0,
          a2: (plus - minus * cosine - beta) * inverseShelfA0
        };
      }
    }
    return {
      b0: b0 * inverseA0,
      b1: b1 * inverseA0,
      b2: b2 * inverseA0,
      a1: a1 * inverseA0,
      a2: a2 * inverseA0
    };
  }
  var RbjBiquad = class {
    b0 = 1;
    b1 = 0;
    b2 = 0;
    a1 = 0;
    a2 = 0;
    z1 = 0;
    z2 = 0;
    constructor(coefficients) {
      if (coefficients) this.setCoefficients(coefficients);
    }
    setCoefficients(coefficients) {
      if (!Number.isFinite(coefficients.b0) || !Number.isFinite(coefficients.b1) || !Number.isFinite(coefficients.b2) || !Number.isFinite(coefficients.a1) || !Number.isFinite(coefficients.a2)) {
        return false;
      }
      return this.setCoefficientsValues(coefficients.b0, coefficients.b1, coefficients.b2, coefficients.a1, coefficients.a2);
    }
    /** Update normalized coefficients without allocating a coefficient object. */
    setCoefficientsValues(b0, b1, b2, a1, a2) {
      if (!Number.isFinite(b0) || !Number.isFinite(b1) || !Number.isFinite(b2) || !Number.isFinite(a1) || !Number.isFinite(a2)) {
        return false;
      }
      this.b0 = b0;
      this.b1 = b1;
      this.b2 = b2;
      this.a1 = a1;
      this.a2 = a2;
      return true;
    }
    setRbjParameters(type, sampleRate, frequencyHz, q = Math.SQRT1_2, gainDb = 0) {
      this.setCoefficients(designRbjBiquad(type, sampleRate, frequencyHz, q, gainDb));
    }
    processSample(input) {
      const output = this.b0 * input + this.z1;
      this.z1 = this.b1 * input - this.a1 * output + this.z2;
      this.z2 = this.b2 * input - this.a2 * output;
      return output;
    }
    processBuffer(input, output, length = Math.min(input.length, output.length)) {
      const count = Math.max(0, Math.min(Math.floor(length), input.length, output.length));
      for (let index = 0; index < count; index += 1) {
        output[index] = this.processSample(input[index] ?? 0);
      }
    }
    reset() {
      this.z1 = 0;
      this.z2 = 0;
    }
  };

  // src/audio/fx/dsp/EqualizerDsp.ts
  var COEFFICIENTS_PER_SECTION = 5;
  var SECTION_COUNT = 4;
  var DEFAULT_RAMP_SECONDS = 0.02;
  var EqualizerDsp = class {
    sampleRate;
    filtersLeft;
    filtersRight;
    currentCoefficients = new Float64Array(SECTION_COUNT * COEFFICIENTS_PER_SECTION);
    targetCoefficients = new Float64Array(SECTION_COUNT * COEFFICIENTS_PER_SECTION);
    lowFrequencyHz = 100;
    lowGainDb = 0;
    mid1FrequencyHz = 500;
    mid1Q = 1;
    mid1GainDb = 0;
    mid2FrequencyHz = 2500;
    mid2Q = 1;
    mid2GainDb = 0;
    highFrequencyHz = 8e3;
    highGainDb = 0;
    remainingRampFrames = 0;
    wetLeft = 0;
    wetRight = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.filtersLeft = [new RbjBiquad(), new RbjBiquad(), new RbjBiquad(), new RbjBiquad()];
      this.filtersRight = [new RbjBiquad(), new RbjBiquad(), new RbjBiquad(), new RbjBiquad()];
      this.setParameters(parameters, 0);
    }
    get outputLeft() {
      return this.wetLeft;
    }
    get outputRight() {
      return this.wetRight;
    }
    setParameters(parameters, rampFrames = Math.round(this.sampleRate * DEFAULT_RAMP_SECONDS)) {
      const nyquist = this.sampleRate * 0.45;
      if (Number.isFinite(parameters.lowFrequencyHz)) this.lowFrequencyHz = clamp2(parameters.lowFrequencyHz, 20, Math.min(500, nyquist));
      if (Number.isFinite(parameters.lowGainDb)) this.lowGainDb = clamp2(parameters.lowGainDb, -15, 15);
      if (Number.isFinite(parameters.mid1FrequencyHz)) this.mid1FrequencyHz = clamp2(parameters.mid1FrequencyHz, 80, Math.min(8e3, nyquist));
      if (Number.isFinite(parameters.mid1Q)) this.mid1Q = clamp2(parameters.mid1Q, 0.1, 12);
      if (Number.isFinite(parameters.mid1GainDb)) this.mid1GainDb = clamp2(parameters.mid1GainDb, -15, 15);
      if (Number.isFinite(parameters.mid2FrequencyHz)) this.mid2FrequencyHz = clamp2(parameters.mid2FrequencyHz, 80, Math.min(12e3, nyquist));
      if (Number.isFinite(parameters.mid2Q)) this.mid2Q = clamp2(parameters.mid2Q, 0.1, 12);
      if (Number.isFinite(parameters.mid2GainDb)) this.mid2GainDb = clamp2(parameters.mid2GainDb, -15, 15);
      if (Number.isFinite(parameters.highFrequencyHz)) this.highFrequencyHz = clamp2(parameters.highFrequencyHz, 1e3, Math.min(2e4, nyquist));
      if (Number.isFinite(parameters.highGainDb)) this.highGainDb = clamp2(parameters.highGainDb, -15, 15);
      this.designTargets();
      const frames = Math.max(0, Math.floor(Number.isFinite(rampFrames) ? rampFrames : 0));
      this.remainingRampFrames = frames;
      if (frames === 0) {
        this.currentCoefficients.set(this.targetCoefficients);
        this.applyCoefficients();
      }
    }
    /** Mutates output state; safe for one stereo sample in an audio render loop. */
    process(inputLeft, inputRight) {
      if (this.remainingRampFrames > 0) {
        const inverseRemaining = 1 / this.remainingRampFrames;
        for (let index = 0; index < this.currentCoefficients.length; index += 1) {
          const current = this.currentCoefficients[index] ?? 0;
          const target = this.targetCoefficients[index] ?? current;
          this.currentCoefficients[index] = current + (target - current) * inverseRemaining;
        }
        this.remainingRampFrames -= 1;
        if (this.remainingRampFrames === 0) this.currentCoefficients.set(this.targetCoefficients);
        this.applyCoefficients();
      }
      let left = inputLeft;
      let right = inputRight;
      for (let section = 0; section < SECTION_COUNT; section += 1) {
        left = this.filtersLeft[section].processSample(left);
        right = this.filtersRight[section].processSample(right);
      }
      this.wetLeft = left;
      this.wetRight = right;
    }
    reset() {
      for (let section = 0; section < SECTION_COUNT; section += 1) {
        this.filtersLeft[section].reset();
        this.filtersRight[section].reset();
      }
      this.remainingRampFrames = 0;
      this.currentCoefficients.set(this.targetCoefficients);
      this.applyCoefficients();
      this.wetLeft = 0;
      this.wetRight = 0;
    }
    designTargets() {
      this.writeTarget(0, designRbjBiquad("low-shelf", this.sampleRate, this.lowFrequencyHz, Math.SQRT1_2, this.lowGainDb));
      this.writeTarget(1, designRbjBiquad("peaking", this.sampleRate, this.mid1FrequencyHz, this.mid1Q, this.mid1GainDb));
      this.writeTarget(2, designRbjBiquad("peaking", this.sampleRate, this.mid2FrequencyHz, this.mid2Q, this.mid2GainDb));
      this.writeTarget(3, designRbjBiquad("high-shelf", this.sampleRate, this.highFrequencyHz, Math.SQRT1_2, this.highGainDb));
    }
    writeTarget(section, coefficients) {
      const offset = section * COEFFICIENTS_PER_SECTION;
      this.targetCoefficients[offset] = coefficients.b0;
      this.targetCoefficients[offset + 1] = coefficients.b1;
      this.targetCoefficients[offset + 2] = coefficients.b2;
      this.targetCoefficients[offset + 3] = coefficients.a1;
      this.targetCoefficients[offset + 4] = coefficients.a2;
    }
    applyCoefficients() {
      for (let section = 0; section < SECTION_COUNT; section += 1) {
        const offset = section * COEFFICIENTS_PER_SECTION;
        const b0 = this.currentCoefficients[offset] ?? 1;
        const b1 = this.currentCoefficients[offset + 1] ?? 0;
        const b2 = this.currentCoefficients[offset + 2] ?? 0;
        const a1 = this.currentCoefficients[offset + 3] ?? 0;
        const a2 = this.currentCoefficients[offset + 4] ?? 0;
        this.filtersLeft[section].setCoefficientsValues(b0, b1, b2, a1, a2);
        this.filtersRight[section].setCoefficientsValues(b0, b1, b2, a1, a2);
      }
    }
  };
  function clamp2(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  // src/audio/fx/dsp/BrowserPanningDelayDsp.ts
  var QUARTER_PI = Math.PI * 0.25;
  var INV_SQRT_TWO = Math.SQRT1_2;
  var MIN_SAMPLE_RATE = 8e3;
  var MAX_SAMPLE_RATE = 192e3;
  var MIN_DELAY_MS = 1;
  var MAX_DELAY_MS = 2e3;
  var MAX_INPUT_MAGNITUDE = 8;
  var PARAMETER_SMOOTHING_SECONDS = 0.015;
  var FEEDBACK_STABILITY_SCALE = 0.78;
  var TIME = 0;
  var FEEDBACK = 1;
  var PAN = 2;
  var MIX = 3;
  function clamp3(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
  function finiteBounded(value, maximumMagnitude) {
    return Number.isFinite(value) ? clamp3(value, -maximumMagnitude, maximumMagnitude) : 0;
  }
  function readLagrangeFromWriteHead(buffer, writeIndex, delaySamples) {
    const wholeDelay = Math.floor(delaySamples);
    const fraction = delaySamples - wholeDelay;
    const oneMinus = 1 - fraction;
    const coefficient0 = oneMinus * (2 - fraction) * (3 - fraction) / 6;
    const coefficient1 = fraction * (2 - fraction) * (3 - fraction) / 2;
    const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
    const coefficient3 = fraction * oneMinus * (2 - fraction) / 6;
    const length = buffer.length;
    let index = writeIndex - wholeDelay;
    if (index < 0) index += length;
    const sample0 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample1 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample2 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample3 = buffer[index] ?? 0;
    return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
  }
  var BrowserPanningDelayDsp = class {
    sampleRate;
    buffers;
    writeIndices = new Int32Array(2);
    current = new Float64Array(4);
    target = new Float64Array(4);
    smoothingCoefficient;
    lastDryLeft = 0;
    lastDryRight = 0;
    lastWetLeft = 0;
    lastWetRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp3(sampleRate, MIN_SAMPLE_RATE, MAX_SAMPLE_RATE) : 48e3;
      const capacity = Math.ceil(MAX_DELAY_MS * this.sampleRate / 1e3) + 8;
      this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
      this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS * this.sampleRate));
      const initialTime = Number.isFinite(parameters.timeMs) ? clamp3(parameters.timeMs, MIN_DELAY_MS, MAX_DELAY_MS) : 500;
      const initialFeedback = Number.isFinite(parameters.feedback) ? clamp3(parameters.feedback, 0, 95) : 30;
      const initialPan = Number.isFinite(parameters.pan) ? clamp3(parameters.pan, -100, 100) : 70;
      const initialMix = Number.isFinite(parameters.mix) ? clamp3(parameters.mix, 0, 100) : 25;
      this.current[TIME] = this.target[TIME] = initialTime;
      this.current[FEEDBACK] = this.target[FEEDBACK] = initialFeedback;
      this.current[PAN] = this.target[PAN] = initialPan;
      this.current[MIX] = this.target[MIX] = initialMix;
    }
    /** Update smoothed targets; invalid individual controls are ignored. */
    setParameters(parameters) {
      if (Number.isFinite(parameters.timeMs)) this.target[TIME] = clamp3(parameters.timeMs, MIN_DELAY_MS, MAX_DELAY_MS);
      if (Number.isFinite(parameters.feedback)) this.target[FEEDBACK] = clamp3(parameters.feedback, 0, 95);
      if (Number.isFinite(parameters.pan)) this.target[PAN] = clamp3(parameters.pan, -100, 100);
      if (Number.isFinite(parameters.mix)) this.target[MIX] = clamp3(parameters.mix, 0, 100);
    }
    /** Clear delay history and restore the smoothed controls to their targets. */
    reset() {
      this.buffers[0].fill(0);
      this.buffers[1].fill(0);
      this.writeIndices.fill(0);
      this.lastDryLeft = 0;
      this.lastDryRight = 0;
      this.lastWetLeft = 0;
      this.lastWetRight = 0;
      for (let index = 0; index < this.current.length; index += 1) this.current[index] = this.target[index] ?? 0;
    }
    /** Process one frame and expose its wet-only panned repeat. */
    processSample(inputLeft, inputRight) {
      this.processFrameSample(inputLeft, inputRight);
    }
    /** Last wet-only output from processSample() or the most recent block frame. */
    get wetOutputLeft() {
      return this.lastWetLeft;
    }
    get wetOutputRight() {
      return this.lastWetRight;
    }
    /** Process planar audio without block-size assumptions or typed-array allocation. */
    processBlock(inputLeft, inputRight, outputLeft, outputRight, frameCount) {
      let frames = Math.min(inputLeft.length, outputLeft.length);
      if (inputRight !== null) frames = Math.min(frames, inputRight.length);
      if (outputRight !== null) frames = Math.min(frames, outputRight.length);
      if (frameCount !== void 0 && Number.isFinite(frameCount)) {
        frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));
      }
      for (let frame = 0; frame < frames; frame += 1) {
        const inputL = inputLeft[frame] ?? 0;
        const inputR = inputRight === null ? inputL : inputRight[frame] ?? 0;
        this.processFrameSample(inputL, inputR);
        const mix = (this.current[MIX] ?? 0) * 0.01;
        outputLeft[frame] = finiteBounded(this.lastDryLeft * (1 - mix) + this.lastWetLeft * mix, MAX_INPUT_MAGNITUDE);
        if (outputRight !== null) {
          outputRight[frame] = finiteBounded(this.lastDryRight * (1 - mix) + this.lastWetRight * mix, MAX_INPUT_MAGNITUDE);
        }
      }
    }
    processFrameSample(inputLeft, inputRight) {
      this.current[TIME] = (this.current[TIME] ?? 0) + this.smoothingCoefficient * ((this.target[TIME] ?? 0) - (this.current[TIME] ?? 0));
      this.current[FEEDBACK] = (this.current[FEEDBACK] ?? 0) + this.smoothingCoefficient * ((this.target[FEEDBACK] ?? 0) - (this.current[FEEDBACK] ?? 0));
      this.current[PAN] = (this.current[PAN] ?? 0) + this.smoothingCoefficient * ((this.target[PAN] ?? 0) - (this.current[PAN] ?? 0));
      this.current[MIX] = (this.current[MIX] ?? 0) + this.smoothingCoefficient * ((this.target[MIX] ?? 0) - (this.current[MIX] ?? 0));
      const dryLeft = finiteBounded(inputLeft, MAX_INPUT_MAGNITUDE);
      const dryRight = finiteBounded(inputRight, MAX_INPUT_MAGNITUDE);
      this.lastDryLeft = dryLeft;
      this.lastDryRight = dryRight;
      const rawDelay = (this.current[TIME] ?? 500) * this.sampleRate * 1e-3;
      const delaySamples = clamp3(rawDelay, 2, this.buffers[0].length - 6);
      const writeLeft = this.writeIndices[0] ?? 0;
      const writeRight = this.writeIndices[1] ?? 0;
      const delayedLeft = readLagrangeFromWriteHead(this.buffers[0], writeLeft, delaySamples);
      const delayedRight = readLagrangeFromWriteHead(this.buffers[1], writeRight, delaySamples);
      const feedback = (this.current[FEEDBACK] ?? 0) * 0.01 * FEEDBACK_STABILITY_SCALE;
      this.buffers[0][writeLeft] = finiteBounded(dryLeft + feedback * delayedRight, MAX_INPUT_MAGNITUDE);
      this.buffers[1][writeRight] = finiteBounded(dryRight + feedback * delayedLeft, MAX_INPUT_MAGNITUDE);
      const nextLeft = writeLeft + 1 >= this.buffers[0].length ? 0 : writeLeft + 1;
      const nextRight = writeRight + 1 >= this.buffers[1].length ? 0 : writeRight + 1;
      this.writeIndices[0] = nextLeft;
      this.writeIndices[1] = nextRight;
      const repeatMono = (delayedLeft + delayedRight) * INV_SQRT_TWO;
      const panRadians = ((this.current[PAN] ?? 0) + 100) * (QUARTER_PI / 100);
      this.lastWetLeft = finiteBounded(repeatMono * Math.cos(panRadians), MAX_INPUT_MAGNITUDE);
      this.lastWetRight = finiteBounded(repeatMono * Math.sin(panRadians), MAX_INPUT_MAGNITUDE);
    }
  };

  // src/audio/fx/dsp/BrowserModDelayDsp.ts
  var MIN_SAMPLE_RATE2 = 8e3;
  var MAX_SAMPLE_RATE2 = 192e3;
  var MIN_TIME_MS = 10;
  var MAX_TIME_MS = 2e3;
  var MAX_DEPTH_MS = 50;
  var MIN_RATE_HZ = 0.05;
  var MAX_RATE_HZ = 10;
  var MAX_FEEDBACK_PERCENT = 95;
  var PARAMETER_SMOOTHING_SECONDS2 = 0.015;
  var TWO_PI2 = 2 * Math.PI;
  var MAX_SAMPLE_MAGNITUDE = 8;
  var FEEDBACK_STABILITY_SCALE2 = 0.78;
  function clamp4(value, minimum, maximum) {
    if (value !== 0 && value >= minimum && value <= maximum) return value;
    return Math.max(minimum, Math.min(maximum, value));
  }
  function finiteBounded2(value) {
    return Number.isFinite(value) ? clamp4(value, -MAX_SAMPLE_MAGNITUDE, MAX_SAMPLE_MAGNITUDE) : 0;
  }
  function readLagrange(buffer, writeIndex, delaySamples) {
    const whole = Math.floor(delaySamples);
    const fraction = delaySamples - whole;
    const oneMinus = 1 - fraction;
    const c0 = oneMinus * (2 - fraction) * (3 - fraction) / 6;
    const c1 = fraction * (2 - fraction) * (3 - fraction) / 2;
    const c2 = -fraction * oneMinus * (3 - fraction) / 2;
    const c3 = fraction * oneMinus * (2 - fraction) / 6;
    const length = buffer.length;
    let index = writeIndex - whole;
    index %= length;
    if (index < 0) index += length;
    const x0 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const x1 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const x2 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const x3 = buffer[index] ?? 0;
    return c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3;
  }
  var BrowserModDelayDsp = class {
    sampleRate;
    buffers;
    writeIndices = new Int32Array(2);
    feedbackFilter = new Float64Array(2);
    rateHz;
    timeMs;
    depthMs;
    feedbackPercent;
    parameterRampFrames;
    feedbackToneAlpha;
    phase = 0;
    outputLeft = 0;
    outputRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp4(sampleRate, MIN_SAMPLE_RATE2, MAX_SAMPLE_RATE2) : 48e3;
      const capacity = Math.ceil((MAX_TIME_MS + MAX_DEPTH_MS) * this.sampleRate / 1e3) + 8;
      this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
      this.rateHz = new LinearParameterSmoother(clamp4(parameters.rateHz ?? 0.3, MIN_RATE_HZ, MAX_RATE_HZ));
      this.timeMs = new LinearParameterSmoother(clamp4(parameters.timeMs ?? 500, MIN_TIME_MS, MAX_TIME_MS));
      this.depthMs = new LinearParameterSmoother(clamp4(parameters.depthMs ?? 10, 0, MAX_DEPTH_MS));
      this.feedbackPercent = new LinearParameterSmoother(clamp4(parameters.feedbackPercent ?? 25, 0, MAX_FEEDBACK_PERCENT));
      this.parameterRampFrames = Math.max(1, Math.round(this.sampleRate * PARAMETER_SMOOTHING_SECONDS2));
      const feedbackCutoff = Math.min(8e3, this.sampleRate * 0.45);
      this.feedbackToneAlpha = 1 - Math.exp(-TWO_PI2 * feedbackCutoff / this.sampleRate);
    }
    get wetLeft() {
      return this.outputLeft;
    }
    get wetRight() {
      return this.outputRight;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.timeMs)) {
        this.timeMs.setTarget(clamp4(parameters.timeMs, MIN_TIME_MS, MAX_TIME_MS), this.parameterRampFrames);
      }
      if (Number.isFinite(parameters.rateHz)) {
        this.rateHz.setTarget(clamp4(parameters.rateHz, MIN_RATE_HZ, MAX_RATE_HZ), this.parameterRampFrames);
      }
      if (Number.isFinite(parameters.depthMs)) {
        this.depthMs.setTarget(clamp4(parameters.depthMs, 0, MAX_DEPTH_MS), this.parameterRampFrames);
      }
      if (Number.isFinite(parameters.feedbackPercent)) {
        this.feedbackPercent.setTarget(clamp4(parameters.feedbackPercent, 0, MAX_FEEDBACK_PERCENT), this.parameterRampFrames);
      }
    }
    processSample(inputLeft, inputRight) {
      const rate = clamp4(this.rateHz.next(), MIN_RATE_HZ, MAX_RATE_HZ);
      const timeMs = clamp4(this.timeMs.next(), MIN_TIME_MS, MAX_TIME_MS);
      const requestedDepthMs = clamp4(this.depthMs.next(), 0, MAX_DEPTH_MS);
      const depthMs = Math.min(requestedDepthMs, timeMs - MIN_TIME_MS, MAX_TIME_MS + MAX_DEPTH_MS - timeMs);
      const feedback = clamp4(this.feedbackPercent.next(), 0, MAX_FEEDBACK_PERCENT) * 0.01 * FEEDBACK_STABILITY_SCALE2;
      this.outputLeft = this.processChannel(inputLeft, 0, this.phase, timeMs, depthMs, feedback);
      this.outputRight = this.processChannel(inputRight, 1, this.phase + Math.PI * 0.5, timeMs, depthMs, feedback);
      this.phase += TWO_PI2 * rate / this.sampleRate;
      if (this.phase >= TWO_PI2) this.phase -= TWO_PI2;
    }
    processBlock(inputLeft, inputRight, outputLeft, outputRight, frameCount) {
      let frames = Math.min(inputLeft.length, outputLeft.length);
      if (inputRight) frames = Math.min(frames, inputRight.length);
      if (outputRight) frames = Math.min(frames, outputRight.length);
      if (frameCount !== void 0 && Number.isFinite(frameCount)) {
        frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));
      }
      for (let frame = 0; frame < frames; frame += 1) {
        const left = inputLeft[frame] ?? 0;
        const right = inputRight ? inputRight[frame] ?? 0 : left;
        this.processSample(left, right);
        if (outputLeft) outputLeft[frame] = this.outputLeft;
        if (outputRight) outputRight[frame] = this.outputRight;
      }
    }
    reset() {
      this.buffers[0].fill(0);
      this.buffers[1].fill(0);
      this.writeIndices.fill(0);
      this.feedbackFilter.fill(0);
      this.phase = 0;
      this.rateHz.reset();
      this.timeMs.reset();
      this.depthMs.reset();
      this.feedbackPercent.reset();
      this.outputLeft = 0;
      this.outputRight = 0;
    }
    processChannel(input, channel, phase, timeMs, depthMs, feedback) {
      const buffer = this.buffers[channel];
      const writeIndex = this.writeIndices[channel] ?? 0;
      const delayMs = clamp4(timeMs + depthMs * Math.sin(phase), MIN_TIME_MS, MAX_TIME_MS + MAX_DEPTH_MS);
      const delaySamples = clamp4(delayMs * this.sampleRate / 1e3, 2, buffer.length - 6);
      const delayed = readLagrange(buffer, writeIndex, delaySamples);
      const previousFiltered = this.feedbackFilter[channel] ?? 0;
      const filtered = previousFiltered + this.feedbackToneAlpha * (delayed - previousFiltered);
      this.feedbackFilter[channel] = Number.isFinite(filtered) ? filtered : 0;
      buffer[writeIndex] = finiteBounded2(finiteBounded2(input) + feedback * Math.tanh(filtered));
      this.writeIndices[channel] = writeIndex + 1 >= buffer.length ? 0 : writeIndex + 1;
      return finiteBounded2(delayed);
    }
  };

  // src/audio/fx/dsp/BrowserTapeEchoDsp.ts
  var TWO_PI3 = Math.PI * 2;
  var MIN_SAMPLE_RATE3 = 8e3;
  var MAX_SAMPLE_RATE3 = 192e3;
  var MAX_INPUT_MAGNITUDE2 = 8;
  var MAX_WOW_FRACTION = 4e-3;
  var WOW_RATE_HZ = 0.63;
  var FLUTTER_RATE_HZ = 6.1;
  var PARAMETER_SMOOTHING_SECONDS3 = 0.015;
  var HEAD_WEIGHTS_1 = 0.55;
  var HEAD_WEIGHTS_2 = 0.3;
  var HEAD_WEIGHTS_3 = 0.15;
  var FEEDBACK_STABILITY_SCALE3 = 0.78;
  var HISS_AMPLITUDE = 8e-5;
  var LOG_TWO = Math.LN2;
  var TIME2 = 0;
  var FEEDBACK2 = 1;
  var WOW = 2;
  var SATURATION = 3;
  var TONE_ALPHA = 4;
  var MIX2 = 5;
  function clamp5(value, minimum, maximum) {
    if (value !== 0 && value >= minimum && value <= maximum) return value;
    return Math.min(maximum, Math.max(minimum, value));
  }
  function finiteBounded3(value, maximumMagnitude) {
    return Number.isFinite(value) ? clamp5(value, -maximumMagnitude, maximumMagnitude) : 0;
  }
  function coefficientForTone(toneHz, sampleRate) {
    const cutoff = clamp5(toneHz, 500, Math.min(16e3, sampleRate * 0.45));
    return 1 - Math.exp(-TWO_PI3 * cutoff / sampleRate);
  }
  var BrowserTapeEchoDsp = class {
    sampleRate;
    buffers;
    writeIndices = new Int32Array(2);
    phases = new Float64Array(4);
    feedbackToneStates = new Float64Array(2);
    reproToneStates = new Float64Array(2);
    previousRecordInputs = new Float64Array(2);
    previousAdAaInputs = new Float64Array(2);
    previousPrimitive = new Float64Array(2);
    primitiveSaturation = new Float64Array([Number.NaN, Number.NaN]);
    primitiveValid = new Uint8Array(2);
    hissLowStates = new Float64Array(2);
    hissBandStates = new Float64Array(2);
    randomStates = new Uint32Array(2);
    current = new Float64Array(6);
    target = new Float64Array(6);
    smoothingCoefficient;
    wowPhaseIncrement;
    flutterPhaseIncrement;
    hissLowAlpha;
    hissHighAlpha;
    lastDryLeft = 0;
    lastDryRight = 0;
    lastWetLeft = 0;
    lastWetRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp5(sampleRate, MIN_SAMPLE_RATE3, MAX_SAMPLE_RATE3) : 48e3;
      const capacity = Math.ceil(
        3 * 2e3 * (1 + MAX_WOW_FRACTION) * this.sampleRate / 1e3
      ) + 8;
      this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
      this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS3 * this.sampleRate));
      this.wowPhaseIncrement = TWO_PI3 * WOW_RATE_HZ / this.sampleRate;
      this.flutterPhaseIncrement = TWO_PI3 * FLUTTER_RATE_HZ / this.sampleRate;
      this.hissLowAlpha = 1 - Math.exp(-TWO_PI3 * 350 / this.sampleRate);
      this.hissHighAlpha = 1 - Math.exp(-TWO_PI3 * Math.min(12e3, this.sampleRate * 0.45) / this.sampleRate);
      const initialTime = Number.isFinite(parameters.timeMs) ? clamp5(parameters.timeMs, 20, 2e3) : 350;
      const initialFeedback = Number.isFinite(parameters.feedback) ? clamp5(parameters.feedback, 0, 95) : 35;
      const initialWow = Number.isFinite(parameters.wow) ? clamp5(parameters.wow, 0, 100) : 15;
      const initialSaturation = Number.isFinite(parameters.saturation) ? clamp5(parameters.saturation, 0, 100) : 25;
      const initialTone = Number.isFinite(parameters.toneHz) ? clamp5(parameters.toneHz, 500, 16e3) : 6e3;
      const initialMix = Number.isFinite(parameters.mix) ? clamp5(parameters.mix, 0, 100) : 30;
      this.current[TIME2] = this.target[TIME2] = initialTime;
      this.current[FEEDBACK2] = this.target[FEEDBACK2] = initialFeedback;
      this.current[WOW] = this.target[WOW] = initialWow;
      this.current[SATURATION] = this.target[SATURATION] = initialSaturation;
      this.current[TONE_ALPHA] = this.target[TONE_ALPHA] = coefficientForTone(initialTone, this.sampleRate);
      this.current[MIX2] = this.target[MIX2] = initialMix;
      this.randomStates[0] = 324508639;
      this.randomStates[1] = 610839777;
      this.phases[0] = 0;
      this.phases[1] = Math.PI * 0.23;
      this.phases[2] = Math.PI * 0.37;
      this.phases[3] = Math.PI * 0.71;
    }
    /** Update smoothed targets; invalid individual controls are ignored. */
    setParameters(parameters) {
      if (Number.isFinite(parameters.timeMs)) this.target[TIME2] = clamp5(parameters.timeMs, 20, 2e3);
      if (Number.isFinite(parameters.feedback)) this.target[FEEDBACK2] = clamp5(parameters.feedback, 0, 95);
      if (Number.isFinite(parameters.wow)) this.target[WOW] = clamp5(parameters.wow, 0, 100);
      if (Number.isFinite(parameters.saturation)) this.target[SATURATION] = clamp5(parameters.saturation, 0, 100);
      if (Number.isFinite(parameters.toneHz)) this.target[TONE_ALPHA] = coefficientForTone(parameters.toneHz, this.sampleRate);
      if (Number.isFinite(parameters.mix)) this.target[MIX2] = clamp5(parameters.mix, 0, 100);
    }
    /** Clear delay and filter history while retaining parameter targets. */
    reset() {
      this.buffers[0].fill(0);
      this.buffers[1].fill(0);
      this.writeIndices.fill(0);
      this.feedbackToneStates.fill(0);
      this.reproToneStates.fill(0);
      this.previousRecordInputs.fill(0);
      this.previousAdAaInputs.fill(0);
      this.previousPrimitive.fill(0);
      this.primitiveValid.fill(0);
      this.hissLowStates.fill(0);
      this.hissBandStates.fill(0);
      this.phases[0] = 0;
      this.phases[1] = Math.PI * 0.23;
      this.phases[2] = Math.PI * 0.37;
      this.phases[3] = Math.PI * 0.71;
      this.randomStates[0] = 324508639;
      this.randomStates[1] = 610839777;
      this.lastDryLeft = 0;
      this.lastDryRight = 0;
      this.lastWetLeft = 0;
      this.lastWetRight = 0;
      for (let index = 0; index < this.current.length; index += 1) this.current[index] = this.target[index] ?? 0;
    }
    /**
     * Process one frame and expose the colored echo signal without dry/wet mix.
     * The returned wet sample is read via `wetOutputLeft` / `wetOutputRight`.
     */
    processSample(inputLeft, inputRight) {
      this.processFrameSample(inputLeft, inputRight);
    }
    /** Last wet-only output from processSample() or the most recent block frame. */
    get wetOutputLeft() {
      return this.lastWetLeft;
    }
    /** Last wet-only right output from processSample() or the most recent block frame. */
    get wetOutputRight() {
      return this.lastWetRight;
    }
    /**
     * Process planar audio. The loop has no block-size assumptions and contains
     * no typed audio-buffer allocations; caller arrays may alias their outputs.
     */
    processBlock(inputLeft, inputRight, outputLeft, outputRight, frameCount) {
      let frames = Math.min(inputLeft.length, outputLeft.length);
      if (inputRight !== null) frames = Math.min(frames, inputRight.length);
      if (outputRight !== null) frames = Math.min(frames, outputRight.length);
      if (frameCount !== void 0 && Number.isFinite(frameCount)) frames = Math.min(frames, Math.max(0, Math.floor(frameCount)));
      for (let frame = 0; frame < frames; frame += 1) {
        this.processFrameSample(inputLeft[frame] ?? 0, inputRight === null ? inputLeft[frame] ?? 0 : inputRight[frame] ?? 0);
        const mix = (this.current[MIX2] ?? 0) * 0.01;
        outputLeft[frame] = finiteBounded3(this.lastDryLeft * (1 - mix) + this.lastWetLeft * mix, MAX_INPUT_MAGNITUDE2);
        if (outputRight !== null) {
          outputRight[frame] = finiteBounded3(this.lastDryRight * (1 - mix) + this.lastWetRight * mix, MAX_INPUT_MAGNITUDE2);
        }
      }
    }
    processFrameSample(inputLeft, inputRight) {
      this.current[TIME2] = (this.current[TIME2] ?? 0) + this.smoothingCoefficient * ((this.target[TIME2] ?? 0) - (this.current[TIME2] ?? 0));
      this.current[FEEDBACK2] = (this.current[FEEDBACK2] ?? 0) + this.smoothingCoefficient * ((this.target[FEEDBACK2] ?? 0) - (this.current[FEEDBACK2] ?? 0));
      this.current[WOW] = (this.current[WOW] ?? 0) + this.smoothingCoefficient * ((this.target[WOW] ?? 0) - (this.current[WOW] ?? 0));
      this.current[SATURATION] = (this.current[SATURATION] ?? 0) + this.smoothingCoefficient * ((this.target[SATURATION] ?? 0) - (this.current[SATURATION] ?? 0));
      this.current[TONE_ALPHA] = (this.current[TONE_ALPHA] ?? 0) + this.smoothingCoefficient * ((this.target[TONE_ALPHA] ?? 0) - (this.current[TONE_ALPHA] ?? 0));
      this.current[MIX2] = (this.current[MIX2] ?? 0) + this.smoothingCoefficient * ((this.target[MIX2] ?? 0) - (this.current[MIX2] ?? 0));
      const timeMs = this.current[TIME2] ?? 350;
      const feedback = (this.current[FEEDBACK2] ?? 0) * 0.01 * FEEDBACK_STABILITY_SCALE3;
      const wow = (this.current[WOW] ?? 0) * 0.01;
      const saturation = (this.current[SATURATION] ?? 0) * 0.01;
      const toneAlpha = this.current[TONE_ALPHA] ?? 0;
      const baseDelay = timeMs * this.sampleRate * 1e-3;
      const lfoLeft = 0.75 * Math.sin(this.phases[0] ?? 0) + 0.25 * Math.sin(this.phases[2] ?? 0);
      const lfoRight = 0.75 * Math.sin(this.phases[1] ?? 0) + 0.25 * Math.sin(this.phases[3] ?? 0);
      const dryLeft = finiteBounded3(inputLeft, MAX_INPUT_MAGNITUDE2);
      const dryRight = finiteBounded3(inputRight, MAX_INPUT_MAGNITUDE2);
      this.lastDryLeft = dryLeft;
      this.lastDryRight = dryRight;
      const writeLeft = this.writeIndices[0] ?? 0;
      const writeRight = this.writeIndices[1] ?? 0;
      const modulation1Left = baseDelay * MAX_WOW_FRACTION * wow * lfoLeft;
      const modulation1Right = baseDelay * MAX_WOW_FRACTION * wow * lfoRight;
      const head1Left = this.readFractional(this.buffers[0], writeLeft, baseDelay + modulation1Left);
      const head2Left = this.readFractional(this.buffers[0], writeLeft, 2 * baseDelay + 2 * modulation1Left);
      const head3Left = this.readFractional(this.buffers[0], writeLeft, 3 * baseDelay + 3 * modulation1Left);
      const head1Right = this.readFractional(this.buffers[1], writeRight, baseDelay + modulation1Right);
      const head2Right = this.readFractional(this.buffers[1], writeRight, 2 * baseDelay + 2 * modulation1Right);
      const head3Right = this.readFractional(this.buffers[1], writeRight, 3 * baseDelay + 3 * modulation1Right);
      let feedbackToneLeft = (this.feedbackToneStates[0] ?? 0) + toneAlpha * (head1Left - (this.feedbackToneStates[0] ?? 0));
      let feedbackToneRight = (this.feedbackToneStates[1] ?? 0) + toneAlpha * (head1Right - (this.feedbackToneStates[1] ?? 0));
      feedbackToneLeft = finiteBounded3(feedbackToneLeft, MAX_INPUT_MAGNITUDE2);
      feedbackToneRight = finiteBounded3(feedbackToneRight, MAX_INPUT_MAGNITUDE2);
      this.feedbackToneStates[0] = feedbackToneLeft;
      this.feedbackToneStates[1] = feedbackToneRight;
      this.buffers[0][writeLeft] = this.recordWithHiss(dryLeft + feedback * feedbackToneLeft, 0, saturation);
      this.buffers[1][writeRight] = this.recordWithHiss(dryRight + feedback * feedbackToneRight, 1, saturation);
      const rawWetLeft = HEAD_WEIGHTS_1 * head1Left + HEAD_WEIGHTS_2 * head2Left + HEAD_WEIGHTS_3 * head3Left;
      const rawWetRight = HEAD_WEIGHTS_1 * head1Right + HEAD_WEIGHTS_2 * head2Right + HEAD_WEIGHTS_3 * head3Right;
      let reproLeft = (this.reproToneStates[0] ?? 0) + toneAlpha * (rawWetLeft - (this.reproToneStates[0] ?? 0));
      let reproRight = (this.reproToneStates[1] ?? 0) + toneAlpha * (rawWetRight - (this.reproToneStates[1] ?? 0));
      reproLeft = finiteBounded3(reproLeft, MAX_INPUT_MAGNITUDE2);
      reproRight = finiteBounded3(reproRight, MAX_INPUT_MAGNITUDE2);
      this.reproToneStates[0] = reproLeft;
      this.reproToneStates[1] = reproRight;
      this.lastWetLeft = reproLeft;
      this.lastWetRight = reproRight;
      let nextWriteLeft = writeLeft + 1;
      let nextWriteRight = writeRight + 1;
      const capacity = this.buffers[0].length;
      if (nextWriteLeft >= capacity) nextWriteLeft = 0;
      if (nextWriteRight >= capacity) nextWriteRight = 0;
      this.writeIndices[0] = nextWriteLeft;
      this.writeIndices[1] = nextWriteRight;
      let wowLeft = (this.phases[0] ?? 0) + this.wowPhaseIncrement;
      let wowRight = (this.phases[1] ?? 0) + this.wowPhaseIncrement;
      let flutterLeft = (this.phases[2] ?? 0) + this.flutterPhaseIncrement;
      let flutterRight = (this.phases[3] ?? 0) + this.flutterPhaseIncrement;
      if (wowLeft >= TWO_PI3) wowLeft -= TWO_PI3;
      if (wowRight >= TWO_PI3) wowRight -= TWO_PI3;
      if (flutterLeft >= TWO_PI3) flutterLeft -= TWO_PI3;
      if (flutterRight >= TWO_PI3) flutterRight -= TWO_PI3;
      this.phases[0] = wowLeft;
      this.phases[1] = wowRight;
      this.phases[2] = flutterLeft;
      this.phases[3] = flutterRight;
    }
    readFractional(buffer, writeIndex, requestedDelay) {
      const delay = clamp5(requestedDelay, 2, buffer.length - 3);
      const integerDelay = Math.floor(delay);
      const fraction = delay - integerDelay;
      let indexMinus1 = writeIndex - integerDelay + 1;
      let index0 = writeIndex - integerDelay;
      let indexPlus1 = writeIndex - integerDelay - 1;
      let indexPlus2 = writeIndex - integerDelay - 2;
      if (indexMinus1 < 0) indexMinus1 += buffer.length;
      if (index0 < 0) index0 += buffer.length;
      if (indexPlus1 < 0) indexPlus1 += buffer.length;
      if (indexPlus2 < 0) indexPlus2 += buffer.length;
      const hMinus1 = -(fraction * (fraction - 1) * (fraction - 2)) / 6;
      const h0 = (fraction + 1) * (fraction - 1) * (fraction - 2) / 2;
      const hPlus1 = -((fraction + 1) * fraction * (fraction - 2)) / 2;
      const hPlus2 = (fraction + 1) * fraction * (fraction - 1) / 6;
      return hMinus1 * (buffer[indexMinus1] ?? 0) + h0 * (buffer[index0] ?? 0) + hPlus1 * (buffer[indexPlus1] ?? 0) + hPlus2 * (buffer[indexPlus2] ?? 0);
    }
    recordWithHiss(input, channel, saturation) {
      const white = this.nextNoise(channel);
      const lowState = (this.hissLowStates[channel] ?? 0) + this.hissLowAlpha * (white - (this.hissLowStates[channel] ?? 0));
      this.hissLowStates[channel] = lowState;
      const highPassed = white - lowState;
      const bandState = (this.hissBandStates[channel] ?? 0) + this.hissHighAlpha * (highPassed - (this.hissBandStates[channel] ?? 0));
      this.hissBandStates[channel] = bandState;
      const boundedInput = finiteBounded3(input + bandState * HISS_AMPLITUDE, MAX_INPUT_MAGNITUDE2);
      if (saturation <= 1e-6) {
        this.primitiveValid[channel] = 0;
        this.previousRecordInputs[channel] = boundedInput;
        this.previousAdAaInputs[channel] = boundedInput;
        return boundedInput;
      }
      const previous = this.previousRecordInputs[channel] ?? 0;
      const midpoint = 0.5 * (previous + boundedInput);
      const midpointSaturated = this.adaa(midpoint, channel, saturation);
      const currentSaturated = this.adaa(boundedInput, channel, saturation);
      this.previousRecordInputs[channel] = boundedInput;
      return finiteBounded3(0.5 * (midpointSaturated + currentSaturated), MAX_INPUT_MAGNITUDE2);
    }
    adaa(input, channel, saturation) {
      const previous = this.previousAdAaInputs[channel] ?? 0;
      const delta = input - previous;
      this.previousAdAaInputs[channel] = input;
      if (Math.abs(delta) < 1e-5) {
        this.primitiveValid[channel] = 0;
        return this.softSaturator(0.5 * (input + previous), saturation);
      }
      const currentPrimitive = this.saturationPrimitive(input, saturation);
      const previousPrimitive = this.primitiveValid[channel] && this.primitiveSaturation[channel] === saturation ? this.previousPrimitive[channel] : this.saturationPrimitive(previous, saturation);
      this.previousPrimitive[channel] = currentPrimitive;
      this.primitiveSaturation[channel] = saturation;
      this.primitiveValid[channel] = 1;
      return (currentPrimitive - previousPrimitive) / delta;
    }
    softSaturator(input, saturation) {
      if (saturation <= 1e-6) return input;
      const drive = 1 + 7 * saturation;
      return (1 - saturation) * input + saturation * Math.tanh(drive * input) / drive;
    }
    saturationPrimitive(input, saturation) {
      if (saturation <= 1e-6) return 0.5 * input * input;
      const drive = 1 + 7 * saturation;
      const magnitude = Math.abs(drive * input);
      const logCosh4 = magnitude + Math.log1p(Math.exp(-2 * magnitude)) - LOG_TWO;
      return 0.5 * (1 - saturation) * input * input + saturation * logCosh4 / (drive * drive);
    }
    nextNoise(channel) {
      let state = this.randomStates[channel] ?? 1;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      this.randomStates[channel] = state;
      return state / 2147483647 - 1;
    }
  };

  // src/audio/fx/dsp/BrowserTwistDsp.ts
  var TWO_PI4 = Math.PI * 2;
  var MAX_SAMPLE_RATE4 = 192e3;
  var MAX_DELAY_MS2 = 300;
  var MIN_DELAY_MS2 = 30;
  var CENTER_DELAY_MS = 120;
  var PARAMETER_SMOOTHING_SECONDS4 = 0.02;
  var MAX_INPUT_MAGNITUDE3 = 8;
  var FEEDBACK_STABILITY_MARGIN = 0.72;
  var TABLE_POINTS = 1024;
  var TABLE_STRIDE = 5;
  function clamp6(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function finiteBounded4(value, maxMagnitude) {
    return Number.isFinite(value) ? clamp6(value, -maxMagnitude, maxMagnitude) : 0;
  }
  function transfer(amount, trajectory) {
    const magnitude = Math.abs(amount);
    let shaped;
    switch (trajectory) {
      case 1:
        shaped = Math.sqrt(magnitude);
        break;
      // quick initial rise, then eases
      case 2:
        shaped = magnitude * magnitude;
        break;
      // eases in, then falls faster
      case 3:
        shaped = Math.round(magnitude * 8) / 8;
        break;
      default:
        shaped = magnitude * magnitude * (3 - 2 * magnitude);
        break;
    }
    return Math.sign(amount) * shaped;
  }
  var BrowserTwistDsp = class {
    sampleRate;
    buffers;
    /** Four precomputed trajectory tables, each with TABLE_POINTS + endpoint. */
    trajectories;
    writeFrame = 0;
    feedbackFilter = new Float64Array(2);
    smoothingCoefficient;
    amountCurrent = 0;
    amountTarget = 0;
    trajectoryCurrent = 0;
    trajectoryTarget = 0;
    lastWetLeft = 0;
    lastWetRight = 0;
    lastDelayMs = CENTER_DELAY_MS;
    lastFeedback = 0.16;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp6(sampleRate, 8e3, MAX_SAMPLE_RATE4) : 48e3;
      const capacity = Math.ceil(MAX_DELAY_MS2 * this.sampleRate / 1e3) + 8;
      this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
      this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS4 * this.sampleRate));
      this.trajectories = [
        new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
        new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
        new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE),
        new Float32Array((TABLE_POINTS + 1) * TABLE_STRIDE)
      ];
      this.buildTrajectoryTables();
      this.setParameters(parameters);
      this.amountCurrent = this.amountTarget;
      this.trajectoryCurrent = this.trajectoryTarget;
    }
    buildTrajectoryTables() {
      for (let mode = 0; mode < this.trajectories.length; mode += 1) {
        const table = this.trajectories[mode];
        for (let point = 0; point <= TABLE_POINTS; point += 1) {
          const magnitude = point / TABLE_POINTS;
          const mappedMagnitude = transfer(magnitude, mode);
          const positiveDelay = CENTER_DELAY_MS * Math.pow(MIN_DELAY_MS2 / CENTER_DELAY_MS, mappedMagnitude);
          const negativeDelay = CENTER_DELAY_MS * Math.pow(MAX_DELAY_MS2 / CENTER_DELAY_MS, mappedMagnitude);
          const feedback = 0.16 + 0.66 * Math.pow(mappedMagnitude, 1.15);
          const cutoffHz = 7800 * Math.pow(0.1, mappedMagnitude);
          const alpha = 1 - Math.exp(-TWO_PI4 * Math.min(cutoffHz, this.sampleRate * 0.45) / this.sampleRate);
          const offset = point * TABLE_STRIDE;
          table[offset] = mappedMagnitude;
          table[offset + 1] = positiveDelay;
          table[offset + 2] = negativeDelay;
          table[offset + 3] = feedback;
          table[offset + 4] = alpha;
        }
      }
    }
    /** Update bounded smoothed targets; discrete trajectory changes are also smoothed. */
    setParameters(parameters) {
      if (Number.isFinite(parameters.amount)) this.amountTarget = clamp6(parameters.amount, -100, 100);
      if (Number.isFinite(parameters.trajectory)) this.trajectoryTarget = Math.round(clamp6(parameters.trajectory, 0, 3));
    }
    /** Process one stereo frame and expose wet-only samples through the getters. */
    processSample(inputLeft, inputRight) {
      this.amountCurrent += this.smoothingCoefficient * (this.amountTarget - this.amountCurrent);
      this.trajectoryCurrent += this.smoothingCoefficient * (this.trajectoryTarget - this.trajectoryCurrent);
      const signedMacro = clamp6(this.amountCurrent / 100, -1, 1);
      const tablePosition = Math.abs(signedMacro) * TABLE_POINTS;
      const point = Math.min(TABLE_POINTS - 1, Math.floor(tablePosition));
      const fraction = tablePosition - point;
      const modeA = Math.floor(this.trajectoryCurrent);
      const modeB = Math.min(3, modeA + 1);
      const modeBlend = this.trajectoryCurrent - modeA;
      const tableA = this.trajectories[modeA];
      const tableB = this.trajectories[modeB];
      const offset0 = point * TABLE_STRIDE;
      const offset1 = (point + 1) * TABLE_STRIDE;
      let mappedMagnitude = 0;
      let positiveDelayMs = CENTER_DELAY_MS;
      let negativeDelayMs = CENTER_DELAY_MS;
      let feedback = 0.16;
      let alpha = 0.5;
      for (let control = 0; control < TABLE_STRIDE; control += 1) {
        const a0 = tableA[offset0 + control] ?? 0;
        const a1 = tableA[offset1 + control] ?? 0;
        const b0 = tableB[offset0 + control] ?? a0;
        const b1 = tableB[offset1 + control] ?? a1;
        const curveA = a0 + (a1 - a0) * fraction;
        const curveB = b0 + (b1 - b0) * fraction;
        const value = curveA + (curveB - curveA) * modeBlend;
        if (control === 0) mappedMagnitude = value;
        else if (control === 1) positiveDelayMs = value;
        else if (control === 2) negativeDelayMs = value;
        else if (control === 3) feedback = value;
        else if (control === 4) alpha = value;
      }
      const mapped = signedMacro < 0 ? -mappedMagnitude : mappedMagnitude;
      const delayMs = signedMacro < 0 ? negativeDelayMs : positiveDelayMs;
      const delayFrames = clamp6(delayMs * this.sampleRate / 1e3, 4, this.buffers[0].length - 3);
      const delay = Math.floor(delayFrames);
      const fractionDelay = delayFrames - delay;
      const dryLeft = finiteBounded4(inputLeft, MAX_INPUT_MAGNITUDE3);
      const dryRight = finiteBounded4(inputRight, MAX_INPUT_MAGNITUDE3);
      const delayedLeft = this.readFractional(this.buffers[0], delay, fractionDelay);
      const delayedRight = this.readFractional(this.buffers[1], delay, fractionDelay);
      const leftFeedbackState = this.feedbackFilter[0] ?? 0;
      const rightFeedbackState = this.feedbackFilter[1] ?? 0;
      const leftFilter = leftFeedbackState + alpha * (delayedLeft - leftFeedbackState);
      const rightFilter = rightFeedbackState + alpha * (delayedRight - rightFeedbackState);
      this.feedbackFilter[0] = finiteBounded4(leftFilter, MAX_INPUT_MAGNITUDE3);
      this.feedbackFilter[1] = finiteBounded4(rightFilter, MAX_INPUT_MAGNITUDE3);
      const boundedFeedback = clamp6(feedback, 0, 0.84) * FEEDBACK_STABILITY_MARGIN;
      const writeLeft = dryLeft + boundedFeedback * Math.tanh(this.feedbackFilter[0] * 1.5);
      const writeRight = dryRight + boundedFeedback * Math.tanh(this.feedbackFilter[1] * 1.5);
      const capacity = this.buffers[0].length;
      const writeIndex = this.writeFrame;
      this.buffers[0][writeIndex] = finiteBounded4(writeLeft, MAX_INPUT_MAGNITUDE3);
      this.buffers[1][writeIndex] = finiteBounded4(writeRight, MAX_INPUT_MAGNITUDE3);
      this.writeFrame = writeIndex + 1 === capacity ? 0 : writeIndex + 1;
      const pan = clamp6(mapped, -1, 1);
      const leftGain = pan > 0 ? Math.cos(pan * Math.PI * 0.5) : 1;
      const rightGain = pan < 0 ? Math.cos(-pan * Math.PI * 0.5) : 1;
      this.lastWetLeft = finiteBounded4(this.feedbackFilter[0] * leftGain, MAX_INPUT_MAGNITUDE3);
      this.lastWetRight = finiteBounded4(this.feedbackFilter[1] * rightGain, MAX_INPUT_MAGNITUDE3);
      this.lastDelayMs = delayMs;
      this.lastFeedback = boundedFeedback;
    }
    readFractional(buffer, delay, fraction) {
      const capacity = buffer.length;
      const indexMinus1 = (this.writeFrame - delay + 1 + capacity) % capacity;
      const index0 = (this.writeFrame - delay + capacity) % capacity;
      const indexPlus1 = (this.writeFrame - delay - 1 + capacity) % capacity;
      const indexPlus2 = (this.writeFrame - delay - 2 + capacity) % capacity;
      return lagrange4(
        buffer[indexMinus1] ?? 0,
        buffer[index0] ?? 0,
        buffer[indexPlus1] ?? 0,
        buffer[indexPlus2] ?? 0,
        fraction
      );
    }
    get wetOutputLeft() {
      return this.lastWetLeft;
    }
    get wetOutputRight() {
      return this.lastWetRight;
    }
    /** Read-only test/diagnostic values; these do not change DSP state. */
    get currentDelayMs() {
      return this.lastDelayMs;
    }
    get currentFeedbackGain() {
      return this.lastFeedback;
    }
    reset() {
      this.buffers[0].fill(0);
      this.buffers[1].fill(0);
      this.writeFrame = 0;
      this.feedbackFilter.fill(0);
      this.lastWetLeft = 0;
      this.lastWetRight = 0;
      this.amountCurrent = this.amountTarget;
      this.trajectoryCurrent = this.trajectoryTarget;
      this.lastDelayMs = CENTER_DELAY_MS;
      this.lastFeedback = 0.16;
    }
  };
  function lagrange4(xMinus1, x0, xPlus1, xPlus2, fraction) {
    const mu = clamp6(fraction, 0, 1);
    const cMinus1 = -mu * (mu - 1) * (mu - 2) / 6;
    const c0 = (mu + 1) * (mu - 1) * (mu - 2) / 2;
    const cPlus1 = -(mu + 1) * mu * (mu - 2) / 2;
    const cPlus2 = (mu + 1) * mu * (mu - 1) / 6;
    return xMinus1 * cMinus1 + x0 * c0 + xPlus1 * cPlus1 + xPlus2 * cPlus2;
  }

  // src/audio/fx/dsp/BrowserGranularDelayDsp.ts
  var MIN_SAMPLE_RATE4 = 8e3;
  var MAX_SAMPLE_RATE5 = 192e3;
  var MIN_GRAIN_MS = 10;
  var MAX_GRAIN_MS = 1e3;
  var MIN_DENSITY_HZ = 1;
  var MAX_DENSITY_HZ = 80;
  var MAX_PITCH_SEMITONES = 24;
  var MAX_JITTER_FRACTION = 0.25;
  var MAX_FEEDBACK_PERCENT2 = 95;
  var FEEDBACK_STABILITY_SCALE4 = 0.75;
  var MAX_SAMPLE_MAGNITUDE2 = 8;
  var PARAMETER_SMOOTHING_SECONDS5 = 0.015;
  var GRAIN_VOICE_COUNT = 16;
  var WINDOW_TABLE_LENGTH = 2049;
  var SAFE_READ_MARGIN_SAMPLES = 4;
  var TWO_PI5 = Math.PI * 2;
  var GRAIN_SIZE = 0;
  var DENSITY = 1;
  var PITCH = 2;
  var JITTER = 3;
  var FEEDBACK3 = 4;
  function clamp7(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }
  function finiteBounded5(value, maximumMagnitude = MAX_SAMPLE_MAGNITUDE2) {
    return Number.isFinite(value) ? clamp7(value, -maximumMagnitude, maximumMagnitude) : 0;
  }
  function positiveModulo(value, modulus) {
    const result = value % modulus;
    return result < 0 ? result + modulus : result;
  }
  function readLagrange2(buffer, position) {
    const whole = Math.floor(position);
    const fraction = position - whole;
    const fMinusOne = fraction - 1;
    const fMinusTwo = fraction - 2;
    const fPlusOne = fraction + 1;
    const coefficientMinusOne = -(fraction * fMinusOne * fMinusTwo) / 6;
    const coefficientZero = fPlusOne * fMinusOne * fMinusTwo / 2;
    const coefficientPlusOne = -(fPlusOne * fraction * fMinusTwo) / 2;
    const coefficientPlusTwo = fPlusOne * fraction * fMinusOne / 6;
    const length = buffer.length;
    const minusOne = buffer[positiveModulo(whole - 1, length)] ?? 0;
    const zero = buffer[positiveModulo(whole, length)] ?? 0;
    const plusOne = buffer[positiveModulo(whole + 1, length)] ?? 0;
    const plusTwo = buffer[positiveModulo(whole + 2, length)] ?? 0;
    return coefficientMinusOne * minusOne + coefficientZero * zero + coefficientPlusOne * plusOne + coefficientPlusTwo * plusTwo;
  }
  var BrowserGranularDelayDsp = class {
    sampleRate;
    buffers;
    windowTable;
    ageFrames = new Int32Array(GRAIN_VOICE_COUNT);
    lengthFrames = new Int32Array(GRAIN_VOICE_COUNT);
    sourcePositions = new Float64Array(GRAIN_VOICE_COUNT);
    playbackRates = new Float64Array(GRAIN_VOICE_COUNT);
    current = new Float64Array(5);
    target = new Float64Array(5);
    smoothingCoefficient;
    frameCounter = 0;
    spawnPhase = 1;
    nextVoice = 0;
    randomState = 1831565813;
    lastWetLeft = 0;
    lastWetRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp7(sampleRate, MIN_SAMPLE_RATE4, MAX_SAMPLE_RATE5) : 48e3;
      const historyCapacity = Math.ceil(4500 * this.sampleRate / 1e3) + 16;
      this.buffers = [new Float32Array(historyCapacity), new Float32Array(historyCapacity)];
      this.windowTable = new Float32Array(WINDOW_TABLE_LENGTH);
      for (let index = 0; index < WINDOW_TABLE_LENGTH; index += 1) {
        const phase = index / (WINDOW_TABLE_LENGTH - 1);
        this.windowTable[index] = 0.5 - 0.5 * Math.cos(TWO_PI5 * phase);
      }
      this.smoothingCoefficient = 1 - Math.exp(-1 / (PARAMETER_SMOOTHING_SECONDS5 * this.sampleRate));
      const grainSizeMs = Number.isFinite(parameters.grainSizeMs) ? clamp7(parameters.grainSizeMs, MIN_GRAIN_MS, MAX_GRAIN_MS) : 120;
      const densityHz = Number.isFinite(parameters.densityHz) ? clamp7(parameters.densityHz, MIN_DENSITY_HZ, MAX_DENSITY_HZ) : 12;
      const pitchSemitones = Number.isFinite(parameters.pitchSemitones) ? clamp7(parameters.pitchSemitones, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES) : 0;
      const positionJitterPercent = Number.isFinite(parameters.positionJitterPercent) ? clamp7(parameters.positionJitterPercent, 0, 100) : 15;
      const feedbackPercent = Number.isFinite(parameters.feedbackPercent) ? clamp7(parameters.feedbackPercent, 0, MAX_FEEDBACK_PERCENT2) : 15;
      this.current[GRAIN_SIZE] = this.target[GRAIN_SIZE] = grainSizeMs;
      this.current[DENSITY] = this.target[DENSITY] = densityHz;
      this.current[PITCH] = this.target[PITCH] = pitchSemitones;
      this.current[JITTER] = this.target[JITTER] = positionJitterPercent;
      this.current[FEEDBACK3] = this.target[FEEDBACK3] = feedbackPercent;
    }
    /** Change grain controls with short smoothing; invalid controls are ignored. */
    setParameters(parameters) {
      if (Number.isFinite(parameters.grainSizeMs)) this.target[GRAIN_SIZE] = clamp7(parameters.grainSizeMs, MIN_GRAIN_MS, MAX_GRAIN_MS);
      if (Number.isFinite(parameters.densityHz)) this.target[DENSITY] = clamp7(parameters.densityHz, MIN_DENSITY_HZ, MAX_DENSITY_HZ);
      if (Number.isFinite(parameters.pitchSemitones)) this.target[PITCH] = clamp7(parameters.pitchSemitones, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES);
      if (Number.isFinite(parameters.positionJitterPercent)) this.target[JITTER] = clamp7(parameters.positionJitterPercent, 0, 100);
      if (Number.isFinite(parameters.feedbackPercent)) this.target[FEEDBACK3] = clamp7(parameters.feedbackPercent, 0, MAX_FEEDBACK_PERCENT2);
    }
    /** Clear all grain/history state and reset deterministic trigger scheduling. */
    reset() {
      this.buffers[0].fill(0);
      this.buffers[1].fill(0);
      this.ageFrames.fill(0);
      this.lengthFrames.fill(0);
      this.sourcePositions.fill(0);
      this.playbackRates.fill(0);
      this.frameCounter = 0;
      this.spawnPhase = 1;
      this.nextVoice = 0;
      this.randomState = 1831565813;
      this.lastWetLeft = 0;
      this.lastWetRight = 0;
      for (let index = 0; index < this.current.length; index += 1) this.current[index] = this.target[index] ?? 0;
    }
    /** Process one stereo frame; output is read from wetOutputLeft/Right. */
    processSample(inputLeft, inputRight) {
      this.current[GRAIN_SIZE] = (this.current[GRAIN_SIZE] ?? 120) + this.smoothingCoefficient * ((this.target[GRAIN_SIZE] ?? 120) - (this.current[GRAIN_SIZE] ?? 120));
      this.current[DENSITY] = (this.current[DENSITY] ?? 12) + this.smoothingCoefficient * ((this.target[DENSITY] ?? 12) - (this.current[DENSITY] ?? 12));
      this.current[PITCH] = (this.current[PITCH] ?? 0) + this.smoothingCoefficient * ((this.target[PITCH] ?? 0) - (this.current[PITCH] ?? 0));
      this.current[JITTER] = (this.current[JITTER] ?? 0) + this.smoothingCoefficient * ((this.target[JITTER] ?? 0) - (this.current[JITTER] ?? 0));
      this.current[FEEDBACK3] = (this.current[FEEDBACK3] ?? 0) + this.smoothingCoefficient * ((this.target[FEEDBACK3] ?? 0) - (this.current[FEEDBACK3] ?? 0));
      const dryLeft = finiteBounded5(inputLeft);
      const dryRight = finiteBounded5(inputRight);
      const historyIndex = this.frameCounter % this.buffers[0].length;
      const regeneration = (this.current[FEEDBACK3] ?? 0) * 0.01 * FEEDBACK_STABILITY_SCALE4;
      this.buffers[0][historyIndex] = finiteBounded5(dryLeft + regeneration * this.lastWetLeft);
      this.buffers[1][historyIndex] = finiteBounded5(dryRight + regeneration * this.lastWetRight);
      const densityHz = clamp7(this.current[DENSITY] ?? 12, MIN_DENSITY_HZ, MAX_DENSITY_HZ);
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
        const windowPosition = age / (length - 1) * (WINDOW_TABLE_LENGTH - 1);
        const tableIndex = Math.min(WINDOW_TABLE_LENGTH - 2, Math.floor(windowPosition));
        const fraction = windowPosition - tableIndex;
        const windowStart = this.windowTable[tableIndex] ?? 0;
        const windowEnd = this.windowTable[tableIndex + 1] ?? 0;
        const window = windowStart + (windowEnd - windowStart) * fraction;
        const sourcePosition = this.sourcePositions[voice] ?? 0;
        wetLeftSum += readLagrange2(this.buffers[0], sourcePosition) * window;
        wetRightSum += readLagrange2(this.buffers[1], sourcePosition) * window;
        windowSum += window;
        this.sourcePositions[voice] = sourcePosition + (this.playbackRates[voice] ?? 1);
        this.ageFrames[voice] = age + 1;
      }
      const normalization = windowSum > 1e-6 ? 1 / windowSum : 0;
      this.lastWetLeft = finiteBounded5(wetLeftSum * normalization);
      this.lastWetRight = finiteBounded5(wetRightSum * normalization);
      this.frameCounter += 1;
    }
    /** Process planar arrays without a fixed quantum or callback allocation. */
    processBlock(inputLeft, inputRight, outputLeft, outputRight, frameCount) {
      let frames = Math.min(inputLeft.length, outputLeft.length);
      if (inputRight !== null) frames = Math.min(frames, inputRight.length);
      if (outputRight !== null) frames = Math.min(frames, outputRight.length);
      if (frameCount !== void 0 && Number.isFinite(frameCount)) {
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
    get wetOutputLeft() {
      return this.lastWetLeft;
    }
    get wetOutputRight() {
      return this.lastWetRight;
    }
    startGrain() {
      const voice = this.nextVoice;
      this.nextVoice = voice + 1 >= GRAIN_VOICE_COUNT ? 0 : voice + 1;
      const requestedLength = Math.max(2, Math.round((this.current[GRAIN_SIZE] ?? 120) * this.sampleRate * 1e-3));
      const densityHz = clamp7(this.current[DENSITY] ?? 12, MIN_DENSITY_HZ, MAX_DENSITY_HZ);
      const periodFrames = this.sampleRate / densityHz;
      const maxLengthForVoiceBudget = Math.max(2, Math.floor(periodFrames * GRAIN_VOICE_COUNT) - 1);
      const length = Math.min(requestedLength, maxLengthForVoiceBudget);
      const pitch = clamp7(this.current[PITCH] ?? 0, -MAX_PITCH_SEMITONES, MAX_PITCH_SEMITONES);
      const playbackRate = Math.pow(2, pitch / 12);
      const jitter = clamp7(this.current[JITTER] ?? 0, 0, 100) * 0.01 * MAX_JITTER_FRACTION * length;
      const sourceAge = Math.max(1, playbackRate) * length + jitter + SAFE_READ_MARGIN_SAMPLES;
      const jitterOffset = (this.nextRandom() * 2 - 1) * jitter;
      this.ageFrames[voice] = 0;
      this.lengthFrames[voice] = length;
      this.sourcePositions[voice] = this.frameCounter - sourceAge + jitterOffset;
      this.playbackRates[voice] = playbackRate;
    }
    nextRandom() {
      let state = this.randomState;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      this.randomState = state >>> 0;
      return this.randomState / 4294967296;
    }
  };

  // src/audio/fx/dsp/BrowserRadioDsp.ts
  var TWO_PI6 = Math.PI * 2;
  var PARAM_SMOOTH_SECONDS = 0.015;
  var LEFT_SEED2 = 1380009009;
  var RIGHT_SEED2 = 1380009010;
  var BAND_HP = [420, 180, 45];
  var BAND_LP = [3200, 5200, 14500];
  var NOISE_ALPHA_HZ = 1900;
  function clamp8(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function logCosh(value) {
    const absolute = Math.abs(value);
    return absolute + Math.log1p(Math.exp(-2 * absolute)) - Math.LN2;
  }
  function adaaTanh(current, previous) {
    const difference = current - previous;
    if (Math.abs(difference) < 1e-8) return Math.tanh((current + previous) * 0.5);
    return (logCosh(current) - logCosh(previous)) / difference;
  }
  var BrowserRadioDsp = class {
    sampleRate;
    highpassLeft;
    highpassRight;
    lowpassLeft;
    lowpassRight;
    dropoutEvents = 0;
    randomLeft = new DeterministicPrng(LEFT_SEED2);
    randomRight = new DeterministicPrng(RIGHT_SEED2);
    previousInput = new Float64Array(2);
    previousDriven = new Float64Array(2);
    noiseState = new Float64Array(2);
    dropoutRemaining = new Int32Array(2);
    dropoutEnvelope = new Float64Array(2);
    band;
    targetBand;
    drive = 1;
    targetDrive = 1;
    noise = 0.08;
    targetNoise = 0.08;
    smoothingAlpha;
    noiseAlpha;
    outputLeft = 0;
    outputRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp8(sampleRate, 8e3, 192e3) : 48e3;
      this.band = this.targetBand = this.normalizeBand(parameters.band ?? 0);
      this.drive = this.targetDrive = 1 + 11 * clamp8(parameters.drive ?? 35, 0, 100) / 100;
      this.noise = this.targetNoise = clamp8(parameters.noise ?? 8, 0, 100) / 100;
      this.smoothingAlpha = 1 - Math.exp(-1 / (PARAM_SMOOTH_SECONDS * this.sampleRate));
      this.noiseAlpha = 1 - Math.exp(-TWO_PI6 * NOISE_ALPHA_HZ / this.sampleRate);
      this.dropoutEnvelope.fill(1);
      this.highpassLeft = new TptStateVariableFilter(this.sampleRate);
      this.highpassRight = new TptStateVariableFilter(this.sampleRate);
      this.lowpassLeft = new TptStateVariableFilter(this.sampleRate);
      this.lowpassRight = new TptStateVariableFilter(this.sampleRate);
      this.updateFilterCoefficients();
    }
    get wetLeft() {
      return this.outputLeft;
    }
    get wetRight() {
      return this.outputRight;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.band)) this.targetBand = this.normalizeBand(parameters.band);
      if (Number.isFinite(parameters.drive)) this.targetDrive = 1 + 11 * clamp8(parameters.drive, 0, 100) / 100;
      if (Number.isFinite(parameters.noise)) this.targetNoise = clamp8(parameters.noise, 0, 100) / 100;
    }
    processSample(left, right) {
      this.drive += this.smoothingAlpha * (this.targetDrive - this.drive);
      this.noise += this.smoothingAlpha * (this.targetNoise - this.noise);
      if (this.band !== this.targetBand) {
        this.band = this.targetBand;
        this.updateFilterCoefficients();
      }
      this.outputLeft = this.processChannel(left, 0);
      this.outputRight = this.processChannel(right, 1);
    }
    reset() {
      this.highpassLeft.reset();
      this.highpassRight.reset();
      this.lowpassLeft.reset();
      this.lowpassRight.reset();
      this.previousInput.fill(0);
      this.previousDriven.fill(0);
      this.noiseState.fill(0);
      this.dropoutRemaining.fill(0);
      this.dropoutEnvelope.fill(1);
      this.randomLeft.setSeed(LEFT_SEED2);
      this.randomRight.setSeed(RIGHT_SEED2);
      this.drive = this.targetDrive;
      this.noise = this.targetNoise;
      this.band = this.targetBand;
      this.updateFilterCoefficients();
      this.outputLeft = 0;
      this.outputRight = 0;
      this.dropoutEvents = 0;
    }
    normalizeBand(value) {
      return Math.round(clamp8(value, 0, 2));
    }
    updateFilterCoefficients() {
      const highpass = Math.min(BAND_HP[this.band] ?? 420, this.sampleRate * 0.42);
      const lowpass = Math.min(BAND_LP[this.band] ?? 3200, this.sampleRate * 0.46);
      this.highpassLeft.setParameters(highpass, Math.SQRT1_2);
      this.highpassRight.setParameters(highpass, Math.SQRT1_2);
      this.lowpassLeft.setParameters(lowpass, Math.SQRT1_2);
      this.lowpassRight.setParameters(lowpass, Math.SQRT1_2);
    }
    processChannel(input, channel) {
      const highpass = channel === 0 ? this.highpassLeft : this.highpassRight;
      const lowpass = channel === 0 ? this.lowpassLeft : this.lowpassRight;
      const random = channel === 0 ? this.randomLeft : this.randomRight;
      highpass.processSample(input);
      lowpass.processSample(highpass.highpass);
      const bandLimited = lowpass.lowpass;
      const midpointDriven = ((this.previousInput[channel] ?? 0) + bandLimited) * 0.5 * this.drive;
      const currentDriven = bandLimited * this.drive;
      const first = adaaTanh(midpointDriven, this.previousDriven[channel] ?? 0);
      const second = adaaTanh(currentDriven, midpointDriven);
      this.previousInput[channel] = bandLimited;
      this.previousDriven[channel] = currentDriven;
      const saturated = (first + second) * 0.5;
      const dropoutRemaining = this.dropoutRemaining[channel] ?? 0;
      if (dropoutRemaining > 0) {
        this.dropoutRemaining[channel] = dropoutRemaining - 1;
      } else if (this.noise > 0 && random.nextFloat() < this.noise * 35e-6) {
        this.dropoutRemaining[channel] = Math.round(this.sampleRate * (8e-3 + random.nextFloat() * 0.017));
        this.dropoutEvents += 1;
      }
      const dropoutTarget = (this.dropoutRemaining[channel] ?? 0) > 0 ? 0 : 1;
      const dropoutAlpha = dropoutTarget < (this.dropoutEnvelope[channel] ?? 1) ? 1 - Math.exp(-1 / (5e-4 * this.sampleRate)) : 1 - Math.exp(-1 / (4e-3 * this.sampleRate));
      let envelope = (this.dropoutEnvelope[channel] ?? 1) + dropoutAlpha * (dropoutTarget - (this.dropoutEnvelope[channel] ?? 1));
      if (envelope < 1e-12) envelope = 0;
      this.dropoutEnvelope[channel] = envelope;
      const coloredNoise = (this.noiseState[channel] ?? 0) + this.noiseAlpha * (random.nextBipolar() - (this.noiseState[channel] ?? 0));
      this.noiseState[channel] = coloredNoise;
      const noiseGain = this.noise * 6e-3;
      return saturated * envelope + coloredNoise * noiseGain;
    }
  };

  // src/audio/fx/dsp/BrowserVibratoDsp.ts
  var MIN_SAMPLE_RATE5 = 8e3;
  var MAX_SAMPLE_RATE6 = 192e3;
  var MIN_RATE_HZ2 = 0.05;
  var MAX_RATE_HZ2 = 20;
  var MIN_DEPTH_PERCENT = 0;
  var MAX_DEPTH_PERCENT = 100;
  var MIN_DELAY_MS3 = 0.2;
  var MAX_DELAY_MS3 = 10;
  var MAX_MODULATION_FACTOR = 0.9;
  var PARAMETER_SMOOTHING_SECONDS6 = 0.015;
  var TWO_PI7 = 2 * Math.PI;
  var MAX_SAMPLE_MAGNITUDE3 = 8;
  function clamp9(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function finiteBounded6(value) {
    return Number.isFinite(value) ? clamp9(value, -MAX_SAMPLE_MAGNITUDE3, MAX_SAMPLE_MAGNITUDE3) : 0;
  }
  function readLagrange3(buffer, writeIndex, delaySamples) {
    const wholeDelay = Math.floor(delaySamples);
    const fraction = delaySamples - wholeDelay;
    const oneMinus = 1 - fraction;
    const coefficient0 = oneMinus * (2 - fraction) * (3 - fraction) / 6;
    const coefficient1 = fraction * (2 - fraction) * (3 - fraction) / 2;
    const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
    const coefficient3 = fraction * oneMinus * (2 - fraction) / 6;
    const length = buffer.length;
    let index = writeIndex - wholeDelay;
    index %= length;
    if (index < 0) index += length;
    const sample0 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample1 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample2 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample3 = buffer[index] ?? 0;
    return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
  }
  var BrowserVibratoDsp = class {
    sampleRate;
    algorithmicLatencySamples = 0;
    buffers;
    writeIndices = new Int32Array(2);
    rateHz;
    depthPercent;
    delayMs;
    parameterRampFrames;
    phase = 0;
    outputLeft = 0;
    outputRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp9(sampleRate, MIN_SAMPLE_RATE5, MAX_SAMPLE_RATE6) : 48e3;
      const capacity = Math.ceil(MAX_DELAY_MS3 * (1 + MAX_MODULATION_FACTOR) * this.sampleRate / 1e3) + 8;
      this.buffers = [new Float32Array(capacity), new Float32Array(capacity)];
      this.rateHz = new LinearParameterSmoother(clamp9(parameters.rateHz ?? 5, MIN_RATE_HZ2, MAX_RATE_HZ2));
      this.depthPercent = new LinearParameterSmoother(clamp9(parameters.depthPercent ?? 35, MIN_DEPTH_PERCENT, MAX_DEPTH_PERCENT));
      this.delayMs = new LinearParameterSmoother(clamp9(parameters.delayMs ?? 2, MIN_DELAY_MS3, MAX_DELAY_MS3));
      this.parameterRampFrames = Math.round(this.sampleRate * PARAMETER_SMOOTHING_SECONDS6);
    }
    get wetLeft() {
      return this.outputLeft;
    }
    get wetRight() {
      return this.outputRight;
    }
    get currentRateHz() {
      return this.rateHz.currentValue;
    }
    get currentDepthPercent() {
      return this.depthPercent.currentValue;
    }
    get currentDelayMs() {
      return this.delayMs.currentValue;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.rateHz)) {
        this.rateHz.setTarget(clamp9(parameters.rateHz, MIN_RATE_HZ2, MAX_RATE_HZ2), this.parameterRampFrames);
      }
      if (Number.isFinite(parameters.depthPercent)) {
        this.depthPercent.setTarget(clamp9(parameters.depthPercent, MIN_DEPTH_PERCENT, MAX_DEPTH_PERCENT), this.parameterRampFrames);
      }
      if (Number.isFinite(parameters.delayMs)) {
        this.delayMs.setTarget(clamp9(parameters.delayMs, MIN_DELAY_MS3, MAX_DELAY_MS3), this.parameterRampFrames);
      }
    }
    processSample(inputLeft, inputRight) {
      const rate = clamp9(this.rateHz.next(), MIN_RATE_HZ2, MAX_RATE_HZ2);
      const depth = clamp9(this.depthPercent.next() / 100, 0, 1) * MAX_MODULATION_FACTOR;
      const baseDelaySamples = clamp9(this.delayMs.next(), MIN_DELAY_MS3, MAX_DELAY_MS3) * this.sampleRate / 1e3;
      const left = this.processChannel(inputLeft, 0, this.phase, baseDelaySamples, depth);
      const right = this.processChannel(inputRight, 1, this.phase + Math.PI * 0.5, baseDelaySamples, depth);
      this.outputLeft = left;
      this.outputRight = right;
      this.phase += TWO_PI7 * rate / this.sampleRate;
      if (this.phase >= TWO_PI7) this.phase -= TWO_PI7;
    }
    reset() {
      this.buffers[0].fill(0);
      this.buffers[1].fill(0);
      this.writeIndices.fill(0);
      this.phase = 0;
      this.rateHz.reset();
      this.depthPercent.reset();
      this.delayMs.reset();
      this.outputLeft = 0;
      this.outputRight = 0;
    }
    processChannel(input, channel, phase, baseDelaySamples, depth) {
      const buffer = this.buffers[channel];
      const writeIndex = this.writeIndices[channel] ?? 0;
      const delaySamples = clamp9(
        baseDelaySamples * (1 + depth * Math.sin(phase)),
        2,
        buffer.length - 6
      );
      const delayed = readLagrange3(buffer, writeIndex, delaySamples);
      buffer[writeIndex] = finiteBounded6(input);
      let nextWriteIndex = writeIndex + 1;
      if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
      this.writeIndices[channel] = nextWriteIndex;
      return finiteBounded6(delayed);
    }
  };

  // src/audio/fx/dsp/BrowserSustainerDsp.ts
  var MIN_THRESHOLD_DB = -60;
  var MAX_THRESHOLD_DB = 0;
  var MIN_RATIO = 1;
  var MAX_RATIO = 20;
  var MIN_RELEASE_MS = 10;
  var MAX_RELEASE_MS = 1e3;
  var DEFAULT_THRESHOLD_DB = -24;
  var DEFAULT_RATIO = 4;
  var DEFAULT_RELEASE_MS = 180;
  var DEFAULT_OUTPUT_DB = 0;
  var ENVELOPE_FLOOR = 1e-9;
  var GATE_CLOSE_OFFSET_DB = 24;
  var GATE_OPEN_OFFSET_DB = 18;
  var LIMITER_CEILING = 0.9660508789898133;
  function clamp10(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function onePoleAlpha(timeMs, sampleRate) {
    return Math.exp(-1 / (Math.max(1e-3, timeMs) * 1e-3 * sampleRate));
  }
  function dbToLinear(db) {
    return Math.pow(10, db / 20);
  }
  var ParameterSmoother = class {
    current;
    target;
    oneMinusAlpha;
    constructor(sampleRate, initialValue) {
      this.current = initialValue;
      this.target = initialValue;
      this.oneMinusAlpha = 1 - Math.exp(-1 / (sampleRate * 0.015));
    }
    setTarget(value) {
      this.target = value;
    }
    next() {
      this.current += (this.target - this.current) * this.oneMinusAlpha;
      return this.current;
    }
  };
  var BrowserSustainerDsp = class {
    sampleRate;
    outputLeft = 0;
    outputRight = 0;
    threshold;
    ratio;
    release;
    outputDb;
    envelope = 0;
    gateEnvelope = 0;
    gateGain = 0;
    gateIsOpen = false;
    attackAlpha = 0;
    releaseAlpha = 0;
    gateEnvelopeAttackAlpha;
    gateEnvelopeReleaseAlpha;
    gateOpenAlpha;
    gateCloseAlpha;
    limiterReleaseAlpha;
    limiterGain = 1;
    controlsCountdown = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.threshold = new ParameterSmoother(this.sampleRate, clamp10(parameters.thresholdDb ?? DEFAULT_THRESHOLD_DB, MIN_THRESHOLD_DB, MAX_THRESHOLD_DB));
      this.ratio = new ParameterSmoother(this.sampleRate, clamp10(parameters.ratio ?? DEFAULT_RATIO, MIN_RATIO, MAX_RATIO));
      this.release = new ParameterSmoother(this.sampleRate, clamp10(parameters.releaseMs ?? DEFAULT_RELEASE_MS, MIN_RELEASE_MS, MAX_RELEASE_MS));
      this.outputDb = new ParameterSmoother(this.sampleRate, clamp10(parameters.outputDb ?? DEFAULT_OUTPUT_DB, -24, 12));
      this.gateEnvelopeAttackAlpha = onePoleAlpha(1, this.sampleRate);
      this.gateEnvelopeReleaseAlpha = onePoleAlpha(60, this.sampleRate);
      this.gateOpenAlpha = onePoleAlpha(1, this.sampleRate);
      this.gateCloseAlpha = onePoleAlpha(60, this.sampleRate);
      this.limiterReleaseAlpha = onePoleAlpha(60, this.sampleRate);
      this.refreshCompressorCoefficients(parameters.releaseMs ?? DEFAULT_RELEASE_MS);
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.thresholdDb)) this.threshold.setTarget(clamp10(parameters.thresholdDb, MIN_THRESHOLD_DB, MAX_THRESHOLD_DB));
      if (Number.isFinite(parameters.ratio)) this.ratio.setTarget(clamp10(parameters.ratio, MIN_RATIO, MAX_RATIO));
      if (Number.isFinite(parameters.releaseMs)) this.release.setTarget(clamp10(parameters.releaseMs, MIN_RELEASE_MS, MAX_RELEASE_MS));
      if (Number.isFinite(parameters.outputDb)) this.outputDb.setTarget(clamp10(parameters.outputDb, -24, 12));
    }
    /** Advances one stereo frame; all computation uses fixed scalar state. */
    processSample(inputLeft, inputRight) {
      const thresholdDb = this.threshold.next();
      const ratio = this.ratio.next();
      const releaseMs = this.release.next();
      const outputDb = this.outputDb.next();
      if (this.controlsCountdown <= 0) {
        this.refreshCompressorCoefficients(releaseMs);
        this.controlsCountdown = 15;
      } else {
        this.controlsCountdown -= 1;
      }
      const peak = Math.max(Math.abs(inputLeft), Math.abs(inputRight));
      const compressorCoefficient = peak > this.envelope ? this.attackAlpha : this.releaseAlpha;
      this.envelope = peak + compressorCoefficient * (this.envelope - peak);
      const gateEnvelopeCoefficient = peak > this.gateEnvelope ? this.gateEnvelopeAttackAlpha : this.gateEnvelopeReleaseAlpha;
      this.gateEnvelope = peak + gateEnvelopeCoefficient * (this.gateEnvelope - peak);
      const gateDb = 20 * Math.log10(Math.max(this.gateEnvelope, ENVELOPE_FLOOR));
      if (this.gateIsOpen) {
        if (gateDb <= thresholdDb - GATE_CLOSE_OFFSET_DB) this.gateIsOpen = false;
      } else if (gateDb >= thresholdDb - GATE_OPEN_OFFSET_DB) {
        this.gateIsOpen = true;
      }
      const gateTarget = this.gateIsOpen ? 1 : 0;
      const gateCoefficient = this.gateIsOpen ? this.gateOpenAlpha : this.gateCloseAlpha;
      this.gateGain = gateTarget + gateCoefficient * (this.gateGain - gateTarget);
      const envelopeDb = 20 * Math.log10(Math.max(this.envelope, ENVELOPE_FLOOR));
      const compressedDb = thresholdDb + (envelopeDb - thresholdDb) / ratio;
      const linkedGain = dbToLinear(compressedDb - envelopeDb) * this.gateGain * dbToLinear(outputDb);
      const rawLeft = inputLeft * linkedGain;
      const rawRight = inputRight * linkedGain;
      const outputPeak = Math.max(Math.abs(rawLeft), Math.abs(rawRight));
      if (outputPeak > LIMITER_CEILING) {
        this.limiterGain = LIMITER_CEILING / outputPeak;
      } else {
        this.limiterGain = 1 + this.limiterReleaseAlpha * (this.limiterGain - 1);
      }
      this.outputLeft = rawLeft * this.limiterGain;
      this.outputRight = rawRight * this.limiterGain;
    }
    reset() {
      this.envelope = 0;
      this.gateEnvelope = 0;
      this.gateGain = 0;
      this.gateIsOpen = false;
      this.limiterGain = 1;
      this.outputLeft = 0;
      this.outputRight = 0;
      this.controlsCountdown = 0;
    }
    refreshCompressorCoefficients(releaseMs) {
      this.attackAlpha = onePoleAlpha(2, this.sampleRate);
      this.releaseAlpha = onePoleAlpha(clamp10(releaseMs, MIN_RELEASE_MS, MAX_RELEASE_MS), this.sampleRate);
    }
  };

  // src/audio/fx/dsp/BrowserIsolatorDsp.ts
  var CROSSOVER_LOW_HZ = 250;
  var CROSSOVER_HIGH_HZ = 2500;
  var BAND_GAIN_MIN_DB = -60;
  var BAND_GAIN_MAX_DB = 12;
  var GATE_RATE_CHOICES = [0.25, 0.5, 1, 2, 4];
  var GATE_DEPTH_MIN_PERCENT = 0;
  var GATE_DEPTH_MAX_PERCENT = 100;
  var BPM_MIN = 20;
  var BPM_MAX = 300;
  var CONTROL_SMOOTHING_SECONDS = 0.015;
  var GATE_EDGE_SMOOTHING_SECONDS = 2e-3;
  var SVF_Q = Math.SQRT1_2;
  var clamp11 = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  var dbToLinear2 = (valueDb) => 10 ** (valueDb / 20);
  var nearestGateRate = (value) => {
    let nearest = GATE_RATE_CHOICES[0];
    let smallestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of GATE_RATE_CHOICES) {
      const distance = Math.abs(candidate - value);
      if (distance < smallestDistance) {
        smallestDistance = distance;
        nearest = candidate;
      }
    }
    return nearest;
  };
  var BrowserIsolatorDsp = class {
    sampleRate;
    outputLeft = 0;
    outputRight = 0;
    lowFirst;
    lowSecond;
    highFirst;
    highSecond;
    lowGain;
    midGain;
    highGain;
    gateDepth;
    gateEnvelope;
    gateRateBeats;
    pendingGateRateBeats;
    bpm;
    cycleBeatPosition = 0;
    isGateOpen = true;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      const nyquist = this.sampleRate * 0.499;
      const lowCrossover = Math.min(CROSSOVER_LOW_HZ, nyquist * 0.45);
      const highCrossover = Math.min(CROSSOVER_HIGH_HZ, nyquist * 0.8);
      const initialLowDb = clamp11(Number.isFinite(parameters.lowGainDb) ? parameters.lowGainDb : 0, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB);
      const initialMidDb = clamp11(Number.isFinite(parameters.midGainDb) ? parameters.midGainDb : 0, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB);
      const initialHighDb = clamp11(Number.isFinite(parameters.highGainDb) ? parameters.highGainDb : 0, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB);
      const initialGateRate = nearestGateRate(clamp11(Number.isFinite(parameters.gateRateBeats) ? parameters.gateRateBeats : 0.5, 0.25, 4));
      const initialGateDepth = clamp11(Number.isFinite(parameters.gateDepthPercent) ? parameters.gateDepthPercent : 0, GATE_DEPTH_MIN_PERCENT, GATE_DEPTH_MAX_PERCENT) / 100;
      this.bpm = clamp11(Number.isFinite(parameters.bpm) ? parameters.bpm : 120, BPM_MIN, BPM_MAX);
      this.gateRateBeats = initialGateRate;
      this.pendingGateRateBeats = initialGateRate;
      this.lowGain = new LinearParameterSmoother(dbToLinear2(initialLowDb));
      this.midGain = new LinearParameterSmoother(dbToLinear2(initialMidDb));
      this.highGain = new LinearParameterSmoother(dbToLinear2(initialHighDb));
      this.gateDepth = new LinearParameterSmoother(initialGateDepth);
      this.gateEnvelope = new LinearParameterSmoother(1);
      const makePair = (cutoffHz) => [
        new TptStateVariableFilter(this.sampleRate, cutoffHz, SVF_Q),
        new TptStateVariableFilter(this.sampleRate, cutoffHz, SVF_Q)
      ];
      this.lowFirst = makePair(lowCrossover);
      this.lowSecond = makePair(lowCrossover);
      this.highFirst = makePair(highCrossover);
      this.highSecond = makePair(highCrossover);
    }
    setParameters(parameters) {
      const rampFrames = Math.max(1, Math.round(this.sampleRate * CONTROL_SMOOTHING_SECONDS));
      if (Number.isFinite(parameters.lowGainDb)) {
        this.lowGain.setTarget(dbToLinear2(clamp11(parameters.lowGainDb, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)), rampFrames);
      }
      if (Number.isFinite(parameters.midGainDb)) {
        this.midGain.setTarget(dbToLinear2(clamp11(parameters.midGainDb, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)), rampFrames);
      }
      if (Number.isFinite(parameters.highGainDb)) {
        this.highGain.setTarget(dbToLinear2(clamp11(parameters.highGainDb, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)), rampFrames);
      }
      if (Number.isFinite(parameters.gateRateBeats)) {
        this.pendingGateRateBeats = nearestGateRate(clamp11(parameters.gateRateBeats, 0.25, 4));
      }
      if (Number.isFinite(parameters.gateDepthPercent)) {
        this.gateDepth.setTarget(clamp11(parameters.gateDepthPercent, GATE_DEPTH_MIN_PERCENT, GATE_DEPTH_MAX_PERCENT) / 100, rampFrames);
      }
      if (Number.isFinite(parameters.bpm)) {
        this.bpm = clamp11(parameters.bpm, BPM_MIN, BPM_MAX);
      }
    }
    processSample(inputLeft, inputRight) {
      const leftLow = this.processLow(inputLeft, 0);
      const rightLow = this.processLow(inputRight, 1);
      const leftHigh = this.processHigh(inputLeft, 0);
      const rightHigh = this.processHigh(inputRight, 1);
      const lowGain = this.lowGain.next();
      const midGain = this.midGain.next();
      const highGain = this.highGain.next();
      const beatIncrement = this.bpm / (60 * this.sampleRate);
      this.cycleBeatPosition += beatIncrement;
      if (this.cycleBeatPosition >= this.gateRateBeats) {
        this.cycleBeatPosition -= this.gateRateBeats;
        this.gateRateBeats = this.pendingGateRateBeats;
      }
      const targetIsOpen = this.cycleBeatPosition < this.gateRateBeats * 0.5;
      if (targetIsOpen !== this.isGateOpen) {
        this.isGateOpen = targetIsOpen;
        this.gateEnvelope.setTarget(targetIsOpen ? 1 : 0, Math.max(1, Math.round(this.sampleRate * GATE_EDGE_SMOOTHING_SECONDS)));
      }
      const gateDepth = this.gateDepth.next();
      const gateGain = 1 - gateDepth * (1 - this.gateEnvelope.next());
      const leftMid = inputLeft - leftLow - leftHigh;
      const rightMid = inputRight - rightLow - rightHigh;
      this.outputLeft = clamp11((leftLow * lowGain + leftMid * midGain + leftHigh * highGain) * gateGain, -16, 16);
      this.outputRight = clamp11((rightLow * lowGain + rightMid * midGain + rightHigh * highGain) * gateGain, -16, 16);
    }
    reset() {
      for (let channel = 0; channel < 2; channel += 1) {
        this.lowFirst[channel].reset();
        this.lowSecond[channel].reset();
        this.highFirst[channel].reset();
        this.highSecond[channel].reset();
      }
      this.lowGain.reset();
      this.midGain.reset();
      this.highGain.reset();
      this.gateDepth.reset();
      this.gateEnvelope.reset(1);
      this.cycleBeatPosition = 0;
      this.gateRateBeats = this.pendingGateRateBeats;
      this.isGateOpen = true;
      this.outputLeft = 0;
      this.outputRight = 0;
    }
    processLow(input, channel) {
      const first = this.lowFirst[channel];
      const second = this.lowSecond[channel];
      first.processSample(input);
      second.processSample(first.lowpass);
      return second.lowpass;
    }
    processHigh(input, channel) {
      const first = this.highFirst[channel];
      const second = this.highSecond[channel];
      first.processSample(input);
      second.processSample(first.highpass);
      return second.highpass;
    }
  };

  // src/audio/fx/dsp/BrowserSlowGearDsp.ts
  var MIN_ATTACK_MS = 5;
  var MAX_ATTACK_MS = 2e3;
  var DEFAULT_ATTACK_MS = 250;
  var MIN_SENSITIVITY_PERCENT = 0;
  var MAX_SENSITIVITY_PERCENT = 100;
  var DEFAULT_SENSITIVITY_PERCENT = 50;
  var ENERGY_WINDOW_SECONDS = 4e-3;
  var PARAMETER_SMOOTHING_SECONDS7 = 0.015;
  var BASELINE_ATTACK_SECONDS = 0.025;
  var BASELINE_RELEASE_SECONDS = 0.35;
  var REARM_QUIET_SECONDS = 0.035;
  var MINIMUM_BASELINE_ENERGY = 1e-20;
  var MAX_DETECTOR_INPUT = 4;
  function clamp12(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function onePoleAlpha2(seconds, sampleRate) {
    return Math.exp(-1 / (Math.max(1e-3, seconds) * sampleRate));
  }
  var BrowserSlowGearDsp = class {
    sampleRate;
    energyWindow;
    attackMs;
    sensitivityPercent;
    baselineAttackAlpha;
    baselineReleaseAlpha;
    rearmQuietFrames;
    energyWindowIndex = 0;
    energyWindowFrames = 0;
    energyWindowSum = 0;
    baselineEnergy = 0;
    activeUntilQuiet = false;
    quietFrames = 0;
    rampElapsedFrames = 0;
    envelope = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      const initialAttackMs = Number.isFinite(parameters.attackMs) ? clamp12(parameters.attackMs, MIN_ATTACK_MS, MAX_ATTACK_MS) : DEFAULT_ATTACK_MS;
      const initialSensitivity = Number.isFinite(parameters.sensitivityPercent) ? clamp12(parameters.sensitivityPercent, MIN_SENSITIVITY_PERCENT, MAX_SENSITIVITY_PERCENT) : DEFAULT_SENSITIVITY_PERCENT;
      this.attackMs = new LinearParameterSmoother(initialAttackMs);
      this.sensitivityPercent = new LinearParameterSmoother(initialSensitivity);
      this.energyWindow = new Float64Array(Math.max(1, Math.ceil(this.sampleRate * ENERGY_WINDOW_SECONDS)));
      this.baselineAttackAlpha = onePoleAlpha2(BASELINE_ATTACK_SECONDS, this.sampleRate);
      this.baselineReleaseAlpha = onePoleAlpha2(BASELINE_RELEASE_SECONDS, this.sampleRate);
      this.rearmQuietFrames = Math.max(1, Math.round(this.sampleRate * REARM_QUIET_SECONDS));
    }
    /** Read-only envelope diagnostic for unit tests. */
    get currentGain() {
      return this.envelope;
    }
    setParameters(parameters) {
      const smoothingFrames = Math.round(this.sampleRate * PARAMETER_SMOOTHING_SECONDS7);
      if (Number.isFinite(parameters.attackMs)) {
        this.attackMs.setTarget(clamp12(parameters.attackMs, MIN_ATTACK_MS, MAX_ATTACK_MS), smoothingFrames);
      }
      if (Number.isFinite(parameters.sensitivityPercent)) {
        this.sensitivityPercent.setTarget(
          clamp12(parameters.sensitivityPercent, MIN_SENSITIVITY_PERCENT, MAX_SENSITIVITY_PERCENT),
          smoothingFrames
        );
      }
    }
    /** Advance one linked stereo frame and return the envelope gain. */
    processSample(inputLeft, inputRight) {
      const attackMs = this.attackMs.next();
      const sensitivity = this.sensitivityPercent.next() / 100;
      const safeLeft = Number.isFinite(inputLeft) ? clamp12(inputLeft, -MAX_DETECTOR_INPUT, MAX_DETECTOR_INPUT) : 0;
      const safeRight = Number.isFinite(inputRight) ? clamp12(inputRight, -MAX_DETECTOR_INPUT, MAX_DETECTOR_INPUT) : 0;
      const frameEnergy = 0.5 * (safeLeft * safeLeft + safeRight * safeRight);
      const oldEnergy = this.energyWindow[this.energyWindowIndex] ?? 0;
      this.energyWindow[this.energyWindowIndex] = frameEnergy;
      this.energyWindowSum += frameEnergy - oldEnergy;
      this.energyWindowIndex += 1;
      if (this.energyWindowIndex >= this.energyWindow.length) this.energyWindowIndex = 0;
      if (this.energyWindowFrames < this.energyWindow.length) this.energyWindowFrames += 1;
      const shortWindowEnergy = Math.max(0, this.energyWindowSum / Math.max(1, this.energyWindowFrames));
      const onsetFloorDb = -64 + (1 - sensitivity) * 24;
      const onsetFloor = 10 ** (onsetFloorDb / 20);
      const onsetFloorEnergy = onsetFloor * onsetFloor;
      const riseRatio = 1.12 + (1 - sensitivity) * 2.25;
      const relativeRiseEnergy = Math.max(MINIMUM_BASELINE_ENERGY, this.baselineEnergy * riseRatio * riseRatio);
      const onset = !this.activeUntilQuiet && shortWindowEnergy >= onsetFloorEnergy && shortWindowEnergy >= relativeRiseEnergy;
      if (onset) {
        this.activeUntilQuiet = true;
        this.quietFrames = 0;
        this.rampElapsedFrames = 0;
      } else if (this.activeUntilQuiet) {
        const quietThreshold = onsetFloor * 0.55;
        if (shortWindowEnergy <= quietThreshold * quietThreshold) {
          this.quietFrames += 1;
          if (this.quietFrames >= this.rearmQuietFrames) {
            this.activeUntilQuiet = false;
            this.quietFrames = 0;
          }
        } else {
          this.quietFrames = 0;
        }
      }
      if (!this.activeUntilQuiet && !onset) {
        const targetAlpha = shortWindowEnergy > this.baselineEnergy ? this.baselineAttackAlpha : this.baselineReleaseAlpha;
        this.baselineEnergy += (shortWindowEnergy - this.baselineEnergy) * (1 - targetAlpha);
      }
      if (onset) {
        this.envelope = 0;
        this.rampElapsedFrames = 1;
        return 0;
      }
      const attackFrames = Math.max(1, attackMs * this.sampleRate / 1e3);
      if (this.rampElapsedFrames > 0 && this.rampElapsedFrames < attackFrames) {
        const phase = clamp12(this.rampElapsedFrames / attackFrames, 0, 1);
        this.envelope = 0.5 - 0.5 * Math.cos(Math.PI * phase);
        this.rampElapsedFrames += 1;
        return this.envelope;
      }
      this.rampElapsedFrames = 0;
      this.envelope = 1;
      return 1;
    }
    reset() {
      this.energyWindow.fill(0);
      this.energyWindowIndex = 0;
      this.energyWindowFrames = 0;
      this.energyWindowSum = 0;
      this.baselineEnergy = 0;
      this.activeUntilQuiet = false;
      this.quietFrames = 0;
      this.rampElapsedFrames = 0;
      this.envelope = 0;
    }
  };

  // src/audio/fx/dsp/BrowserBeatScatterDsp.ts
  var BrowserBeatScatterDsp = class {
    sampleRate;
    maxSliceFrames;
    wetLeft = 0;
    wetRight = 0;
    boundaryCount = 0;
    framesProcessed = 0;
    lastBoundaryFrame = -1;
    leftBuffers;
    rightBuffers;
    grainStarts = new Int32Array(16);
    grainLengths = new Int32Array(16);
    captureBufferIndex = 0;
    playbackBufferIndex = -1;
    captureFrames = 0;
    playbackLength = 0;
    playbackElapsedFrames = 0;
    framesUntilBoundary;
    activeIntervalFrames;
    currentBpm;
    currentSliceBeats;
    currentScatterPercent;
    currentPitchSemitones;
    pitchRatio = 1;
    currentRepeats;
    pendingBpm;
    pendingSliceBeats;
    pendingScatterPercent;
    pendingPitchSemitones;
    pendingRepeats;
    randomState = 1831565813;
    previousWetLeft = 0;
    previousWetRight = 0;
    hasSlice = false;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.maxSliceFrames = Math.ceil(this.sampleRate * 6) + 2;
      this.leftBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
      this.rightBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
      this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
      this.currentSliceBeats = this.pendingSliceBeats = this.clampSliceBeats(parameters.sliceBeats ?? 0.25);
      this.currentScatterPercent = this.pendingScatterPercent = this.clampPercent(parameters.scatterPercent ?? 50);
      this.currentPitchSemitones = this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones ?? 0);
      this.pitchRatio = 2 ** (this.currentPitchSemitones / 12);
      this.currentRepeats = this.pendingRepeats = this.clampRepeats(parameters.repeats ?? 4);
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
      this.framesUntilBoundary = this.activeIntervalFrames;
    }
    get hasCapturedSlice() {
      return this.hasSlice;
    }
    get activeBpm() {
      return this.currentBpm;
    }
    get activeSliceBeats() {
      return this.currentSliceBeats;
    }
    get activeScatterPercent() {
      return this.currentScatterPercent;
    }
    get activePitchSemitones() {
      return this.currentPitchSemitones;
    }
    get activeRepeats() {
      return this.currentRepeats;
    }
    get activeSliceFrames() {
      return this.playbackLength;
    }
    get remainingFramesToBoundary() {
      return this.framesUntilBoundary;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.sliceBeats)) this.pendingSliceBeats = this.clampSliceBeats(parameters.sliceBeats);
      if (Number.isFinite(parameters.scatterPercent)) this.pendingScatterPercent = this.clampPercent(parameters.scatterPercent);
      if (Number.isFinite(parameters.pitchSemitones)) this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones);
      if (Number.isFinite(parameters.repeats)) this.pendingRepeats = this.clampRepeats(parameters.repeats);
    }
    /** Mutates wetLeft/wetRight; no allocations occur in the audio callback. */
    processSample(left, right) {
      const captureLeft = this.leftBuffers[this.captureBufferIndex];
      const captureRight = this.rightBuffers[this.captureBufferIndex];
      if (this.captureFrames < this.maxSliceFrames) {
        captureLeft[this.captureFrames] = left;
        captureRight[this.captureFrames] = right;
      }
      if (!this.hasSlice || this.playbackBufferIndex < 0 || this.playbackLength <= 0) {
        this.wetLeft = 0;
        this.wetRight = 0;
      } else {
        this.renderGrain();
      }
      this.captureFrames = Math.min(this.captureFrames + 1, this.maxSliceFrames);
      this.framesUntilBoundary -= 1;
      this.framesProcessed += 1;
      if (this.framesUntilBoundary <= 0) this.onBoundary();
    }
    reset() {
      this.captureBufferIndex = 0;
      this.playbackBufferIndex = -1;
      this.captureFrames = 0;
      this.playbackLength = 0;
      this.playbackElapsedFrames = 0;
      this.currentBpm = this.pendingBpm;
      this.currentSliceBeats = this.pendingSliceBeats;
      this.currentScatterPercent = this.pendingScatterPercent;
      this.currentPitchSemitones = this.pendingPitchSemitones;
      this.pitchRatio = 2 ** (this.currentPitchSemitones / 12);
      this.currentRepeats = this.pendingRepeats;
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
      this.framesUntilBoundary = this.activeIntervalFrames;
      this.randomState = 1831565813;
      this.previousWetLeft = 0;
      this.previousWetRight = 0;
      this.hasSlice = false;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.boundaryCount = 0;
      this.framesProcessed = 0;
      this.lastBoundaryFrame = -1;
    }
    renderGrain() {
      const repeats = this.currentRepeats;
      const segmentIndex = Math.min(
        repeats - 1,
        Math.floor(this.playbackElapsedFrames * repeats / this.activeIntervalFrames)
      );
      const outputSegmentStart = Math.floor(segmentIndex * this.activeIntervalFrames / repeats);
      const outputSegmentEnd = Math.floor((segmentIndex + 1) * this.activeIntervalFrames / repeats);
      const outputSegmentFrames = Math.max(1, outputSegmentEnd - outputSegmentStart);
      const outputOffset = this.playbackElapsedFrames - outputSegmentStart;
      const sourceStart = this.grainStarts[segmentIndex] ?? 0;
      const sourceLength = Math.max(1, this.grainLengths[segmentIndex] ?? 1);
      const sourcePosition = outputOffset / outputSegmentFrames * sourceLength * this.pitchRatio % sourceLength;
      const sourceIndexOffset = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndexOffset;
      const firstIndex = sourceStart + sourceIndexOffset;
      const secondIndex = sourceStart + (sourceIndexOffset + 1) % sourceLength;
      const playbackLeft = this.leftBuffers[this.playbackBufferIndex];
      const playbackRight = this.rightBuffers[this.playbackBufferIndex];
      let left = (playbackLeft[firstIndex] ?? 0) + ((playbackLeft[secondIndex] ?? 0) - (playbackLeft[firstIndex] ?? 0)) * fraction;
      let right = (playbackRight[firstIndex] ?? 0) + ((playbackRight[secondIndex] ?? 0) - (playbackRight[firstIndex] ?? 0)) * fraction;
      const fadeFrames = Math.min(16, Math.floor(outputSegmentFrames / 2));
      if (fadeFrames > 1 && outputOffset < fadeFrames) {
        const fadeIn = (outputOffset + 1) / fadeFrames;
        left = this.previousWetLeft * (1 - fadeIn) + left * fadeIn;
        right = this.previousWetRight * (1 - fadeIn) + right * fadeIn;
      }
      this.wetLeft = left;
      this.wetRight = right;
      this.previousWetLeft = left;
      this.previousWetRight = right;
      this.playbackElapsedFrames += 1;
    }
    onBoundary() {
      this.boundaryCount += 1;
      this.lastBoundaryFrame = this.framesProcessed - 1;
      const validFrames = Math.min(this.captureFrames, this.maxSliceFrames);
      if (validFrames > 0) {
        this.playbackBufferIndex = this.captureBufferIndex;
        this.captureBufferIndex = 1 - this.captureBufferIndex;
        this.playbackLength = validFrames;
        this.hasSlice = true;
      }
      this.captureFrames = 0;
      this.playbackElapsedFrames = 0;
      this.currentBpm = this.pendingBpm;
      this.currentSliceBeats = this.pendingSliceBeats;
      this.currentScatterPercent = this.pendingScatterPercent;
      this.currentPitchSemitones = this.pendingPitchSemitones;
      this.pitchRatio = 2 ** (this.currentPitchSemitones / 12);
      this.currentRepeats = this.pendingRepeats;
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
      this.framesUntilBoundary = this.activeIntervalFrames;
      if (this.hasSlice) this.prepareGrains();
    }
    prepareGrains() {
      const repeats = this.currentRepeats;
      const scatter = this.currentScatterPercent / 100;
      for (let index = 0; index < repeats; index += 1) {
        const randomBucket = this.nextRandom() % repeats;
        const bucket = Math.round(index + (randomBucket - index) * scatter);
        const start = Math.floor(bucket * this.playbackLength / repeats);
        const end = Math.floor((bucket + 1) * this.playbackLength / repeats);
        this.grainStarts[index] = start;
        this.grainLengths[index] = Math.max(1, end - start);
      }
    }
    nextRandom() {
      let value = this.randomState;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      this.randomState = value >>> 0;
      return this.randomState;
    }
    intervalFrames(bpm, sliceBeats) {
      const rawFrames = 60 * this.sampleRate * sliceBeats / bpm;
      return Math.max(1, Math.min(this.maxSliceFrames, Math.round(rawFrames)));
    }
    clampBpm(value) {
      return Math.max(40, Math.min(300, value));
    }
    clampSliceBeats(value) {
      const options = [0.25, 0.5, 1, 2, 4];
      let nearest = 0.25;
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < options.length; index += 1) {
        const option = options[index];
        const nextDistance = Math.abs(value - option);
        if (nextDistance < distance) {
          nearest = option;
          distance = nextDistance;
        }
      }
      return nearest;
    }
    clampPercent(value) {
      return Math.max(0, Math.min(100, value));
    }
    clampPitch(value) {
      return Math.max(-24, Math.min(24, value));
    }
    clampRepeats(value) {
      return Math.round(Math.max(1, Math.min(16, value)));
    }
  };

  // src/audio/dsp/LagrangeFractionalDelay.ts
  var LagrangeFractionalDelay = class {
    maxDelaySamples;
    capacity;
    buffer;
    writeIndex = 0;
    lastWrittenIndex = -1;
    constructor(maxDelaySamples) {
      if (!Number.isFinite(maxDelaySamples) || maxDelaySamples < 0) {
        throw new RangeError("maxDelaySamples must be a finite non-negative number");
      }
      this.maxDelaySamples = maxDelaySamples;
      this.capacity = Math.max(4, Math.ceil(maxDelaySamples) + 4);
      this.buffer = new Float32Array(this.capacity);
    }
    /** Writes an input sample and returns the delayed/interpolated result. */
    processSample(input, delaySamples) {
      this.buffer[this.writeIndex] = Number.isFinite(input) ? input : 0;
      this.lastWrittenIndex = this.writeIndex;
      this.writeIndex += 1;
      if (this.writeIndex === this.capacity) this.writeIndex = 0;
      return this.readSample(delaySamples);
    }
    /** Reads relative to the most recently written sample. Returns silence before the first write. */
    readSample(delaySamples) {
      if (this.lastWrittenIndex < 0) return 0;
      const delay = Number.isFinite(delaySamples) ? Math.max(0, Math.min(this.maxDelaySamples, delaySamples)) : 0;
      const wholeDelay = Math.floor(delay);
      const fraction = delay - wholeDelay;
      const oneMinus = 1 - fraction;
      const coefficient0 = oneMinus * (2 - fraction) * (3 - fraction) / 6;
      const coefficient1 = fraction * (2 - fraction) * (3 - fraction) / 2;
      const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
      const coefficient3 = fraction * oneMinus * (2 - fraction) / 6;
      let index = this.lastWrittenIndex - wholeDelay;
      if (index < 0) index += this.capacity;
      const sample0 = this.buffer[index] ?? 0;
      index -= 1;
      if (index < 0) index += this.capacity;
      const sample1 = this.buffer[index] ?? 0;
      index -= 1;
      if (index < 0) index += this.capacity;
      const sample2 = this.buffer[index] ?? 0;
      index -= 1;
      if (index < 0) index += this.capacity;
      const sample3 = this.buffer[index] ?? 0;
      return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
    }
    clear() {
      this.buffer.fill(0);
      this.writeIndex = 0;
      this.lastWrittenIndex = -1;
    }
  };

  // src/audio/fx/dsp/BrowserBeatShiftDsp.ts
  var BrowserBeatShiftDsp = class {
    sampleRate;
    maxDelayFrames;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    transitionCount = 0;
    leftDelay;
    rightDelay;
    currentBpm;
    currentOffsetBeats;
    currentCrossfadeMs;
    pendingBpm;
    pendingOffsetBeats;
    pendingCrossfadeMs;
    currentDelayFrames;
    transitionFromFrames = 0;
    transitionToFrames = 0;
    transitionTotalFrames = 0;
    transitionElapsedFrames = 0;
    transitioning = false;
    hasHistory = false;
    wetAvailability = 0;
    readyFadeFrames = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.maxDelayFrames = Math.ceil(this.sampleRate * (60 / 40) * 8) + 4;
      this.leftDelay = new LagrangeFractionalDelay(this.maxDelayFrames);
      this.rightDelay = new LagrangeFractionalDelay(this.maxDelayFrames);
      this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
      this.currentOffsetBeats = this.pendingOffsetBeats = this.clampOffset(parameters.offsetBeats ?? 1);
      this.currentCrossfadeMs = this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs ?? 5);
      this.currentDelayFrames = this.delayFrames(this.currentBpm, this.currentOffsetBeats);
      this.transitionFromFrames = this.transitionToFrames = this.currentDelayFrames;
    }
    get diagnostics() {
      return {
        framesProcessed: this.framesProcessed,
        maxDelayFrames: this.maxDelayFrames,
        currentBpm: this.currentBpm,
        currentOffsetBeats: this.currentOffsetBeats,
        currentCrossfadeMs: this.currentCrossfadeMs,
        currentDelayFrames: this.currentDelayFrames,
        transitionCount: this.transitionCount,
        transitionRemainingFrames: this.transitioning ? this.transitionTotalFrames - this.transitionElapsedFrames : 0,
        wetAvailability: this.wetAvailability,
        hasHistory: this.hasHistory
      };
    }
    /** Delay of the currently committed read head, in frames at sampleRate. */
    get latencySamples() {
      return this.currentDelayFrames;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.offsetBeats)) this.pendingOffsetBeats = this.clampOffset(parameters.offsetBeats);
      if (Number.isFinite(parameters.crossfadeMs)) this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs);
    }
    /** Writes one stereo frame and renders with fixed delay heads. */
    processSample(left, right) {
      this.leftDelay.processSample(left, 0);
      this.rightDelay.processSample(right, 0);
      this.framesProcessed += 1;
      this.maybeBeginTransition();
      if (this.transitioning) {
        const position = this.transitionTotalFrames <= 1 ? 1 : this.transitionElapsedFrames / (this.transitionTotalFrames - 1);
        const fromLeft = this.leftDelay.readSample(this.transitionFromFrames);
        const fromRight = this.rightDelay.readSample(this.transitionFromFrames);
        const toLeft = this.leftDelay.readSample(this.transitionToFrames);
        const toRight = this.rightDelay.readSample(this.transitionToFrames);
        this.wetLeft = fromLeft * equalPowerFadeOutGain(position) + toLeft * equalPowerFadeInGain(position);
        this.wetRight = fromRight * equalPowerFadeOutGain(position) + toRight * equalPowerFadeInGain(position);
        this.transitionElapsedFrames += 1;
        if (this.transitionElapsedFrames >= this.transitionTotalFrames) {
          this.currentDelayFrames = this.transitionToFrames;
          this.transitioning = false;
        }
      } else {
        this.wetLeft = this.leftDelay.readSample(this.currentDelayFrames);
        this.wetRight = this.rightDelay.readSample(this.currentDelayFrames);
      }
      if (!this.hasHistory && this.framesProcessed >= Math.ceil(this.currentDelayFrames) + 4) {
        this.hasHistory = true;
        this.readyFadeFrames = Math.max(1, Math.round(this.sampleRate * this.currentCrossfadeMs / 1e3));
      }
      if (this.hasHistory && this.wetAvailability < 1) {
        this.wetAvailability = Math.min(1, this.wetAvailability + 1 / Math.max(1, this.readyFadeFrames));
      }
    }
    /** Amount of shifted signal available for the core's equal-power wet mix. */
    get mixAvailability() {
      return this.wetAvailability;
    }
    /** Reset only counters/visibility; ring storage stays fixed and is overwritten in place. */
    reset() {
      this.framesProcessed = 0;
      this.transitioning = false;
      this.transitionElapsedFrames = 0;
      this.transitionTotalFrames = 0;
      this.currentBpm = this.pendingBpm;
      this.currentOffsetBeats = this.pendingOffsetBeats;
      this.currentCrossfadeMs = this.pendingCrossfadeMs;
      this.currentDelayFrames = this.delayFrames(this.currentBpm, this.currentOffsetBeats);
      this.transitionFromFrames = this.transitionToFrames = this.currentDelayFrames;
      this.hasHistory = false;
      this.wetAvailability = 0;
      this.readyFadeFrames = 0;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.transitionCount = 0;
    }
    maybeBeginTransition() {
      if (this.transitioning) return;
      const nextDelay = this.delayFrames(this.pendingBpm, this.pendingOffsetBeats);
      const delayChanged = Math.abs(nextDelay - this.currentDelayFrames) >= 0.01;
      const controlsChanged = this.pendingBpm !== this.currentBpm || this.pendingOffsetBeats !== this.currentOffsetBeats || this.pendingCrossfadeMs !== this.currentCrossfadeMs;
      if (!controlsChanged) return;
      if (delayChanged && this.framesProcessed < Math.ceil(nextDelay) + 4) return;
      this.currentBpm = this.pendingBpm;
      this.currentOffsetBeats = this.pendingOffsetBeats;
      this.currentCrossfadeMs = this.pendingCrossfadeMs;
      if (!delayChanged) return;
      this.transitionFromFrames = this.currentDelayFrames;
      this.transitionToFrames = nextDelay;
      this.transitionTotalFrames = Math.max(1, Math.round(this.sampleRate * this.currentCrossfadeMs / 1e3));
      this.transitionElapsedFrames = 0;
      this.transitioning = true;
      this.transitionCount += 1;
    }
    delayFrames(bpm, offsetBeats) {
      return Math.max(0, Math.min(
        this.maxDelayFrames - 4,
        (4 - offsetBeats) * (60 / bpm) * this.sampleRate
      ));
    }
    clampBpm(value) {
      return Math.max(40, Math.min(300, value));
    }
    clampOffset(value) {
      return Math.max(-4, Math.min(4, value));
    }
    clampCrossfade(value) {
      return Math.max(1, Math.min(50, value));
    }
  };

  // src/audio/fx/dsp/BrowserReverseDelayDsp.ts
  var SEGMENT_BEAT_OPTIONS = [0.25, 0.5, 1, 2, 4];
  var BrowserReverseDelayDsp = class {
    sampleRate;
    maxSegmentFrames;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    boundaryCount = 0;
    crossfadeCount = 0;
    leftBuffers;
    rightBuffers;
    outgoingTailLeft;
    outgoingTailRight;
    captureBufferIndex = 0;
    playbackBufferIndex = -1;
    captureFrames = 0;
    playbackLength = 0;
    playbackDurationFrames = 0;
    playbackElapsedFrames = 0;
    activeSegmentFrames;
    currentBpm;
    currentSegmentBeats;
    currentFeedback;
    currentCrossfadeMs;
    pendingBpm;
    pendingSegmentBeats;
    pendingFeedback;
    pendingCrossfadeMs;
    overlapFrames = 0;
    outgoingTailFrames = 0;
    hasCapturedSegment = false;
    hasPreviousTail = false;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.maxSegmentFrames = Math.ceil(this.sampleRate * (60 / 40) * 4);
      this.leftBuffers = [new Float32Array(this.maxSegmentFrames), new Float32Array(this.maxSegmentFrames)];
      this.rightBuffers = [new Float32Array(this.maxSegmentFrames), new Float32Array(this.maxSegmentFrames)];
      const maxOverlapFrames = Math.max(1, Math.floor(this.sampleRate * 0.1));
      this.outgoingTailLeft = new Float32Array(maxOverlapFrames);
      this.outgoingTailRight = new Float32Array(maxOverlapFrames);
      this.currentBpm = this.pendingBpm = this.clampBpm(Number.isFinite(parameters.bpm) ? parameters.bpm : 120);
      this.currentSegmentBeats = this.pendingSegmentBeats = this.quantizeBeats(Number.isFinite(parameters.segmentBeats) ? parameters.segmentBeats : 1);
      this.currentFeedback = this.pendingFeedback = this.clampFeedback(Number.isFinite(parameters.feedback) ? parameters.feedback : 0.2);
      this.currentCrossfadeMs = this.pendingCrossfadeMs = this.clampCrossfade(Number.isFinite(parameters.crossfadeMs) ? parameters.crossfadeMs : 20);
      this.activeSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
      this.overlapFrames = this.computeOverlapFrames(this.activeSegmentFrames, this.currentCrossfadeMs);
    }
    /** A read-only view for deterministic tempo, segment, and crossfade tests. */
    get diagnostics() {
      return {
        framesProcessed: this.framesProcessed,
        boundaryCount: this.boundaryCount,
        crossfadeCount: this.crossfadeCount,
        activeBpm: this.currentBpm,
        activeSegmentBeats: this.currentSegmentBeats,
        activeSegmentFrames: this.activeSegmentFrames,
        pendingBpm: this.pendingBpm,
        pendingSegmentBeats: this.pendingSegmentBeats,
        remainingFramesToBoundary: this.activeSegmentFrames - this.captureFrames,
        playbackElapsedFrames: this.playbackElapsedFrames,
        playbackDurationFrames: this.playbackDurationFrames,
        overlapFrames: this.overlapFrames,
        maxSegmentFrames: this.maxSegmentFrames,
        hasCapturedSegment: this.hasCapturedSegment
      };
    }
    /**
     * A complete source segment must be buffered before reverse playback begins.
     * The reported sample-clocked segment-buffering latency is deliberately one
     * full segment (the catalog's lower bound is one half segment); the reverse
     * mapping itself is position-dependent, and the dry mix remains immediate.
     */
    get latencySamples() {
      return this.activeSegmentFrames;
    }
    get hasCaptured() {
      return this.hasCapturedSegment;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.segmentBeats)) this.pendingSegmentBeats = this.quantizeBeats(parameters.segmentBeats);
      if (Number.isFinite(parameters.feedback)) this.pendingFeedback = this.clampFeedback(parameters.feedback);
      if (Number.isFinite(parameters.crossfadeMs)) this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs);
    }
    /** Mutates wetLeft/wetRight; storage is fixed and no callback allocations occur. */
    processSample(left, right) {
      let wetLeft = 0;
      let wetRight = 0;
      if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
        const sourceOffset = this.reverseSourceOffset(this.playbackElapsedFrames);
        const playbackLeft = this.leftBuffers[this.playbackBufferIndex];
        const playbackRight = this.rightBuffers[this.playbackBufferIndex];
        wetLeft = playbackLeft[sourceOffset] ?? 0;
        wetRight = playbackRight[sourceOffset] ?? 0;
        const activeOverlapFrames = Math.min(this.overlapFrames, this.outgoingTailFrames);
        if (this.hasPreviousTail && this.playbackElapsedFrames < activeOverlapFrames) {
          const position = activeOverlapFrames <= 1 ? 1 : this.playbackElapsedFrames / (activeOverlapFrames - 1);
          wetLeft = this.outgoingTailLeft[this.playbackElapsedFrames] * Math.cos(position * Math.PI / 2) + wetLeft * Math.sin(position * Math.PI / 2);
          wetRight = this.outgoingTailRight[this.playbackElapsedFrames] * Math.cos(position * Math.PI / 2) + wetRight * Math.sin(position * Math.PI / 2);
        }
      }
      if (!Number.isFinite(wetLeft)) wetLeft = 0;
      if (!Number.isFinite(wetRight)) wetRight = 0;
      this.wetLeft = wetLeft;
      this.wetRight = wetRight;
      const captureLeft = this.leftBuffers[this.captureBufferIndex];
      const captureRight = this.rightBuffers[this.captureBufferIndex];
      const feedback = this.currentFeedback;
      captureLeft[this.captureFrames] = this.boundCapture(left + feedback * this.boundFeedback(wetLeft));
      captureRight[this.captureFrames] = this.boundCapture(right + feedback * this.boundFeedback(wetRight));
      this.captureFrames += 1;
      if (this.hasCapturedSegment) this.playbackElapsedFrames += 1;
      this.framesProcessed += 1;
      if (this.captureFrames >= this.activeSegmentFrames) this.onBoundary();
    }
    reset() {
      this.leftBuffers[0].fill(0);
      this.leftBuffers[1].fill(0);
      this.rightBuffers[0].fill(0);
      this.rightBuffers[1].fill(0);
      this.outgoingTailLeft.fill(0);
      this.outgoingTailRight.fill(0);
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
      this.activeSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
      this.overlapFrames = this.computeOverlapFrames(this.activeSegmentFrames, this.currentCrossfadeMs);
      this.outgoingTailFrames = 0;
      this.hasCapturedSegment = false;
      this.hasPreviousTail = false;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.framesProcessed = 0;
      this.boundaryCount = 0;
      this.crossfadeCount = 0;
    }
    onBoundary() {
      this.currentBpm = this.pendingBpm;
      this.currentSegmentBeats = this.pendingSegmentBeats;
      this.currentFeedback = this.pendingFeedback;
      this.currentCrossfadeMs = this.pendingCrossfadeMs;
      this.activeSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
      this.overlapFrames = this.computeOverlapFrames(this.activeSegmentFrames, this.currentCrossfadeMs);
      if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
        const copyFrames = Math.min(this.overlapFrames, this.playbackDurationFrames);
        for (let frame = 0; frame < copyFrames; frame += 1) {
          const offset = this.reverseSourceOffset(this.playbackDurationFrames - copyFrames + frame);
          this.outgoingTailLeft[frame] = this.leftBuffers[this.playbackBufferIndex][offset] ?? 0;
          this.outgoingTailRight[frame] = this.rightBuffers[this.playbackBufferIndex][offset] ?? 0;
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
      this.hasCapturedSegment = this.playbackLength > 0;
      this.boundaryCount += 1;
      this.playbackDurationFrames = this.activeSegmentFrames;
      this.playbackElapsedFrames = 0;
    }
    reverseSourceOffset(elapsedFrames) {
      if (this.playbackLength <= 1 || this.playbackDurationFrames <= 1) return Math.max(0, this.playbackLength - 1);
      const reversePosition = Math.max(0, this.playbackDurationFrames - 1 - elapsedFrames);
      return Math.min(
        this.playbackLength - 1,
        Math.floor(reversePosition * this.playbackLength / this.playbackDurationFrames)
      );
    }
    segmentFrames(bpm, beats) {
      return Math.max(1, Math.min(this.maxSegmentFrames, Math.round(this.sampleRate * (60 / bpm) * beats)));
    }
    computeOverlapFrames(segmentFrames, crossfadeMs) {
      const requested = Math.max(1, Math.round(this.sampleRate * crossfadeMs / 1e3));
      return Math.max(1, Math.min(requested, Math.floor(segmentFrames / 2), this.outgoingTailLeft.length));
    }
    quantizeBeats(value) {
      if (!Number.isFinite(value)) return 1;
      let nearest = SEGMENT_BEAT_OPTIONS[0];
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < SEGMENT_BEAT_OPTIONS.length; index += 1) {
        const candidate = SEGMENT_BEAT_OPTIONS[index];
        const candidateDistance = Math.abs(value - candidate);
        if (candidateDistance < distance) {
          nearest = candidate;
          distance = candidateDistance;
        }
      }
      return nearest;
    }
    clampBpm(value) {
      return Number.isFinite(value) ? Math.max(40, Math.min(300, value)) : 120;
    }
    clampFeedback(value) {
      return Number.isFinite(value) ? Math.max(0, Math.min(0.95, value)) : 0.2;
    }
    clampCrossfade(value) {
      return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 20;
    }
    boundFeedback(value) {
      return Math.max(-1, Math.min(1, value));
    }
    boundCapture(value) {
      return Math.max(-8, Math.min(8, Number.isFinite(value) ? value : 0));
    }
  };

  // src/audio/fx/dsp/BrowserReverseReverbDsp.ts
  var SEGMENT_BEAT_OPTIONS2 = [0.25, 0.5, 1, 2, 4];
  var FDN_DELAY_SECONDS = [0.0297, 0.0371, 0.0411, 0.0533, 0.0617, 0.0719, 0.0797, 0.0893];
  var DIFFUSER_DELAY_SECONDS = [37e-4, 53e-4, 71e-4, 0.0113];
  var ALLPASS_COEFFICIENTS = [0.68, 0.62, 0.57, 0.53];
  var MAX_INTERNAL_SAMPLE = 8;
  var MAX_FEEDBACK = 0.8;
  function finiteOrZero(value) {
    return Number.isFinite(value) ? value : 0;
  }
  function clamp13(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  var BrowserReverseReverbDsp = class {
    sampleRate;
    maxSegmentFrames;
    maxBufferSamples;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    boundaryCount = 0;
    crossfadeCount = 0;
    captureLeft;
    captureRight;
    outgoingTailLeft;
    outgoingTailRight;
    diffuserBuffers;
    diffuserWriteIndices;
    fdnBuffers;
    fdnWriteIndices;
    fdnDampingStates;
    fdnFeedbackGains;
    captureBufferIndex = 0;
    playbackBufferIndex = -1;
    captureFrames = 0;
    playbackLength = 0;
    playbackDurationFrames = 0;
    playbackElapsedFrames = 0;
    currentSegmentFrames;
    currentBpm;
    currentSegmentBeats;
    currentFeedback;
    currentCrossfadeMs;
    currentDecaySeconds;
    currentDampingCutoffHz;
    pendingBpm;
    pendingSegmentBeats;
    pendingFeedback;
    pendingCrossfadeMs;
    overlapFrames = 0;
    outgoingTailFrames = 0;
    hasCapturedSegment = false;
    hasPreviousTail = false;
    dampingAlpha;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
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
      this.currentDecaySeconds = clamp13(finiteOrZero(parameters.decaySeconds ?? 2), 0.1, 10);
      this.currentDampingCutoffHz = clamp13(finiteOrZero(parameters.dampingCutoffHz ?? 8e3), 500, Math.min(16e3, this.sampleRate * 0.499));
      this.currentSegmentFrames = this.segmentFrames(this.currentBpm, this.currentSegmentBeats);
      this.dampingAlpha = 1 - Math.exp(-2 * Math.PI * this.currentDampingCutoffHz / this.sampleRate);
      this.refreshFeedbackGains();
      this.overlapFrames = this.computeOverlapFrames(this.currentSegmentFrames, this.currentCrossfadeMs);
      this.maxBufferSamples = this.captureLeft[0].length * 4 + this.outgoingTailLeft.length * 2 + this.totalSamples(this.diffuserBuffers) + this.totalSamples(this.fdnBuffers) + this.diffuserWriteIndices[0].length * 2 + this.fdnWriteIndices[0].length * 2 + this.fdnDampingStates[0].length * 4 + this.fdnFeedbackGains[0].length * 4;
    }
    /** One complete input-segment buffer is the intentional reverse pre-delay. */
    get latencySamples() {
      return this.currentSegmentFrames;
    }
    get hasCaptured() {
      return this.hasCapturedSegment;
    }
    get diagnostics() {
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
        hasCapturedSegment: this.hasCapturedSegment
      };
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.segmentBeats)) this.pendingSegmentBeats = this.quantizeBeats(parameters.segmentBeats);
      if (Number.isFinite(parameters.feedbackPercent)) this.pendingFeedback = this.clampFeedbackPercent(parameters.feedbackPercent);
      if (Number.isFinite(parameters.crossfadeMs)) this.pendingCrossfadeMs = this.clampCrossfade(parameters.crossfadeMs);
      if (Number.isFinite(parameters.decaySeconds)) {
        this.currentDecaySeconds = clamp13(parameters.decaySeconds, 0.1, 10);
        this.refreshFeedbackGains();
      }
      if (Number.isFinite(parameters.dampingCutoffHz)) {
        this.currentDampingCutoffHz = clamp13(parameters.dampingCutoffHz, 500, Math.min(16e3, this.sampleRate * 0.499));
        this.dampingAlpha = 1 - Math.exp(-2 * Math.PI * this.currentDampingCutoffHz / this.sampleRate);
      }
    }
    /** Mutates wetLeft/wetRight without allocating or assuming a block size. */
    processSample(inputLeft, inputRight) {
      const safeLeft = clamp13(finiteOrZero(inputLeft), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      const safeRight = clamp13(finiteOrZero(inputRight), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      let reverseInputLeft = 0;
      let reverseInputRight = 0;
      if (this.hasCapturedSegment && this.playbackBufferIndex >= 0 && this.playbackLength > 0) {
        const sourceOffset = this.reverseSourceOffset(this.playbackElapsedFrames);
        reverseInputLeft = this.captureLeft[this.playbackBufferIndex][sourceOffset] ?? 0;
        reverseInputRight = this.captureRight[this.playbackBufferIndex][sourceOffset] ?? 0;
        if (this.hasPreviousTail && this.playbackElapsedFrames < this.outgoingTailFrames) {
          const position = this.outgoingTailFrames <= 1 ? 1 : this.playbackElapsedFrames / (this.outgoingTailFrames - 1);
          const fadeOut = Math.cos(position * Math.PI / 2);
          const fadeIn = Math.sin(position * Math.PI / 2);
          reverseInputLeft = this.outgoingTailLeft[this.playbackElapsedFrames] * fadeOut + reverseInputLeft * fadeIn;
          reverseInputRight = this.outgoingTailRight[this.playbackElapsedFrames] * fadeOut + reverseInputRight * fadeIn;
        }
      }
      this.wetLeft = this.processFdn(reverseInputLeft, reverseInputRight, 0);
      this.wetRight = this.processFdn(reverseInputRight, reverseInputLeft, 1);
      const captureLeft = this.captureLeft[this.captureBufferIndex];
      const captureRight = this.captureRight[this.captureBufferIndex];
      captureLeft[this.captureFrames] = clamp13(finiteOrZero(safeLeft + this.currentFeedback * this.wetLeft), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      captureRight[this.captureFrames] = clamp13(finiteOrZero(safeRight + this.currentFeedback * this.wetRight), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      this.captureFrames += 1;
      if (this.hasCapturedSegment) this.playbackElapsedFrames += 1;
      this.framesProcessed += 1;
      if (this.captureFrames >= this.currentSegmentFrames) this.onBoundary();
    }
    reset() {
      this.captureLeft[0].fill(0);
      this.captureLeft[1].fill(0);
      this.captureRight[0].fill(0);
      this.captureRight[1].fill(0);
      this.outgoingTailLeft.fill(0);
      this.outgoingTailRight.fill(0);
      for (let channel = 0; channel < 2; channel += 1) {
        const diffusers = this.diffuserBuffers[channel];
        const lines = this.fdnBuffers[channel];
        for (const buffer of diffusers) buffer.fill(0);
        for (const buffer of lines) buffer.fill(0);
        this.diffuserWriteIndices[channel].fill(0);
        this.fdnWriteIndices[channel].fill(0);
        this.fdnDampingStates[channel].fill(0);
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
    createDiffusers(channel) {
      const channelScale = channel === 0 ? 1 : 1.071;
      return DIFFUSER_DELAY_SECONDS.map((seconds) => new Float32Array(
        Math.max(1, Math.round(this.sampleRate * seconds * channelScale))
      ));
    }
    createFdnLines(channel) {
      const channelScale = channel === 0 ? 1 : 1.037;
      return FDN_DELAY_SECONDS.map((seconds) => new Float32Array(
        Math.max(1, Math.round(this.sampleRate * seconds * channelScale))
      ));
    }
    processFdn(input, crossInput, channel) {
      const diffusers = this.diffuserBuffers[channel];
      const diffuserIndices = this.diffuserWriteIndices[channel];
      let diffused = input;
      for (let stage = 0; stage < diffusers.length; stage += 1) {
        const buffer = diffusers[stage];
        const writeIndex = diffuserIndices[stage] ?? 0;
        const delayed = buffer[writeIndex] ?? 0;
        const coefficient = ALLPASS_COEFFICIENTS[stage] ?? 0.5;
        const output2 = delayed - coefficient * diffused;
        buffer[writeIndex] = clamp13(finiteOrZero(diffused + coefficient * output2), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
        diffuserIndices[stage] = writeIndex + 1 >= buffer.length ? 0 : writeIndex + 1;
        diffused = clamp13(finiteOrZero(output2), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      }
      const lines = this.fdnBuffers[channel];
      const writeIndices = this.fdnWriteIndices[channel];
      const dampingStates = this.fdnDampingStates[channel];
      const d0 = this.readDamped(lines[0], writeIndices, 0, dampingStates);
      const d1 = this.readDamped(lines[1], writeIndices, 1, dampingStates);
      const d2 = this.readDamped(lines[2], writeIndices, 2, dampingStates);
      const d3 = this.readDamped(lines[3], writeIndices, 3, dampingStates);
      const d4 = this.readDamped(lines[4], writeIndices, 4, dampingStates);
      const d5 = this.readDamped(lines[5], writeIndices, 5, dampingStates);
      const d6 = this.readDamped(lines[6], writeIndices, 6, dampingStates);
      const d7 = this.readDamped(lines[7], writeIndices, 7, dampingStates);
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
      this.writeFdnLine(lines[0], writeIndices, 0, primaryInput + crossInjection + h0 * feedback[0]);
      this.writeFdnLine(lines[1], writeIndices, 1, primaryInput - crossInjection + h1 * feedback[1]);
      this.writeFdnLine(lines[2], writeIndices, 2, -primaryInput + crossInjection + h2 * feedback[2]);
      this.writeFdnLine(lines[3], writeIndices, 3, -primaryInput - crossInjection + h3 * feedback[3]);
      this.writeFdnLine(lines[4], writeIndices, 4, primaryInput + crossInjection + h4 * feedback[4]);
      this.writeFdnLine(lines[5], writeIndices, 5, -primaryInput + crossInjection + h5 * feedback[5]);
      this.writeFdnLine(lines[6], writeIndices, 6, -primaryInput - crossInjection + h6 * feedback[6]);
      this.writeFdnLine(lines[7], writeIndices, 7, primaryInput - crossInjection + h7 * feedback[7]);
      const output = (d0 - d1 + d2 - d3 + d4 - d5 + d6 - d7) * 0.24;
      return clamp13(finiteOrZero(output), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
    }
    readDamped(buffer, writeIndices, line, dampingStates) {
      const delayed = buffer[writeIndices[line] ?? 0] ?? 0;
      const prior = dampingStates[line] ?? 0;
      const state = prior + this.dampingAlpha * (delayed - prior);
      dampingStates[line] = Number.isFinite(state) ? state : 0;
      return dampingStates[line] ?? 0;
    }
    writeFdnLine(buffer, writeIndices, line, value) {
      const writeIndex = writeIndices[line] ?? 0;
      buffer[writeIndex] = clamp13(finiteOrZero(value), -MAX_INTERNAL_SAMPLE, MAX_INTERNAL_SAMPLE);
      writeIndices[line] = writeIndex + 1 >= buffer.length ? 0 : writeIndex + 1;
    }
    refreshFeedbackGains() {
      for (let channel = 0; channel < 2; channel += 1) {
        const channelScale = channel === 0 ? 1 : 1.037;
        for (let line = 0; line < FDN_DELAY_SECONDS.length; line += 1) {
          const delaySeconds = (FDN_DELAY_SECONDS[line] ?? 0.03) * channelScale;
          const gain = Math.pow(1e-3, delaySeconds / this.currentDecaySeconds);
          this.fdnFeedbackGains[channel][line] = clamp13(gain, 0, 0.995);
        }
      }
    }
    computeOverlapFrames(segmentFrames, crossfadeMs) {
      const requested = Math.round(this.sampleRate * crossfadeMs / 1e3);
      return Math.max(1, Math.min(requested, Math.floor(segmentFrames / 2), this.outgoingTailLeft.length));
    }
    onBoundary() {
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
          this.outgoingTailLeft[frame] = this.captureLeft[this.playbackBufferIndex][offset] ?? 0;
          this.outgoingTailRight[frame] = this.captureRight[this.playbackBufferIndex][offset] ?? 0;
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
    reverseSourceOffset(elapsedFrames) {
      if (this.playbackLength <= 1 || this.playbackDurationFrames <= 1) return Math.max(0, this.playbackLength - 1);
      const reversePosition = Math.max(0, this.playbackDurationFrames - 1 - elapsedFrames);
      return Math.min(this.playbackLength - 1, Math.floor(reversePosition * this.playbackLength / this.playbackDurationFrames));
    }
    segmentFrames(bpm, beats) {
      return Math.max(1, Math.min(this.maxSegmentFrames, Math.round(this.sampleRate * (60 / bpm) * beats)));
    }
    quantizeBeats(value) {
      if (!Number.isFinite(value)) return 0.5;
      let nearest = SEGMENT_BEAT_OPTIONS2[0];
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < SEGMENT_BEAT_OPTIONS2.length; index += 1) {
        const candidate = SEGMENT_BEAT_OPTIONS2[index];
        const candidateDistance = Math.abs(value - candidate);
        if (candidateDistance < distance) {
          nearest = candidate;
          distance = candidateDistance;
        }
      }
      return nearest;
    }
    clampBpm(value) {
      return clamp13(finiteOrZero(value), 30, 300);
    }
    clampFeedbackPercent(value) {
      return clamp13(finiteOrZero(value), 0, MAX_FEEDBACK * 100) / 100;
    }
    clampCrossfade(value) {
      return clamp13(finiteOrZero(value), 1, 100);
    }
    totalSamples(buffers) {
      let total = 0;
      for (let channel = 0; channel < 2; channel += 1) {
        for (const buffer of buffers[channel]) total += buffer.length;
      }
      return total;
    }
  };

  // src/audio/fx/dsp/BrowserAutoRiffDsp.ts
  var BEAT_STEP_RATES = [0.25, 0.5, 1, 2, 4];
  var SCALE_INTERVALS = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    // chromatic
    [0, 2, 4, 5, 7, 9, 11],
    // major
    [0, 2, 3, 5, 7, 8, 10],
    // natural minor
    [0, 2, 3, 5, 7, 8, 11],
    // harmonic minor
    [0, 2, 4, 7, 9]
    // major pentatonic
  ];
  var RIFF_DEGREES = [0, 2, 4, 6, 4, 2, 0, -2];
  var DECIMATION_FACTOR = 4;
  var YIN_BUFFER_SIZE = 2048;
  var YIN_BUFFER_MASK = YIN_BUFFER_SIZE - 1;
  var YIN_MIN_F0_HZ = 55;
  var YIN_MAX_F0_HZ = 1100;
  var YIN_HOP_DECIMATED = 64;
  var PITCH_CONFIDENCE_THRESHOLD = 0.62;
  var QUEUE_CAPACITY = 32;
  var QUEUE_MASK = QUEUE_CAPACITY - 1;
  var ONSET_REFRACTORY_MS = 90;
  var PENDING_ONSET_MAX_MS = 300;
  var BrowserAutoRiffDsp = class {
    sampleRate;
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
    decimatedRate;
    onsetAttackAlpha;
    onsetReleaseAlpha;
    onsetBaselineAlpha;
    maxLag;
    minLag;
    yinWindow;
    yinRing = new Float32Array(YIN_BUFFER_SIZE);
    yinCmnd = new Float32Array(256);
    queueFrames = new Float64Array(QUEUE_CAPACITY);
    queueSemitones = new Int8Array(QUEUE_CAPACITY);
    queueHead = 0;
    queueTail = 0;
    queueCount = 0;
    decimationSum = 0;
    decimationCount = 0;
    decimatedSamples = 0;
    analysisCountdown = YIN_HOP_DECIMATED;
    totalSinceReset = 0;
    failedPitchAnalyses = 0;
    fastEnergy = 0;
    slowEnergy = 0;
    previousFastEnergy = 0;
    onsetArmed = true;
    nextOnsetFrame = 0;
    pendingOnset = false;
    pendingOnsetFrame = -1;
    nextSequenceFrame = -1;
    sequenceStep = 0;
    sequenceActive = false;
    riffRootMidi = 0;
    currentBpm;
    currentBeatStepRate;
    currentScale;
    currentOnsetSensitivity;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.decimatedRate = this.sampleRate / DECIMATION_FACTOR;
      this.onsetAttackAlpha = 1 - Math.exp(-1 / (4e-3 * this.sampleRate));
      this.onsetReleaseAlpha = 1 - Math.exp(-1 / (0.08 * this.sampleRate));
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
    get latencyFrames() {
      return (this.yinWindow + this.maxLag + YIN_HOP_DECIMATED) * DECIMATION_FACTOR;
    }
    get activeBpm() {
      return this.currentBpm;
    }
    get activeBeatStepRate() {
      return this.currentBeatStepRate;
    }
    get activeScale() {
      return this.currentScale;
    }
    get activeOnsetSensitivity() {
      return this.currentOnsetSensitivity;
    }
    get queueDepth() {
      return this.queueCount;
    }
    get stepFrames() {
      return this.intervalFrames();
    }
    get diagnostics() {
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
        framesProcessed: this.framesProcessed
      };
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.currentBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.beatStepRate)) this.currentBeatStepRate = this.clampRate(parameters.beatStepRate);
      if (Number.isFinite(parameters.scale)) this.currentScale = this.clampScale(parameters.scale);
      if (Number.isFinite(parameters.onsetSensitivity)) {
        this.currentOnsetSensitivity = this.clampSensitivity(parameters.onsetSensitivity);
      }
    }
    setTempo(bpm, beatStepRate) {
      if (Number.isFinite(bpm)) this.currentBpm = this.clampBpm(bpm);
      if (Number.isFinite(beatStepRate)) this.currentBeatStepRate = this.clampRate(beatStepRate);
    }
    setScale(scale) {
      if (Number.isFinite(scale)) this.currentScale = this.clampScale(scale);
    }
    setOnsetSensitivity(sensitivity) {
      if (Number.isFinite(sensitivity)) this.currentOnsetSensitivity = this.clampSensitivity(sensitivity);
    }
    /**
     * Analyze caller-provided mono input. Pass the absolute audio frame so
     * sequence edges remain sample-clocked across variable callback segments.
     */
    processSample(input, frame) {
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
    processStereoSample(left, right, frame) {
      const l = Number.isFinite(left) ? left : 0;
      const r = Number.isFinite(right) ? right : 0;
      this.processSample((l + r) * 0.5, frame);
    }
    /** Pop one fixed-capacity primitive command into the mutable lastPopped* fields. */
    tryPopPitchChange() {
      if (this.queueCount <= 0) return false;
      this.lastPoppedFrame = this.queueFrames[this.queueHead];
      this.lastPoppedSemitones = this.queueSemitones[this.queueHead];
      this.queueHead = this.queueHead + 1 & QUEUE_MASK;
      this.queueCount -= 1;
      return true;
    }
    reset() {
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
    updateOnset(sample, frame) {
      const energy = sample * sample;
      const alpha = energy > this.fastEnergy ? this.onsetAttackAlpha : this.onsetReleaseAlpha;
      this.fastEnergy += alpha * (energy - this.fastEnergy);
      this.slowEnergy += this.onsetBaselineAlpha * (energy - this.slowEnergy);
      const sensitivity = this.currentOnsetSensitivity;
      const absoluteFloor = 65e-4 - 57e-4 * sensitivity;
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
    updateOnsetClock(frame) {
      this.nextOnsetFrame = frame + Math.max(1, Math.round(ONSET_REFRACTORY_MS * this.sampleRate / 1e3));
    }
    pushDecimatedSample(sample) {
      this.yinRing[this.decimatedSamples & YIN_BUFFER_MASK] = sample;
      this.decimatedSamples += 1;
      this.totalSinceReset += 1;
      this.analysisCountdown -= 1;
      if (this.analysisCountdown <= 0) {
        this.analysisCountdown = YIN_HOP_DECIMATED;
        if (this.totalSinceReset >= this.yinWindow + this.maxLag) this.analyzePitch();
      }
    }
    analyzePitch() {
      const newest = this.decimatedSamples - 1;
      let energy = 0;
      for (let i = 0; i < this.yinWindow; i += 1) {
        const sample = this.yinRing[newest - i & YIN_BUFFER_MASK];
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / this.yinWindow);
      if (!Number.isFinite(rms) || rms < 8e-4) {
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
          const a = this.yinRing[newest - i & YIN_BUFFER_MASK];
          const b = this.yinRing[newest - i - lag & YIN_BUFFER_MASK];
          const delta = a - b;
          difference += delta * delta;
        }
        cumulative += difference;
        const normalized = lag === 1 || cumulative <= 1e-20 ? 1 : difference * lag / cumulative;
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
        while (lag < this.maxLag && this.yinCmnd[lag + 1] < this.yinCmnd[lag]) lag += 1;
        bestLag = lag;
        bestCmnd = this.yinCmnd[lag];
      }
      if (bestLag < this.minLag || bestLag > this.maxLag || bestCmnd > (firstThresholdLag >= 0 ? 0.45 : 0.25)) {
        this.failedPitchAnalyses += 1;
        if (this.failedPitchAnalyses >= 2) this.clearPitch();
        return;
      }
      const before = this.yinCmnd[bestLag - 1] ?? bestCmnd;
      const center = this.yinCmnd[bestLag] ?? bestCmnd;
      const after = this.yinCmnd[bestLag + 1] ?? center;
      const denominator = before - 2 * center + after;
      const correction = Math.abs(denominator) > 1e-8 ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator)) : 0;
      const period = bestLag + correction;
      const frequency = this.decimatedRate / period;
      if (!Number.isFinite(frequency) || frequency < YIN_MIN_F0_HZ || frequency > YIN_MAX_F0_HZ) {
        this.failedPitchAnalyses += 1;
        if (this.failedPitchAnalyses >= 2) this.clearPitch();
        return;
      }
      this.failedPitchAnalyses = 0;
      this.pitchEstimateHz = frequency;
      this.pitchEstimateMidi = 69 + 12 * Math.log2(frequency / 440);
      this.pitchConfidence = Math.max(0, Math.min(1, 1 - bestCmnd));
      this.hasPitch = this.pitchConfidence >= PITCH_CONFIDENCE_THRESHOLD;
      if (!this.hasPitch) this.clearPitch();
    }
    clearPitch() {
      this.pitchEstimateHz = 0;
      this.pitchEstimateMidi = 0;
      this.pitchConfidence = 0;
      this.hasPitch = false;
      this.failedPitchAnalyses = 0;
      this.sequenceActive = false;
      this.step = -1;
    }
    startSequence(frame) {
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
    emitSequenceCommand(frame) {
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
      const duration = this.intervalFrames();
      if (this.nextSequenceFrame <= frame) {
        const skipped = Math.floor((frame - this.nextSequenceFrame) / duration) + 1;
        this.nextSequenceFrame += skipped * duration;
      }
    }
    intervalForDegree(degree, scale) {
      const intervals = SCALE_INTERVALS[scale] ?? SCALE_INTERVALS[0];
      const size = intervals.length;
      const octave = Math.floor(degree / size);
      const index = degree - octave * size;
      const relativeSemitones = (intervals[index] ?? 0) + 12 * octave;
      const root = this.riffRootMidi;
      const target = root + relativeSemitones;
      return Math.round(target - root);
    }
    enqueuePitchChange(frame, semitones) {
      if (this.queueCount >= QUEUE_CAPACITY) {
        this.queueOverflowCount += 1;
        return;
      }
      this.queueFrames[this.queueTail] = frame;
      this.queueSemitones[this.queueTail] = semitones;
      this.queueTail = this.queueTail + 1 & QUEUE_MASK;
      this.queueCount += 1;
    }
    intervalFrames() {
      return Math.max(1, Math.round(this.sampleRate * 60 * this.currentBeatStepRate / this.currentBpm));
    }
    pendingOnsetFrames() {
      return Math.max(1, Math.round(PENDING_ONSET_MAX_MS * this.sampleRate / 1e3));
    }
    clampBpm(value) {
      return Math.max(30, Math.min(300, value));
    }
    clampRate(value) {
      let nearest = BEAT_STEP_RATES[0];
      let difference = Math.abs(value - nearest);
      for (let i = 1; i < BEAT_STEP_RATES.length; i += 1) {
        const candidate = BEAT_STEP_RATES[i];
        const candidateDifference = Math.abs(value - candidate);
        if (candidateDifference < difference) {
          nearest = candidate;
          difference = candidateDifference;
        }
      }
      return nearest;
    }
    clampScale(value) {
      return Math.max(0, Math.min(4, Math.round(value)));
    }
    clampSensitivity(value) {
      return Math.max(0, Math.min(1, value));
    }
  };

  // src/audio/fx/dsp/BrowserHrmAutoDsp.ts
  var DEFAULT_EVENT_CAPACITY = 128;
  var DEFAULT_STATE_CAPACITY = 128;
  var DECIMATION_FACTOR2 = 4;
  var YIN_RING_SIZE = 2048;
  var YIN_RING_MASK = YIN_RING_SIZE - 1;
  var YIN_HOP = 64;
  var MIN_F0_HZ = 55;
  var MAX_F0_HZ = 1100;
  var MIN_RMS = 8e-4;
  var CONFIDENCE_THRESHOLD = 0.62;
  var INACTIVE_TARGET = -128;
  var STATE_TARGET_EPSILON = 0.25;
  var MAX_NOTE = 127;
  var SCALE_INTERVALS2 = [
    [0, 2, 4, 5, 7, 9, 11],
    // Major
    [0, 2, 3, 5, 7, 8, 10],
    // Natural minor
    [0, 2, 3, 5, 7, 8, 11],
    // Harmonic minor
    [0, 2, 3, 5, 7, 9, 10],
    // Dorian
    [0, 2, 4, 5, 7, 9, 10]
    // Mixolydian
  ];
  var BrowserHrmAutoDsp = class {
    sampleRate;
    pitchEstimateHz = 0;
    pitchEstimateMidi = 0;
    pitchConfidence = 0;
    hasPitch = false;
    midiOverflowCount = 0;
    stateOverflowCount = 0;
    framesProcessed = 0;
    /** Mutable output fields populated by `tryPopStateChange`; no event object is allocated. */
    lastStateChangeFrame = -1;
    lastStateChangeReason = 0;
    lastStateChangeNote = -1;
    lastStateChangeNoteOn = false;
    lastStateChangeActiveCount = 0;
    lastStateChangeVoiceCount = 0;
    lastStateChangeTarget1 = INACTIVE_TARGET;
    lastStateChangeTarget2 = INACTIVE_TARGET;
    minLag;
    maxLag;
    yinWindow;
    decimatedRate;
    yinRing = new Float32Array(YIN_RING_SIZE);
    yinCmnd = new Float32Array(256);
    midiFrames;
    midiTypes;
    midiChannels;
    midiNotes;
    midiCount = 0;
    stateFrames;
    stateReasons;
    stateNotes;
    stateNoteOns;
    stateActiveCounts;
    stateVoiceCounts;
    stateTargets1;
    stateTargets2;
    stateHead = 0;
    stateTail = 0;
    stateCount = 0;
    activeNoteCounts = new Uint8Array(128);
    activeNoteCount = 0;
    keyValue;
    scaleValue;
    midiChannelValue;
    mixValue;
    voicesValue;
    currentVoiceCount = 0;
    currentTarget1 = INACTIVE_TARGET;
    currentTarget2 = INACTIVE_TARGET;
    decimationSum = 0;
    decimationCount = 0;
    decimatedSamples = 0;
    analysisCountdown = YIN_HOP;
    totalSinceReset = 0;
    failedAnalyses = 0;
    lastProcessedFrame = 0;
    constructor(sampleRate, options = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.decimatedRate = this.sampleRate / DECIMATION_FACTOR2;
      this.maxLag = Math.min(255, Math.floor(this.decimatedRate / MIN_F0_HZ));
      this.minLag = Math.max(2, Math.floor(this.decimatedRate / MAX_F0_HZ));
      this.yinWindow = Math.min(384, Math.max(64, this.maxLag * 2));
      const midiCapacity = this.capacity(options.eventCapacity, DEFAULT_EVENT_CAPACITY);
      const stateCapacity = this.capacity(options.stateCapacity, DEFAULT_STATE_CAPACITY);
      this.midiFrames = new Float64Array(midiCapacity);
      this.midiTypes = new Uint8Array(midiCapacity);
      this.midiChannels = new Uint8Array(midiCapacity);
      this.midiNotes = new Uint8Array(midiCapacity);
      this.stateFrames = new Float64Array(stateCapacity);
      this.stateReasons = new Uint8Array(stateCapacity);
      this.stateNotes = new Int16Array(stateCapacity);
      this.stateNoteOns = new Uint8Array(stateCapacity);
      this.stateActiveCounts = new Uint8Array(stateCapacity);
      this.stateVoiceCounts = new Uint8Array(stateCapacity);
      this.stateTargets1 = new Float32Array(stateCapacity);
      this.stateTargets2 = new Float32Array(stateCapacity);
      this.keyValue = this.clampKey(options.key ?? 0);
      this.scaleValue = this.clampScale(options.scale ?? 0);
      this.midiChannelValue = this.clampChannel(options.midiChannel ?? 1);
      this.mixValue = this.clampMix(options.mix ?? 70);
      this.voicesValue = this.clampVoices(options.voices ?? 2);
    }
    get latencyFrames() {
      return (this.yinWindow + this.maxLag + YIN_HOP) * DECIMATION_FACTOR2;
    }
    get activeMidiNoteCount() {
      return this.activeNoteCount;
    }
    get queueDepth() {
      return this.midiCount;
    }
    get stateQueueDepth() {
      return this.stateCount;
    }
    get key() {
      return this.keyValue;
    }
    get scale() {
      return this.scaleValue;
    }
    get midiChannel() {
      return this.midiChannelValue;
    }
    get mixPercent() {
      return this.mixValue;
    }
    get configuredVoiceCount() {
      return this.voicesValue;
    }
    get targetVoiceCount() {
      return this.currentVoiceCount;
    }
    get targetSemitones1() {
      return this.currentTarget1;
    }
    get targetSemitones2() {
      return this.currentTarget2;
    }
    /**
     * Enqueue a sample-frame-stamped MIDI note event. Events are kept in stable
     * frame order and the fixed queue rejects an event on overflow. `noteOn`
     * with velocity zero follows MIDI semantics and is treated as `noteOff`.
     */
    enqueueMidiEvent(type, channel, note, velocity, frame) {
      if (type !== "noteOn" && type !== "noteOff") return false;
      if (!Number.isInteger(channel) || channel < 1 || channel > 16) return false;
      if (!Number.isInteger(note) || note < 0 || note > MAX_NOTE) return false;
      if (!Number.isFinite(frame) || frame < 0) return false;
      if (this.midiCount >= this.midiFrames.length) {
        this.midiOverflowCount += 1;
        return false;
      }
      const normalizedType = type === "noteOn" && velocity > 0 ? 1 : 0;
      const eventFrame = Math.floor(frame);
      let insertion = this.midiCount;
      while (insertion > 0 && this.midiFrames[insertion - 1] > eventFrame) {
        this.copyMidiEvent(insertion - 1, insertion);
        insertion -= 1;
      }
      this.midiFrames[insertion] = eventFrame;
      this.midiTypes[insertion] = normalizedType;
      this.midiChannels[insertion] = channel;
      this.midiNotes[insertion] = note;
      this.midiCount += 1;
      return true;
    }
    /** Update control values. Changing channel clears held notes to avoid stuck voices. */
    setParameters(parameters) {
      let changed = false;
      if (Number.isFinite(parameters.key)) {
        const next = this.clampKey(parameters.key);
        changed ||= next !== this.keyValue;
        this.keyValue = next;
      }
      if (Number.isFinite(parameters.scale)) {
        const next = this.clampScale(parameters.scale);
        changed ||= next !== this.scaleValue;
        this.scaleValue = next;
      }
      if (Number.isFinite(parameters.midiChannel)) {
        const next = this.clampChannel(parameters.midiChannel);
        if (next !== this.midiChannelValue) {
          this.midiChannelValue = next;
          this.activeNoteCounts.fill(0);
          this.activeNoteCount = 0;
          changed = true;
        }
      }
      if (Number.isFinite(parameters.mix)) this.mixValue = this.clampMix(parameters.mix);
      if (Number.isFinite(parameters.voices)) {
        const next = this.clampVoices(parameters.voices);
        changed ||= next !== this.voicesValue;
        this.voicesValue = next;
      }
      if (changed) this.recomputeTargets(this.lastProcessedFrame, 0, -1, false, true);
    }
    /** Analyze one mono sample using an absolute audio frame. */
    processSample(input, frame) {
      const sampleFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : this.framesProcessed;
      const sample = Number.isFinite(input) ? Math.max(-8, Math.min(8, input)) : 0;
      this.framesProcessed += 1;
      this.lastProcessedFrame = sampleFrame;
      this.applyDueMidiEvents(sampleFrame);
      this.decimationSum += sample;
      this.decimationCount += 1;
      if (this.decimationCount >= DECIMATION_FACTOR2) {
        this.pushDecimatedSample(this.decimationSum / DECIMATION_FACTOR2, sampleFrame);
        this.decimationSum = 0;
        this.decimationCount = 0;
      }
    }
    /** Index in the ascending MIDI-note ordering; returns -1 for an invalid index. */
    getActiveMidiNote(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.activeNoteCount) return -1;
      let ordinal = 0;
      for (let note = 0; note <= MAX_NOTE; note += 1) {
        if (this.activeNoteCounts[note] === 0) continue;
        if (ordinal === index) return note;
        ordinal += 1;
      }
      return -1;
    }
    /** Pop the next fixed state record into the mutable lastStateChange* fields. */
    tryPopStateChange() {
      if (this.stateCount <= 0) return false;
      const index = this.stateHead;
      this.lastStateChangeFrame = this.stateFrames[index];
      this.lastStateChangeReason = this.stateReasons[index];
      this.lastStateChangeNote = this.stateNotes[index];
      this.lastStateChangeNoteOn = this.stateNoteOns[index] !== 0;
      this.lastStateChangeActiveCount = this.stateActiveCounts[index];
      this.lastStateChangeVoiceCount = this.stateVoiceCounts[index];
      this.lastStateChangeTarget1 = this.stateTargets1[index];
      this.lastStateChangeTarget2 = this.stateTargets2[index];
      this.stateHead += 1;
      if (this.stateHead >= this.stateFrames.length) this.stateHead = 0;
      this.stateCount -= 1;
      return true;
    }
    reset() {
      this.yinRing.fill(0);
      this.yinCmnd.fill(0);
      this.midiFrames.fill(0);
      this.midiTypes.fill(0);
      this.midiChannels.fill(0);
      this.midiNotes.fill(0);
      this.stateFrames.fill(0);
      this.stateReasons.fill(0);
      this.stateNotes.fill(0);
      this.stateNoteOns.fill(0);
      this.stateActiveCounts.fill(0);
      this.stateVoiceCounts.fill(0);
      this.stateTargets1.fill(0);
      this.stateTargets2.fill(0);
      this.activeNoteCounts.fill(0);
      this.midiCount = 0;
      this.stateHead = 0;
      this.stateTail = 0;
      this.stateCount = 0;
      this.activeNoteCount = 0;
      this.currentVoiceCount = 0;
      this.currentTarget1 = INACTIVE_TARGET;
      this.currentTarget2 = INACTIVE_TARGET;
      this.decimationSum = 0;
      this.decimationCount = 0;
      this.decimatedSamples = 0;
      this.analysisCountdown = YIN_HOP;
      this.totalSinceReset = 0;
      this.failedAnalyses = 0;
      this.pitchEstimateHz = 0;
      this.pitchEstimateMidi = 0;
      this.pitchConfidence = 0;
      this.hasPitch = false;
      this.midiOverflowCount = 0;
      this.stateOverflowCount = 0;
      this.framesProcessed = 0;
      this.lastProcessedFrame = 0;
      this.lastStateChangeFrame = -1;
      this.lastStateChangeReason = 0;
      this.lastStateChangeNote = -1;
      this.lastStateChangeNoteOn = false;
      this.lastStateChangeActiveCount = 0;
      this.lastStateChangeVoiceCount = 0;
      this.lastStateChangeTarget1 = INACTIVE_TARGET;
      this.lastStateChangeTarget2 = INACTIVE_TARGET;
    }
    applyDueMidiEvents(frame) {
      while (this.midiCount > 0 && this.midiFrames[0] <= frame) {
        const eventFrame = this.midiFrames[0];
        const type = this.midiTypes[0];
        const channel = this.midiChannels[0];
        const note = this.midiNotes[0];
        for (let i = 1; i < this.midiCount; i += 1) this.copyMidiEvent(i, i - 1);
        this.midiCount -= 1;
        if (channel !== this.midiChannelValue) continue;
        if (type === 1) {
          const activeCount = this.activeNoteCounts[note];
          if (activeCount === 0) this.activeNoteCount += 1;
          if (activeCount < 255) this.activeNoteCounts[note] = activeCount + 1;
          this.recomputeTargets(eventFrame, 1, note, true, true);
        } else {
          const activeCount = this.activeNoteCounts[note];
          if (activeCount > 0) {
            this.activeNoteCounts[note] = activeCount - 1;
            if (this.activeNoteCounts[note] === 0) {
              this.activeNoteCount -= 1;
            }
            this.recomputeTargets(eventFrame, 2, note, false, true);
          }
        }
      }
    }
    pushDecimatedSample(sample, frame) {
      this.yinRing[this.decimatedSamples & YIN_RING_MASK] = sample;
      this.decimatedSamples += 1;
      this.totalSinceReset += 1;
      this.analysisCountdown -= 1;
      if (this.analysisCountdown <= 0) {
        this.analysisCountdown = YIN_HOP;
        if (this.totalSinceReset >= this.yinWindow + this.maxLag) this.analyzePitch(frame);
      }
    }
    analyzePitch(frame) {
      const newest = this.decimatedSamples - 1;
      let energy = 0;
      for (let i = 0; i < this.yinWindow; i += 1) {
        const sample = this.yinRing[newest - i & YIN_RING_MASK];
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / this.yinWindow);
      if (!Number.isFinite(rms) || rms < MIN_RMS) {
        this.clearPitch(frame);
        return;
      }
      let cumulative = 0;
      let bestLag = -1;
      let bestCmnd = 1;
      let firstThresholdLag = -1;
      for (let lag = 1; lag <= this.maxLag; lag += 1) {
        let difference = 0;
        for (let i = 0; i < this.yinWindow; i += 1) {
          const a = this.yinRing[newest - i & YIN_RING_MASK];
          const b = this.yinRing[newest - i - lag & YIN_RING_MASK];
          const delta = a - b;
          difference += delta * delta;
        }
        cumulative += difference;
        const normalized = lag === 1 || cumulative <= 1e-20 ? 1 : difference * lag / cumulative;
        this.yinCmnd[lag] = normalized;
        if (lag >= this.minLag && normalized < bestCmnd) {
          bestCmnd = normalized;
          bestLag = lag;
        }
        if (lag >= this.minLag && firstThresholdLag < 0 && normalized < 0.16) firstThresholdLag = lag;
      }
      if (firstThresholdLag >= 0) {
        let lag = firstThresholdLag;
        while (lag < this.maxLag && this.yinCmnd[lag + 1] < this.yinCmnd[lag]) lag += 1;
        bestLag = lag;
        bestCmnd = this.yinCmnd[lag];
      }
      if (bestLag < this.minLag || bestLag > this.maxLag || bestCmnd > (firstThresholdLag >= 0 ? 0.45 : 0.25)) {
        this.failedAnalyses += 1;
        if (this.failedAnalyses >= 2) this.clearPitch(frame);
        return;
      }
      const before = this.yinCmnd[bestLag - 1] ?? bestCmnd;
      const center = this.yinCmnd[bestLag] ?? bestCmnd;
      const after = this.yinCmnd[bestLag + 1] ?? center;
      const denominator = before - 2 * center + after;
      const correction = Math.abs(denominator) > 1e-8 ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator)) : 0;
      const frequency = this.decimatedRate / (bestLag + correction);
      if (!Number.isFinite(frequency) || frequency < MIN_F0_HZ || frequency > MAX_F0_HZ) {
        this.failedAnalyses += 1;
        if (this.failedAnalyses >= 2) this.clearPitch(frame);
        return;
      }
      this.failedAnalyses = 0;
      this.pitchEstimateHz = frequency;
      this.pitchEstimateMidi = 69 + 12 * Math.log2(frequency / 440);
      this.pitchConfidence = Math.max(0, Math.min(1, 1 - bestCmnd));
      const nextHasPitch = this.pitchConfidence >= CONFIDENCE_THRESHOLD;
      if (!nextHasPitch) {
        this.hasPitch = false;
        this.clearPitch(frame);
        return;
      }
      const previousHasPitch = this.hasPitch;
      this.hasPitch = true;
      if (this.activeNoteCount > 0 && (previousHasPitch !== nextHasPitch || this.targetsNeedRefresh())) {
        this.recomputeTargets(frame, 0, -1, false, false);
      }
    }
    clearPitch(frame) {
      const hadPitch = this.hasPitch;
      this.pitchEstimateHz = 0;
      this.pitchEstimateMidi = 0;
      this.pitchConfidence = 0;
      this.hasPitch = false;
      this.failedAnalyses = 0;
      if (hadPitch && this.activeNoteCount > 0) this.recomputeTargets(frame, 0, -1, false, true);
    }
    recomputeTargets(frame, reason, note, noteOn, forceEvent) {
      const oldCount = this.currentVoiceCount;
      const oldTarget1 = this.currentTarget1;
      const oldTarget2 = this.currentTarget2;
      this.currentVoiceCount = 0;
      this.currentTarget1 = INACTIVE_TARGET;
      this.currentTarget2 = INACTIVE_TARGET;
      if (this.activeNoteCount > 0 && this.hasPitch) {
        let first = -1;
        let second = -1;
        for (let midi = 0; midi <= MAX_NOTE; midi += 1) {
          if (this.activeNoteCounts[midi] === 0) continue;
          if (first < 0) first = midi;
          else if (second < 0) {
            second = midi;
            break;
          }
        }
        if (this.activeNoteCount === 1 && first >= 0) {
          const root = this.snapToScale(first);
          const third = this.scaleDegreeAbove(root, 2);
          const fifth = this.scaleDegreeAbove(root, 4);
          this.currentTarget1 = this.shiftToNearestSource(third);
          if (this.voicesValue >= 2) this.currentTarget2 = this.shiftToNearestSource(fifth);
          this.currentVoiceCount = this.voicesValue >= 2 ? 2 : 1;
        } else if (first >= 0) {
          this.currentTarget1 = this.shiftToNearestSource(this.snapToScale(first));
          if (this.voicesValue >= 2 && second >= 0) {
            this.currentTarget2 = this.shiftToNearestSource(this.snapToScale(second));
          }
          this.currentVoiceCount = this.voicesValue >= 2 && second >= 0 ? 2 : 1;
        }
      }
      const targetChanged = this.currentVoiceCount !== oldCount || !this.closeTarget(this.currentTarget1, oldTarget1) || !this.closeTarget(this.currentTarget2, oldTarget2);
      if (forceEvent || targetChanged) {
        this.pushStateChange(frame, reason, note, noteOn);
      }
    }
    targetsNeedRefresh() {
      if (this.activeNoteCount === 0 || !this.hasPitch) return false;
      const previous = this.currentTarget1;
      const candidate = this.calculateTarget1();
      return Math.abs(candidate - previous) >= STATE_TARGET_EPSILON;
    }
    calculateTarget1() {
      let first = -1;
      let second = -1;
      for (let midi = 0; midi <= MAX_NOTE; midi += 1) {
        if (this.activeNoteCounts[midi] === 0) continue;
        if (first < 0) first = midi;
        else if (second < 0) {
          second = midi;
          break;
        }
      }
      if (first < 0) return INACTIVE_TARGET;
      const target = this.activeNoteCount === 1 ? this.scaleDegreeAbove(this.snapToScale(first), 2) : this.snapToScale(first);
      return this.shiftToNearestSource(target);
    }
    pushStateChange(frame, reason, note, noteOn) {
      if (this.stateCount >= this.stateFrames.length) {
        this.stateOverflowCount += 1;
        return;
      }
      const index = this.stateTail;
      this.stateFrames[index] = frame;
      this.stateReasons[index] = reason;
      this.stateNotes[index] = note;
      this.stateNoteOns[index] = noteOn ? 1 : 0;
      this.stateActiveCounts[index] = this.activeNoteCount;
      this.stateVoiceCounts[index] = this.currentVoiceCount;
      this.stateTargets1[index] = this.currentTarget1;
      this.stateTargets2[index] = this.currentTarget2;
      this.stateTail += 1;
      if (this.stateTail >= this.stateFrames.length) this.stateTail = 0;
      this.stateCount += 1;
    }
    snapToScale(note) {
      const intervals = SCALE_INTERVALS2[this.scaleValue];
      const baseOctave = Math.floor((note - this.keyValue) / 12);
      let best = note;
      let bestDistance = 127;
      for (let octave = baseOctave - 1; octave <= baseOctave + 1; octave += 1) {
        for (let i = 0; i < intervals.length; i += 1) {
          const candidate = this.keyValue + 12 * octave + intervals[i];
          const distance = Math.abs(candidate - note);
          if (candidate >= 0 && candidate <= MAX_NOTE && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
      return best;
    }
    scaleDegreeAbove(root, scaleDegrees) {
      const intervals = SCALE_INTERVALS2[this.scaleValue];
      const rootPc = ((root - this.keyValue) % 12 + 12) % 12;
      let rootDegree = 0;
      for (let i = 0; i < intervals.length; i += 1) {
        if (intervals[i] === rootPc) {
          rootDegree = i;
          break;
        }
      }
      const absoluteDegree = rootDegree + scaleDegrees;
      const octave = Math.floor(absoluteDegree / intervals.length);
      const degree = absoluteDegree - octave * intervals.length;
      const rootOctave = Math.floor((root - this.keyValue) / 12);
      return this.keyValue + rootOctave * 12 + octave * 12 + intervals[degree];
    }
    shiftToNearestSource(targetMidi) {
      const source = this.pitchEstimateMidi;
      let nearest = targetMidi;
      let nearestDistance = Math.abs(targetMidi - source);
      for (let octave = -3; octave <= 3; octave += 1) {
        const candidate = targetMidi + octave * 12;
        if (candidate < 0 || candidate > MAX_NOTE) continue;
        const distance = Math.abs(candidate - source);
        if (distance < nearestDistance || distance === nearestDistance && candidate < nearest) {
          nearest = candidate;
          nearestDistance = distance;
        }
      }
      return Math.max(-24, Math.min(24, nearest - source));
    }
    closeTarget(a, b) {
      if (a === INACTIVE_TARGET || b === INACTIVE_TARGET) return a === b;
      return Math.abs(a - b) < STATE_TARGET_EPSILON;
    }
    copyMidiEvent(from, to) {
      this.midiFrames[to] = this.midiFrames[from];
      this.midiTypes[to] = this.midiTypes[from];
      this.midiChannels[to] = this.midiChannels[from];
      this.midiNotes[to] = this.midiNotes[from];
    }
    capacity(value, fallback) {
      return Number.isInteger(value) ? Math.max(1, Math.min(4096, value)) : fallback;
    }
    clampKey(value) {
      return Math.max(0, Math.min(11, Math.round(value)));
    }
    clampScale(value) {
      return Math.max(0, Math.min(4, Math.round(value)));
    }
    clampChannel(value) {
      return Math.max(1, Math.min(16, Math.round(value)));
    }
    clampMix(value) {
      return Math.max(0, Math.min(100, value));
    }
    clampVoices(value) {
      return value < 1.5 ? 1 : 2;
    }
  };

  // src/audio/pitch/liveMono.ts
  function nextPowerOfTwo(value) {
    let result = 1;
    while (result < value) result *= 2;
    return result;
  }
  function finiteInRange(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max;
  }
  var YinPitchDetector = class {
    sampleRate;
    minimumFrequencyHz;
    maximumFrequencyHz;
    frameSamples;
    hopSamples;
    ring;
    differences;
    normalizedDifferences;
    ringMask;
    minimumLag;
    maximumLag;
    threshold;
    analysisWindowSamples;
    writeIndex = 0;
    sampleCount = 0;
    nextAnalysisSample;
    currentFrequencyHz = 0;
    currentConfidence = 0;
    currentVoiced = false;
    currentEstimateTimeSamples = 0;
    analysisSerialValue = 0;
    goodFrames = 0;
    badFrames = 0;
    smoothedLogFrequency = 0;
    constructor(sampleRate, options = {}) {
      if (!finiteInRange(sampleRate, 2e3, 48e3)) {
        throw new RangeError("YIN analysis sample rate must be from 2 kHz through 48 kHz");
      }
      const minimumFrequencyHz = options.minimumFrequencyHz ?? 70;
      const maximumFrequencyHz = options.maximumFrequencyHz ?? 1200;
      if (!finiteInRange(minimumFrequencyHz, 20, sampleRate / 2) || !finiteInRange(maximumFrequencyHz, minimumFrequencyHz + 1, sampleRate / 2)) {
        throw new RangeError("YIN frequency bounds must be finite, ordered and below Nyquist");
      }
      const threshold = options.threshold ?? 0.16;
      if (!finiteInRange(threshold, 0.03, 0.4)) {
        throw new RangeError("YIN threshold must be between 0.03 and 0.4");
      }
      this.sampleRate = sampleRate;
      this.minimumFrequencyHz = minimumFrequencyHz;
      this.maximumFrequencyHz = maximumFrequencyHz;
      this.threshold = threshold;
      this.minimumLag = Math.max(2, Math.floor(sampleRate / maximumFrequencyHz));
      this.maximumLag = Math.ceil(sampleRate / minimumFrequencyHz);
      this.frameSamples = Math.max(64, this.maximumLag * 3);
      this.hopSamples = options.hopSamples ?? Math.max(1, Math.round(sampleRate * 5e-3));
      if (!Number.isInteger(this.hopSamples) || this.hopSamples < 1 || this.hopSamples > this.frameSamples) {
        throw new RangeError("YIN hop must be an integer from 1 through the analysis frame length");
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
    get frequencyHz() {
      return this.currentVoiced ? this.currentFrequencyHz : 0;
    }
    /** YIN periodicity confidence in [0, 1]. */
    get confidence() {
      return this.currentConfidence;
    }
    /** Whether the tracker has met its voiced threshold and two-frame hysteresis. */
    get voiced() {
      return this.currentVoiced;
    }
    /** Approximate frame-center time, in samples from the first pushed sample. */
    get estimateTimeSamples() {
      return this.currentEstimateTimeSamples;
    }
    /** Increments once per completed YIN analysis, for allocation-free polling. */
    get analysisSerial() {
      return this.analysisSerialValue;
    }
    /** Push one decimated sample. This method is safe for a real-time callback. */
    pushSample(sample) {
      this.ring[this.writeIndex] = Number.isFinite(sample) ? sample : 0;
      this.writeIndex = this.writeIndex + 1 & this.ringMask;
      this.sampleCount += 1;
      if (this.sampleCount < this.nextAnalysisSample) return;
      this.analyzeFrame();
      this.nextAnalysisSample += this.hopSamples;
    }
    analyzeFrame() {
      let frameStart = this.writeIndex - this.frameSamples;
      if (frameStart < 0) frameStart += this.ring.length;
      let energy = 0;
      for (let i = 0; i < this.frameSamples; i += 1) {
        let index = frameStart + i;
        if (index >= this.ring.length) index -= this.ring.length;
        const sample = this.ring[index];
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
          const delta = this.ring[firstIndex] - this.ring[secondIndex];
          sum += delta * delta;
        }
        this.differences[lag] = sum;
      }
      let cumulativeDifference = 0;
      for (let lag = 1; lag <= this.maximumLag; lag += 1) {
        const difference = this.differences[lag];
        cumulativeDifference += difference;
        this.normalizedDifferences[lag] = cumulativeDifference > 1e-15 ? difference * lag / cumulativeDifference : 1;
      }
      let bestLag = 0;
      let bestValue = Number.POSITIVE_INFINITY;
      const activeThreshold = this.currentVoiced ? Math.min(0.28, this.threshold + 0.05) : this.threshold;
      for (let lag = this.minimumLag; lag <= this.maximumLag; lag += 1) {
        const value = this.normalizedDifferences[lag];
        if (value < bestValue) {
          bestValue = value;
          bestLag = lag;
        }
        if (value < activeThreshold && (lag === this.maximumLag || value <= this.normalizedDifferences[lag + 1])) {
          bestLag = lag;
          while (bestLag < this.maximumLag && this.normalizedDifferences[bestLag + 1] < this.normalizedDifferences[bestLag]) {
            bestLag += 1;
          }
          bestValue = this.normalizedDifferences[bestLag];
          break;
        }
      }
      this.currentEstimateTimeSamples = this.sampleCount - this.frameSamples / 2 - 0.5;
      this.currentConfidence = Number.isFinite(bestValue) ? Math.max(0, Math.min(1, 1 - bestValue)) : 0;
      const candidate = rms >= 1e-4 && bestLag > 0 && bestValue < activeThreshold;
      if (candidate) {
        this.goodFrames += 1;
        this.badFrames = 0;
        let refinedLag = bestLag;
        if (bestLag > this.minimumLag && bestLag < this.maximumLag) {
          const left = this.normalizedDifferences[bestLag - 1];
          const center = this.normalizedDifferences[bestLag];
          const right = this.normalizedDifferences[bestLag + 1];
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
  };
  var LiveMonoPitchProcessor = class {
    sampleRate;
    latencySamples;
    latencySeconds;
    minimumFrequencyHz;
    maximumFrequencyHz;
    /** Fixed input/transient/OLA ring slots; independent of callback block size. */
    bufferCapacitySamples;
    detector;
    decimation;
    detectorHopRawSamples;
    detectorDelayRawSamples;
    maximumPeriodSamples;
    maximumSearchRadius;
    generationDelaySamples;
    inputRing;
    transientRing;
    outputSumRing;
    outputWeightRing;
    pitchTimes;
    pitchFrequencies;
    pitchConfidences;
    pitchVoiced;
    pitchHistoryMask;
    transientHoldSamples;
    mixSmoothing;
    ratioSmoothing;
    inputSampleCursor = 0;
    decimatorCount = 0;
    decimatorSum = 0;
    detectorSerial = 0;
    pitchHistoryWrite = 0;
    pitchHistoryCount = 0;
    latestPitchHistoryIndex = -1;
    latestPitchTime = 0;
    nextSynthesisCenter = 0;
    currentRatio;
    targetRatio;
    targetSemitones;
    outputMix = 0;
    previousInput = 0;
    derivativeEnvelope = 0;
    transientCountdown = 0;
    lookupFrequency = 0;
    lookupConfidence = 0;
    lookupVoiced = false;
    constructor(options) {
      const sampleRate = options.sampleRate;
      if (!finiteInRange(sampleRate, 8e3, 192e3)) {
        throw new RangeError("sampleRate must be from 8 kHz through 192 kHz");
      }
      const minimumFrequencyHz = options.minimumFrequencyHz ?? 70;
      const maximumFrequencyHz = options.maximumFrequencyHz ?? 1200;
      const decimation = Math.max(1, Math.ceil(sampleRate / 12e3));
      const detectorRate = sampleRate / decimation;
      if (!finiteInRange(minimumFrequencyHz, 20, detectorRate / 2) || !finiteInRange(maximumFrequencyHz, minimumFrequencyHz + 1, detectorRate / 2)) {
        throw new RangeError("F0 limits must be finite, ordered and below the decimated Nyquist rate");
      }
      const semitones = options.semitones ?? 0;
      if (!finiteInRange(semitones, -12, 12)) {
        throw new RangeError("LIVE_MONO semitones must be between -12 and +12");
      }
      this.sampleRate = sampleRate;
      this.minimumFrequencyHz = minimumFrequencyHz;
      this.maximumFrequencyHz = maximumFrequencyHz;
      this.decimation = decimation;
      const detectorHopSamples = Math.max(1, Math.round(detectorRate * 5e-3));
      this.detectorHopRawSamples = detectorHopSamples * decimation;
      this.detector = new YinPitchDetector(detectorRate, {
        minimumFrequencyHz,
        maximumFrequencyHz,
        hopSamples: detectorHopSamples
      });
      this.maximumPeriodSamples = Math.ceil(sampleRate / minimumFrequencyHz);
      this.maximumSearchRadius = Math.ceil(this.maximumPeriodSamples / 2);
      this.detectorDelayRawSamples = Math.ceil(
        (this.detector.frameSamples / 2 + detectorHopSamples * 2 + 2) * decimation
      );
      this.generationDelaySamples = Math.max(
        this.detectorDelayRawSamples,
        this.maximumPeriodSamples + this.maximumSearchRadius
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
        Math.ceil((this.latencySamples + this.detectorDelayRawSamples) / this.detectorHopRawSamples) + 16
      );
      this.pitchTimes = new Float64Array(pitchHistoryLength);
      this.pitchFrequencies = new Float32Array(pitchHistoryLength);
      this.pitchConfidences = new Float32Array(pitchHistoryLength);
      this.pitchVoiced = new Uint8Array(pitchHistoryLength);
      this.pitchHistoryMask = pitchHistoryLength - 1;
      this.transientHoldSamples = Math.max(1, Math.round(sampleRate * 0.012));
      this.mixSmoothing = 1 - Math.exp(-1 / (sampleRate * 8e-3));
      this.ratioSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.012));
      this.targetSemitones = semitones;
      this.targetRatio = 2 ** (semitones / 12);
      this.currentRatio = this.targetRatio;
      this.nextSynthesisCenter = this.latencySamples;
    }
    /** Current requested transpose in semitones. */
    get semitones() {
      return this.targetSemitones;
    }
    /** Most recent YIN voicing decision, suitable for request-driven status reports. */
    get voiced() {
      return this.detector.voiced;
    }
    /** Most recent YIN F0 estimate in hertz, or 0 while unvoiced. */
    get frequencyHz() {
      return this.detector.frequencyHz;
    }
    /** Most recent YIN periodicity confidence in [0, 1]. */
    get confidence() {
      return this.detector.confidence;
    }
    /** Change the transpose target. The ratio slews over about 12 ms. */
    setSemitones(semitones) {
      if (!finiteInRange(semitones, -12, 12)) {
        throw new RangeError("LIVE_MONO semitones must be between -12 and +12");
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
    process(input, output, frameCount = input.length, inputOffset = 0, outputOffset = 0) {
      if (!Number.isInteger(frameCount) || frameCount < 0 || !Number.isInteger(inputOffset) || inputOffset < 0 || inputOffset + frameCount > input.length || !Number.isInteger(outputOffset) || outputOffset < 0 || outputOffset + frameCount > output.length) {
        throw new RangeError("LIVE_MONO block ranges must fit the supplied input and output buffers");
      }
      for (let frame = 0; frame < frameCount; frame += 1) {
        const absoluteSample = this.inputSampleCursor;
        const inputSample = Number.isFinite(input[inputOffset + frame]) ? input[inputOffset + frame] : 0;
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
        const delayedInput = delayedSample >= 0 ? this.inputRing[delayedSample % this.inputRing.length] : 0;
        let desiredMix = 0;
        if (this.targetSemitones !== 0 && this.lookupPitch(delayedSample) && this.lookupVoiced && this.lookupConfidence >= 0.55) desiredMix = 1;
        const delayedTransient = delayedSample >= 0 ? this.transientRing[delayedSample % this.transientRing.length] !== 0 : false;
        const outputIndex = absoluteSample % this.outputSumRing.length;
        const accumulatedWeight = this.outputWeightRing[outputIndex];
        const shiftedAvailable = accumulatedWeight > 1e-8;
        const shiftedSample = shiftedAvailable ? this.outputSumRing[outputIndex] / accumulatedWeight : delayedInput;
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
    storePitchEstimate(estimateTimeSamples) {
      const index = this.pitchHistoryWrite;
      this.pitchTimes[index] = estimateTimeSamples;
      this.pitchFrequencies[index] = this.detector.frequencyHz;
      this.pitchConfidences[index] = this.detector.confidence;
      this.pitchVoiced[index] = this.detector.voiced ? 1 : 0;
      this.latestPitchHistoryIndex = index;
      this.latestPitchTime = estimateTimeSamples;
      this.pitchHistoryWrite = index + 1 & this.pitchHistoryMask;
      if (this.pitchHistoryCount < this.pitchTimes.length) this.pitchHistoryCount += 1;
    }
    /** Writes the requested time's nearest pitch estimate into scalar scratch fields. */
    lookupPitch(timeSamples) {
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
      const index = this.latestPitchHistoryIndex - lag & this.pitchHistoryMask;
      this.lookupFrequency = this.pitchFrequencies[index];
      this.lookupConfidence = this.pitchConfidences[index];
      this.lookupVoiced = this.pitchVoiced[index] !== 0;
      return true;
    }
    synthesizePitchGrain(outputCenter) {
      const sourceTime = outputCenter - this.latencySamples;
      if (!this.lookupPitch(sourceTime) || !this.lookupVoiced || this.lookupConfidence < 0.55 || this.lookupFrequency <= 0) {
        this.nextSynthesisCenter += this.detectorHopRawSamples;
        return;
      }
      const period = Math.max(
        1,
        Math.min(this.maximumPeriodSamples, this.sampleRate / this.lookupFrequency)
      );
      const radius = Math.max(2, Math.min(this.maximumPeriodSamples, Math.round(period)));
      const searchRadius = Math.min(this.maximumSearchRadius, Math.max(1, Math.floor(period / 2)));
      const sourceCenter = Math.round(sourceTime);
      let peakCenter = sourceCenter;
      let peakValue = Number.NEGATIVE_INFINITY;
      for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
        const candidate = sourceCenter + offset;
        const value = this.readInput(candidate);
        if (value > peakValue) {
          peakValue = value;
          peakCenter = candidate;
        }
      }
      const outputCenterInteger = Math.ceil(outputCenter);
      const angle = Math.PI / (radius + 1);
      const cosineStep = Math.cos(angle);
      let cosineBeforePrevious = 1;
      let cosinePrevious = cosineStep;
      for (let offset = 0; offset <= radius; offset += 1) {
        let cosineValue;
        if (offset === 0) {
          cosineValue = 1;
        } else if (offset === 1) {
          cosineValue = cosinePrevious;
        } else {
          const nextCosine = 2 * cosineStep * cosinePrevious - cosineBeforePrevious;
          cosineBeforePrevious = cosinePrevious;
          cosinePrevious = nextCosine;
          cosineValue = nextCosine;
        }
        const weight = 0.5 + 0.5 * cosineValue;
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
    addGrainSample(absoluteOutputSample, sample, weight) {
      if (absoluteOutputSample < this.inputSampleCursor) return;
      const index = absoluteOutputSample % this.outputSumRing.length;
      this.outputSumRing[index] = this.outputSumRing[index] + sample * weight;
      this.outputWeightRing[index] = this.outputWeightRing[index] + weight;
    }
    readInput(absoluteSample) {
      if (absoluteSample < 0 || absoluteSample > this.inputSampleCursor) return 0;
      return this.inputRing[absoluteSample % this.inputRing.length];
    }
  };

  // src/audio/fx/dsp/BrowserRobotDsp.ts
  var DECIMATION_FACTOR3 = 4;
  var YIN_RING_LENGTH = 1024;
  var YIN_RING_MASK2 = YIN_RING_LENGTH - 1;
  var YIN_CMND_LENGTH = 256;
  var YIN_MIN_F0_HZ2 = 80;
  var YIN_MAX_F0_HZ2 = 1e3;
  var YIN_HOP_DECIMATED2 = 64;
  var YIN_RMS_FLOOR = 8e-4;
  var YIN_THRESHOLD = 0.16;
  var PITCH_CONFIDENCE_THRESHOLD2 = 0.62;
  var QUEUE_CAPACITY2 = 32;
  var QUEUE_MASK2 = QUEUE_CAPACITY2 - 1;
  var TARGET_CHANGE_DEADBAND = 0.035;
  var NOTE_CHANGE_HYSTERESIS = 0.05;
  var PSOLA_MIN_F0_HZ = 130;
  var PSOLA_MAX_F0_HZ = 1e3;
  var PSOLA_STABLE_CENTS = 65;
  var PSOLA_STABLE_ANALYSES = 3;
  var PSOLA_CONFIDENCE_THRESHOLD = 0.82;
  var BrowserRobotDsp = class {
    sampleRate;
    latencyFrames;
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
    processingMode = "signalsmith";
    modeReason = "unvoiced";
    modeFrame = 0;
    modeRevision = 0;
    decimatedRate;
    minLag;
    maxLag;
    yinWindow;
    yinRing = new Float32Array(YIN_RING_LENGTH);
    yinCmnd = new Float32Array(YIN_CMND_LENGTH);
    queueFrames = new Float64Array(QUEUE_CAPACITY2);
    queueSemitones = new Float32Array(QUEUE_CAPACITY2);
    queueSourceMidi = new Float32Array(QUEUE_CAPACITY2);
    queueTargetMidi = new Float32Array(QUEUE_CAPACITY2);
    queueHz = new Float32Array(QUEUE_CAPACITY2);
    queueConfidence = new Float32Array(QUEUE_CAPACITY2);
    queueVoiced = new Uint8Array(QUEUE_CAPACITY2);
    psolaProcessor;
    psolaInput = new Float32Array(1);
    psolaOutput = new Float32Array(1);
    queueHead = 0;
    queueTail = 0;
    queueCount = 0;
    decimationSum = 0;
    decimationCount = 0;
    decimatedSamples = 0;
    analysisCountdown = YIN_HOP_DECIMATED2;
    totalSinceReset = 0;
    invalidAnalyses = 0;
    targetOffsetSemitones;
    targetFormantSemitones = 0;
    targetMidiInitialized = false;
    lastFrame = 0;
    lastQueuedVoiced = false;
    lastQueuedSemitones = Number.NaN;
    previousStableFrequencyHz = 0;
    stableAnalysisCount = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.decimatedRate = this.sampleRate / DECIMATION_FACTOR3;
      this.maxLag = Math.max(2, Math.min(YIN_CMND_LENGTH - 2, Math.floor(this.decimatedRate / YIN_MIN_F0_HZ2)));
      this.minLag = Math.max(2, Math.floor(this.decimatedRate / YIN_MAX_F0_HZ2));
      this.yinWindow = Math.min(256, Math.max(64, this.maxLag * 2));
      this.latencyFrames = (this.yinWindow + this.maxLag + YIN_HOP_DECIMATED2) * DECIMATION_FACTOR3;
      this.targetOffsetSemitones = this.clampPitch(parameters.pitch ?? 0);
      this.psolaProcessor = this.createPsolaProcessor();
    }
    get queueDepth() {
      return this.queueCount;
    }
    get psolaLatencySamples() {
      return this.psolaProcessor.latencySamples;
    }
    get diagnostics() {
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
        framesProcessed: this.framesProcessed
      };
    }
    setParameters(parameters) {
      let changed = false;
      if (parameters.pitch !== void 0) {
        if (!Number.isFinite(parameters.pitch)) throw new RangeError("ROBOT pitch must be finite.");
        if (parameters.pitch < -24 || parameters.pitch > 24) throw new RangeError("ROBOT pitch must be between -24 and +24 semitones.");
        this.targetOffsetSemitones = parameters.pitch;
        changed = true;
      }
      if (parameters.formant !== void 0) {
        if (!Number.isFinite(parameters.formant) || parameters.formant < -12 || parameters.formant > 12) {
          throw new RangeError("ROBOT formant must be between -12 and +12 semitones.");
        }
        this.targetFormantSemitones = parameters.formant;
        changed = true;
      }
      if (changed && this.hasPitch) this.updateTarget(this.lastFrame + 1, true);
      else if (changed) this.updateProcessingMode(this.lastFrame + 1);
    }
    /** Process one mono frame using only construction-time storage. */
    processSample(input, frame) {
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
      if (this.decimationCount >= DECIMATION_FACTOR3) {
        this.pushDecimatedSample(this.decimationSum / DECIMATION_FACTOR3);
        this.decimationSum = 0;
        this.decimationCount = 0;
      }
    }
    processStereoSample(left, right, frame) {
      const l = Number.isFinite(left) ? left : 0;
      const r = Number.isFinite(right) ? right : 0;
      this.processSample((l + r) * 0.5, frame);
    }
    /** Pop one primitive event into mutable `lastTarget*` fields. */
    tryPopTargetChange() {
      if (this.queueCount <= 0) return false;
      this.lastTargetFrame = this.queueFrames[this.queueHead];
      this.lastTargetSemitones = this.queueSemitones[this.queueHead];
      this.lastTargetSourceMidi = this.queueSourceMidi[this.queueHead];
      this.lastTargetMidi = this.queueTargetMidi[this.queueHead];
      this.lastTargetHz = this.queueHz[this.queueHead];
      this.lastTargetConfidence = this.queueConfidence[this.queueHead];
      this.lastTargetVoiced = this.queueVoiced[this.queueHead] !== 0;
      this.queueHead = this.queueHead + 1 & QUEUE_MASK2;
      this.queueCount -= 1;
      return true;
    }
    reset() {
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
      this.analysisCountdown = YIN_HOP_DECIMATED2;
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
      this.setProcessingMode("signalsmith", "unvoiced", 0);
    }
    pushDecimatedSample(sample) {
      this.yinRing[this.decimatedSamples & YIN_RING_MASK2] = sample;
      this.decimatedSamples += 1;
      this.totalSinceReset += 1;
      this.analysisCountdown -= 1;
      if (this.analysisCountdown > 0) return;
      this.analysisCountdown = YIN_HOP_DECIMATED2;
      if (this.totalSinceReset >= this.yinWindow + this.maxLag) this.analyzePitch();
    }
    analyzePitch() {
      const newest = this.decimatedSamples - 1;
      let energy = 0;
      for (let i = 0; i < this.yinWindow; i += 1) {
        const sample = this.yinRing[newest - i & YIN_RING_MASK2];
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / this.yinWindow);
      if (!Number.isFinite(rms) || rms < YIN_RMS_FLOOR) {
        this.rejectPitch();
        return;
      }
      let cumulative = 0;
      let bestLag = -1;
      let bestCmnd = 1;
      let firstThresholdLag = -1;
      for (let lag = 1; lag <= this.maxLag; lag += 1) {
        let difference = 0;
        for (let i = 0; i < this.yinWindow; i += 1) {
          const a = this.yinRing[newest - i & YIN_RING_MASK2];
          const b = this.yinRing[newest - i - lag & YIN_RING_MASK2];
          const delta = a - b;
          difference += delta * delta;
        }
        cumulative += difference;
        const normalized = lag === 1 || cumulative <= 1e-20 ? 1 : difference * lag / cumulative;
        this.yinCmnd[lag] = normalized;
        if (lag >= this.minLag && normalized < bestCmnd) {
          bestCmnd = normalized;
          bestLag = lag;
        }
        if (lag >= this.minLag && firstThresholdLag < 0 && normalized < YIN_THRESHOLD) {
          firstThresholdLag = lag;
        }
      }
      if (firstThresholdLag >= 0) {
        let lag = firstThresholdLag;
        while (lag < this.maxLag && this.yinCmnd[lag + 1] < this.yinCmnd[lag]) lag += 1;
        bestLag = lag;
        bestCmnd = this.yinCmnd[lag];
      }
      if (bestLag < this.minLag || bestLag > this.maxLag || bestCmnd > 0.45) {
        this.rejectPitch();
        return;
      }
      const before = this.yinCmnd[bestLag - 1] ?? bestCmnd;
      const center = this.yinCmnd[bestLag] ?? bestCmnd;
      const after = this.yinCmnd[bestLag + 1] ?? center;
      const denominator = before - 2 * center + after;
      const correction = Math.abs(denominator) > 1e-8 ? Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator)) : 0;
      const frequency = this.decimatedRate / (bestLag + correction);
      if (!Number.isFinite(frequency) || frequency < YIN_MIN_F0_HZ2 || frequency > YIN_MAX_F0_HZ2) {
        this.rejectPitch();
        return;
      }
      const midi = 69 + 12 * Math.log2(frequency / 440);
      const confidence = Math.max(0, Math.min(1, 1 - bestCmnd));
      if (!Number.isFinite(midi) || confidence < PITCH_CONFIDENCE_THRESHOLD2) {
        this.rejectPitch();
        return;
      }
      this.invalidAnalyses = 0;
      this.pitchEstimateHz = frequency;
      this.pitchEstimateMidi = midi;
      this.pitchConfidence = confidence;
      this.hasPitch = true;
      const driftCents = this.previousStableFrequencyHz > 0 ? Math.abs(1200 * Math.log2(frequency / this.previousStableFrequencyHz)) : Number.POSITIVE_INFINITY;
      this.stableAnalysisCount = driftCents <= PSOLA_STABLE_CENTS ? this.stableAnalysisCount + 1 : 1;
      this.previousStableFrequencyHz = frequency;
      this.updateTarget(this.lastFrame, false);
    }
    rejectPitch() {
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
    updateTarget(frame, force) {
      if (!this.hasPitch) return;
      const shiftedMidi = this.pitchEstimateMidi + this.targetOffsetSemitones;
      let targetMidi = Math.round(shiftedMidi);
      if (this.targetMidiInitialized) {
        if (targetMidi > this.targetMidi && shiftedMidi < this.targetMidi + 0.5 + NOTE_CHANGE_HYSTERESIS) {
          targetMidi = this.targetMidi;
        } else if (targetMidi < this.targetMidi && shiftedMidi > this.targetMidi - 0.5 - NOTE_CHANGE_HYSTERESIS) {
          targetMidi = this.targetMidi;
        }
      }
      this.targetMidiInitialized = true;
      const semitones = Math.max(-24, Math.min(24, targetMidi - this.pitchEstimateMidi));
      this.targetMidi = targetMidi;
      this.targetSemitones = semitones;
      this.updateProcessingMode(frame);
      const changed = !this.lastQueuedVoiced || !Number.isFinite(this.lastQueuedSemitones) || Math.abs(semitones - this.lastQueuedSemitones) >= TARGET_CHANGE_DEADBAND;
      if (force || changed) {
        this.enqueueTarget(frame, semitones, this.pitchEstimateMidi, targetMidi, this.pitchEstimateHz, this.pitchConfidence, true);
      }
    }
    enqueueTarget(frame, semitones, sourceMidi, targetMidi, hz, confidence, voiced) {
      if (this.queueCount > 0) {
        const previousIndex = this.queueTail - 1 & QUEUE_MASK2;
        if (this.queueFrames[previousIndex] === frame) {
          this.writeTarget(previousIndex, semitones, sourceMidi, targetMidi, hz, confidence, voiced);
          this.lastQueuedVoiced = voiced;
          this.lastQueuedSemitones = voiced ? semitones : Number.NaN;
          return;
        }
      }
      if (this.queueCount >= QUEUE_CAPACITY2) {
        this.queueOverflowCount += 1;
        return;
      }
      const index = this.queueTail;
      this.queueFrames[index] = frame;
      this.writeTarget(index, semitones, sourceMidi, targetMidi, hz, confidence, voiced);
      this.queueTail = this.queueTail + 1 & QUEUE_MASK2;
      this.queueCount += 1;
      this.lastQueuedVoiced = voiced;
      this.lastQueuedSemitones = voiced ? semitones : Number.NaN;
    }
    writeTarget(index, semitones, sourceMidi, targetMidi, hz, confidence, voiced) {
      this.queueSemitones[index] = semitones;
      this.queueSourceMidi[index] = sourceMidi;
      this.queueTargetMidi[index] = targetMidi;
      this.queueHz[index] = hz;
      this.queueConfidence[index] = confidence;
      this.queueVoiced[index] = voiced ? 1 : 0;
    }
    clampPitch(value) {
      return Math.max(-24, Math.min(24, value));
    }
    createPsolaProcessor() {
      return new LiveMonoPitchProcessor({
        sampleRate: this.sampleRate,
        minimumFrequencyHz: PSOLA_MIN_F0_HZ,
        maximumFrequencyHz: PSOLA_MAX_F0_HZ
      });
    }
    updateProcessingMode(frame) {
      let mode = "signalsmith";
      let reason = "unvoiced";
      if (this.hasPitch) {
        if (this.pitchConfidence < PSOLA_CONFIDENCE_THRESHOLD) reason = "low-confidence";
        else if (this.pitchEstimateHz < PSOLA_MIN_F0_HZ || this.pitchEstimateHz > PSOLA_MAX_F0_HZ) {
          reason = "source-frequency-out-of-range";
        } else if (Math.abs(this.targetSemitones) > 12) reason = "target-shift-out-of-range";
        else if (Math.abs(this.targetFormantSemitones) > 1e-6) reason = "formant-control-active";
        else if (this.stableAnalysisCount < PSOLA_STABLE_ANALYSES) reason = "unstable-f0";
        else {
          mode = "psola";
          reason = "stable-voiced";
        }
      }
      this.psolaProcessor.setSemitones(mode === "psola" ? this.targetSemitones : 0);
      this.setProcessingMode(mode, reason, frame);
    }
    setProcessingMode(mode, reason, frame) {
      if (mode === this.processingMode && reason === this.modeReason) return;
      this.processingMode = mode;
      this.modeReason = reason;
      this.modeFrame = Number.isSafeInteger(frame) && frame >= 0 ? frame : 0;
      this.modeRevision += 1;
    }
  };

  // src/audio/fx/dsp/BrowserPatternSlicerDsp.ts
  var RATE_OPTIONS = [0.25, 0.5, 1, 2, 4];
  var PATTERNS = [
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0],
    [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1]
  ];
  var BrowserPatternSlicerDsp = class {
    sampleRate;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    boundaryCount = 0;
    lastBoundaryFrame = -1;
    currentBpm;
    currentPattern;
    currentRateBeats;
    currentDepthPercent;
    currentEdgeMs;
    pendingBpm;
    pendingPattern;
    pendingRateBeats;
    pendingDepthPercent;
    pendingEdgeMs;
    stepIndex = 0;
    stepFrames;
    stepElapsedFrames = 0;
    framesUntilStep;
    previousStepGain = 1;
    stepTargetGain = 1;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
      this.currentPattern = this.pendingPattern = this.clampPattern(parameters.pattern ?? 0);
      this.currentRateBeats = this.pendingRateBeats = this.quantizeRate(parameters.rateBeats ?? 0.25);
      this.currentDepthPercent = this.pendingDepthPercent = this.clampPercent(parameters.depthPercent ?? 100);
      this.currentEdgeMs = this.pendingEdgeMs = this.clampEdge(parameters.edgeMs ?? 2);
      this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
      this.framesUntilStep = this.stepFrames;
      this.stepTargetGain = this.gainAtStep(this.stepIndex, this.currentPattern, this.currentDepthPercent);
      this.previousStepGain = this.stepTargetGain;
    }
    get diagnostics() {
      return {
        framesProcessed: this.framesProcessed,
        boundaryCount: this.boundaryCount,
        lastBoundaryFrame: this.lastBoundaryFrame,
        activeBpm: this.currentBpm,
        activePattern: this.currentPattern,
        activeRateBeats: this.currentRateBeats,
        activeDepthPercent: this.currentDepthPercent,
        activeEdgeMs: this.currentEdgeMs,
        activeStepIndex: this.stepIndex,
        activeStepFrames: this.stepFrames,
        remainingFramesToBoundary: this.framesUntilStep
      };
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.pattern)) this.pendingPattern = this.clampPattern(parameters.pattern);
      if (Number.isFinite(parameters.rateBeats)) this.pendingRateBeats = this.quantizeRate(parameters.rateBeats);
      if (Number.isFinite(parameters.depthPercent)) this.pendingDepthPercent = this.clampPercent(parameters.depthPercent);
      if (Number.isFinite(parameters.edgeMs)) this.pendingEdgeMs = this.clampEdge(parameters.edgeMs);
    }
    /** Applies the raised-cosine gate directly to the stereo frame, with no allocations. */
    processSample(left, right) {
      let gain = this.stepTargetGain;
      const edgeFrames = Math.min(this.stepFrames, Math.max(1, Math.round(this.currentEdgeMs * this.sampleRate / 1e3)));
      if (edgeFrames > 1 && this.stepElapsedFrames < edgeFrames && this.previousStepGain !== this.stepTargetGain) {
        const position = this.stepElapsedFrames / (edgeFrames - 1);
        const fade = 0.5 - 0.5 * Math.cos(Math.PI * position);
        gain = this.previousStepGain + (this.stepTargetGain - this.previousStepGain) * fade;
      }
      this.wetLeft = left * gain;
      this.wetRight = right * gain;
      this.stepElapsedFrames += 1;
      this.framesUntilStep -= 1;
      this.framesProcessed += 1;
      if (this.framesUntilStep <= 0) this.onStepBoundary();
    }
    reset() {
      this.currentBpm = this.pendingBpm;
      this.currentPattern = this.pendingPattern;
      this.currentRateBeats = this.pendingRateBeats;
      this.currentDepthPercent = this.pendingDepthPercent;
      this.currentEdgeMs = this.pendingEdgeMs;
      this.stepIndex = 0;
      this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
      this.framesUntilStep = this.stepFrames;
      this.stepElapsedFrames = 0;
      this.stepTargetGain = this.gainAtStep(this.stepIndex, this.currentPattern, this.currentDepthPercent);
      this.previousStepGain = this.stepTargetGain;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.framesProcessed = 0;
      this.boundaryCount = 0;
      this.lastBoundaryFrame = -1;
    }
    onStepBoundary() {
      this.boundaryCount += 1;
      this.lastBoundaryFrame = this.framesProcessed - 1;
      this.previousStepGain = this.stepTargetGain;
      this.stepIndex = this.stepIndex + 1 & 15;
      this.currentBpm = this.pendingBpm;
      this.currentPattern = this.pendingPattern;
      this.currentRateBeats = this.pendingRateBeats;
      this.currentDepthPercent = this.pendingDepthPercent;
      this.currentEdgeMs = this.pendingEdgeMs;
      this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
      this.framesUntilStep = this.stepFrames;
      this.stepElapsedFrames = 0;
      this.stepTargetGain = this.gainAtStep(this.stepIndex, this.currentPattern, this.currentDepthPercent);
    }
    gainAtStep(step, pattern, depthPercent) {
      const gateOpen = PATTERNS[pattern]?.[step] ?? 1;
      return 1 - depthPercent / 100 * (1 - gateOpen);
    }
    intervalFrames(bpm, rateBeats) {
      return Math.max(1, Math.round(60 * this.sampleRate * rateBeats / bpm));
    }
    clampBpm(value) {
      return Math.max(40, Math.min(300, value));
    }
    clampPattern(value) {
      return Math.round(Math.max(0, Math.min(7, value)));
    }
    clampPercent(value) {
      return Math.max(0, Math.min(100, value));
    }
    clampEdge(value) {
      return Math.max(0.5, Math.min(20, value));
    }
    quantizeRate(value) {
      let nearest = RATE_OPTIONS[0];
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < RATE_OPTIONS.length; index += 1) {
        const option = RATE_OPTIONS[index];
        const nextDistance = Math.abs(value - option);
        if (nextDistance < distance) {
          nearest = option;
          distance = nextDistance;
        }
      }
      return nearest;
    }
  };

  // src/audio/fx/dsp/BrowserStepSlicerDsp.ts
  var RATE_OPTIONS2 = [0.25, 0.5, 1, 2, 4];
  var DEFAULT_LEVELS = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
  var STEP_EDGE_MS = 2;
  var BrowserStepSlicerDsp = class {
    sampleRate;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    boundaryCount = 0;
    lastBoundaryFrame = -1;
    currentBpm;
    currentStepCount;
    currentRateBeats;
    currentDepthPercent;
    currentPanDepthPercent;
    currentFilterHz;
    pendingBpm;
    pendingStepCount;
    pendingRateBeats;
    pendingDepthPercent;
    pendingPanDepthPercent;
    pendingFilterHz;
    stepLevels = new Float64Array(DEFAULT_LEVELS);
    pendingStepLevels = new Float64Array(DEFAULT_LEVELS);
    filterState = new Float64Array(2);
    stepIndex = 0;
    stepFrames;
    stepElapsedFrames = 0;
    framesUntilStep;
    filterAlpha;
    previousStepGain = 1;
    stepTargetGain = 1;
    previousStepPan = 0;
    stepTargetPan = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
      this.currentStepCount = this.pendingStepCount = this.clampStepCount(parameters.stepCount ?? 16);
      this.currentRateBeats = this.pendingRateBeats = this.quantizeRate(parameters.rateBeats ?? 0.25);
      this.currentDepthPercent = this.pendingDepthPercent = this.clampPercent(parameters.depthPercent ?? 100);
      this.currentPanDepthPercent = this.pendingPanDepthPercent = this.clampPercent(parameters.panDepthPercent ?? 0);
      this.currentFilterHz = this.pendingFilterHz = this.clampFilter(parameters.filterHz ?? 2e4);
      this.applyStepParameters(parameters, this.pendingStepLevels);
      this.stepLevels.set(this.pendingStepLevels);
      this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
      this.framesUntilStep = this.stepFrames;
      this.filterAlpha = this.calculateFilterAlpha(this.currentFilterHz);
      this.stepTargetGain = this.gainAtStep(0);
      this.previousStepGain = this.stepTargetGain;
      this.stepTargetPan = this.panAtStep(0);
      this.previousStepPan = this.stepTargetPan;
    }
    get diagnostics() {
      return {
        framesProcessed: this.framesProcessed,
        boundaryCount: this.boundaryCount,
        lastBoundaryFrame: this.lastBoundaryFrame,
        activeBpm: this.currentBpm,
        activeStepCount: this.currentStepCount,
        activeRateBeats: this.currentRateBeats,
        activeDepthPercent: this.currentDepthPercent,
        activePanDepthPercent: this.currentPanDepthPercent,
        activeFilterHz: this.currentFilterHz,
        activeStepIndex: this.stepIndex,
        activeStepLevelPercent: this.stepLevels[this.stepIndex] ?? 100,
        activeStepFrames: this.stepFrames,
        remainingFramesToBoundary: this.framesUntilStep
      };
    }
    /** Latch edits on the next step edge, keeping the stereo clock coherent. */
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.stepCount)) this.pendingStepCount = this.clampStepCount(parameters.stepCount);
      if (Number.isFinite(parameters.rateBeats)) this.pendingRateBeats = this.quantizeRate(parameters.rateBeats);
      if (Number.isFinite(parameters.depthPercent)) this.pendingDepthPercent = this.clampPercent(parameters.depthPercent);
      if (Number.isFinite(parameters.panDepthPercent)) this.pendingPanDepthPercent = this.clampPercent(parameters.panDepthPercent);
      if (Number.isFinite(parameters.filterHz)) this.pendingFilterHz = this.clampFilter(parameters.filterHz);
      this.applyStepParameters(parameters, this.pendingStepLevels);
    }
    processSample(left, right) {
      let fade = 1;
      const edgeFrames = Math.min(this.stepFrames, Math.max(1, Math.round(STEP_EDGE_MS * this.sampleRate / 1e3)));
      if (edgeFrames > 1 && this.stepElapsedFrames < edgeFrames) {
        const position = this.stepElapsedFrames / (edgeFrames - 1);
        fade = 0.5 - 0.5 * Math.cos(Math.PI * position);
      }
      const gain = this.previousStepGain + (this.stepTargetGain - this.previousStepGain) * fade;
      const pan = this.previousStepPan + (this.stepTargetPan - this.previousStepPan) * fade;
      const filteredLeft = this.filterState[0] += this.filterAlpha * (left - this.filterState[0]);
      const filteredRight = this.filterState[1] += this.filterAlpha * (right - this.filterState[1]);
      const panAmount = Math.abs(pan);
      this.wetLeft = filteredLeft * gain * (pan > 0 ? 1 - panAmount : 1);
      this.wetRight = filteredRight * gain * (pan < 0 ? 1 - panAmount : 1);
      this.stepElapsedFrames += 1;
      this.framesUntilStep -= 1;
      this.framesProcessed += 1;
      if (this.framesUntilStep <= 0) this.onStepBoundary();
    }
    reset() {
      this.currentBpm = this.pendingBpm;
      this.currentStepCount = this.pendingStepCount;
      this.currentRateBeats = this.pendingRateBeats;
      this.currentDepthPercent = this.pendingDepthPercent;
      this.currentPanDepthPercent = this.pendingPanDepthPercent;
      this.currentFilterHz = this.pendingFilterHz;
      this.stepLevels.set(this.pendingStepLevels);
      this.stepIndex = 0;
      this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
      this.framesUntilStep = this.stepFrames;
      this.stepElapsedFrames = 0;
      this.filterAlpha = this.calculateFilterAlpha(this.currentFilterHz);
      this.filterState.fill(0);
      this.stepTargetGain = this.gainAtStep(0);
      this.previousStepGain = this.stepTargetGain;
      this.stepTargetPan = this.panAtStep(0);
      this.previousStepPan = this.stepTargetPan;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.framesProcessed = 0;
      this.boundaryCount = 0;
      this.lastBoundaryFrame = -1;
    }
    onStepBoundary() {
      this.boundaryCount += 1;
      this.lastBoundaryFrame = this.framesProcessed - 1;
      this.previousStepGain = this.stepTargetGain;
      this.previousStepPan = this.stepTargetPan;
      this.stepLevels.set(this.pendingStepLevels);
      this.currentBpm = this.pendingBpm;
      this.currentStepCount = this.pendingStepCount;
      this.currentRateBeats = this.pendingRateBeats;
      this.currentDepthPercent = this.pendingDepthPercent;
      this.currentPanDepthPercent = this.pendingPanDepthPercent;
      this.currentFilterHz = this.pendingFilterHz;
      this.stepIndex = (this.stepIndex + 1) % this.currentStepCount;
      this.stepFrames = this.intervalFrames(this.currentBpm, this.currentRateBeats);
      this.framesUntilStep = this.stepFrames;
      this.stepElapsedFrames = 0;
      this.filterAlpha = this.calculateFilterAlpha(this.currentFilterHz);
      this.stepTargetGain = this.gainAtStep(this.stepIndex);
      this.stepTargetPan = this.panAtStep(this.stepIndex);
    }
    gainAtStep(step) {
      const level = (this.stepLevels[step] ?? 100) / 100;
      return 1 - this.currentDepthPercent / 100 * (1 - level);
    }
    panAtStep(step) {
      const direction = (step & 1) === 0 ? -1 : 1;
      return direction * (this.currentPanDepthPercent / 100);
    }
    applyStepParameters(parameters, target) {
      for (let index = 0; index < 16; index += 1) {
        const key = `step${String(index + 1).padStart(2, "0")}`;
        const value = parameters[key];
        if (Number.isFinite(value)) target[index] = this.clampPercent(value);
      }
    }
    intervalFrames(bpm, rateBeats) {
      return Math.max(1, Math.round(60 * this.sampleRate * rateBeats / bpm));
    }
    calculateFilterAlpha(filterHz) {
      return 1 - Math.exp(-2 * Math.PI * filterHz / this.sampleRate);
    }
    clampBpm(value) {
      return Math.max(30, Math.min(300, value));
    }
    clampPercent(value) {
      return Math.max(0, Math.min(100, value));
    }
    clampFilter(value) {
      return Math.max(20, Math.min(Math.min(2e4, this.sampleRate * 0.499), value));
    }
    clampStepCount(value) {
      const rounded = Math.round(value);
      if (rounded <= 0) return 4;
      if (rounded <= 2) return 4 << rounded;
      return rounded < 6 ? 4 : rounded < 12 ? 8 : 16;
    }
    quantizeRate(value) {
      let nearest = RATE_OPTIONS2[0];
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < RATE_OPTIONS2.length; index += 1) {
        const option = RATE_OPTIONS2[index];
        const nextDistance = Math.abs(value - option);
        if (nextDistance < distance) {
          nearest = option;
          distance = nextDistance;
        }
      }
      return nearest;
    }
  };

  // src/audio/fx/dsp/BrowserVinylFlickDsp.ts
  var MAX_HISTORY_SECONDS = 4;
  var LOOKAHEAD_SAMPLES = 2;
  var MIN_RETURN_SECONDS = 0.05;
  var MAX_RETURN_SECONDS = 10;
  var MAX_RATE = 2;
  var MAX_ABS_ACCELERATION = 2e3;
  var MIN_PHASE_SLIP_FRAMES = 32;
  var PHASE_SLIP_SECONDS = 0.01;
  var BrowserVinylFlickDsp = class {
    sampleRate;
    maxHistoryFrames;
    algorithmicLatencySamples = LOOKAHEAD_SAMPLES;
    phaseSlipFrames;
    wetLeft = 0;
    wetRight = 0;
    dryLeft = 0;
    dryRight = 0;
    framesProcessed = 0;
    historyEdgeHits = 0;
    phaseSlipCount = 0;
    historyLeft;
    historyRight;
    speedTarget = 0;
    returnTimeSeconds = 1.5;
    brakePercent = 35;
    motorRate = 1;
    motorVelocity = 0;
    writeFrame = 0;
    readPosition = -LOOKAHEAD_SAMPLES;
    phaseSlipRemaining = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.maxHistoryFrames = Math.max(16, Math.ceil(this.sampleRate * MAX_HISTORY_SECONDS));
      this.phaseSlipFrames = Math.max(MIN_PHASE_SLIP_FRAMES, Math.round(this.sampleRate * PHASE_SLIP_SECONDS));
      this.historyLeft = new Float32Array(this.maxHistoryFrames);
      this.historyRight = new Float32Array(this.maxHistoryFrames);
      this.setParameters(parameters);
    }
    get diagnostics() {
      return {
        framesProcessed: this.framesProcessed,
        readPosition: this.readPosition,
        motorRate: this.motorRate,
        motorVelocity: this.motorVelocity,
        speedTargetRate: this.speedForControl(this.speedTarget),
        returnTimeSeconds: this.returnTimeSeconds,
        brakePercent: this.brakePercent,
        maxHistoryFrames: this.maxHistoryFrames,
        historyEdgeHits: this.historyEdgeHits,
        phaseSlipCount: this.phaseSlipCount
      };
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.speed)) {
        this.speedTarget = Math.max(-100, Math.min(100, parameters.speed));
      }
      if (Number.isFinite(parameters.returnTimeSeconds)) {
        this.returnTimeSeconds = Math.max(MIN_RETURN_SECONDS, Math.min(MAX_RETURN_SECONDS, parameters.returnTimeSeconds));
      }
      if (Number.isFinite(parameters.brakePercent)) {
        this.brakePercent = Math.max(0, Math.min(100, parameters.brakePercent));
      }
    }
    /** Mutates output fields and retains bounded stereo input history. */
    processSample(left, right) {
      const frame = this.writeFrame;
      const writeIndex = frame % this.maxHistoryFrames;
      this.historyLeft[writeIndex] = Number.isFinite(left) ? left : 0;
      this.historyRight[writeIndex] = Number.isFinite(right) ? right : 0;
      const dryFrame = frame - LOOKAHEAD_SAMPLES;
      if (dryFrame >= 0) {
        const dryIndex = dryFrame % this.maxHistoryFrames;
        this.dryLeft = this.historyLeft[dryIndex] ?? 0;
        this.dryRight = this.historyRight[dryIndex] ?? 0;
      } else {
        this.dryLeft = 0;
        this.dryRight = 0;
      }
      this.advanceMotor();
      let oldestFrame = frame - this.maxHistoryFrames + 1;
      if (oldestFrame < 0) oldestFrame = 0;
      const latestReadPosition = frame - LOOKAHEAD_SAMPLES;
      if (frame >= LOOKAHEAD_SAMPLES) {
        if (this.readPosition > latestReadPosition) this.readPosition = latestReadPosition;
        const distanceToOldest = this.readPosition - oldestFrame;
        const slipGuard = Math.ceil(Math.max(0, 1 - this.motorRate) * this.phaseSlipFrames) + 2;
        if (oldestFrame > 0 && this.phaseSlipRemaining === 0 && distanceToOldest <= slipGuard) {
          this.phaseSlipRemaining = this.phaseSlipFrames;
          this.historyEdgeHits += 1;
          this.phaseSlipCount += 1;
        }
        let readPosition = this.readPosition;
        if (readPosition < oldestFrame) readPosition = oldestFrame;
        if (readPosition > latestReadPosition) readPosition = latestReadPosition;
        const oldLeft = this.readHistory(this.historyLeft, readPosition, oldestFrame, frame);
        const oldRight = this.readHistory(this.historyRight, readPosition, oldestFrame, frame);
        if (this.phaseSlipRemaining > 0) {
          const progress = (this.phaseSlipFrames - this.phaseSlipRemaining + 1) / this.phaseSlipFrames;
          const oldGain = 1 - progress;
          const liveGain = progress;
          const liveLeft = this.readHistory(this.historyLeft, latestReadPosition, oldestFrame, frame);
          const liveRight = this.readHistory(this.historyRight, latestReadPosition, oldestFrame, frame);
          this.wetLeft = oldLeft * oldGain + liveLeft * liveGain;
          this.wetRight = oldRight * oldGain + liveRight * liveGain;
          this.phaseSlipRemaining -= 1;
          if (this.phaseSlipRemaining === 0) {
            this.readPosition = latestReadPosition + this.motorRate;
            this.clampNextReadPosition(frame);
          } else {
            this.readPosition += this.motorRate;
          }
        } else {
          this.wetLeft = oldLeft;
          this.wetRight = oldRight;
          this.readPosition += this.motorRate;
        }
      } else {
        this.wetLeft = 0;
        this.wetRight = 0;
        this.readPosition += this.motorRate;
      }
      if (!Number.isFinite(this.wetLeft)) this.wetLeft = 0;
      if (!Number.isFinite(this.wetRight)) this.wetRight = 0;
      this.clampNextReadPosition(frame);
      this.writeFrame += 1;
      this.framesProcessed += 1;
    }
    reset() {
      this.historyLeft.fill(0);
      this.historyRight.fill(0);
      this.motorRate = 1;
      this.motorVelocity = 0;
      this.writeFrame = 0;
      this.readPosition = -LOOKAHEAD_SAMPLES;
      this.phaseSlipRemaining = 0;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.dryLeft = 0;
      this.dryRight = 0;
      this.framesProcessed = 0;
      this.historyEdgeHits = 0;
      this.phaseSlipCount = 0;
    }
    advanceMotor() {
      const targetRate = this.speedForControl(this.speedTarget);
      const naturalFrequency = Math.min(80, 4 / this.returnTimeSeconds);
      const dampingRatio = 0.55 + 1.65 * (this.brakePercent / 100);
      const acceleration = naturalFrequency * naturalFrequency * (targetRate - this.motorRate) - 2 * dampingRatio * naturalFrequency * this.motorVelocity;
      const boundedAcceleration = Math.max(-MAX_ABS_ACCELERATION, Math.min(MAX_ABS_ACCELERATION, acceleration));
      this.motorVelocity += boundedAcceleration / this.sampleRate;
      this.motorVelocity = Math.max(-200, Math.min(200, this.motorVelocity));
      this.motorRate += this.motorVelocity / this.sampleRate;
      this.motorRate = Math.max(0, Math.min(MAX_RATE, this.motorRate));
      if (!Number.isFinite(this.motorRate) || !Number.isFinite(this.motorVelocity)) {
        this.motorRate = 1;
        this.motorVelocity = 0;
      }
    }
    speedForControl(speed) {
      return 1 + speed / 100;
    }
    clampNextReadPosition(frame) {
      const maximumRead = frame + 1 - LOOKAHEAD_SAMPLES;
      if (this.readPosition > maximumRead) this.readPosition = maximumRead;
    }
    readHistory(buffer, position, oldestFrame, latestFrame) {
      const baseFrame = Math.floor(position);
      const fraction = position - baseFrame;
      const sampleMinusOne = this.readFrame(buffer, baseFrame - 1, oldestFrame, latestFrame);
      const sampleZero = this.readFrame(buffer, baseFrame, oldestFrame, latestFrame);
      const samplePlusOne = this.readFrame(buffer, baseFrame + 1, oldestFrame, latestFrame);
      const samplePlusTwo = this.readFrame(buffer, baseFrame + 2, oldestFrame, latestFrame);
      const cMinusOne = -(fraction * (fraction - 1) * (fraction - 2)) / 6;
      const cZero = (fraction + 1) * (fraction - 1) * (fraction - 2) / 2;
      const cPlusOne = -((fraction + 1) * fraction * (fraction - 2)) / 2;
      const cPlusTwo = (fraction + 1) * fraction * (fraction - 1) / 6;
      return cMinusOne * sampleMinusOne + cZero * sampleZero + cPlusOne * samplePlusOne + cPlusTwo * samplePlusTwo;
    }
    readFrame(buffer, frame, oldestFrame, latestFrame) {
      if (frame < oldestFrame || frame > latestFrame) return 0;
      return buffer[frame % this.maxHistoryFrames] ?? 0;
    }
  };

  // src/audio/fx/dsp/BrowserPreampDsp.ts
  var FIR_TAPS = 33;
  var FIR_CENTER = (FIR_TAPS - 1) / 2;
  var FIR_CUTOFF = 0.235;
  var CABINET_TAPS = 129;
  var TWO_PI8 = Math.PI * 2;
  var MAX_OUTPUT = 4;
  var MODEL_RAMP_FRAMES_SECONDS = 0.025;
  var MODEL_DRIVE = new Float64Array([0.78, 1, 1.16, 1.08, 0.88]);
  var MODEL_SHAPE = new Float64Array([1.2, 1.65, 2.2, 2.7, 1.55]);
  var MODEL_BIAS = new Float64Array([0, 0.085, 0.02, -0.045, 0.055]);
  var MODEL_WET = new Float64Array([0.68, 0.82, 0.92, 1, 0.76]);
  function clamp14(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }
  function sinc(value) {
    if (Math.abs(value) < 1e-12) return 1;
    const angle = Math.PI * value;
    return Math.sin(angle) / angle;
  }
  function createOversamplingFilters() {
    const interpolation = new Float64Array(FIR_TAPS);
    let sum = 0;
    for (let tap = 0; tap < FIR_TAPS; tap += 1) {
      const centered = tap - FIR_CENTER;
      const position = tap / (FIR_TAPS - 1);
      const window = 0.42 - 0.5 * Math.cos(TWO_PI8 * position) + 0.08 * Math.cos(2 * TWO_PI8 * position);
      const coefficient = 2 * FIR_CUTOFF * sinc(2 * FIR_CUTOFF * centered) * window;
      interpolation[tap] = coefficient;
      sum += coefficient;
    }
    const decimation = new Float64Array(FIR_TAPS);
    for (let tap = 0; tap < FIR_TAPS; tap += 1) {
      interpolation[tap] = (interpolation[tap] ?? 0) * (2 / sum);
      decimation[tap] = (interpolation[tap] ?? 0) * 0.5;
    }
    return { interpolation, decimation };
  }
  var OVERSAMPLING_FILTERS = createOversamplingFilters();
  function logCosh2(value) {
    const absolute = Math.abs(value);
    return absolute + Math.log1p(Math.exp(-2 * absolute)) - Math.LN2;
  }
  function antiderivative(shape, bias, value, biasValue) {
    return logCosh2(shape * (value + bias)) / shape - value * biasValue;
  }
  function directFormBiquad(input, coefficients, state, offset) {
    const output = coefficients.b0 * input + (state[offset] ?? 0);
    state[offset] = coefficients.b1 * input - coefficients.a1 * output + (state[offset + 1] ?? 0);
    state[offset + 1] = coefficients.b2 * input - coefficients.a2 * output;
    return output;
  }
  function createCabinetResponse(sampleRate) {
    const highPass = designRbjBiquad("highpass", sampleRate, Math.min(105, sampleRate * 0.08), Math.SQRT1_2);
    const lowPass = designRbjBiquad("lowpass", sampleRate, Math.min(5600, sampleRate * 0.42), 0.72);
    const presence = designRbjBiquad("peaking", sampleRate, Math.min(1750, sampleRate * 0.32), 0.9, 2.2);
    const coneBreakup = designRbjBiquad("peaking", sampleRate, Math.min(3950, sampleRate * 0.42), 1.8, -4.5);
    const state = new Float64Array(8);
    const response = new Float64Array(CABINET_TAPS);
    for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
      let value = tap === 0 ? 1 : 0;
      value = directFormBiquad(value, highPass, state, 0);
      value = directFormBiquad(value, lowPass, state, 2);
      value = directFormBiquad(value, presence, state, 4);
      value = directFormBiquad(value, coneBreakup, state, 6);
      response[tap] = value;
    }
    let real = 0;
    let imaginary = 0;
    for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
      const angle = TWO_PI8 * 500 * tap / sampleRate;
      const coefficient = response[tap] ?? 0;
      real += coefficient * Math.cos(angle);
      imaginary -= coefficient * Math.sin(angle);
    }
    const magnitude = Math.max(1e-6, Math.hypot(real, imaginary));
    const normalization = 1 / magnitude;
    for (let tap = 0; tap < CABINET_TAPS; tap += 1) response[tap] = (response[tap] ?? 0) * normalization;
    return response;
  }
  var OnePoleSmoother = class {
    current;
    target;
    oneMinusAlpha;
    constructor(sampleRate, initial, seconds = 0.015) {
      this.current = initial;
      this.target = initial;
      this.oneMinusAlpha = 1 - Math.exp(-1 / (sampleRate * seconds));
    }
    setTarget(value) {
      this.target = value;
    }
    next() {
      this.current += (this.target - this.current) * this.oneMinusAlpha;
      return this.current;
    }
  };
  var BrowserPreampDsp = class {
    sampleRate;
    outputLeft = 0;
    outputRight = 0;
    model;
    gain;
    level;
    equalizer;
    cabinet;
    upsampleHistory = [new Float64Array(FIR_TAPS), new Float64Array(FIR_TAPS)];
    waveshapedHistory = [new Float64Array(FIR_TAPS), new Float64Array(FIR_TAPS)];
    upsampleWriteIndex = new Int32Array(2);
    waveshapedWriteIndex = new Int32Array(2);
    previousDriven = new Float64Array(2);
    previousAntiderivative = new Float64Array(2);
    antiderivativeValid = new Uint8Array(2);
    antiderivativeShape = Number.NaN;
    antiderivativeBias = Number.NaN;
    biasValue = 0;
    slopeAtZero = 1;
    cachedModelPosition = Number.NaN;
    cachedModelDrive = 1;
    cachedShape = 1;
    cachedBias = 0;
    cachedNonlinearBlend = 1;
    cachedGainPercent = Number.NaN;
    cachedDriveModel = Number.NaN;
    cachedStageDrive = 1;
    cachedLevelDb = Number.NaN;
    cachedLevelLinear = 1;
    cabinetHistory = [new Float64Array(CABINET_TAPS), new Float64Array(CABINET_TAPS)];
    cabinetWriteIndex = new Int32Array(2);
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      const initialModel = Number.isFinite(parameters.model) ? parameters.model : 0;
      const initialGain = Number.isFinite(parameters.gainPercent) ? parameters.gainPercent : 35;
      const initialBass = Number.isFinite(parameters.bassDb) ? parameters.bassDb : 0;
      const initialMiddle = Number.isFinite(parameters.middleDb) ? parameters.middleDb : 0;
      const initialTreble = Number.isFinite(parameters.trebleDb) ? parameters.trebleDb : 0;
      const initialLevel = Number.isFinite(parameters.levelDb) ? parameters.levelDb : 0;
      this.model = new LinearParameterSmoother(clamp14(Math.round(initialModel), 0, 4));
      this.gain = new OnePoleSmoother(this.sampleRate, clamp14(initialGain, 0, 100));
      this.level = new OnePoleSmoother(this.sampleRate, clamp14(initialLevel, -24, 12));
      this.equalizer = new EqualizerDsp(this.sampleRate, {
        lowFrequencyHz: Math.min(170, this.sampleRate * 0.2),
        lowGainDb: initialBass,
        mid1FrequencyHz: Math.min(820, this.sampleRate * 0.32),
        mid1Q: 0.8,
        mid1GainDb: initialMiddle,
        highFrequencyHz: Math.min(3600, this.sampleRate * 0.42),
        highGainDb: initialTreble
      });
      this.cabinet = createCabinetResponse(this.sampleRate);
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.model)) {
        this.model.setTarget(clamp14(Math.round(parameters.model), 0, 4), Math.round(this.sampleRate * MODEL_RAMP_FRAMES_SECONDS));
      }
      if (Number.isFinite(parameters.gainPercent)) this.gain.setTarget(clamp14(parameters.gainPercent, 0, 100));
      if (Number.isFinite(parameters.levelDb)) this.level.setTarget(clamp14(parameters.levelDb, -24, 12));
      this.equalizer.setParameters({
        lowGainDb: Number.isFinite(parameters.bassDb) ? parameters.bassDb : void 0,
        mid1GainDb: Number.isFinite(parameters.middleDb) ? parameters.middleDb : void 0,
        highGainDb: Number.isFinite(parameters.trebleDb) ? parameters.trebleDb : void 0
      });
    }
    processSample(inputLeft, inputRight) {
      const modelPosition = this.model.next();
      if (modelPosition !== this.cachedModelPosition) {
        const lowerModel = Math.floor(modelPosition);
        const upperModel = Math.min(4, lowerModel + 1);
        const modelBlend = modelPosition - lowerModel;
        this.cachedModelDrive = lerpTable(MODEL_DRIVE, lowerModel, upperModel, modelBlend);
        this.cachedShape = lerpTable(MODEL_SHAPE, lowerModel, upperModel, modelBlend);
        this.cachedBias = lerpTable(MODEL_BIAS, lowerModel, upperModel, modelBlend);
        this.cachedNonlinearBlend = lerpTable(MODEL_WET, lowerModel, upperModel, modelBlend);
        this.cachedModelPosition = modelPosition;
      }
      const modelDrive = this.cachedModelDrive;
      const shape = this.cachedShape;
      const bias = this.cachedBias;
      const nonlinearBlend = this.cachedNonlinearBlend;
      if (shape !== this.antiderivativeShape || bias !== this.antiderivativeBias) {
        this.antiderivativeValid.fill(0);
        this.antiderivativeShape = shape;
        this.antiderivativeBias = bias;
        this.biasValue = Math.tanh(shape * bias);
        this.slopeAtZero = Math.max(0.2, shape * (1 - this.biasValue * this.biasValue));
      }
      const gainPercent = this.gain.next() / 100;
      if (modelDrive !== this.cachedDriveModel || gainPercent !== this.cachedGainPercent) {
        this.cachedStageDrive = modelDrive * (1 + gainPercent * gainPercent * 28);
        this.cachedDriveModel = modelDrive;
        this.cachedGainPercent = gainPercent;
      }
      const stageDrive = this.cachedStageDrive;
      const levelDb = this.level.next();
      if (levelDb !== this.cachedLevelDb) {
        this.cachedLevelLinear = 10 ** (levelDb / 20);
        this.cachedLevelDb = levelDb;
      }
      const levelLinear = this.cachedLevelLinear;
      const preEqLeft = this.processOversampledChannel(Number.isFinite(inputLeft) ? inputLeft : 0, 0, stageDrive, shape, bias, nonlinearBlend);
      const preEqRight = this.processOversampledChannel(Number.isFinite(inputRight) ? inputRight : 0, 1, stageDrive, shape, bias, nonlinearBlend);
      this.equalizer.process(preEqLeft, preEqRight);
      this.outputLeft = this.processCabinet(this.equalizer.outputLeft, 0) * levelLinear;
      this.outputRight = this.processCabinet(this.equalizer.outputRight, 1) * levelLinear;
      this.outputLeft = clamp14(Number.isFinite(this.outputLeft) ? this.outputLeft : 0, -MAX_OUTPUT, MAX_OUTPUT);
      this.outputRight = clamp14(Number.isFinite(this.outputRight) ? this.outputRight : 0, -MAX_OUTPUT, MAX_OUTPUT);
    }
    reset() {
      for (let channel = 0; channel < 2; channel += 1) {
        this.upsampleHistory[channel].fill(0);
        this.waveshapedHistory[channel].fill(0);
        this.cabinetHistory[channel].fill(0);
      }
      this.upsampleWriteIndex.fill(0);
      this.waveshapedWriteIndex.fill(0);
      this.previousDriven.fill(0);
      this.previousAntiderivative.fill(0);
      this.antiderivativeValid.fill(0);
      this.cabinetWriteIndex.fill(0);
      this.equalizer.reset();
      this.outputLeft = 0;
      this.outputRight = 0;
    }
    processOversampledChannel(input, channel, drive, shape, bias, blend) {
      const inputHistory = this.upsampleHistory[channel];
      const shapedHistory = this.waveshapedHistory[channel];
      let upIndex = this.upsampleWriteIndex[channel] ?? 0;
      let downIndex = this.waveshapedWriteIndex[channel] ?? 0;
      let output = 0;
      const biasValue = this.biasValue;
      const slopeAtZero = this.slopeAtZero;
      for (let phase = 0; phase < 2; phase += 1) {
        inputHistory[upIndex] = phase === 0 ? input : 0;
        let reconstructed = 0;
        for (let tap = 0; tap < FIR_TAPS; tap += 1) {
          const historyIndex = upIndex >= tap ? upIndex - tap : upIndex + FIR_TAPS - tap;
          reconstructed += (inputHistory[historyIndex] ?? 0) * (OVERSAMPLING_FILTERS.interpolation[tap] ?? 0);
        }
        const driven = reconstructed * drive;
        const previous = this.previousDriven[channel] ?? 0;
        const difference = driven - previous;
        let shaped;
        if (Math.abs(difference) < 1e-8) {
          shaped = (Math.tanh(shape * (0.5 * (driven + previous) + bias)) - biasValue) / slopeAtZero;
          this.antiderivativeValid[channel] = 0;
        } else {
          const currentPrimitive = antiderivative(shape, bias, driven, biasValue);
          const previousPrimitive = this.antiderivativeValid[channel] ? this.previousAntiderivative[channel] : antiderivative(shape, bias, previous, biasValue);
          shaped = (currentPrimitive - previousPrimitive) / (difference * slopeAtZero);
          this.previousAntiderivative[channel] = currentPrimitive;
          this.antiderivativeValid[channel] = 1;
        }
        this.previousDriven[channel] = driven;
        const normalized = reconstructed * (1 - blend) + shaped * blend;
        shapedHistory[downIndex] = normalized;
        if (phase === 0) {
          let decimated = 0;
          for (let tap = 0; tap < FIR_TAPS; tap += 1) {
            const historyIndex = downIndex >= tap ? downIndex - tap : downIndex + FIR_TAPS - tap;
            decimated += (shapedHistory[historyIndex] ?? 0) * (OVERSAMPLING_FILTERS.decimation[tap] ?? 0);
          }
          output = decimated;
        }
        downIndex += 1;
        if (downIndex >= FIR_TAPS) downIndex = 0;
        upIndex += 1;
        if (upIndex >= FIR_TAPS) upIndex = 0;
      }
      this.upsampleWriteIndex[channel] = upIndex;
      this.waveshapedWriteIndex[channel] = downIndex;
      return output;
    }
    processCabinet(input, channel) {
      const history = this.cabinetHistory[channel];
      let index = this.cabinetWriteIndex[channel] ?? 0;
      history[index] = input;
      let output = 0;
      for (let tap = 0; tap < CABINET_TAPS; tap += 1) {
        const historyIndex = index >= tap ? index - tap : index + CABINET_TAPS - tap;
        output += (history[historyIndex] ?? 0) * (this.cabinet[tap] ?? 0);
      }
      index += 1;
      if (index >= CABINET_TAPS) index = 0;
      this.cabinetWriteIndex[channel] = index;
      return output;
    }
  };
  function lerpTable(table, low, high, blend) {
    const first = table[low] ?? table[0] ?? 0;
    const second = table[high] ?? first;
    return first + (second - first) * blend;
  }

  // src/audio/fx/dsp/BrowserSynthDsp.ts
  var DEFAULT_SENSITIVITY = 60;
  var DEFAULT_WAVEFORM = 0;
  var DEFAULT_OCTAVE = 0;
  var DEFAULT_TONE_HZ = 4e3;
  var DEFAULT_MIX_PERCENT = 50;
  var DEFAULT_SUB_MIX_PERCENT = 14;
  var MINIMUM_F0_HZ = 55;
  var MAXIMUM_F0_HZ = 1e3;
  var ANALYSIS_HOP_SECONDS = 5e-3;
  var PARAMETER_RAMP_SECONDS = 0.02;
  var FILTER_CONTROL_INTERVAL = 16;
  var FILTER_RESONANCE_Q = 1.25;
  var MAX_INPUT_MAGNITUDE4 = 4;
  var MAX_OUTPUT_MAGNITUDE = 4;
  function clamp15(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function cleanNumber(value, fallback, minimum, maximum) {
    return typeof value === "number" && Number.isFinite(value) ? clamp15(value, minimum, maximum) : fallback;
  }
  function nextPowerOfTwo2(value) {
    let result = 1;
    while (result < value) result *= 2;
    return result;
  }
  function onePoleAlpha3(seconds, sampleRate) {
    return Math.exp(-1 / (Math.max(1e-3, seconds) * sampleRate));
  }
  var SynthYinTracker = class {
    sampleRate;
    minimumFrequencyHz;
    maximumFrequencyHz;
    frameSamples;
    hopSamples;
    ring;
    differences;
    normalizedDifferences;
    ringMask;
    minimumLag;
    maximumLag;
    analysisWindowSamples;
    writeIndex = 0;
    sampleCount = 0;
    nextAnalysisSample;
    sensitivity = DEFAULT_SENSITIVITY;
    confidenceValue = 0;
    frequencyValue = 0;
    voicedValue = false;
    goodFrames = 0;
    badFrames = 0;
    logFrequency = 0;
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.minimumFrequencyHz = Math.min(MINIMUM_F0_HZ, sampleRate * 0.08);
      this.maximumFrequencyHz = Math.min(MAXIMUM_F0_HZ, sampleRate * 0.4);
      this.minimumLag = Math.max(2, Math.floor(sampleRate / this.maximumFrequencyHz));
      this.maximumLag = Math.ceil(sampleRate / this.minimumFrequencyHz);
      this.frameSamples = Math.max(64, this.maximumLag * 3);
      this.hopSamples = Math.max(1, Math.round(sampleRate * ANALYSIS_HOP_SECONDS));
      this.analysisWindowSamples = this.frameSamples - this.maximumLag;
      const ringLength = nextPowerOfTwo2(this.frameSamples * 2);
      this.ring = new Float32Array(ringLength);
      this.differences = new Float64Array(this.maximumLag + 1);
      this.normalizedDifferences = new Float64Array(this.maximumLag + 1);
      this.ringMask = ringLength - 1;
      this.nextAnalysisSample = this.frameSamples;
    }
    get frequencyHz() {
      return this.voicedValue ? this.frequencyValue : 0;
    }
    get confidence() {
      return this.confidenceValue;
    }
    get voiced() {
      return this.voicedValue;
    }
    setSensitivity(value) {
      if (Number.isFinite(value)) this.sensitivity = clamp15(value, 0, 100);
    }
    pushSample(sample, sensitivity = this.sensitivity) {
      this.setSensitivity(sensitivity);
      this.ring[this.writeIndex] = Number.isFinite(sample) ? sample : 0;
      this.writeIndex = this.writeIndex + 1 & this.ringMask;
      this.sampleCount += 1;
      if (this.sampleCount < this.nextAnalysisSample) return;
      this.analyzeFrame();
      this.nextAnalysisSample += this.hopSamples;
    }
    reset() {
      this.ring.fill(0);
      this.differences.fill(0);
      this.normalizedDifferences.fill(0);
      this.writeIndex = 0;
      this.sampleCount = 0;
      this.nextAnalysisSample = this.frameSamples;
      this.confidenceValue = 0;
      this.frequencyValue = 0;
      this.voicedValue = false;
      this.goodFrames = 0;
      this.badFrames = 0;
      this.logFrequency = 0;
    }
    analyzeFrame() {
      let frameStart = this.writeIndex - this.frameSamples;
      if (frameStart < 0) frameStart += this.ring.length;
      let energy = 0;
      for (let index = 0; index < this.frameSamples; index += 1) {
        let ringIndex = frameStart + index;
        if (ringIndex >= this.ring.length) ringIndex -= this.ring.length;
        const sample = this.ring[ringIndex];
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / this.frameSamples);
      this.differences[0] = 0;
      for (let lag = 1; lag <= this.maximumLag; lag += 1) {
        let difference = 0;
        for (let index = 0; index < this.analysisWindowSamples; index += 1) {
          let first = frameStart + index;
          if (first >= this.ring.length) first -= this.ring.length;
          let second = first + lag;
          if (second >= this.ring.length) second -= this.ring.length;
          const delta = this.ring[first] - this.ring[second];
          difference += delta * delta;
        }
        this.differences[lag] = difference;
      }
      let cumulativeDifference = 0;
      for (let lag = 1; lag <= this.maximumLag; lag += 1) {
        cumulativeDifference += this.differences[lag];
        this.normalizedDifferences[lag] = cumulativeDifference > 1e-15 ? this.differences[lag] * lag / cumulativeDifference : 1;
      }
      const sensitivity = this.sensitivity / 100;
      const threshold = 0.23 - 0.09 * sensitivity;
      const activeThreshold = this.voicedValue ? Math.min(0.32, threshold + 0.055) : threshold;
      let bestLag = 0;
      let bestValue = Number.POSITIVE_INFINITY;
      for (let lag = this.minimumLag; lag <= this.maximumLag; lag += 1) {
        const value = this.normalizedDifferences[lag];
        if (value < bestValue) {
          bestValue = value;
          bestLag = lag;
        }
        if (value < activeThreshold && (lag === this.maximumLag || value <= this.normalizedDifferences[lag + 1])) {
          bestLag = lag;
          while (bestLag < this.maximumLag && this.normalizedDifferences[bestLag + 1] < this.normalizedDifferences[bestLag]) {
            bestLag += 1;
          }
          bestValue = this.normalizedDifferences[bestLag];
          break;
        }
      }
      this.confidenceValue = Number.isFinite(bestValue) ? clamp15(1 - bestValue, 0, 1) : 0;
      const amplitudeThreshold = 3e-3 + (1 - sensitivity) * 0.035;
      const candidate = rms >= amplitudeThreshold && bestLag > 0 && bestValue < activeThreshold;
      if (candidate) {
        this.goodFrames += 1;
        this.badFrames = 0;
        let refinedLag = bestLag;
        if (bestLag > this.minimumLag && bestLag < this.maximumLag) {
          const left = this.normalizedDifferences[bestLag - 1];
          const center = this.normalizedDifferences[bestLag];
          const right = this.normalizedDifferences[bestLag + 1];
          const denominator = left - 2 * center + right;
          if (Math.abs(denominator) > 1e-12) {
            refinedLag += clamp15(0.5 * (left - right) / denominator, -0.5, 0.5);
          }
        }
        const measuredLogFrequency = Math.log(this.sampleRate / refinedLag);
        if (this.goodFrames === 1 || this.frequencyValue <= 0) {
          this.logFrequency = measuredLogFrequency;
        } else {
          this.logFrequency += (measuredLogFrequency - this.logFrequency) * 0.35;
        }
        this.frequencyValue = Math.exp(this.logFrequency);
        if (this.goodFrames >= 2) this.voicedValue = true;
      } else {
        this.goodFrames = 0;
        this.badFrames += 1;
        if (this.badFrames >= 2) this.voicedValue = false;
      }
    }
  };
  var BrowserSynthDsp = class {
    sampleRate;
    outputLeft = 0;
    outputRight = 0;
    detector;
    decimation;
    decimatorAlpha;
    sensitivity;
    waveform;
    octave;
    toneHz;
    mixPercent;
    pitchSnapPercent;
    subMixPercent;
    filter;
    envelopeAttackAlpha;
    envelopeReleaseAlpha;
    trackingAttackAlpha;
    trackingReleaseAlpha;
    pitchSmoothingAlpha;
    decimatorCount = 0;
    decimatorFiltered = 0;
    inputEnvelopeValue = 0;
    trackingBlend = 0;
    targetFrequencyHz = 0;
    oscillatorFrequencyHz = 0;
    oscillatorPhase = 0;
    subOscillatorPhase = 0;
    triangleState = 0;
    controlsCountdown = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.decimation = Math.max(1, Math.ceil(this.sampleRate / 12e3));
      const detectorRate = this.sampleRate / this.decimation;
      this.detector = new SynthYinTracker(detectorRate);
      this.decimatorAlpha = this.decimation > 1 ? 1 - Math.exp(-2 * Math.PI * (detectorRate * 0.42) / this.sampleRate) : 1;
      const sensitivity = cleanNumber(parameters.sensitivity, DEFAULT_SENSITIVITY, 0, 100);
      const waveform = Math.round(cleanNumber(parameters.waveform, DEFAULT_WAVEFORM, 0, 2));
      const octave = cleanNumber(parameters.octave, DEFAULT_OCTAVE, -24, 24);
      const tone = cleanNumber(parameters.tone, DEFAULT_TONE_HZ, 100, 16e3);
      const mix = cleanNumber(parameters.mix, DEFAULT_MIX_PERCENT, 0, 100);
      const pitchSnapPercent = cleanNumber(parameters.pitchSnapPercent, 0, 0, 100);
      const subMix = cleanNumber(parameters.subMixPercent, DEFAULT_SUB_MIX_PERCENT, 0, 100);
      this.sensitivity = new LinearParameterSmoother(sensitivity);
      this.waveform = new LinearParameterSmoother(waveform);
      this.octave = new LinearParameterSmoother(octave);
      this.toneHz = new LinearParameterSmoother(tone);
      this.mixPercent = new LinearParameterSmoother(mix);
      this.pitchSnapPercent = new LinearParameterSmoother(pitchSnapPercent);
      this.subMixPercent = new LinearParameterSmoother(subMix);
      this.filter = new TptStateVariableFilter(this.sampleRate, tone, FILTER_RESONANCE_Q);
      this.envelopeAttackAlpha = onePoleAlpha3(4e-3, this.sampleRate);
      this.envelopeReleaseAlpha = onePoleAlpha3(0.075, this.sampleRate);
      this.trackingAttackAlpha = onePoleAlpha3(8e-3, this.sampleRate);
      this.trackingReleaseAlpha = onePoleAlpha3(0.022, this.sampleRate);
      this.pitchSmoothingAlpha = 1 - onePoleAlpha3(0.018, this.sampleRate);
    }
    /** Most recent YIN periodicity confidence, from 0 (weak) to 1 (strong). */
    get detectorConfidence() {
      return this.detector.confidence;
    }
    /** Latest accepted monophonic F0, or zero while the detector is unvoiced. */
    get detectedFrequencyHz() {
      return this.detector.frequencyHz;
    }
    get isVoiced() {
      return this.detector.voiced;
    }
    /** When unvoiced, the effect's wet branch follows the input as a safe fallback. */
    get fallbackActive() {
      return !this.detector.voiced;
    }
    get inputEnvelope() {
      return this.inputEnvelopeValue;
    }
    /** Current clamped targets are exposed for diagnostics and deterministic tests. */
    get targetSensitivityPercent() {
      return this.sensitivity.targetValue;
    }
    get targetWaveform() {
      return this.waveform.targetValue;
    }
    get targetOctaveSemitones() {
      return this.octave.targetValue;
    }
    get targetToneHz() {
      return this.toneHz.targetValue;
    }
    get targetMixPercent() {
      return this.mixPercent.targetValue;
    }
    /** Latest pitch target driving the oscillator, after the snap blend. */
    get targetPitchHz() {
      return this.targetFrequencyHz;
    }
    get targetPitchSnapPercent() {
      return this.pitchSnapPercent.targetValue;
    }
    get targetSubMixPercent() {
      return this.subMixPercent.targetValue;
    }
    setParameters(parameters) {
      const rampFrames = Math.max(1, Math.round(this.sampleRate * PARAMETER_RAMP_SECONDS));
      if (Number.isFinite(parameters.sensitivity)) {
        this.sensitivity.setTarget(clamp15(parameters.sensitivity, 0, 100), rampFrames);
      }
      if (Number.isFinite(parameters.waveform)) {
        this.waveform.setTarget(Math.round(clamp15(parameters.waveform, 0, 2)), rampFrames);
      }
      if (Number.isFinite(parameters.octave)) {
        this.octave.setTarget(clamp15(parameters.octave, -24, 24), rampFrames);
      }
      if (Number.isFinite(parameters.tone)) {
        this.toneHz.setTarget(clamp15(parameters.tone, 100, 16e3), rampFrames);
      }
      if (Number.isFinite(parameters.mix)) {
        this.mixPercent.setTarget(clamp15(parameters.mix, 0, 100), rampFrames);
      }
      if (Number.isFinite(parameters.pitchSnapPercent)) {
        this.pitchSnapPercent.setTarget(clamp15(parameters.pitchSnapPercent, 0, 100), rampFrames);
      }
      if (Number.isFinite(parameters.subMixPercent)) {
        this.subMixPercent.setTarget(clamp15(parameters.subMixPercent, 0, 100), rampFrames);
      }
    }
    /** Advances one stereo frame; the processor has no block-size-dependent state. */
    processSample(inputLeft, inputRight) {
      const left = Number.isFinite(inputLeft) ? clamp15(inputLeft, -MAX_INPUT_MAGNITUDE4, MAX_INPUT_MAGNITUDE4) : 0;
      const right = Number.isFinite(inputRight) ? clamp15(inputRight, -MAX_INPUT_MAGNITUDE4, MAX_INPUT_MAGNITUDE4) : 0;
      const peak = Math.max(Math.abs(left), Math.abs(right));
      const envelopeAlpha = peak > this.inputEnvelopeValue ? this.envelopeAttackAlpha : this.envelopeReleaseAlpha;
      this.inputEnvelopeValue = peak + envelopeAlpha * (this.inputEnvelopeValue - peak);
      const sensitivity = this.sensitivity.next();
      const waveform = this.waveform.next();
      const octave = this.octave.next();
      const tone = this.toneHz.next();
      const mix = this.mixPercent.next() / 100;
      const pitchSnap = this.pitchSnapPercent.next() / 100;
      const subMix = this.subMixPercent.next() / 100;
      if (this.decimation > 1) {
        const mono = (left + right) * 0.5;
        this.decimatorFiltered += (mono - this.decimatorFiltered) * this.decimatorAlpha;
        this.decimatorCount += 1;
        if (this.decimatorCount >= this.decimation) {
          this.detector.pushSample(this.decimatorFiltered, sensitivity);
          this.decimatorCount = 0;
        }
      } else {
        this.detector.pushSample((left + right) * 0.5, sensitivity);
      }
      const voiced = this.detector.voiced;
      const confidence = this.detector.confidence;
      const trackingTarget = voiced ? clamp15((confidence - 0.2) / 0.8, 0, 1) : 0;
      const trackingAlpha = trackingTarget > this.trackingBlend ? this.trackingAttackAlpha : this.trackingReleaseAlpha;
      this.trackingBlend = trackingTarget + trackingAlpha * (this.trackingBlend - trackingTarget);
      if (this.controlsCountdown <= 0) {
        if (voiced && this.detector.frequencyHz > 0) {
          const octaveRatio = Math.pow(2, octave / 12);
          const measuredFrequency = this.detector.frequencyHz;
          const midiNote = 69 + 12 * Math.log2(measuredFrequency / 440);
          const quantizedFrequency = 440 * Math.pow(2, (Math.round(midiNote) - 69) / 12);
          const snappedFrequency = Math.exp(
            Math.log(measuredFrequency) + (Math.log(quantizedFrequency) - Math.log(measuredFrequency)) * pitchSnap
          );
          this.targetFrequencyHz = clamp15(
            snappedFrequency * octaveRatio,
            10,
            this.sampleRate * 0.45
          );
        }
        this.filter.setParameters(Math.min(tone, this.sampleRate * 0.45), FILTER_RESONANCE_Q);
        this.controlsCountdown = FILTER_CONTROL_INTERVAL - 1;
      } else {
        this.controlsCountdown -= 1;
      }
      if (this.targetFrequencyHz > 0) {
        this.oscillatorFrequencyHz += (this.targetFrequencyHz - this.oscillatorFrequencyHz) * this.pitchSmoothingAlpha;
      }
      let oscillator = 0;
      if (this.oscillatorFrequencyHz > 0) {
        const dt = clamp15(this.oscillatorFrequencyHz / this.sampleRate, 1e-5, 0.45);
        const subDt = dt * 0.5;
        const saw = 2 * this.oscillatorPhase - 1 - this.polyBlep(this.oscillatorPhase, dt);
        let square = this.oscillatorPhase < 0.5 ? 1 : -1;
        square += this.polyBlep(this.oscillatorPhase, dt);
        let secondEdge = this.oscillatorPhase + 0.5;
        if (secondEdge >= 1) secondEdge -= 1;
        square -= this.polyBlep(secondEdge, dt);
        this.triangleState = clamp15(this.triangleState + square * (4 * dt), -1, 1);
        const subSquareRaw = this.subOscillatorPhase < 0.5 ? 1 : -1;
        let subSquare = subSquareRaw + this.polyBlep(this.subOscillatorPhase, subDt);
        let subSecondEdge = this.subOscillatorPhase + 0.5;
        if (subSecondEdge >= 1) subSecondEdge -= 1;
        subSquare -= this.polyBlep(subSecondEdge, subDt);
        let selectedWave;
        if (waveform <= 1) {
          selectedWave = saw + (square - saw) * waveform;
        } else {
          selectedWave = square + (this.triangleState - square) * (waveform - 1);
        }
        oscillator = selectedWave * (1 - subMix) + subSquare * subMix;
        this.oscillatorPhase += dt;
        if (this.oscillatorPhase >= 1) this.oscillatorPhase -= 1;
        this.subOscillatorPhase += subDt;
        if (this.subOscillatorPhase >= 1) this.subOscillatorPhase -= 1;
      }
      const filteredOscillator = this.filter.processSample(oscillator);
      const velocity = clamp15(this.inputEnvelopeValue * 2.5, 0, 0.9);
      const synthesized = filteredOscillator * velocity * this.trackingBlend;
      const wetLeft = left * (1 - this.trackingBlend) + synthesized;
      const wetRight = right * (1 - this.trackingBlend) + synthesized;
      this.outputLeft = clamp15(left * (1 - mix) + wetLeft * mix, -MAX_OUTPUT_MAGNITUDE, MAX_OUTPUT_MAGNITUDE);
      this.outputRight = clamp15(right * (1 - mix) + wetRight * mix, -MAX_OUTPUT_MAGNITUDE, MAX_OUTPUT_MAGNITUDE);
    }
    reset() {
      this.detector.reset();
      this.decimatorCount = 0;
      this.decimatorFiltered = 0;
      this.inputEnvelopeValue = 0;
      this.trackingBlend = 0;
      this.targetFrequencyHz = 0;
      this.oscillatorFrequencyHz = 0;
      this.oscillatorPhase = 0;
      this.subOscillatorPhase = 0;
      this.triangleState = 0;
      this.controlsCountdown = 0;
      this.filter.reset();
      this.outputLeft = 0;
      this.outputRight = 0;
      this.sensitivity.reset();
      this.waveform.reset();
      this.octave.reset();
      this.toneHz.reset();
      this.mixPercent.reset();
      this.pitchSnapPercent.reset();
      this.subMixPercent.reset();
    }
    polyBlep(phase, dt) {
      if (phase < dt) {
        const normalized = phase / dt;
        return normalized + normalized - normalized * normalized - 1;
      }
      if (phase > 1 - dt) {
        const normalized = (phase - 1) / dt;
        return normalized * normalized + (normalized + normalized) + 1;
      }
      return 0;
    }
  };

  // src/audio/fx/dsp/BrowserG2bDsp.ts
  var BrowserG2bDsp = class {
    sampleRate;
    voice;
    tracking;
    blend;
    body;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.tracking = this.bound(parameters.tracking, 65, 0, 100);
      this.blend = this.bound(parameters.blend, 65, 0, 100);
      this.body = this.bound(parameters.body, 180, 60, 1200);
      this.voice = new BrowserSynthDsp(this.sampleRate, {
        sensitivity: this.tracking,
        waveform: 1,
        octave: -12,
        tone: this.body,
        mix: this.blend,
        subMixPercent: 0
      });
    }
    get outputLeft() {
      return this.voice.outputLeft;
    }
    get outputRight() {
      return this.voice.outputRight;
    }
    get detectedFrequencyHz() {
      return this.voice.detectedFrequencyHz;
    }
    get detectorConfidence() {
      return this.voice.detectorConfidence;
    }
    get isVoiced() {
      return this.voice.isVoiced;
    }
    get targetTrackingPercent() {
      return this.tracking;
    }
    get targetBlendPercent() {
      return this.blend;
    }
    get targetBodyHz() {
      return this.body;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.tracking)) this.tracking = this.bound(parameters.tracking, this.tracking, 0, 100);
      if (Number.isFinite(parameters.blend)) this.blend = this.bound(parameters.blend, this.blend, 0, 100);
      if (Number.isFinite(parameters.body)) this.body = this.bound(parameters.body, this.body, 60, 1200);
      this.voice.setParameters({ sensitivity: this.tracking, waveform: 1, octave: -12, tone: this.body, mix: this.blend });
    }
    processSample(left, right) {
      this.voice.processSample(left, right);
    }
    reset() {
      this.voice.reset();
    }
    bound(value, fallback, minimum, maximum) {
      return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
    }
  };

  // src/audio/fx/vocoder/BrowserVocoderCore.ts
  var MIN_SAMPLE_RATE6 = 8e3;
  var MAX_SAMPLE_RATE7 = 192e3;
  var MIN_BANDS = 8;
  var MAX_BANDS = 24;
  var LOWEST_CENTER_HZ = 80;
  var HIGHEST_CENTER_HZ = 10500;
  var FILTER_Q = 1.15;
  var ATTACK_SECONDS = 4e-3;
  var RELEASE_SECONDS = 0.06;
  var INTERNAL_CARRIER_HZ = 110;
  var MAX_INPUT_MAGNITUDE5 = 8;
  var MAX_ENVELOPE = 8;
  var MAX_OUTPUT_MAGNITUDE2 = 4;
  var ERB_SCALE = 21.4;
  var ERB_FACTOR = 437e-5;
  function clamp16(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function boundedSample(value) {
    return Number.isFinite(value) ? clamp16(value, -MAX_INPUT_MAGNITUDE5, MAX_INPUT_MAGNITUDE5) : 0;
  }
  function erb(number) {
    return ERB_SCALE * Math.log10(1 + ERB_FACTOR * number);
  }
  function inverseErb(value) {
    return (10 ** (value / ERB_SCALE) - 1) / ERB_FACTOR;
  }
  function polyBlep(phase, step) {
    if (phase < step) {
      const t = phase / step;
      return 2 * t - t * t - 1;
    }
    if (phase > 1 - step) {
      const t = (phase - 1) / step;
      return t * t + 2 * t + 1;
    }
    return 0;
  }
  var BrowserVocoderCore = class _BrowserVocoderCore {
    sampleRate;
    algorithmicLatencySamples = 0;
    analysisFilters;
    carrierFilters;
    envelopes;
    centerFrequenciesHz;
    attackCoefficient;
    releaseCoefficient;
    oscillatorStep;
    activeBands;
    carrierMode;
    phase = 0;
    currentOutput = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp16(sampleRate, MIN_SAMPLE_RATE6, MAX_SAMPLE_RATE7) : 48e3;
      this.activeBands = _BrowserVocoderCore.validateBands(parameters.bands ?? 16);
      this.carrierMode = _BrowserVocoderCore.validateCarrier(parameters.carrier ?? 1);
      this.attackCoefficient = Math.exp(-1 / (ATTACK_SECONDS * this.sampleRate));
      this.releaseCoefficient = Math.exp(-1 / (RELEASE_SECONDS * this.sampleRate));
      this.oscillatorStep = INTERNAL_CARRIER_HZ / this.sampleRate;
      this.envelopes = new Float64Array(MAX_BANDS);
      this.centerFrequenciesHz = new Float64Array(MAX_BANDS);
      this.analysisFilters = new Array(MAX_BANDS);
      this.carrierFilters = new Array(MAX_BANDS);
      const low = Math.min(LOWEST_CENTER_HZ, this.sampleRate * 0.01);
      for (let band = 0; band < MAX_BANDS; band += 1) {
        this.analysisFilters[band] = new TptStateVariableFilter(this.sampleRate, low, FILTER_Q);
        this.carrierFilters[band] = new TptStateVariableFilter(this.sampleRate, low, FILTER_Q);
      }
      this.configureFilterbank(this.activeBands);
    }
    get outputLeft() {
      return this.currentOutput;
    }
    get outputRight() {
      return this.currentOutput;
    }
    get bands() {
      return this.activeBands;
    }
    get carrier() {
      return this.carrierMode;
    }
    /** Center frequency of an active ERB analysis/resynthesis band. */
    getBandCenterFrequencyHz(band) {
      if (!Number.isInteger(band) || band < 0 || band >= this.activeBands) return 0;
      return this.centerFrequenciesHz[band] ?? 0;
    }
    /** Current bounded envelope for diagnostics/tests and future MIDI routing. */
    getEnvelopeLevel(band) {
      if (!Number.isInteger(band) || band < 0 || band >= this.activeBands) return 0;
      return this.envelopes[band] ?? 0;
    }
    setParameters(parameters) {
      const keys = Object.keys(parameters);
      for (const key of keys) {
        if (key !== "bands" && key !== "carrier") {
          throw new RangeError(`Browser VOCODER does not support the ${key} parameter.`);
        }
      }
      const nextBands = parameters.bands === void 0 ? this.activeBands : _BrowserVocoderCore.validateBands(parameters.bands);
      const nextCarrier = parameters.carrier === void 0 ? this.carrierMode : _BrowserVocoderCore.validateCarrier(parameters.carrier);
      if (nextBands !== this.activeBands) {
        this.activeBands = nextBands;
        this.envelopes.fill(0);
        for (let band = 0; band < MAX_BANDS; band += 1) {
          this.analysisFilters[band]?.reset();
          this.carrierFilters[band]?.reset();
        }
        this.configureFilterbank(nextBands);
      }
      this.carrierMode = nextCarrier;
    }
    /** Voice-input carrier or internal anti-aliased saw/square carrier mode. */
    processSample(modulatorLeft, modulatorRight) {
      const modulator = boundedSample((boundedSample(modulatorLeft) + boundedSample(modulatorRight)) * 0.5);
      let carrier = modulator;
      if (this.carrierMode !== 0) {
        carrier = this.carrierMode === 1 ? this.nextSaw() : this.nextSquare();
      }
      this.currentOutput = this.processWithCarrier(modulator, carrier);
    }
    /**
     * Advance the persistent analysis/envelope bank with a modulator sample and
     * resynthesize it using an externally supplied, sample-aligned carrier.
     */
    processWithCarrier(modulatorSample, carrierSample) {
      const modulator = boundedSample(modulatorSample);
      const carrier = boundedSample(carrierSample);
      return this.processWithCarrierInputs(modulator, carrier, null);
    }
    /**
     * Advance the same analysis/envelope filterbank using a distinct carrier
     * sample for each band. This is the shared carrier-bank path used by OSC BOT
     * and other oscillator-bank reconstructions; callers provide a preallocated
     * array and no storage is created on the render path.
     */
    processWithCarrierBank(modulatorSample, bandCarriers) {
      if (bandCarriers === null || bandCarriers === void 0 || bandCarriers.length < this.activeBands) {
        throw new RangeError(`Browser VOCODER carrier bank must contain at least ${this.activeBands} samples.`);
      }
      return this.processWithCarrierInputs(boundedSample(modulatorSample), 0, bandCarriers);
    }
    processWithCarrierInputs(modulator, scalarCarrier, bandCarriers) {
      let sum = 0;
      for (let band = 0; band < this.activeBands; band += 1) {
        const analysis = this.analysisFilters[band];
        const carrierFilter = this.carrierFilters[band];
        if (!analysis || !carrierFilter) continue;
        analysis.processSample(modulator);
        const carrier = bandCarriers === null ? scalarCarrier : boundedSample(bandCarriers[band] ?? 0);
        carrierFilter.processSample(carrier);
        const target = clamp16(Math.abs(analysis.bandpass), 0, MAX_ENVELOPE);
        const previous = this.envelopes[band] ?? 0;
        const coefficient = target > previous ? this.attackCoefficient : this.releaseCoefficient;
        const envelope = clamp16(coefficient * previous + (1 - coefficient) * target, 0, MAX_ENVELOPE);
        this.envelopes[band] = envelope;
        sum += envelope * carrierFilter.bandpass;
      }
      const normalized = sum * 4 / Math.sqrt(this.activeBands);
      this.currentOutput = Number.isFinite(normalized) ? clamp16(normalized, -MAX_OUTPUT_MAGNITUDE2, MAX_OUTPUT_MAGNITUDE2) : 0;
      return this.currentOutput;
    }
    reset() {
      this.envelopes.fill(0);
      for (let band = 0; band < MAX_BANDS; band += 1) {
        this.analysisFilters[band]?.reset();
        this.carrierFilters[band]?.reset();
      }
      this.phase = 0;
      this.currentOutput = 0;
    }
    nextSaw() {
      const sample = 2 * this.phase - 1 - polyBlep(this.phase, this.oscillatorStep);
      this.advanceOscillator();
      return sample;
    }
    nextSquare() {
      const halfCyclePhase = this.phase < 0.5 ? this.phase + 0.5 : this.phase - 0.5;
      const sample = (this.phase < 0.5 ? 1 : -1) + polyBlep(this.phase, this.oscillatorStep) - polyBlep(halfCyclePhase, this.oscillatorStep);
      this.advanceOscillator();
      return sample;
    }
    advanceOscillator() {
      this.phase += this.oscillatorStep;
      if (this.phase >= 1) this.phase -= 1;
    }
    configureFilterbank(bands) {
      const low = Math.min(LOWEST_CENTER_HZ, this.sampleRate * 0.01);
      const high = Math.max(low * 1.5, Math.min(HIGHEST_CENTER_HZ, this.sampleRate * 0.44));
      const lowErb = erb(low);
      const highErb = erb(high);
      for (let band = 0; band < bands; band += 1) {
        const position = band / (bands - 1);
        const centerHz = inverseErb(lowErb + (highErb - lowErb) * position);
        this.centerFrequenciesHz[band] = centerHz;
        this.analysisFilters[band]?.setParameters(centerHz, FILTER_Q);
        this.carrierFilters[band]?.setParameters(centerHz, FILTER_Q);
      }
    }
    static validateBands(value) {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_BANDS || value > MAX_BANDS) {
        throw new RangeError(`Browser VOCODER bands must be an integer from ${MIN_BANDS} to ${MAX_BANDS}.`);
      }
      return value;
    }
    static validateCarrier(value) {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 2) {
        throw new RangeError("Browser VOCODER carrier must be 0 (voice input), 1 (saw), or 2 (square).");
      }
      return value;
    }
  };

  // src/audio/fx/BrowserOscBotCore.ts
  var MIN_SAMPLE_RATE7 = 8e3;
  var MAX_SAMPLE_RATE8 = 192e3;
  var MIN_BANDS2 = 8;
  var MAX_BANDS2 = 24;
  var DEFAULT_BANDS = 16;
  var MIN_TEMPO_BPM = 30;
  var MAX_TEMPO_BPM = 300;
  var MAX_OUTPUT_MAGNITUDE3 = 4;
  var MAX_INPUT_MAGNITUDE6 = 8;
  var DEFAULT_TONE_HZ2 = 3e3;
  var FILTER_Q2 = 2.2;
  var MAX_OSC_FREQUENCY_RATIO = 0.45;
  var STEP_PATTERNS = [
    [0, 0, 7, 0, 12, 0, 7, 0],
    [0, 3, 7, 10, 12, 10, 7, 3],
    [0, 0, 0, 7, 0, 0, 12, 7],
    [0, 5, 7, 12, 7, 5, 3, 0],
    [0, 12, 7, 5, 0, 12, 10, 7],
    [0, 0, 5, 7, 10, 7, 5, 3],
    [0, 4, 7, 11, 12, 11, 7, 4],
    [0, -5, 0, 7, 0, -5, 12, 7]
  ];
  function clamp17(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function bounded(value, magnitude) {
    return Number.isFinite(value) ? clamp17(value, -magnitude, magnitude) : 0;
  }
  function polyBlep2(phase, increment) {
    if (increment <= 0 || increment >= 0.5) return 0;
    if (phase < increment) {
      const t = phase / increment;
      return 2 * t - t * t - 1;
    }
    if (phase > 1 - increment) {
      const t = (phase - 1) / increment;
      return t * t + 2 * t + 1;
    }
    return 0;
  }
  var Oscillator = class {
    sampleRate;
    frequencyHz = 110;
    phase = 0;
    triangle = 0;
    waveform = 1;
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
    }
    set(frequencyHz, waveform) {
      this.frequencyHz = clamp17(frequencyHz, 1, this.sampleRate * MAX_OSC_FREQUENCY_RATIO);
      this.waveform = waveform;
    }
    reset() {
      this.phase = 0;
      this.triangle = 0;
    }
    processSample() {
      const increment = this.frequencyHz / this.sampleRate;
      let square = this.phase < 0.5 ? 1 : -1;
      square += polyBlep2(this.phase, increment);
      const shiftedPhase = this.phase < 0.5 ? this.phase + 0.5 : this.phase - 0.5;
      square -= polyBlep2(shiftedPhase, increment);
      let output = square;
      if (this.waveform === 0) {
        output = 2 * this.phase - 1 - polyBlep2(this.phase, increment);
      } else if (this.waveform === 2) {
        this.triangle = clamp17(this.triangle * 0.99999 + 4 * increment * square, -1, 1);
        output = this.triangle;
      }
      this.phase += increment;
      if (this.phase >= 1) this.phase -= 1;
      return output;
    }
  };
  var BrowserOscBotCore = class _BrowserOscBotCore {
    sampleRate;
    algorithmicLatencySamples = 0;
    vocoder;
    oscillators;
    bandCarriers;
    toneFilter;
    activeBands;
    waveform;
    patternIndex;
    toneCutoffHz;
    mix;
    tempoValue;
    currentStepFrames;
    framesUntilStep;
    activeStep = 0;
    frame = 0;
    currentOutput = 0;
    constructor(sampleRate = 48e3, parameters = {}, initialFrame = 0) {
      if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE7 || sampleRate > MAX_SAMPLE_RATE8) {
        throw new RangeError(`Browser OSC BOT sample rate must be from ${MIN_SAMPLE_RATE7} to ${MAX_SAMPLE_RATE8} Hz.`);
      }
      _BrowserOscBotCore.validateFrame(initialFrame);
      this.sampleRate = sampleRate;
      this.activeBands = _BrowserOscBotCore.validateBands(parameters.bands ?? DEFAULT_BANDS);
      this.waveform = _BrowserOscBotCore.validateWaveform(parameters.waveform ?? 1);
      this.patternIndex = _BrowserOscBotCore.validatePattern(parameters.pattern ?? 0);
      this.toneCutoffHz = _BrowserOscBotCore.validateTone(parameters.toneCutoffHz ?? DEFAULT_TONE_HZ2, sampleRate);
      this.mix = _BrowserOscBotCore.validateMix(parameters.mix ?? 1);
      this.tempoValue = _BrowserOscBotCore.validateTempo(parameters.tempoBpm ?? 120);
      this.currentStepFrames = _BrowserOscBotCore.computeStepFrames(sampleRate, this.tempoValue);
      this.framesUntilStep = this.currentStepFrames;
      this.frame = initialFrame;
      this.vocoder = new BrowserVocoderCore(sampleRate, { bands: this.activeBands, carrier: 0 });
      this.bandCarriers = new Float32Array(MAX_BANDS2);
      this.oscillators = Array.from({ length: MAX_BANDS2 }, () => new Oscillator(sampleRate));
      this.toneFilter = new TptStateVariableFilter(sampleRate, this.toneCutoffHz, FILTER_Q2);
      this.updateCarrierBank();
    }
    get outputLeft() {
      return this.currentOutput;
    }
    get outputRight() {
      return this.currentOutput;
    }
    get bands() {
      return this.activeBands;
    }
    get pattern() {
      return this.patternIndex;
    }
    get tempoBpm() {
      return this.tempoValue;
    }
    get stepIndex() {
      return this.activeStep;
    }
    get stepFrames() {
      return this.currentStepFrames;
    }
    get currentFrame() {
      return this.frame;
    }
    getEnvelopeLevel(band) {
      return this.vocoder.getEnvelopeLevel(band);
    }
    getBandCenterFrequencyHz(band) {
      return this.vocoder.getBandCenterFrequencyHz(band);
    }
    setParameters(parameters) {
      for (const key of Object.keys(parameters)) {
        if (key !== "bands" && key !== "waveform" && key !== "pattern" && key !== "toneCutoffHz" && key !== "mix" && key !== "tempoBpm") {
          throw new RangeError(`Browser OSC BOT does not support the ${key} parameter.`);
        }
      }
      const nextBands = parameters.bands === void 0 ? this.activeBands : _BrowserOscBotCore.validateBands(parameters.bands);
      const nextWaveform = parameters.waveform === void 0 ? this.waveform : _BrowserOscBotCore.validateWaveform(parameters.waveform);
      const nextPattern = parameters.pattern === void 0 ? this.patternIndex : _BrowserOscBotCore.validatePattern(parameters.pattern);
      const nextTone = parameters.toneCutoffHz === void 0 ? this.toneCutoffHz : _BrowserOscBotCore.validateTone(parameters.toneCutoffHz, this.sampleRate);
      const nextMix = parameters.mix === void 0 ? this.mix : _BrowserOscBotCore.validateMix(parameters.mix);
      const nextTempo = parameters.tempoBpm === void 0 ? this.tempoValue : _BrowserOscBotCore.validateTempo(parameters.tempoBpm);
      const bandsChanged = nextBands !== this.activeBands;
      const tempoChanged = nextTempo !== this.tempoValue;
      this.activeBands = nextBands;
      this.waveform = nextWaveform;
      this.patternIndex = nextPattern;
      this.toneCutoffHz = nextTone;
      this.mix = nextMix;
      this.tempoValue = nextTempo;
      if (bandsChanged) this.vocoder.setParameters({ bands: nextBands });
      if (tempoChanged) {
        const oldStepFrames = this.currentStepFrames;
        this.currentStepFrames = _BrowserOscBotCore.computeStepFrames(this.sampleRate, this.tempoValue);
        const elapsed = oldStepFrames - this.framesUntilStep;
        const phase = oldStepFrames > 0 ? clamp17(elapsed / oldStepFrames, 0, 1) : 0;
        this.framesUntilStep = Math.max(1, Math.round(this.currentStepFrames * (1 - phase)));
      }
      this.toneFilter.setParameters(this.toneCutoffHz, FILTER_Q2);
      this.updateCarrierBank();
    }
    setTempoBpm(tempoBpm) {
      this.setParameters({ tempoBpm });
    }
    processSample(modulatorSample) {
      const modulator = bounded(modulatorSample, MAX_INPUT_MAGNITUDE6);
      const filtered = this.processWet(modulator);
      this.currentOutput = bounded(modulator * (1 - this.mix) + filtered * this.mix, MAX_OUTPUT_MAGNITUDE3);
      return this.currentOutput;
    }
    processWet(modulator) {
      if (this.framesUntilStep <= 0) {
        this.activeStep = this.activeStep + 1 & 7;
        this.framesUntilStep = this.stepFrames;
        this.updateCarrierBank();
      }
      for (let band = 0; band < this.activeBands; band += 1) {
        this.bandCarriers[band] = this.oscillators[band]?.processSample() ?? 0;
      }
      const vocoded = this.vocoder.processWithCarrierBank(modulator, this.bandCarriers);
      const filtered = this.toneFilter.processSample(vocoded);
      this.frame += 1;
      this.framesUntilStep -= 1;
      return bounded(filtered, MAX_OUTPUT_MAGNITUDE3);
    }
    processBlock(inputLeft, inputRight, outputLeft, outputRight, frames = Math.min(inputLeft.length, inputRight.length, outputLeft.length, outputRight.length)) {
      const count = Math.max(0, Math.min(Math.floor(frames), inputLeft.length, inputRight.length, outputLeft.length, outputRight.length));
      for (let index = 0; index < count; index += 1) {
        const left = inputLeft[index] ?? 0;
        const right = inputRight[index] ?? 0;
        const modulator = bounded((bounded(left, MAX_INPUT_MAGNITUDE6) + bounded(right, MAX_INPUT_MAGNITUDE6)) * 0.5, MAX_INPUT_MAGNITUDE6);
        const wet = this.processWet(modulator);
        const boundedLeft = bounded(left, MAX_INPUT_MAGNITUDE6);
        const boundedRight = bounded(right, MAX_INPUT_MAGNITUDE6);
        outputLeft[index] = bounded(boundedLeft * (1 - this.mix) + wet * this.mix, MAX_OUTPUT_MAGNITUDE3);
        outputRight[index] = bounded(boundedRight * (1 - this.mix) + wet * this.mix, MAX_OUTPUT_MAGNITUDE3);
        this.currentOutput = (outputLeft[index] + outputRight[index]) * 0.5;
      }
    }
    reset(initialFrame = 0) {
      _BrowserOscBotCore.validateFrame(initialFrame);
      this.frame = initialFrame;
      this.activeStep = 0;
      this.framesUntilStep = this.currentStepFrames;
      this.currentOutput = 0;
      this.vocoder.reset();
      this.toneFilter.reset();
      for (const oscillator of this.oscillators) oscillator.reset();
      this.updateCarrierBank();
    }
    updateCarrierBank() {
      const pattern = STEP_PATTERNS[this.patternIndex] ?? STEP_PATTERNS[0];
      const semitones = pattern[this.activeStep] ?? 0;
      const transpose = 2 ** (semitones / 12);
      for (let band = 0; band < this.activeBands; band += 1) {
        const center = this.vocoder.getBandCenterFrequencyHz(band);
        this.oscillators[band]?.set(center * transpose, this.waveform);
      }
    }
    static computeStepFrames(sampleRate, tempoBpm) {
      return Math.max(1, Math.round(sampleRate * 60 / (tempoBpm * 4)));
    }
    static validateBands(value) {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_BANDS2 || value > MAX_BANDS2) {
        throw new RangeError(`Browser OSC BOT bands must be an integer from ${MIN_BANDS2} to ${MAX_BANDS2}.`);
      }
      return value;
    }
    static validateWaveform(value) {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 2) {
        throw new RangeError("Browser OSC BOT waveform must be 0 (saw), 1 (square), or 2 (triangle).");
      }
      return value;
    }
    static validatePattern(value) {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value >= STEP_PATTERNS.length) {
        throw new RangeError(`Browser OSC BOT pattern must be an integer from 0 to ${STEP_PATTERNS.length - 1}.`);
      }
      return value;
    }
    static validateTone(value, sampleRate) {
      if (!Number.isFinite(value) || value < 100 || value > 16e3 || value >= sampleRate * 0.49) {
        throw new RangeError("Browser OSC BOT tone cutoff must be from 100 to 16000 Hz and below 0.49 of sample rate.");
      }
      return value;
    }
    static validateMix(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError("Browser OSC BOT mix must be between 0 and 1.");
      }
      return value;
    }
    static validateTempo(value) {
      if (!Number.isFinite(value) || value < MIN_TEMPO_BPM || value > MAX_TEMPO_BPM) {
        throw new RangeError(`Browser OSC BOT tempo must be from ${MIN_TEMPO_BPM} to ${MAX_TEMPO_BPM} BPM.`);
      }
      return value;
    }
    static validateFrame(value) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("Browser OSC BOT frame must be a non-negative safe integer.");
      }
    }
  };

  // src/audio/dsp/SampleFrameScheduler.ts
  var SampleFrameScheduler = class {
    capacity;
    currentFrame;
    blockStartFrame = 0;
    blockEndFrame = 0;
    eventFrame = 0;
    eventCode = 0;
    eventValue = 0;
    droppedEvents = 0;
    count = 0;
    blockActive = false;
    eventFrames;
    eventCodes;
    eventValues;
    constructor(capacity, initialFrame = 0) {
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new RangeError("capacity must be a positive integer");
      }
      if (!Number.isFinite(initialFrame)) throw new RangeError("initialFrame must be finite");
      this.capacity = capacity;
      this.currentFrame = Math.max(0, Math.floor(initialFrame));
      this.eventFrames = new Float64Array(capacity);
      this.eventCodes = new Int32Array(capacity);
      this.eventValues = new Float64Array(capacity);
    }
    get queuedCount() {
      return this.count;
    }
    /** Inserts events in frame order; equal-frame events retain insertion order. */
    scheduleAtFrame(frame, code, value = 0) {
      if (!Number.isInteger(frame) || !Number.isInteger(code) || !Number.isFinite(value) || frame < this.currentFrame) {
        return false;
      }
      if (this.count === this.capacity) {
        this.droppedEvents += 1;
        return false;
      }
      const scheduledFrame = frame;
      let insertionIndex = this.count;
      while (insertionIndex > 0 && this.eventFrames[insertionIndex - 1] > scheduledFrame) {
        this.eventFrames[insertionIndex] = this.eventFrames[insertionIndex - 1];
        this.eventCodes[insertionIndex] = this.eventCodes[insertionIndex - 1];
        this.eventValues[insertionIndex] = this.eventValues[insertionIndex - 1];
        insertionIndex -= 1;
      }
      this.eventFrames[insertionIndex] = scheduledFrame;
      this.eventCodes[insertionIndex] = code;
      this.eventValues[insertionIndex] = value;
      this.count += 1;
      return true;
    }
    /** Replace queued events with one safety event at an absolute frame. */
    replacePendingWith(frame, code, value = 0) {
      if (!Number.isInteger(frame) || !Number.isInteger(code) || !Number.isFinite(value) || frame < this.currentFrame || this.blockActive) return false;
      this.count = 0;
      this.eventFrames[0] = frame;
      this.eventCodes[0] = code;
      this.eventValues[0] = value;
      this.count = 1;
      return true;
    }
    peekNextFrame() {
      return this.count > 0 ? this.eventFrames[0] : null;
    }
    /** Starts a half-open processing interval [currentFrame, currentFrame + frameCount). */
    beginBlock(frameCount) {
      if (!Number.isInteger(frameCount) || frameCount < 0 || this.blockActive) return false;
      this.blockStartFrame = this.currentFrame;
      this.blockEndFrame = this.currentFrame + frameCount;
      this.blockActive = true;
      return true;
    }
    /** Sample offset of the next event in the active block, or -1 if none is due. */
    nextEventOffset() {
      if (!this.blockActive || this.count === 0) return -1;
      const frame = this.eventFrames[0];
      if (frame < this.blockStartFrame || frame >= this.blockEndFrame) return -1;
      return frame - this.blockStartFrame;
    }
    /** Removes the next queued event and copies its scalar payload to public fields. */
    dequeueNextEvent() {
      if (this.count === 0) return false;
      this.eventFrame = this.eventFrames[0];
      this.eventCode = this.eventCodes[0];
      this.eventValue = this.eventValues[0];
      this.count -= 1;
      for (let index = 0; index < this.count; index += 1) {
        this.eventFrames[index] = this.eventFrames[index + 1];
        this.eventCodes[index] = this.eventCodes[index + 1];
        this.eventValues[index] = this.eventValues[index + 1];
      }
      return true;
    }
    endBlock() {
      if (!this.blockActive) return false;
      if (this.count > 0 && this.eventFrames[0] < this.blockEndFrame) return false;
      this.currentFrame = this.blockEndFrame;
      this.blockActive = false;
      return true;
    }
    /** Advances the frame cursor outside a block interval. */
    advanceFrames(frameCount) {
      if (!Number.isInteger(frameCount) || frameCount < 0 || this.blockActive) return false;
      this.currentFrame += frameCount;
      return true;
    }
  };

  // src/audio/fx/BrowserOscVocCore.ts
  var MIN_SAMPLE_RATE8 = 8e3;
  var MAX_SAMPLE_RATE9 = 192e3;
  var MAX_EVENT_COUNT = 256;
  var MIN_BANDS3 = 8;
  var MAX_BANDS3 = 24;
  var ATTACK_SECONDS2 = 5e-3;
  var RELEASE_SECONDS2 = 0.035;
  var MAX_INPUT_MAGNITUDE7 = 8;
  var MAX_OUTPUT_MAGNITUDE4 = 4;
  var EVENT_NOTE_ON = 1;
  var EVENT_NOTE_OFF = 2;
  var EVENT_ALL_NOTES_OFF = 3;
  var EVENT_KIND_SHIFT = 14;
  var EVENT_CHANNEL_SHIFT = 7;
  var MIDI_NOTE_COUNT = 128;
  function clamp18(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function cleanSample(value) {
    return Number.isFinite(value) ? clamp18(value, -MAX_INPUT_MAGNITUDE7, MAX_INPUT_MAGNITUDE7) : 0;
  }
  function polyBlep3(phase, step) {
    if (step <= 0) return 0;
    if (phase < step) {
      const t = phase / step;
      return 2 * t - t * t - 1;
    }
    if (phase > 1 - step) {
      const t = (phase - 1) / step;
      return t * t + 2 * t + 1;
    }
    return 0;
  }
  var BrowserOscVocCore = class _BrowserOscVocCore {
    sampleRate;
    latencySamples = 0;
    eventCapacity = MAX_EVENT_COUNT;
    attackCoefficient;
    releaseCoefficient;
    vocoder;
    scheduler;
    currentWaveform;
    selectedChannel;
    octaveSemitones;
    activeBands;
    phase = 0;
    phaseStep = 440 / 48e3;
    lastFrequencyHz = 440;
    voiceTarget = 0;
    voiceEnvelope = 0;
    latestNote = -1;
    noteSequence = 0;
    currentLeft = 0;
    currentRight = 0;
    heldVelocities = new Float64Array(MIDI_NOTE_COUNT);
    heldOrder = new Float64Array(MIDI_NOTE_COUNT);
    constructor(sampleRate = 48e3, parameters = {}, initialFrame = 0) {
      if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE8 || sampleRate > MAX_SAMPLE_RATE9) {
        throw new RangeError(`Browser OSC VOC sample rate must be from ${MIN_SAMPLE_RATE8} to ${MAX_SAMPLE_RATE9} Hz.`);
      }
      this.sampleRate = sampleRate;
      this.attackCoefficient = Math.exp(-1 / (ATTACK_SECONDS2 * sampleRate));
      this.releaseCoefficient = Math.exp(-1 / (RELEASE_SECONDS2 * sampleRate));
      this.currentWaveform = 0;
      this.selectedChannel = 1;
      this.octaveSemitones = 0;
      this.activeBands = 16;
      _BrowserOscVocCore.validateInitialFrame(initialFrame);
      this.scheduler = new SampleFrameScheduler(MAX_EVENT_COUNT, initialFrame);
      this.vocoder = new BrowserVocoderCore(sampleRate, { bands: 16, carrier: 0 });
      this.setParameters(parameters);
    }
    get outputLeft() {
      return this.currentLeft;
    }
    get outputRight() {
      return this.currentRight;
    }
    get currentFrame() {
      return this.scheduler.currentFrame;
    }
    get pendingEventCount() {
      return this.scheduler.queuedCount;
    }
    get activeNote() {
      return this.latestNote >= 0 ? this.latestNote : null;
    }
    get targetFrequencyHz() {
      return this.lastFrequencyHz;
    }
    get waveform() {
      return this.currentWaveform;
    }
    get midiChannel() {
      return this.selectedChannel;
    }
    get octave() {
      return this.octaveSemitones;
    }
    get bands() {
      return this.activeBands;
    }
    /** Validate the whole update before applying any part of it. */
    setParameters(parameters) {
      for (const key of Object.keys(parameters)) {
        if (key !== "waveform" && key !== "midiChannel" && key !== "octave" && key !== "bands") {
          throw new RangeError(`Browser OSC VOC does not support the ${key} parameter.`);
        }
      }
      const nextWaveform = parameters.waveform === void 0 ? this.currentWaveform : _BrowserOscVocCore.validateWaveform(parameters.waveform);
      const nextChannel = parameters.midiChannel === void 0 ? this.selectedChannel : _BrowserOscVocCore.validateChannel(parameters.midiChannel);
      const nextOctave = parameters.octave === void 0 ? this.octaveSemitones : _BrowserOscVocCore.validateOctave(parameters.octave);
      const nextBands = parameters.bands === void 0 ? this.activeBands : _BrowserOscVocCore.validateBands(parameters.bands);
      if (nextBands !== this.activeBands) {
        this.vocoder.setParameters({ bands: nextBands });
        this.activeBands = nextBands;
      }
      this.currentWaveform = nextWaveform;
      this.octaveSemitones = nextOctave;
      if (nextChannel !== this.selectedChannel) {
        this.selectedChannel = nextChannel;
        this.heldVelocities.fill(0);
        this.heldOrder.fill(0);
        this.latestNote = -1;
        this.voiceTarget = 0;
      }
      this.refreshPitch();
    }
    /** Queue a MIDI note-on at an absolute frame; velocity 0 means note-off. */
    noteOn(channel, note, velocity, frame) {
      _BrowserOscVocCore.validateEvent(channel, note, frame);
      if (!Number.isInteger(velocity) || velocity < 0 || velocity > 127) {
        throw new RangeError("Browser OSC VOC MIDI velocity must be an integer from 0 to 127.");
      }
      this.enqueue(frame, velocity === 0 ? EVENT_NOTE_OFF : EVENT_NOTE_ON, channel, note, velocity);
    }
    /** Queue a MIDI note-off at an absolute frame. */
    noteOff(channel, note, frame) {
      _BrowserOscVocCore.validateEvent(channel, note, frame);
      this.enqueue(frame, EVENT_NOTE_OFF, channel, note, 0);
    }
    /** Schedule a sample-aligned panic, discarding stale pending MIDI events. */
    allNotesOff(frame) {
      if (!Number.isSafeInteger(frame) || frame < this.currentFrame) {
        throw new RangeError(`Browser OSC VOC all-notes-off frame must be a safe integer at or after ${this.currentFrame}.`);
      }
      const code = EVENT_ALL_NOTES_OFF << EVENT_KIND_SHIFT;
      if (!this.scheduler.replacePendingWith(frame, code, 0)) {
        throw new RangeError("Browser OSC VOC could not schedule all-notes-off while processing a block.");
      }
    }
    /** Process one sample frame. Omitted right input means mono input. */
    processSample(modulatorLeft, modulatorRight = modulatorLeft) {
      if (!Number.isSafeInteger(this.currentFrame + 1)) {
        throw new RangeError("Browser OSC VOC sample-frame cursor would exceed the safe integer range.");
      }
      if (!this.scheduler.beginBlock(1)) throw new Error("Browser OSC VOC sample scheduler is already processing a block.");
      while (this.scheduler.nextEventOffset() === 0) this.applyDequeuedEvent();
      this.renderSample(modulatorLeft, modulatorRight);
      if (!this.scheduler.endBlock()) throw new Error("Browser OSC VOC sample scheduler did not finish its frame.");
    }
    /**
     * Align with an AudioWorklet global currentFrame before events are queued.
     * A pending event cannot be rebased because its timestamp is already exact.
     */
    synchronizeFrame(frame) {
      _BrowserOscVocCore.validateInitialFrame(frame);
      if (frame === this.currentFrame) return;
      if (this.scheduler.queuedCount > 0) {
        throw new RangeError("Browser OSC VOC cannot synchronize its frame while MIDI events are pending.");
      }
      this.scheduler = new SampleFrameScheduler(MAX_EVENT_COUNT, frame);
    }
    /**
     * Process any block length. `modulatorRight` may be omitted for mono input;
     * mono wet output is duplicated into the requested left/right buffers.
     */
    processBlock(modulatorLeft, modulatorRight, outputLeft, outputRight, frameCount = modulatorLeft.length) {
      if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
        throw new RangeError("Browser OSC VOC frame count must be a non-negative safe integer.");
      }
      if (modulatorLeft.length < frameCount || modulatorRight && modulatorRight.length < frameCount) {
        throw new RangeError("Browser OSC VOC input buffers are shorter than the requested frame count.");
      }
      if (outputLeft.length < frameCount || outputRight.length < frameCount) {
        throw new RangeError("Browser OSC VOC output buffers are shorter than the requested frame count.");
      }
      if (!Number.isSafeInteger(this.currentFrame + frameCount)) {
        throw new RangeError("Browser OSC VOC sample-frame cursor would exceed the safe integer range.");
      }
      if (!this.scheduler.beginBlock(frameCount)) throw new Error("Browser OSC VOC sample scheduler is already processing a block.");
      let nextEventOffset = this.scheduler.nextEventOffset();
      for (let frame = 0; frame < frameCount; frame += 1) {
        while (nextEventOffset === frame) {
          this.applyDequeuedEvent();
          nextEventOffset = this.scheduler.nextEventOffset();
        }
        const right = modulatorRight ? modulatorRight[frame] ?? 0 : modulatorLeft[frame] ?? 0;
        this.renderSample(modulatorLeft[frame] ?? 0, right);
        outputLeft[frame] = this.currentLeft;
        outputRight[frame] = this.currentRight;
      }
      if (!this.scheduler.endBlock()) throw new Error("Browser OSC VOC left an unprocessed event in the current block.");
    }
    /** Reset voice, frame clock, event queue, oscillator and the shared vocoder. */
    reset(initialFrame = 0) {
      _BrowserOscVocCore.validateInitialFrame(initialFrame);
      this.scheduler = new SampleFrameScheduler(MAX_EVENT_COUNT, initialFrame);
      this.vocoder.reset();
      this.heldVelocities.fill(0);
      this.heldOrder.fill(0);
      this.phase = 0;
      this.phaseStep = 440 / this.sampleRate;
      this.lastFrequencyHz = 440;
      this.voiceTarget = 0;
      this.voiceEnvelope = 0;
      this.latestNote = -1;
      this.noteSequence = 0;
      this.currentLeft = 0;
      this.currentRight = 0;
    }
    enqueue(frame, kind, channel, note, velocity) {
      if (!Number.isSafeInteger(frame) || frame < this.currentFrame) {
        throw new RangeError(`Browser OSC VOC MIDI frame must be a safe integer at or after ${this.currentFrame}.`);
      }
      const code = kind << EVENT_KIND_SHIFT | channel << EVENT_CHANNEL_SHIFT | note;
      if (!this.scheduler.scheduleAtFrame(frame, code, velocity)) {
        throw new RangeError(this.scheduler.queuedCount >= MAX_EVENT_COUNT ? `Browser OSC VOC MIDI event queue is full (${MAX_EVENT_COUNT}).` : "Browser OSC VOC could not schedule the MIDI event.");
      }
    }
    applyDequeuedEvent() {
      if (!this.scheduler.dequeueNextEvent()) return;
      const code = this.scheduler.eventCode;
      const kind = code >> EVENT_KIND_SHIFT;
      const channel = code >> EVENT_CHANNEL_SHIFT & 127;
      const note = code & 127;
      if (kind === EVENT_ALL_NOTES_OFF) {
        this.heldVelocities.fill(0);
        this.heldOrder.fill(0);
        this.latestNote = -1;
        this.voiceTarget = 0;
        return;
      }
      if (channel !== this.selectedChannel) return;
      if (kind === EVENT_NOTE_ON && this.scheduler.eventValue > 0) {
        this.heldVelocities[note] = this.scheduler.eventValue / 127;
        this.noteSequence += 1;
        this.heldOrder[note] = this.noteSequence;
      } else if (kind === EVENT_NOTE_OFF) {
        this.heldVelocities[note] = 0;
        this.heldOrder[note] = 0;
      }
      this.selectMostRecentHeldNote();
    }
    selectMostRecentHeldNote() {
      let selected = -1;
      let selectedOrder = 0;
      for (let note = 0; note < MIDI_NOTE_COUNT; note += 1) {
        const order = this.heldOrder[note] ?? 0;
        if (order > selectedOrder) {
          selected = note;
          selectedOrder = order;
        }
      }
      this.latestNote = selected;
      this.voiceTarget = selected >= 0 ? this.heldVelocities[selected] ?? 0 : 0;
      if (selected >= 0) this.refreshPitch();
    }
    refreshPitch() {
      if (this.latestNote < 0) return;
      const frequency = 440 * 2 ** ((this.latestNote - 69 + this.octaveSemitones) / 12);
      const boundedFrequency = clamp18(frequency, 0, this.sampleRate * 0.45);
      this.lastFrequencyHz = Number.isFinite(boundedFrequency) ? boundedFrequency : 0;
      this.phaseStep = this.lastFrequencyHz / this.sampleRate;
    }
    renderSample(modulatorLeft, modulatorRight) {
      const modulator = (cleanSample(modulatorLeft) + cleanSample(modulatorRight)) * 0.5;
      const coefficient = this.voiceTarget > this.voiceEnvelope ? this.attackCoefficient : this.releaseCoefficient;
      this.voiceEnvelope = clamp18(
        coefficient * this.voiceEnvelope + (1 - coefficient) * this.voiceTarget,
        0,
        1
      );
      let carrier = this.nextCarrierSample() * this.voiceEnvelope;
      if (!Number.isFinite(carrier)) carrier = 0;
      const output = this.vocoder.processWithCarrier(modulator, carrier);
      const safeOutput = Number.isFinite(output) ? clamp18(output, -MAX_OUTPUT_MAGNITUDE4, MAX_OUTPUT_MAGNITUDE4) : 0;
      this.currentLeft = safeOutput;
      this.currentRight = safeOutput;
    }
    nextCarrierSample() {
      const phase = this.phase;
      const step = Math.min(this.phaseStep, 0.45);
      let sample;
      if (this.currentWaveform === 0) {
        sample = 2 * phase - 1 - polyBlep3(phase, step);
      } else {
        const duty = this.currentWaveform === 1 ? 0.5 : 0.25;
        const fallingEdgePhase = phase >= duty ? phase - duty : phase + 1 - duty;
        sample = (phase < duty ? 1 : -1) + polyBlep3(phase, step) - polyBlep3(fallingEdgePhase, step);
      }
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      return Number.isFinite(sample) ? sample : 0;
    }
    static validateWaveform(value) {
      if (!Number.isInteger(value) || value < 0 || value > 2) {
        throw new RangeError("Browser OSC VOC waveform must be 0 (saw), 1 (square), or 2 (pulse).");
      }
      return value;
    }
    static validateChannel(value) {
      if (!Number.isInteger(value) || value < 1 || value > 16) {
        throw new RangeError("Browser OSC VOC MIDI channel must be an integer from 1 to 16.");
      }
      return value;
    }
    static validateOctave(value) {
      if (!Number.isFinite(value) || value < -24 || value > 24) {
        throw new RangeError("Browser OSC VOC octave transpose must be between -24 and 24 semitones.");
      }
      return value;
    }
    static validateBands(value) {
      if (!Number.isInteger(value) || value < MIN_BANDS3 || value > MAX_BANDS3) {
        throw new RangeError(`Browser OSC VOC bands must be an integer from ${MIN_BANDS3} to ${MAX_BANDS3}.`);
      }
      return value;
    }
    static validateEvent(channel, note, frame) {
      if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
        throw new RangeError("Browser OSC VOC MIDI event channel must be an integer from 1 to 16.");
      }
      if (!Number.isInteger(note) || note < 0 || note > 127) {
        throw new RangeError("Browser OSC VOC MIDI note must be an integer from 0 to 127.");
      }
      if (!Number.isSafeInteger(frame) || frame < 0) {
        throw new RangeError("Browser OSC VOC MIDI frame must be a non-negative safe integer.");
      }
    }
    static validateInitialFrame(frame) {
      if (!Number.isSafeInteger(frame) || frame < 0) {
        throw new RangeError("Browser OSC VOC sample frame must be a non-negative safe integer.");
      }
    }
  };

  // src/audio/fx/dsp/BrowserRollDsp.ts
  var MIN_BPM = 40;
  var MAX_BPM = 300;
  var MAX_SLICE_BEATS = 4;
  var MAX_CAPTURE_SECONDS = 60 * MAX_SLICE_BEATS / MIN_BPM;
  var EVENT_FADE_FRAMES = 16;
  var SLICE_DIVISIONS = [0.25, 0.5, 1, 2, 4];
  var HALF_PI2 = Math.PI * 0.5;
  var MAX_STORED_SAMPLE = 4;
  var MAX_OUTPUT_SAMPLE = 8;
  var BrowserRollDsp = class {
    sampleRate;
    maxSliceFrames;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    boundaryCount = 0;
    lastBoundaryFrame = -1;
    leftBuffers;
    rightBuffers;
    fadeTailLeft = new Float32Array(EVENT_FADE_FRAMES);
    fadeTailRight = new Float32Array(EVENT_FADE_FRAMES);
    captureBufferIndex = 0;
    playbackBufferIndex = -1;
    captureFrames = 0;
    playbackLength = 0;
    playbackPosition = 0;
    playbackDirectionSign = 1;
    playbackRate = 1;
    gain = 1;
    tailWriteIndex = 0;
    tailFrames = 0;
    fadeTailStart = 0;
    fadeFrames = 0;
    fadePosition = 0;
    framesUntilBoundary;
    activeIntervalFrames;
    currentBpm;
    currentSliceBeats;
    currentDecayPercent;
    currentPitchSemitones;
    currentDirection;
    pendingBpm;
    pendingSliceBeats;
    pendingDecayPercent;
    pendingPitchSemitones;
    pendingDirection;
    hasSlice = false;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.maxSliceFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_SECONDS) + 2;
      this.leftBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
      this.rightBuffers = [new Float32Array(this.maxSliceFrames), new Float32Array(this.maxSliceFrames)];
      this.currentBpm = this.pendingBpm = this.clampBpm(parameters.bpm ?? 120);
      this.currentSliceBeats = this.pendingSliceBeats = this.quantizeSliceBeats(parameters.sliceBeats ?? 0.5);
      this.currentDecayPercent = this.pendingDecayPercent = this.clampPercent(parameters.decayPercent ?? 20);
      this.currentPitchSemitones = this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones ?? 0);
      this.currentDirection = this.pendingDirection = this.clampDirection(parameters.direction ?? "forward");
      this.playbackRate = this.rateForSemitones(this.currentPitchSemitones);
      this.playbackDirectionSign = this.currentDirection === "reverse" ? -1 : 1;
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
      this.framesUntilBoundary = this.activeIntervalFrames;
    }
    get hasCapturedSlice() {
      return this.hasSlice;
    }
    get activeSliceFrames() {
      return this.playbackLength;
    }
    get remainingFramesToBoundary() {
      return this.framesUntilBoundary;
    }
    get diagnostics() {
      return {
        framesProcessed: this.framesProcessed,
        boundaryCount: this.boundaryCount,
        lastBoundaryFrame: this.lastBoundaryFrame,
        activeBpm: this.currentBpm,
        activeSliceBeats: this.currentSliceBeats,
        activeSliceFrames: this.playbackLength,
        activeDecayPercent: this.currentDecayPercent,
        activePitchSemitones: this.currentPitchSemitones,
        playbackRate: this.playbackRate,
        activeDirection: this.currentDirection,
        remainingFramesToBoundary: this.framesUntilBoundary,
        capturedSlice: this.hasSlice,
        currentGain: this.gain,
        fadeRemainingFrames: Math.max(0, this.fadeFrames - this.fadePosition)
      };
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.pendingBpm = this.clampBpm(parameters.bpm);
      if (Number.isFinite(parameters.sliceBeats)) {
        this.pendingSliceBeats = this.quantizeSliceBeats(parameters.sliceBeats);
      }
      if (Number.isFinite(parameters.decayPercent)) {
        this.pendingDecayPercent = this.clampPercent(parameters.decayPercent);
      }
      if (Number.isFinite(parameters.pitchSemitones)) {
        this.pendingPitchSemitones = this.clampPitch(parameters.pitchSemitones);
      }
      if (parameters.direction === "forward" || parameters.direction === "reverse" || parameters.direction === "alternate") {
        this.pendingDirection = parameters.direction;
      }
    }
    /** Writes one stereo frame. No allocation occurs in this audio callback. */
    processSample(left, right) {
      const captureLeft = this.leftBuffers[this.captureBufferIndex];
      const captureRight = this.rightBuffers[this.captureBufferIndex];
      if (this.captureFrames < this.maxSliceFrames) {
        captureLeft[this.captureFrames] = this.sanitizeInput(left);
        captureRight[this.captureFrames] = this.sanitizeInput(right);
      }
      if (!this.hasSlice || this.playbackBufferIndex < 0 || this.playbackLength <= 0) {
        this.wetLeft = 0;
        this.wetRight = 0;
      } else {
        this.renderPlayback();
      }
      this.recordFadeTail();
      if (this.hasSlice && this.playbackLength > 0) this.advancePlayback();
      this.captureFrames = Math.min(this.captureFrames + 1, this.maxSliceFrames);
      this.framesUntilBoundary -= 1;
      this.framesProcessed += 1;
      if (this.framesUntilBoundary <= 0) {
        this.onBoundary();
      }
    }
    /** Reset signal history while retaining constructor-allocated buffers. */
    reset() {
      this.captureBufferIndex = 0;
      this.playbackBufferIndex = -1;
      this.captureFrames = 0;
      this.playbackLength = 0;
      this.playbackPosition = 0;
      this.gain = 1;
      this.tailWriteIndex = 0;
      this.tailFrames = 0;
      this.fadeTailStart = 0;
      this.fadeFrames = 0;
      this.fadePosition = 0;
      this.fadeTailLeft.fill(0);
      this.fadeTailRight.fill(0);
      this.currentBpm = this.pendingBpm;
      this.currentSliceBeats = this.pendingSliceBeats;
      this.currentDecayPercent = this.pendingDecayPercent;
      this.currentPitchSemitones = this.pendingPitchSemitones;
      this.currentDirection = this.pendingDirection;
      this.playbackRate = this.rateForSemitones(this.currentPitchSemitones);
      this.playbackDirectionSign = this.currentDirection === "reverse" ? -1 : 1;
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
      this.framesUntilBoundary = this.activeIntervalFrames;
      this.hasSlice = false;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.framesProcessed = 0;
      this.boundaryCount = 0;
      this.lastBoundaryFrame = -1;
    }
    renderPlayback() {
      const leftBuffer = this.leftBuffers[this.playbackBufferIndex];
      const rightBuffer = this.rightBuffers[this.playbackBufferIndex];
      let left = this.readFourPoint(leftBuffer, this.playbackPosition) * this.gain;
      let right = this.readFourPoint(rightBuffer, this.playbackPosition) * this.gain;
      if (this.fadePosition < this.fadeFrames) {
        const position = this.fadeFrames <= 1 ? 1 : this.fadePosition / (this.fadeFrames - 1);
        const tailIndex = (this.fadeTailStart + this.fadePosition) % EVENT_FADE_FRAMES;
        const fadeOut = Math.cos(position * HALF_PI2);
        const fadeIn = Math.sin(position * HALF_PI2);
        left = this.fadeTailLeft[tailIndex] * fadeOut + left * fadeIn;
        right = this.fadeTailRight[tailIndex] * fadeOut + right * fadeIn;
        this.fadePosition += 1;
      }
      this.wetLeft = this.sanitizeOutput(left);
      this.wetRight = this.sanitizeOutput(right);
    }
    advancePlayback() {
      const nextPosition = this.playbackPosition + this.playbackDirectionSign * this.playbackRate;
      let wrapped = false;
      if (nextPosition >= this.playbackLength || nextPosition < 0) {
        this.playbackPosition = nextPosition % this.playbackLength;
        if (this.playbackPosition < 0) this.playbackPosition += this.playbackLength;
        wrapped = true;
      } else {
        this.playbackPosition = nextPosition;
      }
      if (wrapped) {
        if (this.framesUntilBoundary > 1) {
          this.gain *= 1 - this.currentDecayPercent / 100;
        }
        this.beginEventFade();
      }
    }
    recordFadeTail() {
      this.fadeTailLeft[this.tailWriteIndex] = this.wetLeft;
      this.fadeTailRight[this.tailWriteIndex] = this.wetRight;
      this.tailWriteIndex = (this.tailWriteIndex + 1) % EVENT_FADE_FRAMES;
      this.tailFrames = Math.min(EVENT_FADE_FRAMES, this.tailFrames + 1);
    }
    beginEventFade() {
      this.fadeFrames = Math.min(EVENT_FADE_FRAMES, this.tailFrames);
      this.fadePosition = 0;
      this.fadeTailStart = (this.tailWriteIndex - this.fadeFrames + EVENT_FADE_FRAMES) % EVENT_FADE_FRAMES;
    }
    onBoundary() {
      this.boundaryCount += 1;
      this.lastBoundaryFrame = this.framesProcessed - 1;
      const validFrames = Math.min(this.captureFrames, this.maxSliceFrames);
      const hadSlice = this.hasSlice;
      if (validFrames > 0) {
        this.playbackBufferIndex = this.captureBufferIndex;
        this.captureBufferIndex = 1 - this.captureBufferIndex;
        this.playbackLength = validFrames;
        this.hasSlice = true;
      }
      this.captureFrames = 0;
      this.currentBpm = this.pendingBpm;
      this.currentSliceBeats = this.pendingSliceBeats;
      this.currentDecayPercent = this.pendingDecayPercent;
      this.currentPitchSemitones = this.pendingPitchSemitones;
      this.currentDirection = this.pendingDirection;
      this.playbackRate = this.rateForSemitones(this.currentPitchSemitones);
      if (this.hasSlice) {
        if (hadSlice) this.gain *= 1 - this.pendingDecayPercent / 100;
        this.updatePlaybackDirection(hadSlice);
        this.playbackPosition = this.playbackDirectionSign > 0 ? 0 : this.playbackLength - 1;
        this.beginEventFade();
      }
      this.activeIntervalFrames = this.intervalFrames(this.currentBpm, this.currentSliceBeats);
      this.framesUntilBoundary = this.activeIntervalFrames;
    }
    updatePlaybackDirection(hadSlice) {
      if (this.currentDirection === "forward") {
        this.playbackDirectionSign = 1;
      } else if (this.currentDirection === "reverse") {
        this.playbackDirectionSign = -1;
      } else if (!hadSlice) {
        this.playbackDirectionSign = 1;
      } else {
        this.playbackDirectionSign *= -1;
      }
    }
    /** Four-point Lagrange interpolation, with every neighboring tap wrapped. */
    readFourPoint(buffer, position) {
      const length = this.playbackLength;
      if (length <= 1) return buffer[0] ?? 0;
      const base = Math.floor(position);
      const fraction = position - base;
      const previous = this.readWrapped(buffer, base - 1, length);
      const current = this.readWrapped(buffer, base, length);
      const next = this.readWrapped(buffer, base + 1, length);
      const afterNext = this.readWrapped(buffer, base + 2, length);
      const weightPrevious = -(fraction * (fraction - 1) * (fraction - 2)) / 6;
      const weightCurrent = (fraction + 1) * (fraction - 1) * (fraction - 2) / 2;
      const weightNext = -((fraction + 1) * fraction * (fraction - 2)) / 2;
      const weightAfterNext = (fraction + 1) * fraction * (fraction - 1) / 6;
      return previous * weightPrevious + current * weightCurrent + next * weightNext + afterNext * weightAfterNext;
    }
    readWrapped(buffer, index, length) {
      let wrappedIndex = index % length;
      if (wrappedIndex < 0) wrappedIndex += length;
      return buffer[wrappedIndex] ?? 0;
    }
    intervalFrames(bpm, sliceBeats) {
      const rawFrames = 60 * this.sampleRate * sliceBeats / bpm;
      return Math.max(1, Math.min(this.maxSliceFrames, Math.round(rawFrames)));
    }
    rateForSemitones(semitones) {
      return 2 ** (semitones / 12);
    }
    clampBpm(value) {
      return Math.max(MIN_BPM, Math.min(MAX_BPM, value));
    }
    quantizeSliceBeats(value) {
      let nearest = SLICE_DIVISIONS[0];
      let distance = Math.abs(value - nearest);
      for (let index = 1; index < SLICE_DIVISIONS.length; index += 1) {
        const option = SLICE_DIVISIONS[index];
        const nextDistance = Math.abs(value - option);
        if (nextDistance < distance) {
          nearest = option;
          distance = nextDistance;
        }
      }
      return nearest;
    }
    clampPercent(value) {
      return Math.max(0, Math.min(100, value));
    }
    clampPitch(value) {
      return Math.max(-24, Math.min(24, value));
    }
    clampDirection(value) {
      return value === "reverse" || value === "alternate" ? value : "forward";
    }
    sanitizeInput(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(-MAX_STORED_SAMPLE, Math.min(MAX_STORED_SAMPLE, value));
    }
    sanitizeOutput(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(-MAX_OUTPUT_SAMPLE, Math.min(MAX_OUTPUT_SAMPLE, value));
    }
  };

  // src/audio/fx/dsp/BrowserFreezeDsp.ts
  var MIN_CAPTURE_MS = 2;
  var MAX_CAPTURE_MS = 2e3;
  var MIN_PITCH_SEMITONES = -24;
  var MAX_PITCH_SEMITONES2 = 24;
  var MIN_SAMPLE_RATE9 = 8e3;
  var DEFAULT_SAMPLE_RATE = 48e3;
  var DEFAULT_CAPTURE_MS = 250;
  var DEFAULT_PITCH_SEMITONES = 0;
  var RELEASE_FADE_MS = 5;
  var MAX_LOOP_SEAM_MS = 5;
  var PITCH_SMOOTHING_MS = 15;
  var MAX_ABS_SAMPLE = 8;
  function clamp19(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function finiteSample(value) {
    return Number.isFinite(value) ? clamp19(value, -MAX_ABS_SAMPLE, MAX_ABS_SAMPLE) : 0;
  }
  function onePoleAlpha4(timeMs, sampleRate) {
    return Math.exp(-1 / (Math.max(1e-3, timeMs) * 1e-3 * sampleRate));
  }
  var BrowserFreezeDsp = class {
    sampleRate;
    maxCaptureFrames;
    outputLeft = 0;
    outputRight = 0;
    framesProcessed = 0;
    historyLeft;
    historyRight;
    loopLeft;
    loopRight;
    fadeStep;
    pitchSmoothingAlpha;
    captureLengthMs = DEFAULT_CAPTURE_MS;
    captureLengthFrames;
    targetPitchSemitones = DEFAULT_PITCH_SEMITONES;
    targetPlaybackRate = 1;
    playbackRate = 1;
    targetFrozen = false;
    capturePending = false;
    frozenBufferActive = false;
    activationGain = 0;
    writePosition = 0;
    historyFrames = 0;
    loopStart = 0;
    loopLength = 0;
    loopCrossfadeFrames = 0;
    loopPhase = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= MIN_SAMPLE_RATE9 ? sampleRate : DEFAULT_SAMPLE_RATE;
      this.maxCaptureFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_MS / 1e3);
      this.historyLeft = new Float32Array(this.maxCaptureFrames);
      this.historyRight = new Float32Array(this.maxCaptureFrames);
      this.loopLeft = new Float32Array(this.maxCaptureFrames);
      this.loopRight = new Float32Array(this.maxCaptureFrames);
      this.captureLengthFrames = this.framesForCapture(DEFAULT_CAPTURE_MS);
      this.fadeStep = 1 / Math.max(1, Math.round(this.sampleRate * RELEASE_FADE_MS / 1e3));
      this.pitchSmoothingAlpha = onePoleAlpha4(PITCH_SMOOTHING_MS, this.sampleRate);
      this.setParameters(parameters);
    }
    /** Target capture state; when false, a short release fade may still be active. */
    get isFrozen() {
      return this.targetFrozen;
    }
    /** True while the captured audio remains held, including its release fade. */
    get hasFrozenBuffer() {
      return this.frozenBufferActive;
    }
    /** Controls and capture length latch at the next freeze activation. */
    setParameters(parameters) {
      if (Number.isFinite(parameters.captureLengthMs)) {
        this.captureLengthMs = clamp19(parameters.captureLengthMs, MIN_CAPTURE_MS, MAX_CAPTURE_MS);
        this.captureLengthFrames = this.framesForCapture(this.captureLengthMs);
      }
      if (Number.isFinite(parameters.pitchSemitones)) {
        this.targetPitchSemitones = clamp19(parameters.pitchSemitones, MIN_PITCH_SEMITONES, MAX_PITCH_SEMITONES2);
        this.targetPlaybackRate = Math.pow(2, this.targetPitchSemitones / 12);
      }
      if (typeof parameters.frozen === "boolean" && parameters.frozen !== this.targetFrozen) {
        this.setFrozen(parameters.frozen);
      }
    }
    /** Processes one frame and exposes its stereo result through outputLeft/Right. */
    processSample(inputLeft, inputRight) {
      const left = finiteSample(inputLeft);
      const right = finiteSample(inputRight);
      this.writeHistory(left, right);
      const targetLoopRate = this.loopLength > this.loopCrossfadeFrames && this.loopLength > 0 ? this.targetPlaybackRate * ((this.loopLength - this.loopCrossfadeFrames) / this.loopLength) : this.targetPlaybackRate;
      this.playbackRate += (targetLoopRate - this.playbackRate) * (1 - this.pitchSmoothingAlpha);
      if (this.capturePending && this.historyFrames >= this.captureLengthFrames && (!this.frozenBufferActive || this.activationGain === 0)) {
        this.captureHistory();
        this.capturePending = false;
      }
      const fadeTarget = this.targetFrozen && this.frozenBufferActive && !this.capturePending ? 1 : 0;
      this.activationGain = this.moveToward(this.activationGain, fadeTarget, this.fadeStep);
      let frozenLeft = 0;
      let frozenRight = 0;
      if (this.frozenBufferActive) {
        frozenLeft = this.readFrozenChannel(this.loopLeft);
        frozenRight = this.readFrozenChannel(this.loopRight);
      }
      const dryGain = Math.cos(this.activationGain * Math.PI / 2);
      const frozenGain = Math.sin(this.activationGain * Math.PI / 2);
      this.outputLeft = finiteSample(left * dryGain + frozenLeft * frozenGain);
      this.outputRight = finiteSample(right * dryGain + frozenRight * frozenGain);
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
    processBlock(inputLeft, inputRight, outputLeft, outputRight) {
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
    reset() {
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
      this.playbackRate = this.targetPlaybackRate;
      this.outputLeft = 0;
      this.outputRight = 0;
      this.framesProcessed = 0;
    }
    /** Snapshot diagnostics allocate only when explicitly read, outside processing. */
    get diagnostics() {
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
        framesProcessed: this.framesProcessed
      };
    }
    setFrozen(frozen) {
      if (frozen) {
        this.targetFrozen = true;
        if (this.frozenBufferActive && this.activationGain > 0) {
          this.capturePending = true;
        } else if (this.historyFrames >= this.captureLengthFrames) {
          this.captureHistory();
          this.capturePending = false;
        } else {
          this.capturePending = true;
        }
        return;
      }
      this.targetFrozen = false;
      this.capturePending = false;
    }
    captureHistory() {
      this.loopLength = this.captureLengthFrames;
      this.loopStart = this.wrapHistoryIndex(this.writePosition - this.loopLength);
      const nextHistoryLeft = this.loopLeft;
      const nextHistoryRight = this.loopRight;
      this.loopLeft = this.historyLeft;
      this.loopRight = this.historyRight;
      this.historyLeft = nextHistoryLeft;
      this.historyRight = nextHistoryRight;
      this.writePosition = 0;
      this.historyFrames = 0;
      this.loopCrossfadeFrames = Math.min(
        Math.max(1, Math.floor(this.loopLength / 4)),
        Math.max(1, Math.min(
          Math.round(this.sampleRate * MAX_LOOP_SEAM_MS / 1e3),
          Math.floor(this.loopLength * 0.01)
        ))
      );
      this.loopPhase = this.loopCrossfadeFrames;
      this.frozenBufferActive = true;
    }
    writeHistory(left, right) {
      this.historyLeft[this.writePosition] = left;
      this.historyRight[this.writePosition] = right;
      this.writePosition += 1;
      if (this.writePosition >= this.maxCaptureFrames) this.writePosition = 0;
      if (this.historyFrames < this.maxCaptureFrames) this.historyFrames += 1;
    }
    readFrozenChannel(buffer) {
      const seamStart = this.loopLength - this.loopCrossfadeFrames;
      if (this.loopPhase + this.playbackRate >= seamStart) {
        const seamPosition = clamp19(
          (this.loopPhase - seamStart + this.playbackRate) / this.loopCrossfadeFrames,
          0,
          1
        );
        const oldGain = 1 - seamPosition;
        const newGain = seamPosition;
        const outgoing = this.readLoopPosition(buffer, this.loopPhase);
        const incoming = this.readLoopPosition(buffer, clamp19(this.loopPhase - seamStart, 0, this.loopCrossfadeFrames));
        return finiteSample(outgoing * oldGain + incoming * newGain);
      }
      return this.readLoopPosition(buffer, this.loopPhase);
    }
    readLoopPosition(buffer, position) {
      const bounded3 = clamp19(position, 0, this.loopLength - 1);
      const firstFrame = Math.floor(bounded3);
      const secondFrame = Math.min(firstFrame + 1, this.loopLength - 1);
      const fraction = bounded3 - firstFrame;
      const firstIndex = (this.loopStart + firstFrame) % this.maxCaptureFrames;
      const secondIndex = (this.loopStart + secondFrame) % this.maxCaptureFrames;
      const firstSample = buffer[firstIndex] ?? 0;
      const secondSample = buffer[secondIndex] ?? 0;
      return firstSample + (secondSample - firstSample) * fraction;
    }
    advanceLoop() {
      this.loopPhase += this.playbackRate;
      if (this.loopPhase >= this.loopLength) {
        this.loopPhase -= this.loopLength - this.loopCrossfadeFrames;
      }
    }
    framesForCapture(milliseconds) {
      return clamp19(Math.round(this.sampleRate * milliseconds / 1e3), 1, this.maxCaptureFrames);
    }
    wrapHistoryIndex(index) {
      let wrapped = index % this.maxCaptureFrames;
      if (wrapped < 0) wrapped += this.maxCaptureFrames;
      return wrapped;
    }
    moveToward(value, target, amount) {
      if (value < target) return target - value <= amount ? target : value + amount;
      if (value > target) return value - target <= amount ? target : value - amount;
      return value;
    }
  };

  // src/audio/fx/dsp/BrowserWarpDsp.ts
  var MIN_SAMPLE_RATE10 = 8e3;
  var MAX_SAMPLE_RATE10 = 192e3;
  var MIN_BPM2 = 30;
  var MAX_BPM2 = 300;
  var CAPTURE_BEATS = [0.25, 0.5, 1, 2, 4];
  var MAX_CAPTURE_SECONDS2 = 8;
  var GRAIN_COUNT = 8;
  var WINDOW_TABLE_SIZE = 1024;
  var GRAIN_WINDOW_MS = 160;
  var MAX_FEEDBACK2 = 0.8;
  var MAX_SAMPLE = 8;
  var TWO_PI9 = Math.PI * 2;
  var FDN_DELAY_SECONDS2 = [0.0297, 0.0371, 0.0411, 0.0533, 0.0617, 0.0719, 0.0797, 0.0893];
  var BPM = 0;
  var CAPTURE = 1;
  var SMEAR = 2;
  var PITCH2 = 3;
  var FEEDBACK4 = 4;
  function clamp20(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function finiteBounded7(value) {
    return Number.isFinite(value) ? clamp20(value, -MAX_SAMPLE, MAX_SAMPLE) : 0;
  }
  function quantizeBeats(value) {
    let chosen = CAPTURE_BEATS[0];
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
  var BrowserWarpDsp = class {
    sampleRate;
    maxCaptureFrames;
    wetLeft = 0;
    wetRight = 0;
    framesProcessed = 0;
    captureCount = 0;
    banks;
    window;
    ageFrames = new Int32Array(GRAIN_COUNT);
    lengthFrames = new Int32Array(GRAIN_COUNT);
    readPositions = new Float64Array(GRAIN_COUNT);
    readSteps = new Float64Array(GRAIN_COUNT);
    fdnLines;
    fdnWrite = new Uint32Array(8);
    fdnDamping = new Float64Array(8);
    fdnRead = new Float64Array(8);
    fdnTransform = new Float64Array(8);
    hadamard = new Int8Array(64);
    current = new Float64Array(5);
    target = new Float64Array(5);
    parameterAlpha;
    dampingAlpha;
    writerBank = 0;
    writerPosition = 0;
    validFrames = 0;
    frozenBank = -1;
    frozenStart = 0;
    frozenLength = 0;
    freezeRequested = false;
    freezePending = false;
    freezeActive = false;
    spawnPhase = 1;
    nextVoice = 0;
    randomState = 1463898704;
    lastFdnLeft = 0;
    lastFdnRight = 0;
    constructor(sampleRate = 48e3, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) ? clamp20(sampleRate, MIN_SAMPLE_RATE10, MAX_SAMPLE_RATE10) : 48e3;
      this.maxCaptureFrames = Math.ceil(this.sampleRate * MAX_CAPTURE_SECONDS2);
      const makeBank = () => [
        new Float32Array(this.maxCaptureFrames),
        new Float32Array(this.maxCaptureFrames)
      ];
      this.banks = [makeBank(), makeBank()];
      this.window = new Float32Array(WINDOW_TABLE_SIZE + 1);
      for (let index = 0; index <= WINDOW_TABLE_SIZE; index += 1) {
        this.window[index] = 0.5 - 0.5 * Math.cos(TWO_PI9 * index / WINDOW_TABLE_SIZE);
      }
      this.fdnLines = FDN_DELAY_SECONDS2.map((seconds) => new Float32Array(
        Math.max(1, Math.round(seconds * this.sampleRate))
      ));
      for (let row = 0; row < 8; row += 1) {
        for (let column = 0; column < 8; column += 1) {
          let parity = 0;
          let bits = row & column;
          while (bits !== 0) {
            parity ^= bits & 1;
            bits >>>= 1;
          }
          this.hadamard[row * 8 + column] = parity === 0 ? 1 : -1;
        }
      }
      this.parameterAlpha = 1 - Math.exp(-1 / (0.015 * this.sampleRate));
      this.dampingAlpha = 1 - Math.exp(-TWO_PI9 * 6500 / this.sampleRate);
      const bpm = Number.isFinite(parameters.bpm) ? clamp20(parameters.bpm, MIN_BPM2, MAX_BPM2) : 120;
      const capture = Number.isFinite(parameters.captureBeats) ? quantizeBeats(parameters.captureBeats) : 1;
      const smear = Number.isFinite(parameters.smearPercent) ? clamp20(parameters.smearPercent, 0, 100) : 30;
      const pitch = Number.isFinite(parameters.pitchSemitones) ? clamp20(parameters.pitchSemitones, -24, 24) : 0;
      const feedback = Number.isFinite(parameters.feedbackPercent) ? clamp20(parameters.feedbackPercent, 0, 95) : 20;
      this.current.set([bpm, capture, smear, pitch, feedback]);
      this.target.set(this.current);
      this.setParameters(parameters);
    }
    get isFrozen() {
      return this.freezeActive;
    }
    get hasPendingFreeze() {
      return this.freezePending;
    }
    get activeCaptureFrames() {
      return this.frozenLength;
    }
    setParameters(parameters) {
      if (Number.isFinite(parameters.bpm)) this.target[BPM] = clamp20(parameters.bpm, MIN_BPM2, MAX_BPM2);
      if (Number.isFinite(parameters.captureBeats)) this.target[CAPTURE] = quantizeBeats(parameters.captureBeats);
      if (Number.isFinite(parameters.smearPercent)) this.target[SMEAR] = clamp20(parameters.smearPercent, 0, 100);
      if (Number.isFinite(parameters.pitchSemitones)) this.target[PITCH2] = clamp20(parameters.pitchSemitones, -24, 24);
      if (Number.isFinite(parameters.feedbackPercent)) this.target[FEEDBACK4] = clamp20(parameters.feedbackPercent, 0, 95);
      if (typeof parameters.frozen === "boolean" && parameters.frozen !== this.freezeRequested) {
        this.freezeRequested = parameters.frozen;
        if (this.freezeRequested && !this.freezeActive) this.freezePending = true;
        if (!this.freezeRequested) this.releaseCapture();
      }
    }
    processSample(inputLeft, inputRight) {
      for (let index = 0; index < this.current.length; index += 1) {
        this.current[index] = (this.current[index] ?? 0) + this.parameterAlpha * ((this.target[index] ?? 0) - (this.current[index] ?? 0));
      }
      const left = finiteBounded7(inputLeft);
      const right = finiteBounded7(inputRight);
      const feedback = Math.min(MAX_FEEDBACK2, (this.current[FEEDBACK4] ?? 20) * 0.01);
      const bank = this.banks[this.writerBank];
      bank[0][this.writerPosition] = finiteBounded7(left + feedback * this.lastFdnLeft);
      bank[1][this.writerPosition] = finiteBounded7(right + feedback * this.lastFdnRight);
      this.writerPosition = (this.writerPosition + 1) % this.maxCaptureFrames;
      this.validFrames = Math.min(this.validFrames + 1, this.maxCaptureFrames);
      if (this.freezePending) this.tryCapture();
      const smear = clamp20(this.current[SMEAR] ?? 30, 0, 100) * 0.01;
      const density = 6 + smear * 34;
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
        const windowPosition = age / (length - 1) * WINDOW_TABLE_SIZE;
        const tableIndex = Math.min(WINDOW_TABLE_SIZE - 1, Math.floor(windowPosition));
        const fraction = windowPosition - tableIndex;
        const envelope = (this.window[tableIndex] ?? 0) + ((this.window[tableIndex + 1] ?? 0) - (this.window[tableIndex] ?? 0)) * fraction;
        const position = this.readPositions[voice] ?? 0;
        const source = this.freezeActive ? this.frozenBank : this.writerBank;
        const sourceLeft = this.readSource(this.banks[source][0], position);
        const sourceRight = this.readSource(this.banks[source][1], position);
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
      this.wetLeft = finiteBounded7(grainLeft + this.lastFdnLeft);
      this.wetRight = finiteBounded7(grainRight + this.lastFdnRight);
      this.framesProcessed += 1;
    }
    processBlock(inputLeft, inputRight, outputLeft, outputRight) {
      const frames = Math.min(inputLeft.length, inputRight.length, outputLeft.length, outputRight.length);
      for (let frame = 0; frame < frames; frame += 1) {
        this.processSample(inputLeft[frame] ?? 0, inputRight[frame] ?? 0);
        outputLeft[frame] = this.wetLeft;
        outputRight[frame] = this.wetRight;
      }
    }
    reset() {
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
      this.randomState = 1463898704;
      this.lastFdnLeft = 0;
      this.lastFdnRight = 0;
      this.wetLeft = 0;
      this.wetRight = 0;
      this.framesProcessed = 0;
      this.captureCount = 0;
    }
    captureFramesForCurrentTempo() {
      const framesPerBeat = this.sampleRate * 60 / clamp20(this.current[BPM] ?? 120, MIN_BPM2, MAX_BPM2);
      return Math.max(32, Math.min(this.maxCaptureFrames, Math.round(framesPerBeat * (this.current[CAPTURE] ?? 1))));
    }
    tryCapture() {
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
    releaseCapture() {
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
    spawnGrain(smear) {
      const voice = this.nextVoice;
      this.nextVoice = (voice + 1) % GRAIN_COUNT;
      this.lengthFrames[voice] = 0;
      this.ageFrames[voice] = 0;
      const beatFrames = this.sampleRate * 60 / clamp20(this.current[BPM] ?? 120, MIN_BPM2, MAX_BPM2);
      const captureLength = this.freezeActive ? this.frozenLength : Math.max(32, this.validFrames);
      const length = Math.max(32, Math.min(
        Math.round(this.sampleRate * GRAIN_WINDOW_MS * 1e-3),
        Math.round(beatFrames * (this.current[CAPTURE] ?? 0.5) / 4),
        captureLength
      ));
      const pitchJitter = this.nextRandomSigned() * smear * 4;
      const pitch = clamp20((this.current[PITCH2] ?? 0) + pitchJitter, -24, 24);
      const step = 2 ** (pitch / 12);
      const jitterFrames = Math.round(smear * length * 0.25 * this.nextRandomSigned());
      let position;
      if (this.freezeActive && this.frozenLength > 0) {
        const offset = this.nextRandomUnit() * Math.max(1, this.frozenLength - length);
        position = this.frozenStart + offset + jitterFrames;
        position = this.frozenStart + this.wrap(position - this.frozenStart, this.frozenLength);
      } else {
        const age = Math.min(this.maxCaptureFrames - 4, Math.max(4, Math.ceil(length * Math.max(1, step)) + Math.abs(jitterFrames) + 4));
        if (this.validFrames < age) return;
        position = this.wrap(this.writerPosition - age + jitterFrames, this.maxCaptureFrames);
      }
      this.readPositions[voice] = position;
      this.readSteps[voice] = step;
      this.ageFrames[voice] = 0;
      this.lengthFrames[voice] = length;
    }
    processFdn(inputLeft, inputRight, feedback) {
      const scale = 0.3535533905932738;
      for (let lineIndex = 0; lineIndex < 8; lineIndex += 1) {
        const line = this.fdnLines[lineIndex];
        const index = this.fdnWrite[lineIndex] ?? 0;
        const delayed = line[index] ?? 0;
        const damped = (this.fdnDamping[lineIndex] ?? 0) + this.dampingAlpha * (delayed - (this.fdnDamping[lineIndex] ?? 0));
        this.fdnDamping[lineIndex] = Number.isFinite(damped) ? damped : 0;
        this.fdnRead[lineIndex] = this.fdnDamping[lineIndex] ?? 0;
      }
      for (let row = 0; row < 8; row += 1) {
        let sum = 0;
        for (let column = 0; column < 8; column += 1) {
          sum += (this.hadamard[row * 8 + column] ?? 1) * (this.fdnRead[column] ?? 0);
        }
        this.fdnTransform[row] = sum * scale;
      }
      const feedbackGain = Math.min(MAX_FEEDBACK2, feedback);
      for (let lineIndex = 0; lineIndex < 8; lineIndex += 1) {
        const line = this.fdnLines[lineIndex];
        const injection = lineIndex < 4 ? inputLeft * 0.25 : inputRight * 0.25;
        const value = finiteBounded7(injection + (this.fdnTransform[lineIndex] ?? 0) * feedbackGain);
        const index = this.fdnWrite[lineIndex] ?? 0;
        line[index] = value;
        this.fdnWrite[lineIndex] = (index + 1) % line.length;
      }
      this.lastFdnLeft = finiteBounded7(((this.fdnRead[0] ?? 0) + (this.fdnRead[1] ?? 0) + (this.fdnRead[2] ?? 0) + (this.fdnRead[3] ?? 0)) * 0.5);
      this.lastFdnRight = finiteBounded7(((this.fdnRead[4] ?? 0) + (this.fdnRead[5] ?? 0) + (this.fdnRead[6] ?? 0) + (this.fdnRead[7] ?? 0)) * 0.5);
    }
    readSource(buffer, position) {
      const base = Math.floor(position);
      const fraction = position - base;
      const a = buffer[this.readIndex(base - 1, buffer.length)] ?? 0;
      const b = buffer[this.readIndex(base, buffer.length)] ?? 0;
      const c = buffer[this.readIndex(base + 1, buffer.length)] ?? 0;
      const d = buffer[this.readIndex(base + 2, buffer.length)] ?? 0;
      return b + 0.5 * fraction * (c - a) + fraction * fraction * (a - 2.5 * b + 2 * c - 0.5 * d) + 0.5 * fraction * fraction * fraction * (d - a + 3 * (b - c));
    }
    readIndex(index, capacity) {
      let wrapped = this.wrap(index, capacity);
      if (this.freezeActive && this.frozenLength > 0) {
        wrapped = this.wrap(this.frozenStart + this.wrap(wrapped - this.frozenStart, this.frozenLength), capacity);
      }
      return wrapped;
    }
    nextRandom() {
      let value = this.randomState;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      this.randomState = value >>> 0;
      return this.randomState;
    }
    nextRandomUnit() {
      return this.nextRandom() / 4294967296;
    }
    nextRandomSigned() {
      return this.nextRandomUnit() * 2 - 1;
    }
    wrap(value, length) {
      if (length <= 0) return 0;
      const wrapped = value % length;
      return wrapped < 0 ? wrapped + length : wrapped;
    }
  };

  // src/audio/fx/dsp/BrowserElectricDsp.ts
  var DEFAULT_CHARACTER = 0;
  var DEFAULT_PITCH_SNAP_PERCENT = 50;
  var DEFAULT_TONE_HZ3 = 5e3;
  var MAX_INPUT = 8;
  var MAX_OUTPUT2 = 4;
  var RING_CARRIER_RATIO = Math.SQRT2;
  var TONE_UPDATE_INTERVAL = 16;
  function clamp21(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }
  function bounded2(value, fallback, minimum, maximum) {
    return Number.isFinite(value) ? clamp21(value, minimum, maximum) : fallback;
  }
  var BrowserElectricDsp = class _BrowserElectricDsp {
    sampleRate;
    voice;
    vocoder;
    bitCrusher;
    toneHz;
    toneLeft;
    toneRight;
    characterValue;
    toneCountdown = 0;
    carrierPhase = 0;
    outputLeftValue = 0;
    outputRightValue = 0;
    constructor(sampleRate, parameters = {}) {
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.characterValue = _BrowserElectricDsp.validateCharacter(parameters.character ?? DEFAULT_CHARACTER);
      const pitchSnap = bounded2(parameters.pitchSnapPercent ?? DEFAULT_PITCH_SNAP_PERCENT, DEFAULT_PITCH_SNAP_PERCENT, 0, 100);
      const tone = bounded2(parameters.toneHz ?? DEFAULT_TONE_HZ3, DEFAULT_TONE_HZ3, 100, 16e3);
      const safeTone = Math.min(tone, this.sampleRate * 0.45);
      this.toneHz = new LinearParameterSmoother(safeTone);
      this.toneLeft = new TptStateVariableFilter(this.sampleRate, safeTone, Math.SQRT1_2);
      this.toneRight = new TptStateVariableFilter(this.sampleRate, safeTone, Math.SQRT1_2);
      this.voice = new BrowserSynthDsp(this.sampleRate, {
        sensitivity: 75,
        waveform: 0,
        octave: 0,
        tone: safeTone,
        mix: 100,
        pitchSnapPercent: pitchSnap,
        subMixPercent: 0
      });
      this.vocoder = new BrowserVocoderCore(this.sampleRate, { bands: 16, carrier: 1 });
      this.bitCrusher = new LoFiDsp(this.sampleRate, {
        bitDepth: 7,
        sampleRateHz: Math.min(8e3, this.sampleRate),
        filterHz: safeTone
      });
    }
    get outputLeft() {
      return this.outputLeftValue;
    }
    get outputRight() {
      return this.outputRightValue;
    }
    get character() {
      return this.characterValue;
    }
    get pitchSnapPercent() {
      return this.voice.targetPitchSnapPercent;
    }
    get detectedFrequencyHz() {
      return this.voice.detectedFrequencyHz;
    }
    get targetPitchHz() {
      return this.voice.targetPitchHz;
    }
    get isVoiced() {
      return this.voice.isVoiced;
    }
    get detectorConfidence() {
      return this.voice.detectorConfidence;
    }
    /** Classic and Metallic need an accepted F0; those paths fail dry until voiced. */
    get requiresVoicedInput() {
      return this.characterValue === 0 || this.characterValue === 1;
    }
    setParameters(parameters) {
      if (parameters.character !== void 0) {
        this.characterValue = _BrowserElectricDsp.validateCharacter(parameters.character);
      }
      const rampFrames = Math.max(1, Math.round(this.sampleRate * 0.02));
      if (Number.isFinite(parameters.pitchSnapPercent)) {
        this.voice.setParameters({ pitchSnapPercent: bounded2(parameters.pitchSnapPercent, DEFAULT_PITCH_SNAP_PERCENT, 0, 100) });
      }
      if (Number.isFinite(parameters.toneHz)) {
        const nextTone = Math.min(bounded2(parameters.toneHz, DEFAULT_TONE_HZ3, 100, 16e3), this.sampleRate * 0.45);
        this.toneHz.setTarget(nextTone, rampFrames);
        this.voice.setParameters({ tone: nextTone });
        this.bitCrusher.setParameters({ filterHz: nextTone }, rampFrames);
      }
    }
    processSample(inputLeft, inputRight) {
      const left = Number.isFinite(inputLeft) ? clamp21(inputLeft, -MAX_INPUT, MAX_INPUT) : 0;
      const right = Number.isFinite(inputRight) ? clamp21(inputRight, -MAX_INPUT, MAX_INPUT) : 0;
      const mono = (left + right) * 0.5;
      this.voice.processSample(left, right);
      const voiced = this.voice.isVoiced;
      const voiceLeft = this.voice.outputLeft;
      const voiceRight = this.voice.outputRight;
      const voiceMono = (voiceLeft + voiceRight) * 0.5;
      let wetLeft;
      let wetRight;
      switch (this.characterValue) {
        case 0:
          wetLeft = voiceLeft;
          wetRight = voiceRight;
          break;
        case 1: {
          const fundamental = this.voice.targetPitchHz;
          const carrierHz = clamp21(fundamental * RING_CARRIER_RATIO, 0, this.sampleRate * 0.45);
          const step = carrierHz / this.sampleRate;
          const carrier = Math.sin(2 * Math.PI * this.carrierPhase);
          this.carrierPhase += step;
          if (this.carrierPhase >= 1) this.carrierPhase -= Math.floor(this.carrierPhase);
          wetLeft = left * carrier * 1.8;
          wetRight = right * carrier * 1.8;
          break;
        }
        case 2: {
          let output;
          if (voiced) {
            output = this.vocoder.processWithCarrier(mono, voiceMono);
          } else {
            this.vocoder.processSample(mono, mono);
            output = this.vocoder.outputLeft;
          }
          wetLeft = output;
          wetRight = output;
          break;
        }
        case 3:
          this.bitCrusher.process(voiced ? voiceLeft : left, voiced ? voiceRight : right);
          wetLeft = this.bitCrusher.wetLeft;
          wetRight = this.bitCrusher.wetRight;
          break;
      }
      const tone = this.toneHz.next();
      if (this.toneCountdown <= 0) {
        const cutoff = clamp21(tone, 100, this.sampleRate * 0.45);
        this.toneLeft.setParameters(cutoff, Math.SQRT1_2);
        this.toneRight.setParameters(cutoff, Math.SQRT1_2);
        this.toneCountdown = TONE_UPDATE_INTERVAL - 1;
      } else {
        this.toneCountdown -= 1;
      }
      const filteredLeft = this.toneLeft.processSample(wetLeft);
      const filteredRight = this.toneRight.processSample(wetRight);
      this.outputLeftValue = Number.isFinite(filteredLeft) ? clamp21(filteredLeft, -MAX_OUTPUT2, MAX_OUTPUT2) : 0;
      this.outputRightValue = Number.isFinite(filteredRight) ? clamp21(filteredRight, -MAX_OUTPUT2, MAX_OUTPUT2) : 0;
    }
    reset() {
      this.voice.reset();
      this.vocoder.reset();
      this.bitCrusher.reset();
      this.toneLeft.reset();
      this.toneRight.reset();
      this.toneHz.reset();
      this.toneCountdown = 0;
      this.carrierPhase = 0;
      this.outputLeftValue = 0;
      this.outputRightValue = 0;
    }
    static validateCharacter(value) {
      if (!Number.isInteger(value) || value < 0 || value > 3) {
        throw new RangeError("Browser ELECTRIC character must be an integer from 0 to 3.");
      }
      return value;
    }
  };

  // src/audio/fx/dsp/BrowserFxDspCore.ts
  var BROWSER_FX_ALGORITHM_INFO = {
    lpf: {
      catalogFunction: "LPF (catalog ID 1)",
      formulaIds: ["F01", "F03"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Supplied formula contract plus the repository TptStateVariableFilter primitive; no Roland source or code."
    },
    bpf: {
      catalogFunction: "BPF (catalog ID 2)",
      formulaIds: ["F01", "F03"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Supplied formula contract plus the repository TptStateVariableFilter primitive; no Roland source or code."
    },
    hpf: {
      catalogFunction: "HPF (catalog ID 3)",
      formulaIds: ["F01", "F03"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Supplied formula contract plus the repository TptStateVariableFilter primitive; no Roland source or code."
    },
    "ring-mod": {
      catalogFunction: "RING.MOD (catalog ID 9)",
      formulaIds: ["F01", "F06", "F29"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Supplied report F29 sine-carrier equation with a sine default and selectable, harmonic-limited triangle wavetable; no Roland source or code. Triangle alias/quality acceptance remains open."
    },
    distortion: {
      catalogFunction: "DIST (catalog ID 24)",
      formulaIds: ["F01", "F07"],
      algorithmicLatencySamples: 16,
      cleanRoomProvenance: "Clean-room tanh/hard-clip/asymmetric ADAA curves inside 4x Blackman-windowed sinc FIR interpolation/decimation; no Roland source, WDF model, or external DSP code."
    },
    preamp: {
      catalogFunction: "PREAMP (catalog ID 23)",
      formulaIds: ["F02", "F07", "F18", "F23"],
      algorithmicLatencySamples: 16,
      impulseResponsePeakSamplesAt48k: 18,
      supportsDryWetMix: false,
      cleanRoomProvenance: "Clean-room 2x Blackman-windowed sinc oversampling with antiderivative anti-aliased asymmetric soft clipping, smoothed three-band tone stack and authored analytic causal/minimum-phase-style 129-tap cabinet response. The oversampling pair contributes 16 fixed samples; cabinet phase moves the full impulse peak to sample 18 at 48 kHz with default controls. PREAMP has no wet/dry control, so dry-path alignment is not part of its contract. Amp styles and cabinet voicing are provisional; no Roland source, measured IR, or code."
    },
    synth: {
      catalogFunction: "SYNTH (catalog ID 6)",
      formulaIds: ["F03", "F06", "F10", "F27"],
      algorithmicLatencySamples: 2868,
      supportsDryWetMix: false,
      cleanRoomProvenance: "Clean-room decimated YIN-style monophonic F0 analysis, onset/envelope following, polyBLEP saw/square and integrated triangle, fixed octave-down sub voice, and TPT state-variable filter. At 48 kHz the lowest 55 Hz note needs a ~54.8 ms analysis frame plus one 5 ms hop and two-frame voiced confirmation (about 59.8 ms before synthesized attack); no original Roland source, code, or hardware behavior is claimed."
    },
    g2b: {
      catalogFunction: "G2B (catalog ID 10)",
      formulaIds: ["F09", "F10", "F11"],
      algorithmicLatencySamples: 2868,
      cleanRoomProvenance: "Clean-room decimated YIN-style mono F0 analysis, fixed -12 semitone square/polyBLEP resynthesis and TPT-SVF body cutoff; a user blend control crossfades resynthesized bass with input. No TD-PSOLA, original hardware topology/source/code, or quality acceptance; at 48 kHz a 55 Hz source needs about 60 ms for acquisition before smoothing."
    },
    vocoder: {
      catalogFunction: "VOCODER (catalog source #20)",
      formulaIds: ["F01", "F03", "F13"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room ERB-spaced 8\u201324 band TPT analysis/resynthesis bank with bounded attack/release envelope followers and polyBLEP saw/square internal carriers. Formant shift is explicitly unsupported; no Roland source, code, or sound-quality acceptance."
    },
    electric: {
      catalogFunction: "ELECTRIC (catalog source ID 17)",
      formulaIds: ["F03", "F09", "F10", "F13", "F28", "F29"],
      algorithmicLatencySamples: 2868,
      cleanRoomProvenance: "Clean-room four-path character bank: decimated YIN/polyBLEP quantized resynthesis, pitch-tracked sine ring modulation, reusable ERB/TPT vocoder, and Lo-Fi sample-rate-hold/quantization with a TPT tone low-pass. Voiced Classic/Metallic paths fail dry until pitch acquisition; controls and topology are provisional perceptual inferences with no Roland source, firmware, topology, or sound-quality acceptance claim."
    },
    "osc-voc": {
      catalogFunction: "OSC VOC (M) (catalog source #21)",
      formulaIds: ["F03", "F06", "F13", "F20"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room mono MIDI carrier uses polyBLEP saw/square/pulse through the same ERB analysis/envelope and per-band carrier filterbank as VOCODER and OSC BOT; fixed 16-band default and bounded 256-event sample-frame scheduler. No Roland source/code, stereo-unison, or sound-quality acceptance is claimed."
    },
    "osc-bot": {
      catalogFunction: "OSC BOT (catalog source #22)",
      formulaIds: ["F03", "F06", "F13", "F20", "F27"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room 16-band-default ERB carrier bank reuses the VOCODER analysis/envelope and per-band carrier filters, with polyBLEP saw/square and integrated BLEP-triangle oscillators, eight authored semitone sequences at a sample-clocked sixteenth-note cadence, and a resonant TPT low-pass. Patterns/topology are perceptual reconstructions; no Roland source/code or sound-quality acceptance is claimed."
    },
    flanger: {
      catalogFunction: "FLANGER (catalog ID 5)",
      formulaIds: ["F01", "F05", "F06", "F14"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room 4-point Lagrange modulated delay, sine LFO, one-pole feedback damping and tanh feedback limiter from supplied functional formulas; no Roland source or code."
    },
    dynamics: {
      catalogFunction: "DYNAMICS (catalog ID 25)",
      formulaIds: ["F01", "F08"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room stereo-linked peak/RMS compressor with attack/release detection and the supplied F08 logarithmic soft-knee curve; no lookahead, Roland source or code."
    },
    sustainer: {
      catalogFunction: "SUSTAINER (catalog ID 11)",
      formulaIds: ["F01", "F08"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room stereo-linked peak envelope, threshold-relative upward/downward compression, hysteretic noise gate and bounded no-lookahead safety limiter; 2 ms attack and gate thresholds/times are provisional authored laws, with no Roland source or code."
    },
    delay: {
      catalogFunction: "DELAY (catalog ID 36)",
      formulaIds: ["F01", "F05", "F14", "F20"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room stereo circular buffer with four-point Lagrange fractional reads, smoothed time, one-pole feedback damping and tanh-limited feedback from supplied functional formulas; no Roland source or code."
    },
    "mod-delay": {
      catalogFunction: "MOD DELAY (catalog ID 39)",
      formulaIds: ["F01", "F05", "F06", "F14"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room long stereo fractional delay with smoothed LFO-modulated four-point Lagrange reads, filtered contractive feedback and bounded saturation; parameters are provisional and no Roland source or code is used."
    },
    "panning-delay": {
      catalogFunction: "PANNING DELAY (FX #37)",
      formulaIds: ["F05", "F14", "F20", "F21"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room two-line cross-feedback delay with four-point Lagrange reads and equal-power repeat panning; matrix and pan interpretation are authored because the catalog gives only functional behavior; no Roland source or code."
    },
    chorus: {
      catalogFunction: "CHORUS (catalog ID 46)",
      formulaIds: ["F01", "F05", "F06", "F21"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room two-voice stereo modulated fractional delay (four-point Lagrange) with phase-decorrelated LFOs and filtered, bounded feedback from supplied functional formulas; no Roland source or code."
    },
    phaser: {
      catalogFunction: "PHASER (catalog ID 4)",
      formulaIds: ["F01", "F04", "F06"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room four/eight-stage first-order all-pass cascade with stereo-quadrature sinusoidal coefficient sweep and bounded feedback from supplied functional formulas; no BI-PHASE mode, Roland source or code."
    },
    tremolo: {
      catalogFunction: "TREMOLO (catalog ID 32)",
      formulaIds: ["F01", "F06"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room smoothed amplitude modulation with sine, triangle and polyBLEP band-limited square LFO shapes from supplied functional formulas; no tempo sync, Roland source or code."
    },
    "auto-pan": {
      catalogFunction: "AUTO PAN (catalog ID 29)",
      formulaIds: ["F01", "F06", "F21"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room equal-power mono panner and stereo mid/side autopan driven by smoothed sine, triangle or polyBLEP band-limited square LFO; no tempo sync, Roland source or code."
    },
    reverb: {
      catalogFunction: "REVERB (catalog ID 47)",
      formulaIds: ["F01", "F17"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Supplied contract F17 with a normalized Householder FDN8 and authored sparse early-reflection FIR; no factory IR, Roland source, or code."
    },
    "gate-reverb": {
      catalogFunction: "GATE REVERB (catalog ID 48)",
      formulaIds: ["F01", "F08", "F17"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room normalized FDN8 reverb return with an input-sidechain stereo-linked peak gate, threshold hysteresis, hold and bounded release; gate law is provisional, with no Roland source or code."
    },
    "beat-repeat": {
      catalogFunction: "BEAT REPEAT (catalog ID 51)",
      formulaIds: ["F15", "F20", "F25"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room sample-clock capture/retrigger in bounded dual stereo buffers with authored equal-power loop crossfades; no Roland source or code."
    },
    "beat-scatter": {
      catalogFunction: "BEAT SCATTER (catalog ID 50)",
      formulaIds: ["F05", "F09", "F15", "F20", "F25"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room two-buffer tempo-slice capture with deterministic PRNG-ordered quantized grains, bounded linear pitch resampling and a short authored read-head transition; slice latency is intentional, with no Roland source or code."
    },
    roll: {
      catalogFunction: "ROLL (catalog ID 44)",
      formulaIds: ["F05", "F15", "F20", "F25"],
      algorithmicLatencySamples: 12e3,
      cleanRoomProvenance: "Clean-room sample-clocked stereo dual-buffer slice capture/retrigger with bounded four-point fractional playback-rate resampling, decay and direction controls. The default 0.5-beat slice is 12,000 reference samples at 48 kHz / 120 BPM; pitch changes playback rate and slice duration. Capture latency is intentional; no Roland source/code or sound-quality acceptance."
    },
    freeze: {
      catalogFunction: "FREEZE (catalog ID 45)",
      formulaIds: ["F12", "F19", "F25"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room bounded stereo micro-loop snapshot with a rolling pre-capture history, equal-power activation transition, linear seam overlap and varispeed loop playback. Spectral STFT mode is explicitly unsupported; captured audio is volatile and resets on reload. A complete history window is needed at startup or after reconfiguration, but there is no fixed pipeline latency. Pitch changes loop duration. It uses no Roland source/code and has no sound-quality acceptance."
    },
    warp: {
      catalogFunction: "WARP (catalog source ID 42)",
      formulaIds: ["F12", "F15", "F17", "F19", "F20"],
      algorithmicLatencySamples: 0,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental lower-tier clean-room tempo-sized stereo capture, bounded Hann-windowed granular pitch-smear reader and normalized Hadamard FDN8. The spectral mode is unavailable; startup/freeze waits for the selected capture window and is intentional rather than a fixed pipeline delay. Catalog topology is explicitly an authored perceptual inference, with no Roland source, code, fidelity, or sound-quality acceptance claim."
    },
    "beat-shift": {
      catalogFunction: "BEAT SHIFT (catalog source ID 52)",
      formulaIds: ["F20", "F25"],
      algorithmicLatencySamples: 72e3,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental prototype; not quality-accepted as the contract FX. Clean-room shared stereo postmix buffer with a signed beat-offset read head and equal-power transition crossfades. Supporting live advances up to +4 beats requires a four-beat look-ahead baseline: offset 0 adds four beats of delay at the active BPM, while the provisional default +1 beat adds three beats (72,000 reference samples at 48 kHz / 120 BPM). Actual latency scales with sample rate, BPM and signed offset; the shared postmix path therefore adds multi-beat live output latency. Effect output uses only the shifted head; there is no independently time-aligned dry mix. Positive=toward FUTURE and negative=toward PAST are authored app conventions; the Roland/BOSS guide only confirms FUTURE/PAST and beat-length shift. No per-loop-track targeting; no Roland DSP source or code. Proper loop-playback read-head integration remains an implementation gap."
    },
    "reverse-delay": {
      catalogFunction: "REVERSE DELAY (catalog ID 38)",
      formulaIds: ["F14", "F20", "F25"],
      algorithmicLatencySamples: 24e3,
      cleanRoomProvenance: "Clean-room alternating fixed stereo segments, beat-quantized timing, backward reads and equal-power crossfades; the default one-beat segment is fully captured before playback. Latency scales with BPM, segment length and sample rate; no Roland source or code."
    },
    "reverse-reverb": {
      catalogFunction: "REVERSE REVERB (catalog ID 49)",
      formulaIds: ["F17", "F18", "F25"],
      algorithmicLatencySamples: 12e3,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental clean-room prototype: beat-quantized stereo segments are read backward into an independent eight-line-per-channel FDN16 tail with one-pole damping and equal-power source-segment overlaps. Default 0.5-beat capture at 120 BPM contributes 250 ms of buffering pre-delay; actual segment latency scales with BPM, segment size and sample rate. FDN tail and quality remain provisional; no measured IR, factory-firmware topology, Roland source/code, or sound-quality acceptance is claimed."
    },
    "vinyl-flick": {
      catalogFunction: "VINYL FLICK (catalog source ID 53)",
      formulaIds: ["F05", "F09", "F26"],
      algorithmicLatencySamples: 2,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental clean-room second-order platter-speed model with a fixed 4-second stereo ring and four-point Lagrange variable-rate resampler; two samples of matched dry/wet lookahead plus periodic 10 ms phase-slip crossfades keep sustained slow/stalled reads audible. Because this is a causal live-stream insert, >1x targets are transient and clamp at available input; sustained >1x requires a source-aware read-ahead path. Controls and response are provisional, not quality-accepted; no Roland source or code."
    },
    "pattern-slicer": {
      catalogFunction: "PATTERN SLICER (catalog source ID 34)",
      formulaIds: ["F16", "F20"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Sample-clocked, authored 16-step gate tables with tempo-selected step intervals and raised-cosine edge smoothing from the supplied functional description; presets and ranges are provisional, with no Roland source or code."
    },
    "step-slicer": {
      catalogFunction: "STEP SLICER (catalog source ID 35)",
      formulaIds: ["F01", "F16", "F20", "F21"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room sample-clocked 16-value amplitude sequence with a 2 ms raised-cosine step transition, optional alternating stereo balance and one-pole low-pass; provisional authored controls, no Roland source or code."
    },
    "stereo-enhance": {
      catalogFunction: "STEREO ENHANCE (catalog ID 31)",
      formulaIds: ["F01", "F04", "F22"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room mid/side width with low-frequency side attenuation, two stable first-order all-pass decorrelators and a width-only polarity safety limiter; no Roland source or code."
    },
    "lo-fi": {
      catalogFunction: "LO-FI (catalog ID 7)",
      formulaIds: ["F28"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room fractional sample-rate hold with deterministic TPDF dithered quantization and one-pole post-filter; no Roland source or code."
    },
    eq: {
      catalogFunction: "EQ (catalog ID 26)",
      formulaIds: ["F01", "F02"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room cascade of low/high RBJ shelves and two RBJ peaking biquads with coefficient ramps; no Roland source or code."
    },
    "manual-pan": {
      catalogFunction: "MANUAL PAN (catalog ID 30)",
      formulaIds: ["F01", "F21"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room static equal-power mono pan and smoothed stereo balance; no Roland source or code."
    },
    "tape-echo": {
      catalogFunction: "TAPE ECHO (catalog ID 40)",
      formulaIds: ["F02", "F05", "F06", "F07", "F14", "F20"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room three-head Lagrange tape delay, wow/flutter modulation, 2x ADAA record saturation, filtered hiss, frequency-dependent loss and contractive feedback; no Roland source or code; head delay is intentional."
    },
    twist: {
      catalogFunction: "TWIST (catalog source ID 43)",
      formulaIds: ["F01", "F03", "F05", "F06", "F07", "F14", "F21"],
      algorithmicLatencySamples: 0,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Clean-room signed macro curve drives a stereo four-point Lagrange variable-rate delay, contractive saturated feedback, one-pole tone and stereo balance. Amount automation creates the pitch trajectory; the four curve laws and parameter ranges are provisional because the referenced matrix is not present in this checkout. This prototype has no Roland source, code, or hardware-fidelity claim."
    },
    "granular-delay": {
      catalogFunction: "GRANULAR DELAY (catalog ID 41)",
      formulaIds: ["F05", "F09", "F15", "F20"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room stereo Hann-windowed, fixed-pool granular resampling with four-point Lagrange history reads, deterministic position jitter and contractive feedback; no Roland source or code."
    },
    radio: {
      catalogFunction: "RADIO (catalog ID 8)",
      formulaIds: ["F02", "F07", "F28"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room TPT AM-narrow/AM-wide/FM band limits, midpoint 2x ADAA tanh saturation, deterministic colored noise and stochastic dropout; controls and noise character are authored provisional choices, with no Roland source or code."
    },
    vibrato: {
      catalogFunction: "VIBRATO (catalog ID 33)",
      formulaIds: ["F01", "F05", "F06"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room wet-only stereo modulated delay with four-point Lagrange reads, sine LFO, smoothed rate/depth/base delay and an authored quadrature channel offset; no Roland source or code."
    },
    "slow-gear": {
      catalogFunction: "SLOW GEAR (catalog ID 13)",
      formulaIds: ["F01", "F27"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room short-window energy onset detector with an adaptive inactive baseline and a raised-cosine attack ramp; attack is intentional, with no fixed pipeline samples or Roland source/code."
    },
    isolator: {
      catalogFunction: "ISOLATOR (three-band crossover and rhythm gate)",
      formulaIds: ["F01", "F03", "F16", "F20"],
      algorithmicLatencySamples: 0,
      cleanRoomProvenance: "Clean-room LR4-style TPT crossover, residual mid band, smoothed gains and sample-clocked BPM-following gate; gate phase is local/free-running, with no Roland source or code."
    },
    "auto-riff": {
      catalogFunction: "AUTO RIFF (catalog ID 12)",
      formulaIds: ["F09", "F10", "F11", "F16", "F20"],
      algorithmicLatencySamples: 0,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental sample-clocked onset/F0 analyzer with a bounded YIN tracker and authored eight-step scale sequence, driving the separately pinned Signalsmith LIVE_FX shifter in the host. Detector and onset performance require a representative pitch/latency/aliasing admission suite; no Roland source, code, or sound-quality acceptance is claimed."
    },
    "hrm-auto": {
      catalogFunction: "HRM AUTO (M) (catalog ID 19)",
      formulaIds: ["F09", "F10", "F11"],
      algorithmicLatencySamples: 0,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental sample-clocked monophonic YIN analysis and bounded MIDI chord/scale target assignment driving separately pinned Signalsmith LIVE_FX shifters in the host. Polyphonic source tracking, voice-leading semantics, tuning and quality acceptance remain unverified; no Roland source, code or sound-quality acceptance is claimed."
    },
    robot: {
      catalogFunction: "ROBOT (catalog ID 16)",
      formulaIds: ["F09", "F10", "F11", "F12"],
      algorithmicLatencySamples: 0,
      implementationStatus: "experimental",
      cleanRoomProvenance: "Experimental sample-clocked monophonic decimated-YIN tracking and semitone target quantization driving a separately pinned Signalsmith LIVE_FX shifter in the host. Polyphonic and unvoiced pitch tracking are unsupported; vendor formant compensation is enabled and anchored to tracked source F0, with zero shift expressing preserve intent and nonzero shift expressing independent envelope movement. Quality acceptance remains unverified; total acquisition/shifter latency requires measurement and no Roland source or firmware semantics are asserted."
    }
  };
  var TWO_PI10 = Math.PI * 2;
  var DEFAULT_SMOOTHING_SECONDS = 0.015;
  var FILTER_RESONANCE_PERCENT_CURVE_EXPONENT = 2.117350426267045;
  function filterResonancePercentToQ(percent) {
    const normalized = clamp22(percent, 0, 100) / 100;
    if (normalized === 0.15) return Math.SQRT1_2;
    return 0.5 + 11.5 * normalized ** FILTER_RESONANCE_PERCENT_CURVE_EXPONENT;
  }
  var RING_MOD_WAVETABLE_SIZE = 2048;
  var RING_MOD_TRIANGLE_HARMONIC_TIERS = [63, 31, 15, 7, 3, 1];
  function createRingModTriangleTables() {
    return RING_MOD_TRIANGLE_HARMONIC_TIERS.map((maximumHarmonic) => {
      const table = new Float64Array(RING_MOD_WAVETABLE_SIZE);
      for (let sample = 0; sample < table.length; sample += 1) {
        const phase = TWO_PI10 * sample / table.length;
        let value = 0;
        for (let harmonic = 1; harmonic <= maximumHarmonic; harmonic += 2) {
          const alternating = (harmonic - 1) / 2 % 2 === 0 ? 1 : -1;
          value += alternating * Math.sin(harmonic * phase) / (harmonic * harmonic);
        }
        table[sample] = value;
      }
      let peak = 0;
      for (let sample = 0; sample < table.length; sample += 1) peak = Math.max(peak, Math.abs(table[sample] ?? 0));
      if (peak > 0) for (let sample = 0; sample < table.length; sample += 1) table[sample] = (table[sample] ?? 0) / peak;
      return table;
    });
  }
  var RING_MOD_TRIANGLE_TABLES = createRingModTriangleTables();
  var DEFAULT_DELAY_SECONDS = [0.0297, 0.0335, 0.0361, 0.0397, 0.0431, 0.0473, 0.0527, 0.0579];
  var EARLY_REFLECTION_DELAYS_SECONDS = [0, 67e-4, 0.0113, 0.0169, 0.0227, 0.0289, 0.0341];
  var EARLY_REFLECTION_GAINS_LEFT = [0.13, 0.068, -0.047, 0.035, -0.026, 0.021, -0.014];
  var EARLY_REFLECTION_GAINS_RIGHT = [0.13, -0.061, 0.052, -0.032, 0.024, -0.019, 0.016];
  var HOUSEHOLDER_ROW_SUM_FACTOR = 2 / 8;
  var FDN_INJECTION_GAIN = 0.18 / Math.sqrt(8);
  var FDN_OUTPUT_GAIN = 0.72 / Math.sqrt(8);
  var EARLY_OUTPUT_GAIN = 0.65;
  var MIN_STATE_MAGNITUDE = 1e-24;
  var FDN_MODULATION_DEPTH_SAMPLES = 0.35;
  var DISTORTION_OVERSAMPLE_FACTOR = 4;
  var DISTORTION_FIR_TAPS = 65;
  var DISTORTION_UPSAMPLE_INPUT_HISTORY = Math.ceil(DISTORTION_FIR_TAPS / DISTORTION_OVERSAMPLE_FACTOR);
  var DISTORTION_INTERPOLATION_TAPS_BY_PHASE = [
    DISTORTION_UPSAMPLE_INPUT_HISTORY,
    DISTORTION_UPSAMPLE_INPUT_HISTORY - 1,
    DISTORTION_UPSAMPLE_INPUT_HISTORY - 1,
    DISTORTION_UPSAMPLE_INPUT_HISTORY - 1
  ];
  var DISTORTION_FIR_CENTER = (DISTORTION_FIR_TAPS - 1) / 2;
  var DISTORTION_CUTOFF_CYCLES_PER_OVERSAMPLE_SAMPLE = 0.117;
  var DISTORTION_MODE_CROSSFADE_OVERSAMPLED_SAMPLES = 256;
  var DISTORTION_DRY_DELAY_SAMPLES = 16;
  var DISTORTION_BIAS = 0.12;
  var FUZZ_SHARPNESS = 2.2;
  var FUZZ_BIAS_TANH = Math.tanh(FUZZ_SHARPNESS * DISTORTION_BIAS);
  var FLANGER_MAX_DELAY_MILLISECONDS = 10;
  var FLANGER_MIN_DELAY_MILLISECONDS = 0.2;
  var FLANGER_MAX_DEPTH_MILLISECONDS = 5;
  var FLANGER_DEFAULT_DELAY_MILLISECONDS = 3;
  var FLANGER_DEFAULT_RATE_HZ = 0.3;
  var FLANGER_DEFAULT_DEPTH = 0.6;
  var FLANGER_DEFAULT_FEEDBACK = 0.25;
  var FLANGER_FEEDBACK_FILTER_HZ = 6e3;
  var DYNAMICS_DEFAULT_THRESHOLD_DB = -18;
  var DYNAMICS_DEFAULT_RATIO = 4;
  var DYNAMICS_DEFAULT_KNEE_DB = 6;
  var DYNAMICS_DEFAULT_ATTACK_MS = 10;
  var DYNAMICS_DEFAULT_RELEASE_MS = 120;
  var DYNAMICS_ENVELOPE_FLOOR = 1e-9;
  var GATE_REVERB_DEFAULT_THRESHOLD_DB = -24;
  var GATE_REVERB_DEFAULT_HOLD_MS = 250;
  var GATE_REVERB_DEFAULT_RELEASE_MS = 150;
  var GATE_REVERB_DETECTOR_RELEASE_MS = 8;
  var GATE_REVERB_HYSTERESIS_RATIO = 0.7071067811865476;
  var GATE_REVERB_RELEASE_DB = 60;
  var DELAY_MAX_TIME_MILLISECONDS = 2e3;
  var DELAY_MIN_TIME_MILLISECONDS = 1;
  var DELAY_DEFAULT_TIME_MILLISECONDS = 500;
  var DELAY_DEFAULT_FEEDBACK = 0.3;
  var DELAY_DEFAULT_TONE_HZ = 8e3;
  var DELAY_DEFAULT_MIX = 0.25;
  var CHORUS_MIN_DELAY_MILLISECONDS = 5;
  var CHORUS_MAX_DELAY_MILLISECONDS = 30;
  var CHORUS_DEFAULT_DELAY_MILLISECONDS = 15;
  var CHORUS_DEFAULT_RATE_HZ = 0.8;
  var CHORUS_DEFAULT_DEPTH_MILLISECONDS = 5;
  var CHORUS_DEFAULT_VOICES = 2;
  var CHORUS_DEFAULT_FEEDBACK = 0;
  var CHORUS_DEFAULT_TONE_HZ = 8e3;
  var CHORUS_FEEDBACK_MAX = 0.5;
  var PHASER_DEFAULT_RATE_HZ = 0.5;
  var PHASER_DEFAULT_DEPTH = 0.65;
  var PHASER_DEFAULT_FEEDBACK = 0.2;
  var PHASER_DEFAULT_STAGES = 8;
  var PHASER_FEEDBACK_MAX = 0.95;
  var PHASER_MIN_FREQUENCY_HZ = 120;
  var PHASER_MAX_FREQUENCY_HZ = 3e3;
  var PHASER_FEEDBACK_FILTER_HZ = 7e3;
  var PHASER_MAX_STAGES = 8;
  var TREMOLO_DEFAULT_RATE_HZ = 4;
  var TREMOLO_DEFAULT_DEPTH = 0.5;
  var TREMOLO_MIN_RATE_HZ = 0.05;
  var TREMOLO_MAX_RATE_HZ = 20;
  var AUTO_PAN_DEFAULT_RATE_HZ = 0.5;
  var AUTO_PAN_DEFAULT_DEPTH = 0.7;
  function sinc2(value) {
    if (Math.abs(value) < 1e-12) return 1;
    const angle = Math.PI * value;
    return Math.sin(angle) / angle;
  }
  function createDistortionFilters() {
    const interpolation = new Float64Array(DISTORTION_FIR_TAPS);
    let coefficientSum = 0;
    for (let tap = 0; tap < DISTORTION_FIR_TAPS; tap += 1) {
      const centered = tap - DISTORTION_FIR_CENTER;
      const normalized = tap / (DISTORTION_FIR_TAPS - 1);
      const blackman = 0.42 - 0.5 * Math.cos(TWO_PI10 * normalized) + 0.08 * Math.cos(2 * TWO_PI10 * normalized);
      const coefficient = DISTORTION_OVERSAMPLE_FACTOR * 2 * DISTORTION_CUTOFF_CYCLES_PER_OVERSAMPLE_SAMPLE * sinc2(2 * DISTORTION_CUTOFF_CYCLES_PER_OVERSAMPLE_SAMPLE * centered) * blackman;
      interpolation[tap] = coefficient;
      coefficientSum += coefficient;
    }
    const normalization = DISTORTION_OVERSAMPLE_FACTOR / coefficientSum;
    const decimation = new Float64Array(DISTORTION_FIR_TAPS);
    for (let tap = 0; tap < DISTORTION_FIR_TAPS; tap += 1) {
      interpolation[tap] = (interpolation[tap] ?? 0) * normalization;
      decimation[tap] = (interpolation[tap] ?? 0) / DISTORTION_OVERSAMPLE_FACTOR;
    }
    return { interpolation, decimation };
  }
  var DISTORTION_FILTERS = createDistortionFilters();
  function logCosh3(value) {
    const absolute = Math.abs(value);
    return absolute + Math.log1p(Math.exp(-2 * absolute)) - Math.LN2;
  }
  function distortionFunction(mode, value) {
    switch (mode) {
      case "hard-clip":
        return clamp22(value, -1, 1);
      case "fuzz":
        return Math.tanh(FUZZ_SHARPNESS * (value + DISTORTION_BIAS)) - FUZZ_BIAS_TANH;
      case "overdrive":
        return Math.tanh(value);
    }
  }
  function distortionAntiderivative(mode, value) {
    switch (mode) {
      case "hard-clip": {
        const absolute = Math.abs(value);
        return absolute <= 1 ? 0.5 * value * value : absolute - 0.5;
      }
      case "fuzz":
        return logCosh3(FUZZ_SHARPNESS * (value + DISTORTION_BIAS)) / FUZZ_SHARPNESS - value * FUZZ_BIAS_TANH;
      case "overdrive":
        return logCosh3(value);
    }
  }
  function antiderivativeAntialiasSample(mode, current, previous) {
    const difference = current - previous;
    if (Math.abs(difference) < 1e-8) return distortionFunction(mode, 0.5 * (current + previous));
    return (distortionAntiderivative(mode, current) - distortionAntiderivative(mode, previous)) / difference;
  }
  function isDistortionMode(value) {
    return value === "overdrive" || value === "hard-clip" || value === "fuzz";
  }
  var ExponentialParameterSmoother = class {
    current;
    target;
    oneMinusAlpha;
    settled = false;
    constructor(sampleRate, initialValue, smoothingSeconds = DEFAULT_SMOOTHING_SECONDS) {
      this.current = initialValue;
      this.target = initialValue;
      this.oneMinusAlpha = 1 - Math.exp(-1 / (sampleRate * smoothingSeconds));
    }
    get isSettled() {
      return this.settled;
    }
    setTarget(value) {
      if (!Object.is(this.target, value)) {
        this.target = value;
        this.settled = false;
      }
    }
    next() {
      if (this.settled) return this.current;
      const previous = this.current;
      this.current += (this.target - this.current) * this.oneMinusAlpha;
      if (Object.is(this.current, previous)) this.settled = true;
      return this.current;
    }
  };
  function clamp22(value, minimum, maximum) {
    if (value !== 0 && value >= minimum && value <= maximum) return value;
    return Math.max(minimum, Math.min(maximum, value));
  }
  function validateBrowserVocoderParameters(parameters) {
    const supported = ["mix", "vocoderBands", "vocoderCarrier"];
    for (const key of Object.keys(parameters)) {
      if (!supported.includes(key)) {
        throw new RangeError(key === "formant" || key === "vocoderFormantSemitones" ? "Browser VOCODER formant shifting is unsupported; no formant remapping is applied." : `Browser VOCODER does not support the ${key} parameter.`);
      }
    }
    if (parameters.mix !== void 0 && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
      throw new RangeError("Browser VOCODER mix must be between 0 and 1.");
    }
    if (parameters.vocoderBands !== void 0 && (!Number.isInteger(parameters.vocoderBands) || parameters.vocoderBands < 8 || parameters.vocoderBands > 24)) {
      throw new RangeError("Browser VOCODER bands must be an integer from 8 to 24.");
    }
    if (parameters.vocoderCarrier !== void 0 && (!Number.isInteger(parameters.vocoderCarrier) || parameters.vocoderCarrier < 0 || parameters.vocoderCarrier > 2)) {
      throw new RangeError("Browser VOCODER carrier must be 0 (voice input), 1 (saw), or 2 (square).");
    }
  }
  function validateBrowserElectricParameters(parameters) {
    const supported = ["mix", "electricCharacter", "electricPitchSnapPercent", "electricToneHz"];
    for (const key of Object.keys(parameters)) {
      if (!supported.includes(key)) {
        throw new RangeError(`Browser ELECTRIC does not support the ${key} parameter.`);
      }
    }
    if (parameters.mix !== void 0 && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
      throw new RangeError("Browser ELECTRIC mix must be between 0 and 1.");
    }
    if (parameters.electricCharacter !== void 0 && (!Number.isInteger(parameters.electricCharacter) || parameters.electricCharacter < 0 || parameters.electricCharacter > 3)) {
      throw new RangeError("Browser ELECTRIC character must be an integer from 0 to 3.");
    }
    if (parameters.electricPitchSnapPercent !== void 0 && (!Number.isFinite(parameters.electricPitchSnapPercent) || parameters.electricPitchSnapPercent < 0 || parameters.electricPitchSnapPercent > 100)) {
      throw new RangeError("Browser ELECTRIC pitch snap must be from 0 to 100 percent.");
    }
    if (parameters.electricToneHz !== void 0 && (!Number.isFinite(parameters.electricToneHz) || parameters.electricToneHz < 100 || parameters.electricToneHz > 16e3)) {
      throw new RangeError("Browser ELECTRIC tone cutoff must be from 100 to 16000 Hz.");
    }
  }
  function validateBrowserOscBotParameters(parameters, sampleRate) {
    const supported = ["mix", "oscBotWaveform", "oscBotPattern", "oscBotToneHz", "bpm"];
    for (const key of Object.keys(parameters)) {
      if (!supported.includes(key)) {
        throw new RangeError(`Browser OSC BOT does not support the ${key} parameter.`);
      }
    }
    if (parameters.mix !== void 0 && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
      throw new RangeError("Browser OSC BOT mix must be between 0 and 1.");
    }
    if (parameters.oscBotWaveform !== void 0 && (!Number.isInteger(parameters.oscBotWaveform) || parameters.oscBotWaveform < 0 || parameters.oscBotWaveform > 2)) {
      throw new RangeError("Browser OSC BOT waveform must be 0 (saw), 1 (square), or 2 (triangle).");
    }
    if (parameters.oscBotPattern !== void 0 && (!Number.isInteger(parameters.oscBotPattern) || parameters.oscBotPattern < 0 || parameters.oscBotPattern > 7)) {
      throw new RangeError("Browser OSC BOT pattern must be an integer from 0 to 7.");
    }
    if (parameters.oscBotToneHz !== void 0 && (!Number.isFinite(parameters.oscBotToneHz) || parameters.oscBotToneHz < 100 || parameters.oscBotToneHz > 16e3 || parameters.oscBotToneHz >= sampleRate * 0.49)) {
      throw new RangeError("Browser OSC BOT tone cutoff must be from 100 to 16000 Hz and below 0.49 of sample rate.");
    }
    if (parameters.bpm !== void 0 && (!Number.isFinite(parameters.bpm) || parameters.bpm < 30 || parameters.bpm > 300)) {
      throw new RangeError("Browser OSC BOT tempo must be from 30 to 300 BPM.");
    }
  }
  function validateBrowserOscVocParameters(parameters) {
    const supported = ["mix", "oscVocWaveform", "oscVocMidiChannel", "oscVocOctave", "oscVocBands"];
    for (const key of Object.keys(parameters)) {
      if (!supported.includes(key)) throw new RangeError(`Browser OSC VOC (M) does not support the ${key} parameter.`);
    }
    if (parameters.mix !== void 0 && (!Number.isFinite(parameters.mix) || parameters.mix < 0 || parameters.mix > 1)) {
      throw new RangeError("Browser OSC VOC (M) mix must be between 0 and 1.");
    }
    if (parameters.oscVocWaveform !== void 0 && (!Number.isInteger(parameters.oscVocWaveform) || parameters.oscVocWaveform < 0 || parameters.oscVocWaveform > 2)) {
      throw new RangeError("Browser OSC VOC (M) waveform must be 0 (saw), 1 (square), or 2 (pulse).");
    }
    if (parameters.oscVocMidiChannel !== void 0 && (!Number.isInteger(parameters.oscVocMidiChannel) || parameters.oscVocMidiChannel < 1 || parameters.oscVocMidiChannel > 16)) {
      throw new RangeError("Browser OSC VOC (M) MIDI channel must be an integer from 1 to 16.");
    }
    if (parameters.oscVocOctave !== void 0 && (!Number.isFinite(parameters.oscVocOctave) || parameters.oscVocOctave < -24 || parameters.oscVocOctave > 24)) {
      throw new RangeError("Browser OSC VOC (M) octave transpose must be from -24 to 24 semitones.");
    }
    if (parameters.oscVocBands !== void 0 && (!Number.isInteger(parameters.oscVocBands) || parameters.oscVocBands < 8 || parameters.oscVocBands > 24)) {
      throw new RangeError("Browser OSC VOC (M) bands must be an integer from 8 to 24.");
    }
  }
  function isTremoloWaveform(value) {
    return value === "sine" || value === "triangle" || value === "square";
  }
  function firstOrderAllpassCoefficient(frequencyHz, sampleRate) {
    const frequency = clamp22(frequencyHz, 20, sampleRate * 0.45);
    const tangent = Math.tan(Math.PI * frequency / sampleRate);
    return clamp22((tangent - 1) / (tangent + 1), -0.9995, 0.9995);
  }
  function polyBlep4(phase, phaseStep) {
    if (phase < phaseStep) {
      const scaled = phase / phaseStep;
      return scaled + scaled - scaled * scaled - 1;
    }
    if (phase > 1 - phaseStep) {
      const scaled = (phase - 1) / phaseStep;
      return scaled * scaled + scaled + scaled + 1;
    }
    return 0;
  }
  function readLagrangeFromWriteHead2(buffer, writeIndex, delaySamples) {
    const wholeDelay = Math.floor(delaySamples);
    const fraction = delaySamples - wholeDelay;
    const oneMinus = 1 - fraction;
    const coefficient0 = oneMinus * (2 - fraction) * (3 - fraction) / 6;
    const coefficient1 = fraction * (2 - fraction) * (3 - fraction) / 2;
    const coefficient2 = -(fraction * oneMinus * (3 - fraction)) / 2;
    const coefficient3 = fraction * oneMinus * (2 - fraction) / 6;
    const length = buffer.length;
    let index = writeIndex - wholeDelay;
    if (index < 0) index += length;
    const sample0 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample1 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample2 = buffer[index] ?? 0;
    index = index > 0 ? index - 1 : length - 1;
    const sample3 = buffer[index] ?? 0;
    return coefficient0 * sample0 + coefficient1 * sample1 + coefficient2 * sample2 + coefficient3 * sample3;
  }
  var BrowserFxDspCore = class {
    sampleRate;
    algorithm;
    get algorithmicLatencySamples() {
      if (this.algorithm === "distortion" || this.algorithm === "preamp") return DISTORTION_DRY_DELAY_SAMPLES;
      if (this.algorithm === "synth" || this.algorithm === "g2b" || this.algorithm === "electric") return 2868;
      if (this.algorithm === "beat-shift") return this.beatShift?.latencySamples ?? 0;
      if (this.algorithm === "reverse-delay") return this.reverseDelay?.latencySamples ?? 0;
      if (this.algorithm === "reverse-reverb") return this.reverseReverb?.latencySamples ?? 0;
      if (this.algorithm === "vinyl-flick") return this.vinylFlick?.algorithmicLatencySamples ?? 0;
      return 0;
    }
    blocksProcessed = 0;
    framesProcessed = 0;
    nonFiniteInputSamples = 0;
    nonFiniteOutputSamples = 0;
    filterLeft;
    filterRight;
    cutoff;
    q;
    wet;
    decaySeconds;
    dampingHz;
    gateThresholdDb;
    gateHoldMs;
    gateReleaseMs;
    gateDetectorEnvelope = 0;
    gateHoldRemainingSamples = 0;
    gateGain = 0;
    ringModHz;
    ringModDepth;
    ringModWaveform;
    driveDb;
    outputDb;
    flangerDelayMs;
    flangerRateHz;
    flangerDepth;
    flangerFeedback;
    dynamicsThreshold;
    dynamicsRatio;
    dynamicsKnee;
    dynamicsAttackMs;
    dynamicsReleaseMs;
    delayTimeMs;
    delayFeedback;
    delayToneHz;
    panningDelay;
    modDelay;
    chorusDelayMs;
    chorusRateHz;
    chorusDepthMs;
    chorusFeedback;
    chorusToneHz;
    phaserRateHz;
    phaserDepth;
    phaserFeedback;
    tremoloRateHz;
    tremoloDepth;
    tremoloWaveformOld;
    tremoloWaveformTarget;
    tremoloWaveformBlend = new LinearParameterSmoother(1);
    tremoloWaveformBlendValue = 1;
    autoPanRateHz;
    autoPanDepth;
    stereoWidth;
    stereoLowMonoCutoffHz;
    stereoDecorrelation;
    stereoLowpassState = 0;
    stereoAllpass1Input = 0;
    stereoAllpass1Output = 0;
    stereoAllpass2Input = 0;
    stereoAllpass2Output = 0;
    stereoLowpassAlpha = 0;
    stereoAllpass1Coefficient = 0;
    stereoAllpass2Coefficient = 0;
    stereoWetLeft = 0;
    stereoWetRight = 0;
    autoPanWaveformOld;
    autoPanWaveformTarget;
    autoPanWaveformBlend = new LinearParameterSmoother(1);
    autoPanWaveformBlendValue = 1;
    autoPanWetLeft = 0;
    autoPanWetRight = 0;
    bypassMix = new LinearParameterSmoother(0);
    // Cache the exact equal-power coefficients while mix/bypass controls are
    // stationary. Values are refreshed from the existing helpers whenever the
    // sample-position changes, so automation retains the original equations.
    cachedWetPosition = Number.NaN;
    cachedWetDryGain = 1;
    cachedWetGain = 0;
    cachedBypassPosition = Number.NaN;
    cachedBypassActiveGain = 1;
    cachedBypassGain = 0;
    distortionModeBlend = new LinearParameterSmoother(1);
    distortionModeOld;
    distortionModeTarget;
    driveLinear = 1;
    outputLinear = 1;
    // Duplicate each circular history so processDistortionSample can read a
    // contiguous window without a wrap branch for every FIR tap.
    upsampleHistory = new Float64Array(DISTORTION_UPSAMPLE_INPUT_HISTORY * 4);
    upsampleWriteIndices = new Int32Array(2);
    previousDrivenInput = new Float64Array(2);
    distortionPreviousPrimitive = new Float64Array(2);
    distortionPrimitiveValid = new Uint8Array(2);
    waveshapedHistory = new Float64Array(DISTORTION_FIR_TAPS * 4);
    waveshapedWriteIndices = new Int32Array(2);
    dryDelayBuffers = [
      new Float32Array(DISTORTION_DRY_DELAY_SAMPLES),
      new Float32Array(DISTORTION_DRY_DELAY_SAMPLES)
    ];
    dryDelayWriteIndices = new Int32Array(2);
    fdnBuffers;
    delayLengths;
    fdnWriteIndices;
    delayFeedbackGains;
    delayModPhases;
    delayModPhaseSteps;
    delayDampingStates;
    delayReadScratch;
    earlyBuffers;
    flangerBuffers;
    flangerWriteIndices;
    flangerPhases;
    flangerFeedbackStates;
    delayBuffers;
    delayWriteIndices;
    delayToneStates;
    delayToneAlpha = 1;
    chorusBuffers;
    chorusWriteIndices;
    chorusFeedbackStates;
    chorusToneAlpha = 1;
    chorusVoiceCount = CHORUS_DEFAULT_VOICES;
    chorusPhase = 0;
    chorusPhaseStep = 0;
    phaserInputStates;
    phaserOutputStates;
    phaserFeedbackStates;
    phaserToneAlpha = 1;
    phaserStageCount = PHASER_DEFAULT_STAGES;
    phaserPhase = 0;
    phaserPhaseStep = 0;
    tremoloPhase = 0;
    tremoloPhaseStep = 0;
    autoPanPhase = 0;
    autoPanPhaseStep = 0;
    dynamicsDetector;
    dynamicsPeakEnvelope = 0;
    dynamicsRmsMeanSquare = 0;
    dynamicsGain = 1;
    dynamicsAttackAlpha = 0;
    dynamicsReleaseAlpha = 0;
    earlyDelays;
    earlyWriteIndices = new Int32Array(2);
    dampingAlpha;
    currentControls;
    beatRepeat;
    roll;
    freeze;
    warp;
    beatScatter;
    beatShift;
    reverseDelay;
    reverseReverb;
    autoRiff;
    hrmAuto;
    robot;
    patternSlicer;
    stepSlicer;
    loFi;
    equalizer;
    tapeEcho;
    twist;
    granularDelay;
    radio;
    vibrato;
    sustainer;
    preamp;
    synth;
    g2b;
    vocoder;
    electric;
    oscVoc;
    oscBot;
    slowGear;
    isolator;
    vinylFlick;
    manualPanPosition;
    manualPanLeftTable;
    manualPanRightTable;
    manualPanWetLeft = 0;
    manualPanWetRight = 0;
    phase = 0;
    phaseStep = 0;
    dcBlockInput = new Float64Array(2);
    dcBlockOutput = new Float64Array(2);
    dcBlockCoefficient;
    flangerDampingAlpha;
    earlyRingLength;
    controlUpdateCountdown = 0;
    // `advanceControls` updates a fixed set of smoothed values every audio
    // sample. Once every smoother and waveform crossfade has reached its exact
    // terminal value, the values and their derived coefficients are immutable
    // until the next control message. A short scan cadence detects that state
    // without adding work to every sample; the coefficient refresh after the
    // final ramp is required before the fast path can become active.
    controlsSteady = false;
    controlSettleScanCountdown = 0;
    controlSmoothersSettled = false;
    // Test-only differential reference switch; production instances keep this
    // enabled and it never changes DSP parameters or audio state.
    settledControlFastPathEnabled = true;
    currentAudioFrame = 0;
    constructor(algorithm, sampleRate = 48e3, parameters = {}, initialFrame = 0) {
      if (algorithm === "vocoder") validateBrowserVocoderParameters(parameters);
      if (algorithm === "electric") validateBrowserElectricParameters(parameters);
      if (algorithm === "osc-voc") validateBrowserOscVocParameters(parameters);
      this.algorithm = algorithm;
      this.sampleRate = Number.isFinite(sampleRate) && sampleRate >= 8e3 ? sampleRate : 48e3;
      this.currentAudioFrame = Number.isSafeInteger(initialFrame) && initialFrame >= 0 ? Math.floor(initialFrame) : 0;
      const nyquist = this.sampleRate * 0.499;
      const initialCutoff = clamp22(parameters.cutoffHz ?? 1200, 20, nyquist);
      const mappedFilterResonance = (algorithm === "lpf" || algorithm === "hpf") && Number.isFinite(parameters.filterResonancePercent) ? filterResonancePercentToQ(parameters.filterResonancePercent) : void 0;
      const initialQ = clamp22(mappedFilterResonance ?? parameters.q ?? Math.SQRT1_2, 0.1, 30);
      if (algorithm === "osc-bot") validateBrowserOscBotParameters(parameters, this.sampleRate);
      const initialWet = clamp22(parameters.mix ?? (algorithm === "vocoder" || algorithm === "osc-voc" || algorithm === "osc-bot" || algorithm === "electric" ? 0.7 : algorithm === "delay" || algorithm === "panning-delay" || algorithm === "mod-delay" ? DELAY_DEFAULT_MIX : algorithm === "chorus" ? 0.4 : algorithm === "phaser" || algorithm === "beat-repeat" || algorithm === "beat-scatter" || algorithm === "roll" || algorithm === "twist" ? 0.5 : algorithm === "lo-fi" || algorithm === "radio" ? 0.7 : algorithm === "tape-echo" || algorithm === "gate-reverb" || algorithm === "reverse-delay" ? 0.3 : algorithm === "reverse-reverb" ? 0.35 : algorithm === "granular-delay" ? 0.35 : algorithm === "warp" ? 0.4 : 1), 0, 1);
      if (algorithm === "freeze" && Number.isFinite(parameters.freezeMode) && parameters.freezeMode !== 0) {
        throw new RangeError("Spectral FREEZE mode is unavailable; only micro-loop mode is wired.");
      }
      const initialDecay = clamp22(parameters.decaySeconds ?? (algorithm === "gate-reverb" || algorithm === "reverse-reverb" ? 2 : 2.4), 0.1, 20);
      const initialDamping = clamp22(parameters.dampingHz ?? 9e3, 200, nyquist);
      const initialGateThresholdDb = clamp22(parameters.gateThresholdDb ?? GATE_REVERB_DEFAULT_THRESHOLD_DB, -60, 0);
      const initialGateHoldMs = clamp22(parameters.gateHoldMs ?? GATE_REVERB_DEFAULT_HOLD_MS, 5, 2e3);
      const initialGateReleaseMs = clamp22(parameters.gateReleaseMs ?? GATE_REVERB_DEFAULT_RELEASE_MS, 10, 2e3);
      const initialRingModHz = clamp22(parameters.ringModHz ?? 440, 0, Math.min(8e3, this.sampleRate * 0.45));
      const initialRingModDepth = clamp22(parameters.ringModDepth ?? 1, 0, 1);
      const initialRingModWaveform = parameters.ringModWaveform === 1 ? 1 : 0;
      const initialDriveDb = clamp22(parameters.driveDb ?? 18, 0, 36);
      const initialOutputDb = clamp22(parameters.outputDb ?? 0, -24, 12);
      const initialDistortionMode = isDistortionMode(parameters.distortionMode) ? parameters.distortionMode : "overdrive";
      const initialFlangerDelayMs = clamp22(parameters.flangerDelayMs ?? FLANGER_DEFAULT_DELAY_MILLISECONDS, FLANGER_MIN_DELAY_MILLISECONDS, FLANGER_MAX_DELAY_MILLISECONDS);
      const initialFlangerRateHz = clamp22(parameters.flangerRateHz ?? FLANGER_DEFAULT_RATE_HZ, 0.05, 20);
      const initialFlangerDepth = clamp22(parameters.flangerDepth ?? FLANGER_DEFAULT_DEPTH, 0, 1);
      const initialFlangerFeedback = clamp22(parameters.flangerFeedback ?? FLANGER_DEFAULT_FEEDBACK, -0.95, 0.95);
      const initialThresholdDb = clamp22(parameters.thresholdDb ?? DYNAMICS_DEFAULT_THRESHOLD_DB, -60, 0);
      const initialRatio = clamp22(parameters.ratio ?? DYNAMICS_DEFAULT_RATIO, 1, 20);
      const initialKneeDb = clamp22(parameters.kneeDb ?? DYNAMICS_DEFAULT_KNEE_DB, 0, 24);
      const initialAttackMs = clamp22(parameters.attackMs ?? DYNAMICS_DEFAULT_ATTACK_MS, 0.1, 100);
      const initialReleaseMs = clamp22(parameters.releaseMs ?? DYNAMICS_DEFAULT_RELEASE_MS, 5, 1e3);
      const initialDelayTimeMs = clamp22(parameters.delayTimeMs ?? DELAY_DEFAULT_TIME_MILLISECONDS, DELAY_MIN_TIME_MILLISECONDS, DELAY_MAX_TIME_MILLISECONDS);
      const initialDelayFeedback = clamp22(parameters.delayFeedback ?? DELAY_DEFAULT_FEEDBACK, 0, 0.95);
      const initialDelayToneHz = clamp22(parameters.delayToneHz ?? DELAY_DEFAULT_TONE_HZ, 100, Math.min(16e3, nyquist));
      const initialChorusDelayMs = clamp22(parameters.chorusDelayMs ?? CHORUS_DEFAULT_DELAY_MILLISECONDS, CHORUS_MIN_DELAY_MILLISECONDS, CHORUS_MAX_DELAY_MILLISECONDS);
      const initialChorusRateHz = clamp22(parameters.chorusRateHz ?? CHORUS_DEFAULT_RATE_HZ, 0.05, 10);
      const initialChorusDepthMs = clamp22(parameters.chorusDepthMs ?? CHORUS_DEFAULT_DEPTH_MILLISECONDS, 0.2, 20);
      const initialChorusVoices = Math.round(clamp22(parameters.chorusVoices ?? CHORUS_DEFAULT_VOICES, 2, 4));
      const initialChorusFeedback = clamp22(parameters.chorusFeedback ?? CHORUS_DEFAULT_FEEDBACK, 0, CHORUS_FEEDBACK_MAX);
      const initialChorusToneHz = clamp22(parameters.chorusToneHz ?? CHORUS_DEFAULT_TONE_HZ, 100, Math.min(16e3, nyquist));
      const initialPhaserRateHz = clamp22(parameters.phaserRateHz ?? PHASER_DEFAULT_RATE_HZ, 0.05, 20);
      const initialPhaserDepth = clamp22(parameters.phaserDepth ?? PHASER_DEFAULT_DEPTH, 0, 1);
      const initialPhaserFeedback = clamp22(parameters.phaserFeedback ?? PHASER_DEFAULT_FEEDBACK, 0, PHASER_FEEDBACK_MAX);
      const initialPhaserStages = clamp22(parameters.phaserStages ?? PHASER_DEFAULT_STAGES, 4, PHASER_MAX_STAGES) < 6 ? 4 : 8;
      const initialTremoloRateHz = clamp22(parameters.tremoloRateHz ?? TREMOLO_DEFAULT_RATE_HZ, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ);
      const initialTremoloDepth = clamp22(parameters.tremoloDepth ?? TREMOLO_DEFAULT_DEPTH, 0, 1);
      const initialTremoloWaveform = isTremoloWaveform(parameters.tremoloWaveform) ? parameters.tremoloWaveform : "sine";
      const initialAutoPanRateHz = clamp22(parameters.autoPanRateHz ?? AUTO_PAN_DEFAULT_RATE_HZ, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ);
      const initialAutoPanDepth = clamp22(parameters.autoPanDepth ?? AUTO_PAN_DEFAULT_DEPTH, 0, 1);
      const initialStereoWidth = clamp22(parameters.stereoWidth ?? 1, 0, 2);
      const initialStereoLowMonoCutoffHz = clamp22(parameters.stereoLowMonoCutoffHz ?? 120, 20, Math.min(1e3, nyquist));
      const initialStereoDecorrelation = clamp22(parameters.stereoDecorrelation ?? 0.25, 0, 1);
      const initialAutoPanWaveform = isTremoloWaveform(parameters.autoPanWaveform) ? parameters.autoPanWaveform : "sine";
      this.tremoloWaveformOld = initialTremoloWaveform;
      this.tremoloWaveformTarget = initialTremoloWaveform;
      this.autoPanWaveformOld = initialAutoPanWaveform;
      this.autoPanWaveformTarget = initialAutoPanWaveform;
      this.dynamicsDetector = parameters.dynamicsDetector === "rms" ? "rms" : "peak";
      this.cutoff = new ExponentialParameterSmoother(this.sampleRate, initialCutoff);
      this.q = new ExponentialParameterSmoother(this.sampleRate, initialQ);
      this.wet = new ExponentialParameterSmoother(this.sampleRate, initialWet);
      this.decaySeconds = new ExponentialParameterSmoother(this.sampleRate, initialDecay);
      this.dampingHz = new ExponentialParameterSmoother(this.sampleRate, initialDamping);
      this.gateThresholdDb = new ExponentialParameterSmoother(this.sampleRate, initialGateThresholdDb);
      this.gateHoldMs = new ExponentialParameterSmoother(this.sampleRate, initialGateHoldMs);
      this.gateReleaseMs = new ExponentialParameterSmoother(this.sampleRate, initialGateReleaseMs);
      this.ringModHz = new ExponentialParameterSmoother(this.sampleRate, initialRingModHz);
      this.ringModDepth = new ExponentialParameterSmoother(this.sampleRate, initialRingModDepth);
      this.ringModWaveform = new ExponentialParameterSmoother(this.sampleRate, initialRingModWaveform, 0.02);
      this.driveDb = new ExponentialParameterSmoother(this.sampleRate, initialDriveDb);
      this.outputDb = new ExponentialParameterSmoother(this.sampleRate, initialOutputDb);
      this.flangerDelayMs = new ExponentialParameterSmoother(this.sampleRate, initialFlangerDelayMs);
      this.flangerRateHz = new ExponentialParameterSmoother(this.sampleRate, initialFlangerRateHz);
      this.flangerDepth = new ExponentialParameterSmoother(this.sampleRate, initialFlangerDepth);
      this.flangerFeedback = new ExponentialParameterSmoother(this.sampleRate, initialFlangerFeedback);
      this.dynamicsThreshold = new ExponentialParameterSmoother(this.sampleRate, initialThresholdDb);
      this.dynamicsRatio = new ExponentialParameterSmoother(this.sampleRate, initialRatio);
      this.dynamicsKnee = new ExponentialParameterSmoother(this.sampleRate, initialKneeDb);
      this.dynamicsAttackMs = new ExponentialParameterSmoother(this.sampleRate, initialAttackMs);
      this.dynamicsReleaseMs = new ExponentialParameterSmoother(this.sampleRate, initialReleaseMs);
      this.delayTimeMs = new ExponentialParameterSmoother(this.sampleRate, initialDelayTimeMs);
      this.delayFeedback = new ExponentialParameterSmoother(this.sampleRate, initialDelayFeedback);
      this.delayToneHz = new ExponentialParameterSmoother(this.sampleRate, initialDelayToneHz);
      this.chorusDelayMs = new ExponentialParameterSmoother(this.sampleRate, initialChorusDelayMs);
      this.chorusRateHz = new ExponentialParameterSmoother(this.sampleRate, initialChorusRateHz);
      this.chorusDepthMs = new ExponentialParameterSmoother(this.sampleRate, initialChorusDepthMs);
      this.chorusFeedback = new ExponentialParameterSmoother(this.sampleRate, initialChorusFeedback);
      this.chorusToneHz = new ExponentialParameterSmoother(this.sampleRate, initialChorusToneHz);
      this.phaserRateHz = new ExponentialParameterSmoother(this.sampleRate, initialPhaserRateHz);
      this.phaserDepth = new ExponentialParameterSmoother(this.sampleRate, initialPhaserDepth);
      this.phaserFeedback = new ExponentialParameterSmoother(this.sampleRate, initialPhaserFeedback);
      this.tremoloRateHz = new ExponentialParameterSmoother(this.sampleRate, initialTremoloRateHz);
      this.tremoloDepth = new ExponentialParameterSmoother(this.sampleRate, initialTremoloDepth);
      this.autoPanRateHz = new ExponentialParameterSmoother(this.sampleRate, initialAutoPanRateHz);
      this.autoPanDepth = new ExponentialParameterSmoother(this.sampleRate, initialAutoPanDepth);
      this.stereoWidth = new ExponentialParameterSmoother(this.sampleRate, initialStereoWidth);
      this.stereoLowMonoCutoffHz = new ExponentialParameterSmoother(this.sampleRate, initialStereoLowMonoCutoffHz);
      this.stereoDecorrelation = new ExponentialParameterSmoother(this.sampleRate, initialStereoDecorrelation);
      this.distortionModeOld = initialDistortionMode;
      this.distortionModeTarget = initialDistortionMode;
      this.driveLinear = Math.pow(10, initialDriveDb / 20);
      this.outputLinear = Math.pow(10, initialOutputDb / 20);
      this.filterLeft = new TptStateVariableFilter(this.sampleRate, initialCutoff, initialQ);
      this.filterRight = new TptStateVariableFilter(this.sampleRate, initialCutoff, initialQ);
      this.phaseStep = TWO_PI10 * initialRingModHz / this.sampleRate;
      this.dcBlockCoefficient = Math.exp(-TWO_PI10 * 10 / this.sampleRate);
      this.flangerDampingAlpha = 1 - Math.exp(-TWO_PI10 * FLANGER_FEEDBACK_FILTER_HZ / this.sampleRate);
      this.fdnBuffers = new Array(16);
      this.delayLengths = new Int32Array(16);
      this.fdnWriteIndices = new Int32Array(16);
      this.delayFeedbackGains = new Float64Array(16);
      this.delayModPhases = new Float64Array(16);
      this.delayModPhaseSteps = new Float64Array(16);
      this.delayDampingStates = new Float64Array(16);
      this.delayReadScratch = new Float64Array(16);
      this.dampingAlpha = new Float64Array(16);
      this.currentControls = new Float64Array(37);
      this.currentControls[0] = initialCutoff;
      this.currentControls[1] = initialQ;
      this.currentControls[2] = initialWet;
      this.currentControls[3] = initialDecay;
      this.currentControls[4] = initialDamping;
      this.currentControls[5] = initialRingModHz;
      this.currentControls[6] = initialRingModDepth;
      this.currentControls[36] = initialRingModWaveform;
      this.currentControls[7] = initialDriveDb;
      this.currentControls[8] = initialOutputDb;
      this.currentControls[9] = initialFlangerDelayMs;
      this.currentControls[10] = initialFlangerDepth;
      this.currentControls[11] = initialFlangerRateHz;
      this.currentControls[12] = initialFlangerFeedback;
      this.currentControls[13] = initialThresholdDb;
      this.currentControls[14] = initialRatio;
      this.currentControls[15] = initialKneeDb;
      this.currentControls[16] = initialAttackMs;
      this.currentControls[17] = initialReleaseMs;
      this.currentControls[18] = initialDelayTimeMs;
      this.currentControls[19] = initialDelayFeedback;
      this.currentControls[20] = initialDelayToneHz;
      this.currentControls[21] = initialChorusDelayMs;
      this.currentControls[22] = initialChorusRateHz;
      this.currentControls[23] = initialChorusDepthMs;
      this.currentControls[24] = initialChorusFeedback;
      this.currentControls[25] = initialChorusToneHz;
      this.currentControls[26] = initialPhaserRateHz;
      this.currentControls[27] = initialPhaserDepth;
      this.currentControls[28] = initialPhaserFeedback;
      this.currentControls[29] = initialTremoloRateHz;
      this.currentControls[30] = initialTremoloDepth;
      this.currentControls[31] = initialAutoPanRateHz;
      this.currentControls[32] = initialAutoPanDepth;
      this.currentControls[33] = initialStereoWidth;
      this.currentControls[34] = initialStereoLowMonoCutoffHz;
      this.currentControls[35] = initialStereoDecorrelation;
      this.beatRepeat = algorithm === "beat-repeat" ? new BeatRepeatDsp(this.sampleRate, parameters) : null;
      this.roll = algorithm === "roll" ? new BrowserRollDsp(this.sampleRate, {
        bpm: parameters.bpm,
        sliceBeats: parameters.rollSliceBeats,
        decayPercent: parameters.rollDecayPercent,
        pitchSemitones: parameters.rollPitchSemitones,
        direction: parameters.rollDirection === 1 ? "reverse" : parameters.rollDirection === 2 ? "alternate" : "forward"
      }) : null;
      this.freeze = algorithm === "freeze" ? new BrowserFreezeDsp(this.sampleRate, {
        captureLengthMs: parameters.freezeCaptureLengthMs,
        pitchSemitones: parameters.freezePitchSemitones,
        frozen: parameters.freezeEnabled === 1
      }) : null;
      this.warp = algorithm === "warp" ? new BrowserWarpDsp(this.sampleRate, {
        bpm: parameters.bpm,
        captureBeats: parameters.warpCaptureBeats,
        smearPercent: parameters.warpSmearPercent,
        pitchSemitones: parameters.warpPitchSemitones,
        feedbackPercent: parameters.warpFeedbackPercent,
        frozen: Number.isFinite(parameters.warpFreezeEnabled) ? parameters.warpFreezeEnabled >= 0.5 : void 0
      }) : null;
      this.beatScatter = algorithm === "beat-scatter" ? new BrowserBeatScatterDsp(this.sampleRate, {
        bpm: parameters.bpm,
        sliceBeats: parameters.beatScatterSliceBeats,
        scatterPercent: parameters.beatScatterScatterPercent,
        pitchSemitones: parameters.beatScatterPitchSemitones,
        repeats: parameters.beatScatterRepeats
      }) : null;
      this.beatShift = algorithm === "beat-shift" ? new BrowserBeatShiftDsp(this.sampleRate, {
        bpm: parameters.bpm,
        offsetBeats: parameters.beatShiftOffsetBeats,
        crossfadeMs: parameters.beatShiftCrossfadeMs
      }) : null;
      this.reverseDelay = algorithm === "reverse-delay" ? new BrowserReverseDelayDsp(this.sampleRate, {
        bpm: parameters.bpm,
        segmentBeats: parameters.reverseDelaySegmentBeats,
        feedback: parameters.reverseDelayFeedback,
        crossfadeMs: parameters.reverseDelayCrossfadeMs
      }) : null;
      this.reverseReverb = algorithm === "reverse-reverb" ? new BrowserReverseReverbDsp(this.sampleRate, {
        bpm: parameters.bpm,
        segmentBeats: parameters.reverseReverbSegmentBeats,
        feedbackPercent: parameters.reverseReverbFeedbackPercent,
        crossfadeMs: parameters.reverseReverbCrossfadeMs,
        decaySeconds: parameters.reverseReverbDecaySeconds ?? initialDecay,
        dampingCutoffHz: parameters.reverseReverbDampingCutoffHz
      }) : null;
      this.autoRiff = algorithm === "auto-riff" ? new BrowserAutoRiffDsp(this.sampleRate, {
        bpm: parameters.bpm,
        scale: parameters.autoRiffScale,
        beatStepRate: parameters.autoRiffRateBeats,
        onsetSensitivity: Number.isFinite(parameters.autoRiffSensitivityPercent) ? parameters.autoRiffSensitivityPercent / 100 : void 0
      }) : null;
      this.hrmAuto = algorithm === "hrm-auto" ? new BrowserHrmAutoDsp(this.sampleRate, {
        key: parameters.hrmAutoKey,
        scale: parameters.hrmAutoScale,
        midiChannel: parameters.hrmAutoMidiChannel,
        mix: parameters.hrmAutoMixPercent,
        voices: 2
      }) : null;
      this.robot = algorithm === "robot" ? new BrowserRobotDsp(this.sampleRate, { pitch: parameters.robotPitch }) : null;
      this.patternSlicer = algorithm === "pattern-slicer" ? new BrowserPatternSlicerDsp(this.sampleRate, {
        bpm: parameters.bpm,
        pattern: parameters.patternSlicerPattern,
        rateBeats: parameters.patternSlicerRateBeats,
        depthPercent: parameters.patternSlicerDepthPercent,
        edgeMs: parameters.patternSlicerEdgeMs
      }) : null;
      this.stepSlicer = algorithm === "step-slicer" ? new BrowserStepSlicerDsp(this.sampleRate, {
        bpm: parameters.bpm,
        stepCount: parameters.stepSlicerStepCount,
        rateBeats: parameters.stepSlicerRateBeats,
        depthPercent: parameters.stepSlicerDepthPercent,
        panDepthPercent: parameters.stepSlicerPanDepthPercent,
        filterHz: parameters.stepSlicerFilterHz,
        step01: parameters.stepSlicerStep01,
        step02: parameters.stepSlicerStep02,
        step03: parameters.stepSlicerStep03,
        step04: parameters.stepSlicerStep04,
        step05: parameters.stepSlicerStep05,
        step06: parameters.stepSlicerStep06,
        step07: parameters.stepSlicerStep07,
        step08: parameters.stepSlicerStep08,
        step09: parameters.stepSlicerStep09,
        step10: parameters.stepSlicerStep10,
        step11: parameters.stepSlicerStep11,
        step12: parameters.stepSlicerStep12,
        step13: parameters.stepSlicerStep13,
        step14: parameters.stepSlicerStep14,
        step15: parameters.stepSlicerStep15,
        step16: parameters.stepSlicerStep16
      }) : null;
      const loFiParameters = {
        bitDepth: parameters.loFiBitDepth,
        sampleRateHz: parameters.loFiSampleRateHz,
        filterHz: parameters.loFiFilterHz
      };
      this.loFi = algorithm === "lo-fi" ? new LoFiDsp(this.sampleRate, loFiParameters) : null;
      const equalizerParameters = {
        lowFrequencyHz: parameters.eqLowFrequencyHz,
        lowGainDb: parameters.eqLowGainDb,
        mid1FrequencyHz: parameters.eqMid1FrequencyHz,
        mid1Q: parameters.eqMid1Q,
        mid1GainDb: parameters.eqMid1GainDb,
        mid2FrequencyHz: parameters.eqMid2FrequencyHz,
        mid2Q: parameters.eqMid2Q,
        mid2GainDb: parameters.eqMid2GainDb,
        highFrequencyHz: parameters.eqHighFrequencyHz,
        highGainDb: parameters.eqHighGainDb
      };
      this.equalizer = algorithm === "eq" ? new EqualizerDsp(this.sampleRate, equalizerParameters) : null;
      this.tapeEcho = algorithm === "tape-echo" ? new BrowserTapeEchoDsp(this.sampleRate, {
        timeMs: parameters.tapeEchoTimeMs,
        feedback: parameters.tapeEchoFeedback,
        wow: parameters.tapeEchoWow,
        saturation: parameters.tapeEchoSaturation,
        toneHz: parameters.tapeEchoToneHz
      }) : null;
      this.twist = algorithm === "twist" ? new BrowserTwistDsp(this.sampleRate, {
        amount: parameters.twistAmount,
        trajectory: parameters.twistTrajectory
      }) : null;
      this.granularDelay = algorithm === "granular-delay" ? new BrowserGranularDelayDsp(this.sampleRate, {
        grainSizeMs: parameters.granularGrainSizeMs,
        densityHz: parameters.granularDensityHz,
        pitchSemitones: parameters.granularPitchSemitones,
        positionJitterPercent: parameters.granularPositionJitterPercent,
        feedbackPercent: parameters.granularFeedbackPercent
      }) : null;
      this.radio = algorithm === "radio" ? new BrowserRadioDsp(this.sampleRate, {
        band: parameters.radioBand,
        drive: parameters.radioDrive,
        noise: parameters.radioNoise
      }) : null;
      this.vibrato = algorithm === "vibrato" ? new BrowserVibratoDsp(this.sampleRate, {
        rateHz: parameters.vibratoRateHz,
        depthPercent: parameters.vibratoDepthPercent,
        delayMs: parameters.vibratoDelayMs
      }) : null;
      this.sustainer = algorithm === "sustainer" ? new BrowserSustainerDsp(this.sampleRate, {
        thresholdDb: parameters.thresholdDb,
        ratio: parameters.ratio,
        releaseMs: parameters.releaseMs,
        outputDb: parameters.outputDb
      }) : null;
      this.preamp = algorithm === "preamp" ? new BrowserPreampDsp(this.sampleRate, {
        model: parameters.preampModel,
        gainPercent: parameters.preampGainPercent,
        bassDb: parameters.preampBassDb,
        middleDb: parameters.preampMiddleDb,
        trebleDb: parameters.preampTrebleDb,
        levelDb: parameters.preampLevelDb
      }) : null;
      this.synth = algorithm === "synth" ? new BrowserSynthDsp(this.sampleRate, {
        sensitivity: parameters.synthSensitivity,
        waveform: parameters.synthWaveform,
        octave: parameters.synthOctave,
        tone: parameters.synthToneHz,
        mix: parameters.synthMixPercent
      }) : null;
      this.g2b = algorithm === "g2b" ? new BrowserG2bDsp(this.sampleRate, {
        tracking: parameters.g2bTrackingPercent,
        blend: parameters.g2bBlendPercent,
        body: parameters.g2bBodyHz
      }) : null;
      this.vocoder = algorithm === "vocoder" ? new BrowserVocoderCore(this.sampleRate, {
        bands: parameters.vocoderBands,
        carrier: parameters.vocoderCarrier
      }) : null;
      this.electric = algorithm === "electric" ? new BrowserElectricDsp(this.sampleRate, {
        character: parameters.electricCharacter,
        pitchSnapPercent: parameters.electricPitchSnapPercent,
        toneHz: parameters.electricToneHz
      }) : null;
      this.oscVoc = algorithm === "osc-voc" ? new BrowserOscVocCore(this.sampleRate, {
        waveform: parameters.oscVocWaveform,
        midiChannel: parameters.oscVocMidiChannel,
        octave: parameters.oscVocOctave,
        bands: parameters.oscVocBands
      }, initialFrame) : null;
      this.oscBot = algorithm === "osc-bot" ? new BrowserOscBotCore(this.sampleRate, {
        waveform: parameters.oscBotWaveform,
        pattern: parameters.oscBotPattern,
        toneCutoffHz: parameters.oscBotToneHz,
        tempoBpm: parameters.bpm,
        mix: 1
      }) : null;
      this.slowGear = algorithm === "slow-gear" ? new BrowserSlowGearDsp(this.sampleRate, {
        attackMs: parameters.slowGearAttackMs,
        sensitivityPercent: parameters.slowGearSensitivityPercent
      }) : null;
      this.isolator = algorithm === "isolator" ? new BrowserIsolatorDsp(this.sampleRate, {
        lowGainDb: parameters.isolatorLowGainDb,
        midGainDb: parameters.isolatorMidGainDb,
        highGainDb: parameters.isolatorHighGainDb,
        gateRateBeats: parameters.isolatorGateRateBeats,
        gateDepthPercent: parameters.isolatorGateDepthPercent,
        bpm: parameters.bpm
      }) : null;
      this.vinylFlick = algorithm === "vinyl-flick" ? new BrowserVinylFlickDsp(this.sampleRate, {
        speed: parameters.vinylFlickSpeed,
        returnTimeSeconds: parameters.vinylFlickReturnTimeSeconds,
        brakePercent: parameters.vinylFlickBrakePercent
      }) : null;
      this.panningDelay = algorithm === "panning-delay" ? new BrowserPanningDelayDsp(this.sampleRate, {
        timeMs: parameters.panningDelayTimeMs,
        feedback: parameters.panningDelayFeedback,
        pan: parameters.panningDelayPan,
        mix: 100
      }) : null;
      this.modDelay = algorithm === "mod-delay" ? new BrowserModDelayDsp(this.sampleRate, {
        timeMs: parameters.modDelayTimeMs,
        rateHz: parameters.modDelayRateHz,
        depthMs: parameters.modDelayDepthMs,
        feedbackPercent: parameters.modDelayFeedbackPercent
      }) : null;
      this.manualPanPosition = new LinearParameterSmoother(clamp22(parameters.manualPanPosition ?? 0, -1, 1));
      this.manualPanLeftTable = new Float32Array(2049);
      this.manualPanRightTable = new Float32Array(2049);
      for (let index = 0; index < this.manualPanLeftTable.length; index += 1) {
        const angle = index / (this.manualPanLeftTable.length - 1) * (Math.PI / 2);
        this.manualPanLeftTable[index] = Math.cos(angle);
        this.manualPanRightTable[index] = Math.sin(angle);
      }
      if (this.algorithm === "reverb" || this.algorithm === "gate-reverb") {
        for (let index = 0; index < 16; index += 1) {
          const channel = index < 8 ? 0 : 1;
          const line = index & 7;
          const stereoScale = channel === 0 ? 1 : 1.013;
          const samples = Math.max(2, Math.round((DEFAULT_DELAY_SECONDS[line] ?? DEFAULT_DELAY_SECONDS[0]) * this.sampleRate * stereoScale));
          this.delayLengths[index] = samples;
          this.fdnBuffers[index] = new Float32Array(samples + 6);
          this.delayModPhases[index] = channel === 0 ? line * 0.37 : 0.19 + line * 0.41;
          this.delayModPhaseSteps[index] = TWO_PI10 * (0.071 + line * 0.013) / this.sampleRate;
        }
        this.earlyRingLength = Math.max(2, Math.ceil(this.sampleRate * 0.035) + 1);
        this.earlyBuffers = [new Float32Array(this.earlyRingLength), new Float32Array(this.earlyRingLength)];
      } else {
        this.earlyRingLength = 0;
        this.earlyBuffers = [void 0, void 0];
      }
      this.flangerWriteIndices = new Int32Array(2);
      this.flangerPhases = new Float64Array([0, Math.PI]);
      this.flangerFeedbackStates = new Float64Array(2);
      if (this.algorithm === "flanger") {
        const capacity = Math.ceil(FLANGER_MAX_DELAY_MILLISECONDS * this.sampleRate / 1e3) + 8;
        this.flangerBuffers = [new Float32Array(capacity), new Float32Array(capacity)];
      } else {
        this.flangerBuffers = [void 0, void 0];
      }
      this.delayWriteIndices = new Int32Array(2);
      this.delayToneStates = new Float64Array(2);
      this.delayToneAlpha = 1 - Math.exp(-TWO_PI10 * initialDelayToneHz / this.sampleRate);
      if (this.algorithm === "delay") {
        const capacity = Math.ceil(DELAY_MAX_TIME_MILLISECONDS * this.sampleRate / 1e3) + 8;
        this.delayBuffers = [new Float32Array(capacity), new Float32Array(capacity)];
      } else {
        this.delayBuffers = [void 0, void 0];
      }
      this.chorusWriteIndices = new Int32Array(8);
      this.chorusFeedbackStates = new Float64Array(8);
      this.chorusVoiceCount = initialChorusVoices;
      this.chorusToneAlpha = 1 - Math.exp(-TWO_PI10 * initialChorusToneHz / this.sampleRate);
      this.chorusPhaseStep = TWO_PI10 * initialChorusRateHz / this.sampleRate;
      if (this.algorithm === "chorus") {
        const capacity = Math.ceil(CHORUS_MAX_DELAY_MILLISECONDS * this.sampleRate / 1e3) + 8;
        this.chorusBuffers = new Array(8);
        for (let index = 0; index < this.chorusBuffers.length; index += 1) {
          this.chorusBuffers[index] = new Float32Array(capacity);
        }
      } else {
        this.chorusBuffers = new Array(8);
      }
      this.phaserInputStates = new Float64Array(2 * PHASER_MAX_STAGES);
      this.phaserOutputStates = new Float64Array(2 * PHASER_MAX_STAGES);
      this.phaserFeedbackStates = new Float64Array(2);
      this.phaserToneAlpha = 1 - Math.exp(-TWO_PI10 * Math.min(PHASER_FEEDBACK_FILTER_HZ, nyquist) / this.sampleRate);
      this.phaserStageCount = initialPhaserStages;
      this.phaserPhaseStep = TWO_PI10 * initialPhaserRateHz / this.sampleRate;
      this.tremoloPhaseStep = initialTremoloRateHz / this.sampleRate;
      this.autoPanPhaseStep = initialAutoPanRateHz / this.sampleRate;
      this.earlyDelays = new Int32Array(EARLY_REFLECTION_DELAYS_SECONDS.length);
      if (this.algorithm === "reverb" || this.algorithm === "gate-reverb") {
        for (let index = 0; index < EARLY_REFLECTION_DELAYS_SECONDS.length; index += 1) {
          this.earlyDelays[index] = Math.min(
            this.earlyRingLength - 1,
            Math.round((EARLY_REFLECTION_DELAYS_SECONDS[index] ?? 0) * this.sampleRate)
          );
        }
        this.refreshTimeVariantCoefficients(initialDecay, initialDamping);
      }
    }
    /**
     * Update targets from outside the render loop. Invalid individual values
     * are ignored; ranges are authored safety limits, not device-manufacturer
     * parameter claims.
     */
    setParameters(parameters) {
      const nyquist = this.sampleRate * 0.499;
      if (this.algorithm === "vocoder") {
        validateBrowserVocoderParameters(parameters);
        if (parameters.vocoderBands !== void 0 || parameters.vocoderCarrier !== void 0) {
          this.vocoder?.setParameters({ bands: parameters.vocoderBands, carrier: parameters.vocoderCarrier });
        }
      }
      if (this.algorithm === "electric") {
        validateBrowserElectricParameters(parameters);
        this.electric?.setParameters({
          character: parameters.electricCharacter,
          pitchSnapPercent: parameters.electricPitchSnapPercent,
          toneHz: parameters.electricToneHz
        });
      }
      if (this.algorithm === "osc-bot") {
        validateBrowserOscBotParameters(parameters, this.sampleRate);
        this.oscBot?.setParameters({
          waveform: parameters.oscBotWaveform,
          pattern: parameters.oscBotPattern,
          toneCutoffHz: parameters.oscBotToneHz,
          tempoBpm: parameters.bpm
        });
      }
      if (this.algorithm === "osc-voc") {
        validateBrowserOscVocParameters(parameters);
        this.oscVoc?.setParameters({
          waveform: parameters.oscVocWaveform,
          midiChannel: parameters.oscVocMidiChannel,
          octave: parameters.oscVocOctave,
          bands: parameters.oscVocBands
        });
      }
      if (this.algorithm === "freeze" && Number.isFinite(parameters.freezeMode) && parameters.freezeMode !== 0) {
        throw new RangeError("Spectral FREEZE mode is unavailable; only micro-loop mode is wired.");
      }
      this.controlsSteady = false;
      this.controlSmoothersSettled = false;
      this.controlSettleScanCountdown = 0;
      if (Number.isFinite(parameters.cutoffHz)) this.cutoff.setTarget(clamp22(parameters.cutoffHz, 20, nyquist));
      if ((this.algorithm === "lpf" || this.algorithm === "hpf") && Number.isFinite(parameters.filterResonancePercent)) {
        this.q.setTarget(filterResonancePercentToQ(parameters.filterResonancePercent));
      } else if (Number.isFinite(parameters.q)) {
        this.q.setTarget(clamp22(parameters.q, 0.1, 30));
      }
      if (Number.isFinite(parameters.mix)) this.wet.setTarget(clamp22(parameters.mix, 0, 1));
      if (Number.isFinite(parameters.decaySeconds)) this.decaySeconds.setTarget(clamp22(parameters.decaySeconds, 0.1, 20));
      if (Number.isFinite(parameters.dampingHz)) this.dampingHz.setTarget(clamp22(parameters.dampingHz, 200, nyquist));
      if (Number.isFinite(parameters.gateThresholdDb)) this.gateThresholdDb.setTarget(clamp22(parameters.gateThresholdDb, -60, 0));
      if (Number.isFinite(parameters.gateHoldMs)) this.gateHoldMs.setTarget(clamp22(parameters.gateHoldMs, 5, 2e3));
      if (Number.isFinite(parameters.gateReleaseMs)) this.gateReleaseMs.setTarget(clamp22(parameters.gateReleaseMs, 10, 2e3));
      if (Number.isFinite(parameters.ringModHz)) this.ringModHz.setTarget(clamp22(parameters.ringModHz, 0, Math.min(8e3, this.sampleRate * 0.45)));
      if (Number.isFinite(parameters.ringModDepth)) this.ringModDepth.setTarget(clamp22(parameters.ringModDepth, 0, 1));
      if (parameters.ringModWaveform === 0 || parameters.ringModWaveform === 1) this.ringModWaveform.setTarget(parameters.ringModWaveform);
      if (Number.isFinite(parameters.driveDb)) this.driveDb.setTarget(clamp22(parameters.driveDb, 0, 36));
      if (Number.isFinite(parameters.outputDb)) this.outputDb.setTarget(clamp22(parameters.outputDb, -24, 12));
      if (isDistortionMode(parameters.distortionMode)) this.requestDistortionMode(parameters.distortionMode);
      if (Number.isFinite(parameters.flangerDelayMs)) this.flangerDelayMs.setTarget(clamp22(parameters.flangerDelayMs, FLANGER_MIN_DELAY_MILLISECONDS, FLANGER_MAX_DELAY_MILLISECONDS));
      if (Number.isFinite(parameters.flangerRateHz)) this.flangerRateHz.setTarget(clamp22(parameters.flangerRateHz, 0.05, 20));
      if (Number.isFinite(parameters.flangerDepth)) this.flangerDepth.setTarget(clamp22(parameters.flangerDepth, 0, 1));
      if (Number.isFinite(parameters.flangerFeedback)) this.flangerFeedback.setTarget(clamp22(parameters.flangerFeedback, -0.95, 0.95));
      if (Number.isFinite(parameters.thresholdDb)) this.dynamicsThreshold.setTarget(clamp22(parameters.thresholdDb, -60, 0));
      if (Number.isFinite(parameters.ratio)) this.dynamicsRatio.setTarget(clamp22(parameters.ratio, 1, 20));
      if (Number.isFinite(parameters.kneeDb)) this.dynamicsKnee.setTarget(clamp22(parameters.kneeDb, 0, 24));
      if (Number.isFinite(parameters.attackMs)) this.dynamicsAttackMs.setTarget(clamp22(parameters.attackMs, 0.1, 100));
      if (Number.isFinite(parameters.releaseMs)) this.dynamicsReleaseMs.setTarget(clamp22(parameters.releaseMs, 5, 1e3));
      if (parameters.dynamicsDetector === "peak" || parameters.dynamicsDetector === "rms") this.dynamicsDetector = parameters.dynamicsDetector;
      if (Number.isFinite(parameters.delayTimeMs)) this.delayTimeMs.setTarget(clamp22(parameters.delayTimeMs, DELAY_MIN_TIME_MILLISECONDS, DELAY_MAX_TIME_MILLISECONDS));
      if (Number.isFinite(parameters.delayFeedback)) this.delayFeedback.setTarget(clamp22(parameters.delayFeedback, 0, 0.95));
      if (Number.isFinite(parameters.delayToneHz)) this.delayToneHz.setTarget(clamp22(parameters.delayToneHz, 100, Math.min(16e3, this.sampleRate * 0.499)));
      if (this.algorithm === "mod-delay") {
        this.modDelay?.setParameters({
          timeMs: parameters.modDelayTimeMs,
          rateHz: parameters.modDelayRateHz,
          depthMs: parameters.modDelayDepthMs,
          feedbackPercent: parameters.modDelayFeedbackPercent
        });
      }
      if (this.algorithm === "panning-delay") {
        this.panningDelay?.setParameters({
          timeMs: parameters.panningDelayTimeMs,
          feedback: parameters.panningDelayFeedback,
          pan: parameters.panningDelayPan
        });
      }
      if (Number.isFinite(parameters.chorusDelayMs)) this.chorusDelayMs.setTarget(clamp22(parameters.chorusDelayMs, CHORUS_MIN_DELAY_MILLISECONDS, CHORUS_MAX_DELAY_MILLISECONDS));
      if (Number.isFinite(parameters.chorusRateHz)) this.chorusRateHz.setTarget(clamp22(parameters.chorusRateHz, 0.05, 10));
      if (Number.isFinite(parameters.chorusDepthMs)) this.chorusDepthMs.setTarget(clamp22(parameters.chorusDepthMs, 0.2, 20));
      if (Number.isFinite(parameters.chorusVoices)) this.chorusVoiceCount = Math.round(clamp22(parameters.chorusVoices, 2, 4));
      if (Number.isFinite(parameters.chorusFeedback)) this.chorusFeedback.setTarget(clamp22(parameters.chorusFeedback, 0, CHORUS_FEEDBACK_MAX));
      if (Number.isFinite(parameters.chorusToneHz)) this.chorusToneHz.setTarget(clamp22(parameters.chorusToneHz, 100, Math.min(16e3, this.sampleRate * 0.499)));
      if (Number.isFinite(parameters.phaserRateHz)) this.phaserRateHz.setTarget(clamp22(parameters.phaserRateHz, 0.05, 20));
      if (Number.isFinite(parameters.phaserDepth)) this.phaserDepth.setTarget(clamp22(parameters.phaserDepth, 0, 1));
      if (Number.isFinite(parameters.phaserFeedback)) this.phaserFeedback.setTarget(clamp22(parameters.phaserFeedback, 0, PHASER_FEEDBACK_MAX));
      if (Number.isFinite(parameters.phaserStages)) this.phaserStageCount = clamp22(parameters.phaserStages, 4, PHASER_MAX_STAGES) < 6 ? 4 : 8;
      if (Number.isFinite(parameters.tremoloRateHz)) this.tremoloRateHz.setTarget(clamp22(parameters.tremoloRateHz, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ));
      if (Number.isFinite(parameters.tremoloDepth)) this.tremoloDepth.setTarget(clamp22(parameters.tremoloDepth, 0, 1));
      if (isTremoloWaveform(parameters.tremoloWaveform)) this.requestTremoloWaveform(parameters.tremoloWaveform);
      if (Number.isFinite(parameters.autoPanRateHz)) this.autoPanRateHz.setTarget(clamp22(parameters.autoPanRateHz, TREMOLO_MIN_RATE_HZ, TREMOLO_MAX_RATE_HZ));
      if (Number.isFinite(parameters.autoPanDepth)) this.autoPanDepth.setTarget(clamp22(parameters.autoPanDepth, 0, 1));
      if (isTremoloWaveform(parameters.autoPanWaveform)) this.requestAutoPanWaveform(parameters.autoPanWaveform);
      if (Number.isFinite(parameters.stereoWidth)) this.stereoWidth.setTarget(clamp22(parameters.stereoWidth, 0, 2));
      if (Number.isFinite(parameters.stereoLowMonoCutoffHz)) this.stereoLowMonoCutoffHz.setTarget(clamp22(parameters.stereoLowMonoCutoffHz, 20, Math.min(1e3, this.sampleRate * 0.499)));
      if (Number.isFinite(parameters.stereoDecorrelation)) this.stereoDecorrelation.setTarget(clamp22(parameters.stereoDecorrelation, 0, 1));
      if (this.algorithm === "beat-repeat") this.beatRepeat?.setParameters(parameters);
      if (this.algorithm === "roll") {
        this.roll?.setParameters({
          bpm: parameters.bpm,
          sliceBeats: parameters.rollSliceBeats,
          decayPercent: parameters.rollDecayPercent,
          pitchSemitones: parameters.rollPitchSemitones,
          direction: parameters.rollDirection === 1 ? "reverse" : parameters.rollDirection === 2 ? "alternate" : "forward"
        });
      }
      if (this.algorithm === "freeze") {
        this.freeze?.setParameters({
          captureLengthMs: parameters.freezeCaptureLengthMs,
          pitchSemitones: parameters.freezePitchSemitones,
          frozen: Number.isFinite(parameters.freezeEnabled) ? parameters.freezeEnabled >= 0.5 : void 0
        });
      }
      if (this.algorithm === "warp") {
        this.warp?.setParameters({
          bpm: parameters.bpm,
          captureBeats: parameters.warpCaptureBeats,
          smearPercent: parameters.warpSmearPercent,
          pitchSemitones: parameters.warpPitchSemitones,
          feedbackPercent: parameters.warpFeedbackPercent,
          frozen: Number.isFinite(parameters.warpFreezeEnabled) ? parameters.warpFreezeEnabled >= 0.5 : void 0
        });
      }
      if (this.algorithm === "beat-scatter") {
        this.beatScatter?.setParameters({
          bpm: parameters.bpm,
          sliceBeats: parameters.beatScatterSliceBeats,
          scatterPercent: parameters.beatScatterScatterPercent,
          pitchSemitones: parameters.beatScatterPitchSemitones,
          repeats: parameters.beatScatterRepeats
        });
      }
      if (this.algorithm === "beat-shift") {
        this.beatShift?.setParameters({
          bpm: parameters.bpm,
          offsetBeats: parameters.beatShiftOffsetBeats,
          crossfadeMs: parameters.beatShiftCrossfadeMs
        });
      }
      if (this.algorithm === "reverse-delay") {
        this.reverseDelay?.setParameters({
          bpm: parameters.bpm,
          segmentBeats: parameters.reverseDelaySegmentBeats,
          feedback: parameters.reverseDelayFeedback,
          crossfadeMs: parameters.reverseDelayCrossfadeMs
        });
      }
      if (this.algorithm === "reverse-reverb") {
        this.reverseReverb?.setParameters({
          bpm: parameters.bpm,
          segmentBeats: parameters.reverseReverbSegmentBeats,
          feedbackPercent: parameters.reverseReverbFeedbackPercent,
          crossfadeMs: parameters.reverseReverbCrossfadeMs,
          decaySeconds: parameters.reverseReverbDecaySeconds ?? parameters.decaySeconds,
          dampingCutoffHz: parameters.reverseReverbDampingCutoffHz ?? parameters.dampingHz
        });
      }
      if (this.algorithm === "auto-riff") {
        this.autoRiff?.setParameters({
          bpm: parameters.bpm,
          scale: Number.isFinite(parameters.autoRiffScale) ? parameters.autoRiffScale : void 0,
          beatStepRate: parameters.autoRiffRateBeats,
          onsetSensitivity: Number.isFinite(parameters.autoRiffSensitivityPercent) ? parameters.autoRiffSensitivityPercent / 100 : void 0
        });
      }
      if (this.algorithm === "hrm-auto") {
        this.hrmAuto?.setParameters({
          key: parameters.hrmAutoKey,
          scale: parameters.hrmAutoScale,
          midiChannel: parameters.hrmAutoMidiChannel,
          mix: parameters.hrmAutoMixPercent
        });
      }
      if (this.algorithm === "robot") {
        this.robot?.setParameters({ pitch: parameters.robotPitch, formant: parameters.robotFormantSemitones });
      }
      if (this.algorithm === "pattern-slicer") {
        this.patternSlicer?.setParameters({
          bpm: parameters.bpm,
          pattern: parameters.patternSlicerPattern,
          rateBeats: parameters.patternSlicerRateBeats,
          depthPercent: parameters.patternSlicerDepthPercent,
          edgeMs: parameters.patternSlicerEdgeMs
        });
      }
      if (this.algorithm === "step-slicer") {
        this.stepSlicer?.setParameters({
          bpm: parameters.bpm,
          stepCount: parameters.stepSlicerStepCount,
          rateBeats: parameters.stepSlicerRateBeats,
          depthPercent: parameters.stepSlicerDepthPercent,
          panDepthPercent: parameters.stepSlicerPanDepthPercent,
          filterHz: parameters.stepSlicerFilterHz,
          step01: parameters.stepSlicerStep01,
          step02: parameters.stepSlicerStep02,
          step03: parameters.stepSlicerStep03,
          step04: parameters.stepSlicerStep04,
          step05: parameters.stepSlicerStep05,
          step06: parameters.stepSlicerStep06,
          step07: parameters.stepSlicerStep07,
          step08: parameters.stepSlicerStep08,
          step09: parameters.stepSlicerStep09,
          step10: parameters.stepSlicerStep10,
          step11: parameters.stepSlicerStep11,
          step12: parameters.stepSlicerStep12,
          step13: parameters.stepSlicerStep13,
          step14: parameters.stepSlicerStep14,
          step15: parameters.stepSlicerStep15,
          step16: parameters.stepSlicerStep16
        });
      }
      if (this.algorithm === "sustainer") this.sustainer?.setParameters(parameters);
      if (this.algorithm === "preamp") {
        this.preamp?.setParameters({
          model: parameters.preampModel,
          gainPercent: parameters.preampGainPercent,
          bassDb: parameters.preampBassDb,
          middleDb: parameters.preampMiddleDb,
          trebleDb: parameters.preampTrebleDb,
          levelDb: parameters.preampLevelDb
        });
      }
      if (this.algorithm === "synth") {
        this.synth?.setParameters({
          sensitivity: parameters.synthSensitivity,
          waveform: parameters.synthWaveform,
          octave: parameters.synthOctave,
          tone: parameters.synthToneHz,
          mix: parameters.synthMixPercent
        });
      }
      if (this.algorithm === "g2b") {
        this.g2b?.setParameters({
          tracking: parameters.g2bTrackingPercent,
          blend: parameters.g2bBlendPercent,
          body: parameters.g2bBodyHz
        });
      }
      if (this.algorithm === "slow-gear") {
        this.slowGear?.setParameters({
          attackMs: parameters.slowGearAttackMs,
          sensitivityPercent: parameters.slowGearSensitivityPercent
        });
      }
      if (this.algorithm === "isolator") {
        this.isolator?.setParameters({
          lowGainDb: parameters.isolatorLowGainDb,
          midGainDb: parameters.isolatorMidGainDb,
          highGainDb: parameters.isolatorHighGainDb,
          gateRateBeats: parameters.isolatorGateRateBeats,
          gateDepthPercent: parameters.isolatorGateDepthPercent,
          bpm: parameters.bpm
        });
      }
      if (this.algorithm === "vinyl-flick") {
        this.vinylFlick?.setParameters({
          speed: parameters.vinylFlickSpeed,
          returnTimeSeconds: parameters.vinylFlickReturnTimeSeconds,
          brakePercent: parameters.vinylFlickBrakePercent
        });
      }
      if (this.algorithm === "lo-fi") {
        this.loFi?.setParameters({
          bitDepth: parameters.loFiBitDepth,
          sampleRateHz: parameters.loFiSampleRateHz,
          filterHz: parameters.loFiFilterHz
        });
      }
      if (this.algorithm === "eq") {
        this.equalizer?.setParameters({
          lowFrequencyHz: parameters.eqLowFrequencyHz,
          lowGainDb: parameters.eqLowGainDb,
          mid1FrequencyHz: parameters.eqMid1FrequencyHz,
          mid1Q: parameters.eqMid1Q,
          mid1GainDb: parameters.eqMid1GainDb,
          mid2FrequencyHz: parameters.eqMid2FrequencyHz,
          mid2Q: parameters.eqMid2Q,
          mid2GainDb: parameters.eqMid2GainDb,
          highFrequencyHz: parameters.eqHighFrequencyHz,
          highGainDb: parameters.eqHighGainDb
        });
      }
      if (this.algorithm === "tape-echo") {
        this.tapeEcho?.setParameters({
          timeMs: parameters.tapeEchoTimeMs,
          feedback: parameters.tapeEchoFeedback,
          wow: parameters.tapeEchoWow,
          saturation: parameters.tapeEchoSaturation,
          toneHz: parameters.tapeEchoToneHz
        });
      }
      if (this.algorithm === "twist") {
        this.twist?.setParameters({
          amount: parameters.twistAmount,
          trajectory: parameters.twistTrajectory
        });
      }
      if (this.algorithm === "granular-delay") {
        this.granularDelay?.setParameters({
          grainSizeMs: parameters.granularGrainSizeMs,
          densityHz: parameters.granularDensityHz,
          pitchSemitones: parameters.granularPitchSemitones,
          positionJitterPercent: parameters.granularPositionJitterPercent,
          feedbackPercent: parameters.granularFeedbackPercent
        });
      }
      if (this.algorithm === "radio") {
        this.radio?.setParameters({
          band: parameters.radioBand,
          drive: parameters.radioDrive,
          noise: parameters.radioNoise
        });
      }
      if (this.algorithm === "vibrato") {
        this.vibrato?.setParameters({
          rateHz: parameters.vibratoRateHz,
          depthPercent: parameters.vibratoDepthPercent,
          delayMs: parameters.vibratoDelayMs
        });
      }
      if (Number.isFinite(parameters.manualPanPosition)) {
        this.manualPanPosition.setTarget(clamp22(parameters.manualPanPosition, -1, 1), Math.round(this.sampleRate * DEFAULT_SMOOTHING_SECONDS));
      }
    }
    /** Small read-only diagnostics for deterministic clock tests and host status. */
    get beatRepeatDiagnostics() {
      const dsp = this.beatRepeat;
      if (!dsp) return null;
      return {
        boundaryCount: dsp.boundaryCount,
        framesProcessed: dsp.framesProcessed,
        lastBoundaryFrame: dsp.lastBoundaryFrame,
        activeBpm: dsp.activeBpm,
        activeDivision: dsp.activeDivision,
        activeDirection: dsp.activeDirection,
        activeSliceFrames: dsp.activeSliceFrames,
        remainingFramesToBoundary: dsp.remainingFramesToBoundary,
        maxSliceFrames: dsp.maxSliceFrames
      };
    }
    /** Small read-only diagnostics for deterministic grain-clock tests. */
    get beatScatterDiagnostics() {
      const scatter = this.beatScatter;
      if (!scatter) return null;
      return {
        boundaryCount: scatter.boundaryCount,
        framesProcessed: scatter.framesProcessed,
        lastBoundaryFrame: scatter.lastBoundaryFrame,
        activeBpm: scatter.activeBpm,
        activeSliceBeats: scatter.activeSliceBeats,
        activeScatterPercent: scatter.activeScatterPercent,
        activePitchSemitones: scatter.activePitchSemitones,
        activeRepeats: scatter.activeRepeats,
        activeSliceFrames: scatter.activeSliceFrames,
        remainingFramesToBoundary: scatter.remainingFramesToBoundary,
        maxSliceFrames: scatter.maxSliceFrames,
        hasCapturedSlice: scatter.hasCapturedSlice
      };
    }
    /** Diagnostics for the fixed-capacity signed beat-shift buffer. */
    get beatShiftDiagnostics() {
      return this.beatShift?.diagnostics ?? null;
    }
    /** Diagnostics for the bounded beat-synchronous reverse segment buffers. */
    get reverseDelayDiagnostics() {
      return this.reverseDelay?.diagnostics ?? null;
    }
    /** Diagnostics for the experimental segmented reverse-FDN-tail processor. */
    get reverseReverbDiagnostics() {
      return this.reverseReverb?.diagnostics ?? null;
    }
    /** Pop one bounded AUTO RIFF pitch event for host scheduling. */
    tryPopAutoRiffPitchChange() {
      return this.autoRiff?.tryPopPitchChange() ?? false;
    }
    get lastAutoRiffPitchFrame() {
      return this.autoRiff?.lastPoppedFrame ?? -1;
    }
    get lastAutoRiffPitchSemitones() {
      return this.autoRiff?.lastPoppedSemitones ?? 0;
    }
    /** Pop one bounded HRM AUTO MIDI/analysis target update for host scheduling. */
    tryPopHrmAutoStateChange() {
      return this.hrmAuto?.tryPopStateChange() ?? false;
    }
    get lastHrmAutoStateFrame() {
      return this.hrmAuto?.lastStateChangeFrame ?? -1;
    }
    get lastHrmAutoStateReason() {
      return this.hrmAuto?.lastStateChangeReason ?? 0;
    }
    get lastHrmAutoStateNote() {
      return this.hrmAuto?.lastStateChangeNote ?? -1;
    }
    get lastHrmAutoStateNoteOn() {
      return this.hrmAuto?.lastStateChangeNoteOn ?? false;
    }
    get lastHrmAutoActiveNoteCount() {
      return this.hrmAuto?.lastStateChangeActiveCount ?? 0;
    }
    get lastHrmAutoVoiceCount() {
      return this.hrmAuto?.lastStateChangeVoiceCount ?? 0;
    }
    get lastHrmAutoTarget1() {
      return this.hrmAuto?.lastStateChangeTarget1 ?? -128;
    }
    get lastHrmAutoTarget2() {
      return this.hrmAuto?.lastStateChangeTarget2 ?? -128;
    }
    get hrmAutoMidiOverflowCount() {
      return this.hrmAuto?.midiOverflowCount ?? 0;
    }
    get hrmAutoStateOverflowCount() {
      return this.hrmAuto?.stateOverflowCount ?? 0;
    }
    /** Pop one bounded ROBOT pitch/F0 state event for host scheduling. */
    tryPopRobotTargetChange() {
      return this.robot?.tryPopTargetChange() ?? false;
    }
    get lastRobotTargetFrame() {
      return this.robot?.lastTargetFrame ?? -1;
    }
    get lastRobotTargetSemitones() {
      return this.robot?.lastTargetSemitones ?? 0;
    }
    get lastRobotTargetSourceMidi() {
      return this.robot?.lastTargetSourceMidi ?? 0;
    }
    get lastRobotTargetMidi() {
      return this.robot?.lastTargetMidi ?? 0;
    }
    get lastRobotTargetHz() {
      return this.robot?.lastTargetHz ?? 0;
    }
    get lastRobotTargetConfidence() {
      return this.robot?.lastTargetConfidence ?? 0;
    }
    get lastRobotTargetVoiced() {
      return this.robot?.lastTargetVoiced ?? false;
    }
    get lastRobotProcessingMode() {
      return this.robot?.processingMode ?? "signalsmith";
    }
    get lastRobotModeReason() {
      return this.robot?.modeReason ?? "unvoiced";
    }
    get lastRobotModeFrame() {
      return this.robot?.modeFrame ?? 0;
    }
    get robotModeRevision() {
      return this.robot?.modeRevision ?? 0;
    }
    get robotPsolaLatencySamples() {
      return this.robot?.psolaLatencySamples ?? 0;
    }
    get robotTrackerAcquisitionFrames() {
      return this.robot?.latencyFrames ?? 0;
    }
    /** Diagnostics for the sample-clocked PATTERN SLICER table and step phase. */
    get patternSlicerDiagnostics() {
      return this.patternSlicer?.diagnostics ?? null;
    }
    /** Diagnostics for the editable, sample-clocked STEP SLICER sequence. */
    get stepSlicerDiagnostics() {
      return this.stepSlicer?.diagnostics ?? null;
    }
    setBypass(bypassed, rampFrames = 0) {
      this.bypassMix.setTarget(bypassed ? 1 : 0, rampFrames);
    }
    get bypassed() {
      return this.bypassMix.targetValue === 1;
    }
    /** True only after an optional bypass crossfade has reached its endpoint. */
    get fullyBypassed() {
      return this.bypassMix.currentValue === 1 && this.bypassMix.targetValue === 1 && this.bypassMix.remainingFrames === 0;
    }
    /** Align the MIDI effect scheduler with the host AudioWorklet sample clock. */
    synchronizeFrame(frame) {
      if (Number.isSafeInteger(frame) && frame >= 0) this.currentAudioFrame = Math.floor(frame);
      if (this.algorithm === "osc-voc") this.oscVoc?.synchronizeFrame(frame);
    }
    scheduleMidiNoteOn(channel, note, velocity, frame) {
      if (this.algorithm === "osc-voc" && this.oscVoc) {
        this.oscVoc.noteOn(channel, note, velocity, frame);
        return;
      }
      if (this.algorithm === "hrm-auto" && this.hrmAuto) {
        if (!this.hrmAuto.enqueueMidiEvent("noteOn", channel, note, velocity, frame)) {
          throw new RangeError("HRM AUTO (M) rejected MIDI note-on (invalid event or bounded queue full).");
        }
        return;
      }
      throw new RangeError("MIDI note events are only supported by OSC VOC (M) and HRM AUTO (M).");
    }
    scheduleMidiNoteOff(channel, note, frame) {
      if (this.algorithm === "osc-voc" && this.oscVoc) {
        this.oscVoc.noteOff(channel, note, frame);
        return;
      }
      if (this.algorithm === "hrm-auto" && this.hrmAuto) {
        if (!this.hrmAuto.enqueueMidiEvent("noteOff", channel, note, 0, frame)) {
          throw new RangeError("HRM AUTO (M) rejected MIDI note-off (invalid event or bounded queue full).");
        }
        return;
      }
      throw new RangeError("MIDI note events are only supported by OSC VOC (M) and HRM AUTO (M).");
    }
    scheduleMidiAllNotesOff(frame) {
      if (this.algorithm !== "osc-voc" || !this.oscVoc) {
        throw new RangeError(`${this.algorithm} does not accept OSC VOC MIDI all-notes-off.`);
      }
      this.oscVoc.allNotesOff(frame);
    }
    /**
     * Process up to two channels. Null input is silence; a mono-to-stereo caller
     * may deliberately pass the same left input for both input channels. Arrays
     * are not retained and no output storage is created by this method.
     */
    processBlock(inputLeft, inputRight, outputLeft, outputRight, frameCount, inputIsMono = inputRight === null) {
      this.blocksProcessed += 1;
      const frames = Math.max(0, Math.floor(frameCount ?? Math.max(outputLeft?.length ?? 0, outputRight?.length ?? 0)));
      const inputLeftLength = inputLeft?.length ?? 0;
      const inputRightLength = inputRight?.length ?? 0;
      const outputLeftLength = outputLeft?.length ?? 0;
      const outputRightLength = outputRight?.length ?? 0;
      const monoAutoPanInput = this.algorithm === "auto-pan" && (!inputRight || inputRightLength === 0);
      const monoStereoEnhanceInput = this.algorithm === "stereo-enhance" && (!inputRight || inputRightLength === 0);
      const monoManualPanInput = this.algorithm === "manual-pan" && inputIsMono;
      if (this.fullyBypassed && this.algorithm !== "beat-shift" && this.algorithm !== "reverse-delay" && this.algorithm !== "reverse-reverb" && this.algorithm !== "vinyl-flick" && this.algorithm !== "freeze" && this.algorithm !== "osc-voc" && this.algorithm !== "hrm-auto") {
        const bypassRightInput = monoAutoPanInput || monoManualPanInput || monoStereoEnhanceInput ? inputLeft : inputRight;
        if (outputLeft && inputLeft && outputLeftLength === frames && inputLeftLength === frames && outputLeft.buffer !== inputLeft.buffer && (!outputRight || outputLeft.buffer !== outputRight.buffer) && (!bypassRightInput || outputLeft.buffer !== bypassRightInput.buffer) && (!outputRight || outputRight.buffer !== inputLeft.buffer && outputRight.buffer !== bypassRightInput?.buffer) && (!outputRight || bypassRightInput && outputRightLength === frames && bypassRightInput.length === frames)) {
          outputLeft.set(inputLeft);
          if (outputRight && bypassRightInput) outputRight.set(bypassRightInput);
          this.framesProcessed += frames;
          this.currentAudioFrame += frames;
          return;
        }
        for (let frame = 0; frame < frames; frame += 1) {
          if (frame < outputLeftLength && outputLeft) outputLeft[frame] = frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0;
          if (frame < outputRightLength && outputRight) {
            outputRight[frame] = monoAutoPanInput || monoManualPanInput ? frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0 : monoStereoEnhanceInput ? frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0 : frame < inputRightLength ? inputRight?.[frame] ?? 0 : 0;
          }
        }
        this.framesProcessed += frames;
        this.currentAudioFrame += frames;
        return;
      }
      for (let frame = 0; frame < frames; frame += 1) {
        let dryLeft = frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0;
        let dryRight = monoAutoPanInput || monoStereoEnhanceInput || monoManualPanInput ? frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0 : frame < inputRightLength ? inputRight?.[frame] ?? 0 : 0;
        if (!Number.isFinite(dryLeft)) {
          dryLeft = 0;
          this.nonFiniteInputSamples += 1;
        }
        if (!Number.isFinite(dryRight)) {
          dryRight = 0;
          this.nonFiniteInputSamples += 1;
        }
        if (Math.abs(dryLeft) < MIN_STATE_MAGNITUDE) dryLeft = 0;
        if (Math.abs(dryRight) < MIN_STATE_MAGNITUDE) dryRight = 0;
        this.advanceControls();
        if (this.algorithm === "dynamics") this.updateDynamicsDetector(dryLeft, dryRight);
        if (this.algorithm === "gate-reverb") this.updateGateReverbEnvelope(dryLeft, dryRight);
        const wetPosition = this.algorithm === "electric" && this.electric?.requiresVoicedInput && !this.electric.isVoiced ? 0 : this.algorithm === "preamp" || this.algorithm === "synth" || this.algorithm === "g2b" ? 1 : this.algorithm === "beat-repeat" && !this.beatRepeat?.hasCapturedSlice || this.algorithm === "roll" && !this.roll?.hasCapturedSlice || this.algorithm === "beat-scatter" && !this.beatScatter?.hasCapturedSlice || this.algorithm === "reverse-delay" && !this.reverseDelay?.hasCaptured ? 0 : this.algorithm === "beat-shift" ? this.beatShift?.mixAvailability ?? 0 : this.algorithm === "pattern-slicer" || this.algorithm === "step-slicer" ? 1 : this.currentControls[2] ?? 1;
        if (wetPosition !== this.cachedWetPosition) {
          this.cachedWetPosition = wetPosition;
          this.cachedWetDryGain = equalPowerFadeOutGain(wetPosition);
          this.cachedWetGain = equalPowerFadeInGain(wetPosition);
        }
        const wetDryGain = this.cachedWetDryGain;
        const wetGain = this.cachedWetGain;
        let mixDryLeft = this.algorithm === "distortion" ? this.processDistortionDryDelay(dryLeft, 0) : dryLeft;
        let mixDryRight = this.algorithm === "distortion" ? this.processDistortionDryDelay(dryRight, 1) : dryRight;
        let wetLeft;
        let wetRight;
        if (this.algorithm === "vinyl-flick") {
          this.vinylFlick?.processSample(dryLeft, dryRight);
          wetLeft = this.vinylFlick?.wetLeft ?? dryLeft;
          wetRight = this.vinylFlick?.wetRight ?? dryRight;
          mixDryLeft = this.vinylFlick?.dryLeft ?? dryLeft;
          mixDryRight = this.vinylFlick?.dryRight ?? dryRight;
        } else if (this.algorithm === "auto-pan") {
          this.processAutoPan(dryLeft, dryRight, monoAutoPanInput);
          wetLeft = this.autoPanWetLeft;
          wetRight = this.autoPanWetRight;
        } else if (this.algorithm === "beat-repeat") {
          this.beatRepeat?.processSample(dryLeft, dryRight);
          wetLeft = this.beatRepeat?.wetLeft ?? 0;
          wetRight = this.beatRepeat?.wetRight ?? 0;
        } else if (this.algorithm === "roll") {
          this.roll?.processSample(dryLeft, dryRight);
          wetLeft = this.roll?.wetLeft ?? 0;
          wetRight = this.roll?.wetRight ?? 0;
        } else if (this.algorithm === "freeze") {
          this.freeze?.processSample(dryLeft, dryRight);
          wetLeft = this.freeze?.outputLeft ?? dryLeft;
          wetRight = this.freeze?.outputRight ?? dryRight;
        } else if (this.algorithm === "warp") {
          this.warp?.processSample(dryLeft, dryRight);
          wetLeft = this.warp?.wetLeft ?? 0;
          wetRight = this.warp?.wetRight ?? 0;
        } else if (this.algorithm === "beat-scatter") {
          this.beatScatter?.processSample(dryLeft, dryRight);
          wetLeft = this.beatScatter?.wetLeft ?? 0;
          wetRight = this.beatScatter?.wetRight ?? 0;
        } else if (this.algorithm === "beat-shift") {
          this.beatShift?.processSample(dryLeft, dryRight);
          wetLeft = this.beatShift?.wetLeft ?? dryLeft;
          wetRight = this.beatShift?.wetRight ?? dryRight;
        } else if (this.algorithm === "reverse-delay") {
          this.reverseDelay?.processSample(dryLeft, dryRight);
          wetLeft = this.reverseDelay?.wetLeft ?? 0;
          wetRight = this.reverseDelay?.wetRight ?? 0;
        } else if (this.algorithm === "reverse-reverb") {
          this.reverseReverb?.processSample(dryLeft, dryRight);
          wetLeft = this.reverseReverb?.wetLeft ?? 0;
          wetRight = this.reverseReverb?.wetRight ?? 0;
        } else if (this.algorithm === "auto-riff") {
          this.autoRiff?.processStereoSample(dryLeft, dryRight, this.currentAudioFrame + frame);
          wetLeft = dryLeft;
          wetRight = dryRight;
        } else if (this.algorithm === "hrm-auto") {
          this.hrmAuto?.processSample((dryLeft + dryRight) * 0.5, this.currentAudioFrame + frame);
          wetLeft = dryLeft;
          wetRight = dryRight;
        } else if (this.algorithm === "robot") {
          this.robot?.processStereoSample(dryLeft, dryRight, this.currentAudioFrame + frame);
          wetLeft = this.robot?.psolaOutputSample ?? 0;
          wetRight = wetLeft;
        } else if (this.algorithm === "pattern-slicer") {
          this.patternSlicer?.processSample(dryLeft, dryRight);
          wetLeft = this.patternSlicer?.wetLeft ?? dryLeft;
          wetRight = this.patternSlicer?.wetRight ?? dryRight;
        } else if (this.algorithm === "step-slicer") {
          this.stepSlicer?.processSample(dryLeft, dryRight);
          wetLeft = this.stepSlicer?.wetLeft ?? dryLeft;
          wetRight = this.stepSlicer?.wetRight ?? dryRight;
        } else if (this.algorithm === "stereo-enhance") {
          this.processStereoEnhance(dryLeft, dryRight);
          wetLeft = this.stereoWetLeft;
          wetRight = this.stereoWetRight;
        } else if (this.algorithm === "lo-fi") {
          this.loFi?.process(dryLeft, dryRight);
          wetLeft = this.loFi?.wetLeft ?? 0;
          wetRight = this.loFi?.wetRight ?? 0;
        } else if (this.algorithm === "eq") {
          this.equalizer?.process(dryLeft, dryRight);
          wetLeft = this.equalizer?.outputLeft ?? dryLeft;
          wetRight = this.equalizer?.outputRight ?? dryRight;
        } else if (this.algorithm === "manual-pan") {
          this.processManualPan(dryLeft, dryRight, monoManualPanInput);
          wetLeft = this.manualPanWetLeft;
          wetRight = this.manualPanWetRight;
        } else if (this.algorithm === "tape-echo") {
          this.tapeEcho?.processSample(dryLeft, dryRight);
          wetLeft = this.tapeEcho?.wetOutputLeft ?? dryLeft;
          wetRight = this.tapeEcho?.wetOutputRight ?? dryRight;
        } else if (this.algorithm === "twist") {
          this.twist?.processSample(dryLeft, dryRight);
          wetLeft = this.twist?.wetOutputLeft ?? 0;
          wetRight = this.twist?.wetOutputRight ?? 0;
        } else if (this.algorithm === "granular-delay") {
          this.granularDelay?.processSample(dryLeft, dryRight);
          wetLeft = this.granularDelay?.wetOutputLeft ?? 0;
          wetRight = this.granularDelay?.wetOutputRight ?? 0;
        } else if (this.algorithm === "radio") {
          this.radio?.processSample(dryLeft, dryRight);
          wetLeft = this.radio?.wetLeft ?? dryLeft;
          wetRight = this.radio?.wetRight ?? dryRight;
        } else if (this.algorithm === "vibrato") {
          this.vibrato?.processSample(dryLeft, dryRight);
          wetLeft = this.vibrato?.wetLeft ?? 0;
          wetRight = this.vibrato?.wetRight ?? 0;
        } else if (this.algorithm === "sustainer") {
          this.sustainer?.processSample(dryLeft, dryRight);
          wetLeft = this.sustainer?.outputLeft ?? dryLeft;
          wetRight = this.sustainer?.outputRight ?? dryRight;
        } else if (this.algorithm === "preamp") {
          this.preamp?.processSample(dryLeft, dryRight);
          wetLeft = this.preamp?.outputLeft ?? dryLeft;
          wetRight = this.preamp?.outputRight ?? dryRight;
        } else if (this.algorithm === "synth") {
          this.synth?.processSample(dryLeft, dryRight);
          wetLeft = this.synth?.outputLeft ?? dryLeft;
          wetRight = this.synth?.outputRight ?? dryRight;
        } else if (this.algorithm === "g2b") {
          this.g2b?.processSample(dryLeft, dryRight);
          wetLeft = this.g2b?.outputLeft ?? dryLeft;
          wetRight = this.g2b?.outputRight ?? dryRight;
        } else if (this.algorithm === "vocoder") {
          this.vocoder?.processSample(dryLeft, dryRight);
          wetLeft = this.vocoder?.outputLeft ?? 0;
          wetRight = this.vocoder?.outputRight ?? 0;
        } else if (this.algorithm === "electric") {
          this.electric?.processSample(dryLeft, dryRight);
          wetLeft = this.electric?.outputLeft ?? dryLeft;
          wetRight = this.electric?.outputRight ?? dryRight;
        } else if (this.algorithm === "osc-voc") {
          this.oscVoc?.processSample(dryLeft, dryRight);
          wetLeft = this.oscVoc?.outputLeft ?? 0;
          wetRight = this.oscVoc?.outputRight ?? 0;
        } else if (this.algorithm === "osc-bot") {
          const modulator = (dryLeft + dryRight) * 0.5;
          const wet = this.oscBot?.processSample(modulator) ?? 0;
          wetLeft = wet;
          wetRight = wet;
        } else if (this.algorithm === "slow-gear") {
          const envelope = this.slowGear?.processSample(dryLeft, dryRight) ?? 1;
          wetLeft = dryLeft * envelope;
          wetRight = dryRight * envelope;
        } else if (this.algorithm === "isolator") {
          this.isolator?.processSample(dryLeft, dryRight);
          wetLeft = this.isolator?.outputLeft ?? dryLeft;
          wetRight = this.isolator?.outputRight ?? dryRight;
        } else if (this.algorithm === "panning-delay") {
          this.panningDelay?.processSample(dryLeft, dryRight);
          wetLeft = this.panningDelay?.wetOutputLeft ?? 0;
          wetRight = this.panningDelay?.wetOutputRight ?? 0;
        } else if (this.algorithm === "mod-delay") {
          this.modDelay?.processSample(dryLeft, dryRight);
          wetLeft = this.modDelay?.wetLeft ?? 0;
          wetRight = this.modDelay?.wetRight ?? 0;
        } else {
          wetLeft = this.processEffectSample(dryLeft, 0);
          wetRight = this.processEffectSample(dryRight, 1);
        }
        if (!Number.isFinite(wetLeft)) {
          wetLeft = 0;
          this.nonFiniteOutputSamples += 1;
        }
        if (!Number.isFinite(wetRight)) {
          wetRight = 0;
          this.nonFiniteOutputSamples += 1;
        }
        if (this.algorithm === "gate-reverb") {
          wetLeft *= this.gateGain;
          wetRight *= this.gateGain;
        }
        let mixedLeft = mixDryLeft * wetDryGain + wetLeft * wetGain;
        let mixedRight = mixDryRight * wetDryGain + wetRight * wetGain;
        const bypassPosition = this.bypassMix.next();
        if (bypassPosition >= 1) {
          mixedLeft = dryLeft;
          mixedRight = dryRight;
        } else {
          if (bypassPosition !== this.cachedBypassPosition) {
            this.cachedBypassPosition = bypassPosition;
            this.cachedBypassActiveGain = equalPowerFadeOutGain(bypassPosition);
            this.cachedBypassGain = equalPowerFadeInGain(bypassPosition);
          }
          const activeGain = this.cachedBypassActiveGain;
          const bypassGain = this.cachedBypassGain;
          mixedLeft = mixedLeft * activeGain + dryLeft * bypassGain;
          mixedRight = mixedRight * activeGain + dryRight * bypassGain;
        }
        if ((this.algorithm === "beat-shift" || this.algorithm === "vinyl-flick") && bypassPosition >= 1) {
          if (frame < outputLeftLength && outputLeft) {
            outputLeft[frame] = frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0;
          }
          if (frame < outputRightLength && outputRight) {
            outputRight[frame] = monoAutoPanInput || monoManualPanInput || monoStereoEnhanceInput || inputIsMono ? frame < inputLeftLength ? inputLeft?.[frame] ?? 0 : 0 : frame < inputRightLength ? inputRight?.[frame] ?? 0 : 0;
          }
          continue;
        }
        if (this.algorithm === "ring-mod") {
          this.phase += this.phaseStep;
          if (this.phase >= TWO_PI10) this.phase -= TWO_PI10;
        }
        if (this.algorithm === "chorus") {
          this.chorusPhase += this.chorusPhaseStep;
          if (this.chorusPhase >= TWO_PI10) this.chorusPhase -= TWO_PI10;
        }
        if (this.algorithm === "phaser") {
          this.phaserPhase += this.phaserPhaseStep;
          if (this.phaserPhase >= TWO_PI10) this.phaserPhase -= TWO_PI10;
        }
        if (this.algorithm === "tremolo") {
          this.tremoloPhase += this.tremoloPhaseStep;
          if (this.tremoloPhase >= 1) this.tremoloPhase -= 1;
        }
        if (this.algorithm === "auto-pan") {
          this.autoPanPhase += this.autoPanPhaseStep;
          if (this.autoPanPhase >= 1) this.autoPanPhase -= 1;
        }
        if (this.algorithm === "slow-gear") {
          mixedLeft = clamp22(mixedLeft, -4, 4);
          mixedRight = clamp22(mixedRight, -4, 4);
        }
        if (!Number.isFinite(mixedLeft)) {
          mixedLeft = 0;
          this.nonFiniteOutputSamples += 1;
        }
        if (!Number.isFinite(mixedRight)) {
          mixedRight = 0;
          this.nonFiniteOutputSamples += 1;
        }
        if (Math.abs(mixedLeft) < MIN_STATE_MAGNITUDE) mixedLeft = 0;
        if (Math.abs(mixedRight) < MIN_STATE_MAGNITUDE) mixedRight = 0;
        if (frame < outputLeftLength && outputLeft) outputLeft[frame] = mixedLeft;
        if (frame < outputRightLength && outputRight) outputRight[frame] = mixedRight;
      }
      this.framesProcessed += frames;
      this.currentAudioFrame += frames;
    }
    reset() {
      this.controlsSteady = false;
      this.controlSmoothersSettled = false;
      this.controlSettleScanCountdown = 0;
      this.filterLeft.reset();
      this.filterRight.reset();
      for (let index = 0; index < this.fdnBuffers.length; index += 1) {
        this.fdnBuffers[index]?.fill(0);
        this.fdnWriteIndices[index] = 0;
        this.delayDampingStates[index] = 0;
      }
      this.delayModPhases.fill(0);
      this.earlyBuffers[0]?.fill(0);
      this.earlyBuffers[1]?.fill(0);
      this.earlyWriteIndices.fill(0);
      this.dcBlockInput.fill(0);
      this.dcBlockOutput.fill(0);
      this.upsampleHistory.fill(0);
      this.upsampleWriteIndices.fill(0);
      this.previousDrivenInput.fill(0);
      this.distortionPreviousPrimitive.fill(0);
      this.distortionPrimitiveValid.fill(0);
      this.waveshapedHistory.fill(0);
      this.waveshapedWriteIndices.fill(0);
      this.dryDelayBuffers[0]?.fill(0);
      this.dryDelayBuffers[1]?.fill(0);
      this.dryDelayWriteIndices.fill(0);
      this.flangerBuffers[0]?.fill(0);
      this.flangerBuffers[1]?.fill(0);
      this.flangerWriteIndices.fill(0);
      this.flangerPhases[0] = 0;
      this.flangerPhases[1] = Math.PI;
      this.flangerFeedbackStates.fill(0);
      this.dynamicsPeakEnvelope = 0;
      this.dynamicsRmsMeanSquare = 0;
      this.dynamicsGain = 1;
      this.gateDetectorEnvelope = 0;
      this.gateHoldRemainingSamples = 0;
      this.gateGain = 0;
      this.delayWriteIndices.fill(0);
      this.delayToneStates.fill(0);
      this.delayBuffers[0]?.fill(0);
      this.delayBuffers[1]?.fill(0);
      for (let index = 0; index < this.chorusBuffers.length; index += 1) this.chorusBuffers[index]?.fill(0);
      this.chorusWriteIndices.fill(0);
      this.chorusFeedbackStates.fill(0);
      this.chorusPhase = 0;
      this.phaserInputStates.fill(0);
      this.phaserOutputStates.fill(0);
      this.phaserFeedbackStates.fill(0);
      this.phaserPhase = 0;
      this.tremoloPhase = 0;
      this.tremoloWaveformOld = this.tremoloWaveformTarget;
      this.tremoloWaveformBlend.reset(1);
      this.tremoloWaveformBlendValue = 1;
      this.autoPanPhase = 0;
      this.autoPanWaveformOld = this.autoPanWaveformTarget;
      this.autoPanWaveformBlend.reset(1);
      this.autoPanWaveformBlendValue = 1;
      this.stereoLowpassState = 0;
      this.stereoAllpass1Input = 0;
      this.stereoAllpass1Output = 0;
      this.stereoAllpass2Input = 0;
      this.stereoAllpass2Output = 0;
      this.stereoWetLeft = 0;
      this.stereoWetRight = 0;
      this.distortionModeOld = this.distortionModeTarget;
      this.distortionModeBlend.reset(1);
      this.phase = 0;
      this.controlUpdateCountdown = 0;
      this.beatRepeat?.reset();
      this.roll?.reset();
      this.freeze?.reset();
      this.warp?.reset();
      this.beatScatter?.reset();
      this.beatShift?.reset();
      this.reverseDelay?.reset();
      this.reverseReverb?.reset();
      this.autoRiff?.reset();
      this.hrmAuto?.reset();
      this.robot?.reset();
      this.patternSlicer?.reset();
      this.stepSlicer?.reset();
      this.loFi?.reset();
      this.equalizer?.reset();
      this.tapeEcho?.reset();
      this.twist?.reset();
      this.granularDelay?.reset();
      this.radio?.reset();
      this.vibrato?.reset();
      this.sustainer?.reset();
      this.preamp?.reset();
      this.synth?.reset();
      this.g2b?.reset();
      this.vocoder?.reset();
      this.electric?.reset();
      this.oscVoc?.reset();
      this.oscBot?.reset();
      this.slowGear?.reset();
      this.isolator?.reset();
      this.vinylFlick?.reset();
      this.panningDelay?.reset();
      this.modDelay?.reset();
      this.manualPanPosition.reset();
      this.manualPanWetLeft = 0;
      this.manualPanWetRight = 0;
    }
    advanceControls() {
      if (this.settledControlFastPathEnabled && this.controlsSteady) {
        if (this.controlUpdateCountdown <= 0) {
          this.refreshControlDependentCoefficients();
          this.controlUpdateCountdown = 15;
        } else {
          this.controlUpdateCountdown -= 1;
        }
        return;
      }
      const refreshedCoefficients = this.controlUpdateCountdown <= 0;
      this.currentControls[0] = this.cutoff.next();
      this.currentControls[1] = this.q.next();
      this.currentControls[2] = this.wet.next();
      this.currentControls[3] = this.decaySeconds.next();
      this.currentControls[4] = this.dampingHz.next();
      this.currentControls[5] = this.ringModHz.next();
      this.currentControls[6] = this.ringModDepth.next();
      this.currentControls[36] = this.ringModWaveform.next();
      this.currentControls[7] = this.driveDb.next();
      this.currentControls[8] = this.outputDb.next();
      this.currentControls[9] = this.flangerDelayMs.next();
      this.currentControls[10] = this.flangerDepth.next();
      this.currentControls[11] = this.flangerRateHz.next();
      this.currentControls[12] = this.flangerFeedback.next();
      this.currentControls[13] = this.dynamicsThreshold.next();
      this.currentControls[14] = this.dynamicsRatio.next();
      this.currentControls[15] = this.dynamicsKnee.next();
      this.currentControls[16] = this.dynamicsAttackMs.next();
      this.currentControls[17] = this.dynamicsReleaseMs.next();
      this.currentControls[18] = this.delayTimeMs.next();
      this.currentControls[19] = this.delayFeedback.next();
      this.currentControls[20] = this.delayToneHz.next();
      this.currentControls[21] = this.chorusDelayMs.next();
      this.currentControls[22] = this.chorusRateHz.next();
      this.currentControls[23] = this.chorusDepthMs.next();
      this.currentControls[24] = this.chorusFeedback.next();
      this.currentControls[25] = this.chorusToneHz.next();
      this.currentControls[26] = this.phaserRateHz.next();
      this.currentControls[27] = this.phaserDepth.next();
      this.currentControls[28] = this.phaserFeedback.next();
      this.currentControls[29] = this.tremoloRateHz.next();
      this.currentControls[30] = this.tremoloDepth.next();
      this.tremoloWaveformBlendValue = this.tremoloWaveformBlend.next();
      this.currentControls[31] = this.autoPanRateHz.next();
      this.currentControls[32] = this.autoPanDepth.next();
      this.autoPanWaveformBlendValue = this.autoPanWaveformBlend.next();
      this.currentControls[33] = this.stereoWidth.next();
      this.currentControls[34] = this.stereoLowMonoCutoffHz.next();
      this.currentControls[35] = this.stereoDecorrelation.next();
      if (this.algorithm === "distortion") {
        this.driveLinear = Math.pow(10, (this.currentControls[7] ?? 18) / 20);
        this.outputLinear = Math.pow(10, (this.currentControls[8] ?? 0) / 20);
      } else if (this.algorithm === "dynamics" || this.algorithm === "delay") {
        this.outputLinear = Math.pow(10, (this.currentControls[8] ?? 0) / 20);
      }
      if (refreshedCoefficients) {
        this.refreshControlDependentCoefficients();
        this.controlUpdateCountdown = 15;
      } else {
        this.controlUpdateCountdown -= 1;
      }
      if (this.algorithm === "ring-mod") this.phaseStep = TWO_PI10 * (this.currentControls[5] ?? 440) / this.sampleRate;
      if (this.algorithm === "chorus") this.chorusPhaseStep = TWO_PI10 * (this.currentControls[22] ?? CHORUS_DEFAULT_RATE_HZ) / this.sampleRate;
      if (this.algorithm === "phaser") this.phaserPhaseStep = TWO_PI10 * (this.currentControls[26] ?? PHASER_DEFAULT_RATE_HZ) / this.sampleRate;
      if (this.algorithm === "tremolo") this.tremoloPhaseStep = (this.currentControls[29] ?? TREMOLO_DEFAULT_RATE_HZ) / this.sampleRate;
      if (this.algorithm === "auto-pan") this.autoPanPhaseStep = (this.currentControls[31] ?? AUTO_PAN_DEFAULT_RATE_HZ) / this.sampleRate;
      if (this.controlSettleScanCountdown <= 0) {
        this.controlSettleScanCountdown = 15;
        if (this.advanceControlSmoothersSettled()) this.controlSmoothersSettled = true;
      } else {
        this.controlSettleScanCountdown -= 1;
      }
      if (this.controlSmoothersSettled && refreshedCoefficients) this.controlsSteady = true;
    }
    refreshControlDependentCoefficients() {
      const cutoffHz = this.currentControls[0] ?? 1200;
      const resonanceQ = this.currentControls[1] ?? Math.SQRT1_2;
      if (this.algorithm === "lpf" || this.algorithm === "bpf" || this.algorithm === "hpf") {
        this.filterLeft.setParameters(cutoffHz, resonanceQ);
        this.filterRight.setParameters(cutoffHz, resonanceQ);
      } else if (this.algorithm === "reverb" || this.algorithm === "gate-reverb") {
        this.refreshTimeVariantCoefficients(this.currentControls[3] ?? 2.4, this.currentControls[4] ?? 9e3);
      } else if (this.algorithm === "dynamics") {
        this.dynamicsAttackAlpha = Math.exp(-1 / (Math.max(0.1, this.currentControls[16] ?? DYNAMICS_DEFAULT_ATTACK_MS) * 1e-3 * this.sampleRate));
        this.dynamicsReleaseAlpha = Math.exp(-1 / (Math.max(5, this.currentControls[17] ?? DYNAMICS_DEFAULT_RELEASE_MS) * 1e-3 * this.sampleRate));
      } else if (this.algorithm === "delay") {
        this.delayToneAlpha = 1 - Math.exp(-TWO_PI10 * Math.min(this.currentControls[20] ?? DELAY_DEFAULT_TONE_HZ, this.sampleRate * 0.499) / this.sampleRate);
      } else if (this.algorithm === "chorus") {
        this.chorusToneAlpha = 1 - Math.exp(-TWO_PI10 * Math.min(this.currentControls[25] ?? CHORUS_DEFAULT_TONE_HZ, this.sampleRate * 0.499) / this.sampleRate);
      } else if (this.algorithm === "stereo-enhance") {
        this.refreshStereoEnhanceCoefficients(this.currentControls[34] ?? 120);
      }
    }
    advanceControlSmoothersSettled() {
      return this.cutoff.isSettled && this.q.isSettled && this.wet.isSettled && this.decaySeconds.isSettled && this.dampingHz.isSettled && this.ringModHz.isSettled && this.ringModDepth.isSettled && this.ringModWaveform.isSettled && this.driveDb.isSettled && this.outputDb.isSettled && this.flangerDelayMs.isSettled && this.flangerDepth.isSettled && this.flangerRateHz.isSettled && this.flangerFeedback.isSettled && this.dynamicsThreshold.isSettled && this.dynamicsRatio.isSettled && this.dynamicsKnee.isSettled && this.dynamicsAttackMs.isSettled && this.dynamicsReleaseMs.isSettled && this.delayTimeMs.isSettled && this.delayFeedback.isSettled && this.delayToneHz.isSettled && this.chorusDelayMs.isSettled && this.chorusRateHz.isSettled && this.chorusDepthMs.isSettled && this.chorusFeedback.isSettled && this.chorusToneHz.isSettled && this.phaserRateHz.isSettled && this.phaserDepth.isSettled && this.phaserFeedback.isSettled && this.tremoloRateHz.isSettled && this.tremoloDepth.isSettled && this.autoPanRateHz.isSettled && this.autoPanDepth.isSettled && this.stereoWidth.isSettled && this.stereoLowMonoCutoffHz.isSettled && this.stereoDecorrelation.isSettled && this.tremoloWaveformBlendValue === 1 && this.autoPanWaveformBlendValue === 1;
    }
    /** Stereo-linked gate control for the FDN8 return; allocated state is scalar-only. */
    updateGateReverbEnvelope(left, right) {
      const linkedPeak = Math.max(Math.abs(left), Math.abs(right));
      if (linkedPeak >= this.gateDetectorEnvelope) {
        this.gateDetectorEnvelope = linkedPeak;
      } else {
        const detectorRelease = Math.exp(-1 / (GATE_REVERB_DETECTOR_RELEASE_MS * 1e-3 * this.sampleRate));
        this.gateDetectorEnvelope *= detectorRelease;
      }
      const threshold = Math.pow(10, this.gateThresholdDb.next() / 20);
      const holdSamples = Math.max(1, Math.round(this.gateHoldMs.next() * 1e-3 * this.sampleRate));
      const releaseMs = this.gateReleaseMs.next();
      const closeThreshold = threshold * GATE_REVERB_HYSTERESIS_RATIO;
      if (this.gateDetectorEnvelope >= threshold) {
        this.gateGain = 1;
        this.gateHoldRemainingSamples = holdSamples;
      } else if (this.gateDetectorEnvelope >= closeThreshold && this.gateGain > 0) {
        this.gateHoldRemainingSamples = holdSamples;
      } else if (this.gateHoldRemainingSamples > 0) {
        this.gateHoldRemainingSamples -= 1;
      } else if (this.gateGain > 0) {
        const releaseCoefficient = Math.exp(
          -(GATE_REVERB_RELEASE_DB * Math.LN10 / 20) / (Math.max(10, releaseMs) * 1e-3 * this.sampleRate)
        );
        this.gateGain *= releaseCoefficient;
        if (this.gateGain < 1e-4) this.gateGain = 0;
      }
    }
    requestTremoloWaveform(waveform) {
      if (waveform === this.tremoloWaveformTarget) return;
      this.tremoloWaveformOld = this.tremoloWaveformTarget;
      this.tremoloWaveformTarget = waveform;
      this.tremoloWaveformBlend.reset(0);
      this.tremoloWaveformBlend.setTarget(1, Math.max(1, Math.round(this.sampleRate * 0.02)));
    }
    requestAutoPanWaveform(waveform) {
      if (waveform === this.autoPanWaveformTarget) return;
      this.autoPanWaveformOld = this.autoPanWaveformTarget;
      this.autoPanWaveformTarget = waveform;
      this.autoPanWaveformBlend.reset(0);
      this.autoPanWaveformBlend.setTarget(1, Math.max(1, Math.round(this.sampleRate * 0.02)));
    }
    requestDistortionMode(mode) {
      if (mode === this.distortionModeTarget) return;
      this.distortionPrimitiveValid.fill(0);
      this.distortionModeOld = this.distortionModeTarget;
      this.distortionModeTarget = mode;
      this.distortionModeBlend.reset(0);
      this.distortionModeBlend.setTarget(1, DISTORTION_MODE_CROSSFADE_OVERSAMPLED_SAMPLES);
    }
    refreshTimeVariantCoefficients(decaySeconds, dampingHz) {
      const cutoff = clamp22(dampingHz, 200, this.sampleRate * 0.499);
      const alpha = 1 - Math.exp(-TWO_PI10 * cutoff / this.sampleRate);
      for (let index = 0; index < 16; index += 1) {
        const lineSamples = this.delayLengths[index] ?? 1;
        this.delayFeedbackGains[index] = Math.pow(10, -3 * lineSamples / (Math.max(0.1, decaySeconds) * this.sampleRate));
        this.dampingAlpha[index] = alpha;
      }
    }
    /** Recomputed outside the inner DSP path when the smoothed cutoff moves. */
    refreshStereoEnhanceCoefficients(lowMonoCutoffHz) {
      const nyquist = this.sampleRate * 0.499;
      const cutoff = clamp22(lowMonoCutoffHz, 20, Math.min(1e3, nyquist));
      this.stereoLowpassAlpha = 1 - Math.exp(-TWO_PI10 * cutoff / this.sampleRate);
      this.stereoAllpass1Coefficient = firstOrderAllpassCoefficient(Math.min(650, this.sampleRate * 0.12), this.sampleRate);
      this.stereoAllpass2Coefficient = firstOrderAllpassCoefficient(Math.min(2300, this.sampleRate * 0.36), this.sampleRate);
    }
    /** M/S width with LF mono protection and a phase-decorrelated side path. */
    processStereoEnhance(inputLeft, inputRight) {
      const mid = 0.5 * (inputLeft + inputRight);
      const side = 0.5 * (inputLeft - inputRight);
      this.stereoLowpassState += this.stereoLowpassAlpha * (side - this.stereoLowpassState);
      const highSide = side - this.stereoLowpassState;
      const allpass1 = -this.stereoAllpass1Coefficient * highSide + this.stereoAllpass1Input + this.stereoAllpass1Coefficient * this.stereoAllpass1Output;
      this.stereoAllpass1Input = highSide;
      this.stereoAllpass1Output = allpass1;
      const allpass2 = -this.stereoAllpass2Coefficient * allpass1 + this.stereoAllpass2Input + this.stereoAllpass2Coefficient * this.stereoAllpass2Output;
      this.stereoAllpass2Input = allpass1;
      this.stereoAllpass2Output = allpass2;
      const decorrelation = this.currentControls[35] ?? 0.25;
      const width = this.currentControls[33] ?? 1;
      let outputSide = (highSide + decorrelation * (allpass2 - highSide)) * width;
      if (width > 1) {
        const sideLimit = Math.abs(mid);
        if (Math.abs(outputSide) > sideLimit) outputSide = outputSide < 0 ? -sideLimit : sideLimit;
      }
      this.stereoWetLeft = mid + outputSide;
      this.stereoWetRight = mid - outputSide;
    }
    /** Static equal-power pan for mono sources; smooth balance for stereo input. */
    processManualPan(inputLeft, inputRight, monoInput) {
      const position = clamp22(this.manualPanPosition.next(), -1, 1);
      const tablePosition = (position + 1) * 1024;
      const index = Math.min(2047, Math.floor(tablePosition));
      const fraction = tablePosition - index;
      const leftStart = this.manualPanLeftTable[index] ?? 0.707;
      const rightStart = this.manualPanRightTable[index] ?? 0.707;
      const leftGain = leftStart + ((this.manualPanLeftTable[index + 1] ?? 0) - leftStart) * fraction;
      const rightGain = rightStart + ((this.manualPanRightTable[index + 1] ?? 0) - rightStart) * fraction;
      if (monoInput) {
        this.manualPanWetLeft = inputLeft * leftGain;
        this.manualPanWetRight = inputLeft * rightGain;
      } else if (position > 0) {
        this.manualPanWetLeft = inputLeft * leftGain * Math.SQRT2;
        this.manualPanWetRight = inputRight;
      } else if (position < 0) {
        this.manualPanWetLeft = inputLeft;
        this.manualPanWetRight = inputRight * rightGain * Math.SQRT2;
      } else {
        this.manualPanWetLeft = inputLeft;
        this.manualPanWetRight = inputRight;
      }
    }
    processEffectSample(input, channel) {
      switch (this.algorithm) {
        case "lpf":
          if (channel === 0) {
            this.filterLeft.processSample(input);
            return this.filterLeft.lowpass;
          }
          this.filterRight.processSample(input);
          return this.filterRight.lowpass;
        case "bpf":
          if (channel === 0) {
            this.filterLeft.processSample(input);
            return this.filterLeft.bandpass;
          }
          this.filterRight.processSample(input);
          return this.filterRight.bandpass;
        case "hpf":
          if (channel === 0) {
            this.filterLeft.processSample(input);
            return this.filterLeft.highpass;
          }
          this.filterRight.processSample(input);
          return this.filterRight.highpass;
        case "ring-mod":
          return this.processRingMod(input, channel);
        case "flanger":
          return this.processFlanger(input, channel);
        case "dynamics":
          return input * this.dynamicsGain;
        case "delay":
          return this.processDelay(input, channel);
        case "mod-delay":
          return input;
        case "chorus":
          return this.processChorus(input, channel);
        case "phaser":
          return this.processPhaser(input, channel);
        case "tremolo":
          return this.processTremolo(input);
        case "auto-pan":
          return input;
        case "reverb":
        case "gate-reverb":
          return this.processReverb(input, channel);
        case "distortion":
          return this.processDistortionSample(input, channel);
        case "beat-repeat":
          return 0;
        case "roll":
          return input;
        case "freeze":
          return input;
        case "warp":
          return input;
        case "beat-scatter":
          return input;
        case "beat-shift":
          return input;
        case "reverse-delay":
          return input;
        case "reverse-reverb":
          return input;
        case "pattern-slicer":
          return input;
        case "step-slicer":
          return input;
        case "stereo-enhance":
          return input;
        case "lo-fi":
          return input;
        case "eq":
          return input;
        case "manual-pan":
          return input;
        case "tape-echo":
          return input;
        case "twist":
          return input;
        case "granular-delay":
          return input;
        case "radio":
          return input;
        case "vibrato":
          return input;
        case "sustainer":
          return input;
        case "slow-gear":
          return input;
        case "isolator":
          return input;
        case "vinyl-flick":
          return input;
        case "preamp":
          return input;
        case "synth":
          return input;
        case "g2b":
          return input;
        case "vocoder":
          return input;
        case "electric":
          return input;
        case "osc-voc":
          return input;
        case "osc-bot":
          return input;
        case "auto-riff":
          return input;
        case "hrm-auto":
          return input;
        case "robot":
          return input;
        case "panning-delay":
          return input;
      }
    }
    processDistortionDryDelay(input, channel) {
      const buffer = this.dryDelayBuffers[channel];
      const index = this.dryDelayWriteIndices[channel] ?? 0;
      if (!buffer) return 0;
      const delayed = buffer[index] ?? 0;
      buffer[index] = input;
      let nextIndex = index + 1;
      if (nextIndex >= DISTORTION_DRY_DELAY_SAMPLES) nextIndex = 0;
      this.dryDelayWriteIndices[channel] = nextIndex;
      return delayed;
    }
    /** 4x zero-stuffed sinc oversampling, ADAA waveshaping and FIR decimation. */
    /** Exact ADAA primitive reuse for a settled mode, never across a mode fade. */
    processCachedDistortionSample(mode, current, previous, channel) {
      const difference = current - previous;
      if (Math.abs(difference) < 1e-8) {
        this.distortionPrimitiveValid[channel] = 0;
        return distortionFunction(mode, 0.5 * (current + previous));
      }
      const currentPrimitive = distortionAntiderivative(mode, current);
      const previousPrimitive = this.distortionPrimitiveValid[channel] ? this.distortionPreviousPrimitive[channel] : distortionAntiderivative(mode, previous);
      this.distortionPreviousPrimitive[channel] = currentPrimitive;
      this.distortionPrimitiveValid[channel] = 1;
      return (currentPrimitive - previousPrimitive) / difference;
    }
    processDistortionSample(input, channel) {
      const inputHistoryBase = channel * DISTORTION_UPSAMPLE_INPUT_HISTORY * 2;
      const waveshapedHistoryBase = channel * DISTORTION_FIR_TAPS * 2;
      const upsampleHistory = this.upsampleHistory;
      const waveshapedHistory = this.waveshapedHistory;
      const interpolation = DISTORTION_FILTERS.interpolation;
      const decimation = DISTORTION_FILTERS.decimation;
      let upWriteIndex = this.upsampleWriteIndices[channel] ?? 0;
      let downWriteIndex = this.waveshapedWriteIndices[channel] ?? 0;
      let output = 0;
      const upWriteOffset = inputHistoryBase + upWriteIndex;
      upsampleHistory[upWriteOffset] = input;
      upsampleHistory[upWriteOffset + DISTORTION_UPSAMPLE_INPUT_HISTORY] = input;
      for (let subSample = 0; subSample < DISTORTION_OVERSAMPLE_FACTOR; subSample += 1) {
        let reconstructed = 0;
        let inputHistoryIndex = upWriteOffset + DISTORTION_UPSAMPLE_INPUT_HISTORY;
        const phaseTapCount = DISTORTION_INTERPOLATION_TAPS_BY_PHASE[subSample];
        for (let inputTap = 0; inputTap < phaseTapCount; inputTap += 1) {
          const coefficientIndex = subSample + DISTORTION_OVERSAMPLE_FACTOR * inputTap;
          reconstructed += upsampleHistory[inputHistoryIndex] * interpolation[coefficientIndex];
          inputHistoryIndex -= 1;
        }
        const driven = reconstructed * this.driveLinear;
        let shaped;
        if (this.distortionModeOld === this.distortionModeTarget) {
          shaped = this.processCachedDistortionSample(this.distortionModeTarget, driven, this.previousDrivenInput[channel] ?? 0, channel);
        } else {
          this.distortionPrimitiveValid[channel] = 0;
          const oldModeOutput = antiderivativeAntialiasSample(
            this.distortionModeOld,
            driven,
            this.previousDrivenInput[channel] ?? 0
          );
          const newModeOutput = antiderivativeAntialiasSample(
            this.distortionModeTarget,
            driven,
            this.previousDrivenInput[channel] ?? 0
          );
          const modePosition = this.distortionModeBlend.next();
          shaped = oldModeOutput * equalPowerFadeOutGain(modePosition) + newModeOutput * equalPowerFadeInGain(modePosition);
          if (this.distortionModeBlend.remainingFrames === 0) {
            this.distortionModeOld = this.distortionModeTarget;
            this.distortionModeBlend.reset(1);
          }
        }
        this.previousDrivenInput[channel] = driven;
        const boundedShaped = Number.isFinite(shaped * this.outputLinear) ? shaped * this.outputLinear : 0;
        const downWriteOffset = waveshapedHistoryBase + downWriteIndex;
        waveshapedHistory[downWriteOffset] = boundedShaped;
        waveshapedHistory[downWriteOffset + DISTORTION_FIR_TAPS] = boundedShaped;
        if (subSample === 0) {
          let decimated = 0;
          let historyIndex = downWriteOffset + DISTORTION_FIR_TAPS;
          for (let tap = 0; tap < DISTORTION_FIR_TAPS; tap += 1) {
            decimated += waveshapedHistory[historyIndex] * decimation[tap];
            historyIndex -= 1;
          }
          output = decimated;
        }
        downWriteIndex += 1;
        if (downWriteIndex >= DISTORTION_FIR_TAPS) downWriteIndex = 0;
      }
      upWriteIndex += 1;
      if (upWriteIndex >= DISTORTION_UPSAMPLE_INPUT_HISTORY) upWriteIndex = 0;
      this.upsampleWriteIndices[channel] = upWriteIndex;
      this.waveshapedWriteIndices[channel] = downWriteIndex;
      return output;
    }
    processRingMod(input, channel) {
      const sineCarrier = Math.sin(this.phase);
      const waveformBlend = this.currentControls[36] ?? 0;
      const carrier = waveformBlend <= 0 ? sineCarrier : waveformBlend >= 1 ? this.ringModTriangle(this.phase, this.currentControls[5] ?? 440) : sineCarrier + (this.ringModTriangle(this.phase, this.currentControls[5] ?? 440) - sineCarrier) * waveformBlend;
      const depth = this.currentControls[6] ?? 1;
      const modulated = input * (1 - depth + depth * carrier);
      const dcBlocked = modulated - (this.dcBlockInput[channel] ?? 0) + this.dcBlockCoefficient * (this.dcBlockOutput[channel] ?? 0);
      this.dcBlockInput[channel] = modulated;
      this.dcBlockOutput[channel] = Math.abs(dcBlocked) < MIN_STATE_MAGNITUDE ? 0 : dcBlocked;
      return this.dcBlockOutput[channel] ?? 0;
    }
    ringModTriangle(phaseRadians, carrierHz) {
      const harmonicBudget = this.sampleRate * 0.45 / Math.max(carrierHz, 1e-9);
      let tier = RING_MOD_TRIANGLE_TABLES.length - 1;
      for (let index = 0; index < RING_MOD_TRIANGLE_HARMONIC_TIERS.length; index += 1) {
        if (RING_MOD_TRIANGLE_HARMONIC_TIERS[index] <= harmonicBudget) {
          tier = index;
          break;
        }
      }
      const table = RING_MOD_TRIANGLE_TABLES[tier];
      const position = phaseRadians / TWO_PI10 * table.length;
      const baseIndex = Math.floor(position);
      const fraction = position - baseIndex;
      const first = table[baseIndex % table.length] ?? 0;
      const second = table[(baseIndex + 1) % table.length] ?? 0;
      return first + (second - first) * fraction;
    }
    /** Smoothed sine-LFO flanger with a four-point Lagrange read head. */
    processFlanger(input, channel) {
      const buffer = this.flangerBuffers[channel];
      if (!buffer || buffer.length < 4) return input;
      const writeIndex = this.flangerWriteIndices[channel] ?? 0;
      const phase = this.flangerPhases[channel] ?? 0;
      const baseDelayMs = this.currentControls[9] ?? FLANGER_DEFAULT_DELAY_MILLISECONDS;
      const depth = this.currentControls[10] ?? FLANGER_DEFAULT_DEPTH;
      const rateHz = this.currentControls[11] ?? FLANGER_DEFAULT_RATE_HZ;
      const feedback = clamp22(this.currentControls[12] ?? FLANGER_DEFAULT_FEEDBACK, -0.95, 0.95);
      const excursionMs = depth * FLANGER_MAX_DEPTH_MILLISECONDS;
      const delayMs = clamp22(
        baseDelayMs + excursionMs * Math.sin(phase),
        FLANGER_MIN_DELAY_MILLISECONDS,
        FLANGER_MAX_DELAY_MILLISECONDS
      );
      const delaySamples = Math.max(2, delayMs * this.sampleRate / 1e3);
      const delayed = readLagrangeFromWriteHead2(buffer, writeIndex, delaySamples);
      const damping = this.flangerFeedbackStates[channel] ?? 0;
      const filteredFeedback = damping + this.flangerDampingAlpha * (delayed - damping);
      this.flangerFeedbackStates[channel] = Number.isFinite(filteredFeedback) ? filteredFeedback : 0;
      const writeSample = input + feedback * Math.tanh(filteredFeedback * 1.5);
      buffer[writeIndex] = Number.isFinite(writeSample) ? clamp22(writeSample, -4, 4) : 0;
      let nextWriteIndex = writeIndex + 1;
      if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
      this.flangerWriteIndices[channel] = nextWriteIndex;
      let nextPhase = phase + TWO_PI10 * rateHz / this.sampleRate;
      if (nextPhase >= TWO_PI10) nextPhase -= TWO_PI10;
      this.flangerPhases[channel] = nextPhase;
      return 0.5 * (input + delayed);
    }
    /** Stereo-linked peak/RMS envelope and the clean-room F08 soft-knee curve. */
    updateDynamicsDetector(left, right) {
      const linkedMagnitude = Math.max(Math.abs(left), Math.abs(right));
      let envelope;
      if (this.dynamicsDetector === "rms") {
        const power = linkedMagnitude * linkedMagnitude;
        const previousPower = this.dynamicsRmsMeanSquare;
        const coefficient = power > previousPower ? this.dynamicsAttackAlpha : this.dynamicsReleaseAlpha;
        this.dynamicsRmsMeanSquare = coefficient * previousPower + (1 - coefficient) * power;
        envelope = Math.sqrt(Math.max(0, this.dynamicsRmsMeanSquare));
      } else {
        const previousEnvelope = this.dynamicsPeakEnvelope;
        const coefficient = linkedMagnitude > previousEnvelope ? this.dynamicsAttackAlpha : this.dynamicsReleaseAlpha;
        this.dynamicsPeakEnvelope = coefficient * previousEnvelope + (1 - coefficient) * linkedMagnitude;
        envelope = this.dynamicsPeakEnvelope;
      }
      const levelDb = 20 * Math.log10(Math.max(DYNAMICS_ENVELOPE_FLOOR, envelope));
      const thresholdDb = this.currentControls[13] ?? DYNAMICS_DEFAULT_THRESHOLD_DB;
      const ratio = Math.max(1, this.currentControls[14] ?? DYNAMICS_DEFAULT_RATIO);
      const kneeDb = Math.max(0, this.currentControls[15] ?? DYNAMICS_DEFAULT_KNEE_DB);
      const slope = 1 / ratio - 1;
      let gainReductionDb = 0;
      if (kneeDb <= 1e-6) {
        if (levelDb > thresholdDb) gainReductionDb = slope * (levelDb - thresholdDb);
      } else {
        const lowerKnee = thresholdDb - kneeDb * 0.5;
        const upperKnee = thresholdDb + kneeDb * 0.5;
        if (levelDb >= upperKnee) {
          gainReductionDb = slope * (levelDb - thresholdDb);
        } else if (levelDb > lowerKnee) {
          const kneePosition = levelDb - lowerKnee;
          gainReductionDb = slope * kneePosition * kneePosition / (2 * kneeDb);
        }
      }
      const gain = Math.pow(10, gainReductionDb / 20) * this.outputLinear;
      this.dynamicsGain = Number.isFinite(gain) ? clamp22(gain, 0, 16) : 0;
    }
    /** Fixed-capacity stereo delay line with smoothed fractional read and feedback. */
    processDelay(input, channel) {
      const buffer = this.delayBuffers[channel];
      if (!buffer || buffer.length < 4) return input;
      const writeIndex = this.delayWriteIndices[channel] ?? 0;
      const delaySamples = Math.max(
        2,
        Math.min(buffer.length - 6, (this.currentControls[18] ?? DELAY_DEFAULT_TIME_MILLISECONDS) * this.sampleRate / 1e3)
      );
      const delayed = readLagrangeFromWriteHead2(buffer, writeIndex, delaySamples);
      const previousTone = this.delayToneStates[channel] ?? 0;
      const filtered = previousTone + this.delayToneAlpha * (delayed - previousTone);
      this.delayToneStates[channel] = Number.isFinite(filtered) ? filtered : 0;
      const feedback = clamp22(this.currentControls[19] ?? DELAY_DEFAULT_FEEDBACK, 0, 0.95);
      const writeSample = input + feedback * Math.tanh(filtered);
      buffer[writeIndex] = Number.isFinite(writeSample) ? clamp22(writeSample, -4, 4) : 0;
      let nextWriteIndex = writeIndex + 1;
      if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
      this.delayWriteIndices[channel] = nextWriteIndex;
      return delayed * this.outputLinear;
    }
    /** Two-to-four decorrelated delay voices per channel, all preallocated. */
    processChorus(input, channel) {
      const voices = this.chorusVoiceCount;
      const baseDelayMs = this.currentControls[21] ?? CHORUS_DEFAULT_DELAY_MILLISECONDS;
      const depthMs = this.currentControls[23] ?? CHORUS_DEFAULT_DEPTH_MILLISECONDS;
      const feedback = clamp22(this.currentControls[24] ?? CHORUS_DEFAULT_FEEDBACK, 0, CHORUS_FEEDBACK_MAX);
      const channelBase = channel * 4;
      let sum = 0;
      for (let voice = 0; voice < voices; voice += 1) {
        const index = channelBase + voice;
        const buffer = this.chorusBuffers[index];
        if (!buffer) continue;
        const writeIndex = this.chorusWriteIndices[index] ?? 0;
        const phase = this.chorusPhase + TWO_PI10 * voice / voices + (channel === 0 ? 0 : Math.PI * 0.5);
        const delayMs = clamp22(
          baseDelayMs + depthMs * Math.sin(phase),
          CHORUS_MIN_DELAY_MILLISECONDS,
          CHORUS_MAX_DELAY_MILLISECONDS
        );
        const delaySamples = Math.max(2, Math.min(buffer.length - 6, delayMs * this.sampleRate / 1e3));
        const delayed = readLagrangeFromWriteHead2(buffer, writeIndex, delaySamples);
        const previousTone = this.chorusFeedbackStates[index] ?? 0;
        const filtered = previousTone + this.chorusToneAlpha * (delayed - previousTone);
        this.chorusFeedbackStates[index] = Number.isFinite(filtered) ? filtered : 0;
        const writeSample = input + feedback * Math.tanh(filtered);
        buffer[writeIndex] = Number.isFinite(writeSample) ? clamp22(writeSample, -4, 4) : 0;
        let nextWriteIndex = writeIndex + 1;
        if (nextWriteIndex >= buffer.length) nextWriteIndex = 0;
        this.chorusWriteIndices[index] = nextWriteIndex;
        sum += delayed;
      }
      return sum / voices;
    }
    /** Four/eight cascaded all-pass sections with a quadrature stereo sweep. */
    processPhaser(input, channel) {
      const depth = clamp22(this.currentControls[27] ?? PHASER_DEFAULT_DEPTH, 0, 1);
      const feedback = clamp22(this.currentControls[28] ?? PHASER_DEFAULT_FEEDBACK, 0, PHASER_FEEDBACK_MAX);
      const phase = this.phaserPhase + (channel === 0 ? 0 : Math.PI * 0.5);
      const sweepPosition = 0.5 + 0.5 * depth * Math.sin(phase);
      const maximumFrequency = Math.min(PHASER_MAX_FREQUENCY_HZ, this.sampleRate * 0.45);
      const baseFrequency = PHASER_MIN_FREQUENCY_HZ * Math.pow(maximumFrequency / PHASER_MIN_FREQUENCY_HZ, sweepPosition);
      const channelOffset = channel * PHASER_MAX_STAGES;
      const feedbackSource = this.phaserFeedbackStates[channel] ?? 0;
      let stageInput = input + feedback * Math.tanh(feedbackSource);
      for (let stage = 0; stage < this.phaserStageCount; stage += 1) {
        const stageScale = 0.72 + stage * 0.08;
        const cutoff = clamp22(baseFrequency * stageScale, 20, maximumFrequency);
        const tangent = Math.tan(Math.PI * cutoff / this.sampleRate);
        const coefficient = (tangent - 1) / (tangent + 1);
        const stateIndex = channelOffset + stage;
        const previousInput = this.phaserInputStates[stateIndex] ?? 0;
        const previousOutput = this.phaserOutputStates[stateIndex] ?? 0;
        const stageOutput = coefficient * stageInput + previousInput - coefficient * previousOutput;
        this.phaserInputStates[stateIndex] = stageInput;
        this.phaserOutputStates[stateIndex] = Number.isFinite(stageOutput) ? stageOutput : 0;
        stageInput = this.phaserOutputStates[stateIndex] ?? 0;
      }
      const previousFeedback = this.phaserFeedbackStates[channel] ?? 0;
      const filteredFeedback = previousFeedback + this.phaserToneAlpha * (stageInput - previousFeedback);
      this.phaserFeedbackStates[channel] = Number.isFinite(filteredFeedback) ? filteredFeedback : 0;
      return 0.5 * (input + stageInput);
    }
    lfoValue(waveform, phase, phaseStep) {
      if (waveform === "sine") return Math.sin(TWO_PI10 * phase);
      if (waveform === "triangle") return 1 - 4 * Math.abs(phase - 0.5);
      let square = phase < 0.5 ? 1 : -1;
      square += polyBlep4(phase, phaseStep);
      const fallingEdgePhase = phase < 0.5 ? phase + 0.5 : phase - 0.5;
      square -= polyBlep4(fallingEdgePhase, phaseStep);
      return clamp22(square, -1, 1);
    }
    /** Stereo-linked amplitude modulation with a click-safe band-limited square LFO. */
    processTremolo(input) {
      const depth = clamp22(this.currentControls[30] ?? TREMOLO_DEFAULT_DEPTH, 0, 1);
      const oldLfo = this.lfoValue(this.tremoloWaveformOld, this.tremoloPhase, this.tremoloPhaseStep);
      const targetLfo = this.lfoValue(this.tremoloWaveformTarget, this.tremoloPhase, this.tremoloPhaseStep);
      const blend = this.tremoloWaveformBlendValue;
      const lfo = oldLfo + (targetLfo - oldLfo) * blend;
      const gain = 1 - depth * 0.5 * (1 - lfo);
      return input * gain;
    }
    /** Equal-power mono pan and stereo mid/side autopan share one bounded LFO. */
    processAutoPan(inputLeft, inputRight, monoInput) {
      const depth = clamp22(this.currentControls[32] ?? AUTO_PAN_DEFAULT_DEPTH, 0, 1);
      const oldLfo = this.lfoValue(this.autoPanWaveformOld, this.autoPanPhase, this.autoPanPhaseStep);
      const targetLfo = this.lfoValue(this.autoPanWaveformTarget, this.autoPanPhase, this.autoPanPhaseStep);
      const blend = this.autoPanWaveformBlendValue;
      const lfo = oldLfo + (targetLfo - oldLfo) * blend;
      const pan = clamp22(depth * lfo, -1, 1);
      const angle = (pan + 1) * Math.PI * 0.25;
      const leftGain = Math.cos(angle);
      const rightGain = Math.sin(angle);
      if (monoInput) {
        this.autoPanWetLeft = inputLeft * leftGain;
        this.autoPanWetRight = inputLeft * rightGain;
        return;
      }
      const mid = 0.5 * (inputLeft + inputRight);
      const side = 0.5 * (inputLeft - inputRight);
      const sideGain = 1 - depth * Math.abs(lfo);
      this.autoPanWetLeft = mid * leftGain * Math.SQRT2 + side * sideGain;
      this.autoPanWetRight = mid * rightGain * Math.SQRT2 - side * sideGain;
    }
    processReverb(input, channel) {
      const lineStart = channel === 0 ? 0 : 8;
      let feedbackSum = 0;
      let outputSum = 0;
      const earlyBuffer = this.earlyBuffers[channel];
      let earlyIndex = this.earlyWriteIndices[channel] ?? 0;
      if (earlyBuffer) earlyBuffer[earlyIndex] = input;
      const earlyCoefficients = channel === 0 ? EARLY_REFLECTION_GAINS_LEFT : EARLY_REFLECTION_GAINS_RIGHT;
      let early = input * (earlyCoefficients[0] ?? 0);
      for (let tap = 1; tap < EARLY_REFLECTION_DELAYS_SECONDS.length; tap += 1) {
        if (!earlyBuffer) continue;
        const delay = this.earlyDelays[tap] ?? 0;
        let readIndex = earlyIndex - delay;
        if (readIndex < 0) readIndex += this.earlyRingLength;
        early += (earlyBuffer[readIndex] ?? 0) * (earlyCoefficients[tap] ?? 0);
      }
      earlyIndex += 1;
      if (earlyIndex >= this.earlyRingLength) earlyIndex = 0;
      this.earlyWriteIndices[channel] = earlyIndex;
      for (let line = 0; line < 8; line += 1) {
        const index = lineStart + line;
        const buffer = this.fdnBuffers[index];
        const writeIndex = this.fdnWriteIndices[index] ?? 0;
        const modulationPhase = this.delayModPhases[index] ?? 0;
        const modulatedDelay = (this.delayLengths[index] ?? 1) + FDN_MODULATION_DEPTH_SAMPLES * Math.sin(modulationPhase);
        const raw = buffer ? readLagrangeFromWriteHead2(buffer, writeIndex, modulatedDelay) : 0;
        let nextModulationPhase = modulationPhase + (this.delayModPhaseSteps[index] ?? 0);
        if (nextModulationPhase >= TWO_PI10) nextModulationPhase -= TWO_PI10;
        this.delayModPhases[index] = nextModulationPhase;
        const damping = this.delayDampingStates[index] ?? 0;
        const alpha = this.dampingAlpha[index] ?? 1;
        const damped = damping + alpha * (raw - damping);
        const dampedState = Math.abs(damped) < MIN_STATE_MAGNITUDE ? 0 : damped;
        this.delayDampingStates[index] = dampedState;
        const feedback = dampedState * (this.delayFeedbackGains[index] ?? 0);
        this.delayReadScratch[index] = feedback;
        feedbackSum += feedback;
        outputSum += dampedState * (line % 2 === 0 ? 1 : -1);
      }
      for (let line = 0; line < 8; line += 1) {
        const index = lineStart + line;
        const buffer = this.fdnBuffers[index];
        if (!buffer) continue;
        const feedback = this.delayReadScratch[index] ?? 0;
        const householderOutput = feedback - HOUSEHOLDER_ROW_SUM_FACTOR * feedbackSum;
        const injectionSign = (line & 1) === 0 ? 1 : -1;
        let next = householderOutput + input * FDN_INJECTION_GAIN * injectionSign;
        if (!Number.isFinite(next) || Math.abs(next) < MIN_STATE_MAGNITUDE) next = 0;
        const writeIndex = this.fdnWriteIndices[index] ?? 0;
        buffer[writeIndex] = next;
        let advancedIndex = writeIndex + 1;
        if (advancedIndex >= buffer.length) advancedIndex = 0;
        this.fdnWriteIndices[index] = advancedIndex;
      }
      const wet = early * EARLY_OUTPUT_GAIN + outputSum * FDN_OUTPUT_GAIN;
      return wet;
    }
  };

  // src/audio/worklet/FxProcessor.ts
  var FallbackFxProcessor = class {
    port = { onmessage: null };
  };
  var fxWorkletGlobals = globalThis;
  var FxProcessorBase = fxWorkletGlobals.AudioWorkletProcessor ?? FallbackFxProcessor;
  function isAlgorithm(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(BROWSER_FX_ALGORITHM_INFO, value);
  }
  var FxProcessor = class extends FxProcessorBase {
    core;
    lastRobotModeRevision = -1;
    constructor(options = {}) {
      super();
      const supplied = options.processorOptions;
      const suppliedAlgorithm = supplied?.algorithm;
      if (!isAlgorithm(suppliedAlgorithm)) {
        const algorithmDescription = suppliedAlgorithm === void 0 ? "missing" : String(suppliedAlgorithm);
        throw new TypeError(`Unsupported Browser FX algorithm: ${algorithmDescription}`);
      }
      const algorithm = suppliedAlgorithm;
      const rate = Number.isFinite(supplied?.sampleRate) ? supplied?.sampleRate : Number.isFinite(fxWorkletGlobals.sampleRate) ? fxWorkletGlobals.sampleRate : 48e3;
      this.core = new BrowserFxDspCore(algorithm, rate, supplied?.parameters, fxWorkletGlobals.currentFrame ?? 0);
      this.core.setBypass(supplied?.bypassed !== false, 0);
      this.port.onmessage = (event) => {
        const message = event.data;
        if (message?.type === "configure") {
          const configureMessage = message;
          if (configureMessage.parameters && typeof configureMessage.parameters === "object") {
            try {
              this.core.setParameters(configureMessage.parameters);
              this.port.postMessage?.({
                type: "configure-ack",
                parameterKeys: Object.keys(configureMessage.parameters)
              });
            } catch (error) {
              this.port.postMessage?.({
                type: "error",
                message: error instanceof Error ? error.message : String(error)
              });
            }
          }
        } else if (message?.type === "set-bypass" && typeof message.value === "boolean") {
          const bypassMessage = message;
          const rampFrames = Number.isFinite(bypassMessage.rampFrames) ? Math.max(0, Math.floor(bypassMessage.rampFrames)) : 128;
          this.core.setBypass(bypassMessage.value, rampFrames);
        } else if (message?.type === "midi-note-on") {
          const noteMessage = message;
          try {
            this.core.scheduleMidiNoteOn(noteMessage.channel, noteMessage.note, noteMessage.velocity, noteMessage.frame);
            this.port.postMessage?.({ type: "midi-event-queued", frame: noteMessage.frame });
          } catch (error) {
            this.port.postMessage?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
          }
        } else if (message?.type === "midi-note-off") {
          const noteMessage = message;
          try {
            this.core.scheduleMidiNoteOff(noteMessage.channel, noteMessage.note, noteMessage.frame);
            this.port.postMessage?.({ type: "midi-event-queued", frame: noteMessage.frame });
          } catch (error) {
            this.port.postMessage?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
          }
        } else if (message?.type === "midi-all-notes-off") {
          const noteMessage = message;
          try {
            this.core.scheduleMidiAllNotesOff(noteMessage.frame);
            this.port.postMessage?.({ type: "midi-event-queued", frame: noteMessage.frame, panic: true });
          } catch (error) {
            this.port.postMessage?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
          }
        } else if (message?.type === "reset") {
          this.core.reset();
        }
      };
    }
    process(inputs, outputs) {
      const inputChannels = inputs[0];
      const outputChannels = outputs[0];
      if (!outputChannels) return true;
      const leftOutput = outputChannels[0] ?? null;
      const rightOutput = outputChannels[1] ?? null;
      const leftInput = inputChannels?.[0] ?? null;
      const rightInput = this.core.algorithm === "auto-pan" ? inputChannels?.[1] ?? null : inputChannels?.[1] ?? (leftInput && rightOutput ? leftInput : null);
      const frames = Math.max(leftOutput?.length ?? 0, rightOutput?.length ?? 0);
      if (Number.isSafeInteger(fxWorkletGlobals.currentFrame)) {
        try {
          this.core.synchronizeFrame(fxWorkletGlobals.currentFrame);
        } catch (error) {
          this.port.postMessage?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (leftOutput || rightOutput) {
        const inputIsMono = !inputChannels || inputChannels.length < 2;
        this.core.processBlock(leftInput, rightInput, leftOutput, rightOutput, frames, inputIsMono);
      }
      while (this.core.tryPopAutoRiffPitchChange()) {
        this.port.postMessage?.({
          type: "auto-riff-pitch",
          frame: this.core.lastAutoRiffPitchFrame,
          semitones: this.core.lastAutoRiffPitchSemitones
        });
      }
      while (this.core.tryPopHrmAutoStateChange()) {
        this.port.postMessage?.({
          type: "hrm-auto-target",
          frame: this.core.lastHrmAutoStateFrame,
          reason: this.core.lastHrmAutoStateReason,
          note: this.core.lastHrmAutoStateNote,
          noteOn: this.core.lastHrmAutoStateNoteOn,
          activeNoteCount: this.core.lastHrmAutoActiveNoteCount,
          voiceCount: this.core.lastHrmAutoVoiceCount,
          target1: this.core.lastHrmAutoTarget1,
          target2: this.core.lastHrmAutoTarget2
        });
      }
      while (this.core.tryPopRobotTargetChange()) {
        this.port.postMessage?.({
          type: "robot-pitch-target",
          frame: this.core.lastRobotTargetFrame,
          semitones: this.core.lastRobotTargetSemitones,
          sourceMidi: this.core.lastRobotTargetSourceMidi,
          targetMidi: this.core.lastRobotTargetMidi,
          sourceHz: this.core.lastRobotTargetHz,
          confidence: this.core.lastRobotTargetConfidence,
          voiced: this.core.lastRobotTargetVoiced
        });
      }
      if (this.core.algorithm === "robot" && this.core.robotModeRevision !== this.lastRobotModeRevision) {
        this.lastRobotModeRevision = this.core.robotModeRevision;
        this.port.postMessage?.({
          type: "robot-mode",
          frame: this.core.lastRobotModeFrame,
          mode: this.core.lastRobotProcessingMode,
          reason: this.core.lastRobotModeReason,
          trackerLatencyFrames: this.core.robotTrackerAcquisitionFrames,
          psolaLatencySamples: this.core.robotPsolaLatencySamples
        });
      }
      for (let channel = 2; channel < outputChannels.length; channel += 1) {
        const output = outputChannels[channel];
        if (!output) continue;
        const input = inputChannels?.[channel];
        const inputLength = input?.length ?? 0;
        for (let frame = 0; frame < output.length; frame += 1) {
          output[frame] = input && frame < inputLength ? input[frame] ?? 0 : 0;
        }
      }
      return true;
    }
  };
  if (typeof fxWorkletGlobals.registerProcessor === "function") {
    fxWorkletGlobals.registerProcessor("rc505-fx-processor", FxProcessor);
  }
})();
