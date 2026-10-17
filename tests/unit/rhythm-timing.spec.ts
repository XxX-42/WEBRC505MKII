import { describe, expect, it } from 'vitest';
import { getRhythmEventFrame, quantizeRhythmStep } from '../../src/audio/rhythm/timing';

describe('rhythm sample-frame swing and quantize', () => {
  it('delays eighth offbeats by the configured ratio using absolute sample frames', () => {
    const sampleRate = 48_000;
    const bpm = 120;
    const startFrame = 137;
    const straight = getRhythmEventFrame(startFrame, 0, 2, 16, sampleRate, bpm, 50, '1/16');
    const swung = getRhythmEventFrame(startFrame, 0, 2, 16, sampleRate, bpm, 67, '1/16');
    expect(straight).toBe(startFrame + 12_000);
    expect(swung).toBe(startFrame + 16_080);
    expect(getRhythmEventFrame(startFrame, 0, 1, 16, sampleRate, bpm, 67, '1/16'))
      .toBe(startFrame + 6_000);
  });

  it('keeps swing timing drift-free across repeated bars with fractional frames per step', () => {
    const sampleRate = 44_100;
    const bpm = 137;
    const startFrame = 8_765;
    const quarterFrames = sampleRate * 60 / bpm;
    for (const bar of [0, 1, 17, 333]) {
      const actual = getRhythmEventFrame(startFrame, bar, 2, 16, sampleRate, bpm, 67, '1/16');
      const expected = startFrame + Math.round((bar * 16 / 4 + 0.67) * quarterFrames);
      expect(actual).toBe(expected);
    }
  });

  it('snaps to nearest grids with deterministic half-step boundaries and bar rollover', () => {
    expect(quantizeRhythmStep(1, '1/8')).toBe(2);
    expect(quantizeRhythmStep(3, '1/8')).toBe(4);
    expect(quantizeRhythmStep(2, '1/4')).toBe(4);

    const sampleRate = 48_000;
    const bpm = 120;
    const quarterGridBoundary = getRhythmEventFrame(0, 0, 14, 16, sampleRate, bpm, 50, '1/4');
    const nextBarBoundary = getRhythmEventFrame(0, 1, 0, 16, sampleRate, bpm, 50, '1/16');
    expect(quarterGridBoundary).toBe(nextBarBoundary);
    expect(getRhythmEventFrame(0, 0, 3, 16, sampleRate, bpm, 50, '1/8'))
      .toBe(getRhythmEventFrame(0, 0, 4, 16, sampleRate, bpm, 50, '1/16'));
  });
});
