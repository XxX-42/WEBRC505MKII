<template>
  <section class="auto-riff-editor" aria-label="AUTO RIFF experimental settings" data-auto-riff-editor>
    <header class="editor-heading">
      <strong>AUTO RIFF <span>(EXPERIMENTAL)</span></strong>
      <span>ONSET-TRIGGERED SCALE QUANTIZATION</span>
    </header>
    <div class="auto-riff-controls">
      <label class="auto-riff-control">
        <span>SCALE</span>
        <select aria-label="AUTO RIFF scale" :value="parameters.scale" @change="setNumber('scale', $event)">
          <option v-for="scale in AUTO_RIFF_SCALE_OPTIONS" :key="scale.value" :value="scale.value">
            {{ scale.label }}
          </option>
        </select>
      </label>
      <label class="auto-riff-control">
        <span>STEP RATE</span>
        <select aria-label="AUTO RIFF step rate in beats" :value="parameters.rateBeats" @change="setNumber('rateBeats', $event)">
          <option v-for="rate in AUTO_RIFF_RATE_OPTIONS" :key="rate" :value="rate">
            {{ rateLabel(rate) }}
          </option>
        </select>
      </label>
      <label class="auto-riff-control">
        <span>ONSET SENSITIVITY {{ Math.round(parameters.sensitivityPercent) }}%</span>
        <input aria-label="AUTO RIFF onset sensitivity percent" type="range" min="0" max="100" step="1" :value="parameters.sensitivityPercent" @input="setNumber('sensitivityPercent', $event)" />
      </label>
      <label class="auto-riff-control">
        <span>EFFECT MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input aria-label="AUTO RIFF effect mix percent" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      </label>
    </div>
    <p class="auto-riff-note">Experimental pitch sequencing. Sensitivity sets the onset threshold; mix controls the pitch-shifted signal.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  AUTO_RIFF_RATE_OPTIONS,
  AUTO_RIFF_SCALE_OPTIONS,
  createDefaultAutoRiffParameters,
  sanitizeAutoRiffParameters,
  type AutoRiffParameters,
} from '../../audio/autoRiffParameters';

const props = defineProps<{ modelValue?: AutoRiffParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: AutoRiffParameters] }>();
const parameters = computed(() => sanitizeAutoRiffParameters(props.modelValue ?? createDefaultAutoRiffParameters()));

function rateLabel(beats: number): string {
  if (beats === 0.25) return '1/16 note';
  if (beats === 0.5) return '1/8 note';
  if (beats === 1) return '1/4 note';
  if (beats === 2) return '1/2 note';
  return '1 bar (4 beats)';
}

function setNumber(key: keyof AutoRiffParameters, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  emit('update:modelValue', sanitizeAutoRiffParameters({
    ...parameters.value,
    [key]: Number(target.value),
  }));
}
</script>

<style scoped>
.auto-riff-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(255, 192, 85, .42); border-radius: 10px; background: rgba(31, 24, 14, .72); color: #f3f3f5; }
.editor-heading, .auto-riff-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading > span, .auto-riff-note { color: rgba(255, 255, 255, .65); }
.editor-heading strong span { color: #ffc055; }
.auto-riff-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.auto-riff-control input, .auto-riff-control select { width: 100%; }
.auto-riff-note { margin: 0; font-size: 10px; }
</style>
