import { describe, expect, it } from 'vitest';
import { BrowserRollDsp } from '../../src/audio/fx/dsp/BrowserRollDsp';

const SAMPLE_RATE = 8000;
const BASE_INTERVAL = 1000; // 0.25 beat at 120 BPM.

function processFrames(
  dsp: BrowserRollDsp,
  frames: number,
  left: (frame: number) => number = () => 0,
  right: (frame: number) => number = left,
): [number[], number[]] {
  const outputLeft: number[] = [];
  const outputRight: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    dsp.processSample(left(frame), right(frame));
    outputLeft.push(dsp.wetLeft);
    outputRight.push(dsp.wetRight);
  }
  return [outputLeft, outputRight];
}

function captureRamp(dsp: BrowserRollDsp, interval = BASE_INTERVAL): void {
  processFrames(dsp, interval, (frame) => frame / interval, (frame) => -frame / interval);
}

describe('Browser clean-room ROLL DSP primitive (catalog source ID 44)', () => {
  it('uses the catalog slice and decay defaults when controls are omitted', () => {
    const dsp = new BrowserRollDsp(SAMPLE_RATE);
    expect(dsp.diagnostics.activeSliceBeats).toBe(0.5);
    expect(dsp.diagnostics.activeDecayPercent).toBe(20);
    expect(dsp.remainingFramesToBoundary).toBe(2000);
  });

  it('uses sample-clocked BPM boundaries and the five stepped beat divisions', () => {
    const expectedIntervals = [1000, 2000, 4000, 8000, 16000];
    const divisions = [0.25, 0.5, 1, 2, 4];

    divisions.forEach((sliceBeats, index) => {
      const dsp = new BrowserRollDsp(SAMPLE_RATE, { bpm: 120, sliceBeats });
      const expected = expectedIntervals[index]!;
      expect(dsp.remainingFramesToBoundary).toBe(expected);
      processFrames(dsp, expected - 1, () => 0.25);
      expect(dsp.boundaryCount).toBe(0);
      expect(dsp.hasCapturedSlice).toBe(false);
      dsp.processSample(0.25, -0.25);
      expect(dsp.boundaryCount).toBe(1);
      expect(dsp.lastBoundaryFrame).toBe(expected - 1);
      expect(dsp.activeSliceFrames).toBe(expected);
      expect(dsp.remainingFramesToBoundary).toBe(expected);
    });
  });

  it('keeps wet output silent during initial capture, then retriggers the newest captured slice', () => {
    const dsp = new BrowserRollDsp(SAMPLE_RATE, { bpm: 120, sliceBeats: 0.25, decayPercent: 0 });
    const initial = processFrames(dsp, BASE_INTERVAL, () => 0.2, () => -0.3);
    expect(initial[0].every((sample) => sample === 0)).toBe(true);
    expect(initial[1].every((sample) => sample === 0)).toBe(true);
    expect(dsp.hasCapturedSlice).toBe(true);
    expect(dsp.diagnostics.fadeRemainingFrames).toBe(16);

    const firstPlayback = processFrames(dsp, BASE_INTERVAL, () => 0.6, () => -0.7);
    expect(firstPlayback[0][0]).toBeCloseTo(0, 5);
    expect(firstPlayback[0][30]).toBeCloseTo(0.2, 3);
    expect(firstPlayback[1][30]).toBeCloseTo(-0.3, 3);
    expect(dsp.boundaryCount).toBe(2);

    const retrigger = processFrames(dsp, 40, () => 0.6, () => -0.7);
    expect(retrigger[0][30]).toBeCloseTo(0.6, 3);
    expect(retrigger[1][30]).toBeCloseTo(-0.7, 3);
    const midpointPosition = 8 / 15;
    const equalPowerMidpoint = (0.2 * Math.cos(midpointPosition * Math.PI / 2))
      + (0.6 * Math.sin(midpointPosition * Math.PI / 2));
    expect(retrigger[0][8]).toBeCloseTo(equalPowerMidpoint, 3);
    expect(dsp.activeSliceFrames).toBe(BASE_INTERVAL);
  });

  it('applies playback-rate pitch in both directions and documents duration-changing behavior', () => {
    const settledFirstSample = (pitchSemitones: number): number => {
      const dsp = new BrowserRollDsp(SAMPLE_RATE, { bpm: 120, sliceBeats: 0.25, pitchSemitones });
      captureRamp(dsp);
      const rendered = processFrames(dsp, 32, (frame) => frame / BASE_INTERVAL, (frame) => frame / BASE_INTERVAL);
      return rendered[0][25]!;
    };
    const normal = settledFirstSample(0);
    const octaveUp = settledFirstSample(12);
    const octaveDown = settledFirstSample(-12);
    expect(octaveUp).toBeGreaterThan(normal * 1.8);
    expect(octaveDown).toBeLessThan(normal * 0.65);

    const dsp = new BrowserRollDsp(SAMPLE_RATE, { sliceBeats: 0.25, pitchSemitones: 24 });
    expect(dsp.diagnostics.playbackRate).toBe(4);
    dsp.setParameters({ pitchSemitones: -24 });
    processFrames(dsp, BASE_INTERVAL);
    expect(dsp.diagnostics.playbackRate).toBe(0.25);

    const seam = new BrowserRollDsp(SAMPLE_RATE, { sliceBeats: 0.25, pitchSemitones: 12 });
    captureRamp(seam);
    processFrames(seam, BASE_INTERVAL / 2);
    expect(seam.diagnostics.fadeRemainingFrames).toBe(16);
    const seamTransition = processFrames(seam, 16);
    expect(seamTransition[0].every(Number.isFinite)).toBe(true);
    expect(seamTransition[1].every(Number.isFinite)).toBe(true);
    expect(seam.diagnostics.fadeRemainingFrames).toBe(0);
  });

  it('supports forward, reverse, and alternate direction at captured-slice boundaries', () => {
    const settledOutput = (direction: 'forward' | 'reverse'): number => {
      const dsp = new BrowserRollDsp(SAMPLE_RATE, { direction, sliceBeats: 0.25, decayPercent: 0 });
      captureRamp(dsp);
      const rendered = processFrames(dsp, 32, (frame) => frame / BASE_INTERVAL, (frame) => frame / BASE_INTERVAL);
      return rendered[0][25]!;
    };
    expect(settledOutput('forward')).toBeLessThan(0.05);
    expect(settledOutput('reverse')).toBeGreaterThan(0.9);

    const alternate = new BrowserRollDsp(SAMPLE_RATE, {
      direction: 'alternate', sliceBeats: 0.25, decayPercent: 0,
    });
    captureRamp(alternate);
    expect(alternate.diagnostics.activeDirection).toBe('alternate');
    expect(processFrames(alternate, 32)[0][25]).toBeLessThan(0.05);
    captureRamp(alternate);
    expect(alternate.diagnostics.activeDirection).toBe('alternate');
    expect(processFrames(alternate, 32)[0][25]).toBeGreaterThan(0.9);
  });

  it('applies decay once per completed retrigger and latches parameter edits at a boundary', () => {
    const dsp = new BrowserRollDsp(SAMPLE_RATE, { sliceBeats: 0.25, decayPercent: 50 });
    processFrames(dsp, BASE_INTERVAL, () => 0.4);
    expect(dsp.diagnostics.currentGain).toBe(1);
    processFrames(dsp, BASE_INTERVAL, () => 0.4);
    expect(dsp.diagnostics.currentGain).toBe(0.5);
    const second = processFrames(dsp, 32, () => 0.4);
    expect(second[0][25]).toBeCloseTo(0.2, 3);
    processFrames(dsp, BASE_INTERVAL - 32, () => 0.4);
    expect(dsp.diagnostics.currentGain).toBe(0.25);

    dsp.setParameters({ decayPercent: 20 });
    processFrames(dsp, BASE_INTERVAL);
    expect(dsp.diagnostics.activeDecayPercent).toBe(20);
    expect(dsp.diagnostics.currentGain).toBeCloseTo(0.2, 6);
  });

  it('applies decay to each faster playback retrigger without double-decaying at the beat edge', () => {
    const dsp = new BrowserRollDsp(SAMPLE_RATE, {
      bpm: 40, sliceBeats: 0.25, decayPercent: 20, pitchSemitones: 24,
    });
    // 3,000 capture frames at 40 BPM; 4x playback makes three internal wraps
    // before the fourth wrap coincides with the next slice boundary.
    processFrames(dsp, 3000, () => 0.25);
    expect(dsp.diagnostics.currentGain).toBe(1);
    processFrames(dsp, 3000);
    expect(dsp.diagnostics.currentGain).toBeCloseTo(0.8 ** 4, 5);
  });

  it('latches clamped BPM, quantized slices, decay, pitch, and direction on the next boundary', () => {
    const dsp = new BrowserRollDsp(SAMPLE_RATE, { bpm: 120, sliceBeats: 0.25 });
    dsp.setParameters({
      bpm: -10,
      sliceBeats: 99,
      decayPercent: -25,
      pitchSemitones: 80,
      direction: 'alternate',
    });
    processFrames(dsp, BASE_INTERVAL);
    expect(dsp.diagnostics).toMatchObject({
      activeBpm: 40,
      activeSliceBeats: 4,
      activeSliceFrames: BASE_INTERVAL,
      activeDecayPercent: 0,
      activePitchSemitones: 24,
      playbackRate: 4,
      activeDirection: 'alternate',
      remainingFramesToBoundary: 48_000,
    });

    dsp.setParameters({ bpm: 900, sliceBeats: 0.9, decayPercent: 150, pitchSemitones: -50 });
    processFrames(dsp, 48_000);
    expect(dsp.diagnostics).toMatchObject({
      activeBpm: 300,
      activeSliceBeats: 1,
      activeDecayPercent: 100,
      activePitchSemitones: -24,
      playbackRate: 0.25,
      remainingFramesToBoundary: 1600,
    });
  });

  it('is invariant to arbitrary host block segmentation when driven sample by sample', () => {
    const totalFrames = 6500;
    const render = (blockSizes: readonly number[]) => {
      const dsp = new BrowserRollDsp(SAMPLE_RATE, { bpm: 120, sliceBeats: 0.25, decayPercent: 80 });
      const left = new Float32Array(totalFrames);
      const right = new Float32Array(totalFrames);
      let frame = 0;
      let block = 0;
      while (frame < totalFrames) {
        const blockEnd = Math.min(totalFrames, frame + blockSizes[block % blockSizes.length]!);
        for (; frame < blockEnd; frame += 1) {
          if (frame === 2300) dsp.setParameters({ bpm: 90, sliceBeats: 0.5, pitchSemitones: 5 });
          const inputLeft = Math.sin(frame * 0.071) * 0.7;
          const inputRight = Math.cos(frame * 0.053) * 0.6;
          dsp.processSample(inputLeft, inputRight);
          left[frame] = dsp.wetLeft;
          right[frame] = dsp.wetRight;
        }
        block += 1;
      }
      return { dsp, left, right };
    };

    const singleBlock = render([totalFrames]);
    const segmented = render([1, 31, 128, 257, 3, 511, 17]);
    expect(segmented.left).toEqual(singleBlock.left);
    expect(segmented.right).toEqual(singleBlock.right);
    expect(segmented.dsp.diagnostics).toEqual(singleBlock.dsp.diagnostics);
  });

  it('keeps outputs finite and bounded, and reset clears captured state and clocks', () => {
    const dsp = new BrowserRollDsp(SAMPLE_RATE, { sliceBeats: 0.25 });
    const inputs = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9, -1e9];
    for (let frame = 0; frame < BASE_INTERVAL * 2; frame += 1) {
      const input = inputs[frame % inputs.length]!;
      dsp.processSample(input, -input);
      expect(Number.isFinite(dsp.wetLeft)).toBe(true);
      expect(Number.isFinite(dsp.wetRight)).toBe(true);
      expect(Math.abs(dsp.wetLeft)).toBeLessThanOrEqual(8);
      expect(Math.abs(dsp.wetRight)).toBeLessThanOrEqual(8);
    }
    expect(dsp.hasCapturedSlice).toBe(true);
    dsp.setParameters({ bpm: 60 });
    dsp.reset();
    expect(dsp.hasCapturedSlice).toBe(false);
    expect(dsp.activeSliceFrames).toBe(0);
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.wetRight).toBe(0);
    expect(dsp.framesProcessed).toBe(0);
    expect(dsp.boundaryCount).toBe(0);
    expect(dsp.lastBoundaryFrame).toBe(-1);
    expect(dsp.remainingFramesToBoundary).toBe(2000);
  });
});
