<template>
  <header class="top-status-strip" data-panel="status">
    <div class="status-cluster">
      <div class="status-pill" :class="{ ready: isInitialized, error: Boolean(initError) }">
        <span class="status-dot"></span>
        <span class="status-label">{{ initInFlight ? `CONNECTING ${audioModeLabel}` : uiStatus.message }}</span>
      </div>
      <div v-if="initError" class="status-error">{{ initError }}</div>
      <div class="status-note mode-summary">{{ capabilitySummary }}</div>
    </div>

    <div class="control-cluster">
      <button class="status-action" type="button" @click="$emit('retry-audio')">
        {{ isInitialized ? 'READY' : 'RETRY' }}
      </button>
      <button class="status-action" type="button" @click="$emit('toggle-audio-mode')">
        AUDIO {{ audioModeLabel }}
      </button>
      <button
        class="status-action primary"
        type="button"
        data-testid="ui-style-toggle"
        @click="$emit('toggle-ui-style')"
      >
        UI {{ uiStyleLabel }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { AudioUiStatus } from '../audio/AudioEngine';

defineProps<{
  isInitialized: boolean;
  initInFlight: boolean;
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
}>();
</script>

<style scoped>
.top-status-strip {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--shell-divider);
  background: var(--shell-status-background);
  backdrop-filter: blur(18px);
}

.status-cluster {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
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
  font-size: 11px;
}

.status-note {
  color: var(--text-muted);
}

.status-error {
  font-size: 10px;
  color: #ff8b8b;
}

.control-cluster {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.status-action {
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
    flex-direction: column;
  }

  .control-cluster {
    justify-content: flex-start;
  }
}
</style>
