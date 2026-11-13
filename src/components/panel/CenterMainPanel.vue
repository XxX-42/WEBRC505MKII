<template>
  <section class="center-main-panel" data-panel="center-main" aria-label="RC-505mkII center controls">
    <div class="transport-bank">
      <div class="center-control-stack">
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="white"
          label="MENU"
          :selected="menuRootSelected"
          :led-on="false"
          aria-label="Open menu"
          data-panel-control="menu"
          data-hardware-control="button"
          @press="openClassicRoot('menu')"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="white"
          label="LOOP"
          :selected="loopRootSelected"
          :led-on="false"
          aria-label="Open loop settings"
          data-testid="physical-loop-button"
          data-panel-control="loop"
          data-hardware-control="button"
          @press="openClassicRoot('loop')"
        />
      </div>
      <div class="center-control-stack transport-buttons">
        <HardwareButton
          shape="rect"
          size="md"
          appearance="classic"
          :color="isPlaying ? 'red' : 'green'"
          :active="isPlaying"
          :led-on="false"
          :label="'ALL START/' + '\n' + 'STOP'"
          :aria-label="isPlaying ? 'Stop all tracks' : 'Start all tracks'"
          data-panel-control="all-transport"
          :disabled="!audioReady || memory.state.busy"
          :disabled-reason="transportDisabledReason"
          data-hardware-control="button"
          @press="toggleAllTransport"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="neutral"
          :label="historyButtonLabel"
          :aria-label="historyButtonAriaLabel"
          :selected="undoLayerActive"
          :led-on="false"
          :disabled="historyButtonDisabled"
          :disabled-reason="historyButtonDisabledReason"
          data-panel-control="undo-redo"
          data-hardware-control="button"
          @press="toggleUndoLayer"
        />
      </div>
    </div>

    <div class="display-cluster">
      <div class="screen-shell" aria-label="RC-505 status display">
        <div class="lcd-display" :class="{ 'lcd-editor-active': isClassicEditor, 'lcd-parameter-active': isClassicEditor, 'lcd-root-active': classicRoot !== null, 'lcd-mixer-active': classicView.kind === 'mixer', 'lcd-fx-play-active': isFxPlayScreen }" :data-classic-screen="classicScreenId" data-testid="rc505-lcd-screen" @keydown.esc.stop.prevent="exitPage">
          <div v-if="lcdDetail" ref="lcdDetailElement" class="lcd-detail" tabindex="-1" data-testid="lcd-details-view"><strong>{{ lcdDetail.label }}</strong><span>{{ lcdDetail.text }}</span><small>EXIT · BACK</small></div>
          <div v-if="!lcdDetail && isFxPlayScreen" class="fx-play-display" :data-classic-fx-display="fxPlayLocation" :aria-label="`${pageTitle} status`">
            <div class="fx-play-tempo" data-fx-tempo>{{ fxPlayTempo }}</div>
            <div class="fx-play-memory"><span data-fx-memory-number>{{ fxPlayMemoryNumber }}</span> <span data-fx-memory-name :title="memory.state.name">{{ memory.state.name || '--' }}</span></div>
            <div class="fx-play-heading">{{ pageTitle }}</div>
            <div class="fx-play-slots" aria-label="FX A through D">
              <div v-for="slot in fxPlaySlots" :key="slot.slot" class="fx-play-slot" :class="{ 'is-on': slot.confirmed && slot.active === 'ON', 'is-unconfirmed': !slot.confirmed }"
                :data-fx-slot="slot.slot" :data-confirmed="slot.confirmed" :data-active="slot.active" :data-state="slot.state"
                :aria-label="`${slot.slot}: ${slot.type}, ${slot.active === 'UNKNOWN' ? slot.state : slot.active}${slot.reason ? `. ${slot.reason}` : ''}`"
                :title="`${slot.slot}: ${slot.type} · ${slot.state}${slot.reason ? ` · ${slot.reason}` : ''}${slot.labelSource === 'engineering' && slot.confirmed ? ' · Engineering display label' : ''}`">
                <span class="fx-play-type">{{ slot.displayType }}</span>
              </div>
            </div>
            <div v-if="fxPlayError" class="fx-play-error" role="status" aria-live="polite" :title="fxPlayError">{{ conciseStatus(fxPlayError) }}</div>
            <div v-else class="fx-play-knob-labels"><span v-for="(control, index) in screenControls" :key="control.key" :data-fx-knob-label="index + 1">{{ control.disabled ? '' : control.label }}</span></div>
          </div>
          <div v-if="!lcdDetail && !isFxPlayScreen" class="lcd-row top">
            <span>{{ lcdContextLabel }}</span>{{ ' ' }}
            <span>{{ pageLabel }} {{ pageCounter }}</span>
          </div>
          <div v-if="!lcdDetail && !isClassicEditor && !isFxPlayScreen && classicRoot === null && classicView.kind !== 'mixer'" class="lcd-name">{{ pageTitle }}</div>
          <div v-if="!lcdDetail && !isClassicEditor && !isFxPlayScreen" class="lcd-data-rows" :class="{ 'lcd-category-columns': classicRoot !== null, 'lcd-mixer-columns': classicView.kind === 'mixer' }"
            :data-classic-root="classicRoot ?? undefined" :data-classic-mixer="classicView.kind === 'mixer' ? RC505_MIXER_PAGES[classicView.pageIndex]?.id : undefined" :aria-label="`${pageTitle} display data`">
            <div v-for="(row, index) in lcdDataRows" :key="row.key" class="lcd-data-row" :class="{ 'is-disabled': row.disabled, 'is-selected': row.selected }" :title="row.reason"
              :data-root-item="classicRoot ? row.key : undefined" :data-root-encoder="classicRoot ? index + 1 : undefined"
              :data-mixer-channel="classicView.kind === 'mixer' ? row.label : undefined" :data-mixer-encoder="classicView.kind === 'mixer' ? index + 1 : undefined"
              :aria-label="`${row.label}${row.reason ? `. ${row.reason}` : ''}`">
              <template v-if="classicView.kind === 'mixer'">
                <span class="lcd-mixer-gain" :title="row.value">{{ row.gain === undefined ? '--' : Math.round(row.gain) }}</span>
                <div class="lcd-mixer-strip" aria-hidden="true">
                  <div class="lcd-mixer-fader"><span v-if="row.gain !== undefined" :style="{ bottom: `${Math.max(0, Math.min(100, row.gain / 2))}%` }"></span><span v-else class="lcd-mixer-unknown">--</span></div>
                  <div class="lcd-mixer-meter" :data-meter-available="row.meter !== undefined"><span v-if="row.meter !== undefined" :style="{ height: `${row.meter * 100}%` }"></span><b v-else>--</b></div>
                </div>
                <span class="lcd-mixer-label">{{ row.label }}</span>
              </template>
              <template v-else><span>{{ row.label }}</span><span v-if="classicRoot === null">{{ row.value }}</span></template>
            </div>
          </div>
          <LcdFieldGrid v-if="isClassicEditor" v-show="!lcdDetail" layout="parameter-dials" :fields="screenFields" :selected-index="screenEditor.selectedFieldIndex.value"
            @select="screenEditor.selectField" @update="setScreenField" @activate="activateScreenField" @details="openLcdDetails" />
          <div v-if="!lcdDetail && !isFxPlayScreen" class="lcd-status" role="status" aria-live="polite" :title="statusDetail">{{ statusHint }}</div>
          <div id="rc505-lcd-confirmations" class="lcd-confirmations"></div>
        </div>
      </div>

      <div class="soft-control-row" aria-label="Screen controls">
        <div v-for="(control, index) in screenControls" :key="control.key" class="soft-field" :title="control.reason">
          <HardwareKnob
            :model-value="control.value"
            interaction-mode="relative"
            pushable
            :interaction-context-key="`${classicScreenId}:${'pageIndex' in classicView ? classicView.pageIndex : 0}:${control.key}:${currentTrackId}:${focusState.activeInputFxSlot}:${focusState.activeTrackFxSlot}:${uiStatus.mode}:${engine.getMixerControlIdentity()}`"
            appearance="classic"
            :label="control.label"
            :color="control.color"
            :size="55"
            :min="control.min"
            :max="control.max"
            :step="control.step"
            :disabled="control.disabled"
            :disabled-reason="control.reason"
            :aria-label="`${control.label} screen control`"
            data-hardware-control="knob"
            :data-panel-control="`screen-encoder-${index + 1}`"
            @rotate="rotateScreenControl(index, $event)"
            @press="pressScreenControl(index)"
            @press-rotate="pressRotateScreenControl(index, $event)"
          />
          <span class="soft-value">{{ control.display }}</span>
        </div>
      </div>

      <div class="page-navigation">
        <span class="write-caption" title="Hold EXIT and ENTER together">WRITE</span>
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="white"
          label="EXIT"
          :led-on="false"
          aria-label="Exit current page"
          data-panel-control="exit"
          data-hardware-control="button"
          allow-secondary-pointer
          @press="pressNavigation('EXIT')"
          @release="releaseNavigation('EXIT')"
          @cancel="cancelNavigation('EXIT')"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="blue"
          :label="confirmationOpen ? 'CONFIRM' : 'ENTER'"
          :aria-label="confirmationOpen ? 'Confirm the displayed action' : 'Enter selected page'"
          :led-on="false"
          :data-panel-control="confirmationOpen ? 'confirm' : 'enter'"
          data-hardware-control="button"
          allow-secondary-pointer
          @press="pressNavigation('ENTER')"
          @release="releaseNavigation('ENTER')"
          @cancel="cancelNavigation('ENTER')"
        />
        <span class="page-caption">PAGE</span>
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="white"
          label="◀"
          title="Previous display page (K)"
          :led-on="false"
          aria-label="Previous display page"
          data-panel-control="page-prev"
          data-hardware-control="button"
          @press="changeScreenPage(-1)"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="white"
          label="▶"
          title="Next display page (J)"
          :led-on="false"
          aria-label="Next display page"
          data-panel-control="page-next"
          data-hardware-control="button"
          @press="changeScreenPage(1)"
        />
      </div>
    </div>

    <div class="master-rhythm-bank">
      <div class="output-control">
        <div class="engraved-label output-caption"><span>OUTPUT</span><span>LEVEL</span></div>
        <HardwareKnob
          :model-value="outputLevel"
          :confirmed-only="uiStatus.mode === 'native'"
          :confirmed-revision="outputSyncRevision"
          appearance="classic"
          label="MASTER"
          color="red"
          :size="66"
          :max="200"
          :disabled="outputDisabled"
          :disabled-reason="outputDisabledReason"
          aria-label="Master output level"
          data-hardware-control="knob"
          data-panel-control="output-level"
          @update:model-value="setOutputLevel"
        />
      </div>

      <div class="rhythm-control-bank">
        <div class="engraved-label">RHYTHM</div>
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="white"
          label="EDIT"
          aria-label="Edit rhythm settings"
          :active="device.state.page === 'rhythm'"
          :selected="isRhythmEditorSelected"
          :led-on="false"
          data-testid="rhythm-edit-button"
          data-panel-control="rhythm-edit"
          data-hardware-control="button"
          @press="openClassicEditor('rhythm', 'rhythm')"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          :color="isRhythmPlaying ? 'red' : 'white'"
          :active="isRhythmPlaying"
          :led-on="false"
          :disabled="rhythmControlDisabled"
          :disabled-reason="rhythmControlDisabledReason"
          :label="'START/' + '\n' + 'STOP'"
          aria-label="Toggle rhythm playback"
          data-panel-control="rhythm-start"
          data-hardware-control="button"
          @press="toggleRhythm"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          appearance="classic"
          color="blue"
          :active="tapActive"
          :led-on="false"
          label="TAP TEMPO"
          aria-label="Tap tempo"
          data-panel-control="tap-tempo"
          data-hardware-control="button"
          @press="beginTap"
          @release="endTap"
          @cancel="cancelTap"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { latestMixerWrites } from '../../composables/latestMixerWrites';
import { NativeRhythmEngine } from '../../audio/NativeRhythmEngine';
import { rc505LcdFieldText } from '../../ui/rc505/Rc505LcdFieldText';
import { AudioEngine } from '../../audio/AudioEngine';
import { NATIVE_CATALOG_FX_LABELS } from '../../audio/nativeFxCatalog';
import { DRUM_KIT_CATALOG, RHYTHM_PATTERN_CATALOG } from '../../audio/rhythm';
import { Transport } from '../../core/Transport';
import { TrackState, TransportState } from '../../core/types';
import { usePanelFocus } from '../../composables/usePanelFocus';
import { useDevicePanel } from '../../composables/useDevicePanel';
import { useDeviceScreenEditor, type DeviceScreenField } from '../../composables/useDeviceScreenEditor';
import { useFxPanelState } from '../../composables/useFxPanelState';
import { useRc505Controls } from '../../composables/useRc505Controls';
import { useTrackFxTargetState } from '../../composables/useTrackFxTargetState';
import { advanceRc505EncoderField } from '../../ui/rc505/Rc505EncoderFields';
import { resolveNativeFxReadback } from '../../ui/rc505/Rc505FxReadback';
import { browserFxPlaySlot, nativeFxPlaySlot, unavailableFxPlaySlot } from '../../ui/rc505/Rc505FxPlayDisplay';
import { formatRc505TrackMeter } from '../../ui/rc505/Rc505TrackMeter';
import { assertTrackFxApplyConfirmed } from '../../audio/TrackFxApplyStatus';
import { useRc505Memory } from '../../composables/useRc505Memory';
import { Rc505NavigationChord, type Rc505NavigationKey } from '../../ui/rc505/Rc505NavigationChord';
import { rhythmUiState, useRhythmUiControls } from '../../composables/rhythmUiState';
import { getRc505RootPage, getRc505RootPageCount, getRc505RootPageStart } from '../../ui/rc505/Rc505DisplayStateMachine';
import { RC505_MIXER_PAGES, RC505_PLAY_SCREENS, type Rc505DisplayAction, type Rc505DisplayEditorTarget, type Rc505DisplayRoot, type Rc505DisplayRootItem, type Rc505DisplayState, type Rc505DisplayView, type Rc505PlayScreenId } from '../../ui/rc505/rc505DisplayTypes';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';
import LcdFieldGrid from './LcdFieldGrid.vue';

const props = defineProps<{
  inputFxValue: number;
  trackFxValue: number;
  inputFxDisabled: boolean;
  inputFxReason: string;
  trackFxDisabled: boolean;
  trackFxReason: string;
  setInputParameter?: (group: string, key: string, value: number) => void;
  setTrackParameter?: (group: string, key: string, value: number) => void;
}>();
const emit = defineEmits<{
  'update:inputFxValue': [value: number];
  'update:trackFxValue': [value: number];
}>();

const engine = AudioEngine.getInstance();
const transport = Transport.getInstance();
const { state: focusState } = usePanelFocus();
const device = useDevicePanel();
const classicState = device.classicState;
const controls = useRc505Controls();
const memory = useRc505Memory();
const navigationChord = new Rc505NavigationChord();
const inputBank = useFxPanelState('input');
const trackBank = useTrackFxTargetState({ sharedOnly: true });
const screenEditor = useDeviceScreenEditor({
  surface: 'classic',
  setInputMacro: (value) => emit('update:inputFxValue', value),
  setTrackMacro: (value) => emit('update:trackFxValue', value),
  setInputParameter: props.setInputParameter,
  setTrackParameter: props.setTrackParameter,
});
const bpm = ref(transport.bpm);
const tapActive = ref(false);
const isPlaying = ref(false);
const outputLevel = ref(engine.getOutputLevel());
const trackLevel = ref(engine.tracks[focusState.currentTrackId - 1]?.track.playLevel ?? 100);
const pageActionHint = ref('');
const capabilityRevision = ref(0);
const mixerPending = ref(false);
const outputSyncRevision = ref(0);
const { isPlaying: isRhythmPlaying, volume: rhythmVolume, disabled: rhythmDisabled, pending: rhythmPending, message: rhythmMessage, toggleRhythm, updateVolume, updateSelection } = useRhythmUiControls({ initializeOnMount: false });
let tapFlashTimer: number | null = null;
let tapResetTimer: number | null = null;
let tapHoldTimer: number | null = null;
let tapSessionBpm: number | null = null;
let tapHeld = false;
let tapPressedAt = 0;
let tapIdentity = '';
let tapExpectedRevision = 0;
let tapHoldConsumed = false;
let unsubscribeStatus: (() => void) | null = null;
const tapTimes: number[] = [];

const currentTrackId = computed(() => focusState.currentTrackId);
const historyButtonLabel = 'UNDO/REDO';
const historyButtonAriaLabel = 'Toggle Undo/Redo control layer';
const historyButtonDisabled = computed(() => !audioReady.value);
const historyButtonDisabledReason = computed(() => !audioReady.value ? transportDisabledReason.value : '');
const undoLayerActive = computed(() => controls.state.controlLayer === 'UNDO_REDO');
const classicView = computed(() => classicState.value.view);
const classicRoot = computed(() => classicView.value.kind === 'menu-root' ? 'menu' : classicView.value.kind === 'loop-root' ? 'loop' : null);
const isClassicEditor = computed(() => classicView.value.kind === 'editor' && screenEditor.active.value);
const fxPlayLocation = computed(() => classicView.value.kind === 'play'
  ? classicScreenId.value === 'input-fx' ? 'input' : classicScreenId.value === 'track-fx' ? 'track' : null
  : null);
const isFxPlayScreen = computed(() => fxPlayLocation.value !== null);
const fxPlayMemoryNumber = computed(() => memory.state.number === null ? '--' : String(memory.state.number).padStart(2, '0'));
const fxPlayTempo = computed(() => Number.isFinite(bpm.value) ? `♩=${bpm.value.toFixed(1)}` : '♩=--');
const fxPlaySlots = computed(() => {
  capabilityRevision.value;
  const location = fxPlayLocation.value;
  if (!location) return [];
  const supported = location === 'input' ? capabilities.value.supportsInputFx : capabilities.value.supportsTrackFx;
  const snapshot = engine.getBrowserSharedFxSnapshot(location);
  return ['A', 'B', 'C', 'D'].map((slot, index) => {
    if (engine.getMode() === 'native') {
      const readback = nativeFxPlaySlot(slot, resolveNativeFxReadback(engine.getNativeCatalogFxSlotStatus(location, index), id => NATIVE_CATALOG_FX_LABELS[id] ?? id));
      // Preserve an explicit restart/error/pending diagnosis even if the engine
      // is not ready. Only an ACK could otherwise falsely advertise audible ON.
      if (!readback.confirmed) return readback;
      if (supported && audioReady.value) return readback;
    } else if (supported && audioReady.value) return browserFxPlaySlot(slot, snapshot?.[index]);
    return unavailableFxPlaySlot(slot, 'UNAVAILABLE', !supported
      ? capabilities.value.fxReason || 'FX is unavailable on this audio runtime.' : uiStatus.value.message || 'Start audio to confirm FX state.');
  });
});
const fxPlayError = computed(() => runtimeStatusPriority.value || scopedControlError.value || memory.state.error || device.actionStatus.error
  || fxPlaySlots.value.find(slot => slot.state === 'ERROR')?.reason || '');
const lcdContextLabel = computed(() => {
  const view = classicView.value;
  if (view.kind !== 'editor') return 'BOSS RC-505mkII';
  if (view.target === 'track') return `TRACK ${currentTrackId.value}`;
  if (view.target === 'input-fx') return 'INPUT FX';
  if (view.target === 'track-fx') return 'TRACK FX';
  if (view.target === 'rhythm') return 'RHYTHM';
  return view.category.toUpperCase();
});
const menuRootSelected = computed(() => classicView.value.kind === 'menu-root');
const loopRootSelected = computed(() => classicView.value.kind === 'loop-root');
const isRhythmEditorSelected = computed(() => classicView.value.kind === 'editor' && classicView.value.target === 'rhythm');
const confirmationOpen = ref(false);
const focusReturnStack: Array<HTMLElement | null> = [];
watch(classicState, async (next, previous) => {
  pageActionHint.value = '';
  let returnFocus: HTMLElement | null = null;
  const depth = next.returnStack.length;
  const previousDepth = previous.returnStack.length;
  if (depth > previousDepth) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    while (focusReturnStack.length < depth) focusReturnStack.push(opener);
  } else if (depth < previousDepth) {
    returnFocus = focusReturnStack[depth] ?? null;
    focusReturnStack.length = depth;
  } else if (next.returnStack.some((view, index) => view !== previous.returnStack[index])) {
    // The display stack can evict an old frame at its depth limit. Preserve
    // openers by frame identity rather than leaving shifted focus positions.
    const openers = new Map(previous.returnStack.map((view, index) => [view, focusReturnStack[index] ?? null] as const));
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const reconciled = next.returnStack.map((view) => openers.has(view) ? openers.get(view)! : opener);
    focusReturnStack.splice(0, focusReturnStack.length, ...reconciled);
  }
  const view = next.view;
  const previousView = previous.view;
  const changedSurface = view.kind !== previousView.kind
    || (view.kind === 'editor' && previousView.kind === 'editor' && view.target !== previousView.target);
  if (!changedSurface && !returnFocus) return;
  await nextTick();
  if (returnFocus?.isConnected) { returnFocus.focus({ preventScroll: true }); return; }
  if (view.kind === 'editor') {
    document.querySelector<HTMLElement>('[data-testid="rc505-lcd-screen"] select:not(:disabled), [data-testid="rc505-lcd-screen"] input:not(:disabled), [data-testid="rc505-lcd-screen"] button:not(:disabled)')?.focus({ preventScroll: true });
  } else if (view.kind === 'loop-root' || view.kind === 'menu-root' || view.kind === 'mixer') {
    document.querySelector<HTMLElement>('.center-main-panel [data-panel-control^="screen-encoder-"][aria-disabled="false"]')?.focus({ preventScroll: true });
  }
});
watch(() => [device.actionStatus.pending, device.actionStatus.error], ([pending, error]) => {
  if (!pending && !error && device.state.page === 'track') pageActionHint.value = '';
});
const classicScreenId = computed(() => {
  const view = classicView.value;
  if (view.kind === 'play') return RC505_PLAY_SCREENS[view.pageIndex]?.id ?? 'memory-number';
  if (view.kind === 'mixer') return `mixer-${RC505_MIXER_PAGES[view.pageIndex]?.id ?? 'inputs'}`;
  if (view.kind === 'loop-root') return 'loop-root';
  if (view.kind === 'menu-root') return 'menu-root';
  if (view.kind === 'editor') return `editor-${view.category}`;
  if (view.kind === 'memory-write') return `memory-${view.operation}`;
  return 'confirm';
});
const pageLabel = computed(() => {
  const view = classicView.value;
  if (view.kind === 'play') return 'PLAY';
  if (view.kind === 'mixer') return 'MIXER';
  if (view.kind === 'loop-root') return 'LOOP';
  if (view.kind === 'menu-root') return 'MENU';
  if (view.kind === 'editor') return 'EDIT';
  if (view.kind === 'memory-write') return 'MEMORY';
  return 'CONFIRM';
});
const pageCounter = computed(() => {
  const view = classicView.value;
  if (view.kind === 'play') return `${view.pageIndex + 1}/7`;
  if (view.kind === 'mixer') return `${view.pageIndex + 1}/${RC505_MIXER_PAGES.length}`;
  if (view.kind === 'loop-root' || view.kind === 'menu-root') {
    const count = getRc505RootPageCount(view.kind === 'loop-root' ? 'loop' : 'menu');
    return `${view.pageIndex + 1}/${count}`;
  }
  if (view.kind === 'editor') return `${screenEditor.pageIndex.value + 1}/${screenEditor.pageCount.value}`;
  return '';
});
const pageTitle = computed(() => {
  const view = classicView.value;
  if (view.kind === 'play') return RC505_PLAY_SCREENS[view.pageIndex]?.label ?? 'PLAY';
  if (view.kind === 'mixer') return RC505_MIXER_PAGES[view.pageIndex]?.label ?? 'MIXER';
  if (view.kind === 'loop-root') return 'LOOP SETTINGS';
  if (view.kind === 'menu-root') return 'MENU SETTINGS';
  if (view.kind === 'editor') return screenEditor.pageTitle.value;
  if (view.kind === 'memory-write') return view.operation === 'choose' ? 'WRITE / CLEAR' : `MEMORY ${view.operation.toUpperCase()}`;
  return 'CONFIRM ACTION';
});
const capabilities = computed(() => {
  capabilityRevision.value;
  return engine.getCapabilities();
});
const uiStatus = computed(() => {
  capabilityRevision.value;
  return engine.getUiStatus();
});
const audioReady = computed(() => uiStatus.value.ready);
const transportDisabledReason = computed(() => audioReady.value ? '' : uiStatus.value.message || 'Start audio from the audio settings before using transport.');
const outputDisabled = computed(() => capabilities.value.supportsOutputLevel === false);
const outputDisabledReason = computed(() => outputDisabled.value
  ? capabilities.value.outputLevelReason || 'Master output level is unavailable on this audio runtime.'
  : '');
const rhythmReason = computed(() => capabilities.value.rhythmReason || 'Rhythm playback is unavailable on this audio runtime.');
const rhythmControlDisabled = computed(() => !audioReady.value || rhythmDisabled.value || rhythmPending.value);
const rhythmControlDisabledReason = computed(() => rhythmPending.value
  ? 'A rhythm command is pending.'
  : !audioReady.value
    ? transportDisabledReason.value
    : rhythmReason.value);
function conciseStatus(message: string): string {
  const oneLine = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine;
}

const scopedControlError = computed(() => {
  const view = classicView.value;
  return controls.errorFor(view.kind === 'play' ? 'play'
    : view.kind === 'editor' && (view.target === 'input-fx' || view.target === 'track-fx') ? view.target : 'other');
});
// Runtime failures and a running engine's unresolved state take precedence
// over stale page notices or earlier per-control success/error messages.
// An unstarted engine without an error still permits offline editor feedback.
const runtimeStatusPriority = computed(() => uiStatus.value.lastError ||
  (!uiStatus.value.ready && uiStatus.value.engineRunning ? uiStatus.value.message || 'AUDIO NOT READY' : ''));
const statusDetail = computed(() => runtimeStatusPriority.value ||
  (scopedControlError.value ? controls.state.errorDetail || scopedControlError.value : '') || classicState.value.notice || (isClassicEditor.value ? screenEditor.status.value : '')
  || memory.state.error || (memory.state.busy ? 'MEMORY TRANSACTION PENDING' : '')
  || device.actionStatus.error || device.actionStatus.pending || pageActionHint.value || (undoLayerActive.value ? 'UNDO/REDO CONTROLS ACTIVE' : '')
  || (rhythmPending.value ? 'RHYTHM COMMAND PENDING' : !audioReady.value ? uiStatus.value.message || 'AUDIO NOT READY'
    : rhythmMessage.value || (isPlaying.value ? 'TRANSPORT RUNNING' : 'READY')));
const statusHint = computed(() => {
  const message = runtimeStatusPriority.value || scopedControlError.value || statusDetail.value;
  if (!uiStatus.value.lastError && !scopedControlError.value && /browser audio not initialized/i.test(message)) return 'AUDIO OFF';
  return conciseStatus(message);
});

type ScreenField = {
  key: string;
  label: string;
  shortLabel?: string;
  shortValue?: string;
  fullText?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  color: 'red' | 'green' | 'blue' | 'yellow' | 'white';
  disabled: boolean;
  reason: string;
  setValue: (value: number) => void;
  format?: (value: number) => string;
  kind?: DeviceScreenField['kind'];
  options?: DeviceScreenField['options'];
  activate?: DeviceScreenField['activate'];
};

type LcdDataRow = { key: string; label: string; value: string; disabled?: boolean; selected?: boolean; reason?: string; gain?: number; meter?: number };
type ScreenControl = {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  color: ScreenField['color'];
  disabled: boolean;
  reason: string;
  display: string;
  canRotate: boolean;
  onRotate?: (delta: number, accelerated: boolean) => void;
  onPress?: () => void;
};

const activeInputFx = computed(() => inputBank.slots.value.find((slot) => slot.id === inputBank.activeSlot.value) ?? inputBank.slots.value[0]!);
const activeTrackFx = computed(() => trackBank.activeFx.value!);
const screenFields = computed<ScreenField[]>(() => {
  capabilityRevision.value;
  if (isClassicEditor.value) return screenEditor.fields.value.map((field) => ({
    min: 0, max: 100, step: 1, color: 'blue' as const,
    ...field, disabled: field.disabled || memory.state.busy,
    reason: memory.state.busy ? 'Memory transaction is pending.' : field.disabled ? field.reason ?? '' : '', setValue: field.setValue ?? (() => undefined),
  }));
  const field = (key: string, label: string, value: number, setValue: (value: number) => void, options: Partial<ScreenField> = {}): ScreenField => ({
    key, label, value, setValue,
    min: options.min ?? 0,
    max: options.max ?? 100,
    step: options.step ?? 1,
    color: options.color ?? 'blue',
    disabled: options.disabled ?? false,
    reason: options.reason ?? '',
    ...(options.format ? { format: options.format } : {}),
  });
  const bpmField = () => field('bpm', 'BPM', bpm.value, setBpm, { min: 40, max: 300, step: 1, color: 'red' });
  const rhythmVolumeField = () => field('rhythm-volume', 'RHYTHM VOL', rhythmVolume.value, setRhythmVolume, {
    color: 'green', disabled: rhythmDisabled.value, reason: rhythmReason.value,
  });
  const inputFxValueField = () => field('input-fx-value', 'INPUT FX', props.inputFxValue, (value) => emit('update:inputFxValue', value), {
    color: 'blue', disabled: props.inputFxDisabled, reason: props.inputFxReason,
  });
  const trackFxValueField = () => field('track-fx-value', 'TRACK FX', props.trackFxValue, (value) => emit('update:trackFxValue', value), {
    color: 'red', disabled: props.trackFxDisabled, reason: props.trackFxReason,
  });
  const levelReason = engine.getTrackCapabilities(currentTrackId.value).levelReason || 'Track level is unavailable on this audio runtime.';
  const levelField = () => field('track-level', `TR ${currentTrackId.value} LEVEL`, trackLevel.value, setTrackLevel, {
    color: 'green', max: 200, disabled: mixerPending.value || !engine.getTrackCapabilities(currentTrackId.value).supportsTrackLevel,
    reason: engine.getTrackCapabilities(currentTrackId.value).supportsTrackLevel ? '' : levelReason,
  });
  const route = engine.getTrackFxApply?.(currentTrackId.value)[0];
  const fxApplyField = () => field('track-fx-apply', 'FX APPLY', route?.applied ? 100 : 0, (value) => { void setTrackFxApply(value); }, {
    color: 'red', step: 100, disabled: !route?.available || route.pending || route.controlFaulted,
    reason: route?.pending ? 'Waiting for both FX routes.' : route?.error || 'Start audio to switch both FX routes.',
    format: (value) => value >= 50 ? 'ON' : 'OFF',
  });
  const outputField = () => field('master-out', 'MASTER OUT', outputLevel.value, setOutputLevel, {
    color: 'red', max: 200, disabled: outputDisabled.value, reason: outputDisabledReason.value,
    format: outputDisabled.value ? () => '—' : (value) => `${Math.round(value)}%`,
  });
  const fxFields = (location: 'input' | 'track') => {
    const bank = location === 'input' ? inputBank : trackBank;
    const slot = location === 'input' ? activeInputFx.value : activeTrackFx.value;
    const disabled = bank.fxDisabled.value;
    const reason = bank.fxUnavailableReason.value || `${location === 'input' ? 'Input' : 'Track'} FX is unavailable on this audio runtime.`;
    const emptySlot = !slot.type || slot.type === 'NONE';
    const valueDisabled = disabled || emptySlot;
    const valueReason = disabled ? reason : emptySlot ? 'Select an effect first to edit its value.' : '';
    const currentOption = bank.fxOptions.value.indexOf(slot.type);
    return [
      field(`${location}-fx-value`, 'FX VALUE', slot.value, (value) => {
        if (location === 'track') emit('update:trackFxValue', value);
        else activeInputFx.value.value = value;
      }, { color: location === 'input' ? 'blue' : 'red', disabled: valueDisabled, reason: valueReason }),
      field(`${location}-fx-slot`, 'FX SLOT', ['A', 'B', 'C', 'D'].indexOf(bank.activeSlot.value) + 1, (value) => bank.selectSlot((['A', 'B', 'C', 'D'][Math.max(0, Math.min(3, Math.round(value) - 1))] ?? 'A') as 'A' | 'B' | 'C' | 'D'), {
        min: 1, max: 4, step: 1, color: 'yellow', disabled,
        reason: disabled ? reason : 'Select effect slot A through D.',
        format: (value) => ['A', 'B', 'C', 'D'][Math.max(0, Math.min(3, Math.round(value) - 1))] ?? 'A',
      }),
      field(`${location}-fx-active`, 'FX ON', slot.active ? 100 : 0, (value) => {
        if (location === 'track') trackBank.setActive(value >= 50);
        else activeInputFx.value.active = value >= 50;
      }, { color: 'green', disabled: valueDisabled, reason: valueReason }),
      field(`${location}-fx-type`, 'FX TYPE', Math.max(0, currentOption), (value) => {
        const next = bank.fxOptions.value[Math.max(0, Math.min(bank.fxOptions.value.length - 1, Math.round(value)))];
        if (!next) return;
        if (location === 'track') trackBank.setType(next);
        else activeInputFx.value.type = next;
      }, { min: 0, max: Math.max(0, bank.fxOptions.value.length - 1), step: 1, color: 'white', disabled, reason, format: (value) => bank.fxOptions.value[Math.max(0, Math.min(bank.fxOptions.value.length - 1, Math.round(value)))] ?? '—' }),
    ];
  };
  const rhythmFields = () => [
    rhythmVolumeField(),
    field('rhythm-pattern', 'PATTERN', rhythmUiState.patternIndex, (value) => { void updateSelection({ patternIndex: Math.max(1, Math.min(RHYTHM_PATTERN_CATALOG.length, Math.round(value))) }); }, {
      min: 1, max: RHYTHM_PATTERN_CATALOG.length, step: 1, color: 'blue', disabled: rhythmDisabled.value, reason: rhythmReason.value,
    }),
    field('rhythm-swing', 'SWING', rhythmUiState.swingPercent, (value) => { void updateSelection({ swingPercent: Math.max(50, Math.min(75, Math.round(value))) }); }, {
      min: 50, max: 75, step: 1, color: 'yellow', disabled: rhythmDisabled.value, reason: rhythmReason.value,
    }),
    field('rhythm-kit', 'KIT', rhythmUiState.kitIndex, (value) => { void updateSelection({ kitIndex: Math.max(1, Math.min(DRUM_KIT_CATALOG.length, Math.round(value))) }); }, {
      min: 1, max: DRUM_KIT_CATALOG.length, step: 1, color: 'red', disabled: rhythmDisabled.value, reason: rhythmReason.value,
    }),
  ];
  switch (device.state.page) {
    case 'mixer': return [levelField(), fxApplyField(), trackFxValueField(), rhythmVolumeField()];
    case 'input-fx': return fxFields('input');
    case 'track-fx': return fxFields('track');
    case 'rhythm': return rhythmFields();
    case 'settings': return [outputField(), bpmField(), rhythmVolumeField(), levelField()];
    case 'track': return [levelField(), fxApplyField(), trackFxValueField(), inputFxValueField()];
    case 'home':
    default: return [bpmField(), rhythmVolumeField(), inputFxValueField(), trackFxValueField()];
  }
});

function trackStateLabel(trackId: number): string {
  return engine.tracks[trackId - 1]?.state ?? 'UNKNOWN';
}

function phraseLabel(trackId: number): string {
  const hasPhrase = engine.getTrackHasPhrase(trackId);
  return hasPhrase === true ? 'PHRASE' : hasPhrase === false ? 'EMPTY' : 'UNKNOWN';
}

function trackLevelLabel(trackId: number): string {
  return formatRc505TrackMeter(engine.getTrackMeter?.(trackId));
}

function fxDisplayRows(location: 'input' | 'track'): LcdDataRow[] {
  capabilityRevision.value;
  const slots = location === 'input' ? inputBank.slots.value : trackBank.slots.value;
  const snapshot = engine.getBrowserSharedFxSnapshot(location);
  return slots.slice(0, 4).map((slot, index) => {
    if (engine.getMode() === 'native') {
      const confirmed = resolveNativeFxReadback(engine.getNativeCatalogFxSlotStatus(location, index),
        (id) => NATIVE_CATALOG_FX_LABELS[id] ?? id);
      return {
        key: `${location}-${slot.id}`, label: `${slot.id} ${confirmed.type}`,
        value: `${confirmed.activeLabel} · ${confirmed.state}`,
        disabled: confirmed.disabled, reason: confirmed.reason,
      };
    }
    const runtime = snapshot?.[index];
    const type = (runtime?.type ?? slot.type) || 'EMPTY';
    const active = runtime?.active ?? slot.active;
    const state = runtime?.state ?? 'PARTIAL';
    return {
      key: `${location}-${slot.id}`,
      label: `${slot.id} ${type}`,
      value: `${active ? 'ON' : 'OFF'} · ${state.toUpperCase()}`,
      disabled: runtime?.state === 'error',
      reason: runtime?.error || '',
    };
  });
}

const lcdDataRows = computed<LcdDataRow[]>(() => {
  capabilityRevision.value;
  const view = classicView.value;
  if (view.kind === 'confirm') return [{ key: 'confirm', label: 'ACTION', value: 'CONFIRM OR EXIT' }];
  if (view.kind === 'memory-write') return view.operation === 'choose'
    ? [{ key: 'write', label: '1 / 2', value: 'WRITE' }, { key: 'clear', label: '3 / 4', value: 'CLEAR' }]
    : [{ key: 'slot', label: 'MEMORY NO.', value: String(view.slot).padStart(2, '0') },
      { key: 'name', label: 'NAME', value: memory.state.name || '—' },
      { key: 'action', label: view.busy ? 'BUSY' : 'ENTER', value: view.busy ? 'PLEASE WAIT' : view.operation.toUpperCase() }];
  if (view.kind === 'loop-root' || view.kind === 'menu-root') {
    const root = view.kind === 'loop-root' ? 'loop' : 'menu';
    const start = getRc505RootPageStart(root, view.pageIndex);
    return getRc505RootPage(root, view.pageIndex).map((item, index) => ({
      key: item.id,
      label: item.label,
      value: item.reason ? 'DISABLED' : 'OPEN',
      disabled: Boolean(item.reason),
      selected: view.selectedIndex === start + index,
      reason: item.reason,
    }));
  }
  if (view.kind === 'play') {
    const screenId = RC505_PLAY_SCREENS[view.pageIndex]?.id as Rc505PlayScreenId | undefined;
    switch (screenId) {
      case 'memory-number':
        return [
          { key: 'memory-number', label: 'MEMORY NO.', value: memory.state.number === null ? '--' : String(memory.state.number).padStart(2, '0') },
          { key: 'memory-name', label: 'NAME', value: memory.state.name || '—' },
          { key: 'memory-support', label: 'MEMORY DATA', value: memory.state.busy ? 'PLEASE WAIT' : memory.state.dirty ? 'EDITED · PARTIAL' : 'SAVED · PARTIAL' },
        ];
      case 'track-status':
        return [1, 2, 3, 4, 5].map((trackId) => ({
          key: `track-state-${trackId}`, label: `TR ${trackId}`, value: trackStateLabel(trackId),
        }));
      case 'loop-tracks':
        return [1, 2, 3, 4, 5].map((trackId) => ({
          key: `loop-presence-${trackId}`, label: `TR ${trackId}`, value: phraseLabel(trackId),
        }));
      case 'loop-status':
        return [1, 2, 3, 4, 5].map((trackId) => ({
          key: `loop-status-${trackId}`, label: `TR ${trackId}`, value: trackStateLabel(trackId),
        }));
      case 'loop-level':
        return [1, 2, 3, 4, 5].map((trackId) => {
          const meter = engine.getTrackMeter?.(trackId);
          const unavailable = !meter?.available;
          return {
            key: `loop-level-${trackId}`, label: `TR ${trackId} LEVEL`, value: trackLevelLabel(trackId),
            disabled: unavailable,
            reason: unavailable ? meter?.reason || 'Track meter data is unavailable.' : 'Post-fader/pre-shared-FX peak/RMS.',
          };
        });
      case 'input-fx': return fxDisplayRows('input');
      case 'track-fx': return fxDisplayRows('track');
      default: return [];
    }
  }
  if (view.kind === 'mixer') {
    const page = RC505_MIXER_PAGES[view.pageIndex];
    if (!page) return [];
    if (page.id === 'tracks') return page.channels.map((channel, index) => {
      const trackId = index + 1;
      const mixer = engine.getMixerState?.();
      const capability = engine.getTrackCapabilities(trackId);
      const readback = mixer?.available && capability.supportsTrackLevel ? mixer.tracks[index] : undefined;
      const gain = typeof readback === 'number' && Number.isFinite(readback) ? readback : undefined;
      const reading = engine.getTrackMeter?.(trackId);
      const meter = reading?.available && Number.isFinite(reading.peak) && reading.peak >= 0 ? Math.min(1, reading.peak) : undefined;
      return { key: `mixer-${channel}`, label: channel, value: gain === undefined ? 'UNAVAILABLE' : `${gain}%`,
        gain, meter, disabled: gain === undefined, reason: gain === undefined ? capability.levelReason || mixer?.reason || 'Track gain is unavailable.'
          : meter === undefined ? reading?.reason || 'Measured track level is unavailable.' : 'Gain and post-fader/pre-shared-FX peak are separate readings.' };
    });
    if (page.id === 'inputs') return page.channels.map((channel) => ({
      key: `mixer-${channel}`, label: channel, value: 'PARTIAL', disabled: true,
      reason: `${channel} input gain and meter data are not exposed by the current audio engine.`,
    }));
    if (page.id === 'outputs') return page.channels.map((channel) => ({
      key: `mixer-${channel}`, label: channel,
      value: channel === 'MAIN' && engine.getMixerState?.().available ? `${engine.getMixerState().main}%` : 'UNAVAILABLE',
      gain: channel === 'MAIN' && engine.getMixerState?.().available ? engine.getMixerState().main ?? undefined : undefined,
      disabled: channel !== 'MAIN' || !engine.getMixerState?.().available,
      reason: channel === 'MAIN'
        ? engine.getMixerState?.().available
          ? 'Independent software MAIN gain scales loop playback and rhythm; monitoring bypasses MAIN.'
          : engine.getMixerState?.().reason || 'Independent MAIN output level is unavailable on this audio runtime.'
        : `${channel} output routing is not exposed by the current audio engine.`,
    }));
    return page.channels.map((channel) => channel === 'RHYTHM'
      ? { key: 'mixer-rhythm', label: 'RHYTHM', value: `${Math.round(rhythmVolume.value)}%`, gain: rhythmDisabled.value ? undefined : rhythmVolume.value }
      : channel === 'MASTER'
        ? { key: 'mixer-master', label: 'MASTER', value: `${Math.round(outputLevel.value)}%`, gain: outputDisabled.value ? undefined : outputLevel.value }
        : { key: 'mixer-phones', label: 'PHONES', value: 'UNAVAILABLE', disabled: true, reason: 'Independent headphone level is not exposed by the current audio engine.' });
  }
  return [];
});

function infoControl(key: string, label: string, display: string, reason = 'This screen item is read-only.', color: ScreenField['color'] = 'white'): ScreenControl {
  return { key, label, value: 0, min: 0, max: 100, step: 1, color, disabled: true, reason, display, canRotate: false };
}

const lcdDetail = ref<{ label: string; text: string } | null>(null);
const lcdDetailElement = ref<HTMLElement | null>(null);
let lcdDetailOpener: HTMLElement | null = null;
function openLcdDetails(index: number): void {
  const field = screenFields.value[index];
  if (!field) return;
  lcdDetailOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  lcdDetail.value = { label: field.label, text: rc505LcdFieldText(field).fullText };
  void nextTick(() => lcdDetailElement.value?.focus());
}
function closeLcdDetails(): void {
  lcdDetail.value = null;
  const opener = lcdDetailOpener; lcdDetailOpener = null;
  void nextTick(() => { if (opener?.isConnected) opener.focus(); });
}
const screenControls = computed<ScreenControl[]>(() => {
  if (lcdDetail.value) return Array.from({ length: 4 }, (_, index) => infoControl(`detail-${index}`, '', '', 'Exit details to edit.'));
  capabilityRevision.value;
  const view = classicView.value;
  if (view.kind === 'memory-write') return Array.from({ length: 4 }, (_, index) => ({
    key: `memory-${index}`, label: view.operation === 'choose' ? index < 2 ? 'WRITE' : 'CLEAR' : 'MEMORY NO.',
    value: view.slot, min: 1, max: 99, step: 1, color: 'white' as const,
    disabled: view.busy, reason: view.busy ? 'Memory transaction is pending.' : '',
    display: view.operation === 'choose' ? 'SELECT' : String(view.slot).padStart(2, '0'),
    canRotate: view.operation !== 'choose',
    onRotate: delta => { dispatchClassic({ type: 'ENCODER_ROTATE', encoderIndex: index, delta }); },
    onPress: () => { dispatchClassic({ type: 'ENCODER_PRESS', encoderIndex: index }); },
  }));
  if (isClassicEditor.value) {
    const fields = screenFields.value.slice(0, 4).map((field, index): ScreenControl => ({
      key: field.key,
      label: field.label,
      value: field.value,
      min: field.min,
      max: field.max,
      step: field.step,
      color: field.color,
      disabled: field.disabled,
      reason: field.reason,
      display: displayFieldValue(field),
      canRotate: !field.disabled && field.kind !== 'action',
      onRotate: (delta, accelerated) => setScreenField(index, advanceRc505EncoderField(field, delta, accelerated)),
      onPress: field.disabled ? undefined : () => { screenEditor.selectField(index); screenEditor.enter(); },
    }));
    return [...fields, ...Array.from({ length: Math.max(0, 4 - fields.length) }, (_, index) => infoControl(`field-empty-${index}`, '', ''))];
  }
  if (view.kind === 'loop-root' || view.kind === 'menu-root') {
    const root: Rc505DisplayRoot = view.kind === 'loop-root' ? 'loop' : 'menu';
    const start = getRc505RootPageStart(root, view.pageIndex);
    const items: readonly Rc505DisplayRootItem[] = getRc505RootPage(root, view.pageIndex);
    const controlsForItems = items.map((item, index): ScreenControl => ({
      key: item.id,
      label: item.label,
      value: view.selectedIndex === start + index ? 100 : 0,
      min: 0,
      max: 100,
      step: 1,
      color: view.selectedIndex === start + index ? 'yellow' : 'white',
      disabled: Boolean(item.reason),
      reason: item.reason ?? '',
      display: item.reason ? 'DISABLED' : 'OPEN',
      canRotate: false,
      onPress: item.reason ? undefined : () => openRootEncoder(index),
    }));
    return [...controlsForItems, ...Array.from({ length: Math.max(0, 4 - controlsForItems.length) }, (_, index) => infoControl(`root-empty-${index}`, '', ''))];
  }
  if (view.kind === 'mixer') {
    const page = RC505_MIXER_PAGES[view.pageIndex];
    if (!page) return [];
    const controlsForChannels = page.channels.map((channel): ScreenControl => {
      if (page.id === 'tracks') {
        const trackId = (page.channels.indexOf(channel) + 1) as 1 | 2 | 3 | 4;
        const mixer = engine.getMixerState?.();
        const capability = engine.getTrackCapabilities(trackId);
        const value = mixer?.tracks[trackId - 1];
        const available = mixer?.available === true && capability.supportsTrackLevel && Number.isFinite(value);
        return { key: `mixer-track-${trackId}`, label: channel, value: value ?? 0, min: 0, max: 200, step: 1, color: 'green',
          disabled: !available || memory.state.busy,
          reason: memory.state.busy ? 'Memory transaction is pending.' : !available ? capability.levelReason || mixer?.reason || 'Track gain is unavailable.' : '',
          display: available ? `${value}%` : 'UNAVAILABLE', canRotate: available,
          onRotate: (delta, accelerated) => { void setMixerLevel(trackId, latestMixerWrites.target(`${engine.getMixerControlIdentity()}:${trackId}`, value ?? 0) + delta * (accelerated ? 5 : 1)); } };
      }
      if (page.id === 'outputs' && channel === 'MAIN') {
        const mixer = engine.getMixerState?.();
        return { key: 'mixer-main', label: 'MAIN', value: mixer?.main ?? 100, min: 0, max: 200, step: 1, color: 'green',
          disabled: !mixer?.available || memory.state.busy,
          reason: memory.state.busy ? 'Memory transaction is pending.' : mixer?.reason || '',
          display: mixer?.available ? `${mixer.main}%` : 'UNAVAILABLE', canRotate: true,
          onRotate: (delta, accelerated) => { void setMixerLevel('MAIN', latestMixerWrites.target(`${engine.getMixerControlIdentity()}:MAIN`, mixer?.main ?? 100) + delta * (accelerated ? 5 : 1)); } };
      }
      if (page.id === 'master' && channel === 'RHYTHM') return {
        key: 'mixer-rhythm', label: channel, value: rhythmVolume.value, min: 0, max: 100, step: 1, color: 'green',
        disabled: rhythmDisabled.value, reason: rhythmReason.value, display: `${Math.round(rhythmVolume.value)}%`, canRotate: !rhythmDisabled.value,
        onRotate: (delta, accelerated) => setRhythmVolume(rhythmVolume.value + delta * (accelerated ? 5 : 1)),
      };
      if (page.id === 'master' && channel === 'MASTER') return {
        key: 'mixer-master', label: channel, value: outputLevel.value, min: 0, max: 200, step: 1, color: 'red',
        disabled: outputDisabled.value || memory.state.busy,
        reason: outputDisabledReason.value, display: `${Math.round(outputLevel.value)}%`, canRotate: !outputDisabled.value,
        onRotate: (delta, accelerated) => { void setMixerLevel('MASTER', latestMixerWrites.target(`${engine.getMixerControlIdentity()}:MASTER`, outputLevel.value) + delta * (accelerated ? 5 : 1)); },
      };
      const reason = page.id === 'inputs'
        ? `${channel} input gain and meter data are not exposed by the current audio engine.`
        : page.id === 'outputs' && channel === 'MAIN'
          ? 'Independent MAIN output level is not exposed. Use the MASTER mixer page for the available shared level.'
          : channel === 'PHONES' ? 'Independent headphone level is not exposed by the current audio engine.'
          : `${channel} output routing is not exposed by the current audio engine.`;
      return infoControl(`mixer-${channel}`, channel, 'UNAVAILABLE', reason);
    });
    return [...controlsForChannels, ...Array.from({ length: Math.max(0, 4 - controlsForChannels.length) }, (_, index) => infoControl(`mixer-empty-${index}`, '', ''))];
  }
  if (view.kind === 'play') {
    // Play functions are independent of the five-track status display.
    return [
      { key: 'play-memory', label: 'MEMORY', value: memory.state.number ?? 1, min: 1, max: 99, step: 1, color: 'white',
        disabled: !memory.state.available || memory.state.busy, reason: memory.state.reason,
        display: memory.state.number === null ? '--' : String(memory.state.number).padStart(2, '0'), canRotate: true,
        onRotate: delta => { void loadMemory(Math.max(1, Math.min(99, (memory.state.number ?? 1) + Math.trunc(delta)))); } },
      infoControl('play-off-2', '', '', 'No function assigned.'),
      infoControl('play-off-3', '', '', 'No function assigned.'),
      infoControl('play-master-reverb', 'MFX REVERB', 'UNAVAILABLE', 'Master reverb control is not available in this runtime.'),
    ];
  }
  return Array.from({ length: 4 }, (_, index) => infoControl(`screen-empty-${index}`, '', ''));
});

function displayFieldValue(field: ScreenField): string {
  return field.format ? field.format(field.value) : `${Math.round(field.value)}${field.max === 100 ? '%' : ''}`;
}

function setScreenField(index: number, value: number): void {
  if (isClassicEditor.value) screenEditor.selectField(index);
  if (screenFields.value[index]?.disabled) return;
  screenFields.value[index]?.setValue(value);
}
function activateScreenField(index: number): void {
  screenEditor.selectField(index);
  screenEditor.enter();
}

function underlyingPanelView(state: Rc505DisplayState): Rc505DisplayView {
  let candidate = state.view;
  let stackIndex = state.returnStack.length - 1;
  while (candidate.kind === 'confirm' || candidate.kind === 'loop-root' || candidate.kind === 'menu-root') {
    candidate = state.returnStack[stackIndex] ?? { kind: 'play', pageIndex: 0 };
    stackIndex -= 1;
  }
  return candidate;
}

function syncClassicPanel(state: Rc505DisplayState): void {
  const view = underlyingPanelView(state);
  if (view.kind === 'editor') {
    if (device.state.page !== view.target) device.openPage(view.target);
    device.setEditorPageIndex(view.pageIndex);
  } else if (view.kind === 'mixer') {
    if (device.state.page !== 'mixer') device.openPage('mixer');
  } else if (device.state.page !== 'home') {
    device.goHome();
  }
}

function dispatchClassic(action: Rc505DisplayAction): Rc505DisplayState {
  const next = device.classicDispatch(action);
  syncClassicPanel(next);
  return next;
}

function openClassicRootItem(index: number): void {
  dispatchClassic({ type: 'ENCODER_PRESS', encoderIndex: index });
}

function openRootEncoder(index: number): void {
  openClassicRootItem(index);
}

function openClassicRoot(root: Rc505DisplayRoot): void {
  const rootKind = root === 'loop' ? 'loop-root' : 'menu-root';
  if (classicView.value.kind === rootKind) return;
  dispatchClassic({ type: 'OPEN_ROOT', root });
}

function openClassicEditor(target: Rc505DisplayEditorTarget, category: string): void {
  if (classicView.value.kind === 'editor' && classicView.value.target === target) return;
  dispatchClassic({ type: 'OPEN_EDITOR', target, category });
}

function rotateScreenControl(index: number, delta: number, accelerated = false): void {
  const control = screenControls.value[index];
  if (!control) return;
  if (classicView.value.kind === 'loop-root' || classicView.value.kind === 'menu-root') {
    dispatchClassic({ type: accelerated ? 'ENCODER_PRESS_ROTATE' : 'ENCODER_ROTATE', encoderIndex: index, delta });
    return;
  }
  if (control.disabled) return;
  if (isClassicEditor.value) {
    if (control.canRotate) control.onRotate?.(delta, accelerated);
    return;
  }
  if (control.canRotate) control.onRotate?.(delta, accelerated);
}

function pressRotateScreenControl(index: number, delta: number): void {
  rotateScreenControl(index, delta, true);
}

function pressScreenControl(index: number): void {
  const control = screenControls.value[index];
  if (!control || control.disabled) return;
  control.onPress?.();
}

function changeScreenPage(direction: -1 | 1): void {
  if (lcdDetail.value) return;
  if (isClassicEditor.value) screenEditor.stepPage(direction);
  dispatchClassic({ type: 'PAGE', direction });
}
function exitPage(): void {
  if (lcdDetail.value) { closeLcdDetails(); return; }
  if (confirmationOpen.value || classicView.value.kind === 'confirm') {
    window.dispatchEvent(new Event('rc505-cancel-confirmation'));
    return;
  }
  const view = classicState.value.view;
  if (view.kind === 'editor') pageActionHint.value = '';
  dispatchClassic({ type: 'EXIT' });
}
function pressNavigation(key: Rc505NavigationKey): void {
  if (!navigationChord.press(key)) return;
  if (confirmationOpen.value || classicView.value.kind === 'confirm' || memory.state.busy) return;
  memory.refresh();
  if (!memory.state.available) { pageActionHint.value = memory.state.reason; return; }
  dispatchClassic({ type: 'OPEN_MEMORY_WRITE', slot: memory.state.number ?? 1 });
}
function releaseNavigation(key: Rc505NavigationKey): void {
  const action = navigationChord.release(key);
  if (action === 'ENTER') enterPage();
  else if (action === 'EXIT') exitPage();
}
function cancelNavigation(key: Rc505NavigationKey): void { navigationChord.cancel(key); }
async function loadMemory(slot: number): Promise<void> {
  if (classicView.value.kind !== 'play' || memory.state.busy) return;
  try { await memory.load(slot); pageActionHint.value = ''; }
  catch (error) { pageActionHint.value = error instanceof Error ? error.message : String(error); }
  finally { capabilityRevision.value += 1; }
}
async function setTrackLevel(value: number): Promise<void> {
  const trackId = currentTrackId.value as 1 | 2 | 3 | 4 | 5;
  if (!Number.isFinite(value) || !engine.getTrackCapabilities(trackId).supportsTrackLevel || memory.state.busy || mixerPending.value) return;
  mixerPending.value = true;
  try {
    await engine.setMixerLevel(trackId, Math.max(0, Math.min(200, Math.round(value))));
    trackLevel.value = engine.getMixerState().tracks[trackId - 1] ?? trackLevel.value;
  } catch (error) { controls.reportError('LEVEL FAILED', error instanceof Error ? error.message : String(error)); }
  finally { mixerPending.value = false; capabilityRevision.value += 1; }
}
async function setTrackFxApply(value: number): Promise<void> {
  const target = currentTrackId.value;
  const before = engine.getTrackFxApply(target)[0];
  if (!before?.available || before.pending || before.controlFaulted) return;
  try {
    assertTrackFxApplyConfirmed(await engine.setTrackFxApply(target, value >= 50), value >= 50);
    controls.clearError('general');
  } catch (error) { controls.reportError('FX ROUTE FAILED', error instanceof Error ? error.message : String(error)); }
  finally { capabilityRevision.value += 1; }
}

function hasActiveTracks(): boolean {
  const activeStates: TrackState[] = [
    TrackState.RECORDING,
    TrackState.PLAYING,
    TrackState.OVERDUBBING,
    TrackState.REC_STANDBY,
    TrackState.REC_FINISHING,
  ];
  return engine.tracks.some((track) => activeStates.includes(track.state));
}

function syncPlaybackState(): void {
  isPlaying.value = engine.getMode() === 'browser'
    ? transport.state === TransportState.PLAYING
    : hasActiveTracks();
}

function syncBpm(): void { bpm.value = transport.bpm; }
function setBpm(value: number): void {
  transport.setBpm(value);
  bpm.value = transport.bpm;
}
function setRhythmVolume(value: number): void {
  rhythmVolume.value = Math.max(0, Math.min(100, Math.round(value)));
  void updateVolume();
}
function setOutputLevel(value: number): void {
  if (outputDisabled.value || memory.state.busy) return;
  setMixerLevel('MASTER', value);
}
function setMixerLevel(channel: 'MAIN' | 'MASTER' | 1 | 2 | 3 | 4 | 5, value: number): void {
  if (memory.state.busy || !Number.isFinite(value)) return;
  const identity = engine.getMixerControlIdentity();
  latestMixerWrites.submit(`${identity}:${channel}`, Math.max(0, Math.min(200, Math.round(value))), async target => {
    await engine.setMixerLevel(channel, target);
    if (engine.getMixerControlIdentity() === identity) { outputLevel.value = engine.getOutputLevel(); capabilityRevision.value += 1; }
  }, () => engine.getMixerControlIdentity() === identity && !memory.state.busy, async error => {
    let unknown = false;
    try { if (engine.getMixerControlIdentity() === identity) await engine.refreshMixerState(); else unknown = true; } catch { unknown = true; }
    if (engine.getMixerControlIdentity() === identity) { outputLevel.value = engine.getOutputLevel(); capabilityRevision.value += 1; }
    controls.reportError('MIXER FAILED', `${error instanceof Error ? error.message : String(error)}${unknown ? ' Readback unknown.' : ''}`);
  }, () => { if (channel === 'MASTER') outputSyncRevision.value += 1; });
}

function toggleAllTransport(): void {
  if (!audioReady.value) return;
  if (isPlaying.value) engine.stopAllTracks();
  else engine.playAllTracks();
  window.setTimeout(syncPlaybackState, 0);
}

function toggleUndoLayer(): void {
  if (audioReady.value) controls.toggleUndoLayer();
}

function enterPage(): void {
  if (lcdDetail.value) return;
  if (confirmationOpen.value || classicView.value.kind === 'confirm') {
    window.dispatchEvent(new Event('rc505-accept-confirmation'));
    return;
  }
  pageActionHint.value = '';
  const view = classicView.value;
  if (view.kind === 'memory-write') {
    if (view.operation === 'choose' || view.busy) return;
    dispatchClassic({ type: 'ENTER' });
    void (view.operation === 'write' ? memory.save(view.slot) : memory.clear(view.slot))
      .then(() => { dispatchClassic({ type: 'MEMORY_COMPLETE', success: true }); })
      .catch((error: unknown) => { dispatchClassic({ type: 'MEMORY_COMPLETE', success: false, message: error instanceof Error ? error.message : String(error) }); });
    return;
  }
  if (isClassicEditor.value) {
    screenEditor.enter();
    return;
  }
  dispatchClassic({ type: 'ENTER' });
}

function handleClassicConfirmationState(event: Event): void {
  const detail = (event as CustomEvent<{ open: boolean; surface: string; prompt?: string; accepted?: boolean }>).detail;
  if (!detail || detail.surface !== 'classic') return;
  confirmationOpen.value = detail.open;
  if (detail.open) {
    if (classicView.value.kind !== 'confirm') {
      dispatchClassic({ type: 'REQUEST_CONFIRMATION', prompt: detail.prompt ?? 'Confirm action' });
    }
  } else if (classicView.value.kind === 'confirm') {
    dispatchClassic({ type: 'CONFIRM', accepted: detail.accepted === true });
  }
}

function resetTapSession(): void {
  if (tapResetTimer !== null) window.clearTimeout(tapResetTimer);
  if (tapHoldTimer !== null) window.clearTimeout(tapHoldTimer);
  tapResetTimer = null; tapHoldTimer = null; tapHeld = false; tapHoldConsumed = false;
  tapSessionBpm = null; tapIdentity = ''; tapTimes.length = 0;
}
function confirmedTapBpm(): number | null {
  if (engine.getMode() !== 'native') return transport.bpm;
  const rhythm = engine.rhythmEngine;
  if (!(rhythm instanceof NativeRhythmEngine) || !rhythm.available || !rhythm.settings) return null;
  try {
    if (rhythm.getPendingTempoIdentity() || rhythm.settings.bpm !== transport.bpm) return null;
  } catch { return null; }
  return rhythm.settings.bpm;
}
function beginTap(): void {
  if (tapHeld) return;
  if (tapSessionBpm !== null && (tapIdentity !== engine.getMixerControlIdentity() || tapExpectedRevision !== transport.tempoMutationRevision)) resetTapSession();
  if (tapResetTimer !== null) { window.clearTimeout(tapResetTimer); tapResetTimer = null; }
  if (tapSessionBpm === null) { tapSessionBpm = confirmedTapBpm(); tapIdentity = engine.getMixerControlIdentity(); tapExpectedRevision = transport.tempoMutationRevision; }
  tapHeld = true; tapPressedAt = performance.now(); tapHoldConsumed = false;
  tapHoldTimer = window.setTimeout(() => {
    tapHoldTimer = null;
    if (!tapHeld) return;
    tapHoldConsumed = true;
    if (tapSessionBpm !== null && tapIdentity === engine.getMixerControlIdentity() && tapExpectedRevision === transport.tempoMutationRevision && !memory.state.busy) setBpm(tapSessionBpm);
    tapTimes.length = 0;
  }, 2000);
}
function endTap(): void {
  if (!tapHeld) return;
  tapHeld = false;
  if (tapHoldTimer !== null) window.clearTimeout(tapHoldTimer);
  tapHoldTimer = null;
  if (tapHoldConsumed) { resetTapSession(); return; }
  tapActive.value = true;
  if (tapFlashTimer !== null) window.clearTimeout(tapFlashTimer);
  tapFlashTimer = window.setTimeout(() => { tapActive.value = false; tapFlashTimer = null; }, 100);
  tapTimes.push(tapPressedAt);
  if (tapTimes.length > 4) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const intervals = tapTimes.slice(1).map((time, index) => time - tapTimes[index]!);
    const nextBpm = Math.round(60000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length));
    if (nextBpm >= 40 && nextBpm <= 300) { setBpm(nextBpm); tapExpectedRevision = transport.tempoMutationRevision; }
  }
  tapResetTimer = window.setTimeout(resetTapSession, 3000);
}
function cancelTap(): void { resetTapSession(); }
watch([() => uiStatus.value.mode, () => engine.getMixerControlIdentity(), currentTrackId, classicScreenId, () => 'pageIndex' in classicView.value ? classicView.value.pageIndex : 0, () => memory.state.busy], () => { resetTapSession(); if (lcdDetail.value) closeLcdDetails(); }, { flush: 'sync' });
watch(() => memory.state.busy, busy => { if (busy) latestMixerWrites.invalidate(); }, { flush: 'sync' });

function syncTrackLevel(): void {
  // AudioParam automation becomes observable after the render quantum.
  if (engine.getMode() === 'browser') outputLevel.value = engine.getOutputLevel();
  trackLevel.value = engine.getMixerState?.().tracks[currentTrackId.value - 1] ?? engine.tracks[currentTrackId.value - 1]?.track.playLevel ?? 100;
  capabilityRevision.value += 1;
  memory.refresh();
}

let trackLevelTimer: number | null = null;

onMounted(() => {
  window.addEventListener('rc505-confirmation-state', handleClassicConfirmationState);
  transport.on('bpm-change', syncBpm);
  transport.on('start', syncPlaybackState);
  transport.on('stop', syncPlaybackState);
  syncPlaybackState();
  syncTrackLevel();
  trackLevelTimer = window.setInterval(syncTrackLevel, 150);
  unsubscribeStatus = engine.onStatusChange(() => {
    capabilityRevision.value += 1;
    outputLevel.value = engine.getOutputLevel();
    syncPlaybackState();
  });
});

onUnmounted(() => {
  navigationChord.cancel();
  window.removeEventListener('rc505-confirmation-state', handleClassicConfirmationState);
  transport.off('bpm-change', syncBpm);
  transport.off('start', syncPlaybackState);
  transport.off('stop', syncPlaybackState);
  if (tapFlashTimer !== null) window.clearTimeout(tapFlashTimer);
  resetTapSession();
  if (trackLevelTimer !== null) window.clearInterval(trackLevelTimer);
  unsubscribeStatus?.();
});
</script>

<style scoped>
.lcd-detail { grid-column: 1 / -1; grid-row: 1 / -1; display: flex; flex-direction: column; min-height: 0; overflow: auto; padding: 4px; color: #202d41; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.lcd-detail small { margin-top: auto; }
.center-main-panel {
  position: relative;
  display: block;
  box-sizing: border-box;
  height: 269px;
  min-width: 830px;
  padding: 0;
  color: #f0f2f5;
  background: linear-gradient(180deg, #28262d 0%, #1a191f 74%, #141419 100%);
  font-family: var(--font-hardware);
}

.transport-bank,
.display-cluster,
.master-rhythm-bank { position: absolute; inset: 0; display: block; }
.center-control-stack,
.transport-buttons { display: contents; }
/* Full-panel positioning layers must not cover sibling controls. */
.transport-bank,
.display-cluster,
.master-rhythm-bank,
.soft-control-row,
.page-navigation,
.rhythm-control-bank { pointer-events: none; }
.center-main-panel :deep(.hardware-button),
.center-main-panel :deep(.hardware-knob-wrapper) { pointer-events: auto; }
.screen-shell {
  position: absolute;
  top: 23px;
  left: 300px;
  box-sizing: border-box;
  width: 280px;
  height: 150px;
  padding: 6px;
  overflow: hidden;
  border: 3px solid #b3b4bd;
  border-radius: 3px;
  background: linear-gradient(145deg, #e1e2e8 0%, #898b96 100%);
  box-shadow: inset 0 1px 2px rgba(255,255,255,.85), inset 0 -2px 3px rgba(0,0,0,.35), 0 3px 7px rgba(0,0,0,.45);
}
.lcd-display {
  position: relative;
  pointer-events: auto;
  display: grid;
  box-sizing: border-box;
  grid-template-rows: 12px 15px minmax(0, 1fr) 22px;
  gap: 1px;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.52);
  border-radius: 1px;
  background: linear-gradient(180deg, #d7e3f4 0%, #b5c5dc 100%);
  color: #1b273a;
  box-shadow: inset 0 0 8px rgba(30, 48, 75, 0.24);
  text-transform: uppercase;
  font-family: var(--font-lcd, 'Lucida Console', monospace);
}
.lcd-display:not(.lcd-editor-active) { aspect-ratio: 2 / 1; }
.lcd-display.lcd-editor-active { grid-template-rows: 12px minmax(0, 1fr) 24px; gap: 1px; }
.lcd-display.lcd-parameter-active { grid-template-rows: 12px minmax(0, 1fr) 14px; }
.lcd-parameter-active .lcd-status { -webkit-line-clamp: 1; }
.lcd-display.lcd-root-active,
.lcd-display.lcd-mixer-active { grid-template-rows: 12px minmax(0, 1fr) 14px; }
.lcd-root-active .lcd-status,
.lcd-mixer-active .lcd-status { -webkit-line-clamp: 1; }
.lcd-data-rows.lcd-category-columns,
.lcd-data-rows.lcd-mixer-columns { grid-template-columns: repeat(4, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); gap: 3px; }
.lcd-category-columns .lcd-data-row { justify-content: center; padding: 2px; text-align: center; white-space: normal; }
.lcd-category-columns .lcd-data-row span { white-space: normal; overflow-wrap: anywhere; font-size: 11px; line-height: 1.1; }
.lcd-mixer-columns .lcd-data-row { display: grid; grid-template-rows: 12px minmax(0, 1fr) 20px; gap: 1px; justify-content: stretch; text-align: center; }
.lcd-mixer-gain { font-size: 11px; line-height: 12px; }
.lcd-mixer-strip { display: flex; justify-content: center; gap: 6px; height: 100%; min-height: 20px; padding: 2px 0; }
.lcd-mixer-fader { position: relative; width: 9px; height: 100%; border-inline: 1px solid currentColor; }
.lcd-mixer-fader > span:not(.lcd-mixer-unknown) { position: absolute; left: -3px; right: -3px; height: 3px; border: 1px solid currentColor; background: var(--lcd-selection-ink); transform: translateY(50%); }
.lcd-mixer-unknown { position: absolute; inset: 0; display: grid; place-items: center; font-size: 10px; }
.lcd-mixer-meter { position: relative; display: flex; align-items: center; justify-content: center; width: 12px; height: 100%; border-bottom: 1px solid currentColor; }
.lcd-mixer-meter > span { position: absolute; bottom: 0; left: 0; right: 0; background: repeating-linear-gradient(to top, currentColor 0 3px, transparent 3px 5px); }
.lcd-mixer-meter b { font-size: 10px; }
.lcd-mixer-label { font-size: 10px; line-height: 10px; white-space: normal; overflow-wrap: anywhere; }
.lcd-display.lcd-fx-play-active { display: block; padding: 3px 5px; }
.fx-play-display { display: grid; grid-template-rows: 11px 20px 11px minmax(0, 1fr) 14px; height: 100%; min-height: 0; line-height: 1; }
.fx-play-tempo { font-size: 10px; text-align: right; }
.fx-play-memory { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 18px; }
.fx-play-memory [data-fx-memory-number] { flex: none; border: 1px solid currentColor; }
.fx-play-memory [data-fx-memory-name] { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fx-play-heading { font-size: 10px; }
.fx-play-slots { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; min-height: 0; align-items: stretch; }
.fx-play-slot { display: flex; flex-direction: column; justify-content: center; align-items: center; min-width: 0; padding: 2px 1px; overflow: hidden; text-align: center; }
.fx-play-slot.is-on { color: var(--lcd-selection-ink, #202d41); background: var(--lcd-selection, #e3e8ff); }
.fx-play-type { max-width: 100%; font-size: 16px; line-height: 1; white-space: pre-line; overflow-wrap: anywhere; }
.fx-play-knob-labels { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: end; font-size: 9px; }
.fx-play-error { align-self: end; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10px; }
.lcd-editor-active .lcd-status { display: -webkit-box; line-height: 12px; white-space: normal; overflow-wrap: anywhere; text-overflow: clip; -webkit-line-clamp: 2; }
.lcd-data-rows { display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); gap: 1px; min-height: 0; overflow: hidden; color: #202d41; font-size: 11px; line-height: 1; }
.lcd-data-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; }
.lcd-data-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lcd-data-row.is-selected { font-weight: 700; color: #0e2845; }
.lcd-data-row.is-disabled { color: #627084; }
.lcd-confirmations { position: absolute; inset: 0; z-index: 8; pointer-events: none; }
.lcd-confirmations:not(:empty) { pointer-events: auto; }
.lcd-row { display: flex; justify-content: space-between; gap: 8px; min-width: 0; font-size: 12px; line-height: 1; letter-spacing: 0.03em; }
.lcd-row.top { color: #384860; }
.lcd-parameter-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); align-items: center; gap: 1px 8px; overflow: hidden; color: #202d41; font-size: 13px; line-height: 1; white-space: normal; }
.lcd-parameter-row span { min-width: 0; overflow-wrap: anywhere; }
.lcd-main { align-self: center; font-size: 26px; font-weight: 700; line-height: 0.9; text-align: center; }
.lcd-name { font-size: 15px; line-height: 1; letter-spacing: 0.06em; text-align: center; }
.lcd-track-line { color: #24344e; }
.lcd-status { display: -webkit-box; min-height: 0; overflow: hidden; color: #1c3957; font-size: 12px; line-height: 1; letter-spacing: 0.02em; text-align: center; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }

.soft-control-row { position: absolute; inset: 0; display: block; width: auto; }
.soft-field { position: absolute; top: 169px; display: grid; justify-items: center; gap: 0; width: 64px; min-width: 64px; }
.soft-field:nth-child(1) { left: 258px; }
.soft-field:nth-child(2) { left: 346px; }
.soft-field:nth-child(3) { left: 436px; }
.soft-field:nth-child(4) { left: 529px; }
.soft-field :deep(.hardware-knob-wrapper) { width: 64px; min-height: 60px; gap: 0; }
.soft-field :deep(.knob-stage),
.soft-field :deep(.led-ring) { width: 60px; height: 60px; }
.soft-field :deep(.knob-stage) { position: relative !important; }
.soft-field :deep(.led-ring) { position: absolute !important; inset: 0 !important; }
.soft-field :deep(.knob-cap) { z-index: 1; }
.soft-field :deep(.knob-label) { max-width: 80px; color: #e0e3e8; font-size: 11px; line-height: 1.05; text-align: center; white-space: normal; }
.soft-value { display: none; }

.page-navigation { position: absolute; inset: 0; display: block; }
.write-caption { position: absolute; top: 31px; left: 622px; width: 64px; border-inline: 1px solid #c5cad2; color: #c5cad2; font-size: 11px; line-height: 11px; letter-spacing: .05em; text-align: center; }
.page-caption { position: absolute; top: 91px; left: 636px; width: 60px; color: #c5cad2; font-size: 11px; letter-spacing: 0.08em; text-align: center; }
.page-navigation :deep(.hardware-button) { position: absolute; width: 58px; min-width: 58px; height: 32px; padding: 0 4px; }
.page-navigation :deep([data-panel-control="exit"]) { top: 49px; left: 583px; }
.page-navigation :deep([data-panel-control="enter"]) { top: 49px; left: 670px; }
.page-navigation :deep([data-panel-control="page-prev"]) { top: 115px; left: 583px; }
.page-navigation :deep([data-panel-control="page-next"]) { top: 115px; left: 670px; }
.page-navigation :deep(.button-label) { font-size: 12px; }
.page-caption, .engraved-label { color: #c5cad2; font-size: 11px; letter-spacing: 0.08em; text-align: center; }

.master-rhythm-bank { pointer-events: none; }
.master-rhythm-bank :deep(button),
.master-rhythm-bank :deep(.hardware-knob-wrapper) { pointer-events: auto; }
.output-control { position: absolute; top: 11px; left: 771px; display: grid; justify-items: center; gap: 0; width: 66px; }
.output-control .engraved-label { position: absolute; top: -20px; left: -18px; display: grid; width: 102px; font-size: 11px; line-height: 1.05; }
.output-control :deep(.hardware-knob-wrapper) { width: 66px; min-height: 78px; gap: 2px; }
.output-control :deep(.knob-stage),
.output-control :deep(.led-ring) { width: 66px; height: 66px; }
.output-control :deep(.knob-stage) { position: relative !important; }
.output-control :deep(.led-ring) { position: absolute !important; inset: 0 !important; }
.output-control :deep(.knob-cap) { z-index: 1; }
.output-control :deep(.knob-label) { color: #e0e3e8; font-size: 11px; }
.rhythm-control-bank { position: absolute; inset: 0; display: block; }
.rhythm-control-bank .engraved-label { position: absolute; top: 94px; left: 774px; width: 60px; font-size: 11px; }
.rhythm-control-bank :deep(.hardware-button) { position: absolute; height: 32px; padding: 0 5px; font-size: 12px; }
.rhythm-control-bank :deep([data-panel-control="rhythm-edit"]) { top: 117px; left: 784px; width: 40px; min-width: 40px; height: 40px; border-radius: 50%; padding: 0; }
.rhythm-control-bank :deep([data-panel-control="rhythm-start"]) { top: 199px; left: 778px; width: 52px; min-width: 52px; }
.rhythm-control-bank :deep([data-panel-control="tap-tempo"]) { top: 199px; left: 665px; width: 50px; min-width: 50px; }
.rhythm-control-bank :deep(.button-label) { font-size: 12px; }
.rhythm-control-bank :deep([data-panel-control="rhythm-start"] .button-label) { white-space: pre-line; line-height: 0.95; letter-spacing: 0.04em; }
.transport-bank :deep(.hardware-button) { position: absolute; height: 32px; }
.transport-bank :deep([data-panel-control="menu"]) { top: 49px; left: 183px; width: 54px; min-width: 54px; }
.transport-bank :deep([data-panel-control="loop"]) { top: 115px; left: 183px; width: 54px; min-width: 54px; }
.transport-bank :deep([data-panel-control="all-transport"]) { top: 199px; left: 14px; width: 78px; min-width: 78px; }
.transport-bank :deep([data-panel-control="undo-redo"]) { top: 199px; left: 130px; width: 80px; min-width: 80px; }
.transport-bank :deep(.button-label) { font-size: 12px; }
.transport-bank :deep([data-panel-control="all-transport"] .button-label) { white-space: pre-line; line-height: .95; }

/* Fixed centers, broader passive capsule housings; no LED state override. */
.transport-bank :deep([data-panel-control="menu"] .button-label),
.transport-bank :deep([data-panel-control="loop"] .button-label) { transform: translateX(-6px); font-size: 11px; letter-spacing: .03em; }
.transport-bank :deep([data-panel-control="menu"]),
.transport-bank :deep([data-panel-control="loop"]) { width: 82px; min-width: 82px; margin-left: -14px; border-radius: 22px !important; padding: 0 27px 0 3px; border: 1px solid #b6bcc5; box-shadow: inset 0 0 0 3px #121519,0 2px 3px #000; }
.transport-bank :deep([data-panel-control="menu"]::after),
.transport-bank :deep([data-panel-control="loop"]::after) { content: ''; position: absolute; right: 5px; width: 23px; height: 23px; border-radius: 50%; border: 2px solid #080a0d; background: radial-gradient(circle at 40% 30%,#404650,#20252c); pointer-events: none; }
.transport-bank :deep([data-panel-control="all-transport"]),
.transport-bank :deep([data-panel-control="undo-redo"]),
.rhythm-control-bank :deep([data-panel-control="tap-tempo"]),
.rhythm-control-bank :deep([data-panel-control="rhythm-start"]) { border-radius: 24px !important; border: 3px solid #9ca5b1; box-shadow: inset 0 0 0 3px #11151b,0 0 0 3px #090b0f,0 3px 4px #000; }


/* Monochrome negative-polarity blue LCD; geometry and text sizes are unchanged. */
.lcd-display { --lcd-ink: #eef0ff; --lcd-muted: #c0c8e8; --lcd-selection: #e3e8ff; --lcd-selection-ink: #20245f; --lcd-line: #adb8e5; background: linear-gradient(180deg,#24266c,#343282 55%,#25235f); color: var(--lcd-ink); box-shadow: inset 0 0 8px #11133a; }
.lcd-row.top,.lcd-data-rows,.lcd-parameter-row,.lcd-track-line,.lcd-status { color: var(--lcd-ink); }
.lcd-data-row.is-selected { color: var(--lcd-selection-ink); background: var(--lcd-selection); }
.lcd-data-row.is-disabled { color: var(--lcd-muted); }
.page-navigation :deep(.hardware-button) { width: 32px; min-width: 32px; margin-left: 13px; border-radius: 50% !important; padding: 0; }
.page-navigation :deep(.button-label) { position: absolute; bottom: 37px; white-space: nowrap; font-size: 11px; }
.page-navigation :deep(.led-dot) { display: none; }
.write-caption { top: 63px; font-size: 9px; }
.page-navigation :deep([data-panel-control="page-prev"] .button-label),
.page-navigation :deep([data-panel-control="page-next"] .button-label) { font-size: 17px; }

</style>
