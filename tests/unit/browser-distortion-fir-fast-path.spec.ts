import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

function renderDistortionReferenceFixture(sampleRate: number) {
  const frames = 8_192;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let noise = 0x12345678;
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    noise = (Math.imul(noise, 1_664_525) + 1_013_904_223) | 0;
    const noiseSample = (noise >>> 0) / 0xffff_ffff - 0.5;
    left[frame] = 0.44 * Math.sin((2 * Math.PI * 421 * time))
      + 0.27 * Math.sin((2 * Math.PI * 2_371 * time) + 0.19) + 0.015 * noiseSample;
    right[frame] = 0.37 * Math.sin((2 * Math.PI * 733 * time) + 0.37)
      + 0.21 * Math.sin(2 * Math.PI * 3_139 * time) - 0.013 * noiseSample;
  }
  for (const frame of [0, 63, 512, 1_023, 2_048, 4_095, 6_144]) {
    left[frame] = frame % 2 ? -0.96 : 0.98;
    right[frame] = frame % 2 ? 0.91 : -0.94;
  }

  const outputLeft = new Float32Array(frames);
  const outputRight = new Float32Array(frames);
  const core = new BrowserFxDspCore('distortion', sampleRate, {
    mix: 1,
    driveDb: 24,
    outputDb: -6,
    distortionMode: 'overdrive',
  });
  core.setBypass(false, 0);
  const blockSizes = [1, 7, 127, 64, 3, 257, 511, 19];
  let frame = 0;
  let blockIndex = 0;
  while (frame < frames) {
    if (frame === 1_024) core.setParameters({ driveDb: 31, outputDb: -9, distortionMode: 'fuzz' });
    if (frame === 4_096) core.setParameters({ driveDb: 18, outputDb: -3, distortionMode: 'hard-clip' });
    const nextChange = frame < 1_024 ? 1_024 : frame < 4_096 ? 4_096 : frames;
    const count = Math.min(blockSizes[blockIndex++ % blockSizes.length]!, nextChange - frame, frames - frame);
    core.processBlock(
      left.subarray(frame, frame + count),
      right.subarray(frame, frame + count),
      outputLeft.subarray(frame, frame + count),
      outputRight.subarray(frame, frame + count),
      count,
      false,
    );
    frame += count;
  }
  const hash = createHash('sha256')
    .update(new Uint8Array(outputLeft.buffer))
    .update(new Uint8Array(outputRight.buffer))
    .digest('hex');
  let energy = 0;
  for (let index = 0; index < frames; index += 1) energy += outputLeft[index]! ** 2 + outputRight[index]! ** 2;
  return { hash, rms: Math.sqrt(energy / (frames * 2)), outputLeft, outputRight, latency: core.algorithmicLatencySamples };
}

describe('Browser DIST 4× FIR fast path compatibility', () => {
  it.each([
    [8_000, '14d03b93168813e5d5ff102b6f228c05951ea559683ee64a7d05cdbf9464f5ca', 0.5132281936221013],
    [44_100, 'a19593734213afbf63c72a33abbb2206593e4ee21a2d0e3b8d19ba0104905f4d', 0.5161918068418253],
    [96_000, 'a2203f8dc58f945ce3dad3f31f894cdac52d8924c22231e0ce80c1eca6d6d9d5', 0.4963840635480989],
  ])('preserves the pre-change reference samples at %i Hz with dynamic mode/drive changes', (sampleRate, expectedHash, expectedRms) => {
    const rendered = renderDistortionReferenceFixture(sampleRate as number);
    expect([...rendered.outputLeft, ...rendered.outputRight].every(Number.isFinite)).toBe(true);
    expect(rendered.hash).toBe(expectedHash);
    expect(rendered.rms).toBeCloseTo(expectedRms as number, 12);
    expect(rendered.latency).toBe(16);
  });
});
