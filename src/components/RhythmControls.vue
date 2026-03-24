<template>
  <div class="rhythm-controls" :class="{ disabled }">
    <div class="section-label">RHYTHM</div>

    <div class="main-row">
      <HardwareButton
        shape="circle"
        size="md"
        :color="isPlaying ? 'red' : 'neutral'"
        :active="isPlaying"
        :label="isPlaying ? 'STOP' : 'PLAY'"
        :aria-label="isPlaying ? 'Stop rhythm' : 'Start rhythm'"
        @press="toggleRhythm"
      />

      <div class="params-col">
        <label class="sub-label" for="rhythm-pattern">PATTERN</label>
        <select
          id="rhythm-pattern"
          v-model="selectedPattern"
          @change="updatePattern"
          class="pattern-select"
          :disabled="disabled"
        >
          <option value="ROCK">ROCK</option>
          <option value="TECHNO">TECHNO</option>
          <option value="METRONOME">METRO</option>
        </select>

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
    <div v-if="disabled" class="native-note">Native v1 unavailable</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { RhythmPattern } from '../audio/RhythmEngine';
import HardwareButton from './ui/HardwareButton.vue';

const engine = AudioEngine.getInstance();
const isPlaying = ref(false);
const selectedPattern = ref<RhythmPattern>('ROCK');
const volume = ref(50);
const disabled = computed(() => !engine.supportsRhythm());

const toggleRhythm = () => {
  if (disabled.value) return;
  if (isPlaying.value) {
    engine.rhythmEngine.stop();
    isPlaying.value = false;
  } else {
    engine.rhythmEngine.start();
    isPlaying.value = true;
  }
};

const updatePattern = () => {
  if (disabled.value) return;
  engine.rhythmEngine.setPattern(selectedPattern.value);
};

const updateVolume = () => {
  if (disabled.value) return;
  engine.rhythmEngine.setVolume(volume.value);
};

onMounted(() => {
  engine.rhythmEngine.setVolume(volume.value);
  engine.rhythmEngine.setPattern(selectedPattern.value);
});
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
  font-size: 9px;
  font-family: var(--font-hardware);
  letter-spacing: 1px;
  color: #777;
  text-transform: uppercase;
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

.pattern-select {
  background: var(--bg-groove-dark);
  color: var(--led-blue-accent);
  border: 1px solid #333;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  border-radius: 4px;
  outline: none;
  cursor: pointer;
  text-transform: uppercase;
  width: 84px;
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
  font-size: 9px;
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
