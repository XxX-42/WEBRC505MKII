import type { NativeFxReadback } from './Rc505FxReadback';

export interface FxPlaySlot {
  slot: string;
  type: string;
  displayType: string;
  labelSource: 'official-example' | 'engineering';
  confirmed: boolean;
  active: 'ON' | 'OFF' | 'UNKNOWN';
  state: string;
  reason: string;
}

// Owner's Manual p8 supplies these example spellings. Other display labels are
// engineering choices, not a claimed reconstruction of the hardware's font/table.
const officialExamples: Record<string, string> = {
  LPF: 'LPF', G2B: 'G2B', 'PATTERN SLICER': 'PTN\nSL', DELAY: 'DLY',
  'BEAT SCATTER': 'BT\nSCT', FLANGER: 'FLN\nGER', TRANSPOSE: 'TR\nNS', 'GRANULAR DELAY': 'GRN\nDLY',
};
const engineeringLabels: Record<string, string> = { FILTER: 'FLT', REVERB: 'REV', SLICER: 'SLC' };

function engineeringLabel(type: string): string {
  if (engineeringLabels[type]) return engineeringLabels[type];
  const words = type.split(/\s+/);
  // Two short lines remain readable at the existing LCD size. The complete
  // identity stays in type/title/ARIA; these are explicitly engineering labels.
  return words.length > 1 ? words.slice(0, 2).map(word => word.slice(0, 3)).join('\n')
    : type.length > 5 ? `${type.slice(0, 3)}\n${type.slice(3, 6)}` : type;
}

function createSlot(slot: string, type: string, active: FxPlaySlot['active'], state: string, reason = ''): FxPlaySlot {
  const normalized = type.replace(/[_-]+/g, ' ').trim().toUpperCase();
  return {
    slot, type, displayType: active === 'UNKNOWN' ? '--' : officialExamples[normalized] ?? engineeringLabel(normalized),
    labelSource: officialExamples[normalized] ? 'official-example' : 'engineering',
    confirmed: active !== 'UNKNOWN', active, state, reason,
  };
}

export function unavailableFxPlaySlot(slot: string, state: string, reason: string): FxPlaySlot {
  return createSlot(slot, '--', 'UNKNOWN', state, reason);
}

export function nativeFxPlaySlot(slot: string, readback: NativeFxReadback): FxPlaySlot {
  return readback.disabled || readback.activeLabel === '—'
    ? unavailableFxPlaySlot(slot, readback.state, readback.reason)
    : createSlot(slot, readback.type, readback.activeLabel, readback.state);
}

export function browserFxPlaySlot(slot: string, runtime: {
  type: string | null; active: boolean; state: string; error: string | null;
} | null | undefined): FxPlaySlot {
  if (!runtime) return unavailableFxPlaySlot(slot, 'UNAVAILABLE', 'Browser FX runtime status is unavailable.');
  if (runtime.error || !['ready', 'empty'].includes(runtime.state)) {
    return unavailableFxPlaySlot(slot, runtime.error ? 'ERROR' : runtime.state.toUpperCase(),
      runtime.error || `Browser FX is ${runtime.state}; its applied state is not confirmed.`);
  }
  if (runtime.state === 'ready' && !runtime.type) {
    return unavailableFxPlaySlot(slot, 'UNKNOWN', 'The running Browser FX type is unavailable.');
  }
  return createSlot(slot, runtime.state === 'empty' ? 'EMPTY' : runtime.type!,
    runtime.state === 'empty' || !runtime.active ? 'OFF' : 'ON', runtime.state.toUpperCase());
}
