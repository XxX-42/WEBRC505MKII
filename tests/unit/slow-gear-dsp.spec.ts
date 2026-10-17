import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserSlowGearDsp } from '../../src/audio/fx/dsp/BrowserSlowGearDsp';

function runMono(core: BrowserFxDspCore, input: Float32Array, blockSizes?: readonly number[]): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const requested = blockSizes?.[blockIndex % blockSizes.length] ?? input.length;
    const length = Math.min(Math.max(1, requested), input.length - offset);
    core.processBlock(input.subarray(offset, offset + length), null, output.subarray(offset, offset + length), null, length);
    offset += length;
    blockIndex += 1;
  }
  return output;
}

function makeConstant(frames: number, amplitude = 0.5): Float32Array {
  return new Float32Array(frames).fill(amplitude);
}

describe('clean-room Browser SLOW GEAR', () => {
  it('attenuates the detected pick frame, then opens with the raised-cosine attack shape', () => {
    const sampleRate = 48000;
    const input = makeConstant(sampleRate / 4, 0.5);
    const output = runMono(new BrowserFxDspCore('slow-gear', sampleRate, {
      slowGearAttackMs: 100,
      slowGearSensitivityPercent: 100,
      mix: 1,
    }), input);

    expect(output[0]).toBeCloseTo(0, 6);
    // Raised cosine gains are 0.146 at 25 ms and 0.5 at 50 ms.
    expect(output[Math.round(sampleRate * 0.025)]).toBeCloseTo(0.5 * 0.1464466, 3);
    expect(output[Math.round(sampleRate * 0.05)]).toBeCloseTo(0.25, 3);
    expect(output[Math.round(sampleRate * 0.1)]).toBeCloseTo(0.5, 3);
    let earlyEnergy = 0;
    let rawEarlyEnergy = 0;
    for (let frame = 0; frame < sampleRate * 0.01; frame += 1) {
      earlyEnergy += (output[frame] ?? 0) ** 2;
      rawEarlyEnergy += (input[frame] ?? 0) ** 2;
    }
    expect(earlyEnergy).toBeLessThan(rawEarlyEnergy * 0.02);
  });

  it('clamps attack to the provisional 5–2000 ms range', () => {
    const sampleRate = 8000;
    const input = makeConstant(4000, 0.25);
    const belowMinimum = runMono(new BrowserFxDspCore('slow-gear', sampleRate, {
      slowGearAttackMs: 1,
      slowGearSensitivityPercent: 100,
      mix: 1,
    }), input);
    const atMinimum = runMono(new BrowserFxDspCore('slow-gear', sampleRate, {
      slowGearAttackMs: 5,
      slowGearSensitivityPercent: 100,
      mix: 1,
    }), input);
    expect(belowMinimum).toEqual(atMinimum);

    const aboveMaximumDsp = new BrowserSlowGearDsp(sampleRate, { attackMs: 2500, sensitivityPercent: 100 });
    const atMaximumDsp = new BrowserSlowGearDsp(sampleRate, { attackMs: 2000, sensitivityPercent: 100 });
    const gainsAbove = new Float32Array(16001);
    const gainsAt = new Float32Array(16001);
    for (let frame = 0; frame < gainsAbove.length; frame += 1) {
      gainsAbove[frame] = aboveMaximumDsp.processSample(0.5, 0.5);
      gainsAt[frame] = atMaximumDsp.processSample(0.5, 0.5);
    }
    expect(gainsAbove).toEqual(gainsAt);
    expect(gainsAt[8000]).toBeCloseTo(0.5, 3);
    expect(gainsAt[16000]).toBeCloseTo(1, 6);
  });

  it('uses sensitivity to detect quieter onsets and does not retrigger on sustained energy', () => {
    const sampleRate = 8000;
    const quietInput = makeConstant(2000, 0.003);
    const insensitive = runMono(new BrowserFxDspCore('slow-gear', sampleRate, {
      slowGearAttackMs: 100,
      slowGearSensitivityPercent: 0,
      mix: 1,
    }), quietInput);
    const sensitive = runMono(new BrowserFxDspCore('slow-gear', sampleRate, {
      slowGearAttackMs: 100,
      slowGearSensitivityPercent: 100,
      mix: 1,
    }), quietInput);
    expect(insensitive[0]).toBeCloseTo(0.003, 6);
    expect(sensitive[0]).toBeCloseTo(0, 6);

    const sustained = runMono(new BrowserFxDspCore('slow-gear', sampleRate, {
      slowGearAttackMs: 80,
      slowGearSensitivityPercent: 100,
      mix: 1,
    }), makeConstant(sampleRate / 2, 0.4));
    expect(sustained[0]).toBeCloseTo(0, 6);
    expect(sustained[Math.round(sampleRate * 0.2)]).toBeCloseTo(0.4, 3);
    expect(sustained[Math.round(sampleRate * 0.45)]).toBeCloseTo(0.4, 3);
  });

  it('rearms after silence and is invariant to callback segmentation', () => {
    const sampleRate = 8000;
    const input = new Float32Array(sampleRate / 2);
    input.fill(0.5, 0, sampleRate * 0.12);
    input.fill(0.5, sampleRate * 0.2);
    const parameters = { slowGearAttackMs: 100, slowGearSensitivityPercent: 100, mix: 1 };
    const whole = runMono(new BrowserFxDspCore('slow-gear', sampleRate, parameters), input);
    const segmented = runMono(new BrowserFxDspCore('slow-gear', sampleRate, parameters), input, [1, 31, 128, 257, 19]);

    expect(segmented).toEqual(whole);
    expect(whole[0]).toBeCloseTo(0, 6);
    expect(whole[Math.round(sampleRate * 0.2)]).toBeCloseTo(0, 6);
    expect(whole[Math.round(sampleRate * 0.24)]).toBeGreaterThan(0);
    expect(whole[Math.round(sampleRate * 0.4)]).toBeCloseTo(0.5, 3);
  });

  it('respects dry mix and produces finite, bounded output for hostile samples', () => {
    const dryInput = new Float32Array([0.75, -0.25, 0.5]);
    expect(runMono(new BrowserFxDspCore('slow-gear', 48000, { mix: 0 }), dryInput)).toEqual(dryInput);

    const hostile = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, 1e38, -1e38, 0.5]);
    const core = new BrowserFxDspCore('slow-gear', 48000, {
      slowGearAttackMs: 5,
      slowGearSensitivityPercent: 100,
      mix: 1,
    });
    const output = runMono(core, hostile, [1, 3]);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(Array.from(output).every((sample) => Math.abs(sample) <= 4)).toBe(true);
    expect(core.nonFiniteInputSamples).toBe(2);
  });
});
