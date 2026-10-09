<template>
  <div class="control-surface-host" aria-live="polite">
    <p v-if="error" class="control-error" role="status">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { useControlDispatcher } from '../composables/useControlDispatcher';

const engine = AudioEngine.getInstance();
const { dispatcher, error, bindProjectStateAdapter } = useControlDispatcher();
let unsubscribeStatus: (() => void) | null = null;

const handleKeydown = (event: KeyboardEvent) => {
  dispatcher.handleKeyboardEvent(event);
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  bindProjectStateAdapter();
  unsubscribeStatus = engine.onStatusChange(bindProjectStateAdapter);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  unsubscribeStatus?.();
});
</script>

<style scoped>
.control-surface-host {
  position: fixed;
  inset: auto 12px 12px auto;
  z-index: 1000;
  pointer-events: none;
}

.control-error {
  max-width: min(460px, calc(100vw - 24px));
  margin: 0;
  padding: 10px 14px;
  border: 1px solid rgba(255, 100, 116, 0.48);
  border-radius: 8px;
  background: rgba(40, 8, 14, 0.94);
  color: #ffd8de;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  font: 12px/1.4 var(--font-hardware);
  pointer-events: auto;
}
</style>
