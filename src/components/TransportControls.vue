<template>
  <div class="transport-bar">
    <div class="bpm-module">
      <div class="module-label">TEMPO</div>
      <div class="led-display-container">
        <div class="led-display">
          <span class="led-digits">{{ bpmDisplay }}</span>
        </div>
        <div class="bpm-controls" :class="{ 'is-disabled': controlsDisabled }">
          <button @click="adjustBpm(-1)" class="bpm-adjust-btn" aria-label="Decrease BPM" :disabled="controlsDisabled">
            <span>-</span>
          </button>
          <button @click="adjustBpm(1)" class="bpm-adjust-btn" aria-label="Increase BPM" :disabled="controlsDisabled">
            <span>+</span>
          </button>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="transport-controls">
      <HardwareButton
        size="lg"
        :color="isPlaying ? 'red' : 'green'"
        :active="isPlaying"
        :label="isPlaying ? 'STOP ALL' : 'PLAY ALL'"
        :aria-label="isPlaying ? 'Stop all tracks' : 'Play all tracks'"
        :disabled="controlsDisabled"
        @press="toggleTransport"
        class="transport-button"
      />

      <HardwareButton
        size="sm"
        color="blue"
        :active="tapActive"
        label="TAP"
        aria-label="Tap tempo"
        :disabled="controlsDisabled"
        @press="handleTap"
        class="tap-button"
        :class="{ 'is-disabled': controlsDisabled }"
      />
    </div>

    <div class="divider"></div>

    <div class="beat-indicator-module" :class="{ 'is-disabled': beatDisabled }">
      <div class="module-label">BEAT</div>
      <div class="beat-led" :class="{ active: beatIndicator }"></div>
      <div v-if="showBeatReason" class="module-note">{{ beatUnavailableReason }}</div>
    </div>

    <div v-if="audioMode === 'browser'" class="midi-clock-module">
      <div class="module-label">MIDI CLOCK</div>
      <button
        class="midi-clock-button"
        type="button"
        :disabled="clockSnapshot.connection === 'connecting'"
        :aria-label="clockSnapshot.connection === 'connected' ? 'Disconnect MIDI clock input' : 'Connect MIDI clock input'"
        @click="toggleMidiClock"
      >
        {{ clockSnapshot.connection === 'connecting' ? 'CONNECTING…' : clockSnapshot.connection === 'connected' ? 'DISCONNECT' : 'CONNECT' }}
      </button>
      <div class="midi-clock-status" role="status" aria-live="polite" data-testid="midi-clock-status">
        {{ midiClockStatus }}
      </div>
    </div>

    <div class="divider"></div>

    <div class="thru-module">
      <HardwareButton
        size="sm"
        color="red"
        :active="isThruActive"
        label="THRU"
        :aria-label="thruAriaLabel"
        :disabled="monitoringDisabled"
        @press="toggleThru"
        class="thru-button"
      />
      <p v-if="monitoringError" class="thru-error" role="alert">{{ monitoringError }}</p>
    </div>

    <div class="divider"></div>

    <div class="settings-module">
      <HardwareButton
        size="md"
        color="white"
        label="SETTINGS"
        aria-label="Open audio settings"
        @press="openSettings"
        class="settings-button"
      />
    </div>

    <AudioSettings v-if="audioMode === 'native'" v-model="showSettings" />
    <BrowserAudioSettings v-else v-model="showSettings" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Transport } from '../core/Transport';
import { TrackState, TransportState } from '../core/types';
import { AudioEngine } from '../audio/AudioEngine';
import { MidiClockInputController, type MidiClockSnapshot } from '../audio/MidiClockInputController';
import HardwareButton from './ui/HardwareButton.vue';
import AudioSettings from './AudioSettings.vue';
import BrowserAudioSettings from './BrowserAudioSettings.vue';
import { useMonitoringControls } from '../composables/useMonitoringControls';

const transport = Transport.getInstance();
const engine = AudioEngine.getInstance();
const capabilities = engine.getCapabilities();

const bpm = ref(transport.bpm);
const isPlaying = ref(false);
const beatIndicator = ref(false);
const tapActive = ref(false);
const showSettings = ref(false);
const nativeReady = ref(engine.isNativeReady());
const audioMode = ref(engine.getMode());
const monitoring = useMonitoringControls(engine);
const isThruActive = monitoring.active;
const monitoringError = monitoring.error;
const monitoringPending = monitoring.pending;
const monitoringReady = monitoring.ready;
const monitoringDisabled = computed(() => !monitoringReady.value || monitoringPending.value);
const midiClock = new MidiClockInputController({ onChange: () => refreshMidiClock() });
const clockSnapshot = ref<MidiClockSnapshot>(midiClock.getSnapshot());
let clockRefreshTimer: number | null = null;
const thruAriaLabel = computed(() => monitoringPending.value
  ? 'Changing direct monitoring state'
  : !monitoringReady.value
    ? `Direct monitoring unavailable: ${monitoring.unavailableReason.value}`
    : isThruActive.value ? 'Disable direct monitoring' : 'Enable direct monitoring');
let unsubscribeStatus: (() => void) | null = null;

const bpmDisplay = computed(() => bpm.value.toString().padStart(3, '0'));
const controlsDisabled = computed(() => !nativeReady.value);
const beatDisabled = computed(() => controlsDisabled.value || !capabilities.supportsBeatFeedback);
const beatUnavailableReason = capabilities.beatReason;
const showBeatReason = computed(() => !capabilities.supportsBeatFeedback);
const midiClockStatus = computed(() => {
  const snapshot = clockSnapshot.value;
  switch (snapshot.connection) {
    case 'connecting': return 'Waiting for MIDI permission';
    case 'unsupported': return 'Web MIDI unavailable';
    case 'permission-denied': return 'MIDI permission denied';
    case 'error': return 'MIDI input error';
    case 'disconnected': return 'Clock monitor off';
  }
  if (snapshot.inputCount === 0) return 'Connected · no input port';
  if (snapshot.signal === 'ambiguous') return 'Multiple clock sources · ambiguous';
  if (snapshot.signal === 'waiting') return 'Waiting for F8 clock';
  if (snapshot.signal === 'stale') return 'No recent F8 clock';
  if (snapshot.stability === 'stable') return 'Timing steady · monitor only';
  if (snapshot.stability === 'unstable') return 'Timing varies · monitor only';
  return 'F8 observed · checking timing';
});

const refreshMidiClock = () => {
  clockSnapshot.value = midiClock.getSnapshot();
};

const toggleMidiClock = async () => {
  if (clockSnapshot.value.connection === 'connected') midiClock.disconnect();
  else await midiClock.connect();
  refreshMidiClock();
};

const updateState = () => {
  bpm.value = transport.bpm;
};

const clearBeatIndicator = () => {
  beatIndicator.value = false;
  if (beatFlashTimer) {
    clearTimeout(beatFlashTimer);
    beatFlashTimer = null;
  }
};

const hasActiveTracks = () => {
  return engine.tracks.some((track) => (
    track.state === TrackState.RECORDING ||
    track.state === TrackState.PLAYING ||
    track.state === TrackState.OVERDUBBING ||
    track.state === TrackState.REC_STANDBY ||
    track.state === TrackState.REC_FINISHING
  ));
};

const syncPlaybackState = () => {
  if (audioMode.value === 'browser') {
    isPlaying.value = transport.state === TransportState.PLAYING;
    return;
  }

  isPlaying.value = hasActiveTracks();
};

const adjustBpm = (delta: number) => {
  if (controlsDisabled.value) return;
  const newBpm = Math.max(40, Math.min(300, transport.bpm + delta));
  transport.setBpm(newBpm);
  updateState();
};

const toggleTransport = () => {
  if (controlsDisabled.value) return;
  if (isPlaying.value) {
    engine.stopAllTracks();
  } else {
    engine.playAllTracks();
  }
};

const openSettings = () => {
  showSettings.value = true;
};

const toggleThru = () => monitoring.toggle();

let tapTimes: number[] = [];
let tapResetTimer: number | null = null;
let beatFlashTimer: number | null = null;
let tapFlashTimer: number | null = null;

const handleBeat = () => {
  if (beatDisabled.value || audioMode.value !== 'browser' || !isPlaying.value) {
    return;
  }

  beatIndicator.value = true;
  if (beatFlashTimer) {
    clearTimeout(beatFlashTimer);
  }
  beatFlashTimer = window.setTimeout(() => {
    beatIndicator.value = false;
    beatFlashTimer = null;
  }, 100);
};

const handleTransportStart = () => {
  if (audioMode.value === 'browser') {
    isPlaying.value = true;
  }
};

const handleTransportStop = () => {
  if (audioMode.value === 'browser') {
    isPlaying.value = false;
  }
  clearBeatIndicator();
};

const handleTap = () => {
  if (controlsDisabled.value) return;
  tapActive.value = true;
  if (tapFlashTimer) {
    clearTimeout(tapFlashTimer);
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
    for (let i = 1; i < tapTimes.length; i++) {
      const current = tapTimes[i];
      const previous = tapTimes[i - 1];
      if (current !== undefined && previous !== undefined) {
        intervals.push(current - previous);
      }
    }
    if (intervals.length > 0) {
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const calculatedBpm = Math.round(60000 / avgInterval);

      if (calculatedBpm >= 40 && calculatedBpm <= 300) {
        transport.setBpm(calculatedBpm);
        updateState();
      }
    }
  }

  if (tapResetTimer) {
    clearTimeout(tapResetTimer);
  }
  tapResetTimer = window.setTimeout(() => {
    const lastTap = tapTimes[tapTimes.length - 1];
    if (lastTap !== undefined && Date.now() - lastTap > 3000) {
      tapTimes = [];
    }
    tapResetTimer = null;
  }, 3000);
};

onMounted(() => {
  clockRefreshTimer = window.setInterval(refreshMidiClock, 250);
  transport.on('bpm-change', updateState);
  transport.on('beat', handleBeat);
  transport.on('start', handleTransportStart);
  transport.on('stop', handleTransportStop);
  syncPlaybackState();
  unsubscribeStatus = engine.onStatusChange((status) => {
    audioMode.value = status.mode;
    nativeReady.value = status.ready;
    syncPlaybackState();
    if (status.mode !== 'browser' || !status.ready) {
      clearBeatIndicator();
    }
  });
});

onUnmounted(() => {
  midiClock.disconnect();
  transport.off('bpm-change', updateState);
  transport.off('beat', handleBeat);
  transport.off('start', handleTransportStart);
  transport.off('stop', handleTransportStop);

  if (tapResetTimer) {
    clearTimeout(tapResetTimer);
  }
  if (beatFlashTimer) {
    clearTimeout(beatFlashTimer);
  }
  if (tapFlashTimer) {
    clearTimeout(tapFlashTimer);
  }
  unsubscribeStatus?.();
  if (clockRefreshTimer !== null) window.clearInterval(clockRefreshTimer);
});
</script>

<style scoped>
.transport-bar {
  display: flex;
  align-items: stretch;
  gap: 24px;
  padding: 16px 24px;
  background: var(--bg-panel-secondary);
  border: 2px solid #0d0d0d;
  border-radius: var(--border-radius-hardware);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    inset 0 -1px 0 rgba(0, 0, 0, 0.8),
    0 4px 12px rgba(0, 0, 0, 0.8);
}

.is-disabled {
  opacity: 0.42;
  pointer-events: none;
}

.bpm-module,
.transport-controls,
.beat-indicator-module,
.midi-clock-module,
.thru-module,
.settings-module {
  min-height: 92px;
}

.midi-clock-module {
  min-width: 116px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}

.midi-clock-button {
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
  background: #202326;
  color: #d6d6d6;
  font: 700 9px var(--font-mono);
  letter-spacing: 0.6px;
  cursor: pointer;
}

.midi-clock-button:disabled {
  opacity: 0.55;
  cursor: wait;
}

.midi-clock-status {
  max-width: 140px;
  color: rgba(240, 240, 240, 0.62);
  font: 8px var(--font-mono);
  line-height: 1.25;
  text-align: center;
}

.divider {
  width: 2px;
  align-self: center;
  height: 64px;
  background: linear-gradient(
    180deg,
    transparent 0%,
    rgba(255, 255, 255, 0.1) 50%,
    transparent 100%
  );
}

.bpm-module {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.module-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(240, 240, 240, 0.4);
  font-family: var(--font-mono);
  text-align: center;
  text-transform: uppercase;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
}

.module-note {
  min-height: 10px;
  font-size: 8px;
  font-family: var(--font-hardware);
  letter-spacing: 0.8px;
  color: #7f7f7f;
  text-transform: uppercase;
  text-align: center;
}

.led-display-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.led-display {
  position: relative;
  padding: 12px 20px;
  background: #0a0000;
  border: 2px solid #1a0000;
  border-radius: 4px;
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.9),
    inset 0 -1px 2px rgba(255, 0, 0, 0.05),
    0 0 8px rgba(255, 0, 0, 0.1);
}

.led-digits {
  font-family: 'Courier New', 'Roboto Mono', monospace;
  font-size: 32px;
  font-weight: 700;
  color: #ff0033;
  letter-spacing: 4px;
  text-shadow:
    0 0 8px rgba(255, 0, 51, 0.8),
    0 0 16px rgba(255, 0, 51, 0.4),
    0 0 24px rgba(255, 0, 51, 0.2);
  font-variant-numeric: tabular-nums;
}

.bpm-controls {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bpm-adjust-btn {
  width: 28px;
  height: 22px;
  background: var(--gradient-plastic-dark);
  border: 1px solid rgba(0, 0, 0, 0.8);
  border-radius: 3px;
  color: rgba(240, 240, 240, 0.6);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.08s ease-out;
  box-shadow: var(--button-border-raised);
}

.bpm-adjust-btn:hover {
  background: var(--gradient-plastic-light);
  color: rgba(240, 240, 240, 0.9);
}

.bpm-adjust-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.bpm-adjust-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.bpm-adjust-btn:active {
  box-shadow: var(--button-border-pressed);
  transform: translateY(1px);
}

.transport-controls {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  padding-bottom: 2px;
}

.beat-indicator-module {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
}

.thru-module,
.settings-module {
  display: flex;
  align-items: flex-end;
  padding-bottom: 2px;
}

.thru-module {
  position: relative;
}

.thru-error {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  margin: 0;
  max-width: 220px;
  color: #ff9a9a;
  font: 10px/1.4 var(--font-hardware);
}

.beat-led {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #1a1a1a;
  border: 2px solid rgba(0, 0, 0, 0.6);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.8),
    0 1px 1px rgba(255, 255, 255, 0.05);
  transition: all 0.05s ease-out;
}

.beat-led.active {
  background: var(--led-red-recording);
  box-shadow:
    0 0 8px rgba(255, 0, 51, 0.8),
    0 0 16px rgba(255, 0, 51, 0.5),
    inset 0 1px 2px rgba(255, 255, 255, 0.2);
}

@media (max-width: 768px) {
  .transport-bar {
    flex-wrap: wrap;
    justify-content: center;
    gap: 16px;
  }

  .divider {
    display: none;
  }
}
</style>
