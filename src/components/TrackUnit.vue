<template>
  <div class="track-unit" :class="{ disabled: !trackAvailable }">
    <div class="track-header">
      <span class="track-id">TRACK {{ trackId }}</span>
      <span v-if="disabledReason" class="track-note">{{ disabledReason }}</span>
    </div>

    <div class="upper-deck disabled-block">
      <div class="left-controls">
        <div class="knobs-row">
          <HardwareKnob
            v-model="filterFreq"
            :min="0"
            :max="100"
            label="FREQ"
            color="blue"
            :size="40"
          />
          <HardwareKnob
            v-model="filterRes"
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
            aria-label="Track FX unavailable in native v1"
            class="ctrl-btn"
          />
          <HardwareButton
            label="TRACK"
            shape="rect"
            size="sm"
            :color="isReverse ? 'purple' : 'neutral'"
            :active="isReverse"
            aria-label="Reverse unavailable in native v1"
            class="ctrl-btn"
          />
        </div>
      </div>

      <div class="right-fader">
        <HardwareFader
          v-model="playLevel"
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

const trackState = ref(trackAudio.state);
const playLevel = ref(trackAudio.track.playLevel);
const isReverse = ref(trackAudio.isReverse);
const isClearing = ref(false);
const filterFreq = ref(50);
const filterRes = ref(0);
const fxState = ref({ filter: false });

const trackAvailable = computed(() => trackAudio.isAvailable);
const trackTransportEnabled = computed(() => trackAudio.transportEnabled);
const disabledReason = computed(() => trackAudio.disabledReason);
const isFilterActive = computed(() => fxState.value.filter);

let pollInterval: number;

onMounted(() => {
  pollInterval = window.setInterval(() => {
    trackState.value = trackAudio.state;
    isReverse.value = trackAudio.isReverse;
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
  height: 100%;
  background: var(--bg-panel-secondary);
  border-right: 1px solid #000;
  padding: 12px 10px;
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

.upper-deck {
  display: flex;
  flex-direction: row;
  height: 240px;
  gap: 8px;
}

.disabled-block {
  opacity: 0.4;
  pointer-events: none;
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
  height: 100%;
}

.lower-deck {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  flex-grow: 1;
}

.stop-wrapper {
  width: 100%;
}

.halo-wrapper {
  position: relative;
  display: grid;
  place-items: center;
  margin-top: auto;
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
