import type { OfflinePitchResult } from '../pitch/signalsmith';
import type { NativeHqEngine } from '../NativeBridgeClient';
import { encodeWav } from './wavEncoder';
import { calculateWavLayout, type WavSampleFormat } from './wavEncoder';

export interface HqWavExportOptions {
  readonly sampleRate: number;
  readonly format: WavSampleFormat;
  readonly semitones: number;
  readonly playbackRate: number;
  /** Estimated peak temporary bytes allowed for this export. Defaults to 512 MiB. */
  readonly memoryBudgetBytes?: number;
}

/** Common UI request shape; Browser ignores the optional Native-only renderer choice. */
export interface HqWavExportRequestOptions extends Omit<HqWavExportOptions, 'sampleRate'> {
  readonly nativeHqEngine?: NativeHqEngine;
}

export type HqWavExportSource = 'browser' | 'native';

export interface HqWavMemoryEstimate {
  readonly estimatedPeakBytes: number;
  readonly inputCopyBytes: number;
  readonly renderedOutputBytes: number;
  readonly wasmBlockBufferBytes: number;
  readonly wavTemporaryBytes: number;
  readonly runtimeReserveBytes: number;
}

export const DEFAULT_HQ_WAV_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;
const HQ_WAV_WASM_RUNTIME_RESERVE_BYTES = 64 * 1024 * 1024;
// Signalsmith's preset latency is not available until its WASM module has been
// initialized. Reserve two seconds at the selected sample rate in the
// preflight estimate so the output buffer can be admitted before that module
// allocates it.
const HQ_WAV_LATENCY_RESERVE_SECONDS = 2;
const HQ_WAV_RENDER_CHUNK_FRAMES = 128;

/**
 * Estimates the known temporary export working set before channel copies or
 * HQ_RENDER output buffers are allocated. Browser source AudioBuffer memory is
 * retained by playback and therefore excluded. Native's UI path uses this
 * estimate before requesting C++ rendering; it conservatively reserves extra
 * loop-sized memory for the interleaved PCM response and deinterleaved channels.
 *
 * This is a conservative admission estimate, not an OS-level memory limit:
 * browser/WASM allocator overhead and concurrent application memory vary.
 */
export function estimateHqWavExportMemory(
  inputFrames: number,
  channelCount: number,
  sampleRate: number,
  playbackRate: number,
  format: WavSampleFormat,
  source: HqWavExportSource = 'browser',
): HqWavMemoryEstimate {
  if (!Number.isSafeInteger(inputFrames) || inputFrames <= 0) {
    throw new RangeError('HQ WAV export requires a non-empty input buffer');
  }
  if (channelCount !== 1 && channelCount !== 2) {
    throw new RangeError('HQ WAV export supports one or two channels');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RangeError('sampleRate must be between 8 kHz and 192 kHz');
  }
  if (!Number.isFinite(playbackRate) || playbackRate < 0.5 || playbackRate > 2) {
    throw new RangeError('playbackRate must be between 0.5 and 2');
  }
  if (source !== 'browser' && source !== 'native') {
    throw new TypeError(`Unsupported HQ WAV export source: ${String(source)}`);
  }

  const outputFrames = Math.ceil(inputFrames / playbackRate);
  const latencyReserveFrames = Math.ceil(sampleRate * HQ_WAV_LATENCY_RESERVE_SECONDS);
  const estimatedRenderFrames = outputFrames + latencyReserveFrames;
  const estimatedFile = calculateWavLayout(outputFrames, channelCount, sampleRate, format);
  const samplesBytes = inputFrames * channelCount * Float32Array.BYTES_PER_ELEMENT;
  // Native's UI-side estimate reserves a third PCM-sized copy for the
  // big-endian fallback, where the response bytes are decoded into a separate
  // Float32Array before the stereo deinterleave.
  const inputCopyBytes = samplesBytes * (source === 'native' ? 3 : 1);
  const renderedOutputBytes = estimatedRenderFrames * channelCount * Float32Array.BYTES_PER_ELEMENT;
  const maxInputFrames = Math.ceil(HQ_WAV_RENDER_CHUNK_FRAMES * Math.max(playbackRate, 1)) + 1;
  const wasmBufferFrames = Math.max(HQ_WAV_RENDER_CHUNK_FRAMES, maxInputFrames);
  const wasmBlockBufferBytes = channelCount * 2 * wasmBufferFrames * Float32Array.BYTES_PER_ELEMENT;
  // encodeWav's result and the worker's exact-size transferable copy coexist
  // briefly; account for both.
  const wavTemporaryBytes = estimatedFile.fileBytes * 2;
  const estimatedPeakBytes = inputCopyBytes + renderedOutputBytes + wasmBlockBufferBytes
    + wavTemporaryBytes + HQ_WAV_WASM_RUNTIME_RESERVE_BYTES;
  if (![inputCopyBytes, renderedOutputBytes, wasmBlockBufferBytes, wavTemporaryBytes, estimatedPeakBytes]
    .every(Number.isSafeInteger)) {
    throw new RangeError('HQ WAV export memory estimate exceeds the safe integer range');
  }

  return Object.freeze({
    estimatedPeakBytes,
    inputCopyBytes,
    renderedOutputBytes,
    wasmBlockBufferBytes,
    wavTemporaryBytes,
    runtimeReserveBytes: HQ_WAV_WASM_RUNTIME_RESERVE_BYTES,
  });
}

/** Rejects a render before creating a Worker or allocating channel/render/WAV buffers. */
export function assertHqWavExportMemoryBudget(
  inputFrames: number,
  channelCount: number,
  options: HqWavExportOptions,
  source: HqWavExportSource = 'browser',
): HqWavMemoryEstimate {
  const budgetBytes = options.memoryBudgetBytes ?? DEFAULT_HQ_WAV_MEMORY_BUDGET_BYTES;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new RangeError('HQ WAV export memory budget must be a positive safe integer number of bytes');
  }
  const estimate = estimateHqWavExportMemory(
    inputFrames,
    channelCount,
    options.sampleRate,
    options.playbackRate,
    options.format,
    source,
  );
  if (estimate.estimatedPeakBytes > budgetBytes) {
    const toMiB = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    throw new RangeError(
      `HQ WAV export needs an estimated ${toMiB(estimate.estimatedPeakBytes)} of temporary memory, `
      + `above the ${toMiB(budgetBytes)} export budget. Raise the export memory budget or reduce the loop length; `
      + 'the recording has not been changed.',
    );
  }
  return estimate;
}

export interface HqWavExportResult extends HqWavExportOptions {
  readonly mode: 'HQ_RENDER';
  readonly bytes: Uint8Array;
  readonly frameCount: number;
  readonly leadingLatencySamples: number;
}

/**
 * Removes algorithmic delay from an HQ_RENDER buffer before encoding. The
 * Signalsmith render is padded by its leading latency; exports intentionally
 * keep exactly the duration implied by the selected playback rate so loop
 * lengths remain deterministic.
 */
export function encodeAlignedHqWav(
  rendered: OfflinePitchResult,
  inputFrames: number,
  format: WavSampleFormat,
): HqWavExportResult {
  if (!Number.isSafeInteger(inputFrames) || inputFrames <= 0) {
    throw new RangeError('HQ WAV export requires a non-empty input buffer');
  }
  if (!Number.isSafeInteger(rendered.leadingLatencySamples) || rendered.leadingLatencySamples < 0) {
    throw new RangeError('HQ_RENDER returned an invalid leading latency');
  }
  if (rendered.channels.length < 1 || rendered.channels.length > 2) {
    throw new RangeError('HQ WAV export supports one or two channels');
  }
  const frameCount = Math.ceil(inputFrames / rendered.playbackRate);
  const start = rendered.leadingLatencySamples;
  const end = start + frameCount;
  if (rendered.channels.some((channel) => channel.length < end)) {
    throw new RangeError('HQ_RENDER output is shorter than its reported aligned duration');
  }
  const alignedChannels = rendered.channels.map((channel) => channel.subarray(start, end));
  const bytes = encodeWav(alignedChannels, { sampleRate: rendered.sampleRate, format });
  return Object.freeze({
    mode: 'HQ_RENDER' as const,
    bytes,
    sampleRate: rendered.sampleRate,
    format,
    semitones: rendered.semitones,
    playbackRate: rendered.playbackRate,
    frameCount,
    leadingLatencySamples: start,
  });
}

export interface HqWavWorkerRequest {
  readonly type: 'render';
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
  readonly semitones: number;
  readonly playbackRate: number;
  readonly format: WavSampleFormat;
  readonly memoryBudgetBytes: number;
}

export type HqWavWorkerResponse =
  | { readonly type: 'progress'; readonly fraction: number }
  | {
      readonly type: 'complete';
      readonly bytes: ArrayBuffer;
      readonly sampleRate: number;
      readonly format: WavSampleFormat;
      readonly semitones: number;
      readonly playbackRate: number;
      readonly frameCount: number;
      readonly leadingLatencySamples: number;
    }
  | { readonly type: 'error'; readonly message: string };

/**
 * Runs Signalsmith's synchronous HQ_RENDER and RIFF encoding in a dedicated
 * module worker so long renders do not block playback controls or Vue's UI.
 */
export function createHqWavExport(
  channels: readonly Float32Array[],
  options: HqWavExportOptions,
  onProgress?: (fraction: number) => void,
): Promise<HqWavExportResult> {
  if (typeof Worker === 'undefined') {
    return Promise.reject(new Error('HQ WAV export requires Web Worker support'));
  }
  if (channels.length < 1 || channels.length > 2) {
    return Promise.reject(new RangeError('HQ WAV export supports one or two channels'));
  }
  const frameCount = channels[0]?.length ?? 0;
  if (frameCount <= 0 || channels.some((channel) => channel.length !== frameCount)) {
    return Promise.reject(new RangeError('HQ WAV export channels must be non-empty and equal in length'));
  }
  if (!Number.isFinite(options.semitones) || options.semitones < -24 || options.semitones > 24) {
    return Promise.reject(new RangeError('semitones must be between -24 and +24'));
  }
  if (!Number.isFinite(options.playbackRate) || options.playbackRate < 0.5 || options.playbackRate > 2) {
    return Promise.reject(new RangeError('playbackRate must be between 0.5 and 2'));
  }
  if (!Number.isInteger(options.sampleRate) || options.sampleRate < 8_000 || options.sampleRate > 192_000) {
    return Promise.reject(new RangeError('sampleRate must be between 8 kHz and 192 kHz'));
  }
  try {
    assertHqWavExportMemoryBudget(frameCount, channels.length, options, 'browser');
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./hq-wav-export.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not start HQ WAV export worker'));
      return;
    }

    const finish = () => {
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<HqWavWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.fraction);
        return;
      }
      finish();
      if (message.type === 'error') {
        reject(new Error(message.message));
        return;
      }
      resolve(Object.freeze({
        mode: 'HQ_RENDER' as const,
        bytes: new Uint8Array(message.bytes),
        sampleRate: message.sampleRate,
        format: message.format,
        semitones: message.semitones,
        playbackRate: message.playbackRate,
        frameCount: message.frameCount,
        leadingLatencySamples: message.leadingLatencySamples,
      }));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'HQ WAV export worker failed'));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error('HQ WAV export worker returned an unreadable message'));
    };

    // AudioBuffer-owned storage must not be detached from the playing track.
    const workerChannels = channels.map((channel) => new Float32Array(channel));
    const transfer = workerChannels.map((channel) => channel.buffer);
    const request: HqWavWorkerRequest = {
      type: 'render',
      channels: workerChannels,
      sampleRate: options.sampleRate,
      semitones: options.semitones,
      playbackRate: options.playbackRate,
      format: options.format,
      memoryBudgetBytes: options.memoryBudgetBytes ?? DEFAULT_HQ_WAV_MEMORY_BUDGET_BYTES,
    };
    worker.postMessage(request, transfer);
  });
}
