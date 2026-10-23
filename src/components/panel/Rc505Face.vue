<template>
  <section class="rc505-face" data-testid="rc505-physical-face" aria-label="BOSS RC-505mkII top control panel">
    <header class="face-branding" aria-label="BOSS RC-505mkII">
      <div class="connection-legends" aria-hidden="true"><span>MIC 1　　　MIC 2　　　L—INST 1—R　　　L—INST 2—R</span><span>MAIN　　SUB 1　　SUB 2　　PHONES　　CTL/EXP</span><span>IN　 MIDI　 OUT　　 USB　　 POWER　　 DC IN</span></div>
      <div class="boss-mark">BOSS</div>
      <div class="model-mark">
        <span class="model-name">RC-505mkII</span>
        <span class="model-subtitle">LOOP STATION</span>
      </div>
    </header>

    <div class="face-upper" data-panel="hardware-top">
      <FxBankControls
        location="input"
        title="INPUT FX"
        color="red"
        :model-value="inputFxValue"
        @update:model-value="setInputFxValue"
        @edit="openFxEditor('input-fx')"
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
        @edit="openFxEditor('track-fx')"
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
const trackSharedBank = useFxPanelState('track');
const trackActiveSlot = computed(() => trackSharedBank.slots.value.find((slot) => slot.id === trackSharedBank.activeSlot.value) ?? trackSharedBank.slots.value[0]);
const inputFxValue = computed(() => inputActiveSlot.value?.value ?? 0);
const trackFxValue = computed(() => trackActiveSlot.value?.value ?? 0);
const inputFxEmpty = computed(() => !inputActiveSlot.value?.type || inputActiveSlot.value.type === 'NONE');
const trackFxEmpty = computed(() => !trackActiveSlot.value?.type || trackActiveSlot.value.type === 'NONE');
const inputFxDisabled = computed(() => inputBank.fxDisabled.value || inputFxEmpty.value);
const trackFxDisabled = computed(() => trackSharedBank.fxDisabled.value || trackFxEmpty.value);
const inputFxReason = computed(() => inputBank.fxUnavailableReason.value || (inputFxEmpty.value ? 'Select an effect first to edit its value.' : 'Input FX is unavailable on this audio runtime.'));
const trackFxReason = computed(() => trackSharedBank.fxUnavailableReason.value || (trackFxEmpty.value ? 'Select an effect first to edit its value.' : 'Track FX is unavailable on this audio runtime.'));

function openFxEditor(target: 'input-fx' | 'track-fx'): void {
  if (target === 'track-fx') trackBank.selectTarget('shared');
  device.classicDispatch({ type: 'OPEN_EDITOR', target, category: target });
  device.openPage(target);
}

function setInputFxValue(value: number): void { inputFxEditor.value?.updateActiveValue(value); }
function setTrackFxValue(value: number): void { trackBank.selectTarget('shared'); trackFxEditor.value?.updateActiveValue(value); }
function setInputFxParameter(group: string, key: string, value: number): void {
  if (!inputFxEditor.value) throw new Error('Input FX controller is not ready.');
  inputFxEditor.value.setLcdParameter(group, key, value);
}
function setTrackFxParameter(group: string, key: string, value: number): void {
  if (!trackFxEditor.value) throw new Error('Track FX controller is not ready.');
  trackBank.selectTarget('shared');
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
  background:
    linear-gradient(112deg, transparent 0 19.8%, rgba(255,255,255,.028) 19.9% 20%, transparent 20.1% 79.8%, rgba(0,0,0,.32) 79.9% 80%, transparent 80.1%),
    radial-gradient(ellipse at 46% 5%, rgba(106, 53, 70, .15), transparent 52%),
    linear-gradient(180deg, #37363d 0%, #211f26 10%, #16161b 100%);
  box-shadow: 0 22px 44px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.22), inset 0 -3px rgba(0,0,0,.72);
}

.face-branding {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  min-height: 51px;
  padding: 0 28px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  background: linear-gradient(180deg, rgba(71,69,77,.72), rgba(29,28,34,.3));
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.boss-mark { color: #f5f3f6; font-size: 22px; font-weight: 900; font-style: italic; letter-spacing: 0.1em; text-shadow: 0 1px 1px #000; }
.model-mark { display: flex; align-items: baseline; gap: 13px; color: #f5f6f7; }
.model-name { color: #f44f72; font-size: 18px; font-weight: 800; letter-spacing: 0.12em; text-shadow: 0 1px #09090c; }
.model-subtitle { color: #d1d6dd; font-size: 12px; letter-spacing: 0.12em; }
.panel-caption { justify-self: end; color: #c0c6cf; font-size: 11px; letter-spacing: 0.12em; }

.face-upper {
  position: relative;
  display: block;
  width: 100%;
  height: 269px;
  min-height: 269px;
  border-bottom: 1px solid #6a2b40;
  background:
    radial-gradient(ellipse at 50% 0%, rgba(130,118,132,.14), transparent 56%),
    linear-gradient(180deg, #39363e 0%, #29262e 66%, #201e25 100%);
}
.face-upper::after {
  content: '';
  position: absolute;
  z-index: 5;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 3px;
  border-top: 1px solid rgba(255,134,170,.58);
  background: linear-gradient(90deg, #4e2638, #cf365d 22%, #6f2c48 50%, #e74770 78%, #44243a);
  box-shadow: 0 0 6px rgba(213,42,91,.36);
  pointer-events: none;
}
.face-upper > :deep(.fx-bank-input) { position: absolute; inset: 0 auto 0 0; width: 330px; }
.face-upper > :deep(.center-main-panel) { position: absolute; inset: 0 auto 0 329px; width: 830px; }
.face-upper > :deep(.fx-bank-track) { position: absolute; inset: 0 0 0 auto; width: 360px; }
.face-upper > :deep(.fx-bank) { min-width: 0; min-height: 0; overflow: visible; }
.face-upper > :deep(.fx-bank .bank-status) { display: none; }
.track-header { display: none; }
.rc505-face :deep(.track-bay) {
  width: 1375px;
  height: 524px;
  min-width: 1375px;
  margin-inline: auto;
  padding-bottom: 0;
  border-top: 3px solid #2f1d2a;
  background: linear-gradient(180deg, #281c28 0%, #17171c 8px, transparent 8px);
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

.rc505-face :deep(.screen-shell) { top: 28px; left: 295px; width: 268px; height: 125px; }
/* High-confidence physical silhouettes from the complete frontal photograph. */
.face-upper::after { height: 9px; border-top: 1px solid #d0d1d6; background: linear-gradient(#bebfc8,#8c8e98); box-shadow: 0 1px 2px #090a0d; }
.rc505-face :deep(.fx-slot-button) { width: 48px !important; min-width: 48px !important; height: 48px !important; transform: translate(-6px,-6px); }
.rc505-face :deep(.bank-heading) { top: 159px; left: 215px; }
.rc505-face :deep(.fx-bank-track .bank-heading) { left: 48px; }
.rc505-face :deep(.bank-heading h2) { color: #d84956; font-size: 16px; }
.rc505-face :deep(.bank-kicker) { display: none; }
.rc505-face :deep([data-panel-control="all-transport"]),
.rc505-face :deep([data-panel-control="undo-redo"]),
.rc505-face :deep([data-panel-control="rhythm-start"]),
.rc505-face :deep([data-panel-control="tap-tempo"]) { border-radius: 22px; height: 40px; }
.rc505-face :deep([data-panel-control="rhythm-start"]),
.rc505-face :deep([data-panel-control="tap-tempo"]) { width: 78px; min-width: 78px; }
.face-upper > :deep(.center-main-panel) { z-index: 1; }
.rc505-face :deep([data-panel-control="rhythm-start"]) { left: 766px; }

/* Static front-panel printing: engineering approximation, not an official logo asset. */
.face-branding { position: relative; background: #202126; border-bottom: 0; }
.connection-legends { position: absolute; left: 140px; right: 130px; top: 6px; display: flex; justify-content: space-between; gap: 16px; color: #d6d7dc; font: 8px Arial,sans-serif; white-space: nowrap; pointer-events: none; }
.face-branding::after { content: ''; position: absolute; left: 140px; right: 130px; top: 27px; height: 20px; background: #df2635; clip-path: polygon(0 0,100% 0,100% 9%,73% 9%,70% 100%,32% 100%,29% 9%,0 9%); pointer-events: none; }
.boss-mark { position: absolute; z-index: 6; top: 54px; left: 225px; display: flex; align-items: center; gap: 5px; color: #d4d7df; font: 900 28px/1 Arial,sans-serif; letter-spacing: -.07em; text-shadow: 0 1px #08090b; pointer-events: none; }
.boss-mark::before { content: ''; width: 20px; height: 22px; border: 2px solid #c7cbd4; background: linear-gradient(90deg,transparent 40%,#c7cbd4 41% 51%,transparent 52%),linear-gradient(0deg,transparent 45%,#c7cbd4 46% 55%,transparent 56%); box-shadow: inset 0 0 0 3px #24252a; }
.model-mark { position: absolute; z-index: 2; left: 50%; top: 30px; transform: translateX(-50%); gap: 7px; white-space: nowrap; }
.model-name,.model-subtitle { color: #17191d; font-family: Arial,sans-serif; font-weight: 900; font-size: 17px; letter-spacing: .015em; text-shadow: none; }

</style>
