import { describe, expect, it } from 'vitest';
import { parseRhythmKitDocument, parseRhythmPatternDocument, parseRhythmRuntimeSnapshot } from '../../src/controls/rhythmDocuments';
import type { RhythmKitDocument, RhythmPatternDocument, RhythmRuntimeSnapshot } from '../../src/audio/rhythmTypes';

const pattern: RhythmPatternDocument = {
  version: 1,
  id: 'four-on-floor',
  name: 'Four on the Floor',
  steps: 4,
  stepsPerBeat: 1,
  lanes: [
    { voice: 'kick', velocities: [1, 0, 0.7, 0] },
    { voice: 'snare', velocities: [0, 0.8, 0, 0.8] },
    { voice: 'hat', velocities: [0.35, 0.35, 0.35, 0.35] },
  ],
};

const kit: RhythmKitDocument = {
  version: 1,
  id: 'studio',
  name: 'Studio Kit',
  voices: {
    kick: { pitchHz: 55, decayMs: 220, noiseAmount: 0.04, toneGain: 0.9 },
    snare: { pitchHz: 190, decayMs: 140, noiseAmount: 0.8, toneGain: 0.4 },
    hat: { pitchHz: 7_500, decayMs: 60, noiseAmount: 1, toneGain: 0.1 },
  },
};

describe('rhythm document validation', () => {
  it('round-trips a bounded pattern, kit, and runtime snapshot', () => {
    expect(parseRhythmPatternDocument(pattern)).toEqual(pattern);
    expect(parseRhythmKitDocument(kit)).toEqual(kit);
    const snapshot: RhythmRuntimeSnapshot = { version: 1, enabled: true, volume: 0.6, pattern, kit };
    expect(parseRhythmRuntimeSnapshot(snapshot)).toEqual(snapshot);
  });

  it('rejects duplicated/missing lanes, bad step lengths, and out-of-range velocity', () => {
    expect(() => parseRhythmPatternDocument({
      ...pattern,
      lanes: [pattern.lanes[0], pattern.lanes[0], pattern.lanes[2]],
    })).toThrow(/unique supported voice/);
    expect(() => parseRhythmPatternDocument({
      ...pattern,
      lanes: [{ ...pattern.lanes[0]!, velocities: [0, 0] }, pattern.lanes[1], pattern.lanes[2]],
    })).toThrow(/exactly 4 steps/);
    expect(() => parseRhythmPatternDocument({
      ...pattern,
      lanes: [{ ...pattern.lanes[0]!, velocities: [0, 0, 1.2, 0] }, pattern.lanes[1], pattern.lanes[2]],
    })).toThrow(/between 0 and 1/);
  });

  it('rejects malformed voice synthesis parameters and invalid runtime volume', () => {
    expect(() => parseRhythmKitDocument({
      ...kit,
      voices: { ...kit.voices, kick: { ...kit.voices.kick, noiseAmount: Number.NaN } },
    })).toThrow(/noise amount/);
    expect(() => parseRhythmRuntimeSnapshot({ version: 1, enabled: true, volume: 2, pattern, kit })).toThrow(/volume/);
  });
});
