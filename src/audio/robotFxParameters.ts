export interface RobotFxParameters {
  targetPitchSemitones: number;
  formantShiftSemitones: number;
  mixPercent: number;
}

export function createDefaultRobotFxParameters(): RobotFxParameters {
  return { targetPitchSemitones: 0, formantShiftSemitones: 0, mixPercent: 100 };
}

export function sanitizeRobotFxParameters(value?: Partial<RobotFxParameters> | null): RobotFxParameters {
  const defaults = createDefaultRobotFxParameters();
  const targetPitchSemitones = Number.isFinite(value?.targetPitchSemitones)
    ? value!.targetPitchSemitones!
    : defaults.targetPitchSemitones;
  const formantShiftSemitones = Number.isFinite(value?.formantShiftSemitones)
    ? value!.formantShiftSemitones!
    : defaults.formantShiftSemitones;
  const mixPercent = Number.isFinite(value?.mixPercent) ? value!.mixPercent! : defaults.mixPercent;
  return {
    targetPitchSemitones: Math.max(-24, Math.min(24, targetPitchSemitones)),
    formantShiftSemitones: Math.max(-12, Math.min(12, formantShiftSemitones)),
    mixPercent: Math.max(0, Math.min(100, mixPercent)),
  };
}

/** Shared Native and Browser catalog adapter keys accepted by the ROBOT runtime boundary. */
export function toCatalogRobotParameters(value?: Partial<RobotFxParameters> | null): Record<string, number> {
  const parameters = sanitizeRobotFxParameters(value);
  return {
    pitch_semitones: parameters.targetPitchSemitones,
    formant_semitones: parameters.formantShiftSemitones,
    mix_percent: parameters.mixPercent,
  };
}
