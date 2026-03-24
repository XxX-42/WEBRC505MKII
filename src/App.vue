<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import LatencyTuner from './components/LatencyTuner.vue';
import TopPanel from './components/TopPanel.vue';
import TrackUnit from './components/TrackUnit.vue';
import { AudioEngine, type AudioMode, type AudioUiStatus } from './audio/AudioEngine';

const engine = AudioEngine.getInstance();
const isInitialized = ref(false);
const initError = ref('');
const theme = ref<'night' | 'day'>('day');
const initInFlight = ref(false);
const audioMode = ref<AudioMode>(engine.getMode());
const uiStatus = ref<AudioUiStatus>(engine.getUiStatus());
let unsubscribeStatus: (() => void) | null = null;

const themeLabel = computed(() => theme.value === 'night' ? 'NIGHT' : 'DAY');
const audioModeLabel = computed(() => audioMode.value === 'browser' ? 'BROWSER' : 'NATIVE');

const applyTheme = (nextTheme: 'night' | 'day') => {
  theme.value = nextTheme;
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('webrc505_theme', nextTheme);
};

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

const toggleTheme = () => {
  applyTheme(theme.value === 'night' ? 'day' : 'night');
};

const toggleAudioMode = () => {
  const nextMode: AudioMode = audioMode.value === 'browser' ? 'native' : 'browser';
  AudioEngine.setPreferredMode(nextMode);
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('audio', nextMode);
  window.location.href = nextUrl.toString();
};

onMounted(() => {
  const savedTheme = localStorage.getItem('webrc505_theme');
  if (savedTheme === 'day' || savedTheme === 'night') {
    applyTheme(savedTheme);
  } else {
    document.documentElement.dataset.theme = theme.value;
  }

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
  <div class="app-root">
    <button class="theme-toggle" type="button" @click="toggleTheme" :aria-label="`Switch theme from ${themeLabel} mode`">
      <span class="theme-toggle-label">THEME</span>
      <span class="theme-toggle-value">{{ themeLabel }}</span>
    </button>

    <button class="audio-mode-toggle" type="button" @click="toggleAudioMode" :aria-label="`Switch audio mode from ${audioModeLabel}`">
      <span class="theme-toggle-label">AUDIO</span>
      <span class="theme-toggle-value">{{ audioModeLabel }}</span>
    </button>

    <div class="engine-status" :class="{ ready: isInitialized, error: Boolean(initError) }">
      <span class="engine-status-dot"></span>
      <span class="engine-status-text">
        {{ initInFlight ? `CONNECTING ${audioModeLabel}` : uiStatus.message }}
      </span>
      <button v-if="!isInitialized" class="engine-status-action" type="button" @click="initAudio()">
        RETRY
      </button>
    </div>

    <p v-if="initError" class="engine-status-error">
      {{ initError }}
    </p>

    <div class="main-layout">
      <div class="top-section">
        <TopPanel />
      </div>

      <div class="main-workspace">
        <div class="track-list">
          <TrackUnit v-for="i in 5" :key="i" :trackId="i" />
        </div>
      </div>

      <div class="latency-overlay">
        <LatencyTuner />
      </div>
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

.main-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.top-section {
  flex: 0 0 auto;
  z-index: 50;
  width: 100%;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}

.main-workspace {
  flex: 1;
  display: flex;
  justify-content: flex-start;
  align-items: flex-start;
  overflow-y: auto;
  overflow-x: auto;
  padding-top: 20px;
  padding-bottom: 20px;
  position: relative;
  width: 100%;
}

.track-list {
  display: flex;
  gap: 16px;
  padding: 24px;
  min-width: max-content;
  margin: 0 auto;
  background: var(--track-list-background);
  border-radius: 12px;
  border: 1px solid var(--panel-border);
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.18);
}

.latency-overlay {
  position: absolute;
  bottom: 20px;
  right: 20px;
  z-index: 100;
  opacity: 0.6;
  transition: opacity 0.3s;
}

.latency-overlay:hover {
  opacity: 1;
}

.engine-status {
  position: absolute;
  top: 18px;
  left: 20px;
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--panel-elevated);
  border: 1px solid var(--panel-border-strong);
  border-radius: 999px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
}

.engine-status.ready .engine-status-dot {
  background: var(--led-green-playing);
  box-shadow: var(--glow-green-soft);
}

.engine-status.error .engine-status-dot {
  background: var(--led-red-recording);
  box-shadow: var(--glow-red-soft);
}

.engine-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--led-yellow-overdub);
  box-shadow: var(--glow-yellow-soft);
}

.engine-status-text {
  font-family: var(--font-hardware);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--text-primary);
}

.engine-status-action {
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--panel-border-strong);
  background: transparent;
  color: var(--color-accent);
  font-family: var(--font-hardware);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  transition: border-color 0.16s ease, transform 0.16s ease;
}

.engine-status-action:hover {
  transform: translateY(-1px);
  border-color: var(--color-accent);
}

.engine-status-action:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.engine-status-error {
  position: absolute;
  top: 62px;
  left: 20px;
  z-index: 200;
  max-width: 420px;
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(255, 0, 51, 0.08);
  border: 1px solid rgba(255, 0, 51, 0.18);
  color: #ff7a7a;
  font-size: 12px;
  line-height: 1.4;
}

.theme-toggle {
  position: absolute;
  top: 18px;
  right: 20px;
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 999px;
  border: 1px solid var(--panel-border-strong);
  background: var(--panel-elevated);
  color: var(--text-primary);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.audio-mode-toggle {
  position: absolute;
  top: 68px;
  right: 20px;
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 999px;
  border: 1px solid var(--panel-border-strong);
  background: var(--panel-elevated);
  color: var(--text-primary);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.audio-mode-toggle:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
  border-color: var(--color-accent);
}

.audio-mode-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.theme-toggle:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
  border-color: var(--color-accent);
}

.theme-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.theme-toggle-label,
.theme-toggle-value {
  font-family: var(--font-hardware);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.4px;
  text-transform: uppercase;
}

.theme-toggle-label {
  color: var(--text-muted);
}

.theme-toggle-value {
  color: var(--color-accent);
}

@media (max-width: 768px) {
  .engine-status {
    top: 10px;
    left: 12px;
    max-width: calc(100vw - 150px);
  }

  .engine-status-error {
    top: 56px;
    left: 12px;
    max-width: calc(100vw - 24px);
  }

  .theme-toggle {
    top: 10px;
    right: 12px;
    padding: 8px 12px;
  }

  .audio-mode-toggle {
    top: 56px;
    right: 12px;
    padding: 8px 12px;
  }

  .main-workspace {
    padding: 12px;
  }

  .track-list {
    padding: 12px;
    gap: 10px;
  }

  .latency-overlay {
    position: static;
    margin: 8px 12px 12px;
    opacity: 1;
    align-self: stretch;
  }
}
</style>
