<template>
  <section class="electric-editor" aria-label="ELECTRIC settings" data-electric-editor>
    <header class="editor-heading">
      <strong>ELECTRIC</strong>
      <span>VOICE CHARACTER</span>
    </header>
    <div class="electric-controls">
      <label class="electric-control">
        <span>CHARACTER</span>
        <select
          aria-label="ELECTRIC character"
          :value="parameters.character"
          @change="setCharacter"
        >
          <option v-for="choice in ELECTRIC_CHARACTERS" :key="choice.value" :value="choice.value">
            {{ choice.label }}
          </option>
        </select>
      </label>
      <label class="electric-control">
        <span>PITCH SNAP {{ Math.round(parameters.pitchSnapPercent) }}%</span>
        <input
          aria-label="ELECTRIC pitch snap percent"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="parameters.pitchSnapPercent"
          @input="setNumber('pitchSnapPercent', $event)"
        />
      </label>
      <label class="electric-control">
        <span>TONE {{ Math.round(parameters.toneHz) }} Hz</span>
        <input
          aria-label="ELECTRIC tone cutoff Hz"
          type="range"
          min="100"
          max="16000"
          step="1"
          :value="parameters.toneHz"
          @input="setNumber('toneHz', $event)"
        />
      </label>
      <label class="electric-control">
        <span>EFFECT MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input
          aria-label="ELECTRIC effect mix percent"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="parameters.mixPercent"
          @input="setNumber('mixPercent', $event)"
        />
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultElectricParameters,
  sanitizeElectricParameters,
  type ElectricParameters,
} from '../../audio/electricParameters';

const ELECTRIC_CHARACTERS = [
  { value: 0, label: 'Classic' },
  { value: 1, label: 'Metallic' },
  { value: 2, label: 'Vocoder' },
  { value: 3, label: 'Bit-crush' },
] as const;

const props = defineProps<{ modelValue?: ElectricParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: ElectricParameters] }>();
const parameters = computed(() => sanitizeElectricParameters(props.modelValue ?? createDefaultElectricParameters()));

function setCharacter(event: Event): void {
  const target = event.target as HTMLSelectElement;
  emit('update:modelValue', sanitizeElectricParameters({
    ...parameters.value,
    character: Number(target.value) as ElectricParameters['character'],
  }));
}

function setNumber(key: 'pitchSnapPercent' | 'toneHz' | 'mixPercent', event: Event): void {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', sanitizeElectricParameters({
    ...parameters.value,
    [key]: Number(target.value),
  }));
}
</script>

<style scoped>
.electric-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110, 185, 255, .28); border-radius: 10px; background: rgba(13, 21, 32, .72); color: #f3f3f5; }
.editor-heading, .electric-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span { color: rgba(255, 255, 255, .65); }
.electric-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.electric-control input, .electric-control select { width: 100%; }
.electric-control select { color: inherit; background: rgba(255, 255, 255, .08); border: 1px solid rgba(255, 255, 255, .18); border-radius: 5px; padding: 4px; }
</style>
