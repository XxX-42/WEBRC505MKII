import type { BrowserSharedDspArtifact } from '../audio/sharedDspGraph';

export type SharedPitchProfile = 'LIVE_MONO' | 'LIVE_POLY' | 'HQ_RENDER';

export const SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES = 8_192;
export const SHARED_PITCH_WASM_MEMORY_BYTES = 64 * 1024 * 1024;
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;
const LIVE_MONO_WINDOW_FRAMES = 4_096;
const LIVE_MONO_MINIMUM_HZ = 40;

export interface SharedPitchProfilePlan {
  profile: SharedPitchProfile;
  kind: 113 | 127;
  channelsPerHandle: 1 | 2;
  stereoHandleCount: 1 | 2;
  maxBlockFrames: number;
  /** Internal Signalsmith analysis block used to bound exact seek/flush scratch. */
  alignmentEngineBlockFrames: number;
  alignmentIntervalFrames: number;
  prepareParameters: readonly number[];
  seed: number;
  latencyModel: 'yin-window-plus-psola-lookahead' | 'signalsmith-input-output-getters';
  supportsOfflineDurationChange: boolean;
}

export interface PitchStretchBlock {
  inputOffset: number;
  inputFrames: number;
  outputOffset: number;
  outputFrames: number;
}

export interface SignalsmithExactRenderPlan {
  inputFrames: number;
  outputFrames: number;
  playbackRate: number;
  seekInputFrames: number;
  processInputFrames: number;
  processOutputFrames: number;
  flushOutputFrames: number;
}

export interface SharedPitchRenderMemoryEstimate {
  /** Input PCM retained by the caller while the render is running. */
  callerSourcePcmBytes: number;
  /** Isolated Worker copy of the caller-owned input, transferred by ownership. */
  sourcePcmBytes: number;
  resultPcmBytes: number;
  /** Short-clip leading/trailing pad and extended render buffer, when needed. */
  alignmentPcmBytes: number;
  wasmInstanceBytes: number;
  wasmTransferBytes: number;
  peakBytes: number;
}

export interface SharedPitchRenderRequest {
  artifact: BrowserSharedDspArtifact;
  profile: SharedPitchProfile;
  sampleRate: number;
  seed: number;
  playbackRate: number;
  left: Float32Array;
  right: Float32Array;
  /** Whole render budget, including retained caller PCM; reserve other project buffers first. */
  maxMemoryBytes: number;
  /** Reverse the transferred worker-owned copies before seek/process. */
  reverse?: boolean;
  liveMonoWorkBudget?: number;
  signal?: AbortSignal;
}

export interface SharedPitchRenderResult {
  profile: SharedPitchProfile;
  sampleRate: number;
  inputFrames: number;
  outputFrames: number;
  playbackRate: number;
  left: Float32Array;
  right: Float32Array;
  wasmSha256: string;
  sourceSetSha256: string;
  alignment: 'signalsmith-exact-output-seek-flush';
  latency: { inputSamples: number; outputSamples: number };
}

export interface SharedPitchWorkerPort {
  onmessage: ((event: MessageEvent<SharedPitchWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: SharedPitchWorkerJob, transfer: Transferable[]): void;
  terminate(): void;
}

export interface SharedPitchWorkerJob {
  type: 'RENDER_SHARED_PITCH';
  requestId: number;
  module: WebAssembly.Module;
  wasmSha256: string;
  sourceSetSha256: string;
  profile: SharedPitchProfile;
  sampleRate: number;
  seed: number;
  inputFrames: number;
  outputFrames: number;
  /** Exact N/M rate after the requested duration is rounded to whole frames. */
  playbackRate: number;
  maxMemoryBytes: number;
  reverse: boolean;
  left: ArrayBuffer;
  right: ArrayBuffer;
}

export type SharedPitchWorkerReply =
  | {
      type: 'SHARED_PITCH_RENDERED';
      requestId: number;
      profile: SharedPitchProfile;
      sampleRate: number;
      inputFrames: number;
      outputFrames: number;
      playbackRate: number;
      wasmSha256: string;
      sourceSetSha256: string;
      alignment: 'signalsmith-exact-output-seek-flush';
      latency: { inputSamples: number; outputSamples: number };
      left: ArrayBuffer;
      right: ArrayBuffer;
    }
  | { type: 'SHARED_PITCH_RENDER_FAILED'; requestId: number; code: string; message: string };

export class SharedPitchRenderError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'SharedPitchRenderError';
    this.code = code;
  }
}

/**
 * Resolve the exact tuples used by the shared C++ profile builder. A mono
 * profile is represented by two independent mono handles for stereo material;
 * it is not a hidden stereo downmix. Its use for offline tempo conversion is
 * deliberately disallowed because kind 127 keeps duration fixed.
 */
export function makeSharedPitchProfilePlan(
  profile: SharedPitchProfile,
  sampleRate: number,
  seed: number,
  liveMonoWorkBudget = 32_768,
): SharedPitchProfilePlan {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError('Shared pitch profile sample rate must be between 8 kHz and 192 kHz.');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('Shared pitch seed must be an unsigned 32-bit integer.');
  }
  const stableSeed = seed & 0x7fff_ffff;
  if (profile === 'LIVE_MONO') {
    if (!Number.isInteger(liveMonoWorkBudget) || liveMonoWorkBudget < LIVE_MONO_WINDOW_FRAMES || liveMonoWorkBudget > 1_000_000) {
      throw new RangeError('LIVE_MONO work budget is outside the prepared profile bounds.');
    }
    if (Math.ceil(sampleRate / LIVE_MONO_MINIMUM_HZ) > LIVE_MONO_WINDOW_FRAMES) {
      throw new RangeError('LIVE_MONO 4096-frame analysis window cannot cover the configured 40 Hz minimum at this sample rate.');
    }
    return {
      profile,
      kind: 127,
      channelsPerHandle: 1,
      stereoHandleCount: 2,
      maxBlockFrames: SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES,
      alignmentEngineBlockFrames: 4_096,
      alignmentIntervalFrames: 1_024,
      prepareParameters: [LIVE_MONO_WINDOW_FRAMES, 512, liveMonoWorkBudget, LIVE_MONO_MINIMUM_HZ, 1_000, 0.15],
      seed: stableSeed,
      latencyModel: 'yin-window-plus-psola-lookahead',
      supportsOfflineDurationChange: false,
    };
  }
  if (profile === 'LIVE_POLY') {
    return {
      profile,
      kind: 113,
      channelsPerHandle: 2,
      stereoHandleCount: 1,
      maxBlockFrames: SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES,
      alignmentEngineBlockFrames: 4_096,
      alignmentIntervalFrames: 1_024,
      prepareParameters: [1, 2, 4_096, 1_024, 1],
      seed: stableSeed,
      latencyModel: 'signalsmith-input-output-getters',
      supportsOfflineDurationChange: true,
    };
  }
  if (profile === 'HQ_RENDER') {
    return {
      profile,
      kind: 113,
      channelsPerHandle: 2,
      stereoHandleCount: 1,
      maxBlockFrames: SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES,
      prepareParameters: [2, 2, 16_384, 1_024, 0],
      alignmentEngineBlockFrames: 16_384,
      alignmentIntervalFrames: 1_024,
      seed: stableSeed,
      latencyModel: 'signalsmith-input-output-getters',
      supportsOfflineDurationChange: true,
    };
  }
  throw new TypeError('Unknown shared pitch profile.');
}

/** Exact chunk schedule with bounded input/output blocks and exact total frames. */
export function* iteratePitchStretchBlocks(
  inputFrames: number,
  outputFrames: number,
  maxBlockFrames = SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES,
): Generator<PitchStretchBlock> {
  if (!Number.isSafeInteger(inputFrames) || inputFrames < 1 ||
      !Number.isSafeInteger(outputFrames) || outputFrames < 1 ||
      !Number.isInteger(maxBlockFrames) || maxBlockFrames < 1 || maxBlockFrames > SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES) {
    throw new RangeError('Pitch render block plan has invalid frame counts or block limit.');
  }
  const calls = Math.max(Math.ceil(inputFrames / maxBlockFrames), Math.ceil(outputFrames / maxBlockFrames));
  if (calls > Math.min(inputFrames, outputFrames)) {
    throw new RangeError('Pitch render cannot partition both sides into non-empty bounded callbacks.');
  }
  const inputBase = Math.floor(inputFrames / calls);
  const inputRemainder = inputFrames % calls;
  const outputBase = Math.floor(outputFrames / calls);
  const outputRemainder = outputFrames % calls;
  let inputOffset = 0;
  let outputOffset = 0;
  for (let index = 0; index < calls; index += 1) {
    const blockInputFrames = inputBase + (index < inputRemainder ? 1 : 0);
    const blockOutputFrames = outputBase + (index < outputRemainder ? 1 : 0);
    if (blockInputFrames < 1 || blockOutputFrames < 1 ||
        blockInputFrames > maxBlockFrames || blockOutputFrames > maxBlockFrames) {
      throw new RangeError('Pitch render partition contains an invalid callback size.');
    }
    yield { inputOffset, inputFrames: blockInputFrames, outputOffset, outputFrames: blockOutputFrames };
    inputOffset += blockInputFrames;
    outputOffset += blockOutputFrames;
  }
  if (inputOffset !== inputFrames || outputOffset !== outputFrames) {
    throw new RangeError('Pitch render partition did not cover the requested input and output exactly.');
  }
}

/** Mirror Signalsmith's pinned `exact()` seek/process/flush frame accounting. */
export function makeSignalsmithExactRenderPlan(
  inputFrames: number,
  outputFrames: number,
  seekInputFrames: number,
): SignalsmithExactRenderPlan {
  if (!Number.isSafeInteger(inputFrames) || inputFrames < 1 ||
      !Number.isSafeInteger(outputFrames) || outputFrames < 1 ||
      !Number.isSafeInteger(seekInputFrames) || seekInputFrames < 1) {
    throw new RangeError('Signalsmith exact render frame counts must be positive safe integers.');
  }
  if (inputFrames < seekInputFrames) {
    throw new SharedPitchRenderError('SOURCE_TOO_SHORT_FOR_ALIGNMENT',
      `Source has ${inputFrames} frames but Signalsmith start alignment needs ${seekInputFrames}.`);
  }
  const playbackRate = inputFrames / outputFrames;
  if (!Number.isFinite(playbackRate) || playbackRate < MIN_PLAYBACK_RATE || playbackRate > MAX_PLAYBACK_RATE) {
    throw new RangeError('Signalsmith exact render ratio must be between 0.25 and 4.');
  }
  const processOutputFrames = Math.trunc(outputFrames - seekInputFrames / playbackRate);
  if (processOutputFrames < 1 || processOutputFrames > outputFrames) {
    throw new SharedPitchRenderError('ALIGNMENT_PLAN_INVALID', 'Signalsmith seek consumes the full render output.');
  }
  return {
    inputFrames,
    outputFrames,
    playbackRate,
    seekInputFrames,
    processInputFrames: inputFrames - seekInputFrames,
    processOutputFrames,
    flushOutputFrames: outputFrames - processOutputFrames,
  };
}

/** Conservative peak estimate for a one-track worker bounce including its 64 MiB module. */
export function estimateSharedPitchRenderMemory(inputFrames: number, outputFrames: number,
                                                seekFrames: number, flushFrames: number,
                                                maxBlockFrames = SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES,
                                                shortInputPadFrames = 0,
                                                shortOutputPadFrames = 0): SharedPitchRenderMemoryEstimate {
  const values = [inputFrames, outputFrames, seekFrames, flushFrames, maxBlockFrames,
    shortInputPadFrames, shortOutputPadFrames];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      inputFrames < 1 || outputFrames < 1 || maxBlockFrames < 1 ||
      maxBlockFrames > SHARED_PITCH_RENDER_MAX_BLOCK_FRAMES) {
    throw new RangeError('Shared pitch render memory estimate has invalid frame counts.');
  }
  if (shortInputPadFrames > 0 && shortOutputPadFrames === 0) {
    throw new RangeError('Short-source input padding requires matching output padding.');
  }
  const callerSourcePcmBytes = inputFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
  const sourcePcmBytes = inputFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
  const resultPcmBytes = outputFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
  const alignmentPcmBytes = shortInputPadFrames === 0 ? 0 :
    (2 * shortInputPadFrames + outputFrames + 2 * shortOutputPadFrames) *
    2 * Float32Array.BYTES_PER_ELEMENT;
  const wasmTransferBytes = (7 + 4 * maxBlockFrames + 2 * seekFrames + 2 * flushFrames) * Float32Array.BYTES_PER_ELEMENT;
  const peakBytes = callerSourcePcmBytes + sourcePcmBytes + resultPcmBytes + alignmentPcmBytes +
    SHARED_PITCH_WASM_MEMORY_BYTES + wasmTransferBytes;
  if (![callerSourcePcmBytes, sourcePcmBytes, resultPcmBytes, alignmentPcmBytes, wasmTransferBytes, peakBytes]
    .every(Number.isSafeInteger)) {
    throw new RangeError('Shared pitch render memory estimate exceeded JavaScript safe integer bounds.');
  }
  return {
    callerSourcePcmBytes,
    sourcePcmBytes,
    resultPcmBytes,
    alignmentPcmBytes,
    wasmInstanceBytes: SHARED_PITCH_WASM_MEMORY_BYTES,
    wasmTransferBytes,
    peakBytes,
  };
}

let nextRequestId = 0;

/** Render one independent stereo track in an isolated Worker-owned WASM instance. */
export function renderSharedPitchInWorker(
  request: SharedPitchRenderRequest,
  workerFactory: () => SharedPitchWorkerPort = createSharedPitchWorker,
): Promise<SharedPitchRenderResult> {
  const plan = makeSharedPitchProfilePlan(request.profile, request.sampleRate, request.seed,
    request.liveMonoWorkBudget);
  if (!plan.supportsOfflineDurationChange) {
    throw new SharedPitchRenderError('PROFILE_NOT_OFFLINE_STRETCH',
      'LIVE_MONO is a fixed-duration mono resynthesis route; this Worker only renders duration-changing stereo Signalsmith profiles.');
  }
  validateRenderRequest(request);
  const inputFrames = request.left.length;
  const outputFrames = Math.max(1, Math.ceil(inputFrames / request.playbackRate));
  const playbackRate = inputFrames / outputFrames;
  const maxAlignmentFrames = getMaxAlignmentFrames(plan);
  const needsShortClipPadding = inputFrames < maxAlignmentFrames;
  const maximumInputPadding = needsShortClipPadding ? maxAlignmentFrames + inputFrames : 0;
  const maximumOutputPadding = needsShortClipPadding
    ? Math.ceil(maximumInputPadding / MIN_PLAYBACK_RATE) : 0;
  const estimate = estimateSharedPitchRenderMemory(inputFrames, outputFrames, maxAlignmentFrames, maxAlignmentFrames,
    plan.maxBlockFrames, maximumInputPadding, maximumOutputPadding);
  if (estimate.peakBytes > request.maxMemoryBytes) {
    throw new SharedPitchRenderError('MEMORY_BUDGET_EXCEEDED',
      `Pitch bounce worker needs an estimated ${estimate.peakBytes} bytes, above the ${request.maxMemoryBytes}-byte budget.`);
  }
  if (request.signal?.aborted) throw new SharedPitchRenderError('ABORTED', 'Shared pitch bounce was cancelled before worker setup.');

  const worker = workerFactory();
  const requestId = (nextRequestId = (nextRequestId + 1) >>> 0 || 1);
  const leftCopy = request.left.slice();
  const rightCopy = request.right.slice();
  return new Promise<SharedPitchRenderResult>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      request.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(new SharedPitchRenderError('ABORTED', 'Shared pitch bounce Worker was terminated after cancellation.'));
    worker.onmessage = (event): void => {
      const reply = event.data;
      if (!reply || reply.requestId !== requestId) return;
      if (reply.type === 'SHARED_PITCH_RENDER_FAILED') {
        fail(new SharedPitchRenderError(reply.code, reply.message));
        return;
      }
      if (reply.type !== 'SHARED_PITCH_RENDERED' || reply.profile !== request.profile ||
          reply.sampleRate !== request.sampleRate || reply.inputFrames !== inputFrames || reply.outputFrames !== outputFrames ||
          reply.playbackRate !== inputFrames / outputFrames ||
          reply.wasmSha256 !== request.artifact.sha256 || reply.sourceSetSha256 !== request.artifact.sourceSetSha256 ||
          reply.alignment !== 'signalsmith-exact-output-seek-flush' ||
          !(reply.left instanceof ArrayBuffer) || !(reply.right instanceof ArrayBuffer) ||
          reply.left.byteLength !== outputFrames * 4 || reply.right.byteLength !== outputFrames * 4 ||
          !reply.latency || !Number.isSafeInteger(reply.latency.inputSamples) || !Number.isSafeInteger(reply.latency.outputSamples)) {
        fail(new SharedPitchRenderError('INVALID_WORKER_REPLY', 'Shared pitch Worker reply did not match the requested render and loaded module identity.'));
        return;
      }
      const left = new Float32Array(reply.left);
      const right = new Float32Array(reply.right);
      if (!isFinitePcm(left) || !isFinitePcm(right)) {
        fail(new SharedPitchRenderError('NONFINITE_RENDER_OUTPUT', 'Shared pitch Worker produced non-finite PCM samples.'));
        return;
      }
      cleanup();
      resolve({
        profile: reply.profile,
        sampleRate: reply.sampleRate,
        inputFrames: reply.inputFrames,
        outputFrames: reply.outputFrames,
        playbackRate: reply.playbackRate,
        left,
        right,
        wasmSha256: reply.wasmSha256,
        sourceSetSha256: reply.sourceSetSha256,
        alignment: reply.alignment,
        latency: reply.latency,
      });
    };
    worker.onerror = (event): void => fail(new SharedPitchRenderError('WORKER_ERROR', event.message || 'Shared pitch render Worker failed.'));
    worker.onmessageerror = (): void => fail(new SharedPitchRenderError('WORKER_MESSAGE_ERROR', 'Shared pitch Worker reply could not be deserialized.'));
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    const message: SharedPitchWorkerJob = {
      type: 'RENDER_SHARED_PITCH', requestId,
      module: request.artifact.module,
      wasmSha256: request.artifact.sha256,
      sourceSetSha256: request.artifact.sourceSetSha256,
      profile: request.profile,
      sampleRate: request.sampleRate,
      seed: plan.seed,
      inputFrames,
      outputFrames,
      playbackRate,
      maxMemoryBytes: request.maxMemoryBytes,
      reverse: request.reverse === true,
      left: leftCopy.buffer,
      right: rightCopy.buffer,
    };
    try {
      worker.postMessage(message, [leftCopy.buffer, rightCopy.buffer]);
    } catch (error) {
      fail(error instanceof Error ? error : new SharedPitchRenderError('WORKER_POST_FAILED', String(error)));
    }
  });
}

export function getMaxAlignmentFrames(plan: SharedPitchProfilePlan): number {
  const maximum = plan.alignmentEngineBlockFrames * 5 + plan.alignmentIntervalFrames * 4 + 8;
  if (!Number.isSafeInteger(maximum) || maximum < plan.maxBlockFrames || maximum > 1_000_000) {
    throw new RangeError('Shared pitch alignment bound is invalid.');
  }
  return maximum;
}

function validateRenderRequest(request: SharedPitchRenderRequest): void {
  if (!request || !(request.artifact?.module instanceof WebAssembly.Module) ||
      !/^[a-f0-9]{64}$/.test(request.artifact.sha256) || !/^[a-f0-9]{64}$/.test(request.artifact.sourceSetSha256)) {
    throw new TypeError('Shared pitch render requires a verified compiled WASM artifact identity.');
  }
  if (request.reverse !== undefined && typeof request.reverse !== 'boolean') {
    throw new TypeError('Shared pitch reverse flag must be a boolean when supplied.');
  }
  if (!Number.isFinite(request.playbackRate) || request.playbackRate < MIN_PLAYBACK_RATE || request.playbackRate > MAX_PLAYBACK_RATE) {
    throw new RangeError('Shared pitch playback rate must be between 0.25 and 4.');
  }
  if (!(request.left instanceof Float32Array) || !(request.right instanceof Float32Array) ||
      request.left.length < 1 || request.left.length !== request.right.length) {
    throw new TypeError('Shared pitch render requires equal non-empty left and right Float32Array sources.');
  }
  if (!Number.isFinite(request.sampleRate) || request.left.length > 259_200_000 ||
      !Number.isSafeInteger(request.maxMemoryBytes) || request.maxMemoryBytes < 1) {
    throw new RangeError('Shared pitch render sample rate, frame count, or memory budget is invalid.');
  }
}

function createSharedPitchWorker(): SharedPitchWorkerPort {
  if (typeof Worker === 'undefined') throw new SharedPitchRenderError('WORKER_UNAVAILABLE', 'This environment does not support module Workers.');
  return new Worker(new URL('./sharedPitchRender.worker.ts', import.meta.url), { type: 'module' }) as SharedPitchWorkerPort;
}

function isFinitePcm(samples: Float32Array): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) return false;
  }
  return true;
}
