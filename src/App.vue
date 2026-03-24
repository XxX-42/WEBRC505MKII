<script setup lang="ts">
import { ref } from 'vue';
import LatencyTuner from './components/LatencyTuner.vue';
import TopPanel from './components/TopPanel.vue';
import TrackUnit from './components/TrackUnit.vue';
import { AudioEngine } from './audio/AudioEngine';

const engine = AudioEngine.getInstance();
const isInitialized = ref(false);
const initError = ref('');

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
</script>

<template>
  <div class="app-root">
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
  background: radial-gradient(circle at center, #1a1a1a 0%, #050505 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
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
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.3);
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
  background: #0a0a0a;
}

.init-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 48px 64px;
  background: #111;
  border: 2px solid #222;
  border-radius: 16px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
}

.init-icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.12);
  background: linear-gradient(180deg, #2a2a2a 0%, #0d0d0d 100%);
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
  color: #ccc;
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
  color: #666;
  margin: 0;
}

.init-error {
  font-size: 12px;
  color: #ff7a7a;
  margin: 0;
  max-width: 320px;
  text-align: center;
}

@media (max-width: 768px) {
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
