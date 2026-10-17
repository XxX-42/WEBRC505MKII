import { describe, expect, it } from 'vitest';
import { calculateWavLayout, encodeWav, encodeWavBlob } from '../../src/audio/export/wavEncoder';

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function readInt24(bytes: Uint8Array, offset: number): number {
  const unsigned = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  return (unsigned & 0x80_0000) !== 0 ? unsigned - 0x1_000000 : unsigned;
}

describe('WAV encoder', () => {
  it('writes canonical RIFF/PCM16 headers with the correct rate, alignment, and stereo interleaving', () => {
    const bytes = encodeWav(
      [new Float32Array([0.25, 0.75]), new Float32Array([-0.25, -0.75])],
      { sampleRate: 48_000 },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(fourCc(bytes, 0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(fourCc(bytes, 8)).toBe('WAVE');
    expect(fourCc(bytes, 12)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // WAVE_FORMAT_PCM
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(192_000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(fourCc(bytes, 36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(8);
    expect([...Array(4)].map((_, index) => view.getInt16(44 + index * 2, true))).toEqual([
      8192, -8192, 24575, -24576,
    ]);
    expect(bytes).toHaveLength(52);
  });

  it('encodes PCM24 extrema, rounds deterministically, clips finite samples, and pads odd data chunks', () => {
    const bytes = encodeWav(
      [new Float64Array([-1, -0.5, 0.5, 1, 2])],
      { sampleRate: 44_100, format: 'pcm24' },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(132_300);
    expect(view.getUint16(32, true)).toBe(3);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(15);
    expect([0, 1, 2, 3, 4].map((index) => readInt24(bytes, 44 + index * 3))).toEqual([
      -8_388_608, -4_194_304, 4_194_304, 8_388_607, 8_388_607,
    ]);
    expect(bytes[59]).toBe(0); // one-byte RIFF padding after the odd-sized data chunk
    expect(view.getUint32(4, true)).toBe(52); // includes the padding byte
    expect(bytes).toHaveLength(60);
  });

  it('writes IEEE Float32 format with a fact chunk, sanitizes non-finite input, and preserves headroom', () => {
    const bytes = encodeWav(
      [new Float32Array([Number.NaN, Number.NEGATIVE_INFINITY, -2, 0.5, Number.POSITIVE_INFINITY, 2])],
      { sampleRate: 96_000, format: 'float32' },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(bytes).toHaveLength(80);
    expect(fourCc(bytes, 36)).toBe('fact');
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getUint32(44, true)).toBe(6);
    expect(fourCc(bytes, 48)).toBe('data');
    expect(view.getUint32(52, true)).toBe(24);
    expect(view.getUint16(20, true)).toBe(3); // WAVE_FORMAT_IEEE_FLOAT
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(28, true)).toBe(384_000);
    expect([...Array(6)].map((_, index) => view.getFloat32(56 + index * 4, true))).toEqual([
      0, 0, -2, 0.5, 0, 2,
    ]);
  });

  it('supports empty mono files and validates dimensions and RIFF bounds before allocation', () => {
    const empty = encodeWav([new Float32Array(0)], { sampleRate: 8_000 });
    expect(empty).toHaveLength(44);
    expect(new DataView(empty.buffer).getUint32(40, true)).toBe(0);
    expect(calculateWavLayout(1, 1, 48_000, 'pcm24')).toMatchObject({
      headerBytes: 44,
      dataBytes: 3,
      paddingBytes: 1,
      riffSize: 40,
      fileBytes: 48,
    });

    expect(() => encodeWav([], { sampleRate: 48_000 })).toThrow(/one or two channels/);
    expect(() => encodeWav([new Float32Array(1), new Float32Array(2)], { sampleRate: 48_000 }))
      .toThrow(/same number of frames/);
    expect(() => calculateWavLayout(0, 3, 48_000)).toThrow(/one or two channels/);
    expect(() => calculateWavLayout(0, 1, 0)).toThrow(/sampleRate/);
    expect(() => calculateWavLayout(0, 1, 48_000, 'pcm8' as never)).toThrow(/Unsupported WAV sample format/);
    expect(() => calculateWavLayout(0xffff_ffff, 2, 48_000)).toThrow(/data chunk/);
    expect(() => calculateWavLayout(0, 2, 0xffff_ffff)).toThrow(/byteRate/);
  });

  it('offers a browser Blob wrapper with an audio/wav MIME type and matching byte length', () => {
    const blob = encodeWavBlob([new Float32Array([0])], { sampleRate: 22_050 });
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(encodeWav([new Float32Array([0])], { sampleRate: 22_050 }).byteLength);
  });
});
