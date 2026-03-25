<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import TopStatusStrip from './components/TopStatusStrip.vue';
import WebToolLayer from './components/WebToolLayer.vue';
import ClassicShell from './components/shells/ClassicShell.vue';
import TechShell from './components/shells/TechShell.vue';
import { AudioEngine, type AudioMode, type AudioUiStatus } from './audio/AudioEngine';
import { useUiStyle } from './composables/useUiStyle';

const engine = AudioEngine.getInstance();
const isInitialized = ref(false);
const initError = ref('');
const initInFlight = ref(false);
const audioMode = ref<AudioMode>(engine.getMode());
const uiStatus = ref<AudioUiStatus>(engine.getUiStatus());
let unsubscribeStatus: (() => void) | null = null;

const { currentStyle, toggleStyle } = useUiStyle();

const audioModeLabel = computed(() => audioMode.value === 'browser' ? 'BROWSER' : 'NATIVE');
const uiStyleLabel = computed(() => currentStyle.value === 'classic' ? 'CLASSIC' : 'TECH');
const capabilitySummary = computed(() => {
  audioMode.value;
  return engine.getCapabilities().modeSummary;
});

const initAudio = async (silent = false) => {
  if (isInitialized.value || initInFlight.value) {
    return;
  }

  if (!silent) {
    initError.value = '';
  }

  initInFlight.value = true;
  try {
    await engine.init();
    isInitialized.value = true;
    uiStatus.value = engine.getUiStatus();
    initError.value = uiStatus.value.lastError;
  } catch (error) {
    console.error('Failed to initialize audio engine:', error);
    uiStatus.value = engine.getUiStatus();
    if (!silent) {
      initError.value = uiStatus.value.lastError || `${audioModeLabel.value} audio is unavailable.`;
    }
  } finally {
    initInFlight.value = false;
  }
};

const toggleAudioMode = () => {
  const nextMode: AudioMode = audioMode.value === 'browser' ? 'native' : 'browser';
  AudioEngine.setPreferredMode(nextMode);
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('audio', nextMode);
  window.location.href = nextUrl.toString();
};

onMounted(() => {
  unsubscribeStatus = engine.onStatusChange((status) => {
    audioMode.value = status.mode;
    uiStatus.value = status;
    isInitialized.value = status.ready;
    initError.value = status.lastError;
  });
  initAudio();
});

onUnmounted(() => {
  unsubscribeStatus?.();
});
</script>

<template>
  <div class="app-root" :data-ui-style="currentStyle">
    <TopStatusStrip
      :is-initialized="isInitialized"
      :init-in-flight="initInFlight"
      :init-error="initError"
      :audio-mode-label="audioModeLabel"
      :ui-style-label="uiStyleLabel"
      :capability-summary="capabilitySummary"
      :ui-status="uiStatus"
      @retry-audio="initAudio()"
      @toggle-audio-mode="toggleAudioMode"
      @toggle-ui-style="toggleStyle"
    />

    <main class="app-main">
      <ClassicShell v-if="currentStyle === 'classic'" />
      <TechShell v-else />
    </main>

    <div class="tool-dock">
      <WebToolLayer />
    </div>
  </div>
</template>

<style scoped>
.app-root {
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--app-background);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  position: relative;
}

.app-main {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.tool-dock {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 200;
  max-width: min(100vw - 36px, 380px);
}

@media (max-width: 900px) {
  .app-root {
    overflow: auto;
    height: auto;
    min-height: 100vh;
  }

  .app-main {
    min-height: 0;
  }

  .tool-dock {
    position: static;
    margin: 0 18px 18px;
    max-width: none;
  }
}
</style>
