import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

describe('four-slot Browser DSP cascade', () => {
  it('runs four real algorithms in series over irregular blocks without non-finite output', () => {
    const sampleRate = 48000;
    const effects = [
      new BrowserFxDspCore('lpf', sampleRate, { cutoffHz: 11_000, mix: 1 }),
      new BrowserFxDspCore('ring-mod', sampleRate, { ringModHz: 83, ringModDepth: 0.35, mix: 1 }),
      new BrowserFxDspCore('hpf', sampleRate, { cutoffHz: 35, mix: 1 }),
      new BrowserFxDspCore('reverb', sampleRate, { mix: 0.3, decaySeconds: 1.7 }),
    ];

    const blockSizes = [64, 127, 3, 1, 1024, 73, 257];
    const totalFrames = blockSizes.reduce((sum, size) => sum + size, 0);
    const sourceLeft = new Float32Array(totalFrames);
    const sourceRight = new Float32Array(totalFrames);
    sourceLeft[0] = 1;
    sourceRight[0] = -0.6;
    for (let frame = 1; frame < totalFrames; frame += 1) {
      sourceLeft[frame] = Math.sin((frame * Math.PI * 2 * 440) / sampleRate) * 0.13;
      sourceRight[frame] = Math.sin((frame * Math.PI * 2 * 331) / sampleRate) * 0.11;
    }

    let sourceOffset = 0;
    let lastBlock: readonly [Float32Array, Float32Array] | null = null;
    for (const frameCount of blockSizes) {
      let left = sourceLeft.subarray(sourceOffset, sourceOffset + frameCount);
      let right = sourceRight.subarray(sourceOffset, sourceOffset + frameCount);
      for (const effect of effects) {
        const outputLeft = new Float32Array(frameCount);
        const outputRight = new Float32Array(frameCount);
        effect.processBlock(left, right, outputLeft, outputRight, frameCount);
        left = outputLeft;
        right = outputRight;
      }
      expect([...left, ...right].every(Number.isFinite)).toBe(true);
      lastBlock = [left, right];
      sourceOffset += frameCount;
    }

    expect(sourceOffset).toBe(totalFrames);
    expect(effects.every((effect) => effect.blocksProcessed === blockSizes.length)).toBe(true);
    expect(lastBlock).not.toBeNull();
    expect(lastBlock![0].some((sample) => Math.abs(sample) > 1e-9)).toBe(true);
    expect(lastBlock![1].some((sample) => Math.abs(sample) > 1e-9)).toBe(true);
    expect(effects.every((effect) => effect.nonFiniteInputSamples === 0 && effect.nonFiniteOutputSamples === 0)).toBe(true);
  });
});
