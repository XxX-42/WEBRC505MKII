<template>
  <div class="browser-track-chain" data-browser-track-fx>
    <div class="chain-context">
      <strong data-track-fx-context>TRACK {{ target }} · SLOT {{ activeSlot }}</strong>
      <span>Independent A → B → C → D, before the shared bank</span>
      <span>BEAT SHIFT and VINYL FLICK use a separate experimental per-loop source-transport route; they are not A–D inserts.</span>
    </div>

    <div class="chain-slots" aria-label="Per-track FX slots">
      <button
        v-for="slot in slots"
        :key="slot.id"
        type="button"
        :class="{ selected: activeSlot === slot.id, enabled: slot.active }"
        :aria-label="`Select Track ${target} FX slot ${slot.id}`"
        :aria-pressed="activeSlot === slot.id"
        @click="selectSlot(slot.id)"
      >{{ slot.id }} <small>{{ slot.active ? 'ON' : 'OFF' }}</small></button>
    </div>

    <template v-if="activeFx && typeof target === 'number'">
      <label class="chain-field">
        Effect
        <select
          aria-label="Per-track FX type"
          :value="activeFx.type"
          @change="setType(target, activeSlotIndex, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="type in fxOptions" :key="type" :value="type">{{ type }}</option>
        </select>
      </label>
      <label class="chain-field">
        Amount {{ activeFx.value.toFixed(0) }}%
        <input
          aria-label="Per-track FX amount"
          type="range" min="0" max="100" step="1"
          :value="activeFx.value"
          :disabled="activeFx.type === 'NONE'"
          @input="setValue(target, activeSlotIndex, Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <button
        type="button" class="activation"
        aria-label="Toggle per-track FX slot"
        :aria-pressed="activeFx.active"
        :disabled="activeFx.type === 'NONE'"
        @click="setActive(target, activeSlotIndex, !activeFx.active)"
      >SLOT {{ activeSlot }} {{ activeFx.active ? 'ON' : 'BYPASSED' }}</button>

      <details v-if="controls.length" class="named-controls">
        <summary>Named controls</summary>
        <p>Blank fields follow the amount control or the processor default. Named edits override individual controls.</p>
        <label v-for="control in controls" :key="`${target}:${activeSlot}:${activeFx.type}:${control.key}`" class="chain-field">
          {{ control.label }} ({{ control.unit }})
          <select
            v-if="control.options?.length"
            :aria-label="`Track ${target} slot ${activeSlot} ${control.key}`"
            :value="activeFx.namedParameters[control.key] ?? ''"
            @change="updateNamed(control.key, $event)"
          >
            <option value="" disabled>Follow amount / default</option>
            <option v-for="option in control.options" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <input
            v-else type="number"
            :aria-label="`Track ${target} slot ${activeSlot} ${control.key}`"
            :value="activeFx.namedParameters[control.key] ?? ''"
            :placeholder="`Default ${control.defaultValue}`"
            :min="control.min" :max="control.max" :step="control.step"
            @change="updateNamed(control.key, $event)"
          />
        </label>
      </details>
    </template>

    <p v-if="warning" class="chain-error" role="alert">{{ warning }}</p>
    <p v-if="slotStatus" class="chain-status" :class="{ 'chain-error': slotStatus.error }" data-track-fx-runtime-status>
      {{ slotStatus.error ? `BYPASSED: ${slotStatus.error}` : `${slotStatus.state.toUpperCase()} · ${slotStatus.bypassed ? 'BYPASSED' : 'ACTIVE'}` }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useBrowserTrackFxState } from '../../composables/useBrowserTrackFxState';

const {
  target, slots, activeSlot, activeSlotIndex, activeFx, controls, fxOptions,
  runtimeStatus, warning, selectSlot, setType, setValue, setNamedParameters, setActive,
} = useBrowserTrackFxState();
const slotStatus = computed(() => runtimeStatus.value?.slots.find((slot) => slot.slotIndex === activeSlotIndex.value));

function updateNamed(key: string, event: Event) {
  if (typeof target.value !== 'number') return;
  const raw = (event.target as HTMLInputElement).value;
  if (!raw.trim()) return;
  setNamedParameters(target.value, activeSlotIndex.value, { [key]: Number(raw) });
}
</script>

<style scoped>
.browser-track-chain, .chain-context, .chain-field, .named-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.browser-track-chain { gap: 12px; }
.chain-context { font-size: 11px; line-height: 1.5; }
.chain-context strong { color: #ff6c7a; letter-spacing: 1px; }
.chain-context span, .named-controls p { color: rgba(255, 255, 255, 0.65); }
.chain-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.chain-slots button, select, input[type="number"], .activation {
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px;
  background: #26232a;
  color: #f3f3f5;
}
.chain-slots button.selected { border-color: #ff6c7a; box-shadow: 0 0 0 1px #ff6c7a; }
.chain-slots button.enabled, .activation[aria-pressed="true"] { background: #63323a; }
.chain-slots small { display: block; font-size: 9px; margin-top: 3px; }
.chain-field { font-size: 11px; }
.chain-field input, .chain-field select { width: 100%; box-sizing: border-box; }
.named-controls { border-top: 1px solid #50434c; padding-top: 10px; }
.named-controls summary { cursor: pointer; font-size: 12px; }
.named-controls p { font-size: 11px; line-height: 1.5; }
.named-controls .chain-field { margin-top: 10px; }
.chain-error { color: #ff9198; }
.chain-status { font-size: 10px; line-height: 1.5; margin: 0; }
button:disabled, input:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
