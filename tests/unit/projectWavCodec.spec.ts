import { describe, expect, it } from 'vitest';
import {
  decodeWav,
  decodeWavBlobToProjectPcm,
  encodeAudioBufferToNativeWavBlobAsync,
  encodeAudioBufferToProjectWavBlobAsync,
  inspectWavHeader,
  PROJECT_AUDIO_SAMPLE_RATE,
} from '../../src/project/wavCodec';
import { readBlobArrayBuffer } from '../../src/project/blobUtils';

function mockAudioBuffer(sampleRate: number, left: Float32Array, right = left) {
  const channels = [left, right];
  return {
    sampleRate,
    length: left.length,
    numberOfChannels: right === left ? 1 : 2,
    getChannelData: (channel: number) => channels[channel]!,
  };
}

function makePcmWav(bits: 16 | 24 | 32, channels: number, rate: number, samples: number[]): Uint8Array {
  const bytesPerSample = bits / 8;
  const dataLength = samples.length * bytesPerSample;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, bits, true);
  ascii(36, 'data'); view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const value of samples) {
    if (bits === 16) view.setInt16(offset, value, true);
    else if (bits === 24) {
      const sample = value & 0xffffff;
      view.setUint8(offset, sample & 0xff); view.setUint8(offset + 1, (sample >> 8) & 0xff); view.setUint8(offset + 2, (sample >> 16) & 0xff);
    } else view.setInt32(offset, value, true);
    offset += bytesPerSample;
  }
  return bytes;
}

describe('project WAVE codec', () => {
  it('exports external WAV as stereo IEEE float32 at 44.1 kHz with exact RIFF sizes', async () => {
    const left = new Float32Array(48_000);
    const right = new Float32Array(48_000);
    for (let i = 0; i < left.length; i += 1) {
      left[i] = Math.sin(2 * Math.PI * 440 * i / 48_000) * 0.5;
      right[i] = -left[i];
    }
    const blob = await encodeAudioBufferToProjectWavBlobAsync(mockAudioBuffer(48_000, left, right));
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 44_100 * 8);
    const metadata = await inspectWavHeader(blob);
    expect(metadata).toMatchObject({ format: 3, channels: 2, sampleRate: 44_100, frames: 44_100, bitsPerSample: 32 });
    const bytes = new Uint8Array(await readBlobArrayBuffer(blob));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true) + 8).toBe(bytes.length);
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(PROJECT_AUDIO_SAMPLE_RATE);
    expect(view.getUint32(40, true)).toBe(44_100 * 8);
    const settledOutputFrame = 1_000;
    const expected = Math.sin(2 * Math.PI * 440 * settledOutputFrame / 44_100) * 0.5;
    expect(view.getFloat32(44 + settledOutputFrame * 8, true)).toBeCloseTo(expected, 2);
    expect(view.getFloat32(48 + settledOutputFrame * 8, true)).toBeCloseTo(-expected, 2);
  });

  it('stores Memory audio at the native rate and preserves stereo samples without resampling', async () => {
    const left = Float32Array.from([0.125, -0.25, 0.5, -0.75]);
    const right = Float32Array.from([-0.125, 0.25, -0.5, 0.75]);
    const blob = await encodeAudioBufferToNativeWavBlobAsync(mockAudioBuffer(48_000, left, right));
    const metadata = await inspectWavHeader(blob);
    expect(metadata).toMatchObject({ sampleRate: 48_000, frames: 4, channels: 2, format: 3 });
    const decoded = decodeWav(await readBlobArrayBuffer(blob));
    expect(decoded.sampleRate).toBe(PROJECT_AUDIO_SAMPLE_RATE);
    // decodeWav is the external/interchange path; the memory loader preserves
    // the original rate through the Blob-based decoder.
    const native = await decodeWavBlobToProjectPcm(blob, undefined, 48_000);
    expect(native.sampleRate).toBe(48_000);
    expect([...native.left]).toEqual([...left]);
    expect([...native.right]).toEqual([...right]);
  });

  it.each([16, 24, 32] as const)('decodes signed PCM %i-bit WAVE into separate stereo channels', (bits) => {
    const scale = 2 ** (bits - 1);
    const wav = makePcmWav(bits, 2, 44_100, [Math.round(0.5 * scale), Math.round(-0.25 * scale)]);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.frames).toBe(1);
    expect(decoded.left[0]).toBeCloseTo(0.5, 3);
    expect(decoded.right[0]).toBeCloseTo(-0.25, 3);
  });

  it('duplicates a mono input to LR and rejects non-finite Float32 samples', () => {
    const mono = decodeWav(makePcmWav(16, 1, 44_100, [16_384, -16_384]));
    expect([...mono.left]).toEqual([...mono.right]);
    const floatWav = new Uint8Array(52);
    const view = new DataView(floatWav.buffer);
    const ascii = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, 44, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
    view.setUint32(24, 44_100, true); view.setUint32(28, 176_400, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
    ascii(36, 'data'); view.setUint32(40, 4, true); view.setFloat32(44, Number.NaN, true);
    expect(() => decodeWav(floatWav)).toThrow(/non-finite sample/);
  });

  it('preserves frequency and frame duration through 48k→44.1k→48k conversion', async () => {
    const sourceRate = 48_000;
    const sourceFrames = 48_000;
    const left = new Float32Array(sourceFrames);
    for (let i = 0; i < sourceFrames; i += 1) left[i] = Math.sin(2 * Math.PI * 997 * i / sourceRate) * 0.7;
    const externalWav = await encodeAudioBufferToProjectWavBlobAsync(mockAudioBuffer(sourceRate, left));
    const roundTrip = await decodeWavBlobToProjectPcm(externalWav, undefined, sourceRate);
    expect(roundTrip.frames).toBe(sourceFrames);
    let crossings = 0;
    const first = Math.floor(0.1 * sourceRate);
    const last = Math.floor(0.9 * sourceRate);
    for (let i = first + 1; i < last; i += 1) if (roundTrip.left[i - 1]! <= 0 && roundTrip.left[i]! > 0) crossings += 1;
    const measuredFrequency = crossings / ((last - first) / sourceRate);
    expect(measuredFrequency).toBeGreaterThan(995);
    expect(measuredFrequency).toBeLessThan(999);
    const rms = Math.sqrt(roundTrip.left.reduce((sum, sample) => sum + sample * sample, 0) / roundTrip.frames);
    expect(rms).toBeGreaterThan(0.45);
    expect(rms).toBeLessThan(0.55);
  });

  it('rejects malformed RIFF boundaries and oversized project audio before allocation', async () => {
    const wav = new Uint8Array(encodeRiffFloatStub());
    new DataView(wav.buffer).setUint32(4, 0xffff_ffff, true);
    await expect(inspectWavHeader(wav)).rejects.toThrow(/RIFF size/);
  });
});

function encodeRiffFloatStub(): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
  view.setUint32(24, 44_100, true); view.setUint32(28, 352_800, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true);
  ascii(36, 'data'); view.setUint32(40, 0, true);
  return bytes;
}
