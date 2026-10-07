<template>
  <div class="latency-tuner" :class="{ collapsed: isCollapsed }">
    <div class="tuner-header" @click="toggleCollapse">
      <div class="header-label">
        <span class="label-icon">IO</span>
        <span>AUDIO TEST</span>
      </div>
      <button class="collapse-btn" :class="{ collapsed: isCollapsed }" aria-label="Toggle audio performance panel">
        {{ isCollapsed ? 'OPEN' : 'CLOSE' }}
      </button>
    </div>

    <div v-if="!isCollapsed" class="tuner-content">
      <div class="legacy-summary">
        <div class="summary-title">{{ latencyInfo.mode === 'browser' ? 'BROWSER AUDIO' : 'NATIVE AUDIO' }} · {{ latencyInfo.backend ?? '--' }}</div>
        <div class="summary-line">{{ latencyInfo.sampleRate }} Hz graph · {{ latencyInfo.bufferFrames }} frames</div>
        <div class="summary-line">{{ latencyInfo.engineRunning ? 'ENGINE READY' : 'ENGINE WAITING' }} · {{ latencyInfo.xrunsOrDropouts ?? 'UNKNOWN' }} reported XRUNs</div>
      </div>

      <AudioPerformanceDashboard />

      <HardwareButton
        size="md"
        color="blue"
        :active="isRefreshing"
        :label="isRefreshing ? 'REFRESHING...' : 'REFRESH STATUS'"
        :aria-label="latencyInfo.mode === 'browser' ? 'Refresh browser audio status' : 'Refresh native status'"
        @press="refreshStatus"
        class="test-button"
      />

      <div v-if="uiError" class="error-panel" role="alert">
        <div class="error-icon">ERR</div>
        <div class="error-text">{{ uiError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine, type LatencyInfo } from '../audio/AudioEngine';
import AudioPerformanceDashboard from './AudioPerformanceDashboard.vue';
import HardwareButton from './ui/HardwareButton.vue';

const isCollapsed = ref(true);
const isRefreshing = ref(false);
const uiError = ref('');
const latencyInfo = ref<LatencyInfo>(AudioEngine.getInstance().getLatencyInfo());
let unsubscribeLatency: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};

const refreshStatus = async () => {
  isRefreshing.value = true;
  uiError.value = '';

  try {
    await AudioEngine.getInstance().init();
  } catch (error) {
    uiError.value = String(error);
  } finally {
    latencyInfo.value = AudioEngine.getInstance().getLatencyInfo();
    isRefreshing.value = false;
  }
};

onMounted(() => {
  const engine = AudioEngine.getInstance();
  unsubscribeLatency = engine.onLatencyInfoChange((info) => {
    latencyInfo.value = info;
  });
  unsubscribeStatus = engine.onStatusChange((status) => {
    uiError.value = status.lastError;
  });
});

onUnmounted(() => {
  unsubscribeLatency?.();
  unsubscribeStatus?.();
});
</script>

<style scoped>
.latency-tuner {
  position: relative;
  width: 360px;
  max-height: min(72vh, 780px);
  background: var(--bg-panel-secondary);
  border: 2px solid #0d0d0d;
  border-radius: var(--border-radius-hardware);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    inset 0 -1px 0 rgba(0, 0, 0, 0.8),
    0 4px 12px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  transition: all 0.3s ease-out;
}

.latency-tuner.collapsed {
  width: 128px;
}

.tuner-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-groove-dark);
  border-bottom: 1px solid rgba(0, 0, 0, 0.6);
  cursor: pointer;
  user-select: none;
}

.header-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(240, 240, 240, 0.65);
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.collapse-btn {
  background: transparent;
  border: none;
  color: rgba(240, 240, 240, 0.55);
  font-size: 10px;
  cursor: pointer;
}

.tuner-content {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(min(72vh, 780px) - 48px);
  overflow-y: auto;
}

.legacy-summary,
.error-panel {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.12);
}

.summary-title {
  font-family: var(--font-hardware);
  font-size: 9px;
  letter-spacing: 0.7px;
}

.summary-line {
  margin-top: 3px;
  color: #9ca3aa;
  font-family: var(--font-mono);
  font-size: 9px;
}

.test-button {
  width: 100%;
}

.error-panel {
  display: flex;
  gap: 10px;
  align-items: center;
  background: rgba(255, 0, 51, 0.08);
  border-color: rgba(255, 0, 51, 0.18);
}

.error-icon {
  font-family: var(--font-hardware);
  color: var(--led-red-recording);
}

.error-text {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 11px;
}
</style>
