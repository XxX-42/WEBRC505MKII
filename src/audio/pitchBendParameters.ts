/** Clean-room PITCH BEND controls shared by Browser and Native catalog routes. */
export interface PitchBendParameters {
  rangeSemitones: number;
  timeMs: number;
  /** 0 is up, 1 is down. */
  direction: number;
  mixPercent: number;
}

export function createDefaultPitchBendParameters(): PitchBendParameters {
  return { rangeSemitones: 12, timeMs: 500, direction: 0, mixPercent: 100 };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function sanitizePitchBendParameters(raw: unknown): PitchBendParameters {
  const defaults = createDefaultPitchBendParameters();
  const source = raw && typeof raw === 'object' ? raw as Partial<PitchBendParameters> : {};
  const direction = Math.round(finite(source.direction, defaults.direction));
  return {
    rangeSemitones: clamp(finite(source.rangeSemitones, defaults.rangeSemitones), 0, 24),
    timeMs: clamp(finite(source.timeMs, defaults.timeMs), 20, 4000),
    direction: direction === 1 ? 1 : 0,
    mixPercent: clamp(finite(source.mixPercent, defaults.mixPercent), 0, 100),
  };
}

export function toCatalogPitchBendParameters(raw: unknown): Record<string, number> {
  const parameters = sanitizePitchBendParameters(raw);
  return {
    range: parameters.rangeSemitones,
    time_ms: parameters.timeMs,
    direction: parameters.direction,
    mix_percent: parameters.mixPercent,
  };
}
