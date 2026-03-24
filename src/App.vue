<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import LatencyTuner from './components/LatencyTuner.vue';
import TopPanel from './components/TopPanel.vue';
import TrackUnit from './components/TrackUnit.vue';
import { AudioEngine } from './audio/AudioEngine';

const engine = AudioEngine.getInstance();
const isInitialized = ref(false);
const initError = ref('');
const theme = ref<'night' | 'day'>('night');

const themeLabel = computed(() => theme.value === 'night' ? 'NIGHT' : 'DAY');

const applyTheme = (nextTheme: 'night' | 'day') => {
  theme.value = nextTheme;
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('webrc505_theme', nextTheme);
};

const initAudio = async () => {
  initError.value = '';
  try {
    await engine.init();
    isInitialized.value = true;
  } catch (error) {
    console.error('Failed to initialize audio engine:', error);
    initError.value = 'Audio initialization failed. Please check microphone permissions and device settings.';
  }
};

const toggleTheme = () => {
  applyTheme(theme.value === 'night' ? 'day' : 'night');
};

onMounted(() => {
  const savedTheme = localStorage.getItem('webrc505_theme');
  if (savedTheme === 'day' || savedTheme === 'night') {
    applyTheme(savedTheme);
    return;
  }

  document.documentElement.dataset.theme = theme.value;
});
</script>

<template>
  <div class="app-root">
    <button class="theme-toggle" type="button" @click="toggleTheme" :aria-label="`Switch theme from ${themeLabel} mode`">
      <span class="theme-toggle-label">THEME</span>
      <span class="theme-toggle-value">{{ themeLabel }}</span>
    </button>

    <div v-if="!isInitialized" class="init-screen">
      <div class="init-panel">
        <div class="init-icon">RC</div>
        <h1 class="init-title">WebRC-505MKII</h1>
        <button @click="initAudio" class="init-button">
          START AUDIO ENGINE
        </button>
        <p class="init-hint">Click to initialize AudioContext & Worklets</p>
        <p v-if="initError" class="init-error">{{ initError }}</p>
      </div>
    </div>

    <div v-else class="main-layout">
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

.init-screen {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--app-init-background);
}

.init-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 48px 64px;
  background: var(--panel-elevated);
  border: 2px solid var(--panel-border-strong);
  border-radius: 16px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.28);
}

.init-icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 2px solid var(--panel-border);
  background: var(--panel-elevated);
  font-family: var(--font-hardware);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #ffcc00;
}

.init-title {
  font-family: var(--font-hardware);
  font-size: 24px;
  letter-spacing: 4px;
  color: var(--text-primary);
  margin: 0;
}

.init-button {
  padding: 16px 32px;
  background: #cc0000;
  color: white;
  border: none;
  border-radius: 4px;
  font-family: var(--font-hardware);
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 4px 12px rgba(204, 0, 0, 0.4);
}

.init-button:hover {
  background: #ff0033;
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(255, 0, 51, 0.5);
}

.init-button:active {
  transform: translateY(0);
}

.init-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}

.init-error {
  font-size: 12px;
  color: #ff7a7a;
  margin: 0;
  max-width: 320px;
  text-align: center;
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
  .theme-toggle {
    top: 10px;
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
