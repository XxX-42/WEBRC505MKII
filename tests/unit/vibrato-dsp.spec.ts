import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserVibratoDsp } from '../../src/audio/fx/dsp/BrowserVibratoDsp';

function source(frames: number): Float32Array {
  const input = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    input[frame] = 0.72 * Math.sin(frame * 0.11) + 0.2 * Math.sin(frame * 0.027);
  }
  return input;
}

function renderCore(core: BrowserFxDspCore, inputLeft: Float32Array, inputRight: Float32Array, blocks: readonly number[]): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(inputLeft.length);
  const right = new Float32Array(inputRight.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < inputLeft.length) {
    const size = Math.min(blocks[blockIndex % blocks.length] ?? 1, inputLeft.length - offset);
    core.processBlock(
      inputLeft.subarray(offset, offset + size),
      inputRight.subarray(offset, offset + size),
      left.subarray(offset, offset + size),
      right.subarray(offset, offset + size),
    );
    offset += size;
    blockIndex += 1;
  }
  return { left, right };
}

describe('Browser VIBRATO DSP', () => {
  it('clamps rate, depth and center delay to the provisional catalog bounds', () => {
    const dsp = new BrowserVibratoDsp(8000);
    dsp.setParameters({ rateHz: 120, depthPercent: -30, delayMs: 40 });
    for (let frame = 0; frame < 256; frame += 1) dsp.processSample(0, 0);
    expect(dsp.currentRateHz).toBe(20);
    expect(dsp.currentDepthPercent).toBe(0);
    expect(dsp.currentDelayMs).toBe(10);

    dsp.setParameters({ rateHz: -2, depthPercent: 240, delayMs: 0.01 });
    for (let frame = 0; frame < 256; frame += 1) dsp.processSample(0, 0);
    expect(dsp.currentRateHz).toBe(0.05);
    expect(dsp.currentDepthPercent).toBe(100);
    expect(dsp.currentDelayMs).toBe(0.2);
  });

  it('stays finite and bounded at extreme controls and arbitrary render sizes', () => {
    const frames = 12037;
    const leftInput = source(frames);
    const rightInput = source(frames).reverse();
    const core = new BrowserFxDspCore('vibrato', 8000, {
      vibratoRateHz: 1000,
      vibratoDepthPercent: 200,
      vibratoDelayMs: 0.01,
      mix: 1,
    });
    core.setParameters({ vibratoRateHz: -4, vibratoDepthPercent: 300, vibratoDelayMs: 50 });
    const result = renderCore(core, leftInput, rightInput, [1, 7, 64, 127, 257, 3, 511]);
    expect(result.left.every(Number.isFinite) && result.right.every(Number.isFinite)).toBe(true);
    expect(result.left.every((sample) => Math.abs(sample) <= 8)).toBe(true);
    expect(result.right.every((sample) => Math.abs(sample) <= 8)).toBe(true);
    expect(core.nonFiniteOutputSamples).toBe(0);
    expect(core.framesProcessed).toBe(frames);
  });

  it('is chunk-invariant and reset reproduces the same stereo output', () => {
    const frames = 8193;
    const leftInput = source(frames);
    const rightInput = source(frames).reverse();
    const parameters = { vibratoRateHz: 9.4, vibratoDepthPercent: 78, vibratoDelayMs: 6.2, mix: 1 };
    const wholeCore = new BrowserFxDspCore('vibrato', 48000, parameters);
    const segmentedCore = new BrowserFxDspCore('vibrato', 48000, parameters);
    const whole = renderCore(wholeCore, leftInput, rightInput, [frames]);
    const segmented = renderCore(segmentedCore, leftInput, rightInput, [1, 17, 128, 257, 3, 511]);
    expect(segmented.left).toEqual(whole.left);
    expect(segmented.right).toEqual(whole.right);

    wholeCore.reset();
    const replay = renderCore(wholeCore, leftInput, rightInput, [1, 64, 11, 509]);
    expect(replay.left).toEqual(whole.left);
    expect(replay.right).toEqual(whole.right);
  });
});
