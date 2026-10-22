<template>
  <details class="browser-catalog-parameters" data-browser-catalog-parameters>
    <summary>Named controls · {{ title }}</summary>
    <p>Blank fields follow the amount control or processor default. Named edits are saved per slot and effect; the amount control affects legacy extensions, while explicit RC controls stay authoritative.</p>
    <label v-for="control in controls" :key="control.key" class="browser-catalog-field">
      <span>{{ control.provenance === 'extension' ? 'Extension · ' : '' }}{{ control.label }} <small v-if="control.unit">({{ control.unit }})</small></span>
      <small v-if="control.hint" class="browser-catalog-hint">{{ control.hint }}</small>
      <select
        v-if="control.options?.length"
        :aria-label="`${title} ${control.key}`"
        :value="modelValue[control.key] ?? ''"
        :disabled="disabled"
        @change="emit('change', control.key, $event)"
      >
        <option value="" disabled>Follow amount / default</option>
        <option v-for="option in control.options" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <input
        v-else
        type="number"
        :aria-label="`${title} ${control.key}`"
        :value="modelValue[control.key] ?? ''"
        :placeholder="`Default ${control.defaultValue}`"
        :min="control.min"
        :max="control.max"
        :step="control.step"
        :disabled="disabled"
        @change="emit('change', control.key, $event)"
      />
      <select
        v-if="control.specialOptions?.length"
        :aria-label="`${title} ${control.key} special choice`"
        :value="modelValue[control.key] ?? ''"
        :disabled="disabled"
        @change="emit('change', control.key, $event)"
      >
        <option value="" disabled>Numeric value / special choice</option>
        <option v-for="option in control.specialOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <button
      v-if="Object.keys(modelValue).length"
      type="button"
      class="reset-named-controls"
      :aria-label="resetLabel ?? `Reset ${title} named controls`"
      :disabled="disabled"
      @click="emit('reset')"
    >Reset named controls</button>
  </details>
</template>

<script setup lang="ts">
import type { BrowserTrackFxControl } from '../../composables/browserTrackFxParameters';

defineProps<{
  title: string;
  controls: BrowserTrackFxControl[];
  modelValue: Record<string, number>;
  disabled?: boolean;
  resetLabel?: string;
}>();
const emit = defineEmits<{
  change: [key: string, event: Event];
  reset: [];
}>();
</script>

<style scoped>
.browser-catalog-parameters { display: grid; gap: 8px; margin-top: 10px; padding: 8px; border: 1px solid rgba(255, 255, 255, .15); border-radius: 8px; }
.browser-catalog-parameters summary { cursor: pointer; font-size: 12px; letter-spacing: .4px; }
.browser-catalog-parameters p, .browser-catalog-hint { margin: 0; opacity: .7; font-size: 11px; line-height: 1.4; }
.browser-catalog-field { display: grid; gap: 4px; font-size: 12px; }
.browser-catalog-field input, .browser-catalog-field select, .reset-named-controls { box-sizing: border-box; min-height: 32px; max-width: 100%; padding: 4px 8px; border: 1px solid rgba(255, 255, 255, .2); border-radius: 7px; background: rgba(255, 255, 255, .08); color: inherit; }
.reset-named-controls { cursor: pointer; }
.browser-catalog-parameters :disabled { opacity: .45; cursor: not-allowed; }
</style>
