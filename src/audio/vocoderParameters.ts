export type VocoderCarrier = 0 | 1 | 2;

export interface VocoderParameters {
  bands: number;
  carrier: VocoderCarrier;
  mixPercent: number;
}

export type VocoderParameterKey = 'bands' | 'carrier' | 'mix';

export function createDefaultVocoderParameters(): VocoderParameters {
  return { bands: 16, carrier: 1, mixPercent: 70 };
}

function finiteNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

export function sanitizeVocoderParameters(raw?: Partial<VocoderParameters> | null): VocoderParameters {
  const defaults = createDefaultVocoderParameters();
  const bands = Math.round(Math.max(8, Math.min(24, finiteNumber(raw?.bands, defaults.bands))));
  const carrier = Math.round(Math.max(0, Math.min(2, finiteNumber(raw?.carrier, defaults.carrier)))) as VocoderCarrier;
  const mixPercent = Math.max(0, Math.min(100, finiteNumber(raw?.mixPercent, defaults.mixPercent)));
  return { bands, carrier, mixPercent };
}

export function toCatalogVocoderParameters(parameters: VocoderParameters): Record<VocoderParameterKey, number> {
  const safe = sanitizeVocoderParameters(parameters);
  return { bands: safe.bands, carrier: safe.carrier, mix: safe.mixPercent };
}
