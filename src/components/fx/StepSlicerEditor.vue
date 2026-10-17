<template>
  <fieldset class="step-slicer-editor" data-step-slicer-editor>
    <legend>STEP SLICER · {{ bank.toUpperCase() }} {{ slotId }}</legend>

    <div class="global-controls">
      <label class="select-control">
        <span>STEP COUNT</span>
        <select :value="settings.stepCount" aria-label="Step count" @change="updateStepCount">
          <option v-for="count in STEP_SLICER_STEP_COUNTS" :key="count" :value="count">{{ count }}</option>
        </select>
      </label>
      <label class="select-control">
        <span>RATE / BEATS</span>
        <select :value="settings.rateBeats" aria-label="Step rate in beats" @change="updateRate">
          <option v-for="rate in STEP_SLICER_RATE_OPTIONS" :key="rate" :value="rate">{{ formatRate(rate) }}</option>
        </select>
      </label>
      <label class="range-control">
        <span>ALT PAN</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          :value="settings.panDepthPercent"
          aria-label="Alternating pan depth"
          @input="updatePanDepth"
        />
        <output>{{ settings.panDepthPercent }}%</output>
      </label>
      <label class="range-control filter-control">
        <span>LPF CUTOFF</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          :value="filterSliderPosition"
          aria-label="Low-pass filter cutoff"
          @input="updateFilterCutoff"
        />
        <output>{{ formatFrequency(settings.filterHz) }}</output>
      </label>
    </div>

    <div class="steps-grid">
      <label
        v-for="(level, index) in settings.steps"
        :key="index"
        class="step-control"
        :class="{ inactive: index >= settings.stepCount }"
      >
        <span class="step-label">{{ String(index + 1).padStart(2, '0') }}</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          :value="level"
          :disabled="index >= settings.stepCount"
          :aria-label="`Step ${index + 1} amplitude`"
          @input="updateStep(index, $event)"
        />
        <output>{{ level }}%</output>
      </label>
    </div>
    <p class="control-note">Slot fader sets depth · tempo follows transport BPM</p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import {
  loadStepSlicerSettings,
  saveStepSlicerSettings,
  STEP_SLICER_RATE_OPTIONS,
  STEP_SLICER_STEP_COUNTS,
  type StepSlicerBank,
  type StepSlicerSettings,
} from '../../composables/stepSlicerSequenceState';

const props = defineProps<{
  bank: StepSlicerBank;
  slotIndex: number;
  slotId: string;
}>();

const audio = AudioEngine.getInstance();
const settings = ref<StepSlicerSettings>(loadStepSlicerSettings(props.bank, props.slotId));
const filterSliderPosition = computed(() => Math.round(
  (Math.log(settings.value.filterHz / 20) / Math.log(1000)) * 100,
));

const syncSettings = (value: StepSlicerSettings) => {
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'step_count', value.stepCount);
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'rate_beats', value.rateBeats);
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'pan_depth_percent', value.panDepthPercent);
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'filter_hz', value.filterHz);
  value.steps.forEach((step, index) => {
    audio.setBrowserStepSlicerStep(props.bank, props.slotIndex, index, step);
  });
};

watch(
  () => [props.bank, props.slotId, props.slotIndex] as const,
  () => {
    settings.value = loadStepSlicerSettings(props.bank, props.slotId);
    syncSettings(settings.value);
  },
  { immediate: true },
);

const persistSettings = (next: StepSlicerSettings) => {
  settings.value = saveStepSlicerSettings(props.bank, props.slotId, next);
  return settings.value;
};

const updateStep = (index: number, event: Event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const steps = [...settings.value.steps];
  steps[index] = Math.max(0, Math.min(100, Math.round(Number(input.value))));
  const saved = persistSettings({ ...settings.value, steps });
  audio.setBrowserStepSlicerStep(props.bank, props.slotIndex, index, saved.steps[index]!);
};

const updateStepCount = (event: Event) => {
  const select = event.currentTarget;
  if (!(select instanceof HTMLSelectElement)) return;
  const stepCount = Number(select.value) as StepSlicerSettings['stepCount'];
  const saved = persistSettings({ ...settings.value, stepCount });
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'step_count', saved.stepCount);
};

const updateRate = (event: Event) => {
  const select = event.currentTarget;
  if (!(select instanceof HTMLSelectElement)) return;
  const rateBeats = Number(select.value) as StepSlicerSettings['rateBeats'];
  const saved = persistSettings({ ...settings.value, rateBeats });
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'rate_beats', saved.rateBeats);
};

const updatePanDepth = (event: Event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const panDepthPercent = Number(input.value);
  const saved = persistSettings({ ...settings.value, panDepthPercent });
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'pan_depth_percent', saved.panDepthPercent);
};

const updateFilterCutoff = (event: Event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const slider = Math.max(0, Math.min(100, Number(input.value)));
  const filterHz = Math.round(20 * (1000 ** (slider / 100)));
  const saved = persistSettings({ ...settings.value, filterHz });
  audio.setBrowserStepSlicerControl(props.bank, props.slotIndex, 'filter_hz', saved.filterHz);
};

const formatRate = (value: number) => value < 1 ? `1/${Math.round(1 / value)}` : `${value}`;
const formatFrequency = (value: number) => value >= 1000
  ? `${Number((value / 1000).toFixed(value >= 10000 ? 0 : 1))} kHz`
  : `${value} Hz`;
</script>

<style scoped>
.step-slicer-editor {
  width: min(100%, 360px);
  min-width: 0;
  margin: 0;
  padding: 7px 8px 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #f3f3f5;
  background: rgba(0, 0, 0, 0.2);
}

.step-slicer-editor legend {
  padding: 0 5px;
  color: rgba(255, 255, 255, 0.7);
  font-family: var(--font-hardware);
  font-size: 9px;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.global-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  margin-bottom: 7px;
}

.select-control,
.range-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 3px 6px;
  min-width: 0;
  padding: 4px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.045);
  font-family: var(--font-hardware);
  font-size: 8px;
  letter-spacing: 0.45px;
}

.select-control span,
.range-control span {
  color: rgba(255, 255, 255, 0.7);
}

.select-control select {
  min-width: 56px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  padding: 2px 4px;
  background: #202125;
  color: #f3f3f5;
  font-family: var(--font-mono);
  font-size: 9px;
}

.range-control input {
  grid-column: 1;
  width: 100%;
  min-width: 25px;
  height: 14px;
  margin: 0;
  accent-color: #ff4054;
}

.range-control output {
  grid-column: 2;
  grid-row: 2;
  min-width: 36px;
  color: #fff;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}

.steps-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.step-control {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 3px 4px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.045);
  font-family: var(--font-mono);
  font-size: 9px;
}

.step-control.inactive {
  opacity: 0.42;
}

.step-label {
  color: rgba(255, 255, 255, 0.7);
  font-variant-numeric: tabular-nums;
}

.step-control input {
  width: 100%;
  min-width: 20px;
  height: 16px;
  margin: 0;
  accent-color: #ff4054;
}

.step-control output {
  width: 28px;
  color: #fff;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.control-note {
  margin: 7px 2px 0;
  color: rgba(255, 255, 255, 0.58);
  font-family: var(--font-hardware);
  font-size: 8px;
  letter-spacing: 0.45px;
  line-height: 1.35;
  text-transform: uppercase;
}

@media (max-width: 520px) {
  .steps-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
