<template>
  <details class="native-catalog-parameters" data-native-catalog-parameters>
    <summary>Named controls · {{ title }}</summary>
    <p class="native-catalog-help">Blank fields follow the amount control or processor default. Official controls override overlapping extensions. Changes are saved only after Native ACK. Removing authored fields while audio is running may require stopping Native audio before applying.</p>
    <p v-if="schema.legacyAliases.length" class="native-catalog-help">Legacy API aliases remain accepted: {{ schema.legacyAliases.map((item) => item.id).join(', ') }}</p>
    <label v-for="descriptor in schema.parameters" :key="descriptor.id" class="native-catalog-field">
      <span>{{ descriptor.provenance === 'extension' ? 'Extension · ' : 'RC · ' }}{{ descriptor.label }} <small>{{ descriptor.unit || descriptor.id }}</small></span>
      <small v-if="descriptor.limitation">PARTIAL: {{ descriptor.limitation }}</small>
      <select
        v-if="descriptor.discrete && descriptor.discreteValues?.length"
        :aria-label="`${title} ${descriptor.id}`"
        :value="draft[descriptor.id] ?? ''"
        :disabled="disabled"
        @change="updateSelect(descriptor.id, $event)"
      >
        <option value="">Follow amount / default ({{ fallbackValue(descriptor.id, descriptor.defaultValue) }})</option>
        <option v-for="choice in descriptor.discreteValues" :key="choice" :value="choice">{{ descriptor.options?.find(option => option.value === choice)?.label ?? choice }}</option>
      </select>
      <input
        v-else
        type="number"
        :aria-label="`${title} ${descriptor.id}`"
        :value="draft[descriptor.id] ?? ''"
        :placeholder="`Macro/default ${fallbackValue(descriptor.id, descriptor.defaultValue)}`"
        :min="descriptor.minimum"
        :max="descriptor.maximum"
        :step="descriptor.step ?? stepFor(descriptor.minimum, descriptor.maximum, descriptor.defaultValue)"
        :disabled="disabled"
        @input="updateNumber(descriptor.id, $event)"
      />
      <select v-if="!descriptor.discrete && descriptor.options?.length" :aria-label="`${title} ${descriptor.id} special value`" :disabled="disabled" :value="draft[descriptor.id] ?? ''" @change="updateSelect(descriptor.id, $event)">
        <option value="">Manual value / default</option>
        <option v-for="choice in descriptor.options" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
      </select>
      <small v-if="descriptor.provenance === 'official-interface'">Guide p.{{ descriptor.sourcePage }} · {{ descriptor.documentedDefault === null ? 'Default undocumented' : `Documented default ${descriptor.documentedDefault}` }} · clean-room DSP, not hardware-verified</small>
    </label>
    <div class="native-catalog-actions">
      <button type="button" :disabled="disabled || !validDraft" @click="apply">Apply named controls</button>
      <button type="button" :disabled="disabled || !Object.keys(modelValue).length" @click="reset">Reset to macro/default</button>
    </div>
    <p class="native-catalog-status" role="status" aria-live="polite">{{ statusText }}</p>
  </details>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { NativeCatalogFxSlotRuntime } from '../../audio/NativeAudioEngine';
import { findOfficialEffect, findOfficialRuntimeParameter, mergeOfficialParameterEdit, isOfficialRuntimeValueValid } from '../../audio/fx/official/parameters';
import type { NativeFxParameterSchema } from '../../audio/NativeBridgeClient';

const props = defineProps<{
  title: string;
  schema: NativeFxParameterSchema;
  modelValue: Record<string, number>;
  macroParameters: Record<string, number>;
  runtime: NativeCatalogFxSlotRuntime | null;
  pendingSubmission?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  apply: [parameters: Record<string, number>];
}>();

const draft = ref<Record<string, number>>({ ...props.modelValue });
// The parent computes an empty object for an unpersisted slot. Watching the
// object identity (deeply) resets an in-progress edit on every Native status
// poll because each render can produce a fresh but equal `{}`. Track content
// instead so only an acknowledged/persisted value replaces the user's draft.
watch(() => JSON.stringify(props.modelValue), (serialized) => {
  try {
    const value: unknown = JSON.parse(serialized || '{}');
    draft.value = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, number>) }
      : {};
  } catch {
    draft.value = {};
  }
});

const validDraft = computed(() => {
  const descriptors = new Map(props.schema.parameters.map((item) => [item.id, item]));
  return Object.entries(draft.value).every(([key, value]) => {
    const descriptor = descriptors.get(key);
    if (descriptor?.provenance === 'official-interface') {
      const parameter = findOfficialRuntimeParameter(findOfficialEffect(descriptor.officialEffectName ?? props.title), key);
      if (parameter && !isOfficialRuntimeValueValid(parameter, value)) return false;
    }
    return Boolean(descriptor) && Number.isFinite(value) && value >= descriptor!.minimum && value <= descriptor!.maximum &&
      (!descriptor!.discrete || descriptor!.discreteValues?.includes(value) === true);
  });
});

const statusText = computed(() => {
  const runtime = props.runtime;
  if (!runtime) return 'NATIVE STATUS UNAVAILABLE';
  if (runtime.outcomeUnknown) return `OUTCOME UNKNOWN · ${runtime.error || 'check Native status before retrying'}`;
  if (props.pendingSubmission) return 'PENDING NATIVE ACK · controls are saved only after confirmation';
  if (runtime.pendingApply) return `PENDING NATIVE ACK · REV ${runtime.requestedRevision ?? '?'}`;
  if (runtime.error) return `NOT APPLIED · ${runtime.error}`;
  if (runtime.acknowledged) return `NATIVE ACK · REV ${runtime.appliedRevision ?? '?'}`;
  return 'WAITING FOR NATIVE ACK';
});

function fallbackValue(key: string, defaultValue: number): number {
  const macro = props.macroParameters[key];
  return typeof macro === 'number' && Number.isFinite(macro) ? macro : defaultValue;
}

function stepFor(minimum: number, maximum: number, defaultValue: number): number {
  const decimals = Math.min(4, Math.max(
    (String(minimum).split('.')[1] ?? '').length,
    (String(maximum).split('.')[1] ?? '').length,
    (String(Number(defaultValue.toFixed(4))).split('.')[1] ?? '').length,
    maximum - minimum > 0 && maximum - minimum <= 1 ? 2 : 0,
  ));
  return decimals ? 10 ** -decimals : 1;
}

function updateNumber(key: string, event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  const next = key === 'official_variant' ? (raw.trim() ? mergeOfficialParameterEdit(draft.value, key, Number(raw)) : Object.fromEntries(Object.entries(draft.value).filter(([name]) => !name.startsWith('official_')))) : { ...draft.value };
  if (!raw.trim()) delete next[key];
  else {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    next[key] = value;
  }
  draft.value = next;
}

function updateSelect(key: string, event: Event) {
  const raw = (event.target as HTMLSelectElement).value;
  const next = key === 'official_variant' ? (raw.trim() ? mergeOfficialParameterEdit(draft.value, key, Number(raw)) : Object.fromEntries(Object.entries(draft.value).filter(([name]) => !name.startsWith('official_')))) : { ...draft.value };
  if (!raw.trim()) delete next[key];
  else {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    next[key] = value;
  }
  draft.value = next;
}

function apply() {
  if (!props.disabled && validDraft.value) emit('apply', { ...draft.value });
}

function reset() {
  draft.value = {};
  emit('apply', {});
}
</script>

<style scoped>
.native-catalog-parameters { display: grid; gap: 8px; margin-top: 10px; padding: 8px; border: 1px solid rgba(0, 0, 0, .15); border-radius: 8px; }
.native-catalog-parameters summary { cursor: pointer; font-size: 12px; letter-spacing: .4px; }
.native-catalog-help { margin: 0; color: rgba(255, 255, 255, .66); font-size: 11px; line-height: 1.4; }
.native-catalog-field { display: grid; gap: 4px; font-size: 12px; }
.native-catalog-field small { opacity: .65; }
.native-catalog-field input, .native-catalog-field select, .native-catalog-actions button { box-sizing: border-box; min-height: 32px; padding: 4px 8px; border: 1px solid rgba(255, 255, 255, .2); border-radius: 7px; background: rgba(255, 255, 255, .08); color: #f3f3f5; }
.native-catalog-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.native-catalog-actions button { cursor: pointer; }
.native-catalog-actions button:disabled, .native-catalog-field :disabled { opacity: .45; cursor: not-allowed; }
.native-catalog-status { margin: 0; font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
</style>
