import { describe, expect, it } from 'vitest';
import { sameNativeControlSnapshot as same } from '../../src/audio/nativeFxParameterSnapshots';

describe('Native authored parameter snapshot equality', () => {
  it('excludes only derived official transport values, not extra or missing authored keys', () => {
    const expected = { official_depth: 50, wet_mix: 0.3, official_bpm: 120, official_quarter_notes_per_measure: 4 };
    expect(same({ ...expected, official_bpm: 187, official_quarter_notes_per_measure: 3 }, expected, 'phaser', { official_depth: 50 })).toBe(true);
    expect(same({ ...expected, stale_override: 1 }, expected, 'phaser', { official_depth: 50 })).toBe(false);
    expect(same({ official_depth: 50 }, expected, 'phaser', { official_depth: 50 })).toBe(false);
    expect(same({ ...expected, official_depth: 51 }, expected, 'phaser', { official_depth: 50 })).toBe(false);
    expect(same(null, expected, 'phaser', {})).toBe(false);
  });
  it('excludes STEP SLICER legacy bpm only if it is not an authored override', () => {
    const actual = { step_level_1: 37, bpm: 180 };
    const expected = { step_level_1: 37, bpm: 120 };
    expect(same(actual, expected, 'step_slicer', {})).toBe(true);
    expect(same(actual, expected, 'step_slicer', { bpm: 120 })).toBe(false);
    expect(same(actual, expected, 'delay', {})).toBe(false);
  });
});
