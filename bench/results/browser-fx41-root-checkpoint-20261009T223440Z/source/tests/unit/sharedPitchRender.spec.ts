import { describe, expect, it, vi } from 'vitest';
import {
  estimateSharedPitchRenderMemory,
  iteratePitchStretchBlocks,
  makeSharedPitchProfilePlan,
  makeSignalsmithExactRenderPlan,
  renderSharedPitchInWorker,
  SharedPitchRenderError,
  type SharedPitchWorkerJob,
  type SharedPitchWorkerPort,
} from '../../src/project/sharedPitchRender';
import {
  renderPitchWorkerJobWithSession,
  type ExactPitchStretchSession,
} from '../../src/project/sharedPitchRenderWorkerRuntime';
import { createWasmExactPitchStretchSession } from '../../src/project/sharedPitchRender.worker';

class TestWorker implements SharedPitchWorkerPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  job: SharedPitchWorkerJob | null = null;
  transfers: Transferable[] = [];
  terminated = false;

  postMessage(message: SharedPitchWorkerJob, transfer: Transferable[]): void {
    this.job = message;
    this.transfers = transfer;
  }
  terminate(): void { this.terminated = true; }

  reply(left = new Float32Array(16), right = new Float32Array(16)): void {
    if (!this.job || !this.onmessage) throw new Error('Worker has no active request.');
    const job = this.job;
    this.onmessage({ data: {
      type: 'SHARED_PITCH_RENDERED', requestId: job.requestId, profile: job.profile,
      sampleRate: job.sampleRate, inputFrames: 12, outputFrames: 16, playbackRate: job.playbackRate,
      wasmSha256: job.wasmSha256, sourceSetSha256: job.sourceSetSha256,
      alignment: 'signalsmith-exact-output-seek-flush', latency: { inputSamples: 2048, outputSamples: 3072 },
      left: left.buffer, right: right.buffer,
    } } as MessageEvent);
  }
}

function artifact() {
  return {
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    sha256: 'a'.repeat(64), sourceSetSha256: 'b'.repeat(64), byteLength: 1,
    compilerIdentity: 'emcc 6.0.10',
  };
}

describe('shared pitch render planning', () => {
  it('matches the three distinct native profile tuples and refuses offline LIVE_MONO', () => {
    expect(makeSharedPitchProfilePlan('LIVE_MONO', 48_000, 41)).toMatchObject({
      kind: 127, channelsPerHandle: 1, stereoHandleCount: 2,
      prepareParameters: [4096, 512, 32768, 40, 1000, 0.15], supportsOfflineDurationChange: false,
    });
    expect(makeSharedPitchProfilePlan('LIVE_POLY', 48_000, 41)).toMatchObject({
      kind: 113, channelsPerHandle: 2, stereoHandleCount: 1,
      prepareParameters: [1, 2, 4096, 1024, 1], supportsOfflineDurationChange: true,
    });
    expect(makeSharedPitchProfilePlan('HQ_RENDER', 48_000, 41)).toMatchObject({
      kind: 113, channelsPerHandle: 2, stereoHandleCount: 1,
      prepareParameters: [2, 2, 8192, 1024, 0], supportsOfflineDurationChange: true,
    });
    expect(() => renderSharedPitchInWorker({
      artifact: artifact(), profile: 'LIVE_MONO', sampleRate: 48_000, seed: 41,
      playbackRate: 1, left: new Float32Array(8), right: new Float32Array(8), maxMemoryBytes: 128 * 1024 * 1024,
    }, () => { throw new Error('must reject before worker creation'); })).toThrowError(SharedPitchRenderError);
  });

  it('partitions paired input/output without gaps, overlaps, empty blocks, or max-block violations', () => {
    const max = 64;
    const pairs: Array<[number, number]> = [
      [1, 1], [64, 64], [65, 65], [257, 514], [514, 257],
      [4097, 16384], [16384, 4097], [15_360, 30_720], [30_720, 15_360],
    ];
    for (const [inputFrames, outputFrames] of pairs) {
      const blocks = [...iteratePitchStretchBlocks(inputFrames, outputFrames, max)];
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks[0].inputOffset).toBe(0);
      expect(blocks[0].outputOffset).toBe(0);
      let consumedInput = 0;
      let producedOutput = 0;
      for (const block of blocks) {
        expect(block.inputOffset).toBe(consumedInput);
        expect(block.outputOffset).toBe(producedOutput);
        expect(block.inputFrames).toBeGreaterThan(0);
        expect(block.outputFrames).toBeGreaterThan(0);
        expect(block.inputFrames).toBeLessThanOrEqual(max);
        expect(block.outputFrames).toBeLessThanOrEqual(max);
        consumedInput += block.inputFrames;
        producedOutput += block.outputFrames;
      }
      expect(consumedInput).toBe(inputFrames);
      expect(producedOutput).toBe(outputFrames);
    }
    for (const maxBlockFrames of [8, 64, 256]) {
      for (const inputFrames of [257, 511, 4097, 15_360]) {
        for (const ratio of [0.25, 0.5, 0.75, 1, 1.5, 2, 4]) {
          const outputFrames = Math.ceil(inputFrames / ratio);
          const blocks = [...iteratePitchStretchBlocks(inputFrames, outputFrames, maxBlockFrames)];
          expect(blocks.reduce((sum, block) => sum + block.inputFrames, 0)).toBe(inputFrames);
          expect(blocks.reduce((sum, block) => sum + block.outputFrames, 0)).toBe(outputFrames);
          expect(blocks.every((block) => block.inputFrames > 0 && block.outputFrames > 0 &&
            block.inputFrames <= maxBlockFrames && block.outputFrames <= maxBlockFrames)).toBe(true);
        }
      }
    }
  });

  it('accounts exact Signalsmith seek/process/flush frame totals and rejects impossible seeks', () => {
    expect(makeSignalsmithExactRenderPlan(48_000, 96_000, 4096)).toEqual({
      inputFrames: 48_000, outputFrames: 96_000, playbackRate: 0.5,
      seekInputFrames: 4096, processInputFrames: 43_904,
      processOutputFrames: 87_808, flushOutputFrames: 8_192,
    });
    expect(() => makeSignalsmithExactRenderPlan(100, 200, 101)).toThrowError(SharedPitchRenderError);
    expect(() => makeSignalsmithExactRenderPlan(10_000, 1_000, 100)).toThrow(RangeError);
  });

  it('preflights worker memory before creating a worker and counts a fixed WASM instance', () => {
    const estimate = estimateSharedPitchRenderMemory(48_000, 96_000, 49_152, 49_152, 8192);
    expect(estimate.wasmInstanceBytes).toBe(64 * 1024 * 1024);
    expect(estimate.peakBytes).toBeGreaterThan(estimate.wasmInstanceBytes + estimate.sourcePcmBytes + estimate.resultPcmBytes);
    const workerFactory = vi.fn(() => new TestWorker());
    expect(() => renderSharedPitchInWorker({
      artifact: artifact(), profile: 'HQ_RENDER', sampleRate: 48_000, seed: 41,
      playbackRate: 0.5, left: new Float32Array(48_000), right: new Float32Array(48_000),
      maxMemoryBytes: estimate.peakBytes - 1,
    }, workerFactory)).toThrowError(SharedPitchRenderError);
    expect(workerFactory).not.toHaveBeenCalled();
  });
});

describe('shared pitch render worker client', () => {
  it('transfers copies, validates full result identity, and leaves caller PCM attached', async () => {
    const worker = new TestWorker();
    const sourceLeft = new Float32Array(12).fill(0.2);
    const sourceRight = new Float32Array(12).fill(-0.3);
    const promise = renderSharedPitchInWorker({
      artifact: artifact(), profile: 'HQ_RENDER', sampleRate: 48_000, seed: 41,
      playbackRate: 0.75, left: sourceLeft, right: sourceRight, maxMemoryBytes: 128 * 1024 * 1024,
    }, () => worker);
    expect(worker.job).not.toBeNull();
    expect(worker.job?.module).toBeInstanceOf(WebAssembly.Module);
    expect(worker.job?.left).not.toBe(sourceLeft.buffer);
    expect(worker.job?.right).not.toBe(sourceRight.buffer);
    expect(sourceLeft.byteLength).toBe(12 * Float32Array.BYTES_PER_ELEMENT);
    expect(sourceRight.byteLength).toBe(12 * Float32Array.BYTES_PER_ELEMENT);
    expect(worker.transfers).toEqual([worker.job?.left, worker.job?.right]);

    const left = new Float32Array(16).fill(0.125);
    const right = new Float32Array(16).fill(-0.25);
    worker.reply(left, right);
    const result = await promise;
    expect(result).toMatchObject({ profile: 'HQ_RENDER', inputFrames: 12, outputFrames: 16,
      playbackRate: 0.75, alignment: 'signalsmith-exact-output-seek-flush',
      latency: { inputSamples: 2048, outputSamples: 3072 } });
    expect([...result.left]).toEqual([...left]);
    expect([...result.right]).toEqual([...right]);
    expect(worker.terminated).toBe(true);
  });

  it('terminates the isolated worker on cancellation', async () => {
    const worker = new TestWorker();
    const controller = new AbortController();
    const promise = renderSharedPitchInWorker({
      artifact: artifact(), profile: 'LIVE_POLY', sampleRate: 48_000, seed: 9,
      playbackRate: 1.25, left: new Float32Array(100), right: new Float32Array(100),
      maxMemoryBytes: 128 * 1024 * 1024, signal: controller.signal,
    }, () => worker);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
    expect(worker.terminated).toBe(true);
  });

  it('rejects a mismatched module or output shape and always retires the worker', async () => {
    const worker = new TestWorker();
    const promise = renderSharedPitchInWorker({
      artifact: artifact(), profile: 'LIVE_POLY', sampleRate: 48_000, seed: 9,
      playbackRate: 1.25, left: new Float32Array(12), right: new Float32Array(12),
      maxMemoryBytes: 128 * 1024 * 1024,
    }, () => worker);
    if (!worker.job) throw new Error('Expected worker request.');
    worker.onmessage?.({ data: {
      type: 'SHARED_PITCH_RENDERED', requestId: worker.job.requestId, profile: 'LIVE_POLY',
      sampleRate: 48_000, inputFrames: 12, outputFrames: 10, playbackRate: 1.25,
      wasmSha256: worker.job.wasmSha256, sourceSetSha256: worker.job.sourceSetSha256,
      alignment: 'signalsmith-exact-output-seek-flush', latency: { inputSamples: 1, outputSamples: 1 },
      left: new ArrayBuffer(44), right: new ArrayBuffer(44),
    } } as MessageEvent);
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_WORKER_REPLY' });
    expect(worker.terminated).toBe(true);
  });
});

describe('shared pitch exact Worker runtime', () => {
  it('rejects an unpinned or incompatible module before it creates a DSP handle', async () => {
    const job = makeWorkerJob(new Float32Array(64), new Float32Array(64), 128 * 1024 * 1024);
    await expect(createWasmExactPitchStretchSession(job)).rejects.toMatchObject({
      code: 'WASM_IMPORT_TABLE_UNSUPPORTED',
    });
  });

  it('pads a source shorter than seek, crops the exact leading silence, flushes the tail, and disposes', async () => {
    const inputLeft = new Float32Array([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    const inputRight = new Float32Array([-0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8, -0.9]);
    const session = new FakeExactSession(10);
    const job = makeWorkerJob(inputLeft, inputRight, 128 * 1024 * 1024);
    const result = await renderPitchWorkerJobWithSession(job, () => session);
    const left = new Float32Array(result.left);
    const right = new Float32Array(result.right);
    expect(left).toEqual(new Float32Array([10, 11, 12, 13, 14, 15, 16, 17]));
    expect(right).toEqual(new Float32Array([110, 111, 112, 113, 114, 115, 116, 117]));
    expect(session.seekInputFrames).toBe(10);
    expect(session.processInputFrames).toBe(18);
    expect(session.processOutputFrames).toBe(18);
    expect(session.flushFrames).toBe(10);
    expect(session.seekWindowAllZero).toBe(true);
    expect(session.disposed).toBe(true);
    expect(result.latency).toEqual({ inputSamples: 2048, outputSamples: 3072 });
  });

  it('preserves exact rounded duration and L/R separation for short clips across the supported rate range', async () => {
    for (const playbackRate of [0.25, 0.5, 1, 2, 4]) {
      const left = new Float32Array(80).fill(0.2);
      const right = new Float32Array(80).fill(-0.2);
      const outputFrames = Math.ceil(left.length / playbackRate);
      const session = new FakeExactSession(100);
      const result = await renderPitchWorkerJobWithSession(
        makeWorkerJob(left, right, 128 * 1024 * 1024, outputFrames), () => session,
      );
      const renderedLeft = new Float32Array(result.left);
      const renderedRight = new Float32Array(result.right);
      const divisor = greatestTestCommonDivisor(left.length, outputFrames);
      const paddingOutput = Math.ceil(100 / (left.length / divisor)) * (outputFrames / divisor);
      expect(result.outputFrames).toBe(outputFrames);
      expect(result.playbackRate).toBe(left.length / outputFrames);
      expect(renderedLeft[0]).toBe(paddingOutput);
      expect(renderedRight[0]).toBe(100 + paddingOutput);
      expect(renderedLeft.length).toBe(outputFrames);
      expect(renderedRight.length).toBe(outputFrames);
      expect(session.seekWindowAllZero).toBe(true);
      expect(session.disposed).toBe(true);
    }
  });

  it('rejects an exact-alignment memory overrun before padding or processing', async () => {
    const session = new FakeExactSession(100);
    await expect(renderPitchWorkerJobWithSession(
      makeWorkerJob(new Float32Array(80).fill(0.2), new Float32Array(80).fill(-0.2),
        64 * 1024 * 1024 + 1), () => session,
    )).rejects.toMatchObject({ code: 'MEMORY_BUDGET_EXCEEDED' });
    expect(session.seekInputFrames).toBe(0);
    expect(session.processInputFrames).toBe(0);
    expect(session.disposed).toBe(true);
  });

  it('fails closed and disposes when the required flush frame count is not produced', async () => {
    const session = new FakeExactSession(4, 1);
    await expect(renderPitchWorkerJobWithSession(
      makeWorkerJob(new Float32Array(64).fill(0.2), new Float32Array(64).fill(-0.2),
        128 * 1024 * 1024), () => session,
    )).rejects.toMatchObject({ code: 'FLUSH_FRAME_MISMATCH' });
    expect(session.disposed).toBe(true);
  });
});

function makeWorkerJob(left: Float32Array, right: Float32Array, maxMemoryBytes: number,
                       outputFrames = left.length): SharedPitchWorkerJob {
  const playbackRate = left.length / outputFrames;
  return {
    type: 'RENDER_SHARED_PITCH', requestId: 1, module: artifact().module,
    wasmSha256: 'a'.repeat(64), sourceSetSha256: 'b'.repeat(64), profile: 'HQ_RENDER',
    sampleRate: 48_000, seed: 41, inputFrames: left.length, outputFrames, playbackRate,
    maxMemoryBytes, left: left.slice().buffer, right: right.slice().buffer,
  };
}

function greatestTestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

class FakeExactSession implements ExactPitchStretchSession {
  disposed = false;
  seekInputFrames = 0;
  processInputFrames = 0;
  processOutputFrames = 0;
  flushFrames = 0;
  seekWindowAllZero = false;
  private readonly seekFrames: number;
  private readonly flushAdjustment: number;

  constructor(seekFrames: number, flushAdjustment = 0) {
    this.seekFrames = seekFrames;
    this.flushAdjustment = flushAdjustment;
  }

  outputSeekLength(): number { return this.seekFrames; }
  outputSeek(left: Float32Array, right: Float32Array, inputOffset: number, inputFrames: number): void {
    this.seekInputFrames = inputFrames;
    this.seekWindowAllZero = left.slice(inputOffset, inputOffset + inputFrames).every((sample) => sample === 0) &&
      right.slice(inputOffset, inputOffset + inputFrames).every((sample) => sample === 0);
  }
  process(left: Float32Array, right: Float32Array, inputOffset: number, inputFrames: number,
          outputLeft: Float32Array, outputRight: Float32Array, outputOffset: number, outputFrames: number): void {
    this.processInputFrames += inputFrames;
    this.processOutputFrames += outputFrames;
    expect(left[inputOffset]).toBeCloseTo(0.2);
    expect(right[inputOffset]).toBeCloseTo(-0.2);
    for (let index = 0; index < outputFrames; index += 1) {
      outputLeft[outputOffset + index] = outputOffset + index;
      outputRight[outputOffset + index] = 100 + outputOffset + index;
    }
  }
  flush(outputLeft: Float32Array, outputRight: Float32Array, outputOffset: number,
        outputFrames: number): number {
    this.flushFrames = outputFrames;
    outputLeft.fill(0, outputOffset, outputOffset + outputFrames);
    outputRight.fill(0, outputOffset, outputOffset + outputFrames);
    return Math.max(0, outputFrames - this.flushAdjustment);
  }
  inputLatencySamples(): number { return 2048; }
  outputLatencySamples(): number { return 3072; }
  dispose(): void { this.disposed = true; }
}
