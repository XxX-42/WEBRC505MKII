import { describe, expect, it } from 'vitest';
import { BrowserG2bDsp } from '../../src/audio/fx/dsp/BrowserG2bDsp';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

function sine(sampleRate: number, frequency: number, frames: number, amplitude = 0.32): Float32Array {
  return Float32Array.from({ length: frames }, (_, frame) => amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate));
}

function goertzelMagnitude(samples: Float32Array, sampleRate: number, frequencyHz: number, start: number, count: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
  let previous = 0;
  let previous2 = 0;
  for (let frame = start; frame < Math.min(samples.length, start + count); frame += 1) {
    const current = (samples[frame] ?? 0) + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = Math.max(0, previous * previous + previous2 * previous2 - coefficient * previous * previous2);
  return 2 * Math.sqrt(power) / Math.max(1, Math.min(count, samples.length - start));
}

function render(processor: BrowserG2bDsp, input: Float32Array, blockSizes: readonly number[] = [input.length]): Float32Array {
  const output = new Float32Array(input.length);
  let frame = 0;
  let block = 0;
  while (frame < input.length) {
    const length = Math.min(Math.max(1, blockSizes[block % blockSizes.length] ?? input.length), input.length - frame);
    for (let offset = frame; offset < frame + length; offset += 1) {
      processor.processSample(input[offset] ?? 0, input[offset] ?? 0);
      output[offset] = processor.outputLeft;
    }
    frame += length;
    block += 1;
  }
  return output;
}

describe('clean-room Browser G2B', () => {
  it('uses an explicit octave-down square voice, not the SYNTH source-pitch default', () => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, 220, sampleRate);
    const processor = new BrowserG2bDsp(sampleRate, { tracking: 75, blend: 100, body: 500 });
    const output = render(processor, input, [1, 17, 128, 257, 31]);
    const start = Math.floor(sampleRate * 0.35);
    const count = Math.floor(sampleRate * 0.3);
    const bassFundamental = goertzelMagnitude(output, sampleRate, 110, start, count);
    const sourcePitch = goertzelMagnitude(output, sampleRate, 220, start, count);
    const twoOctavesDown = goertzelMagnitude(output, sampleRate, 55, start, count);

    expect(BROWSER_WORKLET_FX_TYPES.G2B).toBe('g2b');
    const core = new BrowserFxDspCore('g2b', sampleRate);
    expect(core.algorithm).toBe('g2b');
    expect(core.algorithmicLatencySamples).toBe(2_868); // provisional 59.75 ms low-note YIN acquisition estimate at 48 kHz
    expect(processor.isVoiced).toBe(true);
    expect(Math.abs(processor.detectedFrequencyHz - 220) / 220).toBeLessThan(0.02);
    expect(bassFundamental).toBeGreaterThan(0.04);
    expect(bassFundamental).toBeGreaterThan(sourcePitch * 2);
    expect(bassFundamental).toBeGreaterThan(twoOctavesDown * 2);
    expect([...output].every(Number.isFinite)).toBe(true);
  });

  it('honors blend, body cutoff, and bounded controls without callback-size dependence', () => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, 196, 24_000, 0.3);
    const wet = new BrowserG2bDsp(sampleRate, { tracking: 70, blend: 100, body: 1200 });
    const whole = render(wet, input);
    const split = render(new BrowserG2bDsp(sampleRate, { tracking: 70, blend: 100, body: 1200 }), input, [1, 7, 64, 127, 257, 3]);
    expect(split).toEqual(whole);
    expect(wet.targetTrackingPercent).toBe(70);
    expect(wet.targetBlendPercent).toBe(100);
    expect(wet.targetBodyHz).toBe(1200);

    const darker = render(new BrowserG2bDsp(sampleRate, { tracking: 70, blend: 100, body: 60 }), input);
    const start = Math.floor(sampleRate * 0.35);
    const count = Math.floor(sampleRate * 0.15);
    const brightBass = goertzelMagnitude(whole, sampleRate, 98, start, count);
    const brightThird = goertzelMagnitude(whole, sampleRate, 294, start, count);
    const darkBass = goertzelMagnitude(darker, sampleRate, 98, start, count);
    const darkThird = goertzelMagnitude(darker, sampleRate, 294, start, count);
    // The resonant body filter can lift energy around its cutoff, so compare
    // the generated square's harmonic ratio rather than raw fundamental level.
    expect(darkThird / darkBass).toBeLessThan((brightThird / brightBass) * 0.5);

    const dry = new BrowserG2bDsp(sampleRate, { blend: 0 });
    expect(render(dry, input, [17, 128])).toEqual(input);
    const clamped = new BrowserG2bDsp(sampleRate, { tracking: 180, blend: -2, body: 12 });
    expect(clamped.targetTrackingPercent).toBe(100);
    expect(clamped.targetBlendPercent).toBe(0);
    expect(clamped.targetBodyHz).toBe(60);
  });

  it('constructs through the shipped AudioWorklet and accepts named updates', () => {
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'g2b',
        sampleRate: 48_000,
        bypassed: false,
        parameters: { g2bTrackingPercent: 65, g2bBlendPercent: 65, g2bBodyHz: 180 },
      },
    });
    expect(processor.core.algorithm).toBe('g2b');
    processor.port.onmessage?.({
      data: { type: 'configure', parameters: { g2bTrackingPercent: 82, g2bBlendPercent: 93, g2bBodyHz: 410 } },
    });
    const frames = 48_000;
    const input = sine(48_000, 220, frames);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    expect(processor.process([[input, input]], [[left, right]])).toBe(true);
    expect([...left, ...right].every(Number.isFinite)).toBe(true);
    const bass = goertzelMagnitude(left, 48_000, 110, 16_800, 14_400);
    const source = goertzelMagnitude(left, 48_000, 220, 16_800, 14_400);
    expect(bass).toBeGreaterThan(source * 1.7);
  });
});
