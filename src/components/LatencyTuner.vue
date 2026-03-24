<template>
  <div class="latency-tuner" :class="{ collapsed: isCollapsed }">
    <div class="tuner-header" @click="toggleCollapse">
      <div class="header-label">
        <span class="label-icon">IO</span>
        <span>SYSTEM</span>
      </div>
      <button class="collapse-btn" :class="{ collapsed: isCollapsed }" aria-label="Toggle system panel">
        {{ isCollapsed ? 'OPEN' : 'CLOSE' }}
      </button>
    </div>

    <div v-if="!isCollapsed" class="tuner-content">
      <div class="lcd-panel">
        <div class="lcd-text">
          <div class="lcd-line">NATIVE AUDIO CORE</div>
          <div class="lcd-line small">Bridge-backed realtime diagnostics</div>
          <div class="lcd-line small">Web shell only, no browser audio fallback</div>
        </div>
      </div>

      <div class="stats-panel">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Backend</div>
            <div class="stat-value">{{ latencyInfo.backend ?? '--' }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Sample Rate</div>
            <div class="stat-value">{{ latencyInfo.sampleRate }} Hz</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Buffer</div>
            <div class="stat-value">{{ latencyInfo.bufferFrames }} fr</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Round Trip</div>
            <div class="stat-value">{{ formatLatency(latencyInfo.roundTripLatencyMs) }}</div>
          </div>
        </div>
      </div>

      <div class="diagnostic-panel">
        <div class="diagnostic-title">NATIVE DIAGNOSTICS</div>
        <div class="diagnostic-list">
          <div class="diagnostic-row">
            <span class="diagnostic-key">Bridge</span>
            <span class="diagnostic-value" :class="{ warning: !latencyInfo.bridgeAvailable }">
              {{ latencyInfo.bridgeAvailable ? 'ONLINE' : 'OFFLINE' }}
            </span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">Engine</span>
            <span class="diagnostic-value" :class="{ warning: !latencyInfo.engineRunning }">
              {{ latencyInfo.engineRunning ? 'RUNNING' : 'STOPPED' }}
            </span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">Input Peak</span>
            <span class="diagnostic-value">{{ formatPeak(latencyInfo.inputPeak) }}</span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">Output Peak</span>
            <span class="diagnostic-value">{{ formatPeak(latencyInfo.outputPeak) }}</span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">XRuns</span>
            <span class="diagnostic-value">{{ latencyInfo.xrunsOrDropouts }}</span>
          </div>
        </div>
      </div>

      <HardwareButton
        size="md"
        color="blue"
        :active="isRefreshing"
        :label="isRefreshing ? 'REFRESHING...' : 'REFRESH STATUS'"
        aria-label="Refresh native status"
        @press="refreshStatus"
        class="test-button"
      />

      <div v-if="uiError" class="error-panel">
        <div class="error-icon">ERR</div>
        <div class="error-text">{{ uiError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine, type LatencyInfo } from '../audio/AudioEngine';
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

const formatLatency = (value: number | null) => {
  return value !== null ? `${value.toFixed(2)} ms` : 'N/A';
};

const formatPeak = (value: number) => `${Math.round(value * 100)}%`;

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
  color: rgba(240, 240, 240, 0.5);
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.collapse-btn {
  background: transparent;
  border: none;
  color: rgba(240, 240, 240, 0.4);
  font-size: 10px;
  cursor: pointer;
}

.tuner-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.lcd-panel,
.diagnostic-panel,
.stats-panel,
.error-panel {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 12px;
}

.lcd-line {
  font-family: var(--font-hardware);
  font-size: 12px;
  letter-spacing: 1.3px;
}

.lcd-line.small {
  font-size: 10px;
  color: #8c8c8c;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.stat-card {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  padding: 10px;
}

.stat-label,
.diagnostic-key {
  font-size: 10px;
  letter-spacing: 1px;
  color: #8c8c8c;
  text-transform: uppercase;
  font-family: var(--font-hardware);
}

.stat-value,
.diagnostic-value {
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 13px;
}

.diagnostic-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diagnostic-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.warning {
  color: #ff8b8b;
}

.error-panel {
  display: flex;
  gap: 12px;
  align-items: center;
  background: rgba(255, 0, 51, 0.08);
  border-color: rgba(255, 0, 51, 0.18);
}

.error-icon {
  font-family: var(--font-hardware);
  color: var(--led-red-recording);
}

.error-text {
  font-size: 12px;
}
</style>
