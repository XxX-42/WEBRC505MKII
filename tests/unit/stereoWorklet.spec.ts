import { describe, expect, it } from 'vitest';
import { evaluateRealtimeWorklet } from '../helpers/evaluateRealtimeWorklet';
import { BrowserRealtimeRuntime } from '../../src/audio/BrowserRealtimeRuntime';
import {
  BROWSER_REALTIME_LAYOUT_MONO,
  BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  BROWSER_REALTIME_LAYOUT_VERSION,
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BROWSER_REALTIME_STORAGE_BATCH_BLOCKS,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
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
  takeIndex(track: number, slot: number): number;
  takeModes: Int8Array;
  takeFrames: Int32Array;
  takeActive: Uint8Array;
  takeMeta: Array<Array<Int32Array | null>>;
  commitTake(track: number, slot: number, frames: number): void;
  playPositions: Float64Array;
  playbackFrames: Float64Array;
};

function createHarness(controlBuffer = createControlSharedBuffer(), perTrackInputs = false) {
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
    sampleRate: 48_000,
    currentFrame: 0,
  };
  evaluateRealtimeWorklet(scope);
  if (!RegisteredProcessor) throw new Error('The real Worklet source did not register a processor.');
  const processor = new RegisteredProcessor({ processorOptions: { controlBuffer, perTrackInputs } }) as WorkletTestProcessor;
  return { processor, scope, controlBuffer };
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
