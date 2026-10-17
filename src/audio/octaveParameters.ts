export interface OctaveParameters {
  minus24Level: number;
  minus12Level: number;
  plus12Level: number;
  mixPercent: number;
}

export type OctaveParameterKey =
  | 'minus_24_level'
  | 'minus_12_level'
  | 'plus_12_level'
  | 'mix_percent';

export function createDefaultOctaveParameters(): OctaveParameters {
  return {
    minus24Level: 0,
    minus12Level: 40,
    plus12Level: 0,
    mixPercent: 70,
  };
}

function bounded(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(100, raw));
}

export function sanitizeOctaveParameters(raw?: Partial<OctaveParameters> | null): OctaveParameters {
  const defaults = createDefaultOctaveParameters();
  return {
    minus24Level: bounded(raw?.minus24Level, defaults.minus24Level),
    minus12Level: bounded(raw?.minus12Level, defaults.minus12Level),
    plus12Level: bounded(raw?.plus12Level, defaults.plus12Level),
    mixPercent: bounded(raw?.mixPercent, defaults.mixPercent),
  };
}

export function toCatalogOctaveParameters(parameters: OctaveParameters): Record<OctaveParameterKey, number> {
  const safe = sanitizeOctaveParameters(parameters);
  return {
    minus_24_level: safe.minus24Level,
    minus_12_level: safe.minus12Level,
    plus_12_level: safe.plus12Level,
    mix_percent: safe.mixPercent,
  };
}
