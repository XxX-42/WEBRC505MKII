import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { NativeCatalogFxSlotRuntime } from '../audio/NativeAudioEngine';
import type { TrackFxSlotStatus } from '../audio/AudioEngine';
import type { FxSlotId } from './usePanelFocus';
import { useBrowserTrackFxState, type BrowserTrackFxTarget } from './useBrowserTrackFxState';
import { useFxPanelState, type FxSlotState } from './useFxPanelState';
import { useNativeTrackFxState, type NativeTrackFxTarget } from './useNativeTrackFxState';

export type TrackFxTarget = BrowserTrackFxTarget | NativeTrackFxTarget;

export interface TrackFxTargetRuntimeStatus {
  readonly pendingRestart?: boolean;
  readonly pendingApply?: boolean;
  readonly error?: string | null;
  readonly processingFaulted?: boolean;
  readonly controlFaulted?: boolean;
  readonly acknowledged?: boolean;
}

const slotIds: readonly FxSlotId[] = ['A', 'B', 'C', 'D'];
const engine = AudioEngine.getInstance();

/**
 * Unifies the physical Track FX controls around the active editor target.
 * The shared bank keeps its existing post-mix state; independent Browser and
 * Native targets use their acknowledged per-track chains.
 */
export function useTrackFxTargetState() {
  const shared = useFxPanelState('track');
  const browser = useBrowserTrackFxState();
  const native = useNativeTrackFxState();
  const statusRevision = ref(0);
  const unsubscribe = engine.onStatusChange(() => { statusRevision.value += 1; });
  if (getCurrentScope()) onScopeDispose(unsubscribe);

  const mode = computed(() => {
    statusRevision.value;
    return engine.getMode();
  });
  const nativeMode = computed(() => mode.value === 'native');
  const target = computed<TrackFxTarget>(() => {
    statusRevision.value;
    return nativeMode.value ? native.target.value : browser.target.value;
  });
  const isSharedTarget = computed(() => target.value === 'shared');
  const slots = computed(() => {
    if (isSharedTarget.value) return shared.slots.value;
    return nativeMode.value ? native.slots.value : browser.slots.value;
  });
  const activeSlot = computed(() => {
    if (isSharedTarget.value) return shared.activeSlot.value;
    return nativeMode.value ? native.activeSlot.value : browser.activeSlot.value;
  });
  const activeSlotIndex = computed(() => slotIds.indexOf(activeSlot.value));
  const activeFx = computed(() => slots.value[activeSlotIndex.value] ?? slots.value[0] ?? null);
  const activeFxIsEmpty = computed(() => !activeFx.value?.type || activeFx.value.type === 'NONE');
  const fxOptions = computed(() => {
    if (isSharedTarget.value) return shared.fxOptions.value;
    return nativeMode.value ? native.fxOptions.value : browser.fxOptions;
  });
  const targetAvailable = computed(() => {
    statusRevision.value;
    if (isSharedTarget.value) return true;
    return typeof target.value === 'number' && engine.isTrackAvailable(target.value);
  });
  const fxDisabled = computed(() => {
    if (isSharedTarget.value) return shared.fxDisabled.value;
    if (!targetAvailable.value || !engine.getCapabilities().supportsTrackFx) return true;
    return nativeMode.value ? native.fxOptions.value.length <= 1 : browser.fxOptions.length <= 1;
  });
  const fxUnavailableReason = computed(() => {
    if (isSharedTarget.value) return shared.fxUnavailableReason.value;
    if (typeof target.value !== 'number') return 'Select an available independent Track FX target.';
    if (!targetAvailable.value) {
      return engine.getTrackCapabilities(target.value).availabilityReason || `TRACK ${target.value} IS NOT AVAILABLE.`;
    }
    const capabilities = engine.getCapabilities();
    if (!capabilities.supportsTrackFx) {
      return capabilities.fxReason || `TRACK ${target.value} FX IS UNAVAILABLE ON THIS AUDIO RUNTIME.`;
    }
    if (fxOptions.value.length <= 1) return `TRACK ${target.value} HAS NO AVAILABLE INDEPENDENT FX OPTIONS.`;
    return '';
  });
  const runtimeStatus = computed<TrackFxTargetRuntimeStatus | null>(() => {
    statusRevision.value;
    if (isSharedTarget.value) return shared.runtimeStatus.value as TrackFxTargetRuntimeStatus | null;
    if (nativeMode.value) return native.slotRuntime.value as NativeCatalogFxSlotRuntime | null;
    const status = browser.runtimeStatus.value;
    const slot = status?.slots.find((item) => item.slotIndex === activeSlotIndex.value);
    return (slot as TrackFxSlotStatus | undefined) ?? null;
  });
  const warning = computed(() => {
    if (isSharedTarget.value) return '';
    return nativeMode.value ? native.warning.value : browser.warning.value;
  });

  function selectTarget(value: 'shared' | number): boolean {
    if (value !== 'shared' && (!Number.isInteger(value) || value < 1 || value > 5)) return false;
    const selected = value as TrackFxTarget;
    if (nativeMode.value) return native.selectTarget(selected as NativeTrackFxTarget);
    return browser.selectTarget(selected as BrowserTrackFxTarget);
  }

  function selectSlot(slot: FxSlotId): boolean {
    if (isSharedTarget.value) {
      shared.selectSlot(slot);
      return true;
    }
    return nativeMode.value ? native.selectSlot(slot) : browser.selectSlot(slot);
  }

  function selectedSlotIndex(slot: FxSlotId): number {
    return slotIds.indexOf(slot);
  }

  function setValue(value: number): boolean {
    if (!Number.isFinite(value) || fxDisabled.value || activeFxIsEmpty.value) return false;
    const bounded = Math.max(0, Math.min(100, value));
    if (isSharedTarget.value) {
      const slot = activeFx.value as FxSlotState | null;
      if (!slot) return false;
      slot.value = bounded;
      return true;
    }
    const trackId = target.value as number;
    return nativeMode.value
      ? native.setValue(trackId, activeSlotIndex.value, bounded)
      : browser.setValue(trackId, activeSlotIndex.value, bounded);
  }

  function setType(type: string): boolean {
    if (!type || fxDisabled.value || !fxOptions.value.includes(type)) return false;
    if (isSharedTarget.value) {
      const slot = activeFx.value as FxSlotState | null;
      if (!slot) return false;
      slot.type = type;
      return true;
    }
    const trackId = target.value as number;
    return nativeMode.value
      ? native.setType(trackId, activeSlotIndex.value, type)
      : browser.setType(trackId, activeSlotIndex.value, type);
  }

  function setActive(active: boolean): boolean {
    if (typeof active !== 'boolean' || fxDisabled.value || activeFxIsEmpty.value) return false;
    if (isSharedTarget.value) {
      const slot = activeFx.value as FxSlotState | null;
      if (!slot) return false;
      slot.active = active;
      return true;
    }
    const trackId = target.value as number;
    return nativeMode.value
      ? native.setActive(trackId, activeSlotIndex.value, active)
      : browser.setActive(trackId, activeSlotIndex.value, active);
  }

  function setSlotActive(slot: FxSlotId, active: boolean): boolean {
    const index = selectedSlotIndex(slot);
    if (index < 0 || typeof active !== 'boolean' || fxDisabled.value) return false;
    if (isSharedTarget.value) {
      const selected = shared.slots.value[index];
      if (!selected || !selected.type || selected.type === 'NONE') return false;
      selected.active = active;
      return true;
    }
    const selected = slots.value[index];
    if (!selected || !selected.type || selected.type === 'NONE') return false;
    const trackId = target.value as number;
    return nativeMode.value
      ? native.setActive(trackId, index, active)
      : browser.setActive(trackId, index, active);
  }

  return {
    mode, nativeMode, target, isSharedTarget, slots, activeSlot, activeSlotIndex, activeFx, activeFxIsEmpty,
    fxOptions, fxDisabled, fxUnavailableReason, runtimeStatus, warning,
    selectTarget, selectSlot, setValue, setType, setActive, setSlotActive,
  };
}
