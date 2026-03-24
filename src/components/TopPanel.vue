<template>
  <div class="top-panel">
    <!-- LEFT: INPUT FX -->
    <div class="fx-section input-fx">
      <div class="section-label">INPUT FX</div>
      <div class="fx-row">
        <FxUnit
          v-for="slot in inputSlots"
          :key="slot.id"
          :label="slot.id"
          :options="fxOptions"
          v-model:selectedType="slot.type"
          v-model:modelValue="slot.value"
          v-model:active="slot.active"
        />
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
      <div class="fx-row">
        <FxUnit
          v-for="slot in trackSlots"
          :key="slot.id"
          :label="slot.id"
          :options="fxOptions"
          v-model:selectedType="slot.type"
          v-model:modelValue="slot.value"
          v-model:active="slot.active"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import FxUnit from './fx/FxUnit.vue';
import TransportControls from './TransportControls.vue';
import RhythmControls from './RhythmControls.vue';
import { AudioEngine } from '../audio/AudioEngine';

const engine = AudioEngine.getInstance();
const fxOptions = ['FILTER', 'DELAY', 'REVERB', 'SLICER', 'PHASER'];

interface FxSlot {
  id: string;
  type: string;
  value: number;
  active: boolean;
}

// Default States
const defaultInputSlots: FxSlot[] = [
  { id: 'A', type: 'FILTER', value: 0, active: false },
  { id: 'B', type: 'DELAY', value: 0, active: false },
  { id: 'C', type: 'REVERB', value: 0, active: false },
  { id: 'D', type: 'SLICER', value: 0, active: false },
];

const defaultTrackSlots: FxSlot[] = [
  { id: 'A', type: 'FILTER', value: 0, active: false },
  { id: 'B', type: 'DELAY', value: 0, active: false },
  { id: 'C', type: 'REVERB', value: 0, active: false },
  { id: 'D', type: 'SLICER', value: 0, active: false },
];

const inputSlots = ref<FxSlot[]>(JSON.parse(JSON.stringify(defaultInputSlots)));
const trackSlots = ref<FxSlot[]>(JSON.parse(JSON.stringify(defaultTrackSlots)));

// Persistence
const STORAGE_KEY = 'webrc505_top_panel';

// Helper to sync state to engine
const syncSlotToEngine = (location: 'input' | 'track', index: number, slot: FxSlot) => {
  engine.setFxType(location, index, slot.type);
  
  // Validate value before sending
  let safeValue = slot.value;
  if (typeof safeValue !== 'number' || isNaN(safeValue) || !isFinite(safeValue)) {
      console.warn(`TopPanel: Invalid value detected for ${location} slot ${index}, resetting to 0`);
      safeValue = 0;
  }
  // Clamp to 0-100 (assuming UI uses 0-100)
  safeValue = Math.max(0, Math.min(100, safeValue));

  engine.setFxParam(location, index, safeValue);
  engine.setFxActive(location, index, slot.active);
};

const syncChangedSlots = (
  location: 'input' | 'track',
  newSlots: FxSlot[],
  oldSlots?: FxSlot[]
) => {
  newSlots.forEach((slot, i) => {
    const previous = oldSlots?.[i];
    if (
      previous &&
      previous.type === slot.type &&
      previous.value === slot.value &&
      previous.active === slot.active
    ) {
      return;
    }

    syncSlotToEngine(location, i, slot);
  });
};

const persistSlots = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    inputSlots: inputSlots.value,
    trackSlots: trackSlots.value
  }));
};

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.inputSlots) inputSlots.value = parsed.inputSlots;
      if (parsed.trackSlots) trackSlots.value = parsed.trackSlots;
    } catch (e) {
      console.error('Failed to load Top Panel settings', e);
    }
  }

  // Initialize Engine State
  inputSlots.value.forEach((slot, i) => syncSlotToEngine('input', i, slot));
  trackSlots.value.forEach((slot, i) => syncSlotToEngine('track', i, slot));
});

// Watchers for Real-time Updates
watch(inputSlots, (newSlots, oldSlots) => {
  syncChangedSlots('input', newSlots, oldSlots);
  persistSlots();
}, { deep: true });

watch(trackSlots, (newSlots, oldSlots) => {
  syncChangedSlots('track', newSlots, oldSlots);
  persistSlots();
}, { deep: true });

</script>

<style scoped>
.top-panel {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding: 12px 24px;
  background: var(--bg-panel-secondary);
  border-bottom: 4px solid rgba(0, 0, 0, 0.2);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  z-index: 100;
  height: 180px; /* Fixed height for stability */
}

.fx-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.section-label {
  font-family: var(--font-hardware);
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 2px;
  font-weight: 700;
}

.fx-row {
  display: flex;
  gap: 12px;
  flex-wrap: nowrap;
}

.transport-section {
  flex: 0 0 auto;
  margin: 0 24px;
  display: flex;
  gap: 24px;
  align-items: center;
}

/* Responsive adjustments */
@media (max-width: 1000px) {
  .top-panel {
    height: auto;
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
