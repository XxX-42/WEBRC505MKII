import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BrowserRealtimeRuntime } from '../../src/audio/BrowserRealtimeRuntime';
import {
  BROWSER_REALTIME_LAYOUT_MONO,
  BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  BROWSER_REALTIME_LAYOUT_VERSION,
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  CONTROL_COMMANDS_WORD_OFFSET,
  TRACK_META_BYTES,
  TrackMetaWord,
  createControlSharedBuffer,
  createMonoLoopbackSharedBuffer,
  createTrackSharedBuffer,
  queueSharedCommand,
} from '../../src/audio/browserRealtimeProtocol';

const workletSource = readFileSync(resolve(process.cwd(), 'public/worklets/looper-processor.js'), 'utf8');

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

function createHarness(controlBuffer = createControlSharedBuffer()) {
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
  runInNewContext(workletSource, scope);
  if (!RegisteredProcessor) throw new Error('The real Worklet source did not register a processor.');
  const processor = new RegisteredProcessor({ processorOptions: { controlBuffer } }) as HarnessProcessorBase & Record<string, any>;
  return { processor, scope, controlBuffer };
}

function outputs(frames: number): Float32Array[][] {
  return Array.from({ length: 7 }, () => [new Float32Array(frames), new Float32Array(frames)]);
}

function processBlock(
  processor: HarnessProcessorBase & { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean },
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

function attach(processor: HarnessProcessorBase & { handlePortMessage: (message: unknown) => void }, track: number, capacity = 32) {
  const buffer = createTrackSharedBuffer(capacity);
  const meta = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
  const left = new Float32Array(buffer, TRACK_META_BYTES, capacity);
  const right = new Float32Array(buffer, TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT, capacity);
  processor.handlePortMessage({
    type: 'ATTACH_TRACK', track, buffer,
    channelCount: BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
    layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
    storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  });
  expect(processor.port.messages.at(-1)).toMatchObject({
    type: 'TRACK_ATTACHED', track, channelCount: 2, layoutVersion: 2, storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  });
  return { buffer, meta, left, right };
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
      const { processor, scope } = createHarness();
      const { meta, left, right } = attach(processor, 0, 16);
      left.set([1, 2, 3, 4, 5, 6, 7, 8]);
      right.set([11, 12, 13, 14, 15, 16, 17, 18]);
      Atomics.store(meta, TrackMetaWord.STATE, 5);
      Atomics.store(meta, TrackMetaWord.LOOP_FRAMES, 8);
      Atomics.store(meta, TrackMetaWord.PLAY_POSITION, 5);
      Atomics.store(meta, TrackMetaWord.REVERSE, reverse);
      Atomics.store(meta, TrackMetaWord.ALIGNMENT_SAMPLES, 2);
      const rendered = processBlock(processor, scope, 64, Float32Array.of(0.25), Float32Array.of(-0.5));
      const writePosition = reverse ? 7 : 3;
      expect(left[writePosition]).toBeCloseTo((reverse ? 8 : 4) + 0.25);
      expect(right[writePosition]).toBeCloseTo((reverse ? 18 : 14) - 0.5);
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
      Atomics.store(meta, TrackMetaWord.STATE, 4);
      Atomics.store(meta, TrackMetaWord.LOOP_FRAMES, 4);
      Atomics.store(meta, TrackMetaWord.PLAY_POSITION, reverse ? 0 : 3);
      Atomics.store(meta, TrackMetaWord.REVERSE, reverse);
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

    const rerecordLeft = Float32Array.of(-0.1, -0.2);
    const rerecordRight = Float32Array.of(-0.8, -0.9);
    command(controlBuffer, 4, BrowserRealtimeOpcode.START_RECORD, 0, 9);
    processBlock(processor, scope, 9, rerecordLeft, rerecordRight);
    expect(Array.from(left.subarray(0, 2))).toEqual(Array.from(rerecordLeft));
    expect(Array.from(right.subarray(0, 2))).toEqual(Array.from(rerecordRight));
    Atomics.store(meta, TrackMetaWord.LOOP_FRAMES, 2);
    Atomics.store(meta, TrackMetaWord.STATE, 6);
    const stoppedOutput = processBlock(processor, scope, 11, new Float32Array(2), new Float32Array(2));
    expect(Array.from(stoppedOutput[0]![0]!)).toEqual([0, 0]);
    expect(Array.from(stoppedOutput[0]![1]!)).toEqual([0, 0]);
  });

  it('keeps loopback calibration in a separate versioned mono buffer', () => {
    const { processor, scope, controlBuffer } = createHarness();
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
});

describe('stereo runtime attachment and export contract', () => {
  it('rejects an old ACK, coalesces concurrent preparation, retries, and exports exact stereo samples', async () => {
    let attachMessages = 0;
    let attemptedBuffer: SharedArrayBuffer | null = null;
    const port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage(message: Record<string, unknown>) {
        if (message.type === 'ATTACH_TRACK') {
          attachMessages += 1;
          attemptedBuffer = message.buffer as SharedArrayBuffer;
        }
      },
    };
    const controlBuffer = createControlSharedBuffer();
    const runtime = new BrowserRealtimeRuntime({ port } as unknown as AudioWorkletNode, controlBuffer, 48_000);

    const first = runtime.prepareTrack(0);
    const concurrent = runtime.prepareTrack(0);
    await Promise.resolve();
    expect(attachMessages).toBe(1);
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
    expect(runtime.getTrackMetadata(0)).not.toBeNull();

    const samplesLeft = runtime.getTrackSamples(0, 0)!;
    const samplesRight = runtime.getTrackSamples(0, 1)!;
    const expectedLeft = Float32Array.of(0.125, -0.25, 0.375, -0.5);
    const expectedRight = Float32Array.of(-0.75, 0.5, -0.25, 0.125);
    samplesLeft.set(expectedLeft);
    samplesRight.set(expectedRight);
    Atomics.store(runtime.getTrackMetadata(0)!, TrackMetaWord.LOOP_FRAMES, expectedLeft.length);

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
    await Promise.resolve();
    const control = new Int32Array(controlBuffer);
    const sequence = Atomics.load(control, CONTROL_COMMANDS_WORD_OFFSET) >>> 0;
    port.onmessage?.({ data: {
      type: 'ACK', sequence, opcode: BrowserRealtimeOpcode.EXPORT_TRACK, track: 0,
      executedFrame: 0, targetFrame: 0, status: BrowserRealtimeStatus.OK,
      loopFrames: expectedLeft.length, recordingFrames: expectedLeft.length,
    } } as MessageEvent);
    const audioBuffer = await exported;
    expect(audioBuffer.numberOfChannels).toBe(2);
    expect(Array.from(audioBuffer.getChannelData(0))).toEqual(Array.from(expectedLeft));
    expect(Array.from(audioBuffer.getChannelData(1))).toEqual(Array.from(expectedRight));
    runtime.dispose();
  });
});
