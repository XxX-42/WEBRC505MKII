<template>
  <header class="top-status-strip" data-panel="status">
    <div class="status-cluster">
      <div class="status-pill" role="status" aria-live="polite" :class="{ ready: isInitialized, error: Boolean(initError) }">
        <span class="status-dot"></span>
        <span class="status-label">{{ initInFlight ? (uiStatus.inputState === 'requesting' ? 'ALLOW MICROPHONE' : `CONNECTING ${audioModeLabel}`) : (!initStarted && audioModeLabel === 'BROWSER' && !isInitialized ? 'BROWSER · CLICK START AUDIO' : uiStatus.message) }}</span>
      </div>
      <div v-if="initError" class="status-error" role="alert">{{ initError }}</div>
      <div class="status-note mode-summary" :title="capabilitySummary">{{ capabilitySummary }}</div>
      <div v-if="isInitialized && audioModeLabel === 'BROWSER'" class="input-status" data-testid="input-status">INPUT {{ uiStatus.inputReady ? 'READY' : 'NOT CONNECTED' }} · OUTPUT READY</div>
    </div>

    <div class="control-cluster">
      <button class="status-action start-action" data-testid="start-audio" type="button" :disabled="isInitialized && (audioModeLabel !== 'BROWSER' || uiStatus.inputReady)" @click="$emit('retry-audio')">
        {{ initInFlight ? 'CONNECTING…' : isInitialized && (audioModeLabel !== 'BROWSER' || uiStatus.inputReady) ? 'READY' : isInitialized ? 'CONNECT INPUT' : initStarted ? 'RETRY AUDIO' : 'START AUDIO' }}
      </button>
      <button class="status-action" type="button" @click="$emit('toggle-audio-mode')">
        AUDIO {{ audioModeLabel }}
      </button>
      <details class="app-menu">
        <summary class="status-action">SETTINGS</summary>
        <div class="menu-items">
          <button class="status-action" type="button" @click="$emit('open-settings')">AUDIO SETTINGS</button>
          <button class="status-action" type="button" @click="$emit('toggle-tools')">MONITOR / DIAGNOSTICS</button>
          <button v-if="audioModeLabel === 'NATIVE'" class="status-action" type="button" :disabled="initInFlight" @click="$emit('restart-native')">RESTART NATIVE / APPLY FX</button>
          <button class="status-action primary" type="button" data-testid="ui-style-toggle" @click="$emit('toggle-ui-style')">UI {{ uiStyleLabel }}</button>
        </div>
      </details>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { AudioUiStatus } from '../audio/AudioEngine';

defineProps<{
  isInitialized: boolean;
  initInFlight: boolean;
  initStarted?: boolean;
  initError: string;
  audioModeLabel: string;
  uiStyleLabel: string;
  capabilitySummary: string;
  uiStatus: AudioUiStatus;
}>();

defineEmits<{
  (e: 'retry-audio'): void;
  (e: 'toggle-audio-mode'): void;
  (e: 'toggle-ui-style'): void;
  (e: 'open-settings'): void;
  (e: 'toggle-tools'): void;
  (e: 'restart-native'): void;
}>();
</script>

<style scoped>
.top-status-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  flex-shrink: 0;
  z-index: 300;
  border-bottom: 1px solid var(--shell-divider);
  background: var(--shell-status-background);
  backdrop-filter: blur(18px);
}

.status-cluster {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  width: fit-content;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--shell-divider);
  background: rgba(255, 255, 255, 0.04);
}

.status-pill.ready .status-dot {
  background: var(--led-green-playing);
  box-shadow: var(--glow-green-soft);
}

.status-pill.error .status-dot {
  background: var(--led-red-recording);
  box-shadow: var(--glow-red-soft);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--led-yellow-overdub);
  box-shadow: var(--glow-yellow-soft);
}

.status-label,
.status-note,
.status-error,
.status-action {
  font-family: var(--font-hardware);
  letter-spacing: 1.1px;
  text-transform: uppercase;
}

.status-label,
.status-note {
  font-size: 13px;
  line-height: 1.45;
}

.status-note {
  color: var(--text-muted);
}

.status-error {
  font-size: 13px;
  line-height: 1.45;
  color: #ff8b8b;
  max-width: 680px;
}

.input-status { font-size: 13px; line-height: 1.45; color: #c7cdd6; }
.status-note { max-width: 60vw; color: #c7cdd6; overflow-wrap: anywhere; }
.status-action:focus-visible, .app-menu summary:focus-visible { outline: 2px solid #ef5064; outline-offset: 3px; }
.status-action:disabled { opacity: .5; cursor: default; }
.status-action:not(:disabled):hover { background: rgba(255,255,255,.12); }
.start-action:not(:disabled) { border-color: #b92d44; }
.app-menu { position: relative; }
.app-menu summary { list-style: none; display: flex; align-items: center; cursor: pointer; }
.menu-items { position: absolute; right: 0; top: calc(100% + 8px); min-width: 230px; padding: 10px; display: grid; gap: 8px; background: #17191f; border: 1px solid #535563; border-radius: 10px; box-shadow: 0 12px 30px #0009; }

.control-cluster {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-action {
  font-size: 13px;
  min-height: 38px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--shell-divider);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  cursor: pointer;
}

.status-action.primary {
  color: var(--color-accent);
}

@media (max-width: 900px) {
  .top-status-strip {
    flex-wrap: wrap;
  }

  .control-cluster {
    justify-content: flex-start;
  }
  .status-note { max-width: 88vw; }
}
</style>
