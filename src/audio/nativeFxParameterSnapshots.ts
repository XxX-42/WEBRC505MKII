/** Compare the authored controls, not transport-derived values added by the host adapter. */
export function sameNativeControlSnapshot(
  actual: Record<string, number> | null | undefined,
  expected: Record<string, number>,
  effectId: string,
  overrides: Record<string, number>,
): boolean {
  if (!actual) return false;
  const authored = (key: string) => key !== 'official_bpm' && key !== 'official_quarter_notes_per_measure' &&
    !(effectId === 'step_slicer' && key === 'bpm' && !Object.prototype.hasOwnProperty.call(overrides, 'bpm'));
  const actualKeys = Object.keys(actual).filter(authored).sort();
  const expectedKeys = Object.keys(expected).filter(authored).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) =>
    key === expectedKeys[index] && actual[key] === expected[key]);
}
