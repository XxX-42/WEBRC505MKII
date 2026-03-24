<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="isOpen" class="modal-overlay" @click="handleOverlayClick">
        <div class="modal-container" @click.stop>
          <div class="modal-header">
            <h2 class="modal-title">⚙ AUDIO SETTINGS</h2>
            <button class="close-btn" @click="close" aria-label="Close audio settings">×</button>
          </div>

          <div class="modal-content">
            <div class="setting-group">
              <label class="setting-label" for="input-device">INPUT DEVICE (MICROPHONE)</label>
              <select
                id="input-device"
                v-model="selectedInput"
                @change="handleInputChange"
                class="device-select"
              >
                <option value="">Default</option>
                <option
                  v-for="device in inputDevices"
                  :key="device.deviceId"
                  :value="device.deviceId"
                >
                  {{ device.label || `Microphone ${device.deviceId.slice(0, 8)}` }}
                </option>
              </select>
            </div>

            <div class="setting-group">
              <label class="setting-label" for="output-device">OUTPUT DEVICE (SPEAKERS/HEADPHONES)</label>
              <select
                id="output-device"
                v-model="selectedOutput"
                @change="handleOutputChange"
                class="device-select"
                :disabled="!sinkIdSupported"
              >
                <option value="">Default</option>
                <option
                  v-for="device in outputDevices"
                  :key="device.deviceId"
                  :value="device.deviceId"
                >
                  {{ device.label || `Speaker ${device.deviceId.slice(0, 8)}` }}
                </option>
              </select>
              <div v-if="!sinkIdSupported" class="warning-text small">
                Output device selection is not supported in this browser
              </div>
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
                  <strong>DANGER: FEEDBACK RISK</strong>
                  <p>Only enable with headphones. Using speakers may cause loud feedback.</p>
                </div>
              </div>
            </div>

            <div class="setting-group">
              <HardwareButton
                size="md"
                color="blue"
                label="PLAY TEST TONE (440Hz)"
                aria-label="Play 440 hertz test tone"
                @press="playTestTone"
                class="test-button"
              />
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
import { ref, onMounted, watch } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import HardwareButton from './ui/HardwareButton.vue';

const props = defineProps<{
  modelValue: boolean
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>();

const engine = AudioEngine.getInstance();

const isOpen = ref(props.modelValue);
const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const selectedInput = ref('');
const selectedOutput = ref('');
const monitoringEnabled = ref(false);
const sinkIdSupported = ref(false);

watch(() => props.modelValue, (newVal) => {
  isOpen.value = newVal;
  if (newVal) {
    loadDevices();
  }
});

onMounted(async () => {
  sinkIdSupported.value = typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype;

  if (isOpen.value) {
    await loadDevices();
  }
});

const loadDevices = async () => {
  try {
    const devices = await engine.getDevices();
    inputDevices.value = devices.inputs;
    outputDevices.value = devices.outputs;

    selectedInput.value = engine.selectedInputDeviceId || '';
    selectedOutput.value = engine.selectedOutputDeviceId || '';
    monitoringEnabled.value = engine.monitoringEnabled;
  } catch (error) {
    console.error('Failed to load devices:', error);
  }
};

const handleInputChange = async () => {
  try {
    await engine.setInputDevice(selectedInput.value);
    selectedInput.value = engine.selectedInputDeviceId || '';
  } catch (error) {
    console.error('Failed to change input device:', error);
    selectedInput.value = engine.selectedInputDeviceId || '';
    alert('Failed to change input device. Please check permissions.');
  }
};

const handleOutputChange = async () => {
  try {
    await engine.setOutputDevice(selectedOutput.value);
    selectedOutput.value = engine.selectedOutputDeviceId || '';
  } catch (error) {
    console.error('Failed to change output device:', error);
    selectedOutput.value = engine.selectedOutputDeviceId || '';
    alert('Failed to change output device.');
  }
};

const handleMonitoringChange = () => {
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

  engine.setMonitoring(monitoringEnabled.value);
  monitoringEnabled.value = engine.monitoringEnabled;
};

const playTestTone = () => {
  engine.playTestTone();
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
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
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
  max-width: 600px;
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
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--led-red-recording);
  text-shadow: 0 0 8px rgba(255, 0, 51, 0.6);
  margin: 0;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 20px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.close-btn:hover {
  background: rgba(255, 0, 51, 0.3);
  color: var(--led-red-recording);
}

.close-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.modal-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.setting-group {
  margin-bottom: 24px;
}

.setting-label {
  display: block;
  font-family: var(--font-hardware);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 8px;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.8);
}

.device-select {
  width: 100%;
  padding: 12px 16px;
  background: #0a0a0a;
  border: 2px solid #1a1a1a;
  border-radius: 4px;
  color: #fff;
  font-family: var(--font-mono);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.8),
    inset 0 -1px 2px rgba(255, 255, 255, 0.02);
}

.device-select:hover:not(:disabled) {
  border-color: #2a2a2a;
  background: #0f0f0f;
}

.device-select:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.8),
    0 0 8px rgba(0, 153, 255, 0.3);
}

.device-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.device-select option {
  background: #0a0a0a;
  color: #fff;
  padding: 8px;
}

.monitoring-group {
  background: rgba(255, 0, 51, 0.05);
  border: 2px solid rgba(255, 0, 51, 0.2);
  border-radius: 8px;
  padding: 16px;
}

.monitoring-label {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  margin-bottom: 12px;
  font-size: 14px;
  color: #fff;
}

.monitoring-checkbox {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.checkbox-custom {
  width: 24px;
  height: 24px;
  border: 2px solid #2a2a2a;
  border-radius: 4px;
  background: #0a0a0a;
  position: relative;
  transition: all 0.2s;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.8);
}

.monitoring-checkbox:checked + .checkbox-custom {
  background: var(--led-red-recording);
  border-color: var(--led-red-recording);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.4),
    0 0 12px rgba(255, 0, 51, 0.6);
}

.monitoring-checkbox:checked + .checkbox-custom::after {
  content: 'OK';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #fff;
  font-size: 10px;
  font-weight: bold;
}

.warning-box {
  display: flex;
  gap: 12px;
  background: rgba(255, 0, 51, 0.1);
  border: 1px solid rgba(255, 0, 51, 0.3);
  border-radius: 4px;
  padding: 12px;
}

.warning-icon {
  font-size: 12px;
  flex-shrink: 0;
  font-family: var(--font-hardware);
  letter-spacing: 1px;
  color: var(--led-red-recording);
}

.warning-content {
  flex: 1;
}

.warning-content strong {
  display: block;
  color: var(--led-red-recording);
  font-family: var(--font-hardware);
  font-size: 12px;
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.warning-content p {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.8);
}

.warning-text.small {
  font-size: 11px;
  color: rgba(255, 204, 0, 0.8);
  margin-top: 4px;
}

.test-button {
  width: 100%;
}

.modal-footer {
  padding: 16px 24px;
  background: linear-gradient(180deg, #0f0f0f 0%, #1a1a1a 100%);
  border-top: 2px solid #0d0d0d;
  display: flex;
  justify-content: center;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-active .modal-container,
.modal-leave-active .modal-container {
  transition: transform 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  transform: scale(0.9);
}

.modal-content::-webkit-scrollbar {
  width: 8px;
}

.modal-content::-webkit-scrollbar-track {
  background: #0a0a0a;
  border-radius: 4px;
}

.modal-content::-webkit-scrollbar-thumb {
  background: #2a2a2a;
  border-radius: 4px;
}

.modal-content::-webkit-scrollbar-thumb:hover {
  background: #3a3a3a;
}
</style>
