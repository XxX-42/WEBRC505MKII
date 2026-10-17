<template>
  <section class="g2b-editor" aria-label="G2B settings" data-g2b-editor>
    <header class="editor-heading">
      <strong>G2B</strong>
      <span>OCTAVE-DOWN TRACKER / CLEAN-ROOM MODEL</span>
    </header>
    <div class="g2b-controls">
      <label class="g2b-control">
        <span>TRACKING {{ Math.round(parameters.tracking) }}%</span>
        <input aria-label="G2B tracking sensitivity" type="range" min="0" max="100" step="1" :value="parameters.tracking" @input="setNumber('tracking', $event)" />
      </label>
      <label class="g2b-control">
        <span>OCTAVE BLEND {{ Math.round(parameters.blend) }}%</span>
        <input aria-label="G2B sub octave blend" type="range" min="0" max="100" step="1" :value="parameters.blend" @input="setNumber('blend', $event)" />
      </label>
      <label class="g2b-control">
        <span>BODY {{ Math.round(parameters.body) }} Hz</span>
        <input aria-label="G2B body cutoff hertz" type="range" min="0" max="100" step="1" :value="bodyPosition" :aria-valuetext="`${Math.round(parameters.body)} Hz`" @input="setNumber('body', $event)" />
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { sanitizeG2bParameters, type G2bParameters } from '../../audio/g2bParameters';

const props = defineProps<{ modelValue?: G2bParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: G2bParameters] }>();
const parameters = computed(() => sanitizeG2bParameters(props.modelValue));
const bodyPosition = computed(() => (Math.log(parameters.value.body / 60) / Math.log(20)) * 100);

function setNumber(key: keyof G2bParameters, event: Event): void {
  const target = event.target as HTMLInputElement;
  const value = Number(target.value);
  const next = key === 'body' ? 60 * (20 ** (value / 100)) : value;
  emit('update:modelValue', sanitizeG2bParameters({ ...parameters.value, [key]: next }));
}
</script>

<style scoped>
.g2b-editor { display: grid; gap: 10px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .g2b-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span { color: rgba(255,255,255,.65); }
.g2b-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.g2b-control input { width: 100%; }
</style>
