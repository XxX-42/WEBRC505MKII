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
          <div class="lcd-line">LOOPBACK TEST</div>
          <div class="lcd-line small">Connect output to input</div>
          <div class="lcd-line small">Mute speakers to avoid feedback</div>
        </div>
      </div>

      <HardwareButton
        size="md"
        color="blue"
        :active="isRunning"
        :label="isRunning ? 'TESTING...' : 'RUN TEST'"
        aria-label="Run latency test"
        @press="runTest"
        class="test-button"
      />

      <div v-if="latency !== null" class="result-panel">
        <div class="result-label">MEASURED LATENCY</div>
        <div class="result-value">
          <span class="value-digits">{{ latency.toFixed(2) }}</span>
          <span class="value-unit">ms</span>
        </div>
      </div>

      <div v-if="error" class="error-panel">
        <div class="error-icon">ERR</div>
        <div class="error-text">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import HardwareButton from './ui/HardwareButton.vue';

const isCollapsed = ref(true);
const isRunning = ref(false);
const latency = ref<number | null>(null);
const error = ref<string | null>(null);

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};

const runTest = async () => {
  isRunning.value = true;
  error.value = null;
  latency.value = null;

  try {
    const engine = AudioEngine.getInstance();
    await engine.init();
    const result = await engine.runLoopbackTest();

    if (result < 0) {
      error.value = 'Signal not detected. Check loopback.';
    } else {
      latency.value = result;
      engine.setLatency(result);
    }
  } catch (e) {
    error.value = 'Test failed: ' + e;
  } finally {
    isRunning.value = false;
  }
};
</script>

<style scoped>
.latency-tuner {
  position: relative;
  width: 320px;
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
  width: 120px;
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
  transition: background 0.2s ease-out;
}

.tuner-header:hover {
  background: rgba(26, 26, 26, 0.8);
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

.label-icon {
  font-size: 11px;
  opacity: 0.7;
}

.collapse-btn {
  background: transparent;
  border: none;
  color: rgba(240, 240, 240, 0.4);
  font-size: 10px;
  cursor: pointer;
  padding: 4px;
  transition: all 0.2s ease-out;
}

.collapse-btn:hover {
  color: rgba(240, 240, 240, 0.7);
  transform: scale(1.05);
}

.collapse-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.tuner-content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.lcd-panel {
  padding: 12px;
  background: #0f1f0f;
  border: 2px solid #1a2a1a;
  border-radius: 4px;
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.8),
    inset 0 -1px 2px rgba(0, 255, 0, 0.05);
}

.lcd-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lcd-line {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  color: #00ff66;
  letter-spacing: 0.5px;
  text-shadow: 0 0 4px rgba(0, 255, 102, 0.4);
}

.lcd-line.small {
  font-size: 9px;
  opacity: 0.7;
}

.test-button {
  align-self: center;
}

.result-panel {
  padding: 12px;
  background: var(--bg-groove-dark);
  border-radius: 4px;
  border: 1px solid rgba(0, 255, 102, 0.2);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.result-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  color: rgba(240, 240, 240, 0.4);
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.result-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.value-digits {
  font-family: 'Courier New', 'Roboto Mono', monospace;
  font-size: 28px;
  font-weight: 700;
  color: #00ff66;
  letter-spacing: 2px;
  text-shadow:
    0 0 8px rgba(0, 255, 102, 0.8),
    0 0 16px rgba(0, 255, 102, 0.4);
  font-variant-numeric: tabular-nums;
}

.value-unit {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: rgba(0, 255, 102, 0.6);
  text-transform: uppercase;
}

.error-panel {
  padding: 12px;
  background: rgba(255, 0, 51, 0.1);
  border: 1px solid rgba(255, 0, 51, 0.3);
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.error-icon {
  font-size: 12px;
  font-family: var(--font-hardware);
  color: var(--led-red-recording);
}

.error-text {
  font-family: var(--font-mono);
  font-size: 10px;
  color: rgba(255, 0, 51, 0.9);
  line-height: 1.4;
}

@media (max-width: 768px) {
  .latency-tuner,
  .latency-tuner.collapsed {
    width: 100%;
  }
}
</style>
