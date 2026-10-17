import { describe, expect, it } from 'vitest';
import {
  createDefaultRobotFxParameters,
  sanitizeRobotFxParameters,
  toCatalogRobotParameters,
} from '../../src/audio/robotFxParameters';

describe('ROBOT parameters', () => {
  it('uses the catalog defaults and clamps persisted semitone/mix values', () => {
    expect(createDefaultRobotFxParameters()).toEqual({
      targetPitchSemitones: 0,
      formantShiftSemitones: 0,
      mixPercent: 100,
    });
    expect(sanitizeRobotFxParameters({
      targetPitchSemitones: 40,
      formantShiftSemitones: -20,
      mixPercent: -3,
    })).toEqual({ targetPitchSemitones: 24, formantShiftSemitones: -12, mixPercent: 0 });
  });

  it('sends the same accepted pitch, formant, and mix keys to both catalog adapters', () => {
    expect(toCatalogRobotParameters({
      targetPitchSemitones: -7.5,
      formantShiftSemitones: 9,
      mixPercent: 63,
    })).toEqual({ pitch_semitones: -7.5, formant_semitones: 9, mix_percent: 63 });
  });
});
