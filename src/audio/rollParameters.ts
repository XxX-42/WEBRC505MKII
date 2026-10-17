/** Clean-room ROLL controls shared by the Browser and Native catalog adapters. */
export interface RollParameters {
  sliceBeats: number;
  decayPercent: number;
  pitchSemitones: number;
  direction: number;
}

export const ROLL_SLICE_BEATS = [0.25, 0.5, 1, 2, 4] as const;
export const ROLL_DIRECTIONS = [0, 1, 2] as const;

export function createDefaultRollParameters(): RollParameters {
  return { sliceBeats: 0.5, decayPercent: 20, pitchSemitones: 0, direction: 0 };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function nearest(value: number, choices: readonly number[]): number {
  return choices.reduce((best, choice) => Math.abs(choice - value) < Math.abs(best - value) ? choice : best, choices[0] ?? 0);
}

export function sanitizeRollParameters(value: unknown): RollParameters {
  const defaults = createDefaultRollParameters();
  const source = value && typeof value === 'object' ? value as Partial<RollParameters> : {};
  const direction = Math.round(finiteOr(source.direction, defaults.direction));
  return {
    sliceBeats: nearest(clamp(finiteOr(source.sliceBeats, defaults.sliceBeats), 0.25, 4), ROLL_SLICE_BEATS),
    decayPercent: clamp(finiteOr(source.decayPercent, defaults.decayPercent), 0, 100),
    pitchSemitones: clamp(finiteOr(source.pitchSemitones, defaults.pitchSemitones), -24, 24),
    direction: ROLL_DIRECTIONS.includes(direction as typeof ROLL_DIRECTIONS[number]) ? direction : defaults.direction,
  };
}

/** Parameters consumed by catalog-backed DSP processors; values are provisional clean-room controls. */
export function toCatalogRollParameters(value: RollParameters): Record<string, number> {
  const parameters = sanitizeRollParameters(value);
  return {
    slice_beats: parameters.sliceBeats,
    decay_percent: parameters.decayPercent,
    pitch_semitones: parameters.pitchSemitones,
    direction: parameters.direction,
  };
}
