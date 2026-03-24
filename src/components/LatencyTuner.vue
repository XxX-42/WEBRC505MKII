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
          <div class="lcd-line">AUDIO LATENCY</div>
          <div class="lcd-line small">Browser and compensation status</div>
          <div class="lcd-line small">Use loopback for round-trip test</div>
        </div>
      </div>

      <div class="stats-panel">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Sample Rate</div>
            <div class="stat-value">{{ latencyInfo.sampleRate }} Hz</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Base I/O</div>
            <div class="stat-value">{{ formatLatency(latencyInfo.baseLatencyMs) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Output I/O</div>
            <div class="stat-value">{{ formatLatency(latencyInfo.outputLatencyMs) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Est. Monitor</div>
            <div class="stat-value">{{ formatLatency(latencyInfo.estimatedMonitoringLatencyMs) }}</div>
          </div>
        </div>
      </div>

      <div class="diagnostic-panel">
        <div class="diagnostic-title">LATENCY DIAGNOSTICS</div>
        <div class="diagnostic-list">
          <div class="diagnostic-row">
            <span class="diagnostic-key">Browser</span>
            <span class="diagnostic-value">{{ diagnostics.browser }}</span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">Input</span>
            <span class="diagnostic-value">{{ diagnostics.inputDevice }}</span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">Output</span>
            <span class="diagnostic-value">{{ diagnostics.outputDevice }}</span>
          </div>
          <div class="diagnostic-row">
            <span class="diagnostic-key">Virtual Chain</span>
            <span class="diagnostic-value" :class="{ warning: diagnostics.virtualChainDetected }">
              {{ diagnostics.virtualChainDetected ? `YES - ${diagnostics.virtualChainReason}` : 'NO' }}
            </span>
          </div>
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

      <div class="result-panel">
        <div class="result-label">ROUND-TRIP COMPENSATION</div>
        <div class="result-value">
          <span class="value-digits">{{ measuredLatencyDisplay }}</span>
          <span class="value-unit">ms</span>
        </div>
        <div class="result-note">
          {{ latency !== null ? 'Measured by loopback test' : 'Run loopback test to calibrate' }}
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
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine, type LatencyInfo } from '../audio/AudioEngine';
import HardwareButton from './ui/HardwareButton.vue';

interface DiagnosticsInfo {
  browser: string;
  inputDevice: string;
  outputDevice: string;
  virtualChainDetected: boolean;
  virtualChainReason: string;
}

const isCollapsed = ref(true);
const isRunning = ref(false);
const latency = ref<number | null>(null);
const error = ref<string | null>(null);
const latencyInfo = ref<LatencyInfo>({
  sampleRate: 44100,
  baseLatencyMs: null,
  outputLatencyMs: null,
  estimatedMonitoringLatencyMs: null,
  roundTripLatencyMs: null,
});
const diagnostics = ref<DiagnosticsInfo>({
  browser: 'Detecting...',
  inputDevice: 'Detecting...',
  outputDevice: 'Detecting...',
  virtualChainDetected: false,
  virtualChainReason: '',
});
let unsubscribeLatency: (() => void) | null = null;

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};

const measuredLatencyDisplay = computed(() => {
  const roundTrip = latency.value ?? latencyInfo.value.roundTripLatencyMs;
  return roundTrip !== null ? roundTrip.toFixed(2) : '--';
});

const formatLatency = (value: number | null) => {
  return value !== null ? `${value.toFixed(2)} ms` : 'N/A';
};

const getBrowserLabel = () => {
  const uaData = (navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }> }
  }).userAgentData;
  if (uaData?.brands?.length) {
    const primaryBrand = uaData.brands.find((brand: { brand: string; version: string }) => !brand.brand.includes('Not'));
    if (primaryBrand) {
      return `${primaryBrand.brand} ${primaryBrand.version}`;
    }
  }

  const ua = navigator.userAgent;
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  if (chromeMatch) {
    return `Chrome ${chromeMatch[1]}`;
  }

  const edgeMatch = ua.match(/Edg\/([\d.]+)/);
  if (edgeMatch) {
    return `Edge ${edgeMatch[1]}`;
  }

  return navigator.appVersion;
};

const getSelectedDeviceLabel = (
  devices: MediaDeviceInfo[],
  selectedId: string | null,
  fallbackLabel: string
) => {
  if (selectedId) {
    const selected = devices.find((device) => device.deviceId === selectedId);
    if (selected?.label) {
      return selected.label;
    }
  }

  const defaultDevice = devices.find((device) => device.deviceId === 'default' || device.label.toLowerCase().includes('default'));
  if (defaultDevice?.label) {
    return defaultDevice.label;
  }

  return fallbackLabel;
};

const analyzeVirtualChain = (labels: string[]) => {
  const virtualKeywords = [
    'virtual',
    'voicemeeter',
    'vb-audio',
    'vac',
    'streaming',
    'steam streaming',
    'remote audio',
    'nomachine',
  ];

  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const matchedKeyword = virtualKeywords.find((keyword) => normalizedLabels.some((label) => label.includes(keyword)));

  return {
    detected: Boolean(matchedKeyword),
    reason: matchedKeyword ? matchedKeyword.toUpperCase() : '',
  };
};

const refreshDiagnostics = async () => {
  const engine = AudioEngine.getInstance();
  const browser = getBrowserLabel();

  try {
    const { inputs, outputs } = await engine.getDevices();
    const inputDevice = getSelectedDeviceLabel(inputs, engine.selectedInputDeviceId, 'System Default Input');
    const outputDevice = getSelectedDeviceLabel(outputs, engine.selectedOutputDeviceId, 'System Default Output');
    const virtualChain = analyzeVirtualChain([inputDevice, outputDevice]);

    diagnostics.value = {
      browser,
      inputDevice,
      outputDevice,
      virtualChainDetected: virtualChain.detected,
      virtualChainReason: virtualChain.reason,
    };
  } catch {
    diagnostics.value = {
      browser,
      inputDevice: 'Unavailable',
      outputDevice: 'Unavailable',
      virtualChainDetected: false,
      virtualChainReason: '',
    };
  }
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

onMounted(() => {
  const engine = AudioEngine.getInstance();
  latencyInfo.value = engine.getLatencyInfo();
  unsubscribeLatency = engine.onLatencyInfoChange((info) => {
    latencyInfo.value = info;
    refreshDiagnostics();
  });
  refreshDiagnostics();
});

onUnmounted(() => {
  unsubscribeLatency?.();
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

.stats-panel {
  padding: 12px;
  background: var(--panel-elevated);
  border-radius: 4px;
  border: 1px solid var(--panel-border);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.stat-card {
  padding: 10px;
  border-radius: 4px;
  background: var(--bg-groove-dark);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.stat-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 6px;
}

.stat-value {
  font-family: var(--font-hardware);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.8px;
  color: var(--text-primary);
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

.diagnostic-panel {
  padding: 12px;
  background: var(--panel-elevated);
  border-radius: 4px;
  border: 1px solid var(--panel-border);
}

.diagnostic-title {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.diagnostic-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diagnostic-row {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 10px;
  align-items: start;
}

.diagnostic-key {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.8px;
  color: var(--text-muted);
  text-transform: uppercase;
}

.diagnostic-value {
  font-family: var(--font-hardware);
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-primary);
  word-break: break-word;
}

.diagnostic-value.warning {
  color: var(--led-yellow-overdub);
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

.result-note {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-muted);
  text-align: center;
  letter-spacing: 0.4px;
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
