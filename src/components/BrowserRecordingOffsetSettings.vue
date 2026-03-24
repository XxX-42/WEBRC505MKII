<template>
  <section class="browser-offset-panel">
    <header class="panel-header">
      <h3>RECORDING OFFSET</h3>
      <p>
        Browser-only write-position compensation. This shifts recorded audio earlier or later inside the loop.
        It does not reduce live monitoring latency.
      </p>
    </header>

    <div class="panel-grid">
      <label class="field">
        <span class="field-label">OFFSET (MS)</span>
        <input
          v-model.number="recordingOffsetMs"
          class="field-input"
          type="number"
          step="0.1"
          min="-250"
          max="250"
        >
      </label>

      <div class="field readonly">
        <span class="field-label">OFFSET (SAMPLES)</span>
        <span class="field-value">{{ recordingOffsetSamples }}</span>
      </div>
    </div>

    <div class="panel-actions">
      <button type="button" class="action-btn" @click="save">SAVE</button>
      <button type="button" class="action-btn secondary" @click="resetToZero">RESET TO 0</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  getBrowserRecordingOffsetConfig,
  msToSamples,
  resetBrowserRecordingOffsetConfig,
  setBrowserRecordingOffsetConfig,
  type BrowserRecordingOffsetScope,
} from '../audio/browserRecordingOffset';

const props = withDefaults(defineProps<{
  sampleRate: number
  inputDeviceId?: string | null
  outputDeviceId?: string | null
  bufferFrames?: number | null
}>(), {
  inputDeviceId: null,
  outputDeviceId: null,
  bufferFrames: null,
});

const emit = defineEmits<{
  (e: 'saved', value: number): void
}>();

const buildScope = (): BrowserRecordingOffsetScope => ({
  inputDeviceId: props.inputDeviceId,
  outputDeviceId: props.outputDeviceId,
  sampleRate: props.sampleRate,
  bufferFrames: props.bufferFrames,
});

const initial = getBrowserRecordingOffsetConfig(props.sampleRate, buildScope());
const recordingOffsetMs = ref(initial.recordingOffsetMs);

watch(() => [props.sampleRate, props.inputDeviceId, props.outputDeviceId, props.bufferFrames], () => {
  const config = getBrowserRecordingOffsetConfig(props.sampleRate, buildScope());
  recordingOffsetMs.value = config.recordingOffsetMs;
});

const recordingOffsetSamples = computed(() => msToSamples(recordingOffsetMs.value, props.sampleRate));

const save = () => {
  const saved = setBrowserRecordingOffsetConfig(recordingOffsetMs.value, buildScope());
  recordingOffsetMs.value = saved.recordingOffsetMs;
  emit('saved', saved.recordingOffsetMs);
};

const resetToZero = () => {
  resetBrowserRecordingOffsetConfig(buildScope());
  recordingOffsetMs.value = 0;
  emit('saved', 0);
};
</script>

<style scoped>
.browser-offset-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.16);
}

.panel-header h3 {
  margin: 0 0 6px;
  font-size: 14px;
  letter-spacing: 1.6px;
}

.panel-header p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.panel-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 11px;
  letter-spacing: 1.2px;
  color: var(--text-muted);
}

.field-input,
.field-value {
  min-height: 38px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(0, 0, 0, 0.2);
  color: var(--text-primary);
}

.field-input {
  width: 100%;
}

.panel-actions {
  display: flex;
  gap: 10px;
}

.action-btn {
  min-width: 110px;
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
  cursor: pointer;
}

.action-btn.secondary {
  background: transparent;
}
</style>
