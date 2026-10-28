import { describe, expect, it } from 'vitest';
import { MidiClockEstimator } from '../../src/audio/MidiClockEstimator';

const TICK_MS = 60_000 / (120 * 24);

function feed(estimator: MidiClockEstimator, count: number, start = 0, source = 'a', interval = TICK_MS): number {
  let time = start;
  for (let i = 0; i < count; i += 1) {
    estimator.push(time, source);
    time += interval;
  }
  return time - interval;
}

describe('MidiClockEstimator', () => {
  it('does not infer tempo or phase from a single pulse or a source switch', () => {
    const estimator = new MidiClockEstimator();
    expect(estimator.push(100, 'a')).toMatchObject({ state: 'acquiring', bpm: null, phaseLocked: false, phaseTicks: null });
    expect(estimator.push(120, 'b')).toMatchObject({ state: 'acquiring', acceptedIntervals: 0, bpm: null, phaseLocked: false, phaseTicks: null });
    const snapshot = estimator.push(140, 'b');
    expect(snapshot).toMatchObject({ state: 'acquiring', acceptedIntervals: 1, phaseLocked: false });
    expect(snapshot.bpm).toBeCloseTo(125, 1);
  });

  it('locks only after enough stable intervals and estimates jitter with a robust median', () => {
    const estimator = new MidiClockEstimator();
    let time = 10;
    for (let i = 0; i < 8; i += 1) {
      estimator.push(time, 'clock');
      time += TICK_MS + [0.1, -0.2, 0.3, -0.1, 0.2, -0.3, 0.1, -0.1][i]!;
    }
    const snapshot = estimator.getSnapshot(time - 1);
    expect(snapshot.state).toBe('locked');
    expect(snapshot.stability).toBe('stable');
    expect(Math.abs(snapshot.bpm! - 120)).toBeLessThan(1);
    expect(snapshot.phaseLocked).toBe(true);
    expect(snapshot.phaseTicks).toBeCloseTo(8, 0);
    expect(snapshot.beatPhase).toBeGreaterThanOrEqual(0);
    expect(snapshot.beatPhase).toBeLessThan(1);
  });

  it('infers a missing pulse without halving the tempo or losing phase continuity', () => {
    const estimator = new MidiClockEstimator();
    const last = feed(estimator, 9);
    expect(estimator.getSnapshot(last).state).toBe('locked');
    const afterGap = last + 2 * TICK_MS;
    const snapshot = estimator.push(afterGap, 'a');
    expect(snapshot.state).toBe('locked');
    expect(snapshot.inferredMissingTicks).toBe(1);
    expect(Math.abs(snapshot.bpm! - 120)).toBeLessThan(1);
    expect(snapshot.phaseTicks).toBeCloseTo(10, 1);
  });

  it('re-anchors after an inconsistent interval during acquisition instead of carrying guessed phase', () => {
    const estimator = new MidiClockEstimator();
    estimator.push(0, 'clock');
    estimator.push(2 * TICK_MS, 'clock');

    const inconsistent = estimator.push(3 * TICK_MS, 'clock');
    expect(inconsistent).toMatchObject({
      state: 'acquiring',
      acceptedIntervals: 0,
      rejectedIntervals: 1,
      phaseLocked: false,
      phaseTicks: null,
      lastPulseAtMs: 3 * TICK_MS,
    });

    let snapshot = inconsistent;
    for (let tick = 4; tick <= 9; tick += 1) {
      snapshot = estimator.push(tick * TICK_MS, 'clock');
    }
    expect(snapshot).toMatchObject({ state: 'locked', phaseLocked: true, rejectedIntervals: 1 });
    expect(snapshot.bpm).toBeCloseTo(120, 1);
    expect(snapshot.phaseTicks).toBeCloseTo(6, 5);
  });

  it('rejects isolated timing outliers without poisoning its period, then reports stale phase after dropout', () => {
    const estimator = new MidiClockEstimator();
    const last = feed(estimator, 9);
    const outlier = estimator.push(last + TICK_MS * 1.5, 'a');
    expect(outlier.state).toBe('locked');
    expect(outlier.bpm).toBeCloseTo(120, 1);
    expect(outlier.rejectedIntervals).toBe(1);
    expect(outlier.phaseLocked).toBe(true);
    expect(outlier.phaseTicks).toBeCloseTo(9.5, 1);

    const stale = estimator.getSnapshot(last + 600);
    expect(stale.state).toBe('stale');
    expect(stale.phaseLocked).toBe(false);
    expect(stale.phaseTicks).toBeNull();
    expect(stale.beatPhase).toBeNull();

    const restarted = estimator.push(last + 700, 'a');
    expect(restarted).toMatchObject({ state: 'acquiring', acceptedIntervals: 0, bpm: null, phaseLocked: false });
  });

  it('clears period and relative phase when the source changes', () => {
    const estimator = new MidiClockEstimator();
    const last = feed(estimator, 9, 100, 'first');
    expect(estimator.getSnapshot(last).state).toBe('locked');
    const switched = estimator.push(last + TICK_MS, 'second');
    expect(switched).toMatchObject({ state: 'acquiring', acceptedIntervals: 0, bpm: null, sourceKey: 'second', phaseLocked: false });
    const oneMore = estimator.push(last + TICK_MS * 2, 'second');
    expect(oneMore).toMatchObject({ acceptedIntervals: 1, inferredMissingTicks: 0, phaseTicks: null });
  });

  it('re-anchors after a backwards timestamp and ignores a non-finite timestamp without corrupting evidence', () => {
    const estimator = new MidiClockEstimator();
    const last = feed(estimator, 9);
    const invalid = estimator.push(Number.NaN, 'a');
    expect(invalid).toMatchObject({ state: 'locked', acceptedIntervals: 8, phaseLocked: true });

    const backwards = estimator.push(last - 1, 'a');
    expect(backwards).toMatchObject({ state: 'acquiring', acceptedIntervals: 0, bpm: null, phaseLocked: false, phaseTicks: null });
  });

  it('counts duplicate and backwards timestamps even when each one forces a fresh anchor', () => {
    const estimator = new MidiClockEstimator();
    const last = feed(estimator, 9);
    expect(estimator.getSnapshot(last).phaseLocked).toBe(true);

    const duplicate = estimator.push(last, 'a');
    expect(duplicate).toMatchObject({
      state: 'acquiring',
      acceptedIntervals: 0,
      rejectedIntervals: 1,
      lastPulseAtMs: last,
      phaseLocked: false,
    });

    const backwards = estimator.push(last - 1, 'a');
    expect(backwards).toMatchObject({
      state: 'acquiring',
      acceptedIntervals: 0,
      rejectedIntervals: 2,
      lastPulseAtMs: last - 1,
      phaseLocked: false,
    });
  });

  it('rejects invalid BPM-range options and leaves an empty estimator waiting', () => {
    expect(() => new MidiClockEstimator({ minBpm: 300, maxBpm: 30 })).toThrow(RangeError);
    const estimator = new MidiClockEstimator();
    const snapshot = estimator.push(Number.NaN, 'a');
    expect(snapshot).toMatchObject({ state: 'waiting', bpm: null, sourceKey: null });
  });
});
