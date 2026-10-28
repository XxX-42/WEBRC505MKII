<template>
  <fieldset class="loop-transport" data-loop-transport-editor>
    <legend>Loop source transport · Track {{ trackId }}</legend>
    <p class="explanation">
      This read-head stage shifts the stored loop before its A–D inserts. It is separate from, and is not an ordered A–D insert.
      Settings are saved in this browser's local preferences; project archives do not include FX settings.
    </p>
    <label class="control">
      Source transport
      <select :value="config.mode" :aria-label="`Track ${trackId} source transport`" @change="changeMode">
        <option value="off">Off</option>
        <option value="beatShift">BEAT SHIFT · experimental</option>
        <option value="vinylFlick">VINYL FLICK · experimental</option>
      </select>
    </label>
    <button v-if="!hasPrivateOverride" type="button" @click="void apply({ ...config, mode: 'off' })">
      Apply Off to Track {{ trackId }}
    </button>
    <button v-else-if="runtimeMode === 'browser'" type="button" @click="useSharedSourceRoute">
      Use Shared Track FX Source Route
    </button>
    <template v-if="config.mode === 'beatShift'">
      <label class="control">
        Beat offset {{ config.beatOffsetBeats.toFixed(2) }} beats
        <input
          :aria-label="`Track ${trackId} source beat offset`"
          type="range" min="-4" max="4" step="0.25" :value="config.beatOffsetBeats"
          @change="changeNumber('beatOffsetBeats', $event)"
        />
      </label>
      <label class="control">
        Retarget crossfade {{ config.crossfadeMs.toFixed(0) }} ms
        <input
          :aria-label="`Track ${trackId} source crossfade`"
          type="range" min="1" max="10" step="1" :value="config.crossfadeMs"
          @change="changeNumber('crossfadeMs', $event)"
        />
      </label>
      <p class="explanation">The Browser follows the shared Transport BPM. The Native route receives the current BPM with each setting update.</p>
    </template>
    <template v-else-if="config.mode === 'vinylFlick'">
      <label class="control">
        Platter speed target {{ config.vinylSpeedPercent.toFixed(0) }}%
        <input
          :aria-label="`Track ${trackId} Vinyl speed target`"
          type="range" min="-100" max="100" step="1" :value="config.vinylSpeedPercent"
          @change="changeNumber('vinylSpeedPercent', $event)"
        />
      </label>
      <label class="control">
        Motor return {{ config.motorReturnSeconds.toFixed(2) }} s
        <input
          :aria-label="`Track ${trackId} Vinyl motor return`"
          type="range" min="0.05" max="10" step="0.05" :value="config.motorReturnSeconds"
          @change="changeNumber('motorReturnSeconds', $event)"
        />
      </label>
      <label class="control">
        Brake {{ config.brakePercent.toFixed(0) }}%
        <input
          :aria-label="`Track ${trackId} Vinyl brake`"
          type="range" min="0" max="100" step="1" :value="config.brakePercent"
          @change="changeNumber('brakePercent', $event)"
        />
      </label>
      <label class="control">
        Dry/wet mix {{ config.vinylMixPercent.toFixed(0) }}%
        <input
          :aria-label="`Track ${trackId} Vinyl mix`"
          type="range" min="0" max="100" step="1" :value="config.vinylMixPercent"
          @change="changeNumber('vinylMixPercent', $event)"
        />
      </label>
      <p class="explanation">Project-defined control: −100% targets 0×, 0% targets 1×, +100% targets 2×. Mix blends the original loop with the motor-driven read-head; it does not scale the speed target. Experimental, not sound-quality accepted.</p>
    </template>
    <p class="runtime-status" role="status" aria-live="polite" data-loop-transport-status data-testid="loop-transport-status">{{ status }}</p>
  </fieldset>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AudioEngine } from '../../audio/AudioEngine';
import { Transport } from '../../core/Transport';
import type { NativeLoopTransportConfig } from '../../audio/NativeBridgeClient';

const props = defineProps<{ trackId: number; runtimeMode: 'browser' | 'native' }>();

const STORAGE_KEY = 'webrc505_loop_source_transport_v1';
type SavedTransportSettings = {
  version: 1;
  browser: Record<string, NativeLoopTransportConfig>;
  native: Record<string, NativeLoopTransportConfig>;
};

const makeDefault = (): NativeLoopTransportConfig => ({
  mode: 'off',
  beatOffsetBeats: 0,
  bpm: Transport.getInstance().bpm,
  crossfadeMs: 5,
  vinylSpeedPercent: 0,
  motorReturnSeconds: 1,
  brakePercent: 0,
  vinylMixPercent: 100,
});

const config = ref<NativeLoopTransportConfig>(makeDefault());
const status = ref('OFF · source reader is not processing');
const hasPrivateOverride = ref(false);
const generation = ref(0);

function readSaved(): SavedTransportSettings | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Partial<SavedTransportSettings>;
    if (value.version !== 1 || !value.browser || !value.native) return null;
    return value as SavedTransportSettings;
  } catch {
    status.value = 'Saved source transport settings could not be read; this track stays off.';
    return null;
  }
}

function persist(value: NativeLoopTransportConfig) {
  try {
    const existing = readSaved() ?? { version: 1 as const, browser: {}, native: {} };
    existing[props.runtimeMode][String(props.trackId)] = { ...value };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch {
    status.value = 'Applied, but the source transport setting could not be saved locally.';
  }
}

function removeSavedSetting(): boolean {
  try {
    const existing = readSaved();
    if (!existing) return true;
    delete existing[props.runtimeMode][String(props.trackId)];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    return true;
  } catch {
    return false;
  }
}

function loadTrackSettings(): boolean {
  const saved = readSaved();
  const selected = saved?.[props.runtimeMode][String(props.trackId)];
  if (selected?.mode === 'vinylFlick') {
    config.value = { ...makeDefault(), ...selected, bpm: Transport.getInstance().bpm };
    hasPrivateOverride.value = true;
    return true;
  }
  if (selected?.mode === 'off' || selected?.mode === 'beatShift') {
    config.value = { ...makeDefault(), ...selected, bpm: Transport.getInstance().bpm };
    hasPrivateOverride.value = true;
    return true;
  }
  config.value = makeDefault();
  hasPrivateOverride.value = false;
  status.value = 'No dedicated source override saved; existing source routing is unchanged.';
  return false;
}

async function apply(value: NativeLoopTransportConfig, save = true) {
  const request = ++generation.value;
  const requested = { ...value, bpm: Transport.getInstance().bpm };
  status.value = 'APPLYING SOURCE TRANSPORT…';
  const engine = AudioEngine.getInstance();
  try {
    if (props.runtimeMode === 'browser') {
      if (!engine.setBrowserLoopTransport(props.trackId, requested)) {
        throw new Error('Browser rejected this source transport configuration.');
      }
    } else {
      const acknowledgement = await engine.setNativeLoopTransport(props.trackId, requested);
      if (!acknowledgement.ok) throw new Error(acknowledgement.lastError || 'Native did not acknowledge this source transport configuration.');
    }
    if (request !== generation.value) return;
    config.value = requested;
    hasPrivateOverride.value = true;
    status.value = requested.mode === 'off'
      ? 'OFF · source read-head removed for this track'
      : 'APPLIED · per-loop source stage · not an A–D insert';
    if (save) persist(requested);
  } catch (error) {
    if (request !== generation.value) return;
    status.value = `NOT CONFIRMED: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function useSharedSourceRoute() {
  const engine = AudioEngine.getInstance();
  if (!engine.clearBrowserLoopTransportOverride(props.trackId)) {
    status.value = 'NOT CONFIRMED: the Browser could not restore its shared Track FX source route.';
    return;
  }
  generation.value += 1;
  config.value = makeDefault();
  hasPrivateOverride.value = false;
  status.value = removeSavedSetting()
    ? 'SHARED ROUTE · legacy Track FX source transport is restored for this loop.'
    : 'Shared route restored, but the old local override could not be removed; it may return after reload.';
}

function changeMode(event: Event) {
  const selected = (event.target as HTMLSelectElement).value;
  if (selected !== 'off' && selected !== 'beatShift' && selected !== 'vinylFlick') return;
  void apply({ ...config.value, mode: selected });
}

function changeNumber(
  key: 'beatOffsetBeats' | 'crossfadeMs' | 'vinylSpeedPercent' | 'motorReturnSeconds' | 'brakePercent' | 'vinylMixPercent',
  event: Event,
) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  void apply({ ...config.value, [key]: value });
}

const handleBpmChange = () => {
  if (props.runtimeMode === 'native' && config.value.mode === 'beatShift') void apply(config.value);
};

watch(() => [props.trackId, props.runtimeMode] as const, () => {
  if (loadTrackSettings()) void apply(config.value, false);
}, { immediate: true });

onMounted(() => Transport.getInstance().on('bpm-change', handleBpmChange));
onBeforeUnmount(() => {
  generation.value += 1;
  Transport.getInstance().off('bpm-change', handleBpmChange);
});
</script>

<style scoped>
.loop-transport { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 0; padding: 12px; border: 1px solid #69535b; border-radius: 10px; color: #f3f3f5; }
.loop-transport legend { padding: 0 6px; color: #ff9ba3; font-size: 12px; letter-spacing: .5px; }
.control { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.control select { min-height: 36px; padding: 6px 10px; border: 1px solid rgba(255, 255, 255, .22); border-radius: 8px; background: #26232a; color: #f3f3f5; }
.explanation, .runtime-status { margin: 0; font-size: 12px; line-height: 1.45; color: rgba(255, 255, 255, .7); }
.runtime-status { color: #ffd27a; }
</style>
