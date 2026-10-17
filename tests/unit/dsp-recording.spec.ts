import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';
import { resetBrowserRecordingOffsetConfig, setBrowserRecordingOffsetConfig } from '../../src/audio/browserRecordingOffset';

interface PostedMessage {
  message: Record<string, any>;
  transferList: Transferable[];
  source: Record<string, any>;
}

class FakeWorkletPort {
  onmessage: ((event: { data: any }) => void) | null = null;
  readonly posted: PostedMessage[] = [];

  postMessage(message: Record<string, any>, transferList: Transferable[] = []): void {
    const snapshot = { ...message };
    if (message.samples instanceof Float32Array) snapshot.samples = new Float32Array(message.samples);
    this.posted.push({ message: snapshot, transferList, source: message });
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeAudioWorkletProcessor {
  readonly port = new FakeWorkletPort();

  constructor(_options?: unknown) {}
}

interface LooperProcessorInstance extends FakeAudioWorkletProcessor {
  blocksProcessed: number;
  framesCaptured: number;
  droppedFrames: number;
  overflowEvents: number;
  chunksSent: number;
  maxRecordingFrames: number;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type LooperProcessorConstructor = new (options?: unknown) => LooperProcessorInstance;

function loadLooperProcessor() {
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/looper-processor.js'), 'utf8');
  let registeredName = '';
  let registeredProcessor: LooperProcessorConstructor | null = null;
  const factory = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    `${source}\nreturn LooperProcessor;`,
  ) as (
    AudioWorkletProcessor: typeof FakeAudioWorkletProcessor,
    registerProcessor: (name: string, processor: LooperProcessorConstructor) => void,
  ) => LooperProcessorConstructor;
  const Processor = factory(FakeAudioWorkletProcessor, (name, processor) => {
    registeredName = name;
    registeredProcessor = processor;
  });

  return { Processor, registeredName, registeredProcessor };
}

describe('bounded recording worklet capture', () => {
  it('records irregular callback lengths in sample order and flushes the final partial chunk', () => {
    const { Processor, registeredName, registeredProcessor } = loadLooperProcessor();
    expect(registeredName).toBe('looper-processor');
    expect(registeredProcessor).toBe(Processor);

    const processor = new Processor({
      processorOptions: { chunkSize: 4, chunkPoolSize: 3, maxRecordingFrames: 32 },
    });
    processor.port.receive({ type: 'START_RECORD' });

    const outputA = new Float32Array(5);
    processor.process([[new Float32Array([1, 2, 3])]], [[outputA]]);
    expect([...outputA]).toEqual([1, 2, 3, 0, 0]);

    const outputB = new Float32Array(2);
    processor.process([[new Float32Array([4, 5, 6, 7, 8])]], [[outputB]]);
    expect([...outputB]).toEqual([4, 5]);

    processor.process([[new Float32Array([9, 10])]], [[]]);
    processor.port.receive({ type: 'STOP_RECORD' });

    const chunks = processor.port.posted
      .map(({ message }) => message)
      .filter((message) => message.type === 'RECORD_CHUNK');
    const recorded = chunks.flatMap((message) => Array.from(message.samples.subarray(0, message.validFrames)));
    const complete = processor.port.posted.at(-1)?.message;

    expect(chunks.map((message) => message.validFrames)).toEqual([4, 4, 2]);
    expect(recorded).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(complete).toMatchObject({
      type: 'RECORD_COMPLETE',
      framesCaptured: 10,
      droppedFrames: 0,
      overflowEvents: 0,
      limitReached: false,
      chunksSent: 3,
    });
    expect(processor.blocksProcessed).toBe(3);
    expect(new Set(processor.port.posted.slice(0, -1).map((entry) => entry.source)).size).toBe(1);
    expect(new Set(processor.port.posted.slice(0, -1).map((entry) => entry.transferList)).size).toBe(1);
  });

  it('reports bounded-pool overflow while keeping monitoring available', () => {
    const { Processor } = loadLooperProcessor();
    const processor = new Processor({
      processorOptions: { chunkSize: 2, chunkPoolSize: 1, maxRecordingFrames: 20 },
    });
    processor.port.receive({ type: 'START_RECORD' });
    const input = new Float32Array([1, 2, 3, 4, 5, 6]);
    const output = new Float32Array(input.length);
    processor.process([[input]], [[output]]);
    processor.port.receive({ type: 'STOP_RECORD' });

    expect([...output]).toEqual([...input]);
    expect(processor.port.posted.filter((entry) => entry.message.type === 'RECORD_CHUNK')).toHaveLength(1);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      framesCaptured: 2,
      droppedFrames: 4,
      overflowEvents: 1,
      limitReached: false,
      chunksSent: 1,
    });
  });

  it('reports when a configured frame cap is crossed', () => {
    const { Processor } = loadLooperProcessor();
    const processor = new Processor({
      processorOptions: { chunkSize: 2, chunkPoolSize: 2, maxRecordingFrames: 3 },
    });
    processor.port.receive({ type: 'START_RECORD' });
    processor.process([[new Float32Array([1, 2, 3, 4, 5])]], [[]]);
    processor.port.receive({ type: 'STOP_RECORD' });

    expect(processor.port.posted.filter((entry) => entry.message.type === 'RECORD_CHUNK'))
      .toHaveLength(2);
    expect(processor.port.posted.at(-1)?.message).toMatchObject({
      framesCaptured: 3,
      droppedFrames: 2,
      overflowEvents: 1,
      limitReached: true,
      maxRecordingFrames: 3,
    });
  });
});

describe('TrackAudio recording chunk assembly', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recycles transferable chunks and finalizes only the captured frame range with counters', async () => {
    vi.resetModules();
    const [{ TrackAudio }, { Track }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as unknown[],
    };

    const instances: Array<{
      options?: AudioWorkletNodeOptions;
      port: FakeWorkletPort;
      disconnected: boolean;
      connect: () => void;
      disconnect: () => void;
    }> = [];
    class FakeAudioWorkletNode {
      readonly port = new FakeWorkletPort();
      disconnected = false;

      constructor(_context: AudioContext, _name: string, public options?: AudioWorkletNodeOptions) {
        instances.push(this as unknown as typeof instances[number]);
      }

      connect() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);

    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const processRecordedBuffer = vi.fn();
    (trackAudio as unknown as { processRecordedBuffer: (buffer: Float32Array) => void }).processRecordedBuffer = processRecordedBuffer;

    await trackAudio.startRecording();
    const worklet = instances[0];
    expect(worklet).toBeDefined();
    expect(worklet?.options?.processorOptions).toMatchObject({ chunkSize: 16_384, chunkPoolSize: 3 });
    expect(worklet?.options?.processorOptions?.maxRecordingFrames).toBe(100_663_296);
    expect(trackAudio.recordingMaximumDurationSeconds).toBeGreaterThan(30 * 60);
    expect(worklet?.port.posted[0]?.message).toEqual({ type: 'START_RECORD' });

    const transferredSamples = new Float32Array(16_384);
    transferredSamples.set([0.1, -0.25, 0.75, 0.5]);
    worklet?.port.receive({
      type: 'RECORD_CHUNK',
      chunkIndex: 1,
      sequence: 0,
      validFrames: transferredSamples.length,
      samples: transferredSamples,
    });
    const recycle = worklet?.port.posted.at(-1);
    expect(recycle?.message.type).toBe('RECYCLE_CHUNK');
    expect(recycle?.message.chunkIndex).toBe(1);
    expect(recycle?.message.samples).not.toBe(transferredSamples);
    expect(recycle?.message.samples).toBeInstanceOf(Float32Array);
    expect((recycle?.message.samples as Float32Array).length).toBe(16_384);
    expect(recycle?.transferList[0]).toBe((recycle?.source.samples as Float32Array).buffer);

    await trackAudio.stopRecording();
    expect(worklet?.port.posted.at(-1)?.message).toEqual({ type: 'STOP_RECORD' });
    const finalPartial = new Float32Array([0.25, 0.5, 0.75]);
    worklet?.port.receive({
      type: 'RECORD_CHUNK',
      chunkIndex: 0,
      sequence: 1,
      validFrames: finalPartial.length,
      samples: finalPartial,
    });
    worklet?.port.receive({
      type: 'RECORD_COMPLETE',
      framesCaptured: 16_387,
      droppedFrames: 5,
      overflowEvents: 2,
      maxRecordingFrames: 100_663_296,
      limitReached: false,
      chunksSent: 2,
    });

    expect(processRecordedBuffer).toHaveBeenCalledTimes(1);
    const finalized = processRecordedBuffer.mock.calls[0]?.[0] ?? new Float32Array(0);
    expect(finalized.length).toBe(16_387);
    expect(Array.from(finalized.subarray(0, 4))).toEqual(Array.from(new Float32Array([0.1, -0.25, 0.75, 0.5])));
    expect(Array.from(finalized.subarray(-3))).toEqual([0.25, 0.5, 0.75]);
    expect(trackAudio.recordingFramesCaptured).toBe(16_387);
    expect(trackAudio.recordingDroppedFrames).toBe(5);
    expect(trackAudio.recordingOverflowEvents).toBe(2);
    expect(trackAudio.recordingLimitReached).toBe(false);
    expect(worklet?.disconnected).toBe(true);
  });

  it('waits for pending chunks after completion and assembles them by sequence', async () => {
    vi.resetModules();
    const [{ TrackAudio }, { Track }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 0,
      getProcessedInputNode: async () => context.createGain(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as unknown[],
    };
    const instances: Array<{ port: FakeWorkletPort; disconnected: boolean; connect: () => void; disconnect: () => void }> = [];
    class FakeAudioWorkletNode {
      readonly port = new FakeWorkletPort();
      disconnected = false;
      constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
        instances.push(this as unknown as typeof instances[number]);
      }
      connect() {}
      disconnect() { this.disconnected = true; }
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);

    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const processRecordedBuffer = vi.fn();
    (trackAudio as unknown as { processRecordedBuffer: (buffer: Float32Array) => void }).processRecordedBuffer = processRecordedBuffer;
    await trackAudio.startRecording();
    const worklet = instances[0];
    expect(worklet).toBeDefined();
    await trackAudio.stopRecording();

    worklet?.port.receive({
      type: 'RECORD_COMPLETE', framesCaptured: 5, droppedFrames: 0, overflowEvents: 0,
      maxRecordingFrames: 100_663_296, limitReached: false, chunksSent: 2,
    });
    worklet?.port.receive({
      type: 'RECORD_CHUNK', chunkIndex: 1, sequence: 1, validFrames: 2,
      samples: new Float32Array([4, 5]),
    });
    expect(processRecordedBuffer).not.toHaveBeenCalled();
    expect(worklet?.disconnected).toBe(false);

    worklet?.port.receive({
      type: 'RECORD_CHUNK', chunkIndex: 0, sequence: 0, validFrames: 3,
      samples: new Float32Array([1, 2, 3]),
    });

    expect(processRecordedBuffer).toHaveBeenCalledTimes(1);
    expect(Array.from(processRecordedBuffer.mock.calls[0]?.[0] ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(trackAudio.recordingFramesCaptured).toBe(5);
    expect(trackAudio.recordingDroppedFrames).toBe(0);
    expect(trackAudio.recordingOverflowEvents).toBe(0);
    expect(worklet?.disconnected).toBe(true);
  });

  it('surfaces an explicit storage limit flag and maximum duration', async () => {
    vi.resetModules();
    const [{ TrackAudio }, { Track }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const engine = {
      context, trackMixNode: context.createGain(), roundTripLatency: 0,
      selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(), checkAndResetMaster: vi.fn(), tracks: [] as unknown[],
    };
    const instances: Array<{ port: FakeWorkletPort; disconnected: boolean; connect: () => void; disconnect: () => void }> = [];
    class FakeAudioWorkletNode {
      readonly port = new FakeWorkletPort();
      disconnected = false;
      constructor(_context: AudioContext, _name: string, _options?: AudioWorkletNodeOptions) {
        instances.push(this as unknown as typeof instances[number]);
      }
      connect() {}
      disconnect() { this.disconnected = true; }
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const processRecordedBuffer = vi.fn();
    (trackAudio as unknown as { processRecordedBuffer: (buffer: Float32Array) => void }).processRecordedBuffer = processRecordedBuffer;
    await trackAudio.startRecording();
    const worklet = instances[0];
    await trackAudio.stopRecording();
    worklet?.port.receive({
      type: 'RECORD_COMPLETE', framesCaptured: 0, droppedFrames: 1, overflowEvents: 1,
      maxRecordingFrames: 100_663_296, limitReached: true, chunksSent: 0,
    });

    expect(trackAudio.recordingLimitReached).toBe(true);
    expect(trackAudio.recordingMaximumFrames).toBe(100_663_296);
    expect(trackAudio.recordingMaximumDurationSeconds).toBeGreaterThan(30 * 60);
    expect(trackAudio.recordingDroppedFrames).toBe(1);
    expect(trackAudio.recordingOverflowEvents).toBe(1);
    expect(trackAudio.recordingDiagnostic).toContain('Recording capacity reached');
  });

  it('keeps latency trim, circular offset, and slave sizing while processing in place', async () => {
    vi.resetModules();
    const [{ TrackAudio }, { Track }, { Transport }, { TransportState }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
      import('../../src/core/Transport'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext() as unknown as AudioContext & { sampleRate: number };
    context.sampleRate = 1_000;
    const offsetScope = {
      inputDeviceId: null,
      outputDeviceId: null,
      sampleRate: context.sampleRate,
      bufferFrames: 128,
    };
    setBrowserRecordingOffsetConfig(1, offsetScope);
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0.002,
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as unknown[],
    };
    const transport = Transport.getInstance();
    transport.masterTrackId = 1;
    transport.masterLoopLengthSamples = 8;
    transport.state = TransportState.STOPPED;

    try {
      const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
      const privateApi = trackAudio as unknown as {
        processRecordedBuffer: (buffer: Float32Array) => void;
        resumeAfterRecording: boolean;
        audioBuffer: AudioBuffer | null;
      };
      privateApi.resumeAfterRecording = false;
      privateApi.processRecordedBuffer(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

      const audioBuffer = privateApi.audioBuffer;
      expect(audioBuffer?.length).toBe(8);
      expect(Array.from(audioBuffer?.getChannelData(0) ?? [])).toEqual([4, 5, 6, 7, 8, 9, 10, 3]);
    } finally {
      resetBrowserRecordingOffsetConfig(offsetScope);
      transport.masterTrackId = null;
      transport.masterLoopLengthSamples = 0;
      transport.state = TransportState.STOPPED;
    }
  });
});
