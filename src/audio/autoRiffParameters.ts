export const AUTO_RIFF_SCALE_OPTIONS = [
  { value: 0, label: 'Chromatic' },
  { value: 1, label: 'Major' },
  { value: 2, label: 'Natural minor' },
  { value: 3, label: 'Harmonic minor' },
  { value: 4, label: 'Pentatonic' },
] as const;

export const AUTO_RIFF_RATE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

export interface AutoRiffParameters {
  scale: number;
  rateBeats: number;
  sensitivityPercent: number;
  mixPercent: number;
}

export function createDefaultAutoRiffParameters(): AutoRiffParameters {
  return { scale: 0, rateBeats: 0.5, sensitivityPercent: 55, mixPercent: 65 };
}

export function sanitizeAutoRiffParameters(value?: Partial<AutoRiffParameters> | null): AutoRiffParameters {
  const defaults = createDefaultAutoRiffParameters();
  const scale = Number.isFinite(value?.scale) ? Math.round(value!.scale!) : defaults.scale;
  const requestedRate = Number.isFinite(value?.rateBeats) ? value!.rateBeats! : defaults.rateBeats;
  let rateBeats: number = AUTO_RIFF_RATE_OPTIONS[0];
  for (const option of AUTO_RIFF_RATE_OPTIONS) {
    if (Math.abs(option - requestedRate) < Math.abs(rateBeats - requestedRate)) rateBeats = option;
  }
  const sensitivityPercent = Number.isFinite(value?.sensitivityPercent)
    ? value!.sensitivityPercent!
    : defaults.sensitivityPercent;
  const mixPercent = Number.isFinite(value?.mixPercent) ? value!.mixPercent! : defaults.mixPercent;
  return {
    scale: Math.max(0, Math.min(4, scale)),
    rateBeats,
    sensitivityPercent: Math.max(0, Math.min(100, sensitivityPercent)),
    mixPercent: Math.max(0, Math.min(100, mixPercent)),
  };
}

export function toCatalogAutoRiffParameters(value?: Partial<AutoRiffParameters> | null): Record<string, number> {
  const parameters = sanitizeAutoRiffParameters(value);
  return {
    scale: parameters.scale,
    rate_beats: parameters.rateBeats,
    sensitivity_percent: parameters.sensitivityPercent,
    mix_percent: parameters.mixPercent,
  };
}
