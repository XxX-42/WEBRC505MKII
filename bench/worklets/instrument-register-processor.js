/* Test-only AudioWorklet hook. Load this before the production worklet modules. */
(() => {
  const scope = globalThis;
  if (scope.__rc505BenchRegisterHookInstalled) return;

  const originalRegisterProcessor = scope.registerProcessor;
  if (typeof originalRegisterProcessor !== 'function') {
    throw new Error('The AudioWorklet scope does not expose registerProcessor');
  }

  const META_STRIDE = 26;
  const META = Object.freeze({
    callbacks: 0,
    totalFrames: 1,
    deadlineMisses: 2,
    wrapperDeadlineMisses: 3,
    missingCallbackEstimate: 4,
    missingFrames: 5,
    frameDiscontinuities: 6,
    frameRewinds: 7,
    startGapOverQuantum: 8,
    processDurationOverflow: 9,
    wrapperDurationOverflow: 10,
    gapDurationOverflow: 11,
    callbackErrors: 12,
    instrumentationErrors: 13,
    maxProcessDurationUs: 14,
    maxWrapperDurationUs: 15,
    preflightCallbacks: 16,
    snapshotVersion: 17,
    lastProcessorFrameEnd: 18,
    stopAuthorization: 19,
    processorStopFrame: 20,
    unexpectedTerminationCount: 21,
    coverageCallbacks: 22,
    coverageFrames: 23,
    coverageMissingFrames: 24,
    firstCoverageActiveFrame: 25,
  });

  const CLOCK_PROBE_DELTA_SAMPLES = 4_096;
  const MIN_CLOCK_PROBE_POSITIVE_STEPS = 64;
  const MAX_TIMING_CLOCK_STEP_US = 100;
  let timingClockSource = 'Date.now() fallback';
  let timingClockResolutionUs = 1_000;
  const performanceProbe = {
    objectAvailable: null,
    nowAvailable: null,
    failureReason: null,
  };
  let timingClockProbe = {
    source: timingClockSource,
    monotonic: false,
    performanceObjectAvailable: null,
    performanceNowAvailable: null,
    performanceFailureReason: null,
    probeReadCount: 0,
    deltaSampleCount: 0,
    positiveStepCount: 0,
    zeroStepCount: 0,
    negativeStepCount: 0,
    observedMinPositiveStepUs: null,
    observedMedianPositiveStepUs: null,
    observedP95PositiveStepUs: null,
    resolutionFloorUs: timingClockResolutionUs,
    positiveStepHistogramUs: [],
    passed: false,
  };
  function readClockMilliseconds() {
    try {
      const performanceObject = globalThis.performance;
      performanceProbe.objectAvailable = performanceObject !== undefined && performanceObject !== null;
      if (performanceObject && typeof performanceObject.now === 'function') {
        performanceProbe.nowAvailable = true;
        const value = performanceObject.now();
        if (Number.isFinite(value)) {
          timingClockSource = 'performance.now()';
          return value;
        }
        performanceProbe.failureReason = 'performance.now() returned a non-finite value';
      } else {
        performanceProbe.nowAvailable = false;
        performanceProbe.failureReason = 'performance.now() is unavailable in this AudioWorkletGlobalScope';
      }
    } catch (error) {
      performanceProbe.failureReason = `${error?.name ?? 'Error'}: ${error?.message ?? 'performance.now() failed'}`;
    }
    timingClockSource = 'Date.now() fallback';
    timingClockResolutionUs = 1_000;
    timingClockProbe = {
      ...timingClockProbe,
      source: timingClockSource,
      monotonic: false,
      performanceObjectAvailable: performanceProbe.objectAvailable,
      performanceNowAvailable: performanceProbe.nowAvailable,
      performanceFailureReason: performanceProbe.failureReason,
      resolutionFloorUs: timingClockResolutionUs,
      passed: false,
    };
    return Date.now();
  }

  // Measure actual monotonic clock increments once per AudioWorkletGlobalScope.
  // Keep the full distribution: a single small increment can be an outlier and
  // must not make a heavily quantized clock look suitable for CPU timing.
  function probeTimingClock() {
    const first = readClockMilliseconds();
    const probeSource = timingClockSource;

    let previous = first;
    let zeroStepCount = 0;
    let negativeStepCount = 0;
    let sourceChangedDuringProbe = false;
    const positiveStepsUs = [];
    const histogram = new Map();
    for (let sample = 0; sample < CLOCK_PROBE_DELTA_SAMPLES; sample += 1) {
      const current = readClockMilliseconds();
      if (timingClockSource !== probeSource) {
        sourceChangedDuringProbe = true;
        break;
      }
      const stepUs = (current - previous) * 1_000;
      if (stepUs > 0 && Number.isFinite(stepUs)) {
        positiveStepsUs.push(stepUs);
        const key = Math.round(stepUs * 1_000) / 1_000;
        histogram.set(key, (histogram.get(key) ?? 0) + 1);
      } else if (stepUs === 0) {
        zeroStepCount += 1;
      } else {
        negativeStepCount += 1;
      }
      previous = current;
    }

    positiveStepsUs.sort((left, right) => left - right);
    const quantile = (fraction) => positiveStepsUs.length > 0
      ? positiveStepsUs[Math.max(0, Math.ceil(positiveStepsUs.length * fraction) - 1)]
      : null;
    const minimumStepUs = positiveStepsUs[0] ?? null;
    const medianStepUs = quantile(0.5);
    const p95StepUs = quantile(0.95);
    const positiveStepHistogramUs = [...histogram.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 12)
      .map(([stepUs, count]) => [stepUs, count]);

    // The minimum increment is the observed resolution floor; p95 is a
    // conservative check against clocks whose apparent precision varies.
    if (minimumStepUs !== null) timingClockResolutionUs = minimumStepUs;
    timingClockProbe = {
      source: probeSource,
      monotonic: probeSource === 'performance.now()',
      performanceObjectAvailable: performanceProbe.objectAvailable,
      performanceNowAvailable: performanceProbe.nowAvailable,
      performanceFailureReason: performanceProbe.failureReason,
      probeReadCount: positiveStepsUs.length + zeroStepCount + negativeStepCount + 1,
      deltaSampleCount: positiveStepsUs.length + zeroStepCount + negativeStepCount,
      positiveStepCount: positiveStepsUs.length,
      zeroStepCount,
      negativeStepCount,
      observedMinPositiveStepUs: minimumStepUs,
      observedMedianPositiveStepUs: medianStepUs,
      observedP95PositiveStepUs: p95StepUs,
      resolutionFloorUs: minimumStepUs,
      positiveStepHistogramUs,
      sourceChangedDuringProbe,
      passed: probeSource === 'performance.now()'
        && !sourceChangedDuringProbe
        && negativeStepCount === 0
        && positiveStepsUs.length >= MIN_CLOCK_PROBE_POSITIVE_STEPS
        && p95StepUs !== null
        && p95StepUs <= MAX_TIMING_CLOCK_STEP_US,
    };
  }
  probeTimingClock();

  function getTimingClockReport() {
    return {
      ...timingClockProbe,
      source: timingClockSource,
      monotonic: timingClockSource === 'performance.now()',
      performanceObjectAvailable: performanceProbe.objectAvailable,
      performanceNowAvailable: performanceProbe.nowAvailable,
      performanceFailureReason: performanceProbe.failureReason,
      resolutionFloorUs: timingClockResolutionUs,
    };
  }

  function getLongestChannelLength(groups) {
    let longest = 0;
    if (!groups) return longest;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      if (!group) continue;
      for (let channelIndex = 0; channelIndex < group.length; channelIndex += 1) {
        const channel = group[channelIndex];
        if (channel && channel.length > longest) longest = channel.length;
      }
    }
    return longest;
  }

  function recordCallback(state, startMs, processEndMs, frame, frames, threw) {
    const { slot, sampleRate, meta, blockHistogram, processDurationHistogram,
      wrapperDurationHistogram, startGapHistogram, layout } = state;
    const base = slot * META_STRIDE;
    const timingReliable = timingClockSource === 'performance.now()'
      && timingClockProbe.passed
      && timingClockResolutionUs !== null
      && timingClockResolutionUs <= MAX_TIMING_CLOCK_STEP_US;
    const processUs = timingReliable ? Math.max(0, Math.round((processEndMs - startMs) * 1000)) : 0;
    const quantumUs = frames > 0 ? (frames / sampleRate) * 1e6 : 0;
    let frameGap = 0;

    try {
      if (frames > 0 && frames <= layout.maxBlockFrames) {
        Atomics.add(blockHistogram, slot * layout.blockBins + frames, 1);
      }
      if (timingReliable) {
        if (processUs <= layout.maxDurationUs) {
          Atomics.add(processDurationHistogram, slot * layout.durationBins + processUs, 1);
        } else {
          Atomics.add(meta, base + META.processDurationOverflow, 1);
        }
        Atomics.max(meta, base + META.maxProcessDurationUs, processUs);
        if (processUs > quantumUs) Atomics.add(meta, base + META.deadlineMisses, 1);
      }
      if (state.previousFrame >= 0) {
        const frameDelta = frame - state.previousFrame;
        const frameDifference = frameDelta - state.previousFrames;
        if (frameDifference !== 0) {
          Atomics.add(meta, base + META.frameDiscontinuities, 1);
          if (frameDifference > 0) {
            const missingFrames = frameDifference;
            frameGap = missingFrames;
            const missingCallbacks = state.previousFrames > 0
              ? Math.max(1, Math.floor((frameDelta - 1) / state.previousFrames))
              : 1;
            Atomics.add(meta, base + META.missingFrames, missingFrames);
            Atomics.add(meta, base + META.missingCallbackEstimate, missingCallbacks);
          } else {
            Atomics.add(meta, base + META.frameRewinds, 1);
          }
        }

        if (timingReliable) {
          const elapsedMs = startMs - state.previousStartMs;
          const expectedMs = (frameDelta / sampleRate) * 1000;
          const positiveExcessUs = Math.max(0, Math.round((elapsedMs - expectedMs) * 1000));
          if (positiveExcessUs <= layout.maxDurationUs) {
            Atomics.add(startGapHistogram, slot * layout.durationBins + positiveExcessUs, 1);
          } else {
            Atomics.add(meta, base + META.gapDurationOverflow, 1);
          }
          if (positiveExcessUs > (state.previousFrames / sampleRate) * 1e6) {
            Atomics.add(meta, base + META.startGapOverQuantum, 1);
          }
        }
      }
      state.previousFrame = frame;
      state.previousFrames = frames;
      if (timingReliable) state.previousStartMs = startMs;

      // This captures the callback's production work plus most metric-write cost.
      // The final histogram/max write below is not included, so this is a slight
      // lower bound on total wrapper overhead.
      if (timingReliable) {
        const wrapperUs = Math.max(0, Math.round((readClockMilliseconds() - startMs) * 1000));
        if (wrapperUs <= layout.maxDurationUs) {
          Atomics.add(wrapperDurationHistogram, slot * layout.durationBins + wrapperUs, 1);
        } else {
          Atomics.add(meta, base + META.wrapperDurationOverflow, 1);
        }
        Atomics.max(meta, base + META.maxWrapperDurationUs, wrapperUs);
        if (wrapperUs > quantumUs) Atomics.add(meta, base + META.wrapperDeadlineMisses, 1);
      }
    } catch {
      // Metrics must never turn a test probe failure into a processor failure.
      try { Atomics.add(meta, base + META.instrumentationErrors, 1); } catch { /* ignored */ }
    }
    return { frameGap };
  }

  scope.registerProcessor = function registerProcessorWithBenchMetrics(name, ProcessorConstructor) {
    if (typeof ProcessorConstructor !== 'function') {
      return originalRegisterProcessor.call(scope, name, ProcessorConstructor);
    }

    const originalProcess = ProcessorConstructor.prototype.process;
    if (typeof originalProcess !== 'function') {
      return originalRegisterProcessor.call(scope, name, ProcessorConstructor);
    }

    class InstrumentedProcessor extends ProcessorConstructor {
      constructor(options) {
        super(options);
        const config = options?.processorOptions?.__rc505BenchInstrumentation;
        this.__rc505BenchState = null;
        if (config?.buffer instanceof SharedArrayBuffer && config.layout) {
          const { layout } = config;
          this.__rc505BenchState = {
            slot: config.slot,
            processorName: name,
            sampleRate: config.sampleRate,
            layout,
            meta: new Int32Array(config.buffer, layout.metaByteOffset, layout.metaLength),
            blockHistogram: new Int32Array(config.buffer, layout.blockByteOffset, layout.blockLength),
            processDurationHistogram: new Int32Array(config.buffer, layout.processDurationByteOffset, layout.durationLength),
            wrapperDurationHistogram: new Int32Array(config.buffer, layout.wrapperDurationByteOffset, layout.durationLength),
            startGapHistogram: new Int32Array(config.buffer, layout.startGapByteOffset, layout.durationLength),
            previousFrame: -1,
            previousFrames: 0,
            previousStartMs: 0,
            clockSource: timingClockSource,
            callbackExceptionDetailPosted: false,
          };
          // One ready notification per node, never one message per render quantum.
          this.port.postMessage({
            type: 'rc505-bench-ready', slot: config.slot, processorName: name,
            timingClock: getTimingClockReport(),
          });
        }
      }

      process(inputs, outputs, parameters) {
        const state = this.__rc505BenchState;
        if (!state) {
          return originalProcess.call(this, inputs, outputs, parameters);
        }
        if (Atomics.load(state.meta, state.layout.measurementActiveIndex) !== 1) {
          Atomics.add(state.meta, state.slot * META_STRIDE + META.preflightCallbacks, 1);
          if (state.processorName === 'rc505-browser-block-meter') {
            const frames = getLongestChannelLength(outputs) || getLongestChannelLength(inputs);
            const frame = Number.isSafeInteger(scope.currentFrame) ? scope.currentFrame : -1;
            const frameEnd = frame >= 0 && frames >= 0 ? frame + frames : -1;
            Atomics.store(state.meta, state.slot * META_STRIDE + META.lastProcessorFrameEnd,
              frameEnd <= 0x7fff_ffff ? frameEnd : -1);
          }
          return originalProcess.call(this, inputs, outputs, parameters);
        }

        const frames = getLongestChannelLength(outputs) || getLongestChannelLength(inputs);
        const frame = Number.isSafeInteger(scope.currentFrame) ? scope.currentFrame : 0;
        const startMs = readClockMilliseconds();
        if (state.clockSource !== timingClockSource) {
          state.clockSource = timingClockSource;
          this.port.postMessage({
            type: 'rc505-bench-clock-update', slot: state.slot,
            timingClock: getTimingClockReport(),
          });
        }
        let processEndMs = startMs;
        let result = true;
        let threw = false;
        let coverageActive = false;
        try {
          result = originalProcess.call(this, inputs, outputs, parameters);
          const hasInputFrames = getLongestChannelLength(inputs) > 0;
          coverageActive = result !== false && (state.processorName === 'looper-processor'
            ? this.isRecording === true && hasInputFrames
            : state.processorName === 'rc505-overdub-processor'
              ? this.active === true && hasInputFrames
              : true);
          return result;
        } catch (error) {
          threw = true;
          if (!state.callbackExceptionDetailPosted) {
            state.callbackExceptionDetailPosted = true;
            const errorObject = error && typeof error === 'object' ? error : null;
            try {
              this.port.postMessage({
                type: 'rc505-bench-callback-exception',
                slot: state.slot,
                processorName: state.processorName,
                callbackIndex: Atomics.load(state.meta, state.slot * META_STRIDE + META.callbacks) + 1,
                currentFrame: frame,
                name: typeof errorObject?.name === 'string' ? errorObject.name : 'Error',
                message: typeof errorObject?.message === 'string' ? errorObject.message : String(error),
                stack: typeof errorObject?.stack === 'string' ? errorObject.stack.slice(0, 8_000) : null,
              });
            } catch { /* diagnostic reporting must never alter the production throw path */ }
          }
          throw error;
        } finally {
          processEndMs = readClockMilliseconds();
          if (state.clockSource !== timingClockSource) {
            state.clockSource = timingClockSource;
            this.port.postMessage({
              type: 'rc505-bench-clock-update', slot: state.slot,
              timingClock: getTimingClockReport(),
            });
          }
          const callbackDiagnostics = recordCallback(state, startMs, processEndMs, frame, frames, threw);
          // Publish only the four counters used for interval coverage under a
          // short sequence version. Timing/histogram diagnostics are deliberately
          // outside this window so readers never spin through expensive work.
          const base = state.slot * META_STRIDE;
          Atomics.add(state.meta, base + META.snapshotVersion, 1);
          try {
            Atomics.add(state.meta, base + META.callbacks, 1);
            Atomics.add(state.meta, base + META.totalFrames, frames);
            if (coverageActive) {
              Atomics.add(state.meta, base + META.coverageCallbacks, 1);
              Atomics.add(state.meta, base + META.coverageFrames, frames);
              const firstActiveFrameIndex = base + META.firstCoverageActiveFrame;
              if (Atomics.load(state.meta, firstActiveFrameIndex) < 0
                && Number.isSafeInteger(frame) && frame >= 0 && frame <= 0x7fff_ffff) {
                Atomics.store(state.meta, firstActiveFrameIndex, frame);
              }
            }
            if (callbackDiagnostics.frameGap > 0) {
              Atomics.add(state.meta, base + META.coverageMissingFrames, callbackDiagnostics.frameGap);
            }
            if (threw) Atomics.add(state.meta, base + META.callbackErrors, 1);
            const processorFrameEnd = Number.isSafeInteger(frame) && frame >= 0
              && Number.isSafeInteger(frames) && frames >= 0 ? frame + frames : -1;
            Atomics.store(state.meta, base + META.lastProcessorFrameEnd,
              processorFrameEnd >= 0 && processorFrameEnd <= 0x7fff_ffff ? processorFrameEnd : -1);
            if (result === false) {
              if (Number.isSafeInteger(frame) && frame >= 0 && frame <= 0x7fff_ffff) {
                Atomics.store(state.meta, base + META.processorStopFrame, frame);
              }
              if (Atomics.load(state.meta, base + META.stopAuthorization) !== 1) {
                Atomics.add(state.meta, base + META.unexpectedTerminationCount, 1);
              }
            }
          } finally {
            Atomics.add(state.meta, base + META.snapshotVersion, 1);
          }
        }
      }
    }

    try { Object.defineProperty(InstrumentedProcessor, 'name', { value: ProcessorConstructor.name }); } catch { /* cosmetic */ }
    return originalRegisterProcessor.call(scope, name, InstrumentedProcessor);
  };
  scope.__rc505BenchRegisterHookInstalled = true;
})();
