import { describe, expect, it } from 'vitest';
import { LiveMonoPitchProcessor, YinPitchDetector } from '../../src/audio/pitch/liveMono';

function sine(sampleRate: number, frequency: number, frameCount: number, amplitude = 0.4): Float32Array {
  const signal = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    signal[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return signal;
}

function measuredByPositiveCrossings(
  signal: Float32Array,
  sampleRate: number,
  start: number,
  frameCount: number,
): number {
  const end = Math.min(signal.length, start + frameCount);
  let firstCrossing = -1;
  let lastCrossing = -1;
  let crossingCount = 0;
  for (let i = Math.max(1, start); i < end; i += 1) {
    if (signal[i - 1]! <= 0 && signal[i]! > 0) {
      if (firstCrossing < 0) firstCrossing = i;
      lastCrossing = i;
      crossingCount += 1;
    }
  }
  if (crossingCount < 2) throw new Error('Not enough positive-going zero crossings to measure pitch');
  return ((crossingCount - 1) * sampleRate) / (lastCrossing - firstCrossing);
}

function seededNoise(frameCount: number): Float32Array {
  const output = new Float32Array(frameCount);
  let state = 0x1234_5678;
  for (let i = 0; i < frameCount; i += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[i] = ((state / 0x1_0000_0000) * 2 - 1) * 0.25;
  }
  return output;
}

describe('standalone LIVE_MONO YIN/PSOLA engine', () => {
  it.each([82.41, 110, 220, 440, 880])('tracks a voiced %s Hz sinusoid with YIN', (frequency) => {
    const detector = new YinPitchDetector(12_000, {
      minimumFrequencyHz: 70,
      maximumFrequencyHz: 1_200,
    });
    for (let i = 0; i < 12_000; i += 1) {
      detector.pushSample(0.4 * Math.sin((2 * Math.PI * frequency * i) / 12_000));
    }

    expect(detector.voiced).toBe(true);
    expect(detector.frequencyHz).toBeGreaterThan(0);
    expect(Math.abs(detector.frequencyHz - frequency) / frequency).toBeLessThan(0.015);
    expect(detector.confidence).toBeGreaterThan(0.8);
  });

  it('rejects silence and unvoiced noise', () => {
    const detector = new YinPitchDetector(12_000);
    for (let i = 0; i < 6_000; i += 1) detector.pushSample(0);
    expect(detector.voiced).toBe(false);
    expect(detector.frequencyHz).toBe(0);

    const noiseDetector = new YinPitchDetector(12_000);
    const noise = seededNoise(12_000);
    for (let i = 0; i < noise.length; i += 1) noiseDetector.pushSample(noise[i]!);
    expect(noiseDetector.voiced).toBe(false);
    expect(noiseDetector.frequencyHz).toBe(0);
  });

  it('passes unvoiced noise through at the declared delay instead of pitch-locking it', () => {
    const sampleRate = 48_000;
    const input = seededNoise(sampleRate / 2);
    const output = new Float32Array(input.length);
    const processor = new LiveMonoPitchProcessor({ sampleRate, semitones: 7 });
    processor.process(input, output);

    const start = processor.latencySamples + Math.floor(sampleRate * 0.1);
    const end = input.length;
    for (let i = start; i < end; i += 97) {
      expect(output[i]).toBe(input[i - processor.latencySamples]);
    }
  });

  it.each([
    { inputFrequency: 440, semitones: 7 },
    { inputFrequency: 220, semitones: -5 },
  ])('pitch shifts a sustained $inputFrequency Hz mono tone by $semitones semitones', ({ inputFrequency, semitones }) => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, inputFrequency, sampleRate);
    const output = new Float32Array(input.length);
    const processor = new LiveMonoPitchProcessor({ sampleRate, semitones });
    processor.process(input, output);

    expect(processor.latencySamples).toBeGreaterThan(0);
    expect(processor.latencySeconds).toBeCloseTo(processor.latencySamples / sampleRate, 12);
    expect(processor.bufferCapacitySamples).toBeGreaterThan(processor.latencySamples);
    const frequency = measuredByPositiveCrossings(
      output,
      sampleRate,
      processor.latencySamples + Math.floor(sampleRate * 0.2),
      Math.floor(sampleRate * 0.25),
    );
    const expected = inputFrequency * 2 ** (semitones / 12);
    expect(Math.abs(frequency - expected) / expected).toBeLessThan(0.025);
  });

  it('keeps impulse transients sharp through the delayed bypass', () => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, 220, sampleRate);
    const impulseAt = Math.floor(sampleRate * 0.4);
    input[impulseAt] = 1;
    const output = new Float32Array(input.length);
    const processor = new LiveMonoPitchProcessor({ sampleRate, semitones: 7 });
    processor.process(input, output);

    const delayedImpulseAt = impulseAt + processor.latencySamples;
    expect(output[delayedImpulseAt]).toBeCloseTo(1, 5);
    let localPeak = 0;
    for (let i = delayedImpulseAt - 2; i <= delayedImpulseAt + 2; i += 1) {
      localPeak = Math.max(localPeak, Math.abs(output[i]!));
    }
    expect(localPeak).toBeGreaterThan(0.9);
  });

  it('preserves exact output across variable callback block sizes', () => {
    const sampleRate = 48_000;
    const input = sine(sampleRate, 330, 16_000);
    const oneBlockOutput = new Float32Array(input.length);
    const variedBlockOutput = new Float32Array(input.length);
    const oneBlockProcessor = new LiveMonoPitchProcessor({ sampleRate, semitones: -5 });
    const variedBlockProcessor = new LiveMonoPitchProcessor({ sampleRate, semitones: -5 });
    oneBlockProcessor.process(input, oneBlockOutput);

    const blockSizes = [1, 17, 128, 511, 32, 257, 64];
    let offset = 0;
    let blockIndex = 0;
    while (offset < input.length) {
      const blockCount = Math.min(blockSizes[blockIndex % blockSizes.length]!, input.length - offset);
      variedBlockProcessor.process(input, variedBlockOutput, blockCount, offset, offset);
      offset += blockCount;
      blockIndex += 1;
    }

    let maximumDifference = 0;
    for (let i = 0; i < input.length; i += 1) {
      maximumDifference = Math.max(maximumDifference, Math.abs(oneBlockOutput[i]! - variedBlockOutput[i]!));
    }
    expect(maximumDifference).toBe(0);
  });
});
