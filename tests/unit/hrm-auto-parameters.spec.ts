import { describe, expect, it } from 'vitest';
import {
  createDefaultHrmAutoParameters,
  sanitizeHrmAutoParameters,
  toCatalogHrmAutoParameters,
} from '../../src/audio/hrmAutoParameters';

describe('HRM AUTO parameters', () => {
  it('uses bounded clean-room choices and defaults', () => {
    expect(createDefaultHrmAutoParameters()).toEqual({ key: 0, scale: 0, midiChannel: 1, mixPercent: 70 });
    expect(sanitizeHrmAutoParameters({ key: 7.8, scale: 3.6, midiChannel: 15.7, mixPercent: 42.5 })).toEqual({
      key: 8,
      scale: 4,
      midiChannel: 16,
      mixPercent: 42.5,
    });
    expect(sanitizeHrmAutoParameters({ key: -5, scale: 8, midiChannel: -1, mixPercent: 130 })).toEqual({
      key: 0,
      scale: 4,
      midiChannel: 1,
      mixPercent: 100,
    });
  });

  it('replaces non-finite values with defaults and maps to named catalog keys', () => {
    expect(sanitizeHrmAutoParameters({ key: Number.NaN, scale: Number.POSITIVE_INFINITY, midiChannel: Number.NaN, mixPercent: Number.NaN })).toEqual({
      key: 0,
      scale: 0,
      midiChannel: 1,
      mixPercent: 70,
    });
    expect(toCatalogHrmAutoParameters({ key: 9, scale: 2, midiChannel: 12, mixPercent: 64 })).toEqual({
      key: 9,
      scale: 2,
      'midi-channel': 12,
      mix: 64,
    });
  });
});
