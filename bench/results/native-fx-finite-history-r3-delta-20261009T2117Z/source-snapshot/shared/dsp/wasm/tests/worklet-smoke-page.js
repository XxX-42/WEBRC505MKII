const CONTROL_START = 0;
const CONTROL_READY = 1;
const CONTROL_DONE = 2;
const CONTROL_CALLBACKS = 3;
const CONTROL_ERROR = 4;

const SUMMARY = {
  sampleCount: 0,
  sumSquares: 1,
  peak: 2,
  nonFinite: 3,
  nonZeroInput: 4,
  totalCallbacks: 5,
  startCallbackIndex: 6,
  measuredBlocks: 7,
  totalFrames: 8,
  frameGaps: 9,
  wasmBytesAfter: 10,
  processError: 11,
  maxObservedFrames: 12,
};

const search = new URLSearchParams(location.search);
const targetBlocks = Number(search.get('blocks') || 1024);
const maxBlockFrames = Number(search.get('maxBlockFrames') || 512);
const requestedSampleRate = Number(search.get('sampleRate') || 48000);
const timeoutMs = Number(search.get('timeoutMs') || 30000);
const statusElement = document.querySelector('#status');

function updateStatus(value) {
  statusElement.textContent = typeof value === 'string' ? value : JSON.stringify(value);
}

function makeAudioContext() {
  try {
    const context = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: requestedSampleRate,
      sinkId: { type: 'none' },
    });
    return { context, sinkMode: 'sink-none' };
  } catch (error) {
    const context = new AudioContext({ latencyHint: 'interactive', sampleRate: requestedSampleRate });
    return { context, sinkMode: 'muted-destination', sinkNoneError: String(error) };
  }
}

async function prepare() {
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    throw new Error('Cross-origin isolation is required for lock-free shared test buffers.');
  }
  if (!Number.isInteger(targetBlocks) || targetBlocks < 1 || targetBlocks > 10000) {
    throw new Error('blocks must be an integer from 1 through 10000.');
  }
  if (!Number.isInteger(maxBlockFrames) || maxBlockFrames < 1 || maxBlockFrames > 8192) {
    throw new Error('maxBlockFrames must be an integer from 1 through 8192.');
  }

  const response = await fetch('/webrc-dsp.wasm', { cache: 'no-store' });
  if (!response.ok) throw new Error(`WASM fetch failed with HTTP ${response.status}.`);
  const wasmModule = await WebAssembly.compileStreaming(response);
  const { context, sinkMode, sinkNoneError } = makeAudioContext();
  await context.audioWorklet.addModule('/dsp-wasm-worklet-processor.js');

  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
  const frameRecordBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (targetBlocks + 16));
  const summaryBuffer = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * 16);
  const control = new Int32Array(controlBuffer);
  const frameRecord = new Int32Array(frameRecordBuffer);
  const summary = new Float64Array(summaryBuffer);

  let readyResolve;
  let readyReject;
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = (value) => {
      if (readySettled) return;
      readySettled = true;
      resolve(value);
    };
    readyReject = (error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  const node = new AudioWorkletNode(context, 'dsp-wasm-interface-smoke', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: {
      wasmModule,
      controlBuffer,
      frameRecordBuffer,
      summaryBuffer,
      maxBlockFrames,
      targetBlocks,
    },
  });
  node.port.onmessage = (event) => {
    if (event.data && event.data.type === 'DSP_WASM_READY') readyResolve(event.data);
  };
  node.onprocessorerror = () => {
    const message = 'AudioWorklet processorerror event.';
    Atomics.store(control, CONTROL_ERROR, -6);
    if (window.workletHarness) window.workletHarnessFailure = message;
    readyReject(new Error(message));
  };
  const readyInfo = await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AudioWorklet ready timeout.')), 10000)),
  ]);
  if (readyInfo.apiVersion !== 1) throw new Error(`Unexpected DSP WASM API ${readyInfo.apiVersion}.`);
  if (readyInfo.memoryBytes !== 64 * 1024 * 1024) {
    throw new Error(`Unexpected fixed WASM memory size ${readyInfo.memoryBytes}.`);
  }

  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.value = 997;
  const inputGain = context.createGain();
  inputGain.gain.value = 0.25;
  const mutedOutput = context.createGain();
  mutedOutput.gain.value = 0;
  tone.connect(inputGain);
  inputGain.connect(node);
  node.connect(mutedOutput);
  mutedOutput.connect(context.destination);
  const audioContextStateAtSetup = context.state;

  window.workletHarness = {
    readyInfo,
    targetBlocks,
    maxBlockFrames,
    requestedSampleRate,
    control,
    frameRecord,
    summary,
    node,
    context,
    tone,
    sinkMode,
    sinkNoneError,
    audioContextStateAtSetup,
    async run() {
      const startedAt = performance.now();
      await context.resume();
      tone.start();
      Atomics.store(control, CONTROL_START, 1);

      await new Promise((resolve, reject) => {
        const deadline = performance.now() + timeoutMs;
        const poll = () => {
          const error = Atomics.load(control, CONTROL_ERROR);
          if (error !== 0) {
            reject(new Error(`Worklet reported shared control error ${error}.`));
            return;
          }
          if (Atomics.load(control, CONTROL_DONE) === 1) {
            resolve();
            return;
          }
          if (performance.now() >= deadline) {
            reject(new Error(`Worklet smoke timed out after ${timeoutMs} ms.`));
            return;
          }
          setTimeout(poll, 2);
        };
        poll();
      });

      const measuredFrameCounts = Array.from(frameRecord.subarray(0, targetBlocks));
      Atomics.store(control, CONTROL_START, 0);
      tone.stop();
      node.disconnect();
      inputGain.disconnect();
      mutedOutput.disconnect();
      await context.close();
      const wallElapsedMs = performance.now() - startedAt;
      const result = {
        status: 'complete',
        timingScope: 'external Chromium CDP trace; Worklet performance timers are not used',
        input: 'software-generated 997 Hz sine at 0.25 gain',
        sinkMode,
        sinkNoneError,
        crossOriginIsolated,
        userAgent: navigator.userAgent,
        requestedSampleRate,
        actualSampleRate: context.sampleRate,
        audioContextStateAtSetup,
        maxBlockFrames,
        targetBlocks,
        measuredFrameCounts,
        readyInfo,
        wallElapsedMs,
        audioContextClosed: context.state === 'closed',
        summary: {
          sampleCount: summary[SUMMARY.sampleCount],
          rms: Math.sqrt(summary[SUMMARY.sumSquares] / Math.max(1, summary[SUMMARY.sampleCount])),
          peak: summary[SUMMARY.peak],
          nonFinite: summary[SUMMARY.nonFinite],
          nonZeroInput: summary[SUMMARY.nonZeroInput],
          totalCallbacksAtTargetCompletion: summary[SUMMARY.totalCallbacks],
          totalCallbacks: Atomics.load(control, CONTROL_CALLBACKS),
          startCallbackIndex: summary[SUMMARY.startCallbackIndex],
          measuredBlocks: summary[SUMMARY.measuredBlocks],
          totalFrames: summary[SUMMARY.totalFrames],
          frameGaps: summary[SUMMARY.frameGaps],
          wasmBytesAfter: summary[SUMMARY.wasmBytesAfter],
          processError: summary[SUMMARY.processError],
          maxObservedFrames: summary[SUMMARY.maxObservedFrames],
          wasiIoCalls: summary[13],
          wasiIoFailures: summary[14],
        },
      };
      return result;
    },
  };
  const startButton = document.querySelector('#start-test');
  startButton.disabled = false;
  startButton.addEventListener('click', () => {
    window.workletHarnessPromise = window.workletHarness.run().then((result) => {
      window.workletHarnessResult = result;
    }).catch((error) => {
      window.workletHarnessFailure = String(error && error.stack || error);
    });
  }, { once: true });
  updateStatus({ ready: true, readyInfo, sinkMode });
  return window.workletHarness;
}

window.workletHarnessReady = prepare().catch((error) => {
  window.workletHarnessError = String(error && error.stack || error);
  updateStatus({ error: window.workletHarnessError });
  throw error;
});
