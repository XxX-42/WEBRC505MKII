<template>
  <section class="rhythm-editor" aria-label="Rhythm pattern and kit editor">
    <header class="editor-header">
      <div>
        <p class="eyebrow">RHYTHM / PATTERN + KIT</p>
        <h2>Pattern and Voice Editor</h2>
      </div>
      <button
        type="button"
        class="run-button"
        :class="{ running: draft?.enabled }"
        :disabled="!canEdit || busy || !draft"
        @click="toggleRhythm"
      >
        {{ draft?.enabled ? 'STOP' : 'START' }}
      </button>
    </header>

    <p v-if="unavailableReason" class="notice" role="status">{{ unavailableReason }}</p>
    <p v-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <div v-if="!draft" class="loading-row">
      <span>RHYTHM ENGINE SNAPSHOT NOT AVAILABLE</span>
      <button type="button" :disabled="busy || !canEdit" @click="refresh">RETRY</button>
    </div>

    <template v-else>
      <div class="runtime-row">
        <label class="volume-control">
          <span>RHYTHM LEVEL · {{ Math.round(draft.volume * 100) }}%</span>
          <input
            v-model.number="draft.volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            aria-label="Rhythm output level"
            :disabled="!canEdit || busy"
          >
        </label>
        <label class="name-control">
          <span>PATTERN NAME</span>
          <input v-model.trim="draft.pattern.name" maxlength="128" :disabled="!canEdit || busy" aria-label="Pattern name">
        </label>
        <label class="number-control">
          <span>STEPS</span>
          <input
            :value="draft.pattern.steps"
            type="number"
            min="1"
            max="64"
            step="1"
            :disabled="!canEdit || busy"
            aria-label="Pattern step count"
            @change="changeSteps"
          >
        </label>
        <label class="number-control">
          <span>STEPS / BEAT</span>
          <input
            v-model.number="draft.pattern.stepsPerBeat"
            type="number"
            min="1"
            max="8"
            step="1"
            :disabled="!canEdit || busy"
            aria-label="Pattern steps per beat"
          >
        </label>
      </div>

      <div class="pattern-editor">
        <div class="lane-select" role="tablist" aria-label="Rhythm instrument lanes">
          <button
            v-for="voice in voices"
            :key="voice"
            type="button"
            role="tab"
            :aria-selected="selectedVoice === voice"
            :class="{ selected: selectedVoice === voice }"
            @click="selectedVoice = voice"
          >
            {{ voice.toUpperCase() }}
          </button>
        </div>
        <div class="step-grid" :style="stepGridStyle" role="group" :aria-label="`${selectedVoice} velocity steps`">
          <button
            v-for="(velocity, index) in selectedLane?.velocities ?? []"
            :key="index"
            type="button"
            class="step-cell"
            :class="{ active: velocity > 0, selected: selectedStep === index }"
            :aria-label="`${selectedVoice} step ${index + 1}, velocity ${Math.round(velocity * 127)}`"
            :aria-pressed="velocity > 0"
            @click="toggleStep(index)"
          >
            <span>{{ index + 1 }}</span>
            <i :style="{ height: `${Math.round(velocity * 100)}%` }"></i>
          </button>
        </div>
        <label class="velocity-control">
          <span>STEP {{ selectedStep + 1 }} VELOCITY · {{ Math.round(selectedVelocity * 127) }}</span>
          <input
            v-model.number="selectedVelocity"
            type="range"
            min="0"
            max="1"
            step="0.01"
            aria-label="Selected rhythm step velocity"
            :disabled="!canEdit || busy"
          >
        </label>
      </div>

      <section class="kit-editor" aria-label="Rhythm kit editor">
        <div class="section-heading">
          <div>
            <p class="eyebrow">SYNTHESIZED VOICES</p>
            <h3>{{ draft.kit.name }}</h3>
          </div>
          <div class="file-actions">
            <button type="button" :disabled="!canEdit || busy" @click="kitFileInput?.click()">IMPORT KIT JSON</button>
            <button type="button" :disabled="!draft" @click="exportKit">EXPORT KIT JSON</button>
            <input ref="kitFileInput" type="file" accept="application/json,.json" hidden @change="importKit">
          </div>
        </div>

        <div class="kit-grid">
          <fieldset v-for="voice in voices" :key="voice" :disabled="!canEdit || busy">
            <legend>{{ voice.toUpperCase() }}</legend>
            <label>
              <span>PITCH · Hz</span>
              <input :value="draft.kit.voices[voice].pitchHz" type="number" min="20" max="12000" step="1" @change="changeKitValue(voice, 'pitchHz', $event)">
            </label>
            <label>
              <span>DECAY · ms</span>
              <input :value="draft.kit.voices[voice].decayMs" type="number" min="1" max="10000" step="1" @change="changeKitValue(voice, 'decayMs', $event)">
            </label>
            <label>
              <span>NOISE</span>
              <input :value="draft.kit.voices[voice].noiseAmount" type="number" min="0" max="1" step="0.01" @change="changeKitValue(voice, 'noiseAmount', $event)">
            </label>
            <label>
              <span>TONE GAIN</span>
              <input :value="draft.kit.voices[voice].toneGain" type="number" min="0" max="2" step="0.01" @change="changeKitValue(voice, 'toneGain', $event)">
            </label>
          </fieldset>
        </div>
      </section>

      <footer class="editor-footer">
        <div class="file-actions">
          <button type="button" :disabled="!canEdit || busy" @click="patternFileInput?.click()">IMPORT PATTERN JSON</button>
          <button type="button" :disabled="!draft" @click="exportPattern">EXPORT PATTERN JSON</button>
          <input ref="patternFileInput" type="file" accept="application/json,.json" hidden @change="importPattern">
        </div>
        <span class="status-message" :class="{ error: Boolean(actionError) }" role="status">{{ statusMessage }}</span>
        <button type="button" class="apply-button" :disabled="!canEdit || busy || !draft" @click="applyDraft">
          {{ busy ? 'WAITING FOR RHYTHM ENGINE…' : 'APPLY AT BEAT BOUNDARY' }}
        </button>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { RhythmKitDocument, RhythmPatternDocument, RhythmRuntimeSnapshot, RhythmVoice, RhythmVoiceSettings } from '../audio/rhythmTypes';
import {
  parseRhythmKitDocument,
  parseRhythmPatternDocument,
  parseRhythmRuntimeSnapshot,
} from '../controls/rhythmDocuments';

const engine = AudioEngine.getInstance();
const voices: readonly RhythmVoice[] = ['kick', 'snare', 'hat'];
const snapshot = ref<RhythmRuntimeSnapshot | null>(null);
const draft = ref<RhythmRuntimeSnapshot | null>(null);
const selectedVoice = ref<RhythmVoice>('kick');
const selectedStep = ref(0);
const busy = ref(false);
const loadError = ref('');
const actionError = ref('');
const actionStatus = ref('');
const patternFileInput = ref<HTMLInputElement | null>(null);
const kitFileInput = ref<HTMLInputElement | null>(null);
let unsubscribeStatus: (() => void) | null = null;

const canEdit = computed(() => engine.getMode() === 'browser' && engine.getCapabilities().supportsRhythm);
const unavailableReason = computed(() => engine.getCapabilities().supportsRhythm ? '' : engine.getCapabilities().rhythmReason);
const selectedLane = computed(() => draft.value?.pattern.lanes.find((lane) => lane.voice === selectedVoice.value) ?? null);
const selectedVelocity = computed({
  get: () => selectedLane.value?.velocities[selectedStep.value] ?? 0,
  set: (value: number) => {
    const lane = selectedLane.value;
    if (!lane) return;
    lane.velocities[selectedStep.value] = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  },
});
const stepGridStyle = computed(() => ({ gridTemplateColumns: `repeat(${draft.value?.pattern.steps ?? 1}, minmax(26px, 1fr))` }));
const statusMessage = computed(() => actionError.value || actionStatus.value || (busy.value ? 'WAITING FOR BEAT-BOUNDARY ACKNOWLEDGEMENT' : 'DRAFT CHANGES ARE NOT ACTIVE UNTIL APPLIED'));

async function refresh() {
  if (!canEdit.value) {
    snapshot.value = null;
    draft.value = null;
    return;
  }
  busy.value = true;
  loadError.value = '';
  try {
    const loaded = parseRhythmRuntimeSnapshot(await engine.getRhythmSnapshot());
    snapshot.value = loaded;
    draft.value = structuredClone(loaded);
    selectedStep.value = Math.min(selectedStep.value, loaded.pattern.steps - 1);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function applySnapshot(next: RhythmRuntimeSnapshot, successMessage: string) {
  if (!canEdit.value || busy.value) return;
  busy.value = true;
  actionError.value = '';
  actionStatus.value = '';
  try {
    const validated = parseRhythmRuntimeSnapshot(next);
    await engine.applyRhythmSnapshot(validated);
    const actual = parseRhythmRuntimeSnapshot(await engine.getRhythmSnapshot());
    snapshot.value = actual;
    draft.value = structuredClone(actual);
    actionStatus.value = successMessage;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

const applyDraft = () => {
  if (!draft.value) return;
  void applySnapshot(draft.value, 'RHYTHM ENGINE ACKNOWLEDGED PATTERN AND KIT.');
};

const toggleRhythm = () => {
  if (!draft.value) return;
  void applySnapshot({ ...draft.value, enabled: !draft.value.enabled }, draft.value.enabled ? 'RHYTHM STOP ACKNOWLEDGED.' : 'RHYTHM START ACKNOWLEDGED.');
};

function changeSteps(event: Event) {
  if (!draft.value) return;
  const steps = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 64) {
    actionError.value = 'STEP COUNT MUST BE AN INTEGER FROM 1 TO 64.';
    return;
  }
  const current = draft.value.pattern.steps;
  for (const lane of draft.value.pattern.lanes) {
    if (steps < current) lane.velocities.length = steps;
    else while (lane.velocities.length < steps) lane.velocities.push(0);
  }
  draft.value.pattern.steps = steps;
  selectedStep.value = Math.min(selectedStep.value, steps - 1);
  actionError.value = '';
}

function toggleStep(index: number) {
  const lane = selectedLane.value;
  if (!lane) return;
  selectedStep.value = index;
  lane.velocities[index] = (lane.velocities[index] ?? 0) > 0 ? 0 : 0.8;
}

function changeKitValue(voice: RhythmVoice, parameter: keyof RhythmVoiceSettings, event: Event) {
  if (!draft.value) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) {
    actionError.value = `${voice.toUpperCase()} ${parameter} MUST BE A FINITE NUMBER.`;
    return;
  }
  draft.value.kit.voices[voice][parameter] = value;
  actionError.value = '';
}

async function readJsonFile(event: Event): Promise<unknown> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) throw new Error('No file was selected.');
  return JSON.parse(await file.text()) as unknown;
}

async function importPattern(event: Event) {
  if (!draft.value) return;
  actionError.value = '';
  try {
    const imported = parseRhythmPatternDocument(await readJsonFile(event));
    draft.value = { ...draft.value, pattern: imported };
    selectedStep.value = Math.min(selectedStep.value, imported.steps - 1);
    actionStatus.value = `LOADED ${imported.name}; APPLY TO SEND IT TO THE AUDIO ENGINE.`;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function importKit(event: Event) {
  if (!draft.value) return;
  actionError.value = '';
  try {
    const imported = parseRhythmKitDocument(await readJsonFile(event));
    draft.value = { ...draft.value, kit: imported };
    actionStatus.value = `LOADED ${imported.name}; APPLY TO SEND IT TO THE AUDIO ENGINE.`;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

function downloadJson(value: RhythmPatternDocument | RhythmKitDocument, suffix: 'pattern' | 'kit') {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFileName(value.name)}-${suffix}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const exportPattern = () => { if (draft.value) downloadJson(draft.value.pattern, 'pattern'); };
const exportKit = () => { if (draft.value) downloadJson(draft.value.kit, 'kit'); };
const safeFileName = (value: string) => value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'rhythm';

onMounted(() => {
  void refresh();
  unsubscribeStatus = engine.onStatusChange(() => void refresh());
});

onUnmounted(() => unsubscribeStatus?.());
</script>

<style scoped>
.rhythm-editor {
  display: grid;
  gap: 16px;
  min-width: min(740px, calc(100vw - 48px));
  max-width: 1040px;
  padding: 18px;
  color: #eef1f6;
  font-family: var(--font-hardware);
}

.editor-header,
.section-heading,
.editor-footer,
.runtime-row,
.file-actions { display: flex; align-items: center; gap: 10px; }
.editor-header,
.section-heading,
.editor-footer { justify-content: space-between; }
.editor-header h2,
.section-heading h3 { margin: 3px 0 0; font-size: 16px; letter-spacing: 1px; }
.eyebrow { margin: 0; color: #9da8b7; font-size: 9px; letter-spacing: 1.5px; }
.run-button,
button,
.loading-row button {
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 6px;
  background: #242933;
  color: #e8edf5;
  cursor: pointer;
  font: 10px var(--font-hardware);
  letter-spacing: .6px;
}
.run-button { min-width: 76px; min-height: 36px; }
.run-button.running { border-color: #ed4652; color: #ff7f87; box-shadow: 0 0 12px rgba(255,46,65,.18); }
button { min-height: 32px; padding: 0 10px; }
button:disabled { opacity: .42; cursor: not-allowed; }
.help-text,
.notice,
.error { margin: 0; font-size: 11px; line-height: 1.5; color: #a6afbd; }
.error { color: #ff9198; }
.loading-row { display: flex; justify-content: space-between; align-items: center; color: #bdc7d6; font-size: 11px; }
.runtime-row { flex-wrap: wrap; align-items: end; }
.runtime-row label,
.kit-grid label { display: grid; gap: 6px; min-width: 90px; }
.runtime-row label > span,
.kit-grid label > span,
.velocity-control > span { color: #aeb8c6; font-size: 9px; letter-spacing: .8px; }
.volume-control { flex: 1 1 170px; }
.volume-control input,
.velocity-control input { width: 100%; accent-color: #e74a57; }
.name-control { flex: 1 1 170px; }
.number-control { flex: 0 1 110px; }
input[type="number"],
input[type="text"],
input:not([type]) { min-height: 30px; padding: 0 7px; }
.runtime-row input:not([type="range"]),
.kit-grid input {
  width: 100%; min-height: 32px; padding: 0 7px; border: 1px solid rgba(255,255,255,.14); border-radius: 5px;
  background: #15181e; color: #eef1f6; font: 11px var(--font-mono);
}
.pattern-editor { display: grid; gap: 10px; padding: 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; background: rgba(0,0,0,.15); }
.lane-select { display: flex; gap: 6px; }
.lane-select button.selected { border-color: #579de8; color: #9acaff; }
.step-grid { display: grid; gap: 3px; overflow-x: auto; padding-bottom: 4px; }
.step-cell { position: relative; min-width: 26px; height: 48px; padding: 4px 2px; overflow: hidden; color: #929baa; font: 8px var(--font-mono); }
.step-cell:nth-child(4n + 1) { border-color: rgba(93,157,221,.56); }
.step-cell.active { color: #f3f6fa; background: #353d4a; }
.step-cell.selected { outline: 1px solid #70b7ff; outline-offset: -2px; }
.step-cell i { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(0deg,#ed4351,#ff9198); opacity: .8; }
.step-cell span { position: relative; z-index: 1; }
.velocity-control { display: grid; gap: 6px; max-width: 320px; }
.kit-editor { display: grid; gap: 10px; }
.kit-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; }
.kit-grid fieldset { display: grid; gap: 8px; min-width: 0; padding: 10px; border: 1px solid rgba(255,255,255,.12); border-radius: 7px; }
.kit-grid legend { padding: 0 5px; color: #ffb0b7; font-size: 10px; letter-spacing: 1px; }
.file-actions { flex-wrap: wrap; }
.status-message { flex: 1; min-width: 180px; color: #abc4e1; font-size: 9px; line-height: 1.5; }
.status-message.error { color: #ff9198; }
.apply-button { min-height: 38px; color: #b9ddff; border-color: rgba(84,165,232,.45); }

@media (max-width: 760px) {
  .rhythm-editor { min-width: 0; }
  .kit-grid { grid-template-columns: 1fr; }
  .editor-footer { align-items: stretch; flex-direction: column; }
  .step-grid { grid-template-columns: repeat(8, minmax(26px,1fr)) !important; }
}
</style>
