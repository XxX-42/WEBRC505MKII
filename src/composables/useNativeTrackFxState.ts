import { sameNativeControlSnapshot } from '../audio/nativeFxParameterSnapshots';
import { computed, nextTick, reactive, readonly, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { nativeCatalogEffectId, nativeCatalogMacroParameters, NATIVE_CATALOG_EMPTY_LABEL, NATIVE_CATALOG_FX_LABELS } from '../audio/nativeFxCatalog';
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
let memoryHydrating = false;
const memoryAdoptedSlots = new WeakSet<NativeTrackFxSlotState>();
export interface ConfirmedNativeFxUiSlot { id: FxSlotId; type: string; active: boolean; value: number; parameters: Record<string, number> }

/** Read-only, all-four-slot gate. No requested or placeholder controls enter hydration. */
export function readConfirmedNativeFxUiBank(path: 'input' | 'track', trackId = 0): ConfirmedNativeFxUiSlot[] {
  const engine = AudioEngine.getInstance();
  if (engine.getMode() !== 'native') throw new Error('Native FX hydration requires the Native runtime.');
  return slotIds.map((id, index) => {
    const slot = engine.getNativeCatalogFxSlotStatus(path, index, trackId);
    if (!slot || !slot.acknowledged || slot.pendingApply || slot.pendingRestart || slot.outcomeUnknown || slot.processingFaulted || slot.controlFaulted || slot.error
      || slot.requestedRevision !== slot.appliedRevision || slot.requestedEffectId !== slot.acknowledgedEffectId
      || slot.requestedBypassed !== slot.appliedBypassed) throw new Error(`Native ${path}/${trackId}/${id} lacks confirmed FX readback.`);
    const effect = slot.acknowledgedEffectId;
    const type = effect ? NATIVE_CATALOG_FX_LABELS[effect] : NATIVE_CATALOG_EMPTY_LABEL;
    const parameters = slot.acknowledgedParameters ?? (effect ? null : {});
    if (!type || !parameters || effect && slot.prepared !== true || Object.values(parameters).some((value) => !Number.isFinite(value))) throw new Error('Native FX readback contains unsupported authored parameters.');
    const value = effect === 'transpose' ? ((parameters.shift_semitones ?? 0) + 24) / 48 * 100
      : effect === 'pitch_bend' ? (parameters.range ?? 0) / 24 * 100
        : parameters.mix_percent ?? parameters.mix ?? (parameters.wet_mix !== undefined ? parameters.wet_mix * 100 : 0);
    return { id, type, active: !!effect && !slot.appliedBypassed, value: boundedAmount(value), parameters: { ...parameters } };
  });
}

export async function adoptCommittedNativeTrackFxState(banks = Array.from({ length: 5 }, (_, index) => readConfirmedNativeFxUiBank('track', index + 1))): Promise<void> {
  nativeSynced = true; memoryHydrating = true;
  try {
    ensureNativeTrackFxStateInitialized(); pendingNamedParameters.clear();
    for (const key of Object.keys(warnings)) delete warnings[key];
    banks.forEach((slots, index) => slots.forEach((saved, slotIndex) => {
      const slot = state.tracks[index]!.slots[slotIndex]!;
      Object.assign(slot, { id: saved.id, type: saved.type, value: saved.value, active: saved.active, namedParameters: { ...saved.parameters } });
      memoryAdoptedSlots.add(slot);
    }));
    statusRevision.value += 1; await nextTick(); persist(true);
  } finally { memoryHydrating = false; }
}
interface PendingNamedParameters {
  effectId: string;
  overrides: Record<string, number>;
  expectedRuntimeParameters: Record<string, number>;
  previousRevision: number | null;
  previousError: string;
}
const pendingNamedParameters = new Map<string, PendingNamedParameters>();

const validTrack = (trackId: number) => Number.isInteger(trackId) && trackId >= 1 && trackId <= 5;
const validSlot = (slotIndex: number) => Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 4;
const boundedAmount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const warningKey = (trackId: number, slotIndex: number) => `${trackId}:${slotIndex}`;
const runtimeKey = warningKey;

function sameParameters(left: Record<string, number> | null | undefined, right: Record<string, number>): boolean {
  if (!left) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && left[key] === right[key]);
}

function isDefiniteNamedParameterRejection(message: string): boolean {
  return /invalid native catalog fx parameter|unsupported discrete native catalog fx value|command queue is full|unable to queue a native catalog fx parameter|control application failed|processor faulted|different or missing per-track slot|host lacks safe official parameter replacement/i.test(message);
}

function reconcilePendingNamedParameters(engine: AudioEngine) {
  if (memoryHydrating) return;
  if (engine.getMode() !== 'native' || pendingNamedParameters.size === 0) return;
  let changed = false;
  for (const [key, pending] of pendingNamedParameters) {
    const [trackText, slotText] = key.split(':');
    const trackId = Number(trackText);
    const slotIndex = Number(slotText);
    if (!validTrack(trackId) || !validSlot(slotIndex)) {
      pendingNamedParameters.delete(key);
      continue;
    }
    const runtime = engine.getNativeCatalogFxSlotStatus('track', slotIndex, trackId);
    if (!runtime || runtime.pendingApply || runtime.outcomeUnknown) continue;
    const slot = state.tracks[trackId - 1]!.slots[slotIndex]!;
    if (runtime.acknowledged && runtime.acknowledgedEffectId === pending.effectId &&
        sameNativeControlSnapshot(runtime.acknowledgedParameters, pending.expectedRuntimeParameters, pending.effectId, pending.overrides)) {
      if (nativeCatalogEffectId(slot.type) === pending.effectId && !sameParameters(slot.namedParameters, pending.overrides)) {
        slot.namedParameters = { ...pending.overrides };
        changed = true;
      }
      pendingNamedParameters.delete(key);
      continue;
    }
    const revisionChanged = runtime.requestedRevision !== null && runtime.requestedRevision !== pending.previousRevision;
    const newError = runtime.error && runtime.error !== pending.previousError;
    if (!runtime.pendingApply && !runtime.acknowledged && !runtime.pendingRestart &&
        sameNativeControlSnapshot(runtime.requestedParameters, pending.expectedRuntimeParameters, pending.effectId, pending.overrides) &&
        isDefiniteNamedParameterRejection(runtime.error) && (revisionChanged || newError || !pending.previousError)) {
      // The request was rejected by the host/callback. Keep the last confirmed
      // override map in storage; the panel still exposes the runtime error.
      pendingNamedParameters.delete(key);
    }
  }
  if (changed) persist();
}

function persist(throwOnFailure = false) {
  try {
    localStorage.setItem(NATIVE_TRACK_FX_STORAGE_KEY, JSON.stringify({ version: 1, target: state.target, tracks: state.tracks }));
  } catch (error) {
    warnings.storage = 'Native per-track FX settings could not be saved in this browser.';
    if (throwOnFailure) throw error;
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
  if (memoryHydrating) return;
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
    engine.onStatusChange(() => {
      reconcilePendingNamedParameters(engine);
      statusRevision.value += 1;
    });
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
      pendingNamedParameters.delete(runtimeKey(trackId, slotIndex));
      slot.type = type;
      memoryAdoptedSlots.delete(slot);
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
      const key = runtimeKey(trackId, slotIndex);
      const pending = pendingNamedParameters.get(key);
      pendingNamedParameters.delete(key); // Avoid comparing a synchronous status with the old amount.
      slot.value = boundedAmount(value);
      engine.setTrackFxParameter(trackId, slotIndex, slot.value);
      if (pending) {
        pending.expectedRuntimeParameters = engine.getNativeCatalogFxParameterSnapshot?.('track', slotIndex, trackId, pending.overrides)
          ?? { ...nativeCatalogMacroParameters(slot.type, slot.value), ...pending.overrides };
        pendingNamedParameters.set(key, pending);
        reconcilePendingNamedParameters(engine);
      }
    });
  }

  function setNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
    if (!validTrack(trackId) || !validSlot(slotIndex) || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
    if (Object.entries(parameters).some(([key, value]) => !key || !Number.isFinite(value))) {
      warnings[warningKey(trackId, slotIndex)] = 'Named parameters must have non-empty keys and finite numeric values.';
      return false;
    }
    if (engine.getMode() !== 'native') return false;
    const slot = state.tracks[trackId - 1]!.slots[slotIndex]!;
    const effectId = nativeCatalogEffectId(slot.type);
    if (!effectId || slot.type === NATIVE_CATALOG_EMPTY_LABEL) return false;
    const schema = typeof engine.getNativeCatalogFxParameterSchema === 'function'
      ? engine.getNativeCatalogFxParameterSchema(slot.type, 'track', trackId, parameters, slotIndex)
      : null;
    if (schema) {
      const descriptors = new Map([...schema.parameters, ...schema.legacyAliases].map((descriptor) => [descriptor.id, descriptor]));
      for (const [key, value] of Object.entries(parameters)) {
        const descriptor = descriptors.get(key);
        if (!descriptor) {
          warnings[warningKey(trackId, slotIndex)] = `Native ${slot.type} has no parameter named ${key}.`;
          return false;
        }
        if (value < descriptor.minimum || value > descriptor.maximum ||
            (descriptor.discrete && !descriptor.discreteValues?.includes(value))) {
          warnings[warningKey(trackId, slotIndex)] = `${descriptor.label} must be ${descriptor.discrete
            ? `one of ${descriptor.discreteValues?.join(', ')}`
            : `within ${descriptor.minimum}–${descriptor.maximum}`}.`;
          return false;
        }
      }
    }
    const previous = engine.getNativeCatalogFxSlotStatus('track', slotIndex, trackId);
    if (!previous) {
      warnings[warningKey(trackId, slotIndex)] = 'Native per-track slot status is unavailable; parameters were not sent.';
      return false;
    }
    const expectedRuntimeParameters = engine.getNativeCatalogFxParameterSnapshot?.('track', slotIndex, trackId, parameters)
      ?? { ...nativeCatalogMacroParameters(slot.type, slot.value), ...parameters };
    pendingNamedParameters.set(runtimeKey(trackId, slotIndex), {
      effectId,
      overrides: memoryAdoptedSlots.has(slot) && Object.keys(parameters).length ? { ...slot.namedParameters, ...parameters } : { ...parameters },
      expectedRuntimeParameters,
      previousRevision: previous.requestedRevision,
      previousError: previous.error,
    });
    if (!engine.setTrackFxNamedParameters(trackId, slotIndex, { ...parameters })) {
      pendingNamedParameters.delete(runtimeKey(trackId, slotIndex));
      warnings[warningKey(trackId, slotIndex)] = 'Native rejected the named parameter request before sending it.';
      return false;
    }
    delete warnings[warningKey(trackId, slotIndex)];
    reconcilePendingNamedParameters(engine);
    statusRevision.value += 1;
    return true;
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
