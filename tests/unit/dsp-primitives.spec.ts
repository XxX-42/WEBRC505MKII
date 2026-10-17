import { describe, expect, it } from 'vitest';
import { DeterministicPrng } from '../../src/audio/dsp/DeterministicPrng';
import { equalPowerCrossfadeSample, writeEqualPowerCrossfadeGains } from '../../src/audio/dsp/equalPowerCrossfade';
import { LagrangeFractionalDelay } from '../../src/audio/dsp/LagrangeFractionalDelay';
import { LinearParameterSmoother } from '../../src/audio/dsp/LinearParameterSmoother';
import { RbjBiquad, designRbjBiquad } from '../../src/audio/dsp/RbjBiquad';
import { SampleFrameScheduler } from '../../src/audio/dsp/SampleFrameScheduler';
import { TptStateVariableFilter } from '../../src/audio/dsp/TptStateVariableFilter';

describe('browser DSP primitives', () => {
  it('ramps a parameter over an exact number of sample frames', () => {
    const smoother = new LinearParameterSmoother(0);
    expect(smoother.setTarget(1, 4)).toBe(true);
    expect([smoother.next(), smoother.next(), smoother.next(), smoother.next()]).toEqual([0.25, 0.5, 0.75, 1]);
    expect(smoother.remainingFrames).toBe(0);
    expect(smoother.setTarget(0.5)).toBe(true);
    expect(smoother.currentValue).toBe(0.5);
    expect(smoother.setTarget(Number.NaN)).toBe(false);
    expect(smoother.currentValue).toBe(0.5);
  });

  it('writes equal-power gains at endpoints and keeps midpoint energy', () => {
    const gains = new Float64Array(2);
    writeEqualPowerCrossfadeGains(0, gains);
    expect(gains[0]).toBeCloseTo(1);
    expect(gains[1]).toBeCloseTo(0);
    writeEqualPowerCrossfadeGains(0.5, gains);
    expect(gains[0] ** 2 + gains[1] ** 2).toBeCloseTo(1);
    expect(equalPowerCrossfadeSample(0, 1, 1)).toBeCloseTo(1);
    expect(equalPowerCrossfadeSample(1, 0, -1)).toBeCloseTo(1);
  });

  it('runs a normalized RBJ DF2T lowpass and permits direct coefficient replacement', () => {
    const biquad = new RbjBiquad(designRbjBiquad('lowpass', 48000, 1200));
    let response = 0;
    for (let index = 0; index < 4096; index += 1) response = biquad.processSample(1);
    expect(response).toBeCloseTo(1, 3);

    biquad.reset();
    expect(biquad.setCoefficients({ b0: 0, b1: 1, b2: 0, a1: 0, a2: 0 })).toBe(true);
    expect(biquad.processSample(2)).toBe(0);
    expect(biquad.processSample(3)).toBe(2);
    expect(biquad.setCoefficients({ b0: Number.NaN, b1: 0, b2: 0, a1: 0, a2: 0 })).toBe(false);
    expect(biquad.setCoefficientsValues(1, 0, 0, 0, 0)).toBe(true);
    biquad.reset();
    expect(biquad.processSample(0.25)).toBe(0.25);
    expect(biquad.setCoefficientsValues(Number.NaN, 0, 0, 0, 0)).toBe(false);
  });

  it('designs normalized RBJ shelves with their specified DC and high-frequency gains', () => {
    const sampleRate = 48000;
    const low = new RbjBiquad(designRbjBiquad('low-shelf', sampleRate, 180, Math.SQRT1_2, 12));
    let lowDc = 0;
    for (let frame = 0; frame < 12000; frame += 1) lowDc = low.processSample(1);
    expect(lowDc).toBeCloseTo(10 ** (12 / 20), 3);

    const high = new RbjBiquad(designRbjBiquad('high-shelf', sampleRate, 6000, Math.SQRT1_2, 12));
    let highDc = 0;
    for (let frame = 0; frame < 12000; frame += 1) highDc = high.processSample(1);
    expect(highDc).toBeCloseTo(1, 3);
    expect(Object.values(designRbjBiquad('high-shelf', sampleRate, 6000, 0.7, -12)).every(Number.isFinite)).toBe(true);
  });

  it('updates all TPT SVF modes and remains finite for a bounded cutoff', () => {
    const filter = new TptStateVariableFilter(48000, 900, 0.707);
    expect(filter.setParameters(1200, 0.8)).toBe(true);
    expect(filter.setParameters(Number.NaN, 0.8)).toBe(false);
    for (let index = 0; index < 2048; index += 1) {
      filter.processSample(index === 0 ? 1 : 0);
      expect(Number.isFinite(filter.lowpass + filter.bandpass + filter.highpass)).toBe(true);
    }
    expect(Math.abs(filter.lowpass)).toBeLessThan(0.01);
    filter.reset();
    expect(filter.highpass).toBe(0);
  });

  it('interpolates cubic sample histories with four-point Lagrange delay', () => {
    const delay = new LagrangeFractionalDelay(16);
    for (let frame = 0; frame <= 12; frame += 1) {
      const value = frame ** 3;
      const output = delay.processSample(value, 2.5);
      if (frame >= 5) expect(output).toBeCloseTo((frame - 2.5) ** 3, 3);
    }
    delay.clear();
    expect(delay.readSample(2.5)).toBe(0);
  });

  it('produces repeatable PRNG sequences and bounded float values', () => {
    const first = new DeterministicPrng(42);
    const second = new DeterministicPrng(42);
    const firstValues = new Uint32Array(12);
    for (let index = 0; index < firstValues.length; index += 1) firstValues[index] = first.nextUint32();
    const secondValues = new Uint32Array(12);
    for (let index = 0; index < secondValues.length; index += 1) secondValues[index] = second.nextUint32();
    expect(firstValues).toEqual(secondValues);
    const value = first.nextFloat();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
    const filled = new Float32Array(8);
    first.fillFloat32(filled, true);
    expect([...filled].every((sample) => sample >= -1 && sample < 1)).toBe(true);
  });

  it('schedules equal-frame events stably and reports offsets in variable blocks', () => {
    const scheduler = new SampleFrameScheduler(4, 100);
    expect(scheduler.scheduleAtFrame(104, 2, 0.25)).toBe(true);
    expect(scheduler.scheduleAtFrame(101, 1)).toBe(true);
    expect(scheduler.scheduleAtFrame(101, 3, 0.5)).toBe(true);
    expect(scheduler.beginBlock(8)).toBe(true);
    expect(scheduler.nextEventOffset()).toBe(1);
    expect(scheduler.dequeueNextEvent()).toBe(true);
    expect([scheduler.eventFrame, scheduler.eventCode]).toEqual([101, 1]);
    expect(scheduler.nextEventOffset()).toBe(1);
    expect(scheduler.dequeueNextEvent()).toBe(true);
    expect(scheduler.eventCode).toBe(3);
    expect(scheduler.nextEventOffset()).toBe(4);
    expect(scheduler.dequeueNextEvent()).toBe(true);
    expect(scheduler.eventValue).toBe(0.25);
    expect(scheduler.endBlock()).toBe(true);
    expect(scheduler.currentFrame).toBe(108);
    expect(scheduler.scheduleAtFrame(107, 9)).toBe(false);
  });
});
