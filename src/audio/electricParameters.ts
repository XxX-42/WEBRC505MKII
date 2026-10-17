export type ElectricCharacter = 0 | 1 | 2 | 3;

export interface ElectricParameters {
  character: ElectricCharacter;
  pitchSnapPercent: number;
  toneHz: number;
  mixPercent: number;
}

export function createDefaultElectricParameters(): ElectricParameters {
  return { character: 0, pitchSnapPercent: 50, toneHz: 5_000, mixPercent: 70 };
}

export function sanitizeElectricParameters(value?: Partial<ElectricParameters> | null): ElectricParameters {
  const defaults = createDefaultElectricParameters();
  const character = Number.isFinite(value?.character) ? Math.round(value!.character!) : defaults.character;
  const pitchSnapPercent = Number.isFinite(value?.pitchSnapPercent)
    ? value!.pitchSnapPercent!
    : defaults.pitchSnapPercent;
  const toneHz = Number.isFinite(value?.toneHz) ? value!.toneHz! : defaults.toneHz;
  const mixPercent = Number.isFinite(value?.mixPercent) ? value!.mixPercent! : defaults.mixPercent;
  return {
    character: Math.max(0, Math.min(3, character)) as ElectricCharacter,
    pitchSnapPercent: Math.max(0, Math.min(100, pitchSnapPercent)),
    toneHz: Math.max(100, Math.min(16_000, toneHz)),
    mixPercent: Math.max(0, Math.min(100, mixPercent)),
  };
}

/** Browser worklet's namespaced controls and normalized mix. */
export function toBrowserElectricParameters(value?: Partial<ElectricParameters> | null): Record<string, number> {
  const parameters = sanitizeElectricParameters(value);
  return {
    electricCharacter: parameters.character,
    electricPitchSnapPercent: parameters.pitchSnapPercent,
    electricToneHz: parameters.toneHz,
    mix: parameters.mixPercent / 100,
  };
}

/** Native descriptor keys use the shared 0–100 mix control. */
export function toNativeElectricParameters(value?: Partial<ElectricParameters> | null): Record<string, number> {
  const parameters = sanitizeElectricParameters(value);
  return {
    character: parameters.character,
    'pitch-snap': parameters.pitchSnapPercent,
    tone: parameters.toneHz,
    mix: parameters.mixPercent,
  };
}
