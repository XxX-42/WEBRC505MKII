<template>
  <div class="track-unit">
    <!-- Header -->
    <div class="track-header">
      <span class="track-id">TRACK {{ trackId }}</span>
    </div>

    <!-- Upper Deck: Grid Layout -->
    <div class="upper-deck">
      <!-- Left Controls: Knobs & Buttons -->
      <div class="left-controls">
        <!-- Knobs Row -->
        <div class="knobs-row">
            <HardwareKnob
                v-model="filterFreq"
                :min="0"
                :max="100"
                label="FREQ"
                color="blue"
                :size="40"
                @update:modelValue="updateFilterFreq"
            />
            <HardwareKnob
                v-model="filterRes"
                :min="0"
                :max="10"
                label="RES"
                color="blue"
                :size="40"
                @update:modelValue="updateFilterRes"
            />
        </div>

        <!-- Buttons Row -->
        <div class="buttons-row">
            <HardwareButton
            label="FX"
            shape="rect"
            size="sm"
            :color="isFilterActive ? 'blue' : 'neutral'"
            :active="isFilterActive"
            aria-label="Toggle track filter"
            @press="toggleFilterMode"
            class="ctrl-btn"
            />
            <HardwareButton
            label="TRACK"
            shape="rect"
            size="sm"
            :color="isReverse ? 'purple' : 'neutral'"
            :active="isReverse"
            aria-label="Toggle reverse playback"
            @press="toggleReverse"
            class="ctrl-btn"
            />
        </div>
      </div>

      <!-- Right Fader -->
      <div class="right-fader">
        <HardwareFader
          v-model="playLevel"
          :led-color="faderLedColor"
          label="LEVEL"
          @update:modelValue="updateLevel"
        />
      </div>
    </div>

    <!-- Lower Deck: Halo & Rec/Play -->
    <div class="lower-deck">
        <!-- Stop Button (Now separate and below fader/knobs area, slightly overlapping halo area or just above it) -->
        <!-- Actually, on RC-505 stop is usually near the main button. Let's place it carefully. -->
        <!-- Based on previous layout, STOP was in left-controls. Let's keep it accessible. -->
        
        <div class="stop-wrapper">
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
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
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

// FX Params
const filterFreq = ref(50); // Default middle
const filterRes = ref(0);

// ========================================
// FX STATE MANAGEMENT
// ========================================

const fxState = ref({
  filter: false,
});

const isFilterActive = computed(() => fxState.value.filter);

// ========================================
// POLLING FOR STATE
// ========================================

let pollInterval: number;

onMounted(() => {
  // Init Values
  playLevel.value = trackAudio.track.playLevel;
  // Initialize knobs to saved state if any, or defaults
  // Current Track model doesn't store Freq/Res separately in a persisted way clearly,
  // but 'filterValue' exists.
  filterFreq.value = trackAudio.track.filterValue * 100; 

  pollInterval = window.setInterval(() => {
    trackState.value = trackAudio.state;
    isReverse.value = trackAudio.isReverse;
  }, 50);
});

onUnmounted(() => {
  clearInterval(pollInterval);
});

// ========================================
// LED COLORS
// ========================================

const buttonLedColor = computed(() => {
  if (isClearing.value) return 'white';
  switch (trackState.value) {
    case TrackState.RECORDING: return 'red';
    case TrackState.REC_STANDBY: return 'red';
    case TrackState.REC_FINISHING: return 'green';
    case TrackState.PLAYING: return 'green';
    case TrackState.OVERDUBBING: return 'yellow';
    default: return 'neutral';
  }
});

const faderLedColor = computed(() => {
  // Fader is now ALWAYS volume.
  // Standard behaviors:
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

// ========================================
// ACTIONS
// ========================================

const handleRecPlay = () => trackAudio.triggerRecord();

const toggleReverse = () => {
  trackAudio.toggleReverse();
};

// Stop Button Logic
let stopPressTimer: number | null = null;
const LONG_PRESS_DURATION = 1500;

const startStopPress = () => {
    if (stopPressTimer) return;
    stopPressTimer = window.setTimeout(() => {
        isClearing.value = true;
        trackAudio.clear();
        setTimeout(() => { isClearing.value = false; }, 300);
        stopPressTimer = null;
    }, LONG_PRESS_DURATION);
};

const endStopPress = () => {
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

// FX Logic
const toggleFilterMode = () => {
  fxState.value.filter = !fxState.value.filter;
  trackAudio.fxChain.setFilterEnabled(fxState.value.filter);
  trackAudio.track.filterEnabled = fxState.value.filter;
  
  // No jumping logic needed for knobs! 
  // Knobs maintain their physical position (modelValue)
};

const updateFilterFreq = (val: number) => {
    filterFreq.value = val;
    // Always update the engine parameter, even if bypassed (Ghost State)
    // This allows pre-setting values before engaging FX
    trackAudio.fxChain.setFilterParam('frequency', val / 100); 
    trackAudio.track.filterValue = val / 100;
};

const updateFilterRes = (val: number) => {
    filterRes.value = val;
    trackAudio.fxChain.setFilterParam('resonance', val / 10); // Map 0-10 to 0-1 (or appropriate range)
};

const updateLevel = () => {
    // Pure Volume Control
    trackAudio.track.playLevel = playLevel.value;
    trackAudio.updateSettings();
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

.track-header {
  text-align: center;
  margin-bottom: 4px;
}

.track-id {
  font-family: var(--font-hardware);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 1px;
  color: #666;
}

/* === UPPER DECK === */
.upper-deck {
  display: flex;
  flex-direction: row;
  height: 240px; /* Specific height for upper control area */
  gap: 8px;
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
  width: 50px; /* Fixed width for fader area */
  height: 100%;
}

/* === LOWER DECK === */
.lower-deck {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  flex-grow: 1; /* Fill remaining space */
}

.stop-wrapper {
    width: 80%;
}

.halo-wrapper {
  display: grid;
  place-items: center;
  position: relative;
  width: 110px;
  height: 110px;
}

.halo-layer,
.main-btn {
  grid-area: 1 / 1;
  transform: none;
}

.halo-layer {
  width: 100%;
  height: 100%;
  z-index: 1;
  pointer-events: none;
}

.main-btn {
  z-index: 10;
  margin: 0;
  position: relative;
}
</style>
