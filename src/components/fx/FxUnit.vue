<template>
  <div class="fx-unit">
    <!-- FX Type Selector -->
    <div class="fx-select-container">
      <select 
        :value="selectedType"
        @change="handleTypeChange"
        class="fx-select"
      >
        <option v-for="opt in options" :key="opt" :value="opt">
          {{ opt }}
        </option>
      </select>
    </div>

    <!-- Activation Button -->
    <HardwareButton
      shape="rect"
      size="sm"
      :label="label"
      :active="active"
      :color="active ? 'red' : 'neutral'"
      @press="toggleActive"
    />

    <!-- Parameter Fader -->
    <div class="fader-wrapper">
      <HardwareFader
        :model-value="modelValue"
        @update:model-value="updateFader"
        :led-color="active ? 'red' : 'white'"
        :label="''" 
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareFader from '../ui/HardwareFader.vue';

interface Props {
  label: string;
  options: string[];
  selectedType: string;
  modelValue: number;
  active: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:selectedType', value: string): void;
  (e: 'update:modelValue', value: number): void;
  (e: 'update:active', value: boolean): void;
}>();

const handleTypeChange = (e: Event) => {
  const target = e.target as HTMLSelectElement;
  emit('update:selectedType', target.value);
};

const toggleActive = () => {
  emit('update:active', !props.active);
};

const updateFader = (val: number) => {
  emit('update:modelValue', val);
};
</script>

<style scoped>
.fx-unit {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 56px;
  padding: 8px 4px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.fx-select-container {
  width: 100%;
}

.fx-select {
  width: 100%;
  background: transparent;
  border: none;
  color: #aaa;
  font-family: var(--font-mono);
  font-size: 10px;
  text-align: center;
  appearance: none;
  cursor: pointer;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.fx-select:focus {
  outline: none;
  border-bottom-color: var(--color-accent);
  color: #fff;
}

.fx-select option {
  background: #222;
  color: #fff;
}

.fader-wrapper {
  height: 80px;
  width: 100%;
}
</style>
