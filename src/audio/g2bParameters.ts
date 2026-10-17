/**
 * Clean-room G2B control contract for Browser and Native Input/Track FX slots.
 * Values are implementation controls, not manufacturer knob specifications.
 */
export interface G2bParameters {
  tracking: number;
  blend: number;
  body: number;
}

export function createDefaultG2bParameters(): G2bParameters {
  return { tracking: 65, blend: 65, body: 180 };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function sanitizeG2bParameters(value: unknown): G2bParameters {
  const defaults = createDefaultG2bParameters();
  const source = value && typeof value === 'object' ? value as Partial<G2bParameters> : {};
  return {
    tracking: clamp(finiteOr(source.tracking, defaults.tracking), 0, 100),
    blend: clamp(finiteOr(source.blend, defaults.blend), 0, 100),
    body: clamp(finiteOr(source.body, defaults.body), 60, 1200),
  };
}

export function toCatalogG2bParameters(value: G2bParameters): Record<string, number> {
  const parameters = sanitizeG2bParameters(value);
  return {
    tracking_percent: parameters.tracking,
    blend_percent: parameters.blend,
    body_hz: parameters.body,
  };
}
