<template>
  <section class="control-assign-panel" aria-labelledby="control-assign-title">
    <header class="panel-heading">
      <div>
        <h2 id="control-assign-title">Controls / Assign 16</h2>
        <p>Keyboard shortcuts and MIDI controls use the same audio command path.</p>
      </div>
      <button class="midi-enable" type="button" :disabled="midiState === 'enabling'" @click="enableMidi">
        {{ midiState === 'enabled' ? 'REFRESH MIDI' : midiState === 'unsupported' ? 'MIDI UNAVAILABLE' : 'ENABLE WEB MIDI' }}
      </button>
    </header>

    <p class="midi-status" role="status">{{ midiMessage }}</p>
    <div v-if="midiInputs.length" class="midi-inputs">
      <span v-for="input in midiInputs" :key="input.id" class="midi-input-chip">
        {{ input.name }} · {{ input.state }}
      </span>
    </div>

    <div class="shortcut-legend">
      <span><kbd>1–5</kbd> record / play track</span>
      <span><kbd>Shift</kbd> + <kbd>1–5</kbd> stop track</span>
      <span><kbd>Space</kbd> stop all</span>
      <span><kbd>Z</kbd> undo</span>
      <span><kbd>Y</kbd> redo</span>
      <span><kbd>M</kbd> mark</span>
      <span><kbd>B</kbd> bounce selected track to next</span>
      <span>MIDI Start / Stop controls all tracks; Clock follows tempo; Program Change 1–99 loads Memory 01–99.</span>
    </div>

    <div class="assignments" role="table" aria-label="Sixteen MIDI assignments">
      <div class="assignment-row assignment-header" role="row">
        <span>Slot</span><span>Enable</span><span>Input</span><span>Channel</span><span>Number</span><span>Trigger</span><span>Command</span><span>Track</span><span>Memory</span>
      </div>
      <div v-for="(assignment, index) in rows" :key="index" class="assignment-row" role="row">
        <label class="slot-label" :for="`assign-enabled-${index}`">{{ String(index + 1).padStart(2, '0') }}</label>
        <select :id="`assign-enabled-${index}`" :value="assignment ? 'on' : 'off'" :aria-label="`Assign ${index + 1} enabled`" @change="setEnabled(index, $event)">
          <option value="off">OFF</option>
          <option value="on">ON</option>
        </select>
        <template v-if="assignment">
          <select :value="assignment.source" :aria-label="`Assign ${index + 1} input`" @change="update(index, 'source', $event)">
            <option value="cc">MIDI CC</option>
            <option value="foot">FOOTSWITCH</option>
            <option value="expression">EXPRESSION</option>
            <option value="note">NOTE</option>
          </select>
          <select :value="assignment.channel ?? 'omni'" :aria-label="`Assign ${index + 1} channel`" @change="update(index, 'channel', $event)">
            <option value="omni">OMNI</option>
            <option v-for="channel in 16" :key="channel" :value="channel">CH {{ channel }}</option>
          </select>
          <input :value="assignment.number" type="number" min="0" max="127" :aria-label="`Assign ${index + 1} control number`" @change="update(index, 'number', $event)">
          <select :value="assignment.trigger" :aria-label="`Assign ${index + 1} trigger mode`" @change="update(index, 'trigger', $event)">
            <option value="press">PRESS</option>
            <option value="release">RELEASE</option>
            <option v-if="assignment.source === 'cc' || assignment.source === 'expression'" value="value">VALUE</option>
          </select>
          <select :value="assignment.command" :aria-label="`Assign ${index + 1} command`" @change="update(index, 'command', $event)">
            <option value="record-track">REC / PLAY</option>
            <option value="stop-track">STOP TRACK</option>
            <option value="clear-track">CLEAR TRACK</option>
            <option value="play-all">PLAY ALL</option>
            <option value="stop-all">STOP ALL</option>
            <option value="toggle-transport">TOGGLE ALL</option>
            <option value="undo">UNDO</option>
            <option value="redo">REDO</option>
            <option value="mark">MARK</option>
            <option value="bounce">BOUNCE</option>
            <option value="load-memory">LOAD MEMORY (NUMBER)</option>
            <option v-if="assignment.source !== 'expression'" value="set-track-fx-send">TRACK FX SEND ON / OFF</option>
            <option v-if="assignment.source === 'cc' || assignment.source === 'expression'" value="set-track-level">TRACK LEVEL (EXPRESSION)</option>
            <option v-if="assignment.source === 'cc' || assignment.source === 'expression'" value="set-track-pan">TRACK PAN (EXPRESSION)</option>
            <option v-if="assignment.source === 'cc' || assignment.source === 'expression'" value="set-tempo">TEMPO (EXPRESSION)</option>
          </select>
          <select :value="assignment.trackId" :aria-label="`Assign ${index + 1} track`" @change="update(index, 'trackId', $event)">
            <option v-for="trackId in 5" :key="trackId" :value="trackId">TRK {{ trackId }}</option>
          </select>
          <select :value="assignment.memoryId ?? Math.min(99, assignment.number + 1)" :disabled="assignment.command !== 'load-memory'" :aria-label="`Assign ${index + 1} memory target`" @change="update(index, 'memoryId', $event)">
            <option v-for="memoryId in 99" :key="memoryId" :value="memoryId">MEM {{ String(memoryId).padStart(2, '0') }}</option>
          </select>
        </template>
        <span v-else class="assignment-off" aria-hidden="true">DISABLED</span>
      </div>
    </div>
    <p class="assignment-note">CC and note assignments are saved in this browser. Expression assignments follow MIDI CC value; footswitches use press or release thresholds.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useControlDispatcher } from '../composables/useControlDispatcher';
import type { ControlAssignment } from '../controls/commandDispatcher';

interface MidiInputLike {
  id: string;
  name?: string | null;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array; timeStamp: number }) => void) | null;
}
interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  onstatechange: (() => void) | null;
}
type NavigatorWithMidi = Navigator & { requestMIDIAccess?: () => Promise<MidiAccessLike> };

const { dispatcher, error } = useControlDispatcher();
const rows = ref<Array<ControlAssignment | null>>(dispatcher.assignments.map((item) => item ? { ...item } : null));
const midiInputs = ref<Array<{ id: string; name: string; state: string }>>([]);
const midiState = ref<'disabled' | 'enabling' | 'enabled' | 'unsupported' | 'denied'>('disabled');
const midiMessage = computed(() => {
  if (error.value) return error.value;
  if (midiState.value === 'enabled') return midiInputs.value.length ? 'WEB MIDI IS CONNECTED.' : 'WEB MIDI ENABLED. CONNECT A MIDI DEVICE.';
  if (midiState.value === 'unsupported') return 'THIS BROWSER DOES NOT PROVIDE WEB MIDI.';
  if (midiState.value === 'denied') return 'MIDI ACCESS WAS DENIED. CHECK BROWSER SITE PERMISSIONS.';
  if (midiState.value === 'enabling') return 'WAITING FOR MIDI ACCESS…';
  return 'ENABLE MIDI FROM THIS BUTTON TO GRANT ACCESS.';
});
let midiAccess: MidiAccessLike | null = null;

const syncMidiInputs = () => {
  if (!midiAccess) return;
  midiInputs.value = Array.from(midiAccess.inputs.values()).map((input) => ({
    id: input.id,
    name: input.name || `MIDI ${input.id}`,
    state: input.state || 'connected',
  }));
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = (event) => dispatcher.handleMidiMessage(event.data, event.timeStamp, input.id);
  }
};

const enableMidi = async () => {
  const requestMIDIAccess = (navigator as NavigatorWithMidi).requestMIDIAccess;
  if (!requestMIDIAccess) {
    midiState.value = 'unsupported';
    return;
  }
  midiState.value = 'enabling';
  try {
    midiAccess = await requestMIDIAccess.call(navigator);
    midiAccess.onstatechange = syncMidiInputs;
    syncMidiInputs();
    midiState.value = 'enabled';
  } catch (caught) {
    midiState.value = 'denied';
    console.warn('MIDI access request failed:', caught);
  }
};

const setEnabled = (index: number, event: Event) => {
  const enabled = (event.target as HTMLSelectElement).value === 'on';
  if (!enabled) {
    rows.value[index] = null;
    dispatcher.setAssignment(index, null);
    return;
  }
  const assignment: ControlAssignment = {
    source: 'cc', channel: 1, number: 0, trigger: 'press', command: 'record-track', trackId: 1,
  };
  rows.value[index] = assignment;
  dispatcher.setAssignment(index, assignment);
};

type AssignmentField = keyof ControlAssignment;
const update = (index: number, field: AssignmentField, event: Event) => {
  const current = rows.value[index];
  if (!current) return;
  const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
  const next = { ...current };
  if (field === 'source') {
    next.source = value as ControlAssignment['source'];
    if (next.source === 'note' && next.trigger === 'value') next.trigger = 'press';
    if (next.source === 'expression') {
      next.command = 'set-track-level';
      next.trigger = 'value';
    } else if (next.source === 'foot' || next.source === 'note') {
      if (next.command === 'set-track-level' || next.command === 'set-track-pan' || next.command === 'set-tempo') next.command = 'record-track';
      if (next.trigger === 'value') next.trigger = 'press';
    } else if ((next.command === 'set-track-level' || next.command === 'set-tempo') && next.trigger !== 'value') {
      next.trigger = 'value';
    }
  } else if (field === 'channel') {
    next.channel = value === 'omni' ? null : Number(value);
  } else if (field === 'number' || field === 'trackId' || field === 'memoryId') {
    const minimum = field === 'number' ? 0 : 1;
    const maximum = field === 'trackId' ? 5 : field === 'memoryId' ? 99 : 127;
    next[field] = Math.max(minimum, Math.min(maximum, Number(value))) as never;
  } else if (field === 'trigger') {
    next.trigger = value as ControlAssignment['trigger'];
  } else if (field === 'command') {
    next.command = value as ControlAssignment['command'];
    next.trigger = value === 'set-track-level' || value === 'set-track-pan' || value === 'set-tempo' ? 'value' : 'press';
    if (value === 'load-memory' && next.memoryId === undefined) next.memoryId = Math.max(1, Math.min(99, next.number + 1));
  }
  rows.value[index] = next;
  dispatcher.setAssignment(index, next);
};

onUnmounted(() => {
  if (midiAccess) {
    for (const input of midiAccess.inputs.values()) input.onmidimessage = null;
    midiAccess.onstatechange = null;
  }
});
</script>

<style scoped>
.control-assign-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(76vh, 760px);
  overflow: auto;
  padding: 18px;
  border: 1px solid var(--shell-divider, rgba(255,255,255,.14));
  border-radius: 14px;
  background: var(--shell-surface, #17181c);
  color: var(--text-primary, #f2f2f4);
  box-shadow: 0 18px 54px rgba(0,0,0,.45);
}
.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
h2 { margin: 0; font: 700 15px var(--font-hardware); letter-spacing: 1.1px; text-transform: uppercase; }
.panel-heading p, .assignment-note, .midi-status { margin: 4px 0 0; color: var(--text-muted, #9ba0aa); font: 11px/1.5 var(--font-hardware); }
.midi-enable { flex: 0 0 auto; padding: 9px 12px; border: 1px solid rgba(93, 184, 255, .4); border-radius: 8px; background: #12324a; color: #d9f0ff; font: 700 10px var(--font-hardware); cursor: pointer; }
.midi-enable:disabled { opacity: .55; cursor: wait; }
.midi-inputs { display: flex; gap: 6px; flex-wrap: wrap; }
.midi-input-chip { padding: 4px 8px; border-radius: 999px; background: rgba(35, 148, 94, .16); color: #92e9bd; font: 9px var(--font-hardware); }
.shortcut-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; padding: 10px; border-radius: 8px; background: rgba(255,255,255,.04); color: #bbc0ca; font: 10px/1.5 var(--font-hardware); }
kbd { padding: 2px 5px; border: 1px solid rgba(255,255,255,.2); border-radius: 4px; background: rgba(0,0,0,.3); color: #fff; font: 700 10px var(--font-mono); }
.assignments { min-width: 680px; display: flex; flex-direction: column; gap: 4px; }
.assignment-row { display: grid; grid-template-columns: 40px 65px 112px 64px 78px 72px minmax(150px, 1fr) 70px 78px; gap: 6px; align-items: center; }
.assignment-header { color: #868b95; font: 8px var(--font-hardware); letter-spacing: .6px; text-transform: uppercase; }
.slot-label { color: #aab0bb; font: 700 11px var(--font-mono); text-align: center; }
.assignment-row select, .assignment-row input { width: 100%; min-width: 0; height: 29px; padding: 0 6px; border: 1px solid rgba(255,255,255,.1); border-radius: 5px; background: #22242a; color: #e9ebef; font: 9px var(--font-hardware); }
.assignment-off { grid-column: span 6; color: #686d77; font: 9px var(--font-hardware); letter-spacing: .8px; }
.assignment-note { margin-top: 0; }
@media (max-width: 720px) { .panel-heading { flex-direction: column; } .assignments { overflow-x: auto; } }
</style>
