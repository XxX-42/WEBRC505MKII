import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserIsolatorDsp } from '../../src/audio/fx/dsp/BrowserIsolatorDsp';

function runStereo(
  core: BrowserFxDspCore,
  left: Float32Array,
  right: Float32Array,
  blockSizes?: readonly number[],
): [Float32Array, Float32Array] {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < left.length) {
    const requested = blockSizes?.[blockIndex % blockSizes.length] ?? left.length;
    const length = Math.min(Math.max(1, requested), left.length - offset);
    core.processBlock(
      left.subarray(offset, offset + length),
      right.subarray(offset, offset + length),
      outputLeft.subarray(offset, offset + length),
      outputRight.subarray(offset, offset + length),
      length,
    );
    offset += length;
    blockIndex += 1;
  }
  return [outputLeft, outputRight];
}

function sine(frames: number, sampleRate: number, frequencyHz: number, amplitude = 0.1): Float32Array {
  const result = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    result[frame] = amplitude * Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate);
  }
  return result;
}

function rms(input: Float32Array, start: number): number {
  let total = 0;
  for (let frame = start; frame < input.length; frame += 1) total += (input[frame] ?? 0) ** 2;
  return Math.sqrt(total / Math.max(1, input.length - start));
}

describe('clean-room Browser ISOLATOR', () => {
  it('recombines the three bands to unity at 0 dB with gate depth off', () => {
    const dsp = new BrowserIsolatorDsp(48000, { gateDepthPercent: 0 });
    for (let frame = 0; frame < 12000; frame += 1) {
      const left = Math.sin((2 * Math.PI * 440 * frame) / 48000) * 0.25;
      const right = Math.cos((2 * Math.PI * 730 * frame) / 48000) * 0.2;
      dsp.processSample(left, right);
      expect(dsp.outputLeft).toBeCloseTo(left, 10);
      expect(dsp.outputRight).toBeCloseTo(right, 10);
    }
  });

  it('uses safe unity/tempo defaults for invalid constructor controls', () => {
    const dsp = new BrowserIsolatorDsp(48000, {
      lowGainDb: Number.NaN,
      midGainDb: Number.POSITIVE_INFINITY,
      highGainDb: Number.NaN,
      gateRateBeats: Number.NaN,
      gateDepthPercent: Number.NaN,
      bpm: Number.NaN,
    });
    for (let frame = 0; frame < 5000; frame += 1) {
      const sample = Math.sin((2 * Math.PI * 330 * frame) / 48000) * 0.2;
      dsp.processSample(sample, sample);
      expect(Number.isFinite(dsp.outputLeft)).toBe(true);
      expect(dsp.outputLeft).toBeCloseTo(sample, 10);
    }
  });

  it('boosts the low band while leaving a high-frequency tone substantially unchanged', () => {
    const sampleRate = 48000;
    const frames = sampleRate;
    const parameters = { isolatorLowGainDb: 12, isolatorGateDepthPercent: 0, mix: 1 };
    const [low] = runStereo(
      new BrowserFxDspCore('isolator', sampleRate, parameters),
      sine(frames, sampleRate, 80), new Float32Array(frames),
    );
    const [high] = runStereo(
      new BrowserFxDspCore('isolator', sampleRate, parameters),
      sine(frames, sampleRate, 8000), new Float32Array(frames),
    );

    expect(rms(low, sampleRate / 2)).toBeGreaterThan(rms(high, sampleRate / 2) * 2.5);
    expect(rms(high, sampleRate / 2)).toBeCloseTo(0.1 / Math.sqrt(2), 2);
  });

  it('closes and reopens at the configured BPM-relative gate edges', () => {
    const sampleRate = 8000;
    const dsp = new BrowserIsolatorDsp(sampleRate, {
      gateRateBeats: 0.5,
      gateDepthPercent: 100,
      bpm: 120,
    });
    const gains = new Float32Array(2200);
    for (let frame = 0; frame < gains.length; frame += 1) {
      dsp.processSample(0.5, 0.5);
      gains[frame] = dsp.outputLeft / 0.5;
    }

    expect(gains[20]).toBeCloseTo(1, 6);
    expect(gains[1100]).toBeLessThan(0.001);
    expect(gains[2020]).toBeCloseTo(1, 6);
  });

  it('keeps gate state block-size invariant and handles hostile input through the core', () => {
    const sampleRate = 8000;
    const left = new Float32Array(12000);
    const right = new Float32Array(12000);
    for (let frame = 0; frame < left.length; frame += 1) {
      left[frame] = frame === 6000 ? Number.NaN : Math.sin(frame * 0.021) * 0.4;
      right[frame] = frame === 8000 ? Number.POSITIVE_INFINITY : Math.cos(frame * 0.015) * 0.3;
    }
    const parameters = {
      bpm: 133,
      isolatorGateRateBeats: 0.25,
      isolatorGateDepthPercent: 75,
      isolatorMidGainDb: 2,
      mix: 1,
    };
    const wholeCore = new BrowserFxDspCore('isolator', sampleRate, parameters);
    const splitCore = new BrowserFxDspCore('isolator', sampleRate, parameters);
    const whole = runStereo(wholeCore, left, right);
    const split = runStereo(splitCore, left, right, [1, 31, 128, 257, 19]);

    expect(split[0]).toEqual(whole[0]);
    expect(split[1]).toEqual(whole[1]);
    expect(whole[0].every(Number.isFinite)).toBe(true);
    expect(whole[1].every(Number.isFinite)).toBe(true);
    expect(wholeCore.nonFiniteInputSamples).toBe(2);
  });
});
