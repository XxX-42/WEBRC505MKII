<template>
  <section class="fx-bank" :class="`fx-bank-${location}`" :aria-label="`${title} controls`">
    <div class="bank-heading">
      <span class="bank-kicker">{{ location === 'input' ? 'MIC · INST' : 'TRACK' }}</span>
      <h2>{{ title }}</h2>
    </div>

    <div class="bank-body">
      <HardwareKnob
        class="fx-bank-knob"
        appearance="classic"
        :model-value="modelValue"
        :label="activeFx?.type ?? 'FX VALUE'"
        :color="color"
        :size="140"
        :disabled="valueDisabled"
        :disabled-reason="valueDisabledReason"
        :aria-label="`${title} selected effect value`"
        data-hardware-control="knob"
        @update:model-value="$emit('update:modelValue', $event)"
      />

      <div class="bank-actions">
        <div class="fx-slot-row" role="group" :aria-label="`${title} FX slots`">
          <HardwareButton
            v-for="slot in slots"
            :key="slot.id"
            shape="circle"
            size="sm"
            class="fx-slot-button"
            appearance="classic"
            :label="slot.id"
            :color="color"
            :active="slot.active"
            :data-fx-selected="activeSlot === slot.id ? 'true' : 'false'"
            :data-fx-enabled="slot.active ? 'true' : 'false'"
            :aria-pressed="slot.active"
            :disabled="fxDisabled"
            :disabled-reason="fxUnavailableReason"
            :aria-label="`${title} FX ${slot.id}${slot.active ? ' active' : ''}`"
            :data-testid="`${location}-fx-slot-${slot.id.toLowerCase()}`"
            data-hardware-control="button"
            @press="pressSlot(slot.id)"
          />
        </div>

        <HardwareButton
          shape="rect"
          size="sm"
          class="fx-edit-button"
          appearance="classic"
          color="white"
          label="EDIT"
          :aria-label="`Edit ${title.toLowerCase()} effects`"
          :data-testid="`${location}-fx-edit-button`"
          data-hardware-control="button"
          @press="$emit('edit')"
        />
      </div>
    </div>

    <p v-if="fxUnavailableReason" class="bank-status" role="status">{{ fxUnavailableReason }}</p>
    <p v-else class="bank-status">{{ activeFx?.id ?? 'A' }} · {{ activeFx?.type ?? 'EMPTY' }} · {{ Math.round(activeFx?.value ?? 0) }}%</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useFxPanelState } from '../../composables/useFxPanelState';
import { useTrackFxTargetState } from '../../composables/useTrackFxTargetState';
import { useDevicePanel } from '../../composables/useDevicePanel';
import type { FxLocation, FxSlotId } from '../../composables/usePanelFocus';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';

const props = withDefaults(defineProps<{
  location: FxLocation;
  title: string;
  color: 'red' | 'blue';
  modelValue: number;
}>(), {});

defineEmits<{
  'update:modelValue': [value: number];
  edit: [];
}>();

const sharedBank = useFxPanelState(props.location);
const device = useDevicePanel();
const trackTarget = useTrackFxTargetState();
const slots = computed(() => props.location === 'track' ? trackTarget.slots.value : sharedBank.slots.value);
const activeSlot = computed(() => props.location === 'track' ? trackTarget.activeSlot.value : sharedBank.activeSlot.value);
const fxDisabled = computed(() => props.location === 'track' ? trackTarget.fxDisabled.value : sharedBank.fxDisabled.value);
const fxUnavailableReason = computed(() => props.location === 'track'
  ? trackTarget.fxUnavailableReason.value
  : sharedBank.fxUnavailableReason.value);
const activeFx = computed(() => slots.value.find((slot) => slot.id === activeSlot.value) ?? slots.value[0]);
const activeFxIsEmpty = computed(() => !activeFx.value?.type || activeFx.value.type === 'NONE');
const valueDisabled = computed(() => fxDisabled.value || activeFxIsEmpty.value);
const valueDisabledReason = computed(() => fxDisabled.value
  ? fxUnavailableReason.value
  : activeFxIsEmpty.value ? 'Select an effect first to edit its value.' : '');

function pressSlot(slotId: FxSlotId): void {
  if (fxDisabled.value) return;
  device.openPage(props.location === 'input' ? 'input-fx' : 'track-fx');
  if (props.location === 'track') {
    trackTarget.selectSlot(slotId);
    const slot = trackTarget.slots.value.find((item) => item.id === slotId);
    if (slot?.type && slot.type !== 'NONE') trackTarget.setSlotActive(slotId, !slot.active);
    return;
  }
  sharedBank.selectSlot(slotId);
  const slot = sharedBank.slots.value.find((item) => item.id === slotId);
  if (slot?.type && slot.type !== 'NONE') slot.active = !slot.active;
}
</script>

<style scoped>
.fx-bank {
  position: absolute;
  top: 0;
  bottom: 0;
  display: block;
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: visible;
  color: #e5e7eb;
  font-family: var(--font-hardware);
  background: linear-gradient(150deg, #27292e, #15161a 72%);
}

.bank-heading { position: absolute; top: 10px; left: 16px; display: grid; gap: 3px; }
.bank-heading h2 { margin: 0; color: #e8e4eb; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-shadow: 0 1px #07070a; }
.bank-kicker { color: #cbc4ce; font-size: 12px; letter-spacing: 0.08em; }
.bank-body { display: contents; }
.bank-actions { position: static; display: contents; width: auto; }
.fx-slot-row { display: contents; }
.bank-body :deep(.hardware-knob-wrapper.fx-bank-knob) {
  position: absolute;
  z-index: 2;
  top: 10px;
  width: 140px;
  min-height: 158px;
  gap: 7px;
  margin: 0;
}
.bank-body :deep(.fx-bank-knob .knob-stage) {
  position: relative !important;
  isolation: isolate;
  width: 140px;
  height: 140px;
  flex: 0 0 140px;
}
.bank-body :deep(.fx-bank-knob .led-ring) {
  position: absolute !important;
  inset: 0 !important;
  top: 0 !important;
  left: 0 !important;
  width: 140px !important;
  height: 140px !important;
  max-width: 140px;
  max-height: 140px;
  pointer-events: none;
}
.bank-body :deep(.fx-bank-knob .knob-cap) { z-index: 1; }
.bank-body :deep(.knob-label) { color: #e0e3e8; font-size: 12px; line-height: 1.05; }
.fx-slot-row :deep(.button-label) { font-size: 12px; }
.fx-slot-row :deep(.fx-slot-button) {
  position: absolute;
  top: 197px;
  z-index: 3;
  width: 36px !important;
  min-width: 36px !important;
  height: 36px !important;
  padding: 0 !important;
  border-radius: 50% !important;
}
.fx-slot-row :deep(.fx-slot-button:nth-of-type(1)) { left: 56px; }
.fx-slot-row :deep(.fx-slot-button:nth-of-type(2)) { left: 127px; }
.fx-slot-row :deep(.fx-slot-button:nth-of-type(3)) { left: 194px; }
.fx-slot-row :deep(.fx-slot-button:nth-of-type(4)) { left: 262px; }
.bank-actions :deep(.fx-edit-button) {
  position: absolute;
  z-index: 4;
  top: 112px;
  width: 38px !important;
  min-width: 38px !important;
  height: 38px !important;
  padding: 0 !important;
  border-radius: 50% !important;
}
.bank-actions :deep(.fx-edit-button .button-label) { font-size: 12px; }
.fx-bank :deep(.fx-slot-button[data-fx-selected="true"]:not(.active)) {
  border: 1px solid rgba(245, 248, 255, 0.76);
  box-shadow: 0 0 0 1px rgba(220, 232, 248, 0.32), inset 0 0 7px rgba(220, 232, 248, 0.16);
}
.fx-bank :deep(.fx-slot-button.active.color-red:not(.is-disabled)) {
  background: linear-gradient(155deg, #ffb5ba 0%, #ff4d5d 45%, #9e162b 100%) !important;
  border-color: #ffced1;
  box-shadow: 0 0 7px rgba(255,57,77,.95), 0 0 18px rgba(255,35,61,.62), inset 0 1px rgba(255,255,255,.66), inset 0 -4px 9px rgba(75,0,8,.55);
}
.fx-bank :deep(.fx-slot-button[data-fx-selected="true"].active.color-red:not(.is-disabled)) {
  background: linear-gradient(155deg, #ffd8eb 0%, #ff79ba 46%, #a92c68 100%) !important;
  border-color: #ffe8f4;
  box-shadow: 0 0 8px rgba(255,111,183,.96), 0 0 20px rgba(255,62,156,.7), inset 0 1px rgba(255,255,255,.74), inset 0 -4px 9px rgba(83,5,42,.55);
}
.bank-status {
  min-height: 13px;
  margin: 0;
  color: #aeb5bf;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-align: center;
  text-transform: uppercase;
}

.fx-bank-input { border-right: 1px solid #111216; }
.fx-bank-track { border-left: 1px solid #111216; }
.fx-bank-input :deep(.hardware-knob-wrapper.fx-bank-knob) { left: 70px; }
.fx-bank-track :deep(.hardware-knob-wrapper.fx-bank-knob) { left: 145px; }
.fx-bank-input .bank-actions :deep(.fx-edit-button) { left: 264px; }
.fx-bank-track .bank-actions :deep(.fx-edit-button) { left: 61px; }
.fx-bank-track .fx-slot-row :deep(.fx-slot-button:nth-of-type(1)) { left: 62px; }
.fx-bank-track .fx-slot-row :deep(.fx-slot-button:nth-of-type(2)) { left: 131px; }
.fx-bank-track .fx-slot-row :deep(.fx-slot-button:nth-of-type(3)) { left: 197px; }
.fx-bank-track .fx-slot-row :deep(.fx-slot-button:nth-of-type(4)) { left: 268px; }
.bank-status {
  position: absolute;
  top: 176px;
  left: 14px;
  right: 14px;
  z-index: 1;
  min-height: 14px;
  margin: 0;
  color: #aeb5bf;
  font-size: 12px;
  line-height: 1;
  letter-spacing: 0.07em;
  text-align: center;
  text-transform: uppercase;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 760px) {
  .fx-bank { padding: 0; }
}
</style>
