<template>
  <section class="fx-bank" :class="`fx-bank-${location}`" :aria-label="`${title} controls`"
    :aria-busy="banks.state.busy"
    :aria-description="controlLayer === 'BANK_SELECT' ? `Bank selection. Requested ${banks.state.requestedBank ?? 'none'}; confirmed ${banks.state.appliedBank ?? 'none'}.` : undefined"
    @keydown="handleChordKey">
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
            :selected="slotStates[slot.id]?.selected ?? false"
            :led-on="slotStates[slot.id]?.ledOn ?? false"
            :led-color="slotStates[slot.id]?.ledColor ?? 'off'"
            :data-fx-selected="slotStates[slot.id]?.selected ? 'true' : 'false'"
            :data-fx-enabled="slot.active ? 'true' : 'false'"
            :aria-pressed="controlLayer === 'BANK_SELECT' ? banks.state.appliedBank === slot.id : slot.active"
            :disabled="slotsDisabled"
            :disabled-reason="fxUnavailableReason"
            :aria-label="controlLayer === 'BANK_SELECT' ? `${title} Bank ${slot.id}` : `${title} FX ${slot.id}${slot.active ? ' active' : ''}`"
            :data-testid="`${location}-fx-slot-${slot.id.toLowerCase()}`"
            data-hardware-control="button"
            @press="pressSlot(slot.id)"
            @release="releaseSlot(slot.id)"
            @cancel="releaseSlot(slot.id)"
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
          :selected="controlLayer !== 'NORMAL'"
          :led-on="false"
          :data-fx-layer="controlLayer"
          @press="beginEdit"
          @release="finishEdit"
          @cancel="cancelEdit"
        />
      </div>
    </div>

    <p v-if="fxUnavailableReason" class="bank-status" role="status">{{ fxUnavailableReason }}</p>
    <p v-else class="bank-status">{{ activeFx?.id ?? 'A' }} · {{ activeFx?.type ?? 'EMPTY' }} · {{ Math.round(activeFx?.value ?? 0) }}%</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { createRc505FxControlState, reduceRc505FxControl, type Rc505FxEvent } from '../../ui/rc505/Rc505FxControlStateMachine';
import { AudioEngine } from '../../audio/AudioEngine';
import { useFxPanelState } from '../../composables/useFxPanelState';
import { useTrackFxTargetState } from '../../composables/useTrackFxTargetState';
import { useRc505Controls } from '../../composables/useRc505Controls';
import { useRc505FxBanks } from '../../composables/useRc505FxBanks';
import { resolveRc505FxSlot } from '../../ui/rc505/Rc505ControlStateResolver';
import { resolveNativeFxReadback } from '../../ui/rc505/Rc505FxReadback';
import { Rc505FxSwitchController } from '../../ui/rc505/Rc505FxSwitchController';
import { selectRc505FxSwitchBank, useRc505FxSwitchSettings } from '../../composables/useRc505FxSwitchSettings';
import type { FxLocation, FxSlotId } from '../../composables/usePanelFocus';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';

const props = defineProps<{ location: FxLocation; title: string; color: 'red' | 'blue'; modelValue: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: number]; edit: [] }>();
const sharedBank = useFxPanelState(props.location);
const controls = useRc505Controls();
const banks = useRc505FxBanks(props.location);
const engine = AudioEngine.getInstance();
const trackTarget = useTrackFxTargetState();
const revision = ref(0);
const poll = window.setInterval(() => revision.value++, 100);
const slots = sharedBank.slots;
const activeSlot = sharedBank.activeSlot;
const fxDisabled = sharedBank.fxDisabled;
const switchSettings = computed(() => useRc505FxSwitchSettings(engine.getMode(), props.location, banks.state.requestedBank ?? 'A'));
const switchController = new Rc505FxSwitchController();
const heldRows = new Map<FxSlotId, typeof slots.value[number]>();
const fxUnavailableReason = computed(() => switchSettings.value.state.error || banks.state.error || banks.state.unavailableReason || sharedBank.fxUnavailableReason.value);
const controlLayer = computed(() => controls.state.fxLayers[props.location]);
const slotsDisabled = computed(() => fxDisabled.value || !!switchSettings.value.state.error || banks.state.busy
  || (controlLayer.value === 'BANK_SELECT' && !banks.canSelect.value));
const activeFx = computed(() => slots.value.find((slot) => slot.id === activeSlot.value) ?? slots.value[0]);
const valueDisabled = computed(() => fxDisabled.value || banks.state.busy || !activeFx.value?.type || activeFx.value.type === 'NONE');
const valueDisabledReason = computed(() => fxUnavailableReason.value || 'Select an effect before editing its value.');
const slotStates = computed(() => {
  revision.value;
  return Object.fromEntries(slots.value.map((slot, index) => {
    let active = false;
    if (engine.getMode() === 'native') {
      const runtime = engine.getNativeCatalogFxSlotStatus(props.location, index);
      active = resolveNativeFxReadback(runtime).activeLabel === 'ON';
    } else {
      const runtime = engine.getBrowserSharedFxSnapshot?.(props.location)?.[index];
      active = !!runtime?.active && runtime.state === 'ready';
    }
    return [slot.id, resolveRc505FxSlot({ enabled: !slotsDisabled.value, active,
      selected: controlLayer.value === 'BANK_SELECT' ? banks.state.requestedBank === slot.id : activeSlot.value === slot.id,
      layer: controlLayer.value,
      appliedBank: banks.state.appliedBank === slot.id, reason: fxUnavailableReason.value })];
  }));
});
let interaction = createRc505FxControlState();
let editTimer: number | null = null;
function clearEditTimer() { if (editTimer !== null) window.clearTimeout(editTimer); editTimer = null; }
function dispatch(event: Rc505FxEvent): void {
  const result = reduceRc505FxControl({ ...interaction, layer: controlLayer.value }, event);
  interaction = result.state;
  controls.setFxLayer(props.location, interaction.layer);
  for (const effect of result.effects) {
    if (effect.type === 'APPLY_BANK') { void banks.selectBank(effect.slot); continue; }
    if (props.location === 'track') trackTarget.selectTarget('shared');
    if (effect.type === 'OPEN_EDITOR') {
      if (effect.slot) sharedBank.selectSlot(effect.slot);
      emit('edit');
    } else {
      sharedBank.selectSlot(effect.slot);
      const slot = slots.value.find((item) => item.id === effect.slot);
      if (slot?.type && slot.type !== 'NONE') {
        const active = Object.fromEntries(slots.value.map((row) => [row.id, row.active])) as Record<FxSlotId, boolean>;
        const result = switchController.press(effect.slot, switchSettings.value.state.settings, active);
        if (switchSettings.value.state.settings.switchModes[effect.slot] === 'MOMENT' && result.writes.some((write) => write.slot === effect.slot && write.active)) heldRows.set(effect.slot, slot);
        applySwitchWrites(result.writes);
        if (result.reason) controls.reportError('FX HOLD UNAVAILABLE', result.reason, props.location === 'input' ? 'input-fx' : 'track-fx');
      }
    }
  }
}
function beginEdit(): void {
  if (interaction.editHeld || banks.state.busy) return;
  releaseAllSlots();
  dispatch({ type: 'EDIT_DOWN' });
  // Engineering hold duration selected by the user; no official time is published.
  if (!interaction.consumed) editTimer = window.setTimeout(() => { editTimer = null; dispatch({ type: 'EDIT_HOLD' }); }, 1500);
}
function finishEdit(): void { clearEditTimer(); dispatch({ type: 'EDIT_UP' }); }
function cancelEdit(): void { clearEditTimer(); dispatch({ type: 'CANCEL' }); }
function applySwitchWrites(writes: { slot: FxSlotId; active: boolean }[]): void {
  for (const write of writes) {
    const row = slots.value.find((slot) => slot.id === write.slot);
    if (row) row.active = write.active;
  }
}
function releaseSlot(id: FxSlotId): void {
  for (const write of switchController.release(id)) {
    const original = heldRows.get(write.slot);
    if (original) original.active = false;
    heldRows.delete(write.slot);
  }
}
function releaseAllSlots(): void {
  for (const write of switchController.cancel()) {
    const original = heldRows.get(write.slot);
    if (original) original.active = false;
  }
  heldRows.clear();
}
function pressSlot(slotId: FxSlotId): void {
  if (slotsDisabled.value) return;
  dispatch({ type: 'SLOT', slot: slotId });
  if (interaction.consumed) clearEditTimer();
}
function handleChordKey(event: KeyboardEvent): void {
  if ((!interaction.editHeld && controlLayer.value !== 'BANK_SELECT') || !/^[a-d]$/i.test(event.key)) return;
  event.preventDefault();
  if (!event.repeat) pressSlot(event.key.toUpperCase() as FxSlotId);
}
watch(() => banks.state.error, (error) => {
  const scope = props.location === 'input' ? 'input-fx' : 'track-fx';
  if (error) controls.reportError('FX BANK ERROR', error, scope);
  else controls.clearError(scope);
});
watch(() => banks.state.busy, (busy) => controls.setFxBusy(props.location, busy), { immediate: true, flush: 'sync' });
watch(fxDisabled, (disabled) => { if (disabled) { releaseAllSlots(); cancelEdit(); } });
watch(() => banks.state.requestedBank, releaseAllSlots, { flush: 'sync' });
watch(() => banks.state.requestedBank, (bank) => selectRc505FxSwitchBank(engine.getMode(), props.location, bank ?? 'A'), { immediate: true, flush: 'sync' });
watch(() => switchSettings.value.state.settings, releaseAllSlots, { deep: true, flush: 'sync' });
function cancelAll(): void { releaseAllSlots(); cancelEdit(); }
window.addEventListener('blur', cancelAll);
onUnmounted(() => { cancelAll(); controls.setFxBusy(props.location, false); window.clearInterval(poll); window.removeEventListener('blur', cancelAll); });
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
