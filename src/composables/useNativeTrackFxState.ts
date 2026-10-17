import { computed, reactive, readonly, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { NATIVE_CATALOG_EMPTY_LABEL } from '../audio/nativeFxCatalog';
import type { FxSlotId } from './usePanelFocus';

export const NATIVE_TRACK_FX_STORAGE_KEY = 'webrc505_native_per_track_fx_v1';
export type NativeTrackFxTarget = 'shared' | 1 | 2 | 3 | 4 | 5;

export interface NativeTrackFxSlotState {
  id: FxSlotId;
  type: string;
  value: number;
  active: boolean;
  namedParameters: Record<string, number>;
}

interface NativeTrackBank {
  trackId: number;
  activeSlot: FxSlotId;
  slots: NativeTrackFxSlotState[];
}

const slotIds: readonly FxSlotId[] = ['A', 'B', 'C', 'D'];
const state = reactive({
  target: 'shared' as NativeTrackFxTarget,
  tracks: Array.from({ length: 5 }, (_, index): NativeTrackBank => ({
    trackId: index + 1,
    activeSlot: 'A',
    slots: slotIds.map((id) => ({ id, type: NATIVE_CATALOG_EMPTY_LABEL, value: 0, active: false, namedParameters: {} })),
  })),
});
const warnings = reactive<Record<string, string>>({});
const statusRevision = ref(0);
let initialized = false;
let nativeSynced = false;

const validTrack = (trackId: number) => Number.isInteger(trackId) && trackId >= 1 && trackId <= 5;
const validSlot = (slotIndex: number) => Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 4;
const boundedAmount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const warningKey = (trackId: number, slotIndex: number) => `${trackId}:${slotIndex}`;

function persist() {
  try {
    localStorage.setItem(NATIVE_TRACK_FX_STORAGE_KEY, JSON.stringify({ version: 1, target: state.target, tracks: state.tracks }));
  } catch {
    warnings.storage = 'Native per-track FX settings could not be saved in this browser.';
  }
}

function load() {
  try {
    const saved = localStorage.getItem(NATIVE_TRACK_FX_STORAGE_KEY);
    if (!saved) return;
    const source = asRecord(JSON.parse(saved));
    if (source.version !== 1) {
      warnings.storage = 'Saved Native per-track FX settings use an unsupported version; slots remain bypassed.';
      return;
    }
    if (source.target === 'shared' || (typeof source.target === 'number' && validTrack(source.target))) {
      state.target = source.target as NativeTrackFxTarget;
    }
    if (!Array.isArray(source.tracks)) return;
    for (const bank of state.tracks) {
      const savedBank = asRecord(source.tracks[bank.trackId - 1]);
      if (savedBank.trackId !== bank.trackId) continue;
      if (slotIds.includes(savedBank.activeSlot as FxSlotId)) bank.activeSlot = savedBank.activeSlot as FxSlotId;
      if (!Array.isArray(savedBank.slots)) continue;
      for (let index = 0; index < Math.min(4, savedBank.slots.length); index += 1) {
        const raw = asRecord(savedBank.slots[index]);
        const type = typeof raw.type === 'string' ? raw.type : NATIVE_CATALOG_EMPTY_LABEL;
        // Vinyl transport is a separate experimental source-reader stage, never an A–D insert.
        if (type === 'VINYL FLICK' || type === 'VINYL FLICK (EXPERIMENTAL)' || type === 'BEAT SHIFT') {
          warnings[warningKey(bank.trackId, index)] = `${type} is not a per-track A–D insert. It remains bypassed; use the separate experimental loop-transport route.`;
          continue;
        }
        const parameters = asRecord(raw.namedParameters);
        const validParameters: Record<string, number> = {};
        for (const [key, value] of Object.entries(parameters)) {
          if (key && typeof value === 'number' && Number.isFinite(value)) validParameters[key] = value;
        }
        const slot = bank.slots[index]!;
        slot.type = type;
        slot.value = boundedAmount(raw.value);
        slot.active = type !== NATIVE_CATALOG_EMPTY_LABEL && raw.active === true;
        slot.namedParameters = validParameters;
      }
    }
  } catch {
    warnings.storage = 'Saved Native per-track FX settings could not be read; invalid slots remain bypassed.';
  }
}

function syncSlot(trackId: number, slotIndex: number) {
  const engine = AudioEngine.getInstance();
  if (engine.getMode() !== 'native') return;
  const slot = state.tracks[trackId - 1]!.slots[slotIndex]!;
  if (!engine.setTrackFxType(trackId, slotIndex, slot.type)) {
    warnings[warningKey(trackId, slotIndex)] = `Native per-track FX rejected ${slot.type || 'the selected effect'}; check the runtime status.`;
    return;
  }
  if (slot.type === NATIVE_CATALOG_EMPTY_LABEL) return;
  delete warnings[warningKey(trackId, slotIndex)];
  engine.setTrackFxParameter(trackId, slotIndex, slot.value);
  if (Object.keys(slot.namedParameters).length) engine.setTrackFxNamedParameters(trackId, slotIndex, { ...slot.namedParameters });
  engine.setTrackFxActive(trackId, slotIndex, slot.active);
}

export function ensureNativeTrackFxStateInitialized() {
  const engine = AudioEngine.getInstance();
  if (!initialized) {
    initialized = true;
    load();
    engine.onStatusChange(() => { statusRevision.value += 1; });
  }
  if (engine.getMode() === 'native' && !nativeSynced) {
    nativeSynced = true;
    for (const bank of state.tracks) bank.slots.forEach((_, index) => syncSlot(bank.trackId, index));
  }
}

export function useNativeTrackFxState() {
  ensureNativeTrackFxStateInitialized();
  const currentBank = computed(() => typeof state.target === 'number' ? state.tracks[state.target - 1]! : null);
  const slots = computed(() => currentBank.value?.slots ?? []);
  const activeSlot = computed(() => currentBank.value?.activeSlot ?? 'A');
  const activeSlotIndex = computed(() => slotIds.indexOf(activeSlot.value));
  const activeFx = computed(() => slots.value[activeSlotIndex.value] ?? null);
  const engine = AudioEngine.getInstance();
  const runtimeStatus = computed(() => {
    statusRevision.value;
    if (typeof state.target !== 'number' || engine.getMode() !== 'native') return null;
    return engine.getTrackFxStatus(state.target)[0] ?? null;
  });
  const slotRuntime = computed(() => {
    statusRevision.value;
    if (typeof state.target !== 'number' || engine.getMode() !== 'native') return null;
    return engine.getNativeCatalogFxSlotStatus('track', activeSlotIndex.value, state.target);
  });
  const fxOptions = computed(() => {
    statusRevision.value;
    if (typeof state.target !== 'number' || engine.getMode() !== 'native') return [NATIVE_CATALOG_EMPTY_LABEL];
    return [NATIVE_CATALOG_EMPTY_LABEL, ...engine.getNativeCatalogFxOptions('track', state.target)
      .filter((type) => type !== 'VINYL FLICK' && type !== 'VINYL FLICK (EXPERIMENTAL)' && type !== 'BEAT SHIFT')];
  });
  const warning = computed(() => warnings.storage || (typeof state.target === 'number' ? warnings[warningKey(state.target, activeSlotIndex.value)] : '') || '');

  function selectTarget(target: NativeTrackFxTarget): boolean {
    if (target !== 'shared' && !validTrack(target)) return false;
    state.target = target;
    persist();
    return true;
  }

  function selectSlot(slot: FxSlotId): boolean {
    if (!currentBank.value || !slotIds.includes(slot)) return false;
    currentBank.value.activeSlot = slot;
    persist();
    return true;
  }

  function updateSlot(trackId: number, slotIndex: number, update: (slot: NativeTrackFxSlotState) => void): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex) || engine.getMode() !== 'native') return false;
    update(state.tracks[trackId - 1]!.slots[slotIndex]!);
    persist();
    statusRevision.value += 1;
    return true;
  }

  function setType(trackId: number, slotIndex: number, type: string): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex)) return false;
    if (type === 'VINYL FLICK' || type === 'VINYL FLICK (EXPERIMENTAL)' || type === 'BEAT SHIFT') {
      warnings[warningKey(trackId, slotIndex)] = `${type} is a separate experimental loop-transport stage, not an A–D insert.`;
      return false;
    }
    const trackOptions = [NATIVE_CATALOG_EMPTY_LABEL, ...engine.getNativeCatalogFxOptions('track', trackId)
      .filter((option) => option !== 'VINYL FLICK' && option !== 'VINYL FLICK (EXPERIMENTAL)' && option !== 'BEAT SHIFT')];
    if (type !== NATIVE_CATALOG_EMPTY_LABEL && !trackOptions.includes(type)) {
      warnings[warningKey(trackId, slotIndex)] = `Native per-track FX is unavailable or does not support ${type}.`;
      return false;
    }
    return updateSlot(trackId, slotIndex, (slot) => {
      if (slot.type === type) return;
      slot.type = type;
      slot.value = type === 'TRANSPOSE' || type === 'PITCH BEND' ? 50 : 0;
      slot.active = false;
      slot.namedParameters = {};
      delete warnings[warningKey(trackId, slotIndex)];
      syncSlot(trackId, slotIndex);
    });
  }

  function setValue(trackId: number, slotIndex: number, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    return updateSlot(trackId, slotIndex, (slot) => {
      slot.value = boundedAmount(value);
      engine.setTrackFxParameter(trackId, slotIndex, slot.value);
    });
  }

  function setNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex) || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    if (Object.entries(parameters).some(([key, value]) => !key || !Number.isFinite(value))) {
      warnings[warningKey(trackId, slotIndex)] = 'Named parameters must have non-empty keys and finite numeric values.';
      return false;
    }
    return updateSlot(trackId, slotIndex, (slot) => {
      slot.namedParameters = { ...parameters };
      delete warnings[warningKey(trackId, slotIndex)];
      // The Native API stores the complete override map, so send the complete state, not a patch.
      engine.setTrackFxNamedParameters(trackId, slotIndex, { ...slot.namedParameters });
    });
  }

  function setActive(trackId: number, slotIndex: number, active: boolean): boolean {
    if (typeof active !== 'boolean') return false;
    return updateSlot(trackId, slotIndex, (slot) => {
      slot.active = slot.type !== NATIVE_CATALOG_EMPTY_LABEL && active;
      engine.setTrackFxActive(trackId, slotIndex, slot.active);
    });
  }

  return {
    state: readonly(state), target: computed(() => state.target), slots: computed(() => readonly(slots.value)),
    activeSlot, activeSlotIndex, activeFx: computed(() => activeFx.value ? readonly(activeFx.value) : null),
    fxOptions, runtimeStatus, slotRuntime, warning, selectTarget, selectSlot, setType, setValue, setNamedParameters, setActive,
  };
}
