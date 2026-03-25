<template>
  <section
    class="track-strip"
    :class="{ selected: isCurrentTrack, disabled: !trackAvailable }"
    :data-track-id="trackId"
  >
    <header class="track-strip-header">
      <span class="track-label">TRACK {{ trackId }}</span>
      <span class="track-state">{{ stateLabel }}</span>
      <span v-if="disabledReason" class="track-note">{{ disabledReason }}</span>
    </header>

    <div class="track-button-stack">
      <HardwareButton
        shape="rect"
        size="sm"
        :color="isTrackFxApplied ? 'red' : 'neutral'"
        :active="isTrackFxApplied"
        label="FX"
        :aria-label="fxButtonAriaLabel"
        @press="toggleTrackFx"
      />
      <HardwareButton
        shape="rect"
        size="sm"
        :color="isCurrentTrack ? 'blue' : 'neutral'"
        :active="isCurrentTrack"
        label="TRACK"
        :aria-label="trackButtonAriaLabel"
        @press="handleTrackSelect"
      />
    </div>

    <div class="transport-stack">
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
      />

      <div class="main-transport">
        <div class="slider-column">
          <HardwareFader
            :model-value="playLevel"
            :led-color="faderLedColor"
            label="LEVEL"
            @update:model-value="handleLevelChange"
          />
        </div>

        <div class="main-button-column">
          <div class="halo-wrapper">
            <LoopHalo :track-id="trackId" class="halo-layer" />
            <HardwareButton
              shape="circle"
              size="lg"
              :color="buttonLedColor"
              :active="isRecordingOrPlaying"
              aria-label="Record or play track"
              @press="handleRecPlay"
            />
          </div>
          <div class="loop-indicator-row">
            <span class="indicator-chip" :class="{ active: trackState === TrackState.RECORDING }">REC</span>
            <span class="indicator-chip" :class="{ active: trackState === TrackState.PLAYING }">PLAY</span>
            <span class="indicator-chip" :class="{ active: trackState === TrackState.OVERDUBBING }">DUB</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { TrackState } from '../../core/types';
import { useTrackStripState } from '../../composables/useTrackStripState';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareFader from '../ui/HardwareFader.vue';
import LoopHalo from '../LoopHalo.vue';

const props = defineProps<{
  trackId: number;
}>();

const {
  trackState,
  playLevel,
  trackAvailable,
  disabledReason,
  isCurrentTrack,
  isTrackFxApplied,
  isRecordingOrPlaying,
  buttonLedColor,
  faderLedColor,
  fxButtonAriaLabel,
  trackButtonAriaLabel,
  handleRecPlay,
  handleLevelChange,
  handleTrackSelect,
  toggleTrackFx,
  startStopPress,
  endStopPress,
  cancelStopPress,
} = useTrackStripState(props.trackId);

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
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 560px;
  padding: 16px 14px 18px;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  border-right: 1px solid rgba(0, 0, 0, 0.8);
  background: linear-gradient(180deg, #18191e 0%, #0d0d11 100%);
  color: #f4f4f7;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.track-strip.selected {
  box-shadow: inset 0 0 0 2px rgba(0, 153, 255, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.track-strip.disabled {
  opacity: 0.72;
}

.track-strip-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.track-label,
.track-state,
.track-note,
.indicator-chip {
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.track-label {
  font-size: 32px;
  letter-spacing: 1px;
  line-height: 1;
}

.track-state,
.track-note {
  font-size: 10px;
  letter-spacing: 1.1px;
  color: rgba(255, 255, 255, 0.62);
}

.track-button-stack,
.transport-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.main-transport {
  display: grid;
  grid-template-columns: 54px 1fr;
  gap: 12px;
  align-items: end;
  flex: 1;
}

.slider-column {
  height: 250px;
}

.main-button-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.halo-wrapper {
  position: relative;
  display: grid;
  place-items: center;
  width: 132px;
  height: 132px;
}

.halo-layer {
  position: absolute;
  inset: 0;
}

.loop-indicator-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.indicator-chip {
  min-width: 48px;
  min-height: 26px;
  padding: 4px 8px;
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
</style>
