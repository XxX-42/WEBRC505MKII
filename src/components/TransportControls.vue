<template>
  <div class="transport-bar">
    <div class="bpm-module">
      <div class="module-label">TEMPO</div>
      <div class="led-display-container">
        <div class="led-display">
          <span class="led-digits">{{ bpmDisplay }}</span>
        </div>
        <div class="bpm-controls">
          <button @click="adjustBpm(-1)" class="bpm-adjust-btn" aria-label="Decrease BPM">
            <span>−</span>
          </button>
          <button @click="adjustBpm(1)" class="bpm-adjust-btn" aria-label="Increase BPM">
            <span>+</span>
          </button>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="transport-controls">
      <HardwareButton
        size="lg"
        :color="isPlaying ? 'red' : 'green'"
        :active="isPlaying"
        :label="isPlaying ? 'STOP ALL' : 'PLAY ALL'"
        :aria-label="isPlaying ? 'Stop all tracks' : 'Play all tracks'"
        @press="toggleTransport"
        class="transport-button"
      />

      <HardwareButton
        size="sm"
        color="blue"
        :active="tapActive"
        label="TAP"
        aria-label="Tap tempo"
        @press="handleTap"
        class="tap-button"
      />
    </div>

    <div class="divider"></div>

    <div class="beat-indicator-module">
      <div class="module-label">BEAT</div>
      <div class="beat-led" :class="{ active: beatIndicator }"></div>
    </div>

    <div class="divider"></div>

    <div class="thru-module">
      <HardwareButton
        size="sm"
        color="red"
        :active="isThruActive"
        label="THRU"
        aria-label="Toggle direct monitoring"
        @press="toggleThru"
        class="thru-button"
      />
    </div>

    <div class="divider"></div>

    <div class="settings-module">
      <HardwareButton
        size="md"
        color="white"
        label="⚙ SETTINGS"
        aria-label="Open audio settings"
        @press="openSettings"
        class="settings-button"
      />
    </div>

    <AudioSettings v-model="showSettings" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Transport } from '../core/Transport';
import { TransportState } from '../core/types';
import { AudioEngine } from '../audio/AudioEngine';
import HardwareButton from './ui/HardwareButton.vue';
import AudioSettings from './AudioSettings.vue';

const transport = Transport.getInstance();
const engine = AudioEngine.getInstance();

const bpm = ref(transport.bpm);
const isPlaying = ref(false);
const beatIndicator = ref(false);
const tapActive = ref(false);
const showSettings = ref(false);
const isThruActive = ref(engine.monitoringEnabled);
let unsubscribeMonitoring: (() => void) | null = null;

const bpmDisplay = computed(() => bpm.value.toString().padStart(3, '0'));

const updateState = () => {
  bpm.value = transport.bpm;
  isPlaying.value = transport.state === TransportState.PLAYING;
};

const adjustBpm = (delta: number) => {
  const newBpm = Math.max(40, Math.min(300, transport.bpm + delta));
  transport.setBpm(newBpm);
  updateState();
};

const toggleTransport = () => {
  if (transport.state === TransportState.PLAYING) {
    transport.stop();
  } else {
    transport.start();
  }
  updateState();
};

const openSettings = () => {
  showSettings.value = true;
};

const toggleThru = () => {
  if (!isThruActive.value) {
    const confirmed = confirm(
      '⚠️ WARNING: FEEDBACK RISK!\n\n' +
      'Enabling THRU will route your microphone directly to speakers.\n\n' +
      'This will cause loud squealing/howling if you are using speakers.\n\n' +
      'Only proceed if you are using headphones.\n\n' +
      'Enable THRU?'
    );

    if (confirmed) {
      engine.setMonitoring(true);
      isThruActive.value = true;
      console.log('🎧 THRU ENABLED - Monitoring active (use headphones)');
    }
  } else {
    engine.setMonitoring(false);
    isThruActive.value = false;
    console.log('🔇 THRU DISABLED - Monitoring off');
  }
};

let tapTimes: number[] = [];
let tapResetTimer: number | null = null;
let beatFlashTimer: number | null = null;
let tapFlashTimer: number | null = null;

const handleTap = () => {
  tapActive.value = true;
  if (tapFlashTimer) {
    clearTimeout(tapFlashTimer);
  }
  tapFlashTimer = window.setTimeout(() => {
    tapActive.value = false;
    tapFlashTimer = null;
  }, 100);

  const now = Date.now();
  tapTimes.push(now);

  if (tapTimes.length > 4) {
    tapTimes.shift();
  }

  if (tapTimes.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < tapTimes.length; i++) {
      const current = tapTimes[i];
      const previous = tapTimes[i - 1];
      if (current !== undefined && previous !== undefined) {
        intervals.push(current - previous);
      }
    }
    if (intervals.length > 0) {
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const calculatedBpm = Math.round(60000 / avgInterval);

      if (calculatedBpm >= 40 && calculatedBpm <= 300) {
        transport.setBpm(calculatedBpm);
        updateState();
      }
    }
  }

  if (tapResetTimer) {
    clearTimeout(tapResetTimer);
  }
  tapResetTimer = window.setTimeout(() => {
    const lastTap = tapTimes[tapTimes.length - 1];
    if (lastTap !== undefined && Date.now() - lastTap > 3000) {
      tapTimes = [];
    }
    tapResetTimer = null;
  }, 3000);
};

const onTick = () => {
  beatIndicator.value = true;
  if (beatFlashTimer) {
    clearTimeout(beatFlashTimer);
  }
  beatFlashTimer = window.setTimeout(() => {
    beatIndicator.value = false;
    beatFlashTimer = null;
  }, 100);
};

onMounted(() => {
  transport.on('start', updateState);
  transport.on('stop', updateState);
  transport.on('bpm-change', updateState);
  transport.on('beat', onTick);
  unsubscribeMonitoring = engine.onMonitoringChange((enabled) => {
    isThruActive.value = enabled;
  });
});

onUnmounted(() => {
  transport.off('start', updateState);
  transport.off('stop', updateState);
  transport.off('bpm-change', updateState);
  transport.off('beat', onTick);

  if (tapResetTimer) {
    clearTimeout(tapResetTimer);
  }
  if (beatFlashTimer) {
    clearTimeout(beatFlashTimer);
  }
  if (tapFlashTimer) {
    clearTimeout(tapFlashTimer);
  }
  unsubscribeMonitoring?.();
});
</script>

<style scoped>
.transport-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 16px 24px;
  background: var(--bg-panel-secondary);
  border: 2px solid #0d0d0d;
  border-radius: var(--border-radius-hardware);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.03),
    inset 0 -1px 0 rgba(0, 0, 0, 0.8),
    0 4px 12px rgba(0, 0, 0, 0.8);
}

.divider {
  width: 2px;
  height: 48px;
  background: linear-gradient(
    180deg,
    transparent 0%,
    rgba(255, 255, 255, 0.1) 50%,
    transparent 100%
  );
}

.bpm-module {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.module-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(240, 240, 240, 0.4);
  font-family: var(--font-mono);
  text-align: center;
  text-transform: uppercase;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
}

.led-display-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.led-display {
  position: relative;
  padding: 12px 20px;
  background: #0a0000;
  border: 2px solid #1a0000;
  border-radius: 4px;
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.9),
    inset 0 -1px 2px rgba(255, 0, 0, 0.05),
    0 0 8px rgba(255, 0, 0, 0.1);
}

.led-digits {
  font-family: 'Courier New', 'Roboto Mono', monospace;
  font-size: 32px;
  font-weight: 700;
  color: #ff0033;
  letter-spacing: 4px;
  text-shadow:
    0 0 8px rgba(255, 0, 51, 0.8),
    0 0 16px rgba(255, 0, 51, 0.4),
    0 0 24px rgba(255, 0, 51, 0.2);
  font-variant-numeric: tabular-nums;
}

.bpm-controls {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bpm-adjust-btn {
  width: 28px;
  height: 22px;
  background: var(--gradient-plastic-dark);
  border: 1px solid rgba(0, 0, 0, 0.8);
  border-radius: 3px;
  color: rgba(240, 240, 240, 0.6);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.08s ease-out;
  box-shadow: var(--button-border-raised);
}

.bpm-adjust-btn:hover {
  background: var(--gradient-plastic-light);
  color: rgba(240, 240, 240, 0.9);
}

.bpm-adjust-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.bpm-adjust-btn:active {
  box-shadow: var(--button-border-pressed);
  transform: translateY(1px);
}

.transport-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}

.beat-indicator-module {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.beat-led {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #1a1a1a;
  border: 2px solid rgba(0, 0, 0, 0.6);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.8),
    0 1px 1px rgba(255, 255, 255, 0.05);
  transition: all 0.05s ease-out;
}

.beat-led.active {
  background: var(--led-red-recording);
  box-shadow:
    0 0 8px rgba(255, 0, 51, 0.8),
    0 0 16px rgba(255, 0, 51, 0.5),
    inset 0 1px 2px rgba(255, 255, 255, 0.2);
}

@media (max-width: 768px) {
  .transport-bar {
    flex-wrap: wrap;
    justify-content: center;
    gap: 16px;
  }

  .divider {
    display: none;
  }
}
</style>
