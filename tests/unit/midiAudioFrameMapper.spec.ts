import { describe, expect, it } from 'vitest';
import { MidiAudioFrameMapper } from '../../src/audio/MidiAudioFrameMapper';

const contextA = {};
const contextB = {};
const anchor = (performanceTimeMs: number, audioTimeSeconds: number, contextKey = contextA, contextState: 'running' | 'suspended' = 'running') => ({
  performanceTimeMs, audioTimeSeconds, sampleRate: 48_000, contextKey, contextState,
});

describe('MidiAudioFrameMapper', () => {
  it('maps normal performance-time offset to the corresponding audio frame', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    const mapped = mapper.map(1_025, 1_030);
    expect(mapped).toMatchObject({ ok: true, frame: 481_200, reason: null, driftPpm: null, anchorCount: 1 });
  });

  it('estimates bounded clock drift from multiple anchors', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    mapper.addAnchor(anchor(2_000, 11.0005));
    const mapped = mapper.map(2_500, 2_510);
    expect(mapped.ok).toBe(true);
    expect(mapped.frame).toBe(552_036);
    expect(mapped.driftPpm).toBeCloseTo(500, 0);
  });

  it('invalidates anchors during suspension and rebuilds after resume or context recreation', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    expect(mapper.addAnchor(anchor(1_010, 10.01, contextA, 'suspended')).reason).toBe('context-suspended');
    expect(mapper.map(1_010, 1_010).reason).toBe('context-suspended');
    expect(mapper.addAnchor(anchor(2_000, 12)).ok).toBe(true);
    expect(mapper.map(2_000, 2_010).ok).toBe(true);
    expect(mapper.addAnchor(anchor(3_000, 20, contextB)).reason).toBe('context-changed');
    expect(mapper.addAnchor(anchor(3_100, 20.1, contextB)).ok).toBe(true);
    expect(mapper.map(3_100, 3_110).ok).toBe(true);
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
    expect(mapper.addAnchor(anchor(1_500, 10.5)).ok).toBe(true);
  });

  it('rejects an outlying anchor without silently manufacturing a frame', () => {
    const mapper = new MidiAudioFrameMapper();
    mapper.addAnchor(anchor(1_000, 10));
    mapper.addAnchor(anchor(1_100, 10.1));
    expect(mapper.addAnchor(anchor(1_200, 11)).reason).toBe('outlier-anchor');
    expect(mapper.map(1_150, 1_150)).toMatchObject({ ok: false, frame: null, reason: 'outlier-anchor' });
    expect(mapper.addAnchor(anchor(1_200, 10.2)).ok).toBe(true);
    expect(mapper.map(1_200, 1_200).ok).toBe(true);
  });
});
