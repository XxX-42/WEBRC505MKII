import { describe, expect, it } from 'vitest';
import {
  AUTO_RIFF_RATE_OPTIONS,
  AUTO_RIFF_SCALE_OPTIONS,
  createDefaultAutoRiffParameters,
  sanitizeAutoRiffParameters,
  toCatalogAutoRiffParameters,
} from '../../src/audio/autoRiffParameters';

describe('AUTO RIFF parameters', () => {
  it('provides the catalog defaults and supported scale/rate choices', () => {
    expect(createDefaultAutoRiffParameters()).toEqual({
      scale: 0,
      rateBeats: 0.5,
      sensitivityPercent: 55,
      mixPercent: 65,
    });
    expect(AUTO_RIFF_SCALE_OPTIONS.map(({ label }) => label)).toEqual([
      'Chromatic', 'Major', 'Natural minor', 'Harmonic minor', 'Pentatonic',
    ]);
    expect(AUTO_RIFF_RATE_OPTIONS).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  it('clamps controls and snaps a persisted rate to the closest catalog option', () => {
    expect(sanitizeAutoRiffParameters({
      scale: 2.7,
      rateBeats: 1.4,
      sensitivityPercent: -4,
      mixPercent: 170,
    })).toEqual({ scale: 3, rateBeats: 1, sensitivityPercent: 0, mixPercent: 100 });
  });

  it('falls back safely for malformed values and produces semantic catalog keys', () => {
    expect(sanitizeAutoRiffParameters({
      scale: Number.NaN,
      rateBeats: Number.POSITIVE_INFINITY,
      sensitivityPercent: Number.NaN,
      mixPercent: Number.NaN,
    })).toEqual(createDefaultAutoRiffParameters());
    expect(toCatalogAutoRiffParameters({ scale: 4, rateBeats: 2, sensitivityPercent: 45, mixPercent: 80 }))
      .toEqual({ scale: 4, rate_beats: 2, sensitivity_percent: 45, mix_percent: 80 });
  });
});
