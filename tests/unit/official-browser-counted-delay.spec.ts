import { describe, expect, it } from 'vitest';
import {
  BrowserOfficialDelayDsp,
  type BrowserOfficialDelayAlgorithm,
} from '../../src/audio/fx/dsp/BrowserOfficialDelayDsp';

const RATE = 8000;
const algorithms: BrowserOfficialDelayAlgorithm[] = ['delay', 'panning-delay', 'reverse-delay', 'mod-delay'];

function render(
  dsp: BrowserOfficialDelayDsp,
  length: number,
  input: (frame: number) => readonly [number, number] = frame => frame === 0 ? [1, 1] : [0, 0],
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

function nonzeroFrames(signal: Float64Array, threshold = 1e-9): number[] {
  const frames: number[] = [];
  for (let frame = 0; frame < signal.length; frame += 1) {
    if (Math.abs(signal[frame]!) > threshold) frames.push(frame);
  }
  return frames;
}

describe('official browser counted-repeat delays', () => {
  it('uses the manual defaults of TIME=200ms and FEEDBACK=16', () => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE);
    expect(nonzeroFrames(render(dsp, 28000)[0])).toEqual(
      Array.from({ length: 16 }, (_, index) => 1600 * (index + 1)),
    );
  });

  it.each([1, 2, 4, 16])('FEEDBACK=%i produces exactly that many echoes, not a feedback percentage', count => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE, { time: 10, feedback: count });
    const [left, right] = render(dsp, 80 * (count + 3));
    expect(nonzeroFrames(left)).toEqual(Array.from({ length: count }, (_, index) => 80 * (index + 1)));
    expect(right).toEqual(left);
    for (let repeat = 1; repeat <= count; repeat += 1) {
      expect(left[repeat * 80]).toBeCloseTo(0.65 ** (repeat - 1), 12);
    }
  });

  it('alternates panning repeats left/right while accepting either input channel', () => {
    const dsp = new BrowserOfficialDelayDsp('panning-delay', RATE, { time: 10, feedback: 4 });
    const [left, right] = render(dsp, 480, frame => frame === 0 ? [0, 1] : [0, 0]);
    expect(nonzeroFrames(left)).toEqual([80, 240]);
    expect(nonzeroFrames(right)).toEqual([160, 320]);
    expect(left[80]).toBe(0.5);
    expect(right[160]).toBeCloseTo(0.5 * 0.65, 12);
    expect(left[240]).toBeCloseTo(0.5 * 0.65 ** 2, 12);
  });

  it('retains negative beat TIME across BPM changes and keeps millisecond TIME independent', () => {
    const synced = new BrowserOfficialDelayDsp('delay', RATE, { time: -0.5, bpm: 120, feedback: 1 });
    expect(nonzeroFrames(render(synced, 2400)[0])).toEqual([2000]);
    synced.setParameters({ bpm: 240 });
    synced.reset();
    expect(nonzeroFrames(render(synced, 1400)[0])).toEqual([1000]);
    synced.setParameters({ bpm: 60 });
    synced.reset();
    expect(nonzeroFrames(render(synced, 4400)[0])).toEqual([4000]);

    const milliseconds = new BrowserOfficialDelayDsp('delay', RATE, { time: 10, bpm: 120, feedback: 1 });
    milliseconds.setParameters({ bpm: 60 });
    expect(nonzeroFrames(render(milliseconds, 160)[0])).toEqual([80]);
  });

  it('changes live tempo after a bounded sample-clock ramp without requiring reset', () => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE, { time: -0.5, bpm: 120, feedback: 1 });
    dsp.setParameters({ bpm: 240 });
    for (let i = 0; i < 200; i += 1) dsp.processSample(0, 0);
    expect(nonzeroFrames(render(dsp, 1400)[0])).toEqual([1000]);
  });

  it('reverses the complete previous segment and repeats it a finite number of times', () => {
    const dsp = new BrowserOfficialDelayDsp('reverse-delay', RATE, { time: 10, feedback: 3 });
    expect(dsp.latencySamples).toBe(80);
    const [left, right] = render(dsp, 480, frame => {
      if (frame === 20) return [0.25, -0.5];
      if (frame === 50) return [0.75, -0.25];
      return [0, 0];
    });
    expect(nonzeroFrames(left)).toEqual([109, 139, 189, 219, 269, 299]);
    expect(left[109]).toBeCloseTo(0.75, 12);
    expect(left[139]).toBeCloseTo(0.25, 12);
    expect(right[109]).toBeCloseTo(-0.25, 12);
    expect(right[139]).toBeCloseTo(-0.5, 12);
    expect(left[269]).toBeCloseTo(0.75 * 0.65 ** 2, 12);
  });

  it('keeps reverse edge impulses audible without creating an extra repeat during crossfades', () => {
    const dsp = new BrowserOfficialDelayDsp('reverse-delay', RATE, { time: 10, feedback: 16 });
    const [left] = render(dsp, 1600);
    expect(nonzeroFrames(left)).toEqual(Array.from({ length: 16 }, (_, i) => (i + 2) * 80 - 1));
    expect(left[159]).toBeGreaterThan(0);
    expect(left[159]).toBeLessThan(0.1);
    expect(left[1359]).toBeCloseTo(left[159]! * 0.65 ** 15, 12);
  });

  it('applies reverse TIME/BPM changes only at a segment boundary and keeps captured content', () => {
    const dsp = new BrowserOfficialDelayDsp('reverse-delay', RATE, { time: -0.02, bpm: 120, feedback: 1 });
    for (let i = 0; i < 30; i += 1) dsp.processSample(i === 20 ? 1 : 0, 0);
    dsp.setParameters({ bpm: 60 });
    expect(dsp.latencySamples).toBe(80);
    for (let i = 30; i < 80; i += 1) dsp.processSample(0, 0);
    expect(dsp.latencySamples).toBe(160);
    const [left] = render(dsp, 400, () => [0, 0]);
    // Original position 20 in an 80-frame segment reverses to fraction 59/79
    // of the new 160-frame playback interval, not a discarded or new segment.
    const peak = left.indexOf(Math.max(...left));
    expect(Math.abs(peak - 159 * 59 / 79)).toBeLessThanOrEqual(1);
    expect(nonzeroFrames(left).every(frame => frame < 160)).toBe(true);
  });

  it('depth zero exactly equals ordinary delay while nonzero depth moves both fractional taps', () => {
    const tone = (frame: number): readonly [number, number] => {
      const value = Math.sin(2 * Math.PI * 337 * frame / RATE) * 0.3;
      return [value, value];
    };
    const parameters = { time: 50, feedback: 3, modDepth: 0 };
    const plain = render(new BrowserOfficialDelayDsp('delay', RATE, parameters), 12000, tone);
    const zero = render(new BrowserOfficialDelayDsp('mod-delay', RATE, parameters), 12000, tone);
    expect(zero).toEqual(plain);
    const full = render(new BrowserOfficialDelayDsp('mod-delay', RATE, { ...parameters, modDepth: 100 }), 12000, tone);
    let difference = 0;
    let stereoDifference = 0;
    for (let frame = 1600; frame < 12000; frame += 1) {
      difference += (full[0][frame]! - zero[0][frame]!) ** 2;
      stereoDifference += (full[0][frame]! - full[1][frame]!) ** 2;
    }
    expect(difference).toBeGreaterThan(10);
    expect(stereoDifference).toBeGreaterThan(10);
  });

  it('smooths live MOD DEPTH updates and eventually reaches the fully modulated state', () => {
    const initial = new BrowserOfficialDelayDsp('mod-delay', RATE, { time: 50, feedback: 1, modDepth: 0 });
    const still = new BrowserOfficialDelayDsp('mod-delay', RATE, { time: 50, feedback: 1, modDepth: 0 });
    let initialDifference = 0;
    let lateDifference = 0;
    for (let frame = 0; frame < 2200; frame += 1) {
      if (frame === 1200) initial.setParameters({ modDepth: 100 });
      const value = 0.25 * Math.sin(2 * Math.PI * 100 * frame / RATE);
      initial.processSample(value, value);
      still.processSample(value, value);
      if (frame === 1200) initialDifference = Math.abs(initial.wetLeft - still.wetLeft);
      if (frame >= 1400) lateDifference += Math.abs(initial.wetLeft - still.wetLeft);
    }
    expect(initialDifference).toBeLessThan(0.02);
    expect(lateDifference).toBeGreaterThan(10);
  });

  it('modulated impulse taps remain finite and end after the requested repeat envelope', () => {
    const dsp = new BrowserOfficialDelayDsp('mod-delay', RATE, { time: 50, feedback: 4, modDepth: 100 });
    const [left, right] = render(dsp, 4000);
    for (const output of [left, right]) {
      const frames = nonzeroFrames(output);
      expect(frames.length).toBeGreaterThanOrEqual(4);
      expect(frames.every(frame => frame >= 304 && frame <= 1984)).toBe(true);
      let groups = 0;
      let last = -100;
      for (const frame of frames) {
        if (frame - last > 1) groups += 1;
        last = frame;
      }
      expect(groups).toBe(4);
    }
  });

  it.each(algorithms)('%s is callback-invariant, finite and bounded for exceptional input', algorithm => {
    const params = { time: 10, feedback: 16, modDepth: 100, bpm: 120 };
    const input = (frame: number): readonly [number, number] => {
      if (frame % 100 === 0) return [Number.NaN, Number.POSITIVE_INFINITY];
      if (frame % 17 === 0) return [1e300, -1e300];
      return [0.25 * Math.sin(frame * 0.15), 0.2 * Math.cos(frame * 0.11)];
    };
    const whole = render(new BrowserOfficialDelayDsp(algorithm, RATE, params), 5000, input);
    const split = render(new BrowserOfficialDelayDsp(algorithm, RATE, params), 5000, input, [1, 7, 128, 51]);
    expect(split).toEqual(whole);
    for (const channel of whole) for (const sample of channel) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(8);
    }
  });

  it.each(algorithms)('%s reset clears tails, retains parameters and reuses its preallocated storage', algorithm => {
    const dsp = new BrowserOfficialDelayDsp(algorithm, RATE, { time: 10, feedback: 3, modDepth: 70 });
    const storage = Object.values(dsp).filter(value => ArrayBuffer.isView(value));
    const first = render(dsp, 500);
    dsp.setParameters({ time: 20, feedback: 16, modDepth: 100 });
    render(dsp, 500);
    dsp.setParameters({ time: 10, feedback: 3, modDepth: 70 });
    dsp.reset();
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.wetRight).toBe(0);
    expect(render(dsp, 500)).toEqual(first);
    const after = Object.values(dsp).filter(value => ArrayBuffer.isView(value));
    expect(after.length).toBe(storage.length);
    after.forEach((array, index) => expect(array).toBe(storage[index]));
    dsp.reset();
    expect(nonzeroFrames(render(dsp, 500, () => [0, 0])[0])).toEqual([]);
    expect(dsp.processSample(0, 0)).toBe(dsp);
  });

  it('supports 1ms, rejects TIME OFF/zero, and clamps delay duration and repeat counts safely', () => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE, { time: 1, feedback: 0 });
    dsp.setParameters({ time: -1000, feedback: Number.NaN, bpm: Number.NaN });
    dsp.setParameters({ time: 0 });
    expect(nonzeroFrames(render(dsp, 40)[0])).toEqual([8]);
    const maximum = new BrowserOfficialDelayDsp('delay', RATE, { time: 5000, bpm: 1, feedback: 100 });
    expect(maximum.bufferCapacitySamples).toBe(34 * RATE + 4);
    const [left] = render(maximum, 34 * RATE + 20);
    expect(nonzeroFrames(left)).toEqual(Array.from({ length: 16 }, (_, i) => (i + 1) * 2 * RATE));
  });

  it('does not resurrect overwritten source after the ring wraps', () => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE, { time: 1, feedback: 1 });
    const [left] = render(dsp, dsp.bufferCapacitySamples + 100);
    expect(nonzeroFrames(left)).toEqual([8]);
  });

  it('allows half-note TIME beyond two seconds at the host BPM limits', () => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE, { time: -2, bpm: 40, feedback: 1 });
    expect(nonzeroFrames(render(dsp, 3 * RATE + 100)[0])).toEqual([3 * RATE]);
    expect(dsp.bufferCapacitySamples).toBe(17 * 3 * RATE + 4);
    dsp.setParameters({ bpm: 60 });
    dsp.reset();
    expect(nonzeroFrames(render(dsp, 2 * RATE + 100)[0])).toEqual([2 * RATE]);
    // Faster tempo preserves the beat selection, and storage never shrinks.
    expect(dsp.bufferCapacitySamples).toBe(17 * 3 * RATE + 4);
    dsp.setParameters({ time: 2000 });
    dsp.reset();
    expect(nonzeroFrames(render(dsp, 2 * RATE + 100)[0])).toEqual([2 * RATE]);
  });

  it('grows only when necessary and preserves the source history during a live tempo change', () => {
    const dsp = new BrowserOfficialDelayDsp('delay', RATE, { time: -2, bpm: 240, feedback: 2 });
    render(dsp, 4000);
    const before = Object.values(dsp).filter(value => value instanceof Float32Array);
    dsp.setParameters({ bpm: 40 });
    const grown = Object.values(dsp).filter(value => value instanceof Float32Array);
    expect(grown[0]).not.toBe(before[0]);
    expect(grown[1]).not.toBe(before[1]);
    const [left, right] = render(dsp, 100000, () => [0, 0]);
    expect(nonzeroFrames(left)).toEqual([3 * RATE - 4000, 6 * RATE - 4000]);
    expect(right).toEqual(left);
    expect(left[3 * RATE - 4000]).toBe(1);
    expect(left[6 * RATE - 4000]).toBeCloseTo(0.65, 12);
    dsp.setParameters({ bpm: 60 });
    const after = Object.values(dsp).filter(value => value instanceof Float32Array);
    after.forEach((array, index) => expect(array).toBe(grown[index]));
  });

  it('preserves reverse captured-segment indices when growing partway through capture', () => {
    const dsp = new BrowserOfficialDelayDsp('reverse-delay', RATE, { time: 10, feedback: 1 });
    render(dsp, 150, frame => frame === 100 ? [1, -0.5] : [0, 0]);
    dsp.setParameters({ time: -2, bpm: 40 });
    // Ten frames finish the old capture; the new duration applies afterward.
    const [left, right] = render(dsp, 50000, () => [0, 0]);
    const peak = left.indexOf(Math.max(...left));
    expect(Math.abs(peak - (10 + (3 * RATE - 1) * 59 / 79))).toBeLessThanOrEqual(1);
    expect(left[peak]).toBeGreaterThan(0.99);
    expect(right[peak]).toBeCloseTo(-0.5 * left[peak]!, 12);
    expect(dsp.latencySamples).toBe(3 * RATE);
  });

  it('initializes reverse capture correctly when the constructor needs a larger ring', () => {
    const dsp = new BrowserOfficialDelayDsp('reverse-delay', RATE, { time: -2, bpm: 40, feedback: 1 });
    const sourceFrame = 1000;
    const [left] = render(dsp, 6 * RATE + 100, frame => frame === sourceFrame ? [1, 0] : [0, 0]);
    expect(nonzeroFrames(left)).toEqual([6 * RATE - 1 - sourceFrame]);
  });

  it('preserves wrapped reverse segments and an in-progress capture when the ring grows', () => {
    const dsp = new BrowserOfficialDelayDsp('reverse-delay', RATE, { time: 10, feedback: 1 });
    const processed = dsp.bufferCapacitySamples + 100;
    const captureStart = Math.floor(processed / 80) * 80;
    const position = processed - captureStart;
    for (let frame = 0; frame < processed; frame += 1) {
      const value = frame === captureStart - 80 + 20 ? 0.5 : frame === captureStart + 20 ? 1 : 0;
      dsp.processSample(value, -value);
    }
    dsp.setParameters({ time: -2, bpm: 40 });
    const [left, right] = render(dsp, 50000, () => [0, 0]);
    // The previous segment straddled the old ring boundary. Its remaining
    // reverse playback must survive the copy with no timing or channel shift.
    expect(left[59 - position]).toBe(0.5);
    expect(right[59 - position]).toBe(-0.5);
    const peak = left.indexOf(Math.max(...left));
    const expected = 80 - position + (3 * RATE - 1) * 59 / 79;
    expect(Math.abs(peak - expected)).toBeLessThanOrEqual(1);
    expect(left[peak]).toBeGreaterThan(0.99);
  });
});
