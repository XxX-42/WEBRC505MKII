import { encodeOfficialValue, findOfficialEffect } from '../official/parameters';
/** Dedicated pitch adapters expose these functional clean-room controls. This is
 * interface compatibility, not Roland algorithm/transfer-curve equivalence.
 * MODE 1/2 select undocumented proprietary algorithms and are deliberately not
 * admitted. AUTO RIFF's P1–P30 phrase contents are likewise undocumented.
 */
const keys = (...names: string[]): readonly string[] => Object.freeze(names.map(name => `official_${name}`));
export const BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  transpose: keys('trans'),
  'pitch-bend': keys('pitch', 'bend'),
  robot: keys('note', 'formant'),
  'hrm-manual': keys('voice', 'formant', 'pan', 'key', 'd_level', 'hrm_level'),
  'hrm-auto': keys('voice', 'formant', 'pan', 'hrm_mode', 'key', 'd_level', 'hrm_level'),
  octave: keys('octave', 'oct_level'),
  'auto-riff': keys('tempo', 'hold', 'attack', 'loop', 'key', 'balance'),
});
export const BROWSER_OFFICIAL_PITCH_UNSUPPORTED: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  transpose: { official_mode: 'Roland MODE 1/2 algorithms are proprietary; the Browser implementation uses Signalsmith.' },
  'pitch-bend': { official_mode: 'Roland MODE 1/2 algorithms are proprietary; the Browser implementation uses Signalsmith.' },
  robot: { official_mode: 'Roland MODE 1/2 algorithms are proprietary; the Browser implementation uses YIN/PSOLA/Signalsmith.' },
  octave: { official_mode: 'Roland MODE 1/2 algorithms are proprietary; the Browser implementation uses Signalsmith.' },
  'auto-riff': { official_phrase: 'Roland P1–P30 note/rhythm contents are undocumented; the existing clean-room riff is not any official preset.' },
});
/** Authored monotonic spectral-envelope shift, not a measured Roland FORMANT law. */
export function officialFormantSemitones(value: number): number { return value * 12 / 50; }
export function isOfficialInteger(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Initialize only published, encodable defaults for implemented controls.
 * Unsupported MODE/PHRASE and unknown defaults are never synthesized. */
export function officialPitchDefaults(effectName: string, algorithm: string): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  const supported = BROWSER_OFFICIAL_PITCH_PARAMETER_KEYS[algorithm] ?? [];
  for (const parameter of findOfficialEffect(effectName)?.parameters ?? []) {
    const key = `official_${parameter.key}`;
    if (!supported.includes(key) || parameter.default === null) continue;
    const value = encodeOfficialValue(parameter, parameter.default);
    if (value !== null) result[key] = value;
  }
  return result;
}
