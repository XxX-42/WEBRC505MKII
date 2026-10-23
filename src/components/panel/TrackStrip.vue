<template>
  <section
    class="track-strip"
    :class="{ selected: isCurrentTrack, disabled: !trackTransportReady }"
    :data-track-id="trackId"
  >
    <header class="track-strip-header">
      <span class="track-label">{{ trackId }}</span>
      <span class="track-state">{{ stateLabel }}</span>
      <span v-if="disabledReason" class="track-note">{{ disabledReason }}</span>
      <span v-if="captureWarmupBlocksAction" class="track-note" data-testid="track-capture-warming" role="status">
        Shared input pre-roll is warming; record and overdub are temporarily unavailable.
      </span>
      <span v-if="trackFxDisabledReason" class="track-note" data-testid="track-fx-unavailable">{{ trackFxDisabledReason }}</span>
      <span v-if="trackLevelUnavailableReason" class="track-note" data-testid="track-level-unavailable">{{ trackLevelUnavailableReason }}</span>
      <span v-if="overdubDiagnostic" class="track-note track-warning" role="status" aria-live="polite">
        {{ overdubDiagnostic }}
      </span>
      <span v-if="recordingDiagnostic" class="track-note track-warning" data-testid="track-recording-diagnostic" role="status" aria-live="polite">
        {{ recordingDiagnostic }}
      </span>
    </header>

    <div class="track-top">
      <div class="track-button-stack">
        <HardwareButton
          shape="rect"
          size="sm"
          :led-color="resolvedControls.fx.ledColor"
          :led-on="resolvedControls.fx.ledOn"
          :disabled="!resolvedControls.fx.enabled"
          :disabled-reason="resolvedControls.fx.unavailableReason"
          label="FX"
          class="track-function-button"
          appearance="classic"
          data-track-control="fx"
          :aria-label="`Track ${trackId} ${resolvedControls.fx.hardwareRole}: ${resolvedControls.fx.unavailableReason}`"
          data-hardware-control="button"
          :data-hardware-role="resolvedControls.fx.hardwareRole"
          @press="handleTrackFx"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          :led-color="resolvedControls.track.ledColor"
          :led-on="resolvedControls.track.ledOn"
          :selected="resolvedControls.track.selected"
          :disabled="!resolvedControls.track.enabled"
          :disabled-reason="resolvedControls.track.unavailableReason"
          label="TRACK"
          class="track-function-button"
          appearance="classic"
          data-track-control="select"
          :data-phrase-status="audioEngine.getTrackHasPhrase?.(trackId) === null ? 'unknown' : audioEngine.getTrackHasPhrase?.(trackId) ? 'present' : 'empty'"
          :data-hardware-role="resolvedControls.track.hardwareRole"
          :aria-label="undoLayer ? `Track ${trackId} ${resolvedControls.track.hardwareRole}: ${resolvedControls.track.unavailableReason}` : trackButtonAriaLabel"
          data-hardware-control="button"
          @press="openTrackEditor"
        />
        <div class="clear-note">CLEAR: HOLD</div>
        <button
          class="stop-disc"
          :class="{ 'is-pressed': stopPressActive }"
          type="button"
          :disabled="!resolvedControls.stop.enabled"
          :data-hardware-role="resolvedControls.stop.hardwareRole"
          :title="resolvedControls.stop.unavailableReason || trackInteractionDisabledReason || 'Hold to clear this track'"
          :aria-label="undoLayer ? `Track ${trackId} MARK BACK unavailable` : 'Stop track (hold to clear)'"
          data-hardware-control="button"
          @pointerdown="handleStopPointerDown"
          @pointerup="handleStopPointerUp"
          @pointercancel="handleStopPointerCancel"
          @lostpointercapture="handleStopLostPointerCapture"
          @keydown.space.prevent="handleStopKeyDown"
          @keyup.space.prevent="handleStopKeyUp"
          @keydown.enter.prevent="handleStopKeyDown"
          @keyup.enter.prevent="handleStopKeyUp"
          @blur="cancelStopPress('keyboard')"
        >
          <span class="stop-square"></span>
        </button>
      </div>

      <div class="slider-column">
        <HardwareFader
          appearance="classic"
          :model-value="playLevel"
          :led-color="faderLedColor"
          :disabled="!levelControlEnabled"
          :disabled-reason="trackLevelUnavailableReason"
          :aria-label="levelControlAriaLabel"
          data-testid="track-level-fader"
          data-hardware-control="fader"
          label=""
          @update:model-value="handleLevelChange"
        />
      </div>
    </div>

    <div class="main-button-column">
      <div class="halo-wrapper">
        <LoopHalo :track-id="trackId" appearance="classic" indicator-mode="STATUS" :status-color="resolvedControls.record.ledColor" class="halo-layer" />
        <HardwareButton
          shape="circle"
          size="lg"
          :led-color="resolvedControls.record.ledColor"
          :led-on="resolvedControls.record.ledOn"
          :disabled="!resolvedControls.record.enabled"
          :disabled-reason="resolvedControls.record.unavailableReason || recordActionDisabledReason"
          :aria-label="undoLayer ? `Track ${trackId} ${resolvedControls.record.hardwareRole}` : 'Record or play track'"
          :data-hardware-role="resolvedControls.record.hardwareRole"
          appearance="classic"
          label="▶ / ●"
          data-panel-control="record-play"
          data-hardware-control="button"
          @press="handleTrackRecPlay"
        />
      </div>
      <div class="loop-indicator-row">
        <span class="indicator-chip" :class="{ active: trackState === TrackState.RECORDING }">REC</span>
        <span class="indicator-chip" :class="{ active: trackState === TrackState.PLAYING }">PLAY</span>
        <span class="indicator-chip" :class="{ active: trackState === TrackState.OVERDUBBING }">DUB</span>
      </div>
    </div>

  </section>


</template>

<script setup lang="ts">
import { assertTrackFxApplyConfirmed } from '../../audio/TrackFxApplyStatus';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { registerDeviceTrackController } from '../../composables/deviceTrackControllers';
import { AudioEngine } from '../../audio/AudioEngine';
import { TrackState } from '../../core/types';
import { useDevicePanel } from '../../composables/useDevicePanel';
import { useRc505Controls } from '../../composables/useRc505Controls';
import { useRc505Memory } from '../../composables/useRc505Memory';
import { resolveRc505TrackControls } from '../../ui/rc505/Rc505ControlStateResolver';
import { useTrackStripState } from '../../composables/useTrackStripState';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareFader from '../ui/HardwareFader.vue';
import LoopHalo from '../LoopHalo.vue';

const props = defineProps<{
  trackId: number;
}>();

const device = useDevicePanel();
const controls = useRc505Controls();
const semanticMemory = useRc505Memory();
const undoLayer = computed(() => controls.state.controlLayer === 'UNDO_REDO');
const audioEngine = AudioEngine.getInstance();
const audioStatusRevision = ref(0);
const controlOperationPending = ref(false);
const audioReady = computed(() => {
  audioStatusRevision.value;
  return audioEngine.getUiStatus().ready;
});
const trackDrawerOpen = computed(() => device.state.page === 'track' && device.currentTrackId.value === props.trackId);

const trackController = useTrackStripState(props.trackId);
const {
  trackState,
  runtimeRevision,
  playLevel,
  trackTransportEnabled,
  trackAvailable,
  disabledReason,
  overdubDiagnostic,
  recordingDiagnostic,
  isHqExporting,
  hqExportError,
  livePitchError,
  isCurrentTrack,
  faderLedColor,
  levelControlEnabled,
  levelControlAriaLabel,
  trackLevelUnavailableReason,
  trackButtonAriaLabel,
  handleRecPlay,
  handleLevelChange,
  handleTrackSelect,
  cancelStopPress,
  stopPressActive,
  handleStopPointerDown,
  handleStopPointerUp,
  handleStopPointerCancel,
  handleStopLostPointerCapture,
  handleStopKeyDown,
  handleStopKeyUp,
} = trackController;

const trackTransportReady = computed(() => trackTransportEnabled.value && audioReady.value);
const captureWarmupBlocksAction = computed(() => {
  audioStatusRevision.value;
  const status = audioEngine.getUiStatus();
  return audioEngine.getMode() === 'browser' && status.inputCaptureWarming === true
    && (trackState.value === TrackState.EMPTY || trackState.value === TrackState.PLAYING);
});
const recordActionReady = computed(() => trackTransportReady.value && !captureWarmupBlocksAction.value);
const trackInteractionDisabledReason = computed(() => audioReady.value
  ? disabledReason.value
  : audioEngine.getUiStatus().message || 'Start audio before using track transport.');
const recordActionDisabledReason = computed(() => captureWarmupBlocksAction.value
  ? 'Shared input capture pre-roll is warming. Recording and overdubbing are disabled until the input timeline is ready.'
  : trackInteractionDisabledReason.value);

const resolvedControls = computed(() => {
  audioStatusRevision.value;
  runtimeRevision.value;
  trackState.value;
  const history = audioEngine.getTrackHistoryStatus?.(props.trackId) ?? { canUndo: false, canRedo: false, busy: false };
  return resolveRc505TrackControls({
    state: trackState.value,
    hasPhrase: audioEngine.getTrackHasPhrase?.(props.trackId) ?? null,
    selected: isCurrentTrack.value, available: trackAvailable.value,
    ready: trackTransportReady.value, recordReady: recordActionReady.value,
    recordUnavailableReason: recordActionDisabledReason.value,
    layer: controls.state.controlLayer, history,
    mark: audioEngine.getMarkState?.(props.trackId), operationPending: controlOperationPending.value || semanticMemory.state.busy,
    fxApplyState: audioEngine.getTrackFxApply?.(props.trackId)[0], fxApplySupported: false, fxApplied: null,
  });
});
const trackFxDisabledReason = computed(() => resolvedControls.value.fx.unavailableReason);
async function handleTrackRecPlay(): Promise<void> {
  if (!resolvedControls.value.record.enabled) return;
  if (!undoLayer.value) { handleRecPlay(); return; }
  controlOperationPending.value = true;
  try {
    const history = audioEngine.getTrackHistoryStatus(props.trackId);
    const success = history.canUndo ? await audioEngine.undoTrack(props.trackId) : await audioEngine.redoTrack(props.trackId);
    if (!success) controls.reportError('HISTORY UNAVAILABLE');
  } catch (error) { controls.reportError(error instanceof Error ? error.message : 'HISTORY FAILED'); }
  finally { controlOperationPending.value = false; }
  audioStatusRevision.value += 1;
}

async function performMark(operation: 'set' | 'clear'): Promise<void> {
  if (controlOperationPending.value) return;
  controlOperationPending.value = true;
  try {
    const result = await (operation === 'set' ? audioEngine.setMark(props.trackId) : audioEngine.clearMark(props.trackId));
    if (!result.ok) controls.reportError('MARK FAILED', result.reason || 'The runtime did not confirm MARK.');
    else controls.clearError('general');
  } catch (error) { controls.reportError('MARK FAILED', error instanceof Error ? error.message : String(error)); }
  finally { controlOperationPending.value = false; audioStatusRevision.value += 1; }
}
async function handleTrackFx(): Promise<void> {
  if (!resolvedControls.value.fx.enabled) return;
  if (undoLayer.value) { await performMark('clear'); return; }
  controlOperationPending.value = true;
  try {
    const before = audioEngine.getTrackFxApply(props.trackId)[0];
    if (!before) throw new Error('Track FX routing is unavailable.');
    const result = await audioEngine.setTrackFxApply(props.trackId, !before.applied);
    assertTrackFxApplyConfirmed(result, !before.applied);
    controls.clearError('general');
  } catch (error) { controls.reportError('FX ROUTE FAILED', error instanceof Error ? error.message : String(error)); }
  finally { controlOperationPending.value = false; audioStatusRevision.value += 1; }
}
function openTrackEditor(): void {
  if (!resolvedControls.value.track.enabled) return;
  if (undoLayer.value) { void performMark('set'); return; }
  handleTrackSelect();
  device.classicDispatch({ type: 'OPEN_EDITOR', target: 'track', category: 'track' });
  device.openSelectedTrack();
}

watch([trackDrawerOpen, isHqExporting, hqExportError, livePitchError], ([open, exporting, exportError, pitchError]) => {
  if (!open) {
    device.clearPageStatus('track', props.trackId);
    return;
  }
  device.setPageActionStatus('track', {
    trackId: props.trackId,
    pending: exporting ? 'HQ WAV rendering is still running.' : '',
    error: exportError || pitchError || '',
  });
}, { immediate: true });

let unsubscribeAudioStatus: (() => void) | undefined;
let unregisterTrackController: (() => void) | undefined;
onMounted(() => {
  unregisterTrackController = registerDeviceTrackController(props.trackId, trackController);
  unsubscribeAudioStatus = audioEngine.onStatusChange(() => { audioStatusRevision.value += 1; });
});
onUnmounted(() => { unsubscribeAudioStatus?.(); unregisterTrackController?.(); });

const stateLabel = computed(() => {
  switch (trackState.value) {
    case TrackState.EMPTY:
      return 'EMPTY';
    case TrackState.RECORDING:
      return 'RECORD';
    case TrackState.PLAYING:
      return 'PLAY';
    case TrackState.OVERDUBBING:
      return 'OVERDUB';
    case TrackState.STOPPED:
      return 'STOP';
    case TrackState.REC_STANDBY:
      return 'STANDBY';
    case TrackState.REC_FINISHING:
      return 'FINISH';
    default:
      return trackState.value;
  }
});
</script>

<style scoped>
.track-strip {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 385px;
  padding: 9px 9px 12px;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  border-right: 1px solid rgba(0, 0, 0, 0.86);
  background:
    linear-gradient(115deg, transparent 0 67%, rgba(255,255,255,.018) 67.2% 67.5%, transparent 67.7%),
    linear-gradient(180deg, #26252b 0%, #17171c 42%, #111115 100%);
  color: #f4f4f7;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.track-strip.selected {
  box-shadow: inset 0 0 0 1px rgba(255, 72, 115, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.track-strip.disabled {
  opacity: 0.84;
}

.track-warning {
  color: #ffd166;
}

.track-strip-header {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 40px;
  max-height: 58px;
  overflow: hidden;
}

.track-label,
.track-state,
.track-note,
.indicator-chip,
.clear-note {
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.track-label {
  font-size: 29px;
  letter-spacing: 1px;
  line-height: 1;
}

.track-state,
.track-note,
.clear-note {
  font-size: 10px;
  letter-spacing: 1.1px;
  color: rgba(255, 255, 255, 0.62);
}

.track-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.track-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 56px;
  justify-content: space-between;
  gap: 8px;
  align-items: start;
}

.track-button-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

:deep(.track-button-stack > .track-function-button.hardware-button) {
  flex: 0 0 80px;
  width: 80px;
  height: 28px;
  min-width: 0;
  padding: 0 12px;
  border-radius: 999px;
  background: linear-gradient(180deg, #5b5e64 0%, #24262b 56%, #101115 100%);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.14), 0 2px 4px rgba(0, 0, 0, 0.72);
}

:deep(.track-button-stack > .track-function-button .button-label) {
  color: #d6d9de;
  font-size: 9px;
  letter-spacing: 0.12em;
}

.stop-disc {
  width: 48px;
  height: 48px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid rgba(210, 220, 235, 0.82);
  background: radial-gradient(circle at 35% 30%, #31343a 0%, #191b21 72%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
  cursor: pointer;
  touch-action: none;
}

.stop-disc:hover:not(:disabled) { border-color: #fff; background: radial-gradient(circle at 35% 30%, #444850 0%, #191b21 72%); }
.stop-disc:focus-visible { outline: 3px solid #6bc5ff; outline-offset: 3px; }
.stop-disc:disabled { opacity: 0.62; cursor: not-allowed; }
.stop-disc:active:not(:disabled) { transform: translateY(1px); }

.stop-disc .stop-square {
  width: 12px;
  height: 12px;
}

.stop-square {
  display: block;
  width: 16px;
  height: 16px;
  margin: auto;
  background: #d7dee9;
}

.slider-column {
  height: 112px;
  padding-top: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(0, 0, 0, 0.28) 100%);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 8px rgba(0, 0, 0, 0.18);
}

.main-button-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
}

.halo-wrapper {
  position: relative;
  display: grid;
  place-items: center;
  width: 220px;
  height: 220px;
}

.halo-wrapper::before {
  content: '';
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  border: 7px solid rgba(15, 15, 18, 0.96);
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.08),
    0 10px 18px rgba(0, 0, 0, 0.34);
}

.halo-wrapper::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.06);
}

.halo-layer {
  position: absolute;
  inset: 0;
}

:deep(.halo-layer.loop-halo-container) { width: 100%; height: 100%; }
:deep(.halo-wrapper > .hardware-button.shape-circle.size-lg) { width: 126px; height: 126px; }

.loop-indicator-row {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  justify-content: center;
}

.indicator-chip {
  min-width: 40px;
  min-height: 20px;
  padding: 3px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.72);
  text-align: center;
  font-size: 9px;
  letter-spacing: 1px;
}

.indicator-chip.active {
  color: var(--led-red-recording);
  box-shadow: 0 0 0 1px rgba(255, 0, 51, 0.18) inset;
}

.keep-pitch-panel {
  display: grid;
  gap: 7px;
  padding: 9px;
  border: 1px solid rgba(77, 191, 255, 0.26);
  border-radius: 8px;
  background: rgba(4, 15, 24, 0.68);
  font-family: var(--font-hardware);
}

.keep-pitch-title {
  color: #8fd7ff;
  font-size: 14px;
  letter-spacing: 0.9px;
}

.keep-pitch-panel label {
  display: grid;
  gap: 3px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 13px;
}

.keep-pitch-panel input,
.keep-pitch-panel select {
  width: 100%;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  background: #111217;
  color: #f4f4f7;
  font: 14px var(--font-hardware);
}

.keep-pitch-panel input:disabled,
.keep-pitch-panel select:disabled {
  opacity: 0.45;
}

.keep-pitch-status,
.keep-pitch-warning,
.keep-pitch-latency,
.keep-pitch-note,
.keep-pitch-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.keep-pitch-status,
.keep-pitch-note,
.keep-pitch-latency {
  color: rgba(255, 255, 255, 0.62);
}

.keep-pitch-warning {
  color: #ffd166;
}

.keep-pitch-error {
  color: #ff9b9b;
}

.hq-export-panel {
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.28);
  font-family: var(--font-hardware);
}

.hq-export-panel summary {
  padding: 8px 10px;
  color: rgba(255, 255, 255, 0.78);
  font-size: 14px;
  letter-spacing: 0.9px;
  cursor: pointer;
}

.hq-export-controls {
  display: grid;
  gap: 8px;
  padding: 0 9px 10px;
}

.hq-export-note,
.hq-export-status,
.hq-export-error {
  margin: 0;
  font-family: var(--font-hardware);
  font-size: 12px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.62);
}

.track-utility-drawer { display: grid; gap: 14px; max-width: 780px; margin-inline: auto; }
.drawer-track-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  color: #bdc5cf;
  background: rgba(0, 0, 0, 0.2);
  font: 13px var(--font-hardware);
  letter-spacing: 0.1em;
}
.drawer-track-summary strong { color: #f5f6f7; font-size: 16px; }

.hq-export-controls label {
  display: grid;
  gap: 3px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}

.hq-export-controls input,
.hq-export-controls select {
  width: 100%;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  background: #111217;
  color: #f4f4f7;
  font: 14px var(--font-hardware);
}

.hq-export-controls button {
  min-height: 30px;
  border: 1px solid rgba(77, 191, 255, 0.48);
  border-radius: 5px;
  background: linear-gradient(180deg, #174567 0%, #0e2b43 100%);
  color: white;
  font: 13px var(--font-hardware);
  letter-spacing: 0.4px;
  cursor: pointer;
}

.hq-export-controls button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.hq-export-error {
  color: #ff9b9b;
  overflow-wrap: anywhere;
}

:deep(.slider-column .hardware-fader) {
  gap: 0;
}

:deep(.slider-column .fader-track-container) {
  min-height: 100px;
  gap: 2px;
}

:deep(.slider-column .led-strip) {
  width: 2px;
}

:deep(.slider-column .fader-groove) {
  width: 11px;
  border-radius: 2px;
  background: #06070a;
  box-shadow:
    inset 0 1px 6px rgba(0, 0, 0, 0.94),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

:deep(.slider-column .fader-cap) {
  width: 28px;
  height: 14px;
  border-radius: 2px;
  background: linear-gradient(180deg, #f8fbff 0%, #7d8494 100%);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.7),
    inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

:deep(.slider-column .cap-ridge) {
  width: 19px;
  background: rgba(0, 0, 0, 0.28);
}

:deep(.slider-column .fader-value) {
  display: none;
}

/* Manual-aligned five-track face geometry: the top section ends at y=321. */
.track-strip {
  position: relative;
  display: block;
  box-sizing: border-box;
  width: 275px;
  height: 520px;
  min-height: 520px;
  padding: 0;
  overflow: hidden;
}
.track-strip-header {
  position: absolute;
  top: 12px;
  left: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 86px;
  min-height: 26px;
  max-height: 34px;
  overflow: hidden;
  text-align: center;
}
.track-strip-header .track-state { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
.track-label { font-size: 17px; line-height: 1; }
.track-state { font-size: 12px; line-height: 1; letter-spacing: 0.03em; }
.track-note { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.track-top,
.track-button-stack { position: absolute; inset: 0; display: block; }
.track-top,
.track-button-stack,
.main-button-column,
.halo-wrapper { pointer-events: none; }
.track-strip :deep(button),
.slider-column,
.track-strip :deep(.hardware-fader) { pointer-events: auto; }
.track-button-stack > :deep([data-track-control="fx"]),
.track-button-stack > :deep([data-track-control="select"]) {
  position: absolute !important;
  left: 35px;
  box-sizing: border-box;
  width: 80px !important;
  min-width: 80px !important;
  height: 36px !important;
  min-height: 36px !important;
  padding: 0 8px !important;
  border-radius: 5px !important;
  background: linear-gradient(180deg, #5c6067 0%, #30333a 56%, #191b20 100%) !important;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.18), 0 2px 4px rgba(0, 0, 0, 0.72) !important;
}
.track-button-stack > :deep([data-track-control="fx"]) { top: 48px; }
.track-button-stack > :deep([data-track-control="select"]) { top: 114px; }
.track-button-stack > :deep([data-track-control="fx"] .button-label),
.track-button-stack > :deep([data-track-control="select"] .button-label) {
  color: #d6d9de;
  font-size: 12px;
  letter-spacing: 0.12em;
}
.track-button-stack > :deep(.appearance-classic.is-pressed:not(.is-disabled)) {
  transform: translateY(1px);
  box-shadow: inset 0 3px 6px rgba(0,0,0,.65), 0 1px 2px rgba(0,0,0,.6) !important;
}
.clear-note { position: absolute; top: 183px; left: 35px; width: 80px; color: #e3e6eb; font-size: 11px; line-height: 1; letter-spacing: 0.03em; text-align: center; }
.track-button-stack > .stop-disc { position: absolute; top: 212px; left: 51px; width: 48px; height: 48px; }
.track-button-stack > .stop-disc.is-pressed:not(:disabled) {
  transform: translateY(1px);
  background: radial-gradient(circle at 34% 28%, #23262c, #101217 75%);
  box-shadow: inset 0 3px 7px rgba(0,0,0,.8), 0 1px 2px #000;
}
.slider-column {
  position: absolute;
  top: 65px;
  left: 185.5px;
  display: block;
  box-sizing: border-box;
  width: 36px;
  height: 180px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
:deep(.slider-column .hardware-fader) { width: 100%; height: 180px; min-height: 180px; gap: 0; }
:deep(.slider-column .fader-track-container) { box-sizing: border-box; width: 100%; height: 180px; min-height: 180px; flex: 0 0 180px; gap: 5px; }
:deep(.slider-column .led-strip) { width: 2px; border-radius: 1px; }
:deep(.slider-column .fader-groove) { width: 10px; border-radius: 2px; }
:deep(.slider-column .fader-cap) { width: 28px; height: 14px; }
.main-button-column { position: absolute; inset: 0; display: block; margin: 0; }
.halo-wrapper {
  position: absolute;
  top: 280px;
  left: 26px;
  display: grid;
  place-items: center;
  width: 203px;
  height: 203px;
}
.halo-wrapper::before { inset: 4px; border-width: 7px; pointer-events: none; }
.halo-wrapper::after { inset: 0; border-width: 3px; pointer-events: none; }
.halo-layer,
:deep(.halo-layer.loop-halo-container) {
  position: absolute !important;
  inset: 0 !important;
  box-sizing: border-box;
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  pointer-events: none !important;
}
.halo-layer :deep(svg),
.halo-layer :deep(canvas) { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; pointer-events: none !important; }
.halo-wrapper > :deep([data-panel-control="record-play"]) {
  position: relative;
  z-index: 3;
  width: 129px !important;
  min-width: 129px !important;
  height: 129px !important;
  min-height: 129px !important;
  pointer-events: auto;
}
.halo-wrapper > :deep([data-panel-control="record-play"] .button-label) {
  position: relative;
  z-index: 4;
  margin: 0;
  color: #ffffff;
  font: 700 28px/1 var(--font-hardware);
  letter-spacing: 0.05em;
  text-shadow: 0 1px 2px #050609;
  pointer-events: none;
}
.loop-indicator-row { position: absolute; top: 267px; left: 44px; display: flex; gap: 7px; width: 170px; justify-content: center; }
.loop-indicator-row { width: 1px !important; height: 1px !important; overflow: hidden !important; clip: rect(0,0,0,0) !important; clip-path: inset(50%); white-space: nowrap; }
.indicator-chip { min-width: auto; min-height: 0; padding: 1px 2px; border: 0; border-radius: 0; background: transparent; font-size: 11px; line-height: 1; letter-spacing: 0.06em; }
.indicator-chip.active { box-shadow: none; text-shadow: 0 0 7px currentColor, 0 0 14px currentColor; }
.indicator-chip:nth-child(1).active { color: #ff596b; }
.indicator-chip:nth-child(2).active { color: #52ef91; }
.indicator-chip:nth-child(3).active { color: #ffc34a; }
/* Complete front reference, normalized to the 1520 x 846 face.
   The photograph is not calibrated; lens colors remain engineering approximations. */
.track-strip-header { top: 279px; left: 32px; align-items: flex-start; }
.track-label { font-size: 29px; font-weight: 900; }
.track-button-stack > :deep([data-track-control="fx"]),
.track-button-stack > :deep([data-track-control="select"]) { border-radius: 22px !important; background: linear-gradient(#35363c,#17181d) !important; }
.track-button-stack > :deep([data-track-control="select"]) { top: 121px; }
.clear-note { top: 178px; }
.track-button-stack > .stop-disc { top: 197px; left: 35px; width: 80px; height: 80px; border-width: 6px; }
.stop-disc .stop-square { width: 17px; height: 17px; }
.slider-column { top: 29px; left: 166px; width: 73px; height: 248px; background: linear-gradient(90deg,#292b30,#08090b 15% 85%,#34363c); border-top: 6px solid #0a0b0d; border-bottom: 9px solid #33353b; }
:deep(.slider-column .hardware-fader) { height: 233px; min-height: 233px; }
:deep(.slider-column .fader-track-container) { height: 233px; min-height: 233px; flex: 0 0 233px; }
:deep(.slider-column .led-strip) { opacity: 0; }
:deep(.slider-column .fader-groove) { width: 16px; }
:deep(.slider-column .fader-cap) { width: 73px !important; height: 36px !important; background: linear-gradient(#25272b 0 42%,#d9dde3 43% 54%,#1e2024 55%) !important; border: 1px solid #07080a; border-radius: 2px; }
:deep(.slider-column .cap-ridge) { opacity: 0; }
.halo-wrapper { top: 291px; left: 20px; width: 220px; height: 220px; }
.track-button-stack > :deep(.track-function-button .led-dot) { position: absolute; inset: 2px; width: auto; height: auto; margin: 0; border: 3px solid #8e929c; border-radius: inherit; background: transparent; box-shadow: inset 0 0 1px #15161b; pointer-events: none; }
.track-button-stack > :deep(.track-function-button .led-dot.led-red) { border-color: var(--led-red-recording); background: transparent; box-shadow: 0 0 4px var(--led-red-recording); }
.track-button-stack > :deep(.track-function-button .led-dot.led-green) { border-color: var(--led-green-playing); background: transparent; box-shadow: 0 0 4px var(--led-green-playing); }
.track-button-stack > :deep(.track-function-button .button-label) { position: relative; z-index: 1; }
:deep(.slider-column .fader-groove::before) { display: none; }
</style>
