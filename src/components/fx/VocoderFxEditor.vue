<template>
  <section class="vocoder-editor" aria-label="VOCODER settings" data-vocoder-editor>
    <header class="editor-heading">
      <strong>VOCODER</strong>
      <span>FILTERBANK CARRIER</span>
    </header>
    <div class="vocoder-controls">
      <label class="vocoder-control">
        <span>FILTERBANK BANDS {{ parameters.bands }}</span>
        <input aria-label="VOCODER filterbank bands" type="range" min="8" max="24" step="1" :value="parameters.bands" @input="setNumber('bands', $event)" />
      </label>
      <label class="vocoder-control">
        <span>CARRIER</span>
        <select aria-label="VOCODER carrier" :value="parameters.carrier" @change="setNumber('carrier', $event)">
          <option :value="0">Voice input</option>
          <option :value="1">Internal saw</option>
          <option :value="2">Internal square</option>
        </select>
      </label>
      <label class="vocoder-control">
        <span>EFFECT MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input aria-label="VOCODER effect mix percent" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      </label>
    </div>
    <p class="vocoder-note">Uses an envelope-following analysis filterbank to modulate the selected carrier. Formant shifting is unsupported and rejected.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultVocoderParameters,
  sanitizeVocoderParameters,
  type VocoderParameters,
} from '../../audio/vocoderParameters';

const props = defineProps<{ modelValue?: VocoderParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: VocoderParameters] }>();
const parameters = computed(() => sanitizeVocoderParameters(props.modelValue ?? createDefaultVocoderParameters()));

function setNumber(key: keyof VocoderParameters, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  emit('update:modelValue', sanitizeVocoderParameters({
    ...parameters.value,
    [key]: Number(target.value),
  }));
}
</script>

<style scoped>
.vocoder-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .vocoder-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .vocoder-note { color: rgba(255,255,255,.65); }
.vocoder-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.vocoder-control input, .vocoder-control select { width: 100%; }
.vocoder-note { margin: 0; font-size: 10px; }
</style>
