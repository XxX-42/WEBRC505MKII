<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import TopStatusStrip from './components/TopStatusStrip.vue';
import WebToolLayer from './components/WebToolLayer.vue';
import ClassicShell from './components/shells/ClassicShell.vue';
import TechShell from './components/shells/TechShell.vue';
import { AudioEngine, type AudioMode, type AudioUiStatus } from './audio/AudioEngine';
import { useUiStyle } from './composables/useUiStyle';

const engine = AudioEngine.getInstance();
const isInitialized = ref(false);
const initError = ref('');
const actionError = ref('');
const initInFlight = ref(false);
const initStarted = ref(false);
const toolsOpen = ref(false);
const audioMode = ref<AudioMode>(engine.getMode());
const uiStatus = ref<AudioUiStatus>(engine.getUiStatus());
const confirmation = ref('');
const cancelConfirmationButton = ref<HTMLButtonElement | null>(null);
let resolveConfirmation: ((confirmed: boolean) => void) | null = null;
let confirmationOpener: HTMLElement | null = null;
let unsubscribeStatus: (() => void) | null = null;

function requestConfirmation(message: string): Promise<boolean> {
  if (resolveConfirmation) return Promise.resolve(false);
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation.value = message;
  void nextTick(() => cancelConfirmationButton.value?.focus());
  return new Promise((resolve) => { resolveConfirmation = resolve; });
}

function finishConfirmation(confirmed: boolean): void {
  confirmation.value = '';
  resolveConfirmation?.(confirmed);
  resolveConfirmation = null;
  const opener = confirmationOpener;
  void nextTick(() => { if (opener?.isConnected) opener.focus(); });
}

function trapConfirmationFocus(event: KeyboardEvent): void {
  const buttons = Array.from((event.currentTarget as HTMLElement).querySelectorAll('button'));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  event.preventDefault();
  buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
}

function handleConfirmationRequest(event: Event): void {
  const request = (event as CustomEvent<{ message: string; resolve: (confirmed: boolean) => void }>).detail;
  if (!request || typeof request.resolve !== 'function') return;
  void requestConfirmation(request.message).then(request.resolve);
}
const acceptScreenConfirmation = () => { if (confirmation.value) finishConfirmation(true); };
const cancelScreenConfirmation = () => { if (confirmation.value) finishConfirmation(false); };

const { currentStyle, toggleStyle } = useUiStyle();

const audioModeLabel = computed(() => audioMode.value === 'browser' ? 'BROWSER' : 'NATIVE');
const uiStyleLabel = computed(() => currentStyle.value === 'classic' ? 'CLASSIC' : 'TECH');
const capabilitySummary = computed(() => {
  audioMode.value;
  // Capability fields live on the Native bridge snapshot rather than in Vue
  // state. Track the subscribed status ref so a post-init bridge ACK rerenders
  // the summary (for example, one track becoming five, or FX becoming ready).
  void uiStatus.value;
  return engine.getCapabilities().modeSummary;
});

const initAudio = async (silent = false) => {
  if (initInFlight.value || (isInitialized.value && (audioMode.value !== 'browser' || uiStatus.value.inputReady))) {
    return;
  }

  if (!silent) {
    actionError.value = '';
    initError.value = '';
  }

  initInFlight.value = true;
  initStarted.value = true;
  try {
    await engine.init();
    if (audioMode.value === 'browser') await engine.prepareInputFromUserActivation();
    isInitialized.value = engine.getUiStatus().ready;
    uiStatus.value = engine.getUiStatus();
    initError.value = uiStatus.value.lastError;
  } catch (error) {
    console.error('Failed to initialize audio engine:', error);
    uiStatus.value = engine.getUiStatus();
    if (!silent) {
      initError.value = uiStatus.value.inputError || uiStatus.value.lastError || (error instanceof Error ? error.message : `${audioModeLabel.value} audio is unavailable.`);
    }
  } finally {
    initInFlight.value = false;
  }
};

const retryAudio = () => {
  if (initInFlight.value) {
    // BrowserAudioEngine.init may be waiting for a resume() call made before
    // user activation. Re-issue only resume in this trusted click handler; do
    // not start a second initialization while the first one is still pending.
    void engine.resumeFromUserActivation().catch((error: unknown) => {
      console.error('Failed to resume audio engine from user activation:', error);
    });
    return;
  }

  void initAudio();
};

const toggleAudioMode = async () => {
  if (engine.hasUnsavedLoops() && !await requestConfirmation('Switching audio mode reloads the app and discards the current unsaved loops. Continue?')) return;
  const nextMode: AudioMode = audioMode.value === 'browser' ? 'native' : 'browser';
  AudioEngine.setPreferredMode(nextMode);
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('audio', nextMode);
  window.location.href = nextUrl.toString();
};

const openSettings = () => window.dispatchEvent(new CustomEvent('rc505-open-audio-settings'));
const toggleTools = () => { toolsOpen.value = !toolsOpen.value; };
const restartNativeAudio = async () => {
  if (audioMode.value !== 'native' || initInFlight.value) return;
  if (engine.hasUnsavedLoops() && !await requestConfirmation('Applying Native FX briefly stops audio. Loops are retained at the current sample rate. Continue?')) return;
  initInFlight.value = true;
  actionError.value = '';
  initError.value = '';
  try {
    await engine.restartNativeAudio();
    uiStatus.value = engine.getUiStatus();
    isInitialized.value = uiStatus.value.ready;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
    initError.value = actionError.value;
  } finally { initInFlight.value = false; }
};

onMounted(() => {
  unsubscribeStatus = engine.onStatusChange((status) => {
    audioMode.value = status.mode;
    uiStatus.value = status;
    isInitialized.value = status.ready;
    initError.value = actionError.value || status.inputError || status.lastError;
  });
  window.addEventListener('rc505-toggle-ui-style', toggleStyle);
  window.addEventListener('rc505-toggle-tools', toggleTools);
  window.addEventListener('rc505-restart-native-audio', restartNativeAudio);
  window.addEventListener('rc505-request-confirmation', handleConfirmationRequest);
  window.addEventListener('rc505-accept-confirmation', acceptScreenConfirmation);
  window.addEventListener('rc505-cancel-confirmation', cancelScreenConfirmation);
  // Browser resume and input permission must originate in a trusted click.
  if (audioMode.value === 'native') void initAudio();
});

onUnmounted(() => {
  resolveConfirmation?.(false);
  unsubscribeStatus?.();
  window.removeEventListener('rc505-toggle-ui-style', toggleStyle);
  window.removeEventListener('rc505-toggle-tools', toggleTools);
  window.removeEventListener('rc505-restart-native-audio', restartNativeAudio);
  window.removeEventListener('rc505-request-confirmation', handleConfirmationRequest);
  window.removeEventListener('rc505-accept-confirmation', acceptScreenConfirmation);
  window.removeEventListener('rc505-cancel-confirmation', cancelScreenConfirmation);
});
</script>

<template>
  <div class="app-root" :data-ui-style="currentStyle">
    <TopStatusStrip
      :is-initialized="isInitialized"
      :init-in-flight="initInFlight"
      :init-started="initStarted"
      :init-error="initError"
      :audio-mode-label="audioModeLabel"
      :ui-style-label="uiStyleLabel"
      :capability-summary="capabilitySummary"
      :ui-status="uiStatus"
      @retry-audio="retryAudio"
      @toggle-audio-mode="toggleAudioMode"
      @toggle-ui-style="toggleStyle"
      @open-settings="openSettings"
      @toggle-tools="toggleTools"
      @restart-native="restartNativeAudio"
    />

    <main class="app-main">
      <ClassicShell v-if="currentStyle === 'classic'" />
      <TechShell v-else />
    </main>

    <div class="tool-dock" :class="{ 'tools-open': toolsOpen }">
      <WebToolLayer />
    </div>
    <Teleport v-if="confirmation" :to="currentStyle === 'classic' ? '#rc505-lcd-confirmations' : 'body'">
    <div class="confirmation-backdrop" :class="{ 'confirmation-in-lcd': currentStyle === 'classic' }" @click.self="finishConfirmation(false)">
      <section role="alertdialog" aria-modal="true" aria-labelledby="audio-confirm-title" aria-describedby="audio-confirm-message"
        class="audio-confirmation" @keydown.esc.stop.prevent="finishConfirmation(false)" @keydown.tab="trapConfirmationFocus">
        <h2 id="audio-confirm-title">Confirm audio change</h2>
        <p id="audio-confirm-message">{{ confirmation }}</p>
        <div class="confirmation-actions">
          <button ref="cancelConfirmationButton" type="button" @click="finishConfirmation(false)">CANCEL</button>
          <button type="button" @click="finishConfirmation(true)">CONTINUE</button>
        </div>
      </section>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.confirmation-backdrop { position: fixed; inset: 0; z-index: 6000; display: grid; place-items: center; padding: 20px; background: #000b; }
.audio-confirmation { width: min(100%, 480px); padding: 24px; border: 1px solid #78818f; border-radius: 14px; background: #20242b; color: #f4f5f7; font: 16px/1.5 system-ui, sans-serif; }
.audio-confirmation h2 { margin: 0 0 12px; font-size: 21px; }
.confirmation-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 22px; }
.confirmation-actions button { padding: 10px 18px; border: 1px solid #8692a1; border-radius: 7px; color: white; background: #363d48; font-size: 14px; cursor: pointer; }
.confirmation-actions button:focus-visible { outline: 3px solid #73caff; outline-offset: 3px; }
.confirmation-in-lcd { position: absolute; padding: 0; background: #c6c0cf; z-index: 10; }
.confirmation-in-lcd .audio-confirmation { box-sizing: border-box; width: 100%; max-height: 100%; overflow: auto; padding: 7px; border: 0; border-radius: 0; background: #c6c0cf; color: #211e28; font-size: 12px; line-height: 1.2; }
.confirmation-in-lcd h2 { margin-bottom: 4px; font-size: 14px; }
.confirmation-in-lcd p { margin: 4px 0; }
.confirmation-in-lcd .confirmation-actions { margin-top: 5px; gap: 8px; }
.confirmation-in-lcd button { padding: 4px 9px; font-size: 12px; }
.app-root {
  height: 100dvh;
  width: 100%;
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
  right: 12px;
  top: 62px;
  z-index: 200;
  max-width: min(100vw - 24px, 380px);
}

.tool-dock:not(.tools-open) :deep(.tool-actions),
.tool-dock:not(.tools-open) :deep(.tool-latency) {
  display: none;
}

@media (max-width: 900px) {
  .app-root {
    min-height: 100dvh;
  }

  .app-main {
    min-height: 0;
  }

}
</style>
