<template>
  <section class="hrm-auto-editor" aria-label="HRM AUTO experimental settings" data-hrm-auto-editor>
    <header class="editor-heading">
      <strong>HRM AUTO <span>(EXPERIMENTAL)</span></strong>
      <span>CLEAN-ROOM MIDI HARMONY CONTROLS</span>
    </header>
    <div class="hrm-auto-controls">
      <label class="hrm-auto-control">
        <span>KEY</span>
        <select aria-label="HRM AUTO key" :value="parameters.key" @change="setNumber('key', $event)">
          <option v-for="key in HRM_AUTO_KEY_OPTIONS" :key="key.value" :value="key.value">{{ key.label }}</option>
        </select>
      </label>
      <label class="hrm-auto-control">
        <span>SCALE</span>
        <select aria-label="HRM AUTO scale" :value="parameters.scale" @change="setNumber('scale', $event)">
          <option v-for="scale in HRM_AUTO_SCALE_OPTIONS" :key="scale.value" :value="scale.value">{{ scale.label }}</option>
        </select>
      </label>
      <label class="hrm-auto-control">
        <span>MIDI CHANNEL</span>
        <select aria-label="HRM AUTO MIDI channel" :value="parameters.midiChannel" @change="setNumber('midiChannel', $event)">
          <option v-for="channel in 16" :key="channel" :value="channel">{{ channel }}</option>
        </select>
      </label>
      <label class="hrm-auto-control">
        <span>EFFECT MIX {{ Math.round(parameters.mixPercent) }}%</span>
        <input aria-label="HRM AUTO effect mix percent" type="range" min="0" max="100" step="1" :value="parameters.mixPercent" @input="setNumber('mixPercent', $event)" />
      </label>
    </div>
    <div class="midi-row">
      <button type="button" :disabled="midiState === 'connecting' || midiState === 'unsupported'" @click="toggleMidi">
        {{ midiState === 'connected' ? 'Disconnect MIDI' : midiState === 'connecting' ? 'Connecting…' : 'Connect MIDI' }}
      </button>
      <span role="status" aria-live="polite" data-midi-status>{{ midiStateText }}</span>
    </div>
    <p class="hrm-auto-note">Experimental clean-room control mapping; pitch tracking and harmony voicing may differ from the hardware. MIDI access is requested only after pressing Connect MIDI.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import type { MidiInputState } from '../../audio/MidiInputController';
import {
  HRM_AUTO_KEY_OPTIONS,
  HRM_AUTO_SCALE_OPTIONS,
  createDefaultHrmAutoParameters,
  sanitizeHrmAutoParameters,
  type HrmAutoParameters,
} from '../../audio/hrmAutoParameters';

const props = defineProps<{
  modelValue?: HrmAutoParameters;
  midiTarget: { path: 'input' | 'track'; slot: 'A' | 'B' | 'C' | 'D'; effectId: 'hrm_auto_m' };
}>();
const emit = defineEmits<{ 'update:modelValue': [value: HrmAutoParameters] }>();
const engine = AudioEngine.getInstance();
const parameters = computed(() => sanitizeHrmAutoParameters(props.modelValue ?? createDefaultHrmAutoParameters()));
const midiState = ref<MidiInputState>(engine.getMidiInputState());
let stopListening: (() => void) | undefined;

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
      ? 'Native HRM AUTO must be running and acknowledged in this slot'
      : 'Audio runtime is unavailable';
    case 'permission-denied': return 'MIDI permission denied';
    case 'error': return 'MIDI input error';
    default: return 'MIDI input disconnected';
  }
});

function setNumber(key: keyof HrmAutoParameters, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const value = Number(target.value);
  if (!Number.isFinite(value)) return;
  emit('update:modelValue', sanitizeHrmAutoParameters({ ...parameters.value, [key]: value }));
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
.hrm-auto-editor { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(118, 204, 179, .34); border-radius: 10px; background: rgba(11, 29, 27, .72); color: #f3f3f5; }
.editor-heading, .hrm-auto-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.editor-heading { justify-content: space-between; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .8px; }
.editor-heading > span, .hrm-auto-note { color: rgba(255, 255, 255, .65); }
.editor-heading strong span { color: #83ddbc; }
.hrm-auto-control { display: grid; gap: 4px; min-width: 112px; flex: 1; font-family: var(--font-hardware); font-size: 10px; letter-spacing: .6px; }
.hrm-auto-control input, .hrm-auto-control select { width: 100%; }
.hrm-auto-control select { min-height: 30px; color: #f3f3f5; background: #17191d; border: 1px solid rgba(255, 255, 255, .25); }
.hrm-auto-control input { accent-color: #83ddbc; }
.midi-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font: 10px var(--font-hardware); text-transform: uppercase; }
.midi-row button { min-height: 30px; padding: 0 10px; color: #fff; background: #253a38; border: 1px solid rgba(255, 255, 255, .3); border-radius: 4px; cursor: pointer; }
.midi-row button:disabled { opacity: .5; cursor: not-allowed; }
.hrm-auto-note { margin: 0; font-size: 10px; line-height: 1.4; }
</style>
