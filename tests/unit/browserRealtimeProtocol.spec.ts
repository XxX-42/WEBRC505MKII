import { describe, expect, it, vi } from 'vitest';
import { evaluateRealtimeWorklet } from '../helpers/evaluateRealtimeWorklet';
import { BrowserRealtimeRuntime } from '../../src/audio/BrowserRealtimeRuntime';
import {
  BROWSER_REALTIME_COMMAND_CAPACITY,
  BROWSER_REALTIME_COMMAND_WORDS,
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  ControlWord,
  CONTROL_BUFFER_BYTE_LENGTH,
  CONTROL_COMMANDS_BYTE_OFFSET,
  CONTROL_COMMANDS_WORD_OFFSET,
  CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
  CONTROL_TRACK_STATES_BYTE_OFFSET,
  TRACK_META_BYTES,
  TrackMetaWord,
  createControlSharedBuffer,
  createTakeSegmentBuffer,
  createTrackSharedBuffer,
  BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  BROWSER_REALTIME_LAYOUT_VERSION,
  BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
  frameFromWords,
  frameToWords,
  loadSharedFrame,
  queueSharedCommand,
  storeSharedFrame,
} from '../../src/audio/browserRealtimeProtocol';

type WorkletPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  messages: Array<Record<string, unknown>>;
  postMessage: (message: Record<string, unknown>) => void;
};

class WorkletHarnessBase {
  public port: WorkletPort = {
    onmessage: null,
    messages: [],
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

type WorkletTestProcessor = WorkletHarnessBase & {
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
  controlPositions: Float32Array;
  clockRunning: boolean;
  clockOriginFrame: number;
  clockBeatOrdinal: number;
  clockNextBeatFrame: number;
  bpm: number;
  renderClockTick(frame: number): void;
};

function createProcessor(controlBuffer = createControlSharedBuffer()) {
  let RegisteredProcessor: (new (options: unknown) => WorkletHarnessBase) | null = null;
  const scope: Record<string, unknown> = {
    AudioWorkletProcessor: WorkletHarnessBase,
    registerProcessor: (_name: string, processor: new (options: unknown) => WorkletHarnessBase) => {
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
  if (!RegisteredProcessor) throw new Error('The real worklet source did not register a processor.');
  const processor = new RegisteredProcessor({ processorOptions: { controlBuffer } });
  return { processor: processor as WorkletTestProcessor, scope, controlBuffer };
}

function makeOutputs(frames: number): Float32Array[][] {
  return Array.from({ length: 7 }, () => [new Float32Array(frames), new Float32Array(frames)]);
}

function processBlock(
  processor: WorkletTestProcessor,
  scope: Record<string, unknown>,
  frame: number,
  input: Float32Array,
  outputs = makeOutputs(input.length),
) {
  scope.currentFrame = frame;
  processor.process([[input]], outputs);
  return outputs;
}

function attachTrack(processor: WorkletTestProcessor, track: number, capacity = 256) {
  const allocatedCapacity = BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
  const buffer = createTrackSharedBuffer(allocatedCapacity);
  const meta = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
  const samples = new Float32Array(buffer, TRACK_META_BYTES, allocatedCapacity).subarray(0, capacity);
  const samplesRight = new Float32Array(buffer, TRACK_META_BYTES + allocatedCapacity * Float32Array.BYTES_PER_ELEMENT, allocatedCapacity).subarray(0, capacity);
  processor.handlePortMessage({
    type: 'ATTACH_TRACK', track, buffer,
    channelCount: BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
    layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
    storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  });
  processor.handlePortMessage({ type: 'PREPARE_TAKE', track, takeSlot: 0, mode: 'BASE', usePrimary: true });
  expect(processor.port.messages.at(-1)).toMatchObject({ type: 'TAKE_PREPARED', track, takeSlot: 0 });
  return { buffer, meta, samples, samplesRight };
}

function seedBaseHistory(
  processor: WorkletTestProcessor,
  track: number,
  meta: Int32Array,
  frames: number,
  position = 0,
  reverse = 0,
) {
  const slot = processor.takeIndex(track, 0) as number;
  processor.takeModes[slot] = 0;
  processor.takeFrames[slot] = frames;
  processor.takeActive[slot] = 1;
  processor.takeMeta[track][0] = meta;
  processor.commitTake(track, 0, frames);
  Atomics.store(meta, TrackMetaWord.STATE, 4);
  Atomics.store(meta, TrackMetaWord.PLAY_POSITION, position);
  Atomics.store(meta, TrackMetaWord.REVERSE, reverse);
  processor.playPositions[track] = position;
  processor.playbackFrames[track] = 0;
}

function attachTakeSegment(processor: WorkletTestProcessor, track: number, takeSlot: number) {
  const buffer = createTakeSegmentBuffer(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
  processor.handlePortMessage({ type: 'ATTACH_TAKE_SEGMENT', track, takeSlot, segmentIndex: 0, buffer });
  expect(processor.port.messages.at(-1)).toMatchObject({ type: 'TAKE_SEGMENT_ATTACHED', track, takeSlot, segmentIndex: 0 });
  return new Float32Array(buffer, TRACK_META_BYTES, BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
}

describe('browser real-time shared protocol', () => {
  it('keeps header, command ring, track states, and Float32 positions disjoint', () => {
    expect(CONTROL_COMMANDS_BYTE_OFFSET).toBe(96);
    expect(ControlWord.INPUT_DROPOUT_BLOCKS).toBeLessThan(CONTROL_COMMANDS_WORD_OFFSET);
    expect(CONTROL_COMMANDS_BYTE_OFFSET + BROWSER_REALTIME_COMMAND_CAPACITY * BROWSER_REALTIME_COMMAND_WORDS * 4)
      .toBe(CONTROL_TRACK_STATES_BYTE_OFFSET);
    expect(CONTROL_TRACK_STATES_BYTE_OFFSET + 5 * Int32Array.BYTES_PER_ELEMENT)
      .toBe(CONTROL_TRACK_POSITIONS_BYTE_OFFSET);
    expect(CONTROL_TRACK_POSITIONS_BYTE_OFFSET + 5 * Float32Array.BYTES_PER_ELEMENT)
      .toBe(CONTROL_BUFFER_BYTE_LENGTH);

    const buffer = createControlSharedBuffer();
    const position = new Float32Array(buffer, CONTROL_TRACK_POSITIONS_BYTE_OFFSET, 5);
    position[2] = 0.375;
    expect(position[2]).toBeCloseTo(0.375);
    expect(new Int32Array(buffer, CONTROL_TRACK_STATES_BYTE_OFFSET, 5)[2]).toBe(0);
  });

  it('round-trips and queues absolute target frames above 32-bit range', () => {
    const targetFrame = 9 * 0x1_0000_0000 + 17_123;
    expect(frameFromWords(...frameToWords(targetFrame))).toBe(targetFrame);

    const control = new Int32Array(createControlSharedBuffer());
    expect(queueSharedCommand(control, {
      sequence: 1,
      opcode: BrowserRealtimeOpcode.PLAY,
      track: 4,
      targetFrame,
    })).toBe(true);
    const low = Atomics.load(control, CONTROL_COMMANDS_WORD_OFFSET + 3);
    const high = Atomics.load(control, CONTROL_COMMANDS_WORD_OFFSET + 4);
    expect(frameFromWords(low, high)).toBe(targetFrame);
  });

  it('does not add trigger lookahead to the most recently completed render frame', () => {
    const buffer = createControlSharedBuffer();
    const control = new Int32Array(buffer);
    storeSharedFrame(control, ControlWord.RENDER_FRAME_SEQUENCE, ControlWord.RENDER_FRAME_LOW, ControlWord.RENDER_FRAME_HIGH, 8_192);
    const port = { onmessage: null, onmessageerror: null, postMessage: vi.fn() };
    const runtime = new BrowserRealtimeRuntime({ port } as unknown as AudioWorkletNode, buffer, 48_000);

    expect(runtime.getImmediateTargetFrame()).toBe(8_192);
    expect(runtime.getSafeTargetFrame()).toBe(8_192);
    expect(runtime.getSafeTargetFrame() - loadSharedFrame(
      control,
      ControlWord.RENDER_FRAME_SEQUENCE,
      ControlWord.RENDER_FRAME_LOW,
      ControlWord.RENDER_FRAME_HIGH,
    )).toBeLessThanOrEqual(BROWSER_REALTIME_QUANTUM_FRAMES);
    runtime.dispose();
  });

  it('keeps a future quantized command pending beyond the old two-second timeout', async () => {
    vi.useFakeTimers();
    try {
      const buffer = createControlSharedBuffer();
      const port = { onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null, postMessage: vi.fn() };
      const runtime = new BrowserRealtimeRuntime({ port } as unknown as AudioWorkletNode, buffer, 48_000);
      const targetFrame = 48_000 * 20;
      let result: string | null = null;
      let acknowledgement: Awaited<ReturnType<typeof runtime.enqueue>> | null = null;
      const queued = runtime.enqueue(BrowserRealtimeOpcode.START_RECORD, 0, 0, 0, targetFrame)
        .then((ack) => { acknowledgement = ack; result = 'acknowledged'; }, () => { result = 'rejected'; });

      await vi.advanceTimersByTimeAsync(21_500);
      expect(result).toBeNull();
      port.onmessage?.({ data: {
        type: 'ACK',
        sequence: 1,
        opcode: BrowserRealtimeOpcode.START_RECORD,
        track: 0,
        executedFrame: targetFrame,
        targetFrame,
        status: BrowserRealtimeStatus.OK,
        loopFrames: 0,
        recordingFrames: 1,
      } } as MessageEvent);
      await queued;
      expect(result).toBe('acknowledged');
      expect(acknowledgement).toMatchObject({
        intentFrame: 0,
        targetFrame,
        executedFrame: targetFrame,
        intentToScheduledMs: 20_000,
        scheduledToActualMs: 0,
      });
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a scheduled-action promise immediately when the worklet acknowledges cancellation', async () => {
    vi.useFakeTimers();
    try {
      const buffer = createControlSharedBuffer();
      const port = { onmessage: null as ((event: MessageEvent) => void) | null, onmessageerror: null, postMessage: vi.fn() };
      const runtime = new BrowserRealtimeRuntime({ port } as unknown as AudioWorkletNode, buffer, 48_000);
      const targetFrame = 48_000 * 30;
      let startStatus: number | null = null;
      const start = runtime.enqueue(BrowserRealtimeOpcode.START_RECORD, 2, 0, 0, targetFrame)
        .then((ack) => { startStatus = ack.status; });
      const cancel = runtime.enqueue(
        BrowserRealtimeOpcode.CANCEL_PENDING,
        2,
        0,
        0,
        runtime.getImmediateTargetFrame(),
      );

      port.onmessage?.({ data: {
        type: 'ACK', sequence: 1, opcode: BrowserRealtimeOpcode.START_RECORD, track: 2,
        executedFrame: 128, targetFrame, status: BrowserRealtimeStatus.CANCELLED, loopFrames: 0, recordingFrames: 0,
      } } as MessageEvent);
      port.onmessage?.({ data: {
        type: 'ACK', sequence: 2, opcode: BrowserRealtimeOpcode.CANCEL_PENDING, track: 2,
        executedFrame: 128, targetFrame: 0, status: BrowserRealtimeStatus.OK, loopFrames: 0, recordingFrames: 0,
      } } as MessageEvent);
      await Promise.all([start, cancel]);

      expect(startStatus).toBe(BrowserRealtimeStatus.CANCELLED);
      expect(vi.getTimerCount()).toBe(0);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('persistent AudioWorklet sample processing', () => {
  it('switches monitor passthrough at the requested sample inside a render quantum', () => {
    const { processor, scope, controlBuffer } = createProcessor();
    const control = new Int32Array(controlBuffer);
    queueSharedCommand(control, {
      sequence: 1,
      opcode: BrowserRealtimeOpcode.SET_MONITOR,
      track: -1,
      targetFrame: 3,
      arg0: 1,
    });

    const input = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const outputs = processBlock(processor, scope, 0, input);
    [0, 0, 0, 0.4, 0.5, 0.6, 0.7, 0.8].forEach((sample, index) => {
      expect(outputs[5]![0]![index]).toBeCloseTo(sample, 6);
    });
    const ack = processor.port.messages.find((message) => message.type === 'ACK');
    expect(ack).toMatchObject({ executedFrame: 3, targetFrame: 3, status: BrowserRealtimeStatus.OK });
  });

  it('acknowledges missing storage and invalid track indices without throwing in the processor', () => {
    const { processor, scope, controlBuffer } = createProcessor();
    const control = new Int32Array(controlBuffer);
    queueSharedCommand(control, {
      sequence: 1,
      opcode: BrowserRealtimeOpcode.PLAY,
      track: 0,
      targetFrame: 0,
    });
    queueSharedCommand(control, {
      sequence: 2,
      opcode: BrowserRealtimeOpcode.PLAY,
      track: 7,
      targetFrame: 0,
    });

    expect(() => processBlock(processor, scope, 0, new Float32Array(128))).not.toThrow();
    const acknowledgements = processor.port.messages.filter((message) => message.type === 'ACK');
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements[0]).toMatchObject({
      sequence: 1,
      track: 0,
      status: BrowserRealtimeStatus.MISSING_TRACK_STORAGE,
      loopFrames: 0,
      recordingFrames: 0,
    });
    expect(acknowledgements[1]).toMatchObject({
      sequence: 2,
      track: 7,
      status: BrowserRealtimeStatus.INVALID_TRACK,
      loopFrames: 0,
      recordingFrames: 0,
    });
  });

  it.each([
    { reverse: 0, expectedWrite: 3 },
    { reverse: 1, expectedWrite: 7 },
  ])('writes a delayed overdub impulse to the aligned $reverse playback location', ({ reverse, expectedWrite }) => {
    const { processor, scope, controlBuffer } = createProcessor();
    const { meta, samples } = attachTrack(processor, 0, 16);
    samples.set([1, 2, 3, 4, 5, 6, 7, 8]);
    seedBaseHistory(processor, 0, meta, 8, 5, reverse);
    Atomics.store(meta, TrackMetaWord.REVERSE, reverse);
    Atomics.store(meta, TrackMetaWord.ALIGNMENT_SAMPLES, 2);
    processor.handlePortMessage({ type: 'PREPARE_TAKE', track: 0, takeSlot: 1, mode: 'OVERDUB', usePrimary: false });
    expect(processor.port.messages.at(-1)).toMatchObject({ type: 'TAKE_PREPARED', track: 0, takeSlot: 1 });
    const overdub = attachTakeSegment(processor, 0, 1);
    queueSharedCommand(new Int32Array(controlBuffer), {
      sequence: 1, opcode: BrowserRealtimeOpcode.START_OVERDUB, track: 0, targetFrame: 32,
    });

    processBlock(processor, scope, 32, Float32Array.of(1));
    expect(overdub[expectedWrite]).toBe(1);
    expect(Atomics.load(meta, TrackMetaWord.PLAY_POSITION)).toBe(reverse ? 4 : 6);
  });

  it('cancels a future quantized start before it can enter RECORDING', () => {
    const { processor, scope, controlBuffer } = createProcessor();
    const { meta } = attachTrack(processor, 0, 256);
    const control = new Int32Array(controlBuffer);
    queueSharedCommand(control, {
      sequence: 1,
      opcode: BrowserRealtimeOpcode.START_RECORD,
      track: 0,
      targetFrame: 1_000,
    });
    queueSharedCommand(control, {
      sequence: 2,
      opcode: BrowserRealtimeOpcode.CANCEL_PENDING,
      track: 0,
      targetFrame: 0,
    });

    processBlock(processor, scope, 0, new Float32Array(128));
    for (let frame = 128; frame <= 1_024; frame += 128) {
      processBlock(processor, scope, frame, new Float32Array(128));
    }

    const cancelledStart = processor.port.messages.find((message) => message.sequence === 1);
    expect(cancelledStart).toMatchObject({ status: BrowserRealtimeStatus.CANCELLED, targetFrame: 1_000 });
    expect(Atomics.load(meta, TrackMetaWord.STATE)).toBe(0);
    expect(Atomics.load(meta, TrackMetaWord.RECORDING_FRAMES)).toBe(0);
  });

  it('records, stops, and plays five tracks against the same exact sample clock', () => {
    const { processor, scope, controlBuffer } = createProcessor();
    const control = new Int32Array(controlBuffer);
    const attached = Array.from({ length: 5 }, (_, track) => attachTrack(processor, track));

    for (let track = 0; track < 5; track += 1) {
      queueSharedCommand(control, {
        sequence: track + 1,
        opcode: BrowserRealtimeOpcode.START_RECORD,
        track,
        targetFrame: 0,
      });
    }
    processBlock(processor, scope, 0, Float32Array.from({ length: 128 }, (_, index) => (index + 1) / 128));

    for (let track = 0; track < 5; track += 1) {
      queueSharedCommand(control, {
        sequence: track + 6,
        opcode: BrowserRealtimeOpcode.STOP_RECORD,
        track,
        targetFrame: 128,
        arg0: 1,
      });
    }
    const outputs = processBlock(processor, scope, 128, new Float32Array(128));

    for (let track = 0; track < 5; track += 1) {
      expect(Atomics.load(attached[track]!.meta, TrackMetaWord.STATE)).toBe(4);
      expect(Atomics.load(attached[track]!.meta, TrackMetaWord.LOOP_FRAMES)).toBe(128);
      expect(Atomics.load(attached[track]!.meta, TrackMetaWord.RECORDING_FRAMES)).toBe(128);
      expect(outputs[track]![0]![0]).toBeCloseTo(1 / 128);
      expect(outputs[track]![0]![127]).toBeCloseTo(1);
    }
  });

  it('does not accumulate loop or beat drift over a long sample-clock run', () => {
    const { processor, scope } = createProcessor();
    const { meta, samples } = attachTrack(processor, 0, 256);
    samples.set(Float32Array.from({ length: 127 }, (_, index) => index));
    seedBaseHistory(processor, 0, meta, 127, 0);

    const outputs = makeOutputs(BROWSER_REALTIME_QUANTUM_FRAMES);
    const input = new Float32Array(BROWSER_REALTIME_QUANTUM_FRAMES);
    const blockCount = 8_192;
    for (let block = 0; block < blockCount; block += 1) {
      processBlock(processor, scope, block * BROWSER_REALTIME_QUANTUM_FRAMES, input, outputs);
    }
    expect(Atomics.load(meta, TrackMetaWord.PLAY_POSITION))
      .toBe((blockCount * BROWSER_REALTIME_QUANTUM_FRAMES) % 127);
    expect(processor.controlPositions[0]).toBeCloseTo(64 / 127, 6);

    const origin = 2 ** 32 + 96_000;
    processor.clockRunning = true;
    processor.clockOriginFrame = origin;
    processor.clockBeatOrdinal = 0;
    processor.clockNextBeatFrame = origin;
    processor.bpm = 119;
    const beatFrames: number[] = [];
    processor.port.messages.length = 0;
    for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
      const frame = processor.clockNextBeatFrame as number;
      processor.renderClockTick(frame);
      const tick = processor.port.messages.at(-1);
      beatFrames.push(tick!.frame as number);
    }
    const lastOrdinal = 9_999;
    expect(beatFrames[lastOrdinal]).toBe(origin + Math.round(lastOrdinal * 48_000 * 60 / 119));
    expect(beatFrames.at(-1)! - origin).toBe(Math.round(lastOrdinal * 48_000 * 60 / 119));
  }, 15_000);
});
