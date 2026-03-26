<template>
  <section class="center-main-panel" data-panel="center-main">
    <div class="left-stack">
      <div class="button-rail vertical">
        <HardwareButton shape="rect" size="sm" color="white" label="MENU" aria-label="Menu placeholder" @press="flashPlaceholder('MENU placeholder')" />
        <HardwareButton shape="rect" size="sm" color="white" label="LOOP" aria-label="Loop placeholder" @press="flashPlaceholder('LOOP placeholder')" />
      </div>
      <div class="button-rail">
        <HardwareButton
          shape="rect"
          size="md"
          :color="isPlaying ? 'red' : 'green'"
          :active="isPlaying"
          :label="isPlaying ? 'ALL STOP' : 'ALL START'"
          :aria-label="isPlaying ? 'Stop all tracks' : 'Start all tracks'"
          @press="toggleAllTransport"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          color="yellow"
          label="UNDO/REDO"
          aria-label="Undo or redo placeholder"
          @press="flashPlaceholder('UNDO/REDO is a placeholder in this web shell')"
        />
      </div>
    </div>

    <div class="display-cluster">
      <div class="screen-shell">
        <div class="lcd-display">
          <div class="lcd-row top">
            <span>MEMORY</span>
            <span>J={{ bpmDisplay }}.0</span>
          </div>
          <div class="lcd-main">01</div>
          <div class="lcd-name">Memory01</div>
          <div class="lcd-row">
            <span>TRACK {{ currentTrackId }}</span>
            <span>{{ focusLabel }}</span>
          </div>
          <div class="lcd-row small">
            <span>{{ statusHint }}</span>
          </div>
        </div>
      </div>

      <div class="knob-row">
        <HardwareKnob v-for="knob in screenKnobs" :key="knob.label" v-model="knob.value" :label="knob.label" color="white" :size="58" />
      </div>
    </div>

    <div class="nav-stack">
      <div class="button-rail">
        <HardwareButton shape="rect" size="sm" color="white" label="EXIT" aria-label="Exit placeholder" @press="flashPlaceholder('EXIT placeholder')" />
        <HardwareButton shape="rect" size="sm" color="blue" label="ENTER" aria-label="Enter placeholder" @press="flashPlaceholder('ENTER placeholder')" />
      </div>
      <div class="navigation-ring">
        <button class="nav-btn up" type="button" @click="flashPlaceholder('Up navigation placeholder')">^</button>
        <button class="nav-btn left" type="button" @click="flashPlaceholder('Left navigation placeholder')">&lt;</button>
        <button class="nav-btn right" type="button" @click="flashPlaceholder('Right navigation placeholder')">&gt;</button>
        <button class="nav-btn down" type="button" @click="flashPlaceholder('Down navigation placeholder')">v</button>
        <button class="nav-btn center" type="button" @click="flashPlaceholder('Cursor center placeholder')">o</button>
      </div>
    </div>

    <div class="right-stack">
      <div class="output-shell">
        <div class="cluster-title">OUTPUT LEVEL</div>
        <div class="output-block">
          <HardwareKnob v-model="outputLevel" label="" color="red" :size="84" />
        </div>
      </div>

      <div class="rhythm-shell">
        <div class="cluster-title">RHYTHM</div>
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          label="EDIT"
          aria-label="Rhythm edit placeholder"
          @press="flashPlaceholder('RHYTHM EDIT placeholder')"
        />
      </div>

      <div class="button-rail">
        <HardwareButton
          shape="rect"
          size="sm"
          color="blue"
          :active="tapActive"
          label="TAP TEMPO"
          aria-label="Tap tempo"
          @press="handleTap"
        />
        <HardwareButton
          shape="rect"
          size="sm"
          :color="isRhythmPlaying ? 'red' : 'white'"
          :active="isRhythmPlaying"
          :label="isRhythmPlaying ? 'START/STOP' : 'START/STOP'"
          aria-label="Toggle rhythm"
          @press="toggleRhythm"
        />
      </div>

      <select v-model="selectedPattern" class="pattern-select" @change="updatePattern">
        <option value="ROCK">ROCK</option>
        <option value="TECHNO">TECHNO</option>
        <option value="METRONOME">METRO</option>
      </select>

      <div class="rhythm-level">
        <span>VOL</span>
        <input v-model.number="rhythmVolume" type="range" min="0" max="100" @input="updateVolume">
      </div>

      <div v-if="rhythmUnavailableReason" class="rhythm-note">{{ rhythmUnavailableReason }}</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import type { RhythmPattern } from '../../audio/RhythmEngine';
import { Transport } from '../../core/Transport';
import { TrackState, TransportState } from '../../core/types';
import { usePanelFocus } from '../../composables/usePanelFocus';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';

const engine = AudioEngine.getInstance();
const transport = Transport.getInstance();
const { state } = usePanelFocus();

const bpm = ref(transport.bpm);
const tapActive = ref(false);
const isPlaying = ref(false);
const outputLevel = ref(76);
const statusHint = ref('CENTER CONTROL FOCUSED');
const isRhythmPlaying = ref(false);
const selectedPattern = ref<RhythmPattern>('ROCK');
const rhythmVolume = ref(50);
const screenKnobs = reactive([
  { label: '1', value: 30 },
  { label: '2', value: 54 },
  { label: '3', value: 62 },
  { label: '4', value: 44 },
]);
let tapFlashTimer: number | null = null;
let tapResetTimer: number | null = null;
let unsubscribeStatus: (() => void) | null = null;
const tapTimes: number[] = [];

const bpmDisplay = computed(() => bpm.value.toString().padStart(3, '0'));
const currentTrackId = computed(() => state.currentTrackId);
const rhythmUnavailableReason = computed(() => {
  const capabilities = engine.getCapabilities();
  return capabilities.supportsRhythm ? '' : capabilities.rhythmReason;
});
const focusLabel = computed(() => {
  if (state.panelFocusContext === 'track-fx') {
    return `TRK FX ${state.activeTrackFxSlot}`;
  }
  if (state.panelFocusContext === 'input-fx') {
    return `IN FX ${state.activeInputFxSlot}`;
  }
  return state.panelFocusContext.toUpperCase();
});

const hasActiveTracks = () => engine.tracks.some((track) => (
  track.state === TrackState.RECORDING ||
  track.state === TrackState.PLAYING ||
  track.state === TrackState.OVERDUBBING ||
  track.state === TrackState.REC_STANDBY ||
  track.state === TrackState.REC_FINISHING
));

const syncPlaybackState = () => {
  if (engine.getMode() === 'browser') {
    isPlaying.value = transport.state === TransportState.PLAYING;
    return;
  }
  isPlaying.value = hasActiveTracks();
};

const updateBpm = () => {
  bpm.value = transport.bpm;
};

const toggleAllTransport = () => {
  if (isPlaying.value) {
    engine.stopAllTracks();
    return;
  }
  engine.playAllTracks();
};

const flashPlaceholder = (message: string) => {
  statusHint.value = message.toUpperCase();
  window.setTimeout(() => {
    statusHint.value = 'CENTER CONTROL FOCUSED';
  }, 1200);
};

const handleTap = () => {
  tapActive.value = true;
  if (tapFlashTimer) {
    window.clearTimeout(tapFlashTimer);
  }
  tapFlashTimer = window.setTimeout(() => {
    tapActive.value = false;
    tapFlashTimer = null;
  }, 100);

  const now = Date.now();
  tapTimes.push(now);
  if (tapTimes.length > 4) {
    tapTimes.shift();
  }

  if (tapTimes.length >= 2) {
    const intervals: number[] = [];
    for (let index = 1; index < tapTimes.length; index += 1) {
      intervals.push(tapTimes[index]! - tapTimes[index - 1]!);
    }
    const avgInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const calculatedBpm = Math.round(60000 / avgInterval);
    if (calculatedBpm >= 40 && calculatedBpm <= 300) {
      transport.setBpm(calculatedBpm);
      bpm.value = transport.bpm;
    }
  }

  if (tapResetTimer) {
    window.clearTimeout(tapResetTimer);
  }
  tapResetTimer = window.setTimeout(() => {
    tapTimes.length = 0;
    tapResetTimer = null;
  }, 3000);
};

const toggleRhythm = () => {
  if (!engine.getCapabilities().supportsRhythm) {
    flashPlaceholder(engine.getCapabilities().rhythmReason || 'RHYTHM UNAVAILABLE');
    return;
  }

  if (isRhythmPlaying.value) {
    engine.rhythmEngine.stop();
    isRhythmPlaying.value = false;
    return;
  }

  engine.rhythmEngine.start();
  isRhythmPlaying.value = true;
};

const updatePattern = () => {
  engine.rhythmEngine.setPattern(selectedPattern.value);
};

const updateVolume = () => {
  engine.rhythmEngine.setVolume(rhythmVolume.value);
};

onMounted(() => {
  transport.on('bpm-change', updateBpm);
  transport.on('start', syncPlaybackState);
  transport.on('stop', syncPlaybackState);
  syncPlaybackState();
  engine.rhythmEngine.setPattern(selectedPattern.value);
  engine.rhythmEngine.setVolume(rhythmVolume.value);
  unsubscribeStatus = engine.onStatusChange(() => {
    syncPlaybackState();
  });
});

onUnmounted(() => {
  transport.off('bpm-change', updateBpm);
  transport.off('start', syncPlaybackState);
  transport.off('stop', syncPlaybackState);
  if (tapFlashTimer) {
    window.clearTimeout(tapFlashTimer);
  }
  if (tapResetTimer) {
    window.clearTimeout(tapResetTimer);
  }
  unsubscribeStatus?.();
});
</script>

<style scoped>
.center-main-panel {
  display: grid;
  grid-template-columns: 164px minmax(360px, 1fr) 140px 182px;
  gap: 14px;
  padding: 14px 14px 10px;
  color: #f3f3f5;
}

.left-stack,
.nav-stack,
.right-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.button-rail {
  display: flex;
  gap: 8px;
}

.button-rail.vertical {
  flex-direction: column;
}

.cluster-title,
.lcd-row,
.lcd-main,
.lcd-name,
.pattern-select,
.rhythm-level,
.nav-btn {
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.cluster-title {
  font-size: 11px;
  letter-spacing: 1.4px;
  color: rgba(255, 255, 255, 0.68);
}

.display-cluster {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
}

.screen-shell {
  padding: 8px;
  border-radius: 8px;
  background: linear-gradient(180deg, #e9edf3 0%, #bfc8d3 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

.lcd-display {
  min-width: 300px;
  min-height: 142px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  justify-content: center;
  padding: 12px 16px;
  border-radius: 6px;
  background: linear-gradient(180deg, #323cbf 0%, #172166 100%);
  color: #f3fbff;
  box-shadow: inset 0 0 0 1px rgba(220, 240, 255, 0.16);
}

.lcd-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  letter-spacing: 1.2px;
}

.lcd-row.top {
  color: rgba(243, 251, 255, 0.76);
}

.lcd-main {
  font-size: 70px;
  line-height: 0.9;
  text-align: center;
}

.lcd-name {
  text-align: center;
  font-size: 28px;
  line-height: 1;
}

.lcd-row.small {
  justify-content: center;
  color: rgba(243, 251, 255, 0.74);
}

.knob-row {
  display: grid;
  grid-template-columns: repeat(4, 62px);
  gap: 14px;
}

.navigation-ring {
  position: relative;
  width: 120px;
  height: 120px;
  margin: 0 auto;
}

.nav-btn {
  position: absolute;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
  cursor: pointer;
}

.nav-btn.up { top: 0; left: 42px; }
.nav-btn.down { bottom: 0; left: 42px; }
.nav-btn.left { left: 0; top: 42px; }
.nav-btn.right { right: 0; top: 42px; }
.nav-btn.center { left: 42px; top: 42px; }

.output-shell,
.rhythm-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.output-block {
  display: flex;
  justify-content: flex-start;
}

.pattern-select {
  min-height: 36px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
  padding: 0 10px;
}

.rhythm-level {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 1.1px;
}

.rhythm-note {
  font-family: var(--font-hardware);
  font-size: 10px;
  letter-spacing: 1.1px;
  color: #ff9198;
  text-transform: uppercase;
}

@media (max-width: 1400px) {
  .center-main-panel {
    min-width: 760px;
  }
}
</style>
