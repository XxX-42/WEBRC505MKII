import { describe, expect, it } from 'vitest';
import { BrowserTwistDsp } from '../../src/audio/fx/dsp/BrowserTwistDsp';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

function firstArrival(samples: Float32Array, threshold = 0.01): number {
  return samples.findIndex((sample) => Math.abs(sample) >= threshold);
}

function processImpulse(dsp: BrowserTwistDsp, frames: number): Float32Array {
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const input = frame === 0 ? 1 : 0;
    dsp.processSample(input, input);
    output[frame] = dsp.wetOutputLeft;
  }
  return output;
}

function dominantFrequency(samples: Float32Array, sampleRate: number, minimumHz = 250, maximumHz = 500): number {
  let maximumPower = -1;
  let dominantHz = minimumHz;
  const windowSize = samples.length;
  for (let frequency = minimumHz; frequency <= maximumHz; frequency += 2) {
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const coefficient = 2 * Math.cos(omega);
    let previous = 0;
    let previous2 = 0;
    for (let index = 0; index < windowSize; index += 1) {
      const hann = 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (windowSize - 1)));
      const current = (samples[index] ?? 0) * hann + (coefficient * previous) - previous2;
      previous2 = previous;
      previous = current;
    }
    const power = previous2 * previous2 + previous * previous - coefficient * previous * previous2;
    if (power > maximumPower) {
      maximumPower = power;
      dominantHz = frequency;
    }
  }
  return dominantHz;
}

describe('clean-room Browser TWIST', () => {
  it('registers the real AudioWorklet algorithm and rejects unknown identifiers', () => {
    expect(BROWSER_WORKLET_FX_TYPES.TWIST).toBe('twist');
    const processor = new FxProcessor({
      processorOptions: { algorithm: 'twist', sampleRate: 48_000, parameters: { twistAmount: 72 }, bypassed: false },
    });
    expect(processor.core.algorithm).toBe('twist');
    expect(() => new FxProcessor({
      processorOptions: { algorithm: 'twist-unknown' as never, sampleRate: 48_000 },
    })).toThrow('Unsupported Browser FX algorithm: twist-unknown');
  });

  it('uses all four macro curves to place a stereo fractional-delay impulse', () => {
    const amount = 43;
    const expectedDelayMs = [69.3, 48.4, 93.0, 71.3] as const;
    const arrivals: number[] = [];
    for (let trajectory = 0; trajectory < 4; trajectory += 1) {
      const dsp = new BrowserTwistDsp(8_000, { amount, trajectory });
      const output = processImpulse(dsp, 8_000 / 2);
      const arrival = firstArrival(output);
      arrivals.push(arrival);
      expect(arrival).toBeGreaterThan(0);
      expect(Math.abs(arrival - Math.round((expectedDelayMs[trajectory]! * 8_000) / 1000))).toBeLessThanOrEqual(2);
      expect(dsp.currentDelayMs).toBeCloseTo(expectedDelayMs[trajectory]!, 0);
    }
    expect(new Set(arrivals).size).toBe(4);
  });

  it('sweeps the moving read head upward in pitch as macro amount rises', () => {
    const sampleRate = 8_000;
    const dsp = new BrowserTwistDsp(sampleRate, { amount: -80, trajectory: 0 });
    const primingFrames = sampleRate * 2 / 5;
    for (let frame = 0; frame < primingFrames; frame += 1) {
      const sample = 0.5 * Math.sin((2 * Math.PI * 330 * frame) / sampleRate);
      dsp.processSample(sample, sample);
    }
    const sweepFrames = sampleRate;
    const measured: number[] = [];
    const earlyWet = new Float32Array(1_024);
    const lateWet = new Float32Array(1_024);
    const earlySource = new Float32Array(1_024);
    const lateSource = new Float32Array(1_024);
    let earlyDelayMs = 0;
    let lateDelayMs = 0;
    let previous = 0;
    for (let frame = 0; frame < sweepFrames; frame += 1) {
      if (frame % 64 === 0) {
        dsp.setParameters({ amount: -80 + (160 * frame) / sweepFrames });
      }
      const sample = 0.5 * Math.sin((2 * Math.PI * 330 * (primingFrames + frame)) / sampleRate);
      dsp.processSample(sample, sample);
      if (frame >= 800 && frame < 1_824) {
        earlyWet[frame - 800] = dsp.wetOutputLeft;
        earlySource[frame - 800] = sample;
        if (frame === 1_823) earlyDelayMs = dsp.currentDelayMs;
      }
      if (frame >= 6_400 && frame < 7_424) {
        lateWet[frame - 6_400] = dsp.wetOutputLeft;
        lateSource[frame - 6_400] = sample;
        if (frame === 6_423) lateDelayMs = dsp.currentDelayMs;
      }
      if (frame >= sampleRate * 0.4 && frame < sampleRate * 0.9) {
        const current = dsp.wetOutputLeft;
        if (previous <= 0 && current > 0) measured.push(frame);
        previous = current;
      }
    }
    const observedFrequency = (measured.length * sampleRate) / (sampleRate * 0.5);
    expect(observedFrequency).toBeGreaterThan(340);
    expect(dsp.currentDelayMs).toBeLessThan(80);

    const earlyFrequency = dominantFrequency(earlyWet, sampleRate);
    const lateFrequency = dominantFrequency(lateWet, sampleRate);
    const earlySourceFrequency = dominantFrequency(earlySource, sampleRate);
    const lateSourceFrequency = dominantFrequency(lateSource, sampleRate);
    expect(earlyFrequency).toBeGreaterThan(earlySourceFrequency + 20);
    expect(lateFrequency).toBeGreaterThan(lateSourceFrequency + 20);

    // For y(t) = x(t - D(t)), the first-order Doppler ratio is 1 - dD/dt.
    // Verify the measured, smoothed read-head trajectory itself predicts an
    // upward shift, so a zero-crossing count is not the sole pitch evidence.
    const elapsedSeconds = (6_423 - 1_823) / sampleRate;
    const expectedDopplerRatio = 1 - ((lateDelayMs - earlyDelayMs) / 1000) / elapsedSeconds;
    expect(lateDelayMs).toBeLessThan(earlyDelayMs);
    expect(expectedDopplerRatio).toBeGreaterThan(1.1);
  });

  it('keeps high-feedback output bounded and parameter trajectories smoothed', () => {
    const dsp = new BrowserTwistDsp(8_000, { amount: 100 });
    let peak = 0;
    for (let frame = 0; frame < 80_000; frame += 1) {
      dsp.processSample(frame % 17 < 8 ? 8 : -8, frame % 17 < 8 ? 8 : -8);
      peak = Math.max(peak, Math.abs(dsp.wetOutputLeft), Math.abs(dsp.wetOutputRight));
    }
    expect(dsp.currentFeedbackGain).toBeLessThan(0.61);
    expect(peak).toBeLessThanOrEqual(8);
    expect(Number.isFinite(dsp.wetOutputLeft) && Number.isFinite(dsp.wetOutputRight)).toBe(true);
  });

  it('resets delay history and honors dry mix and bit-exact bypass in the core', () => {
    const input = new Float32Array(4_000);
    input[0] = 1;
    const dryCore = new BrowserFxDspCore('twist', 8_000, { mix: 0, twistAmount: 100 });
    const dry = new Float32Array(input.length);
    dryCore.processBlock(input, null, dry, null);
    expect(dry).toEqual(input);

    const bypass = new BrowserFxDspCore('twist', 8_000, { mix: 1, twistAmount: 100 });
    bypass.setBypass(true);
    const bypassOutput = new Float32Array(input.length);
    bypass.processBlock(input, null, bypassOutput, null);
    expect(bypassOutput).toEqual(input);

    const core = new BrowserFxDspCore('twist', 8_000, { mix: 1, twistAmount: -50 });
    const first = new Float32Array(input.length);
    core.processBlock(input, null, first, null);
    core.reset();
    const repeated = new Float32Array(input.length);
    core.processBlock(input, null, repeated, null);
    expect(repeated).toEqual(first);
  });
});
