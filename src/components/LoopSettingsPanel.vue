<template>
  <section class="loop-settings" aria-label="Loop and tempo settings">
    <p class="help-text">Sample-clock settings are applied to the live browser engine and recalled with Memory.</p>
    <p v-if="unavailableReason" class="error-note" role="status">{{ unavailableReason }}</p>

    <div class="settings-grid">
      <label>
        <span>MASTER TEMPO (BPM)</span>
        <input
          type="number"
          min="40"
          max="300"
          step="0.1"
          :value="settings?.bpm ?? 120"
          :disabled="!available || busy"
          aria-label="Master tempo in beats per minute"
          @change="changeBpm"
        >
      </label>

      <label>
        <span>MASTER LOOP</span>
        <select
          :value="settings?.masterTrackId ?? 'none'"
          :disabled="!available || busy"
          aria-label="Master loop track"
          @change="changeMaster"
        >
          <option value="none">NONE</option>
          <option v-for="trackId in availableMasterTracks" :key="trackId" :value="trackId">
            TRACK {{ trackId }}
          </option>
        </select>
      </label>

      <label>
        <span>LOOP SYNC</span>
        <select :value="settings?.loopSyncMode" :disabled="!available || busy" aria-label="Loop synchronization mode" @change="changeLoopSync">
          <option :value="LoopSyncMode.IMMEDIATE">IMMEDIATE</option>
          <option :value="LoopSyncMode.MEASURE">MEASURE</option>
          <option :value="LoopSyncMode.LOOP_LENGTH">LOOP LENGTH</option>
        </select>
      </label>

      <label>
        <span>TEMPO SYNC</span>
        <select :value="settings?.tempoSyncMode" :disabled="!available || busy" aria-label="Tempo synchronization mode" @change="changeTempoSync">
          <option :value="TempoSyncMode.PITCH">PITCH</option>
          <option :value="TempoSyncMode.XFADE">XFADE</option>
        </select>
      </label>

      <label>
        <span>QUANTIZE</span>
        <select :value="settings?.quantize" :disabled="!available || busy" aria-label="Record quantize mode" @change="changeQuantize">
          <option :value="QuantizeMode.OFF">OFF</option>
          <option :value="QuantizeMode.MEASURE">MEASURE</option>
        </select>
      </label>
    </div>

    <div class="footer-line" aria-live="polite">
      <span v-if="busy">APPLYING TO AUDIO ENGINE…</span>
      <span v-else-if="settings">MASTER {{ settings.masterTrackId === null ? 'NONE' : `TRACK ${settings.masterTrackId}` }} · {{ settings.bpm.toFixed(1) }} BPM</span>
    </div>
    <p v-if="error" class="error-note" role="alert">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { LoopEngineSettings } from '../audio/loopSettings';
import { LoopSyncMode, QuantizeMode, TempoSyncMode } from '../core/types';
import { Transport } from '../core/Transport';

const engine = AudioEngine.getInstance();
const transport = Transport.getInstance();
const settings = ref<LoopEngineSettings | null>(null);
const error = ref('');
const busy = ref(false);
const available = computed(() => engine.getMode() === 'browser');
const unavailableReason = computed(() => available.value ? '' : 'LOOP CLOCK SETTINGS REQUIRE BROWSER AUDIO.');
const availableMasterTracks = ref<number[]>([]);
let pollTimer = 0;
let unsubscribeEngine: (() => void) | null = null;
let unsubscribeProject: (() => void) | null = null;

const refresh = () => {
  if (!available.value) {
    settings.value = null;
    availableMasterTracks.value = [];
    return;
  }
  try {
    settings.value = engine.getLoopSettings();
    const loopFrames = engine.getRealtimeMetrics()?.loopFrames ?? [];
    availableMasterTracks.value = loopFrames.flatMap((frames, index) => frames > 0 ? [index + 1] : []);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
};

const apply = async (patch: Partial<LoopEngineSettings>) => {
  if (!available.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await engine.updateLoopSettings(patch);
    refresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    refresh();
  } finally {
    busy.value = false;
  }
};

const changeBpm = (event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || value < 40 || value > 300) {
    error.value = 'BPM MUST BE BETWEEN 40 AND 300.';
    refresh();
    return;
  }
  void apply({ bpm: value });
};

const changeMaster = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value;
  void apply({ masterTrackId: value === 'none' ? null : Number(value) });
};

const changeLoopSync = (event: Event) => void apply({ loopSyncMode: (event.target as HTMLSelectElement).value as LoopEngineSettings['loopSyncMode'] });
const changeTempoSync = (event: Event) => void apply({ tempoSyncMode: (event.target as HTMLSelectElement).value as LoopEngineSettings['tempoSyncMode'] });
const changeQuantize = (event: Event) => void apply({ quantize: (event.target as HTMLSelectElement).value as LoopEngineSettings['quantize'] });

const refreshOnTransport = () => refresh();

onMounted(() => {
  refresh();
  transport.on('bpm-change', refreshOnTransport);
  transport.on('master-track-change', refreshOnTransport);
  if (available.value) {
    try {
      unsubscribeProject = engine.getProjectService().subscribe(refreshOnTransport);
    } catch {
      // The panel remains operational before the Memories service is created.
    }
  }
  unsubscribeEngine = engine.onStatusChange(() => refresh());
  pollTimer = window.setInterval(refresh, 500);
});

onUnmounted(() => {
  transport.off('bpm-change', refreshOnTransport);
  transport.off('master-track-change', refreshOnTransport);
  unsubscribeEngine?.();
  unsubscribeProject?.();
  window.clearInterval(pollTimer);
});
</script>

<style scoped>
.loop-settings {
  display: grid;
  gap: 14px;
  min-width: min(460px, calc(100vw - 48px));
  padding: 16px;
  color: #e8ebf2;
  font-family: var(--font-hardware);
}

.help-text,
.error-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #9ca4b4;
}

.error-note { color: #ff8e97; }

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

label { display: grid; gap: 6px; min-width: 0; }
label > span { font-size: 9px; letter-spacing: 1px; color: #aeb5c2; }

input,
select {
  width: 100%;
  min-height: 38px;
  padding: 0 9px;
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 6px;
  background: #171a20;
  color: #f0f2f6;
  font: 12px var(--font-mono);
}

input:focus-visible,
select:focus-visible { outline: 2px solid #419cff; outline-offset: 1px; }
input:disabled,
select:disabled { opacity: .48; }

.footer-line { min-height: 14px; font-size: 10px; letter-spacing: .7px; color: #9cb8dc; }

@media (max-width: 520px) {
  .settings-grid { grid-template-columns: 1fr; }
}
</style>
