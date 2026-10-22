<template>
  <div class="native-track-chain" data-native-track-fx>
    <div class="chain-context">
      <strong data-native-track-fx-context>TRACK {{ target }} · SLOT {{ activeSlot }}</strong>
      <span>Independent Native A → B → C → D before the shared post-mix bank</span>
    </div>

    <div class="chain-slots" aria-label="Native per-track FX slots">
      <button
        v-for="slot in slots"
        :key="slot.id"
        type="button"
        :class="{ selected: activeSlot === slot.id, enabled: slot.active }"
        :aria-label="`Select Native Track ${target} FX slot ${slot.id}`"
        :aria-pressed="activeSlot === slot.id"
        @click="selectSlot(slot.id)"
      >{{ slot.id }} <small>{{ slot.active ? 'ON' : 'OFF' }}</small></button>
    </div>

    <template v-if="activeFx && typeof target === 'number'">
      <label class="chain-field">
        Effect
        <select
          aria-label="Native per-track FX type"
          :value="activeFx.type"
          :disabled="fxOptions.length <= 1"
          @change="setType(target, activeSlotIndex, ($event.target as HTMLSelectElement).value)"
        >
          <option v-if="activeFx.type && !fxOptions.includes(activeFx.type)" :value="activeFx.type" disabled>
            UNAVAILABLE: {{ activeFx.type }}
          </option>
          <option v-for="type in fxOptions" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>

      <label class="chain-field">
        Amount {{ activeFx.value.toFixed(0) }}%
        <input
          aria-label="Native per-track FX amount"
          type="range" min="0" max="100" step="1"
          :value="activeFx.value"
          :disabled="activeFx.type === 'NONE' || !available"
          @input="setValue(target, activeSlotIndex, Number(($event.target as HTMLInputElement).value))"
        />
      </label>

      <button
        type="button" class="activation"
        aria-label="Toggle Native per-track FX slot"
        :aria-pressed="activeFx.active"
        :disabled="activeFx.type === 'NONE' || !available"
        @click="setActive(target, activeSlotIndex, !activeFx.active)"
      >SLOT {{ activeSlot }} {{ activeFx.active ? 'ON' : 'BYPASSED' }}</button>

      <template v-if="parameterSchema">
        <label v-for="descriptor in parameterSchema.parameters" :key="descriptor.id" class="chain-field">
          {{ descriptor.provenance === 'extension' ? 'Extension · ' : 'RC · ' }}{{ descriptor.label }} <small>{{ descriptor.unit || descriptor.id }} · {{ descriptor.minimum }}–{{ descriptor.maximum }}</small>
          <small v-if="descriptor.limitation">PARTIAL: {{ descriptor.limitation }}</small>
          <select
            v-if="descriptor.discrete && descriptor.discreteValues?.length"
            :aria-label="`Native ${descriptor.label}`"
            :value="descriptor.provenance === 'routing' ? (draftParameters[descriptor.id] ?? '') : draftValue(descriptor.id, descriptor.defaultValue)"
            :disabled="activeFx.type === 'NONE' || !available"
            @change="setDraftValue(descriptor.id, Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-if="descriptor.provenance === 'routing'" value="">Choose algorithm explicitly</option>
            <option v-for="choice in descriptor.discreteValues" :key="choice" :value="choice">{{ descriptor.options?.find(option => option.value === choice)?.label ?? choice }}</option>
          </select>
          <input
            v-else
            :aria-label="`Native ${descriptor.label}`"
            type="number" :min="descriptor.minimum" :max="descriptor.maximum"
            :step="descriptor.step ?? numberStep(descriptor.minimum, descriptor.maximum, descriptor.defaultValue)"
            :value="descriptor.provenance === 'routing' ? (draftParameters[descriptor.id] ?? '') : draftValue(descriptor.id, descriptor.defaultValue)"
            :disabled="activeFx.type === 'NONE' || !available"
            @input="setDraftValue(descriptor.id, Number(($event.target as HTMLInputElement).value))"
          />
          <select v-if="!descriptor.discrete && descriptor.options?.length" :aria-label="`Native ${descriptor.label} special choice`" :value="draftParameters[descriptor.id] ?? ''" :disabled="activeFx.type === 'NONE' || !available" @change="setDraftValue(descriptor.id, Number(($event.target as HTMLSelectElement).value))">
            <option value="" disabled>Numeric value / special choice</option>
            <option v-for="choice in descriptor.options" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
          </select>
        </label>
        <p v-if="parameterSchema.legacyAliases.length" class="parameter-help">
          Legacy JSON aliases accepted: {{ parameterSchema.legacyAliases.map((alias) => alias.id).join(', ') }}
        </p>
      </template>
      <p v-else class="parameter-help" data-native-parameter-schema-unavailable>
        This host does not advertise a valid Native parameter schema. Ranges are not guessed; advanced JSON remains host-validated.
      </p>
      <button
        type="button" class="apply-parameters"
        :disabled="activeFx.type === 'NONE' || !available || !parameterSchema"
        @click="applyDraftParameters"
      >Apply descriptor controls</button>
      <button
        type="button" class="apply-parameters"
        :disabled="activeFx.type === 'NONE' || !available"
        @click="resetNamedParameters"
      >Reset named overrides to macro/default</button>
      <details class="advanced-parameters">
        <summary>Advanced named parameter JSON</summary>
        <label class="chain-field">
          Named parameter overrides (JSON)
          <textarea
            v-model="namedText"
            aria-label="Native per-track named parameter JSON"
            rows="5"
            spellcheck="false"
            :disabled="activeFx.type === 'NONE' || !available"
          />
        </label>
        <button
          type="button" class="apply-parameters"
          :disabled="activeFx.type === 'NONE' || !available"
          @click="applyNamedParameters"
        >Apply named parameters</button>
      </details>
      <p class="parameter-help">Named fields use Native-published IDs, bounds, and discrete choices. Requested values remain pending until the host revision is applied.</p>
    </template>

    <p v-if="warning || editorError" class="chain-error" role="alert">{{ editorError || warning }}</p>
    <p v-if="slotStatus" class="chain-status" :class="{ 'chain-error': slotStatus.error }" data-native-track-fx-runtime-status>
      {{ statusText }}
    </p>
    <LoopTransportEditor v-if="typeof target === 'number'" :track-id="target" runtime-mode="native" />
  </div>
</template>

<script setup lang="ts">
import { mergeOfficialParameterEdit } from '../../audio/fx/official/parameters';
import { computed, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import { nativeCatalogMacroParameters } from '../../audio/nativeFxCatalog';
import { useNativeTrackFxState } from '../../composables/useNativeTrackFxState';
import LoopTransportEditor from '../fx/LoopTransportEditor.vue';

const {
  target, slots, activeSlot, activeSlotIndex, activeFx, fxOptions, runtimeStatus, slotRuntime,
  warning, selectSlot, setType, setValue, setNamedParameters, setActive,
} = useNativeTrackFxState();
const slotStatus = computed(() => runtimeStatus.value?.slots.find((slot) => slot.slotIndex === activeSlotIndex.value));
const available = computed(() => runtimeStatus.value?.available === true);
const engine = AudioEngine.getInstance();
const parameterSchema = computed(() => typeof engine.getNativeCatalogFxParameterSchema === 'function' &&
  typeof target.value === 'number' && activeFx.value && activeFx.value.type !== 'NONE'
  ? engine.getNativeCatalogFxParameterSchema(activeFx.value.type, 'track', target.value, activeFx.value.namedParameters, activeSlotIndex.value)
  : null);
const namedText = ref('{}');
const draftParameters = ref<Record<string, number>>({});
const editorError = ref('');

watch([target, activeSlot, activeFx], () => {
  namedText.value = JSON.stringify(activeFx.value?.namedParameters ?? {}, null, 2);
  draftParameters.value = activeFx.value ? { ...activeFx.value.namedParameters } : {};
  editorError.value = '';
}, { immediate: true, deep: true });

const statusText = computed(() => {
  const status = slotRuntime.value;
  if (!status) return slotStatus.value?.error || 'NATIVE PER-TRACK FX STATUS UNAVAILABLE';
  if (status.outcomeUnknown) return `OUTCOME UNKNOWN · ${status.error || 'checking Native host revision'}`;
  if (status.pendingApply) return `PENDING · ${status.requestedEffectId ?? 'EMPTY SLOT'} · REV ${status.requestedRevision ?? '?'}`;
  if (status.error) return `NOT APPLIED: ${status.error}`;
  if (status.acknowledged) {
    const accepted = Object.keys(status.acknowledgedParameters ?? {}).length;
    return `API ACK ${status.acknowledgedEffectId ?? 'EMPTY SLOT'} · ${accepted} PARAMETER(S) · REV ${status.appliedRevision ?? '?'}`;
  }
  if (!available.value) return 'NATIVE PER-TRACK CATALOG UNAVAILABLE';
  return 'WAITING FOR NATIVE API ACK';
});

function draftValue(key: string, descriptorDefault: number): number {
  const explicit = draftParameters.value[key];
  if (Number.isFinite(explicit)) return explicit!;
  const active = activeFx.value;
  const macro = active ? nativeCatalogMacroParameters(active.type, active.value)[key] : undefined;
  return Number.isFinite(macro) ? macro! : descriptorDefault;
}

function numberStep(minimum: number, maximum: number, defaultValue: number): number {
  const range = maximum - minimum;
  const decimals = Math.min(4, Math.max(
    (String(minimum).split('.')[1] ?? '').length,
    (String(maximum).split('.')[1] ?? '').length,
    (String(Number(defaultValue.toFixed(4))).split('.')[1] ?? '').length,
    range > 0 && range <= 1 ? 2 : 0,
  ));
  return decimals ? 10 ** -decimals : 1;
}

function setDraftValue(key: string, value: number) {
  if (!Number.isFinite(value)) return;
  draftParameters.value = mergeOfficialParameterEdit(draftParameters.value, key, value);
  const active = activeFx.value;
  const effective = { ...(active ? nativeCatalogMacroParameters(active.type, active.value) : {}), ...draftParameters.value };
  namedText.value = JSON.stringify(effective, null, 2);
}

function applyDraftParameters() {
  if (typeof target.value !== 'number' || !activeFx.value || !parameterSchema.value) return;
  for (const descriptor of parameterSchema.value.parameters) {
    const value = draftValue(descriptor.id, descriptor.defaultValue);
    if (!Number.isFinite(value) || value < descriptor.minimum || value > descriptor.maximum ||
        (descriptor.discrete && !descriptor.discreteValues?.includes(value))) {
      editorError.value = `${descriptor.label} is outside the Native descriptor's allowed values.`;
      return;
    }
  }
  editorError.value = '';
  if (!setNamedParameters(target.value, activeSlotIndex.value, { ...draftParameters.value })) {
    editorError.value = warning.value || 'Native named parameters were rejected.';
  }
}

function resetNamedParameters() {
  if (typeof target.value !== 'number') return;
  namedText.value = '{}';
  draftParameters.value = {};
  editorError.value = '';
  if (!setNamedParameters(target.value, activeSlotIndex.value, {})) editorError.value = warning.value || 'Native named parameters were rejected.';
}

function applyNamedParameters() {
  if (typeof target.value !== 'number') return;
  try {
    const parsed: unknown = JSON.parse(namedText.value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Named parameters must be a JSON object.');
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([key, value]) => !key || typeof value !== 'number' || !Number.isFinite(value))) {
      throw new TypeError('Named parameters need non-empty keys and finite numeric values.');
    }
    editorError.value = '';
    draftParameters.value = { ...(parsed as Record<string, number>) };
    if (!setNamedParameters(target.value, activeSlotIndex.value, parsed as Record<string, number>)) {
      editorError.value = warning.value || 'Native named parameters were rejected.';
    }
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : 'Native named parameters are invalid JSON.';
  }
}
</script>

<style scoped>
.native-track-chain, .chain-context, .chain-field { display: flex; flex-direction: column; gap: 8px; }
.native-track-chain { gap: 12px; }
.chain-context { font-size: 13px; line-height: 1.45; }
.chain-context strong { color: #ff6c7a; letter-spacing: 1px; }
.chain-context span, .parameter-help { color: rgba(255, 255, 255, 0.65); }
.chain-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.chain-slots button, select, input, textarea, .activation, .apply-parameters {
  min-height: 36px; padding: 6px 10px; border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px; background: #26232a; color: #f3f3f5;
}
.chain-slots button.selected { border-color: #ff6c7a; box-shadow: 0 0 0 1px #ff6c7a; }
.chain-slots button.enabled, .activation[aria-pressed="true"] { background: #63323a; }
.chain-slots small { display: block; font-size: 11px; margin-top: 3px; }
.chain-field { font-size: 13px; }
.chain-field :is(input, select, textarea) { font-size: 14px; }
.chain-field small { color: rgba(255, 255, 255, 0.55); }
.chain-slots button, .activation, .apply-parameters { font-size: 13px; }
.chain-field input, .chain-field select, .chain-field textarea { width: 100%; box-sizing: border-box; }
.chain-field textarea { resize: vertical; font-family: monospace; }
.chain-error { color: #ff9198; }
.chain-status { font-size: 12px; line-height: 1.45; margin: 0; overflow-wrap: anywhere; }
.parameter-help { margin: -4px 0 0; font-size: 12px; line-height: 1.45; }
.advanced-parameters { display: grid; gap: 10px; }
.advanced-parameters summary { cursor: pointer; }
button:disabled, input:disabled, textarea:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
