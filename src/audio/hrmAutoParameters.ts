/** Clean-room, provisional controls for the experimental HRM AUTO editor. */
export type HrmAutoKey = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export type HrmAutoScale = 0 | 1 | 2 | 3 | 4;

export const HRM_AUTO_KEY_OPTIONS = [
  { value: 0, label: 'C' },
  { value: 1, label: 'C#' },
  { value: 2, label: 'D' },
  { value: 3, label: 'D#' },
  { value: 4, label: 'E' },
  { value: 5, label: 'F' },
  { value: 6, label: 'F#' },
  { value: 7, label: 'G' },
  { value: 8, label: 'G#' },
  { value: 9, label: 'A' },
  { value: 10, label: 'A#' },
  { value: 11, label: 'B' },
] as const;

export const HRM_AUTO_SCALE_OPTIONS = [
  { value: 0, label: 'Major' },
  { value: 1, label: 'Natural minor' },
  { value: 2, label: 'Harmonic minor' },
  { value: 3, label: 'Dorian' },
  { value: 4, label: 'Mixolydian' },
] as const;

export interface HrmAutoParameters {
  key: HrmAutoKey;
  scale: HrmAutoScale;
  midiChannel: number;
  mixPercent: number;
}

export type HrmAutoCatalogParameterKey = 'key' | 'scale' | 'midi-channel' | 'mix';

export function createDefaultHrmAutoParameters(): HrmAutoParameters {
  return { key: 0, scale: 0, midiChannel: 1, mixPercent: 70 };
}

function finiteNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/** Clamp stepped HRM AUTO choices and the continuous mix to their catalog ranges. */
export function sanitizeHrmAutoParameters(raw?: Partial<HrmAutoParameters> | null): HrmAutoParameters {
  const defaults = createDefaultHrmAutoParameters();
  return {
    key: Math.round(Math.max(0, Math.min(11, finiteNumber(raw?.key, defaults.key)))) as HrmAutoKey,
    scale: Math.round(Math.max(0, Math.min(4, finiteNumber(raw?.scale, defaults.scale)))) as HrmAutoScale,
    midiChannel: Math.round(Math.max(1, Math.min(16, finiteNumber(raw?.midiChannel, defaults.midiChannel)))),
    mixPercent: Math.max(0, Math.min(100, finiteNumber(raw?.mixPercent, defaults.mixPercent))),
  };
}

/** Convert UI-friendly fields into the named keys used by the FX catalog. */
export function toCatalogHrmAutoParameters(
  parameters?: Partial<HrmAutoParameters> | null,
): Record<HrmAutoCatalogParameterKey, number> {
  const safe = sanitizeHrmAutoParameters(parameters);
  return {
    key: safe.key,
    scale: safe.scale,
    'midi-channel': safe.midiChannel,
    mix: safe.mixPercent,
  };
}
