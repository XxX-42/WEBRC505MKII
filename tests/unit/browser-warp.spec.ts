import { describe, expect, it } from 'vitest';
import { BrowserWarpDsp } from '../../src/audio/fx/dsp/BrowserWarpDsp';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

function makeTone(frames: number, sampleRate: number, frequency: number): [Float32Array, Float32Array] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = 0.4 * Math.sin(2 * Math.PI * frequency * frame / sampleRate);
    right[frame] = 0.3 * Math.sin(2 * Math.PI * frequency * frame / sampleRate + 0.3);
  }
  return [left, right];
}

function runChunked(
  input: readonly [Float32Array, Float32Array],
  chunks: readonly number[],
  parameters: { bpm: number; captureBeats: number; smearPercent: number; pitchSemitones: number; feedbackPercent: number; frozen: boolean },
): [Float32Array, Float32Array] {
  const dsp = new BrowserWarpDsp(8000, parameters);
  const output: [Float32Array, Float32Array] = [new Float32Array(input[0].length), new Float32Array(input[1].length)];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < input[0].length) {
    const count = Math.min(chunks[chunkIndex % chunks.length] ?? 1, input[0].length - offset);
    const left = input[0].subarray(offset, offset + count);
    const right = input[1].subarray(offset, offset + count);
    const outLeft = output[0].subarray(offset, offset + count);
    const outRight = output[1].subarray(offset, offset + count);
    dsp.processBlock(left, right, outLeft, outRight);
    offset += count;
    chunkIndex += 1;
  }
  return output;
}

describe('Browser WARP experimental granular capture and FDN8', () => {
  it('allocates fixed capture capacity at the supported maximum sample rate', () => {
    const warp = new BrowserWarpDsp(192000, { bpm: 30, captureBeats: 4 });
    expect(warp.maxCaptureFrames).toBe(192000 * 8);
    // Four Float32 capture arrays: two stereo banks, about 23.44 MiB.
    expect(warp.maxCaptureFrames * 4 * Float32Array.BYTES_PER_ELEMENT).toBe(24_576_000);
  });

  it('waits for a complete tempo-sized capture, then holds the captured bank until released', () => {
    const warp = new BrowserWarpDsp(8000, {
      bpm: 300,
      captureBeats: 0.25,
      smearPercent: 40,
      pitchSemitones: 5,
      feedbackPercent: 70,
      frozen: true,
    });
    const left = new Float32Array(400);
    const right = new Float32Array(400);
    left.fill(0.25);
    right.fill(-0.2);
    const outLeft = new Float32Array(400);
    const outRight = new Float32Array(400);
    warp.processBlock(left.subarray(0, 399), right.subarray(0, 399), outLeft.subarray(0, 399), outRight.subarray(0, 399));
    expect(warp.isFrozen).toBe(false);
    expect(warp.hasPendingFreeze).toBe(true);
    warp.processBlock(left.subarray(399), right.subarray(399), outLeft.subarray(399), outRight.subarray(399));
    expect(warp.isFrozen).toBe(true);
    expect(warp.hasPendingFreeze).toBe(false);
    expect(warp.activeCaptureFrames).toBe(400);
    expect(warp.captureCount).toBe(1);
    warp.setParameters({ frozen: false });
    expect(warp.isFrozen).toBe(false);
  });

  it('is independent of callback chunking with tempo-synced capture and freeze', () => {
    const input = makeTone(12000, 8000, 330);
    const params = { bpm: 300, captureBeats: 0.25, smearPercent: 60, pitchSemitones: -7, feedbackPercent: 80, frozen: true };
    const whole = runChunked(input, [12000], params);
    const irregular = runChunked(input, [1, 7, 93, 256, 17, 512], params);
    expect(irregular[0]).toEqual(whole[0]);
    expect(irregular[1]).toEqual(whole[1]);
    expect(whole[0].some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
    expect(whole[0].every(Number.isFinite)).toBe(true);
    expect(whole[1].every(Number.isFinite)).toBe(true);
    expect(Math.max(...whole[0].slice(400))).toBeLessThanOrEqual(8);
    expect(Math.min(...whole[0].slice(400))).toBeGreaterThanOrEqual(-8);
  });

  it('clamps feedback, handles non-finite input, and resets deterministically', () => {
    const warp = new BrowserWarpDsp(8000, { bpm: 300, captureBeats: 0.25, feedbackPercent: 95, frozen: false });
    const source = new Float32Array(4096);
    for (let i = 0; i < source.length; i += 1) source[i] = i === 0 ? Number.POSITIVE_INFINITY : 0.8;
    const left = new Float32Array(source.length);
    const right = new Float32Array(source.length);
    warp.processBlock(source, source, left, right);
    expect(left.every(Number.isFinite)).toBe(true);
    expect(right.every(Number.isFinite)).toBe(true);
    expect(Math.max(...left)).toBeLessThanOrEqual(8);
    expect(Math.min(...left)).toBeGreaterThanOrEqual(-8);
    warp.reset();
    const replayLeft = new Float32Array(source.length);
    const replayRight = new Float32Array(source.length);
    warp.processBlock(source, source, replayLeft, replayRight);
    expect(replayLeft).toEqual(left);
    expect(replayRight).toEqual(right);
  });

  it('keeps core wet mix bounded and bypass exact-dry', () => {
    const input = makeTone(2048, 8000, 440);
    const bypassed = new BrowserFxDspCore('warp', 8000, { bpm: 300, captureBeats: 0.25, mix: 2 });
    bypassed.setBypass(true);
    const bypassLeft = new Float32Array(input[0].length);
    const bypassRight = new Float32Array(input[1].length);
    bypassed.processBlock(input[0], input[1], bypassLeft, bypassRight);
    expect(bypassLeft).toEqual(input[0]);
    expect(bypassRight).toEqual(input[1]);

    // Values above 1 are clamped at the core boundary; the experimental wet
    // path remains finite and inside its explicit state/output bound.
    const active = new BrowserFxDspCore('warp', 8000, {
      bpm: 300, captureBeats: 0.25, smearPercent: 100,
      pitchSemitones: 24, feedbackPercent: 95, mix: 2,
    });
    const outputLeft = new Float32Array(input[0].length);
    const outputRight = new Float32Array(input[1].length);
    active.processBlock(input[0], input[1], outputLeft, outputRight);
    expect(outputLeft.every(Number.isFinite)).toBe(true);
    expect(outputRight.every(Number.isFinite)).toBe(true);
    expect(Math.max(...outputLeft)).toBeLessThanOrEqual(8);
    expect(Math.min(...outputLeft)).toBeGreaterThanOrEqual(-8);
    expect(Math.max(...outputRight)).toBeLessThanOrEqual(8);
    expect(Math.min(...outputRight)).toBeGreaterThanOrEqual(-8);
  });
});
