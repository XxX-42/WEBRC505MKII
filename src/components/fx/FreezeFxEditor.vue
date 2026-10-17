<template>
  <section class="freeze-editor" aria-label="FREEZE settings" data-freeze-editor>
    <header class="editor-heading">
      <strong>FREEZE</strong>
      <span>MICRO-LOOP / CLEAN-ROOM MODEL</span>
    </header>
    <div class="freeze-controls">
      <label class="freeze-control">
        <span>CAPTURE {{ Math.round(parameters.captureLengthMs) }} ms</span>
        <input aria-label="FREEZE capture length milliseconds" type="range" min="2" max="2000" step="1" :value="parameters.captureLengthMs" @input="setNumber('captureLengthMs', $event)" />
      </label>
      <label class="freeze-control">
        <span>PITCH {{ signed(parameters.pitchSemitones) }} st</span>
        <input aria-label="FREEZE pitch semitones" type="range" min="-24" max="24" step="1" :value="parameters.pitchSemitones" @input="setNumber('pitchSemitones', $event)" />
      </label>
      <button
        type="button"
        class="freeze-toggle"
        :class="{ held: parameters.frozen }"
        :aria-pressed="parameters.frozen"
        aria-label="Capture or release FREEZE loop"
        @click="emitParameters({ ...parameters, frozen: !parameters.frozen })"
      >
        {{ parameters.frozen ? 'RELEASE' : 'CAPTURE / HOLD' }}
      </button>
    </div>
    <p class="freeze-note">Micro-loop mode only. Spectral freeze is unavailable. Captured audio is volatile and resets on reload.</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { createDefaultFreezeParameters, sanitizeFreezeParameters, type FreezeParameters } from '../../audio/freezeParameters';

const props = defineProps<{ modelValue?: FreezeParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: FreezeParameters] }>();
const parameters = computed(() => sanitizeFreezeParameters(props.modelValue ?? createDefaultFreezeParameters()));
function signed(value: number): string { return value > 0 ? `+${Math.round(value)}` : `${Math.round(value)}`; }
function emitParameters(value: unknown): void { emit('update:modelValue', sanitizeFreezeParameters(value)); }
function setNumber(key: 'captureLengthMs' | 'pitchSemitones', event: Event): void {
  const target = event.target as HTMLInputElement;
  emitParameters({ ...parameters.value, [key]: Number(target.value) });
}
</script>

<style scoped>
.freeze-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(110,185,255,.28); border-radius: 10px; background: rgba(13,21,32,.72); color: #f3f3f5; }
.editor-heading, .freeze-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading span, .freeze-note { color: rgba(255,255,255,.65); }
.freeze-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.freeze-control input { width: 100%; }
.freeze-toggle { min-height: 36px; padding: 0 12px; border: 1px solid rgba(255,255,255,.4); border-radius: 6px; background: #1b2230; color: #fff; font-family: var(--font-hardware); font-size: 10px; }
.freeze-toggle.held { border-color: #71d5ff; color: #71d5ff; }
.freeze-note { margin: 0; font-size: 10px; }
</style>
