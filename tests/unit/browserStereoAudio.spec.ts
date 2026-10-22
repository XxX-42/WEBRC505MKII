import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';

class Port {
  onmessage: ((event: { data: any }) => void) | null = null;
  readonly posted: Array<{ message: any; transfers: Transferable[] }> = [];
  postMessage(message: any, transfers: Transferable[] = []) {
    this.posted.push({ message: { ...message }, transfers });
  }
  receive(data: any) { this.onmessage?.({ data }); }
}

class WorkletBase {
  readonly port = new Port();
  constructor(_options?: unknown) {}
}

function loadProcessor(path: string, className: string) {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const factory = new Function('AudioWorkletProcessor', 'registerProcessor', `${source}\nreturn ${className};`) as (
    base: typeof WorkletBase,
    register: (name: string, processor: new (options?: any) => any) => void,
  ) => new (options?: any) => any;
  return factory(WorkletBase, () => {});
}

describe('Browser stereo worklet audio', () => {
  it('keeps the 384 MiB capture cap total across stereo channel arrays at 192 kHz', () => {
    const capBytes = 384 * 1024 * 1024;
    const maxStereoFrames = Math.floor(capBytes / Float32Array.BYTES_PER_ELEMENT / 2);
    expect(maxStereoFrames).toBe(50_331_648);
    expect(maxStereoFrames / 192_000).toBe(262.144);
    expect((300 * 192_000 * 2 * Float32Array.BYTES_PER_ELEMENT) / (1024 * 1024)).toBe(439.453125);
  });

  it('captures independent L/R order across partial chunks and preserves mono input', () => {
    const Recorder = loadProcessor('public/worklets/looper-processor.js', 'LooperProcessor');
    const recorder = new Recorder({ processorOptions: { chunkSize: 3, chunkPoolSize: 3, maxRecordingBytes: 128 } });
    recorder.port.receive({ type: 'START_RECORD' });
    const left = [new Float32Array([1, 2]), new Float32Array([3, 4, 5, 6])];
    const right = [new Float32Array([-1, -2]), new Float32Array([-3, -4, -5, -6])];
    recorder.process([[left[0], right[0]]], [[new Float32Array(2), new Float32Array(2)]]);
    recorder.process([[left[1], right[1]]], [[]]);
    recorder.port.receive({ type: 'STOP_RECORD' });
    const messages = recorder.port.posted.map(({ message }: any) => message);
    const configured = messages.find((message: any) => message.type === 'RECORD_CONFIGURED');
    const chunks = messages.filter((message: any) => message.type === 'RECORD_CHUNK');
    expect(configured).toMatchObject({ channelCount: 2, maxRecordingFrames: 16, maxRecordingBytes: 128 });
    expect(chunks.map((chunk: any) => chunk.validFrames)).toEqual([3, 3]);
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[0].subarray(0, chunk.validFrames))))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunks.flatMap((chunk: any) => Array.from(chunk.channels[1].subarray(0, chunk.validFrames))))
      .toEqual([-1, -2, -3, -4, -5, -6]);
    expect(chunks.every((chunk: any) => chunk.samples === chunk.channels[0])).toBe(true);

    const mono = new Recorder({ processorOptions: { chunkSize: 4, chunkPoolSize: 2, maxRecordingBytes: 16 } });
    mono.port.receive({ type: 'START_RECORD' });
    mono.process([[new Float32Array([7, 8, 9])]], [[]]);
    mono.port.receive({ type: 'STOP_RECORD' });
    const monoChunk = mono.port.posted.map(({ message }: any) => message)
      .find((message: any) => message.type === 'RECORD_CHUNK');
    expect(monoChunk.channelCount).toBe(1);
    expect(monoChunk.channels).toHaveLength(1);
    expect(Array.from(monoChunk.samples.subarray(0, monoChunk.validFrames))).toEqual([7, 8, 9]);

    const boundedStereo = new Recorder({ processorOptions: { chunkSize: 4, chunkPoolSize: 1, maxRecordingBytes: 16 } });
    boundedStereo.port.receive({ type: 'START_RECORD' });
    boundedStereo.process([[new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3])]], [[]]);
    boundedStereo.port.receive({ type: 'STOP_RECORD' });
    const budgetConfigured = boundedStereo.port.posted.find(({ message }: any) => message.type === 'RECORD_CONFIGURED')?.message;
    const complete = boundedStereo.port.posted.find(({ message }: any) => message.type === 'RECORD_COMPLETE')?.message;
    expect(budgetConfigured).toMatchObject({ channelCount: 2, maxRecordingFrames: 2, maxRecordingBytes: 16 });
    expect(complete).toMatchObject({ framesCaptured: 2, droppedFrames: 1, limitReached: true });
  });

  it('applies stereo overdub samples to matching loop channels and emits a paired patch', () => {
    const Overdub = loadProcessor('public/worklets/browser-track-io.js', 'BrowserOverdubProcessor');
    const processor = new Overdub({ processorOptions: { transferBufferFrames: 2, transferBufferPoolSize: 1 } });
    const leftLoop = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const rightLoop = new Float32Array([-0.1, -0.2, -0.3, -0.4]);
    const patchBuffers = [{ slotIndex: 0, indices: new Uint32Array(2), values: new Float32Array(2),
      oldValues: new Float32Array(2), rightValues: new Float32Array(2), oldRightValues: new Float32Array(2) }];
    processor.port.receive({
      type: 'OVERDUB_INIT', channels: [leftLoop, rightLoop], channelCount: 2, buffers: patchBuffers,
      startFrame: 0, startOffsetSamples: 0, latencySamples: 0, recordingOffsetSamples: 0,
    });
    const outLeft = new Float32Array(2);
    const outRight = new Float32Array(2);
    processor.process([[new Float32Array([0.5, 0.6]), new Float32Array([1.5, 1.6])]], [[outLeft, outRight]]);
    const patch = processor.port.posted.find(({ message }: any) => message.type === 'OVERDUB_PATCH');
    expect(Array.from(leftLoop, (value) => Number(value.toFixed(5)))).toEqual([0.6, 0.8, 0.3, 0.4]);
    expect(Array.from(rightLoop, (value) => Number(value.toFixed(5)))).toEqual([1.4, 1.4, -0.3, -0.4]);
    expect(Array.from(patch.message.values.subarray(0, 2), (value: number) => Number(value.toFixed(5)))).toEqual([0.6, 0.8]);
    expect(Array.from(patch.message.rightValues.subarray(0, 2), (value: number) => Number(value.toFixed(5)))).toEqual([1.4, 1.4]);
    expect(patch.transfers).toHaveLength(5);
    expect(Array.from(outLeft, (value) => Number(value.toFixed(5)))).toEqual([0.6, 0.8]);
    expect(Array.from(outRight, (value) => Number(value.toFixed(5)))).toEqual([1.4, 1.4]);
  });

  it('assembles a two-channel AudioBuffer and patches both overdub channels without touching neighbors', async () => {
    const { TrackAudio } = await import('../../src/audio/TrackAudio');
    const { Track, TrackState } = await import('../../src/core/types');
    const context = createMockAudioContext();
    const engine = {
      context, trackMixNode: context.createGain(), roundTripLatency: 0,
      selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(), checkAndResetMaster: vi.fn(), tracks: [] as unknown[],
    };
    const nodes: any[] = [];
    class FakeNode {
      readonly port = new Port();
      onprocessorerror: ((event: Event) => void) | null = null;
      disconnected = false;
      constructor(_ctx: AudioContext, _name: string, public options?: AudioWorkletNodeOptions) { nodes.push(this); }
      connect() {}
      disconnect() { this.disconnected = true; }
    }
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const track = new TrackAudio(engine as never, new Track(1), 0, null, null);
    await track.startRecording();
    const node = nodes[0];
    node.port.receive({ type: 'RECORD_CONFIGURED', channelCount: 2, maxRecordingFrames: 4, maxRecordingBytes: 32 });
    await track.stopRecording();
    node.port.receive({ type: 'RECORD_CHUNK', chunkIndex: 0, sequence: 0, validFrames: 2, channelCount: 2,
      channels: [new Float32Array([1, 2]), new Float32Array([11, 12])] });
    node.port.receive({ type: 'RECORD_CHUNK', chunkIndex: 1, sequence: 1, validFrames: 1, channelCount: 2,
      channels: [new Float32Array([3]), new Float32Array([13])] });
    (track as any).resumeAfterRecording = false;
    node.port.receive({ type: 'RECORD_COMPLETE', framesCaptured: 3, droppedFrames: 0, overflowEvents: 0,
      maxRecordingFrames: 4, channelCount: 2, limitReached: false, chunksSent: 2 });
    const audioBuffer = (track as any).audioBuffer as AudioBuffer;
    expect(audioBuffer.numberOfChannels).toBe(2);
    expect(Array.from(audioBuffer.getChannelData(0))).toEqual([1, 2, 3]);
    expect(Array.from(audioBuffer.getChannelData(1))).toEqual([11, 12, 13]);
    expect(track.state).toBe(TrackState.STOPPED);

    (track as any).workletNode = node;
    (track as any).acceptRecordingChunk(node, {
      type: 'RECORD_CHUNK', chunkIndex: 2, sequence: 2, validFrames: 1, channelCount: 2,
      channels: [new Float32Array([4]), new Float32Array([14, 15])],
    });
    expect((track as any).recordedChunks[2]).toBeNull();
    (track as any).recordingStoredFrames = (384 * 1024 * 1024) / 8 - 1;
    (track as any).recordingChannelCount = 2;
    (track as any).acceptRecordingChunk(node, {
      type: 'RECORD_CHUNK', chunkIndex: 2, sequence: 2, validFrames: 2, channelCount: 2,
      channels: [new Float32Array([4, 5]), new Float32Array([14, 15])],
    });
    expect((track as any).recordedChunks[2]).toBeNull();
    expect(track.recordingDiagnostic).toContain('384 MiB');
    (track as any).workletNode = null;
    (track as any).recordingStoredFrames = 0;

    (track as any).overdubProcessor = node;
    (track as any).overdubSessionAudioBuffer = audioBuffer;
    (track as any).prepareOverdubStopRollback(audioBuffer);
    (track as any).overdubNextPatchSequence = 0;
    (track as any).overdubStopping = false;
    (track as any).handleOverdubMessage(node, audioBuffer, {
      type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
      startInputFrame: 100, endInputFrame: 101,
      indices: new Uint32Array([1]), values: new Float32Array([22]), oldValues: new Float32Array([2]),
      rightValues: new Float32Array([222]), oldRightValues: new Float32Array([12]),
    });
    expect(audioBuffer.getChannelData(0)[1]).toBe(22);
    expect(audioBuffer.getChannelData(1)[1]).toBe(222);
    expect(audioBuffer.getChannelData(0)[0]).toBe(1);
    expect(audioBuffer.getChannelData(1)[0]).toBe(11);
    (track as any).handleOverdubMessage(node, audioBuffer, {
      type: 'OVERDUB_PATCH', sequence: 1, slotIndex: 1, validFrames: 1,
      indices: new Uint32Array([2]), values: new Float32Array([99]),
    });
    expect(audioBuffer.getChannelData(0)[1]).toBe(2); // The earlier valid patch is rolled back with the malformed patch.
    expect(audioBuffer.getChannelData(1)[1]).toBe(12);
    expect((track as any).overdubDiagnostic).toContain('invalid');
    expect(node.port.posted.at(-1)?.message).toMatchObject({ type: 'OVERDUB_STOP', stopFrame: 0 });
    (track as any).handleOverdubMessage(node, audioBuffer, {
      type: 'OVERDUB_STOPPED', patchesSent: 2, overflowFrames: 0, overflowEvents: 0,
        requestedStopFrame: 0, processorStopFrame: 0,
        appliedExclusiveEnd: 0,
    });
    expect(node.disconnected).toBe(true);
    expect(track.historyBusy).toBe(false);
    vi.unstubAllGlobals();
  });

  it('fails a stop with no further AudioWorklet process in bounded time and preserves an explicit partial-edit warning', async () => {
    const { TrackAudio } = await import('../../src/audio/TrackAudio');
    const { Track, TrackState } = await import('../../src/core/types');
    const context = createMockAudioContext();
    (context as unknown as { state: string }).state = 'closed';
    const engine = {
      context, trackMixNode: context.createGain(), roundTripLatency: 0,
      selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(), checkAndResetMaster: vi.fn(), tracks: [] as unknown[],
    };
    const track = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const node = {
      port: new Port(), disconnected: false,
      disconnect() { this.disconnected = true; },
    };
    (track as any).overdubProcessor = node;
    (track as any).overdubStopping = false;
    track.state = TrackState.OVERDUBBING;

    vi.useFakeTimers();
    try {
      (track as any).stopOverdub();
      expect(node.port.posted.map(({ message }) => message.type)).toEqual(['OVERDUB_STOP']);
      expect((track as any).overdubProcessor).toBe(node);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(node.disconnected).toBe(true);
      expect((track as any).overdubProcessor).toBeNull();
      expect(track.historyBusy).toBe(false);
      expect(track.state).toBe(TrackState.PLAYING);
      expect(track.overdubDiagnostic).toContain('could not drain the terminal stop acknowledgement within 5000 ms');
      expect(track.overdubDiagnostic).toContain('the stop-frame cutoff was applied, but missing pre-stop patches may leave a partial overdub');
      expect(track.overdubDiagnostic).toContain('Use Undo to restore the pre-overdub PCM if its history entry was retained');
    } finally {
      vi.useRealTimers();
    }
  });

  it('also bounds waiting for a terminal ACK whose final patch never arrives', async () => {
    const { TrackAudio } = await import('../../src/audio/TrackAudio');
    const { Track, TrackState } = await import('../../src/core/types');
    const context = createMockAudioContext();
    const engine = {
      context, trackMixNode: context.createGain(), roundTripLatency: 0,
      selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(), checkAndResetMaster: vi.fn(), tracks: [] as unknown[],
    };
    const track = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const node = { port: new Port(), disconnected: false, disconnect() { this.disconnected = true; } };
    (track as any).overdubProcessor = node;
    (track as any).overdubStopping = false;
    track.state = TrackState.OVERDUBBING;

    vi.useFakeTimers();
    try {
      (track as any).stopOverdub();
      (track as any).handleOverdubMessage(node, null, {
        type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
        requestedStopFrame: 0, appliedExclusiveEnd: 0, processorStopFrame: 0,
      });
      expect((track as any).overdubExpectedPatchMessages).toBe(1);
      expect((track as any).overdubProcessor).toBe(node);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(node.disconnected).toBe(true);
      expect((track as any).overdubProcessor).toBeNull();
      expect(track.historyBusy).toBe(false);
      expect(track.overdubDiagnostic).toContain('final PCM patches (0/1 received)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for an asynchronously delivered final patch even if its stop acknowledgement arrives first', async () => {
    const { TrackAudio } = await import('../../src/audio/TrackAudio');
    const { Track, TrackState } = await import('../../src/core/types');
    const context = createMockAudioContext();
    const engine = {
      context, trackMixNode: context.createGain(), roundTripLatency: 0,
      selectedInputDeviceId: null, selectedOutputDeviceId: null, selectedBufferFrames: 128,
      getProcessedInputNode: async () => context.createGain(), checkAndResetMaster: vi.fn(), tracks: [] as unknown[],
    };
    const track = new TrackAudio(engine as never, new Track(1), 0, null, null);
    const node = {
      port: new Port(), disconnected: false,
      disconnect() { this.disconnected = true; },
    };
    const buffer = context.createBuffer(1, 4, context.sampleRate);
    buffer.getChannelData(0).set([1, 2, 3, 4]);
    (track as any).audioBuffer = buffer;
    (track as any).prepareOverdubStopRollback(buffer);
    (track as any).overdubProcessor = node;
    (track as any).overdubSessionAudioBuffer = buffer;
    (track as any).overdubStopping = true;
    (track as any).overdubExpectedPatchMessages = null;
    (track as any).overdubReceivedPatchMessages = 0;
    (track as any).overdubNextPatchSequence = 0;
    (track as any).overdubStopFrameTarget = 103;
    track.state = TrackState.PLAYING;

    queueMicrotask(() => (track as any).handleOverdubMessage(node, buffer, {
      type: 'OVERDUB_STOPPED', patchesSent: 1, overflowFrames: 0, overflowEvents: 0,
      requestedStopFrame: 103, appliedExclusiveEnd: 103, processorStopFrame: 128,
    }));
    await Promise.resolve();
    expect((track as any).overdubProcessor).toBe(node);
    expect(track.historyBusy).toBe(true);

    queueMicrotask(() => (track as any).handleOverdubMessage(node, buffer, {
      type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 1,
      startInputFrame: 102, endInputFrame: 103,
      indices: new Uint32Array([2]), values: new Float32Array([30]), oldValues: new Float32Array([3]),
    }));
    await Promise.resolve();
    expect(buffer.getChannelData(0)[2]).toBe(30);
    expect(node.disconnected).toBe(true);
    expect((track as any).overdubProcessor).toBeNull();
    expect(track.canUndo).toBe(true);
    expect(track.undo()).toBe(true);
    expect(Array.from((track as any).audioBuffer.getChannelData(0))).toEqual([1, 2, 3, 4]);
  });
});
