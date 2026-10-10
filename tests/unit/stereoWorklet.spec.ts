import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateRealtimeWorklet } from '../helpers/evaluateRealtimeWorklet';
import { BrowserRealtimeRuntime } from '../../src/audio/BrowserRealtimeRuntime';
import { BrowserFxMidiQueueWriter, createBrowserFxMidiBuffer } from '../../src/audio/browserFxMidiProtocol';
import {
  BROWSER_REALTIME_LAYOUT_MONO,
  BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  BROWSER_REALTIME_LAYOUT_VERSION,
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BROWSER_REALTIME_STORAGE_BATCH_BLOCKS,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
  BROWSER_REALTIME_TRACK_COUNT,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  ControlWord,
  TRACK_META_BYTES,
  TrackMetaWord,
  createControlSharedBuffer,
  createMonoLoopbackSharedBuffer,
  createTakeSegmentBuffer,
  createTrackSharedBuffer,
  queueSharedCommand,
} from '../../src/audio/browserRealtimeProtocol';

type HarnessPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  messages: Array<Record<string, unknown>>;
  postMessage: (message: Record<string, unknown>) => void;
};

type SharedDspTestRoute = {
  left: number;
  right: number;
  enabled: boolean;
  wetGain: number;
  wetTarget: number;
  wetStep: number;
  wetRampRemaining: number;
  pendingReset: boolean;
  values: Float32Array;
};

type SharedDspFxTestRoute = { handles: number[]; warmupFrames: number; warmedFrames: number; historyCount: number };

class HarnessProcessorBase {
  public port: HarnessPort = {
    onmessage: null,
    messages: [],
    postMessage(message) { this.messages.push(message); },
  };
}

type WorkletTestProcessor = HarnessProcessorBase & {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  handlePortMessage(message: unknown): void;
  sharedDsp: {
    wasm: {
      webrc_dsp_process: (handle: number, ...args: number[]) => number;
      webrc_dsp_reset: (handle: number) => number;
      webrc_dsp_fx_fixed_latency_samples?: (handle: number) => number;
      webrc_dsp_fx_startup_warmup_frames?: (handle: number) => number;
      webrc_dsp_managed_memory_bytes?: () => number;
    };
    maxBlockFrames: number;
    scratchAddress: number;
    scratchInput: Float32Array;
    scratchOutput: Float32Array;
    outputStageLeft: Float32Array;
    outputStageRight: Float32Array;
    fxInputRoutes?: SharedDspFxTestRoute[];
    fxTrackRoutes?: SharedDspFxTestRoute[];
    fxMidiBuffer?: SharedArrayBuffer;
    fxCurrentMidiEventCount?: number;
    fxStaged?: {
      stageId: number; handles: number[];
      inputRoutes: SharedDspFxTestRoute[];
      trackRoutes: SharedDspFxTestRoute[];
    } | null;
    fxWarming?: {
      stageId: number;
      warmedFrames: number;
      trackRoutes: SharedDspFxTestRoute[];
    } | null;
    fxActiveHandles?: number[];
    fxRetired?: { stageId: number; handles: number[] } | null;
    fxTransitionFrames?: number;
    fxTransitionElapsed?: number;
  } | null;
  setSharedDspWetTarget(route: SharedDspTestRoute, target: number): void;
  processSharedDspStereo(
    route: SharedDspTestRoute, sourceLeft: Float32Array, sourceRight: Float32Array,
    outputLeft: Float32Array, outputRight: Float32Array, frames: number,
  ): boolean;
  collectSharedDspFxMidiEvents(blockStartFrame: number, frames: number): void;
  processSharedDspRenderedOutputs(outputs: Float32Array[][], frames: number, blockStartFrame: number): void;
  takeIndex(track: number, slot: number): number;
  takeModes: Int8Array;
  takeFrames: Int32Array;
  takeActive: Uint8Array;
  takeMeta: Array<Array<Int32Array | null>>;
  commitTake(track: number, slot: number, frames: number): void;
  playPositions: Float64Array;
  playbackFrames: Float64Array;
  outputMonitorEnabled: boolean;
  processCallbackCount: number;
  processFrameCount: number;
  timelineDuplicateCallbacks: number;
  timelineForwardGapCount: number;
  timelineForwardGapFrames: number;
  timelineFailureCount: number;
  timelineRecoveryActive: boolean;
  timelineRecoveryNeeded: boolean;
  timelineRecoveryCount: number;
  timelineRecoveryCompleteCount: number;
  timelineRecoveryCatchupFrames: number;
  timelineUnrecoveredGapFrames: number;
  timelineDroppedOutputCallbacks: number;
  timelineDroppedOutputFrames: number;
  timelineDroppedInputCallbacks: number;
  timelineDroppedInputFrames: number;
  timelineUniqueAdvancedFrames: number;
  timelineUniqueOutputFrames: number;
  timelineOutputEndFrame: number;
  timelineXrunCount: number;
  timelineExplicitRecoveryCount: number;
  timelineExplicitRecoverySkippedFrames: number;
  timelineDiscontinuityEpoch: number;
  timelineExpectedFrame: number;
  timelineLastActualFrame: number;
  timelineLastStatus: number;
};

function createHarness(
  controlBuffer = createControlSharedBuffer(),
  perTrackInputs = false,
  sharedDspModule?: WebAssembly.Module,
) {
  let RegisteredProcessor: (new (options: unknown) => HarnessProcessorBase) | null = null;
  const scope: Record<string, unknown> = {
    AudioWorkletProcessor: HarnessProcessorBase,
    registerProcessor: (_name: string, processor: new (options: unknown) => HarnessProcessorBase) => {
      RegisteredProcessor = processor;
    },
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    Math,
    Number,
    Array,
    performance,
    console,
    WebAssembly,
    sampleRate: 48_000,
    currentFrame: 0,
  };
  evaluateRealtimeWorklet(scope);
  if (!RegisteredProcessor) throw new Error('The real Worklet source did not register a processor.');
  const processorOptions: Record<string, unknown> = { controlBuffer, perTrackInputs };
  const fxMidiBuffer = sharedDspModule ? createBrowserFxMidiBuffer() : undefined;
  const fxCarrierControl = sharedDspModule ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) : undefined;
  if (sharedDspModule) {
    processorOptions.sharedDspModule = sharedDspModule;
    processorOptions.sharedDspMaxBlockFrames = 64;
    processorOptions.trackFxSendMask = new Uint8Array(BROWSER_REALTIME_TRACK_COUNT).fill(1);
    processorOptions.fxTransitionBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    processorOptions.fxMidiBuffer = fxMidiBuffer;
    processorOptions.fxCarrierControl = fxCarrierControl;
  }
  const processor = new RegisteredProcessor({ processorOptions }) as WorkletTestProcessor;
  return { processor, scope, controlBuffer, fxMidiBuffer, fxCarrierControl };
}

function readSharedDspWasmBytes() {
  const configuredPath = process.env.WEBRC_DSP_WASM_PATH;
  return readFileSync(configuredPath || resolve(process.cwd(), 'public/dsp/webrc-dsp.wasm'));
}

function createIntegratedRuntimeHarness() {
  const controlBuffer = createControlSharedBuffer();
  const { processor, scope } = createHarness(controlBuffer, true);
  const runtimePort = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(message: Record<string, unknown>) {
      processor.handlePortMessage(message);
    },
  };
  processor.port.postMessage = (message) => {
    processor.port.messages.push(message);
    runtimePort.onmessage?.({ data: message } as MessageEvent);
  };
  const runtime = new BrowserRealtimeRuntime(
    { port: runtimePort } as unknown as AudioWorkletNode,
    controlBuffer,
    48_000,
  );
  let frame = 0;
  const processAt = (startFrame: number, track: number | null, left?: Float32Array, right?: Float32Array) => {
    const inputs = Array.from({ length: 6 }, () => [] as Float32Array[]);
    if (track !== null && left) inputs[track + 1] = right ? [left, right] : [left];
    scope.currentFrame = startFrame;
    processor.process(inputs, outputs(left?.length ?? right?.length ?? 1));
  };
  const command = async (
    opcode: number,
    track: number,
    arg0 = 0,
    input?: { left: Float32Array; right?: Float32Array },
  ) => {
    const startFrame = frame;
    const pending = runtime.enqueue(opcode, track, arg0, 0, startFrame);
    processAt(startFrame, input ? track : null, input?.left, input?.right);
    frame += input?.left.length ?? input?.right?.length ?? 1;
    return await pending;
  };
  const drive = async <T>(action: Promise<T>): Promise<T> => {
    let settled = false;
    let failure: unknown;
    let result: T;
    void action.then((value) => { result = value; settled = true; }, (error) => { failure = error; settled = true; });
    const control = new Int32Array(controlBuffer);
    for (let attempt = 0; attempt < 1_000 && !settled; attempt += 1) {
      await Promise.resolve();
      if (Atomics.load(control, ControlWord.COMMAND_READ) !== Atomics.load(control, ControlWord.COMMAND_WRITE)) {
        processAt(frame, null);
        frame += 1;
      }
    }
    if (!settled) throw new Error('Integrated Worklet test did not settle after draining sample-clock commands.');
    if (failure) throw failure;
    return result!;
  };
  const exportContext = () => ({
    sampleRate: 48_000,
    createBuffer(channelCount: number, length: number, sampleRate: number) {
      const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
      return {
        numberOfChannels: channelCount, length, sampleRate,
        getChannelData(channel: number) { return channels[channel]!; },
      };
    },
  }) as unknown as AudioContext;
  return { runtime, processor, controlBuffer, command, drive, exportContext };
}

function outputs(frames: number): Float32Array[][] {
  return Array.from({ length: 7 }, () => [new Float32Array(frames), new Float32Array(frames)]);
}

function processBlock(
  processor: WorkletTestProcessor,
  scope: Record<string, unknown>,
  frame: number,
  left: Float32Array | null,
  right?: Float32Array | null,
) {
  const frames = left?.length ?? right?.length ?? BROWSER_REALTIME_QUANTUM_FRAMES;
  scope.currentFrame = frame;
  const channels = left ? (right ? [left, right] : [left]) : (right ? [right] : []);
  const input = channels.length ? [channels] : [];
  const rendered = outputs(frames);
  processor.process(input, rendered);
  return rendered;
}

function attach(processor: WorkletTestProcessor, track: number, capacity = 32) {
  const allocatedCapacity = BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
  const buffer = createTrackSharedBuffer(allocatedCapacity);
  const meta = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
  const left = new Float32Array(buffer, TRACK_META_BYTES, allocatedCapacity).subarray(0, capacity);
  const right = new Float32Array(buffer, TRACK_META_BYTES + allocatedCapacity * Float32Array.BYTES_PER_ELEMENT, allocatedCapacity).subarray(0, capacity);
  processor.handlePortMessage({
    type: 'ATTACH_TRACK', track, buffer,
    channelCount: BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
    layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
    storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  });
  expect(processor.port.messages.at(-1)).toMatchObject({
    type: 'TRACK_ATTACHED', track, channelCount: 2, layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION, storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  });
  prepareTake(processor, track, 0, 'BASE', true);
  return { buffer, meta, left, right };
}

function prepareTake(
  processor: WorkletTestProcessor,
  track: number,
  takeSlot: number,
  mode: 'BASE' | 'OVERDUB' | 'REPLACE1' | 'REPLACE2',
  usePrimary = false,
) {
  processor.handlePortMessage({ type: 'PREPARE_TAKE', track, takeSlot, mode, usePrimary });
  expect(processor.port.messages.at(-1)).toMatchObject({ type: 'TAKE_PREPARED', track, takeSlot });
}

function attachTakeSegment(
  processor: WorkletTestProcessor,
  track: number,
  takeSlot: number,
  segmentIndex = 0,
) {
  const buffer = createTakeSegmentBuffer(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
  processor.handlePortMessage({ type: 'ATTACH_TAKE_SEGMENT', track, takeSlot, segmentIndex, buffer });
  expect(processor.port.messages.at(-1)).toMatchObject({ type: 'TAKE_SEGMENT_ATTACHED', track, takeSlot, segmentIndex });
  const left = new Float32Array(buffer, TRACK_META_BYTES, BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
  const right = new Float32Array(
    buffer,
    TRACK_META_BYTES + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
    BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  );
  return { buffer, left, right };
}

function seedBaseHistory(
  processor: WorkletTestProcessor,
  track: number,
  meta: Int32Array,
  left: Float32Array,
  right: Float32Array,
  frames: number,
  position = 0,
  reverse = 0,
) {
  const takeIndex = processor.takeIndex(track, 0) as number;
  processor.takeModes[takeIndex] = 0;
  processor.takeFrames[takeIndex] = frames;
  processor.takeActive[takeIndex] = 1;
  processor.takeMeta[track][0] = meta;
  processor.commitTake(track, 0, frames);
  Atomics.store(meta, TrackMetaWord.STATE, 4);
  Atomics.store(meta, TrackMetaWord.PLAY_POSITION, position);
  Atomics.store(meta, TrackMetaWord.REVERSE, reverse);
  processor.playPositions[track] = position;
  processor.playbackFrames[track] = 0;
}

function command(controlBuffer: SharedArrayBuffer, sequence: number, opcode: number, track: number, frame: number, arg0 = 0) {
  expect(queueSharedCommand(new Int32Array(controlBuffer), { sequence, opcode, track, targetFrame: frame, arg0 })).toBe(true);
}

describe('versioned planar LR looper storage', () => {
  it('allocates two contiguous frame planes and reports the layout in the header', () => {
    const capacity = 19;
    const buffer = createTrackSharedBuffer(capacity);
    const meta = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    expect(buffer.byteLength).toBe(TRACK_META_BYTES + capacity * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(Atomics.load(meta, TrackMetaWord.CAPACITY_FRAMES)).toBe(capacity);
    expect(Atomics.load(meta, TrackMetaWord.CHANNEL_COUNT)).toBe(2);
    expect(Atomics.load(meta, TrackMetaWord.LAYOUT_VERSION)).toBe(BROWSER_REALTIME_LAYOUT_VERSION);
    expect(Atomics.load(meta, TrackMetaWord.STORAGE_LAYOUT)).toBe(BROWSER_REALTIME_LAYOUT_PLANAR_LR);
    const left = new Float32Array(buffer, TRACK_META_BYTES, capacity);
    const right = new Float32Array(buffer, TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT, capacity);
    left[3] = 0.25;
    right[3] = -0.75;
    expect(left[3]).toBe(0.25);
    expect(right[3]).toBe(-0.75);
  });

  it('records and plays distinct stereo channels without averaging or crosstalk', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const { meta, left, right } = attach(processor, 0, 16);
    const inputLeft = Float32Array.of(0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4);
    const inputRight = Float32Array.of(-0.8, -0.6, -0.4, -0.2, 0.2, 0.4, 0.6, 0.8);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 0);
    processBlock(processor, scope, 0, inputLeft, inputRight);
    command(controlBuffer, 2, BrowserRealtimeOpcode.STOP_RECORD, 0, 8, 1);
    const rendered = processBlock(processor, scope, 8, new Float32Array(8), new Float32Array(8));

    expect(Atomics.load(meta, TrackMetaWord.LOOP_FRAMES)).toBe(8);
    expect(Array.from(left.subarray(0, 8))).toEqual(Array.from(inputLeft));
    expect(Array.from(right.subarray(0, 8))).toEqual(Array.from(inputRight));
    expect(Array.from(rendered[0]![0]!)).toEqual(Array.from(inputLeft));
    expect(Array.from(rendered[0]![1]!)).toEqual(Array.from(inputRight));
  });

  it('preserves left-only, right-only, and anti-phase input independently', () => {
    const profiles = [
      { name: 'left-only', left: [0.25, -0.5, 0.75, -1], right: [0, 0, 0, 0] },
      { name: 'right-only', left: [0, 0, 0, 0], right: [-0.125, 0.25, -0.375, 0.5] },
      { name: 'anti-phase', left: [0.125, -0.25, 0.375, -0.5], right: [-0.125, 0.25, -0.375, 0.5] },
    ];
    for (const [track, profile] of profiles.entries()) {
      const { processor, scope, controlBuffer } = createHarness();
      const { left, right } = attach(processor, track, 8);
      const l = Float32Array.from(profile.left);
      const r = Float32Array.from(profile.right);
      command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, track, 0);
      processBlock(processor, scope, 0, l, r);
      expect(Array.from(left.subarray(0, l.length)), profile.name).toEqual(profile.left);
      expect(Array.from(right.subarray(0, r.length)), profile.name).toEqual(profile.right);
      expect(Array.from(left.subarray(0, l.length)).map((sample, index) => sample + right[index]!))
        .toEqual(profile.left.map((sample, index) => sample + profile.right[index]!));
    }
  });

  it('duplicates a mono input into both loop planes for compatibility', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const { left, right } = attach(processor, 0, 8);
    const mono = Float32Array.of(0.2, -0.4, 0.6, -0.8);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 0);
    processBlock(processor, scope, 0, mono);
    expect(Array.from(left.subarray(0, mono.length))).toEqual(Array.from(mono));
    expect(Array.from(right.subarray(0, mono.length))).toEqual(Array.from(mono));
  });

  it('applies reverse and sample alignment to each overdub plane at the same frame', () => {
    for (const reverse of [0, 1]) {
      const { processor, scope, controlBuffer } = createHarness();
      const { meta, left, right } = attach(processor, 0, 16);
      left.set([1, 2, 3, 4, 5, 6, 7, 8]);
      right.set([11, 12, 13, 14, 15, 16, 17, 18]);
      seedBaseHistory(processor, 0, meta, left, right, 8, 5, reverse);
      Atomics.store(meta, TrackMetaWord.ALIGNMENT_SAMPLES, 2);
      prepareTake(processor, 0, 1, 'OVERDUB');
      const overdub = attachTakeSegment(processor, 0, 1);
      command(controlBuffer, 1, BrowserRealtimeOpcode.START_OVERDUB, 0, 64);
      const rendered = processBlock(processor, scope, 64, Float32Array.of(0.25), Float32Array.of(-0.5));
      const writePosition = reverse ? 7 : 3;
      expect(overdub.left[writePosition]).toBeCloseTo(0.25);
      expect(overdub.right[writePosition]).toBeCloseTo(-0.5);
      expect(rendered[0]![0]![0]).toBe(6);
      expect(rendered[0]![1]![0]).toBe(16);
      expect(Atomics.load(meta, TrackMetaWord.PLAY_POSITION)).toBe(reverse ? 4 : 6);
    }
  });

  it('wraps forward and reverse playback at the loop boundary without mixing LR data', () => {
    for (const reverse of [0, 1]) {
      const { processor, scope } = createHarness();
      const { meta, left, right } = attach(processor, 0, 8);
      left.set([1, 2, 3, 4]);
      right.set([10, 20, 30, 40]);
      seedBaseHistory(processor, 0, meta, left, right, 4, reverse ? 0 : 3, reverse);
      const rendered = outputs(4);
      scope.currentFrame = 128;
      processor.process([], rendered);
      expect(Array.from(rendered[0]![0]!)).toEqual(reverse ? [1, 4, 3, 2] : [4, 1, 2, 3]);
      expect(Array.from(rendered[0]![1]!)).toEqual(reverse ? [10, 40, 30, 20] : [40, 10, 20, 30]);
      expect(Atomics.load(meta, TrackMetaWord.PLAY_POSITION)).toBe(reverse ? 0 : 3);
    }
  });

  it('starts recording inside a quantum and respects the sample-targeted command boundary', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const { meta, left, right } = attach(processor, 0, 16);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 3);
    processBlock(processor, scope, 0,
      Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8),
      Float32Array.of(-1, -2, -3, -4, -5, -6, -7, -8));
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(5);
    expect(Array.from(left.subarray(0, 5))).toEqual([4, 5, 6, 7, 8]);
    expect(Array.from(right.subarray(0, 5))).toEqual([-4, -5, -6, -7, -8]);
  });

  it('clears both channels, stays silent in EMPTY/STOPPED fast paths, then rerecords cleanly', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const { meta, left, right } = attach(processor, 0, 16);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 0);
    processBlock(processor, scope, 0, Float32Array.of(1, 2, 3, 4), Float32Array.of(10, 20, 30, 40));
    command(controlBuffer, 2, BrowserRealtimeOpcode.STOP_RECORD, 0, 4, 1);
    processBlock(processor, scope, 4, new Float32Array(1), new Float32Array(1));
    command(controlBuffer, 3, BrowserRealtimeOpcode.CLEAR, 0, 5);
    const emptyOutput = processBlock(processor, scope, 5, new Float32Array(4), new Float32Array(4));
    expect(Atomics.load(meta, TrackMetaWord.LOOP_FRAMES)).toBe(0);
    expect(Array.from(emptyOutput[0]![0]!)).toEqual([0, 0, 0, 0]);
    expect(Array.from(emptyOutput[0]![1]!)).toEqual([0, 0, 0, 0]);
    processor.handlePortMessage({ type: 'RELEASE_TRACK_HISTORY', track: 0 });
    expect(processor.port.messages.at(-1)).toMatchObject({ type: 'TRACK_HISTORY_RELEASED', track: 0 });

    const rerecordLeft = Float32Array.of(-0.1, -0.2);
    const rerecordRight = Float32Array.of(-0.8, -0.9);
    prepareTake(processor, 0, 0, 'BASE', true);
    command(controlBuffer, 4, BrowserRealtimeOpcode.START_RECORD, 0, 9);
    processBlock(processor, scope, 9, rerecordLeft, rerecordRight);
    expect(Array.from(left.subarray(0, 2))).toEqual(Array.from(rerecordLeft));
    expect(Array.from(right.subarray(0, 2))).toEqual(Array.from(rerecordRight));
    command(controlBuffer, 5, BrowserRealtimeOpcode.STOP_RECORD, 0, 11, 1);
    processBlock(processor, scope, 11, new Float32Array(2), new Float32Array(2));
    command(controlBuffer, 6, BrowserRealtimeOpcode.STOP, 0, 13);
    const stoppedOutput = processBlock(processor, scope, 13, new Float32Array(2), new Float32Array(2));
    expect(Array.from(stoppedOutput[0]![0]!)).toEqual([0, 0]);
    expect(Array.from(stoppedOutput[0]![1]!)).toEqual([0, 0]);
  });

  it('keeps loopback calibration in a separate versioned mono buffer', () => {
    const { processor, scope } = createHarness();
    const monoBuffer = createMonoLoopbackSharedBuffer(4);
    const meta = new Int32Array(monoBuffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    expect(monoBuffer.byteLength).toBe(TRACK_META_BYTES + 4 * Float32Array.BYTES_PER_ELEMENT);
    expect(Atomics.load(meta, TrackMetaWord.CHANNEL_COUNT)).toBe(1);
    expect(Atomics.load(meta, TrackMetaWord.STORAGE_LAYOUT)).toBe(BROWSER_REALTIME_LAYOUT_MONO);

    processor.handlePortMessage({ type: 'ARM_LOOPBACK', buffer: monoBuffer, startFrame: 0, frames: 4 });
    expect(processor.port.messages.at(-1)).toMatchObject({ type: 'LOOPBACK_ARMED', frames: 4 });
    processBlock(processor, scope, 0, Float32Array.of(1, 2, 3, 4), Float32Array.of(-1, -2, -3, -4));
    const calibrated = new Float32Array(monoBuffer, TRACK_META_BYTES, 4);
    expect(Array.from(calibrated)).toEqual([0, 0, 0, 0]);
    expect(Atomics.load(meta, TrackMetaWord.LOOP_FRAMES)).toBe(4);

    const rejected = createMonoLoopbackSharedBuffer(4);
    processor.handlePortMessage({
      type: 'ATTACH_TRACK', track: 1, buffer: rejected,
      channelCount: 1, layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION, storageLayout: BROWSER_REALTIME_LAYOUT_MONO,
    });
    expect(processor.port.messages.at(-1)?.type).toBe('TRACK_ATTACH_ERROR');
  });

  it('advances the audio clock and emits silence for EMPTY/STOPPED tracks in the no-command fast path', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const attached = Array.from({ length: 5 }, (_, track) => attach(processor, track, 16));
    const control = new Int32Array(controlBuffer);
    const first = processBlock(processor, scope, 0, null);
    expect(Atomics.load(control, 3) >>> 0).toBe(BROWSER_REALTIME_QUANTUM_FRAMES);
    for (let track = 0; track < 5; track += 1) {
      expect(Array.from(first[track]![0]!)).toEqual(new Array(BROWSER_REALTIME_QUANTUM_FRAMES).fill(0));
      expect(Array.from(first[track]![1]!)).toEqual(new Array(BROWSER_REALTIME_QUANTUM_FRAMES).fill(0));
    }
    Atomics.store(attached[0]!.meta, TrackMetaWord.STATE, 6);
    Atomics.store(attached[0]!.meta, TrackMetaWord.LOOP_FRAMES, 4);
    attached[0]!.left.set([9, 8, 7, 6]);
    attached[0]!.right.set([-9, -8, -7, -6]);
    const second = processBlock(processor, scope, BROWSER_REALTIME_QUANTUM_FRAMES, null);
    expect(Atomics.load(control, 3) >>> 0).toBe(2 * BROWSER_REALTIME_QUANTUM_FRAMES);
    expect(Array.from(second[0]![0]!)).toEqual(new Array(BROWSER_REALTIME_QUANTUM_FRAMES).fill(0));
    expect(Array.from(second[0]![1]!)).toEqual(new Array(BROWSER_REALTIME_QUANTUM_FRAMES).fill(0));
  });

  it('records each isolated input, writes dropout frames as silence, and resumes without compressing time', () => {
    const { processor, scope, controlBuffer } = createHarness(createControlSharedBuffer(), true);
    const { meta, left, right } = attach(processor, 0, 512);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 0);
    const render = (frame: number, trackInput: Float32Array[] | null) => {
      scope.currentFrame = frame;
      const inputs: Array<Float32Array[] | undefined> = [
        undefined,
        trackInput ?? undefined,
        undefined, undefined, undefined, undefined,
      ];
      processor.process(inputs as Float32Array[][], outputs(128));
    };
    render(0, [new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.5)]);
    render(128, null);
    render(256, [new Float32Array(128).fill(0.75), new Float32Array(128).fill(-1)]);
    command(controlBuffer, 2, BrowserRealtimeOpcode.STOP_RECORD, 0, 384, 1);
    render(384, [new Float32Array(128), new Float32Array(128)]);

    expect(Atomics.load(meta, TrackMetaWord.LOOP_FRAMES)).toBe(384);
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(384);
    expect(Array.from(left.subarray(0, 2))).toEqual([0.25, 0.25]);
    expect(Array.from(right.subarray(0, 2))).toEqual([-0.5, -0.5]);
    expect(Array.from(left.subarray(127, 130))).toEqual([0.25, 0, 0]);
    expect(Array.from(right.subarray(127, 130))).toEqual([-0.5, 0, 0]);
    expect(Array.from(left.subarray(255, 258))).toEqual([0, 0.75, 0.75]);
    expect(Array.from(right.subarray(255, 258))).toEqual([0, -1, -1]);
    expect(Atomics.load(new Int32Array(controlBuffer), ControlWord.INPUT_DROPOUT_FRAMES)).toBe(128);
  });

  it('replays duplicate render frames and advances a bounded source-switch gap once across five stereo histories', () => {
    const { processor, scope, controlBuffer } = createHarness(createControlSharedBuffer(), true);
    const tracks = Array.from({ length: 5 }, (_, track) => attach(processor, track, 512));
    const control = new Int32Array(controlBuffer);
    for (let track = 0; track < 5; track += 1) {
      command(controlBuffer, track + 1, BrowserRealtimeOpcode.START_RECORD, track, 0);
    }

    const makeSources = (leftScale: number, rightScale: number) => {
      const inputs: Float32Array[][] = Array.from({ length: 6 }, () => []);
      for (let track = 0; track < 5; track += 1) {
        const left = new Float32Array(128).fill(leftScale * (track + 1));
        const right = new Float32Array(128).fill(rightScale * (track + 1));
        inputs[track + 1] = [left, right];
      }
      return inputs;
    };
    const constantBlock = (value: number) => Array.from(new Float32Array(128).fill(value));
    const renderAt = (frame: number, inputs: Float32Array[][]) => {
      scope.currentFrame = frame;
      const rendered = outputs(128);
      processor.process(inputs, rendered);
      return rendered;
    };

    const sourceA = renderAt(0, makeSources(0.1, -0.07));
    expect(processor.timelineUniqueOutputFrames).toBe(128);
    expect(processor.timelineOutputEndFrame).toBe(128);
    expect(tracks.every(({ meta }) => Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES) === 128)).toBe(true);
    command(controlBuffer, 99, BrowserRealtimeOpcode.SET_MONITOR, 0, 128, 1);

    // A duplicate callback has a different live input source, but must replay
    // the previous PCM and leave commands, record heads, and history untouched.
    const duplicate = renderAt(0, makeSources(-0.9, 0.8));
    for (let output = 0; output < 7; output += 1) {
      expect(Array.from(duplicate[output]![0]!)).toEqual(Array.from(sourceA[output]![0]!));
      expect(Array.from(duplicate[output]![1]!)).toEqual(Array.from(sourceA[output]![1]!));
    }
    expect(processor.timelineDuplicateCallbacks).toBe(1);
    expect(processor.timelineUniqueOutputFrames).toBe(128);
    expect(processor.timelineOutputEndFrame).toBe(128);
    expect(processor.outputMonitorEnabled).toBe(false);
    expect(Atomics.load(control, ControlWord.COMMAND_READ)).toBe(5);
    expect(Atomics.load(control, ControlWord.COMMAND_WRITE)).toBe(6);
    expect(tracks.every(({ meta }) => Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES) === 128)).toBe(true);

    // The next real block is one quantum ahead. The Worklet advances frames
    // 128..255 through zero input before switching to the new five-track source.
    renderAt(256, makeSources(-0.03, 0.11));
    for (let track = 0; track < 5; track += 1) {
      const { meta, left, right } = tracks[track]!;
      expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(384);
      expect(Array.from(left.subarray(0, 128))).toEqual(constantBlock(0.1 * (track + 1)));
      expect(Array.from(right.subarray(0, 128))).toEqual(constantBlock(-0.07 * (track + 1)));
      expect(Array.from(left.subarray(128, 256))).toEqual(constantBlock(0));
      expect(Array.from(right.subarray(128, 256))).toEqual(constantBlock(0));
      expect(Array.from(left.subarray(256, 384))).toEqual(constantBlock(-0.03 * (track + 1)));
      expect(Array.from(right.subarray(256, 384))).toEqual(constantBlock(0.11 * (track + 1)));
    }
    const monitorAck = processor.port.messages.find((message) => message.type === 'ACK' && message.sequence === 99);
    expect(monitorAck).toMatchObject({ executedFrame: 128, status: 0 });
    expect(processor.outputMonitorEnabled).toBe(true);
    expect(Atomics.load(control, ControlWord.COMMAND_READ)).toBe(6);
    expect(processor.timelineForwardGapCount).toBe(1);
    expect(processor.timelineForwardGapFrames).toBe(128);
    expect(processor.timelineFailureCount).toBe(0);
    expect(processor.timelineExpectedFrame).toBe(384);
    expect(processor.timelineLastActualFrame).toBe(256);
    expect(processor.timelineLastStatus).toBe(2);
    expect(processor.processCallbackCount).toBe(3);
    expect(processor.processFrameCount).toBe(384);
    expect(processor.timelineUniqueOutputFrames).toBe(256);
    expect(processor.timelineOutputEndFrame).toBe(384);
    expect(Atomics.load(control, ControlWord.INPUT_DROPOUT_FRAMES)).toBe(5 * 128);
    expect(Atomics.load(control, ControlWord.RENDER_FRAME_LOW) >>> 0).toBe(384);
  });

  it('recovers a multi-quantum forward gap in bounded silence chunks and applies commands once', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const { meta, left, right } = attach(processor, 0, 1_024);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 0);
    processBlock(processor, scope, 0, new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.5));
    command(controlBuffer, 2, BrowserRealtimeOpcode.SET_MONITOR, 0, 256, 1);

    // Expected frame is 128, so the 384-frame gap needs two bounded catch-up
    // callbacks. The first callback emits silence; it does not reject commands.
    const first = processBlock(processor, scope, 512,
      new Float32Array(128).fill(0.75), new Float32Array(128).fill(-1));
    expect(first.every((output) => output![0]!.every((sample) => sample === 0) &&
      output![1]!.every((sample) => sample === 0))).toBe(true);
    expect(processor.outputMonitorEnabled).toBe(true);
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(384);
    expect(processor.timelineExpectedFrame).toBe(384);
    expect(processor.timelineRecoveryActive).toBe(true);
    expect(processor.timelineRecoveryNeeded).toBe(false);

    // The repeated render timestamp is counted, catch-up consumes frames
    // 384..511, and this block's actual PCM is recorded once at 512..639.
    const resumed = processBlock(processor, scope, 512,
      new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.25));
    expect(Array.from(resumed[5]![0]!)).toEqual(new Array(128).fill(0.5));
    expect(Array.from(resumed[5]![1]!)).toEqual(new Array(128).fill(-0.25));
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(640);
    expect(Array.from(left.subarray(0, 128))).toEqual(new Array(128).fill(0.25));
    expect(Array.from(left.subarray(128, 512))).toEqual(new Array(384).fill(0));
    expect(Array.from(right.subarray(0, 128))).toEqual(new Array(128).fill(-0.5));
    expect(Array.from(right.subarray(128, 512))).toEqual(new Array(384).fill(0));
    expect(processor.timelineDuplicateCallbacks).toBe(1);
    expect(processor.timelineForwardGapCount).toBe(1);
    expect(processor.timelineForwardGapFrames).toBe(384);
    expect(processor.timelineFailureCount).toBe(0);
    expect(processor.timelineRecoveryCount).toBe(1);
    expect(processor.timelineRecoveryCompleteCount).toBe(1);
    expect(processor.timelineRecoveryCatchupFrames).toBe(384);
    expect(processor.timelineRecoveryActive).toBe(false);
    expect(processor.timelineExpectedFrame).toBe(640);
    expect(processor.timelineLastActualFrame).toBe(512);
    expect(processor.timelineLastStatus).toBe(2);
    expect(processor.timelineDroppedOutputCallbacks).toBe(1);
    expect(processor.timelineDroppedOutputFrames).toBe(128);
    expect(processor.timelineDroppedInputCallbacks).toBe(1);
    expect(processor.timelineDroppedInputFrames).toBe(128);
    expect(processor.timelineUniqueAdvancedFrames).toBe(640);
    expect(processor.timelineUniqueOutputFrames).toBe(256);
    expect(processor.timelineOutputEndFrame).toBe(640);
    expect(processor.timelineXrunCount).toBe(1);
    expect(processor.port.messages.find((message) => message.type === 'ACK' && message.sequence === 2))
      .toMatchObject({ executedFrame: 256, status: BrowserRealtimeStatus.OK });
  });

  it('latches an oversized outage and only rebases under an explicit project recovery request', () => {
    const { processor, scope, controlBuffer } = createHarness();
    const { meta, left, right } = attach(processor, 0, 512);
    command(controlBuffer, 1, BrowserRealtimeOpcode.START_RECORD, 0, 0);
    processBlock(processor, scope, 0, new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.5));

    const dropped = processBlock(processor, scope, 8_192,
      new Float32Array(128).fill(0.75), new Float32Array(128).fill(-1));
    expect(dropped.every((output) => output![0]!.every((sample) => sample === 0) &&
      output![1]!.every((sample) => sample === 0))).toBe(true);
    expect(processor.timelineRecoveryNeeded).toBe(true);
    expect(processor.timelineFailureCount).toBe(1);
    expect(processor.timelineXrunCount).toBe(1);
    expect(processor.timelineUnrecoveredGapFrames).toBe(8_064);
    expect(processor.timelineExpectedFrame).toBe(128);
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(128);

    processor.handlePortMessage({ type: 'TIMELINE_RECOVERY_REQUEST', requestId: 55 });
    const recovered = processBlock(processor, scope, 8_192,
      new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.25));
    expect(recovered.every((output) => output![0]!.every((sample) => sample === 0) &&
      output![1]!.every((sample) => sample === 0))).toBe(true);
    expect(processor.timelineRecoveryNeeded).toBe(false);
    expect(processor.timelineExplicitRecoveryCount).toBe(1);
    expect(processor.timelineExplicitRecoverySkippedFrames).toBe(8_064);
    expect(processor.timelineDiscontinuityEpoch).toBe(1);
    expect(processor.timelineExpectedFrame).toBe(8_320);
    expect(processor.timelineLastStatus).toBe(9);
    expect(processor.timelineUniqueAdvancedFrames).toBe(256);
    expect(processor.timelineUniqueOutputFrames).toBe(256);
    expect(processor.timelineOutputEndFrame).toBe(8_320);
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(256);
    expect(Array.from(left.subarray(128, 256))).toEqual(new Array(128).fill(0.5));
    expect(Array.from(right.subarray(128, 256))).toEqual(new Array(128).fill(-0.25));
    expect(Atomics.load(new Int32Array(controlBuffer), ControlWord.INPUT_DROPOUT_FRAMES)).toBe(8_064);
    expect(processor.port.messages.find((message) => message.type === 'TIMELINE_RECOVERY_ACK' && message.requestId === 55))
      .toMatchObject({ recovered: true, previousFrame: 128, actualFrame: 8_192, skippedFrames: 8_064, discontinuityEpoch: 1 });
  });

  it('restores the immutable marked PCM branch after undo and an overdub replaces the redo take', async () => {
    const { runtime, command: run, drive, exportContext } = createIntegratedRuntimeHarness();
    await runtime.prepareTrack(0);

    const aLeft = Float32Array.of(0.1, 0.2, 0.3, 0.4);
    const aRight = Float32Array.of(-0.1, -0.2, -0.3, -0.4);
    await runtime.beginTake(0, 'BASE');
    expect((await run(BrowserRealtimeOpcode.START_RECORD, 0, 0, { left: aLeft, right: aRight })).status)
      .toBe(BrowserRealtimeStatus.OK);
    expect((await run(BrowserRealtimeOpcode.STOP_RECORD, 0, 1)).status).toBe(BrowserRealtimeStatus.OK);

    const bLeft = Float32Array.of(0.05, 0.06, 0.07, 0.08);
    const bRight = Float32Array.of(-0.05, -0.06, -0.07, -0.08);
    await runtime.beginTake(0, 'OVERDUB');
    expect((await run(BrowserRealtimeOpcode.START_OVERDUB, 0, 0, { left: bLeft, right: bRight })).status)
      .toBe(BrowserRealtimeStatus.OK);
    expect((await run(BrowserRealtimeOpcode.STOP_OVERDUB, 0)).status).toBe(BrowserRealtimeStatus.OK);
    const markedBranchExpected = await runtime.exportTrack(0, exportContext());

    // The test runner has driven the real processor through sample-clocked
    // commands; capture the immutable checkpoint from the public Runtime API.
    await drive(runtime.markTrack(0));
    expect(runtime.hasMarkSnapshot(0)).toBe(true);
    expect((await run(BrowserRealtimeOpcode.UNDO, 0)).status).toBe(BrowserRealtimeStatus.OK);

    const cLeft = Float32Array.of(0.3, 0.3, 0.3, 0.3);
    const cRight = Float32Array.of(-0.3, -0.3, -0.3, -0.3);
    await runtime.beginTake(0, 'OVERDUB');
    expect((await run(BrowserRealtimeOpcode.PLAY, 0)).status).toBe(BrowserRealtimeStatus.OK);
    expect((await run(BrowserRealtimeOpcode.START_OVERDUB, 0, 0, { left: cLeft, right: cRight })).status)
      .toBe(BrowserRealtimeStatus.OK);
    expect((await run(BrowserRealtimeOpcode.STOP_OVERDUB, 0)).status).toBe(BrowserRealtimeStatus.OK);

    await drive(runtime.restoreMarkedTrack(0));
    const restored = await runtime.exportTrack(0, exportContext());
    expect(restored.length).toBe(4);
    expect(Array.from(restored.getChannelData(0))).toEqual(Array.from(markedBranchExpected.getChannelData(0)));
    expect(Array.from(restored.getChannelData(1))).toEqual(Array.from(markedBranchExpected.getChannelData(1)));
    [0.18, 0.25, 0.36, 0.47].forEach((sample, index) => {
      expect(restored.getChannelData(0)[index]).toBeCloseTo(sample, 6);
      expect(restored.getChannelData(1)[index]).toBeCloseTo(-sample, 6);
    });
    runtime.dispose();
  });
});

describe('stereo runtime attachment and export contract', () => {
  it('rejects an old ACK, coalesces concurrent preparation, retries, and exports exact stereo samples', async () => {
    let attachMessages = 0;
    let segmentMessages = 0;
    let attemptedBuffer: SharedArrayBuffer | null = null;
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage(message: Record<string, unknown>) {
        if (message.type === 'ATTACH_TRACK') {
          attachMessages += 1;
          attemptedBuffer = message.buffer as SharedArrayBuffer;
        } else if (message.type === 'ATTACH_TAKE_SEGMENT') {
          segmentMessages += 1;
          port.onmessage?.({ data: {
            type: 'TAKE_SEGMENT_ATTACHED', track: message.track,
            takeSlot: message.takeSlot, segmentIndex: message.segmentIndex,
          } } as MessageEvent);
        }
      },
    };
    const controlBuffer = createControlSharedBuffer();
    const runtime = new BrowserRealtimeRuntime({ port } as unknown as AudioWorkletNode, controlBuffer, 48_000);

    const first = runtime.prepareTrack(0);
    const concurrent = runtime.prepareTrack(0);
    await Promise.resolve();
    expect(attachMessages).toBe(1);
    expect(attemptedBuffer).toBeInstanceOf(SharedArrayBuffer);
    port.onmessage?.({ data: { type: 'TRACK_ATTACHED', track: 0 } } as MessageEvent);
    await expect(first).rejects.toThrow(/handshake mismatch/);
    await expect(concurrent).rejects.toThrow(/handshake mismatch/);
    expect(runtime.getTrackMetadata(0)).toBeNull();
    expect(runtime.getTrackSamples(0, 0)).toBeNull();

    const retry = runtime.prepareTrack(0);
    await Promise.resolve();
    expect(attachMessages).toBe(2);
    const goodAck = () => port.onmessage?.({ data: {
      type: 'TRACK_ATTACHED', track: 0, channelCount: 2,
      layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
      storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
    } } as MessageEvent);
    goodAck();
    await retry;
    expect(segmentMessages).toBe(BROWSER_REALTIME_STORAGE_BATCH_BLOCKS - 1);
    expect(runtime.getTrackMetadata(0)).not.toBeNull();

    const samplesLeft = runtime.getTrackSamples(0, 0)!;
    const samplesRight = runtime.getTrackSamples(0, 1)!;
    const expectedLeft = Float32Array.of(0.125, -0.25, 0.375, -0.5);
    const expectedRight = Float32Array.of(-0.75, 0.5, -0.25, 0.125);
    samplesLeft.set(expectedLeft);
    samplesRight.set(expectedRight);
    const metadata = runtime.getTrackMetadata(0)!;
    Atomics.store(metadata, TrackMetaWord.LOOP_FRAMES, expectedLeft.length);
    Atomics.store(metadata, TrackMetaWord.HISTORY_CURSOR, 1);
    Atomics.store(metadata, TrackMetaWord.HISTORY_LENGTH, 1);
    port.onmessage?.({ data: {
      type: 'TAKE_COMMITTED', track: 0, takeSlot: 0, mode: 0,
      frameCount: expectedLeft.length, historyCursor: 1, historyLength: 1,
    } } as MessageEvent);

    const exported = runtime.exportTrack(0, {
      sampleRate: 48_000,
      createBuffer(channelCount: number, length: number, sampleRate: number) {
        const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
        return {
          numberOfChannels: channelCount, length, sampleRate,
          getChannelData(channel: number) { return channels[channel]!; },
          _channels: channels,
        };
      },
    } as unknown as AudioContext);
    const audioBuffer = await exported;
    expect(audioBuffer.numberOfChannels).toBe(2);
    expect(Array.from(audioBuffer.getChannelData(0))).toEqual(Array.from(expectedLeft));
    expect(Array.from(audioBuffer.getChannelData(1))).toEqual(Array.from(expectedRight));
    runtime.dispose();
  });

  it('exports immutable BASE frame counts across Record A, Record B, Undo, and Redo', async () => {
    const attachedTakeBuffers = new Map<number, SharedArrayBuffer>();
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage(message: Record<string, unknown>) {
        if (message.type === 'ATTACH_TRACK') {
          port.onmessage?.({ data: {
            type: 'TRACK_ATTACHED', track: message.track, channelCount: 2,
            layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
            storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
          } } as MessageEvent);
        } else if (message.type === 'ATTACH_TAKE_SEGMENT') {
          if (typeof message.takeSlot === 'number' && message.takeSlot > 0 && message.segmentIndex === 0 &&
              message.buffer instanceof SharedArrayBuffer) {
            attachedTakeBuffers.set(message.takeSlot, message.buffer);
          }
          port.onmessage?.({ data: {
            type: 'TAKE_SEGMENT_ATTACHED', track: message.track,
            takeSlot: message.takeSlot, segmentIndex: message.segmentIndex,
          } } as MessageEvent);
        } else if (message.type === 'PREPARE_TAKE') {
          port.onmessage?.({ data: { type: 'TAKE_PREPARED', track: message.track } } as MessageEvent);
        }
      },
    };
    const runtime = new BrowserRealtimeRuntime(
      { port } as unknown as AudioWorkletNode,
      createControlSharedBuffer(),
      48_000,
    );
    await runtime.prepareTrack(0);

    const metadata = runtime.getTrackMetadata(0)!;
    const commit = (slot: number, frames: number) => {
      Atomics.store(metadata, TrackMetaWord.LOOP_FRAMES, frames);
      Atomics.store(metadata, TrackMetaWord.HISTORY_CURSOR, slot + 1);
      Atomics.store(metadata, TrackMetaWord.HISTORY_LENGTH, slot + 1);
      port.onmessage?.({ data: {
        type: 'TAKE_COMMITTED', track: 0, takeSlot: slot, mode: 0,
        frameCount: frames, historyCursor: slot + 1, historyLength: slot + 1,
      } } as MessageEvent);
    };
    const aLeft = Float32Array.of(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8);
    const aRight = Float32Array.from(aLeft, (sample) => -sample);
    await runtime.beginTake(0, 'BASE');
    runtime.getTrackSamples(0, 0)!.set(aLeft);
    runtime.getTrackSamples(0, 1)!.set(aRight);
    commit(0, aLeft.length);

    await runtime.beginTake(0, 'BASE');
    const bBuffer = attachedTakeBuffers.get(1);
    expect(bBuffer).toBeInstanceOf(SharedArrayBuffer);
    const bLeftStorage = new Float32Array(bBuffer!, TRACK_META_BYTES, BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
    const bRightStorage = new Float32Array(
      bBuffer!,
      TRACK_META_BYTES + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
      BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
    );
    const bLeft = Float32Array.of(0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6);
    const bRight = Float32Array.from(bLeft, (sample) => -sample);
    bLeftStorage.set(bLeft);
    bRightStorage.set(bRight);
    commit(1, bLeft.length);

    const createContext = () => ({
      sampleRate: 48_000,
      createBuffer(channelCount: number, length: number, sampleRate: number) {
        const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
        return {
          numberOfChannels: channelCount, length, sampleRate,
          getChannelData(channel: number) { return channels[channel]!; },
        };
      },
    }) as unknown as AudioContext;

    // The Worklet's undo/redo operation changes this cursor. The visible
    // LOOP_FRAMES header remains B's length, so the export must trust the
    // immutable per-take commit notification for A's original length.
    Atomics.store(metadata, TrackMetaWord.HISTORY_CURSOR, 1);
    const undo = await runtime.exportTrack(0, createContext());
    expect(undo.length).toBe(8);
    expect(Array.from(undo.getChannelData(0))).toEqual(Array.from(aLeft));
    expect(Array.from(undo.getChannelData(1))).toEqual(Array.from(aRight));

    Atomics.store(metadata, TrackMetaWord.HISTORY_CURSOR, 2);
    const redo = await runtime.exportTrack(0, createContext());
    expect(redo.length).toBe(16);
    expect(Array.from(redo.getChannelData(0))).toEqual(Array.from(bLeft));
    expect(Array.from(redo.getChannelData(1))).toEqual(Array.from(bRight));
    runtime.dispose();
  });
});

describe('shared Worklet filter wet/dry transitions', () => {
  it('stages complete PREAMP selectors and Vinyl across all five stereo routes before the warmup fade', async () => {
    const moduleBytes = readSharedDspWasmBytes();
    const wasmModule = await WebAssembly.compile(moduleBytes);
    const controlBuffer = createControlSharedBuffer();
    const { processor, scope } = createHarness(controlBuffer, true, wasmModule);
    expect(processor.port.messages.at(-1)).toMatchObject({ type: 'SHARED_DSP_READY', abiVersion: 2 });
    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      const { meta, left, right } = attach(processor, track, 256);
      left.fill(0.08 * (track + 1));
      right.fill(-0.05 * (track + 1));
      seedBaseHistory(processor, track, meta, left, right, 256);
    }
    const quantumFrames = 64;
    let blockStart = 0;
    const renderInputs = (frames = quantumFrames) => {
      const inputs = Array.from({ length: BROWSER_REALTIME_TRACK_COUNT + 1 }, () => [] as Float32Array[]);
      for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame += 1) {
          const absolute = blockStart + frame;
          left[frame] = 0.1 * (track + 1) + 0.04 * Math.sin(2 * Math.PI * (173 + track * 19) * absolute / 48_000);
          right[frame] = -0.08 * (track + 1) + 0.03 * Math.sin(2 * Math.PI * (601 + track * 37) * absolute / 48_000);
        }
        inputs[track + 1] = [left, right];
      }
      scope.currentFrame = blockStart;
      const rendered = outputs(frames);
      processor.process(inputs, rendered);
      if (blockStart === 0) {
        expect(rendered[0]![0]![frames - 1]).toBeCloseTo(0.08, 6);
        expect(rendered[0]![1]![frames - 1]).toBeCloseTo(-0.05, 6);
      }
      blockStart += frames;
      return rendered;
    };
    for (let block = 0; block < 75; block += 1) renderInputs();

    const preamp = () => ({ ordinal: 23, parameters: [
      { id: 48, value: 1 }, { id: 3, value: 1 },
      { id: 82, value: 8 }, { id: 83, value: 8 }, { id: 84, value: 3 },
      { id: 85, value: 1 }, { id: 86, value: 5 },
    ] });
    const vinyl = () => ({ ordinal: 53, parameters: [
      { id: 48, value: 1 }, { id: 21, value: 1 }, { id: 55, value: 0.35 },
    ] });
    processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_STAGE', requestId: 31, plan: {
      input: [],
      track: [preamp(), vinyl()],
      output: [],
    } });
    const stagedReply = [...processor.port.messages].reverse().find((message) =>
      message.type === 'SHARED_DSP_FX_BANK_STAGED')!;
    if (!stagedReply.ok) throw new Error(JSON.stringify(stagedReply));
    expect(stagedReply).toMatchObject({ ok: true, handleCount: 10 });
    const dsp = processor.sharedDsp!;
    const candidate = dsp.fxStaged!;
    const candidateKeys = Reflect.ownKeys(candidate).sort();
    const candidateRouteKeys = [
      ...candidate.inputRoutes,
      candidate.inputMonitorRoute,
      ...candidate.trackRoutes,
    ].map((route) => Reflect.ownKeys(route).sort());
    expect(candidateKeys).toEqual(expect.arrayContaining([
      'stageId', 'handles', 'inputRoutes', 'inputMonitorRoute', 'trackRoutes',
      'warmupFrames', 'warmedFrames', 'failed',
    ]));
    expect(candidate.inputRoutes.map((route) => route.warmupFrames)).toEqual(Array(5).fill(0));
    expect(candidate.trackRoutes).toHaveLength(5);
    expect(candidate.trackRoutes.every((route) => route.handles.length === 2)).toBe(true);
    const startupFramesByRoute = candidate.trackRoutes.map((route) => route.handles.reduce((sum, handle) =>
      sum + dsp.wasm.webrc_dsp_fx_startup_warmup_frames!(handle), 0));
    const fixedFramesByRoute = candidate.trackRoutes.map((route) => route.handles.reduce((sum, handle) =>
      sum + dsp.wasm.webrc_dsp_fx_fixed_latency_samples!(handle), 0));
    expect(startupFramesByRoute).toEqual(Array(5).fill(Number(stagedReply.warmupFrames)));
    expect(candidate.trackRoutes.map((route) => route.warmupFrames)).toEqual(startupFramesByRoute);
    expect(candidate.warmupFrames).toBe(Math.max(...startupFramesByRoute));
    expect(candidate.trackRoutes.map((route) =>
      dsp.wasm.webrc_dsp_fx_fixed_latency_samples!(route.handles[1]!))).toEqual(Array(5).fill(960));
    expect(fixedFramesByRoute.every((frames) => frames >= 960)).toBe(true);
    expect(startupFramesByRoute[0]).toBeGreaterThan(192_076);
    expect(dsp.fxInputRoutes?.every((route) => route.historyCount === 4_800)).toBe(true);
    expect(dsp.fxTrackRoutes?.every((route) => route.historyCount === 4_800)).toBe(true);

    const bytesBeforeCommit = dsp.wasm.webrc_dsp_managed_memory_bytes!();
    processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_COMMIT', requestId: 32, stageId: candidate.stageId });
    expect([...processor.port.messages].reverse().find((message) =>
      message.type === 'SHARED_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: true, warming: true });
    expect(dsp.fxTrackRoutes?.every((route) => route.handles.length === 0)).toBe(true);
    expect(dsp.fxInputRoutes?.every((route) => route.historyCount === 4_800)).toBe(true);
    expect(dsp.fxTrackRoutes?.every((route) => route.historyCount === 4_800)).toBe(true);
    expect(dsp.fxTransitionFrames).toBe(480);
    expect(dsp.fxTransitionElapsed).toBe(0);
    expect(dsp.fxWarming?.stageId).toBe(candidate.stageId);
    expect(dsp.fxWarming?.trackRoutes.map((route) => route.warmedFrames)).toEqual(Array(5).fill(0));
    expect(dsp.fxRetired).toBeNull();
    expect(dsp.wasm.webrc_dsp_managed_memory_bytes!()).toBe(bytesBeforeCommit);

    const startupFrames = Number(stagedReply.warmupFrames);
    while (dsp.fxWarming!.warmedFrames + quantumFrames < startupFrames) renderInputs();
    const remainingWarmupFrames = startupFrames - dsp.fxWarming!.warmedFrames;
    expect(remainingWarmupFrames).toBeGreaterThan(0);
    expect(remainingWarmupFrames).toBeLessThanOrEqual(quantumFrames);
    if (remainingWarmupFrames > 1) renderInputs(remainingWarmupFrames - 1);
    expect(dsp.fxWarming?.warmedFrames).toBe(startupFrames - 1);
    renderInputs(1); // Warmup ends on the exact final sample; fade starts on the next callback.
    expect(dsp.fxWarming).toBeNull();
    expect(dsp.fxRetired?.stageId).toBe(candidate.stageId);
    expect(Reflect.ownKeys(candidate).sort()).toEqual(candidateKeys);
    expect([
      ...candidate.inputRoutes,
      candidate.inputMonitorRoute,
      ...candidate.trackRoutes,
    ].map((route) => Reflect.ownKeys(route).sort())).toEqual(candidateRouteKeys);
    expect(dsp.fxTransitionElapsed).toBe(0);
    expect(dsp.fxTrackRoutes?.every((route) => route.handles.length === 2)).toBe(true);
    let finalOutput: Float32Array[][] = [];
    for (let block = 0; block < 8; block += 1) finalOutput = renderInputs();
    expect(dsp.fxTransitionElapsed).toBe(480);
    expect(dsp.fxTrackRoutes?.every((route) => route.handles.length === 2)).toBe(true);
    expect(finalOutput[0]?.[0]?.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);
    expect(finalOutput[0]?.[1]?.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);
    expect(finalOutput[0]?.[0]?.some((sample, index) =>
      Math.abs(sample - finalOutput[0]![1]![index]!) > 1e-6)).toBe(true);
    processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_FINALIZE', requestId: 33, stageId: candidate.stageId });
    expect([...processor.port.messages].reverse().find((message) =>
      message.type === 'SHARED_DSP_FX_BANK_FINALIZED')).toMatchObject({ ok: true });
    processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_FINALIZE', requestId: 35, stageId: candidate.stageId });
    expect([...processor.port.messages].reverse().find((message) =>
      message.type === 'SHARED_DSP_FX_BANK_FINALIZED')).toMatchObject({ ok: true, idempotent: true });

    const stableHandles = dsp.fxActiveHandles!.slice();
    const stableBytes = dsp.wasm.webrc_dsp_managed_memory_bytes!();
    processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_STAGE', requestId: 34, plan: {
      input: [], track: [{ ordinal: 53, parameters: [{ id: 999, value: 1 }] }], output: [],
    } });
    expect([...processor.port.messages].reverse().find((message) =>
      message.type === 'SHARED_DSP_FX_BANK_STAGED')).toMatchObject({ ok: false });
    expect(dsp.fxActiveHandles).toEqual(stableHandles);
    expect(dsp.wasm.webrc_dsp_managed_memory_bytes!()).toBe(stableBytes);
  }, 120_000);

  it('fans one sample-offset MIDI span to five independent stereo track processors', async () => {
    const module = await WebAssembly.compile(readSharedDspWasmBytes());
    const makeMidiTrackHarness = () => createHarness(createControlSharedBuffer(), true, module);
    const tested = makeMidiTrackHarness();
    const control = makeMidiTrackHarness();
    const midiInstrument = { ordinal: 21, parameters: [{ id: 48, value: 1 }, { id: 3, value: 1 }] };

    const prime = (harness: ReturnType<typeof createHarness>) => {
      const { processor, scope } = harness;
      // Seed five distinct real stereo loop sources, then let the actual
      // Worklet callback render them so stopped-bank warmup has valid history.
      for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
        const { meta, left, right } = attach(processor, track, 4_800);
        for (let frame = 0; frame < 4_800; frame += 1) {
          left[frame] = 0.08 * (track + 1) + 0.03 * Math.sin(2 * Math.PI * (171 + track * 17) * frame / 48_000);
          right[frame] = -0.06 * (track + 1) + 0.02 * Math.sin(2 * Math.PI * (619 + track * 23) * frame / 48_000);
        }
        seedBaseHistory(processor, track, meta, left, right, 4_800);
      }
      const silence = new Float32Array(64);
      for (let block = 0; block < 75; block += 1) {
        const blockStart = block * 64;
        processBlock(processor, scope, blockStart, silence, silence);
      }
      processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_STAGE', requestId: 701, plan: {
        input: [], track: [midiInstrument], output: [],
      } });
      const stage = [...processor.port.messages].reverse().find((message) =>
        message.type === 'SHARED_DSP_FX_BANK_STAGED');
      expect(stage).toMatchObject({ ok: true, handleCount: BROWSER_REALTIME_TRACK_COUNT });
      processor.handlePortMessage({ type: 'SHARED_DSP_FX_BANK_COMMIT', requestId: 702,
        stageId: stage!.stageId, allowHistoryWarmup: true });
      expect([...processor.port.messages].reverse().find((message) =>
        message.type === 'SHARED_DSP_FX_BANK_COMMITTED')).toMatchObject({ ok: true });
      expect(processor.sharedDsp!.fxTrackRoutes!.map((route) => route.handles.length))
        .toEqual(Array(BROWSER_REALTIME_TRACK_COUNT).fill(1));
    };
    prime(tested);
    prime(control);

    const writer = new BrowserFxMidiQueueWriter(tested.fxMidiBuffer!);
    const eventStartFrame = 4_800;
    expect(writer.enqueue({ type: 'NoteOn', channel: 0, note: 67, velocity: 118, timestampMs: 0 }, eventStartFrame + 17)).toBe(true);
    expect(writer.enqueue({ type: 'NoteOff', channel: 0, note: 67, velocity: 0, timestampMs: 1 }, eventStartFrame + 200)).toBe(true);
    const testedCapture = outputs(256);
    const controlCapture = outputs(256);
    const silence = new Float32Array(64);
    for (let block = 0; block < 4; block += 1) {
      const blockStart = eventStartFrame + block * 64;
      const testedBlock = processBlock(tested.processor, tested.scope, blockStart, silence, silence);
      const controlBlock = processBlock(control.processor, control.scope, blockStart, silence, silence);
      expect(tested.processor.sharedDsp!.fxCurrentMidiEventCount).toBe(block === 0 ? 1 : block === 3 ? 1 : 0);
      for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
        testedCapture[track]![0]!.set(testedBlock[track]![0]!, block * 64);
        testedCapture[track]![1]!.set(testedBlock[track]![1]!, block * 64);
        controlCapture[track]![0]!.set(controlBlock[track]![0]!, block * 64);
        controlCapture[track]![1]!.set(controlBlock[track]![1]!, block * 64);
      }
    }
    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      for (let frame = 0; frame < 17; frame += 1) {
        expect(testedCapture[track]![0]![frame]).toBe(controlCapture[track]![0]![frame]);
        expect(testedCapture[track]![1]![frame]).toBe(controlCapture[track]![1]![frame]);
      }
      expect(testedCapture[track]![0]!.slice(17).some((sample, index) =>
        Math.abs(sample - controlCapture[track]![0]![index + 17]!) > 1e-7)).toBe(true);
      expect(testedCapture[track]![1]!.slice(17).some((sample, index) =>
        Math.abs(sample - controlCapture[track]![1]![index + 17]!) > 1e-7)).toBe(true);
    }
  }, 120_000);

  it('ramps enable and clear across actual blocks while preserving independent stereo', () => {
    const { processor } = createHarness();
    const maxBlockFrames = 64;
    const scratchInput = new Float32Array(maxBlockFrames);
    const scratchOutput = new Float32Array(maxBlockFrames);
    const outputStageLeft = new Float32Array(maxBlockFrames);
    const outputStageRight = new Float32Array(maxBlockFrames);
    let resetCalls = 0;
    processor.sharedDsp = {
      maxBlockFrames,
      scratchAddress: 0,
      scratchInput,
      scratchOutput,
      outputStageLeft,
      outputStageRight,
      wasm: {
        webrc_dsp_process(handle) {
          const gain = handle === 1 ? 0.25 : 0.75;
          for (let index = 0; index < maxBlockFrames; index += 1) scratchOutput[index] = scratchInput[index] * gain;
          return 0;
        },
        webrc_dsp_reset() { resetCalls += 1; return 0; },
      },
    };
    const route: SharedDspTestRoute = {
      left: 1, right: 2, enabled: true, wetGain: 0, wetTarget: 0,
      wetStep: 0, wetRampRemaining: 0, pendingReset: false, values: new Float32Array(4),
    };
    const inputLeft = new Float32Array(maxBlockFrames).fill(0.75);
    const inputRight = new Float32Array(maxBlockFrames).fill(-0.25);
    const outputLeft = new Float32Array(maxBlockFrames);
    const outputRight = new Float32Array(maxBlockFrames);
    let previousLeft: number | null = null;
    let previousRight: number | null = null;
    let largestEnableStep = 0;

    processor.setSharedDspWetTarget(route, 1);
    for (let block = 0; block < 8; block += 1) {
      expect(processor.processSharedDspStereo(route, inputLeft, inputRight, outputLeft, outputRight, maxBlockFrames)).toBe(true);
      for (let frame = 0; frame < maxBlockFrames; frame += 1) {
        if (previousLeft !== null) largestEnableStep = Math.max(largestEnableStep, Math.abs(outputLeft[frame]! - previousLeft));
        if (previousRight !== null) largestEnableStep = Math.max(largestEnableStep, Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
    }
    expect(route.wetGain).toBe(1);
    expect(outputLeft[maxBlockFrames - 1]).toBeCloseTo(0.1875, 6);
    expect(outputRight[maxBlockFrames - 1]).toBeCloseTo(-0.1875, 6);
    expect(largestEnableStep).toBeLessThan(0.002);

    route.pendingReset = true;
    let largestClearStep = 0;
    processor.setSharedDspWetTarget(route, 0);
    for (let block = 0; block < 8; block += 1) {
      expect(processor.processSharedDspStereo(route, inputLeft, inputRight, outputLeft, outputRight, maxBlockFrames)).toBe(true);
      for (let frame = 0; frame < maxBlockFrames; frame += 1) {
        if (previousLeft !== null) largestClearStep = Math.max(largestClearStep, Math.abs(outputLeft[frame]! - previousLeft));
        if (previousRight !== null) largestClearStep = Math.max(largestClearStep, Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
    }
    expect(route.enabled).toBe(false);
    expect(route.wetGain).toBe(0);
    expect(resetCalls).toBe(2);
    expect(outputLeft[maxBlockFrames - 1]).toBeCloseTo(0.75, 6);
    expect(outputRight[maxBlockFrames - 1]).toBeCloseTo(-0.25, 6);
    expect(largestClearStep).toBeLessThan(0.002);
  });

  it('crossfades retired FX routes to a new or empty route without an old→dry→new jump', () => {
    const { processor } = createHarness();
    const maxFrames = 64;
    const scratch = Array.from({ length: 4 }, () => new Float32Array(maxFrames));
    const transitionSourceLeft = new Float32Array(maxFrames);
    const transitionSourceRight = new Float32Array(maxFrames);
    const transitionOldLeft = new Float32Array(maxFrames);
    const transitionOldRight = new Float32Array(maxFrames);
    const addresses = [100, 200, 300, 400];
    const arraysByAddress = new Map(addresses.map((address, index) => [address, scratch[index]!]));
    const sharedDsp = {
      maxBlockFrames: maxFrames,
      disposed: false,
      fxScratchLeftA: scratch[0]!, fxScratchRightA: scratch[1]!,
      fxScratchLeftB: scratch[2]!, fxScratchRightB: scratch[3]!,
      fxScratchLeftAAddress: addresses[0]!, fxScratchRightAAddress: addresses[1]!,
      fxScratchLeftBAddress: addresses[2]!, fxScratchRightBAddress: addresses[3]!,
      fxTransitionSourceLeft: transitionSourceLeft, fxTransitionSourceRight: transitionSourceRight,
      fxTransitionOldLeft: transitionOldLeft, fxTransitionOldRight: transitionOldRight,
      fxTransitionFrames: 480, fxTransitionElapsed: 0,
      fxRetired: {}, failureCounts: new Uint32Array(6),
      wasm: {
        webrc_dsp_fx_process_stereo(handle: number, sourceLeftAddress: number, sourceRightAddress: number,
          destinationLeftAddress: number, destinationRightAddress: number, frames: number) {
          const gain = handle === 1 ? 0.25 : 0.75;
          const sourceLeft = arraysByAddress.get(sourceLeftAddress)!;
          const sourceRight = arraysByAddress.get(sourceRightAddress)!;
          const destinationLeft = arraysByAddress.get(destinationLeftAddress)!;
          const destinationRight = arraysByAddress.get(destinationRightAddress)!;
          for (let frame = 0; frame < frames; frame += 1) {
            destinationLeft[frame] = sourceLeft[frame]! * gain;
            destinationRight[frame] = sourceRight[frame]! * gain;
          }
          return 0;
        },
      },
    };
    processor.sharedDsp = sharedDsp as unknown as NonNullable<WorkletTestProcessor['sharedDsp']>;

    const oldRoute = { handles: [1], wetGain: 1, wetTarget: 1, wetStep: 0, wetRampRemaining: 0 };
    const newRoute = { handles: [2], wetGain: 1, wetTarget: 1, wetStep: 0, wetRampRemaining: 0 };
    const sourceLeft = new Float32Array(maxFrames).fill(0.5);
    const sourceRight = new Float32Array(maxFrames).fill(-0.25);
    const outputLeft = new Float32Array(maxFrames);
    const outputRight = new Float32Array(maxFrames);
    let previousLeft = 0.125;
    let previousRight = -0.0625;
    let largestReplaceStep = 0;
    for (let block = 0; block < 8; block += 1) {
      processor.processSharedDspFxChain(newRoute, sourceLeft, sourceRight, outputLeft, outputRight, maxFrames, oldRoute);
      for (let frame = 0; frame < maxFrames; frame += 1) {
        largestReplaceStep = Math.max(largestReplaceStep, Math.abs(outputLeft[frame]! - previousLeft),
          Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
      sharedDsp.fxTransitionElapsed += maxFrames;
    }
    expect(outputLeft[63]).toBeCloseTo(0.375, 6);
    expect(outputRight[63]).toBeCloseTo(-0.1875, 6);
    expect(largestReplaceStep).toBeLessThan(0.001);

    sharedDsp.fxTransitionElapsed = 0;
    sharedDsp.fxTransitionFrames = 480;
    previousLeft = 0.125;
    previousRight = -0.0625;
    let largestClearStep = 0;
    const emptyRoute = { handles: [], wetGain: 0, wetTarget: 0, wetStep: 0, wetRampRemaining: 0 };
    for (let block = 0; block < 8; block += 1) {
      processor.processSharedDspFxChain(emptyRoute, sourceLeft, sourceRight, outputLeft, outputRight, maxFrames, oldRoute);
      for (let frame = 0; frame < maxFrames; frame += 1) {
        largestClearStep = Math.max(largestClearStep, Math.abs(outputLeft[frame]! - previousLeft),
          Math.abs(outputRight[frame]! - previousRight));
        previousLeft = outputLeft[frame]!;
        previousRight = outputRight[frame]!;
      }
      sharedDsp.fxTransitionElapsed += maxFrames;
    }
    expect(outputLeft[63]).toBeCloseTo(0.5, 6);
    expect(outputRight[63]).toBeCloseTo(-0.25, 6);
    expect(largestClearStep).toBeLessThan(0.001);
  });
});
