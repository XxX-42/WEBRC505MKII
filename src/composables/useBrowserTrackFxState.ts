import { computed, reactive, readonly, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { BROWSER_PER_TRACK_FX_TYPES } from '../audio/BrowserTrackFxChain';
import type { FxSlotId } from './usePanelFocus';
import { getBrowserTrackFxControls, getBrowserTrackFxMacroKeys, sanitizeBrowserTrackFxParameters } from './browserTrackFxParameters';

export const BROWSER_TRACK_FX_STORAGE_KEY = 'webrc505_browser_per_track_fx_v1';
export type BrowserTrackFxTarget = 'shared' | 1 | 2 | 3 | 4 | 5;
export interface BrowserTrackFxSlotState {
  id: FxSlotId;
  type: string;
  value: number;
  active: boolean;
  namedParameters: Record<string, number>;
}
interface TrackBank {
  trackId: number;
  activeSlot: FxSlotId;
  slots: BrowserTrackFxSlotState[];
}

const slotIds: readonly FxSlotId[] = ['A', 'B', 'C', 'D'];
const state = reactive({
  target: 'shared' as BrowserTrackFxTarget,
  tracks: Array.from({ length: 5 }, (_, index): TrackBank => ({
    trackId: index + 1,
    activeSlot: 'A',
    slots: slotIds.map((id) => ({ id, type: 'NONE', value: 0, active: false, namedParameters: {} })),
  })),
});
const warnings = reactive<Record<string, string>>({});
const statusRevision = ref(0);
let initialized = false;
let browserSynced = false;

const validTrack = (trackId: number) => Number.isInteger(trackId) && trackId >= 1 && trackId <= 5;
const validSlot = (slotIndex: number) => Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 4;
const validType = (type: string) => type === 'NONE' || BROWSER_PER_TRACK_FX_TYPES.includes(type);
const menuType = (type: string) => type === 'WARP' || type === 'REVERSE REVERB' ? `${type} (EXPERIMENTAL)` : type;
const warningKey = (trackId: number, slotIndex: number) => `${trackId}:${slotIndex}`;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const boundedAmount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

function persist() {
  try {
    localStorage.setItem(BROWSER_TRACK_FX_STORAGE_KEY, JSON.stringify({ version: 1, target: state.target, tracks: state.tracks }));
  } catch {
    warnings.storage = 'Per-track FX settings could not be saved in this browser.';
  }
}

function load() {
  try {
    const saved = localStorage.getItem(BROWSER_TRACK_FX_STORAGE_KEY);
    if (!saved) return;
    const source = asRecord(JSON.parse(saved));
    if (source.version !== 1) {
      warnings.storage = 'Saved per-track FX settings use an unsupported version; slots remain bypassed.';
      return;
    }
    if (source.target === 'shared' || (typeof source.target === 'number' && validTrack(source.target))) state.target = source.target as BrowserTrackFxTarget;
    if (!Array.isArray(source.tracks)) return;
    for (const bank of state.tracks) {
      const savedBank = asRecord(source.tracks[bank.trackId - 1]);
      if (savedBank.trackId !== bank.trackId) continue;
      if (slotIds.includes(savedBank.activeSlot as FxSlotId)) bank.activeSlot = savedBank.activeSlot as FxSlotId;
      const savedSlots = savedBank.slots;
      if (!Array.isArray(savedSlots)) continue;
      bank.slots.forEach((slot, index) => {
        const rawSlot = asRecord(savedSlots[index]);
        const type = typeof rawSlot.type === 'string' ? rawSlot.type : 'NONE';
        if (!validType(type)) {
          warnings[warningKey(bank.trackId, index)] = `Unsupported saved per-track FX: ${type}. Slot cleared and bypassed.`;
          return;
        }
        slot.type = menuType(type);
        slot.value = boundedAmount(rawSlot.value);
        slot.active = type !== 'NONE' && rawSlot.active === true;
        slot.namedParameters = sanitizeBrowserTrackFxParameters(type, rawSlot.namedParameters);
        // A capture command cannot restore audio that is absent after reload.
        if ('freezeEnabled' in slot.namedParameters) slot.namedParameters.freezeEnabled = 0;
        if ('warpFreezeEnabled' in slot.namedParameters) slot.namedParameters.warpFreezeEnabled = 0;
      });
    }
  } catch {
    warnings.storage = 'Saved per-track FX settings could not be read; invalid slots remain bypassed.';
  }
}

function syncSlot(trackId: number, slotIndex: number): boolean {
  const engine = AudioEngine.getInstance();
  if (engine.getMode() !== 'browser') return false;
  const slot = state.tracks[trackId - 1]!.slots[slotIndex]!;
  if (!engine.setTrackFxType(trackId, slotIndex, slot.type)) {
    slot.active = false;
    warnings[warningKey(trackId, slotIndex)] = 'Per-track FX could not be installed; the slot is bypassed. See its runtime status.';
    return false;
  }
  if (slot.type === 'NONE') return true;
  const parametersApplied = engine.setTrackFxParameter(trackId, slotIndex, slot.value)
    && (!Object.keys(slot.namedParameters).length || engine.setTrackFxNamedParameters(trackId, slotIndex, { ...slot.namedParameters }));
  if (!parametersApplied || !engine.setTrackFxActive(trackId, slotIndex, slot.active)) {
    slot.active = false;
    warnings[warningKey(trackId, slotIndex)] = 'Per-track settings were not applied; the slot is bypassed. See its runtime status.';
    return false;
  }
  return true;
}

export function ensureBrowserTrackFxStateInitialized() {
  const engine = AudioEngine.getInstance();
  if (!initialized) {
    initialized = true;
    load();
    engine.onStatusChange(() => {
      statusRevision.value += 1;
      if (engine.getMode() !== 'browser') return;
      let changed = false;
      for (const bank of state.tracks) {
        const runtime = engine.getTrackFxStatus(bank.trackId)[0];
        for (const status of runtime?.slots ?? []) {
          const slot = bank.slots[status.slotIndex];
          if (status.error && slot?.active) {
            slot.active = false;
            changed = true;
          }
        }
      }
      if (changed) persist();
    });
  }
  if (engine.getMode() === 'browser' && !browserSynced) {
    browserSynced = true;
    for (const bank of state.tracks) bank.slots.forEach((_, index) => syncSlot(bank.trackId, index));
  }
}

export function useBrowserTrackFxState() {
  ensureBrowserTrackFxStateInitialized();
  const currentBank = computed(() => typeof state.target === 'number' ? state.tracks[state.target - 1]! : null);
  const slots = computed(() => currentBank.value?.slots ?? []);
  const activeSlot = computed(() => currentBank.value?.activeSlot ?? 'A');
  const activeSlotIndex = computed(() => slotIds.indexOf(activeSlot.value));
  const activeFx = computed(() => slots.value[activeSlotIndex.value] ?? null);
  const controls = computed(() => getBrowserTrackFxControls(activeFx.value?.type ?? 'NONE'));
  const runtimeStatus = computed(() => {
    statusRevision.value;
    if (typeof state.target !== 'number' || AudioEngine.getInstance().getMode() !== 'browser') return null;
    return AudioEngine.getInstance().getTrackFxStatus(state.target)[0] ?? null;
  });
  const warning = computed(() => warnings.storage || (typeof state.target === 'number' ? warnings[warningKey(state.target, activeSlotIndex.value)] : '') || '');

  function selectTarget(target: BrowserTrackFxTarget): boolean {
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

  function updateSlot(trackId: number, slotIndex: number, update: (slot: BrowserTrackFxSlotState) => boolean | void): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex)) return false;
    if (AudioEngine.getInstance().getMode() !== 'browser') return false;
    const applied = update(state.tracks[trackId - 1]!.slots[slotIndex]!);
    persist();
    statusRevision.value += 1;
    return applied !== false;
  }

  function setType(trackId: number, slotIndex: number, type: string): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex)) return false;
    if (!validType(type)) {
      warnings[warningKey(trackId, slotIndex)] = `Unsupported Browser per-track FX: ${type}. No shared-bank fallback was applied.`;
      return false;
    }
    return updateSlot(trackId, slotIndex, (slot) => {
      const selectedType = menuType(type);
      if (slot.type === selectedType) return;
      slot.type = selectedType;
      slot.active = false;
      slot.value = 0;
      slot.namedParameters = {};
      delete warnings[warningKey(trackId, slotIndex)];
      return syncSlot(trackId, slotIndex);
    });
  }

  function setValue(trackId: number, slotIndex: number, value: number): boolean {
    if (!Number.isFinite(value)) return false;
    return updateSlot(trackId, slotIndex, (slot) => {
      slot.value = boundedAmount(value);
      // Clear only the controls changed by the macro. Unrelated named edits
      // (for example DELAY time/feedback) retain their independent values.
      for (const key of getBrowserTrackFxMacroKeys(slot.type)) delete slot.namedParameters[key];
      const applied = AudioEngine.getInstance().setTrackFxParameter(trackId, slotIndex, slot.value);
      if (!applied) {
        slot.active = false;
        warnings[warningKey(trackId, slotIndex)] = 'Amount was saved but not applied; the slot is bypassed. See its runtime status.';
      }
      return applied;
    });
  }

  function setNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex)) return false;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    const slot = state.tracks[trackId - 1]!.slots[slotIndex]!;
    const sanitized = sanitizeBrowserTrackFxParameters(slot.type, parameters);
    if (Object.keys(sanitized).length !== Object.keys(parameters).length) {
      warnings[warningKey(trackId, slotIndex)] = 'Unsupported or non-finite named parameter rejected.';
      return false;
    }
    return updateSlot(trackId, slotIndex, (current) => {
      current.namedParameters = { ...current.namedParameters, ...sanitized };
      delete warnings[warningKey(trackId, slotIndex)];
      const applied = AudioEngine.getInstance().setTrackFxNamedParameters(trackId, slotIndex, sanitized);
      if (!applied) {
        current.active = false;
        warnings[warningKey(trackId, slotIndex)] = 'Named settings were saved but not applied; the slot is bypassed. See its runtime status.';
      }
      return applied;
    });
  }

  function setActive(trackId: number, slotIndex: number, active: boolean): boolean {
    if (typeof active !== 'boolean') return false;
    return updateSlot(trackId, slotIndex, (slot) => {
      const requestedActive = slot.type !== 'NONE' && active;
      const applied = AudioEngine.getInstance().setTrackFxActive(trackId, slotIndex, requestedActive);
      slot.active = applied && requestedActive;
      if (!applied) warnings[warningKey(trackId, slotIndex)] = 'Activation was rejected; the slot remains bypassed. See its runtime status.';
      else delete warnings[warningKey(trackId, slotIndex)];
      return applied;
    });
  }

  return {
    state: readonly(state), target: computed(() => state.target),
    slots: computed(() => readonly(slots.value)), activeSlot, activeSlotIndex,
    activeFx: computed(() => activeFx.value ? readonly(activeFx.value) : null), controls,
    fxOptions: ['NONE', ...new Set(BROWSER_PER_TRACK_FX_TYPES.map(menuType))], runtimeStatus, warning,
    selectTarget, selectSlot, setType, setValue, setNamedParameters, setActive,
  };
}
