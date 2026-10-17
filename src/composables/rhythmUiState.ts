import { computed, onMounted, onUnmounted, reactive } from 'vue';
import type { RhythmPlaybackSettings } from '../audio/RhythmEngine';
import { NativeRhythmEngine } from '../audio/NativeRhythmEngine';
import { AudioEngine } from '../audio/AudioEngine';

/** Shared settings keep the top strip and center panel's controls synchronized. */
export const rhythmUiState = reactive<RhythmPlaybackSettings>({
  patternIndex: 106,
  kitIndex: 1,
  variation: 'A',
  section: 'main',
  swingPercent: 50,
  quantizeGrid: '1/16',
});

/** Apply either runtime's shared selection in one restart-safe call. */
export function applyRhythmUiSettings(): boolean | Promise<boolean> {
  const audio = AudioEngine.getInstance();
  if (!audio.getCapabilities().supportsRhythm) return false;
  return audio.rhythmEngine.setSettings({ ...rhythmUiState });
}

const playback = reactive({ available: false, reason: '', isPlaying: false, volume: 50, error: '', pending: 0 });

/** Both panels observe the same ACK-backed Native state and Browser worklet state. */
export function useRhythmUiControls(options: { initializeOnMount?: boolean } = {}) {
  const audio = AudioEngine.getInstance();
  let unsubscribe: (() => void) | undefined;
  const sync = () => {
    const capabilities = audio.getCapabilities();
    const rhythm = audio.rhythmEngine;
    playback.available = capabilities.supportsRhythm;
    playback.reason = capabilities.rhythmReason;
    playback.error = rhythm.error || '';
    if (typeof rhythm.isRunning === 'boolean') playback.isPlaying = rhythm.isRunning;
    if (rhythm instanceof NativeRhythmEngine && playback.pending === 0) {
      const settings = rhythm.settings;
      if (settings) {
        Object.assign(rhythmUiState, {
          patternIndex: settings.patternIndex, kitIndex: settings.kitIndex, variation: settings.variation,
          section: settings.section, swingPercent: settings.swingPercent, quantizeGrid: settings.quantizeGrid,
        });
        playback.volume = settings.volume;
      }
    }
    if (!playback.available) playback.isPlaying = false;
  };

  const perform = async (action: () => void | boolean | Promise<boolean>): Promise<boolean> => {
    if (!audio.getCapabilities().supportsRhythm) { sync(); return false; }
    playback.error = '';
    playback.pending += 1;
    try {
      const result = await action();
      if (result === false && !audio.rhythmEngine.error) playback.error = 'The rhythm change was rejected.';
      return result !== false;
    } catch (error) {
      playback.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      playback.pending -= 1;
      const error = playback.error;
      sync();
      // Also support engines that reject without supplying their own error text.
      if (error && !playback.error) playback.error = error;
    }
  };

  const toggleRhythm = async () => {
    if (playback.pending > 0) return false;
    const wasPlaying = playback.isPlaying;
    const success = await perform(() => wasPlaying ? audio.rhythmEngine.stop() : audio.rhythmEngine.start());
    // Browser starts synchronously; Native state always comes from its ACK.
    if (success && !(audio.rhythmEngine instanceof NativeRhythmEngine)) {
      playback.isPlaying = typeof audio.rhythmEngine.isRunning === 'boolean' ? audio.rhythmEngine.isRunning : !wasPlaying;
    }
    return success;
  };
  const applySelection = () => {
    const selection = { ...rhythmUiState };
    return perform(() => audio.rhythmEngine.setSettings(selection));
  };
  const updateVolume = () => {
    const volume = playback.volume;
    return perform(() => audio.rhythmEngine.setVolume(volume));
  };
  const updateSelection = (selection: Partial<RhythmPlaybackSettings>) => {
    Object.assign(rhythmUiState, selection);
    return applySelection();
  };

  sync();
  onMounted(() => {
    sync();
    // A Native mount reads the running host instead of overwriting its settings.
    if (options.initializeOnMount !== false && !(audio.rhythmEngine instanceof NativeRhythmEngine)) {
      void applySelection();
      void updateVolume();
    }
    unsubscribe = audio.onStatusChange?.(sync);
  });
  onUnmounted(() => unsubscribe?.());

  return {
    selection: rhythmUiState,
    isPlaying: computed(() => playback.isPlaying),
    volume: computed({ get: () => playback.volume, set: (value: number) => { playback.volume = value; } }),
    disabled: computed(() => !playback.available),
    pending: computed(() => playback.pending > 0),
    message: computed(() => playback.error || playback.reason),
    toggleRhythm, applySelection, updateSelection, updateVolume,
  };
}
