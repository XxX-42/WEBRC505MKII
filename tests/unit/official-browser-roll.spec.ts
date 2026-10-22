import { describe, expect, it } from 'vitest';
import { BrowserOfficialRollDsp } from '../../src/audio/fx/dsp/BrowserOfficialRollDsp';

const RATE = 8000;

function render(
  dsp: BrowserOfficialRollDsp,
  length: number,
  input: (frame: number) => readonly [number, number] = () => [0, 0],
  blocks: readonly number[] = [length],
): [Float64Array, Float64Array] {
  const left = new Float64Array(length);
  const right = new Float64Array(length);
  let frame = 0;
  let block = 0;
  while (frame < length) {
    const end = Math.min(length, frame + blocks[block++ % blocks.length]!);
    for (; frame < end; frame += 1) {
      const sample = input(frame);
      dsp.processSample(sample[0], sample[1]);
      left[frame] = dsp.wetLeft;
      right[frame] = dsp.wetRight;
    }
  }
  return [left, right];
}

function nonzeroFrames(signal: Float64Array): number[] {
  return Array.from(signal.keys()).filter(frame => Math.abs(signal[frame]!) > 1e-9);
}

function primeImpulse(dsp: BrowserOfficialRollDsp): void {
  render(dsp, dsp.timeFrames, frame => frame === 0 ? [1, -0.5] : [0, 0]);
}

describe('official browser ROLL1/ROLL2 capture and counted repeats', () => {
  it('defaults to quarter-note TIME and listens silently while ROLL is initially OFF', () => {
    const dsp = new BrowserOfficialRollDsp(RATE);
    expect(dsp.timeFrames).toBe(4000);
    expect(render(dsp, 5000, () => [1, -1])[0].every(sample => sample === 0)).toBe(true);
    expect(dsp.hasCapturedSlice).toBe(false);
    dsp.setParameters({ roll: 1 });
    expect(dsp.activeCycleFrames).toBe(2000);
    expect(dsp.processSample(0, 0)).toBe(dsp);
    expect(dsp.wetLeft).toBe(1);
  });

  it.each([1, 2, 3, 4])('ROLL selector %i divides TIME by 2^selector, not a beat or bar multiplier', roll => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 8 });
    primeImpulse(dsp);
    dsp.setParameters({ roll });
    const period = 64 / 2 ** roll;
    expect(dsp.activeCycleFrames).toBe(period);
    const [left, right] = render(dsp, period * 6);
    expect(nonzeroFrames(left)).toEqual([0, period, period * 2, period * 3, period * 4, period * 5]);
    expect(nonzeroFrames(right)).toEqual(nonzeroFrames(left));
    expect(left[period]).toBe(1);
    expect(right[period]).toBe(-0.5);
  });

  it.each([1, 2, 50, 100])('ROLL1 FEEDBACK=%i plays exactly that many further full repeats after OFF', repeats => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 8, repeats });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 2 });
    render(dsp, 37); // OFF may interrupt any point in the held cycle.
    dsp.setParameters({ roll: 0 });
    const [left, right] = render(dsp, 16 * (repeats + 3), () => [0.75, -0.75]);
    expect(nonzeroFrames(left)).toEqual(Array.from({ length: repeats }, (_, index) => index * 16));
    expect(nonzeroFrames(right)).toEqual(nonzeroFrames(left));
    for (const frame of nonzeroFrames(left)) expect(left[frame]).toBe(1);
    expect(dsp.isPlaying).toBe(false);
  });

  it('uses 50 complete release repeats by default, not a 50% feedback gain', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 1 });
    dsp.setParameters({ roll: 0 });
    const [left] = render(dsp, 240);
    expect(nonzeroFrames(left)).toHaveLength(50);
    expect(left[196]).toBe(1);
    expect(left[200]).toBe(0);
  });

  it('ROLL2 REPEAT has the same exact finite count contract', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { variant: 2, time: 8, repeats: 3 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 4 });
    render(dsp, 11);
    dsp.setParameters({ roll: 0 });
    expect(nonzeroFrames(render(dsp, 24)[0])).toEqual([0, 4, 8]);
  });

  it('ROLL2 INF keeps repeating after OFF while ROLL1 cannot acquire an infinite tail', () => {
    const infinite = new BrowserOfficialRollDsp(RATE, { variant: 2, time: 1, repeats: -1000 });
    primeImpulse(infinite);
    infinite.setParameters({ roll: 1 });
    infinite.setParameters({ roll: 0 });
    expect(nonzeroFrames(render(infinite, 800)[0])).toHaveLength(200);
    expect(infinite.isPlaying).toBe(true);

    const finite = new BrowserOfficialRollDsp(RATE, { variant: 1, time: 1, repeats: 2 });
    primeImpulse(finite);
    finite.setParameters({ repeats: -1000, roll: 1 });
    finite.setParameters({ roll: 0 });
    expect(nonzeroFrames(render(finite, 40)[0])).toEqual([0, 4]);
    infinite.setParameters({ variant: 1 });
    expect(render(infinite, 20)[0].every(sample => sample === 0)).toBe(true);
  });

  it('ON ignores the finite release count and holds the same audio indefinitely', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, repeats: 1 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 1 });
    const [left] = render(dsp, 400, () => [0.25, -0.25]);
    expect(nonzeroFrames(left)).toHaveLength(100);
    expect(left[396]).toBe(1);
    expect(dsp.isPlaying).toBe(true);
  });

  it('waits for one full TIME interval when ON has insufficient pre-roll', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, roll: 1 });
    expect(dsp.isCapturePending).toBe(true);
    expect(render(dsp, 7, frame => frame === 0 ? [1, -1] : [0, 0])[0].every(sample => sample === 0)).toBe(true);
    expect(dsp.hasCapturedSlice).toBe(false);
    dsp.processSample(0, 0);
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.isCapturePending).toBe(false);
    expect(dsp.hasCapturedSlice).toBe(true);
    expect(nonzeroFrames(render(dsp, 12)[0])).toEqual([0, 4, 8]);
  });

  it('includes valid partial pre-roll and cancels incomplete captures on OFF', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1 });
    render(dsp, 3, frame => frame === 0 ? [1, 0] : [0, 0]);
    dsp.setParameters({ roll: 2 });
    render(dsp, 4);
    expect(dsp.isCapturePending).toBe(true);
    dsp.setParameters({ roll: 0 });
    expect(render(dsp, 20, () => [0.25, 0.5])[0].every(sample => sample === 0)).toBe(true);
    expect(dsp.hasCapturedSlice).toBe(false);
    dsp.setParameters({ roll: 1 });
    expect(dsp.isCapturePending).toBe(false);
    dsp.processSample(0, 0);
    expect(dsp.wetLeft).toBe(0.25);
    expect(dsp.wetRight).toBe(0.5);
  });

  it('finishes a pending capture using existing pre-roll rather than delaying a second full interval', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1 });
    render(dsp, 3, frame => frame === 0 ? [1, -0.5] : [0, 0]);
    dsp.setParameters({ roll: 2 });
    expect(render(dsp, 5)[0].every(sample => sample === 0)).toBe(true);
    expect(dsp.isCapturePending).toBe(false);
    expect(nonzeroFrames(render(dsp, 8)[0])).toEqual([0, 2, 4, 6]);
  });

  it('changes ON divisions from the same complete snapshot without recapturing new input', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 8 });
    render(dsp, 64, frame => [frame / 64, -frame / 64]);
    dsp.setParameters({ roll: 4 });
    render(dsp, 80, () => [0.9, 0.9]);
    dsp.setParameters({ roll: 1 });
    const [left, right] = render(dsp, 64, () => [0.9, 0.9]);
    expect(dsp.activeCycleFrames).toBe(32);
    for (let i = 0; i < left.length; i += 1) {
      expect(left[i]).toBe((i % 32) / 64);
      expect(right[i]).toBe(-(i % 32) / 64);
    }
  });

  it('keeps recording during the held loop and finite tail for the next activation', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, repeats: 1 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 1 });
    render(dsp, dsp.maxCaptureFrames + 13, () => [0.25, -0.75]);
    dsp.setParameters({ roll: 0 });
    render(dsp, 12, () => [0.5, -0.25]);
    dsp.setParameters({ roll: 2 });
    const [left, right] = render(dsp, 12);
    expect(left.every(sample => sample === 0.5)).toBe(true);
    expect(right.every(sample => sample === -0.25)).toBe(true);
  });

  it('preserves chronological stereo source order when a new capture crosses the history-ring seam', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1 });
    render(dsp, dsp.maxCaptureFrames - 4);
    render(dsp, 8, frame => [frame / 8, -frame / 16]);
    dsp.setParameters({ roll: 1 });
    const [left, right] = render(dsp, 8);
    expect(Array.from(left)).toEqual([0, 0.125, 0.25, 0.375, 0, 0.125, 0.25, 0.375]);
    expect(Array.from(right)).toEqual([-0, -0.0625, -0.125, -0.1875, -0, -0.0625, -0.125, -0.1875]);
  });

  it.each([-2, -1, -0.125])('negative TIME=%s is quarter-note beats, not time-signature-relative bars', time => {
    for (const bpm of [40, 120, 300]) {
      const dsp = new BrowserOfficialRollDsp(RATE, { time, bpm });
      const fullLength = Math.round(-time * 60 / bpm * RATE);
      expect(dsp.timeFrames).toBe(fullLength);
      primeImpulse(dsp);
      dsp.setParameters({ roll: 1 });
      const period = Math.round(fullLength / 2);
      expect(nonzeroFrames(render(dsp, period * 3)[0])).toEqual([0, period, period * 2]);
    }
  });

  it('honors the synchronized three-second maximum rather than the numeric one-second maximum', () => {
    const synced = new BrowserOfficialRollDsp(RATE, { time: -2, bpm: 40 });
    expect(synced.timeFrames).toBe(24000);
    expect(synced.maxCaptureFrames).toBe(24000);
    primeImpulse(synced);
    synced.setParameters({ roll: 1 });
    expect(nonzeroFrames(render(synced, 36000)[0])).toEqual([0, 12000, 24000]);
    const numeric = new BrowserOfficialRollDsp(RATE, { time: 1000, bpm: 40 });
    expect(numeric.timeFrames).toBe(8000);
    numeric.setParameters({ bpm: 300 });
    expect(numeric.timeFrames).toBe(8000);
  });

  it('resamples the existing snapshot on live TIME/BPM edits without capturing new material', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: -0.125, bpm: 300 });
    render(dsp, 200, frame => [frame / 200, -frame / 200]);
    dsp.setParameters({ roll: 1 });
    render(dsp, 250, () => [0.9, 0.9]);
    dsp.setParameters({ bpm: 150 });
    expect(dsp.timeFrames).toBe(400);
    expect(dsp.activeCycleFrames).toBe(200);
    const [left, right] = render(dsp, 400);
    expect(left[100]).toBe(0.25);
    expect(right[100]).toBe(-0.25);
    expect(left.slice(0, 200)).toEqual(left.slice(200));
    dsp.setParameters({ time: 10 });
    expect(dsp.activeCycleFrames).toBe(40);
    expect(render(dsp, 40)[0][20]).toBe(0.25);
  });

  it('changes a running release budget without restarting already counted cycles', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, repeats: 5 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 1 });
    dsp.setParameters({ roll: 0 });
    expect(nonzeroFrames(render(dsp, 8)[0])).toEqual([0, 4]);
    dsp.setParameters({ repeats: 3 });
    expect(nonzeroFrames(render(dsp, 20)[0])).toEqual([0]);
    dsp.setParameters({ repeats: 10 });
    expect(nonzeroFrames(render(dsp, 20)[0])).toEqual([]);
  });

  it('unchanged control updates do not restart playback or extend the release budget', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, repeats: 2 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 1 });
    dsp.setParameters({ roll: 0 });
    const frames: number[] = [];
    for (let frame = 0; frame < 20; frame += 1) {
      dsp.setParameters({ time: 1, repeats: 2, roll: 0, bpm: 120 });
      dsp.processSample(0, 0);
      if (dsp.wetLeft !== 0) frames.push(frame);
    }
    expect(frames).toEqual([0, 4]);
  });

  it('reset clears history and rearms an active ON without leaking stale samples', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, repeats: 1 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 1 });
    render(dsp, 3);
    dsp.reset();
    expect(dsp.hasCapturedSlice).toBe(false);
    expect(dsp.isCapturePending).toBe(true);
    expect(dsp.timeFrames).toBe(8);
    expect(render(dsp, 24)[0].every(sample => sample === 0)).toBe(true);
    dsp.setParameters({ roll: 0 });
    dsp.reset();
    expect(dsp.isCapturePending).toBe(false);
    expect(render(dsp, 24, () => [1, 1])[0].every(sample => sample === 0)).toBe(true);
  });

  it('bounds malformed controls and nonfinite or overrange samples without NaN or runaway feedback', () => {
    const dsp = new BrowserOfficialRollDsp(NaN, { time: 1, roll: 4, repeats: NaN, bpm: Infinity });
    expect(dsp.sampleRate).toBe(48000);
    dsp.setParameters({ time: -1000, bpm: NaN, roll: NaN });
    expect(dsp.timeFrames).toBe(48);
    render(dsp, 48, frame => frame % 2 ? [Infinity, NaN] : [1e30, -1e30]);
    const [left, right] = render(dsp, 10000);
    expect(left.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 8)).toBe(true);
    expect(right.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 8)).toBe(true);
    expect(left.some(sample => sample === 8)).toBe(true);
    expect(right.some(sample => sample === -8)).toBe(true);
    dsp.setParameters({ time: 2000, bpm: -1, roll: 99 });
    expect(dsp.timeFrames).toBe(48000);
    expect(dsp.activeCycleFrames).toBe(3000);
    dsp.setParameters({ time: -4 });
    expect(dsp.timeFrames).toBe(144000);
  });

  it('rounds sub-sample fractions to one frame rather than producing empty loops', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1 });
    primeImpulse(dsp);
    dsp.setParameters({ roll: 4 });
    expect(dsp.activeCycleFrames).toBe(1);
    expect(render(dsp, 16)[0].every(sample => sample === 1)).toBe(true);
  });

  it('retains all constructor-owned storage across maximum capture, parameter edits and reset', () => {
    const dsp = new BrowserOfficialRollDsp(RATE, { time: 1, roll: 4 });
    const storage = dsp as unknown as {
      sourceLeft: Float32Array;
      sourceRight: Float32Array;
      capturedLeft: Float32Array;
      capturedRight: Float32Array;
    };
    const arrays = [storage.sourceLeft, storage.sourceRight, storage.capturedLeft, storage.capturedRight];
    render(dsp, 100);
    dsp.setParameters({ time: -2, bpm: 40, roll: 0 });
    dsp.setParameters({ roll: 1 });
    render(dsp, dsp.maxCaptureFrames + 100);
    dsp.reset();
    expect(storage.sourceLeft).toBe(arrays[0]);
    expect(storage.sourceRight).toBe(arrays[1]);
    expect(storage.capturedLeft).toBe(arrays[2]);
    expect(storage.capturedRight).toBe(arrays[3]);
    for (const array of arrays) expect(array.length).toBe(24000);
  });

  it('is exactly invariant to host chunking across capture, control edits and release', () => {
    const run = (blocks: readonly number[]): number[][] => {
      const dsp = new BrowserOfficialRollDsp(RATE, { variant: 2, time: 8, roll: 2, repeats: 3 });
      const output: number[][] = [[], []];
      const append = (length: number): void => {
        const result = render(dsp, length, frame => [Math.sin(frame * 0.17), Math.cos(frame * 0.11)], blocks);
        output[0]!.push(...result[0]);
        output[1]!.push(...result[1]);
      };
      append(231);
      dsp.setParameters({ roll: 1, time: 12 });
      append(351);
      dsp.setParameters({ roll: 0 });
      append(300);
      dsp.setParameters({ roll: 4 });
      append(137);
      return output;
    };
    expect(run([1])).toEqual(run([128]));
    expect(run([3, 17, 64, 5, 127])).toEqual(run([128]));
  });
});
