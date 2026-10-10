<template>
  <div v-if="!isNative" class="rhythm-controls" :class="{ disabled: browserDisabled }">
    <div class="section-label">RHYTHM</div>

    <div class="main-row">
      <HardwareButton
        shape="circle"
        size="md"
        :color="browserPlaying ? 'red' : 'neutral'"
        :active="browserPlaying"
        :label="browserPlaying ? 'STOP' : 'PLAY'"
        :aria-label="browserPlaying ? 'Stop rhythm' : 'Start rhythm'"
        @press="toggleBrowserRhythm"
      />

      <div class="params-col">
        <label class="sub-label" for="browser-rhythm-pattern">PATTERN</label>
        <select
          id="browser-rhythm-pattern"
          v-model="browserPattern"
          @change="updateBrowserPattern"
          class="pattern-select"
          :disabled="browserDisabled"
        >
          <option value="ROCK">ROCK</option>
          <option value="TECHNO">TECHNO</option>
          <option value="METRONOME">METRO</option>
        </select>

        <div class="level-control">
          <span class="sub-label">VOL</span>
          <input
            type="range"
            min="0"
            max="100"
            v-model.number="browserVolume"
            @input="updateBrowserVolume"
            class="level-slider hardware-interactive"
            aria-label="Rhythm volume"
            :disabled="browserDisabled"
          />
        </div>
      </div>
    </div>
    <div v-if="browserDisabled" class="native-note">{{ browserUnavailableReason }}</div>
  </div>

  <div v-else class="rhythm-controls native-rhythm" :class="{ disabled: nativeDisabled }">
    <div class="section-label">CLEAN-ROOM RHYTHM</div>

    <div class="native-main-row">
      <HardwareButton
        shape="circle"
        size="md"
        :color="nativeStatus?.playing ? 'red' : 'neutral'"
        :active="nativeStatus?.playing ?? false"
        :label="nativeStatus?.playing ? 'STOP' : 'PLAY'"
        :aria-label="nativeStatus?.playing ? 'Stop native rhythm' : 'Start native rhythm'"
        :disabled="nativeDisabled || nativeBusy"
        @press="toggleNativeRhythm"
      />

      <div class="native-selects">
        <label class="sub-label" for="native-rhythm-pattern">PATTERN</label>
        <select
          id="native-rhythm-pattern"
          v-model.number="nativePatternIndex"
          class="native-select pattern-select"
          :disabled="nativeDisabled || nativeBusy"
          @change="updateNativePatternKit"
        >
          <option v-for="pattern in patterns" :key="pattern.id" :value="pattern.index">
            {{ String(pattern.index + 1).padStart(3, '0') }} · {{ pattern.name }} · {{ pattern.meter }}
          </option>
        </select>

        <label class="sub-label" for="native-rhythm-kit">KIT</label>
        <select
          id="native-rhythm-kit"
          v-model.number="nativeKitIndex"
          class="native-select kit-select"
          :disabled="nativeDisabled || nativeBusy"
          @change="updateNativePatternKit"
        >
          <option v-for="kit in kits" :key="kit.id" :value="kit.index">
            {{ String(kit.index + 1).padStart(2, '0') }} · {{ kit.name }}
          </option>
        </select>

        <label class="sub-label" for="native-rhythm-tempo">TEMPO</label>
        <div class="level-control">
          <input
            id="native-rhythm-tempo"
            type="range"
            min="20"
            max="300"
            step="1"
            v-model.number="nativeTempo"
            class="level-slider native-tempo-slider hardware-interactive"
            aria-label="Native rhythm tempo"
            :disabled="nativeDisabled || nativeBusy"
            @change="updateNativeTempo"
          />
          <span class="numeric-value">{{ Math.round(nativeTempo) }}</span>
        </div>

        <div class="level-control">
          <span class="sub-label">VOL</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            v-model.number="nativeVolumePercent"
            class="level-slider hardware-interactive"
            aria-label="Native rhythm volume"
            :disabled="nativeDisabled || nativeBusy"
            @change="updateNativeVolume"
          />
        </div>
      </div>
    </div>

    <div class="native-transport" :class="{ unavailable: nativeDisabled }">
      <label class="intro-toggle">
        <input v-model="playIntro" type="checkbox" :disabled="nativeDisabled || nativeBusy" />
        INTRO
      </label>
      <button v-for="(variation, index) in variations" :key="variation" type="button"
        class="rhythm-action hardware-interactive" :disabled="nativeDisabled || nativeBusy || !nativeStatus?.playing"
        @click="queueNativeVariation(index)">
        {{ variation }}
      </button>
      <button type="button" class="rhythm-action hardware-interactive"
        :disabled="nativeDisabled || nativeBusy || !nativeStatus?.playing" @click="runNativeCommand('FILL QUEUED', () => engine.nativeRhythm.queueFill())">
        FILL
      </button>
      <button type="button" class="rhythm-action hardware-interactive"
        :disabled="nativeDisabled || nativeBusy || !nativeStatus?.playing" @click="runNativeCommand('ENDING QUEUED', () => engine.nativeRhythm.queueEnding())">
        END
      </button>
    </div>

    <div class="native-status" aria-live="polite">
      <span v-if="nativeStatus?.prepared">
        {{ nativeStatus.section.toUpperCase() }} · BAR {{ nativeStatus.barIndex + 1 }} · {{ Math.round(nativeStatus.effectiveBpm) }} BPM
        <span v-if="nativeStatus.tempoPending"> · TEMPO QUEUED</span>
        <span v-if="nativeStatus.volumePending"> · VOL RAMPING</span>
      </span>
      <span v-else>{{ nativeUnavailableReason }}</span>
      <span v-if="nativeNotice"> · {{ nativeNotice }}</span>
    </div>
    <div v-if="nativeError" class="native-error" role="alert">{{ nativeError }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { RhythmPattern } from '../audio/RhythmEngine';
import { CLEAN_ROOM_RHYTHM_KITS, CLEAN_ROOM_RHYTHM_PATTERNS } from '../audio/cleanroomRhythmCatalog';
import type { NativeRhythmMutationResponse, NativeRhythmStatus } from '../audio/NativeBridgeClient';
import HardwareButton from './ui/HardwareButton.vue';

const engine = AudioEngine.getInstance();
const isNative = computed(() => engine.getMode() === 'native');
const patterns = CLEAN_ROOM_RHYTHM_PATTERNS;
const kits = CLEAN_ROOM_RHYTHM_KITS;
const variations = ['A', 'B', 'C', 'D'] as const;
const nativeStatus = shallowRef<NativeRhythmStatus | null>(engine.nativeRhythm.status);
const nativeError = ref('');
const nativeNotice = ref('');
const nativeBusy = ref(false);
const nativePatternIndex = ref(nativeStatus.value?.selectedPatternIndex ?? 0);
const nativeKitIndex = ref(nativeStatus.value?.selectedKitIndex ?? 0);
const nativeTempo = ref(nativeStatus.value?.requestedBpm ?? 120);
const nativeVolumePercent = ref((nativeStatus.value?.requestedVolume ?? 0.7) * 100);
const playIntro = ref(true);
const browserPlaying = ref(false);
const browserPattern = ref<RhythmPattern>('ROCK');
const browserVolume = ref(50);
const browserDisabled = computed(() => !engine.getCapabilities().supportsRhythm);
const browserUnavailableReason = computed(() => engine.getCapabilities().rhythmReason);
const nativeDisabled = computed(() => {
  nativeStatus.value;
  return !engine.getCapabilities().supportsRhythm || !nativeStatus.value?.prepared;
});
const nativeUnavailableReason = computed(() => {
  nativeStatus.value;
  return engine.getCapabilities().rhythmReason || 'NATIVE RHYTHM IS NOT PREPARED';
});

function syncNativeStatus(status: NativeRhythmStatus | null, error: string) {
  nativeStatus.value = status;
  if (!status) {
    if (error) nativeError.value = error;
    return;
  }
  if (status.selectedPatternIndex !== null) nativePatternIndex.value = status.selectedPatternIndex;
  if (status.selectedKitIndex !== null) nativeKitIndex.value = status.selectedKitIndex;
  nativeTempo.value = status.requestedBpm;
  nativeVolumePercent.value = status.requestedVolume * 100;
  if (status.prepared) nativeError.value = '';
}

async function runNativeCommand(
  acceptedMessage: string,
  command: () => Promise<NativeRhythmMutationResponse>,
) {
  if (nativeDisabled.value || nativeBusy.value) return;
  nativeBusy.value = true;
  nativeError.value = '';
  try {
    const response = await command();
    syncNativeStatus(response.rhythm, '');
    nativeNotice.value = `${acceptedMessage} · FRAME ${response.acceptedFrame}`;
    window.setTimeout(() => { nativeNotice.value = ''; }, 2500);
  } catch (error) {
    const latest = await engine.nativeRhythm.refresh();
    syncNativeStatus(latest, engine.nativeRhythm.error);
    nativeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    nativeBusy.value = false;
  }
}

async function toggleNativeRhythm() {
  if (nativeStatus.value?.playing) {
    await runNativeCommand('STOP QUEUED', () => engine.nativeRhythm.stop());
  } else {
    await runNativeCommand('START QUEUED', () => engine.nativeRhythm.start(playIntro.value));
  }
}

async function updateNativePatternKit() {
  await runNativeCommand('SELECTION QUEUED', () => engine.nativeRhythm.selectPatternKit(nativePatternIndex.value, nativeKitIndex.value));
}

async function updateNativeTempo() {
  await runNativeCommand('TEMPO QUEUED', () => engine.nativeRhythm.setTempo(nativeTempo.value));
}

async function updateNativeVolume() {
  await runNativeCommand('VOLUME QUEUED', () => engine.nativeRhythm.setVolume(nativeVolumePercent.value / 100));
}

async function queueNativeVariation(index: number) {
  await runNativeCommand(`VARIATION ${variations[index]} QUEUED`, () => engine.nativeRhythm.queueVariation(index));
}

function toggleBrowserRhythm() {
  if (browserDisabled.value) return;
  if (browserPlaying.value) {
    engine.rhythmEngine.stop();
    browserPlaying.value = false;
  } else {
    engine.rhythmEngine.start();
    browserPlaying.value = true;
  }
}

function updateBrowserPattern() {
  if (!browserDisabled.value) engine.rhythmEngine.setPattern(browserPattern.value);
}

function updateBrowserVolume() {
  if (!browserDisabled.value) engine.rhythmEngine.setVolume(browserVolume.value);
}

let unsubscribeNativeRhythm: (() => void) | undefined;
onMounted(() => {
  if (isNative.value) {
    unsubscribeNativeRhythm = engine.nativeRhythm.subscribe(syncNativeStatus);
    void engine.nativeRhythm.refresh();
  } else {
    engine.rhythmEngine.setVolume(browserVolume.value);
    engine.rhythmEngine.setPattern(browserPattern.value);
  }
});
onUnmounted(() => unsubscribeNativeRhythm?.());
</script>

<style scoped>
.rhythm-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 92px;
  padding: 0 12px;
  border-left: 1px solid #333;
  border-right: 1px solid #333;
}

.rhythm-controls.disabled { opacity: 0.45; }
.native-rhythm { min-width: 470px; min-height: 132px; align-items: stretch; }
.section-label { font-family: var(--font-hardware); font-size: 12px; color: #666; letter-spacing: 2px; font-weight: 700; text-align: center; }
.main-row, .native-main-row { display: flex; gap: 12px; align-items: flex-end; padding-bottom: 2px; }
.params-col, .native-selects { display: flex; flex-direction: column; gap: 5px; min-width: 250px; }
.pattern-select, .native-select {
  background: var(--bg-groove-dark); color: var(--led-blue-accent); border: 1px solid #333; padding: 3px 6px;
  font-family: var(--font-mono); font-size: 11px; border-radius: 4px; outline: none; cursor: pointer; text-transform: uppercase;
}
.pattern-select { width: 84px; }
.native-select { width: 100%; }
.kit-select { max-width: 210px; }
.pattern-select:hover, .pattern-select:focus-visible, .native-select:focus-visible { border-color: var(--color-accent); box-shadow: 0 0 0 1px rgba(0, 153, 255, 0.3); }
.level-control { display: flex; align-items: center; gap: 6px; }
.sub-label { font-size: 9px; color: #666; font-weight: 700; font-family: var(--font-mono); letter-spacing: 0.6px; }
.level-slider { width: 58px; height: 4px; -webkit-appearance: none; appearance: none; background: #333; border-radius: 2px; outline: none; }
.native-tempo-slider { width: 126px; }
.numeric-value { width: 28px; color: var(--led-blue-accent); font: 10px var(--font-mono); text-align: right; }
.level-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #aaa; cursor: pointer; transition: background 0.2s; }
.level-slider::-webkit-slider-thumb:hover { background: #fff; }
.native-transport { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 4px; }
.rhythm-action { background: var(--bg-groove-dark); border: 1px solid #333; border-radius: 3px; color: #aaa; padding: 3px 8px; font: 9px var(--font-hardware); letter-spacing: .5px; }
.rhythm-action:disabled { opacity: .35; }
.intro-toggle { display: inline-flex; gap: 4px; align-items: center; color: #888; font: 9px var(--font-mono); }
.native-status, .native-note { min-height: 12px; color: #777; font: 9px var(--font-hardware); letter-spacing: .6px; text-align: center; text-transform: uppercase; }
.native-error { color: #ef7676; font: 10px var(--font-mono); text-align: center; overflow-wrap: anywhere; }
</style>
