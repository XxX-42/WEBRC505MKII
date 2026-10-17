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
  }));
}

function initOverdub(processor: WorkletInstance, samples: number[], options: {
  capacity?: number;
  poolSize?: number;
  startFrame?: number;
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
    expect(processor.port.posted[0]?.transferList).toHaveLength(2);
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
    expect(processor.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_PATCH', 'OVERDUB_STOPPED']);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      overflowFrames: 1,
      overflowEvents: 1,
      patchesSent: 1,
    });
    const stoppedOutput = new Float32Array(3);
    processor.process([[Float32Array.from([7, 8, 9])]], [[stoppedOutput]]);
    expect([...stoppedOutput]).toEqual([0, 0, 0]);
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
