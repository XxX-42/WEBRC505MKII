import guide from './parameter-guide.json';

/** A versioned, additive interface. Legacy project parameter units never change. */
export const OFFICIAL_FX_SCHEMA_VERSION = 1;
export const OFFICIAL_FX_SOURCE = guide.source.pdf_url;
export type OfficialValue = string | number;
export interface OfficialParameter {
  name: string; key: string; values_raw: string; default: OfficialValue | null;
  default_evidence?: string; unit?: string; condition?: string; notes?: string;
  sequence_target?: boolean; tempo_range?: { from: string; to: string }; knob?: boolean;
}
export interface OfficialEffect {
  name: string; scope: string; page: number; availability_notes?: string; sequence_supported?: boolean;
  parameters: readonly OfficialParameter[];
}
export const OFFICIAL_FX_EFFECTS = guide.effects as readonly OfficialEffect[];
export interface OfficialOption { label: string; value: OfficialValue; runtime: number }
export interface OfficialDomain {
  range?: { min: number; max: number; step: number };
  options: OfficialOption[];
  complete: boolean;
  unit: string;
}
const option = (label: string, runtime: number, value: OfficialValue = label): OfficialOption => ({ label, value, runtime });
/** Only documented endpoints and named choices are admitted; no hidden tempo list invented. */
export function officialParameterDomain(parameter: OfficialParameter): OfficialDomain {
  const raw = parameter.values_raw;
  const domain: OfficialDomain = { options: [], complete: true, unit: parameter.unit ?? (/(dB|ms|Hz|cm|OCT)\s*$/.exec(raw)?.[1] ?? '') };
  if (raw.includes('MEAS')) {
    domain.range = { min: 0, max: 100, step: 1 };
    domain.options = [option('4MEAS', -16), option('2MEAS', -8), option('1MEAS', -4), option('1/2 note', -2, 'half_note'), option('1/4 note', -1, 'quarter_note'), option('1/32 note', -0.125, 'thirty_second_note')];
    if (raw.startsWith('OFF')) domain.options.unshift(option('OFF', -1000));
    domain.complete = false; // guide prints note endpoints, not a full discrete list
    return domain;
  }
  if (parameter.tempo_range) {
    const noteValues: Record<string, OfficialOption> = {
      'whole note': option('1/1 note', -4, 'whole_note'),
      '1/2 note': option('1/2 note', -2, 'half_note'),
      '1/16 note': option('1/16 note', -0.25, 'sixteenth_note'),
      '1/32 note': option('1/32 note', -0.125, 'thirty_second_note'),
    };
    domain.options = [...new Map([noteValues[parameter.tempo_range.from], option('1/4 note', -1, 'quarter_note'), noteValues[parameter.tempo_range.to]].filter((v): v is OfficialOption => !!v).map(v => [v.runtime, v])).values()];
    if (raw.startsWith('THRU')) domain.options.unshift(option('THRU', -1000));
    const numberPart = raw.split(',')[0]!.replace(/\s/g, '');
    const bounds = numberPart.match(/[+-]?\d+(?:\.\d+)?/g)?.map(Number);
    if (bounds && bounds.length >= 2) domain.range = { min: bounds[0]!, max: bounds[bounds.length-1]!, step: 1 };
    domain.complete = false;
    return domain;
  }
  if (raw.includes('FLAT') && raw.includes('12.5 kHz')) return { ...domain, unit: 'Hz', range: { min: 20, max: 12500, step: 0.1 }, options: [option('FLAT', -1000)] };
  const numberedPattern = /^P(0?1)–(\d+)$/.exec(raw);
  if (numberedPattern) return { ...domain, options: Array.from({ length: Number(numberedPattern[2]) }, (_, i) => option(`P${String(i+1).padStart(numberedPattern[1]!.length, '0')}`, i)) };
  const annotatedRange = /^([+-]?\d+(?:\.\d+)?)(?:–[+-]?\d+(?:\. ?\d+)?)+\s*(?:dB|ms|s)?(?:, INF)?$/.exec(raw);
  if (annotatedRange) {
    const bounds = raw.replace(/\. /g,'.').match(/[+-]?\d+(?:\.\d+)?/g)!.map(Number);
    return { ...domain, range: { min: bounds[0]!, max: bounds[bounds.length-1]!, step: bounds.some(v => !Number.isInteger(v)) ? 0.1 : 1 }, options: raw.endsWith('INF') ? [option('INF', -1000)] : [] };
  }
  if (raw === 'C–B' || raw === 'C (Am)–B (G#m)' || raw === 'CHROMATIC, C (Am)–B (G#m)') {
    const chromatic = raw.startsWith('CHROMATIC');
    const choices = Array.from({ length: 12 }, (_, index) => option(index === 0 ? (raw.includes('(Am)') ? 'C (Am)' : 'C') : index === 11 ? (raw.includes('(G#m)') ? 'B (G#m)' : 'B') : `Pitch class ${index} (C=0)`, index + (chromatic ? 1 : 0), index));
    if (chromatic) choices.unshift(option('CHROMATIC', 0));
    // Interior pitch-class spelling is a software display convention, not a
    // claim about undocumented manufacturer enharmonic labels.
    if (raw.includes('(Am)')) choices[chromatic ? 1 : 0]!.value = 'C (Am)';
    if (raw === 'C–B') choices[0]!.value = 'C';
    return { ...domain, options: choices, complete: false };
  }
  if (raw === 'C1–G9') {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    // Software note convention: C4 = MIDI 60; not a measured device ID map.
    return { ...domain, unit: 'MIDI note', options: Array.from({ length: 104 }, (_, i) => {
      const midi = i + 24;
      const label = `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
      return option(label, midi);
    }) };
  }
  if (/^(?:[+-]?\d+OCT|0)(?:, (?:[+-]?\d+OCT|0))+$/.test(raw)) {
    // Enum order is stable, including numeric-looking zero between OCT labels.
    return { ...domain, unit: 'octave', options: raw.split(', ').map((label, index) => option(label, index, label === '0' ? 0 : label)) };
  }
  if (raw === 'L50–CENTER–R50') return { ...domain, range: { min: -50, max: 50, step: 1 }, options: [option('CENTER', 0)] };
  if (raw === '20.0 Hz–10.0 kHz') return { ...domain, unit: 'Hz', range: { min: 20, max: 10000, step: 0.1 } };
  if (raw === 'OFF, 31–1') return { ...domain, options: [option('OFF', -1000), ...Array.from({ length: 31 }, (_, i) => option(String(31-i), 31-i, 31-i))] };
  if (raw === 'OFF, 1/2–1/32') return { ...domain, options: [option('OFF', -1000), ...Array.from({ length: 31 }, (_, i) => option(`1/${i+2}`, i+2))] };
  if (raw === 'P1–P30') return { ...domain, options: Array.from({ length: 30 }, (_, i) => option(`P${i+1}`, i)) };
  if (raw === 'CENTER, 1–10 cm') return { ...domain, unit: 'cm', options: [option('CENTER', 0), ...Array.from({ length: 10 }, (_, i) => option(String(i+1), i+1, i+1))] };
  const numeric = /^([+-]?\d+(?:\.\d+)?)–([+-]?\d+(?:\.\d+)?)(?: (dB|ms|Hz)|OCT)?$/.exec(raw);
  if (numeric) return { ...domain, unit: numeric[3] ?? domain.unit, range: { min: Number(numeric[1]), max: Number(numeric[2]), step: 1 } };
  if (raw.includes('–')) return { ...domain, complete: false }; // unresolved note spelling or scaled range
  if (raw.includes(',')) {
    domain.options = raw.split(',').map((entry, index) => {
      const label = entry.trim();
      if (label === 'BI-PHASE') return option(label, -1);
      if (/^[+-]?\d+(?:\.\d+)?$/.test(label)) return option(label, Number(label), Number(label));
      return option(label, index);
    });
    return domain;
  }
  return { ...domain, complete: false };
}
export function findOfficialEffect(name: string): OfficialEffect | undefined {
  const normalized = name.replace(/^DSP /, '').replace(/ \((?:EXPERIMENTAL|CLEAN-ROOM|FDN16)\)$/, '').replace(/^FDN8 REVERB$/, 'REVERB');
  return OFFICIAL_FX_EFFECTS.find(effect => effect.name === normalized);
}
/** Strict validation: rejected controls must not silently reach DSP as unrelated values. */
export function encodeOfficialValue(parameter: OfficialParameter, value: OfficialValue): number | null {
  const domain = officialParameterDomain(parameter);
  const selected = domain.options.find(candidate => candidate.value === value);
  if (selected) return selected.runtime;
  if (typeof value === 'string' && parameter.values_raw.endsWith('OCT') && /^[+-]?\d+OCT$/.test(value)) value = Number(value.slice(0, -3));
  if (typeof value !== 'number' || !Number.isFinite(value) || !domain.range) return null;
  const { min, max, step } = domain.range;
  if (value < min || value > max || Math.abs((value-min)/step-Math.round((value-min)/step)) > 1e-7) return null;
  return value;
}
export interface OfficialParameterState { schemaVersion: 1; effect: string; values: Record<string, OfficialValue> }
export function parseOfficialParameterState(raw: unknown): OfficialParameterState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<OfficialParameterState>;
  const effect = typeof candidate.effect === 'string' ? findOfficialEffect(candidate.effect) : undefined;
  if (candidate.schemaVersion !== 1 || !effect || !candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) return null;
  const values: Record<string, OfficialValue> = {};
  for (const [key, value] of Object.entries(candidate.values)) {
    const parameter = effect.parameters.find(entry => entry.key === key);
    if (!parameter || (typeof value !== 'string' && typeof value !== 'number') || encodeOfficialValue(parameter, value) === null) return null;
    values[key] = value;
  }
  return { schemaVersion: 1, effect: effect.name, values };
}
export function officialParameterApplicable(effect: string, key: string, values: Readonly<Record<string, OfficialValue>>): boolean {
  if (effect === 'VOCODER' && key === 'carrier_thru') return ['MIC1','MIC2','INST1-L','INST1-R','INST2-L','INST2-R'].includes(String(values.carrier));
  return !findOfficialEffect(effect)?.parameters.find(parameter => parameter.key === key)?.condition;
}

export function isOfficialRuntimeValueValid(parameter: OfficialParameter, value: number): boolean {
  const domain = officialParameterDomain(parameter);
  if (!Number.isFinite(value)) return false;
  return domain.options.some(option => option.runtime === value) || encodeOfficialValue({ ...parameter, values_raw: parameter.values_raw }, value) !== null;
}

/** Variant is adapter routing state, not an extra manual parameter. */
export function resolveOfficialEffect(name: string, parameters: Readonly<Record<string, number>> = {}): OfficialEffect | undefined {
  const canonical = name.replace(' (EXPERIMENTAL)', '');
  if (canonical === 'TAPE ECHO' || canonical === 'ROLL') {
    const variant = parameters.official_variant;
    return variant === 1 || variant === 2 ? findOfficialEffect(`${canonical}${variant}`) : undefined;
  }
  return findOfficialEffect(name);
}
export function mergeOfficialParameterEdit(current: Readonly<Record<string, number>>, key: string, value: number): Record<string, number> {
  const next = key === 'official_variant' && value !== current.official_variant
    ? Object.fromEntries(Object.entries(current).filter(([name]) => !name.startsWith('official_')))
    : { ...current };
  return { ...next, [key]: value };
}

/** Indexed STEP LEVEL addresses retain the documented STEP LEVEL domain. */
export function findOfficialRuntimeParameter(effect: OfficialEffect | undefined, runtimeKey: string): OfficialParameter | undefined {
  let key = runtimeKey.replace(/^official_/, '');
  if (effect?.name === 'STEP SLICER' && /^step_level_(?:[1-9]|1[0-6])$/.test(key)) key = 'step_level';
  return effect?.parameters.find(parameter => parameter.key === key);
}

/** The implemented shared and private banks use MULTI mode. Legacy extensions are unaffected. */
export function isOfficialFxSlotAllowed(type: string, path: 'input' | 'track', slotIndex: number): boolean {
  const effect = resolveOfficialEffect(type);
  return !effect?.availability_notes?.includes('only in FX A') || (path === 'track' && slotIndex === 0);
}
