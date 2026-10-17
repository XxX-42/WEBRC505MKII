<template>
  <section class="pitch-bend-editor" aria-label="PITCH BEND settings" data-pitch-bend-editor>
    <header class="editor-heading">
      <strong>PITCH BEND</strong>
      <span>ONE-SHOT SWEEP ON ACTIVATE</span>
    </header>
    <div class="bend-controls">
      <label class="bend-control">
        <span>RANGE {{ Math.round(parameters.rangeSemitones) }} ST</span>
        <input aria-label="Pitch bend range in semitones" type="range" min="0" max="24" step="1" :value="parameters.rangeSemitones" @input="setNumber('rangeSemitones', $event)" />
      </label>
      <label class="bend-control">
        <span>TIME {{ Math.round(parameters.timeMs) }} MS</span>
        <input aria-label="Pitch bend time in milliseconds" type="range" min="0" max="100" step="1" :value="timeToSlider(parameters.timeMs)" @input="setTime($event)" />
      </label>
      <label class="bend-control">
        <span>DIRECTION</span>
        <select aria-label="Pitch bend direction" :value="parameters.direction" @change="setNumber('direction', $event)">
          <option :value="0">UP</option>
          <option :value="1">DOWN</option>
        </select>
      </label>
      <label class="bend-control">
        <span>MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input aria-label="Pitch bend mix percent" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      </label>
    </div>
    <p class="bend-note">Activation sweeps from unshifted pitch to the selected interval, then holds. Bypass resets the next activation.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { createDefaultPitchBendParameters, sanitizePitchBendParameters, type PitchBendParameters } from '../../audio/pitchBendParameters';

const props = defineProps<{ modelValue?: PitchBendParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: PitchBendParameters] }>();
const parameters = computed(() => sanitizePitchBendParameters(props.modelValue ?? createDefaultPitchBendParameters()));

// The catalog declares a logarithmic bend-time control from 20 ms to 4 s.
function sliderToTime(position: number): number {
  return 20 * (200 ** (Math.max(0, Math.min(100, position)) / 100));
}
function timeToSlider(timeMs: number): number {
  return Math.round((Math.log(Math.max(20, Math.min(4000, timeMs)) / 20) / Math.log(200)) * 100);
}
function setNumber(key: keyof PitchBendParameters, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  emit('update:modelValue', sanitizePitchBendParameters({ ...parameters.value, [key]: Number(target.value) }));
}
function setTime(event: Event): void {
  const target = event.target as HTMLInputElement;
  emit('update:modelValue', sanitizePitchBendParameters({ ...parameters.value, timeMs: sliderToTime(Number(target.value)) }));
}
</script>

<style scoped>
.pitch-bend-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .bend-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .bend-note { color: rgba(255,255,255,.65); }
.bend-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.bend-control input, .bend-control select { width: 100%; }
.bend-control select { color: #fff; background: #171c27; border: 1px solid rgba(255,255,255,.18); border-radius: 5px; min-height: 26px; }
.bend-note { margin: 0; font-size: 10px; }
</style>
