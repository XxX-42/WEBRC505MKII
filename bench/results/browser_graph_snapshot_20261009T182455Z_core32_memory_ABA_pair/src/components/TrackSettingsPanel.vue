<template>
  <details class="track-settings" :class="{ unavailable: !settingsAvailable }">
    <summary>TRACK {{ trackId }} SETTINGS</summary>
    <p v-if="!settingsAvailable" class="settings-note">{{ unavailableReason }}</p>
    <template v-else-if="settings">
      <fieldset class="settings-grid" :disabled="busy || !settingsAvailable">
        <label class="toggle-setting"><input type="checkbox" :checked="settings.oneShot" @change="setOneShot"> ONE SHOT</label>
        <label>START
          <select :value="settings.startMode" @change="setField('startMode', $event)">
            <option value="IMMEDIATE">IMMEDIATE</option><option value="FADE">FADE</option>
          </select>
        </label>
        <label>STOP
          <select :value="settings.stopMode" @change="setField('stopMode', $event)">
            <option value="IMMEDIATE">IMMEDIATE</option><option value="FADE">FADE</option><option value="LOOP">LOOP</option>
          </select>
        </label>
        <label class="range-setting">FADE IN <span>{{ settings.fadeInMs }} ms</span>
          <input type="range" min="0" max="5000" step="25" :value="settings.fadeInMs" :disabled="busy || !settingsAvailable" @input="setNumber('fadeInMs', $event)">
        </label>
        <label class="range-setting">FADE OUT <span>{{ settings.fadeOutMs }} ms</span>
          <input type="range" min="0" max="5000" step="25" :value="settings.fadeOutMs" :disabled="busy || !settingsAvailable" @input="setNumber('fadeOutMs', $event)">
        </label>
        <label class="range-setting">SPEED <span>{{ settings.speed.toFixed(2) }}×</span>
          <input type="range" min="0.25" max="4" step="0.01" :value="settings.speed" :disabled="busy || !settingsAvailable" @input="setNumber('speed', $event)">
        </label>
        <label class="toggle-setting"><input type="checkbox" :checked="settings.tempoSyncEnabled" @change="setTempoSyncEnabled"> TEMPO SYNC</label>
        <label>TEMPO SPEED
          <select :value="settings.tempoSyncSpeed" :disabled="!settings.tempoSyncEnabled" @change="setField('tempoSyncSpeed', $event)">
            <option value="HALF">HALF</option><option value="NORMAL">NORMAL</option><option value="DOUBLE">DOUBLE</option>
          </select>
        </label>
        <label>TEMPO MODE
          <select :value="settings.tempoSyncMode" :disabled="!settings.tempoSyncEnabled" @change="setField('tempoSyncMode', $event)">
            <option value="PITCH">PITCH</option><option value="XFADE">XFADE</option>
          </select>
        </label>
        <div class="record-bpm" aria-label="Recorded tempo">REC BPM <strong>{{ settings.recordBpm ?? '—' }}</strong></div>
        <label class="range-setting">PAN <span>{{ panLabel }}</span>
          <input type="range" min="-50" max="50" step="1" :value="pan" :disabled="busy || !settingsAvailable" @input="setPan">
        </label>
        <label class="toggle-setting"><input type="checkbox" :checked="settings.keepPitch" @change="setKeepPitch"> KEEP PITCH</label>
        <label>DUB MODE
          <select :value="settings.dubMode" @change="setField('dubMode', $event)">
            <option value="OVERDUB">OVERDUB</option><option value="REPLACE1">REPLACE 1</option><option value="REPLACE2">REPLACE 2</option>
          </select>
        </label>
        <label class="toggle-setting"><input type="checkbox" :checked="settings.autoRec.enabled" @change="setAutoRecEnabled"> AUTO REC</label>
        <label class="range-setting">AUTO REC THRESHOLD <span>{{ settings.autoRec.threshold.toFixed(2) }}</span>
          <input type="range" min="0" max="1" step="0.01" :value="settings.autoRec.threshold" :disabled="!settings.autoRec.enabled || !settingsAvailable || busy" @input="setAutoRecNumber('threshold', $event)">
        </label>
        <label class="range-setting">AUTO REC DEBOUNCE <span>{{ settings.autoRec.debounceMs }} ms</span>
          <input type="range" min="1" max="1000" step="1" :value="settings.autoRec.debounceMs" :disabled="!settings.autoRec.enabled || !settingsAvailable || busy" @input="setAutoRecNumber('debounceMs', $event)">
        </label>
      </fieldset>

      <fieldset class="track-actions" aria-label="Track history and markers" :disabled="!settingsAvailable || busy">
        <button type="button" @click="dispatch('undo')">UNDO</button>
        <button type="button" @click="dispatch('redo')">REDO</button>
        <button type="button" @click="dispatch('mark')">MARK</button>
        <button type="button" @click="dispatch('mark-back')">MARK BACK</button>
        <button type="button" @click="dispatch('mark-clear')">MARK CLEAR</button>
        <button type="button" @click="dispatch('rec-back')">REC BACK</button>
      </fieldset>

      <fieldset class="track-wav-actions" :disabled="wavBusy || !settingsAvailable">
        <button type="button" :disabled="wavBusy || !settingsAvailable" @click="exportTrackWav">EXPORT WAV</button>
        <button type="button" :disabled="wavBusy || !settingsAvailable" @click="openTrackImport">IMPORT WAV</button>
        <input ref="wavInput" class="visually-hidden" type="file" accept="audio/wav,.wav" @change="importTrackWav">
      </fieldset>
      <p v-if="operationError || controlError" class="settings-error" role="alert">{{ operationError || controlError }}</p>
    </template>
  </details>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { TrackRuntimeSettings } from '../core/types';
import type { ProjectService } from '../project/ProjectService';
import { useControlDispatcher } from '../composables/useControlDispatcher';

interface TrackRuntimePort {
  getRuntimeSettings?: () => TrackRuntimeSettings;
  updateRuntimeSettings?: (settings: Partial<TrackRuntimeSettings>) => Promise<void>;
}
type ProjectTrackPort = Pick<ProjectService, 'exportTrackWav' | 'importTrackWav'>;

const props = defineProps<{ trackId: number }>();
const engine = AudioEngine.getInstance();
const { dispatcher, error: controlError } = useControlDispatcher();
const settings = ref<TrackRuntimeSettings | null>(null);
const pan = ref(0);
const operationError = ref('');
const wavBusy = ref(false);
const wavInput = ref<HTMLInputElement | null>(null);
const track = engine.tracks[props.trackId - 1] as typeof engine.tracks[number] & TrackRuntimePort;
let refreshInterval = 0;
let unsubscribeStatus: (() => void) | null = null;

const engineReady = ref(engine.getUiStatus().ready);
const busy = ref(false);
const settingsAvailable = computed(() => engine.getMode() === 'browser' && engineReady.value && Boolean(track?.getRuntimeSettings && track?.updateRuntimeSettings));
const unavailableReason = computed(() => engine.getMode() === 'native' ? 'Track settings require browser audio.' : 'Track runtime settings are unavailable.');
const panLabel = computed(() => pan.value === 0 ? 'CENTER' : pan.value < 0 ? `L${Math.abs(pan.value)}` : `R${pan.value}`);
const projectService = () => {
  const getter = (engine as unknown as { getProjectService?: () => ProjectTrackPort | null }).getProjectService;
  const service = getter?.call(engine);
  if (!service) throw new Error('Project storage is unavailable until browser audio is ready.');
  return service;
};

const refreshSettings = () => {
  const panValue = (track.track as unknown as { pan?: string | number } | undefined)?.pan;
  if (typeof panValue === 'number') pan.value = panValue;
  else if (typeof panValue === 'string') pan.value = panValue === 'CENTER' ? 0 : panValue.startsWith('L') ? -Number(panValue.slice(1)) : Number(panValue.slice(1));
  if (!settingsAvailable.value) {
    settings.value = null;
    return;
  }
  const current = track.getRuntimeSettings?.();
  if (current) settings.value = { ...current, autoRec: { ...current.autoRec } };
};

const apply = async (partial: Partial<TrackRuntimeSettings>) => {
  if (!settingsAvailable.value || !track.updateRuntimeSettings || busy.value) return;
  busy.value = true;
  operationError.value = '';
  try {
    await track.updateRuntimeSettings(partial);
    refreshSettings();
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
};

const setOneShot = (event: Event) => apply({ oneShot: (event.target as HTMLInputElement).checked });
const setKeepPitch = (event: Event) => apply({ keepPitch: (event.target as HTMLInputElement).checked });
const setField = (field: 'startMode' | 'stopMode' | 'dubMode' | 'tempoSyncSpeed' | 'tempoSyncMode', event: Event) => apply({ [field]: (event.target as HTMLSelectElement).value } as Partial<TrackRuntimeSettings>);
const setNumber = (field: 'fadeInMs' | 'fadeOutMs' | 'speed', event: Event) => apply({ [field]: Number((event.target as HTMLInputElement).value) } as Partial<TrackRuntimeSettings>);
const setTempoSyncEnabled = (event: Event) => apply({ tempoSyncEnabled: (event.target as HTMLInputElement).checked });
const setPan = (event: Event) => {
  pan.value = Math.max(-50, Math.min(50, Math.round(Number((event.target as HTMLInputElement).value))));
  void dispatcher.dispatch({ type: 'set-track-pan', trackId: props.trackId, value: pan.value });
};
const setAutoRecEnabled = (event: Event) => {
  const current = settings.value;
  if (!current) return;
  apply({ autoRec: { ...current.autoRec, enabled: (event.target as HTMLInputElement).checked } });
};
const setAutoRecNumber = (field: 'threshold' | 'debounceMs', event: Event) => {
  const current = settings.value;
  if (!current) return;
  apply({ autoRec: { ...current.autoRec, [field]: Number((event.target as HTMLInputElement).value) } });
};

type TrackAction = 'undo' | 'redo' | 'mark' | 'mark-back' | 'mark-clear' | 'rec-back';
const dispatch = (type: TrackAction) => {
  operationError.value = '';
  void dispatcher.dispatch({ type, trackId: props.trackId });
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const exportTrackWav = async () => {
  wavBusy.value = true;
  operationError.value = '';
  try {
    const blob = await projectService().exportTrackWav(props.trackId);
    downloadBlob(blob, `Track${props.trackId}.wav`);
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : String(error);
  } finally {
    wavBusy.value = false;
  }
};

const openTrackImport = () => wavInput.value?.click();
const importTrackWav = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  wavBusy.value = true;
  operationError.value = '';
  try {
    await projectService().importTrackWav(props.trackId, file);
    refreshSettings();
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : String(error);
  } finally {
    input.value = '';
    wavBusy.value = false;
  }
};

onMounted(() => {
  refreshSettings();
  unsubscribeStatus = engine.onStatusChange((status) => {
    engineReady.value = status.ready;
    refreshSettings();
  });
  refreshInterval = window.setInterval(refreshSettings, 300);
});
onUnmounted(() => {
  unsubscribeStatus?.();
  window.clearInterval(refreshInterval);
});
</script>

<style scoped>
.track-settings { width: 100%; color: #dfe3eb; font: 8px var(--font-hardware); }
.track-settings summary { padding: 7px 8px; border: 1px solid rgba(255,255,255,.1); border-radius: 5px; background: rgba(255,255,255,.04); color: #aeb7c5; cursor: pointer; letter-spacing: .8px; }
.track-settings[open] summary { margin-bottom: 8px; color: #e5f3ff; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 7px; padding: 0 2px; margin: 0; border: 0; min-width: 0; }
.settings-grid label { display: flex; flex-direction: column; gap: 4px; color: #9199a7; font-size: 8px; letter-spacing: .4px; }
.settings-grid select { height: 25px; padding: 0 5px; border: 1px solid rgba(255,255,255,.12); border-radius: 4px; background: #191b20; color: #e6eaf0; font: 9px var(--font-hardware); }
.toggle-setting { flex-direction: row !important; align-items: center; min-height: 25px; color: #c2c8d3 !important; }
.toggle-setting input { accent-color: #5cc391; }
.range-setting { grid-column: span 2; }
.range-setting span { float: right; color: #c5d0dd; }
.range-setting input { width: 100%; height: 12px; accent-color: #52c29c; }
.track-actions, .track-wav-actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 0; padding: 0; border: 0; min-width: 0; }
.track-actions button, .track-wav-actions button { padding: 5px 6px; border: 1px solid rgba(255,255,255,.13); border-radius: 4px; background: #22252c; color: #c5d7eb; font: 8px var(--font-hardware); letter-spacing: .4px; cursor: pointer; }
.track-wav-actions button { background: #193b36; color: #a9eed7; }
.track-actions button:disabled, .track-wav-actions button:disabled { opacity: .45; cursor: wait; }
.settings-note, .settings-error { margin: 7px 2px 0; color: #a0a7b2; font: 8px/1.4 var(--font-hardware); }
.settings-error { color: #ffacb7; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
</style>
