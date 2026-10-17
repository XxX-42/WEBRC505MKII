import { describe, expect, it } from 'vitest';
import { createDefaultVocoderParameters, sanitizeVocoderParameters, toCatalogVocoderParameters } from '../../src/audio/vocoderParameters';

describe('Vocoder parameters', () => {
  it('uses bounded clean-room controls and maps the supported native/browser keys', () => {
    const defaults = createDefaultVocoderParameters();
    expect(defaults).toEqual({ bands: 16, carrier: 1, mixPercent: 70 });
    expect(sanitizeVocoderParameters({ bands: 23.7, carrier: 2.4, mixPercent: -5 })).toEqual({
      bands: 24,
      carrier: 2,
      mixPercent: 0,
    });
    expect(sanitizeVocoderParameters({ bands: Number.NaN, carrier: 2.9, mixPercent: 101 })).toEqual({
      bands: 16,
      carrier: 2,
      mixPercent: 100,
    });
    expect(toCatalogVocoderParameters({ bands: 12, carrier: 0, mixPercent: 55 })).toEqual({
      bands: 12,
      carrier: 0,
      mix: 55,
    });
  });
});
