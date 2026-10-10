import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  iteratePitchStretchBlocks,
  makeSignalsmithExactRenderPlan,
  makeSharedPitchProfilePlan,
  type SharedPitchProfile,
  type SharedPitchWorkerJob,
  type SharedPitchWorkerReply,
} from '../../src/project/sharedPitchRender';
import { handleSharedPitchWorkerMessage } from '../../src/project/sharedPitchRenderWorkerRuntime';
import {
  createWasmExactPitchStretchSession,
} from '../../src/project/sharedPitchRender.worker';
import type { ExactPitchStretchSession } from '../../src/project/sharedPitchRenderWorkerRuntime';

const wasmPath = process.env.WEBRC_SHARED_DSP_WASM_PATH;
const describeWithWasm = wasmPath ? describe : describe.skip;
const evidenceDirectory = process.env.WEBRC_PITCH_PCM_EVIDENCE_DIR;

interface Fixture {
  id: string;
  profile: SharedPitchProfile;
  inputFrames: number;
  playbackRate: number;
  seed: number;
}

interface RenderCapture {
  preparedSeekFrames: number;
  paddedInputLeft: Float32Array | null;
  paddedInputRight: Float32Array | null;
  paddedOutputLeft: Float32Array | null;
  paddedOutputRight: Float32Array | null;
  processBlocks: Array<{ inputOffset: number; inputFrames: number; outputOffset: number; outputFrames: number }>;
  flushFrames: number;
}

const fixtures: Fixture[] = [
  { id: 'livepoly-long-half', profile: 'LIVE_POLY', inputFrames: 48_000, playbackRate: 0.5, seed: 0x5eed },
  { id: 'livepoly-long-unity', profile: 'LIVE_POLY', inputFrames: 48_000, playbackRate: 1, seed: 0x5eee },
  { id: 'livepoly-long-oneandhalf-tail', profile: 'LIVE_POLY', inputFrames: 48_000, playbackRate: 1.5, seed: 0x5eef },
  { id: 'hq-long-double', profile: 'HQ_RENDER', inputFrames: 48_000, playbackRate: 2, seed: 0x5ef0 },
  { id: 'hq-short-unity-crop', profile: 'HQ_RENDER', inputFrames: 4_800, playbackRate: 1, seed: 0x5ef1 },
  { id: 'hq-short-oneandhalf-crop', profile: 'HQ_RENDER', inputFrames: 4_800, playbackRate: 1.5, seed: 0x5ef2 },
];

describeWithWasm('actual WASM pitch Worker PCM against an independent C ABI render', () => {
  it('matches direct seek/process/flush calls and records full/cropped stereo PCM', async () => {
    const wasmBytes = await readFile(wasmPath!);
    const wasmSha256 = sha256(wasmBytes);
    const expectedWasmSha256 = process.env.WEBRC_SHARED_DSP_WASM_SHA256;
    const sourceSetSha256 = process.env.WEBRC_SHARED_DSP_SOURCE_SET_SHA256;
    expect(expectedWasmSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(wasmSha256).toBe(expectedWasmSha256);
    const module = new WebAssembly.Module(wasmBytes);
    const results: Array<Record<string, unknown>> = [];

    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
    for (const fixture of fixtures) {
      const input = makeFixturePcm(fixture.inputFrames, fixture.seed);
      const outputFrames = Math.max(1, Math.round(fixture.inputFrames / fixture.playbackRate));
      const exactRate = fixture.inputFrames / outputFrames;
      const job: SharedPitchWorkerJob = {
        type: 'RENDER_SHARED_PITCH',
        requestId: fixture.seed,
        module,
        wasmSha256,
        sourceSetSha256: sourceSetSha256!,
        profile: fixture.profile,
        sampleRate: 48_000,
        seed: fixture.seed,
        inputFrames: fixture.inputFrames,
        outputFrames,
        playbackRate: exactRate,
        maxMemoryBytes: 256 * 1024 * 1024,
        reverse: false,
        left: input.left.slice().buffer,
        right: input.right.slice().buffer,
      };
      const capture: RenderCapture = {
        preparedSeekFrames: 0,
        paddedInputLeft: null,
        paddedInputRight: null,
        paddedOutputLeft: null,
        paddedOutputRight: null,
        processBlocks: [],
        flushFrames: 0,
      };
      let reply: SharedPitchWorkerReply | null = null;
      await handleSharedPitchWorkerMessage(job, (value) => { reply = value; },
        async (workerJob) => recordSession(
          await createWasmExactPitchStretchSession(workerJob), capture));
      expect(reply?.type).toBe('SHARED_PITCH_RENDERED');
      if (!reply || reply.type !== 'SHARED_PITCH_RENDERED') {
        throw new Error(reply?.type === 'SHARED_PITCH_RENDER_FAILED'
          ? `${reply.code}: ${reply.message}` : 'Worker did not return a render.');
      }
      expect(reply.wasmSha256).toBe(wasmSha256);
      expect(reply.sourceSetSha256).toBe(sourceSetSha256);
      expect(reply.alignment).toBe('signalsmith-exact-output-seek-flush');
      const workerLeft = new Float32Array(reply.left);
      const workerRight = new Float32Array(reply.right);
      expect(workerLeft.length).toBe(outputFrames);
      expect(workerRight.length).toBe(outputFrames);
      expect(allFinite(workerLeft)).toBe(true);
      expect(allFinite(workerRight)).toBe(true);

      const direct = await runDirectWasmCAbi(job, input.left, input.right);
      expect(direct.seekFrames).toBe(capture.preparedSeekFrames);
      expect(direct.flushFrames).toBe(capture.flushFrames);
      expect(direct.processBlocks).toEqual(capture.processBlocks);
      expect(direct.inputLeft).toEqual(capture.paddedInputLeft);
      expect(direct.inputRight).toEqual(capture.paddedInputRight);
      // Both paths use independent WASM instances/handles. Exact equality shows
      // that Worker padding, seek prefix, callback partitioning, flush, and crop
      // agree with direct calls to the same C ABI.
      expect(maxAbsError(workerLeft, direct.croppedLeft)).toBe(0);
      expect(maxAbsError(workerRight, direct.croppedRight)).toBe(0);
      expect(direct.croppedLeft.length).toBe(outputFrames);
      expect(direct.croppedRight.length).toBe(outputFrames);

      const tailWindows = [64, 128, 256, 512, 1_024].filter((frames) => frames <= outputFrames)
        .map((frames) => ({ frames, leftRms: rms(direct.croppedLeft, outputFrames - frames, outputFrames),
          rightRms: rms(direct.croppedRight, outputFrames - frames, outputFrames) }));
      const firstNonzero = [firstAbove(direct.croppedLeft, 1e-5), firstAbove(direct.croppedRight, 1e-5)];
      const lastNonzero = [lastAbove(direct.croppedLeft, 1e-5), lastAbove(direct.croppedRight, 1e-5)];
      const result = {
        id: fixture.id,
        profile: fixture.profile,
        sampleRate: 48_000,
        inputFrames: fixture.inputFrames,
        outputFrames,
        exactPlaybackRate: exactRate,
        seed: fixture.seed,
        wasmSha256,
        sourceSetSha256,
        inputSha256: [sha256(floatBytes(input.left)), sha256(floatBytes(input.right))],
        workerOutputSha256: [sha256(floatBytes(workerLeft)), sha256(floatBytes(workerRight))],
        directCAbiOutputSha256: [sha256(floatBytes(direct.croppedLeft)), sha256(floatBytes(direct.croppedRight))],
        fullPaddedOutputSha256: [sha256(floatBytes(direct.fullLeft)), sha256(floatBytes(direct.fullRight))],
        seekInputFrames: direct.seekFrames,
        processInputFrames: direct.processInputFrames,
        processOutputFrames: direct.processOutputFrames,
        flushOutputFrames: direct.flushFrames,
        inputPaddingFrames: direct.inputPaddingFrames,
        outputPaddingFrames: direct.outputPaddingFrames,
        outputCropStartFrame: direct.cropStart,
        outputCropEndFrameExclusive: direct.cropStart + outputFrames,
        processBlocks: direct.processBlocks,
        firstAboveThresholdFrame: firstNonzero,
        lastAboveThresholdFrame: lastNonzero,
        tailWindows,
        outputLatencyGetterSamples: reply.latency.outputSamples,
        inputLatencyGetterSamples: reply.latency.inputSamples,
      };
      results.push(result);
      console.log(JSON.stringify({ suite: 'actual-wasm-pitch-worker-vs-direct-cabi', ...result }));

      if (evidenceDirectory) {
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.input.left.f32le`), input.left);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.input.right.f32le`), input.right);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.worker.left.f32le`), workerLeft);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.worker.right.f32le`), workerRight);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.direct-cabi.full.left.f32le`), direct.fullLeft);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.direct-cabi.full.right.f32le`), direct.fullRight);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.direct-cabi.aligned-input.left.f32le`), direct.inputLeft);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.direct-cabi.aligned-input.right.f32le`), direct.inputRight);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.direct-cabi.cropped.left.f32le`), direct.croppedLeft);
        await writeFloatSidecar(join(evidenceDirectory, `${fixture.id}.direct-cabi.cropped.right.f32le`), direct.croppedRight);
      }
    }

    if (evidenceDirectory) {
      await writeFile(join(evidenceDirectory, 'worker-direct-comparison.json'),
        `${JSON.stringify({ schemaVersion: 1, suite: 'actual-wasm-pitch-worker-vs-direct-cabi', wasmSha256,
          sourceSetSha256, results }, null, 2)}\n`, 'utf8');
    }
    console.log(JSON.stringify({ suite: 'actual-wasm-pitch-worker-vs-direct-cabi-summary', wasmSha256,
      sourceSetSha256, fixtures: results.length, comparedFrames: results.reduce((n, r) => n + Number(r.outputFrames), 0) }));
  }, 120_000);
});

function recordSession(session: ExactPitchStretchSession, capture: RenderCapture): ExactPitchStretchSession {
  return {
    outputSeekLength(rate) {
      const frames = session.outputSeekLength(rate);
      capture.preparedSeekFrames = frames;
      return frames;
    },
    outputSeek(left, right, inputOffset, inputFrames, rate) {
      capture.paddedInputLeft = left.slice();
      capture.paddedInputRight = right.slice();
      session.outputSeek(left, right, inputOffset, inputFrames, rate);
    },
    process(left, right, inputOffset, inputFrames, outputLeft, outputRight, outputOffset, outputFrames) {
      session.process(left, right, inputOffset, inputFrames, outputLeft, outputRight, outputOffset, outputFrames);
      capture.paddedOutputLeft = outputLeft;
      capture.paddedOutputRight = outputRight;
      capture.processBlocks.push({ inputOffset, inputFrames, outputOffset, outputFrames });
    },
    flush(outputLeft, outputRight, outputOffset, outputFrames, rate) {
      capture.flushFrames = session.flush(outputLeft, outputRight, outputOffset, outputFrames, rate);
      capture.paddedOutputLeft = outputLeft;
      capture.paddedOutputRight = outputRight;
      return capture.flushFrames;
    },
    inputLatencySamples: () => session.inputLatencySamples(),
    outputLatencySamples: () => session.outputLatencySamples(),
    dispose: () => session.dispose(),
  };
}

async function runDirectWasmCAbi(job: SharedPitchWorkerJob, left: Float32Array, right: Float32Array) {
  const session = await createWasmExactPitchStretchSession(job);
  try {
    const seekFrames = session.outputSeekLength(job.playbackRate);
    const padding = job.inputFrames < seekFrames
      ? calculatePadding(job.inputFrames, job.outputFrames, seekFrames) : { input: 0, output: 0 };
    const alignedLeft = new Float32Array(job.inputFrames + 2 * padding.input);
    const alignedRight = new Float32Array(job.inputFrames + 2 * padding.input);
    alignedLeft.set(left, padding.input);
    alignedRight.set(right, padding.input);
    const paddedOutputFrames = job.outputFrames + 2 * padding.output;
    const plan = makeSignalsmithExactRenderPlan(alignedLeft.length, paddedOutputFrames, seekFrames);
    expect(plan.playbackRate).toBe(job.playbackRate);
    const fullLeft = new Float32Array(paddedOutputFrames);
    const fullRight = new Float32Array(paddedOutputFrames);
    session.outputSeek(alignedLeft, alignedRight, 0, seekFrames, plan.playbackRate);
    const processBlocks = [...iteratePitchStretchBlocks(plan.processInputFrames, plan.processOutputFrames,
      makeSharedPitchProfilePlan(job.profile, job.sampleRate, job.seed).maxBlockFrames)];
    for (const block of processBlocks) {
      session.process(alignedLeft, alignedRight, seekFrames + block.inputOffset, block.inputFrames,
        fullLeft, fullRight, block.outputOffset, block.outputFrames);
    }
    const flushFrames = session.flush(fullLeft, fullRight, plan.processOutputFrames,
      plan.flushOutputFrames, plan.playbackRate);
    expect(flushFrames).toBe(plan.flushOutputFrames);
    const croppedLeft = fullLeft.slice(padding.output, padding.output + job.outputFrames);
    const croppedRight = fullRight.slice(padding.output, padding.output + job.outputFrames);
    return {
      seekFrames,
      processInputFrames: plan.processInputFrames,
      processOutputFrames: plan.processOutputFrames,
      flushFrames,
      inputPaddingFrames: padding.input,
      outputPaddingFrames: padding.output,
      cropStart: padding.output,
      inputLeft: alignedLeft,
      inputRight: alignedRight,
      fullLeft,
      fullRight,
      croppedLeft,
      croppedRight,
      processBlocks: processBlocks.map(({ inputOffset, inputFrames, outputOffset, outputFrames }) =>
        ({ inputOffset: seekFrames + inputOffset, inputFrames, outputOffset, outputFrames })),
    };
  } finally {
    session.dispose();
  }
}

function calculatePadding(inputFrames: number, outputFrames: number, seekFrames: number): { input: number; output: number } {
  const divisor = gcd(inputFrames, outputFrames);
  const inputUnit = inputFrames / divisor;
  const outputUnit = outputFrames / divisor;
  const multiples = Math.ceil(seekFrames / inputUnit);
  return { input: multiples * inputUnit, output: multiples * outputUnit };
}

function gcd(left: number, right: number): number {
  let a = left; let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function makeFixturePcm(frames: number, seed: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const phase = (seed & 0xff) / 8192;
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = 0.24 * Math.sin(2 * Math.PI * 220 * frame / 48_000 + phase);
    right[frame] = 0.18 * Math.sin(2 * Math.PI * 330 * frame / 48_000 + 0.31 - phase);
  }
  if (frames > 1_000) {
    left[137] += 0.5;
    right[frames - 191] -= 0.4;
  }
  return { left, right };
}

function maxAbsError(left: Float32Array, right: Float32Array): number {
  expect(left.length).toBe(right.length);
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) maximum = Math.max(maximum, Math.abs(left[index]! - right[index]!));
  return maximum;
}

function firstAbove(samples: Float32Array, threshold: number): number {
  for (let index = 0; index < samples.length; index += 1) if (Math.abs(samples[index]!) > threshold) return index;
  return -1;
}

function lastAbove(samples: Float32Array, threshold: number): number {
  for (let index = samples.length - 1; index >= 0; index -= 1) if (Math.abs(samples[index]!) > threshold) return index;
  return -1;
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let frame = start; frame < end; frame += 1) sum += samples[frame]! ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
}

function allFinite(samples: Float32Array): boolean {
  for (let frame = 0; frame < samples.length; frame += 1) if (!Number.isFinite(samples[frame])) return false;
  return true;
}

function floatBytes(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeFloatSidecar(path: string, samples: Float32Array): Promise<void> {
  await writeFile(path, floatBytes(samples));
}
