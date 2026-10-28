<template>
  <div class="track-unit" :class="{ disabled: !trackAvailable }" :data-track-id="trackId">
    <div class="track-header">
      <span class="track-id">TRACK {{ trackId }}</span>
      <span v-if="disabledReason" class="track-note">{{ disabledReason }}</span>
      <span v-if="captureWarmupBlocksAction" class="track-note" data-testid="track-capture-warming" role="status">
        Shared input pre-roll is warming; record and overdub are temporarily unavailable.
      </span>
      <div v-if="capabilityNotes.length > 0" class="track-capability-row">
        <span v-for="note in capabilityNotes" :key="note" class="track-capability-chip">
          {{ note }}
        </span>
      </div>
    </div>

    <div class="upper-deck">
      <div class="left-controls">
        <div class="knobs-row">
          <HardwareKnob
            :model-value="filterFreq"
            @update:modelValue="handleFilterFreqChange"
            :min="0"
            :max="100"
            label="FREQ"
            aria-label="Track filter frequency"
            color="blue"
            :size="40"
            :disabled="!filterControlsEnabled"
            :disabled-reason="filterButtonAriaLabel"
          />
          <HardwareKnob
            :model-value="filterRes"
            @update:modelValue="handleFilterResChange"
            :min="0"
            :max="10"
            label="RES"
            aria-label="Track filter resonance"
            color="blue"
            :size="40"
            :disabled="!filterControlsEnabled"
            :disabled-reason="filterButtonAriaLabel"
          />
        </div>

        <div class="buttons-row">
          <HardwareButton
            label="FX"
            shape="rect"
            size="sm"
            :color="isFilterActive ? 'blue' : 'neutral'"
            :active="isFilterActive"
            :aria-label="filterButtonAriaLabel"
            :disabled="!filterControlsEnabled"
            @press="toggleFilter"
            class="ctrl-btn"
          />
          <HardwareButton
            label="TRACK"
            shape="rect"
            size="sm"
            :color="isReverse ? 'purple' : 'neutral'"
            :active="isReverse"
            :aria-label="reverseButtonAriaLabel"
            :disabled="!reverseControlEnabled"
            @press="handleReverseToggle"
            class="ctrl-btn"
          />
        </div>
      </div>

      <div class="right-fader">
        <HardwareFader
          :model-value="playLevel"
          @update:modelValue="handleLevelChange"
          :led-color="faderLedColor"
          label="LEVEL"
          :disabled="!levelControlEnabled"
          :disabled-reason="levelControlAriaLabel"
          :aria-label="levelControlAriaLabel"
        />
      </div>
    </div>

    <div class="lower-deck">
      <div class="stop-wrapper">
        <HardwareButton
          label="STOP"
          shape="rect"
          size="sm"
          color="red"
          :aria-label="stopButtonAriaLabel"
          :disabled="!trackTransportEnabled"
          @press="startStopPress"
          @release="endStopPress"
          @cancel="cancelStopPress"
          class="ctrl-btn stop-btn"
        />
      </div>

      <div class="halo-wrapper">
        <LoopHalo :trackId="trackId" class="halo-layer" />
        <HardwareButton
          shape="circle"
          size="lg"
          :color="buttonLedColor"
          :active="isRecordingOrPlaying"
          aria-label="Record or play track"
          :disabled="!recordActionEnabled"
          :disabled-reason="recordActionDisabledReason"
          @press="handleRecPlay"
          class="main-btn"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { TrackState } from '../core/types';
import { useRc505Controls } from '../composables/useRc505Controls';
import LoopHalo from './LoopHalo.vue';
import HardwareButton from './ui/HardwareButton.vue';
import HardwareFader from './ui/HardwareFader.vue';
import HardwareKnob from './ui/HardwareKnob.vue';

const props = defineProps<{
  trackId: number;
}>();

const engine = AudioEngine.getInstance();
const controls = useRc505Controls();
const trackAudio = engine.tracks[props.trackId - 1]!;
const trackCapabilities = ref(engine.getTrackCapabilities(props.trackId));

const getEngineUiStatus = () => typeof engine.getUiStatus === 'function' ? engine.getUiStatus() : null;
const isEngineReady = () => getEngineUiStatus()?.ready ?? trackAudio.transportEnabled;

const trackState = ref(trackAudio.state);
const playLevel = ref(trackAudio.track.playLevel);
const isReverse = ref(trackAudio.isReverse);
const isClearing = ref(false);
const filterFreq = ref(Math.round(trackAudio.track.filterValue * 100));
const filterRes = ref(Math.round(trackAudio.track.filterResonance * 10));
const fxState = ref({ filter: trackAudio.track.filterEnabled });
const trackAvailable = ref(trackAudio.isAvailable);
const trackTransportEnabled = ref(trackAudio.transportEnabled && isEngineReady());
const inputCaptureWarming = ref(false);
const recordActionPending = ref(false);
const disabledReason = ref(trackAudio.disabledReason || (isEngineReady() ? '' : getEngineUiStatus()?.message || 'Audio engine is not ready'));
const isFilterActive = computed(() => fxState.value.filter);
const levelControlEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.value.supportsTrackLevel);
const levelControlAriaLabel = computed(() => !levelControlEnabled.value
  ? `Track ${props.trackId} level unavailable: ${trackCapabilities.value.levelReason || 'Track level is unavailable'}`
  : `Track ${props.trackId} level`);
const filterControlsEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.value.supportsTrackFx);
const reverseControlEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.value.supportsReverse);
const captureWarmupBlocksAction = computed(() => getEngineUiStatus()?.mode === 'browser' && inputCaptureWarming.value
  && (trackState.value === TrackState.EMPTY || trackState.value === TrackState.PLAYING));
const recordActionEnabled = computed(() => trackTransportEnabled.value && !captureWarmupBlocksAction.value && !recordActionPending.value);
const recordActionDisabledReason = computed(() => recordActionPending.value
  ? 'Waiting for the Native REC acknowledgement.'
  : captureWarmupBlocksAction.value
    ? 'Shared input capture pre-roll is warming. Recording and overdubbing are disabled until the input timeline is ready.'
    : disabledReason.value);
const filterButtonAriaLabel = computed(() => filterControlsEnabled.value ? 'Toggle track filter' : trackCapabilities.value.trackFxReason);
const reverseButtonAriaLabel = computed(() => reverseControlEnabled.value ? 'Toggle reverse playback' : trackCapabilities.value.reverseReason);
const stopButtonAriaLabel = computed(() => trackTransportEnabled.value
  ? 'Stop track (hold to clear)'
  : `Stop track unavailable: ${disabledReason.value || 'Audio engine is not ready'}`);
const capabilityNotes = computed(() => {
  if (!trackAvailable.value) {
    return [] as string[];
  }

  const notes: string[] = [];
  if (!trackCapabilities.value.supportsTrackLevel && trackCapabilities.value.levelReason) {
    notes.push(trackCapabilities.value.levelReason);
  }
  if (!trackCapabilities.value.supportsTrackFx && trackCapabilities.value.trackFxReason) {
    notes.push(trackCapabilities.value.trackFxReason);
  }
  if (!trackCapabilities.value.supportsReverse && trackCapabilities.value.reverseReason) {
    notes.push(trackCapabilities.value.reverseReason);
  }

  return Array.from(new Set(notes));
});

let pollInterval: number;
let unsubscribeFromEngineStatus: (() => void) | undefined;

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

const syncTrackUi = () => {
  const engineStatus = getEngineUiStatus();
  const engineReady = engineStatus?.ready ?? trackAudio.transportEnabled;
  inputCaptureWarming.value = engineStatus?.inputCaptureWarming === true;
  trackState.value = trackAudio.state;
  isReverse.value = trackAudio.isReverse;
  trackAvailable.value = trackAudio.isAvailable;
  trackCapabilities.value = engine.getTrackCapabilities(props.trackId);
  trackTransportEnabled.value = trackAudio.transportEnabled && engineReady;
  disabledReason.value = trackAudio.disabledReason || (engineReady ? '' : engineStatus?.message || 'Audio engine is not ready');
};

onMounted(() => {
  trackAudio.fxChain.setFilterEnabled(trackAudio.track.filterEnabled);
  trackAudio.fxChain.setFilterParam('frequency', trackAudio.track.filterValue);
  trackAudio.fxChain.setFilterParam('resonance', trackAudio.track.filterResonance);
  trackAudio.updateSettings();
  syncTrackUi();
  unsubscribeFromEngineStatus = engine.onStatusChange?.(() => syncTrackUi());
  pollInterval = window.setInterval(() => {
    syncTrackUi();
  }, 50);
});

onUnmounted(() => {
  unsubscribeFromEngineStatus?.();
  clearInterval(pollInterval);
  cancelStopPress();
  if (clearVisualTimer !== null) clearTimeout(clearVisualTimer);
});

const buttonLedColor = computed(() => {
  if (isClearing.value) return 'white';
  switch (trackState.value) {
    case TrackState.RECORDING: return 'red';
    case TrackState.PLAYING: return 'green';
    case TrackState.OVERDUBBING: return 'yellow';
    default: return 'neutral';
  }
});

const faderLedColor = computed(() => {
  switch (trackState.value) {
    case TrackState.RECORDING: return 'red';
    case TrackState.PLAYING: return 'green';
    case TrackState.OVERDUBBING: return 'yellow';
    default: return 'white';
  }
});

const isRecordingOrPlaying = computed(() => {
  return trackState.value === TrackState.RECORDING ||
         trackState.value === TrackState.PLAYING ||
         trackState.value === TrackState.OVERDUBBING;
});

const handleRecPlay = async () => {
  if (!recordActionEnabled.value) return;
  recordActionPending.value = true;
  try {
    await trackAudio.triggerRecord();
  } catch (error) {
    controls.reportError('REC ACTION FAILED', error instanceof Error ? error.message : String(error));
  } finally {
    recordActionPending.value = false;
  }
};

const handleLevelChange = (value: number) => {
  if (!levelControlEnabled.value) return;

  const safeValue = clamp(Math.round(value), 0, 100);
  playLevel.value = safeValue;
  trackAudio.track.playLevel = safeValue;
  trackAudio.updateSettings();
};

const toggleFilter = () => {
  if (!filterControlsEnabled.value) return;

  const nextState = !fxState.value.filter;
  fxState.value.filter = nextState;
  trackAudio.track.filterEnabled = nextState;
  trackAudio.fxChain.setFilterEnabled(nextState);
};

const handleFilterFreqChange = (value: number) => {
  if (!filterControlsEnabled.value) return;

  const safeValue = clamp(Math.round(value), 0, 100);
  filterFreq.value = safeValue;
  const normalized = safeValue / 100;
  trackAudio.track.filterValue = normalized;
  trackAudio.fxChain.setFilterParam('frequency', normalized);
};

const handleFilterResChange = (value: number) => {
  if (!filterControlsEnabled.value) return;

  const safeValue = clamp(Math.round(value), 0, 10);
  filterRes.value = safeValue;
  const normalized = safeValue / 10;
  trackAudio.track.filterResonance = normalized;
  trackAudio.fxChain.setFilterParam('resonance', normalized);
};

const handleReverseToggle = () => {
  if (!reverseControlEnabled.value) return;

  trackAudio.toggleReverse();
  isReverse.value = trackAudio.isReverse;
};

let stopPressTimer: number | null = null;
let clearVisualTimer: number | null = null;
let stopPressActive = false;
let stopPressTriggered = false;
const LONG_PRESS_DURATION = 2000;

const startStopPress = () => {
  if (!trackTransportEnabled.value || stopPressActive) return;
  stopPressActive = true;
  stopPressTriggered = false;
  stopPressTimer = window.setTimeout(() => {
    stopPressTimer = null;
    if (!stopPressActive || !trackTransportEnabled.value) {
      stopPressActive = false;
      return;
    }
    stopPressTriggered = true;
    isClearing.value = true;
    trackAudio.clear();
    clearVisualTimer = window.setTimeout(() => {
      isClearing.value = false;
      clearVisualTimer = null;
    }, 300);
  }, LONG_PRESS_DURATION);
};

const endStopPress = () => {
  if (!stopPressActive) return;
  stopPressActive = false;
  if (stopPressTimer !== null) {
    clearTimeout(stopPressTimer);
    stopPressTimer = null;
  }
  if (!stopPressTriggered && trackTransportEnabled.value) trackAudio.triggerStop();
};

const cancelStopPress = () => {
  stopPressActive = false;
  stopPressTriggered = false;
  if (stopPressTimer !== null) {
    clearTimeout(stopPressTimer);
    stopPressTimer = null;
  }
};

watch(trackTransportEnabled, (enabled) => {
  if (!enabled) cancelStopPress();
});
</script>

<style scoped>
.track-unit {
  display: flex;
  flex-direction: column;
  width: 180px;
  min-height: 540px;
  background: var(--bg-panel-secondary);
  border-right: 1px solid #000;
  padding: 14px 10px 18px;
  gap: 12px;
}

.track-unit.disabled {
  opacity: 0.72;
}

.track-header {
  text-align: center;
  margin-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.track-id {
  font-family: var(--font-hardware);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 1px;
  color: #666;
}

.track-note {
  font-family: var(--font-hardware);
  font-size: 9px;
  letter-spacing: 0.9px;
  color: #8a8a8a;
}

.track-capability-row {
  display: flex;
  gap: 4px;
  justify-content: center;
  flex-wrap: wrap;
}

.track-capability-chip {
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.18);
  font-family: var(--font-hardware);
  font-size: 8px;
  letter-spacing: 0.7px;
  color: #8a8a8a;
  text-transform: uppercase;
}

.upper-deck {
  display: flex;
  flex-direction: row;
  min-height: 240px;
  gap: 8px;
  align-items: flex-start;
}

.left-controls {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 16px;
}

.knobs-row {
  display: flex;
  justify-content: space-around;
  padding-top: 8px;
}

.buttons-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 4px;
}

.ctrl-btn {
  width: 100%;
}

.right-fader {
  width: 50px;
  align-self: stretch;
}

.lower-deck {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex: 1 1 auto;
  min-height: 196px;
}

.stop-wrapper {
  width: 100%;
}

.halo-wrapper {
  position: relative;
  display: grid;
  place-items: center;
  width: 128px;
  height: 128px;
  flex: 0 0 128px;
}

.halo-layer {
  position: absolute;
  inset: 0;
}

.main-btn {
  position: relative;
  z-index: 1;
}

.is-disabled {
  opacity: 0.42;
  pointer-events: none;
}
</style>
