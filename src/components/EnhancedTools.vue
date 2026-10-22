<script setup lang="ts">
import { computed, onUnmounted, reactive, watch } from 'vue';
import { createEnhancedDevicePanel } from '../composables/createEnhancedDevicePanel';
import { useDeviceScreenEditor, type DeviceScreenField } from '../composables/useDeviceScreenEditor';
import { usePanelFocus } from '../composables/usePanelFocus';
import type { DevicePanelPage } from '../composables/useDevicePanel';
import { useRc505Controls } from '../composables/useRc505Controls';
import InputFxPanel from './panel/InputFxPanel.vue';
import TrackFxPanel from './panel/TrackFxPanel.vue';

defineEmits<{ close: [] }>();
const panel = createEnhancedDevicePanel();
const editor = useDeviceScreenEditor({ surface: 'enhanced', panel });
const focus = usePanelFocus();
const controls = useRc505Controls();
const pages: Array<{ page: DevicePanelPage; label: string }> = [
  { page: 'menu', label: 'PROJECT / TOOLS' }, { page: 'track', label: 'PITCH / HQ WAV' },
  { page: 'input-fx', label: 'INPUT FX' }, { page: 'track-fx', label: 'PRIVATE / SHARED FX' },
  { page: 'memory', label: 'PROJECT MEMORY' }, { page: 'settings', label: 'AUDIO DEVICE' },
];
const fields = editor.fields;
const status = editor.status;
const page = computed(() => panel.state.page);
interface NumberDraft {
  value: string;
  target: HTMLInputElement;
  committed: boolean;
  cleanupTimer: number | null;
}
const numberDrafts = reactive(new Map<string, NumberDraft>());
const numberDraftContext = computed(() => `${page.value}:${editor.pageIndex.value}:${focus.state.currentTrackId}`);

function clearNumberDrafts(): void {
  for (const draft of numberDrafts.values()) {
    if (draft.cleanupTimer !== null) window.clearTimeout(draft.cleanupTimer);
  }
  numberDrafts.clear();
}

function numberValue(field: DeviceScreenField): string {
  return numberDrafts.get(field.key)?.value ?? String(field.value ?? '');
}

function beginNumberDraft(field: DeviceScreenField, event: Event): void {
  const target = event.target as HTMLInputElement;
  if (field.disabled) return;
  numberDrafts.set(field.key, { value: target.value, target, committed: true, cleanupTimer: null });
}

function updateNumberDraft(field: DeviceScreenField, event: Event): void {
  const draft = numberDrafts.get(field.key);
  if (!draft || draft.target !== event.target || field.disabled) return;
  if (draft.cleanupTimer !== null) window.clearTimeout(draft.cleanupTimer);
  draft.value = draft.target.value;
  draft.committed = false;
  draft.cleanupTimer = null;
}

function commitNumberDraft(field: DeviceScreenField, event: Event): void {
  const draft = numberDrafts.get(field.key);
  if (!draft || draft.target !== event.target) return;
  if (draft.committed) return;
  // Set the guard before invoking a setter because it may synchronously cause
  // the field list to be rebuilt by an engine/status update.
  draft.committed = true;
  const text = draft.value.trim();
  const value = Number(text);
  if (field.disabled || text === '' || !Number.isFinite(value)) return;
  void field.setValue?.(value);
}

function finishNumberDraft(field: DeviceScreenField, event: Event): void {
  const draft = numberDrafts.get(field.key);
  if (!draft || draft.target !== event.target) return;
  if (draft.cleanupTimer !== null) window.clearTimeout(draft.cleanupTimer);
  // Some browsers dispatch change as part of the same focus transition as
  // blur. Defer cleanup one task so either event order commits at most once.
  draft.cleanupTimer = window.setTimeout(() => {
    const current = numberDrafts.get(field.key);
    if (current !== draft) return;
    if (!current.committed) commitNumberDraft(field, event);
    numberDrafts.delete(field.key);
  }, 0);
}

watch(numberDraftContext, clearNumberDrafts, { flush: 'sync' });
watch(fields, (currentFields) => {
  for (const [key, draft] of numberDrafts) {
    if (!currentFields.some((field) => field.key === key && !field.disabled)) {
      if (draft.cleanupTimer !== null) window.clearTimeout(draft.cleanupTimer);
      numberDrafts.delete(key);
    }
  }
}, { flush: 'sync' });
onUnmounted(clearNumberDrafts);

function change(index: number, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) void fields.value[index]?.setValue?.(value);
}
</script>

<template>
  <Teleport to="body">
    <div class="enhanced-backdrop" @click.self="$emit('close')">
      <section class="enhanced-tools" role="dialog" aria-modal="true" aria-label="WEBRC505 Enhanced tools" data-testid="enhanced-tools" @keydown.esc.stop="$emit('close')">
        <header><strong>WEBRC505 · ENHANCED</strong><button type="button" autofocus @click="$emit('close')">CLOSE</button></header>
        <nav aria-label="Enhanced tools pages"><button v-for="item in pages" :key="item.page" type="button" :aria-pressed="page === item.page" @click="panel.openPage(item.page)">{{ item.label }}</button></nav>
        <label v-if="page === 'track'">TRACK <select aria-label="Enhanced track" :value="focus.state.currentTrackId" @change="focus.setCurrentTrack(Number(($event.target as HTMLSelectElement).value))"><option v-for="id in 5" :key="id" :value="id">{{ id }}</option></select></label>
        <fieldset v-if="page === 'input-fx' || page === 'track-fx'" :disabled="controls.state.fxBusy.input || controls.state.fxBusy.track">
          <legend>FX editor</legend><InputFxPanel v-if="page === 'input-fx'" /><TrackFxPanel v-else />
        </fieldset>
        <div v-else class="enhanced-fields">
          <label v-for="(field, index) in fields" :key="`${numberDraftContext}:${field.key}`" :data-field-key="field.key" :title="field.reason">
            <span>{{ field.label }}</span>
            <button v-if="field.kind === 'action'" type="button" :data-testid="`enhanced-field-${field.key}`" :disabled="field.disabled" @click="field.activate?.()">{{ field.label }}</button>
            <select :data-testid="`enhanced-field-${field.key}`" v-else-if="field.kind === 'enum'" :aria-label="field.label" :value="field.value" :disabled="field.disabled" @change="change(index, $event)"><option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
            <button :data-testid="`enhanced-field-${field.key}`" v-else-if="field.kind === 'boolean'" type="button" :aria-label="field.label" :aria-pressed="field.value >= 50" :disabled="field.disabled" @click="field.setValue?.(field.value >= 50 ? 0 : 100)">{{ field.value >= 50 ? 'ON' : 'OFF' }}</button>
            <input :data-testid="`enhanced-field-${field.key}`" v-else type="number" :aria-label="field.label" :value="numberValue(field)" :min="field.min" :max="field.max" :step="field.step ?? 1" :disabled="field.disabled" @focus="beginNumberDraft(field, $event)" @input="updateNumberDraft(field, $event)" @change="commitNumberDraft(field, $event)" @blur="finishNumberDraft(field, $event)">
            <small v-if="field.disabled">{{ field.reason }}</small>
          </label>
        </div>
        <footer v-if="page !== 'input-fx' && page !== 'track-fx'"><button type="button" @click="editor.stepPage(-1)">PREVIOUS</button><span>{{ editor.pageIndex.value + 1 }} / {{ editor.pageCount.value }}</span><button type="button" @click="editor.stepPage(1)">NEXT</button></footer>
        <p role="status">{{ status }}</p>
        <details><summary>DIAGNOSTICS</summary><p>{{ controls.state.errorDetail || 'No control-layer error.' }}</p><p>{{ status }}</p></details>
        <p class="enhanced-note">Project archives are software extensions. Hardware Memory parity is PARTIAL.</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.enhanced-backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 24px; background: #000b; }
.enhanced-tools { width: min(900px, 100%); max-height: 85vh; overflow: auto; padding: 20px; border: 1px solid #73829a; border-radius: 12px; background: #161b24; color: #f2f5fa; font: 14px/1.45 system-ui, sans-serif; }
header, nav, footer { display: flex; gap: 10px; justify-content: space-between; align-items: center; margin-bottom: 18px; } nav { flex-wrap: wrap; justify-content: start; }
button, select, input { min-height: 36px; padding: 6px 10px; border: 1px solid #6d798c; border-radius: 5px; background: #293342; color: #fff; font: inherit; } button { cursor: pointer; } button[aria-pressed=true] { border-color: #9ce1ff; background: #284b60; } :disabled { opacity: .55; cursor: not-allowed; }
.enhanced-fields { display: grid; gap: 16px; margin: 18px 0; } .enhanced-fields label { display: grid; grid-template-columns: 1fr minmax(200px, 1fr); gap: 8px; } small { grid-column: 1 / -1; color: #d0d7e2; } .enhanced-note { color: #c0cad9; }
</style>
