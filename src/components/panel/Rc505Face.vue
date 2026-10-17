<template>
  <section class="rc505-face" data-testid="rc505-physical-face" aria-label="BOSS RC-505mkII top control panel">
    <header class="face-branding" aria-label="BOSS RC-505mkII">
      <div class="boss-mark">BOSS</div>
      <div class="model-mark">
        <span class="model-name">RC-505mkII</span>
        <span class="model-subtitle">LOOP STATION</span>
      </div>
      <span class="panel-caption">LOOP STATION</span>
    </header>

    <div class="face-upper" data-panel="hardware-top">
      <FxBankControls
        location="input"
        title="INPUT FX"
        color="blue"
        :model-value="inputFxValue"
        @update:model-value="setInputFxValue"
        @edit="device.openPage('input-fx')"
      />

      <CenterMainPanel
        :input-fx-value="inputFxValue"
        :track-fx-value="trackFxValue"
        :input-fx-disabled="inputFxDisabled"
        :input-fx-reason="inputFxReason"
        :track-fx-disabled="trackFxDisabled"
        :track-fx-reason="trackFxReason"
        :set-input-parameter="setInputFxParameter"
        :set-track-parameter="setTrackFxParameter"
        @update:input-fx-value="setInputFxValue"
        @update:track-fx-value="setTrackFxValue"
      />

      <FxBankControls
        location="track"
        title="TRACK FX"
        color="red"
        :model-value="trackFxValue"
        @update:model-value="setTrackFxValue"
        @edit="device.openPage('track-fx')"
      />
    </div>

    <TrackBay />
    <div hidden aria-hidden="true" class="lcd-fx-controllers">
      <InputFxPanel ref="inputFxEditor" />
      <TrackFxPanel ref="trackFxEditor" />
    </div>
  </section>

</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useFxPanelState } from '../../composables/useFxPanelState';
import { useTrackFxTargetState } from '../../composables/useTrackFxTargetState';
import { useDevicePanel } from '../../composables/useDevicePanel';
import CenterMainPanel from './CenterMainPanel.vue';
import FxBankControls from './FxBankControls.vue';
import InputFxPanel from './InputFxPanel.vue';
import TrackBay from './TrackBay.vue';
import TrackFxPanel from './TrackFxPanel.vue';

interface FxEditorHandle { updateActiveValue(value: number): void; setLcdParameter(group: string, key: string, value: number): void }

const device = useDevicePanel();
const inputBank = useFxPanelState('input');
const trackBank = useTrackFxTargetState();
const inputFxEditor = ref<FxEditorHandle | null>(null);
const trackFxEditor = ref<FxEditorHandle | null>(null);
const inputActiveSlot = computed(() => inputBank.slots.value.find((slot) => slot.id === inputBank.activeSlot.value) ?? inputBank.slots.value[0]);
const trackActiveSlot = trackBank.activeFx;
const inputFxValue = computed(() => inputActiveSlot.value?.value ?? 0);
const trackFxValue = computed(() => trackActiveSlot.value?.value ?? 0);
const inputFxEmpty = computed(() => !inputActiveSlot.value?.type || inputActiveSlot.value.type === 'NONE');
const trackFxEmpty = computed(() => !trackActiveSlot.value?.type || trackActiveSlot.value.type === 'NONE');
const inputFxDisabled = computed(() => inputBank.fxDisabled.value || inputFxEmpty.value);
const trackFxDisabled = computed(() => trackBank.fxDisabled.value || trackFxEmpty.value);
const inputFxReason = computed(() => inputBank.fxUnavailableReason.value || (inputFxEmpty.value ? 'Select an effect first to edit its value.' : 'Input FX is unavailable on this audio runtime.'));
const trackFxReason = computed(() => trackBank.fxUnavailableReason.value || (trackFxEmpty.value ? 'Select an effect first to edit its value.' : 'Track FX is unavailable on this audio runtime.'));

function setInputFxValue(value: number): void { inputFxEditor.value?.updateActiveValue(value); }
function setTrackFxValue(value: number): void { trackFxEditor.value?.updateActiveValue(value); }
function setInputFxParameter(group: string, key: string, value: number): void {
  if (!inputFxEditor.value) throw new Error('Input FX controller is not ready.');
  inputFxEditor.value.setLcdParameter(group, key, value);
}
function setTrackFxParameter(group: string, key: string, value: number): void {
  if (!trackFxEditor.value) throw new Error('Track FX controller is not ready.');
  trackFxEditor.value.setLcdParameter(group, key, value);
}
</script>

<style scoped>
.rc505-face {
  width: 1520px;
  min-width: 1520px;
  height: 846px;
  min-height: 846px;
  overflow: hidden;
  border: 1px solid #52565d;
  border-radius: 24px 24px 8px 8px;
  color: #e6e8ec;
  background: linear-gradient(180deg, #777b82 0%, #36393f 4%, #1e2024 16%, #17181c 100%);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.42), inset 0 1px rgba(255, 255, 255, 0.26), inset 0 -3px rgba(0, 0, 0, 0.6);
}

.face-branding {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  min-height: 51px;
  padding: 0 28px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  background: linear-gradient(180deg, #282a2f, #1b1c20);
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.boss-mark { color: #f5f6f7; font-size: 22px; font-weight: 900; font-style: italic; letter-spacing: 0.1em; }
.model-mark { display: flex; align-items: baseline; gap: 13px; color: #f5f6f7; }
.model-name { font-size: 18px; font-weight: 800; letter-spacing: 0.12em; }
.model-subtitle { color: #d1d6dd; font-size: 12px; letter-spacing: 0.12em; }
.panel-caption { justify-self: end; color: #c0c6cf; font-size: 11px; letter-spacing: 0.12em; }

.face-upper {
  position: relative;
  display: block;
  width: 100%;
  height: 269px;
  min-height: 269px;
  border-bottom: 1px solid #686d75;
  background: linear-gradient(180deg, #3d4046 0%, #27292e 100%);
}
.face-upper > :deep(.fx-bank-input) { position: absolute; inset: 0 auto 0 0; width: 330px; }
.face-upper > :deep(.center-main-panel) { position: absolute; inset: 0 auto 0 329px; width: 830px; }
.face-upper > :deep(.fx-bank-track) { position: absolute; inset: 0 0 0 auto; width: 360px; }
.face-upper > :deep(.fx-bank) { min-width: 0; min-height: 0; overflow: visible; }
.track-header { display: none; }
.rc505-face :deep(.track-bay) {
  width: 1375px;
  height: 524px;
  min-width: 1375px;
  margin-inline: auto;
  padding-bottom: 0;
}

.menu-page { display: grid; gap: 10px; max-width: 760px; margin-inline: auto; font-family: var(--font-hardware); }
.drawer-intro { margin: 0 0 4px; color: #d0d6df; font-size: 14px; line-height: 1.5; }
.menu-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  min-height: 66px;
  padding: 12px 16px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 9px;
  color: #f4f5f7;
  background: linear-gradient(180deg, #2b3038, #20242a);
  text-align: left;
  cursor: pointer;
}
.menu-action:hover:not(:disabled) { border-color: rgba(105, 199, 255, 0.55); background: #2c333c; }
.menu-action:disabled { opacity: 0.5; cursor: not-allowed; }
.menu-action:focus-visible { outline: 3px solid #6bc5ff; outline-offset: 2px; }
.menu-action > span:first-child { display: grid; gap: 5px; }
.menu-action strong { font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; }
.menu-action small { color: #d0d6df; font-size: 14px; line-height: 1.45; }
.menu-action > span:last-child { color: #75caff; font-size: 25px; }

</style>
