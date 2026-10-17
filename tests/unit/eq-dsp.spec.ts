import { describe, expect, it } from 'vitest';
import { EqualizerDsp, type EqualizerDspParameters } from '../../src/audio/fx/dsp/EqualizerDsp';

function tone(frames: number, sampleRate: number, frequency: number): Float32Array {
  const result = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) result[frame] = 0.35 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  return result;
}

function render(input: Float32Array, parameters: EqualizerDspParameters, blocks?: readonly number[]): Float32Array {
  const dsp = new EqualizerDsp(48000, parameters);
  const output = new Float32Array(input.length);
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    const count = Math.min(blocks?.[block % blocks.length] ?? input.length, input.length - offset);
    for (let frame = offset; frame < offset + count; frame += 1) {
      const sample = input[frame] ?? 0;
      dsp.process(sample, sample);
      output[frame] = dsp.outputLeft;
    }
    offset += count;
    block += 1;
  }
  return output;
}

function energy(samples: Float32Array, start: number): number {
  let value = 0;
  for (let index = start; index < samples.length; index += 1) value += (samples[index] ?? 0) ** 2;
  return value;
}

describe('clean-room four-band EQ DSP', () => {
  it('applies low/high shelves and two independent peaking bands', () => {
    const sampleRate = 48000;
    const frames = sampleRate;
    const lowTone = tone(frames, sampleRate, 60);
    const highTone = tone(frames, sampleRate, 10000);
    const midOneTone = tone(frames, sampleRate, 700);
    const midTwoTone = tone(frames, sampleRate, 3500);

    const lowBoost = render(lowTone, { lowGainDb: 12 });
    const highCut = render(highTone, { highGainDb: -12 });
    const midOneBoost = render(midOneTone, { mid1GainDb: 12, mid1FrequencyHz: 700, mid1Q: 1 });
    const midTwoBoost = render(midTwoTone, { mid2GainDb: 12, mid2FrequencyHz: 3500, mid2Q: 1 });
    expect(energy(lowBoost, 12000)).toBeGreaterThan(energy(lowTone, 12000) * 3);
    expect(energy(highCut, 12000)).toBeLessThan(energy(highTone, 12000) * 0.3);
    expect(energy(midOneBoost, 12000)).toBeGreaterThan(energy(midOneTone, 12000) * 3);
    expect(energy(midTwoBoost, 12000)).toBeGreaterThan(energy(midTwoTone, 12000) * 3);
  });

  it('smooths parameter changes and is invariant to arbitrary chunking', () => {
    const input = tone(24017, 48000, 920);
    const parameters = { lowGainDb: 4, mid1FrequencyHz: 850, mid1Q: 1.4, mid1GainDb: -6, highGainDb: 3 };
    const whole = render(input, parameters);
    const segmented = render(input, parameters, [1, 7, 64, 127, 257, 3, 511]);
    expect(segmented).toEqual(whole);
    expect(whole.every(Number.isFinite)).toBe(true);

    const updated = new EqualizerDsp(48000, { lowGainDb: 0 });
    updated.process(0.25, -0.25);
    updated.setParameters({ lowGainDb: 15 }, 256);
    const transition = new Float32Array(256);
    for (let frame = 0; frame < transition.length; frame += 1) {
      updated.process(0.25, -0.25);
      transition[frame] = updated.outputLeft;
    }
    expect(transition.every(Number.isFinite)).toBe(true);
    expect(transition[0]).not.toBe(transition[255]);
    for (let frame = 0; frame < 4096; frame += 1) updated.process(0.25, -0.25);
    expect(updated.outputLeft).toBeCloseTo(0.25 * 10 ** (15 / 20), 0);
  });

  it('clamps unsafe controls and resets filter state without changing its curve', () => {
    const safe = render(tone(4096, 48000, 2500), { highFrequencyHz: 20000, highGainDb: 15, mid1Q: 0.1, mid1GainDb: 8 });
    const unsafe = render(tone(4096, 48000, 2500), { highFrequencyHz: 1e12, highGainDb: 200, mid1Q: -1, mid1GainDb: 8 });
    expect(unsafe).toEqual(safe);

    const dsp = new EqualizerDsp(48000, { lowGainDb: -10 });
    for (let frame = 0; frame < 4096; frame += 1) dsp.process(frame === 0 ? 1 : 0, 0);
    dsp.reset();
    dsp.process(1, 0);
    expect(dsp.outputLeft).toBeGreaterThan(0);
    expect(dsp.outputRight).toBe(0);
  });
});
