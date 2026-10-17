export interface ManualHarmonistParameters {
  voice1Interval: number;
  voice2Interval: number;
  panPercent: number;
  mixPercent: number;
}

export type ManualHarmonistParameterKey =
  | 'voice_1_interval'
  | 'voice_2_interval'
  | 'pan_percent'
  | 'mix_percent';

export function createDefaultManualHarmonistParameters(): ManualHarmonistParameters {
  return {
    voice1Interval: 7,
    voice2Interval: 12,
    panPercent: 0,
    mixPercent: 70,
  };
}

function bounded(raw: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(minimum, Math.min(maximum, raw));
}

export function sanitizeManualHarmonistParameters(
  raw?: Partial<ManualHarmonistParameters> | null,
): ManualHarmonistParameters {
  const defaults = createDefaultManualHarmonistParameters();
  return {
    voice1Interval: bounded(raw?.voice1Interval, defaults.voice1Interval, -24, 24),
    voice2Interval: bounded(raw?.voice2Interval, defaults.voice2Interval, -24, 24),
    panPercent: bounded(raw?.panPercent, defaults.panPercent, -100, 100),
    mixPercent: bounded(raw?.mixPercent, defaults.mixPercent, 0, 100),
  };
}

export function toCatalogManualHarmonistParameters(
  parameters: ManualHarmonistParameters,
): Record<ManualHarmonistParameterKey, number> {
  const safe = sanitizeManualHarmonistParameters(parameters);
  return {
    voice_1_interval: safe.voice1Interval,
    voice_2_interval: safe.voice2Interval,
    pan_percent: safe.panPercent,
    mix_percent: safe.mixPercent,
  };
}
