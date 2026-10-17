import { describe, expect, it } from 'vitest';
import { BrowserModDelayDsp } from '../../src/audio/fx/dsp/BrowserModDelayDsp';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

function renderImpulse(core: BrowserFxDspCore, length: number, blockSizes: readonly number[]): Float32Array {
  const input = new Float32Array(length);
  input[0] = 1;
  const output = new Float32Array(length);
  let offset = 0;
  let block = 0;
  while (offset < length) {
    const count = Math.min(blockSizes[block % blockSizes.length] ?? length, length - offset);
    core.processBlock(input.subarray(offset, offset + count), null, output.subarray(offset, offset + count), null, count);
    offset += count;
    block += 1;
  }
  return output;
}

describe('Browser MOD DELAY (catalog source ID 39)', () => {
  it('places the impulse at the authored base delay without fixed pipeline latency', () => {
    const core = new BrowserFxDspCore('mod-delay', 8000, {
      modDelayTimeMs: 50,
      modDelayRateHz: 0.05,
      modDelayDepthMs: 0,
      modDelayFeedbackPercent: 0,
      mix: 1,
    });
    core.setBypass(false, 0);
    const output = renderImpulse(core, 520, [1, 17, 64]);
    expect(output[399]).toBe(0);
    expect(output[400]).toBeCloseTo(1, 5);
    expect(core.algorithmicLatencySamples).toBe(0);
  });

  it('reduces LFO depth at the minimum delay instead of clipping the moving head', () => {
    const sampleRate = 8000;
    const length = 1600;
    const input = new Float32Array(length);
    for (let frame = 0; frame < length; frame += 1) {
      input[frame] = 0.4 * Math.sin(2 * Math.PI * 330 * frame / sampleRate);
    }
    const boundary = new BrowserModDelayDsp(sampleRate, {
      timeMs: 10, rateHz: 0.7, depthMs: 50, feedbackPercent: 0,
    });
    const fixed = new BrowserModDelayDsp(sampleRate, {
      timeMs: 10, rateHz: 0.7, depthMs: 0, feedbackPercent: 0,
    });
    const boundaryOutput = new Float32Array(length);
    const fixedOutput = new Float32Array(length);
    boundary.processBlock(input, null, boundaryOutput, null);
    fixed.processBlock(input, null, fixedOutput, null);
    expect(boundaryOutput).toEqual(fixedOutput);
  });

  it('modulates a delayed tone, remains finite at maximum feedback and is block-invariant', () => {
    const sampleRate = 8000;
    const length = 18000;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (let frame = 0; frame < length; frame += 1) {
      left[frame] = frame === 0 ? 1 : 0.2 * Math.sin(2 * Math.PI * 330 * frame / sampleRate);
      right[frame] = frame === 0 ? 1 : 0.2 * Math.sin(2 * Math.PI * 330 * frame / sampleRate);
    }
    const parameters = { timeMs: 65, rateHz: 0.7, depthMs: 35, feedbackPercent: 95 };
    const reference = new BrowserModDelayDsp(sampleRate, parameters);
    const segmented = new BrowserModDelayDsp(sampleRate, parameters);
    const referenceLeft = new Float32Array(length);
    const referenceRight = new Float32Array(length);
    const segmentedLeft = new Float32Array(length);
    const segmentedRight = new Float32Array(length);
    reference.processBlock(left, right, referenceLeft, referenceRight);
    let offset = 0;
    const blocks = [1, 31, 257, 89, 64];
    let block = 0;
    while (offset < length) {
      const count = Math.min(blocks[block % blocks.length] ?? 1, length - offset);
      segmented.processBlock(
        left.subarray(offset, offset + count), right.subarray(offset, offset + count),
        segmentedLeft.subarray(offset, offset + count), segmentedRight.subarray(offset, offset + count), count,
      );
      offset += count;
      block += 1;
    }
    let differenceEnergy = 0;
    let peak = 0;
    for (let frame = 0; frame < length; frame += 1) {
      const a = referenceLeft[frame] ?? 0;
      const b = segmentedLeft[frame] ?? 0;
      expect(Number.isFinite(a)).toBe(true);
      expect(Number.isFinite(referenceRight[frame] ?? 0)).toBe(true);
      peak = Math.max(peak, Math.abs(a));
      differenceEnergy += (a - b) * (a - b);
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(8);
    expect(differenceEnergy).toBeLessThan(1e-10);

    const unmodulated = new BrowserModDelayDsp(sampleRate, { ...parameters, depthMs: 0, feedbackPercent: 0 });
    const dryFeedbackOutput = new Float32Array(length);
    const dryFeedbackRight = new Float32Array(length);
    unmodulated.processBlock(left, right, dryFeedbackOutput, dryFeedbackRight);
    let modDifference = 0;
    for (let frame = 2000; frame < 8000; frame += 1) {
      const delta = (referenceLeft[frame] ?? 0) - (dryFeedbackOutput[frame] ?? 0);
      modDifference += delta * delta;
    }
    expect(modDifference).toBeGreaterThan(1e-3);
  });
});
