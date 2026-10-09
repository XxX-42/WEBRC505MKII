<template>
  <div class="top-panel">
    <!-- LEFT: INPUT FX -->
    <div class="fx-section input-fx">
      <div class="section-label">INPUT FX</div>
      <div v-if="fxDisabled" class="section-note">{{ fxUnavailableReason }}</div>
      <select class="fx-bank-select" :value="activeBankId" :disabled="fxDisabled || busy" aria-label="Active FX bank" @change="changeBank">
        <option v-for="bank in banks" :key="bank.id" :value="bank.id">{{ bank.name }}</option>
      </select>
      <div v-if="error" class="section-note fx-error" role="alert">{{ error }}</div>
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
            :selected-type="slot.type"
            :model-value="slot.value"
            :active="slot.active"
            :disabled="fxDisabled || busy"
            @update:selected-type="updateType('input', slot.id, $event)"
            @update:model-value="updateValue('input', slot.id, $event)"
            @update:active="toggleActive('input', slot.id, $event)"
          />
        </div>
      </div>
    </div>

    <!-- CENTER: TRANSPORT -->
    <div class="transport-section">
      <TransportControls />
      <details class="project-controls">
          <summary>MEMORY / ASSIGN</summary>
          <MemoryControls />
        </details>
        <details class="project-controls">
          <summary>LOOP / TEMPO</summary>
          <LoopSettingsPanel />
        </details>
        <details class="project-controls">
          <summary>RHYTHM EDIT</summary>
          <RhythmEditorPanel />
        </details>
    </div>

    <!-- RIGHT: TRACK FX -->
    <div class="fx-section track-fx">
      <div class="section-label">TRACK FX</div>
      <div v-if="fxDisabled" class="section-note">{{ fxUnavailableReason }}</div>
      <select class="fx-bank-select" :value="activeBankId" :disabled="fxDisabled || busy" aria-label="Active FX bank" @change="changeBank">
        <option v-for="bank in banks" :key="bank.id" :value="bank.id">{{ bank.name }}</option>
      </select>
      <div v-if="error" class="section-note fx-error" role="alert">{{ error }}</div>
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
            :selected-type="slot.type"
            :model-value="slot.value"
            :active="slot.active"
            :disabled="fxDisabled || busy"
            @update:selected-type="updateType('track', slot.id, $event)"
            @update:model-value="updateValue('track', slot.id, $event)"
            @update:active="toggleActive('track', slot.id, $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import FxUnit from './fx/FxUnit.vue';
import TransportControls from './TransportControls.vue';
import MemoryControls from './MemoryControls.vue';
import LoopSettingsPanel from './LoopSettingsPanel.vue';
import RhythmEditorPanel from './RhythmEditorPanel.vue';
import { useFxPanelState } from '../composables/useFxPanelState';

const {
  slots: inputSlots,
  banks,
  activeBankId,
  busy,
  error,
  fxOptions,
  fxDisabled,
  fxUnavailableReason,
  activeSlot: activeInputSlot,
  selectSlot: selectInputSlot,
  selectBank,
  updateType: updateInputType,
  updateValue: updateInputValue,
  toggleActive: toggleInputActive,
} = useFxPanelState('input');

const {
  slots: trackSlots,
  activeSlot: activeTrackSlot,
  selectSlot: selectTrackSlot,
  updateType: updateTrackType,
  updateValue: updateTrackValue,
  toggleActive: toggleTrackActive,
} = useFxPanelState('track');

const changeBank = (event: Event) => void selectBank((event.target as HTMLSelectElement).value);
const updateType = (location: 'input' | 'track', slot: 'A' | 'B' | 'C' | 'D', type: string) => {
  void (location === 'input' ? updateInputType(slot, type) : updateTrackType(slot, type));
};
const updateValue = (location: 'input' | 'track', slot: 'A' | 'B' | 'C' | 'D', value: number) => {
  void (location === 'input' ? updateInputValue(slot, value) : updateTrackValue(slot, value));
};
const toggleActive = (location: 'input' | 'track', slot: 'A' | 'B' | 'C' | 'D', active: boolean) => {
  void (location === 'input' ? toggleInputActive(slot, active) : toggleTrackActive(slot, active));
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

.fx-bank-select {
  max-width: 130px;
  min-height: 24px;
  padding: 2px 5px;
  border: 1px solid rgba(255, 255, 255, .13);
  border-radius: 4px;
  background: #1c1e24;
  color: #d9e5f5;
  font: 9px var(--font-hardware);
}

.fx-bank-select:disabled { opacity: .45; }
.fx-error { color: #ff9198; }

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

.project-controls {
  position: relative;
  z-index: 5;
  width: 292px;
  flex: 0 0 292px;
  color: var(--text-muted);
  font-family: var(--font-hardware);
}

.project-controls > summary {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 7px;
  background: rgba(0,0,0,.2);
  color: #d3d8e2;
  cursor: pointer;
  font-size: 9px;
  letter-spacing: 1px;
}

.project-controls[open] > :deep(.memory-controls) {
  position: absolute;
  top: 38px;
  right: 0;
  width: min(380px, calc(100vw - 24px));
}

.project-controls[open] > :deep(.loop-settings) {
  position: absolute;
  top: 38px;
  right: 0;
  width: min(480px, calc(100vw - 24px));
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 10px;
  background: #15181e;
  box-shadow: 0 18px 42px rgba(0,0,0,.55);
}

.project-controls[open] > :deep(.rhythm-editor) {
  position: absolute;
  top: 38px;
  right: 0;
  width: min(760px, calc(100vw - 24px));
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 10px;
  background: #15181e;
  box-shadow: 0 18px 42px rgba(0,0,0,.55);
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

  .project-controls[open] > :deep(.memory-controls) {
    position: static;
    width: 100%;
  }

  .project-controls[open] > :deep(.loop-settings) {
    position: static;
    width: 100%;
  }

  .project-controls[open] > :deep(.rhythm-editor) {
    position: static;
    width: min(760px, calc(100vw - 24px));
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
