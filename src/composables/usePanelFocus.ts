import { computed, reactive, readonly } from 'vue';

export type FxLocation = 'input' | 'track';
export type FxSlotId = 'A' | 'B' | 'C' | 'D';
export type FxBankId = 'MAIN';
export type PanelFocusContext =
  | 'status'
  | 'input-fx'
  | 'track-fx'
  | 'center-main'
  | 'track-bay'
  | 'tool-layer';

interface PanelFocusState {
  currentTrackId: number;
  activeInputFxBank: FxBankId;
  activeInputFxSlot: FxSlotId;
  activeTrackFxBank: FxBankId;
  activeTrackFxSlot: FxSlotId;
  trackFxApplyMap: Record<number, boolean>;
  panelFocusContext: PanelFocusContext;
}

const panelFocusState = reactive<PanelFocusState>({
  currentTrackId: 1,
  activeInputFxBank: 'MAIN',
  activeInputFxSlot: 'A',
  activeTrackFxBank: 'MAIN',
  activeTrackFxSlot: 'A',
  trackFxApplyMap: {
    1: false,
    2: false,
    3: false,
    4: false,
    5: false,
  },
  panelFocusContext: 'center-main',
});

export function usePanelFocus() {
  const setCurrentTrack = (trackId: number) => {
    panelFocusState.currentTrackId = trackId;
    panelFocusState.panelFocusContext = 'track-bay';
  };

  const setActiveFxSlot = (location: FxLocation, slot: FxSlotId) => {
    if (location === 'input') {
      panelFocusState.activeInputFxSlot = slot;
      panelFocusState.activeInputFxBank = 'MAIN';
      panelFocusState.panelFocusContext = 'input-fx';
      return;
    }

    panelFocusState.activeTrackFxSlot = slot;
    panelFocusState.activeTrackFxBank = 'MAIN';
    panelFocusState.panelFocusContext = 'track-fx';
  };

  const setTrackFxApplied = (trackId: number, active: boolean) => {
    panelFocusState.trackFxApplyMap[trackId] = active;
    panelFocusState.panelFocusContext = 'track-bay';
  };

  const toggleTrackFxApplied = (trackId: number) => {
    setTrackFxApplied(trackId, !panelFocusState.trackFxApplyMap[trackId]);
  };

  const activeInputKey = computed(() => `${panelFocusState.activeInputFxBank}:${panelFocusState.activeInputFxSlot}`);
  const activeTrackKey = computed(() => `${panelFocusState.activeTrackFxBank}:${panelFocusState.activeTrackFxSlot}`);

  return {
    state: readonly(panelFocusState),
    activeInputKey,
    activeTrackKey,
    setCurrentTrack,
    setActiveFxSlot,
    setTrackFxApplied,
    toggleTrackFxApplied,
  };
}
