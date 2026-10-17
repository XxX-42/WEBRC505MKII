const HALF_PI = Math.PI * 0.5;

function clampPosition(position: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.min(1, position));
}

export function equalPowerFadeOutGain(position: number): number {
  return Math.cos(clampPosition(position) * HALF_PI);
}

export function equalPowerFadeInGain(position: number): number {
  return Math.sin(clampPosition(position) * HALF_PI);
}

/**
 * Writes [outgoing, incoming] gains to caller-owned storage, avoiding a
 * per-sample tuple/object allocation in real-time code.
 */
export function writeEqualPowerCrossfadeGains(
  position: number,
  output: Float32Array | Float64Array,
  offset = 0,
): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + 1 >= output.length) return;
  const clamped = clampPosition(position) * HALF_PI;
  output[offset] = Math.cos(clamped);
  output[offset + 1] = Math.sin(clamped);
}

export function equalPowerCrossfadeSample(
  outgoing: number,
  incoming: number,
  position: number,
): number {
  const clamped = clampPosition(position) * HALF_PI;
  return outgoing * Math.cos(clamped) + incoming * Math.sin(clamped);
}
