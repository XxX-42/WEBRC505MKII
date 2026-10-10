import {
  estimateSharedPitchRenderMemory,
  iteratePitchStretchBlocks,
  makeSharedPitchProfilePlan,
  makeSignalsmithExactRenderPlan,
  SharedPitchRenderError,
  type SharedPitchWorkerJob,
  type SharedPitchWorkerReply,
} from './sharedPitchRender';

export interface ExactPitchStretchSession {
  /** Exact upstream outputSeekLength() result in input-domain frames. */
  outputSeekLength(playbackRate: number): number;
  /** Consumes the leading source window and primes the output stream. */
  outputSeek(left: Float32Array, right: Float32Array, inputOffset: number,
             inputFrames: number, playbackRate: number): void;
  /** Processes paired bounded chunks after the seek window. */
  process(left: Float32Array, right: Float32Array, inputOffset: number,
          inputFrames: number, outputLeft: Float32Array, outputRight: Float32Array,
          outputOffset: number, outputFrames: number): void;
  /** Writes and returns the explicit upstream flush tail length. */
  flush(outputLeft: Float32Array, outputRight: Float32Array, outputOffset: number,
        outputFrames: number, playbackRate: number): number;
  inputLatencySamples(): number;
  outputLatencySamples(): number;
  dispose(): void;
}

export type ExactPitchStretchSessionFactory =
  (job: SharedPitchWorkerJob) => ExactPitchStretchSession | Promise<ExactPitchStretchSession>;

/**
 * Run the exact aligned stretch in an isolated non-audio Worker. Latency getter
 * values are returned as metadata only; alignment comes from outputSeekLength,
 * outputSeek, and flush, matching the pinned Signalsmith `exact()` algorithm.
 */
export async function renderPitchWorkerJobWithSession(
  job: SharedPitchWorkerJob,
  createSession: ExactPitchStretchSessionFactory,
): Promise<Extract<SharedPitchWorkerReply, { type: 'SHARED_PITCH_RENDERED' }>> {
  validateJob(job);
  const profile = makeSharedPitchProfilePlan(job.profile, job.sampleRate, job.seed);
  if (!profile.supportsOfflineDurationChange || profile.kind !== 113 || profile.channelsPerHandle !== 2) {
    throw new SharedPitchRenderError('PROFILE_NOT_OFFLINE_STRETCH', 'This worker requires a stereo Signalsmith profile.');
  }
  const left = new Float32Array(job.left);
  const right = new Float32Array(job.right);
  if (job.reverse) {
    reverseInPlace(left);
    reverseInPlace(right);
  }
  const session = await createSession(job);
  try {
    const seekInputFrames = session.outputSeekLength(job.playbackRate);
    const sourcePlaybackRate = job.inputFrames / job.outputFrames;
    if (sourcePlaybackRate !== job.playbackRate) {
      throw new SharedPitchRenderError('PLAYBACK_RATE_MISMATCH', 'Requested PCM length and exact stretch rate disagree.');
    }
    const padding = job.inputFrames < seekInputFrames
      ? calculateShortClipPadding(job.inputFrames, job.outputFrames, seekInputFrames) : null;
    const renderInputFrames = padding?.paddedInputFrames ?? job.inputFrames;
    const renderOutputFrames = padding?.paddedOutputFrames ?? job.outputFrames;
    const render = makeSignalsmithExactRenderPlan(renderInputFrames, renderOutputFrames, seekInputFrames);
    if (render.playbackRate !== sourcePlaybackRate) {
      throw new SharedPitchRenderError('ALIGNMENT_RATE_CHANGED', 'Short-clip padding changed the requested stretch rate.');
    }
    if (render.processInputFrames < 1 || render.processOutputFrames < 1) {
      throw new SharedPitchRenderError('SOURCE_TOO_SHORT_FOR_PROCESS',
        'The source is too short to leave a process segment after exact alignment pre-roll.');
    }
    const estimate = estimateSharedPitchRenderMemory(job.inputFrames, job.outputFrames,
      render.seekInputFrames, render.flushOutputFrames, profile.maxBlockFrames,
      padding?.inputPadding ?? 0, padding?.outputPadding ?? 0);
    if (estimate.peakBytes > job.maxMemoryBytes) {
      throw new SharedPitchRenderError('MEMORY_BUDGET_EXCEEDED',
        `Aligned pitch render needs ${estimate.peakBytes} bytes, above the ${job.maxMemoryBytes}-byte budget.`);
    }
    const alignment = padding
      ? makeShortClipAlignment(left, right, padding)
      : { inputLeft: left, inputRight: right, inputFrames: job.inputFrames,
          outputFrames: job.outputFrames, outputCropStart: 0 };
    const outputLeft = new Float32Array(alignment.outputFrames);
    const outputRight = new Float32Array(alignment.outputFrames);

    session.outputSeek(alignment.inputLeft, alignment.inputRight, 0, render.seekInputFrames, render.playbackRate);
    for (const block of iteratePitchStretchBlocks(render.processInputFrames, render.processOutputFrames,
      profile.maxBlockFrames)) {
      session.process(alignment.inputLeft, alignment.inputRight, render.seekInputFrames + block.inputOffset,
        block.inputFrames,
        outputLeft, outputRight, block.outputOffset, block.outputFrames);
    }
    const flushedFrames = session.flush(outputLeft, outputRight,
      render.processOutputFrames, render.flushOutputFrames, render.playbackRate);
    if (flushedFrames !== render.flushOutputFrames) {
      throw new SharedPitchRenderError('FLUSH_FRAME_MISMATCH',
        `Signalsmith flush returned ${flushedFrames} frames; ${render.flushOutputFrames} were required.`);
    }
    if (!isFinitePcm(outputLeft) || !isFinitePcm(outputRight)) {
      throw new SharedPitchRenderError('NONFINITE_RENDER_OUTPUT', 'Signalsmith produced non-finite PCM samples.');
    }
    const inputLatencySamples = session.inputLatencySamples();
    const outputLatencySamples = session.outputLatencySamples();
    if (!Number.isSafeInteger(inputLatencySamples) || inputLatencySamples < 0 ||
        !Number.isSafeInteger(outputLatencySamples) || outputLatencySamples < 0) {
      throw new SharedPitchRenderError('INVALID_LATENCY_METADATA', 'Signalsmith latency getters returned invalid metadata.');
    }
    const alignedLeft = alignment.outputCropStart === 0 ? outputLeft :
      outputLeft.slice(alignment.outputCropStart, alignment.outputCropStart + job.outputFrames);
    const alignedRight = alignment.outputCropStart === 0 ? outputRight :
      outputRight.slice(alignment.outputCropStart, alignment.outputCropStart + job.outputFrames);
    if (alignedLeft.length !== job.outputFrames || alignedRight.length !== job.outputFrames) {
      throw new SharedPitchRenderError('ALIGNMENT_CROP_INVALID', 'Short-clip crop did not match the target duration.');
    }
    return {
      type: 'SHARED_PITCH_RENDERED', requestId: job.requestId,
      profile: job.profile, sampleRate: job.sampleRate,
      inputFrames: job.inputFrames, outputFrames: job.outputFrames,
      playbackRate: render.playbackRate,
      wasmSha256: job.wasmSha256, sourceSetSha256: job.sourceSetSha256,
      alignment: 'signalsmith-exact-output-seek-flush',
      latency: { inputSamples: inputLatencySamples, outputSamples: outputLatencySamples },
      left: alignedLeft.buffer, right: alignedRight.buffer,
    };
  } finally {
    session.dispose();
  }
}

interface ShortClipPadding {
  inputPadding: number;
  outputPadding: number;
  inputFrames: number;
  outputFrames: number;
  paddedInputFrames: number;
  paddedOutputFrames: number;
}

/** Plan leading/trailing silence for short sources without allocating first. */
function calculateShortClipPadding(inputFrames: number, outputFrames: number,
                                   seekInputFrames: number): ShortClipPadding {
  const divisor = greatestCommonDivisor(inputFrames, outputFrames);
  const inputUnit = inputFrames / divisor;
  const outputUnit = outputFrames / divisor;
  const paddingUnits = Math.ceil(seekInputFrames / inputUnit);
  const inputPadding = paddingUnits * inputUnit;
  const outputPadding = paddingUnits * outputUnit;
  const paddedInputFrames = inputFrames + 2 * inputPadding;
  const paddedOutputFrames = outputFrames + 2 * outputPadding;
  if (![inputPadding, outputPadding, paddedInputFrames, paddedOutputFrames].every(Number.isSafeInteger) ||
      inputPadding < seekInputFrames || outputPadding < 1 ||
      BigInt(inputPadding) * BigInt(outputFrames) !==
        BigInt(outputPadding) * BigInt(inputFrames)) {
    throw new SharedPitchRenderError('SHORT_CLIP_PADDING_INVALID', 'Could not construct ratio-preserving short-clip padding.');
  }
  return { inputPadding, outputPadding, inputFrames, outputFrames, paddedInputFrames, paddedOutputFrames };
}

/** Allocate the validated short-source silence padding after memory admission. */
function makeShortClipAlignment(left: Float32Array, right: Float32Array,
                                padding: ShortClipPadding) {
  const inputLeft = new Float32Array(padding.paddedInputFrames);
  const inputRight = new Float32Array(padding.paddedInputFrames);
  inputLeft.set(left, padding.inputPadding);
  inputRight.set(right, padding.inputPadding);
  return { inputLeft, inputRight, inputFrames: padding.paddedInputFrames,
    outputFrames: padding.paddedOutputFrames, outputCropStart: padding.outputPadding };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function reverseInPlace(samples: Float32Array): void {
  for (let left = 0, right = samples.length - 1; left < right; left += 1, right -= 1) {
    const value = samples[left]!;
    samples[left] = samples[right]!;
    samples[right] = value;
  }
}

/** Worker message adapter. A failed/unsupported WASM API is always reported explicitly. */
export async function handleSharedPitchWorkerMessage(
  job: SharedPitchWorkerJob,
  postReply: (reply: SharedPitchWorkerReply, transfer?: Transferable[]) => void,
  createSession: ExactPitchStretchSessionFactory,
): Promise<void> {
  try {
    const reply = await renderPitchWorkerJobWithSession(job, createSession);
    postReply(reply, [reply.left, reply.right]);
  } catch (error) {
    const code = error instanceof SharedPitchRenderError ? error.code : 'PITCH_RENDER_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    postReply({ type: 'SHARED_PITCH_RENDER_FAILED', requestId: job?.requestId ?? 0, code, message });
  }
}

function validateJob(job: SharedPitchWorkerJob): void {
  if (!job || job.type !== 'RENDER_SHARED_PITCH' || !(job.module instanceof WebAssembly.Module) ||
      !/^[a-f0-9]{64}$/.test(job.wasmSha256) || !/^[a-f0-9]{64}$/.test(job.sourceSetSha256) ||
      !Number.isSafeInteger(job.requestId) || job.requestId < 1 ||
      !Number.isFinite(job.sampleRate) || job.sampleRate < 8_000 || job.sampleRate > 192_000 ||
      !Number.isInteger(job.seed) || job.seed < 0 || job.seed > 0xffff_ffff ||
      !Number.isSafeInteger(job.inputFrames) || job.inputFrames < 1 ||
      !Number.isSafeInteger(job.outputFrames) || job.outputFrames < 1 ||
      !Number.isFinite(job.playbackRate) || job.playbackRate < 0.25 || job.playbackRate > 4 ||
      typeof job.reverse !== 'boolean' ||
      !Number.isSafeInteger(job.maxMemoryBytes) || job.maxMemoryBytes < 1 ||
      !(job.left instanceof ArrayBuffer) || !(job.right instanceof ArrayBuffer) ||
      job.left.byteLength !== job.inputFrames * Float32Array.BYTES_PER_ELEMENT ||
      job.right.byteLength !== job.inputFrames * Float32Array.BYTES_PER_ELEMENT) {
    throw new SharedPitchRenderError('INVALID_WORKER_REQUEST', 'The shared pitch Worker request failed validation.');
  }
  const exactRate = job.inputFrames / job.outputFrames;
  if (exactRate !== job.playbackRate) {
    throw new SharedPitchRenderError('PLAYBACK_RATE_MISMATCH', 'Worker request rate must equal exact input/output frame ratio.');
  }
}

function isFinitePcm(samples: Float32Array): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) return false;
  }
  return true;
}
