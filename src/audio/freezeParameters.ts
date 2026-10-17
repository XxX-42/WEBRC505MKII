/** Clean-room FREEZE micro-loop controls. Spectral mode remains unavailable. */
export interface FreezeParameters {
  captureLengthMs: number;
  pitchSemitones: number;
  frozen: boolean;
}

export const FREEZE_CAPTURE_RANGE_MS = { min: 2, max: 2000 } as const;

export function createDefaultFreezeParameters(): FreezeParameters {
  return { captureLengthMs: 250, pitchSemitones: 0, frozen: false };
}

export function sanitizeFreezeParameters(value: unknown): FreezeParameters {
  const source = value && typeof value === 'object' ? value as Partial<FreezeParameters> : {};
  const defaults = createDefaultFreezeParameters();
  const captureLengthMs = typeof source.captureLengthMs === 'number' && Number.isFinite(source.captureLengthMs)
    ? source.captureLengthMs
    : defaults.captureLengthMs;
  const pitchSemitones = typeof source.pitchSemitones === 'number' && Number.isFinite(source.pitchSemitones)
    ? source.pitchSemitones
    : defaults.pitchSemitones;
  return {
    captureLengthMs: Math.max(FREEZE_CAPTURE_RANGE_MS.min, Math.min(FREEZE_CAPTURE_RANGE_MS.max, captureLengthMs)),
    pitchSemitones: Math.max(-24, Math.min(24, pitchSemitones)),
    frozen: source.frozen === true,
  };
}

/** Stable numeric keys shared by the Browser and Native catalog adapters. */
export function toCatalogFreezeParameters(value: FreezeParameters): Record<string, number> {
  const parameters = sanitizeFreezeParameters(value);
  return {
    capture_ms: parameters.captureLengthMs,
    mode: 0,
    pitch_semitones: parameters.pitchSemitones,
    freeze: parameters.frozen ? 1 : 0,
  };
}
