<script lang="ts">
export interface LcdFieldOption {
  label: string;
  value: number;
}

export interface LcdField {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  reason: string;
  format?: (value: number) => string;
  kind?: 'number' | 'enum' | 'boolean' | 'action';
  options?: readonly LcdFieldOption[];
  setValue?: (value: number) => void;
  activate?: () => void;
}
</script>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  fields: readonly LcdField[];
  selectedIndex?: number;
}>(), {
  selectedIndex: 0,
});

const emit = defineEmits<{
  (event: 'select', index: number): void;
  (event: 'update', index: number, value: number): void;
  (event: 'activate', index: number): void;
}>();

const cards = computed(() => Array.from({ length: 4 }, (_, index) => props.fields[index] ?? null));

function fieldId(key: string): string {
  return 'lcd-field-' + key;
}

function selectField(index: number): void {
  emit('select', index);
}

function displayValue(field: LcdField): string {
  if (field.format) return field.format(field.value);
  if (field.kind === 'boolean') return field.value >= 50 ? 'ON' : 'OFF';
  if (field.kind === 'enum') {
    return field.options?.find((option) => option.value === field.value)?.label ?? String(field.value);
  }
  return Math.round(field.value) + (field.max === 100 ? '%' : '');
}

function enumIndex(field: LcdField): number {
  if (!field.options?.length) return 0;
  const index = field.options.findIndex((option) => option.value === field.value);
  return index < 0 ? 0 : index;
}

function updateNumber(index: number, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const value = Number(target.value);
  if (Number.isFinite(value)) emit('update', index, value);
}

function updateEnum(index: number, field: LcdField, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const option = field.options?.[Number(target.value)];
  if (option) emit('update', index, option.value);
}

function toggleBoolean(index: number, field: LcdField): void {
  emit('update', index, field.value >= 50 ? 0 : 100);
}

function activateField(index: number): void {
  emit('activate', index);
}
</script>

<template>
  <div class="lcd-field-grid" role="group" aria-label="LCD screen controls">
    <div
      v-for="(field, index) in cards"
      :key="field ? field.key : 'lcd-empty-' + index"
      class="lcd-field-card"
      :data-field-key="field?.key"
      :class="{
        'is-selected': selectedIndex === index,
        'is-disabled': field?.disabled,
        'is-empty': !field,
        'is-number': field?.kind !== 'enum' && field?.kind !== 'boolean' && field?.kind !== 'action',
        'is-action': field?.kind === 'action',
      }"
      :title="field?.reason || undefined"
      @pointerdown="selectField(index)"
      @focusin="selectField(index)"
    >
      <template v-if="field">
        <template v-if="field.kind === 'enum'">
          <span class="lcd-field-label">{{ field.label }}</span>
          <div class="lcd-enum-control">
            <output class="lcd-enum-value" :aria-label="`${field.label}: ${displayValue(field)}`">
              {{ displayValue(field) }}
            </output>
            <input
              :id="fieldId(field.key)"
              :data-testid="fieldId(field.key)"
              class="lcd-enum-range"
              type="range"
              min="0"
              :max="Math.max(0, (field.options?.length ?? 1) - 1)"
              step="1"
              :value="enumIndex(field)"
              :disabled="field.disabled || !field.options?.length"
              :data-option-labels="JSON.stringify(field.options?.map((option) => option.label) ?? [])"
              :aria-label="field.label"
              :aria-valuetext="displayValue(field)"
              :aria-description="field.reason || undefined"
              :title="field.reason || undefined"
              @input="updateEnum(index, field, $event)"
            >
          </div>
        </template>

        <template v-else-if="field.kind === 'boolean'">
          <span class="lcd-field-label">{{ field.label }}</span>
          <button
            type="button"
            class="lcd-field-toggle"
            :data-testid="fieldId(field.key)"
            :disabled="field.disabled"
            :aria-pressed="field.value >= 50"
            :aria-label="field.label + ': ' + displayValue(field)"
            :aria-description="field.reason || undefined"
            :title="field.reason || undefined"
            @click="toggleBoolean(index, field)"
          >
            {{ displayValue(field) }}
          </button>
        </template>

        <template v-else-if="field.kind === 'action'">
          <button
            type="button"
            class="lcd-field-action"
            :data-testid="fieldId(field.key)"
            :disabled="field.disabled"
            :aria-label="field.label"
            :aria-description="field.reason || undefined"
            :title="field.reason || undefined"
            @click="activateField(index)"
          >
            <span class="lcd-field-label">{{ field.label }}</span>
            <strong v-if="field.format || field.value !== 0">{{ displayValue(field) }}</strong>
            <span class="action-mark" aria-hidden="true">›</span>
          </button>
        </template>

        <template v-else>
          <div class="lcd-field-heading">
            <label class="lcd-field-label" :for="fieldId(field.key)">{{ field.label }}</label>
            <output class="lcd-field-value" :for="fieldId(field.key)">{{ displayValue(field) }}</output>
          </div>
          <input
            :id="fieldId(field.key)"
            :data-testid="fieldId(field.key)"
            class="lcd-field-range"
            type="range"
            :min="field.min"
            :max="field.max"
            :step="field.step"
            :value="field.value"
            :disabled="field.disabled"
            :aria-label="field.label"
            :aria-valuetext="displayValue(field)"
            :aria-description="field.reason || undefined"
            :title="field.reason || undefined"
            @input="updateNumber(index, $event)"
          >
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lcd-field-grid {
  display: grid;
  box-sizing: border-box;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 2px 4px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  color: #24212a;
  font-family: var(--font-lcd, 'Lucida Console', monospace);
  text-transform: uppercase;
}

.lcd-field-card {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  min-width: 0;
  min-height: 0;
  padding: 3px 5px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 0;
  background: transparent;
}

.lcd-field-card.is-selected {
  border-color: #313e55;
  background: #313e55;
  color: #e9f1ff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
}
.lcd-field-card:has(.lcd-enum-control) { display: grid; grid-template-rows: 12px minmax(0, 1fr); gap: 0; padding: 1px 2px; }
.lcd-field-card.is-number { flex-direction: column; align-items: stretch; justify-content: center; gap: 1px; padding: 1px 3px; }
.lcd-field-card.is-number .lcd-field-label { font-size: 12px; letter-spacing: 0; }

.lcd-field-card.is-disabled {
  border-style: dashed;
  color: #615b69;
}

.lcd-field-card.is-disabled.is-selected {
  color: #f0ebf6;
}

.lcd-field-card.is-empty {
  visibility: hidden;
}

.lcd-field-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lcd-field-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
  height: 16px;
}

.lcd-field-value {
  display: block;
  max-width: 86px;
  overflow: hidden;
  color: inherit;
  font-size: 15px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lcd-field-range {
  display: block;
  width: 100%;
  height: 8px;
  min-height: 8px;
  margin: 0;
  padding: 0;
  accent-color: #344e72;
  cursor: pointer;
  touch-action: pan-y;
}

.is-selected .lcd-field-range {
  accent-color: #e0e9f7;
}

.lcd-field-range:disabled {
  cursor: not-allowed;
}

.lcd-field-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 0 3px;
  color: inherit;
  font: 700 12px/1.15 var(--font-lcd, 'Lucida Console', monospace);
  text-align: center;
  text-overflow: ellipsis;
  white-space: normal;
  overflow: hidden;
}

.lcd-enum-control {
  display: grid;
  box-sizing: border-box;
  grid-template-rows: minmax(0, 1fr) 5px;
  align-items: center;
  min-width: 0;
  height: 20px;
  border-top: 1px solid rgba(37, 50, 72, 0.32);
  border-bottom: 1px solid rgba(37, 50, 72, 0.32);
}

.lcd-enum-value {
  display: block;
  width: 100%;
  max-height: 14px;
  overflow: hidden;
  color: inherit;
  font: 700 13px/1 var(--font-lcd, 'Lucida Console', monospace);
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lcd-enum-range {
  box-sizing: border-box;
  width: 100%;
  height: 5px;
  min-height: 5px;
  margin: 0;
  accent-color: #344e72;
  cursor: pointer;
}
.is-selected .lcd-enum-range { accent-color: #e0e9f7; }
.lcd-enum-range:disabled { cursor: not-allowed; }
.is-disabled .lcd-enum-control { opacity: .6; }
.is-selected .lcd-enum-control { border-color: rgba(255, 255, 255, .45); }
.lcd-field-card.is-action { border-color: rgba(37, 50, 72, .24); }
.lcd-field-card.is-action.is-selected { border-color: #313e55; }
.lcd-field-card.is-disabled:not(.is-selected) { color: #4f607b; }
.lcd-field-card.is-disabled.is-selected { color: #d4deef; }

.lcd-field-card :is(input, button):focus-visible {
  outline: 2px solid #273953;
  outline-offset: -2px;
}
.lcd-field-card.is-selected :is(input, button):focus-visible { outline-color: #fff; }
.lcd-field-card :is(input, button):disabled { cursor: not-allowed; }

.lcd-field-range {
  accent-color: #344e72;
}

.lcd-field-toggle {
  min-width: 46px;
  min-height: 24px;
  padding: 1px 6px;
  border: 1px solid rgba(37, 50, 72, .5);
  border-radius: 0;
  color: #222d40;
  background: transparent;
  font: 800 13px/1 var(--font-lcd, monospace);
  cursor: pointer;
}

.is-selected .lcd-field-toggle {
  border-color: #e4efff;
  color: #182237;
  background: #d7e4f7;
}

.lcd-field-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  width: 100%;
  min-width: 0;
  min-height: 22px;
  padding: 1px 2px;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.lcd-field-action strong {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-mark {
  flex: 0 0 auto;
  font-size: 17px;
  line-height: 1;
}

.lcd-field-card :is(input, select, button):focus-visible {
  outline: 2px solid #282332;
  outline-offset: -2px;
}

.lcd-field-card.is-selected :is(input, select, button):focus-visible {
  outline-color: #fff;
}

.lcd-field-card :is(input, select, button):disabled {
  cursor: not-allowed;
}
</style>
