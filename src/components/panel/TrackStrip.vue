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
      <span v-if="trackFxUnavailableReason" class="track-note" data-testid="track-fx-unavailable">{{ trackFxUnavailableReason }}</span>
      <span v-if="trackLevelUnavailableReason" class="track-note" data-testid="track-level-unavailable">{{ trackLevelUnavailableReason }}</span>
      <span v-if="overdubDiagnostic" class="track-note track-warning" role="status" aria-live="polite">
        {{ overdubDiagnostic }}
      </span>
    </header>

    <div class="track-top">
      <div class="track-button-stack">
        <HardwareButton
          shape="rect"
          size="sm"
          :color="trackFxControlEnabled && isTrackFxApplied ? 'red' : 'neutral'"
          :active="trackFxControlEnabled && isTrackFxApplied"
          :disabled="!trackFxControlEnabled"
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
          :led-color="faderLedColor"
          :disabled="!levelControlEnabled"
          :disabled-reason="trackLevelUnavailableReason"
          :aria-label="levelControlAriaLabel"
          data-testid="track-level-fader"
          label=""
          @update:model-value="handleLevelChange"
        />
      </div>
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

    <section class="keep-pitch-panel" :aria-label="`Track ${trackId} live KeepPitch controls`">
      <div class="keep-pitch-title">LIVE KEEP PITCH</div>
      <label>
        <span>Mode</span>
        <select
          v-model="livePitchMode"
          data-testid="keep-pitch-mode"
          :disabled="livePitchControlsDisabled"
          @change="handleLivePitchModeChange"
        >
          <option value="OFF">OFF</option>
          <option value="LIVE_MONO" :disabled="!liveMonoPitchSupported">LIVE MONO</option>
          <option value="LIVE_POLY" :disabled="!livePolyPitchSupported">LIVE POLY</option>
        </select>
      </label>
      <label>
        <span>Semitones (−12 to +12)</span>
        <input
          v-model.number="livePitchSemitones"
          data-testid="keep-pitch-semitones"
          type="number"
          min="-12"
          max="12"
          step="1"
          :disabled="livePitchControlsDisabled"
          @change="handleLivePitchSemitonesChange"
        >
      </label>
      <p class="keep-pitch-status" data-testid="keep-pitch-status" role="status" aria-live="polite">
        {{ livePitchStatus }}
      </p>
      <p v-if="livePitchFallbackReason" class="keep-pitch-warning" data-testid="keep-pitch-fallback">
        FALLBACK: {{ livePitchFallbackReason }}
      </p>
      <p v-if="livePitchMode !== 'OFF'" class="keep-pitch-latency" data-testid="keep-pitch-latency">
        ALGORITHMIC LATENCY ONLY:
        <template v-if="livePitchLatencyFrames !== null && livePitchLatencyMs !== null">
          algorithmic latency: {{ livePitchLatencyFrames }} samples / {{ livePitchLatencyMs.toFixed(2) }} ms
        </template>
        <template v-else>not measured yet</template>
      </p>
      <p v-if="isNativePitchMode" class="keep-pitch-note" data-testid="keep-pitch-native-limit">
        Native KeepPitch supports one selected track target at a time
      </p>
      <p v-if="!liveMonoPitchSupported && !livePolyPitchSupported" class="keep-pitch-note" data-testid="keep-pitch-unavailable">
        KeepPitch is unavailable on this audio runtime
      </p>
      <p v-if="livePitchError" class="keep-pitch-error" data-testid="keep-pitch-error" role="alert">
        {{ livePitchError }}
      </p>
    </section>

    <details class="hq-export-panel">
      <summary>HQ RENDER / WAV</summary>
      <div class="hq-export-controls">
        <p class="hq-export-note">Offline pitch render. Loop length follows playback rate. Browser uses Signalsmith.</p>
        <label v-if="isNativeAudioMode">
          <span>Native Rubber Band engine</span>
          <select
            v-model="hqNativeEngine"
            data-testid="native-hq-engine"
            :disabled="isHqExporting || !nativeHqRendererAvailable"
            @change="handleHqNativeEngineChange"
          >
            <option v-if="!nativeHqRendererAvailable" value="R3" disabled>Unavailable</option>
            <option v-for="engine in nativeHqRendererEngines" :key="engine" :value="engine">{{ engine }}</option>
          </select>
        </label>
        <p v-if="isNativeAudioMode && !nativeHqRendererAvailable" class="hq-export-note" data-testid="native-hq-unavailable">
          Native HQ render is unavailable in this bridge status.
        </p>
        <label>
          <span>Pitch (semitones)</span>
          <input v-model.number="hqPitchSemitones" type="number" min="-24" max="24" step="1" :disabled="isHqExporting" @change="handleHqPitchChange">
        </label>
        <label>
          <span>Playback rate</span>
          <input v-model.number="hqPlaybackRate" type="number" min="0.5" max="2" step="0.05" :disabled="isHqExporting" @change="handleHqPlaybackRateChange">
        </label>
        <label>
          <span>WAV format</span>
          <select v-model="hqWavFormat" :disabled="isHqExporting">
            <option value="pcm16">PCM 16-bit</option>
            <option value="pcm24">PCM 24-bit</option>
            <option value="float32">Float 32-bit</option>
          </select>
        </label>
        <label>
          <span>Memory budget estimate (MiB)</span>
          <input
            v-model.number="hqMemoryBudgetMiB"
            data-testid="hq-memory-budget-mib"
            type="number"
            min="64"
            max="4096"
            step="64"
            :disabled="isHqExporting"
            @change="handleHqMemoryBudgetChange"
          >
        </label>
        <p class="hq-export-note">This is a preflight estimate, not an OS memory guarantee; a larger value can still exceed available device memory.</p>
        <button type="button" :disabled="!canExportHqWav || isHqExporting" @click="exportHqWav">
          {{ isHqExporting ? `RENDERING ${hqExportProgress}%` : 'EXPORT HQ WAV' }}
        </button>
        <p v-if="isHqExporting" class="hq-export-status" role="status" aria-live="polite">
          Rendering off the audio thread… {{ hqExportProgress }}%
        </p>
        <p v-if="hqExportError" class="hq-export-error" role="alert">{{ hqExportError }}</p>
      </div>
    </details>
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
  overdubDiagnostic,
  hqPitchSemitones,
  hqPlaybackRate,
  hqWavFormat,
  hqMemoryBudgetMiB,
  hqNativeEngine,
  nativeHqRendererAvailable,
  nativeHqRendererEngines,
  isHqExporting,
  hqExportProgress,
  hqExportError,
  canExportHqWav,
  livePitchMode,
  livePitchSemitones,
  liveMonoPitchSupported,
  livePolyPitchSupported,
  livePitchControlsDisabled,
  livePitchStatus,
  livePitchFallbackReason,
  livePitchLatencyFrames,
  livePitchLatencyMs,
  livePitchError,
  isNativeAudioMode,
  isNativePitchMode,
  isCurrentTrack,
  isTrackFxApplied,
  trackFxControlEnabled,
  isRecordingOrPlaying,
  buttonLedColor,
  faderLedColor,
  levelControlEnabled,
  levelControlAriaLabel,
  trackFxUnavailableReason,
  trackLevelUnavailableReason,
  fxButtonAriaLabel,
  trackButtonAriaLabel,
  handleRecPlay,
  handleLevelChange,
  handleTrackSelect,
  toggleTrackFx,
  exportHqWav,
  handleLivePitchModeChange,
  handleLivePitchSemitonesChange,
  handleHqNativeEngineChange,
  handleHqPitchChange,
  handleHqPlaybackRateChange,
  handleHqMemoryBudgetChange,
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

.track-warning {
  color: #ffd166;
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
  display: grid;
  place-items: center;
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
  font-size: 10px;
  letter-spacing: 0.9px;
}

.keep-pitch-panel label {
  display: grid;
  gap: 3px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 9px;
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
  font: 11px var(--font-hardware);
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
  font-size: 9px;
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
  font-size: 10px;
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
  font-size: 9px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.62);
}

.hq-export-controls label {
  display: grid;
  gap: 3px;
  font-size: 9px;
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
  font: 11px var(--font-hardware);
}

.hq-export-controls button {
  min-height: 30px;
  border: 1px solid rgba(77, 191, 255, 0.48);
  border-radius: 5px;
  background: linear-gradient(180deg, #174567 0%, #0e2b43 100%);
  color: white;
  font: 10px var(--font-hardware);
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
