import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserRadioDsp } from '../../src/audio/fx/dsp/BrowserRadioDsp';

const sampleRate = 48000;

function renderTone(frequency: number, frames: number, band: number, drive = 0): Float32Array {
  const input = new Float32Array(frames);
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) input[frame] = 0.8 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  const core = new BrowserFxDspCore('radio', sampleRate, { radioBand: band, radioDrive: drive, radioNoise: 0, mix: 1 });
  core.setBypass(false, 0);
  core.processBlock(input, input, output, null);
  return output;
}

function rms(input: Float32Array, start = 0): number {
  let sum = 0;
  for (let index = start; index < input.length; index += 1) sum += (input[index] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, input.length - start));
}

function residualHarmonicRatio(input: Float32Array, frequency: number): number {
  const start = input.length - 4096;
  const length = input.length - start;
  let sine = 0;
  let cosine = 0;
  let energy = 0;
  for (let index = 0; index < length; index += 1) {
    const sample = input[start + index] ?? 0;
    const phase = (2 * Math.PI * frequency * index) / sampleRate;
    sine += sample * Math.sin(phase);
    cosine += sample * Math.cos(phase);
    energy += sample * sample;
  }
  const fundamentalEnergy = (2 * (sine * sine + cosine * cosine)) / (length * length);
  return Math.sqrt(Math.max(0, energy / length - fundamentalEnergy) / Math.max(1e-20, energy / length));
}

function renderSegmented(core: BrowserFxDspCore, input: Float32Array, blockSizes: readonly number[]): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    const size = Math.min(blockSizes[block % blockSizes.length] ?? 1, input.length - offset);
    core.processBlock(input.subarray(offset, offset + size), input.subarray(offset, offset + size), output.subarray(offset, offset + size), null);
    offset += size;
    block += 1;
  }
  return output;
}

describe('clean-room Browser RADIO DSP', () => {
  it('uses distinct AM-narrow and FM band limits', () => {
    const narrow100 = renderTone(100, 24000, 0);
    const fm100 = renderTone(100, 24000, 2);
    const narrow1k = renderTone(1000, 24000, 0);
    expect(rms(narrow100, 12000)).toBeLessThan(rms(fm100, 12000) * 0.55);
    expect(rms(narrow1k, 12000)).toBeGreaterThan(rms(narrow100, 12000));
  });

  it('adds nonlinear harmonics as the provisional saturation drive rises', () => {
    const lowDrive = renderTone(900, 24000, 2, 0);
    const highDrive = renderTone(900, 24000, 2, 100);
    expect(residualHarmonicRatio(highDrive, 900)).toBeGreaterThan(residualHarmonicRatio(lowDrive, 900) + 0.08);
  });

  it('produces repeatable colored noise and dropout decisions and resets deterministically', () => {
    const first = new BrowserRadioDsp(sampleRate, { band: 2, drive: 0, noise: 100 });
    const second = new BrowserRadioDsp(sampleRate, { band: 2, drive: 0, noise: 100 });
    let checksumA = 0;
    let checksumB = 0;
    for (let frame = 0; frame < sampleRate * 3; frame += 1) {
      first.processSample(0.3, 0.3);
      second.processSample(0.3, 0.3);
      expect(first.wetLeft).toBe(second.wetLeft);
      checksumA += Math.abs(first.wetLeft - 0.3);
      checksumB += Math.abs(second.wetLeft - 0.3);
    }
    expect(checksumA).toBeGreaterThan(0);
    expect(checksumA).toBe(checksumB);
    expect(first.dropoutEvents).toBeGreaterThan(0);
    expect(first.dropoutEvents).toBe(second.dropoutEvents);

    first.reset();
    second.reset();
    first.processSample(0.3, 0.3);
    second.processSample(0.3, 0.3);
    expect(first.wetLeft).toBe(second.wetLeft);
  });

  it('is invariant to variable Browser render block sizes', () => {
    const frames = 7777;
    const input = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) input[frame] = Math.sin(frame * 0.11) * 0.7;
    const config = { radioBand: 1, radioDrive: 62, radioNoise: 25, mix: 1 };
    const wholeCore = new BrowserFxDspCore('radio', sampleRate, config);
    const splitCore = new BrowserFxDspCore('radio', sampleRate, config);
    wholeCore.setBypass(false, 0);
    splitCore.setBypass(false, 0);
    const whole = renderSegmented(wholeCore, input, [frames]);
    const split = renderSegmented(splitCore, input, [1, 17, 128, 257, 3, 511]);
    expect(split).toEqual(whole);
  });
});
