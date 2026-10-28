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
    const chunkPosts = processor.port.posted.filter((entry) => entry.message.type === 'RECORD_CHUNK');
    expect(new Set(chunkPosts.map((entry) => entry.source)).size).toBe(1);
    expect(new Set(chunkPosts.map((entry) => entry.transferList)).size).toBe(1);
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

  it('retires the recorder worklet on the first callback after STOP_RECORD', () => {
    const { Processor } = loadLooperProcessor();
    const processor = new Processor({ processorOptions: { chunkSize: 4, chunkPoolSize: 1, maxRecordingFrames: 32 } });
    const preStartInput = new Float32Array([9, 8]);
    const preStartOutput = new Float32Array(2);
    expect(processor.process([[preStartInput]], [[preStartOutput]])).toBe(true);
    expect([...preStartOutput]).toEqual([...preStartInput]);
    processor.port.receive({ type: 'START_RECORD' });
    expect(processor.process([[new Float32Array([1, 2])]], [[]])).toBe(true);
    processor.port.receive({ type: 'STOP_RECORD' });
    processor.port.receive({ type: 'STOP_RECORD' });
    expect(processor.port.posted.at(-1)?.message.type).toBe('RECORD_COMPLETE');
    expect(processor.process([[new Float32Array([3, 4])]], [[]])).toBe(false);
    expect(processor.port.posted.filter(({ message }) => message.type === 'RECORD_COMPLETE')).toHaveLength(1);

    const nextRecording = new Processor({
      processorOptions: { chunkSize: 4, chunkPoolSize: 1, maxRecordingFrames: 32 },
    });
    nextRecording.port.receive({ type: 'START_RECORD' });
    expect(nextRecording.process([[new Float32Array([5, 6])]], [[]])).toBe(true);
    nextRecording.port.receive({ type: 'STOP_RECORD' });
    expect(nextRecording.port.posted.at(-1)?.message).toMatchObject({
      type: 'RECORD_COMPLETE',
      framesCaptured: 2,
      chunksSent: 1,
    });
    expect(nextRecording.process([[]], [[]])).toBe(false);
  });
});

describe('TrackAudio recording chunk assembly', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a reversed loop playing when REC/PLAY is pressed and permits overdub after returning forward', async () => {
    const [{ TrackAudio }, { Track, TrackState }] = await Promise.all([
      import('../../src/audio/TrackAudio'), import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const engine = { context, trackMixNode: context.createGain(), tracks: [] as unknown[] };
    const audio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const buffer = context.createBuffer(2, 16, context.sampleRate);
    buffer.getChannelData(0).set([0.25, -0.5]);
    (audio as unknown as { audioBuffer: AudioBuffer }).audioBuffer = buffer;
    audio.state = TrackState.PLAYING;
    audio.isReverse = true;
    const suspend = vi.spyOn(audio as any, 'suspendLoopTransportForOverdub').mockImplementation(() => {});
    const overdub = vi.spyOn(audio as any, 'startOverdub').mockResolvedValue(undefined);
    audio.triggerRecord();
    expect(audio.state).toBe(TrackState.PLAYING);
    expect(suspend).not.toHaveBeenCalled();
    expect(overdub).not.toHaveBeenCalled();
    expect(buffer.getChannelData(0)[0]).toBe(0.25);
    expect(audio.overdubDiagnostic).toContain('REVERSE');
    audio.isReverse = false;
    audio.triggerRecord();
    expect(audio.state).toBe(TrackState.OVERDUBBING);
    expect(overdub).toHaveBeenCalledOnce();
  });

  it('does not quantize start or stop when this track has LOOP SYNC OFF', async () => {
    const [{ TrackAudio }, { Track, TrackState }, { Transport }] = await Promise.all([
      import('../../src/audio/TrackAudio'), import('../../src/core/types'), import('../../src/core/Transport'),
    ]);
    const context = createMockAudioContext();
    const engine = { context, trackMixNode: context.createGain(), tracks: [] as unknown[],
      getRecordPlaySettings: () => ({ quantize: 'MEASURE' }) };
    const transport = Transport.getInstance();
    transport.stop(); transport.masterTrackId = 1; transport.masterLoopLengthSamples = 2048;
    try {
      const audio = new TrackAudio(engine as never, new Track(2), 1, null, null);
      const start = vi.spyOn(audio, 'startRecording').mockResolvedValue(undefined);
      const stop = vi.spyOn(audio, 'stopRecording').mockResolvedValue(undefined);
      audio.triggerRecord();
      expect(start).toHaveBeenCalledOnce();
      expect(audio.state).toBe(TrackState.EMPTY);
      audio.state = TrackState.RECORDING;
      audio.triggerRecord();
      expect(stop).toHaveBeenCalledOnce();
      expect(audio.state).toBe(TrackState.RECORDING);
    } finally {
      transport.stop(); transport.masterTrackId = null; transport.masterLoopLengthSamples = 0;
    }
  });

  it('keeps the recorded PCM length when LOOP SYNC is OFF even if another track is master', async () => {
    const [{ TrackAudio }, { Track }, { Transport }] = await Promise.all([
      import('../../src/audio/TrackAudio'), import('../../src/core/types'), import('../../src/core/Transport'),
    ]);
    const context = createMockAudioContext();
    const engine = { context, trackMixNode: context.createGain(), tracks: [] as unknown[], roundTripLatency: 0,
      selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames: 128 };
    const transport = Transport.getInstance();
    transport.stop(); transport.masterTrackId = 1; transport.masterLoopLengthSamples = 8;
    try {
      const audio = new TrackAudio(engine as never, new Track(2), 1, null, null);
      const internal = audio as unknown as { processRecordedBuffer: (samples: Float32Array) => void; resumeAfterRecording: boolean; audioBuffer: AudioBuffer };
      internal.resumeAfterRecording = false;
      internal.processRecordedBuffer(Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
      expect(internal.audioBuffer.length).toBe(10);
      expect(Array.from(internal.audioBuffer.getChannelData(0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      transport.stop(); transport.masterTrackId = null; transport.masterLoopLengthSamples = 0;
    }
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
    expect(worklet?.options?.processorOptions?.maxRecordingBytes).toBe(384 * 1024 * 1024);
    expect(trackAudio.recordingMaximumFrames).toBe(50_331_648);
    expect(trackAudio.recordingMaximumDurationSeconds).toBeGreaterThan(15 * 60);
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

  it('uses the engine-owned shared capture session, honors stopFrame, preserves stereo and does not dispose the tap', async () => {
    vi.resetModules();
    const [{ TrackAudio }, { Track }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const node = {
      port: new FakeWorkletPort(),
      disconnected: false,
      disconnect() { this.disconnected = true; },
    } as unknown as AudioWorkletNode & { disconnected: boolean };
    const session = { node, trackIndex: 0, sessionId: 91, inputGeneration: 7, startFrame: 100 };
    let listener: ((message: unknown) => void) | null = null;
    const recycleInputCaptureChunk = vi.fn(() => true);
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 0,
      getProcessedInputNode: async () => context.createGain(),
      getInputCaptureRequestFrame: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(102),
      beginInputCaptureSession: vi.fn((_track: number, _frame: number, receive: (message: unknown) => void) => {
        listener = receive;
        return session;
      }),
      stopInputCaptureSession: vi.fn(() => true),
      abortInputCaptureSession: vi.fn(),
      recycleInputCaptureChunk,
      releaseInputCaptureSession: vi.fn(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as unknown[],
    };

    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const processRecordedBuffers = vi.fn();
    (trackAudio as unknown as { processRecordedBuffers: (buffers: Float32Array[]) => void }).processRecordedBuffers = processRecordedBuffers;

    await trackAudio.startRecording();
    expect(engine.beginInputCaptureSession).toHaveBeenCalledWith(0, 100, expect.any(Function));
    expect((trackAudio as unknown as { workletNode: AudioWorkletNode }).workletNode).toBe(node);
    await trackAudio.stopRecording();
    expect(engine.stopInputCaptureSession).toHaveBeenCalledWith(session, 102);

    listener?.({
      type: 'RECORD_CONFIGURED', sessionId: 91, inputGeneration: 7,
      channelCount: 2, maxRecordingFrames: 50_331_648, maxRecordingBytes: 384 * 1024 * 1024,
    });
    const left = new Float32Array(16_384);
    const right = new Float32Array(16_384);
    left.set([0.1, 0.2, 0.3, 0.4]);
    right.set([-0.1, -0.2, -0.3, -0.4]);
    listener?.({
      type: 'RECORD_CHUNK', sessionId: 91, inputGeneration: 7,
      chunkIndex: 1, sequence: 0, startFrame: 100, validFrames: 4, channelCount: 2,
      channels: [left, right],
    });
    listener?.({
      type: 'RECORD_COMPLETE', sessionId: 91, inputGeneration: 7,
      requestedStartFrame: 100, stopFrame: 102, framesCaptured: 2, droppedFrames: 0,
      overflowEvents: 0, maxRecordingFrames: 50_331_648, maxRecordingBytes: 384 * 1024 * 1024,
      channelCount: 2, limitReached: false, chunksSent: 1, status: 'complete',
      timelineOverlapEvents: 2, timelineOverlapFrames: 6,
    });

    expect(processRecordedBuffers).toHaveBeenCalledTimes(1);
    const assembled = processRecordedBuffers.mock.calls[0]?.[0] ?? [];
    expect(assembled).toHaveLength(2);
    expect(Array.from(assembled[0] ?? [])).toEqual(Array.from(left.subarray(0, 2)));
    expect(Array.from(assembled[1] ?? [])).toEqual(Array.from(right.subarray(0, 2)));
    expect(recycleInputCaptureChunk).toHaveBeenCalledWith(session, 1, [left, right]);
    expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(session);
    expect(trackAudio.recordingDiagnostic).toContain('2 block(s), 6 frame(s) skipped');
    expect(trackAudio.recordingDiagnostic).toContain('continuity cannot be verified');
    expect(node.disconnected).toBe(false);
  });

  it('surfaces shared-capture failure and retains the incumbent track PCM', async () => {
    vi.resetModules();
    const [{ TrackAudio }, { Track, TrackState }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
    ]);
    const context = createMockAudioContext();
    const node = {
      port: new FakeWorkletPort(),
      disconnected: false,
      disconnect() { this.disconnected = true; },
    } as unknown as AudioWorkletNode & { disconnected: boolean };
    const session = { node, trackIndex: 0, sessionId: 92, inputGeneration: 8, startFrame: 200 };
    let listener: ((message: unknown) => void) | null = null;
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      getProcessedInputNode: async () => context.createGain(),
      getInputCaptureRequestFrame: vi.fn().mockReturnValue(200),
      beginInputCaptureSession: vi.fn((_track: number, _frame: number, receive: (message: unknown) => void) => {
        listener = receive;
        return session;
      }),
      abortInputCaptureSession: vi.fn(),
      recycleInputCaptureChunk: vi.fn(() => true),
      releaseInputCaptureSession: vi.fn(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as unknown[],
    };

    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const original = context.createBuffer(1, 8, context.sampleRate);
    (trackAudio as any).audioBuffer = original;
    trackAudio.state = TrackState.STOPPED;
    await trackAudio.startRecording();
    listener?.({
      type: 'CAPTURE_ERROR', sessionId: 92, inputGeneration: 8,
      reason: 'request-frame-outside-preroll',
    });

    expect((trackAudio as any).audioBuffer).toBe(original);
    expect(trackAudio.state).toBe(TrackState.STOPPED);
    expect(trackAudio.recordingDiagnostic).toContain('request-frame-outside-preroll');
    expect(engine.abortInputCaptureSession).toHaveBeenCalledWith(session);
    expect(engine.releaseInputCaptureSession).toHaveBeenCalledWith(session);
    expect(node.disconnected).toBe(false);
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
      trackAudio.track.loopSyncSw = 'ON';
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
