import { isBlobLike, readBlobArrayBuffer } from './blobUtils';

export const PROJECT_AUDIO_SAMPLE_RATE = 44_100;
export const PROJECT_AUDIO_CHANNELS = 2;
// Explicit resource policy: up to 90 minutes at 48 kHz in the engine model,
// with a 512 MiB default per encoded asset. Callers may raise the byte limit
// where the browser's storage quota and memory budget permit it.
export const PROJECT_AUDIO_MAX_FRAMES = 259_200_000;
export const PROJECT_AUDIO_MAX_WAV_BYTES = 512 * 1024 * 1024;
const MIN_SUPPORTED_SAMPLE_RATE = 8_000;
const MAX_SUPPORTED_SAMPLE_RATE = 192_000;
const SINC_HALF_TAPS = 16;
const MAX_POLYPHASES = 4096;
const kernelCache = new Map<string, { phases: number; numerator: number; denominator: number; weights: Float64Array }>();

export interface StereoPcm {
  sampleRate: number;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}

export interface AudioBufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface WavMetadata {
  format: number;
  channels: 1 | 2;
  sampleRate: number;
  frames: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
}

function assertSampleRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || !Number.isInteger(sampleRate) || sampleRate < MIN_SUPPORTED_SAMPLE_RATE || sampleRate > MAX_SUPPORTED_SAMPLE_RATE) {
    throw new RangeError(`Sample rate must be an integer from ${MIN_SUPPORTED_SAMPLE_RATE} to ${MAX_SUPPORTED_SAMPLE_RATE} Hz.`);
  }
}

function assertFrameCount(frames: number): void {
  if (!Number.isInteger(frames) || frames < 0 || frames > PROJECT_AUDIO_MAX_FRAMES) {
    throw new RangeError(`Audio frame count exceeds the ${PROJECT_AUDIO_MAX_FRAMES}-frame project limit.`);
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function assertFiniteSamples(samples: Float32Array, label: string): void {
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) throw new TypeError(`${label} contains a non-finite sample at frame ${index}.`);
  }
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-9) return 1;
  const x = Math.PI * value;
  return Math.sin(x) / x;
}

function blackman(index: number, taps: number): number {
  if (taps <= 1) return 1;
  const phase = index / (taps - 1);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * phase) + 0.08 * Math.cos(4 * Math.PI * phase);
}

/** Band-limited per-channel resampling. Output is capped before allocation. */
export function resampleMono(input: Float32Array, sourceRate: number, destinationRate = PROJECT_AUDIO_SAMPLE_RATE): Float32Array {
  assertSampleRate(sourceRate);
  assertSampleRate(destinationRate);
  assertFrameCount(input.length);
  if (sourceRate === destinationRate) return Float32Array.from(input, finiteOrZero);

  const outputFrames = Math.round(input.length * destinationRate / sourceRate);
  assertFrameCount(outputFrames);
  const output = new Float32Array(outputFrames);
  if (input.length === 0) return output;

  // The cutoff scales during downsampling, preventing frequencies above the
  // destination Nyquist limit from folding into the audible band.
  resampleRangeInto(input, sourceRate, destinationRate, 0, output);
  return output;
}

export function normalizeStereoPcm(input: {
  sampleRate: number;
  left: Float32Array;
  right?: Float32Array | null;
}): StereoPcm {
  assertSampleRate(input.sampleRate);
  const frames = input.left.length;
  assertFrameCount(frames);
  if (input.right && input.right.length !== frames) throw new RangeError('Stereo channels must have the same frame count.');
  assertFiniteSamples(input.left, 'Left channel');
  if (input.right) assertFiniteSamples(input.right, 'Right channel');
  const right = input.right ?? input.left;
  return {
    sampleRate: input.sampleRate,
    frames,
    left: Float32Array.from(input.left, finiteOrZero),
    right: Float32Array.from(right, finiteOrZero),
  };
}

export function convertStereoPcmToProjectFormat(input: StereoPcm): StereoPcm {
  assertFrameCount(input.frames);
  if (input.left.length !== input.frames || input.right.length !== input.frames) throw new RangeError('PCM frame count does not match channel buffers.');
  const left = resampleMono(input.left, input.sampleRate, PROJECT_AUDIO_SAMPLE_RATE);
  const right = resampleMono(input.right, input.sampleRate, PROJECT_AUDIO_SAMPLE_RATE);
  if (left.length !== right.length) throw new RangeError('Resampled stereo channels have different frame counts.');
  if (left.length * 8 + 44 > PROJECT_AUDIO_MAX_WAV_BYTES) throw new RangeError('Resampled audio exceeds the configured per-asset resource limit.');
  return { sampleRate: PROJECT_AUDIO_SAMPLE_RATE, frames: left.length, left, right };
}

export function audioBufferToProjectPcm(buffer: AudioBufferLike): StereoPcm {
  assertSampleRate(buffer.sampleRate);
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new RangeError('Project audio supports mono or stereo source buffers only.');
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels === 1 ? left : buffer.getChannelData(1);
  return convertStereoPcmToProjectFormat(normalizeStereoPcm({ sampleRate: buffer.sampleRate, left, right }));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
}

export function encodeFloat32StereoWav(pcm: StereoPcm): Uint8Array {
  if (pcm.sampleRate !== PROJECT_AUDIO_SAMPLE_RATE) throw new RangeError(`WAV project assets must be ${PROJECT_AUDIO_SAMPLE_RATE} Hz.`);
  if (pcm.left.length !== pcm.frames || pcm.right.length !== pcm.frames) throw new RangeError('PCM frame count does not match channel buffers.');
  assertFrameCount(pcm.frames);
  assertFiniteSamples(pcm.left, 'Left channel');
  assertFiniteSamples(pcm.right, 'Right channel');
  const dataBytes = pcm.frames * PROJECT_AUDIO_CHANNELS * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(dataBytes) || dataBytes + 44 > PROJECT_AUDIO_MAX_WAV_BYTES) throw new RangeError('WAV asset exceeds the project size limit.');

  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, PROJECT_AUDIO_CHANNELS, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * PROJECT_AUDIO_CHANNELS * Float32Array.BYTES_PER_ELEMENT, true);
  view.setUint16(32, PROJECT_AUDIO_CHANNELS * Float32Array.BYTES_PER_ELEMENT, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < pcm.frames; frame += 1) {
    view.setFloat32(offset, finiteOrZero(pcm.left[frame]!), true);
    view.setFloat32(offset + 4, finiteOrZero(pcm.right[frame]!), true);
    offset += 8;
  }
  return bytes;
}

function makeFloat32StereoHeader(dataBytes: number, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

function resampleRange(input: Float32Array, sourceRate: number, outputStart: number, outputCount: number): Float32Array {
  const output = new Float32Array(outputCount);
  if (sourceRate === PROJECT_AUDIO_SAMPLE_RATE) {
    output.set(input.subarray(outputStart, outputStart + outputCount));
    for (let i = 0; i < output.length; i += 1) output[i] = finiteOrZero(output[i]!);
    return output;
  }
  resampleRangeInto(input, sourceRate, PROJECT_AUDIO_SAMPLE_RATE, outputStart, output);
  return output;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = a;
  let right = b;
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function getPolyphaseKernel(sourceRate: number, destinationRate: number) {
  const key = `${sourceRate}:${destinationRate}`;
  const cached = kernelCache.get(key);
  if (cached) return cached;
  const divisor = greatestCommonDivisor(sourceRate, destinationRate);
  const numerator = sourceRate / divisor;
  const denominator = destinationRate / divisor;
  const phases = Math.min(MAX_POLYPHASES, denominator);
  const taps = SINC_HALF_TAPS * 2;
  const weights = new Float64Array(phases * taps);
  const cutoff = Math.min(1, destinationRate / sourceRate) * 0.94;
  for (let phase = 0; phase < phases; phase += 1) {
    const fraction = phase / phases;
    let sum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = (tap - SINC_HALF_TAPS + 1) - fraction;
      const weight = cutoff * sinc(distance * cutoff) * blackman(tap, taps);
      weights[phase * taps + tap] = weight;
      sum += weight;
    }
    if (sum !== 0) {
      for (let tap = 0; tap < taps; tap += 1) {
        const index = phase * taps + tap;
        weights[index] = weights[index]! / sum;
      }
    }
  }
  const result = { phases, numerator, denominator, weights };
  kernelCache.set(key, result);
  return result;
}

function resampleRangeInto(
  input: Float32Array,
  sourceRate: number,
  destinationRate: number,
  outputStart: number,
  output: Float32Array,
  inputFrameOffset = 0,
): void {
  const kernel = getPolyphaseKernel(sourceRate, destinationRate);
  const taps = SINC_HALF_TAPS * 2;
  const ratio = sourceRate / destinationRate;
  for (let local = 0; local < output.length; local += 1) {
    const outputIndex = outputStart + local;
    const center = outputIndex * ratio - inputFrameOffset;
    let centerFrame = Math.floor(center);
    const fraction = center - centerFrame;
    let phase = Math.round(fraction * kernel.phases);
    if (phase >= kernel.phases) { phase = 0; centerFrame += 1; }
    const first = centerFrame - SINC_HALF_TAPS + 1;
    const weightOffset = phase * taps;
    let sum = 0;
    let edgeWeightSum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const sourceIndex = first + tap;
      const weight = kernel.weights[weightOffset + tap]!;
      if (sourceIndex < 0 || sourceIndex >= input.length) continue;
      sum += finiteOrZero(input[sourceIndex]!) * weight;
      edgeWeightSum += weight;
    }
    output[local] = edgeWeightSum === 0 ? 0 : sum / edgeWeightSum;
  }
}

/** Chunked WAVE writer for long loops. It avoids building a second full PCM
 * copy while keeping the final asset as a Blob suitable for IndexedDB. */
export function encodeAudioBufferToProjectWavBlob(buffer: AudioBufferLike, maxWavBytes = PROJECT_AUDIO_MAX_WAV_BYTES): Blob {
  return encodeAudioBufferToProjectWavBlobChunks(buffer, maxWavBytes);
}

function encodeAudioBufferToProjectWavBlobChunks(buffer: AudioBufferLike, maxWavBytes: number): Blob {
  assertSampleRate(buffer.sampleRate);
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new RangeError('Project audio supports mono or stereo source buffers only.');
  assertFrameCount(buffer.length);
  const outputFrames = Math.round(buffer.length * PROJECT_AUDIO_SAMPLE_RATE / buffer.sampleRate);
  assertFrameCount(outputFrames);
  const dataBytes = outputFrames * 8;
  if (!Number.isSafeInteger(dataBytes) || dataBytes + 44 > maxWavBytes || dataBytes + 44 > 0xffff_ffff) {
    throw new RangeError(`WAV asset exceeds the configured ${maxWavBytes}-byte resource limit.`);
  }
  const leftInput = buffer.getChannelData(0);
  const rightInput = buffer.numberOfChannels === 1 ? leftInput : buffer.getChannelData(1);
  assertFiniteSamples(leftInput, 'Left channel');
  if (buffer.numberOfChannels === 2) assertFiniteSamples(rightInput, 'Right channel');
  const parts: BlobPart[] = [toArrayBufferPart(makeFloat32StereoHeader(dataBytes, PROJECT_AUDIO_SAMPLE_RATE))];
  const framesPerChunk = 16_384;
  for (let start = 0; start < outputFrames; start += framesPerChunk) {
    const count = Math.min(framesPerChunk, outputFrames - start);
    const left = resampleRange(leftInput, buffer.sampleRate, start, count);
    const right = resampleRange(rightInput, buffer.sampleRate, start, count);
    const interleaved = new Uint8Array(count * 8);
    const view = new DataView(interleaved.buffer);
    for (let frame = 0, offset = 0; frame < count; frame += 1, offset += 8) {
      view.setFloat32(offset, finiteOrZero(left[frame]!), true);
      view.setFloat32(offset + 4, finiteOrZero(right[frame]!), true);
    }
    parts.push(toArrayBufferPart(interleaved));
  }
  return new Blob(parts, { type: 'audio/wav' });
}

/** Async long-loop encoder. It yields between 16k-frame chunks so memory
 * serialization cannot monopolize the browser main thread for a whole loop. */
export async function encodeAudioBufferToProjectWavBlobAsync(
  buffer: AudioBufferLike,
  maxWavBytes = PROJECT_AUDIO_MAX_WAV_BYTES,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  assertSampleRate(buffer.sampleRate);
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new RangeError('Project audio supports mono or stereo source buffers only.');
  assertFrameCount(buffer.length);
  const outputFrames = Math.round(buffer.length * PROJECT_AUDIO_SAMPLE_RATE / buffer.sampleRate);
  assertFrameCount(outputFrames);
  const dataBytes = outputFrames * 8;
  if (!Number.isSafeInteger(dataBytes) || dataBytes + 44 > maxWavBytes || dataBytes + 44 > 0xffff_ffff) {
    throw new RangeError(`WAV asset exceeds the configured ${maxWavBytes}-byte resource limit.`);
  }
  const leftInput = buffer.getChannelData(0);
  const rightInput = buffer.numberOfChannels === 1 ? leftInput : buffer.getChannelData(1);
  assertFiniteSamples(leftInput, 'Left channel');
  if (buffer.numberOfChannels === 2) assertFiniteSamples(rightInput, 'Right channel');

  const parts: BlobPart[] = [toArrayBufferPart(makeFloat32StereoHeader(dataBytes, PROJECT_AUDIO_SAMPLE_RATE))];
  const framesPerChunk = 16_384;
  for (let start = 0; start < outputFrames; start += framesPerChunk) {
    const count = Math.min(framesPerChunk, outputFrames - start);
    const left = resampleRange(leftInput, buffer.sampleRate, start, count);
    const right = resampleRange(rightInput, buffer.sampleRate, start, count);
    const interleaved = new Uint8Array(count * 8);
    const view = new DataView(interleaved.buffer);
    for (let frame = 0, offset = 0; frame < count; frame += 1, offset += 8) {
      view.setFloat32(offset, left[frame]!, true);
      view.setFloat32(offset + 4, right[frame]!, true);
    }
    parts.push(toArrayBufferPart(interleaved));
    onProgress?.((start + count) / Math.max(1, outputFrames));
    if (start + count < outputFrames) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Blob(parts, { type: 'audio/wav' });
}

/** Lossless internal WAVE storage for 99Memory and project bundles. */
export async function encodeAudioBufferToNativeWavBlobAsync(
  buffer: AudioBufferLike,
  maxWavBytes = PROJECT_AUDIO_MAX_WAV_BYTES,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  assertSampleRate(buffer.sampleRate);
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new RangeError('Project audio supports mono or stereo source buffers only.');
  assertFrameCount(buffer.length);
  const dataBytes = buffer.length * 8;
  if (!Number.isSafeInteger(dataBytes) || dataBytes + 44 > maxWavBytes || dataBytes + 44 > 0xffff_ffff) {
    throw new RangeError(`Native-rate WAV asset exceeds the configured ${maxWavBytes}-byte resource limit.`);
  }
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels === 1 ? left : buffer.getChannelData(1);
  assertFiniteSamples(left, 'Left channel');
  if (buffer.numberOfChannels === 2) assertFiniteSamples(right, 'Right channel');
  const parts: BlobPart[] = [toArrayBufferPart(makeFloat32StereoHeader(dataBytes, buffer.sampleRate))];
  const framesPerChunk = 16_384;
  for (let start = 0; start < buffer.length; start += framesPerChunk) {
    const count = Math.min(framesPerChunk, buffer.length - start);
    const bytes = new Uint8Array(count * 8);
    const view = new DataView(bytes.buffer);
    for (let frame = 0, offset = 0; frame < count; frame += 1, offset += 8) {
      view.setFloat32(offset, left[start + frame]!, true);
      view.setFloat32(offset + 4, right[start + frame]!, true);
    }
    parts.push(toArrayBufferPart(bytes));
    onProgress?.((start + count) / Math.max(1, buffer.length));
    if (start + count < buffer.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return new Blob(parts, { type: 'audio/wav' });
}

function toArrayBufferPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = '';
  for (let i = 0; i < length; i += 1) result += String.fromCharCode(view.getUint8(offset + i));
  return result;
}

/** Reads and validates chunk metadata without loading a long WAV payload. */
export async function inspectWavHeader(input: Blob | ArrayBuffer | Uint8Array, maxWavBytes = PROJECT_AUDIO_MAX_WAV_BYTES): Promise<WavMetadata> {
  const size = isBlobLike(input) ? input.size : input.byteLength;
  if (!Number.isSafeInteger(maxWavBytes) || maxWavBytes < 44 || size < 44 || size > maxWavBytes) throw new RangeError('WAV file size is outside the configured resource limit.');
  const prefix = isBlobLike(input)
    ? new Uint8Array(await readBlobArrayBuffer(input.slice(0, Math.min(size, 65_536))))
    : input instanceof Uint8Array ? input.subarray(0, Math.min(size, 65_536)) : new Uint8Array(input, 0, Math.min(size, 65_536));
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new TypeError('File is not a RIFF/WAVE document.');
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd !== size) throw new RangeError('WAV RIFF size does not match the file size.');
  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let blockAlign: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= prefix.byteLength;) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const end = body + chunkSize;
    if (end > riffEnd) throw new RangeError(`WAV ${chunkId} chunk exceeds the RIFF boundary.`);
    if (chunkId === 'fmt ') {
      if (chunkSize < 16 || body + 16 > prefix.byteLength) throw new TypeError('WAV fmt chunk is truncated or too far into the file.');
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 'data' && dataOffset === null) {
      dataOffset = body;
      dataBytes = chunkSize;
    }
    if ((chunkId === 'fmt ' || chunkId === 'data') && end > prefix.byteLength) break;
    offset = end + (chunkSize & 1);
  }
  if (format === null || channels === null || sampleRate === null || blockAlign === null || bitsPerSample === null || dataOffset === null) {
    throw new TypeError('WAV must contain fmt and data chunks in the first 64 KiB.');
  }
  assertSampleRate(sampleRate);
  if (channels !== 1 && channels !== 2) throw new RangeError('Only mono and stereo WAV sources are supported.');
  if (!((format === 3 && bitsPerSample === 32) || (format === 1 && [8, 16, 24, 32].includes(bitsPerSample)))) throw new TypeError('Unsupported WAV encoding.');
  const expectedAlign = channels * bitsPerSample / 8;
  if (blockAlign !== expectedAlign || dataBytes % blockAlign !== 0 || dataOffset + dataBytes > riffEnd) throw new TypeError('WAV data chunk is misaligned or truncated.');
  const frames = dataBytes / blockAlign;
  assertFrameCount(frames);
  return { format, channels, sampleRate, frames, bitsPerSample, dataOffset, dataBytes };
}

function decodePcmValue(view: DataView, offset: number, format: number, bits: number): number {
  if (format === 3 && bits === 32) {
    const sample = view.getFloat32(offset, true);
    if (!Number.isFinite(sample)) throw new TypeError('WAV float audio contains a non-finite sample.');
    return sample;
  }
  if (format !== 1) throw new TypeError('Only uncompressed PCM and IEEE float WAV files are supported.');
  if (bits === 8) return (view.getUint8(offset) - 128) / 128;
  if (bits === 16) return view.getInt16(offset, true) / 32768;
  if (bits === 24) {
    let value = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  }
  if (bits === 32) return view.getInt32(offset, true) / 2147483648;
  throw new TypeError(`Unsupported WAV PCM bit depth: ${bits}.`);
}

export function decodeWav(input: ArrayBuffer | Uint8Array): StereoPcm {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 44 || bytes.byteLength > PROJECT_AUDIO_MAX_WAV_BYTES) throw new RangeError('WAV file size is outside the supported range.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new TypeError('File is not a RIFF/WAVE document.');
  const declaredEnd = view.getUint32(4, true) + 8;
  if (declaredEnd !== bytes.byteLength) throw new RangeError('WAV RIFF size does not match the file size.');
  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let blockAlign: number | null = null;
  let dataOffset: number | null = null;
  let dataBytes = 0;

  for (let offset = 12; offset + 8 <= declaredEnd;) {
    const id = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const end = body + chunkSize;
    if (end > declaredEnd || end > bytes.byteLength) throw new RangeError(`WAV ${id} chunk exceeds the file boundary.`);
    if (id === 'fmt ') {
      if (chunkSize < 16) throw new TypeError('WAV fmt chunk is truncated.');
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data' && dataOffset === null) {
      dataOffset = body;
      dataBytes = chunkSize;
    }
    offset = end + (chunkSize & 1);
  }

  if (format === null || channels === null || sampleRate === null || bitsPerSample === null || blockAlign === null || dataOffset === null) {
    throw new TypeError('WAV must contain fmt and data chunks.');
  }
  assertSampleRate(sampleRate);
  if (channels !== 1 && channels !== 2) throw new RangeError('Only mono and stereo WAV sources are supported.');
  if (!((format === 3 && bitsPerSample === 32) || (format === 1 && [8, 16, 24, 32].includes(bitsPerSample)))) {
    throw new TypeError(`Unsupported WAV encoding ${format} at ${bitsPerSample} bits.`);
  }
  const bytesPerSample = bitsPerSample / 8;
  if (blockAlign !== channels * bytesPerSample || dataBytes % blockAlign !== 0) throw new TypeError('WAV block alignment is invalid.');
  const frames = dataBytes / blockAlign;
  assertFrameCount(frames);
  const left = new Float32Array(frames);
  const right = channels === 2 ? new Float32Array(frames) : left;
  for (let frame = 0, cursor = dataOffset; frame < frames; frame += 1) {
    left[frame] = decodePcmValue(view, cursor, format, bitsPerSample);
    if (channels === 2) right[frame] = decodePcmValue(view, cursor + bytesPerSample, format, bitsPerSample);
    cursor += blockAlign;
  }
  return convertStereoPcmToProjectFormat({ sampleRate, frames, left, right });
}

/** Incrementally decodes a WAV Blob, resampling one 16k output-frame tile at a
 * time and yielding to the browser between tiles. */
export async function decodeWavBlobToProjectPcm(
  blob: Blob,
  onProgress?: (fraction: number) => void,
  destinationRate = PROJECT_AUDIO_SAMPLE_RATE,
  maxDecodedBytes = PROJECT_AUDIO_MAX_WAV_BYTES,
): Promise<StereoPcm> {
  const metadata = await inspectWavHeader(blob, maxDecodedBytes);
  assertSampleRate(destinationRate);
  const outputFrames = Math.round(metadata.frames * destinationRate / metadata.sampleRate);
  assertFrameCount(outputFrames);
  if (outputFrames * 8 + 44 > maxDecodedBytes) throw new RangeError('Decoded audio exceeds the configured per-asset resource limit.');
  const left = new Float32Array(outputFrames);
  const right = new Float32Array(outputFrames);
  const framesPerChunk = 16_384;
  const sourceBytesPerFrame = metadata.channels * metadata.bitsPerSample / 8;

  for (let outputStart = 0; outputStart < outputFrames; outputStart += framesPerChunk) {
    const outputCount = Math.min(framesPerChunk, outputFrames - outputStart);
    const firstSource = Math.max(0, Math.floor(outputStart * metadata.sampleRate / destinationRate) - SINC_HALF_TAPS - 1);
    const lastSource = Math.min(metadata.frames, Math.ceil((outputStart + outputCount) * metadata.sampleRate / destinationRate) + SINC_HALF_TAPS + 1);
    const sourceFrames = lastSource - firstSource;
    const sourceBytes = new Uint8Array(await readBlobArrayBuffer(blob.slice(
      metadata.dataOffset + firstSource * sourceBytesPerFrame,
      metadata.dataOffset + lastSource * sourceBytesPerFrame,
    )));
    const sourceView = new DataView(sourceBytes.buffer, sourceBytes.byteOffset, sourceBytes.byteLength);
    const sourceLeft = new Float32Array(sourceFrames);
    const sourceRight = metadata.channels === 1 ? sourceLeft : new Float32Array(sourceFrames);
    for (let frame = 0, cursor = 0; frame < sourceFrames; frame += 1, cursor += sourceBytesPerFrame) {
      sourceLeft[frame] = decodePcmValue(sourceView, cursor, metadata.format, metadata.bitsPerSample);
      if (metadata.channels === 2) sourceRight[frame] = decodePcmValue(sourceView, cursor + metadata.bitsPerSample / 8, metadata.format, metadata.bitsPerSample);
    }
    const leftTile = new Float32Array(outputCount);
    if (metadata.sampleRate === destinationRate) leftTile.set(sourceLeft.subarray(outputStart - firstSource, outputStart - firstSource + outputCount));
    else resampleRangeInto(sourceLeft, metadata.sampleRate, destinationRate, outputStart, leftTile, firstSource);
    left.set(leftTile, outputStart);
    if (metadata.channels === 1) right.set(leftTile, outputStart);
    else {
      const rightTile = new Float32Array(outputCount);
      if (metadata.sampleRate === destinationRate) rightTile.set(sourceRight.subarray(outputStart - firstSource, outputStart - firstSource + outputCount));
      else resampleRangeInto(sourceRight, metadata.sampleRate, destinationRate, outputStart, rightTile, firstSource);
      right.set(rightTile, outputStart);
    }
    onProgress?.((outputStart + outputCount) / Math.max(1, outputFrames));
    if (outputStart + outputCount < outputFrames) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { sampleRate: destinationRate, frames: outputFrames, left, right };
}

export function encodeAudioBufferToProjectWav(buffer: AudioBufferLike): Uint8Array {
  return encodeFloat32StereoWav(audioBufferToProjectPcm(buffer));
}

export function pcmToAudioBuffer(pcm: StereoPcm, context: BaseAudioContext): AudioBuffer {
  const converted = pcm.sampleRate === PROJECT_AUDIO_SAMPLE_RATE ? pcm : convertStereoPcmToProjectFormat(pcm);
  const result = context.createBuffer(2, converted.frames, PROJECT_AUDIO_SAMPLE_RATE);
  result.getChannelData(0).set(converted.left);
  result.getChannelData(1).set(converted.right);
  return result;
}
