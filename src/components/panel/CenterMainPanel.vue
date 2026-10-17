<template>
  <section class="center-main-panel" data-panel="center-main" aria-label="RC-505mkII center controls">
    <div class="transport-bank">
      <div class="center-control-stack">
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          label="MENU"
          :active="device.state.page === 'settings' || device.state.page === 'menu'"
          aria-label="Open menu"
          data-panel-control="menu"
          data-hardware-control="button"
          @press="device.openPage('menu')"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          label="LOOP"
          :active="device.state.page === 'track'"
          aria-label="Open selected track loop"
          data-testid="physical-loop-button"
          data-panel-control="loop"
          data-hardware-control="button"
          @press="device.openSelectedTrack"
        />
      </div>
      <div class="center-control-stack transport-buttons">
        <HardwareButton
          shape="rect"
          size="md"
          :color="isPlaying ? 'red' : 'green'"
          :active="isPlaying"
          :label="isPlaying ? 'ALL STOP' : 'ALL START'"
          :aria-label="isPlaying ? 'Stop all tracks' : 'Start all tracks'"
          data-panel-control="all-transport"
          :disabled="!audioReady"
          :disabled-reason="transportDisabledReason"
          data-hardware-control="button"
          @press="toggleAllTransport"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          color="yellow"
          label="UNDO/REDO"
          aria-label="Undo and redo are unavailable"
          :disabled="true"
          disabled-reason="Undo and redo require an audio history backend, which this runtime does not provide."
          data-panel-control="undo-redo"
          data-hardware-control="button"
        />
      </div>
    </div>

    <div class="display-cluster">
      <div class="screen-shell" aria-label="RC-505 status display">
        <div class="lcd-display" :class="{ 'lcd-editor-active': screenEditor.active.value }" data-testid="rc505-lcd-screen" @keydown.esc.stop.prevent="exitPage">
          <div class="lcd-row top">
            <span>BOSS RC-505mkII</span>
            <span>{{ pageLabel }}<template v-if="screenEditor.active.value"> {{ screenEditor.pageIndex.value + 1 }}/{{ screenEditor.pageCount.value }}</template></span>
          </div>
          <div v-if="!screenEditor.active.value" class="lcd-main">{{ bpmDisplay }}</div>
          <div class="lcd-name">{{ pageTitle }}</div>
          <div class="lcd-row lcd-track-line">
            <span>TR {{ currentTrackId }} · {{ selectedTrackState }}</span>
            <span>{{ bpmDisplay }} BPM</span>
          </div>
          <LcdFieldGrid v-if="screenEditor.active.value" :fields="screenFields" :selected-index="screenEditor.selectedFieldIndex.value"
            @select="screenEditor.selectField" @update="setScreenField" @activate="activateScreenField" />
          <div v-else class="lcd-parameter-row" aria-label="Current screen controls">
            <span v-for="(field, index) in screenFields" :key="field.key">{{ index + 1 }} {{ field.label }} {{ displayFieldValue(field) }}</span>
          </div>
          <div class="lcd-status" role="status" aria-live="polite" :title="statusHint">{{ statusHint }}</div>
          <div id="rc505-lcd-confirmations" class="lcd-confirmations"></div>
        </div>
      </div>

      <div class="soft-control-row" aria-label="Screen controls">
        <div v-for="(field, index) in screenFields" :key="field.key" class="soft-field">
          <HardwareKnob
            :model-value="field.value"
            :label="field.label"
            :color="field.color"
            :size="55"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            :disabled="field.disabled || field.kind === 'action'"
            :disabled-reason="field.kind === 'action' ? 'Use the command on the LCD or select it and press ENTER.' : field.reason"
            :aria-label="`${field.label} screen control`"
            data-hardware-control="knob"
            @update:model-value="setScreenField(index, $event)"
          />
          <span class="soft-value">{{ displayFieldValue(field) }}</span>
        </div>
      </div>

      <div class="page-navigation">
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          label="EXIT"
          aria-label="Exit current page"
          data-panel-control="exit"
          data-hardware-control="button"
          @press="exitPage"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          color="blue"
          label="ENTER"
          aria-label="Enter selected page"
          data-panel-control="enter"
          data-hardware-control="button"
          @press="enterPage"
        />
        <span class="page-caption">PAGE</span>
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          label="K ‹"
          aria-label="Previous display page"
          data-panel-control="page-prev"
          data-hardware-control="button"
          @press="changeScreenPage(-1)"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          label="J ›"
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
          label="MASTER"
          color="red"
          :size="66"
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
          color="white"
          label="EDIT"
          aria-label="Edit rhythm settings"
          :active="device.state.page === 'rhythm'"
          data-testid="rhythm-edit-button"
          data-panel-control="rhythm-edit"
          data-hardware-control="button"
          @press="device.openPage('rhythm')"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          :color="isRhythmPlaying ? 'red' : 'white'"
          :active="isRhythmPlaying"
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
          color="blue"
          :active="tapActive"
          label="TAP TEMPO"
          aria-label="Tap tempo"
          data-panel-control="tap-tempo"
          data-hardware-control="button"
          @press="handleTap"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import { DRUM_KIT_CATALOG, RHYTHM_PATTERN_CATALOG } from '../../audio/rhythm';
import { Transport } from '../../core/Transport';
import { TrackState, TransportState } from '../../core/types';
import { usePanelFocus } from '../../composables/usePanelFocus';
import { useDevicePanel } from '../../composables/useDevicePanel';
import { useDeviceScreenEditor, type DeviceScreenField } from '../../composables/useDeviceScreenEditor';
import { useFxPanelState } from '../../composables/useFxPanelState';
import { useTrackFxTargetState } from '../../composables/useTrackFxTargetState';
import { rhythmUiState, useRhythmUiControls } from '../../composables/rhythmUiState';
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
const inputBank = useFxPanelState('input');
const trackBank = useTrackFxTargetState();
const screenEditor = useDeviceScreenEditor({
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
const selectedTrackState = ref(engine.tracks[focusState.currentTrackId - 1]?.state ?? TrackState.EMPTY);
const pageActionHint = ref('');
const capabilityRevision = ref(0);
const { isPlaying: isRhythmPlaying, volume: rhythmVolume, disabled: rhythmDisabled, pending: rhythmPending, message: rhythmMessage, toggleRhythm, updateVolume, updateSelection } = useRhythmUiControls({ initializeOnMount: false });
let tapFlashTimer: number | null = null;
let tapResetTimer: number | null = null;
let unsubscribeStatus: (() => void) | null = null;
const tapTimes: number[] = [];

const bpmDisplay = computed(() => String(Math.round(bpm.value)).padStart(3, '0'));
const currentTrackId = computed(() => focusState.currentTrackId);
let screenOpener: HTMLElement | null = null;
watch(() => device.state.page, async (page, previous) => {
  pageActionHint.value = '';
  const editing = page !== 'home' && page !== 'mixer';
  const wasEditing = previous !== 'home' && previous !== 'mixer';
  if (editing && !wasEditing) screenOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (editing) {
    document.querySelector<HTMLElement>('[data-testid="rc505-lcd-screen"] select:not(:disabled), [data-testid="rc505-lcd-screen"] input:not(:disabled), [data-testid="rc505-lcd-screen"] button:not(:disabled)')?.focus({ preventScroll: true });
  } else if (wasEditing && screenOpener?.isConnected) screenOpener.focus({ preventScroll: true });
});
watch(() => [device.actionStatus.pending, device.actionStatus.error], ([pending, error]) => {
  if (!pending && !error && device.state.page === 'track') pageActionHint.value = '';
});
const pageLabel = computed(() => device.state.page.toUpperCase().replace('-', ' '));
const pageTitle = computed(() => screenEditor.active.value ? screenEditor.pageTitle.value : device.state.page === 'home'
  ? 'LIVE SESSION'
  : device.state.page === 'mixer'
    ? `TRACK ${currentTrackId.value} MIXER`
    : pageLabel.value);
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
const statusHint = computed(() => screenEditor.status.value || device.actionStatus.error || device.actionStatus.pending || pageActionHint.value || (rhythmPending.value
  ? 'RHYTHM COMMAND PENDING'
  : !audioReady.value
    ? uiStatus.value.message || 'AUDIO ENGINE NOT READY'
    : rhythmMessage.value || (isPlaying.value ? 'TRANSPORT RUNNING' : 'READY')));

type ScreenField = {
  key: string;
  label: string;
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

const activeInputFx = computed(() => inputBank.slots.value.find((slot) => slot.id === inputBank.activeSlot.value) ?? inputBank.slots.value[0]!);
const activeTrackFx = computed(() => trackBank.activeFx.value!);
const screenFields = computed<ScreenField[]>(() => {
  capabilityRevision.value;
  if (screenEditor.active.value) return screenEditor.fields.value.map((field) => ({
    min: 0, max: 100, step: 1, color: 'blue' as const, disabled: false,
    ...field, reason: field.disabled ? field.reason ?? '' : '', setValue: field.setValue ?? (() => undefined),
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
    color: 'green', disabled: !engine.getTrackCapabilities(currentTrackId.value).supportsTrackLevel,
    reason: engine.getTrackCapabilities(currentTrackId.value).supportsTrackLevel ? '' : levelReason,
  });
  const fxApplyField = () => field('track-fx-apply', 'FX APPLY', 0, setTrackFxApply, {
    color: 'red', disabled: true,
    reason: 'The shared Track FX bank has no per-track apply route. Use the independent Track FX target editor.',
    format: () => '—',
  });
  const outputField = () => field('master-out', 'MASTER OUT', outputLevel.value, setOutputLevel, {
    color: 'red', disabled: outputDisabled.value, reason: outputDisabledReason.value,
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

function displayFieldValue(field: ScreenField): string {
  return field.format ? field.format(field.value) : `${Math.round(field.value)}${field.max === 100 ? '%' : ''}`;
}
function setScreenField(index: number, value: number): void {
  if (screenEditor.active.value) screenEditor.selectField(index);
  if (screenFields.value[index]?.disabled) return;
  screenFields.value[index]?.setValue(value);
}
function activateScreenField(index: number): void {
  screenEditor.selectField(index);
  screenEditor.enter();
}
function changeScreenPage(direction: -1 | 1): void {
  if (screenEditor.active.value) screenEditor.stepPage(direction);
  else device.changePage(direction);
}
function exitPage(): void {
  if (document.querySelector('#rc505-lcd-confirmations [role="alertdialog"]')) {
    window.dispatchEvent(new Event('rc505-cancel-confirmation'));
    return;
  }
  if (screenEditor.active.value) screenEditor.exit();
  else device.backPage();
}
function setTrackLevel(value: number): void {
  const currentTrack = engine.tracks[currentTrackId.value - 1];
  if (!currentTrack || !engine.getTrackCapabilities(currentTrackId.value).supportsTrackLevel) return;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  trackLevel.value = bounded;
  currentTrack.track.playLevel = bounded;
  currentTrack.updateSettings();
}
function setTrackFxApply(): void {}

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
  transport.setBpm(Math.round(value));
  bpm.value = transport.bpm;
}
function setRhythmVolume(value: number): void {
  rhythmVolume.value = Math.max(0, Math.min(100, Math.round(value)));
  void updateVolume();
}
function setOutputLevel(value: number): void {
  if (outputDisabled.value) return;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  outputLevel.value = bounded;
  engine.setOutputLevel(bounded);
}

function toggleAllTransport(): void {
  if (!audioReady.value) return;
  if (isPlaying.value) engine.stopAllTracks();
  else engine.playAllTracks();
  window.setTimeout(syncPlaybackState, 0);
}

function enterPage(): void {
  if (document.querySelector('#rc505-lcd-confirmations [role="alertdialog"]')) {
    window.dispatchEvent(new Event('rc505-accept-confirmation'));
    return;
  }
  if (screenEditor.active.value) { screenEditor.enter(); return; }
  pageActionHint.value = '';
  if (device.state.page === 'home') device.openPage('mixer');
  else if (device.state.page === 'mixer') device.openSelectedTrack();

}

function handleTap(): void {
  tapActive.value = true;
  if (tapFlashTimer !== null) window.clearTimeout(tapFlashTimer);
  tapFlashTimer = window.setTimeout(() => { tapActive.value = false; tapFlashTimer = null; }, 100);

  const now = Date.now();
  tapTimes.push(now);
  if (tapTimes.length > 4) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const intervals = tapTimes.slice(1).map((time, index) => time - tapTimes[index]!);
    const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const nextBpm = Math.round(60000 / average);
    if (nextBpm >= 40 && nextBpm <= 300) setBpm(nextBpm);
  }

  if (tapResetTimer !== null) window.clearTimeout(tapResetTimer);
  tapResetTimer = window.setTimeout(() => { tapTimes.length = 0; tapResetTimer = null; }, 3000);
}

function syncTrackLevel(): void {
  trackLevel.value = engine.tracks[currentTrackId.value - 1]?.track.playLevel ?? 100;
  selectedTrackState.value = engine.tracks[currentTrackId.value - 1]?.state ?? TrackState.EMPTY;
}

let trackLevelTimer: number | null = null;

onMounted(() => {
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
  transport.off('bpm-change', syncBpm);
  transport.off('start', syncPlaybackState);
  transport.off('stop', syncPlaybackState);
  if (tapFlashTimer !== null) window.clearTimeout(tapFlashTimer);
  if (tapResetTimer !== null) window.clearTimeout(tapResetTimer);
  if (trackLevelTimer !== null) window.clearInterval(trackLevelTimer);
  unsubscribeStatus?.();
});
</script>

<style scoped>
.center-main-panel {
  position: relative;
  display: block;
  box-sizing: border-box;
  height: 269px;
  min-width: 830px;
  padding: 0;
  color: #f0f2f5;
  background: linear-gradient(180deg, #24262b 0%, #18191d 100%);
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
  height: 135px;
  padding: 6px;
  overflow: hidden;
  border: 2px solid #c0c3c9;
  border-radius: 5px;
  background: linear-gradient(160deg, #d9dce1, #8e949d);
  box-shadow: inset 0 1px 2px white, 0 3px 7px rgba(0, 0, 0, 0.28);
}
.lcd-display {
  position: relative;
  pointer-events: auto;
  display: grid;
  box-sizing: border-box;
  grid-template-rows: 11px 22px 14px 12px 22px 22px;
  gap: 1px;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 3px;
  background: linear-gradient(180deg, #c6c0cf 0%, #b3adbf 100%);
  color: #211e28;
  box-shadow: inset 0 0 10px rgba(31, 26, 43, 0.25);
  text-transform: uppercase;
}
.screen-shell:has(.lcd-editor-active) { height: 147px; }
.lcd-display.lcd-editor-active { grid-template-rows: 11px 16px 11px minmax(0, 1fr) 16px; gap: 1px; }
.lcd-editor-active .lcd-name { font-size: 13px; line-height: 16px; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lcd-editor-active .lcd-status { display: block; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
.lcd-confirmations { position: absolute; inset: 0; z-index: 8; pointer-events: none; }
.lcd-confirmations:not(:empty) { pointer-events: auto; }
.lcd-row { display: flex; justify-content: space-between; gap: 8px; min-width: 0; font-size: 11px; line-height: 1; letter-spacing: 0.06em; }
.lcd-row.top { color: #514c5b; }
.lcd-parameter-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); align-items: center; gap: 1px 8px; overflow: hidden; color: #292633; font-size: 11px; line-height: 1; white-space: normal; }
.lcd-parameter-row span { min-width: 0; overflow-wrap: anywhere; }
.lcd-main { align-self: center; font-size: 24px; font-weight: 700; line-height: 0.9; text-align: center; }
.lcd-name { font-size: 14px; line-height: 1; letter-spacing: 0.12em; text-align: center; }
.lcd-track-line { color: #292633; }
.lcd-status { display: -webkit-box; min-height: 0; overflow: hidden; color: #244832; font-size: 11px; line-height: 1; letter-spacing: 0.04em; text-align: center; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }

.soft-control-row { position: absolute; inset: 0; display: block; width: auto; }
.soft-field { position: absolute; top: 185px; display: grid; justify-items: center; gap: 0; width: 64px; min-width: 64px; }
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
.page-caption { position: absolute; top: 115px; left: 636px; width: 60px; color: #c5cad2; font-size: 11px; letter-spacing: 0.08em; text-align: center; }
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
</style>
