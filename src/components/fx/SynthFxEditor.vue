<template>
  <section class="synth-editor" aria-label="SYNTH settings" data-synth-editor>
    <header class="editor-heading">
      <strong>SYNTH</strong>
      <span>5 CONTROL / CLEAN-ROOM MODEL</span>
    </header>

    <div class="synth-controls">
      <label class="synth-control">
        <span>SENSITIVITY {{ Math.round(parameters.sensitivity) }}%</span>
        <input aria-label="Synth tracking sensitivity" type="range" min="0" max="100" step="1" :value="parameters.sensitivity" @input="setNumber('sensitivity', $event)" />
      </label>
      <label class="synth-control">
        <span>WAVEFORM</span>
        <select aria-label="Synth oscillator waveform" :value="parameters.waveform" @change="setNumber('waveform', $event)">
          <option v-for="(waveform, index) in SYNTH_WAVEFORMS" :key="waveform" :value="index">{{ waveform }}</option>
        </select>
      </label>
      <label class="synth-control">
        <span>OCTAVE {{ parameters.octave > 0 ? '+' : '' }}{{ parameters.octave }} st</span>
        <input aria-label="Synth oscillator octave" type="range" min="-24" max="24" step="1" :value="parameters.octave" @input="setNumber('octave', $event)" />
      </label>
      <label class="synth-control">
        <span>TONE {{ Math.round(parameters.tone) }} Hz</span>
        <input aria-label="Synth tone cutoff hertz" type="range" min="100" max="16000" step="1" :value="parameters.tone" @input="setNumber('tone', $event)" />
      </label>
      <label class="synth-control">
        <span>MIX {{ Math.round(parameters.mix) }}%</span>
        <input aria-label="Synth effect mix percent" type="range" min="0" max="100" step="1" :value="parameters.mix" @input="setNumber('mix', $event)" />
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { sanitizeSynthParameters, SYNTH_WAVEFORMS, type SynthParameters } from '../../audio/synthParameters';

const props = defineProps<{ modelValue?: SynthParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: SynthParameters] }>();
const parameters = computed(() => sanitizeSynthParameters(props.modelValue));

function setNumber(key: keyof SynthParameters, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const value = Number(target.value);
  emit('update:modelValue', sanitizeSynthParameters({ ...parameters.value, [key]: value }));
}
</script>

<style scoped>
.synth-editor {
  display: grid;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(110, 185, 255, .28);
  border-radius: 10px;
  background: rgba(13, 21, 32, .72);
  color: #f3f3f5;
}
.editor-heading,
.synth-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span { color: rgba(255,255,255,.65); }
.synth-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.synth-control input { width: 100%; }
.synth-control select { color: #fff; background: #171c27; border: 1px solid rgba(255,255,255,.18); border-radius: 5px; min-height: 28px; }
</style>
