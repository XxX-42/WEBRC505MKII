import { describe, expect, it } from 'vitest';
import { BrowserSynthDsp } from '../../src/audio/fx/dsp/BrowserSynthDsp';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

function sine(sampleRate: number, frequency: number, frames: number, amplitude = 0.35): Float32Array {
  const result = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    result[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return result;
}

function goertzelMagnitude(
  samples: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  start: number,
  frameCount: number,
): number {
  const count = Math.min(frameCount, samples.length - start);
  const coefficient = 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
  let previous = 0;
  let previous2 = 0;
  for (let index = 0; index < count; index += 1) {
    const current = (samples[start + index] ?? 0) + (coefficient * previous) - previous2;
    previous2 = previous;
    previous = current;
  }
  const power = Math.max(0, (previous * previous) + (previous2 * previous2) - (coefficient * previous * previous2));
  return (2 * Math.sqrt(power)) / Math.max(1, count);
}

function render(
  processor: BrowserSynthDsp,
  left: Float32Array,
  right: Float32Array,
  blockSizes: readonly number[] = [left.length],
): { left: Float32Array; right: Float32Array } {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < left.length) {
    const requested = blockSizes[blockIndex % blockSizes.length] ?? left.length;
    const frameCount = Math.min(Math.max(1, requested), left.length - offset);
    for (let frame = offset; frame < offset + frameCount; frame += 1) {
      processor.processSample(left[frame] ?? 0, right[frame] ?? 0);
      outputLeft[frame] = processor.outputLeft;
      outputRight[frame] = processor.outputRight;
    }
    offset += frameCount;
    blockIndex += 1;
  }
  return { left: outputLeft, right: outputRight };
}

function maximumMagnitude(samples: Float32Array, start = 0): number {
  let maximum = 0;
  for (let frame = start; frame < samples.length; frame += 1) {
    maximum = Math.max(maximum, Math.abs(samples[frame] ?? 0));
  }
  return maximum;
}

describe('clean-room Browser SYNTH', () => {
  it('is accepted by the shipped processor factory and applies named configure updates', () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate;
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'synth',
        sampleRate,
        bypassed: false,
        parameters: { synthSensitivity: 60, synthWaveform: 0, synthOctave: 0, synthToneHz: 4000, synthMixPercent: 0 },
      },
    });
    expect(processor.core.algorithm).toBe('synth');
    processor.port.onmessage?.({
      data: {
        type: 'configure',
        parameters: { synthSensitivity: 75, synthWaveform: 1, synthOctave: 12, synthToneHz: 12_000, synthMixPercent: 100 },
      },
    });

    const input = sine(sampleRate, 220, frameCount, 0.32);
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    expect(processor.process([[input, input]], [[left, right]])).toBe(true);
    const start = Math.floor(sampleRate * 0.35);
    const count = Math.floor(sampleRate * 0.5);
    const octaveMagnitude = goertzelMagnitude(left, sampleRate, 440, start, count);
    const rootMagnitude = goertzelMagnitude(left, sampleRate, 220, start, count);
    expect(octaveMagnitude).toBeGreaterThan(0.05);
    expect(octaveMagnitude).toBeGreaterThan(rootMagnitude * 1.5);
  });

  it('tracks a monophonic sine and resynthesizes the selected octave with polyBLEP', () => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, 220, sampleRate);
    const processor = new BrowserSynthDsp(sampleRate, {
      sensitivity: 70,
      waveform: 0,
      octave: 12,
      tone: 12_000,
      mix: 100,
    });
    const output = render(processor, input, input, [1, 17, 128, 257, 31, 511]).left;
    const analysisStart = Math.floor(sampleRate * 0.35);
    const analysisFrames = Math.floor(sampleRate * 0.3);
    const expectedMagnitude = goertzelMagnitude(output, sampleRate, 440, analysisStart, analysisFrames);
    const inputPitchMagnitude = goertzelMagnitude(output, sampleRate, 220, analysisStart, analysisFrames);

    expect(processor.isVoiced).toBe(true);
    expect(processor.fallbackActive).toBe(false);
    expect(processor.detectorConfidence).toBeGreaterThan(0.8);
    expect(Math.abs(processor.detectedFrequencyHz - 220) / 220).toBeLessThan(0.02);
    expect(expectedMagnitude).toBeGreaterThan(0.08);
    expect(expectedMagnitude).toBeGreaterThan(inputPitchMagnitude * 1.7);
    expect([...output].every(Number.isFinite)).toBe(true);
    expect(maximumMagnitude(output)).toBeLessThanOrEqual(4);
  });

  it('clamps constructor and update values, ignores non-finite updates, and keeps a zero mix exactly dry', () => {
    const processor = new BrowserSynthDsp(48_000, {
      sensitivity: -12,
      waveform: 8,
      octave: 99,
      tone: 80_000,
      mix: 160,
    });
    expect(processor.targetSensitivityPercent).toBe(0);
    expect(processor.targetWaveform).toBe(2);
    expect(processor.targetOctaveSemitones).toBe(24);
    expect(processor.targetToneHz).toBe(16_000);
    expect(processor.targetMixPercent).toBe(100);

    processor.setParameters({ sensitivity: 101, waveform: -4, octave: -90, tone: -1, mix: -20 });
    expect(processor.targetSensitivityPercent).toBe(100);
    expect(processor.targetWaveform).toBe(0);
    expect(processor.targetOctaveSemitones).toBe(-24);
    expect(processor.targetToneHz).toBe(100);
    expect(processor.targetMixPercent).toBe(0);
    processor.setParameters({ sensitivity: Number.NaN, waveform: Number.POSITIVE_INFINITY, octave: Number.NaN, tone: Number.NaN, mix: Number.POSITIVE_INFINITY });
    expect(processor.targetSensitivityPercent).toBe(100);
    expect(processor.targetWaveform).toBe(0);
    expect(processor.targetOctaveSemitones).toBe(-24);
    expect(processor.targetToneHz).toBe(100);
    expect(processor.targetMixPercent).toBe(0);

    const left = Float32Array.from({ length: 300 }, (_, index) => Math.sin(index * 0.13) * 0.4);
    const right = Float32Array.from({ length: 300 }, (_, index) => Math.cos(index * 0.09) * 0.3);
    const dry = new BrowserSynthDsp(48_000, { mix: 0 });
    const output = render(dry, left, right, [1, 31, 127]);
    expect(output.left).toEqual(left);
    expect(output.right).toEqual(right);
  });

  it('changes harmonic content with waveform and tone controls', () => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, 220, Math.floor(sampleRate * 0.8));
    const renderThirdHarmonic = (waveform: number, tone: number): number => {
      const processor = new BrowserSynthDsp(sampleRate, {
        sensitivity: 70,
        waveform,
        octave: 0,
        tone,
        mix: 100,
      });
      const output = render(processor, input, input).left;
      const start = Math.floor(sampleRate * 0.35);
      const count = Math.floor(sampleRate * 0.3);
      return goertzelMagnitude(output, sampleRate, 660, start, count)
        / Math.max(1e-8, goertzelMagnitude(output, sampleRate, 220, start, count));
    };

    const brightSquare = renderThirdHarmonic(1, 16_000);
    const triangle = renderThirdHarmonic(2, 16_000);
    const darkSquare = renderThirdHarmonic(1, 100);
    expect(brightSquare).toBeGreaterThan(0.12);
    expect(triangle).toBeLessThan(brightSquare * 0.35);
    expect(darkSquare).toBeLessThan(brightSquare * 0.4);
  });

  it('falls back to the input when pitch confidence is weak and releases to silence', () => {
    const sampleRate = 48_000;
    const noise = new Float32Array(Math.floor(sampleRate * 0.4));
    let state = 0x4152_1a2b;
    for (let frame = 0; frame < noise.length; frame += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      noise[frame] = ((state / 0x1_0000_0000) * 2 - 1) * 0.2;
    }
    const fallback = new BrowserSynthDsp(sampleRate, { sensitivity: 100, waveform: 1, mix: 100 });
    const fallbackOutput = render(fallback, noise, noise, [1, 9, 64, 511]);
    expect(fallback.fallbackActive).toBe(true);
    expect(fallback.isVoiced).toBe(false);
    expect(fallback.detectedFrequencyHz).toBe(0);
    expect([...fallbackOutput.left, ...fallbackOutput.right].every(Number.isFinite)).toBe(true);
    expect(maximumMagnitude(fallbackOutput.left)).toBeLessThanOrEqual(1);

    const pitched = new BrowserSynthDsp(sampleRate, { sensitivity: 70, waveform: 1, mix: 100 });
    const voice = sine(sampleRate, 330, Math.floor(sampleRate * 0.3));
    render(pitched, voice, voice, [127]);
    expect(pitched.isVoiced).toBe(true);
    const silence = new Float32Array(Math.floor(sampleRate * 0.5));
    const release = render(pitched, silence, silence, [7, 128, 513]);
    expect(pitched.fallbackActive).toBe(true);
    expect(pitched.isVoiced).toBe(false);
    expect(maximumMagnitude(release.left, Math.floor(sampleRate * 0.35))).toBeLessThan(0.01);
    expect(maximumMagnitude(release.right, Math.floor(sampleRate * 0.35))).toBeLessThan(0.01);
  });

  it('produces identical output for different callback block sizes and resets its detector state', () => {
    const sampleRate = 48_000;
    const left = sine(sampleRate, 196, 18_257, 0.3);
    const right = sine(sampleRate, 294, 18_257, 0.22);
    const parameters = { sensitivity: 75, waveform: 1, octave: -5, tone: 7_500, mix: 80 };
    const wholeProcessor = new BrowserSynthDsp(sampleRate, parameters);
    const splitProcessor = new BrowserSynthDsp(sampleRate, parameters);
    const whole = render(wholeProcessor, left, right);
    const split = render(splitProcessor, left, right, [1, 7, 64, 127, 257, 3, 511]);
    expect(split.left).toEqual(whole.left);
    expect(split.right).toEqual(whole.right);

    wholeProcessor.reset();
    expect(wholeProcessor.outputLeft).toBe(0);
    expect(wholeProcessor.outputRight).toBe(0);
    expect(wholeProcessor.isVoiced).toBe(false);
    expect(wholeProcessor.detectorConfidence).toBe(0);
    expect(wholeProcessor.targetOctaveSemitones).toBe(-5);
  });
});
