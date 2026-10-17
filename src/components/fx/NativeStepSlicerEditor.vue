<template>
  <section class="native-step-slicer" aria-label="Native Step Slicer settings" data-native-step-slicer-editor>
    <header class="editor-heading">
      <strong>STEP SLICER</strong>
      <span>{{ parameters.step_count }} STEPS</span>
    </header>

    <div class="global-controls">
      <label>
        <span>STEPS</span>
        <select aria-label="Step count" :value="parameters.step_count" @change="setNumber('step_count', $event)">
          <option v-for="count in STEP_SLICER_COUNT_OPTIONS" :key="count" :value="count">{{ count }}</option>
        </select>
      </label>
      <label>
        <span>RATE (BEATS)</span>
        <select aria-label="Step rate in beats" :value="parameters.rate_beats" @change="setNumber('rate_beats', $event)">
          <option v-for="rate in STEP_SLICER_RATE_OPTIONS" :key="rate" :value="rate">{{ rate }}</option>
        </select>
      </label>
      <label>
        <span>DEPTH {{ Math.round(parameters.depth_percent) }}%</span>
        <input aria-label="Depth percent" type="range" min="0" max="100" step="1" :value="parameters.depth_percent" @input="setNumber('depth_percent', $event)" />
      </label>
      <label>
        <span>PAN {{ Math.round(parameters.pan_depth_percent) }}%</span>
        <input aria-label="Pan depth percent" type="range" min="0" max="100" step="1" :value="parameters.pan_depth_percent" @input="setNumber('pan_depth_percent', $event)" />
      </label>
      <label>
        <span>FILTER {{ Math.round(parameters.filter_hz) }} HZ</span>
        <input aria-label="Filter cutoff in hertz" type="range" min="20" max="20000" step="10" :value="parameters.filter_hz" @input="setNumber('filter_hz', $event)" />
      </label>
    </div>

    <div class="step-grid" aria-label="Sixteen step amplitudes">
      <label v-for="step in stepValues" :key="step.key" class="step-control">
        <span>{{ step.label }}</span>
        <input
          :aria-label="`${step.label} amplitude percent`"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="step.value"
          @input="setStep(step.key, $event)"
        />
        <output>{{ Math.round(step.value) }}</output>
      </label>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultNativeStepSlicerParameters,
  sanitizeNativeStepSlicerParameters,
  STEP_SLICER_COUNT_OPTIONS,
  STEP_SLICER_RATE_OPTIONS,
  type NativeStepSlicerParameters,
} from '../../audio/nativeStepSlicerParameters';

const props = defineProps<{ modelValue?: NativeStepSlicerParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: NativeStepSlicerParameters] }>();
const parameters = computed(() => sanitizeNativeStepSlicerParameters(props.modelValue ?? createDefaultNativeStepSlicerParameters()));
const stepValues = computed(() => Array.from({ length: 16 }, (_, index) => {
  const key = `step_${String(index + 1).padStart(2, '0')}` as keyof NativeStepSlicerParameters;
  return { key, label: `STEP ${String(index + 1).padStart(2, '0')}`, value: parameters.value[key] };
}));

function setNumber(key: 'step_count' | 'rate_beats' | 'depth_percent' | 'pan_depth_percent' | 'filter_hz', event: Event) {
  const value = Number((event.target as HTMLInputElement | HTMLSelectElement).value);
  emit('update:modelValue', sanitizeNativeStepSlicerParameters({ ...parameters.value, [key]: value }));
}

function setStep(key: keyof NativeStepSlicerParameters, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  emit('update:modelValue', sanitizeNativeStepSlicerParameters({ ...parameters.value, [key]: value }));
}
</script>

<style scoped>
.native-step-slicer {
  display: grid;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(120, 170, 255, 0.24);
  border-radius: 10px;
  background: rgba(10, 16, 29, 0.72);
  color: #f3f3f5;
}
.editor-heading,
.global-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.editor-heading,
.global-controls label,
.step-control {
  font-family: var(--font-hardware);
  font-size: 10px;
  letter-spacing: 0.8px;
}
.editor-heading span,
.step-control output { color: rgba(255,255,255,.68); }
.global-controls label { display: grid; gap: 4px; min-width: 80px; }
.global-controls select { color: #fff; background: #171c27; border: 1px solid rgba(255,255,255,.18); border-radius: 5px; min-height: 26px; }
.global-controls input { width: 110px; max-width: 100%; }
.step-grid { display: grid; grid-template-columns: repeat(8, minmax(44px, 1fr)); gap: 5px 8px; }
.step-control { display: grid; justify-items: center; gap: 3px; min-width: 0; }
.step-control input { writing-mode: vertical-lr; direction: rtl; width: 22px; height: 56px; }
.step-control output { font-variant-numeric: tabular-nums; }
@media (max-width: 620px) { .step-grid { grid-template-columns: repeat(4, minmax(48px, 1fr)); } }
</style>
