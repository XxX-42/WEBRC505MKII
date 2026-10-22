import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface PostedWorkletMessage {
  message: Record<string, any>;
  transferList: Transferable[];
}

class TestPort {
  onmessage: ((event: { data: any }) => void) | null = null;
  readonly posted: PostedWorkletMessage[] = [];

  postMessage(message: Record<string, any>, transferList: Transferable[] = []) {
    this.posted.push({ message: { ...message }, transferList });
  }

  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}

class TestAudioWorkletProcessor {
  readonly port = new TestPort();
  constructor(_options?: unknown) {}
}

interface WorkletInstance {
  port: TestPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type WorkletConstructor = new (options?: unknown) => WorkletInstance;

function loadProcessors() {
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/browser-track-io.js'), 'utf8');
  const registered = new Map<string, WorkletConstructor>();
  const context = createContext({
    currentFrame: 0,
    Float32Array,
    Uint32Array,
    AudioWorkletProcessor: TestAudioWorkletProcessor,
    registerProcessor: (name: string, processor: WorkletConstructor) => registered.set(name, processor),
  });
  runInContext(source, context);
  const worklets = new Map<string, WorkletConstructor>();
  // Each constructor is closed over the fake AudioWorkletProcessor from its source context.
  for (const [name, constructor] of registered) worklets.set(name, constructor);
  return { worklets, setCurrentFrame(frame: number) { context.currentFrame = frame; } };
}

function makePool(size: number, capacity: number) {
  return Array.from({ length: size }, (_, slotIndex) => ({
    slotIndex,
    indices: new Uint32Array(capacity),
    values: new Float32Array(capacity),
    oldValues: new Float32Array(capacity),
  }));
}

function initOverdub(processor: WorkletInstance, samples: number[], options: {
  capacity?: number;
  poolSize?: number;
  startFrame?: number;
  requestFrame?: number;
  startOffsetSamples?: number;
  latencySamples?: number;
  recordingOffsetSamples?: number;
  reverse?: boolean;
} = {}) {
  const capacity = options.capacity ?? 4;
  const poolSize = options.poolSize ?? 3;
  processor.port.receive({
    type: 'OVERDUB_INIT',
    samples: Float32Array.from(samples),
    buffers: makePool(poolSize, capacity),
    startFrame: options.startFrame ?? 0,
    ...(Number.isSafeInteger(options.requestFrame) ? { requestFrame: options.requestFrame } : {}),
    startOffsetSamples: options.startOffsetSamples ?? 0,
    latencySamples: options.latencySamples ?? 0,
    recordingOffsetSamples: options.recordingOffsetSamples ?? 0,
    reverse: options.reverse ?? false,
  });
}

describe('browser track I/O AudioWorklets', () => {
  it('overdubs in sample order with loop wrap, round-trip latency and user offset', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    expect(OverdubProcessor).toBeDefined();
    const processor = new OverdubProcessor!({ processorOptions: { transferBufferFrames: 4, transferBufferPoolSize: 3 } });
    initOverdub(processor, [10, 20, 30, 40, 50], {
      startFrame: 100,
      startOffsetSamples: 4,
      latencySamples: 1,
      recordingOffsetSamples: 1,
    });

    setCurrentFrame(100);
    const output = new Float32Array(3);
    processor.process([[Float32Array.from([1, 2, 3])]], [[output]]);

    expect([...output]).toEqual([50, 10, 20]);
    const patch = processor.port.posted[0]?.message;
    expect(patch).toMatchObject({ type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 3 });
    expect(Array.from(patch?.indices ?? [])).toEqual([2, 3, 4, 0]);
    expect(Array.from(patch?.values ?? [])).toEqual([31, 42, 53, 0]);
    expect(processor.port.posted[0]?.transferList).toHaveLength(3);
  });

  it('batches four 128-frame quanta but flushes a partial patch immediately at STOP', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 2048, transferBufferPoolSize: 3,
      batchPatchMessages: true, patchFlushFrames: 512,
    } });
    initOverdub(processor, new Array(1024).fill(0), { capacity: 2048, poolSize: 3 });

    for (let quantum = 0; quantum < 3; quantum += 1) {
      setCurrentFrame(quantum * 128);
      processor.process([[new Float32Array(128).fill(1)]], [[new Float32Array(128)]]);
    }
    expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_PATCH')).toHaveLength(0);

    setCurrentFrame(384);
    processor.process([[new Float32Array(128).fill(1)]], [[new Float32Array(128)]]);
    const first = processor.port.posted.find(({ message }) => message.type === 'OVERDUB_PATCH')?.message;
    expect(first).toMatchObject({ sequence: 0, patchFlushFrames: 512, startInputFrame: 0, endInputFrame: 512, validFrames: 512 });

    // Return the transferred storage so the next partial tail can be staged.
    processor.port.receive({ type: 'RECYCLE_OVERDUB_BUFFER', slotIndex: first?.slotIndex,
      indices: first?.indices, values: first?.values, oldValues: first?.oldValues });
    processor.port.receive({ type: 'OVERDUB_STOP', stopFrame: 530 });
    setCurrentFrame(512);
    processor.process([[new Float32Array(128).fill(1)]], [[new Float32Array(128)]]);

    const terminalMessages = processor.port.posted.slice(-2).map(({ message }) => message);
    expect(terminalMessages.map(({ type }) => type)).toEqual(['OVERDUB_PATCH', 'OVERDUB_STOPPED']);
    expect(terminalMessages[0]).toMatchObject({ sequence: 1, startInputFrame: 512, endInputFrame: 530, validFrames: 18 });
    expect(terminalMessages[1]).toMatchObject({ requestedStopFrame: 530, appliedExclusiveEnd: 530, patchesSent: 2, patchFlushFrames: 512 });
  });

  it('keeps variable AudioWorklet block tails ordered before opening another transfer slot', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 2048, transferBufferPoolSize: 3,
      batchPatchMessages: true, patchFlushFrames: 512,
    } });
    initOverdub(processor, new Array(2048).fill(0), { capacity: 2048, poolSize: 3 });

    setCurrentFrame(0);
    processor.process([[new Float32Array(768).fill(1)]], [[new Float32Array(768)]]);
    setCurrentFrame(768);
    processor.process([[new Float32Array(768).fill(1)]], [[new Float32Array(768)]]);

    const patches = processor.port.posted
      .filter(({ message }) => message.type === 'OVERDUB_PATCH')
      .map(({ message }) => message);
    expect(patches.map(({ sequence, startInputFrame, endInputFrame }) => ({
      sequence, startInputFrame, endInputFrame,
    }))).toEqual([
      { sequence: 0, startInputFrame: 0, endInputFrame: 512 },
      { sequence: 1, startInputFrame: 512, endInputFrame: 1024 },
      { sequence: 2, startInputFrame: 1024, endInputFrame: 1536 },
    ]);
  });

  it('flushes staged samples when STOP arrives after its exact requested frame', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 2048, transferBufferPoolSize: 3,
      batchPatchMessages: true, patchFlushFrames: 512,
    } });
    initOverdub(processor, new Array(1024).fill(0), { capacity: 2048, poolSize: 3 });

    setCurrentFrame(0);
    processor.process([[new Float32Array(128).fill(1)]], [[new Float32Array(128)]]);
    setCurrentFrame(128);
    processor.process([[new Float32Array(128).fill(1)]], [[new Float32Array(128)]]);
    expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_PATCH')).toHaveLength(0);

    processor.port.receive({ type: 'OVERDUB_STOP', stopFrame: 200 });
    setCurrentFrame(256);
    expect(processor.process([[new Float32Array(128).fill(1)]], [[new Float32Array(128)]])).toBe(false);
    const messages = processor.port.posted.slice(-2).map(({ message }) => message);
    expect(messages.map(({ type }) => type)).toEqual(['OVERDUB_PATCH', 'OVERDUB_STOPPED']);
    // The processor may flush a raw range that includes samples after S; the
    // host clips application to [R,S) and rolls back any already-applied tail.
    expect(messages[0]).toMatchObject({ startInputFrame: 0, endInputFrame: 256, validFrames: 256 });
    expect(messages[1]).toMatchObject({ requestedStopFrame: 200, appliedExclusiveEnd: 200, patchesSent: 1 });
  });

  it('uses reverse playback indices and wraps the latency/offset-compensated write positions', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: { transferBufferFrames: 4, transferBufferPoolSize: 3 } });
    initOverdub(processor, [10, 20, 30, 40], {
      startFrame: 40,
      startOffsetSamples: 0,
      latencySamples: 1,
      recordingOffsetSamples: 1,
      reverse: true,
    });

    setCurrentFrame(40);
    const output = new Float32Array(3);
    processor.process([[Float32Array.from([0.5, 1, -1])]], [[output]]);

    expect([...output]).toEqual([10.5, 41, 29]);
    const patch = processor.port.posted[0]?.message;
    expect(Array.from(patch?.indices ?? [])).toEqual([0, 3, 2, 0]);
    expect(Array.from(patch?.values ?? [])).toEqual([10.5, 41, 29, 0]);
  });

  it('stops cleanly and reports bounded patch-pool overflow without losing playback output', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: { transferBufferFrames: 2, transferBufferPoolSize: 1 } });
    initOverdub(processor, [10, 20, 30], { capacity: 2, poolSize: 1 });

    setCurrentFrame(0);
    const output = new Float32Array(3);
    processor.process([[Float32Array.from([1, 1, 1])]], [[output]]);
    processor.port.receive({ type: 'OVERDUB_STOP' });

    expect([...output]).toEqual([11, 21, 30]);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_PATCH']);
    const stoppedOutput = new Float32Array(3);
    expect(processor.process([[Float32Array.from([7, 8, 9])]], [[stoppedOutput]])).toBe(false);
    expect([...stoppedOutput]).toEqual([0, 0, 0]);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_PATCH', 'OVERDUB_STOPPED']);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      overflowFrames: 1,
      overflowEvents: 1,
      patchesSent: 1,
    });
    processor.port.receive({ type: 'OVERDUB_STOP' });
    expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_STOPPED')).toHaveLength(1);
  });

  it('stops overdub writes at the exclusive requested audio frame inside a render quantum', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: { transferBufferFrames: 8, transferBufferPoolSize: 2 } });
    initOverdub(processor, [10, 20, 30, 40], { capacity: 8, poolSize: 2, startFrame: 100 });

    processor.port.receive({ type: 'OVERDUB_STOP', stopFrame: 102 });
    setCurrentFrame(100);
    const output = new Float32Array(4);
    expect(processor.process([[Float32Array.from([1, 2, 3, 4])]], [[output]])).toBe(false);

    const patch = processor.port.posted.find(({ message }) => message.type === 'OVERDUB_PATCH')?.message;
    expect(patch).toMatchObject({ startInputFrame: 100, endInputFrame: 102, validFrames: 2 });
    expect(Array.from(patch?.indices ?? []).slice(0, 2)).toEqual([0, 1]);
    expect(Array.from(patch?.oldValues ?? []).slice(0, 2)).toEqual([10, 20]);
    expect(Array.from(patch?.values ?? []).slice(0, 2)).toEqual([11, 22]);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      type: 'OVERDUB_STOPPED', requestedStopFrame: 102, appliedExclusiveEnd: 102,
      processorStopFrame: 104, stopFrame: 104,
    });
    expect(Array.from(output)).toEqual([11, 22, 0, 0]);
  });

  it('acknowledges a delayed process callback without moving the applied exclusive stop boundary', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: { transferBufferFrames: 8, transferBufferPoolSize: 2 } });
    initOverdub(processor, [10, 20, 30, 40], { capacity: 8, poolSize: 2, startFrame: 100 });
    processor.port.receive({ type: 'OVERDUB_STOP', stopFrame: 102 });
    setCurrentFrame(104); // The worklet learns about STOP after the requested cutoff.

    const output = new Float32Array(4);
    expect(processor.process([[new Float32Array([1, 2, 3, 4])]], [[output]])).toBe(false);
    const ack = processor.port.posted.at(-1)?.message;
    expect(ack).toMatchObject({
      type: 'OVERDUB_STOPPED', requestedStopFrame: 102, appliedExclusiveEnd: 102,
      processorStopFrame: 108, stopFrame: 108,
    });
    expect(Array.from(output)).toEqual([0, 0, 0, 0]);
    expect(Array.from((processor as any).loopChannels[0])).toEqual([10, 20, 30, 40]);
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_PATCH')).toBe(false);
  });

  it('retires an invalid overdub processor instead of leaving an idle callback loop', () => {
    const { worklets } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: { transferBufferFrames: 4, transferBufferPoolSize: 1 } });
    expect(processor.process([[]], [[new Float32Array(4)]])).toBe(true);
    processor.port.receive({ type: 'OVERDUB_INIT', channels: [], channelCount: 0, buffers: [] });
    expect(processor.port.posted.at(-1)?.message).toMatchObject({ type: 'OVERDUB_ERROR' });
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_STOPPED')).toBe(false);
    expect(processor.process([[]], [[new Float32Array(4)]])).toBe(false);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_ERROR', 'OVERDUB_STOPPED']);
  });

  it('chronologically stages bounded stereo backfill before live input and emits one startup patch only after catch-up', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 20, transferBufferPoolSize: 2,
      startupBackfillFrames: 8, startupQueueFrames: 12, startupReplayFramesPerProcess: 4,
    } });
    const channels = [new Float32Array(20), new Float32Array(20)];
    processor.port.receive({
      type: 'OVERDUB_INIT', channels, channelCount: 2,
      buffers: [{ slotIndex: 0, indices: new Uint32Array(20), values: new Float32Array(20),
        oldValues: new Float32Array(20), rightValues: new Float32Array(20), oldRightValues: new Float32Array(20) }],
      startFrame: 0, requestFrame: 10, startOffsetSamples: 0,
    });

    // The first live callback starts at frame 18. Its input must wait while the
    // tap returns [10, 18); no output patch may expose a partial transaction.
    setCurrentFrame(18);
    processor.process([[Float32Array.from([100, 101]), Float32Array.from([-100, -101])]], [[new Float32Array(2), new Float32Array(2)]]);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_FIRST_INPUT_FRAME']);
    processor.port.receive({
      type: 'OVERDUB_BACKFILL', requestFrame: 10, firstInputFrame: 18,
      validFrames: 8, channelCount: 2,
      channels: [Float32Array.from([10, 11, 12, 13, 14, 15, 16, 17]), Float32Array.from([-10, -11, -12, -13, -14, -15, -16, -17])],
    });

    const liveBlocks = [
      [20, [102, 103]], [22, [104, 105]], [24, [106, 107]],
      [26, [108, 109]], [28, [110, 111]],
    ] as const;
    for (let block = 0; block < liveBlocks.length; block += 1) {
      const [frame, left] = liveBlocks[block]!;
      setCurrentFrame(frame);
      processor.process([[Float32Array.from(left), Float32Array.from(left.map((sample) => -sample))]], [[new Float32Array(2), new Float32Array(2)]]);
      if (block < liveBlocks.length - 1) {
        expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_PATCH')).toHaveLength(0);
      }
    }

    const patches = processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.message).toMatchObject({ sequence: 0, validFrames: 20 });
    expect(Array.from(patches[0]!.message.indices)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Array.from(patches[0]!.message.values)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    expect(Array.from(patches[0]!.message.rightValues)).toEqual([-10, -11, -12, -13, -14, -15, -16, -17, -100, -101, -102, -103, -104, -105, -106, -107, -108, -109, -110, -111]);
    // S=30: R=10, E=18. The committed patch is exactly [R,S), with no
    // repeated frame at the backfill/live boundary and no extra tail sample.
    setCurrentFrame(30);
    processor.port.receive({ type: 'OVERDUB_STOP' });
    expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_STOPPED')).toHaveLength(0);
    expect(processor.process([[]], [[new Float32Array(2), new Float32Array(2)]])).toBe(false);
    const stopAck = processor.port.posted.at(-1)?.message;
    expect(stopAck).toMatchObject({
      type: 'OVERDUB_STOPPED', requestFrame: 10, firstInputFrame: 18,
      requestedStopFrame: 30, appliedExclusiveEnd: 30, processorStopFrame: 32, stopFrame: 32,
      backfillFrames: 8, channelCount: 2,
      replayBudgetFramesPerProcess: 4, replayedFrames: 20,
      maxReplayedFramesPerProcess: 4,
      liveQueueCapacityFrames: 12, liveQueueFrames: 12,
      liveQueuePeakFrames: 12, startupCancelled: false,
    });
    expect(new Set(Array.from(patches[0]!.message.indices.slice(0, 20))).size).toBe(20);
    expect(Array.from(patches[0]!.message.values.slice(0, 20))).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
    ]);
    expect(Array.from(patches[0]!.message.rightValues.slice(0, 20))).toEqual([
      -10, -11, -12, -13, -14, -15, -16, -17, -100, -101, -102, -103, -104, -105, -106, -107, -108, -109, -110, -111,
    ]);
    expect(stopAck?.patchesSent).toBe(1);
  });

  it('rejects an incomplete R-to-E backfill with no partial patch and a bounded terminal acknowledgement', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 16, transferBufferPoolSize: 1,
      startupBackfillFrames: 8, startupQueueFrames: 8, startupReplayFramesPerProcess: 4,
    } });
    initOverdub(processor, new Array(16).fill(0), { capacity: 16, poolSize: 1, requestFrame: 10 });
    setCurrentFrame(12);
    processor.process([[Float32Array.from([1, 2])]], [[new Float32Array(2)]]);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_FIRST_INPUT_FRAME']);
    processor.port.receive({ type: 'OVERDUB_BACKFILL', requestFrame: 10, firstInputFrame: 12,
      validFrames: 1, channelCount: 1, channels: [Float32Array.from([9, 0])] });
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_ERROR')).toBe(true);
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_PATCH')).toBe(false);
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_STOPPED')).toBe(false);
    expect(processor.process([[]], [[new Float32Array(2)]])).toBe(false);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      type: 'OVERDUB_STOPPED', requestFrame: 10, firstInputFrame: 12,
      backfillFrames: 0, patchesSent: 0, startupCancelled: true,
    });
  });

  it('rejects a startup gap beyond the bounded preroll without publishing any partial patch', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 16, transferBufferPoolSize: 1,
      startupBackfillFrames: 4, startupQueueFrames: 12,
    } });
    initOverdub(processor, new Array(16).fill(0), { capacity: 16, poolSize: 1, requestFrame: 10 });
    setCurrentFrame(15);
    expect(processor.process([[Float32Array.from([1, 2])]], [[new Float32Array(2)]])).toBe(false);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual([
      'OVERDUB_ERROR', 'OVERDUB_STOPPED',
    ]);
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_PATCH')).toBe(false);
  });

  it('cancels while awaiting startup backfill before any shared-PCM patch is sent', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 16, transferBufferPoolSize: 1,
      startupBackfillFrames: 8, startupQueueFrames: 8,
    } });
    initOverdub(processor, new Array(16).fill(0), { capacity: 16, poolSize: 1, requestFrame: 10 });
    setCurrentFrame(12);
    processor.process([[Float32Array.from([1, 2])]], [[new Float32Array(2)]]);
    processor.port.receive({ type: 'OVERDUB_STOP' });
    expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_PATCH')).toHaveLength(0);
    expect(processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_STOPPED')).toHaveLength(0);
    expect(processor.process([[Float32Array.from([3, 4])]], [[new Float32Array(2)]])).toBe(false);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      type: 'OVERDUB_STOPPED', patchesSent: 0, startupCancelled: true,
    });
  });

  it('handles a zero-frame backfill and replays the first live block exactly once', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 8, transferBufferPoolSize: 1,
      startupBackfillFrames: 4, startupQueueFrames: 4, startupReplayFramesPerProcess: 8,
    } });
    initOverdub(processor, new Array(8).fill(0), { capacity: 8, poolSize: 1, requestFrame: 30 });
    setCurrentFrame(30);
    processor.process([[Float32Array.from([1, 2])]], [[new Float32Array(2)]]);
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_FIRST_INPUT_FRAME']);
    processor.port.receive({ type: 'OVERDUB_BACKFILL', requestFrame: 30, firstInputFrame: 30,
      validFrames: 0, channelCount: 1, channels: [new Float32Array(4)] });
    setCurrentFrame(32);
    processor.process([[Float32Array.from([3, 4])]], [[new Float32Array(2)]]);

    const patches = processor.port.posted.filter(({ message }) => message.type === 'OVERDUB_PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.message.validFrames).toBe(4);
    expect(Array.from(patches[0]!.message.indices.slice(0, 4))).toEqual([6, 7, 0, 1]);
    expect(Array.from(patches[0]!.message.values.slice(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('fails safely when bounded startup staging cannot hold the replay backlog', () => {
    const { worklets, setCurrentFrame } = loadProcessors();
    const OverdubProcessor = worklets.get('rc505-overdub-processor');
    const processor = new OverdubProcessor!({ processorOptions: {
      transferBufferFrames: 8, transferBufferPoolSize: 1,
      startupBackfillFrames: 4, startupQueueFrames: 4, startupReplayFramesPerProcess: 1,
    } });
    initOverdub(processor, new Array(8).fill(0), { capacity: 8, poolSize: 1, requestFrame: 10 });
    setCurrentFrame(12);
    processor.process([[Float32Array.from([1, 2])]], [[new Float32Array(2)]]);
    processor.port.receive({ type: 'OVERDUB_BACKFILL', requestFrame: 10, firstInputFrame: 12,
      validFrames: 2, channelCount: 1, channels: [Float32Array.from([5, 6, 0, 0])] });
    setCurrentFrame(14);
    processor.process([[Float32Array.from([3, 4])]], [[new Float32Array(2)]]);
    setCurrentFrame(16);
    processor.process([[Float32Array.from([5, 6])]], [[new Float32Array(2)]]);

    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_ERROR')).toBe(true);
    expect(processor.port.posted.some(({ message }) => message.type === 'OVERDUB_PATCH')).toBe(false);
  });

  it('captures variable loopback block lengths into a one-second bounded transfer and keeps pass-through intact', () => {
    const { worklets } = loadProcessors();
    const LoopbackProcessor = worklets.get('rc505-loopback-capture');
    expect(LoopbackProcessor).toBeDefined();
    const processor = new LoopbackProcessor!({ processorOptions: { captureFrames: 5 } });
    const firstOutput = new Float32Array(3);
    processor.process([[Float32Array.from([1, 2])]], [[firstOutput]]);
    expect([...firstOutput]).toEqual([1, 2, 0]);
    expect(processor.port.posted).toHaveLength(0);

    const secondOutput = new Float32Array(4);
    processor.process([[Float32Array.from([3, 4, 5, 6])]], [[secondOutput]]);
    expect([...secondOutput]).toEqual([3, 4, 5, 6]);
    expect(processor.port.posted).toHaveLength(1);
    expect(processor.port.posted[0]?.message).toMatchObject({ type: 'LOOPBACK_CAPTURE', framesCaptured: 5 });
    expect([...((processor.port.posted[0]?.message.samples as Float32Array) ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect(processor.port.posted[0]?.transferList).toHaveLength(1);
  });
});
