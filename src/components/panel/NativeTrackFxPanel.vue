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
      <p class="parameter-help">Use the Native descriptor's parameter IDs and finite numeric values. Overrides are sent as one complete map.</p>
    </template>

    <p v-if="warning || editorError" class="chain-error" role="alert">{{ editorError || warning }}</p>
    <p v-if="slotStatus" class="chain-status" :class="{ 'chain-error': slotStatus.error }" data-native-track-fx-runtime-status>
      {{ statusText }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useNativeTrackFxState } from '../../composables/useNativeTrackFxState';

const {
  target, slots, activeSlot, activeSlotIndex, activeFx, fxOptions, runtimeStatus, slotRuntime,
  warning, selectSlot, setType, setValue, setNamedParameters, setActive,
} = useNativeTrackFxState();
const slotStatus = computed(() => runtimeStatus.value?.slots.find((slot) => slot.slotIndex === activeSlotIndex.value));
const available = computed(() => runtimeStatus.value?.available === true);
const namedText = ref('{}');
const editorError = ref('');

watch([target, activeSlot, activeFx], () => {
  namedText.value = JSON.stringify(activeFx.value?.namedParameters ?? {}, null, 2);
  editorError.value = '';
}, { immediate: true, deep: true });

const statusText = computed(() => {
  const status = slotRuntime.value;
  if (!status) return slotStatus.value?.error || 'NATIVE PER-TRACK FX STATUS UNAVAILABLE';
  if (status.error) return `NOT APPLIED: ${status.error}`;
  if (status.pendingApply) return `APPLYING ${status.requestedEffectId ?? 'EMPTY SLOT'} · REV ${status.requestedRevision ?? '?'}`;
  if (status.acknowledged) {
    const accepted = Object.keys(status.acknowledgedParameters ?? {}).length;
    return `API ACK ${status.acknowledgedEffectId ?? 'EMPTY SLOT'} · ${accepted} PARAMETER(S) · REV ${status.appliedRevision ?? '?'}`;
  }
  if (!available.value) return 'NATIVE PER-TRACK CATALOG UNAVAILABLE';
  return 'WAITING FOR NATIVE API ACK';
});

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
.chain-context { font-size: 11px; line-height: 1.5; }
.chain-context strong { color: #ff6c7a; letter-spacing: 1px; }
.chain-context span, .parameter-help { color: rgba(255, 255, 255, 0.65); }
.chain-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.chain-slots button, select, input[type="range"], textarea, .activation, .apply-parameters {
  min-height: 36px; padding: 6px 10px; border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px; background: #26232a; color: #f3f3f5;
}
.chain-slots button.selected { border-color: #ff6c7a; box-shadow: 0 0 0 1px #ff6c7a; }
.chain-slots button.enabled, .activation[aria-pressed="true"] { background: #63323a; }
.chain-slots small { display: block; font-size: 9px; margin-top: 3px; }
.chain-field { font-size: 11px; }
.chain-field input, .chain-field select, .chain-field textarea { width: 100%; box-sizing: border-box; }
.chain-field textarea { resize: vertical; font-family: monospace; }
.chain-error { color: #ff9198; }
.chain-status { font-size: 10px; line-height: 1.5; margin: 0; overflow-wrap: anywhere; }
.parameter-help { margin: -4px 0 0; font-size: 10px; line-height: 1.4; }
button:disabled, input:disabled, textarea:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
