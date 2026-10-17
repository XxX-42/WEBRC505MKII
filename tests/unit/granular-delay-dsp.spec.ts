import { describe, expect, it } from 'vitest';
import { BrowserGranularDelayDsp } from '../../src/audio/fx/dsp/BrowserGranularDelayDsp';

function render(
  dsp: BrowserGranularDelayDsp,
  input: Float32Array,
  blockSizes?: readonly number[],
): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    const requested = blockSizes?.[block % blockSizes.length] ?? input.length;
    const frames = Math.min(Math.max(1, requested), input.length - offset);
    dsp.processBlock(
      input.subarray(offset, offset + frames),
      null,
      output.subarray(offset, offset + frames),
      null,
      frames,
    );
    offset += frames;
    block += 1;
  }
  return output;
}

function toneMagnitude(samples: Float32Array, sampleRate: number, frequency: number, start: number, end: number): number {
  let real = 0;
  let imaginary = 0;
  for (let frame = start; frame < end; frame += 1) {
    const angle = (2 * Math.PI * frequency * frame) / sampleRate;
    const value = samples[frame] ?? 0;
    real += value * Math.cos(angle);
    imaginary -= value * Math.sin(angle);
  }
  return (2 * Math.hypot(real, imaginary)) / (end - start);
}

describe('Browser granular-delay DSP', () => {
  it('uses overlapping windowed grains with audible resampling pitch control', () => {
    const sampleRate = 48000;
    const frames = sampleRate * 2;
    const input = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      input[frame] = 0.3 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
    }

    const unshifted = render(new BrowserGranularDelayDsp(sampleRate, {
      grainSizeMs: 180, densityHz: 20, pitchSemitones: 0, positionJitterPercent: 0, feedbackPercent: 0,
    }), input);
    const octaveUp = render(new BrowserGranularDelayDsp(sampleRate, {
      grainSizeMs: 180, densityHz: 20, pitchSemitones: 12, positionJitterPercent: 0, feedbackPercent: 0,
    }), input);
    const unshifted440 = toneMagnitude(unshifted, sampleRate, 440, 24000, 72000);
    const octaveUp440 = toneMagnitude(octaveUp, sampleRate, 440, 24000, 72000);
    const octaveUp880 = toneMagnitude(octaveUp, sampleRate, 880, 24000, 72000);

    expect(unshifted440).toBeGreaterThan(0.05);
    expect(octaveUp880).toBeGreaterThan(0.05);
    expect(octaveUp880).toBeGreaterThan(octaveUp440 * 5);
    expect(octaveUp.every(Number.isFinite)).toBe(true);
    expect(octaveUp.every((sample) => Math.abs(sample) <= 1)).toBe(true);
  });

  it('changes density, grain length and jitter while retaining deterministic segmentation', () => {
    const sampleRate = 16000;
    const frames = 32000;
    const input = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      input[frame] = 0.25 * Math.sin((2 * Math.PI * 317 * frame) / sampleRate)
        + (frame % 317 === 0 ? 0.3 : 0);
    }

    const baseline = render(new BrowserGranularDelayDsp(sampleRate, {
      grainSizeMs: 80, densityHz: 8, pitchSemitones: 0, positionJitterPercent: 0, feedbackPercent: 10,
    }), input);
    const varied = render(new BrowserGranularDelayDsp(sampleRate, {
      grainSizeMs: 240, densityHz: 24, pitchSemitones: 5, positionJitterPercent: 75, feedbackPercent: 10,
    }), input);
    const segmented = render(new BrowserGranularDelayDsp(sampleRate, {
      grainSizeMs: 240, densityHz: 24, pitchSemitones: 5, positionJitterPercent: 75, feedbackPercent: 10,
    }), input, [1, 7, 64, 127, 257, 3, 511]);

    expect(varied).not.toEqual(baseline);
    expect(segmented).toEqual(varied);
    expect(varied.every(Number.isFinite)).toBe(true);
    expect(varied.every((sample) => Math.abs(sample) <= 8)).toBe(true);
  });

  it('keeps maximum-density, maximum-feedback output finite and bounded at sample-rate limits', () => {
    for (const sampleRate of [8000, 48000, 96000]) {
      const frames = Math.round(sampleRate * 0.35);
      const input = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) input[frame] = frame % 251 < 125 ? 0.9 : -0.9;
      const output = render(new BrowserGranularDelayDsp(sampleRate, {
        grainSizeMs: 1000, densityHz: 80, pitchSemitones: 24,
        positionJitterPercent: 100, feedbackPercent: 95,
      }), input, [1, 127, 511]);

      expect(output.every(Number.isFinite), `finite at ${sampleRate} Hz`).toBe(true);
      expect(output.every((sample) => Math.abs(sample) <= 8), `bounded at ${sampleRate} Hz`).toBe(true);
    }
  });
});
