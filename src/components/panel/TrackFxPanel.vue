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
      <HardwareKnob
        :model-value="activeFx?.value ?? 0"
        label="TRACK FX"
        color="red"
        :size="118"
        @update:model-value="updateActiveValue"
      />

      <div class="fx-detail">
        <div class="detail-chip">TRACK {{ currentTrackId }}</div>
        <select v-if="activeFx" v-model="activeFx.type" class="fx-select" :disabled="fxDisabled">
          <option v-for="option in fxOptions" :key="option" :value="option">{{ option }}</option>
        </select>
        <div class="detail-line">SLOT {{ activeFx?.id ?? 'A' }}</div>
        <div class="detail-line">APPLY {{ appliedTrackSummary }}</div>
        <div v-if="fxUnavailableReason" class="detail-note">{{ fxUnavailableReason }}</div>
      </div>
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
import HardwareButton from '../ui/HardwareButton.vue';
import HardwareKnob from '../ui/HardwareKnob.vue';

const { slots, fxOptions, fxDisabled, fxUnavailableReason, activeSlot, selectSlot } = useFxPanelState('track');
const { state } = usePanelFocus();
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

const updateActiveValue = (value: number) => {
  if (!activeFx.value) return;
  activeFx.value.value = Math.max(0, Math.min(100, Math.round(value)));
};
</script>

<style scoped>
.panel-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 292px;
  padding: 12px 10px 12px 14px;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
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
  align-items: flex-end;
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
  min-width: 140px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: #f3f3f5;
}

.slot-row {
  display: grid;
  grid-template-columns: repeat(4, 54px);
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
}

.apply-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.apply-chip {
  min-height: 34px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #f3f3f5;
  letter-spacing: 1px;
  font-size: 10px;
}

.apply-chip.active {
  color: var(--led-red-recording);
  border-color: rgba(255, 0, 51, 0.28);
  box-shadow: 0 0 0 1px rgba(255, 0, 51, 0.18) inset;
}
</style>
