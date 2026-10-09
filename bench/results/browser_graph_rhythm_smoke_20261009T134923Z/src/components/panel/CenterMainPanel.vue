<template>
  <section class="center-main-panel" data-panel="center-main">
    <div class="left-stack">
      <div class="button-rail vertical">
        <HardwareButton shape="rect" size="sm" color="white" label="MEMORY" aria-label="Open memory controls" @press="showMemoryPanel = true" />
        <HardwareButton shape="rect" size="sm" color="white" label="TRACK SET" aria-label="Open selected track settings" @press="showTrackSettings = true" />
        <HardwareButton shape="rect" size="sm" color="blue" label="AUDIO I/O" aria-label="Open audio input and output settings" @press="showAudioSettings = true" />
        <HardwareButton shape="rect" size="sm" color="blue" label="LOOP SET" aria-label="Open loop and tempo settings" @press="showLoopSettings = true" />
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
          label="UNDO"
          aria-label="Undo selected track"
          @press="dispatchTrackCommand('undo')"
        />
        <HardwareButton shape="rect" size="sm" color="yellow" label="REDO" aria-label="Redo selected track" @press="dispatchTrackCommand('redo')" />
      </div>
    </div>

    <div class="display-cluster">
      <div class="screen-shell">
        <div class="lcd-display">
          <div class="lcd-row top">
            <span>MEMORY</span>
            <span>J={{ bpmDisplay }}.0</span>
          </div>
          <div class="lcd-main">{{ String(activeMemorySlot).padStart(2, '0') }}</div>
          <div class="lcd-name">Memory{{ String(activeMemorySlot).padStart(2, '0') }}</div>
          <div class="lcd-row">
            <span>TRACK {{ currentTrackId }}</span>
            <span>{{ currentTrackState }}</span>
          </div>
          <div class="lcd-row small">
            <span>{{ currentTrackSummary }}</span>
          </div>
        </div>
      </div>

      <div class="selected-track-summary">{{ focusLabel }}</div>
    </div>

    <div class="nav-stack">
      <div class="button-rail">
        <HardwareButton shape="rect" size="sm" color="white" label="EXIT" aria-label="Close open panel" @press="closePanels" />
        <HardwareButton shape="rect" size="sm" color="blue" label="ENTER" aria-label="Open memory controls" @press="showMemoryPanel = true" />
      </div>
      <div class="navigation-ring">
        <button class="nav-btn up" type="button" aria-label="Increase tempo" @click="adjustBpm(1)">+</button>
        <button class="nav-btn left" type="button" aria-label="Select previous track" @click="selectAdjacentTrack(-1)">&lt;</button>
        <button class="nav-btn right" type="button" aria-label="Select next track" @click="selectAdjacentTrack(1)">&gt;</button>
        <button class="nav-btn down" type="button" aria-label="Decrease tempo" @click="adjustBpm(-1)">−</button>
        <button class="nav-btn center" type="button" aria-label="Record or play selected track" @click="dispatchTrackCommand('record-track')">●</button>
      </div>
    </div>

    <div class="right-stack">
      <div class="output-shell" :class="{ unavailable: !canControlMasterLevel }">
        <div class="cluster-title">MASTER LEVEL</div>
        <div class="output-block">
          <HardwareKnob :model-value="outputLevel" :min="0" :max="200" label="" color="red" :size="84" @update:model-value="setOutputLevel" />
        </div>
        <span class="master-level-value">{{ outputLevel }}%</span>
        <span v-if="!canControlMasterLevel" class="module-note">BROWSER OUTPUT CONTROL</span>
      </div>

      <div class="button-rail rhythm-actions">
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
          color="white"
          label="RHYTHM EDIT"
          aria-label="Open rhythm pattern and kit editor"
          @press="showRhythmSettings = true"
        />
      </div>
    </div>

    <Teleport to="body">
      <div v-if="showMemoryPanel || showTrackSettings || showAudioSettings || showLoopSettings || showRhythmSettings" class="panel-modal-backdrop" @click.self="closePanels">
        <section class="panel-modal" role="dialog" aria-modal="true" :aria-label="modalTitle">
          <header class="modal-header"><h2>{{ modalTitle }}</h2><button type="button" aria-label="Close panel" @click="closePanels">×</button></header>
          <MemoryControls v-if="showMemoryPanel" v-model="memorySlot" />
          <TrackSettingsPanel v-else-if="showTrackSettings" :track-id="currentTrackId" />
          <LoopSettingsPanel v-else-if="showLoopSettings" />
          <RhythmEditorPanel v-else-if="showRhythmSettings" />
          <template v-else-if="showAudioSettings">
            <AudioSettings v-if="audioMode === 'native'" v-model="showAudioSettings" />
            <BrowserAudioSettings v-else v-model="showAudioSettings" />
          </template>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import { Transport } from '../../core/Transport';
import { TrackState, TransportState } from '../../core/types';
import { usePanelFocus } from '../../composables/usePanelFocus';
import { useControlDispatcher } from '../../composables/useControlDispatcher';
import { useMemorySlot } from '../../composables/useMemorySlot';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';
import MemoryControls from '../MemoryControls.vue';
import TrackSettingsPanel from '../TrackSettingsPanel.vue';
import LoopSettingsPanel from '../LoopSettingsPanel.vue';
import RhythmEditorPanel from '../RhythmEditorPanel.vue';
import AudioSettings from '../AudioSettings.vue';
import BrowserAudioSettings from '../BrowserAudioSettings.vue';

const engine = AudioEngine.getInstance();
const transport = Transport.getInstance();
const { state, setCurrentTrack } = usePanelFocus();
const { dispatcher } = useControlDispatcher();
const { activeMemorySlot } = useMemorySlot();

const bpm = ref(transport.bpm);
const tapActive = ref(false);
const isPlaying = ref(false);
const outputLevel = ref(100);
const showMemoryPanel = ref(false);
const showTrackSettings = ref(false);
const showAudioSettings = ref(false);
const showLoopSettings = ref(false);
const showRhythmSettings = ref(false);
const memorySlot = ref(activeMemorySlot.value);
const audioMode = ref(engine.getMode());
const currentTrackState = ref('EMPTY');
const currentRuntimeSettings = ref<{
  oneShot: boolean;
  stopMode: string;
  speed: number;
  keepPitch: boolean;
  dubMode: string;
} | null>(null);
let tapFlashTimer: number | null = null;
let tapResetTimer: number | null = null;
let unsubscribeStatus: (() => void) | null = null;
let statePollInterval = 0;
const tapTimes: number[] = [];

const bpmDisplay = computed(() => bpm.value.toString().padStart(3, '0'));
const currentTrackId = computed(() => state.currentTrackId);
const currentTrackSummary = computed(() => {
  const settings = currentRuntimeSettings.value;
  if (!settings) return 'TRACK SETTINGS UNAVAILABLE';
  return `${settings.speed.toFixed(2)}×${settings.keepPitch ? ' PITCH' : ''} ${settings.oneShot ? '1SHOT' : 'LOOP'} ${settings.stopMode}`;
});
const modalTitle = computed(() => showMemoryPanel.value ? 'MEMORY / PROJECT'
  : showTrackSettings.value ? `TRACK ${currentTrackId.value} SETTINGS`
    : showLoopSettings.value ? 'LOOP / TEMPO SETTINGS'
      : showRhythmSettings.value ? 'RHYTHM PATTERN / KIT EDITOR'
    : 'AUDIO SETTINGS');
const masterApi = engine as unknown as { getMasterLevel?: () => number; setMasterLevel?: (value: number) => void };
const canControlMasterLevel = computed(() => engine.getMode() === 'browser'
  && typeof masterApi.getMasterLevel === 'function'
  && typeof masterApi.setMasterLevel === 'function');
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
  track.state === TrackState.REPLACING ||
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
  void dispatcher.dispatch({ type: 'toggle-transport' });
};

const dispatchTrackCommand = (type: 'record-track' | 'undo' | 'redo') => {
  if (type === 'record-track') {
    void dispatcher.dispatch({ type, trackId: currentTrackId.value });
    return;
  }
  void dispatcher.dispatch({ type, trackId: currentTrackId.value });
};

const closePanels = () => {
  showMemoryPanel.value = false;
  showTrackSettings.value = false;
  showAudioSettings.value = false;
  showLoopSettings.value = false;
  showRhythmSettings.value = false;
};

const selectAdjacentTrack = (delta: number) => {
  const nextTrackId = ((currentTrackId.value - 1 + delta + 5) % 5) + 1;
  setCurrentTrack(nextTrackId);
};

const adjustBpm = (delta: number) => {
  transport.setBpm(Math.max(40, Math.min(300, transport.bpm + delta)));
  updateBpm();
};

const setOutputLevel = (value: number) => {
  if (!canControlMasterLevel.value || !masterApi.setMasterLevel) return;
  const safeValue = Math.max(0, Math.min(200, Math.round(value)));
  masterApi.setMasterLevel(safeValue / 100);
  outputLevel.value = safeValue;
};

const syncCurrentTrack = () => {
  const current = engine.tracks[currentTrackId.value - 1] as (typeof engine.tracks[number] & {
    getRuntimeSettings?: () => typeof currentRuntimeSettings.value;
  }) | undefined;
  currentTrackState.value = current?.state ?? 'EMPTY';
  currentRuntimeSettings.value = current?.getRuntimeSettings?.() ?? null;
  if (canControlMasterLevel.value && masterApi.getMasterLevel) {
    outputLevel.value = Math.round(Math.max(0, Math.min(2, masterApi.getMasterLevel())) * 100);
  }
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

onMounted(() => {
  transport.on('bpm-change', updateBpm);
  transport.on('start', syncPlaybackState);
  transport.on('stop', syncPlaybackState);
  syncPlaybackState();
  audioMode.value = engine.getMode();
  syncCurrentTrack();
  statePollInterval = window.setInterval(() => {
    syncPlaybackState();
    syncCurrentTrack();
  }, 100);
  unsubscribeStatus = engine.onStatusChange((status) => {
    audioMode.value = status.mode;
    syncPlaybackState();
    syncCurrentTrack();
  });
});

watch(activeMemorySlot, (slot) => { memorySlot.value = slot; });

onUnmounted(() => {
  transport.off('bpm-change', updateBpm);
  transport.off('start', syncPlaybackState);
  transport.off('stop', syncPlaybackState);
  window.clearInterval(statePollInterval);
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
  grid-template-columns: 142px minmax(320px, 1fr) 108px 150px;
  gap: 10px;
  padding: 12px 12px 10px;
  color: #f3f3f5;
  overflow: hidden;
}

.left-stack,
.nav-stack,
.right-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
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
  gap: 12px;
  align-items: center;
  min-width: 0;
}

.screen-shell {
  padding: 8px;
  border-radius: 8px;
  background: linear-gradient(180deg, #e9edf3 0%, #bfc8d3 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

.lcd-display {
  min-width: 0;
  width: 100%;
  min-height: 136px;
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
  font-size: 62px;
  line-height: 0.9;
  text-align: center;
}

.lcd-name {
  text-align: center;
  font-size: 24px;
  line-height: 1;
}

.lcd-row.small {
  justify-content: center;
  color: rgba(243, 251, 255, 0.74);
}

.knob-row {
  display: grid;
  grid-template-columns: repeat(4, 62px);
  gap: 10px;
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

.output-shell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  min-width: 0;
}

.output-shell.unavailable {
  opacity: 0.5;
  pointer-events: none;
}

.master-level-value,
.selected-track-summary {
  color: #b6c2d2;
  font: 9px var(--font-hardware);
  letter-spacing: 0.8px;
  text-align: center;
}

.panel-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.68);
  backdrop-filter: blur(4px);
}

.panel-modal {
  width: min(880px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 14px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px;
  background: #121419;
  color: #f3f4f7;
  box-shadow: 0 24px 80px rgba(0,0,0,.6);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  font-family: var(--font-hardware);
}

.modal-header h2 {
  margin: 0;
  color: #dce4f0;
  font-size: 12px;
  letter-spacing: 1.1px;
}

.modal-header button {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 50%;
  background: #22252b;
  color: #e6ebf4;
  font-size: 18px;
  cursor: pointer;
}

.output-block {
  display: flex;
  justify-content: flex-start;
}

@media (max-width: 1400px) {
  .center-main-panel {
    min-width: 760px;
  }
}
</style>
