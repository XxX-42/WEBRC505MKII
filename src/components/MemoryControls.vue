<template>
  <section class="memory-controls" aria-label="Memory and project controls">
    <header class="memory-heading">
      <div>
        <div class="panel-label">MEMORY / PROJECT</div>
        <div class="selected-memory">MEMORY {{ paddedSlot }} <span v-if="selectedMemoryName">· {{ selectedMemoryName }}</span></div>
      </div>
      <button class="assign-toggle" type="button" @click="showAssignments = !showAssignments">
        {{ showAssignments ? 'CLOSE ASSIGN' : 'CONTROL / ASSIGN 16' }}
      </button>
    </header>

    <div class="memory-row">
      <label for="memory-slot">MEMORY</label>
      <select id="memory-slot" v-model.number="slot" :disabled="busy">
        <option v-for="memoryId in 99" :key="memoryId" :value="memoryId">{{ String(memoryId).padStart(2, '0') }}<template v-if="memoryNames[memoryId]"> · {{ memoryNames[memoryId] }}</template></option>
      </select>
      <input v-model="memoryName" class="memory-name" type="text" maxlength="32" aria-label="Memory name" placeholder="Memory name">
    </div>

    <div class="memory-actions">
      <button type="button" :disabled="!serviceReady || busy" @click="saveMemory">SAVE</button>
      <button type="button" :disabled="!serviceReady || busy" @click="loadMemory">LOAD</button>
      <button type="button" :disabled="!serviceReady || busy" @click="openImport">IMPORT</button>
      <button type="button" :disabled="!serviceReady || busy" @click="exportProject">EXPORT PROJECT</button>
      <button type="button" :disabled="!serviceReady || busy" @click="exportMixWav">MIX WAV</button>
      <button type="button" :disabled="!serviceReady || busy" @click="showBounce = !showBounce">BOUNCE</button>
      <input ref="importInput" class="visually-hidden" type="file" accept=".wrcproj,application/x-webrc505-project" @change="importProject">
    </div>

    <div v-if="showBounce" class="bounce-panel">
      <fieldset class="bounce-sources" :disabled="busy">
        <legend>SOURCE TRACKS</legend>
        <label v-for="trackId in 5" :key="trackId" class="source-check">
          <input type="checkbox" :checked="bounceSources.includes(trackId)" :disabled="trackId === bounceTarget" @change="toggleBounceSource(trackId, $event)">
          TRACK {{ trackId }}
        </label>
      </fieldset>
      <label>TARGET
        <select v-model.number="bounceTarget" :disabled="busy" @change="ensureBounceSources"><option v-for="trackId in 5" :key="trackId" :value="trackId">TRACK {{ trackId }}</option></select>
      </label>
      <label class="bounce-duration">DURATION
        <select v-model="durationUnit" :disabled="busy"><option value="full">FULL LOOP</option><option value="seconds">SECONDS</option><option value="frames">FRAMES</option></select>
        <input v-if="durationUnit !== 'full'" v-model.number="durationValue" type="number" min="1" step="1" :aria-label="`Bounce duration in ${durationUnit}`" :disabled="busy">
      </label>
      <label class="realtime-setting"><input v-model="realtimeBounce" type="checkbox" :disabled="busy"> REALTIME</label>
      <button type="button" :disabled="!serviceReady || busy || !bounceSources.length" @click="bounce">RENDER BOUNCE</button>
    </div>

    <div v-if="operationText" class="project-operation" role="status">
      <span>{{ operationText }}</span>
      <progress v-if="progress !== null" :value="progress" max="1"></progress>
    </div>
    <p v-if="projectError" class="project-error" role="alert">{{ projectError }}</p>
    <p v-if="!serviceReady && !projectError" class="project-note">{{ unavailableReason }}</p>

    <ControlAssignPanel v-if="showAssignments" />
  </section>
</template>

<script setup lang="ts">
import { computed, markRaw, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { useMemorySlot } from '../composables/useMemorySlot';
import type { ProjectService } from '../project/ProjectService';
import type { ProjectBounceOptions, ProjectServiceState } from '../project/projectTypes';
import ControlAssignPanel from './ControlAssignPanel.vue';


const props = withDefaults(defineProps<{ modelValue?: number }>(), { modelValue: 1 });
const emit = defineEmits<{ 'update:modelValue': [slot: number] }>();
const engine = AudioEngine.getInstance();
const { setActiveMemorySlot } = useMemorySlot();
const slot = ref(props.modelValue);
const memoryName = ref(`Memory ${String(slot.value).padStart(2, '0')}`);
const memoryNames = ref<Record<number, string>>({});
const state = ref<ProjectServiceState>({ busy: false, operation: 'idle', error: null, progress: null });
const serviceReady = ref(false);
const service = shallowRef<ProjectService | null>(null);
const projectError = ref('');
const showAssignments = ref(false);
const showBounce = ref(false);
const bounceSources = ref([1]);
const bounceTarget = ref(2);
const durationUnit = ref<'full' | 'seconds' | 'frames'>('full');
const durationValue = ref<number | null>(null);
const realtimeBounce = ref(false);
const importInput = ref<HTMLInputElement | null>(null);
let unsubscribeStatus: (() => void) | null = null;
let unsubscribeProject: (() => void) | null = null;

const paddedSlot = computed(() => String(slot.value).padStart(2, '0'));
const selectedMemoryName = computed(() => memoryNames.value[slot.value] || '');
const busy = computed(() => state.value.busy);
const progress = computed(() => state.value.progress);
const operationText = computed(() => {
  if (state.value.operation !== 'idle') return `${state.value.operation.toUpperCase()}${progress.value === null ? '' : ` · ${Math.round(progress.value * 100)}%`}`;
  return state.value.busy ? 'WORKING…' : '';
});
const unavailableReason = computed(() => engine.getMode() !== 'browser'
  ? 'Memory projects require the browser audio engine.'
  : 'Start browser audio to open the project store.');

watch(slot, (value) => {
  emit('update:modelValue', value);
  if (!memoryNames.value[value]) memoryName.value = `Memory ${String(value).padStart(2, '0')}`;
  else memoryName.value = memoryNames.value[value]!;
});
watch(() => props.modelValue, (value) => { if (value !== slot.value) slot.value = value; });

const getProjectService = (): ProjectService | null => {
  try {
    return (engine as unknown as { getProjectService?: () => ProjectService | null }).getProjectService?.() ?? null;
  } catch {
    return null;
  }
};

const refreshMemories = async (projects: ProjectService | null = service.value) => {
  if (!projects) return;
  const memories = await projects.listMemories();
  memoryNames.value = Object.fromEntries(memories.map((memory) => [memory.slot, memory.name]));
};

const attachProjectService = () => {
  const next = getProjectService();
  if (next === service.value) return;
  unsubscribeProject?.();
  unsubscribeProject = null;
  service.value = next ? markRaw(next) : null;
  serviceReady.value = Boolean(next);
  if (!next) return;
  state.value = next.getState();
  unsubscribeProject = next.subscribe((nextState) => {
    state.value = nextState;
    projectError.value = nextState.error ?? '';
  });
  void refreshMemories(next).catch((error: unknown) => {
    projectError.value = error instanceof Error ? error.message : String(error);
  });
};

const withProjectOperation = async (operation: () => Promise<unknown>) => {
  if (!service.value) return;
  projectError.value = '';
  try {
    await operation();
    if (service.value) state.value = service.value.getState();
  } catch (error) {
    projectError.value = error instanceof Error ? error.message : String(error);
  }
};

const saveMemory = () => withProjectOperation(async () => {
  await service.value!.saveMemory(slot.value, memoryName.value.trim() || `Memory ${paddedSlot.value}`);
  setActiveMemorySlot(slot.value);
  await refreshMemories();
});

const loadMemory = () => withProjectOperation(async () => {
  await service.value!.loadMemory(slot.value);
  setActiveMemorySlot(slot.value);
  await refreshMemories();
});

const openImport = () => importInput.value?.click();

const importProject = (event: Event) => withProjectOperation(async () => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  await service.value!.importProject(file);
  input.value = '';
  await refreshMemories();
});

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const exportProject = () => withProjectOperation(async () => {
  const blob = await service.value!.exportProject();
  downloadBlob(blob, `Memory${paddedSlot.value}.wrcproj`);
});

const exportMixWav = () => withProjectOperation(async () => {
  const selectedTrackIds = engine.tracks
    .map((track, index) => ({ track, trackId: index + 1 }))
    .filter(({ track }) => track.state !== 'EMPTY')
    .map(({ trackId }) => trackId);
  if (selectedTrackIds.length === 0) throw new Error('Record audio on at least one track before exporting a mix.');
  const blob = await service.value!.exportMixWav({ selectedTrackIds });
  downloadBlob(blob, `Memory${paddedSlot.value}-Mix.wav`);
});

const toggleBounceSource = (trackId: number, event: Event) => {
  const included = (event.target as HTMLInputElement).checked;
  if (included && trackId !== bounceTarget.value && !bounceSources.value.includes(trackId)) bounceSources.value.push(trackId);
  if (!included) bounceSources.value = bounceSources.value.filter((id) => id !== trackId);
};

const ensureBounceSources = () => {
  if (bounceSources.value.includes(bounceTarget.value)) {
    bounceSources.value = bounceSources.value.filter((id) => id !== bounceTarget.value);
  }
  if (bounceSources.value.length === 0) {
    const source = Array.from({ length: 5 }, (_, index) => index + 1).find((id) => id !== bounceTarget.value);
    if (source) bounceSources.value = [source];
  }
};

const bounce = () => withProjectOperation(async () => {
  const options: ProjectBounceOptions = {
    selectedTrackIds: [...bounceSources.value],
    realtime: realtimeBounce.value,
  };
  if (durationUnit.value === 'seconds' && durationValue.value) options.durationSeconds = durationValue.value;
  if (durationUnit.value === 'frames' && durationValue.value) options.durationFrames = durationValue.value;
  await service.value!.bounceTrack(bounceTarget.value, options);
  await refreshMemories();
});

onMounted(() => {
  attachProjectService();
  unsubscribeStatus = engine.onStatusChange(attachProjectService);
});

onUnmounted(() => {
  unsubscribeStatus?.();
  unsubscribeProject?.();
});
</script>

<style scoped>
.memory-controls { display: flex; flex-direction: column; gap: 8px; min-width: 258px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.1); border-radius: 10px; background: rgba(4,5,8,.76); color: #e6e9ef; box-shadow: 0 8px 20px rgba(0,0,0,.3); }
.memory-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.panel-label { color: #7f8794; font: 700 8px var(--font-hardware); letter-spacing: 1.4px; }
.selected-memory { margin-top: 2px; color: #eef2fa; font: 700 11px var(--font-hardware); letter-spacing: .6px; }
.selected-memory span { color: #8fa0b7; font-weight: 400; }
.assign-toggle, .memory-actions button, .bounce-panel button { border: 1px solid rgba(92,173,255,.28); border-radius: 6px; background: rgba(18,52,78,.8); color: #d7edff; padding: 6px 8px; font: 700 8px var(--font-hardware); letter-spacing: .5px; cursor: pointer; }
.memory-row { display: grid; grid-template-columns: auto 68px minmax(86px,1fr); align-items: center; gap: 6px; font: 8px var(--font-hardware); letter-spacing: .6px; color: #99a0ab; }
.memory-row select, .memory-row input, .bounce-panel select { min-width: 0; height: 27px; padding: 0 6px; border: 1px solid rgba(255,255,255,.1); border-radius: 5px; background: #202229; color: #e7eaf0; font: 9px var(--font-hardware); }
.memory-actions { display: flex; gap: 5px; flex-wrap: wrap; }
.memory-actions button:disabled, .bounce-panel button:disabled { opacity: .42; cursor: not-allowed; }
.bounce-panel { display: grid; grid-template-columns: minmax(140px,1.4fr) minmax(74px,.8fr) minmax(100px,1fr); align-items: end; gap: 7px; padding: 8px; border-radius: 7px; background: rgba(255,255,255,.04); }
.bounce-sources { display: flex; gap: 6px; flex-wrap: wrap; grid-column: 1 / -1; margin: 0; padding: 4px 6px 8px; border: 1px solid rgba(255,255,255,.12); border-radius: 5px; }
.bounce-sources legend { color: #888f9b; font: 8px var(--font-hardware); }
.source-check, .realtime-setting { display: inline-flex; flex-direction: row !important; align-items: center; gap: 4px !important; }
.source-check input, .realtime-setting input { accent-color: #58c69e; }
.bounce-duration input { height: 27px; border: 1px solid rgba(255,255,255,.1); border-radius: 5px; background: #202229; color: #e7eaf0; }
.bounce-panel label { display: flex; flex-direction: column; gap: 4px; color: #888f9b; font: 8px var(--font-hardware); }
.realtime-setting { grid-column: 1 / -1; }
.bounce-panel button { grid-column: 1 / -1; }
.project-operation, .project-note, .project-error { margin: 0; color: #9ba4b2; font: 9px/1.4 var(--font-hardware); }
.project-error { color: #ffadb6; }
.project-operation { display: flex; align-items: center; gap: 8px; }
.project-operation progress { width: 72px; height: 6px; accent-color: #59c3a7; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
</style>
