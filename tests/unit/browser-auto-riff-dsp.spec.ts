import { describe, expect, it } from 'vitest';
import { BrowserAutoRiffDsp, type BrowserAutoRiffScale } from '../../src/audio/fx/dsp/BrowserAutoRiffDsp';

function monoSine(sampleRate: number, frequency: number, frames: number, amplitude = 0.3): Float32Array {
  const result = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    result[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return result;
}

function process(input: Float32Array, dsp: BrowserAutoRiffDsp, segments?: readonly number[]): void {
  let frame = 0;
  let segment = 0;
  while (frame < input.length) {
    const length = segments?.length
      ? Math.min(Math.max(1, segments[segment % segments.length] ?? input.length), input.length - frame)
      : input.length - frame;
    for (let offset = frame; offset < frame + length; offset += 1) dsp.processSample(input[offset] ?? 0, offset);
    frame += length;
    segment += 1;
  }
}

function drain(dsp: BrowserAutoRiffDsp, frames: number[] = [], semitones: number[] = []): void {
  while (dsp.tryPopPitchChange()) {
    frames.push(dsp.lastPoppedFrame);
    semitones.push(dsp.lastPoppedSemitones);
  }
}

function makeSequence(scale: BrowserAutoRiffScale, bpm = 300, beatStepRate = 0.25, seconds = 2): {
  dsp: BrowserAutoRiffDsp;
  frames: number[];
  semitones: number[];
} {
  const sampleRate = 8_000;
  const dsp = new BrowserAutoRiffDsp(sampleRate, { scale, bpm, beatStepRate, onsetSensitivity: 0.75 });
  process(monoSine(sampleRate, 220, Math.floor(sampleRate * seconds)), dsp);
  const frames: number[] = [];
  const semitones: number[] = [];
  drain(dsp, frames, semitones);
  return { dsp, frames, semitones };
}

describe('clean-room provisional Browser AUTO RIFF analysis and sequencer', () => {
  it('tracks a sine fundamental with bounded decimated YIN/CMND and accepts mono-averaged stereo', () => {
    const sampleRate = 48_000;
    const defaults = new BrowserAutoRiffDsp(sampleRate);
    expect(defaults.activeBeatStepRate).toBe(0.5);
    expect(defaults.stepFrames).toBe(12_000);
    const mono = new BrowserAutoRiffDsp(sampleRate);
    const stereo = new BrowserAutoRiffDsp(sampleRate);
    const input = monoSine(sampleRate, 220, sampleRate * 2);
    for (let frame = 0; frame < input.length; frame += 1) {
      const sample = input[frame] ?? 0;
      mono.processSample(sample, frame);
      stereo.processStereoSample(sample * 0.8, sample * 1.2, frame);
    }

    expect(mono.hasPitch).toBe(true);
    expect(mono.pitchEstimateHz).toBeCloseTo(220, 0);
    expect(Math.abs(mono.pitchEstimateHz - 220) / 220).toBeLessThan(0.02);
    expect(stereo.hasPitch).toBe(true);
    expect(stereo.pitchEstimateHz).toBeCloseTo(mono.pitchEstimateHz, 4);
    expect(mono.pitchConfidence).toBeGreaterThan(0.62);
    expect(mono.latencyFrames).toBeGreaterThan(0);
    expect(mono.latencyFrames).toBeLessThan(sampleRate * 0.1);
  });

  it('waits for a voiced onset before starting a deterministic eight-step scale riff', () => {
    const { dsp, frames, semitones } = makeSequence(1, 300, 0.25, 1.5);
    expect(dsp.onsetCount).toBeGreaterThan(0);
    expect(dsp.lastOnsetFrame).toBeGreaterThanOrEqual(0);
    expect(frames).toHaveLength(8);
    expect(semitones).toEqual([0, 4, 7, 11, 7, 4, 0, -3]);
    expect(frames[0]).toBeGreaterThanOrEqual(dsp.lastOnsetFrame);
    expect(dsp.step).toBe(-1);
  });

  it('quantizes the sequence to BPM and every supported beat step rate', () => {
    for (const rate of [0.25, 0.5, 1, 2, 4] as const) {
      const { dsp, frames } = makeSequence(0, 300, rate, 2.2);
      expect(dsp.stepFrames).toBe(Math.round((8_000 * 60 * rate) / 300));
      expect(frames.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < frames.length; index += 1) {
        expect(frames[index]! - frames[index - 1]!).toBe(dsp.stepFrames);
      }
    }

    const slow = new BrowserAutoRiffDsp(8_000, { bpm: 30, beatStepRate: 0.25 });
    const fast = new BrowserAutoRiffDsp(8_000, { bpm: 300, beatStepRate: 0.25 });
    expect(slow.stepFrames).toBe(4_000);
    expect(fast.stepFrames).toBe(400);
    slow.setTempo(1, 8);
    expect(slow.activeBpm).toBe(30);
    expect(slow.activeBeatStepRate).toBe(4);
    expect(slow.stepFrames).toBe(64_000);
  });

  it('maps all five scale choices into safe semitone shifts and clamps controls', () => {
    const expected: readonly (readonly number[])[] = [
      [0, 2, 4, 6, 4, 2, 0, -2],
      [0, 4, 7, 11, 7, 4, 0, -3],
      [0, 3, 7, 10, 7, 3, 0, -4],
      [0, 3, 7, 11, 7, 3, 0, -4],
      [0, 4, 9, 14, 9, 4, 0, -5],
    ];
    for (let scale = 0; scale <= 4; scale += 1) {
      const result = makeSequence(scale as BrowserAutoRiffScale, 300, 0.25, 1.5);
      expect(result.semitones).toEqual(expected[scale]);
      expect(result.semitones.every((value) => value >= -24 && value <= 24)).toBe(true);
    }

    const clamped = new BrowserAutoRiffDsp(8_000, { bpm: 999, beatStepRate: 9, scale: 4, onsetSensitivity: 5 });
    expect(clamped.activeBpm).toBe(300);
    expect(clamped.activeBeatStepRate).toBe(4);
    expect(clamped.activeScale).toBe(4);
    expect(clamped.activeOnsetSensitivity).toBe(1);
    clamped.setParameters({ bpm: 1, onsetSensitivity: -2 });
    clamped.setScale(-4);
    expect(clamped.activeBpm).toBe(30);
    expect(clamped.activeScale).toBe(0);
    expect(clamped.activeOnsetSensitivity).toBe(0);
  });

  it('does not invent pitch or enqueue commands from silence or unpitched noise', () => {
    const silence = new BrowserAutoRiffDsp(8_000, { bpm: 300 });
    process(new Float32Array(16_000), silence);
    expect(silence.hasPitch).toBe(false);
    expect(silence.pitchEstimateHz).toBe(0);
    expect(silence.onsetCount).toBe(0);
    expect(silence.queueDepth).toBe(0);

    const noise = new BrowserAutoRiffDsp(8_000, { bpm: 300 });
    let state = 0x12345678;
    for (let frame = 0; frame < 16_000; frame += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      noise.processSample(((state >>> 0) / 0xffffffff - 0.5) * 0.3, frame);
    }
    expect(noise.hasPitch).toBe(false);
    expect(noise.queueDepth).toBe(0);
  });

  it('is invariant to input segmentation and bounds its fixed primitive command queue', () => {
    const sampleRate = 8_000;
    const input = monoSine(sampleRate, 220, sampleRate * 1.5);
    const whole = new BrowserAutoRiffDsp(sampleRate, { bpm: 300, beatStepRate: 0.25, scale: 2 });
    const split = new BrowserAutoRiffDsp(sampleRate, { bpm: 300, beatStepRate: 0.25, scale: 2 });
    process(input, whole);
    process(input, split, [1, 19, 257, 31, 64, 3]);
    const wholeFrames: number[] = [];
    const wholeShifts: number[] = [];
    const splitFrames: number[] = [];
    const splitShifts: number[] = [];
    drain(whole, wholeFrames, wholeShifts);
    drain(split, splitFrames, splitShifts);
    expect(splitFrames).toEqual(wholeFrames);
    expect(splitShifts).toEqual(wholeShifts);

    const crowded = new BrowserAutoRiffDsp(sampleRate, { bpm: 300, beatStepRate: 0.25 });
    for (let frame = 0; frame < sampleRate * 6; frame += 1) {
      const inBurst = frame % 6_000 < 3_000;
      const sample = inBurst ? 0.3 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate) : 0;
      crowded.processSample(sample, frame);
    }
    expect(crowded.queueDepth).toBeLessThanOrEqual(32);
    expect(crowded.queueOverflowCount).toBeGreaterThan(0);
    while (crowded.tryPopPitchChange()) {
      expect(Number.isFinite(crowded.lastPoppedFrame)).toBe(true);
      expect(crowded.lastPoppedSemitones).toBeGreaterThanOrEqual(-24);
      expect(crowded.lastPoppedSemitones).toBeLessThanOrEqual(24);
    }
  });

  it('keeps the sample callback allocation-free with stable fixed buffers', () => {
    const dsp = new BrowserAutoRiffDsp(8_000);
    const internals = dsp as unknown as {
      yinRing: Float32Array;
      yinCmnd: Float32Array;
      queueFrames: Float64Array;
      queueSemitones: Int8Array;
    };
    const ring = internals.yinRing;
    const cmnd = internals.yinCmnd;
    const frames = internals.queueFrames;
    const semitones = internals.queueSemitones;
    for (let frame = 0; frame < 20_000; frame += 1) {
      const value = 0.2 * Math.sin((2 * Math.PI * 220 * frame) / 8_000);
      expect(dsp.processSample(value, frame)).toBeUndefined();
    }
    expect(internals.yinRing).toBe(ring);
    expect(internals.yinCmnd).toBe(cmnd);
    expect(internals.queueFrames).toBe(frames);
    expect(internals.queueSemitones).toBe(semitones);
    expect(internals.yinRing.length).toBe(2_048);
    expect(internals.queueFrames.length).toBe(32);
  });
});
