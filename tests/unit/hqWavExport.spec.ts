import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflinePitchResult } from '../../src/audio/pitch/signalsmith';
import {
  assertHqWavExportMemoryBudget,
  createHqWavExport,
  encodeAlignedHqWav,
  estimateHqWavExportMemory,
} from '../../src/audio/export/hqWavExport';
import { renderPitchOffline } from '../../src/audio/pitch';

function fakeRender(overrides: Partial<OfflinePitchResult> = {}): OfflinePitchResult {
  return {
    mode: 'HQ_RENDER',
    channels: [new Float32Array([9, 9, 0.25, -0.5, 0.75, 99])],
    sampleRate: 48_000,
    latencySamples: 2,
    inputLatencySamples: 1,
    outputLatencySamples: 1,
    windowSamples: 4,
    hopSamples: 1,
    playbackRate: 1,
    semitones: 3,
    leadingLatencySamples: 2,
    ...overrides,
  };
}

describe('HQ_RENDER WAV export alignment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes reported leading latency, drops padded tail, and preserves the exact rendered loop duration', () => {
    const result = encodeAlignedHqWav(fakeRender(), 3, 'pcm16');
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);

    expect(result).toMatchObject({
      mode: 'HQ_RENDER',
      sampleRate: 48_000,
      frameCount: 3,
      semitones: 3,
      playbackRate: 1,
      leadingLatencySamples: 2,
    });
    expect(view.getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((frame) => view.getInt16(44 + frame * 2, true))).toEqual([8192, -16384, 24575]);
  });

  it('keeps rate-derived output length and rejects a truncated HQ render', () => {
    const result = encodeAlignedHqWav(fakeRender({
      playbackRate: 0.5,
      channels: [new Float32Array([9, 9, 0, 0, 0, 0, 0, 0])],
    }), 3, 'float32');
    expect(result.frameCount).toBe(6);
    expect(result.bytes.byteLength).toBe(56 + 6 * 4);

    expect(() => encodeAlignedHqWav(fakeRender({ channels: [new Float32Array([0, 0, 1])] }), 3, 'pcm16'))
      .toThrow(/shorter than its reported aligned duration/);
  });

  it('renders real Signalsmith HQ_RENDER audio and encodes the latency-aligned loop', async () => {
    const sampleRate = 48_000;
    const input = new Float32Array(sampleRate);
    for (let frame = 0; frame < input.length; frame += 1) {
      input[frame] = 0.5 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    }
    const rendered = await renderPitchOffline([input], {
      mode: 'HQ_RENDER', sampleRate, semitones: 0, playbackRate: 1,
    });
    const result = encodeAlignedHqWav(rendered, input.length, 'pcm16');
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    let squareSum = 0;
    for (let frame = 8_000; frame < 40_000; frame += 1) {
      const sample = view.getInt16(44 + frame * 2, true) / 32_768;
      squareSum += sample * sample;
    }

    expect(result.frameCount).toBe(input.length);
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(40, true)).toBe(input.length * 2);
    expect(Math.sqrt(squareSum / 32_000)).toBeGreaterThan(0.2);
  }, 30_000);

  it('runs the worker with copied, transferable track channels and forwards progress/results', async () => {
    class FakeWorker {
      static instance: FakeWorker | null = null;
      onmessage: ((event: MessageEvent<any>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      request: any;
      transfer: Transferable[] = [];

      constructor(_url: URL, _options: WorkerOptions) { FakeWorker.instance = this; }
      postMessage(request: unknown, transfer: Transferable[] = []) {
        this.request = request;
        this.transfer = transfer;
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const source = new Float32Array([0.1, -0.2, 0.3]);
    const onProgress = vi.fn();
    const pending = createHqWavExport([source], {
      sampleRate: 48_000,
      semitones: 5,
      playbackRate: 1.25,
      format: 'pcm24',
    }, onProgress);

    const worker = FakeWorker.instance!;
    expect(worker.request).toMatchObject({
      type: 'render',
      sampleRate: 48_000,
      semitones: 5,
      playbackRate: 1.25,
      format: 'pcm24',
      channels: [new Float32Array([0.1, -0.2, 0.3])],
    });
    expect(worker.transfer).toHaveLength(1);
    expect(worker.transfer[0]).not.toBe(source.buffer);
    expect(source).toEqual(new Float32Array([0.1, -0.2, 0.3]));

    worker.onmessage?.({ data: { type: 'progress', fraction: 0.5 } } as MessageEvent);
    const bytes = new ArrayBuffer(48);
    worker.onmessage?.({ data: {
      type: 'complete', bytes, sampleRate: 48_000, format: 'pcm24',
      semitones: 5, playbackRate: 1.25, frameCount: 3, leadingLatencySamples: 44,
    } } as MessageEvent);
    const result = await pending;

    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(result.bytes).toEqual(new Uint8Array(bytes));
    expect(result).toMatchObject({ mode: 'HQ_RENDER', frameCount: 3, leadingLatencySamples: 44, format: 'pcm24' });
    expect(worker.terminated).toBe(true);
  });

  it('rejects RIFF oversize and invalid pitch/rate before starting a worker', async () => {
    const constructor = vi.fn();
    vi.stubGlobal('Worker', constructor);
    await expect(createHqWavExport([new Float32Array([1])], {
      sampleRate: 48_000,
      semitones: 25,
      playbackRate: 1,
      format: 'pcm16',
    })).rejects.toThrow(/semitones/);
    expect(constructor).not.toHaveBeenCalled();
  });

  it('admits an export exactly at its configured estimated-memory budget', async () => {
    class FakeWorker {
      static instance: FakeWorker | null = null;
      onmessage: ((event: MessageEvent<any>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      request: any;
      constructor(_url: URL, _options: WorkerOptions) { FakeWorker.instance = this; }
      postMessage(request: unknown) { this.request = request; }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const source = new Float32Array([0.125, -0.25, 0.5]);
    const estimate = estimateHqWavExportMemory(3, 1, 48_000, 1, 'pcm16');
    const options = {
      sampleRate: 48_000,
      semitones: 0,
      playbackRate: 1,
      format: 'pcm16' as const,
      memoryBudgetBytes: estimate.estimatedPeakBytes,
    };

    expect(assertHqWavExportMemoryBudget(3, 1, options)).toEqual(estimate);
    const pending = createHqWavExport([source], options);
    expect(FakeWorker.instance?.request.memoryBudgetBytes).toBe(estimate.estimatedPeakBytes);
    expect(FakeWorker.instance?.request).not.toHaveProperty('source');
    FakeWorker.instance?.onmessage?.({ data: {
      type: 'complete', bytes: new ArrayBuffer(48), sampleRate: 48_000,
      format: 'pcm16', semitones: 0, playbackRate: 1, frameCount: 3, leadingLatencySamples: 0,
    } } as MessageEvent);
    await expect(pending).resolves.toMatchObject({ frameCount: 3 });
  });

  it('rejects over-budget exports before starting a worker and preserves live loop PCM', async () => {
    const constructor = vi.fn();
    vi.stubGlobal('Worker', constructor);
    const liveLoopChannel = new Float32Array([0.125, -0.25, 0.5, -0.75]);
    const originalSamples = liveLoopChannel.slice();
    const estimate = estimateHqWavExportMemory(liveLoopChannel.length, 1, 48_000, 1, 'pcm16');

    await expect(createHqWavExport([liveLoopChannel], {
      sampleRate: 48_000,
      semitones: 0,
      playbackRate: 1,
      format: 'pcm16',
      memoryBudgetBytes: estimate.estimatedPeakBytes - 1,
    })).rejects.toThrow(/above the .* export budget/);

    expect(constructor).not.toHaveBeenCalled();
    expect(liveLoopChannel).toEqual(originalSamples);
  });
});
