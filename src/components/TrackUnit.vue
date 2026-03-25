<template>
  <div class="track-unit" :class="{ disabled: !trackAvailable }" :data-track-id="trackId">
    <div class="track-header">
      <span class="track-id">TRACK {{ trackId }}</span>
      <span v-if="disabledReason" class="track-note">{{ disabledReason }}</span>
      <div v-if="capabilityNotes.length > 0" class="track-capability-row">
        <span v-for="note in capabilityNotes" :key="note" class="track-capability-chip">
          {{ note }}
        </span>
      </div>
    </div>

    <div class="upper-deck">
      <div class="left-controls">
        <div class="knobs-row" :class="{ 'is-disabled': !filterControlsEnabled }">
          <HardwareKnob
            :model-value="filterFreq"
            @update:modelValue="handleFilterFreqChange"
            :min="0"
            :max="100"
            label="FREQ"
            color="blue"
            :size="40"
          />
          <HardwareKnob
            :model-value="filterRes"
            @update:modelValue="handleFilterResChange"
            :min="0"
            :max="10"
            label="RES"
            color="blue"
            :size="40"
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
            @press="toggleFilter"
            class="ctrl-btn"
            :class="{ 'is-disabled': !filterControlsEnabled }"
          />
          <HardwareButton
            label="TRACK"
            shape="rect"
            size="sm"
            :color="isReverse ? 'purple' : 'neutral'"
            :active="isReverse"
            :aria-label="reverseButtonAriaLabel"
            @press="handleReverseToggle"
            class="ctrl-btn"
            :class="{ 'is-disabled': !reverseControlEnabled }"
          />
        </div>
      </div>

      <div class="right-fader" :class="{ 'is-disabled': !levelControlEnabled }">
        <HardwareFader
          :model-value="playLevel"
          @update:modelValue="handleLevelChange"
          :led-color="faderLedColor"
          label="LEVEL"
        />
      </div>
    </div>

    <div class="lower-deck">
      <div class="stop-wrapper" :class="{ 'is-disabled': !trackTransportEnabled }">
        <HardwareButton
          label="STOP"
          shape="rect"
          size="sm"
          color="red"
          aria-label="Stop track (hold to clear)"
          @mousedown="startStopPress"
          @touchstart.prevent="startStopPress"
          @mouseup="endStopPress"
          @touchend.prevent="endStopPress"
          @mouseleave="cancelStopPress"
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
          @press="handleRecPlay"
          class="main-btn"
          :class="{ 'is-disabled': !trackTransportEnabled }"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { TrackState } from '../core/types';
import LoopHalo from './LoopHalo.vue';
import HardwareButton from './ui/HardwareButton.vue';
import HardwareFader from './ui/HardwareFader.vue';
import HardwareKnob from './ui/HardwareKnob.vue';

const props = defineProps<{
  trackId: number;
}>();

const engine = AudioEngine.getInstance();
const trackAudio = engine.tracks[props.trackId - 1]!;
const trackCapabilities = engine.getTrackCapabilities(props.trackId);

const trackState = ref(trackAudio.state);
const playLevel = ref(trackAudio.track.playLevel);
const isReverse = ref(trackAudio.isReverse);
const isClearing = ref(false);
const filterFreq = ref(Math.round(trackAudio.track.filterValue * 100));
const filterRes = ref(Math.round(trackAudio.track.filterResonance * 10));
const fxState = ref({ filter: trackAudio.track.filterEnabled });
const trackAvailable = ref(trackAudio.isAvailable);
const trackTransportEnabled = ref(trackAudio.transportEnabled);
const disabledReason = ref(trackAudio.disabledReason);
const isFilterActive = computed(() => fxState.value.filter);
const levelControlEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.supportsTrackLevel);
const filterControlsEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.supportsTrackFx);
const reverseControlEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.supportsReverse);
const filterButtonAriaLabel = computed(() => filterControlsEnabled.value ? 'Toggle track filter' : trackCapabilities.trackFxReason);
const reverseButtonAriaLabel = computed(() => reverseControlEnabled.value ? 'Toggle reverse playback' : trackCapabilities.reverseReason);
const capabilityNotes = computed(() => {
  if (!trackAvailable.value) {
    return [] as string[];
  }

  const notes: string[] = [];
  if (!trackCapabilities.supportsTrackLevel && trackCapabilities.levelReason) {
    notes.push(trackCapabilities.levelReason);
  }
  if (!trackCapabilities.supportsTrackFx && trackCapabilities.trackFxReason) {
    notes.push(trackCapabilities.trackFxReason);
  }
  if (!trackCapabilities.supportsReverse && trackCapabilities.reverseReason) {
    notes.push(trackCapabilities.reverseReason);
  }

  return Array.from(new Set(notes));
});

let pollInterval: number;

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

const syncTrackUi = () => {
  trackState.value = trackAudio.state;
  isReverse.value = trackAudio.isReverse;
  trackAvailable.value = trackAudio.isAvailable;
  trackTransportEnabled.value = trackAudio.transportEnabled;
  disabledReason.value = trackAudio.disabledReason;
};

onMounted(() => {
  trackAudio.fxChain.setFilterEnabled(trackAudio.track.filterEnabled);
  trackAudio.fxChain.setFilterParam('frequency', trackAudio.track.filterValue);
  trackAudio.fxChain.setFilterParam('resonance', trackAudio.track.filterResonance);
  trackAudio.updateSettings();
  syncTrackUi();
  pollInterval = window.setInterval(() => {
    syncTrackUi();
  }, 50);
});

onUnmounted(() => {
  clearInterval(pollInterval);
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

const handleRecPlay = () => {
  if (!trackTransportEnabled.value) return;
  trackAudio.triggerRecord();
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
const LONG_PRESS_DURATION = 1500;

const startStopPress = () => {
  if (!trackTransportEnabled.value || stopPressTimer) return;
  stopPressTimer = window.setTimeout(() => {
    isClearing.value = true;
    trackAudio.clear();
    setTimeout(() => { isClearing.value = false; }, 300);
    stopPressTimer = null;
  }, LONG_PRESS_DURATION);
};

const endStopPress = () => {
  if (!trackTransportEnabled.value) return;
  if (stopPressTimer) {
    clearTimeout(stopPressTimer);
    stopPressTimer = null;
    trackAudio.triggerStop();
  }
};

const cancelStopPress = () => {
  if (stopPressTimer) {
    clearTimeout(stopPressTimer);
    stopPressTimer = null;
  }
};
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
