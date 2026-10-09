<template>
  <section
    class="track-strip"
    :class="{ selected: isCurrentTrack, disabled: !trackAvailable }"
    :data-track-id="trackId"
  >
    <header class="track-strip-header">
      <span class="track-label">{{ trackId }}</span>
      <span class="track-state">{{ stateLabel }}</span>
      <span v-if="disabledReason" class="track-note">{{ disabledReason }}</span>
    </header>

    <div class="track-top">
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
          :color="isCurrentTrack ? 'green' : 'neutral'"
          :active="isCurrentTrack"
          label="TRACK"
          :aria-label="trackButtonAriaLabel"
          @press="handleTrackSelect"
        />
        <div class="clear-note">CLEAR: HOLD</div>
        <button
          class="stop-disc"
          type="button"
          aria-label="Stop track (hold to clear)"
          @mousedown="startStopPress"
          @touchstart.prevent="startStopPress"
          @mouseup="endStopPress"
          @touchend.prevent="endStopPress"
          @mouseleave="cancelStopPress"
        >
          <span class="stop-square"></span>
        </button>
      </div>

      <div class="slider-column">
        <HardwareFader
          :model-value="playLevel"
          :max="200"
          :led-color="faderLedColor"
          label=""
          @update:model-value="handleLevelChange"
        />
      </div>
    </div>

    <div class="main-button-column">
      <div class="halo-wrapper">
        <LoopHalo :track-id="trackId" class="halo-layer" />
        <button
          class="main-recplay-button"
          :class="[`state-${buttonLedColor}`, { active: isRecordingOrPlaying }]"
          type="button"
          aria-label="Record or play track"
          @click="handleRecPlay"
        >
          <span class="main-recplay-core">
            <span class="main-recplay-icon">
              {{ transportGlyph }}
            </span>
          </span>
        </button>
      </div>
      <div class="loop-indicator-row">
        <span class="indicator-chip" :class="{ active: trackState === TrackState.RECORDING }">REC</span>
        <span class="indicator-chip" :class="{ active: trackState === TrackState.PLAYING }">PLAY</span>
        <span class="indicator-chip" :class="{ active: trackState === TrackState.OVERDUBBING }">DUB</span>
        <span class="indicator-chip replace-chip" :class="{ active: trackState === TrackState.REPLACING }">REPLACE</span>
      </div>
      <TrackSettingsPanel :track-id="trackId" />
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
import TrackSettingsPanel from '../TrackSettingsPanel.vue';

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
    case TrackState.REPLACING:
      return 'REPLACE';
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

const transportGlyph = computed(() => {
  if (trackState.value === TrackState.PLAYING || trackState.value === TrackState.OVERDUBBING || trackState.value === TrackState.REPLACING) {
    return '▶';
  }
  return '●';
});
</script>

<style scoped>
.track-strip {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 612px;
  padding: 12px 12px 20px;
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
  gap: 2px;
  min-height: 48px;
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
  font-size: 40px;
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

.track-top {
  display: grid;
  grid-template-columns: 78px 64px;
  justify-content: space-between;
  gap: 8px;
  align-items: start;
}

.track-button-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}

.stop-disc {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 2px solid rgba(210, 220, 235, 0.82);
  background: radial-gradient(circle at 35% 30%, #31343a 0%, #191b21 72%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
  cursor: pointer;
}

.stop-square {
  display: block;
  width: 16px;
  height: 16px;
  margin: auto;
  background: #d7dee9;
}

.slider-column {
  height: 286px;
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
  gap: 12px;
  margin-top: auto;
}

.halo-wrapper {
  position: relative;
  width: 178px;
  height: 178px;
}

.halo-wrapper::before {
  content: '';
  position: absolute;
  inset: 6px;
  border-radius: 50%;
  border: 10px solid rgba(15, 15, 18, 0.96);
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
  top: 50%;
  left: 50%;
  width: 138px;
  height: 138px;
  transform: translate(-50%, -50%);
}

.main-recplay-button {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 92px;
  height: 92px;
  transform: translate(-50%, -50%);
  border: none;
  border-radius: 50%;
  background: transparent;
  padding: 0;
  cursor: pointer;
  z-index: 2;
}

.main-recplay-button::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 28%, #f7f2e9 0%, #e8dfd0 55%, #c3b9a8 100%);
  box-shadow:
    0 8px 16px rgba(0, 0, 0, 0.32),
    inset 0 2px 0 rgba(255, 255, 255, 0.9),
    inset 0 -2px 8px rgba(0, 0, 0, 0.2);
}

.main-recplay-button::after {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.08);
}

.main-recplay-button.state-red::after {
  border-color: rgba(255, 0, 51, 0.42);
  box-shadow: 0 0 18px rgba(255, 0, 51, 0.24);
}

.main-recplay-button.state-green::after {
  border-color: rgba(0, 255, 102, 0.42);
  box-shadow: 0 0 18px rgba(0, 255, 102, 0.24);
}

.main-recplay-button.state-yellow::after {
  border-color: rgba(255, 204, 0, 0.42);
  box-shadow: 0 0 18px rgba(255, 204, 0, 0.22);
}

.main-recplay-button.active::before {
  transform: scale(0.985);
}

.main-recplay-core {
  position: absolute;
  inset: 10px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 6px solid rgba(33, 255, 157, 0.88);
  background: radial-gradient(circle at center, #202226 0%, #1b1d21 100%);
  box-shadow:
    0 0 14px rgba(0, 255, 102, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  z-index: 1;
}

.main-recplay-button.state-red .main-recplay-core {
  border-color: rgba(255, 92, 110, 0.9);
  box-shadow: 0 0 14px rgba(255, 0, 51, 0.24);
}

.main-recplay-button.state-yellow .main-recplay-core {
  border-color: rgba(255, 214, 87, 0.9);
  box-shadow: 0 0 14px rgba(255, 204, 0, 0.22);
}

.main-recplay-button.state-purple::after {
  border-color: rgba(168, 85, 247, .45);
  box-shadow: 0 0 18px rgba(168, 85, 247, .24);
}

.main-recplay-button.state-purple .main-recplay-core {
  border-color: rgba(196, 142, 255, .9);
  box-shadow: 0 0 14px rgba(168, 85, 247, .28);
}

.main-recplay-button.state-purple .main-recplay-icon { color: #efddff; }

.main-recplay-icon {
  font-family: var(--font-hardware);
  font-size: 34px;
  line-height: 1;
  color: #b4f7cb;
  text-shadow: 0 0 8px rgba(180, 247, 203, 0.28);
}

.main-recplay-button.state-red .main-recplay-icon {
  color: #ffd6dd;
}

.main-recplay-button.state-yellow .main-recplay-icon {
  color: #fff1b2;
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

:deep(.slider-column .hardware-fader) {
  gap: 0;
}

:deep(.slider-column .fader-track-container) {
  min-height: 248px;
  gap: 6px;
}

:deep(.slider-column .led-strip) {
  width: 2px;
}

:deep(.slider-column .fader-groove) {
  width: 20px;
  border-radius: 2px;
  background: #06070a;
  box-shadow:
    inset 0 1px 6px rgba(0, 0, 0, 0.94),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

:deep(.slider-column .fader-cap) {
  width: 34px;
  height: 18px;
  border-radius: 2px;
  background: linear-gradient(180deg, #f8fbff 0%, #7d8494 100%);
  box-shadow:
    0 2px 6px rgba(0, 0, 0, 0.7),
    inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

:deep(.slider-column .cap-ridge) {
  width: 24px;
  background: rgba(0, 0, 0, 0.28);
}

:deep(.slider-column .fader-value) {
  display: none;
}
</style>
