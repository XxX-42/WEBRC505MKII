import { describe, expect, it } from 'vitest';
import {
  PITCH_MODE_CONTRACT,
  isPitchModeImplemented,
  renderPitchOffline,
} from '../../src/audio/pitch';

const SAMPLE_RATE = 48_000;

function sine(frequency: number, length: number): Float32Array {
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) output[i] = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
  return output;
}

function dominantFrequency(signal: Float32Array, start: number, length: number, lowHz: number, highHz: number): number {
  let bestFrequency = lowHz;
  let bestPower = -1;
  const last = Math.min(signal.length, start + length);
  const count = last - start;
  for (let frequency = lowHz; frequency <= highHz; frequency += 0.25) {
    const angle = (2 * Math.PI * frequency) / SAMPLE_RATE;
    const cosine = Math.cos(angle);
    const sineAngle = Math.sin(angle);
    let real = 0;
    let imaginary = 0;
    let phaseReal = 1;
    let phaseImaginary = 0;
    for (let i = start; i < last; i += 1) {
      const sample = signal[i]!;
      real += sample * phaseReal;
      imaginary -= sample * phaseImaginary;
      const nextReal = phaseReal * cosine - phaseImaginary * sineAngle;
      phaseImaginary = phaseReal * sineAngle + phaseImaginary * cosine;
      phaseReal = nextReal;
    }
    const power = real * real + imaginary * imaginary;
    if (power > bestPower) {
      bestPower = power;
      bestFrequency = frequency;
    }
  }
  if (count <= 0) throw new RangeError('analysis region is empty');
  return bestFrequency;
}

describe('Signalsmith pitch and KeepPitch adapters', () => {
  it('reports implemented and unavailable mode paths honestly', () => {
    expect(isPitchModeImplemented('LIVE_POLY')).toBe(true);
    expect(isPitchModeImplemented('HQ_RENDER')).toBe(true);
    expect(isPitchModeImplemented('LIVE_MONO')).toBe(true);
    expect(PITCH_MODE_CONTRACT.LIVE_MONO.engine).toContain('YIN');
    expect(PITCH_MODE_CONTRACT.LIVE_POLY.engine).toContain('Signalsmith Stretch 1.3.2');
    expect(PITCH_MODE_CONTRACT.LIVE_POLY.notes.join(' ')).toContain('per-track opt-in');
    expect(PITCH_MODE_CONTRACT.LIVE_POLY.notes.join(' ')).toContain('pinned official MIT C++ source');
  });

  it('renders a +7 semitone pitch shift while stretching time at constant pitch', async () => {
    const input = sine(440, SAMPLE_RATE * 2);
    const result = await renderPitchOffline([input], {
      mode: 'HQ_RENDER',
      sampleRate: SAMPLE_RATE,
      semitones: 7,
      playbackRate: 0.8,
    });

    expect(result.channels[0]!.length).toBe(Math.ceil(input.length / 0.8) + result.latencySamples);
    expect(result.windowSamples).toBe(5_760);
    expect(result.hopSamples).toBe(1_440);
    expect(result.latencySamples).toBe(result.inputLatencySamples + result.outputLatencySamples);
    const target = 440 * 2 ** (7 / 12);
    const measured = dominantFrequency(
      result.channels[0]!,
      result.leadingLatencySamples + Math.floor(SAMPLE_RATE * 0.5),
      SAMPLE_RATE,
      640,
      680,
    );
    const centsError = Math.abs(1200 * Math.log2(measured / target));
    expect(centsError).toBeLessThan(8);
  }, 30_000);

  it('reports algorithmic delay and keeps stereo phase locked for identical channels', async () => {
    const input = new Float32Array(SAMPLE_RATE).fill(0);
    input[0] = 1;
    const result = await renderPitchOffline([input, input], {
      mode: 'HQ_RENDER',
      sampleRate: SAMPLE_RATE,
      semitones: 0,
      playbackRate: 1,
    });

    expect(result.latencySamples).toBe(result.inputLatencySamples + result.outputLatencySamples);
    const firstAudible = result.channels[0]!.findIndex((sample) => Math.abs(sample) > 1e-5);
    expect(firstAudible).toBe(result.latencySamples);
    let maxChannelDifference = 0;
    for (let i = 0; i < result.channels[0]!.length; i += 1) {
      maxChannelDifference = Math.max(
        maxChannelDifference,
        Math.abs(result.channels[0]![i]! - result.channels[1]![i]!),
      );
    }
    expect(maxChannelDifference).toBeLessThan(1e-6);
  }, 30_000);
});
