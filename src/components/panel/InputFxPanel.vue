<template>
  <section class="panel-shell input-panel" data-panel="input-fx">
    <div class="panel-header">
      <div>
        <h2>INPUT FX</h2>
        <p class="eyebrow">EDIT / FX BANK</p>
      </div>
      <div class="edit-stack">
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          :active="editMode"
          label="EDIT"
          aria-label="Toggle input FX edit mode"
          @press="editMode = !editMode"
        />
        <div class="edit-lamp" :class="{ active: editMode }"></div>
      </div>
    </div>

    <div class="fx-main">
      <HardwareKnob
        :model-value="activeFx?.value ?? 0"
        label="INPUT FX"
        color="blue"
        :size="118"
        @update:model-value="updateActiveValue"
      />

      <div class="fx-detail">
        <div class="detail-chip">BANK {{ activeFx?.id ?? 'A' }}</div>
        <select v-if="activeFx" v-model="activeFx.type" class="fx-select" :disabled="fxDisabled">
          <option v-if="activeFx.type && !fxOptions.includes(activeFx.type)" :value="activeFx.type" disabled>
            UNAVAILABLE: {{ activeFx.type }}
          </option>
          <option v-for="option in fxOptions" :key="option" :value="option">{{ option }}</option>
        </select>
        <div class="detail-line">ACTIVE {{ activeFx?.active ? 'ON' : 'OFF' }}</div>
        <div class="detail-line">PARAM {{ Math.round(activeFx?.value ?? 0) }}</div>
        <div v-if="fxUnavailableReason" class="detail-note">{{ fxUnavailableReason }}</div>
        <div v-if="nativeFxRuntimeText" class="detail-note" data-native-fx-status>{{ nativeFxRuntimeText }}</div>
      </div>
    </div>

    <NativeStepSlicerEditor
      v-if="runtimeStatus && activeFx?.type === 'STEP SLICER'"
      :model-value="activeFx.stepSlicerParameters"
      @update:model-value="updateStepSlicerParameters"
    />

    <PreampFxEditor
      v-if="activeFx?.type === 'PREAMP'"
      :model-value="activeFx.preampParameters"
      @update:model-value="updatePreampParameters"
    />

    <SynthFxEditor
      v-if="activeFx?.type === 'SYNTH'"
      :model-value="activeFx.synthParameters"
      @update:model-value="updateSynthParameters"
    />

    <G2bFxEditor
      v-if="activeFx?.type === 'G2B'"
      :model-value="activeFx.g2bParameters"
      @update:model-value="updateG2bParameters"
    />

    <RollFxEditor
      v-if="activeFx?.type === 'ROLL'"
      :model-value="activeFx.rollParameters"
      @update:model-value="updateRollParameters"
    />

    <FreezeFxEditor
      v-if="activeFx?.type === 'FREEZE'"
      :model-value="activeFx.freezeParameters"
      @update:model-value="updateFreezeParameters"
    />

    <PitchBendFxEditor
      v-if="activeFx?.type === 'PITCH BEND'"
      :model-value="activeFx.pitchBendParameters"
      @update:model-value="updatePitchBendParameters"
    />

    <ManualHarmonistFxEditor
      v-if="activeFx?.type === 'HRM MANUAL'"
      :model-value="activeFx.manualHarmonistParameters"
      @update:model-value="updateManualHarmonistParameters"
    />

    <OctaveFxEditor
      v-if="activeFx?.type === 'OCTAVE'"
      :model-value="activeFx.octaveParameters"
      @update:model-value="updateOctaveParameters"
    />

    <VocoderFxEditor
      v-if="activeFx?.type === 'VOCODER'"
      :model-value="activeFx.vocoderParameters"
      @update:model-value="updateVocoderParameters"
    />

    <OscVocFxEditor
      v-if="activeFx?.type === 'OSC VOC (M)'"
      :model-value="activeFx.oscVocParameters ?? createDefaultOscVocParameters()"
      :midi-target="{ path: 'input', slot: activeFx?.id ?? 'A' }"
      @update:model-value="updateOscVocParameters"
    />

    <AutoRiffFxEditor
      v-if="activeFx?.type === 'AUTO RIFF' || activeFx?.type === 'AUTO RIFF (EXPERIMENTAL)'"
      :model-value="activeFx.autoRiffParameters"
      @update:model-value="updateAutoRiffParameters"
    />

    <RobotFxEditor
      v-if="activeFx?.type === 'ROBOT' || activeFx?.type === 'ROBOT (EXPERIMENTAL)'"
      :model-value="activeFx.robotParameters"
      @update:model-value="updateRobotParameters"
    />

    <ElectricFxEditor
      v-if="activeFx?.type === 'ELECTRIC'"
      :model-value="activeFx.electricParameters"
      @update:model-value="updateElectricParameters"
    />

    <HrmAutoFxEditor
      v-if="activeFx?.type === 'HRM AUTO (M)' || activeFx?.type === 'HRM AUTO (M) (EXPERIMENTAL)'"
      :model-value="activeFx.hrmAutoParameters"
      :midi-target="{ path: 'input', slot: activeFx?.id ?? 'A', effectId: 'hrm_auto_m' }"
      @update:model-value="updateHrmAutoParameters"
    />

    <BrowserCatalogParametersEditor
      v-if="inputNamedControls.length"
      :key="`browser-input-${activeSlot}-${activeFx?.type}`"
      :title="`Input FX slot ${activeSlot}`"
      :controls="inputNamedControls"
      :model-value="activeInputNamedParameters"
      :disabled="fxDisabled"
      reset-label="Reset Input FX named controls"
      data-input-named-controls
      @change="updateInputNamedParameter"
      @reset="resetInputNamedControls"
    />

    <NativeCatalogParametersEditor
      v-if="nativeSchema && nativeSchema.parameters.length"
      :key="`native-input-${activeSlot}-${activeFx?.type}`"
      :title="`INPUT ${activeSlot} · ${activeFx?.type ?? ''}`"
      :schema="nativeSchema"
      :model-value="activeInputNamedParameters"
      :macro-parameters="nativeMacroParameters"
      :runtime="runtimeStatus"
      :pending-submission="nativeNamedParametersPending"
      :disabled="fxDisabled || nativeNamedParametersPending || Boolean(runtimeStatus?.pendingApply || runtimeStatus?.outcomeUnknown)"
      @apply="applyNativeNamedParameters"
    />
    <p v-else-if="nativeMode && activeFx?.type && activeFx.type !== 'NONE' && !dedicatedInputEditorTypes.has(activeFx.type) && !nativeSchema" class="detail-note" data-native-parameter-schema-unavailable>
      Named controls unavailable: this Native host does not advertise a valid descriptor schema
    </p>
    <p v-if="nativeParameterError" class="detail-note" role="alert">{{ nativeParameterError }}</p>

    <div class="slot-row">
      <HardwareButton
        v-for="slot in slots"
        :key="slot.id"
        shape="circle"
        size="md"
        :label="slot.id"
        :color="activeSlot === slot.id ? 'blue' : slot.active ? 'red' : 'neutral'"
        :active="activeSlot === slot.id || slot.active"
        :aria-label="`Select input FX slot ${slot.id}`"
        @press="handleSlotPress(slot.id)"
      />
    </div>

    <div class="slot-toggle" v-if="activeFx">
      <HardwareButton
        shape="rect"
        size="md"
        :label="activeFx.active ? 'BYPASS' : 'ACTIVATE'"
        :color="activeFx.active ? 'red' : 'white'"
        :active="activeFx.active"
        :aria-label="`Toggle input FX slot ${activeFx.id}`"
        @press="activeFx.active = !activeFx.active"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { mergeOfficialParameterEdit } from '../../audio/fx/official/parameters';
import { computed, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import { nativeCatalogMacroParameters } from '../../audio/nativeFxCatalog';
import { getBrowserInputFxControls, getBrowserTrackFxMacroKeys, sanitizeBrowserTrackFxParameters } from '../../composables/browserTrackFxParameters';
import { createDefaultNativeStepSlicerParameters, type NativeStepSlicerParameters } from '../../audio/nativeStepSlicerParameters';
import { useFxPanelState } from '../../composables/useFxPanelState';
import type { FxSlotId } from '../../composables/usePanelFocus';
import { createDefaultPreampParameters, sanitizePreampParameters, type PreampParameters } from '../../audio/preampParameters';
import { createDefaultSynthParameters, sanitizeSynthParameters, type SynthParameters } from '../../audio/synthParameters';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';
import NativeStepSlicerEditor from '../fx/NativeStepSlicerEditor.vue';
import NativeCatalogParametersEditor from '../fx/NativeCatalogParametersEditor.vue';
import BrowserCatalogParametersEditor from '../fx/BrowserCatalogParametersEditor.vue';
import PreampFxEditor from '../fx/PreampFxEditor.vue';
import SynthFxEditor from '../fx/SynthFxEditor.vue';
import G2bFxEditor from '../fx/G2bFxEditor.vue';
import { createDefaultG2bParameters, sanitizeG2bParameters, toCatalogG2bParameters, type G2bParameters } from '../../audio/g2bParameters';
import RollFxEditor from '../fx/RollFxEditor.vue';
import { createDefaultRollParameters, sanitizeRollParameters, toCatalogRollParameters, type RollParameters } from '../../audio/rollParameters';
import FreezeFxEditor from '../fx/FreezeFxEditor.vue';
import PitchBendFxEditor from '../fx/PitchBendFxEditor.vue';
import { createDefaultPitchBendParameters, sanitizePitchBendParameters, toCatalogPitchBendParameters, type PitchBendParameters } from '../../audio/pitchBendParameters';
import ManualHarmonistFxEditor from '../fx/ManualHarmonistFxEditor.vue';
import { createDefaultManualHarmonistParameters, sanitizeManualHarmonistParameters, toCatalogManualHarmonistParameters, type ManualHarmonistParameters } from '../../audio/manualHarmonistParameters';
import OctaveFxEditor from '../fx/OctaveFxEditor.vue';
import { createDefaultOctaveParameters, sanitizeOctaveParameters, toCatalogOctaveParameters, type OctaveParameters } from '../../audio/octaveParameters';
import VocoderFxEditor from '../fx/VocoderFxEditor.vue';
import { createDefaultVocoderParameters, sanitizeVocoderParameters, toCatalogVocoderParameters, type VocoderParameters } from '../../audio/vocoderParameters';
import { createDefaultOscVocParameters, sanitizeOscVocParameters, toCatalogOscVocParameters, type OscVocParameters } from '../../audio/oscVocParameters';
import OscVocFxEditor from '../fx/OscVocFxEditor.vue';
import { sanitizeFreezeParameters, toCatalogFreezeParameters, type FreezeParameters } from '../../audio/freezeParameters';
import AutoRiffFxEditor from '../fx/AutoRiffFxEditor.vue';
import { createDefaultAutoRiffParameters, sanitizeAutoRiffParameters, toCatalogAutoRiffParameters, type AutoRiffParameters } from '../../audio/autoRiffParameters';
import RobotFxEditor from '../fx/RobotFxEditor.vue';
import { createDefaultRobotFxParameters, sanitizeRobotFxParameters, toCatalogRobotParameters, type RobotFxParameters } from '../../audio/robotFxParameters';
import HrmAutoFxEditor from '../fx/HrmAutoFxEditor.vue';
import { createDefaultHrmAutoParameters, sanitizeHrmAutoParameters, toCatalogHrmAutoParameters, type HrmAutoParameters } from '../../audio/hrmAutoParameters';
import ElectricFxEditor from '../fx/ElectricFxEditor.vue';
import { createDefaultElectricParameters, sanitizeElectricParameters, toBrowserElectricParameters, toNativeElectricParameters, type ElectricParameters } from '../../audio/electricParameters';

const { slots, fxOptions, fxDisabled, fxUnavailableReason, runtimeStatus, activeSlot, selectSlot,
  setNativeNamedParameters, nativeNamedParametersPending } = useFxPanelState('input');
const editMode = ref(false);

const activeFx = computed(() => slots.value.find((slot) => slot.id === activeSlot.value) ?? slots.value[0]);
const activeSlotIndex = computed(() => slots.value.findIndex((slot) => slot.id === activeFx.value?.id));
const nativeMode = computed(() => {
  runtimeStatus.value;
  return AudioEngine.getInstance().getMode() === 'native';
});
const nativeSchema = computed(() => nativeMode.value && activeFx.value?.type
  ? AudioEngine.getInstance().getNativeCatalogFxParameterSchema(
    activeFx.value.type, 'input', 0, activeFx.value.namedParametersByType?.[activeFx.value.type] ?? {}, activeSlotIndex.value)
  : null);
const nativeMacroParameters = computed(() => activeFx.value
  ? nativeCatalogMacroParameters(activeFx.value.type, activeFx.value.value)
  : {});
const nativeParameterError = ref('');
watch([activeSlot, () => activeFx.value?.type], () => { nativeParameterError.value = ''; });
function applyNativeNamedParameters(parameters: Record<string, number>) {
  nativeParameterError.value = setNativeNamedParameters(activeSlotIndex.value, parameters)
    ? '' : 'Native did not accept the named controls; check the schema and current slot status.';
}
const nativeFxRuntimeText = computed(() => {
  const status = runtimeStatus.value;
  if (!status) return '';
  if (status.pendingRestart) return `SAVED; SETTINGS > RESTART NATIVE / APPLY FX TO APPLY ${activeFx.value?.type || 'EMPTY SLOT'}`;
  if (status.error) return `NATIVE FX NOT APPLIED: ${status.error}`;
  return status.acknowledged
    ? `NATIVE API ACK: ${status.acknowledgedEffectId ?? 'EMPTY SLOT'}; ${Object.keys(status.acknowledgedParameters ?? {}).length} PARAMETER(S) ACCEPTED`
    : 'NATIVE FX WAITING FOR API ACK';
});
const dedicatedInputEditorTypes = new Set([
  'PREAMP', 'SYNTH', 'G2B', 'ROLL', 'FREEZE', 'PITCH BEND', 'HRM MANUAL',
  'OCTAVE', 'VOCODER', 'OSC VOC (M)', 'AUTO RIFF', 'AUTO RIFF (EXPERIMENTAL)',
  'ROBOT', 'ROBOT (EXPERIMENTAL)', 'HRM AUTO (M)', 'HRM AUTO (M) (EXPERIMENTAL)',
  'ELECTRIC', 'STEP SLICER',
]);
const inputNamedControls = computed(() => {
  const slot = activeFx.value;
  if (!slot || fxDisabled.value || AudioEngine.getInstance().getMode() !== 'browser') return [];
  return getBrowserInputFxControls(slot.type, slot.namedParametersByType?.[slot.type] ?? {}, activeSlotIndex.value)
    .filter((control) => !dedicatedInputEditorTypes.has(slot.type) || control.provenance !== 'extension');
});
const activeInputNamedParameters = computed(() => {
  const slot = activeFx.value;
  return slot?.namedParametersByType?.[slot.type] ?? {};
});

const handleSlotPress = (slotId: FxSlotId) => {
  selectSlot(slotId);
};

const updateActiveValue = (value: number) => {
  if (!activeFx.value) return;
  const slot = activeFx.value;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  slot.value = bounded;
  // The amount macro regains control of any explicitly named parameter it
  // drives, following the same precedence rule as the private Track bank.
  if (AudioEngine.getInstance().getMode() === 'browser' && slot.type) {
    const macroKeys = new Set(getBrowserTrackFxMacroKeys(slot.type));
    const existing = slot.namedParametersByType?.[slot.type];
    if (existing && Object.keys(existing).some((key) => macroKeys.has(key))) {
      const remaining = Object.fromEntries(Object.entries(existing).filter(([key]) => !macroKeys.has(key)));
      const next = { ...(slot.namedParametersByType ?? {}) };
      if (Object.keys(remaining).length) next[slot.type] = remaining;
      else delete next[slot.type];
      slot.namedParametersByType = Object.keys(next).length ? next : undefined;
    }
  }
  if (activeFx.value.type === 'PREAMP') {
    const current = sanitizePreampParameters(activeFx.value.preampParameters ?? createDefaultPreampParameters());
    updatePreampParameters({ ...current, gainPercent: bounded });
  }
  if (activeFx.value.type === 'SYNTH') {
    const current = sanitizeSynthParameters(activeFx.value.synthParameters ?? createDefaultSynthParameters());
    updateSynthParameters({ ...current, mix: bounded });
  }
  if (activeFx.value.type === 'G2B') {
    const current = sanitizeG2bParameters(activeFx.value.g2bParameters ?? createDefaultG2bParameters());
    updateG2bParameters({ ...current, blend: bounded });
  }
  if (activeFx.value.type === 'ROLL') {
    const current = sanitizeRollParameters(activeFx.value.rollParameters ?? createDefaultRollParameters());
    updateRollParameters(current);
  }
  if (activeFx.value.type === 'PITCH BEND') {
    const current = sanitizePitchBendParameters(activeFx.value.pitchBendParameters ?? createDefaultPitchBendParameters());
    updatePitchBendParameters({ ...current, rangeSemitones: (bounded / 100) * 24 });
  }
  if (activeFx.value.type === 'HRM MANUAL') {
    const current = sanitizeManualHarmonistParameters(activeFx.value.manualHarmonistParameters ?? createDefaultManualHarmonistParameters());
    updateManualHarmonistParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'OCTAVE') {
    const current = sanitizeOctaveParameters(activeFx.value.octaveParameters ?? createDefaultOctaveParameters());
    updateOctaveParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'VOCODER') {
    const current = sanitizeVocoderParameters(activeFx.value.vocoderParameters ?? createDefaultVocoderParameters());
    updateVocoderParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'OSC VOC (M)') {
    const current = sanitizeOscVocParameters(activeFx.value.oscVocParameters ?? createDefaultOscVocParameters());
    updateOscVocParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'AUTO RIFF' || activeFx.value.type === 'AUTO RIFF (EXPERIMENTAL)') {
    const current = sanitizeAutoRiffParameters(activeFx.value.autoRiffParameters ?? createDefaultAutoRiffParameters());
    updateAutoRiffParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'ROBOT' || activeFx.value.type === 'ROBOT (EXPERIMENTAL)') {
    const current = sanitizeRobotFxParameters(activeFx.value.robotParameters ?? createDefaultRobotFxParameters());
    updateRobotParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'HRM AUTO (M)' || activeFx.value.type === 'HRM AUTO (M) (EXPERIMENTAL)') {
    const current = sanitizeHrmAutoParameters(activeFx.value.hrmAutoParameters ?? createDefaultHrmAutoParameters());
    updateHrmAutoParameters({ ...current, mixPercent: bounded });
  }
  if (activeFx.value.type === 'ELECTRIC') {
    const current = sanitizeElectricParameters(activeFx.value.electricParameters ?? createDefaultElectricParameters());
    updateElectricParameters({ ...current, mixPercent: bounded });
  }
  if (runtimeStatus.value && activeFx.value.type === 'STEP SLICER') {
    const parameters = activeFx.value.stepSlicerParameters ?? createDefaultNativeStepSlicerParameters();
    updateStepSlicerParameters({ ...parameters, depth_percent: bounded });
  }
};

function updateInputNamedParameter(key: string, event: Event): void {
  const slot = activeFx.value;
  const control = inputNamedControls.value.find((candidate) => candidate.key === key);
  if (!slot || !control || !slot.type) return;
  const raw = (event.target as HTMLInputElement | HTMLSelectElement).value;
  if (!raw.trim()) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  const current = slot.namedParametersByType?.[slot.type] ?? {};
  const sanitized = sanitizeBrowserTrackFxParameters(slot.type, mergeOfficialParameterEdit(current, key, value));
  if (!Object.prototype.hasOwnProperty.call(sanitized, key)) return;
  slot.namedParametersByType = {
    ...(slot.namedParametersByType ?? {}),
    [slot.type]: sanitized,
  };
}

function resetInputNamedControls(): void {
  const slot = activeFx.value;
  if (!slot || !slot.type) return;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex < 0) return;
  const type = slot.type;
  const next = { ...(slot.namedParametersByType ?? {}) };
  delete next[type];
  slot.namedParametersByType = Object.keys(next).length ? next : undefined;
  const engine = AudioEngine.getInstance();
  // Recreate this Browser processor to clear its internal worklet parameter
  // overlay, then restore the macro, active state and all other effect presets.
  engine.setFxType('input', slotIndex, 'NONE');
  engine.setFxType('input', slotIndex, type);
  engine.setFxParam('input', slotIndex, slot.value);
  engine.setFxActive('input', slotIndex, slot.active);
}


const updatePreampParameters = (parameters: PreampParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.preampParameters = sanitizePreampParameters(parameters);
  slot.value = slot.preampParameters.gainPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setPreampParameters('input', slotIndex, slot.preampParameters);
};

const updateSynthParameters = (parameters: SynthParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.synthParameters = sanitizeSynthParameters(parameters);
  slot.value = slot.synthParameters.mix;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, { ...slot.synthParameters });
};

const updateG2bParameters = (parameters: G2bParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.g2bParameters = sanitizeG2bParameters(parameters);
  slot.value = slot.g2bParameters.blend;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogG2bParameters(slot.g2bParameters));
};

const updateRollParameters = (parameters: RollParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.rollParameters = sanitizeRollParameters(parameters);
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogRollParameters(slot.rollParameters));
};

const updateFreezeParameters = (parameters: FreezeParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.freezeParameters = sanitizeFreezeParameters(parameters);
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogFreezeParameters(slot.freezeParameters));
};

const updateStepSlicerParameters = (parameters: NativeStepSlicerParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.stepSlicerParameters = parameters;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setNativeStepSlicerParameters('input', slotIndex, parameters);
};

const updatePitchBendParameters = (parameters: PitchBendParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.pitchBendParameters = sanitizePitchBendParameters(parameters);
  slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogPitchBendParameters(slot.pitchBendParameters));
};

const updateManualHarmonistParameters = (parameters: ManualHarmonistParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.manualHarmonistParameters = sanitizeManualHarmonistParameters(parameters);
  slot.value = slot.manualHarmonistParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogManualHarmonistParameters(slot.manualHarmonistParameters));
};

const updateOctaveParameters = (parameters: OctaveParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.octaveParameters = sanitizeOctaveParameters(parameters);
  slot.value = slot.octaveParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogOctaveParameters(slot.octaveParameters));
};

const updateVocoderParameters = (parameters: VocoderParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.vocoderParameters = sanitizeVocoderParameters(parameters);
  slot.value = slot.vocoderParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogVocoderParameters(slot.vocoderParameters));
};

const updateOscVocParameters = (parameters: OscVocParameters) => {
  const slot = activeFx.value;
  if (!slot) return;
  slot.oscVocParameters = sanitizeOscVocParameters(parameters);
  slot.value = slot.oscVocParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogOscVocParameters(slot.oscVocParameters));
};

const updateAutoRiffParameters = (parameters: AutoRiffParameters) => {
  const slot = activeFx.value;
  if (!slot || (slot.type !== 'AUTO RIFF' && slot.type !== 'AUTO RIFF (EXPERIMENTAL)')) return;
  slot.autoRiffParameters = sanitizeAutoRiffParameters(parameters);
  slot.value = slot.autoRiffParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogAutoRiffParameters(slot.autoRiffParameters));
};

const updateRobotParameters = (parameters: RobotFxParameters) => {
  const slot = activeFx.value;
  if (!slot || (slot.type !== 'ROBOT' && slot.type !== 'ROBOT (EXPERIMENTAL)')) return;
  slot.robotParameters = sanitizeRobotFxParameters(parameters);
  slot.value = slot.robotParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0 && fxOptions.value.some((option) => option === 'ROBOT' || option === 'ROBOT (EXPERIMENTAL)')) {
    AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogRobotParameters(slot.robotParameters));
  }
};

const updateHrmAutoParameters = (parameters: HrmAutoParameters) => {
  const slot = activeFx.value;
  if (!slot || (slot.type !== 'HRM AUTO (M)' && slot.type !== 'HRM AUTO (M) (EXPERIMENTAL)')) return;
  slot.hrmAutoParameters = sanitizeHrmAutoParameters(parameters);
  slot.value = slot.hrmAutoParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex >= 0) AudioEngine.getInstance().setCatalogFxParameters('input', slotIndex, toCatalogHrmAutoParameters(slot.hrmAutoParameters));
};

const updateElectricParameters = (parameters: ElectricParameters) => {
  const slot = activeFx.value;
  if (!slot || slot.type !== 'ELECTRIC') return;
  slot.electricParameters = sanitizeElectricParameters(parameters);
  slot.value = slot.electricParameters.mixPercent;
  const slotIndex = slots.value.findIndex((candidate) => candidate.id === slot.id);
  if (slotIndex < 0) return;
  const engine = AudioEngine.getInstance();
  engine.setCatalogFxParameters('input', slotIndex, engine.getMode() === 'native'
    ? toNativeElectricParameters(slot.electricParameters)
    : toBrowserElectricParameters(slot.electricParameters));
};
function setLcdParameter(group: string, key: string, value: number): void {
  if (!activeFx.value || fxDisabled.value) throw new Error('The selected FX bank is unavailable.');
  if (!Number.isFinite(value)) throw new Error('FX parameter must be finite.');
  const handlers: Record<string, (parameters: never) => void> = {
    preampParameters: updatePreampParameters,
    synthParameters: updateSynthParameters,
    g2bParameters: updateG2bParameters,
    rollParameters: updateRollParameters,
    freezeParameters: updateFreezeParameters,
    stepSlicerParameters: updateStepSlicerParameters,
    pitchBendParameters: updatePitchBendParameters,
    manualHarmonistParameters: updateManualHarmonistParameters,
    octaveParameters: updateOctaveParameters,
    vocoderParameters: updateVocoderParameters,
    oscVocParameters: updateOscVocParameters,
    autoRiffParameters: updateAutoRiffParameters,
    robotParameters: updateRobotParameters,
    hrmAutoParameters: updateHrmAutoParameters,
    electricParameters: updateElectricParameters,
  };
  const handler = handlers[group];
  if (!handler) throw new Error('This FX parameter group is not exposed by the engine.');
  const slot = activeFx.value as unknown as Record<string, unknown>;
  const previous = slot[group];
  const parameters = typeof previous === 'object' && previous ? previous as Record<string, unknown> : {};
  const nextValue = typeof parameters[key] === 'boolean' || (group === 'freezeParameters' && key === 'frozen') ? value >= 50 : value;
  handler({ ...parameters, [key]: nextValue } as never);
}

defineExpose({ updateActiveValue, setLcdParameter });

</script>

<style scoped>
.panel-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 292px;
  padding: 12px 14px 12px 10px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
}

.panel-header,
.fx-main {
  display: flex;
  justify-content: space-between;
  gap: 14px;
}

.fx-main {
  align-items: center;
}

.panel-header h2,
.eyebrow,
.detail-chip,
.detail-line,
.detail-note {
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.panel-header h2 {
  margin: 4px 0 0;
  letter-spacing: 1.6px;
  color: #ff3f53;
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 1.8px;
  color: rgba(255, 255, 255, 0.66);
}

.edit-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.edit-lamp {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.7);
}

.edit-lamp.active {
  box-shadow: 0 0 12px rgba(255, 255, 255, 0.4);
}

.fx-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.detail-chip {
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  letter-spacing: 1px;
  font-size: 13px;
}

.detail-line,
.detail-note {
  font-size: 12px;
  letter-spacing: 1px;
}

.detail-note {
  color: #ff9198;
}

.fx-select {
  min-height: 38px;
  min-width: 136px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
  font: 14px/1.3 var(--font-hardware, system-ui, sans-serif);
}

.input-named-controls {
  display: grid;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.16);
}

.input-named-controls summary {
  cursor: pointer;
  font-family: var(--font-hardware);
  letter-spacing: 0.7px;
}

.input-named-controls p,
.input-named-hint {
  margin: 0;
  color: rgba(255, 255, 255, 0.66);
}

.input-named-control {
  display: grid;
  gap: 4px;
}

.input-named-control select,
.input-named-control input {
  width: 100%;
  min-height: 34px;
  color: #f3f3f5;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  padding: 4px 8px;
}

.reset-named-controls {
  min-height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 8px;
  padding: 4px 10px;
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
  cursor: pointer;
}

.slot-row {
  display: grid;
  grid-template-columns: repeat(4, 54px);
  justify-content: flex-start;
  gap: 8px;
  margin-top: auto;
}

.slot-row :deep(.button-label) { font-size: 13px; }
.panel-shell :deep(.editor-heading),
.panel-shell :deep(.editor-title) { font-size: 14px; }
.panel-shell :deep(label),
.panel-shell :deep(.control-row),
.panel-shell :deep(.midi-row) { font-size: 13px; }
.panel-shell :deep(p),
.panel-shell :deep(.hint),
.panel-shell :deep(.parameter-help),
.panel-shell :deep([class$="-note"]),
.panel-shell :deep(.robot-status) { font-size: 12px; line-height: 1.45; }
.panel-shell :deep(small) { font-size: 12px; }
.panel-shell :deep(select),
.panel-shell :deep(input[type="number"]),
.panel-shell :deep(textarea) { font-size: 14px; }

.slot-toggle {
  display: flex;
  justify-content: flex-start;
}
</style>
