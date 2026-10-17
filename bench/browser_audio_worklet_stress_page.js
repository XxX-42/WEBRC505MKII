import { BrowserWorkletFX } from '../src/audio/fx/BrowserWorkletFX';
import { RhythmEngine } from '../src/audio/RhythmEngine';
import { Transport } from '../src/core/Transport';
import { RHYTHM_PATTERN_CATALOG } from '../src/audio/rhythm/catalog';
import { createLivePolyPitchNode } from '../src/audio/pitch/signalsmith';

const REQUESTED_SAMPLE_RATE = Number(new URLSearchParams(location.search).get('sampleRate') || '48000');
const MAX_SLOTS = 24;
const META_STRIDE = 17;
const MAX_BLOCK_FRAMES = 2_048;
const MAX_DURATION_US = 65_535;
const DURATION_BINS = MAX_DURATION_US + 1;
const READY_TIMEOUT_MS = 30_000;

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
});

const startButton = document.querySelector('#start');
const statusNode = document.querySelector('#status');
let harnessState = null;

function setStatus(value) {
  statusNode.textContent = value;
}

function createSharedLayout() {
  // One shared flag and one reserved final-output count follow the node slots.
  const metaLength = MAX_SLOTS * META_STRIDE + 2;
  const blockBins = MAX_BLOCK_FRAMES + 1;
  const metaByteOffset = 0;
  const blockByteOffset = metaLength * Int32Array.BYTES_PER_ELEMENT;
  const blockLength = MAX_SLOTS * blockBins;
  const processDurationByteOffset = blockByteOffset + blockLength * Int32Array.BYTES_PER_ELEMENT;
  const durationLength = MAX_SLOTS * DURATION_BINS;
  const wrapperDurationByteOffset = processDurationByteOffset + durationLength * Int32Array.BYTES_PER_ELEMENT;
  const startGapByteOffset = wrapperDurationByteOffset + durationLength * Int32Array.BYTES_PER_ELEMENT;
  const byteLength = startGapByteOffset + durationLength * Int32Array.BYTES_PER_ELEMENT;
  const nonFiniteIndex = MAX_SLOTS * META_STRIDE;
  const measurementActiveIndex = nonFiniteIndex + 1;
  return {
    metaLength,
    metaByteOffset,
    blockBins,
    blockByteOffset,
    blockLength,
    processDurationByteOffset,
    wrapperDurationByteOffset,
    startGapByteOffset,
    durationLength,
    durationBins: DURATION_BINS,
    maxBlockFrames: MAX_BLOCK_FRAMES,
    maxDurationUs: MAX_DURATION_US,
    byteLength,
    nonFiniteIndex,
    nonFiniteByteOffset: nonFiniteIndex * Int32Array.BYTES_PER_ELEMENT,
    measurementActiveIndex,
  };
}

function createNodeInstrumentationProxy(state) {
  const NativeAudioWorkletNode = window.AudioWorkletNode;
  if (typeof NativeAudioWorkletNode !== 'function') throw new Error('AudioWorkletNode is unavailable');
  state.NativeAudioWorkletNode = NativeAudioWorkletNode;

  window.AudioWorkletNode = new Proxy(NativeAudioWorkletNode, {
    construct(target, args) {
      const [context, processorName, originalOptions = {}] = args;
      const slot = state.nodes.length;
      if (slot >= MAX_SLOTS) throw new Error(`The benchmark exceeded its ${MAX_SLOTS}-node probe capacity`);
      const label = state.pendingNodeLabel || `${processorName}#${slot + 1}`;
      const processorOptions = {
        ...(originalOptions.processorOptions ?? {}),
        __rc505BenchInstrumentation: {
          buffer: state.buffer,
          slot,
          sampleRate: context.sampleRate,
          layout: state.layout,
        },
        __rc505BenchNonFiniteByteOffset: state.layout.nonFiniteByteOffset,
      };
      const options = { ...originalOptions, processorOptions };
      // Keep unsuccessful constructor attempts (Signalsmith first registers a
      // module lazily) from consuming a slot or its descriptive label.
      const node = Reflect.construct(target, [context, processorName, options], target);
      state.pendingNodeLabel = null;
      const descriptor = { slot, label, processorName, node };
      state.nodes.push(descriptor);
      state.waiters.get(label)?.(descriptor);
      node.addEventListener('processorerror', () => state.processorErrors.push({
        slot,
        label,
        processorName,
        message: 'AudioWorklet processorerror event',
      }));
      node.port.addEventListener('message', (event) => {
        if (event.data?.type === 'rc505-bench-ready' && event.data.slot === slot) {
          state.readySlots.add(slot);
          state.timingClockBySlot[slot] = event.data.timingClock ?? {
            source: event.data.timingClockSource ?? 'unknown',
            resolutionFloorUs: event.data.timingClockResolutionFloorUs ?? null,
            passed: false,
          };
        }
        if (event.data?.type === 'rc505-bench-clock-update' && event.data.slot === slot) {
          state.timingClockBySlot[slot] = event.data.timingClock ?? {
            source: event.data.timingClockSource ?? 'unknown',
            resolutionFloorUs: event.data.timingClockResolutionFloorUs ?? null,
            passed: false,
          };
        }
      });
      node.port.start();
      return node;
    },
  });
}

function waitForNode(label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      harnessState?.waiters.delete(label);
      reject(new Error(`Timed out waiting for AudioWorkletNode construction: ${label}`));
    }, READY_TIMEOUT_MS);
    harnessState.waiters.set(label, (descriptor) => {
      clearTimeout(timer);
      resolve(descriptor);
    });
  });
}

function setNextNodeLabel(label) {
  if (!harnessState) throw new Error('Benchmark graph has not been initialized');
  if (harnessState.pendingNodeLabel) throw new Error(`A node label is already pending: ${harnessState.pendingNodeLabel}`);
  harnessState.pendingNodeLabel = label;
}

async function createFx(context, label, type, parameters) {
  const constructed = waitForNode(label);
  setNextNodeLabel(label);
  const fx = new BrowserWorkletFX(
    context,
    type,
    () => harnessState.ensureFxModule(),
    (error) => harnessState.processorErrors.push({ label, processorName: 'rc505-fx-processor', message: error.message }),
    parameters,
  );
  fx.setBypass(false);
  await constructed;
  if (fx.error) throw new Error(`Browser FX adapter ${label} failed to install: ${fx.error}`);
  return fx;
}

function buildBuffer(context, frequencyHz, phaseOffset, seconds = 3) {
  const frameCount = Math.ceil(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, frameCount, context.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const phase = (Math.PI * 2 * frame) / context.sampleRate + phaseOffset;
    const fundamental = Math.sin(phase * frequencyHz);
    const harmonic = Math.sin(phase * frequencyHz * 2.01);
    const overtone = Math.sin(phase * frequencyHz * 3.03);
    left[frame] = (0.08 * fundamental) + (0.018 * harmonic) + (0.006 * overtone);
    right[frame] = (0.075 * Math.sin(phase * frequencyHz + 0.13))
      + (0.015 * Math.sin(phase * frequencyHz * 2.01 + 0.2));
  }
  return buffer;
}

function connectChain(source, effects, destination) {
  if (effects.length === 0) {
    source.connect(destination);
    return;
  }
  source.connect(effects[0].input);
  for (let index = 0; index + 1 < effects.length; index += 1) {
    effects[index].output.connect(effects[index + 1].input);
  }
  effects[effects.length - 1].output.connect(destination);
}

async function createOutputProbe(context, destination) {
  const heartbeatBuffer = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const probe = new harnessState.NativeAudioWorkletNode(context, 'rc505-bench-output-finite-probe', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { heartbeatBuffer },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the uninstrumented output probe to initialize')), READY_TIMEOUT_MS);
    const onMessage = (event) => {
      if (event.data?.type !== 'rc505-bench-output-probe-ready') return;
      clearTimeout(timer);
      probe.port.removeEventListener('message', onMessage);
      resolve();
    };
    probe.port.addEventListener('message', onMessage);
    probe.port.start();
  });
  probe.connect(destination);
  return { node: probe, heartbeat: new Int32Array(heartbeatBuffer) };
}

function createOutputSampler(context, analyser) {
  const samples = new Float32Array(analyser.fftSize);
  const previousSamples = new Float32Array(analyser.fftSize);
  const stats = { inspectedValues: 0, nonSilentValues: 0, nonFiniteValues: 0, peakLinear: 0, pollCount: 0, nonSilentPolls: 0, changedWindowPolls: 0, changedValues: 0, audioTimeAdvancePolls: 0 };
  let priorAudioTime = context.currentTime;
  const poll = () => {
    const audioTime = context.currentTime;
    if (audioTime > priorAudioTime) stats.audioTimeAdvancePolls += 1;
    priorAudioTime = audioTime;
    analyser.getFloatTimeDomainData(samples);
    stats.pollCount += 1;
    let sawSignal = false;
    let changedValues = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      stats.inspectedValues += 1;
      if (!Number.isFinite(sample)) {
        stats.nonFiniteValues += 1;
        continue;
      }
      const amplitude = Math.abs(sample);
      if (amplitude > 0.00001) {
        stats.nonSilentValues += 1;
        sawSignal = true;
      }
      if (amplitude > stats.peakLinear) stats.peakLinear = amplitude;
    }
    if (stats.pollCount > 1) {
      for (let index = 0; index < samples.length; index += 1) {
        if (Math.abs(samples[index] - previousSamples[index]) > 0.000001) changedValues += 1;
      }
      stats.changedValues += changedValues;
      if (changedValues >= samples.length * 0.01) stats.changedWindowPolls += 1;
    }
    previousSamples.set(samples);
    if (sawSignal) stats.nonSilentPolls += 1;
  };
  const timer = window.setInterval(poll, 50);
  return {
    reset() {
      stats.inspectedValues = 0;
      stats.nonSilentValues = 0;
      stats.nonFiniteValues = 0;
      stats.peakLinear = 0;
      stats.pollCount = 0;
      stats.nonSilentPolls = 0;
      stats.changedWindowPolls = 0;
      stats.changedValues = 0;
      previousSamples.fill(0);
      stats.audioTimeAdvancePolls = 0;
    },
    stop() {
      window.clearInterval(timer);
      poll();
      const nonSilentRatio = stats.inspectedValues > 0 ? stats.nonSilentValues / stats.inspectedValues : 0;
      const nonSilentPollRatio = stats.pollCount > 0 ? stats.nonSilentPolls / stats.pollCount : 0;
      const changedWindowPollRatio = stats.pollCount > 1 ? stats.changedWindowPolls / (stats.pollCount - 1) : 0;
      return {
        ...stats,
        nonSilentRatio,
        nonSilentPollRatio,
        changedWindowPollRatio,
        nonSilentThresholdLinear: 0.00001,
        minimumPeakForSignalLinear: 0.0001,
        minimumNonSilentPollRatio: 0.95,
        minimumChangedWindowPollRatio: 0.95,
        pumpIntervalMs: 50,
        passed: stats.pollCount >= 3 && nonSilentPollRatio >= 0.95 && changedWindowPollRatio >= 0.95 && stats.nonFiniteValues === 0 && stats.peakLinear >= 0.0001,
        limitation: 'A test-only AnalyserNode read pump forces software graph rendering in headless mode; inspected windows overlap and do not establish physical output, acoustic quality, or device callback timing.',
      };
    },
  };
}

function getHistogramQuantile(histogram, offset, bins, count, quantile) {
  if (count <= 0) return null;
  const target = Math.max(1, Math.ceil(count * quantile));
  let accumulated = 0;
  for (let index = 0; index < bins; index += 1) {
    accumulated += Atomics.load(histogram, offset + index);
    if (accumulated >= target) return index + 0.5;
  }
  return null;
}

function getSparseHistogram(histogram, offset, bins) {
  const nonZeroBins = [];
  for (let index = 0; index < bins; index += 1) {
    const count = Atomics.load(histogram, offset + index);
    if (count > 0) nonZeroBins.push([index, count]);
  }
  return nonZeroBins;
}

function readDistribution(histogram, slot, bins, count, overflowCount, timingEligible) {
  const quantileSampleCount = timingEligible ? Math.max(0, count - overflowCount) : 0;
  const offset = slot * bins;
  return {
    sampleCount: timingEligible ? count : null,
    quantileSampleCount,
    binWidth: 1,
    unit: 'microseconds',
    p50: timingEligible ? getHistogramQuantile(histogram, offset, bins, quantileSampleCount, 0.50) : null,
    p95: timingEligible ? getHistogramQuantile(histogram, offset, bins, quantileSampleCount, 0.95) : null,
    p99: timingEligible ? getHistogramQuantile(histogram, offset, bins, quantileSampleCount, 0.99) : null,
    p999: timingEligible ? getHistogramQuantile(histogram, offset, bins, quantileSampleCount, 0.999) : null,
    overflowCount: timingEligible ? overflowCount : null,
    timingEligible,
  };
}

function readMemoryInfo() {
  const memory = performance.memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) {
    return { available: false, reason: 'performance.memory is not exposed by this browser context' };
  }
  return {
    available: true,
    source: 'performance.memory',
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

function waitForReadyNodes(state) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (state.readySlots.size === state.nodes.length && state.nodes.length > 0) {
        resolve();
        return;
      }
      if (state.processorErrors.length > 0) {
        reject(new Error(`An AudioWorklet node failed during setup: ${JSON.stringify(state.processorErrors)}`));
        return;
      }
      if ((performance.now() - started) > READY_TIMEOUT_MS) {
        reject(new Error(`Timed out waiting for ${state.nodes.length} AudioWorklet nodes to report readiness; ready=${state.readySlots.size}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function waitForFirstCallbacks(state) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const allHaveRun = state.nodes.every((node) => Atomics.load(state.meta, node.slot * META_STRIDE + META.preflightCallbacks) > 0);
      if (allHaveRun) {
        resolve();
        return;
      }
      if ((performance.now() - started) > READY_TIMEOUT_MS) {
        const pending = state.nodes.filter((node) => Atomics.load(state.meta, node.slot * META_STRIDE + META.preflightCallbacks) === 0);
        reject(new Error(`Timed out waiting for worklet callbacks from: ${pending.map((node) => `${node.label} (${node.processorName})`).join(', ')}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function snapshotMetrics(state, duration) {
  const blockHistogram = new Int32Array(state.buffer, state.layout.blockByteOffset, state.layout.blockLength);
  const processDurationHistogram = new Int32Array(state.buffer, state.layout.processDurationByteOffset, state.layout.durationLength);
  const wrapperDurationHistogram = new Int32Array(state.buffer, state.layout.wrapperDurationByteOffset, state.layout.durationLength);
  const startGapHistogram = new Int32Array(state.buffer, state.layout.startGapByteOffset, state.layout.durationLength);
  const slots = state.nodes.map((node) => {
    const base = node.slot * META_STRIDE;
    const load = (field) => Atomics.load(state.meta, base + field);
    const callbackCount = load(META.callbacks);
    const clock = state.timingClockBySlot[node.slot] ?? { source: 'unknown', resolutionFloorUs: null, passed: false };
    const timingEligible = clock.source === 'performance.now()'
      && clock.passed === true
      && clock.observedP95PositiveStepUs !== null
      && clock.observedP95PositiveStepUs <= 100
      && clock.positiveStepCount >= 64;
    const byBlockFrames = {};
    const blockOffset = node.slot * state.layout.blockBins;
    for (let frames = 1; frames <= state.layout.maxBlockFrames; frames += 1) {
      const value = Atomics.load(blockHistogram, blockOffset + frames);
      if (value > 0) byBlockFrames[String(frames)] = value;
    }
    return {
      slot: node.slot,
      label: node.label,
      processorName: node.processorName,
      timingClock: clock,
      timingBudgetEligible: timingEligible,
      preflightCallbacks: load(META.preflightCallbacks),
      callbacks: callbackCount,
      totalOutputFramesObserved: load(META.totalFrames),
      callbackBlockFrames: byBlockFrames,
      callbackCpuDuration: readDistribution(
        processDurationHistogram,
        node.slot,
        state.layout.durationBins,
        callbackCount,
        load(META.processDurationOverflow),
        timingEligible,
      ),
      callbackCpuDurationHistogramUs: timingEligible ? getSparseHistogram(
        processDurationHistogram,
        node.slot * state.layout.durationBins,
        state.layout.durationBins,
      ) : null,
      instrumentedWrapperDuration: readDistribution(
        wrapperDurationHistogram,
        node.slot,
        state.layout.durationBins,
        callbackCount,
        load(META.wrapperDurationOverflow),
        timingEligible,
      ),
      instrumentedWrapperDurationHistogramUs: timingEligible ? getSparseHistogram(
        wrapperDurationHistogram,
        node.slot * state.layout.durationBins,
        state.layout.durationBins,
      ) : null,
      startGapExcess: readDistribution(
        startGapHistogram,
        node.slot,
        state.layout.durationBins,
        Math.max(0, callbackCount - 1),
        load(META.gapDurationOverflow),
        timingEligible,
      ),
      startGapExcessHistogramUs: timingEligible ? getSparseHistogram(
        startGapHistogram,
        node.slot * state.layout.durationBins,
        state.layout.durationBins,
      ) : null,
      deadlineMisses: timingEligible ? load(META.deadlineMisses) : null,
      wrapperDeadlineMisses: timingEligible ? load(META.wrapperDeadlineMisses) : null,
      missingCallbackEstimate: load(META.missingCallbackEstimate),
      missingFrames: load(META.missingFrames),
      frameDiscontinuities: load(META.frameDiscontinuities),
      frameRewinds: load(META.frameRewinds),
      callbackStartGapsOverOneQuantum: timingEligible ? load(META.startGapOverQuantum) : null,
      callbackErrors: load(META.callbackErrors),
      instrumentationErrors: load(META.instrumentationErrors),
      maxCallbackCpuDurationUs: timingEligible ? load(META.maxProcessDurationUs) : null,
      maxInstrumentedWrapperDurationUs: timingEligible ? load(META.maxWrapperDurationUs) : null,
    };
  });

  return {
    measuredWallDurationSeconds: duration.seconds,
    measuredWallStartUtc: duration.startedAt,
    measuredWallEndUtc: duration.endedAt,
    callbackMetrics: slots,
    timingAccuracy: {
      eligibleForRealtimeCpuBudget: slots.length > 0 && slots.every((slot) => slot.timingBudgetEligible),
      timingClockByProcessor: slots.map((slot) => ({ label: slot.label, ...slot.timingClock })),
      exclusionReason: slots.some((slot) => !slot.timingBudgetEligible)
        ? 'The AudioWorklet monotonic-clock probe was unavailable, lacked enough positive-step samples, or observed a 95th-percentile step above 100 microseconds; callback CPU quantiles/deadline metrics are suppressed and cannot pass a performance budget.'
        : null,
    },
    callbackCounts: {
      totalInstrumentedCallbacks: slots.reduce((sum, slot) => sum + slot.callbacks, 0),
      estimatedMissingCallbacks: slots.reduce((sum, slot) => sum + slot.missingCallbackEstimate, 0),
      estimatedMissingFrames: slots.reduce((sum, slot) => sum + slot.missingFrames, 0),
      directDroppedCallbackCount: null,
      directDroppedFrameCount: null,
      directDroppedCountUnavailableReason: 'The Web Audio AudioWorklet API exposes no direct browser XRUN or dropped-callback counter; positive currentFrame gaps are reported as software-side estimates.',
      deadlineMisses: slots.every((slot) => slot.timingBudgetEligible) ? slots.reduce((sum, slot) => sum + slot.deadlineMisses, 0) : null,
      wrapperDeadlineMisses: slots.every((slot) => slot.timingBudgetEligible) ? slots.reduce((sum, slot) => sum + slot.wrapperDeadlineMisses, 0) : null,
      callbackErrors: slots.reduce((sum, slot) => sum + slot.callbackErrors, 0),
      instrumentationErrors: slots.reduce((sum, slot) => sum + slot.instrumentationErrors, 0),
      nonFiniteOutputSamples: Atomics.load(state.meta, state.layout.nonFiniteIndex),
    },
    callbackMetricsByProcessor: slots.reduce((summary, slot) => {
      const key = slot.processorName;
      const current = summary[key] ?? { nodes: 0, callbacks: 0, estimatedMissingCallbacks: 0, deadlineMisses: 0, timingBudgetEligible: true };
      current.nodes += 1;
      current.callbacks += slot.callbacks;
      current.estimatedMissingCallbacks += slot.missingCallbackEstimate;
      current.timingBudgetEligible = current.timingBudgetEligible && slot.timingBudgetEligible;
      current.deadlineMisses = current.timingBudgetEligible
        ? current.deadlineMisses + slot.deadlineMisses
        : null;
      summary[key] = current;
      return summary;
    }, {}),
  };
}

async function setupGraph() {
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    throw new Error('SharedArrayBuffer instrumentation requires cross-origin isolation (COOP/COEP headers)');
  }

  const context = new AudioContext({ sampleRate: REQUESTED_SAMPLE_RATE, latencyHint: 'interactive' });
  const resumePromise = context.resume();
  const layout = createSharedLayout();
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const meta = new Int32Array(buffer, layout.metaByteOffset, layout.metaLength);
  harnessState = {
    context,
    layout,
    buffer,
    meta,
    nodes: [],
    waiters: new Map(),
    readySlots: new Set(),
    processorErrors: [],
    timingClockBySlot: {},
    pendingNodeLabel: null,
    fxModulePromise: null,
    ensureFxModule() {
      this.fxModulePromise ??= context.audioWorklet.addModule('/worklets/fx-processor.js');
      return this.fxModulePromise;
    },
  };
  createNodeInstrumentationProxy(harnessState);

  await resumePromise;
  if (context.state !== 'running') throw new Error(`AudioContext did not enter running state: ${context.state}`);
  // Register this independent heartbeat before installing the test-only
  // registerProcessor wrapper, so its execution count is independent of the
  // per-production-node instrumentation branch.
  await context.audioWorklet.addModule('/bench/worklets/output-finite-probe.js');
  await context.audioWorklet.addModule('/bench/worklets/instrument-register-processor.js');
  await context.audioWorklet.addModule('/bench/worklets/instrumented-heartbeat.js');

  const master = context.createGain();
  master.gain.value = 0.8;
  const outputAnalyser = context.createAnalyser();
  outputAnalyser.fftSize = 8_192;
  const diagnosticProbeEnabled = new URLSearchParams(location.search).get('diagnosticOutputProbe') === '1';
  const outputProbeState = diagnosticProbeEnabled ? await createOutputProbe(context, outputAnalyser) : null;
  const outputProbe = outputProbeState?.node ?? null;
  outputAnalyser.connect(context.destination);
  const outputSampler = createOutputSampler(context, outputAnalyser);
  master.connect(outputProbe ?? outputAnalyser);

  const diagnosticStage = new URLSearchParams(location.search).get('diagnosticStage') || 'production';
  if (diagnosticStage === 'instrumented-heartbeat' || diagnosticStage === 'single-lpf') {
    const source = context.createOscillator();
    source.frequency.value = 440;
    let diagnosticFx = null;
    let diagnosticNode = null;
    if (diagnosticStage === 'instrumented-heartbeat') {
      const label = 'diagnostic-instrumented-heartbeat';
      const constructed = waitForNode(label);
      setNextNodeLabel(label);
      diagnosticNode = new AudioWorkletNode(context, 'rc505-bench-instrumented-heartbeat', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      await constructed;
      source.connect(diagnosticNode);
      diagnosticNode.connect(master);
    } else {
      diagnosticFx = await createFx(context, 'diagnostic-single-lpf', 'DSP LPF', { cutoffHz: 9_000, q: 0.71 });
      source.connect(diagnosticFx.input);
      diagnosticFx.output.connect(master);
    }
    await waitForReadyNodes(harnessState);
    source.start(context.currentTime + 0.05);
    await waitForFirstCallbacks(harnessState);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    window.__rc505BenchSetupReady = true;
    return {
      context, master, inputFx: diagnosticFx ? [diagnosticFx] : [], trackFx: [],
      inputSource: source, trackSources: [], directProbeSource: null, directProbeWorklet: diagnosticNode,
      trackMix: null, outputProbe, outputProbeHeartbeat: outputProbeState?.heartbeat ?? null,
      outputAnalyser, outputSampler, livePoly: null, rhythm: null, diagnosticStage,
    };
  }

  const inputFx = [];
  const inputFxSpecs = [
    ['input-slot-A-lpf', 'DSP LPF', { cutoffHz: 9_000, q: 0.71 }],
    ['input-slot-B-distortion', 'DIST', { driveDb: 8, mix: 0.35, distortionMode: 'overdrive' }],
    ['input-slot-C-vibrato', 'VIBRATO', { vibratoRateHz: 0.7, vibratoDepthPercent: 38, vibratoDelayMs: 3.5, mix: 0.72 }],
    ['input-slot-D-sustainer', 'SUSTAINER', { thresholdDb: -30, ratio: 5, releaseMs: 180, outputDb: 0, mix: 0.9 }],
  ];
  for (const [label, name, parameters] of inputFxSpecs) inputFx.push(await createFx(context, label, name, parameters));

  const trackFx = [];
  const trackFxSpecs = [
    ['postmix-slot-A-chorus', 'CHORUS', { chorusDelayMs: 15, chorusDepthMs: 5, chorusVoices: 2, mix: 0.2 }],
    ['postmix-slot-B-reverb', 'FDN8 REVERB', { decaySeconds: 1.2, dampingHz: 8_000, mix: 0.12 }],
    ['postmix-slot-C-delay', 'DELAY', { delayTimeMs: 240, delayFeedback: 0.12, delayToneHz: 7_000, mix: 0.13 }],
    ['postmix-slot-D-auto-pan', 'AUTO PAN', { autoPanRateHz: 0.32, autoPanDepth: 0.45, mix: 0.7 }],
  ];
  for (const [label, name, parameters] of trackFxSpecs) trackFx.push(await createFx(context, label, name, parameters));

  const inputSource = context.createBufferSource();
  inputSource.buffer = buildBuffer(context, 220, 0.1);
  inputSource.loop = true;
  const inputGain = context.createGain();
  inputGain.gain.value = 0.25;
  inputSource.connect(inputGain);
  connectChain(inputGain, inputFx, master);

  const trackMix = context.createGain();
  trackMix.gain.value = 0.75;
  connectChain(trackMix, trackFx, master);

  const trackSources = [];
  const loopSeconds = 3;
  const livePolyBuffer = buildBuffer(context, 110, 0.03, loopSeconds);
  const livePolyLabel = 'track-1-live-poly-signalsmith';
  const livePolyConstructed = waitForNode(livePolyLabel);
  setNextNodeLabel(livePolyLabel);
  const livePoly = await createLivePolyPitchNode(context, {
    mode: 'LIVE_POLY',
    channels: 2,
    semitones: 5,
    playbackRate: 1,
    tonalityLimitHz: 8_000,
  });
  await livePolyConstructed;
  await livePoly.loadBuffer([livePolyBuffer.getChannelData(0), livePolyBuffer.getChannelData(1)]);
  await livePoly.scheduleLoop({
    inputOffsetSeconds: 0,
    loopStartSeconds: 0,
    loopEndSeconds: loopSeconds,
    outputTime: context.currentTime + livePoly.latencySeconds,
    semitones: 5,
    playbackRate: 1,
    tonalityLimitHz: 8_000,
  });
  livePoly.connect(trackMix);

  for (let trackIndex = 1; trackIndex < 5; trackIndex += 1) {
    const source = context.createBufferSource();
    source.buffer = buildBuffer(context, 165 + trackIndex * 55, trackIndex * 0.17, loopSeconds);
    source.loop = true;
    source.connect(trackMix);
    trackSources.push(source);
  }

  // Optional diagnostic-only source separates browser graph pull/scheduling
  // from silence or routing mistakes in the multi-node product-style graph.
  const directProbeSource = new URLSearchParams(location.search).get('diagnosticDirectSource') === '1'
    ? context.createOscillator()
    : null;
  let directProbeWorklet = null;
  if (directProbeSource) {
    directProbeSource.frequency.value = 440;
    const label = 'diagnostic-instrumented-heartbeat';
    const constructed = waitForNode(label);
    setNextNodeLabel(label);
    directProbeWorklet = new AudioWorkletNode(context, 'rc505-bench-instrumented-heartbeat', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    await constructed;
    const directProbeGain = context.createGain();
    directProbeGain.gain.value = 0.01;
    directProbeSource.connect(directProbeWorklet);
    directProbeWorklet.connect(directProbeGain);
    directProbeGain.connect(master);
  }

  const rhythm = new RhythmEngine(context);
  rhythm.connect(master);
  rhythm.setVolume(20);
  const pattern = RHYTHM_PATTERN_CATALOG[0];
  if (!pattern) throw new Error('The clean-room rhythm catalog did not contain a pattern');
  const configured = rhythm.setSettings({
    patternIndex: 1,
    kitIndex: 1,
    variation: pattern.variations[0],
    section: 'main',
    swingPercent: 58,
    quantizeGrid: '1/16',
  });
  if (!configured) throw new Error('The production rhythm engine rejected the benchmark settings');

  const rhythmLabel = 'production-rhythm-engine';
  const rhythmConstructed = waitForNode(rhythmLabel);
  setNextNodeLabel(rhythmLabel);
  rhythm.start();

  // Wait for the lazily-created production rhythm node.
  await rhythmConstructed;
  await waitForReadyNodes(harnessState);
  for (const source of trackSources) source.start(context.currentTime + 0.05);
  inputSource.start(context.currentTime + 0.05);
  directProbeSource?.start(context.currentTime + 0.05);
  await waitForFirstCallbacks(harnessState);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  window.__rc505BenchSetupReady = true;

  return { context, master, inputFx, trackFx, inputSource, trackSources, directProbeSource, directProbeWorklet, trackMix, outputProbe, outputProbeHeartbeat: outputProbeState?.heartbeat ?? null, outputAnalyser, outputSampler, livePoly, rhythm, diagnosticStage };
}

function summarizeMemory(start, end) {
  if (!start.available || !end.available) {
    return { available: false, reason: start.reason ?? end.reason ?? 'Browser JS heap metrics unavailable' };
  }
  return {
    available: true,
    source: start.source,
    startUsedJSHeapSize: start.usedJSHeapSize,
    endUsedJSHeapSize: end.usedJSHeapSize,
    deltaUsedJSHeapSize: end.usedJSHeapSize - start.usedJSHeapSize,
    startTotalJSHeapSize: start.totalJSHeapSize,
    endTotalJSHeapSize: end.totalJSHeapSize,
    jsHeapSizeLimit: end.jsHeapSizeLimit,
  };
}

async function runBenchmark(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1_800) {
    throw new RangeError('durationSeconds must be greater than 0 and no more than 1800 seconds');
  }
  if (harnessState) throw new Error('The benchmark graph can only run once per page');

  setStatus('Building production Browser AudioWorklet graph…');
  const graph = await setupGraph();
  const state = harnessState;
  const measurementMode = new URLSearchParams(location.search).get('diagnosticMeasurementMode') || 'record';
  if (!['record', 'preflight'].includes(measurementMode)) throw new RangeError(`Unknown diagnostic measurement mode: ${measurementMode}`);
  const startMemory = readMemoryInfo();
  const startedAt = new Date().toISOString();
  const preflightAtMeasurementStart = state.nodes.map((node) =>
    Atomics.load(state.meta, node.slot * META_STRIDE + META.preflightCallbacks));
  const outputProbeHeartbeatAtStart = graph.outputProbeHeartbeat
    ? [Atomics.load(graph.outputProbeHeartbeat, 0), Atomics.load(graph.outputProbeHeartbeat, 1)]
    : null;
  if (measurementMode === 'record') Atomics.store(state.meta, state.layout.measurementActiveIndex, 1);
  const startMonotonicMs = performance.now();
  const startAudioTimeSeconds = graph.context.currentTime;
  graph.outputSampler.reset();
  setStatus(`Measuring for ${durationSeconds} real-wall seconds…`);
  await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
  const outputSignalSentinel = graph.outputSampler.stop();
  const endMonotonicMs = performance.now();
  const endedAt = new Date().toISOString();
  const endAudioTimeSeconds = graph.context.currentTime;
  const stateAtMeasurementEnd = graph.context.state;
  const outputProbeHeartbeatAtEnd = graph.outputProbeHeartbeat
    ? [Atomics.load(graph.outputProbeHeartbeat, 0), Atomics.load(graph.outputProbeHeartbeat, 1)]
    : null;
  const activeFlagAtMeasurementEnd = Atomics.load(state.meta, state.layout.measurementActiveIndex);
  Atomics.store(state.meta, state.layout.measurementActiveIndex, 0);
  await graph.context.suspend();
  const endMemory = readMemoryInfo();

  const duration = {
    seconds: (endMonotonicMs - startMonotonicMs) / 1000,
    startedAt,
    endedAt,
    audioContextStartSeconds: startAudioTimeSeconds,
    audioContextEndSeconds: endAudioTimeSeconds,
    audioContextAdvanceSeconds: endAudioTimeSeconds - startAudioTimeSeconds,
    audioContextAdvanceRatio: (endAudioTimeSeconds - startAudioTimeSeconds) /
      Math.max(0.001, (endMonotonicMs - startMonotonicMs) / 1000),
    stateBeforeSuspend: stateAtMeasurementEnd,
  };
  const metrics = snapshotMetrics(state, duration);
  metrics.preflightCallbacksDuringMeasurement = state.nodes.map((node, index) => {
    const end = Atomics.load(state.meta, node.slot * META_STRIDE + META.preflightCallbacks);
    return {
      label: node.label,
      start: preflightAtMeasurementStart[index],
      end,
      delta: end - preflightAtMeasurementStart[index],
    };
  });
  metrics.uninstrumentedOutputProbe = outputProbeHeartbeatAtStart && outputProbeHeartbeatAtEnd
    ? {
      callbackCountDelta: outputProbeHeartbeatAtEnd[0] - outputProbeHeartbeatAtStart[0],
      outputFrameDelta: outputProbeHeartbeatAtEnd[1] - outputProbeHeartbeatAtStart[1],
      source: 'test-only pass-through AudioWorklet registered before the benchmark registerProcessor wrapper',
    }
    : { available: false, reason: 'optional diagnosticOutputProbe=1 was not enabled' };
  metrics.callbackCounts.nonFiniteOutputSamples = outputSignalSentinel.nonFiniteValues;
  const expectedAudioFrames = duration.audioContextAdvanceSeconds * graph.context.sampleRate;
  metrics.callbackCoverage = metrics.callbackMetrics.map((slot) => {
    const ratio = slot.totalOutputFramesObserved / Math.max(1, expectedAudioFrames);
    return {
      label: slot.label,
      expectedAudioFrames,
      observedFrames: slot.totalOutputFramesObserved,
      ratio,
      passed: ratio >= 0.95,
    };
  });
  metrics.callbackCoveragePassed = metrics.callbackCoverage.every((slot) => slot.passed);
  metrics.preflightCallbacksPassed = metrics.preflightCallbacksDuringMeasurement.length > 0
    && metrics.preflightCallbacksDuringMeasurement.every((slot) => slot.delta > 0);
  const minimumContextAdvanceSeconds = Math.max(1, duration.seconds * 0.95);
  const contextProgression = {
    passed: stateAtMeasurementEnd === 'running' &&
      duration.audioContextAdvanceSeconds >= minimumContextAdvanceSeconds,
    minimumAdvanceRatio: 0.95,
    minimumAdvanceSeconds: minimumContextAdvanceSeconds,
    measuredAdvanceSeconds: duration.audioContextAdvanceSeconds,
    limitation: 'AudioContext clock progression is a software-side guard; this is not endpoint continuity or hardware XRUN instrumentation.',
  };
  if (!contextProgression.passed) {
    throw new Error(`AudioContext did not remain live for measurement: state=${stateAtMeasurementEnd}, audioAdvance=${duration.audioContextAdvanceSeconds.toFixed(3)}s, wall=${duration.seconds.toFixed(3)}s, minimum=${minimumContextAdvanceSeconds.toFixed(3)}s`);
  }
  if (!outputSignalSentinel.passed) {
    const callbackCounts = metrics.callbackMetrics.map((metric) => ({ label: metric.label, preflightCallbacks: metric.preflightCallbacks, callbacks: metric.callbacks, frames: metric.totalOutputFramesObserved }));
    throw new Error(`Final output signal sentinel failed: ${JSON.stringify(outputSignalSentinel)}; uninstrumentedOutputProbe=${JSON.stringify(metrics.uninstrumentedOutputProbe)}; activeAtEnd=${activeFlagAtMeasurementEnd}; activeAfterReset=${Atomics.load(state.meta, state.layout.measurementActiveIndex)}; progression=${JSON.stringify(contextProgression)}; processorErrors=${JSON.stringify(state.processorErrors)}; callbacks=${JSON.stringify(callbackCounts)}`);
  }
  if (measurementMode === 'record' && !metrics.callbackCoveragePassed) {
    throw new Error(`Worklet callback coverage failed: ${JSON.stringify(metrics.callbackCoverage)}`);
  }
  if (measurementMode === 'preflight' && !metrics.preflightCallbacksPassed) {
    throw new Error(`Preflight callback progression failed: ${JSON.stringify(metrics.preflightCallbacksDuringMeasurement)}`);
  }
  const processorNames = state.nodes.map(({ slot, label, processorName }) => ({ slot, label, processorName }));
  const summary = {
    schemaVersion: 1,
    benchmark: 'rc505_browser_audio_worklet_stress',
    measurementMode: measurementMode === 'record'
      ? 'actual AudioContext + production AudioWorklet adapters with callback instrumentation active, pulled by a test-only AnalyserNode read pump'
      : 'diagnostic control: production AudioWorklet graph in preflight branch with callback metric recording disabled; not a performance run',
    generatedAtUtc: new Date().toISOString(),
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      crossOriginIsolated: window.crossOriginIsolated,
      requestedSampleRateHz: REQUESTED_SAMPLE_RATE,
      actualSampleRateHz: graph.context.sampleRate,
      baseLatencySeconds: Number.isFinite(graph.context.baseLatency) ? graph.context.baseLatency : null,
      outputLatencySeconds: Number.isFinite(graph.context.outputLatency) ? graph.context.outputLatency : null,
    },
    graph: {
      diagnosticStage: graph.diagnosticStage,
      syntheticLoopTracks: graph.diagnosticStage === 'production' ? 5 : 0,
      track1Source: graph.diagnosticStage === 'production'
        ? 'production Signalsmith createLivePolyPitchNode (LIVE_POLY), 3-second stereo synthetic loop'
        : null,
      track2Through5Source: graph.diagnosticStage === 'production'
        ? 'four looping stereo AudioBufferSourceNode clean-room synthetic tone buffers'
        : null,
      diagnosticDirectSource: new URLSearchParams(location.search).get('diagnosticDirectSource') === '1'
        ? 'optional 440 Hz oscillator mixed directly to master for render-path diagnostics; excluded from product-acceptance claims'
        : null,
      inputEffects: graph.diagnosticStage === 'production' ? ['DSP LPF', 'DIST', 'VIBRATO', 'SUSTAINER'] : [],
      inputEffectRouting: graph.diagnosticStage === 'production'
        ? 'separate synthetic input loop -> four serial production BrowserWorkletFX nodes -> final mix'
        : 'diagnostic-only minimal signal path; no production input effects',
      trackEffectBank: graph.diagnosticStage === 'production' ? ['CHORUS', 'FDN8 REVERB', 'DELAY', 'AUTO PAN'] : [],
      trackEffectRouting: graph.diagnosticStage === 'production'
        ? 'five track sources -> summed track bus -> four serial production BrowserWorkletFX nodes -> final mix'
        : 'diagnostic-only minimal signal path; no production track-effect bank',
      rhythm: graph.rhythm ? {
        adapter: 'production RhythmEngine + public /worklets/rhythm-processor.js',
        patternId: graph.rhythm.patternMetadata.id,
        patternName: graph.rhythm.patternMetadata.pattern,
        kitIndex: 1,
        provenance: graph.rhythm.eventProvenance,
      } : null,
      finalOutput: graph.outputProbe
        ? 'optional test-only pass-through AudioWorklet -> AnalyserNode -> AudioContext.destination; no physical endpoint is claimed'
        : 'production graph master -> AnalyserNode -> AudioContext.destination; main-thread sampling does not establish a physical endpoint',
      workletNodes: processorNames,
    },
    duration,
    contextProgression,
    metrics,
    outputSignalSentinel,
    browserJsMemory: summarizeMemory(startMemory, endMemory),
    instrumentation: {
      timingSource: 'AudioWorklet performance.now() when available; Date.now() fallback is marked coarse and ineligible for CPU-budget conclusions',
      processCpuMetric: 'synchronous per-callback JavaScript wall duration; not OS thread CPU time',
      callbackStartGaps: 'positive excess between observed process start times and currentFrame-derived expected sample-time intervals',
      deadlineDefinition: 'process callback duration greater than its actual output/input block duration at the AudioContext sample rate',
      missingCallbackDefinition: 'estimated from positive currentFrame discontinuities relative to the prior callback block; not a browser XRUN counter',
      sharedMemory: 'fixed SharedArrayBuffer histograms and counters; no per-callback postMessage or dynamic allocations in the probe hot path',
      processorRegistration: 'test-only registerProcessor wrapper loaded before production worklets; production process implementations are invoked unchanged',
      outputFiniteProbe: 'test-only final-bus pass-through with a 5ms AnalyserNode read pump; main-thread inspected windows overlap and add scheduling overhead',
      outputSignalSentinel: 'AnalyserNode windows require finite, non-silent samples, fresh window changes, and peak level; windows overlap and are not unique output-frame counts',
      contextProgression: 'context must remain running and its sample clock must advance at least 95% of real measurement time, with a 1s absolute minimum',
      durationQuantization: 'integer microsecond histogram bins; values above 65.535 ms counted as overflow',
      measuredWrapperOverhead: 'wrapper histogram includes most shared-memory metric writes; it excludes its final histogram/max stores and does not estimate the total effect on browser scheduling',
    },
    strictExclusions: [
      'Not a hardware test and not evidence about a physical audio interface, microphone, speakers, headphones, device drivers, or hardware buffer behavior.',
      'The final-output sentinel proves only that the generated final bus has finite, non-silent electrical samples above the recorded threshold; it is not an acoustic or sound-quality acceptance test.',
      'Not the complete application/runtime path: no Vue UI, device setup, recording/overdub, app transport integration, per-track production TrackAudio lifecycle, or full master/monitor topology.',
      'Not a whole-app CPU, whole-system CPU, thermal, power, or acoustic-latency benchmark.',
      'Not direct XRUN/dropout instrumentation. Deadline misses and frame-gap-derived missing callback estimates are software-side proxies only.',
      'All loop and input signals are generated synthetic tones; rhythm events and kit are clean-room generated, not user audio or factory samples/MIDI.',
      'Any result applies only to the exact headless-shell version, host, OS, graph, sample rate, duration, and instrumentation recorded in the JSON.',
    ],
    cleanup: { contextSuspended: graph.context.state === 'suspended', contextClosed: false },
  };

  graph.rhythm?.stop();
  for (const source of graph.trackSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  try { graph.inputSource.stop(); } catch { /* already stopped */ }
  try { graph.directProbeSource?.stop(); } catch { /* absent or already stopped */ }
  graph.directProbeWorklet?.disconnect();
  for (const fx of [...graph.inputFx, ...graph.trackFx]) fx.dispose();
  graph.outputProbe?.disconnect();
  graph.outputAnalyser.disconnect();
  graph.livePoly?.disconnect();
  await graph.context.close();
  summary.cleanup = { contextSuspended: true, contextClosed: graph.context.state === 'closed' };
  window.__rc505BenchResult = summary;
  setStatus(`Finished ${duration.seconds.toFixed(2)} seconds`);
  return summary;
}

startButton.addEventListener('click', () => {
  if (window.__rc505BenchStartPromise) return;
  startButton.disabled = true;
  window.__rc505BenchStartPromise = (async () => {
    try {
      // Resolve Transport before graph setup so this production rhythm path uses
      // its ordinary singleton BPM source.
      Transport.getInstance();
      await runBenchmark(Number(new URLSearchParams(location.search).get('seconds') || '10'));
    } catch (error) {
      window.__rc505BenchError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      setStatus(`FAILED: ${window.__rc505BenchError}`);
      return null;
    }
  })();
});

window.__rc505Bench = {
  get ready() { return window.__rc505BenchSetupReady ?? false; },
  get error() { return window.__rc505BenchError ?? null; },
  get readySlots() { return harnessState?.readySlots.size ?? 0; },
  get nodeCount() { return harnessState?.nodes.length ?? 0; },
  async run(durationSeconds) {
    if (!window.__rc505BenchStartPromise) {
      // Use this method only after the runner's synthetic click granted audio
      // activation; the button path itself remains the canonical entrypoint.
      throw new Error('Click Start before invoking the benchmark');
    }
    if (durationSeconds !== undefined) {
      throw new Error('Pass --duration-seconds on the runner; use the page URL only for its configured value');
    }
    await window.__rc505BenchStartPromise;
    return window.__rc505BenchResult ?? null;
  },
};
