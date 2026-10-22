<template>
  <div class="rhythm-controls" :class="{ disabled }">
    <div class="section-label">RHYTHM</div>

    <div class="main-row">
      <HardwareButton
        shape="circle"
        size="md"
        :color="isPlaying ? 'red' : 'neutral'"
        :active="isPlaying"
        :disabled="disabled || pending"
        :label="isPlaying ? 'STOP' : 'PLAY'"
        :aria-label="isPlaying ? 'Stop rhythm' : 'Start rhythm'"
        @press="toggleRhythm"
      />

      <div class="params-col">
        <label class="sub-label" for="rhythm-pattern">PATTERN</label>
        <select
          id="rhythm-pattern"
          v-model.number="selection.patternIndex"
          @change="applySelection"
          class="pattern-select"
          data-testid="rhythm-pattern-select"
          :disabled="disabled"
          aria-label="Rhythm pattern catalog"
        >
          <option v-for="pattern in patterns" :key="pattern.id" :value="pattern.globalIndex">
            {{ pattern.globalIndex }} · {{ pattern.genre }} / {{ pattern.pattern }} · {{ pattern.beat }}
          </option>
        </select>

        <details class="rhythm-details" :class="{ 'is-disabled': disabled }">
          <summary aria-label="More rhythm settings">KIT · VARIATION · TIMING</summary>
          <div class="rhythm-settings-popover">
            <label class="setting-field">
              <span class="sub-label">KIT</span>
              <select v-model.number="selection.kitIndex" data-testid="rhythm-kit-select" :disabled="disabled" @change="applySelection">
                <option v-for="kit in kits" :key="kit.index" :value="kit.index">{{ kit.index }} · {{ kit.officialName }}</option>
              </select>
            </label>
            <label class="setting-field">
              <span class="sub-label">VARIATION</span>
              <select v-model="selection.variation" data-testid="rhythm-variation-select" :disabled="disabled" @change="applySelection">
                <option v-for="variation in variations" :key="variation" :value="variation">{{ variation }}</option>
              </select>
            </label>
            <label class="setting-field">
              <span class="sub-label">SECTION</span>
              <select v-model="selection.section" data-testid="rhythm-section-select" :disabled="disabled" @change="applySelection">
                <option v-for="section in sections" :key="section" :value="section">{{ section.toUpperCase() }}</option>
              </select>
            </label>
            <label class="setting-field swing-field">
              <span class="sub-label">SWING <output>{{ selection.swingPercent }}%</output></span>
              <input
                v-model.number="selection.swingPercent"
                type="range"
                min="50"
                max="75"
                step="1"
                data-testid="rhythm-swing"
                aria-label="Rhythm swing percent"
                :disabled="disabled"
                @change="applySelection"
              />
            </label>
            <label class="setting-field">
              <span class="sub-label">QUANTIZE</span>
              <select v-model="selection.quantizeGrid" data-testid="rhythm-quantize-select" :disabled="disabled" @change="applySelection">
                <option v-for="grid in quantizeGrids" :key="grid" :value="grid">{{ grid }}</option>
              </select>
            </label>
            <div class="provenance-note" data-testid="rhythm-provenance">
              Clean-room patterns and timbres; not factory MIDI or samples
            </div>
          </div>
        </details>

        <div class="level-control">
          <span class="sub-label">VOL</span>
          <input
            type="range"
            min="0"
            max="100"
            v-model.number="volume"
            @input="updateVolume"
            class="level-slider hardware-interactive"
            aria-label="Rhythm volume"
            :disabled="disabled"
          />
        </div>
      </div>
    </div>
    <div v-if="message" class="native-note" role="status" data-testid="rhythm-status">{{ message }}</div>
  </div>
</template>

<script setup lang="ts">
import { DRUM_KIT_CATALOG, RHYTHM_PATTERN_CATALOG, RHYTHM_QUANTIZE_GRIDS, RHYTHM_SECTIONS, RHYTHM_VARIATIONS } from '../audio/rhythm';
import { useRhythmUiControls } from '../composables/rhythmUiState';
import HardwareButton from './ui/HardwareButton.vue';

const { selection, isPlaying, volume, disabled, pending, message, toggleRhythm, applySelection, updateVolume } = useRhythmUiControls();
const patterns = RHYTHM_PATTERN_CATALOG;
const kits = DRUM_KIT_CATALOG;
const variations = RHYTHM_VARIATIONS;
const sections = RHYTHM_SECTIONS;
const quantizeGrids = RHYTHM_QUANTIZE_GRIDS;

</script>

<style scoped>
.rhythm-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 92px;
  padding: 0 12px;
  border-left: 1px solid #333;
  border-right: 1px solid #333;
}

.rhythm-controls.disabled {
  opacity: 0.45;
}

.native-note {
  max-width: 190px;
  font-size: 12px;
  font-family: var(--font-hardware);
  letter-spacing: 1px;
  line-height: 1.3;
  text-align: center;
  color: #777;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}

.section-label {
  font-family: var(--font-hardware);
  font-size: 12px;
  color: #666;
  letter-spacing: 2px;
  font-weight: 700;
}

.main-row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  padding-bottom: 2px;
}

.params-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rhythm-controls {
  position: relative;
}

.pattern-select {
  background: var(--bg-groove-dark);
  color: var(--led-blue-accent);
  border: 1px solid #333;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 13px;
  border-radius: 4px;
  outline: none;
  cursor: pointer;
  text-transform: uppercase;
  width: 148px;
}

.rhythm-details {
  position: relative;
  color: var(--led-blue-accent);
  font-family: var(--font-mono);
  font-size: 12px;
}

.rhythm-details summary {
  cursor: pointer;
  color: #8a8a91;
  letter-spacing: 0.45px;
  list-style-position: inside;
}

.rhythm-details.is-disabled summary {
  cursor: not-allowed;
}

.rhythm-settings-popover {
  position: absolute;
  z-index: 500;
  top: 17px;
  right: -6px;
  width: 232px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px 10px;
  padding: 10px;
  border: 1px solid #3e4852;
  border-radius: 5px;
  background: #111820;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
}

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.setting-field select {
  width: 100%;
  min-width: 0;
  background: #18232d;
  color: var(--led-blue-accent);
  border: 1px solid #394550;
  border-radius: 3px;
  padding: 3px;
  font-family: var(--font-mono);
  font-size: 13px;
}

.swing-field {
  grid-column: span 2;
}

.swing-field .sub-label {
  display: flex;
  justify-content: space-between;
}

.swing-field input {
  width: 100%;
}

.provenance-note {
  grid-column: span 2;
  color: #a0a6ad;
  font-size: 12px;
  line-height: 1.35;
  text-transform: uppercase;
}

.pattern-select:hover,
.pattern-select:focus-visible {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px rgba(0, 153, 255, 0.3);
}

.level-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sub-label {
  font-size: 12px;
  color: #666;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.6px;
}

.level-slider {
  width: 58px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #333;
  border-radius: 2px;
  outline: none;
}

.level-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #aaa;
  cursor: pointer;
  transition: background 0.2s;
}

.level-slider::-webkit-slider-thumb:hover {
  background: #fff;
}
</style>
