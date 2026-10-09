import { computed, reactive, ref, shallowRef } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { FxStateSnapshot } from '../audio/BrowserAudioEngine';
import type { ProjectFxBank, ProjectFxUnit } from '../project/projectTypes';
import { sharedDspFxOrdinal, sharedDspFxType } from '../audio/sharedDspGraph';
import { type FxLocation, type FxSlotId, usePanelFocus } from './usePanelFocus';

export interface FxSlotState {
  id: FxSlotId;
  index: number;
  type: string;
  value: number;
  parameterLabel: string;
  active: boolean;
  unit: ProjectFxUnit | null;
}

const SLOT_IDS: readonly FxSlotId[] = ['A', 'B', 'C', 'D'];
const engine = AudioEngine.getInstance();
const focus = usePanelFocus();
const fxState = shallowRef<FxStateSnapshot | null>(null);
const engineReady = ref(engine.getUiStatus().ready);
const operationBusy = ref(false);
const operationError = ref('');
const pendingEdits = reactive(new Map<string, ProjectFxUnit | null>());
const queuedWrites = new Map<string, Promise<void>>();
let mutationTail: Promise<void> = Promise.resolve();
let initialized = false;
let unsubscribeFx: (() => void) | null = null;

function activeBankFrom(snapshot: FxStateSnapshot | null): ProjectFxBank | null {
  return snapshot?.banks.find((bank) => bank.id === snapshot.activeBankId) ?? null;
}

function canAccessFx(): boolean {
  return engine.getMode() === 'browser' && engineReady.value;
}

function refreshState(): void {
  if (!canAccessFx()) {
    unsubscribeFx?.();
    unsubscribeFx = null;
    fxState.value = null;
    return;
  }
  try {
    if (!unsubscribeFx) {
      unsubscribeFx = engine.subscribeFxState((next) => {
        fxState.value = next;
        syncTrackSends(next);
      });
    } else {
      fxState.value = engine.getFxState();
      syncTrackSends(fxState.value);
    }
    operationError.value = '';
  } catch (error) {
    fxState.value = null;
    operationError.value = error instanceof Error ? error.message : String(error);
  }
}

function syncTrackSends(snapshot: FxStateSnapshot | null): void {
  if (!snapshot) return;
  engine.tracks.forEach((track, index) => {
    const trackWithModel = track as typeof track & { track?: { fxSw?: string } };
    if (trackWithModel.track?.fxSw) focus.setTrackFxApplied(index + 1, trackWithModel.track.fxSw === 'ON', false);
  });
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  refreshState();
  engine.onStatusChange((status) => {
    engineReady.value = status.ready;
    refreshState();
  });
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

function primaryParameter(unit: ProjectFxUnit | null): { key: string; label: string; value: number } {
  if (!unit) return { key: '', label: 'PARAM', value: 0 };
  const sharedOrdinal = sharedDspFxOrdinal(unit.type);
  if (sharedOrdinal !== null) {
    const parameter = engine.getSharedDspFxCatalog().find((entry) => entry.ordinal === sharedOrdinal)?.parameters[0];
    if (!parameter) return { key: '', label: 'SAFE PARAM', value: 0 };
    const span = parameter.maximum - parameter.minimum;
    const raw = unit.params[String(parameter.id)] ?? parameter.defaultValue;
    return {
      key: String(parameter.id),
      label: `${parameter.name.toUpperCase()} SAFE`,
      value: span > 0 ? clamp((raw - parameter.minimum) / span) * 100 : 0,
    };
  }
  switch (unit.type.toUpperCase()) {
    case 'FILTER': return { key: 'frequency', label: 'FREQUENCY', value: clamp(unit.params.frequency ?? 0.5) * 100 };
    case 'DELAY':
    case 'REVERB': return { key: 'mix', label: 'MIX', value: clamp(unit.params.mix ?? 0) * 100 };
    case 'SLICER':
    case 'PHASER': return { key: 'depth', label: 'DEPTH', value: clamp(unit.params.depth ?? 0.5) * 100 };
    case 'COMPRESSOR': {
      const amount = unit.params.amount ?? clamp(-(unit.params.thresholdDb ?? -24) / 60);
      return { key: 'amount', label: 'AMOUNT', value: clamp(amount) * 100 };
    }
    default: return { key: '', label: 'PARAM', value: 0 };
  }
}

function createFxUnit(type: string): ProjectFxUnit {
  const key = type.trim().toUpperCase();
  const sharedOrdinal = sharedDspFxOrdinal(key);
  if (sharedOrdinal !== null) {
    const descriptor = engine.getSharedDspFxCatalog().find((entry) => entry.ordinal === sharedOrdinal);
    if (!descriptor) throw new TypeError(`Shared DSP FX type ${type} is not available.`);
    return {
      type: sharedDspFxType(sharedOrdinal),
      enabled: true,
      params: Object.fromEntries(descriptor.parameters.map((parameter) => [String(parameter.id), parameter.defaultValue])),
    };
  }
  switch (key) {
    case 'FILTER': return { type: key, enabled: true, params: { frequency: 0.5, resonance: 0.05 } };
    case 'DELAY': return { type: key, enabled: true, params: { time: 0.3, feedback: 0.3, mix: 0.5 } };
    case 'REVERB': return { type: key, enabled: true, params: { decay: 0.475, mix: 0.5, seed: 0x505 } };
    case 'SLICER': return { type: key, enabled: true, params: { rate: 3 / 19, depth: 1 } };
    case 'PHASER': return { type: key, enabled: true, params: { rate: 0.4 / 4.9, depth: 0.5, resonance: 0.1 } };
    case 'COMPRESSOR': return { type: key, enabled: true, params: { amount: 0.4, thresholdDb: -24, ratio: 8.6, kneeDb: 30, attackSeconds: 0.003, releaseSeconds: 0.25 } };
    default: throw new TypeError(`FX type ${type} is not registered.`);
  }
}

function copyAndChangeValue(unit: ProjectFxUnit, value: number): ProjectFxUnit {
  const next = structuredClone(unit);
  const normalized = clamp(value / 100);
  const sharedOrdinal = sharedDspFxOrdinal(next.type);
  if (sharedOrdinal !== null) {
    const parameter = engine.getSharedDspFxCatalog().find((entry) => entry.ordinal === sharedOrdinal)?.parameters[0];
    if (!parameter) throw new TypeError(`Shared DSP FX type ${unit.type} is not available.`);
    next.params[String(parameter.id)] = parameter.minimum + (parameter.maximum - parameter.minimum) * normalized;
    return next;
  }
  switch (next.type.toUpperCase()) {
    case 'FILTER': next.params.frequency = normalized; break;
    case 'DELAY':
    case 'REVERB': next.params.mix = normalized; break;
    case 'SLICER':
    case 'PHASER': next.params.depth = normalized; break;
    case 'COMPRESSOR':
      next.params.amount = normalized;
      next.params.thresholdDb = -60 * normalized;
      next.params.ratio = 1 + 19 * normalized;
      break;
    default: throw new TypeError(`FX type ${unit.type} has no primary control.`);
  }
  return next;
}

function slotIndex(slotId: FxSlotId): number {
  return SLOT_IDS.indexOf(slotId);
}

function currentSlotUnit(location: FxLocation, index: number): ProjectFxUnit | null {
  const snapshot = fxState.value;
  const key = `${snapshot?.activeBankId ?? ''}:${location}:${index}`;
  if (pendingEdits.has(key)) return pendingEdits.get(key) ?? null;
  return activeBankFrom(snapshot)?.[location][index] ?? null;
}

async function writeSlot(location: FxLocation, index: number, next: ProjectFxUnit | null): Promise<void> {
  const bankId = fxState.value?.activeBankId;
  if (!bankId) {
    operationError.value = 'FX bank state is not available until browser audio is ready.';
    return;
  }
  const key = `${bankId}:${location}:${index}`;
  pendingEdits.set(key, next);
  operationBusy.value = true;
  operationError.value = '';
  const write = mutationTail.catch(() => undefined).then(async () => {
    if (engine.getActiveFxBankId() !== bankId) throw new Error('FX bank changed before the queued slot update was applied.');
    await engine.updateFxBankSlot(location, index, next);
  });
  mutationTail = write;
  queuedWrites.set(key, write);
  try {
    await write;
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : String(error);
    try { fxState.value = engine.getFxState(); } catch { /* the current bank may no longer be available */ }
  } finally {
    if (queuedWrites.get(key) === write) {
      queuedWrites.delete(key);
      pendingEdits.delete(key);
    }
    operationBusy.value = queuedWrites.size > 0;
  }
}

async function selectBank(id: string): Promise<void> {
  if (operationBusy.value || id === fxState.value?.activeBankId) return;
  operationBusy.value = true;
  operationError.value = '';
  const previousMutation = mutationTail;
  const selection = previousMutation.catch(() => undefined).then(async () => {
    await engine.selectFxBank(id);
  });
  mutationTail = selection;
  try {
    await selection;
    fxState.value = engine.getFxState();
    syncTrackSends(fxState.value);
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : String(error);
  } finally {
    operationBusy.value = false;
  }
}

ensureInitialized();

export function useFxPanelState(location: FxLocation) {
  const capabilities = computed(() => engine.getCapabilities());
  const fxDisabled = computed(() => !canAccessFx() || (location === 'input'
    ? !capabilities.value.supportsInputFx
    : !capabilities.value.supportsTrackFx));
  const fxUnavailableReason = computed(() => fxDisabled.value
    ? capabilities.value.fxReason || 'FX bank controls require initialized browser audio.'
    : '');
  const banks = computed(() => fxState.value?.banks ?? []);
  const activeBankId = computed(() => fxState.value?.activeBankId ?? '');
  const fxOptions = computed(() => {
    if (!canAccessFx()) return [];
    try { return engine.getAvailableFxTypes(); } catch { return []; }
  });
  const slots = computed<FxSlotState[]>(() => {
    const snapshot = fxState.value;
    const bank = activeBankFrom(snapshot);
    const current = bank?.[location] ?? [];
    return SLOT_IDS.map((id, index) => {
      const unit = currentSlotUnit(location, index);
      const parameter = primaryParameter(unit);
      return {
        id,
        index,
        type: unit?.type ?? '',
        value: parameter.value,
        parameterLabel: parameter.label,
        active: unit?.enabled ?? false,
        unit,
      };
    }).slice(0, Math.max(SLOT_IDS.length, current.length));
  });
  const activeSlot = computed(() => location === 'input'
    ? focus.state.activeInputFxSlot
    : focus.state.activeTrackFxSlot);

  const selectSlot = (slotId: FxSlotId) => focus.setActiveFxSlot(location, slotId);
  const updateType = (slotId: FxSlotId, type: string) => {
    if (fxDisabled.value) return Promise.resolve();
    try {
      if (!fxOptions.value.includes(type)) throw new TypeError(`FX type ${type} is not available.`);
      return writeSlot(location, slotIndex(slotId), createFxUnit(type));
    } catch (error) {
      operationError.value = error instanceof Error ? error.message : String(error);
      return Promise.resolve();
    }
  };
  const updateValue = (slotId: FxSlotId, value: number) => {
    if (fxDisabled.value) return Promise.resolve();
    const index = slotIndex(slotId);
    const current = currentSlotUnit(location, index);
    try {
      const unit = current ?? createFxUnit(fxOptions.value.includes('FILTER') ? 'FILTER' : fxOptions.value[0] ?? 'FILTER');
      return writeSlot(location, index, copyAndChangeValue(unit, value));
    } catch (error) {
      operationError.value = error instanceof Error ? error.message : String(error);
      return Promise.resolve();
    }
  };
  const toggleActive = (slotId: FxSlotId, active?: boolean) => {
    if (fxDisabled.value) return Promise.resolve();
    const index = slotIndex(slotId);
    const unit = currentSlotUnit(location, index);
    if (!unit) {
      operationError.value = 'Choose an FX type before activating an empty slot.';
      return Promise.resolve();
    }
    return writeSlot(location, index, { ...unit, enabled: active ?? !unit.enabled });
  };

  return {
    slots,
    banks,
    activeBankId,
    fxOptions,
    fxDisabled,
    fxUnavailableReason,
    activeSlot,
    busy: computed(() => operationBusy.value),
    error: computed(() => operationError.value),
    selectSlot,
    selectBank,
    updateType,
    updateValue,
    toggleActive,
  };
}
