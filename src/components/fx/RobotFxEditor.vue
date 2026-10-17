<template>
  <section class="robot-editor" aria-label="ROBOT settings" data-robot-editor>
    <header class="editor-heading">
      <strong>ROBOT</strong>
      <span>FIXED-PITCH VOICE CHARACTER</span>
    </header>
    <div class="robot-controls">
      <label class="robot-control">
        <span>TARGET PITCH {{ signed(parameters.targetPitchSemitones) }} st</span>
        <input
          aria-label="ROBOT target pitch semitones"
          type="range"
          min="-24"
          max="24"
          step="0.1"
          :value="parameters.targetPitchSemitones"
          @input="setNumber('targetPitchSemitones', $event)"
        />
      </label>
      <label class="robot-control">
        <span>EFFECT MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input
          aria-label="ROBOT effect mix percent"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="parameters.mixPercent"
          @input="setNumber('mixPercent', $event)"
        />
      </label>
      <label class="robot-control">
        <span>FORMANT SHIFT {{ signed(parameters.formantShiftSemitones) }} st</span>
        <input
          aria-label="ROBOT formant shift semitones"
          type="range"
          min="-12"
          max="12"
          step="0.1"
          :value="parameters.formantShiftSemitones"
          @input="setNumber('formantShiftSemitones', $event)"
        />
      </label>
    </div>
    <p class="robot-status" role="status" data-formant-status>
      Experimental monophonic formant compensation preserves formants at 0 st and shifts independently at nonzero values. Polyphonic tracking, sound quality, and Roland fidelity are not verified.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultRobotFxParameters,
  sanitizeRobotFxParameters,
  type RobotFxParameters,
} from '../../audio/robotFxParameters';

const props = defineProps<{ modelValue?: RobotFxParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: RobotFxParameters] }>();
const parameters = computed(() => sanitizeRobotFxParameters(props.modelValue ?? createDefaultRobotFxParameters()));

function signed(value: number): string {
  if (value > 0) return `+${Number(value.toFixed(1))}`;
  return `${Number(value.toFixed(1))}`;
}

function setNumber(key: keyof RobotFxParameters, event: Event): void {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', sanitizeRobotFxParameters({
    ...parameters.value,
    [key]: Number(target.value),
  }));
}
</script>

<style scoped>
.robot-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110, 185, 255, .28); border-radius: 10px; background: rgba(13, 21, 32, .72); color: #f3f3f5; }
.editor-heading, .robot-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .robot-status { color: rgba(255, 255, 255, .65); }
.robot-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.robot-control input { width: 100%; }
.robot-status { margin: 0; font-size: 10px; }
</style>
