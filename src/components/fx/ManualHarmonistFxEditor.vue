<template>
  <section class="harmonist-editor" aria-label="HRM MANUAL settings" data-hrm-manual-editor>
    <header class="editor-heading">
      <strong>HRM MANUAL</strong>
      <span>TWO INDEPENDENT HARMONY VOICES</span>
    </header>
    <div class="harmony-controls">
      <label class="harmony-control">
        <span>VOICE 1 {{ formatInterval(parameters.voice1Interval) }}</span>
        <input aria-label="Harmony voice 1 interval in semitones" type="range" min="-24" max="24" step="1" :value="parameters.voice1Interval" @input="setNumber('voice1Interval', $event)" />
      </label>
      <label class="harmony-control">
        <span>VOICE 2 {{ formatInterval(parameters.voice2Interval) }}</span>
        <input aria-label="Harmony voice 2 interval in semitones" type="range" min="-24" max="24" step="1" :value="parameters.voice2Interval" @input="setNumber('voice2Interval', $event)" />
      </label>
      <label class="harmony-control">
        <span>PAN {{ Math.round(parameters.panPercent) }}%</span>
        <input aria-label="Harmony pan percent" type="range" min="-100" max="100" step="1" :value="parameters.panPercent" @input="setNumber('panPercent', $event)" />
      </label>
      <label class="harmony-control">
        <span>HARMONY MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input aria-label="Harmony mix percent" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      </label>
    </div>
    <p class="harmony-note">The original stays centered at full level; two shifted voices are added as one panned harmony bus. Formant preservation is unsupported. Native mono Input rejects non-center pan; stereo Track output supports pan.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultManualHarmonistParameters,
  sanitizeManualHarmonistParameters,
  type ManualHarmonistParameters,
} from '../../audio/manualHarmonistParameters';

const props = defineProps<{ modelValue?: ManualHarmonistParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: ManualHarmonistParameters] }>();
const parameters = computed(() => sanitizeManualHarmonistParameters(
  props.modelValue ?? createDefaultManualHarmonistParameters(),
));

function formatInterval(interval: number): string {
  return `${interval > 0 ? '+' : ''}${interval} ST`;
}

function setNumber(key: keyof ManualHarmonistParameters, event: Event): void {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', sanitizeManualHarmonistParameters({
    ...parameters.value,
    [key]: Number(target.value),
  }));
}
</script>

<style scoped>
.harmonist-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .harmony-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .harmony-note { color: rgba(255,255,255,.65); }
.harmony-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.harmony-control input { width: 100%; }
.harmony-note { margin: 0; font-size: 10px; }
</style>
