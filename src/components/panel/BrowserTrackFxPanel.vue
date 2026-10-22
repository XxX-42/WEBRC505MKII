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
      <label v-if="activeFx.type !== 'OSC VOC (M)' && activeFx.type !== 'HRM AUTO (M)' && activeFx.type !== 'HRM AUTO (M) (EXPERIMENTAL)'" class="chain-field">
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

      <details v-if="controls.length && activeFx.type !== 'OSC VOC (M)' && activeFx.type !== 'HRM AUTO (M)' && activeFx.type !== 'HRM AUTO (M) (EXPERIMENTAL)'" class="named-controls">
        <summary>Named controls</summary>
        <p>Blank fields follow the amount control or the processor default. Named edits override individual controls.</p>
        <label v-for="control in controls" :key="`${target}:${activeSlot}:${activeFx.type}:${control.key}`" class="chain-field">
          {{ control.provenance === 'extension' ? 'Extension · ' : '' }}{{ control.label }} ({{ control.unit }})
          <small v-if="control.hint" class="chain-field-hint">{{ control.hint }}</small>
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
          <select v-if="control.specialOptions?.length" :aria-label="`Track ${target} slot ${activeSlot} ${control.key} special choice`" :value="activeFx.namedParameters[control.key] ?? ''" @change="updateNamed(control.key, $event)">
            <option value="" disabled>Numeric value / special choice</option>
            <option v-for="option in control.specialOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
      </details>
      <OscVocFxEditor
        v-if="activeFx.type === 'OSC VOC (M)' && typeof target === 'number'"
        :model-value="oscVocParameters"
        :midi-target="{ path: 'track', trackId: target, slot: activeSlot, effectId: 'osc_voc_m' }"
        @update:model-value="updateOscVocParameters"
      />
      <HrmAutoFxEditor
        v-if="(activeFx.type === 'HRM AUTO (M)' || activeFx.type === 'HRM AUTO (M) (EXPERIMENTAL)') && typeof target === 'number'"
        :model-value="hrmAutoParameters"
        :midi-target="{ path: 'track', trackId: target, slot: activeSlot, effectId: 'hrm_auto_m' }"
        @update:model-value="updateHrmAutoParameters"
      />
    </template>

    <p v-if="warning" class="chain-error" role="alert">{{ warning }}</p>
    <p v-if="slotStatus" class="chain-status" :class="{ 'chain-error': slotStatus.error }" data-track-fx-runtime-status>
      {{ slotStatus.error ? `BYPASSED: ${slotStatus.error}` : `${slotStatus.state.toUpperCase()} · ${slotStatus.bypassed ? 'BYPASSED' : 'ACTIVE'}` }}
    </p>
    <p v-if="slotStatus?.pendingApply" class="chain-status chain-warning" data-track-fx-pending>
      Preparing {{ slotStatus.requestedEffectId }}; current audio stays active until the candidate is ready.
    </p>
    <p v-if="slotStatus?.resourceNote" class="chain-status chain-warning" data-track-fx-resource-warning>{{ slotStatus.resourceNote }}</p>
    <p v-if="slotStatus?.warning" class="chain-status chain-error" data-track-fx-selection-warning>{{ slotStatus.warning }}</p>
    <LoopTransportEditor v-if="typeof target === 'number'" :track-id="target" runtime-mode="browser" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useBrowserTrackFxState } from '../../composables/useBrowserTrackFxState';
import OscVocFxEditor from '../fx/OscVocFxEditor.vue';
import { createDefaultOscVocParameters, sanitizeOscVocParameters, type OscVocParameters } from '../../audio/oscVocParameters';
import HrmAutoFxEditor from '../fx/HrmAutoFxEditor.vue';
import { createDefaultHrmAutoParameters, sanitizeHrmAutoParameters, type HrmAutoParameters } from '../../audio/hrmAutoParameters';
import LoopTransportEditor from '../fx/LoopTransportEditor.vue';

const {
  target, slots, activeSlot, activeSlotIndex, activeFx, controls, fxOptions,
  runtimeStatus, warning, selectSlot, setType, setValue, setNamedParameters, setActive,
} = useBrowserTrackFxState();
const slotStatus = computed(() => runtimeStatus.value?.slots.find((slot) => slot.slotIndex === activeSlotIndex.value));
const oscVocParameters = computed(() => {
  const named = activeFx.value?.namedParameters;
  return sanitizeOscVocParameters(named ? {
    waveform: named.waveform as OscVocParameters['waveform'],
    midiChannel: named['midi-channel'],
    octaveSemitones: named.octave,
    mixPercent: typeof named.mix === 'number' ? named.mix * 100 : activeFx.value?.value,
  } : createDefaultOscVocParameters());
});
const hrmAutoParameters = computed(() => {
  const named = activeFx.value?.namedParameters ?? {};
  const defaults = createDefaultHrmAutoParameters();
  return sanitizeHrmAutoParameters({
    key: named.key as HrmAutoParameters['key'] | undefined,
    scale: named.scale as HrmAutoParameters['scale'] | undefined,
    midiChannel: named['midi-channel'],
    mixPercent: typeof named.mix === 'number' ? named.mix * 100 : defaults.mixPercent,
  });
});

function updateNamed(key: string, event: Event) {
  if (typeof target.value !== 'number') return;
  const raw = (event.target as HTMLInputElement).value;
  if (!raw.trim()) return;
  setNamedParameters(target.value, activeSlotIndex.value, { [key]: Number(raw) });
}

function updateOscVocParameters(parameters: OscVocParameters) {
  if (typeof target.value !== 'number') return;
  setNamedParameters(target.value, activeSlotIndex.value, {
    waveform: parameters.waveform,
    'midi-channel': parameters.midiChannel,
    octave: parameters.octaveSemitones,
    mix: parameters.mixPercent / 100,
  });
}

function updateHrmAutoParameters(parameters: HrmAutoParameters) {
  if (typeof target.value !== 'number') return;
  setNamedParameters(target.value, activeSlotIndex.value, {
    key: parameters.key,
    scale: parameters.scale,
    'midi-channel': parameters.midiChannel,
    mix: parameters.mixPercent / 100,
  });
}
</script>

<style scoped>
.browser-track-chain, .chain-context, .chain-field, .named-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.browser-track-chain { gap: 12px; }
.chain-context { font-size: 13px; line-height: 1.45; }
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
.chain-slots small { display: block; font-size: 11px; margin-top: 3px; }
.chain-field { font-size: 13px; }
.chain-field :is(input, select) { font-size: 14px; }
.chain-slots button, .activation { font-size: 13px; }
.chain-field input, .chain-field select { width: 100%; box-sizing: border-box; }
.named-controls { border-top: 1px solid #50434c; padding-top: 10px; }
.named-controls summary { cursor: pointer; font-size: 12px; }
.named-controls p { font-size: 12px; line-height: 1.45; }
.named-controls .chain-field { margin-top: 10px; }
.chain-error { color: #ff9198; }
.chain-warning { color: #ffd27a; }
.chain-status { font-size: 12px; line-height: 1.45; margin: 0; }
button:disabled, input:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
