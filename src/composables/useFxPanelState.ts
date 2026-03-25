import { computed, effectScope, reactive, watch } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { type FxLocation, type FxSlotId, usePanelFocus } from './usePanelFocus';

export interface FxSlotState {
  id: FxSlotId;
  type: string;
  value: number;
  active: boolean;
}

const STORAGE_KEY = 'webrc505_top_panel';
const fxOptions = ['FILTER', 'DELAY', 'REVERB', 'SLICER', 'PHASER'];
const engine = AudioEngine.getInstance();
const focus = usePanelFocus();

const defaultInputSlots: FxSlotState[] = [
  { id: 'A', type: 'FILTER', value: 0, active: false },
  { id: 'B', type: 'DELAY', value: 0, active: false },
  { id: 'C', type: 'REVERB', value: 0, active: false },
  { id: 'D', type: 'SLICER', value: 0, active: false },
];

const defaultTrackSlots: FxSlotState[] = [
  { id: 'A', type: 'FILTER', value: 0, active: false },
  { id: 'B', type: 'DELAY', value: 0, active: false },
  { id: 'C', type: 'REVERB', value: 0, active: false },
  { id: 'D', type: 'SLICER', value: 0, active: false },
];

const state = reactive({
  inputSlots: structuredClone(defaultInputSlots) as FxSlotState[],
  trackSlots: structuredClone(defaultTrackSlots) as FxSlotState[],
});

let initialized = false;

function sanitizeValue(rawValue: number) {
  if (typeof rawValue !== 'number' || Number.isNaN(rawValue) || !Number.isFinite(rawValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, rawValue));
}

function syncSlotToEngine(location: FxLocation, index: number, slot: FxSlotState) {
  engine.setFxType(location, index, slot.type);
  engine.setFxParam(location, index, sanitizeValue(slot.value));
  engine.setFxActive(location, index, slot.active);
}

function persistSlots() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    inputSlots: state.inputSlots,
    trackSlots: state.trackSlots,
  }));
}

function loadSlots() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    return;
  }

  try {
    const parsed = JSON.parse(saved) as Partial<typeof state>;
    if (Array.isArray(parsed.inputSlots)) {
      state.inputSlots = parsed.inputSlots as FxSlotState[];
    }
    if (Array.isArray(parsed.trackSlots)) {
      state.trackSlots = parsed.trackSlots as FxSlotState[];
    }
  } catch (error) {
    console.error('Failed to load FX panel settings', error);
  }
}

function ensureInitialized() {
  if (initialized) {
    return;
  }

  initialized = true;
  loadSlots();
  state.inputSlots.forEach((slot, index) => syncSlotToEngine('input', index, slot));
  state.trackSlots.forEach((slot, index) => syncSlotToEngine('track', index, slot));

  const scope = effectScope(true);
  scope.run(() => {
    watch(() => state.inputSlots, (newSlots, oldSlots) => {
      newSlots.forEach((slot, index) => {
        const previous = oldSlots?.[index];
        if (
          previous &&
          previous.type === slot.type &&
          previous.value === slot.value &&
          previous.active === slot.active
        ) {
          return;
        }
        syncSlotToEngine('input', index, slot);
      });
      persistSlots();
    }, { deep: true });

    watch(() => state.trackSlots, (newSlots, oldSlots) => {
      newSlots.forEach((slot, index) => {
        const previous = oldSlots?.[index];
        if (
          previous &&
          previous.type === slot.type &&
          previous.value === slot.value &&
          previous.active === slot.active
        ) {
          return;
        }
        syncSlotToEngine('track', index, slot);
      });
      persistSlots();
    }, { deep: true });
  });
}

export function useFxPanelState(location: FxLocation) {
  ensureInitialized();

  const capabilities = computed(() => engine.getCapabilities());
  const fxDisabled = computed(() => !capabilities.value.supportsInputFx);
  const fxUnavailableReason = computed(() => capabilities.value.fxReason);
  const slots = computed(() => location === 'input' ? state.inputSlots : state.trackSlots);
  const activeSlot = computed(() => location === 'input'
    ? focus.state.activeInputFxSlot
    : focus.state.activeTrackFxSlot);

  const selectSlot = (slotId: FxSlotId) => {
    focus.setActiveFxSlot(location, slotId);
  };

  return {
    slots,
    fxOptions,
    fxDisabled,
    fxUnavailableReason,
    activeSlot,
    selectSlot,
  };
}
