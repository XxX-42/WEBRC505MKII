import { describe, expect, it } from 'vitest';
import { BrowserOscBotCore } from '../../src/audio/fx/BrowserOscBotCore';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';

function tone(sampleRate: number, frequencyHz: number, frames: number, amplitude: number, start = 0, end = frames): Float32Array {
  const signal = new Float32Array(frames);
  for (let frame = start; frame < end; frame += 1) {
    signal[frame] = amplitude * Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate);
  }
  return signal;
}

function rms(samples: Float32Array, start: number, end: number): number {
  let energy = 0;
  const count = Math.max(1, end - start);
  for (let frame = start; frame < end; frame += 1) energy += (samples[frame] ?? 0) ** 2;
  return Math.sqrt(energy / count);
}

function render(input: Float32Array, pattern: number, blocks: readonly number[]): Float32Array {
  const core = new BrowserOscBotCore(48_000, { bands: 16, pattern, waveform: 0, mix: 1, tempoBpm: 120 });
  const output = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const frames = Math.min(blocks[blockIndex % blocks.length] ?? input.length, input.length - offset);
    const left = input.subarray(offset, offset + frames);
    const right = input.subarray(offset, offset + frames);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    core.processBlock(left, right, outputLeft, outputRight);
    output.set(outputLeft, offset);
    offset += frames;
    blockIndex += 1;
  }
  expect(core.currentFrame).toBe(input.length);
  return output;
}

describe('Browser clean-room OSC BOT carrier-bank core', () => {
  it('gates the authored oscillator-bank pattern with the shared VOCODER envelopes', () => {
    const sampleRate = 48_000;
    const frames = sampleRate * 2;
    const input = tone(sampleRate, 180, frames, 0.4, sampleRate / 3, sampleRate);
    const output = render(input, 0, [frames]);
    expect(rms(output, sampleRate * 0.55, sampleRate * 0.9)).toBeGreaterThan(0.001);
    expect(rms(output, sampleRate * 1.55, sampleRate * 1.9)).toBeGreaterThan(
      rms(output, sampleRate / 10, sampleRate / 4) * 2,
    );
    expect([...output].every(Number.isFinite)).toBe(true);
  });

  it('renders distinct authored step patterns and is invariant to variable block sizes', () => {
    const sampleRate = 48_000;
    const input = tone(sampleRate, 330, sampleRate * 2, 0.32);
    const pattern0 = render(input, 0, [128]);
    const pattern1 = render(input, 1, [1, 31, 127, 257, 64, 511]);
    const blockwisePattern0 = render(input, 0, [1, 17, 128, 257, 31, 511, 73]);
    expect(blockwisePattern0).toEqual(pattern0);
    let differenceEnergy = 0;
    for (let frame = sampleRate / 4; frame < input.length; frame += 1) {
      differenceEnergy += ((pattern0[frame] ?? 0) - (pattern1[frame] ?? 0)) ** 2;
    }
    expect(differenceEnergy).toBeGreaterThan(0.1);
  });

  it('uses a sample-clocked sixteenth-note pattern and retains fractional step phase on tempo changes', () => {
    const core = new BrowserOscBotCore(48_000, { tempoBpm: 120, mix: 0 });
    expect(core.stepFrames).toBe(6000);
    for (let frame = 0; frame < 6000; frame += 1) core.processSample(0);
    expect(core.stepIndex).toBe(0);
    core.processSample(0);
    expect(core.stepIndex).toBe(1);
    expect(core.currentFrame).toBe(6001);
    core.setTempoBpm(60);
    expect(core.stepFrames).toBe(12_000);
    for (let frame = 0; frame < 11_999; frame += 1) core.processSample(0);
    expect(core.stepIndex).toBe(2);
  });

  it('provides separate saw, square and integrated BLEP-triangle carriers', () => {
    const sampleRate = 48_000;
    const input = tone(sampleRate, 440, sampleRate, 0.3);
    const saw = render(input, 0, [128]);
    const squareCore = new BrowserOscBotCore(sampleRate, { waveform: 1, mix: 1 });
    const triangleCore = new BrowserOscBotCore(sampleRate, { waveform: 2, mix: 1 });
    const square = new Float32Array(input.length);
    const triangle = new Float32Array(input.length);
    for (let frame = 0; frame < input.length; frame += 1) {
      square[frame] = squareCore.processSample(input[frame] ?? 0);
      triangle[frame] = triangleCore.processSample(input[frame] ?? 0);
    }
    expect(saw).not.toEqual(square);
    expect(square).not.toEqual(triangle);
    expect([...square, ...triangle].every(Number.isFinite)).toBe(true);
  });

  it('rejects out-of-contract bands, waveform, pattern, tone, mix and tempo', () => {
    expect(() => new BrowserOscBotCore(7999)).toThrow(/sample rate/);
    expect(() => new BrowserOscBotCore(48_000, { bands: 7 })).toThrow(/integer from 8 to 24/);
    expect(() => new BrowserOscBotCore(48_000, { waveform: 3 as never })).toThrow(/waveform must be/);
    expect(() => new BrowserOscBotCore(48_000, { pattern: 8 })).toThrow(/pattern must be/);
    expect(() => new BrowserOscBotCore(48_000, { toneCutoffHz: 100 })).not.toThrow();
    expect(() => new BrowserOscBotCore(48_000, { toneCutoffHz: 16_000 })).not.toThrow();
    expect(() => new BrowserOscBotCore(24_000, { toneCutoffHz: 16_000 })).toThrow(/below 0.49/);
    expect(() => new BrowserOscBotCore(48_000, { mix: 1.1 })).toThrow(/mix must be/);
    expect(() => new BrowserOscBotCore(48_000, { tempoBpm: 301 })).toThrow(/tempo must be/);
    expect(() => new BrowserOscBotCore(48_000).setParameters({ resonance: 3 } as never)).toThrow(/does not support/);
  });

  it('runs through the shipped Browser FX DSP core with explicit validation and no alias fallback', () => {
    const frames = 24_000;
    const input = tone(48_000, 220, frames, 0.3);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    const core = new BrowserFxDspCore('osc-bot', 48_000, {
      oscBotWaveform: 0,
      oscBotPattern: 3,
      oscBotToneHz: 2600,
      bpm: 110,
      mix: 1,
    });
    expect(core.algorithmicLatencySamples).toBe(0);
    core.processBlock(input, input, outputLeft, outputRight, frames);
    expect([...outputLeft].every(Number.isFinite)).toBe(true);
    expect(rms(outputLeft, 6000, 20_000)).toBeGreaterThan(0.001);
    expect(outputLeft).toEqual(outputRight);
    expect(() => core.setParameters({ oscBotPattern: 8 })).toThrow(/pattern must be/);
    expect(() => new BrowserFxDspCore('osc-bot', 48_000, { vocoderCarrier: 1 })).toThrow(/does not support/);
  });
});
