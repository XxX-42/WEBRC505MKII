<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isOpen" class="modal-overlay" @click="handleOverlayClick">
        <div class="modal-container" @click.stop>
          <div class="modal-header">
            <h2 class="modal-title">NATIVE AUDIO SETTINGS</h2>
            <button class="close-btn" @click="close" aria-label="Close audio settings">×</button>
          </div>

          <div class="modal-content">
            <div class="setting-group">
              <label class="setting-label" for="backend">BACKEND</label>
              <select id="backend" v-model="selectedBackend" @change="handleBackendChange" class="device-select" :disabled="!bridgeAvailable">
                <option v-for="backend in backends" :key="backend" :value="backend">{{ backend }}</option>
              </select>
            </div>

            <div class="setting-group">
              <label class="setting-label" for="input-device">INPUT DEVICE</label>
              <select id="input-device" v-model="selectedInput" @change="handleInputChange" class="device-select" :disabled="!bridgeAvailable">
                <option v-for="device in inputDevices" :key="device.id" :value="device.id">
                  {{ device.name }}
                </option>
              </select>
            </div>

            <div class="setting-group">
              <label class="setting-label" for="output-device">OUTPUT DEVICE</label>
              <select id="output-device" v-model="selectedOutput" @change="handleOutputChange" class="device-select" :disabled="!bridgeAvailable">
                <option v-for="device in outputDevices" :key="device.id" :value="device.id">
                  {{ device.name }}
                </option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-group half">
                <label class="setting-label" for="sample-rate">SAMPLE RATE</label>
                <select id="sample-rate" v-model.number="selectedSampleRate" @change="handleSampleRateChange" class="device-select" :disabled="!bridgeAvailable">
                  <option v-for="sampleRate in sampleRates" :key="sampleRate" :value="sampleRate">
                    {{ sampleRate }} Hz
                  </option>
                </select>
                <small v-if="selectedBackend !== 'BROWSER'" class="setting-help">Changing Native sample rate requires all five tracks to be empty. Export or back up loops, clear every track, then change the rate.</small>
              </div>

              <div class="setting-group half">
                <label class="setting-label" for="buffer-frames">BUFFER</label>
                <span v-if="selectedBackend === 'BROWSER'" class="device-select" aria-live="polite">
                  {{ selectedBufferFrames > 0 ? `${selectedBufferFrames} actual frames` : 'Waiting for render quantum' }}
                </span>
                <select v-else id="buffer-frames" v-model.number="selectedBufferFrames" @change="handleBufferChange" class="device-select" :disabled="!bridgeAvailable">
                  <option v-for="buffer in bufferOptions" :key="buffer" :value="buffer">
                    {{ buffer }} frames
                  </option>
                </select>
              </div>
            </div>

            <div v-if="selectedBackend !== 'BROWSER'" class="setting-group">
              <label class="setting-label" for="loop-storage-budget">NATIVE LOOP MEMORY BUDGET</label>
              <select id="loop-storage-budget" v-model.number="selectedLoopStorageBudget" @change="handleLoopStorageBudgetChange" class="device-select" :disabled="!bridgeAvailable">
                <option v-for="budget in loopStorageBudgets" :key="budget.bytes" :value="budget.bytes">{{ budget.label }}</option>
              </select>
              <small class="setting-help">The default 768 MiB covers 300 seconds per track at 48 kHz. Choose 1.5 GiB for 96 kHz or 2.5 GiB for 192 kHz. The Native engine must allocate and touch this loop memory; available system RAM can still limit startup.</small>
            </div>

            <div class="setting-group monitoring-group">
              <label class="setting-label monitoring-label">
                <input
                  type="checkbox"
                  v-model="monitoringEnabled"
                  @change="handleMonitoringChange"
                  class="monitoring-checkbox"
                  :disabled="!bridgeAvailable"
                >
                <span class="checkbox-custom"></span>
                <span>SOFTWARE MONITORING</span>
              </label>
              <div class="warning-box">
                <div class="warning-icon">WARNING</div>
                <div class="warning-content">
                  <strong>DANGER: FEEDBACK RISK</strong>
                  <p>Native monitoring is live passthrough. Use headphones only.</p>
                </div>
              </div>
            </div>

            <div class="setting-group">
              <div class="native-status" :class="{ offline: !bridgeAvailable }">
                <span>{{ bridgeAvailable ? 'Native bridge connected' : 'Native bridge unavailable' }}</span>
                <span v-if="lastError" class="native-status-error">{{ lastError }}</span>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <HardwareButton
              size="lg"
              color="white"
              label="CLOSE"
              aria-label="Close audio settings"
              @press="close"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { AudioEngine, type AudioBackend, type AudioDeviceInfo } from '../audio/AudioEngine';
import HardwareButton from './ui/HardwareButton.vue';

const props = defineProps<{
  modelValue: boolean
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>();

const engine = AudioEngine.getInstance();

const isOpen = ref(props.modelValue);
const backends = ref<AudioBackend[]>([]);
const inputDevices = ref<AudioDeviceInfo[]>([]);
const outputDevices = ref<AudioDeviceInfo[]>([]);
const sampleRates = ref<number[]>([]);
const bufferOptions = ref<number[]>([]);
const selectedBackend = ref<AudioBackend>('WASAPI');
const selectedInput = ref('');
const selectedOutput = ref('');
const selectedSampleRate = ref(48000);
const selectedBufferFrames = ref(128);
const loopStorageBudgets = [
  { bytes: 768 * 1024 * 1024, label: '768 MiB (up to 48 kHz / 300 s)' },
  { bytes: 1536 * 1024 * 1024, label: '1.5 GiB (up to 96 kHz / 300 s)' },
  { bytes: 2560 * 1024 * 1024, label: '2.5 GiB (up to 192 kHz / 300 s)' },
];
const selectedLoopStorageBudget = ref(768 * 1024 * 1024);
const monitoringEnabled = ref(false);
const bridgeAvailable = ref(engine.isBridgeAvailable());
const lastError = ref(engine.getUiStatus().lastError);
let unsubscribeMonitoring: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

watch(() => props.modelValue, (newVal) => {
  isOpen.value = newVal;
  if (newVal) {
    void loadDevices();
  }
});

onMounted(async () => {
  unsubscribeMonitoring = engine.onMonitoringChange((enabled) => {
    monitoringEnabled.value = enabled;
  });
  unsubscribeStatus = engine.onStatusChange((status) => {
    bridgeAvailable.value = status.bridgeAvailable;
    lastError.value = status.lastError;
  });

  if (isOpen.value) {
    await loadDevices();
  }
});

onUnmounted(() => {
  unsubscribeMonitoring?.();
  unsubscribeStatus?.();
});

const loadDevices = async () => {
  try {
    const selection = await engine.getDevices();
    backends.value = selection.backends;
    selectedBackend.value = selection.selectedBackend;
    inputDevices.value = selection.inputs;
    outputDevices.value = selection.outputs;
    sampleRates.value = selection.sampleRates;
    bufferOptions.value = selection.bufferOptions;
    selectedInput.value = engine.selectedInputDeviceId || selection.inputs[0]?.id || '';
    selectedOutput.value = engine.selectedOutputDeviceId || selection.outputs[0]?.id || '';
    selectedSampleRate.value = engine.selectedSampleRate;
    selectedBufferFrames.value = engine.selectedBufferFrames;
    selectedLoopStorageBudget.value = engine.nativeLooperStorageBudgetBytes;
    monitoringEnabled.value = engine.monitoringEnabled;
  } catch (error) {
    console.error('Failed to load native devices:', error);
  }
};

const handleBackendChange = async () => {
  try {
    await engine.setBackend(selectedBackend.value);
    await loadDevices();
  } catch (error) {
    alert(`Failed to change backend: ${error}`);
  }
};

const handleInputChange = async () => {
  try {
    await engine.setInputDevice(selectedInput.value);
    await loadDevices();
  } catch (error) {
    alert(`Failed to change input device: ${error}`);
  }
};

const handleOutputChange = async () => {
  try {
    await engine.setOutputDevice(selectedOutput.value);
    await loadDevices();
  } catch (error) {
    alert(`Failed to change output device: ${error}`);
  }
};

const handleSampleRateChange = async () => {
  try {
    await engine.setSampleRate(selectedSampleRate.value);
    await loadDevices();
  } catch (error) {
    selectedSampleRate.value = engine.selectedSampleRate;
    alert(`Failed to change sample rate: ${error}`);
  }
};

const handleLoopStorageBudgetChange = async () => {
  try {
    await engine.setNativeLooperStorageBudget(selectedLoopStorageBudget.value);
    await loadDevices();
  } catch (error) {
    selectedLoopStorageBudget.value = engine.nativeLooperStorageBudgetBytes;
    alert(`Failed to change loop memory budget: ${error}`);
  }
};

const handleBufferChange = async () => {
  try {
    await engine.setBufferFrames(selectedBufferFrames.value);
    await loadDevices();
  } catch (error) {
    alert(`Failed to change buffer size: ${error}`);
  }
};

const handleMonitoringChange = async () => {
  if (monitoringEnabled.value) {
    const confirmed = confirm(
      'WARNING: Enabling monitoring with speakers may cause loud feedback.\n\n' +
      'Only proceed if you are using headphones.\n\n' +
      'Continue?'
    );

    if (!confirmed) {
      monitoringEnabled.value = false;
      return;
    }
  }

  try {
    await engine.setMonitoring(monitoringEnabled.value);
    monitoringEnabled.value = engine.monitoringEnabled;
  } catch (error) {
    alert(`Failed to change monitoring: ${error}`);
    monitoringEnabled.value = engine.monitoringEnabled;
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
  max-width: 720px;
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
  color: var(--led-red-recording);
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
}

.setting-row {
  display: flex;
  gap: 16px;
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
  font-size: 13px;
  letter-spacing: 1.4px;
  color: #888;
}

.device-select {
  background: var(--bg-groove-dark);
  color: var(--text-primary);
  border: 1px solid #333;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 14px;
}

.setting-help {
  color: #999;
  font-size: 14px;
  line-height: 1.45;
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
  background: rgba(255, 0, 51, 0.08);
  border: 1px solid rgba(255, 0, 51, 0.18);
  border-radius: 8px;
}

.warning-icon {
  font-family: var(--font-hardware);
  color: var(--led-red-recording);
  font-size: 12px;
}

.warning-content {
  color: var(--text-primary);
  font-size: 14px;
}

.native-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(0, 255, 102, 0.08);
  border: 1px solid rgba(0, 255, 102, 0.14);
  font-size: 14px;
}

.native-status.offline {
  background: rgba(255, 0, 51, 0.08);
  border-color: rgba(255, 0, 51, 0.18);
}

.native-status-error {
  color: #ff8b8b;
}

.modal-footer {
  padding: 18px 24px;
  display: flex;
  justify-content: flex-end;
  border-top: 2px solid #0d0d0d;
}
</style>
