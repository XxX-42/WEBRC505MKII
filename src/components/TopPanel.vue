<template>
  <div class="top-panel">
    <!-- LEFT: INPUT FX -->
    <div class="fx-section input-fx" data-panel="input-fx">
      <div class="section-label">INPUT FX</div>
      <div v-if="fxDisabled" class="section-note">{{ fxUnavailableReason }}</div>
      <div v-if="nativeStatusText(inputRuntimeStatus)" class="section-note" data-native-fx-status>{{ nativeStatusText(inputRuntimeStatus) }}</div>
      <div class="fx-row">
        <div
          v-for="slot in inputSlots"
          :key="slot.id"
          class="fx-slot-shell"
          :class="{ active: activeInputSlot === slot.id }"
          @pointerdown="selectInputSlot(slot.id)"
        >
          <FxUnit
            :label="slot.id"
            :options="inputFxOptions"
            v-model:selectedType="slot.type"
            :model-value="slot.value"
            @update:model-value="updateInputFxValue(slot.id, $event)"
            v-model:active="slot.active"
            :disabled="fxDisabled"
          />
        </div>
      </div>
      <StepSlicerEditor
        v-if="showInputStepSlicerEditor"
        bank="input"
        :slot-index="activeInputSlotIndex"
        :slot-id="activeInputSlot"
      />
      <PreampFxEditor
        v-if="showInputPreampEditor"
        :model-value="activeInputPreampParameters"
        @update:model-value="updateInputPreampParameters"
      />
      <SynthFxEditor
        v-if="showInputSynthEditor"
        :model-value="activeInputSynthParameters"
        @update:model-value="updateInputSynthParameters"
      />
      <G2bFxEditor
        v-if="showInputG2bEditor"
        :model-value="activeInputG2bParameters"
        @update:model-value="updateInputG2bParameters"
      />
      <RollFxEditor
        v-if="showInputRollEditor"
        :model-value="activeInputRollParameters"
        @update:model-value="updateInputRollParameters"
      />
      <FreezeFxEditor
        v-if="showInputFreezeEditor"
        :model-value="activeInputFreezeParameters"
        @update:model-value="updateInputFreezeParameters"
      />
      <PitchBendFxEditor
        v-if="showInputPitchBendEditor"
        :model-value="activeInputPitchBendParameters"
        @update:model-value="updateInputPitchBendParameters"
      />
      <ManualHarmonistFxEditor
        v-if="showInputHarmonistEditor"
        :model-value="activeInputHarmonistParameters"
        @update:model-value="updateInputHarmonistParameters"
      />
      <OctaveFxEditor
        v-if="showInputOctaveEditor"
        :model-value="activeInputOctaveParameters"
        @update:model-value="updateInputOctaveParameters"
      />
      <VocoderFxEditor
        v-if="showInputVocoderEditor"
        :model-value="activeInputVocoderParameters"
        @update:model-value="updateInputVocoderParameters"
      />
      <OscVocFxEditor
        v-if="showInputOscVocEditor"
        :model-value="activeInputOscVocParameters"
        :midi-target="{ path: 'input', slot: activeInputSlot }"
        @update:model-value="updateInputOscVocParameters"
      />
      <AutoRiffFxEditor
        v-if="showInputAutoRiffEditor"
        :model-value="activeInputAutoRiffParameters"
        @update:model-value="updateInputAutoRiffParameters"
      />
      <RobotFxEditor
        v-if="showInputRobotEditor"
        :model-value="activeInputRobotParameters"
        @update:model-value="updateInputRobotParameters"
      />
      <HrmAutoFxEditor
        v-if="showInputHrmAutoEditor"
        :model-value="activeInputHrmAutoParameters"
        :midi-target="{ path: 'input', slot: activeInputSlot, effectId: 'hrm_auto_m' }"
        @update:model-value="updateInputHrmAutoParameters"
      />
      <ElectricFxEditor
        v-if="showInputElectricEditor"
        :model-value="activeInputElectricParameters"
        @update:model-value="updateInputElectricParameters"
      />
      <BrowserCatalogParametersEditor
        v-if="inputNamedControls.length"
        :key="`browser-input-${activeInputSlot}-${activeInputFx?.type}`"
        :title="`Input FX slot ${activeInputSlot}`"
        :controls="inputNamedControls"
        :model-value="activeInputNamedParameters"
        :disabled="fxDisabled"
        data-input-named-controls
        @change="updateInputNamedParameter"
        @reset="resetInputNamedControls"
      />
      <NativeCatalogParametersEditor
        v-if="nativeInputSchema && nativeInputSchema.parameters.length"
        :key="`native-input-${activeInputSlot}-${activeInputFx?.type}`"
        :title="`INPUT ${activeInputSlot} · ${activeInputFx?.type ?? ''}`"
        :schema="nativeInputSchema"
        :model-value="activeInputNamedParameters"
        :macro-parameters="nativeInputMacroParameters"
        :runtime="inputRuntimeStatus"
        :pending-submission="inputNamedParametersPending"
        :disabled="fxDisabled || inputNamedParametersPending || Boolean(inputRuntimeStatus?.pendingApply || inputRuntimeStatus?.outcomeUnknown)"
        @apply="applyNativeInputNamedParameters"
      />
      <p v-else-if="nativeMode && activeInputFx?.type && !dedicatedNativeEditorTypes.has(activeInputFx.type) && !nativeInputSchema" class="section-note">
        Named controls unavailable: this Native host does not advertise a valid descriptor schema
      </p>
      <p v-if="nativeInputParameterError" class="section-note" role="alert">{{ nativeInputParameterError }}</p>
    </div>

    <!-- CENTER: TRANSPORT -->
    <div class="transport-section">
      <TransportControls />
      <RhythmControls />
    </div>

    <!-- RIGHT: TRACK FX -->
    <div class="fx-section track-fx" data-panel="track-fx">
      <div class="section-label">TRACK FX</div>
      <label v-if="browserMode" class="fx-target">
        FX TARGET
        <select aria-label="Track FX target" :value="browserTrackTarget" @change="changeBrowserTrackTarget">
          <option value="shared">Shared bank (post-mix)</option>
          <option v-for="trackId in 5" :key="trackId" :value="trackId">Track {{ trackId }} (independent)</option>
        </select>
      </label>
      <label v-if="nativeMode" class="fx-target">
        FX TARGET
        <select aria-label="Native Track FX target" :value="nativeTrackTarget" @change="changeNativeTrackTarget">
          <option value="shared">Shared bank (post-mix)</option>
          <option v-for="trackId in 5" :key="trackId" :value="trackId">Track {{ trackId }} (independent)</option>
        </select>
      </label>
      <div v-if="nativeMode && nativeTrackTarget !== 'shared'" class="independent-track-editor">
        <NativeTrackFxPanel />
      </div>
      <div v-else-if="browserMode && browserTrackTarget !== 'shared'" class="independent-track-editor">
        <BrowserTrackFxPanel />
      </div>
      <template v-else>
      <div v-if="browserMode || nativeMode" class="section-note">SHARED BANK · POST-MIX</div>
      <div v-if="trackFxDisabled" class="section-note">{{ trackFxUnavailableReason }}</div>
      <div v-if="nativeStatusText(trackRuntimeStatus)" class="section-note" data-native-fx-status>{{ nativeStatusText(trackRuntimeStatus) }}</div>
      <div class="fx-row">
        <div
          v-for="slot in trackSlots"
          :key="slot.id"
          class="fx-slot-shell"
          :class="{ active: activeTrackSlot === slot.id }"
          @pointerdown="selectTrackSlot(slot.id)"
        >
          <FxUnit
            :label="slot.id"
            :options="trackFxOptions"
            v-model:selectedType="slot.type"
            :model-value="slot.value"
            @update:model-value="updateTrackFxValue(slot.id, $event)"
            v-model:active="slot.active"
            :disabled="fxDisabled"
          />
        </div>
      </div>
      <StepSlicerEditor
        v-if="showTrackStepSlicerEditor"
        bank="track"
        :slot-index="activeTrackSlotIndex"
        :slot-id="activeTrackSlot"
      />
      <PreampFxEditor
        v-if="showTrackPreampEditor"
        :model-value="activeTrackPreampParameters"
        @update:model-value="updateTrackPreampParameters"
      />
      <SynthFxEditor
        v-if="showTrackSynthEditor"
        :model-value="activeTrackSynthParameters"
        @update:model-value="updateTrackSynthParameters"
      />
      <G2bFxEditor
        v-if="showTrackG2bEditor"
        :model-value="activeTrackG2bParameters"
        @update:model-value="updateTrackG2bParameters"
      />
      <RollFxEditor
        v-if="showTrackRollEditor"
        :model-value="activeTrackRollParameters"
        @update:model-value="updateTrackRollParameters"
      />
      <FreezeFxEditor
        v-if="showTrackFreezeEditor"
        :model-value="activeTrackFreezeParameters"
        @update:model-value="updateTrackFreezeParameters"
      />
      <PitchBendFxEditor
        v-if="showTrackPitchBendEditor"
        :model-value="activeTrackPitchBendParameters"
        @update:model-value="updateTrackPitchBendParameters"
      />
      <ManualHarmonistFxEditor
        v-if="showTrackHarmonistEditor"
        :model-value="activeTrackHarmonistParameters"
        @update:model-value="updateTrackHarmonistParameters"
      />
      <OctaveFxEditor
        v-if="showTrackOctaveEditor"
        :model-value="activeTrackOctaveParameters"
        @update:model-value="updateTrackOctaveParameters"
      />
      <VocoderFxEditor
        v-if="showTrackVocoderEditor"
        :model-value="activeTrackVocoderParameters"
        @update:model-value="updateTrackVocoderParameters"
      />
      <OscVocFxEditor
        v-if="showTrackOscVocEditor"
        :model-value="activeTrackOscVocParameters"
        :midi-target="{ path: 'track', slot: activeTrackSlot }"
        @update:model-value="updateTrackOscVocParameters"
      />
      <AutoRiffFxEditor
        v-if="showTrackAutoRiffEditor"
        :model-value="activeTrackAutoRiffParameters"
        @update:model-value="updateTrackAutoRiffParameters"
      />
      <RobotFxEditor
        v-if="showTrackRobotEditor"
        :model-value="activeTrackRobotParameters"
        @update:model-value="updateTrackRobotParameters"
      />
      <HrmAutoFxEditor
        v-if="showTrackHrmAutoEditor"
        :model-value="activeTrackHrmAutoParameters"
        :midi-target="{ path: 'track', slot: activeTrackSlot, effectId: 'hrm_auto_m' }"
        @update:model-value="updateTrackHrmAutoParameters"
      />
      <ElectricFxEditor
        v-if="showTrackElectricEditor"
        :model-value="activeTrackElectricParameters"
        @update:model-value="updateTrackElectricParameters"
      />
      <BrowserCatalogParametersEditor
        v-if="trackNamedControls.length"
        :key="`browser-track-${activeTrackSlot}-${activeTrackFx?.type}`"
        :title="`Track FX slot ${activeTrackSlot}`"
        :controls="trackNamedControls"
        :model-value="activeTrackNamedParameters"
        :disabled="trackFxDisabled"
        data-track-named-controls
        @change="updateTrackNamedParameter"
        @reset="resetTrackNamedControls"
      />
      </template>
      <NativeCatalogParametersEditor
        v-if="nativeTrackTarget === 'shared' && nativeTrackSchema && nativeTrackSchema.parameters.length"
        :key="`native-track-${activeTrackSlot}-${activeTrackFx?.type}`"
        :title="`SHARED TRACK ${activeTrackSlot} · ${activeTrackFx?.type ?? ''}`"
        :schema="nativeTrackSchema"
        :model-value="activeTrackNamedParameters"
        :macro-parameters="nativeTrackMacroParameters"
        :runtime="trackRuntimeStatus"
        :pending-submission="trackNamedParametersPending"
        :disabled="trackFxDisabled || trackNamedParametersPending || Boolean(trackRuntimeStatus?.pendingApply || trackRuntimeStatus?.outcomeUnknown)"
        @apply="applyNativeTrackNamedParameters"
      />
      <p v-else-if="nativeMode && nativeTrackTarget === 'shared' && activeTrackFx?.type && !dedicatedNativeEditorTypes.has(activeTrackFx.type) && !nativeTrackSchema" class="section-note">
        Named controls unavailable: this Native host does not advertise a valid descriptor schema
      </p>
      <p v-if="nativeTrackTarget === 'shared' && nativeTrackParameterError" class="section-note" role="alert">{{ nativeTrackParameterError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { mergeOfficialParameterEdit } from '../audio/fx/official/parameters';
import { computed, ref, watch } from 'vue';
import type { NativeCatalogFxSlotRuntime } from '../audio/NativeAudioEngine';
import { AudioEngine } from '../audio/AudioEngine';
import { nativeCatalogMacroParameters } from '../audio/nativeFxCatalog';
import FxUnit from './fx/FxUnit.vue';
import StepSlicerEditor from './fx/StepSlicerEditor.vue';
import PreampFxEditor from './fx/PreampFxEditor.vue';
import TransportControls from './TransportControls.vue';
import RhythmControls from './RhythmControls.vue';
import { useFxPanelState } from '../composables/useFxPanelState';
import { getBrowserInputFxControls, getBrowserTrackFxControls, getBrowserTrackFxMacroKeys, sanitizeBrowserTrackFxParameters, type BrowserTrackFxControl } from '../composables/browserTrackFxParameters';
import { useBrowserTrackFxState, type BrowserTrackFxTarget } from '../composables/useBrowserTrackFxState';
import { useNativeTrackFxState, type NativeTrackFxTarget } from '../composables/useNativeTrackFxState';
import BrowserTrackFxPanel from './panel/BrowserTrackFxPanel.vue';
import NativeTrackFxPanel from './panel/NativeTrackFxPanel.vue';
import NativeCatalogParametersEditor from './fx/NativeCatalogParametersEditor.vue';
import BrowserCatalogParametersEditor from './fx/BrowserCatalogParametersEditor.vue';
import { sanitizePreampParameters, type PreampParameters } from '../audio/preampParameters';
import { sanitizeSynthParameters, type SynthParameters } from '../audio/synthParameters';
import SynthFxEditor from './fx/SynthFxEditor.vue';
import { sanitizeG2bParameters, toCatalogG2bParameters, type G2bParameters } from '../audio/g2bParameters';
import G2bFxEditor from './fx/G2bFxEditor.vue';
import RollFxEditor from './fx/RollFxEditor.vue';
import { sanitizeRollParameters, toCatalogRollParameters, type RollParameters } from '../audio/rollParameters';
import FreezeFxEditor from './fx/FreezeFxEditor.vue';
import { sanitizeFreezeParameters, toCatalogFreezeParameters, type FreezeParameters } from '../audio/freezeParameters';
import PitchBendFxEditor from './fx/PitchBendFxEditor.vue';
import { createDefaultPitchBendParameters, sanitizePitchBendParameters, toCatalogPitchBendParameters, type PitchBendParameters } from '../audio/pitchBendParameters';
import ManualHarmonistFxEditor from './fx/ManualHarmonistFxEditor.vue';
import { createDefaultManualHarmonistParameters, sanitizeManualHarmonistParameters, toCatalogManualHarmonistParameters, type ManualHarmonistParameters } from '../audio/manualHarmonistParameters';
import OctaveFxEditor from './fx/OctaveFxEditor.vue';
import { createDefaultOctaveParameters, sanitizeOctaveParameters, toCatalogOctaveParameters, type OctaveParameters } from '../audio/octaveParameters';
import VocoderFxEditor from './fx/VocoderFxEditor.vue';
import { createDefaultVocoderParameters, sanitizeVocoderParameters, toCatalogVocoderParameters, type VocoderParameters } from '../audio/vocoderParameters';
import { createDefaultOscVocParameters, sanitizeOscVocParameters, toCatalogOscVocParameters, type OscVocParameters } from '../audio/oscVocParameters';
import OscVocFxEditor from './fx/OscVocFxEditor.vue';
import AutoRiffFxEditor from './fx/AutoRiffFxEditor.vue';
import { sanitizeAutoRiffParameters, toCatalogAutoRiffParameters, type AutoRiffParameters } from '../audio/autoRiffParameters';
import RobotFxEditor from './fx/RobotFxEditor.vue';
import { sanitizeRobotFxParameters, toCatalogRobotParameters, type RobotFxParameters } from '../audio/robotFxParameters';
import HrmAutoFxEditor from './fx/HrmAutoFxEditor.vue';
import { createDefaultHrmAutoParameters, sanitizeHrmAutoParameters, toCatalogHrmAutoParameters, type HrmAutoParameters } from '../audio/hrmAutoParameters';
import ElectricFxEditor from './fx/ElectricFxEditor.vue';
import { createDefaultElectricParameters, sanitizeElectricParameters, toBrowserElectricParameters, toNativeElectricParameters, type ElectricParameters } from '../audio/electricParameters';

const {
  slots: inputSlots,
  fxOptions: inputFxOptions,
  fxDisabled,
  fxUnavailableReason,
  runtimeStatus: inputRuntimeStatus,
  activeSlot: activeInputSlot,
  selectSlot: selectInputSlot,
  setNativeNamedParameters: setInputNativeNamedParameters,
  nativeNamedParametersPending: inputNamedParametersPending,
} = useFxPanelState('input');

const {
  slots: trackSlots,
  fxOptions: trackFxOptions,
  fxDisabled: trackFxDisabled,
  fxUnavailableReason: trackFxUnavailableReason,
  runtimeStatus: trackRuntimeStatus,
  activeSlot: activeTrackSlot,
  selectSlot: selectTrackSlot,
  setNativeNamedParameters: setTrackNativeNamedParameters,
  nativeNamedParametersPending: trackNamedParametersPending,
} = useFxPanelState('track');
const audio = AudioEngine.getInstance();
const { target: browserTrackTarget, selectTarget: selectBrowserTrackTarget } = useBrowserTrackFxState();
const { target: nativeTrackTarget, selectTarget: selectNativeTrackTarget } = useNativeTrackFxState();
const browserMode = computed(() => {
  trackRuntimeStatus.value;
  return audio.getMode() === 'browser';
});
const nativeMode = computed(() => !browserMode.value);
function changeBrowserTrackTarget(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  selectBrowserTrackTarget(value === 'shared' ? 'shared' : Number(value) as BrowserTrackFxTarget);
}
function changeNativeTrackTarget(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  selectNativeTrackTarget(value === 'shared' ? 'shared' : Number(value) as NativeTrackFxTarget);
}
const activeInputSlotIndex = computed(() => inputSlots.value.findIndex((slot) => slot.id === activeInputSlot.value));
const activeTrackSlotIndex = computed(() => trackSlots.value.findIndex((slot) => slot.id === activeTrackSlot.value));
const activeInputFx = computed(() => inputSlots.value[activeInputSlotIndex.value] ?? null);
const activeTrackFx = computed(() => trackSlots.value[activeTrackSlotIndex.value] ?? null);
const dedicatedInputEditorTypes = new Set([
  'PREAMP', 'SYNTH', 'G2B', 'ROLL', 'FREEZE', 'PITCH BEND', 'HRM MANUAL',
  'OCTAVE', 'VOCODER', 'OSC VOC (M)', 'AUTO RIFF', 'AUTO RIFF (EXPERIMENTAL)',
  'ROBOT', 'ROBOT (EXPERIMENTAL)', 'HRM AUTO (M)', 'HRM AUTO (M) (EXPERIMENTAL)',
  'ELECTRIC', 'STEP SLICER',
]);
const dedicatedNativeEditorTypes = dedicatedInputEditorTypes;
const nativeInputSchema = computed(() => nativeMode.value && activeInputFx.value?.type
  ? audio.getNativeCatalogFxParameterSchema(activeInputFx.value.type, 'input', 0, activeInputFx.value.namedParametersByType?.[activeInputFx.value.type] ?? {}, activeInputSlotIndex.value)
  : null);
const nativeTrackSchema = computed(() => nativeMode.value && activeTrackFx.value?.type
  ? audio.getNativeCatalogFxParameterSchema(activeTrackFx.value.type, 'track', 0, activeTrackFx.value.namedParametersByType?.[activeTrackFx.value.type] ?? {}, activeTrackSlotIndex.value)
  : null);
const activeTrackNamedParameters = computed(() => activeTrackFx.value?.namedParametersByType?.[activeTrackFx.value.type] ?? {});
const nativeInputMacroParameters = computed(() => activeInputFx.value
  ? nativeCatalogMacroParameters(activeInputFx.value.type, activeInputFx.value.value)
  : {});
const nativeTrackMacroParameters = computed(() => activeTrackFx.value
  ? nativeCatalogMacroParameters(activeTrackFx.value.type, activeTrackFx.value.value)
  : {});
const nativeInputParameterError = ref('');
const nativeTrackParameterError = ref('');
watch([activeInputSlot, () => activeInputFx.value?.type], () => { nativeInputParameterError.value = ''; });
watch([activeTrackSlot, () => activeTrackFx.value?.type], () => { nativeTrackParameterError.value = ''; });
function applyNativeInputNamedParameters(parameters: Record<string, number>) {
  nativeInputParameterError.value = setInputNativeNamedParameters(activeInputSlotIndex.value, parameters)
    ? '' : 'Native did not accept the named controls; check the schema and current slot status.';
}
function applyNativeTrackNamedParameters(parameters: Record<string, number>) {
  nativeTrackParameterError.value = setTrackNativeNamedParameters(activeTrackSlotIndex.value, parameters)
    ? '' : 'Native did not accept the named controls; check the schema and current slot status.';
}
const inputNamedControls = computed((): BrowserTrackFxControl[] => {
  const slot = activeInputFx.value;
  if (!slot || audio.getMode() !== 'browser' || fxDisabled.value) return [];
  return getBrowserInputFxControls(slot.type, slot.namedParametersByType?.[slot.type] ?? {}, activeInputSlotIndex.value)
    .filter((control) => !dedicatedInputEditorTypes.has(slot.type) || control.provenance !== 'extension');
});
const trackNamedControls = computed((): BrowserTrackFxControl[] => {
  const slot = activeTrackFx.value;
  if (!slot || !browserMode.value || browserTrackTarget.value !== 'shared' || trackFxDisabled.value) return [];
  return getBrowserTrackFxControls(slot.type, activeTrackNamedParameters.value, activeTrackSlotIndex.value, 'shared')
    .filter((control) => !dedicatedInputEditorTypes.has(slot.type) || control.provenance !== 'extension');
});
const activeInputNamedParameters = computed(() => activeInputFx.value?.namedParametersByType?.[activeInputFx.value.type] ?? {});
const showInputStepSlicerEditor = computed(() => audio.getMode() === 'browser'
  && inputSlots.value[activeInputSlotIndex.value]?.type === 'STEP SLICER');
const showTrackStepSlicerEditor = computed(() => audio.getMode() === 'browser'
  && trackSlots.value[activeTrackSlotIndex.value]?.type === 'STEP SLICER');
const showInputPreampEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'PREAMP');
const showTrackPreampEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'PREAMP');
const showInputSynthEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'SYNTH');
const showTrackSynthEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'SYNTH');
const showInputG2bEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'G2B');
const showTrackG2bEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'G2B');
const showInputRollEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'ROLL');
const showTrackRollEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'ROLL');
const showInputFreezeEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'FREEZE');
const showTrackFreezeEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'FREEZE');
const showInputPitchBendEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'PITCH BEND');
const showTrackPitchBendEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'PITCH BEND');
const showInputHarmonistEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'HRM MANUAL');
const showTrackHarmonistEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'HRM MANUAL');
const showInputOctaveEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'OCTAVE');
const showTrackOctaveEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'OCTAVE');
const showInputVocoderEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'VOCODER');
const showTrackVocoderEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'VOCODER');
const showInputOscVocEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'OSC VOC (M)');
const showTrackOscVocEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'OSC VOC (M)');
const showInputAutoRiffEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'AUTO RIFF (EXPERIMENTAL)'
  || inputSlots.value[activeInputSlotIndex.value]?.type === 'AUTO RIFF');
const showTrackAutoRiffEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'AUTO RIFF (EXPERIMENTAL)'
  || trackSlots.value[activeTrackSlotIndex.value]?.type === 'AUTO RIFF');
const showInputRobotEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'ROBOT (EXPERIMENTAL)'
  || inputSlots.value[activeInputSlotIndex.value]?.type === 'ROBOT');
const showTrackRobotEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'ROBOT (EXPERIMENTAL)'
  || trackSlots.value[activeTrackSlotIndex.value]?.type === 'ROBOT');
const showInputHrmAutoEditor = computed(() => ['HRM AUTO (M)', 'HRM AUTO (M) (EXPERIMENTAL)'].includes(inputSlots.value[activeInputSlotIndex.value]?.type ?? ''));
const showTrackHrmAutoEditor = computed(() => ['HRM AUTO (M)', 'HRM AUTO (M) (EXPERIMENTAL)'].includes(trackSlots.value[activeTrackSlotIndex.value]?.type ?? ''));
const showInputElectricEditor = computed(() => inputSlots.value[activeInputSlotIndex.value]?.type === 'ELECTRIC');
const showTrackElectricEditor = computed(() => trackSlots.value[activeTrackSlotIndex.value]?.type === 'ELECTRIC');
const activeInputPreampParameters = computed(() => showInputPreampEditor.value
  ? sanitizePreampParameters(inputSlots.value[activeInputSlotIndex.value]?.preampParameters)
  : undefined);
const activeTrackPreampParameters = computed(() => showTrackPreampEditor.value
  ? sanitizePreampParameters(trackSlots.value[activeTrackSlotIndex.value]?.preampParameters)
  : undefined);
const activeInputSynthParameters = computed(() => showInputSynthEditor.value
  ? sanitizeSynthParameters(inputSlots.value[activeInputSlotIndex.value]?.synthParameters)
  : undefined);
const activeTrackSynthParameters = computed(() => showTrackSynthEditor.value
  ? sanitizeSynthParameters(trackSlots.value[activeTrackSlotIndex.value]?.synthParameters)
  : undefined);
const activeInputG2bParameters = computed(() => showInputG2bEditor.value
  ? sanitizeG2bParameters(inputSlots.value[activeInputSlotIndex.value]?.g2bParameters)
  : undefined);
const activeTrackG2bParameters = computed(() => showTrackG2bEditor.value
  ? sanitizeG2bParameters(trackSlots.value[activeTrackSlotIndex.value]?.g2bParameters)
  : undefined);
const activeInputRollParameters = computed(() => showInputRollEditor.value
  ? sanitizeRollParameters(inputSlots.value[activeInputSlotIndex.value]?.rollParameters)
  : undefined);
const activeTrackRollParameters = computed(() => showTrackRollEditor.value
  ? sanitizeRollParameters(trackSlots.value[activeTrackSlotIndex.value]?.rollParameters)
  : undefined);
const activeInputFreezeParameters = computed(() => showInputFreezeEditor.value
  ? sanitizeFreezeParameters(inputSlots.value[activeInputSlotIndex.value]?.freezeParameters)
  : undefined);
const activeTrackFreezeParameters = computed(() => showTrackFreezeEditor.value
  ? sanitizeFreezeParameters(trackSlots.value[activeTrackSlotIndex.value]?.freezeParameters)
  : undefined);
const activeInputPitchBendParameters = computed(() => showInputPitchBendEditor.value
  ? sanitizePitchBendParameters(inputSlots.value[activeInputSlotIndex.value]?.pitchBendParameters)
  : undefined);
const activeTrackPitchBendParameters = computed(() => showTrackPitchBendEditor.value
  ? sanitizePitchBendParameters(trackSlots.value[activeTrackSlotIndex.value]?.pitchBendParameters)
  : undefined);
const activeInputHarmonistParameters = computed(() => showInputHarmonistEditor.value
  ? sanitizeManualHarmonistParameters(inputSlots.value[activeInputSlotIndex.value]?.manualHarmonistParameters)
  : undefined);
const activeTrackHarmonistParameters = computed(() => showTrackHarmonistEditor.value
  ? sanitizeManualHarmonistParameters(trackSlots.value[activeTrackSlotIndex.value]?.manualHarmonistParameters)
  : undefined);
const activeInputOctaveParameters = computed(() => showInputOctaveEditor.value
  ? sanitizeOctaveParameters(inputSlots.value[activeInputSlotIndex.value]?.octaveParameters)
  : undefined);
const activeTrackOctaveParameters = computed(() => showTrackOctaveEditor.value
  ? sanitizeOctaveParameters(trackSlots.value[activeTrackSlotIndex.value]?.octaveParameters)
  : undefined);
const activeInputVocoderParameters = computed(() => showInputVocoderEditor.value
  ? sanitizeVocoderParameters(inputSlots.value[activeInputSlotIndex.value]?.vocoderParameters)
  : undefined);
const activeTrackVocoderParameters = computed(() => showTrackVocoderEditor.value
  ? sanitizeVocoderParameters(trackSlots.value[activeTrackSlotIndex.value]?.vocoderParameters)
  : undefined);
const activeInputOscVocParameters = computed(() => showInputOscVocEditor.value
  ? sanitizeOscVocParameters(inputSlots.value[activeInputSlotIndex.value]?.oscVocParameters)
  : createDefaultOscVocParameters());
const activeTrackOscVocParameters = computed(() => showTrackOscVocEditor.value
  ? sanitizeOscVocParameters(trackSlots.value[activeTrackSlotIndex.value]?.oscVocParameters)
  : createDefaultOscVocParameters());
const activeInputAutoRiffParameters = computed(() => showInputAutoRiffEditor.value
  ? sanitizeAutoRiffParameters(inputSlots.value[activeInputSlotIndex.value]?.autoRiffParameters)
  : undefined);
const activeTrackAutoRiffParameters = computed(() => showTrackAutoRiffEditor.value
  ? sanitizeAutoRiffParameters(trackSlots.value[activeTrackSlotIndex.value]?.autoRiffParameters)
  : undefined);
const activeInputRobotParameters = computed(() => showInputRobotEditor.value
  ? sanitizeRobotFxParameters(inputSlots.value[activeInputSlotIndex.value]?.robotParameters)
  : undefined);
const activeTrackRobotParameters = computed(() => showTrackRobotEditor.value
  ? sanitizeRobotFxParameters(trackSlots.value[activeTrackSlotIndex.value]?.robotParameters)
  : undefined);
const activeInputHrmAutoParameters = computed(() => showInputHrmAutoEditor.value
  ? sanitizeHrmAutoParameters(inputSlots.value[activeInputSlotIndex.value]?.hrmAutoParameters)
  : createDefaultHrmAutoParameters());
const activeTrackHrmAutoParameters = computed(() => showTrackHrmAutoEditor.value
  ? sanitizeHrmAutoParameters(trackSlots.value[activeTrackSlotIndex.value]?.hrmAutoParameters)
  : createDefaultHrmAutoParameters());
const activeInputElectricParameters = computed(() => showInputElectricEditor.value
  ? sanitizeElectricParameters(inputSlots.value[activeInputSlotIndex.value]?.electricParameters)
  : undefined);
const activeTrackElectricParameters = computed(() => showTrackElectricEditor.value
  ? sanitizeElectricParameters(trackSlots.value[activeTrackSlotIndex.value]?.electricParameters)
  : undefined);

function setPreampParameters(path: 'input' | 'track', slotIndex: number, parameters: PreampParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'PREAMP') return;
  slot.preampParameters = sanitizePreampParameters(parameters);
  slot.value = slot.preampParameters.gainPercent;
  audio.setPreampParameters(path, slotIndex, slot.preampParameters);
}

function updateInputPreampParameters(parameters: PreampParameters): void {
  setPreampParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackPreampParameters(parameters: PreampParameters): void {
  setPreampParameters('track', activeTrackSlotIndex.value, parameters);
}

function setSynthParameters(path: 'input' | 'track', slotIndex: number, parameters: SynthParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'SYNTH') return;
  slot.synthParameters = sanitizeSynthParameters(parameters);
  slot.value = slot.synthParameters.mix;
  audio.setCatalogFxParameters(path, slotIndex, { ...slot.synthParameters });
}

function updateInputSynthParameters(parameters: SynthParameters): void {
  setSynthParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackSynthParameters(parameters: SynthParameters): void {
  setSynthParameters('track', activeTrackSlotIndex.value, parameters);
}

function setG2bParameters(path: 'input' | 'track', slotIndex: number, parameters: G2bParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'G2B') return;
  slot.g2bParameters = sanitizeG2bParameters(parameters);
  slot.value = slot.g2bParameters.blend;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogG2bParameters(slot.g2bParameters));
}

function updateInputG2bParameters(parameters: G2bParameters): void {
  setG2bParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackG2bParameters(parameters: G2bParameters): void {
  setG2bParameters('track', activeTrackSlotIndex.value, parameters);
}

function setRollParameters(path: 'input' | 'track', slotIndex: number, parameters: RollParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'ROLL') return;
  slot.rollParameters = sanitizeRollParameters(parameters);
  audio.setCatalogFxParameters(path, slotIndex, toCatalogRollParameters(slot.rollParameters));
}

function updateInputRollParameters(parameters: RollParameters): void {
  setRollParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackRollParameters(parameters: RollParameters): void {
  setRollParameters('track', activeTrackSlotIndex.value, parameters);
}

function setFreezeParameters(path: 'input' | 'track', slotIndex: number, parameters: FreezeParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'FREEZE') return;
  slot.freezeParameters = sanitizeFreezeParameters(parameters);
  audio.setCatalogFxParameters(path, slotIndex, toCatalogFreezeParameters(slot.freezeParameters));
}

function updateInputFreezeParameters(parameters: FreezeParameters): void {
  setFreezeParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackFreezeParameters(parameters: FreezeParameters): void {
  setFreezeParameters('track', activeTrackSlotIndex.value, parameters);
}

function setPitchBendParameters(path: 'input' | 'track', slotIndex: number, parameters: PitchBendParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'PITCH BEND') return;
  slot.pitchBendParameters = sanitizePitchBendParameters(parameters);
  slot.value = (slot.pitchBendParameters.rangeSemitones / 24) * 100;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogPitchBendParameters(slot.pitchBendParameters));
}

function updateInputPitchBendParameters(parameters: PitchBendParameters): void {
  setPitchBendParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackPitchBendParameters(parameters: PitchBendParameters): void {
  setPitchBendParameters('track', activeTrackSlotIndex.value, parameters);
}

function setManualHarmonistParameters(path: 'input' | 'track', slotIndex: number, parameters: ManualHarmonistParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'HRM MANUAL') return;
  slot.manualHarmonistParameters = sanitizeManualHarmonistParameters(parameters);
  slot.value = slot.manualHarmonistParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogManualHarmonistParameters(slot.manualHarmonistParameters));
}

function updateInputHarmonistParameters(parameters: ManualHarmonistParameters): void {
  setManualHarmonistParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackHarmonistParameters(parameters: ManualHarmonistParameters): void {
  setManualHarmonistParameters('track', activeTrackSlotIndex.value, parameters);
}

function setOctaveParameters(path: 'input' | 'track', slotIndex: number, parameters: OctaveParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'OCTAVE') return;
  slot.octaveParameters = sanitizeOctaveParameters(parameters);
  slot.value = slot.octaveParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogOctaveParameters(slot.octaveParameters));
}

function updateInputOctaveParameters(parameters: OctaveParameters): void {
  setOctaveParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackOctaveParameters(parameters: OctaveParameters): void {
  setOctaveParameters('track', activeTrackSlotIndex.value, parameters);
}

function setVocoderParameters(path: 'input' | 'track', slotIndex: number, parameters: VocoderParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'VOCODER') return;
  slot.vocoderParameters = sanitizeVocoderParameters(parameters);
  slot.value = slot.vocoderParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogVocoderParameters(slot.vocoderParameters));
}

function updateInputVocoderParameters(parameters: VocoderParameters): void {
  setVocoderParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackVocoderParameters(parameters: VocoderParameters): void {
  setVocoderParameters('track', activeTrackSlotIndex.value, parameters);
}

function setOscVocParameters(path: 'input' | 'track', slotIndex: number, parameters: OscVocParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'OSC VOC (M)') return;
  slot.oscVocParameters = sanitizeOscVocParameters(parameters);
  slot.value = slot.oscVocParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogOscVocParameters(slot.oscVocParameters));
}

function updateInputOscVocParameters(parameters: OscVocParameters): void {
  setOscVocParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackOscVocParameters(parameters: OscVocParameters): void {
  setOscVocParameters('track', activeTrackSlotIndex.value, parameters);
}

function setAutoRiffParameters(path: 'input' | 'track', slotIndex: number, parameters: AutoRiffParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || (slot.type !== 'AUTO RIFF' && slot.type !== 'AUTO RIFF (EXPERIMENTAL)')) return;
  slot.autoRiffParameters = sanitizeAutoRiffParameters(parameters);
  slot.value = slot.autoRiffParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogAutoRiffParameters(slot.autoRiffParameters));
}

function updateInputAutoRiffParameters(parameters: AutoRiffParameters): void {
  setAutoRiffParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackAutoRiffParameters(parameters: AutoRiffParameters): void {
  setAutoRiffParameters('track', activeTrackSlotIndex.value, parameters);
}

function setRobotParameters(path: 'input' | 'track', slotIndex: number, parameters: RobotFxParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const options = path === 'input' ? inputFxOptions.value : trackFxOptions.value;
  const slot = slots[slotIndex];
  if (!slot || (slot.type !== 'ROBOT' && slot.type !== 'ROBOT (EXPERIMENTAL)')) return;
  slot.robotParameters = sanitizeRobotFxParameters(parameters);
  slot.value = slot.robotParameters.mixPercent;
  if (!options.some((option) => option === 'ROBOT' || option === 'ROBOT (EXPERIMENTAL)')) return;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogRobotParameters(slot.robotParameters));
}

function updateInputRobotParameters(parameters: RobotFxParameters): void {
  setRobotParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackRobotParameters(parameters: RobotFxParameters): void {
  setRobotParameters('track', activeTrackSlotIndex.value, parameters);
}

function setHrmAutoParameters(path: 'input' | 'track', slotIndex: number, parameters: HrmAutoParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || (slot.type !== 'HRM AUTO (M)' && slot.type !== 'HRM AUTO (M) (EXPERIMENTAL)')) return;
  slot.hrmAutoParameters = sanitizeHrmAutoParameters(parameters);
  slot.value = slot.hrmAutoParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, toCatalogHrmAutoParameters(slot.hrmAutoParameters));
}

function updateInputHrmAutoParameters(parameters: HrmAutoParameters): void {
  setHrmAutoParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackHrmAutoParameters(parameters: HrmAutoParameters): void {
  setHrmAutoParameters('track', activeTrackSlotIndex.value, parameters);
}

function setElectricParameters(path: 'input' | 'track', slotIndex: number, parameters: ElectricParameters): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slot = slots[slotIndex];
  if (!slot || slot.type !== 'ELECTRIC') return;
  slot.electricParameters = sanitizeElectricParameters(parameters);
  slot.value = slot.electricParameters.mixPercent;
  audio.setCatalogFxParameters(path, slotIndex, audio.getMode() === 'native'
    ? toNativeElectricParameters(slot.electricParameters)
    : toBrowserElectricParameters(slot.electricParameters));
}

function updateInputElectricParameters(parameters: ElectricParameters): void {
  setElectricParameters('input', activeInputSlotIndex.value, parameters);
}

function updateTrackElectricParameters(parameters: ElectricParameters): void {
  setElectricParameters('track', activeTrackSlotIndex.value, parameters);
}

function updateBrowserNamedParameter(path: 'input' | 'track', key: string, event: Event): void {
  const slot = path === 'input' ? activeInputFx.value : activeTrackFx.value;
  const controls = path === 'input' ? inputNamedControls.value : trackNamedControls.value;
  const control = controls.find((candidate) => candidate.key === key);
  if (!slot || !control || audio.getMode() !== 'browser') return;
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

function resetBrowserNamedControls(path: 'input' | 'track'): void {
  const slot = path === 'input' ? activeInputFx.value : activeTrackFx.value;
  const index = path === 'input' ? activeInputSlotIndex.value : activeTrackSlotIndex.value;
  if (!slot || index < 0 || audio.getMode() !== 'browser') return;
  const type = slot.type;
  const presets = { ...(slot.namedParametersByType ?? {}) };
  delete presets[type];
  slot.namedParametersByType = Object.keys(presets).length ? presets : undefined;
  // Recreate the Browser insert so omitted named fields return to processor
  // defaults instead of retaining a previous worklet-side partial override.
  audio.setFxType(path, index, 'NONE');
  audio.setFxType(path, index, type);
  audio.setFxParam(path, index, slot.value);
  audio.setFxActive(path, index, slot.active);
}

function updateInputNamedParameter(key: string, event: Event): void { updateBrowserNamedParameter('input', key, event); }
function updateTrackNamedParameter(key: string, event: Event): void { updateBrowserNamedParameter('track', key, event); }
function resetInputNamedControls(): void { resetBrowserNamedControls('input'); }
function resetTrackNamedControls(): void { resetBrowserNamedControls('track'); }

function updateFxValue(path: 'input' | 'track', slotId: string, value: number): void {
  const slots = path === 'input' ? inputSlots.value : trackSlots.value;
  const slotIndex = slots.findIndex((slot) => slot.id === slotId);
  const slot = slots[slotIndex];
  if (!slot || !Number.isFinite(value)) return;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  if (audio.getMode() === 'browser' && slot.type) {
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
  if (slot.type === 'PREAMP') {
    setPreampParameters(path, slotIndex, {
      ...sanitizePreampParameters(slot.preampParameters),
      gainPercent: bounded,
    });
  } else if (slot.type === 'SYNTH') {
    setSynthParameters(path, slotIndex, {
      ...sanitizeSynthParameters(slot.synthParameters),
      mix: bounded,
    });
  } else if (slot.type === 'G2B') {
    setG2bParameters(path, slotIndex, {
      ...sanitizeG2bParameters(slot.g2bParameters),
      blend: bounded,
    });
  } else if (slot.type === 'PITCH BEND') {
    setPitchBendParameters(path, slotIndex, {
      ...sanitizePitchBendParameters(slot.pitchBendParameters ?? createDefaultPitchBendParameters()),
      rangeSemitones: (bounded / 100) * 24,
    });
  } else if (slot.type === 'HRM MANUAL') {
    setManualHarmonistParameters(path, slotIndex, {
      ...sanitizeManualHarmonistParameters(slot.manualHarmonistParameters ?? createDefaultManualHarmonistParameters()),
      mixPercent: bounded,
    });
  } else if (slot.type === 'OCTAVE') {
    setOctaveParameters(path, slotIndex, {
      ...sanitizeOctaveParameters(slot.octaveParameters ?? createDefaultOctaveParameters()),
      mixPercent: bounded,
    });
  } else if (slot.type === 'VOCODER') {
    setVocoderParameters(path, slotIndex, {
      ...sanitizeVocoderParameters(slot.vocoderParameters ?? createDefaultVocoderParameters()),
      mixPercent: bounded,
    });
  } else if (slot.type === 'OSC VOC (M)') {
    setOscVocParameters(path, slotIndex, {
      ...sanitizeOscVocParameters(slot.oscVocParameters ?? createDefaultOscVocParameters()),
      mixPercent: bounded,
    });
  } else if (slot.type === 'AUTO RIFF' || slot.type === 'AUTO RIFF (EXPERIMENTAL)') {
    setAutoRiffParameters(path, slotIndex, {
      ...sanitizeAutoRiffParameters(slot.autoRiffParameters),
      mixPercent: bounded,
    });
  } else if (slot.type === 'ROBOT' || slot.type === 'ROBOT (EXPERIMENTAL)') {
    setRobotParameters(path, slotIndex, {
      ...sanitizeRobotFxParameters(slot.robotParameters),
      mixPercent: bounded,
    });
  } else if (slot.type === 'HRM AUTO (M)' || slot.type === 'HRM AUTO (M) (EXPERIMENTAL)') {
    setHrmAutoParameters(path, slotIndex, {
      ...sanitizeHrmAutoParameters(slot.hrmAutoParameters ?? createDefaultHrmAutoParameters()),
      mixPercent: bounded,
    });
  } else if (slot.type === 'ELECTRIC') {
    setElectricParameters(path, slotIndex, {
      ...sanitizeElectricParameters(slot.electricParameters ?? createDefaultElectricParameters()),
      mixPercent: bounded,
    });
  } else {
    slot.value = bounded;
  }
}

function updateInputFxValue(slotId: string, value: number): void {
  updateFxValue('input', slotId, value);
}

function updateTrackFxValue(slotId: string, value: number): void {
  updateFxValue('track', slotId, value);
}

const nativeStatusText = (status: NativeCatalogFxSlotRuntime | null) => {
  if (!status) return '';
  if (status.error) return `NATIVE FX NOT APPLIED: ${status.error}`;
  if (status.pendingRestart) return 'SAVED; RESTART NATIVE AUDIO TO APPLY EFFECT TYPE';
  return status.acknowledged
    ? `NATIVE API ACK: ${status.acknowledgedEffectId ?? 'EMPTY SLOT'}; ${Object.keys(status.acknowledgedParameters ?? {}).length} PARAMETER(S) ACCEPTED`
    : 'NATIVE FX WAITING FOR API ACK';
};

</script>

<style scoped>
.top-panel {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  padding: 18px 220px 20px;
  background: var(--bg-panel-secondary);
  border-bottom: 4px solid rgba(0, 0, 0, 0.2);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  z-index: 100;
  min-height: 220px;
}

.fx-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  justify-content: flex-start;
  min-width: 0;
}

.section-label {
  font-family: var(--font-hardware);
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 2px;
  font-weight: 700;
}

.section-note {
  min-height: 12px;
  font-family: var(--font-hardware);
  font-size: 9px;
  letter-spacing: 0.9px;
  color: #8d8d8d;
  text-transform: uppercase;
}

.fx-target { display: flex; flex-direction: column; gap: 6px; font-size: 10px; letter-spacing: 1px; }
.fx-target select {
  min-height: 36px; padding: 6px 10px; border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px; background: #26232a; color: #f3f3f5;
}
.independent-track-editor { max-height: 45vh; overflow-y: auto; padding: 2px 4px 2px 2px; }

.fx-row {
  display: flex;
  gap: 12px;
  flex-wrap: nowrap;
}

.fx-slot-shell {
  border-radius: 8px;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}

.fx-slot-shell.active {
  box-shadow: 0 0 0 1px rgba(0, 153, 255, 0.35), 0 0 18px rgba(0, 153, 255, 0.12);
  transform: translateY(-1px);
}

.input-named-controls {
  display: grid;
  gap: 8px;
  max-height: 210px;
  overflow-y: auto;
  margin-top: 10px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.16);
}
.input-named-controls summary { cursor: pointer; font-size: 12px; letter-spacing: 0.5px; }
.input-named-controls p, .input-named-hint { margin: 0; color: rgba(255, 255, 255, 0.66); font-size: 11px; line-height: 1.4; }
.input-named-control { display: grid; gap: 4px; font-size: 12px; }
.input-named-control input, .input-named-control select {
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
}
.reset-input-named-controls {
  justify-self: start;
  min-height: 30px;
  padding: 4px 9px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  cursor: pointer;
}

.transport-section {
  flex: 0 0 auto;
  margin: 0 12px;
  display: flex;
  gap: 24px;
  align-items: flex-start;
  align-self: center;
  justify-content: center;
  min-width: 0;
}

.input-fx,
.track-fx {
  flex: 1 1 0;
}

.input-fx .fx-row {
  justify-content: flex-start;
}

.track-fx .fx-row {
  justify-content: flex-end;
}

@media (max-width: 1680px) {
  .top-panel {
    padding-left: 160px;
    padding-right: 160px;
  }
}

@media (max-width: 1360px) {
  .top-panel {
    padding-left: 24px;
    padding-right: 24px;
  }
}

/* Responsive adjustments */
@media (max-width: 1000px) {
  .top-panel {
    min-height: 0;
    flex-wrap: wrap;
    justify-content: center;
    gap: 20px;
    padding: 12px;
  }

  .fx-section {
    flex: 1 1 320px;
  }

  .fx-row {
    justify-content: center;
    flex-wrap: wrap;
  }

  .transport-section {
    order: 2;
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    margin: 8px 0;
  }
}

@media (max-width: 768px) {
  .top-panel {
    align-items: stretch;
  }

  .fx-section {
    flex: 1 1 100%;
  }

  .transport-section {
    gap: 12px;
  }
}
</style>
