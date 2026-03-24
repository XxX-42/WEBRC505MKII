<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isOpen" class="modal-overlay" @click="handleOverlayClick">
        <div class="modal-container" @click.stop>
          <div class="modal-header">
            <h2 class="modal-title">BROWSER AUDIO SETTINGS</h2>
            <button class="close-btn" @click="close" aria-label="Close browser audio settings">×</button>
          </div>

          <div class="modal-content">
            <div class="setting-group">
              <label class="setting-label" for="browser-input-device">INPUT DEVICE</label>
              <select id="browser-input-device" v-model="selectedInput" @change="handleInputChange" class="device-select">
                <option v-for="device in inputDevices" :key="device.id" :value="device.id">
                  {{ device.name }}
                </option>
              </select>
            </div>

            <div class="setting-group">
              <label class="setting-label" for="browser-output-device">OUTPUT DEVICE</label>
              <select id="browser-output-device" v-model="selectedOutput" @change="handleOutputChange" class="device-select">
                <option v-for="device in outputDevices" :key="device.id" :value="device.id">
                  {{ device.name }}
                </option>
              </select>
            </div>

            <div class="setting-group monitoring-group">
              <label class="setting-label monitoring-label">
                <input
                  type="checkbox"
                  v-model="monitoringEnabled"
                  @change="handleMonitoringChange"
                  class="monitoring-checkbox"
                >
                <span class="checkbox-custom"></span>
                <span>SOFTWARE MONITORING</span>
              </label>
              <div class="warning-box">
                <div class="warning-icon">WARNING</div>
                <div class="warning-content">
                  <strong>Browser monitoring affects live passthrough only.</strong>
                  <p>Recording offset below corrects loop write position, not live monitoring feel.</p>
                </div>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-group half">
                <label class="setting-label">SAMPLE RATE</label>
                <div class="readonly-field">{{ sampleRate }} Hz</div>
              </div>

              <div class="setting-group half">
                <label class="setting-label">ROUND TRIP COMP</label>
                <div class="readonly-field">{{ roundTripDisplay }}</div>
              </div>
            </div>

            <div class="action-row">
              <HardwareButton
                size="md"
                color="blue"
                label="TEST TONE"
                aria-label="Play browser output test tone"
                @press="playTestTone"
              />
              <HardwareButton
                size="md"
                color="white"
                :label="isTesting ? 'TESTING...' : 'RUN LOOPBACK'"
                aria-label="Run browser loopback latency test"
                @press="runLoopback"
              />
            </div>

            <BrowserRecordingOffsetSettings
              :sample-rate="sampleRate"
              :input-device-id="selectedInput || null"
              :output-device-id="selectedOutput || null"
              :buffer-frames="128"
            />

            <div class="status-box">
              <div class="status-line">
                <span>MODE</span>
                <span>BROWSER WEB AUDIO</span>
              </div>
              <div class="status-line">
                <span>STATUS</span>
                <span>{{ uiStatus.message }}</span>
              </div>
              <div v-if="uiStatus.lastError" class="status-error">
                {{ uiStatus.lastError }}
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <HardwareButton
              size="lg"
              color="white"
              label="CLOSE"
              aria-label="Close browser audio settings"
              @press="close"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed } from 'vue';
import { AudioEngine, type AudioDeviceInfo, type AudioUiStatus } from '../audio/AudioEngine';
import BrowserRecordingOffsetSettings from './BrowserRecordingOffsetSettings.vue';
import HardwareButton from './ui/HardwareButton.vue';

const props = defineProps<{
  modelValue: boolean
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>();

const engine = AudioEngine.getInstance();

const isOpen = ref(props.modelValue);
const inputDevices = ref<AudioDeviceInfo[]>([]);
const outputDevices = ref<AudioDeviceInfo[]>([]);
const selectedInput = ref('');
const selectedOutput = ref('');
const monitoringEnabled = ref(engine.monitoringEnabled);
const uiStatus = ref<AudioUiStatus>(engine.getUiStatus());
const sampleRate = ref(engine.selectedSampleRate);
const isTesting = ref(false);
let unsubscribeMonitoring: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let unsubscribeLatency: (() => void) | null = null;

const roundTripDisplay = computed(() => {
  const latency = engine.getLatencyInfo().roundTripLatencyMs;
  return latency !== null ? `${latency.toFixed(2)} ms` : 'NOT SET';
});

watch(() => props.modelValue, (value) => {
  isOpen.value = value;
  if (value) {
    void loadDevices();
  }
});

onMounted(async () => {
  unsubscribeMonitoring = engine.onMonitoringChange((enabled) => {
    monitoringEnabled.value = enabled;
  });
  unsubscribeStatus = engine.onStatusChange((status) => {
    uiStatus.value = status;
  });
  unsubscribeLatency = engine.onLatencyInfoChange((latency) => {
    sampleRate.value = latency.sampleRate;
  });

  if (isOpen.value) {
    await loadDevices();
  }
});

onUnmounted(() => {
  unsubscribeMonitoring?.();
  unsubscribeStatus?.();
  unsubscribeLatency?.();
});

const loadDevices = async () => {
  try {
    const selection = await engine.getDevices();
    inputDevices.value = selection.inputs;
    outputDevices.value = selection.outputs;
    sampleRate.value = selection.sampleRates[0] ?? engine.selectedSampleRate;
    selectedInput.value = engine.selectedInputDeviceId || selection.inputs[0]?.id || '';
    selectedOutput.value = engine.selectedOutputDeviceId || selection.outputs[0]?.id || '';
    monitoringEnabled.value = engine.monitoringEnabled;
  } catch (error) {
    console.error('Failed to load browser devices:', error);
  }
};

const handleInputChange = async () => {
  try {
    await engine.setInputDevice(selectedInput.value);
  } catch (error) {
    alert(`Failed to change browser input device: ${error}`);
  }
};

const handleOutputChange = async () => {
  try {
    await engine.setOutputDevice(selectedOutput.value);
  } catch (error) {
    alert(`Failed to change browser output device: ${error}`);
  }
};

const handleMonitoringChange = async () => {
  if (monitoringEnabled.value) {
    const confirmed = confirm(
      'WARNING: Enabling browser monitoring with speakers may cause loud feedback.\n\n' +
      'Use headphones only.\n\n' +
      'Continue?'
    );

    if (!confirmed) {
      monitoringEnabled.value = false;
      return;
    }
  }

  try {
    await engine.setMonitoring(monitoringEnabled.value);
  } catch (error) {
    alert(`Failed to change browser monitoring: ${error}`);
    monitoringEnabled.value = engine.monitoringEnabled;
  }
};

const playTestTone = () => {
  engine.playTestTone();
};

const runLoopback = async () => {
  isTesting.value = true;
  try {
    const latency = await engine.runLoopbackTest();
    engine.setLatency(latency);
  } catch (error) {
    alert(`Loopback test failed: ${error}`);
  } finally {
    isTesting.value = false;
  }
};

const close = () => {
  isOpen.value = false;
  emit('update:modelValue', false);
};

const handleOverlayClick = () => {
  close();
};
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}

.modal-container {
  background: var(--bg-panel-secondary);
  border: 3px solid #0d0d0d;
  border-radius: var(--border-radius-hardware);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    inset 0 -1px 0 rgba(0, 0, 0, 0.8),
    0 8px 32px rgba(0, 0, 0, 0.9);
  width: 90%;
  max-width: 760px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  background: linear-gradient(180deg, #1a1a1a 0%, #0f0f0f 100%);
  border-bottom: 2px solid #0d0d0d;
}

.modal-title {
  font-family: var(--font-hardware);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--led-blue-accent);
}

.close-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 24px;
  cursor: pointer;
}

.modal-content {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow-y: auto;
}

.setting-row,
.action-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.setting-group.half {
  flex: 1;
}

.setting-label {
  font-family: var(--font-hardware);
  font-size: 11px;
  letter-spacing: 1.4px;
  color: #888;
}

.device-select,
.readonly-field {
  background: var(--bg-groove-dark);
  color: var(--text-primary);
  border: 1px solid #333;
  border-radius: 6px;
  padding: 10px 12px;
  min-height: 42px;
}

.monitoring-group {
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
}

.monitoring-label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.monitoring-checkbox {
  display: none;
}

.checkbox-custom {
  width: 18px;
  height: 18px;
  border: 1px solid #555;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.monitoring-checkbox:checked + .checkbox-custom {
  background: var(--led-red-recording);
  box-shadow: var(--glow-red-soft);
}

.warning-box {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  background: rgba(0, 153, 255, 0.08);
  border: 1px solid rgba(0, 153, 255, 0.18);
  border-radius: 8px;
}

.warning-icon {
  font-family: var(--font-hardware);
  color: var(--led-blue-accent);
  font-size: 11px;
}

.warning-content {
  color: var(--text-primary);
  font-size: 12px;
}

.status-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.status-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.status-error {
  color: #ff8b8b;
  font-size: 12px;
}

.modal-footer {
  padding: 18px 24px;
  display: flex;
  justify-content: flex-end;
  border-top: 2px solid #0d0d0d;
}
</style>
