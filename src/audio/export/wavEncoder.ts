/** Supported sample encodings for an uncompressed RIFF/WAVE file. */
export type WavSampleFormat = 'pcm16' | 'pcm24' | 'float32';

export interface WavEncodeOptions {
  /** Integer samples per second, stored in the RIFF header. */
  sampleRate: number;
  /** Defaults to signed little-endian PCM16. */
  format?: WavSampleFormat;
}

export interface WavLayout {
  readonly format: WavSampleFormat;
  readonly channelCount: 1 | 2;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly bitsPerSample: 16 | 24 | 32;
  readonly bytesPerSample: 2 | 3 | 4;
  readonly blockAlign: number;
  readonly byteRate: number;
  readonly headerBytes: 44 | 56;
  readonly dataBytes: number;
  readonly paddingBytes: 0 | 1;
  readonly riffSize: number;
  readonly fileBytes: number;
}

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * Validates WAVE dimensions and computes the complete RIFF layout without
 * allocating audio storage. This is useful for callers that need to reject a
 * large export before starting an offline render.
 */
export function calculateWavLayout(
  frameCount: number,
  channelCount: number,
  sampleRate: number,
  format: WavSampleFormat = 'pcm16',
): WavLayout {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('WAV frameCount must be a non-negative safe integer');
  }
  if (channelCount !== 1 && channelCount !== 2) {
    throw new RangeError('WAV export supports exactly one or two channels');
  }
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > UINT32_MAX) {
    throw new RangeError('WAV sampleRate must be an integer from 1 to 4294967295 Hz');
  }
  if (format !== 'pcm16' && format !== 'pcm24' && format !== 'float32') {
    throw new TypeError(`Unsupported WAV sample format: ${String(format)}`);
  }

  const bitsPerSample = format === 'pcm16' ? 16 : format === 'pcm24' ? 24 : 32;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channelCount * bytesPerSample;
  if (blockAlign > UINT16_MAX) throw new RangeError('WAV blockAlign exceeds the RIFF field limit');

  const byteRate = sampleRate * blockAlign;
  if (!Number.isSafeInteger(byteRate) || byteRate > UINT32_MAX) {
    throw new RangeError('WAV byteRate exceeds the RIFF field limit');
  }

  const dataBytes = frameCount * blockAlign;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > UINT32_MAX) {
    throw new RangeError('WAV data chunk exceeds the RIFF 32-bit size limit');
  }

  const paddingBytes = (dataBytes % 2) as 0 | 1;
  const headerBytes = format === 'float32' ? 56 : 44;
  const fileBytes = headerBytes + dataBytes + paddingBytes;
  const riffSize = fileBytes - 8;
  if (!Number.isSafeInteger(fileBytes) || riffSize > UINT32_MAX) {
    throw new RangeError('WAV file exceeds the RIFF 32-bit size limit');
  }
  if (format === 'float32' && frameCount > UINT32_MAX) {
    throw new RangeError('WAV fact sample count exceeds its 32-bit field limit');
  }

  return {
    format,
    channelCount,
    sampleRate,
    frameCount,
    bitsPerSample: bitsPerSample as WavLayout['bitsPerSample'],
    bytesPerSample: bytesPerSample as WavLayout['bytesPerSample'],
    blockAlign,
    byteRate,
    headerBytes,
    dataBytes,
    paddingBytes,
    riffSize,
    fileBytes,
  };
}

/**
 * Encodes planar channel data into a standards-compliant little-endian RIFF /
 * WAVE byte array. The encoder is deterministic and independent of Web Audio.
 *
 * Non-finite input samples are replaced with silence. Integer PCM is clipped
 * to [-1, 1] before quantization; Float32 preserves finite headroom beyond
 * that range, clamping only to the largest representable finite Float32 value.
 * PCM conversion uses the full signed integer range (-1 -> minimum, +1 ->
 * maximum) with round-to-nearest, ties away from zero.
 */
export function encodeWav(
  channels: readonly ArrayLike<number>[],
  options: WavEncodeOptions,
): Uint8Array {
  if (channels.length !== 1 && channels.length !== 2) {
    throw new RangeError('WAV export supports exactly one or two channels');
  }
  const frameCount = channels[0]?.length;
  if (frameCount === undefined || !Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('WAV channel data must have a valid frame count');
  }
  for (let channel = 1; channel < channels.length; channel += 1) {
    if (channels[channel]?.length !== frameCount) {
      throw new RangeError('All WAV channels must contain the same number of frames');
    }
  }

  const layout = calculateWavLayout(frameCount, channels.length, options.sampleRate, options.format);
  // Uint8Array construction may still reject a RIFF-valid file if this runtime
  // has a lower allocation cap; preserve the native RangeError for that case.
  const output = new Uint8Array(layout.fileBytes);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  writeFourCc(view, 0, 'RIFF');
  view.setUint32(4, layout.riffSize, true);
  writeFourCc(view, 8, 'WAVE');
  writeFourCc(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, layout.format === 'float32' ? 3 : 1, true);
  view.setUint16(22, layout.channelCount, true);
  view.setUint32(24, layout.sampleRate, true);
  view.setUint32(28, layout.byteRate, true);
  view.setUint16(32, layout.blockAlign, true);
  view.setUint16(34, layout.bitsPerSample, true);

  let dataHeaderOffset = 36;
  if (layout.format === 'float32') {
    writeFourCc(view, 36, 'fact');
    view.setUint32(40, 4, true);
    view.setUint32(44, layout.frameCount, true);
    dataHeaderOffset = 48;
  }
  writeFourCc(view, dataHeaderOffset, 'data');
  view.setUint32(dataHeaderOffset + 4, layout.dataBytes, true);

  const payloadOffset = dataHeaderOffset + 8;
  let offset = payloadOffset;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < layout.channelCount; channel += 1) {
      const channelData = channels[channel];
      if (layout.format === 'pcm16') {
        view.setInt16(offset, quantizePcm(clipPcmSample(channelData?.[frame]), 16), true);
      } else if (layout.format === 'pcm24') {
        writeInt24LittleEndian(view, offset, quantizePcm(clipPcmSample(channelData?.[frame]), 24));
      } else {
        view.setFloat32(offset, finiteFloat32Sample(channelData?.[frame]), true);
      }
      offset += layout.bytesPerSample;
    }
  }
  // Uint8Array is zero-initialized, so any RIFF pad byte is already correct.
  return output;
}

function finiteSampleOrSilence(sample: number | undefined): number {
  if (sample === undefined || !Number.isFinite(sample)) return 0;
  return sample;
}

function clipPcmSample(sample: number | undefined): number {
  const finiteSample = finiteSampleOrSilence(sample);
  return Math.max(-1, Math.min(1, finiteSample));
}

function finiteFloat32Sample(sample: number | undefined): number {
  const finiteSample = finiteSampleOrSilence(sample);
  return Math.max(-FLOAT32_MAX, Math.min(FLOAT32_MAX, finiteSample));
}

function quantizePcm(sample: number, bits: 16 | 24): number {
  const negativeScale = 2 ** (bits - 1);
  const positiveScale = negativeScale - 1;
  const scaled = sample < 0 ? sample * negativeScale : sample * positiveScale;
  return scaled < 0 ? Math.ceil(scaled - 0.5) : Math.floor(scaled + 0.5);
}

function writeInt24LittleEndian(view: DataView, offset: number, value: number): void {
  const unsigned = value < 0 ? value + 0x1_000000 : value;
  view.setUint8(offset, unsigned & 0xff);
  view.setUint8(offset + 1, (unsigned >>> 8) & 0xff);
  view.setUint8(offset + 2, (unsigned >>> 16) & 0xff);
}

function writeFourCc(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/** Browser convenience wrapper; the core encoder itself remains DOM-free. */
export function encodeWavBlob(
  channels: readonly ArrayLike<number>[],
  options: WavEncodeOptions,
): Blob {
  const bytes = encodeWav(channels, options);
  // Copy into an ArrayBuffer-backed view so TS runtimes with SharedArrayBuffer
  // in the Uint8Array generic do not widen the BlobPart type unnecessarily.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'audio/wav' });
}
