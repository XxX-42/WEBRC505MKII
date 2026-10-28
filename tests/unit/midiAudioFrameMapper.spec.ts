import { describe, expect, it } from 'vitest';
import { MidiAudioFrameMapper } from '../../src/audio/MidiAudioFrameMapper';

const contextA = {};
const contextB = {};
const anchor = (performanceTimeMs: number, audioTimeSeconds: number, contextKey = contextA, contextState: 'running' | 'suspended' = 'running') => ({
  performanceTimeMs, audioTimeSeconds, sampleRate: 48_000, contextKey, contextState,
});

describe('MidiAudioFrameMapper', () => {
  it('does not claim a precise mapping until several anchors span enough time', () => {
    const mapper = new MidiAudioFrameMapper();
    expect(mapper.addAnchor(anchor(1_000, 10))).toMatchObject({ ok: true, reason: 'insufficient-drift-evidence', driftPpm: null });
    expect(mapper.addAnchor(anchor(1_100, 10.1005))).toMatchObject({ ok: true, reason: 'insufficient-drift-evidence', driftPpm: null });
    expect(mapper.map(1_050, 1_100)).toMatchObject({ ok: false, frame: null, reason: 'insufficient-drift-evidence', driftPpm: null });
    mapper.addAnchor(anchor(3_000, 12));
    expect(mapper.addAnchor(anchor(4_000, 13))).toMatchObject({ ok: true, reason: null });
    expect(mapper.map(4_025, 4_030)).toMatchObject({ ok: true, frame: 625_198, driftPpm: expect.any(Number), anchorCount: 4 });
  });

  it('treats an identical repeated clock sample as an idempotent anchor', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.addAnchor(anchor(1_000, 10))).toMatchObject({
      ok: true, reason: 'insufficient-drift-evidence', driftPpm: null, anchorCount: 1,
    });
    expect(mapper.map(1_025, 1_030)).toMatchObject({
      ok: false, frame: null, reason: 'insufficient-drift-evidence', driftPpm: null, anchorCount: 1,
    });
  });

  it('estimates bounded clock drift from multiple anchors', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    mapper.addAnchor(anchor(4_000, 13.0015));
    mapper.addAnchor(anchor(7_000, 16.003));
    const mapped = mapper.map(7_500, 7_510);
    expect(mapped.ok).toBe(true);
    expect(mapped.frame).toBe(792_156);
    expect(mapped.driftPpm).toBeCloseTo(500, 0);
  });

  it('invalidates anchors during suspension and rebuilds after resume or context recreation', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.addAnchor(anchor(1_010, 10.01, contextA, 'suspended')).reason).toBe('context-suspended');
    expect(mapper.map(1_010, 1_010).reason).toBe('context-suspended');
    expect(mapper.addAnchor(anchor(2_000, 12)).reason).toBe('insufficient-drift-evidence');
    mapper.addAnchor(anchor(4_000, 14));
    expect(mapper.addAnchor(anchor(6_000, 16)).reason).toBe(null);
    expect(mapper.map(6_000, 6_010).ok).toBe(true);
    expect(mapper.addAnchor(anchor(7_000, 20, contextB)).reason).toBe('context-changed');
    expect(mapper.addAnchor(anchor(8_000, 21, contextB)).reason).toBe('insufficient-drift-evidence');
    mapper.addAnchor(anchor(10_000, 23, contextB));
    expect(mapper.addAnchor(anchor(12_000, 25, contextB)).reason).toBe(null);
    expect(mapper.map(12_000, 12_010).ok).toBe(true);
  });

  it('fails explicitly for late and future event timestamps', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.map(700, 1_000)).toMatchObject({ ok: false, frame: null, reason: 'stale-event' });
    expect(mapper.map(1_120, 1_000)).toMatchObject({ ok: false, frame: null, reason: 'future-event' });
  });

  it('fails when repeated quantized currentTime reads provide no advancing audio clock', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.addAnchor(anchor(1_250, 10)).reason).toBe('invalid-anchor');
    expect(mapper.map(1_200, 1_250)).toMatchObject({ ok: false, frame: null, reason: 'invalid-anchor' });
    expect(mapper.addAnchor(anchor(1_500, 10.5)).reason).toBe('insufficient-drift-evidence');
  });

  it('keeps collecting after a short-baseline apparent drift and later recovers', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.addAnchor(anchor(1_100, 10.1005)).reason).toBe('insufficient-drift-evidence');
    expect(mapper.addAnchor(anchor(3_000, 12)).reason).toBe('insufficient-drift-evidence');
    expect(mapper.addAnchor(anchor(4_000, 13)).reason).toBe(null);
    expect(mapper.map(4_000, 4_000).ok).toBe(true);
  });

  it('allows an explicit reset to discard insufficient or polluted samples before resampling', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    mapper.addAnchor(anchor(1_100, 10.1005));
    expect(mapper.map(1_050, 1_050).reason).toBe('insufficient-drift-evidence');

    mapper.reset();
    expect(mapper.map(1_050, 1_050).reason).toBe('unanchored');
    mapper.addAnchor(anchor(2_000, 20));
    mapper.addAnchor(anchor(4_000, 22));
    expect(mapper.addAnchor(anchor(6_000, 24)).reason).toBe(null);
    expect(mapper.map(6_000, 6_000).ok).toBe(true);
  });

  it('does not treat render-quantized clock edges as trusted short-term drift', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.addAnchor(anchor(1_100, 10.102667)).reason).toBe('insufficient-drift-evidence');
    expect(mapper.addAnchor(anchor(2_000, 11.002667)).reason).toBe('insufficient-drift-evidence');
    expect(mapper.map(2_000, 2_000)).toMatchObject({ ok: false, frame: null, driftPpm: null });
    expect(mapper.addAnchor(anchor(4_000, 13.002667)).reason).toBe(null);
    expect(Math.abs(mapper.map(4_000, 4_000).driftPpm ?? Infinity)).toBeLessThanOrEqual(2_000);
  });

  it('rejects continuous outliers after a trusted fit and accepts a valid resample', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    mapper.addAnchor(anchor(3_000, 12));
    mapper.addAnchor(anchor(5_000, 14));
    expect(mapper.addAnchor(anchor(6_000, 15.2)).reason).toBe('outlier-anchor');
    expect(mapper.addAnchor(anchor(6_100, 15.5)).reason).toBe('outlier-anchor');
    expect(mapper.map(5_500, 5_500)).toMatchObject({ ok: false, frame: null, reason: 'outlier-anchor' });
    expect(mapper.addAnchor(anchor(6_000, 15)).reason).toBe(null);
    expect(mapper.map(6_000, 6_000).ok).toBe(true);
  });
});
