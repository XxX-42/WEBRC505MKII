import type { FxSlotState } from '../../composables/useFxPanelState';

export const FX_PRESET_BANK_IDS = ['A', 'B', 'C', 'D'] as const;
export type FxPresetBankId = typeof FX_PRESET_BANK_IDS[number];
export type FxPresetRuntime = 'browser' | 'native';
export type FxPresetLocation = 'input' | 'track';
export type FxPresetParameter = number | string | boolean;

export interface FxPresetBankProfile {
  slots: FxSlotState[];
  /** Captured Browser DSP state, present only after the runtime reported all slots ready. */
  browserParameters?: Array<Record<string, FxPresetParameter> | null>;
  /** Complete confirmed Native host controls; absent legacy profiles have no identity proof. */
  nativeParameters?: Array<Record<string, number> | null>;
}

export interface FxPresetBankDocument {
  version: 1;
  runtime: FxPresetRuntime;
  location: FxPresetLocation;
  activeBank: FxPresetBankId | null;
  banks: Record<FxPresetBankId, FxPresetBankProfile>;
}

export function fxPresetBankStorageKey(runtime: FxPresetRuntime, location: FxPresetLocation): string {
  return `webrc505_fx_preset_banks_v1_${runtime}_${location}`;
}

export function cloneFxPresetSlots(slots: readonly FxSlotState[]): FxSlotState[] {
  return JSON.parse(JSON.stringify(slots)) as FxSlotState[];
}

export function createEmptyFxPresetSlots(): FxSlotState[] {
  return FX_PRESET_BANK_IDS.map((id) => ({ id, type: '', value: 0, active: false }));
}

export function createFxPresetBankDocument(
  runtime: FxPresetRuntime,
  location: FxPresetLocation,
  legacySlots: readonly FxSlotState[],
): FxPresetBankDocument {
  if (!isFourSlotRows(legacySlots)) throw new Error('FX bank migration requires four valid A–D slots.');
  const banks = Object.fromEntries(FX_PRESET_BANK_IDS.map((id) => [id, {
    slots: id === 'A' ? cloneFxPresetSlots(legacySlots) : createEmptyFxPresetSlots(),
  }])) as Record<FxPresetBankId, FxPresetBankProfile>;
  return { version: 1, runtime, location, activeBank: 'A', banks };
}

export function parseFxPresetBankDocument(
  serialized: string,
  runtime: FxPresetRuntime,
  location: FxPresetLocation,
): FxPresetBankDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.runtime !== runtime || parsed.location !== location ||
      !(parsed.activeBank === null || isFxPresetBankId(parsed.activeBank)) || !isRecord(parsed.banks)) return null;

  const banks = {} as Record<FxPresetBankId, FxPresetBankProfile>;
  for (const id of FX_PRESET_BANK_IDS) {
    const rawProfile = parsed.banks[id];
    if (!isRecord(rawProfile) || !isFourSlotRows(rawProfile.slots)) return null;
    const profile: FxPresetBankProfile = { slots: cloneFxPresetSlots(rawProfile.slots) };
    if (rawProfile.browserParameters !== undefined) {
      if (!Array.isArray(rawProfile.browserParameters) || rawProfile.browserParameters.length !== 4 ||
          !rawProfile.browserParameters.every(isBrowserParameterRecordOrNull)) return null;
      profile.browserParameters = rawProfile.browserParameters.map((parameters) =>
        parameters === null ? null : { ...parameters });
    }
    if (rawProfile.nativeParameters !== undefined) {
      if (!Array.isArray(rawProfile.nativeParameters) || rawProfile.nativeParameters.length !== 4 || !rawProfile.nativeParameters.every((parameters) =>
        parameters === null || isRecord(parameters) && Object.values(parameters).every((value) => typeof value === 'number' && Number.isFinite(value)))) return null;
      profile.nativeParameters = rawProfile.nativeParameters.map((parameters) => parameters === null ? null : { ...parameters });
    }
    banks[id] = profile;
  }
  return {
    version: 1,
    runtime,
    location,
    activeBank: parsed.activeBank,
    banks,
  };
}

export function serializeFxPresetBankDocument(document: FxPresetBankDocument): string {
  return JSON.stringify(document);
}

export function isFxPresetBankId(value: unknown): value is FxPresetBankId {
  return typeof value === 'string' && (FX_PRESET_BANK_IDS as readonly string[]).includes(value);
}

function isFourSlotRows(value: unknown): value is FxSlotState[] {
  return Array.isArray(value) && value.length === 4 && value.every((slot, index) =>
    isRecord(slot) && slot.id === FX_PRESET_BANK_IDS[index] && typeof slot.type === 'string' &&
    typeof slot.value === 'number' && Number.isFinite(slot.value) && typeof slot.active === 'boolean' &&
    isJsonSafe(slot));
}

function isBrowserParameterRecordOrNull(value: unknown): value is Record<string, FxPresetParameter> | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, parameter]) => key.length > 0 &&
    (typeof parameter === 'string' || typeof parameter === 'boolean' ||
      (typeof parameter === 'number' && Number.isFinite(parameter))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonSafe(item, depth + 1));
  if (!isRecord(value)) return false;
  // JSON serialization omits undefined object properties. FxSlotState uses
  // optional fields that may be explicitly cleared to undefined in memory, so
  // accept those fields here; undefined array elements remain invalid above.
  return Object.entries(value).every(([key, item]) => key.length > 0 &&
    (item === undefined || isJsonSafe(item, depth + 1)));
}
