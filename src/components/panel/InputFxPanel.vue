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
      v-if="activeFx?.type === 'HRM AUTO (M)'"
      :model-value="activeFx.hrmAutoParameters"
      :midi-target="{ path: 'input', slot: activeFx?.id ?? 'A', effectId: 'hrm_auto_m' }"
      @update:model-value="updateHrmAutoParameters"
    />

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
import { computed, ref } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import { createDefaultNativeStepSlicerParameters, type NativeStepSlicerParameters } from '../../audio/nativeStepSlicerParameters';
import { useFxPanelState } from '../../composables/useFxPanelState';
import type { FxSlotId } from '../../composables/usePanelFocus';
import { createDefaultPreampParameters, sanitizePreampParameters, type PreampParameters } from '../../audio/preampParameters';
import { createDefaultSynthParameters, sanitizeSynthParameters, type SynthParameters } from '../../audio/synthParameters';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';
import NativeStepSlicerEditor from '../fx/NativeStepSlicerEditor.vue';
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

const { slots, fxOptions, fxDisabled, fxUnavailableReason, runtimeStatus, activeSlot, selectSlot } = useFxPanelState('input');
const editMode = ref(false);

const activeFx = computed(() => slots.value.find((slot) => slot.id === activeSlot.value) ?? slots.value[0]);
const nativeFxRuntimeText = computed(() => {
  const status = runtimeStatus.value;
  if (!status) return '';
  if (status.pendingRestart) return `SAVED; RESTART NATIVE AUDIO TO APPLY ${activeFx.value?.type || 'EMPTY SLOT'}`;
  if (status.error) return `NATIVE FX NOT APPLIED: ${status.error}`;
  return status.acknowledged
    ? `NATIVE API ACK: ${status.acknowledgedEffectId ?? 'EMPTY SLOT'}; ${Object.keys(status.acknowledgedParameters ?? {}).length} PARAMETER(S) ACCEPTED`
    : 'NATIVE FX WAITING FOR API ACK';
});

const handleSlotPress = (slotId: FxSlotId) => {
  selectSlot(slotId);
};

const updateActiveValue = (value: number) => {
  if (!activeFx.value) return;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  activeFx.value.value = bounded;
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
  if (activeFx.value.type === 'HRM AUTO (M)') {
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
  if (!slot || slot.type !== 'HRM AUTO (M)') return;
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
  font-size: 10px;
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
  font-size: 10px;
}

.detail-line,
.detail-note {
  font-size: 11px;
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
}

.slot-row {
  display: grid;
  grid-template-columns: repeat(4, 54px);
  justify-content: flex-start;
  gap: 8px;
  margin-top: auto;
}

.slot-toggle {
  display: flex;
  justify-content: flex-start;
}
</style>
