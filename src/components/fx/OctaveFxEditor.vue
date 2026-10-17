<template>
  <section class="octave-editor" aria-label="OCTAVE settings" data-octave-editor>
    <header class="editor-heading">
      <strong>OCTAVE</strong>
      <span>THREE INDEPENDENT PITCH VOICES</span>
    </header>
    <div class="octave-controls">
      <label class="octave-control">
        <span>−24 ST {{ Math.round(parameters.minus24Level) }}%</span>
        <input aria-label="OCTAVE minus 24 level" type="range" min="0" max="100" step="1" :value="parameters.minus24Level" @input="setNumber('minus24Level', $event)" />
      </label>
      <label class="octave-control">
        <span>−12 ST {{ Math.round(parameters.minus12Level) }}%</span>
        <input aria-label="OCTAVE minus 12 level" type="range" min="0" max="100" step="1" :value="parameters.minus12Level" @input="setNumber('minus12Level', $event)" />
      </label>
      <label class="octave-control">
        <span>+12 ST {{ Math.round(parameters.plus12Level) }}%</span>
        <input aria-label="OCTAVE plus 12 level" type="range" min="0" max="100" step="1" :value="parameters.plus12Level" @input="setNumber('plus12Level', $event)" />
      </label>
      <label class="octave-control">
        <span>HARMONY MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input aria-label="OCTAVE harmony mix percent" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      </label>
    </div>
    <p class="octave-note">Three fixed Signalsmith pitch voices are added to latency-aligned full-level dry audio. Pitch tracking sensitivity and formant preservation are unsupported.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultOctaveParameters,
  sanitizeOctaveParameters,
  type OctaveParameters,
} from '../../audio/octaveParameters';

const props = defineProps<{ modelValue?: OctaveParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: OctaveParameters] }>();
const parameters = computed(() => sanitizeOctaveParameters(
  props.modelValue ?? createDefaultOctaveParameters(),
));

function setNumber(key: keyof OctaveParameters, event: Event): void {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', sanitizeOctaveParameters({
    ...parameters.value,
    [key]: Number(target.value),
  }));
}
</script>

<style scoped>
.octave-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .octave-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .octave-note { color: rgba(255,255,255,.65); }
.octave-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.octave-control input { width: 100%; }
.octave-note { margin: 0; font-size: 10px; }
</style>
