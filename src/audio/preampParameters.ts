/**
 * Shared clean-room PREAMP controls used by the Browser and Native FX banks.
 * The ranges are the current algorithm contract, not manufacturer knob limits.
 */
export interface PreampParameters {
  model: number;
  gainPercent: number;
  bassDb: number;
  middleDb: number;
  trebleDb: number;
  levelDb: number;
}

export const PREAMP_MODELS = ['Clean', 'Tweed', 'Stack', 'Lead', 'Bass'] as const;

export function createDefaultPreampParameters(): PreampParameters {
  return {
    model: 0,
    gainPercent: 35,
    bassDb: 0,
    middleDb: 0,
    trebleDb: 0,
    levelDb: 0,
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sanitizePreampParameters(value: unknown): PreampParameters {
  const defaults = createDefaultPreampParameters();
  const source = value && typeof value === 'object' ? value as Partial<PreampParameters> : {};
  return {
    model: clamp(Math.round(finiteOr(source.model, defaults.model)), 0, PREAMP_MODELS.length - 1),
    gainPercent: clamp(finiteOr(source.gainPercent, defaults.gainPercent), 0, 100),
    bassDb: clamp(finiteOr(source.bassDb, defaults.bassDb), -12, 12),
    middleDb: clamp(finiteOr(source.middleDb, defaults.middleDb), -12, 12),
    trebleDb: clamp(finiteOr(source.trebleDb, defaults.trebleDb), -12, 12),
    levelDb: clamp(finiteOr(source.levelDb, defaults.levelDb), -24, 12),
  };
}

export function toNativePreampParameters(value: PreampParameters): Record<string, number> {
  const parameters = sanitizePreampParameters(value);
  return {
    model: parameters.model,
    gain: parameters.gainPercent,
    bass: parameters.bassDb,
    middle: parameters.middleDb,
    treble: parameters.trebleDb,
    level: parameters.levelDb,
  };
}

export function toBrowserPreampParameters(value: PreampParameters): Record<string, number> {
  const parameters = sanitizePreampParameters(value);
  return {
    model: parameters.model,
    gain: parameters.gainPercent,
    bass: parameters.bassDb,
    middle: parameters.middleDb,
    treble: parameters.trebleDb,
    level: parameters.levelDb,
  };
}
