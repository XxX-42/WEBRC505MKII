/** Common numeric descriptor fields exposed by both Native and WASM catalogs. */
export interface FxControlParameter {
  id: number;
  minimum: number;
  maximum: number;
  defaultValue: number;
  unit: string;
}

/** For new enabled units only; loading a saved unit must retain its own values. */
export function createEnabledFxParameters(
  descriptors: readonly FxControlParameter[],
): Record<string, number> {
  const values = Object.fromEntries(descriptors.map(parameter =>
    [String(parameter.id), parameter.defaultValue]));
  // The processor factory starts bypassed for safe standalone setup. Selecting
  // an enabled effect in the application must also activate that processor.
  if (descriptors.some(parameter => parameter.id === 48)) values['48'] = 1;
  return values;
}

const PREPARE_SELECTOR_IDS = new Set([82, 83, 84, 85, 86, 107, 125]);
const DISCRETE_UNITS = new Set([
  'boolean', 'choice', 'integer', 'count', 'voices', 'midi-note', 'midi note', 'index', 'selector',
]);

/** Select a control that can safely consume a continuous 0–100 UI/MIDI value. */
export function selectContinuousFxParameter<T extends FxControlParameter>(
  descriptors: readonly T[],
): T | undefined {
  const continuous = descriptors.filter(parameter =>
    parameter.id !== 48 && !PREPARE_SELECTOR_IDS.has(parameter.id) &&
    !DISCRETE_UNITS.has(parameter.unit.toLowerCase()) &&
    Number.isFinite(parameter.minimum) && Number.isFinite(parameter.maximum) &&
    parameter.maximum > parameter.minimum);
  // Pitch's main control is the musical interval; Mix remains independently
  // editable rather than displacing it just because it precedes it in metadata.
  return continuous.find(parameter => parameter.id === 93) ?? continuous[0];
}
