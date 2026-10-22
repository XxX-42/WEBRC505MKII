import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

function renderFdnBoundaryFixture(sampleRate: number, algorithm: 'reverb' | 'gate-reverb') {
  const frames = 100_003;
  const inputLeft = new Float32Array(frames);
  const inputRight = new Float32Array(frames);
  let random = 0x12345678;
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const noiseLeft = (random / 0x1_0000_0000 - 0.5) * 0.08;
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const noiseRight = (random / 0x1_0000_0000 - 0.5) * 0.08;
    if (frame % 7_000 < 640 || frame % 7_000 === 0) {
      inputLeft[frame] = 0.21 * Math.sin(2 * Math.PI * 440 * time)
        + 0.04 * Math.sin(2 * Math.PI * 1_307 * time) + noiseLeft;
      inputRight[frame] = 0.18 * Math.sin(2 * Math.PI * 659 * time + 0.2)
        + 0.03 * Math.sin(2 * Math.PI * 1_711 * time) + noiseRight;
    }
    if (frame % 7_000 === 0) {
      inputLeft[frame] += 0.8;
      inputRight[frame] -= 0.6;
    }
  }

  const core = new BrowserFxDspCore(algorithm, sampleRate, {
    mix: 1,
    decaySeconds: 2.4,
    dampingHz: 9_000,
    gateThresholdDb: -12,
    gateHoldMs: 25,
    gateReleaseMs: 80,
  });
  const outputLeft = new Float32Array(frames);
  const outputRight = new Float32Array(frames);
  const blockSizes = [128, 257, 7, 4_096, 1, 64];
  let frame = 0;
  let blockIndex = 0;
  while (frame < frames) {
    if (frame === 40_000) {
      core.setParameters({
        decaySeconds: 3.7,
        dampingHz: 5_200,
        gateThresholdDb: -21,
        gateHoldMs: 41,
        gateReleaseMs: 111,
      });
    }
    if (frame === 80_000) {
      core.setParameters({
        decaySeconds: 1.2,
        dampingHz: 13_500,
        gateThresholdDb: -9,
        gateHoldMs: 12,
        gateReleaseMs: 53,
      });
    }
    const nextBoundary = frame < 40_000 ? 40_000 : frame < 80_000 ? 80_000 : frames;
    const count = Math.min(blockSizes[blockIndex++ % blockSizes.length]!, nextBoundary - frame, frames - frame);
    core.processBlock(
      inputLeft.subarray(frame, frame + count),
      inputRight.subarray(frame, frame + count),
      outputLeft.subarray(frame, frame + count),
      outputRight.subarray(frame, frame + count),
      count,
      false,
    );
    frame += count;
  }

  const bytes = new Uint8Array(outputLeft.byteLength + outputRight.byteLength);
  bytes.set(new Uint8Array(outputLeft.buffer));
  bytes.set(new Uint8Array(outputRight.buffer), outputLeft.byteLength);
  let energy = 0;
  let finite = true;
  for (let index = 0; index < frames; index += 1) {
    const left = outputLeft[index]!;
    const right = outputRight[index]!;
    finite &&= Number.isFinite(left) && Number.isFinite(right);
    energy += left * left + right * right;
  }
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    rms: Math.sqrt(energy / (frames * 2)),
    finite,
    latency: core.algorithmicLatencySamples,
  };
}

function renderFdnNearStateFloorFixture() {
  const sampleRate = 48_000;
  const frames = 131_071;
  const inputLeft = new Float32Array(frames);
  const inputRight = new Float32Array(frames);
  let random = 0x12345678;
  for (let frame = 0; frame < frames; frame += 1) {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const noiseLeft = (random / 0x1_0000_0000 - 0.5) * 2;
    const envelope = frame % 997 < 31 ? 1 : 0.001;
    const pulse = frame % 4_093 === 0 ? 1 : 0;
    inputLeft[frame] = (noiseLeft * envelope + pulse) * 2e-23;
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    const noiseRight = (random / 0x1_0000_0000 - 0.5) * 2;
    inputRight[frame] = (noiseRight * envelope - pulse * 0.6) * 2e-23;
  }

  const core = new BrowserFxDspCore('reverb', sampleRate, {
    mix: 1,
    decaySeconds: 2.4,
    dampingHz: 9_000,
  });
  const outputLeft = new Float32Array(frames);
  const outputRight = new Float32Array(frames);
  const blockSizes = [128, 257, 7, 4_096, 1, 64];
  let frame = 0;
  let blockIndex = 0;
  let maximumAbsoluteOutput = 0;
  while (frame < frames) {
    const count = Math.min(blockSizes[blockIndex++ % blockSizes.length]!, frames - frame);
    core.processBlock(
      inputLeft.subarray(frame, frame + count),
      inputRight.subarray(frame, frame + count),
      outputLeft.subarray(frame, frame + count),
      outputRight.subarray(frame, frame + count),
      count,
      false,
    );
    frame += count;
  }

  const bytes = new Uint8Array(outputLeft.byteLength + outputRight.byteLength);
  bytes.set(new Uint8Array(outputLeft.buffer));
  bytes.set(new Uint8Array(outputRight.buffer), outputLeft.byteLength);
  let energy = 0;
  let finite = true;
  for (let index = 0; index < frames; index += 1) {
    const left = outputLeft[index]!;
    const right = outputRight[index]!;
    finite &&= Number.isFinite(left) && Number.isFinite(right);
    maximumAbsoluteOutput = Math.max(maximumAbsoluteOutput, Math.abs(left), Math.abs(right));
    energy += left * left + right * right;
  }
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    rms: Math.sqrt(energy / (frames * 2)),
    maximumAbsoluteOutput,
    finite,
  };
}

describe('Browser FDN one-correction cyclic reads', () => {
  it.each([
    [48_000, 'reverb', 'c6e594d6b645d030fee4bb79ec3cb417da711fd455c688f0bc9d5da4923d1cc1', 0.008273137827069253],
    [48_000, 'gate-reverb', 'f67ecec263e7d3de2c4b1887d1cb21a956557c787c0110fbc8e618d3c6139964', 0.006303312815307572],
    [96_000, 'reverb', 'eb2a8aa2c6b7ee42f3ac550beacc40d1be1a6ee58889ed6667ee3cf6d123d237', 0.006661491313098152],
    [96_000, 'gate-reverb', '6fd2feb2511a36ee1608a213822738940248ee7e5f3355a832a45c36f0781d1e', 0.006314447017902151],
  ] as const)('%s Hz %s preserves the pre-change output across ring boundaries and live parameter ramps', (
    sampleRate, algorithm, expectedHash, expectedRms,
  ) => {
    const rendered = renderFdnBoundaryFixture(sampleRate, algorithm);
    expect(rendered.finite).toBe(true);
    expect(rendered.hash).toBe(expectedHash);
    expect(rendered.rms).toBeCloseTo(expectedRms, 12);
    expect(rendered.latency).toBe(0);
  });

  it('preserves the Float64 FDN state floor and near-floor tail output bit-for-bit', () => {
    const rendered = renderFdnNearStateFloorFixture();
    expect(rendered.finite).toBe(true);
    expect(rendered.hash).toBe('6aa0d248bcb25db95374c5325230abce88403c598d3905a11b810ed510b862b0');
    expect(rendered.rms).toBeCloseTo(1.5695853670963377e-25, 35);
    expect(rendered.maximumAbsoluteOutput).toBeCloseTo(2.7899671245083207e-24, 35);
  });
});
