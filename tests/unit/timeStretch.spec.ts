import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface TimeStretchState {
  windowFrames: number;
  binCount: number;
  pendingIndex: number;
  playbackFrame: number;
  underruns: number;
  autoResets: number;
  firstHop: boolean;
  binAngles: Float64Array;
  outLeft: number;
  outRight: number;
}

type Reader = (frame: number) => number;
type TimeStretchModule = {
  TIME_STRETCH_WINDOW_FRAMES: number;
  TIME_STRETCH_HOP_FRAMES: number;
  createTimeStretchState(windowFrames: number, hopFrames: number): TimeStretchState;
  resetTimeStretchState(state: TimeStretchState, sourceFrame?: number, playbackFrame?: number): void;
  processTimeStretchFrame(state: TimeStretchState, loopFrames: number, speed: number, reverse: boolean, readLeft: Reader, readRight: Reader): void;
  prepareTimeStretchHop(state: TimeStretchState, loopFrames: number, speed: number, reverse: boolean, readLeft: Reader, readRight: Reader): boolean;
};

const SAMPLE_RATE = 48_000;
let core: TimeStretchModule;

beforeAll(async () => {
  // Load the actual ESM file served to AudioWorklet and ProjectService.
  const modulePath = resolve(process.cwd(), 'public/worklets/time-stretch-core.js');
  core = await import(pathToFileURL(modulePath).href) as TimeStretchModule;
});

function makeStereoTone(frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const time = index / SAMPLE_RATE;
    left[index] = 0.42 * Math.sin(2 * Math.PI * 252.7 * time) + 0.2 * Math.sin(2 * Math.PI * 713.3 * time + 0.3);
    right[index] = 0.37 * Math.sin(2 * Math.PI * 371.4 * time + 0.5) + 0.18 * Math.sin(2 * Math.PI * 941.2 * time);
  }
  return { left, right };
}

function linearReader(input: Float32Array): Reader {
  return (frame) => {
    if (frame < 0 || frame >= input.length) return 0;
    const lower = Math.floor(frame);
    const upper = Math.min(input.length - 1, lower + 1);
    const fraction = frame - lower;
    return input[lower]! * (1 - fraction) + input[upper]! * fraction;
  };
}

function render(speed: number, left: Float32Array, right: Float32Array, frames: number) {
  const windowFrames = core.TIME_STRETCH_WINDOW_FRAMES;
  const hopFrames = core.TIME_STRETCH_HOP_FRAMES;
  const state = core.createTimeStretchState(windowFrames, hopFrames);
  const readLeft = linearReader(left);
  const readRight = linearReader(right);
  const outputLeft = new Float32Array(frames);
  const outputRight = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    core.processTimeStretchFrame(state, 0, speed, false, readLeft, readRight);
    outputLeft[index] = state.outLeft;
    outputRight[index] = state.outRight;
  }
  return { state, left: outputLeft, right: outputRight };
}

function estimateTone(samples: Float32Array, expectedHz: number, start: number, length: number): number {
  const window = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
  }
  let bestFrequency = expectedHz;
  let bestPower = -1;
  for (let frequency = expectedHz - 12; frequency <= expectedHz + 12.001; frequency += 0.25) {
    const angularStep = 2 * Math.PI * frequency / SAMPLE_RATE;
    const cosineStep = Math.cos(angularStep);
    const sineStep = Math.sin(angularStep);
    let cosine = 1;
    let sine = 0;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < length; index += 1) {
      const sample = samples[start + index]! * window[index]!;
      real += sample * cosine;
      imaginary -= sample * sine;
      const nextCosine = cosine * cosineStep - sine * sineStep;
      sine = sine * cosineStep + cosine * sineStep;
      cosine = nextCosine;
    }
    const power = real * real + imaginary * imaginary;
    if (power > bestPower) {
      bestPower = power;
      bestFrequency = frequency;
    }
  }
  return bestFrequency;
}

function toneMagnitude(samples: Float32Array, frequency: number, start: number, length: number): number {
  let real = 0;
  let imaginary = 0;
  let windowSum = 0;
  const step = 2 * Math.PI * frequency / SAMPLE_RATE;
  const cosineStep = Math.cos(step);
  const sineStep = Math.sin(step);
  let cosine = 1;
  let sine = 0;
  for (let index = 0; index < length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
    const sample = samples[start + index]! * window;
    real += sample * cosine;
    imaginary -= sample * sine;
    windowSum += window;
    const nextCosine = cosine * cosineStep - sine * sineStep;
    sine = sine * cosineStep + cosine * sineStep;
    cosine = nextCosine;
  }
  return 2 * Math.hypot(real, imaginary) / windowSum;
}

function rms(samples: Float32Array, start: number, length: number): number {
  let power = 0;
  for (let index = start; index < start + length; index += 1) power += samples[index]! * samples[index]!;
  return Math.sqrt(power / length);
}

function maximumMagnitude(samples: Float32Array): number {
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, Math.abs(sample));
  return maximum;
}

function phaseDifference(left: Float32Array, right: Float32Array, frequency: number, start: number, length: number): number {
  const channelPhase = (samples: Float32Array) => {
    let real = 0;
    let imaginary = 0;
    const step = 2 * Math.PI * frequency / SAMPLE_RATE;
    const cosineStep = Math.cos(step);
    const sineStep = Math.sin(step);
    let cosine = 1;
    let sine = 0;
    for (let index = 0; index < length; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
      const sample = samples[start + index]! * window;
      real += sample * cosine;
      imaginary -= sample * sine;
      const nextCosine = cosine * cosineStep - sine * sineStep;
      sine = sine * cosineStep + cosine * sineStep;
      cosine = nextCosine;
    }
    return Math.atan2(imaginary, real);
  };
  return channelPhase(right) - channelPhase(left);
}

function wrapRadians(value: number): number {
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

describe('shared stereo keep-pitch time-stretch core', () => {
  it.each([0.5, 1.3, 2])('preserves both independent stereo tones and scales duration at %.2fx', (speed) => {
    const sourceFrames = SAMPLE_RATE;
    const source = makeStereoTone(sourceFrames);
    const outputFrames = Math.ceil(sourceFrames / speed);
    const output = render(speed, source.left, source.right, outputFrames);
    const analysisLength = Math.min(48_000, outputFrames - 8_000);
    const analysisStart = Math.floor((outputFrames - analysisLength) / 2);

    expect(output.left).toHaveLength(outputFrames);
    expect(output.right).toHaveLength(outputFrames);
    expect(output.state.playbackFrame).toBe(outputFrames);
    const leftLow = estimateTone(output.left, 252.7, analysisStart, analysisLength);
    const leftHigh = estimateTone(output.left, 713.3, analysisStart, analysisLength);
    const rightLow = estimateTone(output.right, 371.4, analysisStart, analysisLength);
    const rightHigh = estimateTone(output.right, 941.2, analysisStart, analysisLength);
    expect(Math.abs(leftLow - 252.7) / 252.7).toBeLessThan(0.02);
    expect(Math.abs(leftHigh - 713.3) / 713.3).toBeLessThan(0.02);
    expect(Math.abs(rightLow - 371.4) / 371.4).toBeLessThan(0.02);
    expect(Math.abs(rightHigh - 941.2) / 941.2).toBeLessThan(0.02);
    const leftLowLevel = toneMagnitude(output.left, 252.7, analysisStart, analysisLength);
    const leftHighLevel = toneMagnitude(output.left, 713.3, analysisStart, analysisLength);
    const rightLowLevel = toneMagnitude(output.right, 371.4, analysisStart, analysisLength);
    const rightHighLevel = toneMagnitude(output.right, 941.2, analysisStart, analysisLength);
    expect(leftLowLevel / 0.42).toBeGreaterThan(0.9);
    expect(leftLowLevel / 0.42).toBeLessThan(1.1);
    expect(leftHighLevel / 0.2).toBeGreaterThan(0.9);
    expect(leftHighLevel / 0.2).toBeLessThan(1.1);
    expect(rightLowLevel / 0.37).toBeGreaterThan(0.9);
    expect(rightLowLevel / 0.37).toBeLessThan(1.1);
    expect(rightHighLevel / 0.18).toBeGreaterThan(0.9);
    expect(rightHighLevel / 0.18).toBeLessThan(1.1);
    expect(toneMagnitude(output.left, 371.4, analysisStart, analysisLength) / leftLowLevel).toBeLessThan(0.02);
    expect(toneMagnitude(output.left, 941.2, analysisStart, analysisLength) / leftHighLevel).toBeLessThan(0.02);
    expect(toneMagnitude(output.right, 252.7, analysisStart, analysisLength) / rightLowLevel).toBeLessThan(0.02);
    expect(toneMagnitude(output.right, 713.3, analysisStart, analysisLength) / rightHighLevel).toBeLessThan(0.02);
  });

  it.each([0.5, 1.3, 2])('keeps widely separated left and right signals isolated at %.2fx', (speed) => {
    const sourceFrames = SAMPLE_RATE;
    const left = new Float32Array(sourceFrames);
    const right = new Float32Array(sourceFrames);
    for (let index = 0; index < sourceFrames; index += 1) {
      const time = index / SAMPLE_RATE;
      left[index] = Math.sin(2 * Math.PI * 233.3 * time);
      right[index] = Math.sin(2 * Math.PI * 1379.1 * time + 0.4);
    }
    const outputFrames = Math.ceil(sourceFrames / speed);
    const output = render(speed, left, right, outputFrames);
    const length = Math.min(24_000, outputFrames - 4_000);
    const start = Math.floor((outputFrames - length) / 2);
    const leftLevel = toneMagnitude(output.left, 233.3, start, length);
    const rightLevel = toneMagnitude(output.right, 1379.1, start, length);
    expect(toneMagnitude(output.left, 1379.1, start, length) / leftLevel).toBeLessThan(0.02);
    expect(toneMagnitude(output.right, 233.3, start, length) / rightLevel).toBeLessThan(0.02);
  });

  it.each([0.5, 1.3, 2])('preserves a musical multi-tone signal at %.2fx', (speed) => {
    const sourceFrames = SAMPLE_RATE * 2;
    const left = new Float32Array(sourceFrames);
    const right = new Float32Array(sourceFrames);
    const leftTones = [110.3, 220.7, 329.6, 493.9, 659.1, 987.3];
    const rightTones = [146.8, 293.7, 440.2, 587.6, 783.8, 1174.7];
    for (let index = 0; index < sourceFrames; index += 1) {
      const time = index / SAMPLE_RATE;
      left[index] = leftTones.reduce((sum, frequency, tone) => sum + 0.13 * Math.sin(2 * Math.PI * frequency * time + tone * 0.17), 0);
      right[index] = rightTones.reduce((sum, frequency, tone) => sum + 0.13 * Math.sin(2 * Math.PI * frequency * time + tone * 0.23), 0);
    }

    const outputFrames = Math.ceil(sourceFrames / speed);
    const output = render(speed, left, right, outputFrames);
    const analysisLength = Math.min(48_000, outputFrames - 8_000);
    const analysisStart = Math.floor((outputFrames - analysisLength) / 2);
    for (const frequency of leftTones) {
      const measured = estimateTone(output.left, frequency, analysisStart, analysisLength);
      expect(Math.abs(measured - frequency) / frequency).toBeLessThan(0.02);
      expect(toneMagnitude(output.left, frequency, analysisStart, analysisLength) / 0.13).toBeGreaterThan(0.9);
      expect(toneMagnitude(output.left, frequency, analysisStart, analysisLength) / 0.13).toBeLessThan(1.1);
    }
    for (const frequency of rightTones) {
      const measured = estimateTone(output.right, frequency, analysisStart, analysisLength);
      expect(Math.abs(measured - frequency) / frequency).toBeLessThan(0.02);
      expect(toneMagnitude(output.right, frequency, analysisStart, analysisLength) / 0.13).toBeGreaterThan(0.9);
      expect(toneMagnitude(output.right, frequency, analysisStart, analysisLength) / 0.13).toBeLessThan(1.1);
    }
    const inputRms = rms(left, 0, left.length);
    const outputRms = rms(output.left, analysisStart, analysisLength);
    expect(outputRms / inputRms).toBeGreaterThan(0.96);
    expect(outputRms / inputRms).toBeLessThan(1.04);
  });

  it.each([0.5, 1.3, 2])('keeps an empty right channel silent beside a multitone left channel at %.2fx', (speed) => {
    const sourceFrames = SAMPLE_RATE;
    const left = new Float32Array(sourceFrames);
    const right = new Float32Array(sourceFrames);
    for (let index = 0; index < sourceFrames; index += 1) {
      const time = index / SAMPLE_RATE;
      left[index] = 0.2 * Math.sin(2 * Math.PI * 173.21 * time) + 0.15 * Math.sin(2 * Math.PI * 519.61 * time + 0.3);
    }
    const output = render(speed, left, right, Math.ceil(sourceFrames / speed));
    expect(maximumMagnitude(output.right)).toBeLessThan(1e-8);
  });

  it.each([0.5, 1.3, 2])('preserves interchannel phase for a shared tone at %.2fx', (speed) => {
    const sourceFrames = SAMPLE_RATE;
    const phaseOffset = 0.73;
    const left = new Float32Array(sourceFrames);
    const right = new Float32Array(sourceFrames);
    for (let index = 0; index < sourceFrames; index += 1) {
      const time = index / SAMPLE_RATE;
      left[index] = 0.7 * Math.sin(2 * Math.PI * 440.37 * time);
      right[index] = 0.7 * Math.sin(2 * Math.PI * 440.37 * time + phaseOffset);
    }
    const outputFrames = Math.ceil(sourceFrames / speed);
    const output = render(speed, left, right, outputFrames);
    const length = Math.min(32_000, outputFrames - 8_000);
    const start = Math.floor((outputFrames - length) / 2);
    const measuredOffset = phaseDifference(output.left, output.right, 440.37, start, length);
    expect(Math.abs(wrapRadians(measuredOffset - phaseOffset))).toBeLessThan(0.12);
  });

  it.each([0.5, 1.3, 2])('preserves frame-zero and frame-one onset at %.2fx', (speed) => {
    for (const pulseFrame of [0, 1]) {
      const left = new Float32Array(256);
      const right = new Float32Array(256);
      left[pulseFrame] = 1;
      right[pulseFrame] = -1;
      const output = render(speed, left, right, 64);
      const firstPeak = Math.max(...Array.from(output.left.slice(0, 32), Math.abs));
      const firstNonzero = output.left.findIndex((sample) => Math.abs(sample) > 1e-4);

      expect(firstPeak).toBeGreaterThan(0.2);
      expect(firstNonzero).toBeGreaterThanOrEqual(0);
      expect(firstNonzero).toBeLessThanOrEqual(Math.ceil(pulseFrame / speed) + 1);
      expect(maximumMagnitude(output.right.slice(0, 32))).toBeGreaterThan(0.2);
      for (let index = 0; index < output.left.length; index += 1) {
        expect(Math.abs(output.left[index]! + output.right[index]!)).toBeLessThan(1e-6);
      }
    }
  });

  it.each([0.5, 1.3, 2])('keeps a shared transient timeline for different stereo pulses at %.2fx', (speed) => {
    const left = new Float32Array(256);
    const right = new Float32Array(256);
    left[0] = 1;
    right[1] = 0.75;
    const output = render(speed, left, right, 64);
    const leftFirst = output.left.findIndex((sample) => Math.abs(sample) > 1e-4);
    const rightFirst = output.right.findIndex((sample) => Math.abs(sample) > 1e-4);

    expect(leftFirst).toBeGreaterThanOrEqual(0);
    expect(rightFirst).toBeGreaterThanOrEqual(0);
    expect(leftFirst).toBeLessThanOrEqual(1);
    expect(rightFirst).toBeLessThanOrEqual(1);
    expect(maximumMagnitude(output.left.slice(0, 32))).toBeGreaterThan(0.2);
    expect(maximumMagnitude(output.right.slice(0, 32))).toBeGreaterThan(0.1);
  });

  it.each([0.5, 1.3, 2])('has bounded startup level and a smooth PV handoff at %.2fx', (speed) => {
    const frames = 2_048;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      left[index] = 0.7 * Math.sin(2 * Math.PI * 252.7 * index / SAMPLE_RATE);
      right[index] = 0.7 * Math.sin(2 * Math.PI * 371.4 * index / SAMPLE_RATE + 0.4);
    }
    const output = render(speed, left, right, 64);
    let maximumStep = 0;
    for (let index = 1; index < output.left.length; index += 1) {
      maximumStep = Math.max(maximumStep, Math.abs(output.left[index]! - output.left[index - 1]!));
      maximumStep = Math.max(maximumStep, Math.abs(output.right[index]! - output.right[index - 1]!));
    }

    expect(maximumMagnitude(output.left)).toBeLessThan(0.9);
    expect(maximumMagnitude(output.right)).toBeLessThan(0.9);
    expect(maximumStep).toBeLessThan(0.15);
  });

  it('keeps a constant step at unity amplitude through the startup crossfade', () => {
    const step = new Float32Array(256).fill(1);
    const output = render(2, step, step, 64);
    for (let index = 0; index < 32; index += 1) {
      expect(output.left[index]).toBeGreaterThan(0.9);
      expect(output.left[index]).toBeLessThan(1.1);
      expect(output.right[index]).toBeCloseTo(output.left[index]!, 6);
    }
  });

  it('wraps both channels through the same loop frame and supports reverse coordinates', () => {
    const state = core.createTimeStretchState(128, 64);
    const seen = new Set<number>();
    const reader = (frame: number) => {
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(96);
      seen.add(Math.floor(frame));
      return Math.sin(frame / 7);
    };
    for (let index = 0; index < 240; index += 1) core.processTimeStretchFrame(state, 96, 1.5, false, reader, reader);
    core.resetTimeStretchState(state, 0);
    for (let index = 0; index < 240; index += 1) core.processTimeStretchFrame(state, 96, 1.5, true, reader, reader);
    expect(seen.size).toBeGreaterThan(80);
    expect(Number.isFinite(state.outLeft)).toBe(true);
    expect(Number.isFinite(state.outRight)).toBe(true);
  });

  it.each([
    { direction: 1, start: 96.25, label: 'forward across the loop boundary' },
    { direction: -1, start: 0.75, label: 'reverse across the loop boundary' },
  ])('preserves fractional reader coordinates while wrapping $label', ({ direction, start }) => {
    const state = core.createTimeStretchState(128, 64);
    core.resetTimeStretchState(state, start);
    const observed: number[] = [];
    const reader = (frame: number) => {
      observed.push(frame);
      return 0.25;
    };

    core.processTimeStretchFrame(state, 97, 1.3, direction < 0, reader, () => 0);

    const initialWindowReads = 128;
    expect(observed).toHaveLength(initialWindowReads + 32 * Math.ceil(1.3));
    for (let index = 0; index < initialWindowReads; index += 1) {
      const unwrapped = start + index * direction;
      const expected = ((unwrapped % 97) + 97) % 97;
      expect(observed[index]).toBeCloseTo(expected, 10);
    }
  });

  it('keeps one-shot reader coordinates fractional and unclamped', () => {
    const state = core.createTimeStretchState(128, 64);
    core.resetTimeStretchState(state, -0.25);
    const observed: number[] = [];
    const reader = (frame: number) => {
      observed.push(frame);
      return 0;
    };

    core.processTimeStretchFrame(state, 0, 1.3, false, reader, () => 0);

    for (let index = 0; index < 128; index += 1) {
      expect(observed[index]).toBeCloseTo(-0.25 + index, 10);
    }
  });

  it('precomputes the per-bin phase scale for this window size', () => {
    const state = core.createTimeStretchState(128, 64);
    expect(state.binAngles).toHaveLength(state.binCount);
    for (let bin = 0; bin < state.binCount; bin += 1) {
      expect(state.binAngles[bin]).toBeCloseTo(2 * Math.PI * bin / state.windowFrames, 14);
    }
  });

  it('counts missing-reader hops and resets its correlation anchor after persistent underruns', () => {
    const state = core.createTimeStretchState(128, 64);
    let available = false;
    const reader = (frame: number) => available
      ? 0.7 * Math.sin(2 * Math.PI * 440 * frame / SAMPLE_RATE)
      : Number.NaN;
    for (let index = 0; index < 64 * 4; index += 1) core.processTimeStretchFrame(state, 0, 1.5, false, reader, reader);
    expect(state.underruns).toBeGreaterThanOrEqual(3);
    expect(state.autoResets).toBeGreaterThan(0);

    available = true;
    const recovered = new Float32Array(8_192);
    for (let index = 0; index < recovered.length; index += 1) {
      core.processTimeStretchFrame(state, 0, 1.5, false, reader, reader);
      recovered[index] = state.outLeft;
    }
    expect(Number.isFinite(state.outLeft)).toBe(true);
    expect(Number.isFinite(state.outRight)).toBe(true);
    expect(Math.abs(estimateTone(recovered, 440, 1_000, 6_000) - 440) / 440).toBeLessThan(0.02);
    expect(toneMagnitude(recovered, 440, 1_000, 6_000)).toBeGreaterThan(0.45);
  });

  it('applies rate changes on a hop boundary without dropping the current overlap', () => {
    const source = makeStereoTone(SAMPLE_RATE * 2);
    const readLeft = linearReader(source.left);
    const readRight = linearReader(source.right);
    const state = core.createTimeStretchState(core.TIME_STRETCH_WINDOW_FRAMES, core.TIME_STRETCH_HOP_FRAMES);
    let previous = 0;
    let maximumJump = 0;
    for (let index = 0; index < 18_000; index += 1) {
      const speed = index < 5_137 ? 1 : 1.7;
      core.processTimeStretchFrame(state, 0, speed, false, readLeft, readRight);
      maximumJump = Math.max(maximumJump, Math.abs(state.outLeft - previous));
      previous = state.outLeft;
    }
    expect(maximumJump).toBeLessThan(0.35);
  });

  it('prepares the following hop without advancing or changing the buffered output sequence', () => {
    const frames = core.TIME_STRETCH_HOP_FRAMES * 8;
    const source = makeStereoTone(SAMPLE_RATE * 2);
    const readLeft = linearReader(source.left);
    const readRight = linearReader(source.right);
    const baseline = render(1.3, source.left, source.right, frames);
    const state = core.createTimeStretchState(core.TIME_STRETCH_WINDOW_FRAMES, core.TIME_STRETCH_HOP_FRAMES);
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    let preparedHops = 0;

    expect(core.prepareTimeStretchHop(state, 0, 1.3, false, readLeft, readRight)).toBe(false);
    for (let index = 0; index < frames; index += 1) {
      core.processTimeStretchFrame(state, 0, 1.3, false, readLeft, readRight);
      outputLeft[index] = state.outLeft;
      outputRight[index] = state.outRight;
      if (index + core.TIME_STRETCH_HOP_FRAMES < frames && state.pendingIndex === 1 && !state.nextReady) {
        const playbackFrameBeforePrepare = state.playbackFrame;
        const pendingIndexBeforePrepare = state.pendingIndex;
        expect(core.prepareTimeStretchHop(state, 0, 1.3, false, readLeft, readRight)).toBe(true);
        expect(state.playbackFrame).toBe(playbackFrameBeforePrepare);
        expect(state.pendingIndex).toBe(pendingIndexBeforePrepare);
        expect(state.nextReady).toBe(true);
        preparedHops += 1;
      }
    }

    expect(preparedHops).toBe(7);
    let maximumDifference = 0;
    for (let index = 0; index < frames; index += 1) {
      maximumDifference = Math.max(maximumDifference, Math.abs(outputLeft[index]! - baseline.left[index]!));
      maximumDifference = Math.max(maximumDifference, Math.abs(outputRight[index]! - baseline.right[index]!));
    }
    expect(maximumDifference).toBeLessThan(1e-7);

    core.resetTimeStretchState(state);
    expect(state.nextReady).toBe(false);
    expect(state.pendingIndex).toBe(state.hopFrames);
  });

  it('rejects invalid workspace sizes and reset positions', () => {
    expect(() => core.createTimeStretchState(16, 16)).toThrow(RangeError);
    expect(() => core.createTimeStretchState(128, 64)).not.toThrow();
    const state = core.createTimeStretchState(128, 64);
    expect(() => core.resetTimeStretchState(state, Number.NaN)).toThrow(RangeError);
  });
});
