<template>
  <section class="roll-editor" aria-label="ROLL settings" data-roll-editor>
    <header class="editor-heading">
      <strong>ROLL</strong>
      <span>QUANTIZED STEREO SLICE / CLEAN-ROOM MODEL</span>
    </header>
    <div class="roll-controls">
      <label class="roll-control">
        <span>SLICE</span>
        <select aria-label="ROLL slice length in beats" :value="parameters.sliceBeats" @change="setNumber('sliceBeats', $event)">
          <option v-for="slice in slices" :key="slice" :value="slice">{{ sliceLabel(slice) }}</option>
        </select>
      </label>
      <label class="roll-control">
        <span>DECAY {{ Math.round(parameters.decayPercent) }}%</span>
        <input aria-label="ROLL decay percent" type="range" min="0" max="100" step="1" :value="parameters.decayPercent" @input="setNumber('decayPercent', $event)" />
      </label>
      <label class="roll-control">
        <span>PITCH {{ signed(parameters.pitchSemitones) }} st</span>
        <input aria-label="ROLL pitch semitones" type="range" min="-24" max="24" step="1" :value="parameters.pitchSemitones" @input="setNumber('pitchSemitones', $event)" />
      </label>
      <label class="roll-control">
        <span>DIRECTION</span>
        <select aria-label="ROLL playback direction" :value="parameters.direction" @change="setNumber('direction', $event)">
          <option :value="0">FORWARD</option>
          <option :value="1">REVERSE</option>
          <option :value="2">ALTERNATE</option>
        </select>
      </label>
    </div>
    <p class="roll-note">Auto-captures and retriggers while active. Pitch changes playback rate and slice duration.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ROLL_SLICE_BEATS, createDefaultRollParameters, sanitizeRollParameters, type RollParameters } from '../../audio/rollParameters';

const props = defineProps<{ modelValue?: RollParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: RollParameters] }>();
const parameters = computed(() => sanitizeRollParameters(props.modelValue ?? createDefaultRollParameters()));
const slices = ROLL_SLICE_BEATS;
function sliceLabel(beats: number): string {
  if (beats === 0.25) return '1/16 note';
  if (beats === 0.5) return '1/8 note';
  if (beats === 1) return '1/4 note';
  if (beats === 2) return '1/2 note';
  return '1 bar (4 beats)';
}
function signed(value: number): string { return value > 0 ? `+${value}` : `${value}`; }
function setNumber(key: keyof RollParameters, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  emit('update:modelValue', sanitizeRollParameters({ ...parameters.value, [key]: Number(target.value) }));
}
</script>

<style scoped>
.roll-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .roll-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .roll-note { color: rgba(255,255,255,.65); }
.roll-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.roll-control input, .roll-control select { width: 100%; }
.roll-note { margin: 0; font-size: 10px; }
</style>
