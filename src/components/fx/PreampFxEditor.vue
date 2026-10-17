<template>
  <section class="preamp-editor" aria-label="PREAMP settings" data-preamp-editor>
    <header class="editor-heading">
      <strong>PREAMP</strong>
      <span>6 CONTROL / CLEAN-ROOM MODEL</span>
    </header>

    <div class="preamp-controls">
      <label class="model-control">
        <span>MODEL</span>
        <select aria-label="Preamp model" :value="parameters.model" @change="setModel">
          <option v-for="(model, index) in PREAMP_MODELS" :key="model" :value="index">{{ model }}</option>
        </select>
      </label>

      <label class="preamp-control">
        <span>GAIN {{ Math.round(parameters.gainPercent) }}%</span>
        <input aria-label="Preamp gain percent" type="range" min="0" max="100" step="1" :value="parameters.gainPercent" @input="setNumber('gainPercent', $event)" />
      </label>
      <label class="preamp-control">
        <span>BASS {{ formatDb(parameters.bassDb) }}</span>
        <input aria-label="Preamp bass in decibels" type="range" min="-12" max="12" step="0.5" :value="parameters.bassDb" @input="setNumber('bassDb', $event)" />
      </label>
      <label class="preamp-control">
        <span>MIDDLE {{ formatDb(parameters.middleDb) }}</span>
        <input aria-label="Preamp middle in decibels" type="range" min="-12" max="12" step="0.5" :value="parameters.middleDb" @input="setNumber('middleDb', $event)" />
      </label>
      <label class="preamp-control">
        <span>TREBLE {{ formatDb(parameters.trebleDb) }}</span>
        <input aria-label="Preamp treble in decibels" type="range" min="-12" max="12" step="0.5" :value="parameters.trebleDb" @input="setNumber('trebleDb', $event)" />
      </label>
      <label class="preamp-control">
        <span>LEVEL {{ formatDb(parameters.levelDb) }}</span>
        <input aria-label="Preamp level in decibels" type="range" min="-24" max="12" step="0.5" :value="parameters.levelDb" @input="setNumber('levelDb', $event)" />
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { PREAMP_MODELS, sanitizePreampParameters, type PreampParameters } from '../../audio/preampParameters';

const props = defineProps<{ modelValue?: PreampParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: PreampParameters] }>();
const parameters = computed(() => sanitizePreampParameters(props.modelValue));

function formatDb(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function setModel(event: Event): void {
  const model = Number((event.target as HTMLSelectElement).value);
  emit('update:modelValue', sanitizePreampParameters({ ...parameters.value, model }));
}

function setNumber(key: Exclude<keyof PreampParameters, 'model'>, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  emit('update:modelValue', sanitizePreampParameters({ ...parameters.value, [key]: value }));
}
</script>

<style scoped>
.preamp-editor {
  display: grid;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(255, 150, 110, .28);
  border-radius: 10px;
  background: rgba(24, 15, 18, .72);
  color: #f3f3f5;
}
.editor-heading,
.preamp-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span { color: rgba(255,255,255,.65); }
.preamp-control,
.model-control { display: grid; gap: 4px; min-width: 104px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.preamp-controls input { width: 100%; }
.model-control select { color: #fff; background: #171c27; border: 1px solid rgba(255,255,255,.18); border-radius: 5px; min-height: 28px; }
</style>
