import { describe, expect, it } from 'vitest';
import {
  createDefaultOctaveParameters,
  sanitizeOctaveParameters,
  toCatalogOctaveParameters,
} from '../../src/audio/octaveParameters';

describe('OCTAVE controls', () => {
  it('uses the authored fixed-voice defaults and maps the generic macro to mix', () => {
    expect(createDefaultOctaveParameters()).toEqual({
      minus24Level: 0, minus12Level: 40, plus12Level: 0, mixPercent: 70,
    });
    expect(toCatalogOctaveParameters({
      minus24Level: 10, minus12Level: 40, plus12Level: 80, mixPercent: 55,
    })).toEqual({
      minus_24_level: 10, minus_12_level: 40, plus_12_level: 80, mix_percent: 55,
    });
  });

  it('bounds voice levels/mix and omits unsupported tracking and formant controls', () => {
    expect(sanitizeOctaveParameters({
      minus24Level: -10, minus12Level: 130, plus12Level: Number.NaN, mixPercent: 33,
    })).toEqual({
      minus24Level: 0, minus12Level: 100, plus12Level: 0, mixPercent: 33,
    });
    expect(toCatalogOctaveParameters(createDefaultOctaveParameters())).not.toHaveProperty('tracking_percent');
  });
});
