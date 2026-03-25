<template>
  <div class="top-panel">
    <!-- LEFT: INPUT FX -->
    <div class="fx-section input-fx">
      <div class="section-label">INPUT FX</div>
      <div v-if="fxDisabled" class="section-note">{{ fxUnavailableReason }}</div>
      <div class="fx-row">
        <div
          v-for="slot in inputSlots"
          :key="slot.id"
          class="fx-slot-shell"
          :class="{ active: activeInputSlot === slot.id }"
          @mousedown="selectInputSlot(slot.id)"
        >
          <FxUnit
            :label="slot.id"
            :options="fxOptions"
            v-model:selectedType="slot.type"
            v-model:modelValue="slot.value"
            v-model:active="slot.active"
            :disabled="fxDisabled"
          />
        </div>
      </div>
    </div>

    <!-- CENTER: TRANSPORT -->
    <div class="transport-section">
      <TransportControls />
      <RhythmControls />
    </div>

    <!-- RIGHT: TRACK FX -->
    <div class="fx-section track-fx">
      <div class="section-label">TRACK FX</div>
      <div v-if="fxDisabled" class="section-note">{{ fxUnavailableReason }}</div>
      <div class="fx-row">
        <div
          v-for="slot in trackSlots"
          :key="slot.id"
          class="fx-slot-shell"
          :class="{ active: activeTrackSlot === slot.id }"
          @mousedown="selectTrackSlot(slot.id)"
        >
          <FxUnit
            :label="slot.id"
            :options="fxOptions"
            v-model:selectedType="slot.type"
            v-model:modelValue="slot.value"
            v-model:active="slot.active"
            :disabled="fxDisabled"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import FxUnit from './fx/FxUnit.vue';
import TransportControls from './TransportControls.vue';
import RhythmControls from './RhythmControls.vue';
import { useFxPanelState } from '../composables/useFxPanelState';

const {
  slots: inputSlots,
  fxOptions,
  fxDisabled,
  fxUnavailableReason,
  activeSlot: activeInputSlot,
  selectSlot: selectInputSlot,
} = useFxPanelState('input');

const {
  slots: trackSlots,
  activeSlot: activeTrackSlot,
  selectSlot: selectTrackSlot,
} = useFxPanelState('track');

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
    padding-left: 96px;
    padding-right: 96px;
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
