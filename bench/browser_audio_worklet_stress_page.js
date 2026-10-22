import { BrowserWorkletFX } from '../src/audio/fx/BrowserWorkletFX';
import { RhythmEngine } from '../src/audio/RhythmEngine';
import { Transport } from '../src/core/Transport';
import { RHYTHM_PATTERN_CATALOG } from '../src/audio/rhythm/catalog';
import { createLivePolyPitchNode } from '../src/audio/pitch/signalsmith';
import { signalsmithLiveWasmSnapshot } from '../src/audio/pitch/signalsmithWasmBudget';
import {
  ActiveWorkletCoverageTracker,
  readCoherentWorkletCounters,
  summarizeActiveWorkletCoverage,
} from './active_worklet_coverage';

const REQUESTED_SAMPLE_RATE = Number(new URLSearchParams(location.search).get('sampleRate') || '48000');
// The full-runtime profile constructs 20 private inserts, four input FX, four
// shared/postmix FX, Rhythm, LIVE_POLY, and transient record/overdub nodes.
// The strict 30-minute workload is bounded at 104 cumulative nodes; leave a
// small, explicit eight-slot margin so diagnostics do not abort the app path.
const MAX_SLOTS = Number(new URLSearchParams(location.search).get('maxInstrumentedNodes') || '112');
if (!Number.isSafeInteger(MAX_SLOTS) || MAX_SLOTS < 35 || MAX_SLOTS > 512) {
  throw new RangeError(`maxInstrumentedNodes must be an integer from 35 through 512; got ${MAX_SLOTS}`);
}
const MAX_DIAGNOSTIC_DETAILS = 32;
const RECENT_CALLBACK_ACTIVITY_SECONDS = 3;
const META_STRIDE = 26;
const MAX_BLOCK_FRAMES = 2_048;
const MAX_DURATION_US = 65_535;
const DURATION_BINS = MAX_DURATION_US + 1;
const READY_TIMEOUT_MS = 30_000;
const DYNAMIC_TRACK_WORKLET_PROCESSORS = new Set([
  'signalsmith-stretch',
  'looper-processor',
  'rc505-overdub-processor',
]);

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

const startButton = document.querySelector('#start');
const statusNode = document.querySelector('#status');
let harnessState = null;

function setStatus(value) {
  statusNode.textContent = value;
}

function serializeException(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message : String(error),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 8_000) : null,
  };
}

function reportSetupPhase(stage, details = {}) {
  window.__rc505BenchPhase = { stage, details, updatedAtUtc: new Date().toISOString() };
  setStatus(stage);
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

function initializeSharedMetadata(meta) {
  for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
    Atomics.store(meta, slot * META_STRIDE + META.lastProcessorFrameEnd, -1);
    Atomics.store(meta, slot * META_STRIDE + META.processorStopFrame, -1);
    Atomics.store(meta, slot * META_STRIDE + META.firstCoverageActiveFrame, -1);
  }
}

function createNodeInstrumentationProxy(state) {
  const NativeAudioWorkletNode = window.AudioWorkletNode;
  if (typeof NativeAudioWorkletNode !== 'function') throw new Error('AudioWorkletNode is unavailable');
  state.NativeAudioWorkletNode = NativeAudioWorkletNode;
  state.nodeDescriptorByNode ??= new WeakMap();

  window.AudioWorkletNode = new Proxy(NativeAudioWorkletNode, {
    construct(target, args) {
      const [context, processorName, originalOptions = {}] = args;
      const slot = state.nodes.length;
      if (slot >= MAX_SLOTS) {
        if (state.nodeConstructionFailures.length < MAX_DIAGNOSTIC_DETAILS) {
          state.nodeConstructionFailures.push({
            processorName,
            attemptedSlot: slot,
            capacity: MAX_SLOTS,
            attemptedAtUtc: new Date().toISOString(),
            reason: 'The test-only AudioWorkletNode instrumentation capacity was exhausted before the browser AudioWorkletNode constructor ran.',
          });
        }
        throw new Error(`The benchmark exceeded its ${MAX_SLOTS}-node probe capacity before creating ${processorName} at slot ${slot}`);
      }
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
      const descriptor = {
        slot,
        label,
        processorName,
        node,
        expectedStopAck: null,
        stopAckCount: 0,
        stopAckType: null,
        captureConfiguredMessages: [],
        captureCompletionMessages: [],
        captureStartRequests: [],
        captureStopRequests: [],
        overdubInitMessages: [],
        overdubBackfillMessages: [],
        overdubErrorMessages: [],
        overdubStopRequests: [],
        overdubFirstInputMessages: [],
        overdubPatchMessages: [],
        overdubStopMessages: [],
        lastObservedCallbackCount: 0,
        lastCallbackActivityAtMs: Number.NEGATIVE_INFINITY,
      };
      state.nodeDescriptorByNode.set(node, descriptor);
      state.nodes.push(descriptor);
      state.waiters.get(label)?.(descriptor);
      const originalPortPostMessage = node.port.postMessage;
      if (typeof originalPortPostMessage === 'function') {
        node.port.postMessage = function (message, ...messageArgs) {
          if ((message?.type === 'START_RECORD' || message?.type === 'START_CAPTURE' || message?.type === 'OVERDUB_INIT')
            && descriptor.coverageCommandFrame === undefined) {
            try {
              descriptor.coverageCommandFrame = readProcessorAudioFrame(state);
              descriptor.coverageStartMessageType = message.type;
            } catch (error) {
              descriptor.coverageStartFrameObservationError = error instanceof Error ? error.message : String(error);
            }
          }
          if (message?.type === 'START_CAPTURE') {
            const request = {
              trackIndex: message.trackIndex,
              sessionId: message.sessionId,
              inputGeneration: message.inputGeneration,
              startFrame: message.startFrame,
              requestedAtProcessorFrame: readProcessorAudioFrame(state),
            };
            descriptor.captureStartRequest = request;
            descriptor.captureStartRequests.push(request);
          } else if (message?.type === 'STOP_CAPTURE') {
            const request = {
              trackIndex: message.trackIndex,
              sessionId: message.sessionId,
              inputGeneration: message.inputGeneration,
              stopFrame: message.stopFrame,
            };
            descriptor.captureStopRequest = request;
            descriptor.captureStopRequests.push(request);
          } else if (descriptor.processorName === 'rc505-overdub-processor' && message?.type === 'OVERDUB_INIT') {
            descriptor.overdubInitMessages.push({
              requestFrame: message.requestFrame ?? null,
              startFrame: message.startFrame,
              channelCount: message.channelCount,
              sentAtProcessorFrame: readProcessorAudioFrame(state),
            });
          } else if (descriptor.processorName === 'rc505-overdub-processor' && message?.type === 'OVERDUB_BACKFILL') {
            descriptor.overdubBackfillMessages.push({
              requestFrame: message.requestFrame,
              firstInputFrame: message.firstInputFrame,
              validFrames: message.validFrames,
              channelCount: message.channelCount,
            });
          } else if (descriptor.processorName === 'rc505-overdub-processor' && message?.type === 'OVERDUB_STOP') {
            descriptor.overdubStopRequests.push({
              requestedStopFrame: message.stopFrame ?? null,
              requestedAtProcessorFrame: readProcessorAudioFrame(state),
              postedAtWallMs: performance.now(),
            });
          }
          return originalPortPostMessage.call(this, message, ...messageArgs);
        };
      }
      node.addEventListener('processorerror', () => state.processorErrors.push({
        slot,
        label,
        processorName,
        message: 'AudioWorklet processorerror event',
      }));
      node.port.addEventListener('message', (event) => {
        if (descriptor.processorName === 'rc505-overdub-processor' && event.data?.type === 'OVERDUB_ERROR') {
          descriptor.overdubErrorMessages.push({ ...event.data, receivedAtWallMs: performance.now() });
        }
        if (descriptor.processorName === 'rc505-input-capture' && event.data?.type === 'RECORD_CONFIGURED') {
          descriptor.captureConfiguredMessages.push({ ...event.data });
        }
        if (descriptor.processorName === 'rc505-input-capture' && event.data?.type === 'RECORD_COMPLETE') {
          descriptor.captureCompletionMessages.push({ ...event.data });
        }
        if (descriptor.processorName === 'rc505-overdub-processor' && event.data?.type === 'OVERDUB_FIRST_INPUT_FRAME') {
          descriptor.overdubFirstInputMessages.push({ ...event.data, receivedAtWallMs: performance.now() });
        }
        if (descriptor.processorName === 'rc505-overdub-processor' && event.data?.type === 'OVERDUB_PATCH') {
          // Keep only scalar range metadata here. Copying the transferred PCM
          // payload would perturb the loaded path and inflate the probe heap.
          descriptor.overdubPatchMessages.push({
            sequence: event.data.sequence,
            startInputFrame: event.data.startInputFrame,
            endInputFrame: event.data.endInputFrame,
            validFrames: event.data.validFrames,
            slotIndex: event.data.slotIndex,
            channelCount: event.data.rightValues instanceof Float32Array ? 2 : 1,
            receivedAtProcessorFrame: readProcessorAudioFrame(state),
            receivedAtWallMs: performance.now(),
          });
        }
        if (descriptor.processorName === 'rc505-overdub-processor' && event.data?.type === 'OVERDUB_STOPPED') {
          descriptor.overdubStopMessages.push({
            ...event.data,
            ackReceivedAtProcessorFrame: readProcessorAudioFrame(state),
            ackReceivedAtWallMs: performance.now(),
          });
        }
        if (descriptor.expectedStopAck && event.data?.type === descriptor.expectedStopAck) {
          descriptor.stopAckCount += 1;
          descriptor.stopAckType = event.data.type;
          try {
            descriptor.stopAckReceivedAtFrame = readProcessorAudioFrame(state);
          } catch (error) {
            descriptor.stopAckFrameObservationError = error instanceof Error ? error.message : String(error);
          }
        }
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
        if (event.data?.type === 'rc505-bench-callback-exception' && event.data.slot === slot
          && state.callbackExceptionDetails.length < MAX_DIAGNOSTIC_DETAILS) {
          state.callbackExceptionDetails.push({
            ...event.data,
            receivedAtUtc: new Date().toISOString(),
          });
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
    snapshot() { return { ...stats }; },
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

function readWorkletCounters(state, slot) {
  const descriptor = state.nodes[slot];
  const stopAck = descriptor?.expectedStopAck != null && descriptor.stopAckCount === 1;
  const stopAcknowledgementType = stopAck ? descriptor?.stopAckType ?? null : null;
  const clockSlot = getProcessorAudioClockSlot(state);
  if (clockSlot === null) {
    let last = null;
    let boundaryFrame = Math.round(state.context.currentTime * state.context.sampleRate);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const beforeFrame = Math.round(state.context.currentTime * state.context.sampleRate);
      const counters = readRawWorkletCounters(state, slot);
      const afterFrame = Math.round(state.context.currentTime * state.context.sampleRate);
      last = counters;
      boundaryFrame = beforeFrame;
      if (beforeFrame === afterFrame && counters.snapshotStable === true) {
        return {
          ...counters,
          stopAcknowledged: stopAck,
          stopAcknowledgementType,
          timelineFrame: beforeFrame,
          timelineStable: true,
          timelineSnapshotAttempts: attempt,
          boundarySource: 'AudioContext.currentTime converted to sample frame; audio timeline, not wall clock',
        };
      }
    }
    return {
      ...(last ?? { frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: null }),
      stopAcknowledged: stopAck,
      stopAcknowledgementType,
      snapshotStable: false,
      timelineFrame: boundaryFrame,
      timelineStable: false,
      timelineSnapshotAttempts: 8,
      boundarySource: 'AudioContext.currentTime converted to sample frame; audio timeline, not wall clock',
    };
  }
  if (slot === clockSlot) {
    const target = readRawWorkletCounters(state, slot);
    const timelineFrame = target.processorFrameEnd ?? null;
    return {
      ...target,
      stopAcknowledged: stopAck,
      stopAcknowledgementType,
      timelineFrame,
      timelineStable: target.snapshotStable === true && timelineFrame !== null,
      timelineSnapshotAttempts: target.snapshotAttempts ?? 1,
      boundarySource: 'rc505-browser-block-meter AudioWorklet currentFrame + block length',
    };
  }

  let last = null;
  let lastClockFrame = null;
  let lastClockAttempts = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const before = readRawWorkletCounters(state, clockSlot);
    const counters = readRawWorkletCounters(state, slot);
    const after = readRawWorkletCounters(state, clockSlot);
    const beforeFrame = before.processorFrameEnd ?? null;
    const afterFrame = after.processorFrameEnd ?? null;
    last = counters;
    lastClockFrame = beforeFrame;
    lastClockAttempts = (before.snapshotAttempts ?? 1) + (after.snapshotAttempts ?? 1);
    if (before.snapshotStable === true && after.snapshotStable === true
      && counters.snapshotStable === true && beforeFrame !== null && beforeFrame === afterFrame
      ) {
      const timelineFrame = counters.processorFrameEnd === null
        ? beforeFrame
        : Math.max(beforeFrame, counters.processorFrameEnd);
      return {
        ...counters,
        stopAcknowledged: stopAck,
        stopAcknowledgementType,
        timelineFrame,
        timelineStable: true,
        timelineSnapshotAttempts: lastClockAttempts,
        boundarySource: 'max(independent block-meter AudioWorklet frame, target last completed process frame)',
      };
    }
  }
  return {
    ...(last ?? { frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: null }),
    stopAcknowledged: stopAck,
    stopAcknowledgementType,
    snapshotStable: false,
    timelineFrame: lastClockFrame,
    timelineStable: false,
    timelineSnapshotAttempts: lastClockAttempts || 1,
    boundarySource: 'rc505-browser-block-meter AudioWorklet currentFrame + block length',
  };
}

function readRawWorkletCounters(state, slot) {
  const base = slot * META_STRIDE;
  return readCoherentWorkletCounters(state.meta, base, {
    callbacksIndex: META.callbacks,
    framesIndex: META.totalFrames,
    callbackErrorsIndex: META.callbackErrors,
    snapshotVersionIndex: META.snapshotVersion,
    processorFrameEndIndex: META.lastProcessorFrameEnd,
    processorStopFrameIndex: META.processorStopFrame,
    coverageCallbacksIndex: META.coverageCallbacks,
    coverageFramesIndex: META.coverageFrames,
    unexpectedTerminationCountIndex: META.unexpectedTerminationCount,
    missingProcessorFramesIndex: META.coverageMissingFrames,
    firstActiveFrameIndex: META.firstCoverageActiveFrame,
  }, 64);
}

function readProcessorAudioFrame(state) {
  const clockSlot = getProcessorAudioClockSlot(state);
  if (clockSlot !== null) return readRawWorkletCounters(state, clockSlot).processorFrameEnd ?? null;
  const graph = window.__rc505BenchGraph;
  return graph?.context ? Math.round(graph.context.currentTime * graph.context.sampleRate) : null;
}

function expectWorkletStop(node, ackType) {
  const state = harnessState;
  const descriptor = state?.nodeDescriptorByNode?.get(node);
  if (!descriptor) throw new Error(`Cannot authorize stop for an unregistered worklet (${ackType})`);
  const expectedType = descriptor.processorName === 'looper-processor' ? 'RECORD_COMPLETE'
    : descriptor.processorName === 'rc505-overdub-processor' ? 'OVERDUB_STOPPED' : null;
  if (expectedType !== ackType) {
    throw new Error(`Stop ACK ${ackType} is invalid for ${descriptor.processorName}; expected ${expectedType ?? 'no stop ACK'}`);
  }
  if (descriptor.expectedStopAck !== null || descriptor.stopAckCount !== 0) {
    throw new Error(`Worklet ${descriptor.label} already has a stop request/ACK lifecycle`);
  }
  const counters = readRawWorkletCounters(state, descriptor.slot);
  if (counters.processorStopFrame !== null || counters.unexpectedTerminationCount !== 0) {
    const startupContext = descriptor.processorName === 'rc505-overdub-processor'
      ? {
        overdubErrors: descriptor.overdubErrorMessages,
        initMessages: descriptor.overdubInitMessages,
        firstInputMessages: descriptor.overdubFirstInputMessages,
        backfillMessages: descriptor.overdubBackfillMessages,
        stopRequests: descriptor.overdubStopRequests,
        stopMessages: descriptor.overdubStopMessages,
        controlCalls: state.workload?.overdubControlCalls ?? [],
        receivedPatches: state.workload?.overdubPatchReceiveTrace ?? [],
      }
      : null;
    throw new Error(`Worklet ${descriptor.label} terminated before its explicit stop request: ${JSON.stringify({ counters, startupContext })}`);
  }
  descriptor.expectedStopAck = ackType;
  Atomics.store(state.meta, descriptor.slot * META_STRIDE + META.stopAuthorization, 1);
  return descriptor;
}

function expectWorkletStart(node, requestedStartFrame) {
  const descriptor = harnessState?.nodeDescriptorByNode?.get(node);
  if (!descriptor) throw new Error('Cannot record an activation boundary for an unregistered worklet');
  if (descriptor.processorName !== 'looper-processor'
    && descriptor.processorName !== 'rc505-overdub-processor'
    && descriptor.processorName !== 'rc505-input-capture') {
    throw new Error(`Activation boundary is not supported for ${descriptor.processorName}`);
  }
  if (!Number.isSafeInteger(requestedStartFrame) || requestedStartFrame < 0) {
    throw new RangeError(`Invalid high-level operation request frame: ${requestedStartFrame}`);
  }
  if (!Number.isSafeInteger(descriptor.coverageCommandFrame) || descriptor.coverageCommandFrame < 0) {
    throw new Error(`Worklet ${descriptor.label} has no coherent processor-frame start-command observation`);
  }
  if (descriptor.coverageStartFrame !== undefined && descriptor.coverageStartFrame !== null) {
    throw new Error(`Worklet ${descriptor.label} already has a start-frame expectation`);
  }
  descriptor.coverageStartFrame = requestedStartFrame;
  descriptor.coverageStartCountersFromZero = true;
  return {
    requestedStartFrame,
    commandFrame: descriptor.coverageCommandFrame,
    requestToCommandFrames: descriptor.coverageCommandFrame - requestedStartFrame,
    startMessageType: descriptor.coverageStartMessageType,
    firstActiveFrame: readRawWorkletCounters(harnessState, descriptor.slot).firstActiveFrame,
  };
}

function expectInputCaptureCompletion(node) {
  const descriptor = harnessState?.nodeDescriptorByNode?.get(node);
  if (!descriptor || descriptor.processorName !== 'rc505-input-capture') {
    throw new Error('Shared input capture completion can only be observed on rc505-input-capture');
  }
  const previousCount = descriptor.captureCompletionMessages.length;
  const expectedCount = descriptor.expectedCaptureCompletionCount ?? previousCount;
  if (expectedCount !== previousCount) {
    throw new Error(`Shared input capture ${descriptor.label} has an unobserved prior completion`);
  }
  descriptor.expectedCaptureCompletionCount = expectedCount + 1;
  return { descriptor, previousCount };
}

function getSharedInputCaptureDescriptor(graph) {
  if (!graph?.diagnosticSharedInputCapture || !Number.isInteger(graph.sharedInputCapture?.instrumentedSlot)) return null;
  const descriptor = harnessState?.nodes?.[graph.sharedInputCapture.instrumentedSlot];
  if (!descriptor || descriptor.processorName !== 'rc505-input-capture') {
    throw new Error('The declared persistent shared-input tap is missing from the AudioWorklet descriptor registry');
  }
  return descriptor;
}

async function waitForInputCaptureCompletion(node, expectation, timeoutMs = 10_000) {
  const descriptor = harnessState?.nodeDescriptorByNode?.get(node);
  if (!descriptor || descriptor !== expectation.descriptor) {
    throw new Error('Shared input capture node changed during the recording session');
  }
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const messages = descriptor.captureCompletionMessages;
    if (messages.length > expectation.previousCount + 1) {
      throw new Error(`Shared input capture ${descriptor.label} sent duplicate RECORD_COMPLETE messages`);
    }
    if (messages.length === expectation.previousCount + 1) {
      const message = messages[expectation.previousCount];
      const stop = descriptor.captureStopRequest;
      if (stop?.sessionId !== message.sessionId
        || stop?.inputGeneration !== message.inputGeneration
        || stop?.stopFrame !== message.stopFrame) {
        throw new Error(`Shared input capture RECORD_COMPLETE does not match its STOP_CAPTURE request: ${JSON.stringify({ stop, complete: message })}`);
      }
      return {
        ackType: 'RECORD_COMPLETE',
        ackCount: 1,
        processorRemainsActive: true,
        message: {
          sessionId: message.sessionId,
          inputGeneration: message.inputGeneration,
          requestedStartFrame: message.requestedStartFrame,
          stopFrame: message.stopFrame,
          framesCaptured: message.framesCaptured,
          droppedFrames: message.droppedFrames,
          overflowEvents: message.overflowEvents,
          channelCount: message.channelCount,
          status: message.status,
          chunksSent: message.chunksSent,
        },
      };
    }
    if (harnessState?.processorErrors.length) {
      throw new Error(`AudioWorklet processor error before shared-capture completion: ${JSON.stringify(harnessState.processorErrors)}`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for shared input capture RECORD_COMPLETE on ${descriptor.label}`);
}

async function waitForWorkletStopAck(node, ackType, timeoutMs = 10_000) {
  const descriptor = harnessState?.nodeDescriptorByNode?.get(node);
  if (!descriptor || descriptor.expectedStopAck !== ackType) {
    throw new Error(`Worklet stop ACK ${ackType} was not authorized before the stop command`);
  }
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const counters = readWorkletCounters(harnessState, descriptor.slot);
    if (descriptor.stopAckCount > 1) {
      throw new Error(`Worklet ${descriptor.label} sent ${descriptor.stopAckCount} ${ackType} ACKs for one stop request`);
    }
    if (descriptor.stopAckCount === 1) {
      if (counters.processorStopFrame === null) {
        throw new Error(`Worklet ${descriptor.label} ACKed ${ackType} without a processor-frame terminal callback`);
      }
      if ((counters.unexpectedTerminationCount ?? 0) !== 0) {
        throw new Error(`Worklet ${descriptor.label} had an unrequested false return before ${ackType}`);
      }
      return { processorStopFrame: counters.processorStopFrame, ackType, ackCount: descriptor.stopAckCount };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${ackType} AudioWorklet stop acknowledgement`);
}

function getProcessorAudioClockSlot(state) {
  if (state.processorAudioClockSlotResolved) return state.processorAudioClockSlot;
  const candidates = state.nodes.filter((node) => node.processorName === 'rc505-browser-block-meter');
  if (candidates.length > 1) {
    throw new Error(`Expected one independent block-meter AudioWorklet frame clock, found ${candidates.length}`);
  }
  state.processorAudioClockSlot = candidates[0]?.slot ?? null;
  state.processorAudioClockSlotResolved = true;
  return state.processorAudioClockSlot;
}

function activeDynamicWorklets(graph) {
  const state = harnessState;
  if (!state || !graph) return [];
  const active = [];
  const add = (node, role, trackId = null) => {
    const descriptor = node && state.nodeDescriptorByNode?.get(node);
    if (!descriptor) {
      if (node) throw new Error(`Active ${role} worklet is missing from the instrumented node registry`);
      return;
    }
    active.push({
      slot: descriptor.slot,
      role,
      trackId,
      ...(descriptor.coverageStartFrame !== undefined && descriptor.coverageStartFrame !== null
        ? { expectedStartFrame: descriptor.coverageStartFrame, startCountersFromZero: descriptor.coverageStartCountersFromZero === true }
        : {}),
    });
  };

  if (Array.isArray(graph.runtimeTracks)) {
    for (const track of graph.runtimeTracks) {
      const trackId = Number.isInteger(track.track?.id) ? track.track.id : null;
      if (track.livePolyPitchActive && track.livePolyPitchNode) {
        add(track.livePolyPitchNode, 'live-poly', trackId);
      }
      // The shared input capture node is a persistent graph processor. Its
      // callbacks are covered for the whole graph lifetime; only its per-take
      // R/F/S capture contract is dynamic. Reclassifying the same tap as a new
      // recorder on every take would reuse one worklet's lifetime counters as
      // if they had reset and would break sequential capture sessions.
      const sharedCaptureNode = track.recordingCaptureSession?.node === track.workletNode;
      if (track.workletNode && !sharedCaptureNode
        && (track.isRecording || hasPendingExpectedStopAck(track.workletNode))) {
        add(track.workletNode, 'recorder', trackId);
      }
      if (track.overdubProcessor && (track.state === 'OVERDUBBING' || hasPendingExpectedStopAck(track.overdubProcessor))) {
        add(track.overdubProcessor, 'overdub', trackId);
      }
    }
  } else if (graph.livePoly) {
    add(graph.livePoly, 'synthetic-live-poly');
  }
  return active;
}

function hasPendingExpectedStopAck(node) {
  const descriptor = harnessState?.nodeDescriptorByNode?.get(node);
  return !!descriptor?.expectedStopAck && descriptor.stopAckCount === 0;
}

function syncActiveWorkletCoverage(graph, frame = null) {
  const state = harnessState;
  if (!state?.activeWorkletCoverage || !graph?.context) return [];
  // Keep this monotonic guard tied to the Web Audio timeline. Each interval's
  // actual boundary comes from the independent block-meter processor frame.
  const audioFrame = frame ?? Math.round(graph.context.currentTime * graph.context.sampleRate);
  return state.activeWorkletCoverage.sync(
    audioFrame,
    activeDynamicWorklets(graph),
    (slot) => readWorkletCounters(state, slot),
  );
}

function getPrivateTrackCoverageSnapshot(graph) {
  const descriptors = graph.privateTrackFxDescriptors ?? [];
  return {
    audioContextFrame: Math.round(graph.context.currentTime * graph.context.sampleRate),
    audioContextTimeSeconds: graph.context.currentTime,
    boundarySource: getProcessorAudioClockSlot(harnessState) === null
      ? 'AudioContext.currentTime converted to sample frame; audio timeline, not wall clock'
      : 'max(independent block-meter AudioWorklet frame, target last completed process frame)',
    slots: descriptors.map((descriptor) => ({
      ...descriptor,
      counters: readWorkletCounters(harnessState, descriptor.instrumentedSlot),
    })),
  };
}

function comparePrivateTrackCoverageSnapshots(start, end) {
  const audioContextExpectedFrames = end.audioContextFrame - start.audioContextFrame;
  const startBySlot = new Map(start.slots.map((slot) => [slot.instrumentedSlot, slot]));
  const slots = end.slots.map((slot) => {
    const before = startBySlot.get(slot.instrumentedSlot);
    const observedFrames = before ? slot.counters.frames - before.counters.frames : 0;
    const callbacks = before ? slot.counters.callbacks - before.counters.callbacks : 0;
    const callbackErrors = before ? slot.counters.callbackErrors - before.counters.callbackErrors : 0;
    const snapshotStable = before?.counters.snapshotStable === true && slot.counters.snapshotStable === true
      && before.counters.timelineStable === true && slot.counters.timelineStable === true;
    const startTimelineFrame = before?.counters.timelineFrame ?? null;
    const endTimelineFrame = slot.counters.timelineFrame ?? null;
    const timelineBoundariesUsable = snapshotStable && startTimelineFrame !== null && endTimelineFrame !== null
      && endTimelineFrame >= startTimelineFrame;
    const expectedFrames = timelineBoundariesUsable ? endTimelineFrame - startTimelineFrame : null;
    const processorFrameAdvance = before?.counters.processorFrameEnd !== null
      && before?.counters.processorFrameEnd !== undefined
      && slot.counters.processorFrameEnd !== null
      && slot.counters.processorFrameEnd !== undefined
      ? slot.counters.processorFrameEnd - before.counters.processorFrameEnd
      : null;
    return {
      trackId: slot.trackId,
      slot: slot.effectSlot,
      type: slot.type,
      label: slot.label,
      audioContextExpectedFrames,
      expectedFrames,
      observedFrames,
      callbacks,
      callbackErrors,
      snapshotStable,
      snapshotAttempts: (before?.counters.snapshotAttempts ?? 0) + (slot.counters.snapshotAttempts ?? 0),
      startTimelineFrame,
      endTimelineFrame,
      timelineSnapshotAttempts: (before?.counters.timelineSnapshotAttempts ?? 0)
        + (slot.counters.timelineSnapshotAttempts ?? 0),
      processorFrameEndAtStart: before?.counters.processorFrameEnd ?? null,
      processorFrameEndAtStop: slot.counters.processorFrameEnd ?? null,
      processorFrameAdvance,
      processorFrameAdvanceDeltaFromExpected: processorFrameAdvance === null || expectedFrames === null
        ? null : processorFrameAdvance - expectedFrames,
      coverageRatio: expectedFrames !== null && expectedFrames > 0 ? observedFrames / expectedFrames : null,
      passed: expectedFrames !== null && expectedFrames > 0 && callbacks > 0 && callbackErrors === 0
        && snapshotStable && observedFrames / expectedFrames >= 0.95,
    };
  });
  const tracks = Array.from({ length: 5 }, (_, index) => {
    const trackId = index + 1;
    const trackSlots = slots.filter((slot) => slot.trackId === trackId);
    return {
      trackId,
      slotCount: trackSlots.length,
      slots: trackSlots,
      minimumCoverageRatio: trackSlots.length > 0
        ? Math.min(...trackSlots.map((slot) => slot.coverageRatio ?? 0))
        : null,
      passed: trackSlots.length === 4 && trackSlots.every((slot) => slot.passed),
    };
  });
  return {
    audioContextExpectedFrames,
    boundarySource: end.boundarySource,
    tracks,
    passed: slots.length === 20 && tracks.every((track) => track.passed),
  };
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
  initializeSharedMetadata(meta);
  harnessState = {
    context,
    layout,
    buffer,
    meta,
    nodes: [],
    waiters: new Map(),
    readySlots: new Set(),
    processorErrors: [],
    callbackExceptionDetails: [],
    nodeConstructionFailures: [],
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
    harnessState.persistentSlotSet = new Set(harnessState.nodes
      .filter((node) => !DYNAMIC_TRACK_WORKLET_PROCESSORS.has(node.processorName))
      .map((node) => node.slot));
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
  harnessState.persistentSlotSet = new Set(harnessState.nodes
    .filter((node) => !DYNAMIC_TRACK_WORKLET_PROCESSORS.has(node.processorName))
    .map((node) => node.slot));
  window.__rc505BenchSetupReady = true;

  return { context, master, inputFx, trackFx, inputSource, trackSources, directProbeSource, directProbeWorklet, trackMix, outputProbe, outputProbeHeartbeat: outputProbeState?.heartbeat ?? null, outputAnalyser, outputSampler, livePoly, rhythm, diagnosticStage };
}

function createStereoLoop(context, frequency, phase, seconds = 1.25) {
  const frames = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / context.sampleRate;
    left[frame] = 0.22 * Math.sin((2 * Math.PI * frequency * t) + phase)
      + 0.025 * Math.sin((2 * Math.PI * frequency * 2.01 * t) + phase * 0.5);
    right[frame] = 0.17 * Math.sin((2 * Math.PI * (frequency * 1.37) * t) + phase + 0.31)
      + 0.018 * Math.sin((2 * Math.PI * frequency * 3.03 * t) + 0.11);
  }
  return buffer;
}

const FULL_RUNTIME_TRACK_FX = Object.freeze([
  ['DSP LPF', 'DIST', 'CHORUS', 'DELAY'],
  ['PHASER', 'TREMOLO', 'AUTO PAN', 'FDN8 REVERB'],
  ['FLANGER', 'RING.MOD', 'MOD DELAY', 'PANNING DELAY'],
  ['DYNAMICS', 'SUSTAINER', 'TAPE ECHO', 'GRANULAR DELAY'],
  ['PREAMP', 'GATE REVERB', 'VIBRATO', 'STEREO ENHANCE'],
]);
const FULL_RUNTIME_INPUT_FX = Object.freeze(['DSP LPF', 'DIST', 'VIBRATO', 'SUSTAINER']);
const FULL_RUNTIME_SHARED_FX = Object.freeze(['CHORUS', 'FDN8 REVERB', 'DELAY', 'AUTO PAN']);
const DIAGNOSTIC_DISABLE_LIVE_POLY = new URLSearchParams(location.search).get('diagnosticDisableLivePoly') === '1';
const DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX = new URLSearchParams(location.search).get('diagnosticOmitPrivateTrackFx') === '1';
const DIAGNOSTIC_SHARED_INPUT_CAPTURE = new URLSearchParams(location.search).get('diagnosticSharedInputCapture') === '1';

async function setupFullRuntimeGraph() {
  reportSetupPhase('full-runtime: checking cross-origin isolation');
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    throw new Error('SharedArrayBuffer instrumentation requires cross-origin isolation (COOP/COEP headers)');
  }
  reportSetupPhase('full-runtime: importing BrowserAudioEngine and TrackAudio');
  const loadModule = (specifier) => (new Function('specifier', 'return import(specifier)'))(specifier);
  const [{ BrowserAudioEngine }, { TrackAudio }] = await Promise.all([
    loadModule('/src/audio/BrowserAudioEngine.ts'),
    loadModule('/src/audio/TrackAudio.ts'),
  ]);
  reportSetupPhase('full-runtime: constructing BrowserAudioEngine');
  const engine = new BrowserAudioEngine();
  const context = engine.context;
  if (context.sampleRate !== REQUESTED_SAMPLE_RATE) {
    throw new Error(`BrowserAudioEngine opened at ${context.sampleRate} Hz, not the requested ${REQUESTED_SAMPLE_RATE} Hz`);
  }

  const layout = createSharedLayout();
  const buffer = new SharedArrayBuffer(layout.byteLength);
  const meta = new Int32Array(buffer, layout.metaByteOffset, layout.metaLength);
  initializeSharedMetadata(meta);
  harnessState = {
    context,
    layout,
    buffer,
    meta,
    nodes: [],
    waiters: new Map(),
    readySlots: new Set(),
    processorErrors: [],
    callbackExceptionDetails: [],
    nodeConstructionFailures: [],
    timingClockBySlot: {},
    pendingNodeLabel: null,
    fxModulePromise: null,
    ensureFxModule() {
      this.fxModulePromise ??= context.audioWorklet.addModule('/worklets/fx-processor.js');
      return this.fxModulePromise;
    },
  };
  const state = harnessState;
  reportSetupPhase('full-runtime: resuming AudioContext and registering worklets');
  createNodeInstrumentationProxy(state);
  await context.resume();
  if (context.state !== 'running') throw new Error(`BrowserAudioEngine context did not enter running state: ${context.state}`);
  await context.audioWorklet.addModule('/bench/worklets/output-finite-probe.js');
  await context.audioWorklet.addModule('/bench/worklets/instrument-register-processor.js');
  await context.audioWorklet.addModule('/bench/worklets/instrumented-heartbeat.js');
  reportSetupPhase('full-runtime: initializing BrowserAudioEngine');
  await engine.init();

  reportSetupPhase('full-runtime: preparing shared/input FX in bypass');
  for (let slotIndex = 0; slotIndex < FULL_RUNTIME_INPUT_FX.length; slotIndex += 1) {
    const type = FULL_RUNTIME_INPUT_FX[slotIndex];
    engine.setFxType('input', slotIndex, type);
    engine.setFxActive('input', slotIndex, false);
    engine.setFxParam('input', slotIndex, 18);
  }
  for (let slotIndex = 0; slotIndex < FULL_RUNTIME_SHARED_FX.length; slotIndex += 1) {
    const type = FULL_RUNTIME_SHARED_FX[slotIndex];
    engine.setFxType('track', slotIndex, type);
    engine.setFxActive('track', slotIndex, false);
    engine.setFxParam('track', slotIndex, 12);
  }

  const selectedTrackEffects = [];
  const privateTrackFxDescriptors = [];
  if (DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX) {
    reportSetupPhase('diagnostic: omitting all twenty private track FX processors');
  } else {
    for (let trackId = 1; trackId <= 5; trackId += 1) {
      reportSetupPhase(`full-runtime: enabling private FX for track ${trackId}/5`);
      const types = FULL_RUNTIME_TRACK_FX[trackId - 1];
      for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
        const type = types[slotIndex];
        const effectSlot = String.fromCharCode(65 + slotIndex);
        const nodeLabel = `track-${trackId}-private-${effectSlot}-${type.replaceAll(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`;
        const construction = waitForNode(nodeLabel);
        setNextNodeLabel(nodeLabel);
        if (!engine.setTrackFxType(trackId, slotIndex, type)) {
          throw new Error(`Could not request Track ${trackId} private FX ${String.fromCharCode(65 + slotIndex)}: ${type}`);
        }
        const nodeDescriptor = await construction;
        nodeDescriptor.trackId = trackId;
        nodeDescriptor.effectSlot = effectSlot;
        nodeDescriptor.trackFxType = type;
        privateTrackFxDescriptors.push({
          trackId,
          effectSlot,
          type,
          label: nodeLabel,
          instrumentedSlot: nodeDescriptor.slot,
        });
        engine.setTrackFxParameter(trackId, slotIndex, 12);
        if (!engine.setTrackFxActive(trackId, slotIndex, false)) {
          throw new Error(`Could not stage Track ${trackId} private FX ${String.fromCharCode(65 + slotIndex)}: ${type}`);
        }
        selectedTrackEffects.push({ trackId, slot: String.fromCharCode(65 + slotIndex), type });
      }
    }
  }

  const waitUntil = async (predicate, label, timeoutMs = 90_000) => {
    const deadline = performance.now() + timeoutMs;
    let lastProgressReport = performance.now();
    while (performance.now() < deadline) {
      if (state.processorErrors.length > 0) {
        throw new Error(`AudioWorklet processor error while waiting for ${label}: ${JSON.stringify(state.processorErrors)}`);
      }
      if (predicate()) return;
      if (performance.now() - lastProgressReport >= 2_000) {
        const trackStatuses = engine.getTrackFxStatus().flatMap((bank) => bank.slots
          .filter((slot) => slot.state !== 'ready' || !slot.active || slot.error)
          .map((slot) => ({ trackId: bank.trackId, slot: slot.slot, type: slot.type, state: slot.state, active: slot.active, error: slot.error })));
        const sharedEffects = [...engine.inputFxInstances, ...engine.trackFxInstances].filter(Boolean);
        reportSetupPhase(`full-runtime: waiting for ${label}`, {
          readySlots: state.readySlots.size,
          nodeCount: state.nodes.length,
          processorErrors: [...state.processorErrors],
          pendingTrackFx: trackStatuses,
          sharedFxCount: sharedEffects.length,
          sharedFxPending: sharedEffects.filter((effect) => effect.error || !effect.processorReady)
            .map((effect) => ({ algorithm: effect.algorithm, error: effect.error, processorReady: effect.processorReady })),
        });
        lastProgressReport = performance.now();
      }
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  // Input is generated in this test page and routed through the actual public
  // Browser input-FX chain. The production recording API is pointed at that
  // processed node so no microphone or user device is accessed.
  const inputMerger = context.createChannelMerger(2);
  const leftOscillator = context.createOscillator();
  const rightOscillator = context.createOscillator();
  const leftGain = context.createGain();
  const rightGain = context.createGain();
  leftOscillator.type = rightOscillator.type = 'sine';
  leftOscillator.frequency.value = 377;
  rightOscillator.frequency.value = 911;
  leftGain.gain.value = 0.3;
  rightGain.gain.value = 0.21;
  leftOscillator.connect(leftGain).connect(inputMerger, 0, 0);
  rightOscillator.connect(rightGain).connect(inputMerger, 0, 1);
  inputMerger.connect(engine.inputFxChain.input);
  leftOscillator.start();
  rightOscillator.start();
  let sharedInputCapture = null;
  if (DIAGNOSTIC_SHARED_INPUT_CAPTURE) {
    if (engine.currentInputStream) throw new Error('The isolated benchmark unexpectedly initialized an authorized input stream');
    // Harness-only route substitution: the synthetic merger above is the
    // source whose engine Input A-D FX output is captured. This initializes
    // the same persistent engine-owned worklet as an already-authorized
    // device input without requesting microphone access or a user device.
    engine.currentInputStream = inputMerger;
    const label = 'engine-shared-input-capture';
    const construction = waitForNode(label);
    setNextNodeLabel(label);
    await engine.activateInputCaptureTap();
    const descriptor = await construction;
    sharedInputCapture = {
      enabled: true,
      processorName: descriptor.processorName,
      label,
      instrumentedSlot: descriptor.slot,
      route: 'synthetic stereo oscillator -> BrowserAudioEngine Input A-D FX -> engine-owned rc505-input-capture -> muted destination; no microphone/device permission requested',
      persistent: true,
    };
  }
  engine.getProcessedInputNode = async () => engine.inputFxChain.output;

  const privateStatusReady = () => DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX || engine.getTrackFxStatus().length === 5
    && engine.getTrackFxStatus().every((bank, trackIndex) => bank.trackId === trackIndex + 1
      && bank.slots.length === 4
      && bank.slots.every((slot, slotIndex) => slot.type === FULL_RUNTIME_TRACK_FX[trackIndex][slotIndex]
        && slot.active && !slot.bypassed && slot.state === 'ready'));
  const sharedEffectsReady = () => [...engine.inputFxInstances, ...engine.trackFxInstances]
    .filter(Boolean).length === 8
    && [...engine.inputFxInstances, ...engine.trackFxInstances]
      .filter(Boolean).every((effect) => !effect.error && effect.processorReady);
  reportSetupPhase('full-runtime: seeding five stereo PCM loops');
  const tracks = engine.tracks;
  if (tracks.length !== 5) throw new Error(`BrowserAudioEngine exposed ${tracks.length} tracks, expected five`);
  const preparedBuffers = tracks.map((_, index) => createStereoLoop(context, 110 + (index * 37), index * 0.31));
  const restored = TrackAudio.restoreProjectBuffersAtomically(tracks, preparedBuffers);
  if (!restored.ok) throw new Error(`Could not seed deterministic stereo loops: ${restored.reason}`);
  reportSetupPhase('full-runtime: starting five PCM loops on the ordinary source route');
  await Promise.all(tracks.map((track) => track.play()));
  if (DIAGNOSTIC_DISABLE_LIVE_POLY) {
    reportSetupPhase('diagnostic: skipping all five LIVE_POLY processors');
  } else {
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      const stage = `full-runtime: enabling LIVE_POLY track ${index + 1}/5`;
      reportSetupPhase(stage, { trackId: track.track.id, bufferChannels: track.audioBuffer?.numberOfChannels ?? null });
      let operationError = null;
      let operationSettled = false;
      const operation = track.setLivePolyPitchEnabled(true, {
        semitones: index % 2 === 0 ? 5 : -3,
        playbackRate: 1,
        tonalityLimitHz: 8_000,
      }).then(() => { operationSettled = true; }, (error) => {
        operationError = error;
        operationSettled = true;
      });
      const operationStartedAt = performance.now();
      while (!operationSettled) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        if (!operationSettled) {
          reportSetupPhase(`${stage} (still pending)`, {
            trackId: track.track.id,
            elapsedMs: Math.round(performance.now() - operationStartedAt),
            hasNode: Boolean(track.livePolyPitchNode),
            nodePromisePending: Boolean(track.livePolyPitchNodePromise),
            enabled: Boolean(track.livePolyPitchEnabledInternal),
            active: track.livePolyPitchActive,
            state: track.state,
            playbackRevision: track.playbackRevision,
            processorErrors: [...state.processorErrors],
          });
        }
      }
      await operation;
      if (operationError) throw operationError;
    }
  }
  if (!DIAGNOSTIC_DISABLE_LIVE_POLY) {
    await waitUntil(() => tracks.every((track) => track.livePolyPitchActive), 'five active per-track LIVE_POLY Signalsmith processors');
  }

  // Build and warm the pitch processors before asking the full active FX graph
  // to render. This changes only setup order; every requested stage is active
  // throughout the timed workload below.
  reportSetupPhase('full-runtime: activating all input/shared/private FX stages');
  for (let slotIndex = 0; slotIndex < FULL_RUNTIME_INPUT_FX.length; slotIndex += 1) {
    engine.setFxActive('input', slotIndex, true);
  }
  for (let slotIndex = 0; slotIndex < FULL_RUNTIME_SHARED_FX.length; slotIndex += 1) {
    engine.setFxActive('track', slotIndex, true);
  }
  if (!DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX) {
    for (let trackId = 1; trackId <= 5; trackId += 1) {
      for (let slotIndex = 0; slotIndex < 4; slotIndex += 1) {
        const type = FULL_RUNTIME_TRACK_FX[trackId - 1][slotIndex];
        if (!engine.setTrackFxActive(trackId, slotIndex, true)) {
          throw new Error(`Could not activate Track ${trackId} private FX ${String.fromCharCode(65 + slotIndex)}: ${type}`);
        }
      }
    }
  }
  reportSetupPhase(DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX
    ? 'diagnostic: waiting for eight active input/shared FX adapters'
    : 'full-runtime: waiting for 28 active input/shared/private FX adapters');
  await waitUntil(() => privateStatusReady() && sharedEffectsReady(), DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX
    ? 'all eight active input/shared FX adapters'
    : 'all 28 active input/shared/private A–D FX adapters');

  reportSetupPhase('full-runtime: starting production rhythm');
  const pattern = RHYTHM_PATTERN_CATALOG[0];
  if (!pattern || !engine.rhythmEngine.setSettings({
    patternIndex: 1,
    kitIndex: 1,
    variation: pattern.variations[0],
    section: 'main',
    swingPercent: 58,
    quantizeGrid: '1/16',
  })) throw new Error('The production Browser RhythmEngine rejected its supported clean-room fixture');
  engine.rhythmEngine.setVolume(18);
  engine.rhythmEngine.start();
  // RhythmEngine creates its worklet asynchronously.
  await waitUntil(() => state.nodes.some((node) => node.processorName === 'rc505-rhythm-processor'), 'production RhythmEngine worklet');
  reportSetupPhase('full-runtime: waiting for all worklet readiness and first callbacks');
  await waitForReadyNodes(state);
  await waitForFirstCallbacks(state);
  await new Promise((resolve) => window.setTimeout(resolve, 1_000));

  const expectedInitialNodeCount = 35 + (sharedInputCapture ? 1 : 0);
  if (state.nodes.length !== expectedInitialNodeCount) {
    throw new Error(`Full-runtime graph constructed ${state.nodes.length} initial worklets; expected ${expectedInitialNodeCount}${sharedInputCapture ? ' (35-node graph + one shared capture tap)' : ''}`);
  }

  // Only the steady graph nodes are required to cover the complete timed
  // interval. Recorder/overdub nodes are deliberately event-driven later.
  state.persistentSlotSet = new Set(state.nodes
    .filter((node) => !DYNAMIC_TRACK_WORKLET_PROCESSORS.has(node.processorName))
    .map((node) => node.slot));
  state.privateTrackFxDescriptors = privateTrackFxDescriptors;
  const outputAnalyser = context.createAnalyser();
  outputAnalyser.fftSize = 8_192;
  engine.masterGainNode.connect(outputAnalyser);
  outputAnalyser.connect(context.destination);
  const outputSampler = createOutputSampler(context, outputAnalyser);
  reportSetupPhase('full-runtime: graph ready');
  window.__rc505BenchSetupReady = true;
  const workload = {
    profile: 'browser-application-full-private-track-fx',
    appEngine: 'production BrowserAudioEngine + TrackAudio + BrowserTrackFxChain + RhythmEngine',
    sampleRateHz: context.sampleRate,
    activeTrackCount: 5,
    activePrivateTrackFxCount: selectedTrackEffects.length,
    privateTrackFxMatrix: selectedTrackEffects,
    activeInputFx: FULL_RUNTIME_INPUT_FX.map((type, slotIndex) => ({ slot: String.fromCharCode(65 + slotIndex), type })),
    activeSharedTrackFx: FULL_RUNTIME_SHARED_FX.map((type, slotIndex) => ({ slot: String.fromCharCode(65 + slotIndex), type })),
    activeLivePolyTracks: tracks.filter((track) => track.livePolyPitchActive).map((track) => track.track.id),
    diagnosticIsolation: [
      DIAGNOSTIC_DISABLE_LIVE_POLY ? 'All five LIVE_POLY processors were intentionally omitted.' : null,
      DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX ? 'All twenty private A–D FX processors were intentionally omitted.' : null,
    ].filter(Boolean).join(' ') || null,
    rhythm: {
      adapter: 'production Browser RhythmEngine + rc505-rhythm-processor',
      patternId: engine.rhythmEngine.patternMetadata.id,
      patternName: engine.rhythmEngine.patternMetadata.pattern,
      kitIndex: 1,
      provenance: engine.rhythmEngine.eventProvenance,
    },
    pcmSeed: 'deterministic stereo PCM installed through TrackAudio.restoreProjectBuffersAtomically before measurement; real Browser recording/overdub operations execute during measurement',
    initialInstrumentedWorkletCount: state.nodes.length,
    topologyDeclaration: sharedInputCapture
      ? '36 initial instrumented nodes = the unchanged 35-node full-runtime topology plus one persistent engine-owned Browser input capture tap'
      : '35 initial instrumented nodes = the standard full-runtime topology; no shared Browser input capture tap',
    sharedInputCapture,
    instrumentationNodeSlotCapacity: MAX_SLOTS,
    instrumentationSharedMemoryBytes: layout.byteLength,
    instrumentationSharedMemoryMiB: layout.byteLength / (1024 * 1024),
    instrumentationMemoryNote: 'Test-only callback instrumentation SharedArrayBuffer; this is added to the browser process memory footprint and can affect scheduling. It is not application audio memory.',
    dynamicOperationsDuringMeasurement: [],
    overdubControlCalls: [],
    overdubPatchReceiveTrace: [],
    persistentWorkletSlots: [...state.persistentSlotSet],
    privateTrackFxWorklets: privateTrackFxDescriptors,
  };
  if (sharedInputCapture) {
    // Diagnostic-only event tracing: capture the caller and track state for
    // every control command capable of stopping an active overdub. This is
    // written only to operation/error telemetry and is not part of app code.
    for (const track of tracks) {
      for (const methodName of ['triggerRecord', 'triggerStop', 'stopOverdub']) {
        const original = track[methodName];
        if (typeof original !== 'function') continue;
        track[methodName] = function (...args) {
          const activeOverdub = Boolean(this.overdubProcessor) || this.state === 'OVERDUBBING';
          if (methodName === 'stopOverdub' || activeOverdub && methodName !== 'triggerRecord') {
            workload.overdubControlCalls.push({
              trackId: this.track?.id ?? null,
              method: methodName,
              wallMs: performance.now(),
              state: this.state,
              processorPresent: Boolean(this.overdubProcessor),
              starting: Boolean(this.overdubStarting),
              stopping: Boolean(this.overdubStopping),
              diagnostic: this.overdubDiagnostic ?? null,
              rollbackAborted: Boolean(this.overdubRollbackAborted),
              nextPatchSequence: this.overdubNextPatchSequence ?? null,
              receivedPatchMessages: this.overdubReceivedPatchMessages ?? null,
              lastReceivedPatchEndFrame: this.overdubLastReceivedPatchEndFrame ?? null,
              stack: new Error(`TrackAudio.${methodName}`).stack,
            });
          } else if (methodName === 'triggerRecord' && this.state === 'OVERDUBBING') {
            workload.overdubControlCalls.push({
              trackId: this.track?.id ?? null,
              method: methodName,
              wallMs: performance.now(),
              state: this.state,
              processorPresent: Boolean(this.overdubProcessor),
              starting: Boolean(this.overdubStarting),
              stopping: Boolean(this.overdubStopping),
              diagnostic: this.overdubDiagnostic ?? null,
              rollbackAborted: Boolean(this.overdubRollbackAborted),
              nextPatchSequence: this.overdubNextPatchSequence ?? null,
              receivedPatchMessages: this.overdubReceivedPatchMessages ?? null,
              lastReceivedPatchEndFrame: this.overdubLastReceivedPatchEndFrame ?? null,
              stack: new Error(`TrackAudio.${methodName}`).stack,
            });
          }
          return original.apply(this, args);
        };
      }
      const originalHandleOverdubMessage = track.handleOverdubMessage;
      if (typeof originalHandleOverdubMessage === 'function') {
        track.handleOverdubMessage = function (node, audioBuffer, message) {
          const patch = message?.type === 'OVERDUB_PATCH' ? {
            sequence: message.sequence,
            startInputFrame: message.startInputFrame,
            endInputFrame: message.endInputFrame,
            validFrames: message.validFrames,
            slotIndex: message.slotIndex,
          } : null;
          const result = originalHandleOverdubMessage.call(this, node, audioBuffer, message);
          if (patch) workload.overdubPatchReceiveTrace.push({
            trackId: this.track?.id ?? null,
            ...patch,
            receivedPatchMessages: this.overdubReceivedPatchMessages,
            nextPatchSequence: this.overdubNextPatchSequence,
            lastReceivedPatchEndFrame: this.overdubLastReceivedPatchEndFrame,
            rollbackAborted: Boolean(this.overdubRollbackAborted),
            diagnostic: this.overdubDiagnostic ?? null,
          });
          return result;
        };
      }
    }
  }
  state.workload = workload;
  return {
    context,
    master: engine.masterGainNode,
    inputFx: [...engine.inputFxInstances, ...engine.trackFxInstances].filter(Boolean),
    trackFx: [],
    inputSource: { stop: () => { leftOscillator.stop(); rightOscillator.stop(); } },
    trackSources: [],
    directProbeSource: null,
    directProbeWorklet: null,
    trackMix: engine.trackMixNode,
    outputProbe: null,
    outputProbeHeartbeat: null,
    outputAnalyser,
    outputSampler,
    livePoly: null,
    rhythm: engine.rhythmEngine,
    diagnosticStage: 'full-runtime',
    runtimeEngine: engine,
    runtimeTracks: tracks,
    privateTrackFxDescriptors,
    diagnosticDisableLivePoly: DIAGNOSTIC_DISABLE_LIVE_POLY,
    diagnosticOmitPrivateTrackFx: DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX,
    diagnosticSharedInputCapture: DIAGNOSTIC_SHARED_INPUT_CAPTURE,
    sharedInputCapture,
    workload,
  };
}

async function sha256TrackPcm(track) {
  const buffer = track.audioBuffer;
  if (!buffer || (buffer.numberOfChannels !== 1 && buffer.numberOfChannels !== 2)) {
    throw new Error(`Track ${track.track.id} has no supported completed PCM buffer`);
  }
  const interleaved = new Float32Array(buffer.length * buffer.numberOfChannels);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < buffer.length; frame += 1) {
      const sample = samples[frame];
      if (!Number.isFinite(sample)) throw new Error(`Track ${track.track.id} contains non-finite PCM at ${frame}:${channel}`);
      interleaved[frame * buffer.numberOfChannels + channel] = sample;
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(interleaved.buffer));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function waitForRuntimeState(predicate, label, timeoutMs = 15_000, syncCoverage = true) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const graph = window.__rc505BenchGraph;
    if (graph && syncCoverage) syncActiveWorkletCoverage(graph);
    if (harnessState?.processorErrors.length) {
      throw new Error(`AudioWorklet processor error while waiting for ${label}: ${JSON.stringify(harnessState.processorErrors)}`);
    }
    if (harnessState?.nodeConstructionFailures.length) {
      throw new Error(`AudioWorklet construction was rejected while waiting for ${label}: ${JSON.stringify(harnessState.nodeConstructionFailures)}`);
    }
    if (predicate()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function describeRuntimeTrackHistoryState(track) {
  const buffer = track.audioBuffer;
  return {
    trackId: track.track.id,
    state: track.state,
    projectRevision: track.projectRevision,
    playbackRevision: track.playbackRevision,
    hasPcm: !!buffer,
    pcmFrames: buffer?.length ?? 0,
    pcmChannels: buffer?.numberOfChannels ?? 0,
    historyBusy: track.historyBusy,
    canUndo: track.canUndo,
    canRedo: track.canRedo,
    historyUnavailableReason: track.historyUnavailableReason,
    pendingClear: track.pendingClear,
    isRecording: track.isRecording,
    recordingStarting: track.recordingStarting,
    recordingFinalizing: track.isFinalizingRecording,
    overdubStarting: track.overdubStarting,
    overdubStopping: track.overdubStopping,
    overdubProcessorPresent: track.overdubProcessor !== null,
    overdubReceivedPatchMessages: track.overdubReceivedPatchMessages,
    overdubExpectedPatchMessages: track.overdubExpectedPatchMessages,
    livePolyPitchEnabled: track.livePolyPitchEnabled,
    livePolyPitchActive: track.livePolyPitchActive,
    livePolyPitchNodePresent: track.livePolyPitchNode !== null,
    livePolyPitchNodePromisePending: track.livePolyPitchNodePromise !== null,
    livePolyPitchFallbackReason: track.livePolyPitchFallbackReason,
    liveMonoPitchEnabled: track.liveMonoPitchEnabled,
    liveMonoPitchActive: track.liveMonoPitchActive,
    liveMonoPitchFallbackReason: track.liveMonoPitchFallbackReason,
  };
}

function observeRuntimeTrackPlayback(track) {
  const originalPlayDescriptor = Object.getOwnPropertyDescriptor(track, 'play');
  const originalEnsureDescriptor = Object.getOwnPropertyDescriptor(track, 'ensureLivePolyPitchNode');
  const originalPitchStartDescriptor = Object.getOwnPropertyDescriptor(track, 'startLivePolyPitchPlayback');
  const originalPlay = track.play;
  const originalEnsureLivePoly = track.ensureLivePolyPitchNode;
  const originalPitchStart = track.startLivePolyPitchPlayback;
  const observation = { playCalls: [], pitchStartCalls: [], ensureNodeCalls: [], bufferResetPromises: [], pitchPortCommands: [] };
  const node = track.livePolyPitchNode;
  const port = node?.port;
  const originalPortHandler = port?.onmessage ?? null;
  const postMessageDescriptor = port ? Object.getOwnPropertyDescriptor(port, 'postMessage') : undefined;
  const onMessageDescriptor = port ? Object.getOwnPropertyDescriptor(port, 'onmessage') : undefined;
  const originalPortPostMessage = port?.postMessage;
  const requests = new Map();

  if (port && originalPortPostMessage && originalPortHandler) {
    try {
      port.postMessage = function (message, ...args) {
        if (Array.isArray(message) && Number.isInteger(message[0]) && typeof message[1] === 'string') {
          const entry = {
            id: message[0], method: message[1], sentAtMs: performance.now(), state: 'pending',
            trackStateAtSend: track.state,
            playbackRevisionAtSend: track.playbackRevision,
          };
          observation.pitchPortCommands.push(entry);
          requests.set(message[0], entry);
        }
        return originalPortPostMessage.call(this, message, ...args);
      };
      port.onmessage = function (event) {
        const data = event.data;
        const entry = Array.isArray(data) && Number.isInteger(data[0]) ? requests.get(data[0]) : undefined;
        if (entry) {
          const value = data[1];
          Object.assign(entry, {
            state: value && typeof value === 'object' && typeof value.__signalsmithError === 'string' ? 'remote-error' : 'acked',
            ackedAtMs: performance.now(),
            ...(value && typeof value === 'object' && typeof value.__signalsmithError === 'string'
              ? { error: value.__signalsmithError } : {}),
          });
          requests.delete(data[0]);
        }
        return originalPortHandler.call(this, event);
      };
      observation.portObserverInstalled = port.postMessage !== originalPortPostMessage && port.onmessage !== originalPortHandler;
    } catch (error) {
      observation.portInstrumentationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  } else {
    observation.portInstrumentationError = 'LIVE_POLY node or original MessagePort callbacks were unavailable';
  }

  track.ensureLivePolyPitchNode = async function (...args) {
    const ensureEntry = { startedAtMs: performance.now(), state: 'pending', nodeExistedAtStart: this.livePolyPitchNode !== null };
    observation.ensureNodeCalls.push(ensureEntry);
    const node = await originalEnsureLivePoly.apply(this, args);
    Object.assign(ensureEntry, { state: 'resolved', endedAtMs: performance.now(), nodeLatencySamples: node.latencySamples });
    return node;
  };

  track.startLivePolyPitchPlayback = async function (...args) {
    const entry = {
      startedAtMs: performance.now(),
      state: 'pending',
      stateAtEntry: this.state,
      playbackRevisionAtEntry: this.playbackRevision,
      livePolyPitchEnabledAtEntry: this.livePolyPitchEnabled,
      isReverseAtEntry: this.isReverse,
    };
    observation.pitchStartCalls.push(entry);
    try {
      const value = await originalPitchStart.apply(this, args);
      Object.assign(entry, {
        state: 'resolved', endedAtMs: performance.now(),
        trackStateAtResolve: this.state,
        playbackRevisionAtResolve: this.playbackRevision,
        livePolyPitchActiveAtResolve: this.livePolyPitchActive,
        livePolyPitchFallbackReasonAtResolve: this.livePolyPitchFallbackReason,
      });
      return value;
    } catch (error) {
      Object.assign(entry, {
        state: 'rejected', endedAtMs: performance.now(),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw error;
    }
  };

  track.play = async function (...args) {
    const entry = {
      startedAtMs: performance.now(),
      state: 'pending',
      stateAtEntry: this.state,
      playbackRevisionAtEntry: this.playbackRevision,
      livePolyPitchEnabledAtEntry: this.livePolyPitchEnabled,
    };
    observation.playCalls.push(entry);
    try {
      const promise = originalPlay.apply(this, args);
      const resetPromise = this.livePolyPitchBufferReset;
      const reset = { startedAtMs: performance.now(), state: 'pending' };
      observation.bufferResetPromises.push(reset);
      Promise.resolve(resetPromise).then(() => Object.assign(reset, { state: 'resolved', endedAtMs: performance.now() }), (error) => Object.assign(reset, {
        state: 'rejected', endedAtMs: performance.now(),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }));
      const value = await promise;
      Object.assign(entry, {
        state: 'resolved', endedAtMs: performance.now(),
        trackState: this.state,
        playbackRevisionAtResolve: this.playbackRevision,
        livePolyPitchActive: this.livePolyPitchActive,
        livePolyPitchFallbackReason: this.livePolyPitchFallbackReason,
        resetPromiseStateAtResolve: reset.state,
      });
      return value;
    } catch (error) {
      Object.assign(entry, {
        state: 'rejected', endedAtMs: performance.now(),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw error;
    }
  };

  return {
    observation,
    restore() {
      if (originalPlayDescriptor) Object.defineProperty(track, 'play', originalPlayDescriptor);
      else delete track.play;
      if (originalEnsureDescriptor) Object.defineProperty(track, 'ensureLivePolyPitchNode', originalEnsureDescriptor);
      else delete track.ensureLivePolyPitchNode;
      if (originalPitchStartDescriptor) Object.defineProperty(track, 'startLivePolyPitchPlayback', originalPitchStartDescriptor);
      else delete track.startLivePolyPitchPlayback;
      if (port) {
        if (postMessageDescriptor) Object.defineProperty(port, 'postMessage', postMessageDescriptor);
        else delete port.postMessage;
        if (onMessageDescriptor) Object.defineProperty(port, 'onmessage', onMessageDescriptor);
        else port.onmessage = originalPortHandler;
      }
    },
  };
}

async function runRuntimeOverdubHistory(graph, trackIndex, scheduledAtMs) {
  const track = graph.runtimeTracks[trackIndex];
  if (!track) throw new Error(`Missing Browser Track ${trackIndex + 1}`);
  if (track.state !== 'PLAYING') await track.play();
  await waitForRuntimeState(() => track.state === 'PLAYING', `Track ${trackIndex + 1} playback before overdub`);
  const before = await sha256TrackPcm(track);
  const harnessFrameBeforeTrigger = readProcessorAudioFrame(harnessState);
  track.triggerRecord();
  await waitForRuntimeState(
    () => track.state === 'OVERDUBBING' && track.overdubProcessor !== null,
    `Track ${trackIndex + 1} real overdub worklet`, 15_000, false,
  );
  const overdubNode = track.overdubProcessor;
  if (!overdubNode) throw new Error(`Track ${trackIndex + 1} overdub entered active state without its processor`);
  const overdubDescriptor = harnessState.nodeDescriptorByNode.get(overdubNode);
  if (!overdubDescriptor || overdubDescriptor.processorName !== 'rc505-overdub-processor') {
    throw new Error(`Track ${trackIndex + 1} overdub processor is missing its instrumented descriptor`);
  }
  const init = overdubDescriptor.overdubInitMessages.length === 1
    ? overdubDescriptor.overdubInitMessages[0]
    : null;
  const requestedStartFrame = init?.requestFrame;
  if (!Number.isSafeInteger(requestedStartFrame) || requestedStartFrame < 0) {
    throw new Error(`Track ${trackIndex + 1} overdub did not publish its exact input request frame: ${JSON.stringify({ harnessFrameBeforeTrigger, initMessages: overdubDescriptor.overdubInitMessages })}`);
  }
  const triggerToRequestFrameDelta = requestedStartFrame - harnessFrameBeforeTrigger;
  const startBoundary = expectWorkletStart(overdubNode, requestedStartFrame);
  startBoundary.harnessFrameBeforeTrigger = harnessFrameBeforeTrigger;
  startBoundary.triggerToRequestFrameDelta = triggerToRequestFrameDelta;
  syncActiveWorkletCoverage(graph);
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  // This is node callback coverage, not the PCM capture boundary: the shared
  // input tap may backfill [R,F) even when this newly-created processor starts
  // later. Preserve both observations independently.
  const callbackStartCounters = readRawWorkletCounters(harnessState, overdubDescriptor.slot);
  const processorCallbackStartFrame = callbackStartCounters.firstActiveFrame;
  const processorCallbackStartupDelayFrames = Number.isSafeInteger(processorCallbackStartFrame)
    ? processorCallbackStartFrame - requestedStartFrame : null;
  startBoundary.firstActiveFrame = processorCallbackStartFrame;
  startBoundary.callbackStartupDelayFrames = processorCallbackStartupDelayFrames;
  startBoundary.startupCoverageSource = 'instrumented first active processor callback; independent of shared-tap PCM backfill';
  expectWorkletStop(overdubNode, 'OVERDUB_STOPPED');
  const processorFrameBeforeStopCommand = readProcessorAudioFrame(harnessState);
  const rollbackJournal = track.overdubStopRollbackJournal;
  const rollbackBefore = {
    retainedJournalFrames: rollbackJournal?.retainedFrames ?? null,
    appliedFrameCount: track.overdubAppliedFrameCount ?? null,
    lastAppliedInputFrameExclusive: track.overdubLastAppliedInputFrameExclusive ?? null,
  };
  const stopCommandCallStartedAtWallMs = performance.now();
  track.triggerRecord();
  const stopCommandCallReturnedAtWallMs = performance.now();
  const rollbackAfter = {
    retainedJournalFrames: rollbackJournal?.retainedFrames ?? null,
    appliedFrameCount: track.overdubAppliedFrameCount ?? null,
    lastAppliedInputFrameExclusive: track.overdubLastAppliedInputFrameExclusive ?? null,
    targetFrame: track.overdubStopFrameTarget ?? null,
  };
  const rollbackObservedFrames = rollbackBefore.retainedJournalFrames !== null && rollbackAfter.retainedJournalFrames !== null
    ? Math.max(0, rollbackBefore.retainedJournalFrames - rollbackAfter.retainedJournalFrames)
    : null;
  const stopRequestAtTrigger = overdubDescriptor.overdubStopRequests.at(-1) ?? null;
  const requestedStopFrame = stopRequestAtTrigger?.requestedStopFrame ?? null;
  const stopAck = await waitForWorkletStopAck(overdubNode, 'OVERDUB_STOPPED');
  syncActiveWorkletCoverage(graph);
  await waitForRuntimeState(() => track.state === 'PLAYING' && track.overdubProcessor === null && !track.historyBusy, `Track ${trackIndex + 1} overdub patch drain`);
  const after = await sha256TrackPcm(track);
  if (after === before) throw new Error(`Track ${trackIndex + 1} overdub produced no PCM change`);
  // Port/method wrapping is useful for a focused root-cause probe, but it must
  // be opt-in so ordinary full-runtime measurements keep the production path.
  const playbackObservation = new URLSearchParams(location.search).get('diagnosticObserveLivePolyPlayback') === '1'
    ? observeRuntimeTrackPlayback(track)
    : null;
  if (!track.canUndo || !track.undo()) throw new Error(`Track ${trackIndex + 1} overdub did not expose its PCM undo snapshot`);
  try {
    await waitForRuntimeState(() => track.state === 'PLAYING' && !track.historyBusy, `Track ${trackIndex + 1} undo restore`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const observation = playbackObservation ? `; playbackObservation=${JSON.stringify(playbackObservation.observation)}` : '';
    throw new Error(`${detail}; acceptedUndo=true; stateAtDeadline=${JSON.stringify(describeRuntimeTrackHistoryState(track))}${observation}`);
  }
  const afterUndo = await sha256TrackPcm(track);
  if (afterUndo !== before) throw new Error(`Track ${trackIndex + 1} undo did not restore the exact pre-overdub PCM hash`);
  if (!track.canRedo || !track.redo()) throw new Error(`Track ${trackIndex + 1} overdub did not expose its PCM redo snapshot`);
  try {
    await waitForRuntimeState(() => track.state === 'PLAYING' && !track.historyBusy, `Track ${trackIndex + 1} redo restore`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const observation = playbackObservation ? `; playbackObservation=${JSON.stringify(playbackObservation.observation)}` : '';
    throw new Error(`${detail}; acceptedRedo=true; stateAtDeadline=${JSON.stringify(describeRuntimeTrackHistoryState(track))}${observation}`);
  }
  const afterRedo = await sha256TrackPcm(track);
  if (afterRedo !== after) throw new Error(`Track ${trackIndex + 1} redo did not restore the exact post-overdub PCM hash`);
  playbackObservation?.restore();
  let sharedInputTransaction = null;
  if (graph.diagnosticSharedInputCapture) {
    const tap = getSharedInputCaptureDescriptor(graph);
    const firstInput = overdubDescriptor.overdubFirstInputMessages.find((message) => message.requestFrame === requestedStartFrame);
    const backfill = overdubDescriptor.overdubBackfillMessages.find((message) => message.requestFrame === requestedStartFrame);
    const stop = overdubDescriptor.overdubStopMessages.find((message) => message.requestFrame === requestedStartFrame);
    const stopRequests = overdubDescriptor.overdubStopRequests;
    const startRequests = tap.captureStartRequests.filter((message) =>
      message.trackIndex === trackIndex && message.startFrame === requestedStartFrame);
    if (!init || !firstInput || !backfill || !stop || stopRequests.length !== 1 || startRequests.length !== 1) {
      throw new Error(`Track ${trackIndex + 1} overdub did not expose one complete shared-tap R/F/S transaction: ${JSON.stringify({ requestedStartFrame, init, initMessages: overdubDescriptor.overdubInitMessages, firstInput, firstInputMessages: overdubDescriptor.overdubFirstInputMessages, backfill, backfillMessages: overdubDescriptor.overdubBackfillMessages, stop, stopMessages: overdubDescriptor.overdubStopMessages, stopRequests, startRequests, trackCaptureStartRequests: tap.captureStartRequests.filter((message) => message.trackIndex === trackIndex) })}`);
    }
    const S = stopRequests[0].requestedStopFrame;
    const patchMessages = overdubDescriptor.overdubPatchMessages;
    let patchCursor = requestedStartFrame;
    let patchRangesContiguous = true;
    let patchRangesStartAtOrAfterRequest = true;
    let appliedPatchCursor = requestedStartFrame;
    let appliedPatchRangesContiguous = true;
    let appliedPatchRangeFrames = 0;
    let patchRangeFrames = 0;
    let postStopPatchRangeFrames = 0;
    for (let index = 0; index < patchMessages.length; index += 1) {
      const patch = patchMessages[index];
      if (patch.sequence !== index || patch.startInputFrame !== patchCursor
        || !Number.isSafeInteger(patch.startInputFrame) || !Number.isSafeInteger(patch.endInputFrame)
        || !Number.isInteger(patch.validFrames) || patch.endInputFrame - patch.startInputFrame !== patch.validFrames) {
        patchRangesContiguous = false;
      }
      if (Number.isSafeInteger(patch.endInputFrame) && Number.isSafeInteger(patch.startInputFrame)) {
        patchRangeFrames += Math.max(0, patch.endInputFrame - patch.startInputFrame);
        postStopPatchRangeFrames += Math.max(0, patch.endInputFrame - Math.max(patch.startInputFrame, S));
        patchCursor = patch.endInputFrame;
        if (patch.startInputFrame < requestedStartFrame) patchRangesStartAtOrAfterRequest = false;
        const appliedStart = Math.max(patch.startInputFrame, requestedStartFrame);
        const appliedEnd = Math.min(patch.endInputFrame, S);
        if (appliedEnd > appliedStart) {
          if (appliedStart !== appliedPatchCursor) appliedPatchRangesContiguous = false;
          appliedPatchRangeFrames += appliedEnd - appliedStart;
          appliedPatchCursor = appliedEnd;
        }
      }
    }
    const exactPatchRange = patchRangesContiguous && patchRangesStartAtOrAfterRequest
      && appliedPatchRangesContiguous && appliedPatchCursor === S
      && patchMessages.length === stop.patchesSent
      && patchMessages.length > 0 && patchMessages[0].startInputFrame === requestedStartFrame
      && patchCursor >= S && appliedPatchRangeFrames === S - requestedStartFrame;
    if (!Number.isSafeInteger(S) || S < requestedStartFrame
      || stop.requestedStopFrame !== S || stop.appliedExclusiveEnd !== S
      || !Number.isSafeInteger(stop.processorStopFrame) || stop.processorStopFrame < S
      || stop.stopFrame !== stop.processorStopFrame
      || stop.overflowFrames !== 0
      || !exactPatchRange
      || !stopRequestAtTrigger || stopRequestAtTrigger.requestedStopFrame !== S
      || rollbackAfter.targetFrame !== S
      || rollbackAfter.lastAppliedInputFrameExclusive !== null && rollbackAfter.lastAppliedInputFrameExclusive > S
      || rollbackObservedFrames !== null && rollbackObservedFrames !== (rollbackBefore.lastAppliedInputFrameExclusive !== null
        ? Math.max(0, rollbackBefore.lastAppliedInputFrameExclusive - S) : 0)) {
      throw new Error(`Track ${trackIndex + 1} overdub did not satisfy its exact R/S PCM, rollback, no-overflow, and terminal-ACK contract: ${JSON.stringify({ requestedStartFrame, S, processorCallbackStartFrame, processorCallbackStartupDelayFrames, startBoundary, stopRequestAtTrigger, stop, patchMessages, patchRangesContiguous, patchRangesStartAtOrAfterRequest, appliedPatchRangesContiguous, patchRangeFrames, appliedPatchRangeFrames, appliedPatchCursor, patchCursor, postStopPatchRangeFrames, exactPatchRange, rollbackBefore, rollbackAfter, rollbackObservedFrames })}`);
    }
    const captureStart = startRequests[0];
    const configuredMatches = tap.captureConfiguredMessages.filter((message) =>
      message.sessionId === captureStart.sessionId && message.inputGeneration === captureStart.inputGeneration);
    const completionMatches = tap.captureCompletionMessages.filter((message) =>
      message.sessionId === captureStart.sessionId && message.inputGeneration === captureStart.inputGeneration);
    const inputCaptureConfiguration = configuredMatches[0];
    const inputCaptureCompletion = completionMatches[0];
    const backfillFrameCount = firstInput.firstInputFrame - requestedStartFrame;
    if (configuredMatches.length !== 1 || completionMatches.length !== 1
      || inputCaptureConfiguration?.requestedStartFrame !== requestedStartFrame
      || inputCaptureConfiguration?.requestAgeAtStartFrames !== inputCaptureConfiguration.startReceivedFrame - requestedStartFrame
      || inputCaptureConfiguration?.preRollValidFrames > inputCaptureConfiguration?.preRollCapacityFrames
      || inputCaptureCompletion?.requestedStartFrame !== requestedStartFrame
      || inputCaptureCompletion?.stopFrame !== firstInput.firstInputFrame
      || inputCaptureCompletion?.framesCaptured !== backfillFrameCount
      || backfill.validFrames !== backfillFrameCount
      || stop.requestFrame !== requestedStartFrame
      || stop.firstInputFrame !== firstInput.firstInputFrame
      || stop.backfillFrames !== backfillFrameCount
      || stop.replayedFrames !== stop.backfillFrames + stop.liveQueueFrames
      || stop.maxReplayedFramesPerProcess > stop.replayBudgetFramesPerProcess
      || stop.liveQueuePeakFrames > stop.liveQueueCapacityFrames
      || backfill.channelCount !== stop.channelCount
      || stop.startupCancelled !== false
      || stop.patchesSent < 1) {
      throw new Error(`Track ${trackIndex + 1} overdub shared-tap/replay telemetry did not satisfy its bounded exact-frame contract: ${JSON.stringify({ requestedStartFrame, firstInput, backfill, stop, inputCaptureConfiguration, inputCaptureCompletion })}`);
    }
    const completionIndex = tap.captureCompletionMessages.indexOf(inputCaptureCompletion);
    const nextExpectedCompletion = tap.expectedCaptureCompletionCount ?? 0;
    if (completionIndex !== nextExpectedCompletion) {
      throw new Error(`Shared input capture completion ${inputCaptureCompletion.sessionId}/${inputCaptureCompletion.inputGeneration} was out of order: expected message ${nextExpectedCompletion}, found ${completionIndex}`);
    }
    // Overdub's private R/F backfill uses the same persistent tap and emits a
    // RECORD_COMPLETE just like a normal recording. Mark this exact session as
    // consumed so a later recording cannot mistake it for an unobserved take.
    tap.expectedCaptureCompletionCount = completionIndex + 1;
    const ackReceivedAtWallMs = stop.ackReceivedAtWallMs;
    sharedInputTransaction = {
      requestFrameR: requestedStartFrame,
      firstInputFrameF: firstInput.firstInputFrame,
      stopRequestFrameS: S,
      framesCapturedFromRequestThroughStop: S - requestedStartFrame,
      exactRequestedPcmRange: exactPatchRange,
      outgoingPatchRange: {
        firstFrame: patchMessages[0]?.startInputFrame ?? null,
        exclusiveEndFrame: patchCursor,
        totalFrames: patchRangeFrames,
        appliedPreStopFrames: appliedPatchRangeFrames,
        appliedExclusiveEndFrame: appliedPatchCursor,
        patchCount: patchMessages.length,
        patchesSentByWorklet: stop.patchesSent,
        sequenceAndRangeContiguous: patchRangesContiguous,
        startsAtOrAfterRequestedFrame: patchRangesStartAtOrAfterRequest,
        appliedRangesContiguousToStop: appliedPatchRangesContiguous,
        postStopPatchFrames: postStopPatchRangeFrames,
        droppedInputFrames: stop.overflowFrames,
        overflowBursts: stop.overflowEvents,
      },
      stopCommand: {
        stopFrameS: S,
        commandCallStartedAtWallMs: stopCommandCallStartedAtWallMs,
        commandCallReturnedAtWallMs: stopCommandCallReturnedAtWallMs,
        postMessageObservedAtWallMs: stopRequestAtTrigger.postedAtWallMs,
        processorFrameBeforeCommand: processorFrameBeforeStopCommand,
        commandObservedAtProcessorFrame: stopRequestAtTrigger.requestedAtProcessorFrame,
        processorTerminalFrame: stop.processorStopFrame,
        terminalQuantumOvershootFrames: stop.processorStopFrame - S,
        ackReceivedAtProcessorFrame: stop.ackReceivedAtProcessorFrame,
        ackReceivedAtWallMs,
        mainThreadCommandToAckLatencyMs: Number.isFinite(stopRequestAtTrigger.postedAtWallMs)
          && Number.isFinite(ackReceivedAtWallMs) ? ackReceivedAtWallMs - stopRequestAtTrigger.postedAtWallMs : null,
      },
      processorCallbackStartup: {
        firstActiveFrame: processorCallbackStartFrame,
        delayFramesFromR: processorCallbackStartupDelayFrames,
        delayMsFromR: Number.isFinite(processorCallbackStartupDelayFrames)
          ? processorCallbackStartupDelayFrames / graph.context.sampleRate * 1_000 : null,
        source: 'worklet callback instrumentation; distinct from complete backfilled PCM range',
      },
      postStopRollback: {
        requestedStopFrameS: S,
        journalRetainedFramesBeforeStop: rollbackBefore.retainedJournalFrames,
        journalRetainedFramesAfterStopRequest: rollbackAfter.retainedJournalFrames,
        latestAppliedInputFrameExclusiveBeforeStop: rollbackBefore.lastAppliedInputFrameExclusive,
        latestAppliedInputFrameExclusiveAfterStopRequest: rollbackAfter.lastAppliedInputFrameExclusive,
        appliedFramesBeforeStop: rollbackBefore.appliedFrameCount,
        appliedFramesAfterStopRequest: rollbackAfter.appliedFrameCount,
        alreadyAppliedFramesAtOrAfterSReverted: rollbackObservedFrames,
        exercisedNaturalPostStopRollback: rollbackObservedFrames > 0,
      },
      stopCommandObservedAtProcessorFrame: stopRequests[0].requestedAtProcessorFrame,
      processorStopFrame: stop.processorStopFrame,
      inputCaptureStartReceivedFrame: inputCaptureConfiguration.startReceivedFrame,
      inputCaptureAgeFrames: inputCaptureConfiguration.requestAgeAtStartFrames,
      inputCapturePreRollCapacityFrames: inputCaptureConfiguration.preRollCapacityFrames,
      inputCapturePreRollValidFrames: inputCaptureConfiguration.preRollValidFrames,
      capturedBackfillFrames: inputCaptureCompletion.framesCaptured,
      exactBackfillHalfOpenRange: inputCaptureCompletion.framesCaptured === firstInput.firstInputFrame - requestedStartFrame,
      replayBudgetFramesPerProcess: stop.replayBudgetFramesPerProcess,
      totalReplayedFrames: stop.replayedFrames,
      maximumReplayedFramesInOneProcess: stop.maxReplayedFramesPerProcess,
      liveQueueCapacityFrames: stop.liveQueueCapacityFrames,
      liveQueueFrames: stop.liveQueueFrames,
      liveQueuePeakFrames: stop.liveQueuePeakFrames,
      patchMessagesSent: stop.patchesSent,
      exactUndoAndRedoPcmHashes: true,
    };
  }
  return {
    operation: 'overdub-undo-redo',
    trackId: track.track.id,
    scheduledAtElapsedSeconds: (scheduledAtMs - graph.measurementStartMs) / 1_000,
    beforePcmSha256: before,
    afterOverdubPcmSha256: after,
    afterUndoPcmSha256: afterUndo,
    afterRedoPcmSha256: afterRedo,
    exactUndoAndRedoHashes: true,
    processorStartRequest: startBoundary,
    processorStopAck: stopAck,
    workletPatchMessages: track.overdubReceivedPatchMessages,
    ...(sharedInputTransaction ? { sharedInputTransaction } : {}),
    ...(playbackObservation ? { playbackObservation: playbackObservation.observation } : {}),
  };
}

async function runRuntimeRecording(graph, trackIndex, scheduledAtMs) {
  const track = graph.runtimeTracks[trackIndex];
  if (!track) throw new Error(`Missing Browser Track ${trackIndex + 1}`);
  const restoreLivePoly = !graph.diagnosticDisableLivePoly && track.livePolyPitchEnabled;
  if (restoreLivePoly) {
    await track.setLivePolyPitchEnabled(false);
    syncActiveWorkletCoverage(graph);
  }
  track.stop();
  if (!track.clear()) throw new Error(`Track ${trackIndex + 1} could not preserve history before recording replacement`);
  await waitForRuntimeState(() => track.state === 'EMPTY' && !track.historyBusy, `Track ${trackIndex + 1} clear before recording`);
  const highLevelRequestedFrame = readProcessorAudioFrame(harnessState);
  await track.startRecording();
  const recorderNode = track.workletNode;
  if (!recorderNode) throw new Error(`Track ${trackIndex + 1} entered recording state without its processor`);
  const captureSession = track.recordingCaptureSession;
  if (graph.diagnosticSharedInputCapture && !captureSession) {
    throw new Error(`Track ${trackIndex + 1} did not use the shared Browser input capture session: ${track.recordingDiagnostic ?? 'no diagnostic supplied'}`);
  }
  if (!graph.diagnosticSharedInputCapture && captureSession) {
    throw new Error(`Track ${trackIndex + 1} unexpectedly used shared input capture in the baseline run`);
  }
  const requestedStartFrame = captureSession?.startFrame ?? highLevelRequestedFrame;
  let startBoundary = captureSession ? null : expectWorkletStart(recorderNode, requestedStartFrame);
  syncActiveWorkletCoverage(graph);
  await waitForRuntimeState(() => track.state === 'RECORDING' && track.isRecording, `Track ${trackIndex + 1} recording start`);
  await new Promise((resolve) => window.setTimeout(resolve, 700));
  const captureCompletionExpectation = captureSession ? expectInputCaptureCompletion(recorderNode) : null;
  if (!captureSession) expectWorkletStop(recorderNode, 'RECORD_COMPLETE');
  await track.stopRecording();
  const stopAck = captureCompletionExpectation
    ? await waitForInputCaptureCompletion(recorderNode, captureCompletionExpectation)
    : await waitForWorkletStopAck(recorderNode, 'RECORD_COMPLETE');
  const captureMessage = stopAck.message ?? null;
  let sharedInputTransaction = null;
  if (captureSession && (!captureMessage
    || captureMessage.sessionId !== captureSession.sessionId
    || captureMessage.inputGeneration !== captureSession.inputGeneration
    || captureMessage.requestedStartFrame !== captureSession.startFrame
    || captureMessage.stopFrame < captureSession.startFrame
    || captureMessage.framesCaptured !== captureMessage.stopFrame - captureMessage.requestedStartFrame
    || captureMessage.droppedFrames !== 0
    || captureMessage.overflowEvents !== 0
    || captureMessage.status !== 'complete'
    || captureMessage.channelCount !== 2)) {
    throw new Error(`Shared capture did not acknowledge an exact, complete stereo half-open frame range: ${JSON.stringify({ session: captureSession, captureMessage })}`);
  }
  if (captureSession) {
    const tap = getSharedInputCaptureDescriptor(graph);
    if (!tap) throw new Error('A shared input capture session completed without the declared persistent tap');
    const configuredMatches = tap.captureConfiguredMessages.filter((message) =>
      message.sessionId === captureSession.sessionId && message.inputGeneration === captureSession.inputGeneration);
    const startRequests = tap.captureStartRequests.filter((message) =>
      message.sessionId === captureSession.sessionId && message.inputGeneration === captureSession.inputGeneration);
    if (configuredMatches.length !== 1 || startRequests.length !== 1) {
      throw new Error(`Shared capture session ${captureSession.sessionId} did not have exactly one START_CAPTURE/RECORD_CONFIGURED pair: ${JSON.stringify({ configuredMatches, startRequests })}`);
    }
    const configured = configuredMatches[0];
    const captureStart = startRequests[0];
    startBoundary = {
      requestedStartFrame,
      commandFrame: captureStart.requestedAtProcessorFrame,
      requestToCommandFrames: captureStart.requestedAtProcessorFrame - requestedStartFrame,
      startMessageType: 'START_CAPTURE',
      firstActiveFrame: configured.startReceivedFrame,
      lifetimeClassification: 'persistent input tap; callback coverage is measured from graph setup',
    };
    if (configured.requestedStartFrame !== captureSession.startFrame
      || captureStart.startFrame !== captureSession.startFrame
      || configured.requestAgeAtStartFrames !== configured.startReceivedFrame - captureSession.startFrame
      || !Number.isInteger(configured.preRollValidFrames) || configured.preRollValidFrames < 0
      || configured.preRollValidFrames > configured.preRollCapacityFrames
      || configured.requestAgeAtStartFrames > configured.preRollCapacityFrames) {
      throw new Error(`Shared capture session ${captureSession.sessionId} start telemetry exceeded its exact bounded pre-roll contract: ${JSON.stringify({ configured, captureStart, session: captureSession })}`);
    }
    sharedInputTransaction = {
      requestFrameR: captureSession.startFrame,
      captureStartReceivedFrameF: configured.startReceivedFrame,
      stopFrameS: captureMessage.stopFrame,
      captureAgeFrames: configured.requestAgeAtStartFrames,
      preRollCapacityFrames: configured.preRollCapacityFrames,
      preRollValidFramesAtStart: configured.preRollValidFrames,
      framesCaptured: captureMessage.framesCaptured,
      exactHalfOpenRange: captureMessage.framesCaptured === captureMessage.stopFrame - captureSession.startFrame,
      droppedFrames: captureMessage.droppedFrames,
      overflowEvents: captureMessage.overflowEvents,
    };
  }
  syncActiveWorkletCoverage(graph);
  await waitForRuntimeState(() => track.audioBuffer !== null && track.state === 'PLAYING' && !track.historyBusy, `Track ${trackIndex + 1} recording finalization`, 30_000);
  const buffer = track.audioBuffer;
  if (!buffer || buffer.numberOfChannels !== 2 || buffer.length < Math.floor(graph.context.sampleRate * 0.25)) {
    throw new Error(`Track ${trackIndex + 1} real recording did not produce a usable stereo loop`);
  }
  const recordedSha256 = await sha256TrackPcm(track);
  if (restoreLivePoly) {
    await track.setLivePolyPitchEnabled(true, { semitones: trackIndex % 2 === 0 ? 5 : -3, playbackRate: 1, tonalityLimitHz: 8_000 });
    syncActiveWorkletCoverage(graph);
    await waitForRuntimeState(() => track.livePolyPitchActive && track.state === 'PLAYING', `Track ${trackIndex + 1} LIVE_POLY after real recording`, 30_000);
  }
  return {
    operation: 'clear-record-stereo-live-poly-restore',
    trackId: track.track.id,
    scheduledAtElapsedSeconds: (scheduledAtMs - graph.measurementStartMs) / 1_000,
    recordedFrames: buffer.length,
    recordedChannels: buffer.numberOfChannels,
    recordedPcmSha256: recordedSha256,
    recordingOverflowEvents: track.recordingOverflowEvents,
    recordingDroppedFrames: track.recordingDroppedFrames,
    processorStartRequest: startBoundary,
    processorStopAck: stopAck,
    ...(captureSession ? {
      sharedInputCapture: {
        sessionId: captureSession.sessionId,
        inputGeneration: captureSession.inputGeneration,
        requestFrameR: captureSession.startFrame,
        captureStartReceivedFrameF: sharedInputTransaction.captureStartReceivedFrameF,
        captureAgeFrames: sharedInputTransaction.captureAgeFrames,
        preRollCapacityFrames: sharedInputTransaction.preRollCapacityFrames,
        preRollValidFramesAtStart: sharedInputTransaction.preRollValidFramesAtStart,
        requestedStartFrame: captureSession.startFrame,
        requestedStopFrame: captureMessage.stopFrame,
        framesCaptured: captureMessage.framesCaptured,
        exactHalfOpenRange: captureMessage.framesCaptured === captureMessage.stopFrame - captureMessage.requestedStartFrame,
        stereoChannelsCaptured: captureMessage.channelCount,
        droppedFrames: captureMessage.droppedFrames,
        overflowEvents: captureMessage.overflowEvents,
        completionStatus: captureMessage.status,
        persistentTapProcessor: graph.sharedInputCapture?.label ?? null,
        transaction: sharedInputTransaction,
      },
    } : {}),
    livePolyRestored: restoreLivePoly ? track.livePolyPitchActive : null,
  };
}

async function runTimedMeasurement(graph, durationSeconds) {
  const start = performance.now();
  const end = start + durationSeconds * 1_000;
  graph.measurementStartMs = start;
  harnessState.measurementStartMs = start;
  harnessState.measurementStartAudioTimeSeconds = graph.context.currentTime;
  syncActiveWorkletCoverage(graph);
  if (graph.workload) {
    graph.workload.measurementStartUtc = new Date().toISOString();
    graph.workload.dynamicOperationsDuringMeasurement = [];
  }
  const requestedOperationInterval = Number(new URLSearchParams(location.search).get('operationIntervalSeconds') || '30');
  if (!Number.isFinite(requestedOperationInterval) || requestedOperationInterval < 2 || requestedOperationInterval > 180) {
    throw new RangeError('operationIntervalSeconds must be from 2 through 180 seconds');
  }
  const operationIntervalMs = requestedOperationInterval * 1_000;
  let nextOperationAt = start + operationIntervalMs;
  let operationIndex = 0;
  while (performance.now() < end) {
    const now = performance.now();
    const remaining = end - now;
    if (graph.workload && now >= nextOperationAt && remaining > 25_000) {
      const scheduledAt = nextOperationAt;
      const cycleIndex = Math.floor(operationIndex / 6);
      const slotInCycle = operationIndex % 6;
      const record = slotInCycle === 0;
      const trackIndex = record ? cycleIndex % 5 : (cycleIndex + slotInCycle - 1) % 5;
      const operation = {
        index: operationIndex + 1,
        operation: record ? 'clear-record-stereo-live-poly-restore' : 'overdub-undo-redo',
        trackId: trackIndex + 1,
        state: 'running',
        startedAtUtc: new Date().toISOString(),
        scheduledAtElapsedSeconds: (scheduledAt - start) / 1_000,
      };
      const privateCoverageStart = harnessState.activeWorkletCoverage
        ? getPrivateTrackCoverageSnapshot(graph)
        : null;
      graph.workload.dynamicOperationsDuringMeasurement.push(operation);
      window.__rc505BenchProgress = getBenchmarkProgress({ includeLifecycle: false });
      try {
        const result = record
          ? await runRuntimeRecording(graph, trackIndex, scheduledAt)
          : await runRuntimeOverdubHistory(graph, trackIndex, scheduledAt);
        syncActiveWorkletCoverage(graph);
        const privateCoverage = privateCoverageStart
          ? comparePrivateTrackCoverageSnapshots(privateCoverageStart, getPrivateTrackCoverageSnapshot(graph))
          : null;
        Object.assign(operation, result, {
          ...(privateCoverage ? { privateTrackCoverageDuringOperation: privateCoverage } : {}),
          state: 'completed', endedAtUtc: new Date().toISOString(),
        });
        if (privateCoverage && !privateCoverage.passed) {
          throw new Error(`A–D track coverage gap during dynamic operation ${operation.index}: ${JSON.stringify(privateCoverage.tracks.filter((track) => !track.passed))}`);
        }
      } catch (error) {
        Object.assign(operation, {
          state: 'failed',
          endedAtUtc: new Date().toISOString(),
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        throw error;
      }
      operationIndex += 1;
      nextOperationAt = scheduledAt + operationIntervalMs;
      continue;
    }
    window.__rc505BenchProgress = getBenchmarkProgress({ includeLifecycle: false });
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(1_000, Math.max(50, Math.min(remaining, nextOperationAt - now)))));
  }
  if (graph.workload) graph.workload.measurementEndUtc = new Date().toISOString();
  harnessState.measurementEndMs = performance.now();
  if (harnessState.activeWorkletCoverage) {
    syncActiveWorkletCoverage(graph);
    const endFrame = Math.round(graph.context.currentTime * graph.context.sampleRate);
    harnessState.activeWorkletCoverage.finish(endFrame, (slot) => readWorkletCounters(harnessState, slot));
  }
}

function getBenchmarkProgress({ includeLifecycle = true } = {}) {
  const state = harnessState;
  const currentGraph = window.__rc505BenchGraph;
  if (currentGraph) syncActiveWorkletCoverage(currentGraph);
  const activeIndex = state?.layout.measurementActiveIndex;
  const measurementActive = state && activeIndex !== undefined
    ? Atomics.load(state.meta, activeIndex) === 1
    : false;
  const progressAtMs = performance.now();
  const nodes = state?.nodes.map((node) => {
    const base = node.slot * META_STRIDE;
    const callbacks = Atomics.load(state.meta, base + META.callbacks);
    if (callbacks > node.lastObservedCallbackCount) node.lastCallbackActivityAtMs = progressAtMs;
    node.lastObservedCallbackCount = callbacks;
    return {
      slot: node.slot,
      label: node.label,
      processorName: node.processorName,
      callbacks,
      outputFrames: Atomics.load(state.meta, base + META.totalFrames),
      callbackErrors: Atomics.load(state.meta, base + META.callbackErrors),
      missingCallbackEstimate: Atomics.load(state.meta, base + META.missingCallbackEstimate),
      isPersistentGraphNode: state.persistentSlotSet?.has(node.slot) ?? true,
      callbacksAdvancedWithinRecentWindow: progressAtMs - node.lastCallbackActivityAtMs <= RECENT_CALLBACK_ACTIVITY_SECONDS * 1_000,
    };
  }) ?? [];
  const graph = window.__rc505BenchGraph ?? null;
  const nodeLifecycle = includeLifecycle && state ? getNodeLifecycleSnapshot(state, graph, nodes) : null;
  return {
    generatedAtUtc: new Date().toISOString(),
    state: window.__rc505BenchError
      ? 'failed'
      : measurementActive ? 'running' : window.__rc505BenchResult ? 'completed' : 'initializing',
    elapsedWallSeconds: state?.measurementStartMs
      ? ((state.measurementEndMs ?? performance.now()) - state.measurementStartMs) / 1_000
      : 0,
    actualSampleRateHz: state?.context?.sampleRate ?? null,
    audioContextCurrentTimeSeconds: state?.context?.currentTime ?? null,
    audioContextAdvanceDuringMeasurementSeconds: state?.measurementStartAudioTimeSeconds === undefined
      ? null
      : (state?.context?.currentTime ?? state.measurementStartAudioTimeSeconds) - state.measurementStartAudioTimeSeconds,
    instrumentedNodeCount: nodes.length,
    readySlotCount: state?.readySlots.size ?? 0,
    nodeCounts: nodes.reduce((counts, node) => {
      counts[node.processorName] = (counts[node.processorName] ?? 0) + 1;
      return counts;
    }, {}),
    nodeLifecycle,
    nodeConstructionFailures: [...(state?.nodeConstructionFailures ?? [])],
    callbackExceptionDetails: [...(state?.callbackExceptionDetails ?? [])],
    sharedMemoryProbeBytes: state?.buffer?.byteLength ?? null,
    sharedMemoryProbeMiB: state?.buffer ? state.buffer.byteLength / (1024 * 1024) : null,
    callbackErrors: nodes.reduce((sum, node) => sum + node.callbackErrors, 0),
    estimatedMissingCallbacks: nodes.reduce((sum, node) => sum + node.missingCallbackEstimate, 0),
    nodes,
    workload: state?.workload ?? graph?.workload ?? null,
    outputSampler: state?.outputSampler?.snapshot?.() ?? null,
    processorErrors: state?.processorErrors ?? [],
    error: window.__rc505BenchError ?? null,
  };
}

function getNodeLifecycleSnapshot(state, graph, progressNodes) {
  const trackNodeReferences = new Map();
  const registerTrackNode = (node, role, status) => {
    if (node && typeof node === 'object') trackNodeReferences.set(node, { role, status });
  };
  for (const track of graph?.runtimeTracks ?? []) {
    registerTrackNode(track.livePolyPitchNode, 'LIVE_POLY', track.livePolyPitchActive ? 'active' : 'retained-idle');
    registerTrackNode(track.workletNode, 'recording', track.isRecording ? 'active' : 'retained-idle');
    registerTrackNode(track.overdubProcessor, 'overdub', track.overdubProcessor ? 'active' : 'retained-idle');
  }

  const dynamicProcessorNames = new Set(['signalsmith-stretch', 'looper-processor', 'rc505-overdub-processor']);
  const classified = progressNodes.map((progressNode, index) => {
    const descriptor = state.nodes[index];
    const referenced = trackNodeReferences.get(descriptor?.node);
    let lifecycleState = 'unclassified';
    if (referenced) lifecycleState = referenced.status;
    else if (state.persistentSlotSet?.has(progressNode.slot) && !dynamicProcessorNames.has(progressNode.processorName)) {
      lifecycleState = 'persistent-graph';
    } else if (dynamicProcessorNames.has(progressNode.processorName)) {
      lifecycleState = 'retired-from-track';
    }
    return {
      slot: progressNode.slot,
      processorName: progressNode.processorName,
      lifecycleState,
      trackRole: referenced?.role ?? null,
      callbacksAdvancedWithinRecentWindow: progressNode.callbacksAdvancedWithinRecentWindow,
    };
  });
  const countByState = classified.reduce((counts, node) => {
    counts[node.lifecycleState] = (counts[node.lifecycleState] ?? 0) + 1;
    return counts;
  }, {});
  const countByProcessorAndState = classified.reduce((counts, node) => {
    const key = `${node.processorName}:${node.lifecycleState}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  let wasmLeases = null;
  if (graph?.runtimeEngine?.context) {
    try {
      wasmLeases = signalsmithLiveWasmSnapshot(graph.runtimeEngine.context);
    } catch (error) {
      wasmLeases = { available: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }
  return {
    createdNodeCount: progressNodes.length,
    lifecycleCountByState: countByState,
    lifecycleCountByProcessorAndState: countByProcessorAndState,
    classificationNotes: {
      persistentGraph: 'Created during graph setup and retained as shared FX/Rhythm/meter infrastructure.',
      active: 'Currently referenced by a TrackAudio live route or recording/overdub field.',
      retainedIdle: 'Still referenced by TrackAudio but currently not routed as active.',
      retiredFromTrack: 'Dynamic TrackAudio processor no longer referenced by its track; worklet callback history remains in the cumulative descriptor list.',
      callbacksAdvancedWithinRecentWindow: `At least one callback advanced within ${RECENT_CALLBACK_ACTIVITY_SECONDS} seconds; this is activity evidence, not a hardware liveness guarantee.`,
    },
    signalsmithWasmLeases: wasmLeases,
  };
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

  const profile = new URLSearchParams(location.search).get('profile') || 'synthetic-probe';
  if (!['synthetic-probe', 'full-runtime'].includes(profile)) throw new RangeError(`Unknown benchmark profile: ${profile}`);
  setStatus(profile === 'full-runtime'
    ? 'Building BrowserAudioEngine five-track private A–D graph…'
    : 'Building production Browser AudioWorklet graph…');
  const graph = profile === 'full-runtime' ? await setupFullRuntimeGraph() : await setupGraph();
  const state = harnessState;
  const measurementMode = new URLSearchParams(location.search).get('diagnosticMeasurementMode') || 'record';
  if (!['record', 'preflight'].includes(measurementMode)) throw new RangeError(`Unknown diagnostic measurement mode: ${measurementMode}`);
  if (measurementMode === 'record') state.activeWorkletCoverage = new ActiveWorkletCoverageTracker();
  const startMemory = readMemoryInfo();
  const startedAt = new Date().toISOString();
  state.outputSampler = graph.outputSampler;
  state.workload = graph.workload ?? null;
  window.__rc505BenchGraph = graph;
  const preflightAtMeasurementStart = state.nodes.map((node) =>
    Atomics.load(state.meta, node.slot * META_STRIDE + META.preflightCallbacks));
  const outputProbeHeartbeatAtStart = graph.outputProbeHeartbeat
    ? [Atomics.load(graph.outputProbeHeartbeat, 0), Atomics.load(graph.outputProbeHeartbeat, 1)]
    : null;
  if (measurementMode === 'record') Atomics.store(state.meta, state.layout.measurementActiveIndex, 1);
  const privateTrackCoverageStartSnapshot = measurementMode === 'record'
    ? getPrivateTrackCoverageSnapshot(graph)
    : null;
  const startMonotonicMs = performance.now();
  const startAudioTimeSeconds = graph.context.currentTime;
  graph.outputSampler.reset();
  setStatus(`Measuring for ${durationSeconds} real-wall seconds…`);
  await runTimedMeasurement(graph, durationSeconds);
  const privateTrackCoverageEndSnapshot = measurementMode === 'record'
    ? getPrivateTrackCoverageSnapshot(graph)
    : null;
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
  const finalLifecycle = getBenchmarkProgress();

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
    const eventDriven = state.persistentSlotSet !== undefined && !state.persistentSlotSet.has(slot.slot);
    const activeIntervals = eventDriven ? state.activeWorkletCoverage?.intervalsForSlot(slot.slot) ?? [] : [];
    const activeIntervalSummary = eventDriven ? summarizeActiveWorkletCoverage(activeIntervals) : null;
    const expectedFramesForCoverage = eventDriven
      ? activeIntervalSummary?.expectedFrames ?? 0
      : expectedAudioFrames;
    const observedFramesForCoverage = eventDriven
      ? activeIntervalSummary?.observedFrames ?? 0
      : slot.totalOutputFramesObserved;
    const ratio = eventDriven
      ? activeIntervalSummary?.coverageRatio ?? 0
      : observedFramesForCoverage / Math.max(1, expectedFramesForCoverage);
    const passed = eventDriven ? activeIntervalSummary?.passed ?? false : ratio >= 0.95;
    return {
      label: slot.label,
      processorName: slot.processorName,
      eventDriven,
      continuousCoverageEligible: !eventDriven,
      coverageStatus: eventDriven
        ? activeIntervalSummary?.coverageStatus ?? 'NOT_EVALUATED'
        : passed ? 'PASS' : 'FAIL',
      eligibleIntervalCount: eventDriven ? activeIntervalSummary?.eligibleIntervalCount ?? 0 : null,
      notEvaluatedIntervalCount: eventDriven ? activeIntervalSummary?.notEvaluatedIntervalCount ?? 0 : null,
      observedFramesInNotEvaluatedIntervals: eventDriven
        ? activeIntervalSummary?.observedFramesInNotEvaluatedIntervals ?? 0 : null,
      coverageWindowNote: eventDriven
        ? 'Dynamic TrackAudio worklets are evaluated separately over positive-frame active intervals. Zero-frame intervals are reported as NOT_EVALUATED and excluded; a slot with no eligible interval fails. Frames outside eligible intervals are reported but do not extend the expected window.'
        : 'Persistent graph node expected to process at least 95% of the complete measured AudioContext frame span.',
      expectedAudioFrames,
      expectedFramesForCoverage,
      observedFrames: observedFramesForCoverage,
      observedFramesOutsideActiveIntervals: eventDriven
        ? Math.max(0, slot.totalOutputFramesObserved - observedFramesForCoverage)
        : 0,
      ratio,
      activeIntervals,
      passed,
    };
  });
  metrics.privateTrackCoverage = privateTrackCoverageStartSnapshot && privateTrackCoverageEndSnapshot
    ? comparePrivateTrackCoverageSnapshots(privateTrackCoverageStartSnapshot, privateTrackCoverageEndSnapshot)
    : {
      audioContextExpectedFrames: null,
      boundarySource: getProcessorAudioClockSlot(state) === null
        ? 'AudioContext.currentTime converted to sample frame; audio timeline, not wall clock'
        : 'max(independent block-meter AudioWorklet frame, target last completed process frame)',
      tracks: [],
      passed: false,
      unavailableReason: 'A coherent start/end coverage snapshot was not captured for record mode',
    };
  const requirePrivateTrackCoverage = profile === 'full-runtime' && !graph.diagnosticOmitPrivateTrackFx;
  metrics.privateTrackCoverage.required = requirePrivateTrackCoverage;
  if (!requirePrivateTrackCoverage) metrics.privateTrackCoverage.passed = null;
  metrics.activeWorkletIntervals = state.activeWorkletCoverage?.allIntervals() ?? [];
  metrics.callbackCoveragePassed = metrics.callbackCoverage.length > 0
    && metrics.callbackCoverage.every((slot) => slot.passed)
    && (!requirePrivateTrackCoverage || metrics.privateTrackCoverage.passed === true);
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
  // Keep detailed diagnostics even when a strict acceptance guard fails.
  // Otherwise the failure itself would discard the per-node latency data
  // needed to find the expensive stage.
  window.__rc505BenchDiagnostic = {
    schemaVersion: 1,
    state: 'measurement-diagnostic',
    measurementMode,
    browser: {
      userAgent: navigator.userAgent,
      requestedSampleRateHz: REQUESTED_SAMPLE_RATE,
      actualSampleRateHz: graph.context.sampleRate,
    },
    graph: {
      profile,
      diagnosticStage: graph.diagnosticStage,
      workload: graph.workload ?? null,
      initialInstrumentedWorkletCount: graph.workload?.initialInstrumentedWorkletCount ?? state.nodes.length,
      topologyDeclaration: graph.workload?.topologyDeclaration ?? null,
      sharedInputCapture: graph.sharedInputCapture ?? { enabled: false },
      workletNodes: state.nodes.map(({ slot, label, processorName }) => ({ slot, label, processorName })),
    },
    duration,
    contextProgression,
    metrics,
    outputSignalSentinel,
    uninstrumentedOutputProbe: metrics.uninstrumentedOutputProbe,
    processorErrors: [...state.processorErrors],
    callbackExceptionDetails: [...state.callbackExceptionDetails],
    nodeConstructionFailures: [...state.nodeConstructionFailures],
    nodeLifecycle: finalLifecycle.nodeLifecycle,
    measurementActiveFlagAtEnd: activeFlagAtMeasurementEnd,
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
      profile,
      initialInstrumentedWorkletCount: graph.workload?.initialInstrumentedWorkletCount ?? state.nodes.length,
      topologyDeclaration: graph.workload?.topologyDeclaration ?? null,
      sharedInputCapture: graph.sharedInputCapture ?? { enabled: false },
      syntheticLoopTracks: ['production', 'full-runtime'].includes(graph.diagnosticStage) ? 5 : 0,
      track1Source: graph.workload?.pcmSeed ?? (graph.diagnosticStage === 'production'
        ? 'production Signalsmith createLivePolyPitchNode (LIVE_POLY), 3-second stereo synthetic loop'
        : null),
      track2Through5Source: graph.diagnosticStage === 'production'
        ? 'four looping stereo AudioBufferSourceNode clean-room synthetic tone buffers'
        : graph.diagnosticStage === 'full-runtime'
          ? DIAGNOSTIC_DISABLE_LIVE_POLY
            ? 'production TrackAudio buffers seeded with deterministic stereo PCM; LIVE_POLY intentionally omitted for isolated diagnostics'
            : 'production TrackAudio buffers seeded with deterministic stereo PCM; five production Signalsmith LIVE_POLY routes active'
        : null,
      diagnosticDirectSource: new URLSearchParams(location.search).get('diagnosticDirectSource') === '1'
        ? 'optional 440 Hz oscillator mixed directly to master for render-path diagnostics; excluded from product-acceptance claims'
        : null,
      inputEffects: graph.workload?.activeInputFx?.map((entry) => entry.type)
        ?? (graph.diagnosticStage === 'production' ? ['DSP LPF', 'DIST', 'VIBRATO', 'SUSTAINER'] : []),
      inputEffectRouting: graph.diagnosticStage === 'full-runtime'
        ? graph.sharedInputCapture?.enabled
          ? 'synthetic stereo oscillator input -> actual BrowserAudioEngine Input A–D FX -> persistent engine-owned shared capture worklet; TrackAudio records exact requested half-open frame ranges from that tap during logged recording operations'
          : 'synthetic stereo oscillator input -> actual BrowserAudioEngine Input A–D FX -> actual TrackAudio recorder worklet during logged recording operations'
        : graph.diagnosticStage === 'production'
        ? 'separate synthetic input loop -> four serial production BrowserWorkletFX nodes -> final mix'
        : 'diagnostic-only minimal signal path; no production input effects',
      sharedTrackEffectBank: graph.workload?.activeSharedTrackFx ?? [],
      trackEffectBank: graph.workload?.privateTrackFxMatrix
        ?? (graph.diagnosticStage === 'production' ? ['CHORUS', 'FDN8 REVERB', 'DELAY', 'AUTO PAN'] : []),
      trackEffectRouting: graph.diagnosticStage === 'full-runtime'
        ? DIAGNOSTIC_OMIT_PRIVATE_TRACK_FX
          ? 'five independent production TrackAudio sources -> empty/passthrough per-track chains -> TrackMix -> four shared postmix FX -> production master meter and destination'
          : 'five independent Browser TrackAudio sources -> each private serial A–D BrowserTrackFxChain -> TrackMix -> four shared postmix FX -> production master meter and destination'
        : graph.diagnosticStage === 'production'
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
      fullRuntimeWorkload: graph.workload ?? null,
      nodeLifecycle: finalLifecycle.nodeLifecycle,
    },
    duration,
    contextProgression,
    metrics,
    outputSignalSentinel,
    browserJsMemory: summarizeMemory(startMemory, endMemory),
    instrumentation: {
      maxInstrumentedWorkletNodes: MAX_SLOTS,
      sharedMemoryProbeBytes: state.buffer.byteLength,
      sharedMemoryProbeMiB: state.buffer.byteLength / (1024 * 1024),
      sharedMemoryProbeOverhead: 'Test-only SharedArrayBuffer reserved for callback histograms and counters; its allocation contributes to browser memory and may affect scheduling. It is excluded from the application memory budget.',
      nodeLifecycleClassification: 'Cumulative created count is separate from track-referenced active/idle nodes, setup-persistent graph nodes, and dynamic nodes no longer referenced by TrackAudio; Signalsmith WASM leases come from the runtime ledger.',
      callbackExceptionDetails: [...state.callbackExceptionDetails],
      nodeConstructionFailures: [...state.nodeConstructionFailures],
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
      profile === 'full-runtime'
        ? 'Uses production BrowserAudioEngine, TrackAudio, BrowserTrackFxChain, RhythmEngine, recorder/overdub worklets, and PCM undo/redo APIs, but is not the Vue LCD UI, real device setup, physical output, or whole-app CPU measurement.'
        : 'Not the complete application/runtime path: no Vue UI, device setup, recording/overdub, app transport integration, per-track production TrackAudio lifecycle, or full master/monitor topology.',
      'Not a whole-app CPU, whole-system CPU, thermal, power, or acoustic-latency benchmark.',
      'Not direct XRUN/dropout instrumentation. Deadline misses and frame-gap-derived missing callback estimates are software-side proxies only.',
      'All loop and input signals are generated synthetic tones; rhythm events and kit are clean-room generated, not user audio or factory samples/MIDI.',
      'Any result applies only to the exact headless-shell version, host, OS, graph, sample rate, duration, and instrumentation recorded in the JSON.',
    ],
    cleanup: { contextSuspended: graph.context.state === 'suspended', contextClosed: false },
  };

  graph.rhythm?.stop();
  for (const track of graph.runtimeTracks ?? []) track.stop();
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
      window.__rc505BenchException = serializeException(error);
      window.__rc505BenchError = `${window.__rc505BenchException.name}: ${window.__rc505BenchException.message}`;
      setStatus(`FAILED: ${window.__rc505BenchError}`);
      return null;
    }
  })();
});

window.__rc505Bench = {
  get ready() { return window.__rc505BenchSetupReady ?? false; },
  get error() { return window.__rc505BenchError ?? null; },
  get exception() { return window.__rc505BenchException ?? null; },
  get diagnostic() { return window.__rc505BenchDiagnostic ?? null; },
  get readySlots() { return harnessState?.readySlots.size ?? 0; },
  get nodeCount() { return harnessState?.nodes.length ?? 0; },
  get progress() { return getBenchmarkProgress(); },
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
