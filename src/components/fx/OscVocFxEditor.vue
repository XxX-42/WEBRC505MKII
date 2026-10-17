<template>
  <section class="osc-voc-editor" aria-label="OSC VOC (M) settings" data-osc-voc-editor>
    <div class="editor-title">OSC VOC (M)</div>
    <label class="control-row">
      <span>Carrier waveform</span>
      <select aria-label="OSC VOC carrier waveform" :value="parameters.waveform" @change="setNumber('waveform', $event)">
        <option :value="0">Saw</option>
        <option :value="1">Square</option>
        <option :value="2">Pulse</option>
      </select>
    </label>
    <label class="control-row">
      <span>MIDI channel</span>
      <select aria-label="OSC VOC MIDI channel" :value="parameters.midiChannel" @change="setNumber('midiChannel', $event)">
        <option v-for="channel in 16" :key="channel" :value="channel">{{ channel }}</option>
      </select>
    </label>
    <label class="control-row">
      <span>Carrier transpose</span>
      <input aria-label="OSC VOC octave transpose" type="range" min="-24" max="24" step="1" :value="parameters.octaveSemitones" @input="setNumber('octaveSemitones', $event)" />
      <output>{{ parameters.octaveSemitones }} st</output>
    </label>
    <label class="control-row">
      <span>Effect mix</span>
      <input aria-label="OSC VOC effect mix" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      <output>{{ Math.round(parameters.mixPercent) }}%</output>
    </label>
    <div class="midi-row">
      <button type="button" :disabled="midiState === 'connecting' || midiState === 'unsupported'" @click="toggleMidi">
        {{ midiState === 'connected' ? 'Disconnect MIDI' : midiState === 'connecting' ? 'Connecting…' : 'Connect MIDI' }}
      </button>
      <span role="status" aria-live="polite" data-midi-status>{{ midiStateText }}</span>
    </div>
    <p class="hint">MIDI permission is requested only when Connect MIDI is pressed. {{ carrierVoiceHint }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AudioEngine, type OscVocMidiTarget } from '../../audio/AudioEngine';
import type { MidiInputState } from '../../audio/MidiInputController';
import { sanitizeOscVocParameters, type OscVocParameters } from '../../audio/oscVocParameters';

const props = defineProps<{ modelValue: OscVocParameters; midiTarget: OscVocMidiTarget }>();
const emit = defineEmits<{ 'update:modelValue': [value: OscVocParameters] }>();
const engine = AudioEngine.getInstance();
const parameters = ref(sanitizeOscVocParameters(props.modelValue));
const midiState = ref<MidiInputState>(engine.getMidiInputState());
const carrierVoiceHint = computed(() => engine.getMode() === 'native'
  ? 'Native follows up to 8 held MIDI notes.'
  : 'One monophonic carrier follows the latest held note.');
let stopListening: (() => void) | undefined;

watch(() => props.modelValue, (value) => { parameters.value = sanitizeOscVocParameters(value); }, { deep: true });
onMounted(() => { stopListening = engine.onMidiInputStateChange((state) => { midiState.value = state; }); });
onBeforeUnmount(() => stopListening?.());
watch(() => [props.midiTarget.path, props.midiTarget.slot] as const, () => {
  if (midiState.value === 'connected' && engine.getMode() === 'native') engine.disconnectMidiInput();
});

const midiStateText = computed(() => {
  switch (midiState.value) {
    case 'connected': return 'MIDI input connected';
    case 'connecting': return 'Waiting for MIDI permission';
    case 'unsupported': return 'Web MIDI unavailable in this runtime/browser';
    case 'runtime-unavailable': return engine.getMode() === 'native'
      ? 'Native OSC VOC must be running and acknowledged in this slot'
      : 'Audio runtime is unavailable';
    case 'permission-denied': return 'MIDI permission denied';
    case 'error': return 'MIDI input error';
    default: return 'MIDI input disconnected';
  }
});

function setNumber(key: keyof OscVocParameters, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const value = Number(target.value);
  if (!Number.isFinite(value)) return;
  const next = sanitizeOscVocParameters({ ...parameters.value, [key]: value });
  parameters.value = next;
  emit('update:modelValue', next);
}

async function toggleMidi(): Promise<void> {
  if (midiState.value === 'connected') {
    engine.disconnectMidiInput();
    return;
  }
  midiState.value = await engine.connectMidiInput(props.midiTarget);
}
</script>

<style scoped>
.osc-voc-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(255, 255, 255, .16); border-radius: 6px; color: #f3f3f5; }
.editor-title { font: 700 11px var(--font-hardware); letter-spacing: 1px; text-transform: uppercase; }
.control-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(90px, 1.4fr) auto; align-items: center; gap: 8px; font: 10px var(--font-hardware); text-transform: uppercase; }
.control-row select { grid-column: 2 / span 2; min-height: 30px; color: #f3f3f5; background: #17191d; border: 1px solid rgba(255, 255, 255, .25); }
.control-row input { width: 100%; accent-color: #d08dff; }
.midi-row { display: flex; align-items: center; gap: 10px; font: 10px var(--font-hardware); text-transform: uppercase; }
.midi-row button { min-height: 30px; padding: 0 10px; color: #fff; background: #2e3140; border: 1px solid rgba(255, 255, 255, .3); border-radius: 4px; cursor: pointer; }
.midi-row button:disabled { opacity: .5; cursor: not-allowed; }
.hint { margin: 0; color: rgba(255, 255, 255, .62); font: 9px/1.4 var(--font-hardware); }
</style>
