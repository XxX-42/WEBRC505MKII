<template>
  <aside class="web-tool-layer" data-panel="tool-layer">
    <div class="tool-actions">
      <button
        class="tool-btn"
        type="button"
        :disabled="monitoringDisabled"
        :aria-label="thruAriaLabel"
        :title="thruDisabledTitle"
        @click="toggleThru"
      >
        THRU {{ isThruActive ? 'ON' : 'OFF' }}
      </button>
      <button class="tool-btn" type="button" @click="openSettings">
        AUDIO SETTINGS
      </button>
      <p v-if="monitoringError" class="thru-error" role="alert">{{ monitoringError }}</p>
    </div>

    <LatencyTuner class="tool-latency" />

    <AudioSettings v-if="audioMode === 'native'" v-model="showSettings" />
    <BrowserAudioSettings v-else v-model="showSettings" />
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import AudioSettings from './AudioSettings.vue';
import BrowserAudioSettings from './BrowserAudioSettings.vue';
import LatencyTuner from './LatencyTuner.vue';
import { useMonitoringControls } from '../composables/useMonitoringControls';
import { useUiStyle } from '../composables/useUiStyle';
import { useDevicePanel } from '../composables/useDevicePanel';

const engine = AudioEngine.getInstance();
const { currentStyle } = useUiStyle();
const device = useDevicePanel();
const showSettings = ref(false);
const audioMode = ref(engine.getMode());
const monitoring = useMonitoringControls(engine);
const isThruActive = monitoring.active;
const monitoringError = monitoring.error;
const monitoringPending = monitoring.pending;
const monitoringReady = monitoring.ready;
const monitoringDisabled = computed(() => !monitoringReady.value || monitoringPending.value);
const thruDisabledTitle = computed(() => !monitoringReady.value ? monitoring.unavailableReason.value : undefined);
const thruAriaLabel = computed(() => monitoringPending.value
  ? 'Changing direct monitoring state'
  : !monitoringReady.value
    ? `Direct monitoring unavailable: ${monitoring.unavailableReason.value}`
    : isThruActive.value ? 'Disable direct monitoring' : 'Enable direct monitoring');
let unsubscribeStatus: (() => void) | null = null;
const AUDIO_SETTINGS_EVENT = 'rc505-open-audio-settings';

const openSettings = () => {
  window.dispatchEvent(new Event(AUDIO_SETTINGS_EVENT));
};

const toggleThru = () => monitoring.toggle();
const handleSettingsRequested = () => {
  if (currentStyle.value === 'classic') { device.openPage('settings'); return; }
  showSettings.value = true;
};

onMounted(() => {
  window.addEventListener(AUDIO_SETTINGS_EVENT, handleSettingsRequested);
  unsubscribeStatus = engine.onStatusChange((status) => {
    audioMode.value = status.mode;
  });
});

onUnmounted(() => {
  window.removeEventListener(AUDIO_SETTINGS_EVENT, handleSettingsRequested);
  unsubscribeStatus?.();
});
</script>

<style scoped>
.web-tool-layer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-end;
}

.tool-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.tool-btn {
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--shell-divider);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  font-family: var(--font-hardware);
  font-size: 11px;
  letter-spacing: 1.1px;
  text-transform: uppercase;
  cursor: pointer;
}

.tool-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.thru-error {
  flex-basis: 100%;
  max-width: 360px;
  margin: 0;
  color: #ff9a9a;
  font: 10px/1.4 var(--font-hardware);
}

.tool-latency {
  max-width: min(100%, 360px);
}

@media (max-width: 900px) {
  .web-tool-layer {
    align-items: stretch;
  }

  .tool-actions {
    justify-content: flex-start;
  }
}
</style>
