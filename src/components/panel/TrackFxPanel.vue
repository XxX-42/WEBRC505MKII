<template>
  <section class="panel-shell track-panel" data-panel="track-fx">
    <div class="panel-header">
      <div>
        <h2>TRACK FX</h2>
        <p class="eyebrow">EDIT / FX BANK</p>
      </div>
      <div class="edit-stack">
        <HardwareButton
          shape="rect"
          size="sm"
          color="white"
          :active="editMode"
          label="EDIT"
          aria-label="Toggle track FX edit mode"
          @press="editMode = !editMode"
        />
        <div class="edit-lamp" :class="{ active: editMode }"></div>
      </div>
    </div>

    <div class="fx-main">
      <div class="knob-control" :class="{ disabled: fxDisabled || busy }" :aria-disabled="fxDisabled || busy">
        <HardwareKnob
          :model-value="activeFx?.value ?? 0"
          label="TRACK FX"
          color="red"
          :size="118"
          @update:model-value="updateActiveValue"
        />
      </div>

      <div class="fx-detail">
        <div class="detail-chip">TRACK {{ currentTrackId }} · SLOT {{ activeFx?.id ?? 'A' }}</div>
        <select class="fx-select bank-select" :value="activeBankId" :disabled="fxDisabled || busy" aria-label="Active FX bank" @change="changeBank">
          <option v-for="bank in banks" :key="bank.id" :value="bank.id">{{ bank.name }}</option>
        </select>
        <select v-if="activeFx" :value="activeFx.type" class="fx-select" :disabled="fxDisabled || busy" aria-label="Track FX type" @change="changeType">
          <option v-if="!activeFx.type" value="" disabled>EMPTY</option>
          <option v-for="option in fxOptions" :key="option" :value="option">{{ option }}</option>
        </select>
        <div class="detail-line">{{ activeFx?.parameterLabel ?? 'PARAM' }} {{ Math.round(activeFx?.value ?? 0) }}%</div>
        <div class="detail-line">APPLY {{ appliedTrackSummary }}</div>
        <div v-if="fxUnavailableReason" class="detail-note">{{ fxUnavailableReason }}</div>
        <div v-if="error" class="detail-note" role="alert">{{ error }}</div>
      </div>
    </div>

    <div v-if="activeFx" class="slot-toggle">
      <HardwareButton
        shape="rect"
        size="md"
        :label="activeFx.active ? 'BYPASS' : 'ACTIVATE'"
        :color="activeFx.active ? 'red' : 'white'"
        :active="activeFx.active"
        :disabled="fxDisabled || busy || !activeFx.unit"
        :aria-label="`Toggle track FX slot ${activeFx.id}`"
        @press="toggleActive(activeFx.id)"
      />
    </div>

    <div class="slot-row">
      <HardwareButton
        v-for="slot in slots"
        :key="slot.id"
        shape="circle"
        size="md"
        :label="slot.id"
        :color="activeSlot === slot.id ? 'red' : slot.active ? 'yellow' : 'neutral'"
        :active="activeSlot === slot.id || slot.active"
        :aria-label="`Select track FX slot ${slot.id}`"
        @press="selectSlot(slot.id)"
      />
    </div>

    <div class="apply-grid">
      <button
        v-for="trackId in 5"
        :key="trackId"
        class="apply-chip"
        :class="{ active: trackFxApplyMap[trackId] }"
        type="button"
        :aria-pressed="trackFxApplyMap[trackId]"
        :aria-label="`${trackFxApplyMap[trackId] ? 'Disable' : 'Enable'} track FX send for track ${trackId}`"
        @click="toggleTrackFx(trackId)"
      >
        T{{ trackId }} {{ trackFxApplyMap[trackId] ? 'ON' : 'OFF' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useFxPanelState } from '../../composables/useFxPanelState';
import { usePanelFocus } from '../../composables/usePanelFocus';
import { useControlDispatcher } from '../../composables/useControlDispatcher';
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';

const {
  slots, banks, activeBankId, fxOptions, fxDisabled, fxUnavailableReason, activeSlot, busy, error,
  selectSlot, selectBank, updateType, updateValue, toggleActive,
} = useFxPanelState('track');
const { state } = usePanelFocus();
const { dispatcher } = useControlDispatcher();
const editMode = ref(false);

const activeFx = computed(() => slots.value.find((slot) => slot.id === activeSlot.value) ?? slots.value[0]);
const currentTrackId = computed(() => state.currentTrackId);
const trackFxApplyMap = computed(() => state.trackFxApplyMap);
const appliedTrackSummary = computed(() => {
  const activeTracks = Object.entries(trackFxApplyMap.value)
    .filter(([, active]) => active)
    .map(([trackId]) => `T${trackId}`);
  return activeTracks.length > 0 ? activeTracks.join(' ') : 'NONE';
});

const toggleTrackFx = (trackId: number) => {
  void dispatcher.dispatch({
    type: 'set-track-fx-send',
    trackId,
    enabled: !trackFxApplyMap.value[trackId],
  });
};

const updateActiveValue = (value: number) => {
  if (!activeFx.value) return;
  void updateValue(activeFx.value.id, Math.max(0, Math.min(100, Math.round(value))));
};
const changeType = (event: Event) => {
  if (!activeFx.value) return;
  void updateType(activeFx.value.id, (event.target as HTMLSelectElement).value);
};
const changeBank = (event: Event) => void selectBank((event.target as HTMLSelectElement).value);
</script>

<style scoped>
.panel-shell {
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  gap: 14px;
  min-height: 292px;
  padding: 12px 12px 12px 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
  overflow: hidden;
}

.panel-header,
.fx-main {
  display: flex;
  justify-content: space-between;
  gap: 14px;
}

.knob-control { display: grid; place-items: center; }
.knob-control.disabled { pointer-events: none; opacity: .45; }

.fx-main {
  align-items: center;
  display: grid;
  grid-template-columns: 124px minmax(0, 1fr);
}

.panel-header h2,
.eyebrow,
.detail-chip,
.detail-line,
.detail-note,
.apply-chip {
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
  min-width: 0;
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
  width: 100%;
  min-width: 0;
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
  gap: 10px;
}

.slot-toggle {
  display: flex;
  justify-content: flex-start;
}

.apply-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  max-width: 100%;
}

.apply-chip {
  min-height: 34px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #f3f3f5;
  letter-spacing: 1px;
  font-size: 9px;
  min-width: 0;
}

.apply-chip.active {
  color: var(--led-red-recording);
  border-color: rgba(255, 0, 51, 0.28);
  box-shadow: 0 0 0 1px rgba(255, 0, 51, 0.18) inset;
}
</style>
