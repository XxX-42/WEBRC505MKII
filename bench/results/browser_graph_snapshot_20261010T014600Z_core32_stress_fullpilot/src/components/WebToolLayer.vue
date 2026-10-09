<template>
  <aside class="web-tool-layer" data-panel="tool-layer">
    <div class="tool-actions">
      <button class="tool-btn" type="button" @click="toggleThru">
        THRU {{ isThruActive ? 'ON' : 'OFF' }}
      </button>
      <button class="tool-btn" type="button" @click="openSettings">
        AUDIO SETTINGS
      </button>
    </div>

    <LatencyTuner class="tool-latency" />

    <AudioSettings v-if="audioMode === 'native'" v-model="showSettings" />
    <BrowserAudioSettings v-else v-model="showSettings" />
  </aside>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import AudioSettings from './AudioSettings.vue';
import BrowserAudioSettings from './BrowserAudioSettings.vue';
import LatencyTuner from './LatencyTuner.vue';

const engine = AudioEngine.getInstance();
const showSettings = ref(false);
const isThruActive = ref(engine.monitoringEnabled);
const audioMode = ref(engine.getMode());
let unsubscribeMonitoring: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

const openSettings = () => {
  showSettings.value = true;
};

const toggleThru = () => {
  if (!isThruActive.value) {
    const confirmed = confirm(
      'WARNING: FEEDBACK RISK!\n\n' +
      'Enabling THRU will route your microphone directly to speakers.\n\n' +
      'Only proceed if you are using headphones.\n\n' +
      'Enable THRU?'
    );

    if (!confirmed) {
      return;
    }
  }

  void engine.setMonitoring(!isThruActive.value);
};

onMounted(() => {
  unsubscribeMonitoring = engine.onMonitoringChange((enabled) => {
    isThruActive.value = enabled;
  });
  unsubscribeStatus = engine.onStatusChange((status) => {
    audioMode.value = status.mode;
  });
});

onUnmounted(() => {
  unsubscribeMonitoring?.();
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
