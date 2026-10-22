import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { NativeHqEngine } from '../audio/NativeBridgeClient';
import type { HqWavExportRequestOptions } from '../audio/export/hqWavExport';
import type { WavSampleFormat } from '../audio/export/wavEncoder';
import { TrackState } from '../core/types';
import { usePanelFocus } from './usePanelFocus';

type LivePitchMode = 'OFF' | 'LIVE_MONO' | 'LIVE_POLY';

type LivePitchTrack = {
  setLiveMonoPitchEnabled?: (enabled: boolean, options?: { semitones?: number }) => Promise<void> | void;
  setLivePolyPitchEnabled?: (enabled: boolean, options?: { semitones?: number }) => Promise<void> | void;
  liveMonoPitchEnabled?: boolean;
  livePolyPitchEnabled?: boolean;
  liveMonoPitchActive?: boolean;
  livePolyPitchActive?: boolean;
  liveMonoPitchLatencySamples?: number | null;
  livePolyPitchLatencySamples?: number | null;
  liveMonoPitchFallbackReason?: string | null;
  livePolyPitchFallbackReason?: string | null;
};

interface StoredLivePitchSettings {
  mode: LivePitchMode;
  semitones: number;
}

interface StoredTrackStripSettings extends StoredLivePitchSettings {
  hqMemoryBudgetMiB: number;
}

const TRACK_STRIP_SETTINGS_STORAGE_PREFIX = 'webrc505_track_strip_settings_v1';
const clampSemitones = (value: number) => Math.max(-12, Math.min(12, Math.round(value)));
const DEFAULT_HQ_MEMORY_BUDGET_MIB = 512;
const clampHqMemoryBudgetMiB = (value: number) => Math.max(64, Math.min(4096, Math.round(value / 64) * 64));
const isLivePitchMode = (value: unknown): value is LivePitchMode => (
  value === 'OFF' || value === 'LIVE_MONO' || value === 'LIVE_POLY'
);

export function useTrackStripState(trackId: number) {
  const engine = AudioEngine.getInstance();
  const trackAudio = engine.tracks[trackId - 1]!;
  const livePitchTrack = trackAudio as unknown as LivePitchTrack;
  const readAudioMode = () => typeof engine.getMode === 'function' ? engine.getMode() : 'browser';
  const getLivePitchStorageKey = () => {
    const mode = readAudioMode();
    const backend = engine.selectedBackend ?? (mode === 'browser' ? 'BROWSER' : 'NATIVE');
    return `${TRACK_STRIP_SETTINGS_STORAGE_PREFIX}:${mode}:${backend}:track:${trackId}`;
  };
  const readStoredTrackSettings = (key: string): StoredTrackStripSettings => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return { mode: 'OFF', semitones: 0, hqMemoryBudgetMiB: DEFAULT_HQ_MEMORY_BUDGET_MIB };
      const value = JSON.parse(raw) as Partial<StoredTrackStripSettings>;
      return {
        mode: isLivePitchMode(value.mode) ? value.mode : 'OFF',
        semitones: typeof value.semitones === 'number' && Number.isFinite(value.semitones)
          ? clampSemitones(value.semitones)
          : 0,
        hqMemoryBudgetMiB: typeof value.hqMemoryBudgetMiB === 'number' && Number.isFinite(value.hqMemoryBudgetMiB)
          ? clampHqMemoryBudgetMiB(value.hqMemoryBudgetMiB)
          : DEFAULT_HQ_MEMORY_BUDGET_MIB,
      };
    } catch {
      return { mode: 'OFF', semitones: 0, hqMemoryBudgetMiB: DEFAULT_HQ_MEMORY_BUDGET_MIB };
    }
  };
  let livePitchStorageKey = getLivePitchStorageKey();
  const storedTrackSettings = readStoredTrackSettings(livePitchStorageKey);
  const hqExportTrack = typeof trackAudio.exportHqWav === 'function'
    ? trackAudio
    : null;
  const trackCapabilities = ref(engine.getTrackCapabilities(trackId));
  const focus = usePanelFocus();

  const trackState = ref(trackAudio.state);
  const currentAudioMode = ref(readAudioMode());
  const playLevel = ref(trackAudio.track.playLevel);
  const trackAvailable = ref(trackAudio.isAvailable);
  const trackTransportEnabled = ref(trackAudio.transportEnabled);
  const disabledReason = ref(trackCapabilities.value.availabilityReason || trackAudio.disabledReason);
  const getOverdubDiagnostic = () => 'overdubDiagnostic' in trackAudio ? trackAudio.overdubDiagnostic : null;
  const overdubDiagnostic = ref(getOverdubDiagnostic());
  const getRecordingDiagnostic = () => 'recordingDiagnostic' in trackAudio ? trackAudio.recordingDiagnostic : null;
  const recordingDiagnostic = ref(getRecordingDiagnostic());
  const hqPitchSemitones = ref(0);
  const hqPlaybackRate = ref(1);
  const hqWavFormat = ref<WavSampleFormat>('pcm16');
  const hqMemoryBudgetMiB = ref(storedTrackSettings.hqMemoryBudgetMiB);
  const hqNativeEngine = ref<NativeHqEngine>('R3');
  const nativeHqRendererAvailable = ref(false);
  const nativeHqRendererEngines = ref<NativeHqEngine[]>([]);
  const isHqExporting = ref(false);
  const hqExportProgress = ref(0);
  const hqExportError = ref('');
  const isClearing = ref(false);
  const livePitchMode = ref<LivePitchMode>(storedTrackSettings.mode);
  const livePitchSemitones = ref(storedTrackSettings.semitones);
  const lastLivePitchSemitones = ref(storedTrackSettings.semitones);
  const livePitchChanging = ref(false);
  const livePitchError = ref('');
  const livePitchActionStatus = ref('');
  const livePitchRuntimeReady = ref(false);
  const livePitchRestoreAttempted = ref(false);
  const lastLivePitchSelection = ref<LivePitchMode>(storedTrackSettings.mode);
  const liveMonoPitchSupported = computed(() => typeof livePitchTrack.setLiveMonoPitchEnabled === 'function');
  const livePolyPitchSupported = computed(() => typeof livePitchTrack.setLivePolyPitchEnabled === 'function');
  const isNativePitchMode = computed(() => (typeof engine.getMode === 'function' ? engine.getMode() : 'browser') === 'native');
  const isNativeAudioMode = computed(() => currentAudioMode.value === 'native');
  const isTrackBusyForPitch = computed(() => (
    trackState.value === TrackState.RECORDING || trackState.value === TrackState.REC_FINISHING
  ));
  const livePitchControlsDisabled = computed(() => (
    !trackAvailable.value || (!liveMonoPitchSupported.value && !livePolyPitchSupported.value)
      || isTrackBusyForPitch.value || livePitchChanging.value
  ));
  const livePitchFallbackReason = ref('');
  const livePitchActive = ref(false);
  const livePitchLatencyFrames = ref<number | null>(null);
  const livePitchLatencyMs = ref<number | null>(null);
  const livePitchStatus = computed(() => {
    if (livePitchActionStatus.value) return livePitchActionStatus.value;
    if (livePitchError.value) return 'KEEP PITCH ERROR';
    if (livePitchMode.value === 'OFF') return 'KEEP PITCH OFF';
    if (!livePitchRuntimeReady.value) return `SAVED ${livePitchMode.value}; WAITING FOR AUDIO RUNTIME`;
    if (livePitchFallbackReason.value) return `${livePitchMode.value} FALLBACK`;
    if (livePitchActive.value) return `${livePitchMode.value} ACTIVE`;
    const enabled = livePitchMode.value === 'LIVE_MONO'
      ? livePitchTrack.liveMonoPitchEnabled
      : livePitchTrack.livePolyPitchEnabled;
    return enabled ? `${livePitchMode.value} ENABLED; WAITING FOR LOOP PLAYBACK` : `${livePitchMode.value} INACTIVE`;
  });
  let livePitchSelectionWasPersisted = storedTrackSettings.mode !== 'OFF' || storedTrackSettings.semitones !== 0;
  let pollInterval = 0;
  let stopPressTimer: number | null = null;
  let clearVisualTimer: number | null = null;
  const stopPressActive = ref(false);
  let stopPressTriggered = false;
  let stopPressSource: 'pointer' | 'keyboard' | null = null;
  let stopPressPointerId: number | null = null;
  const LONG_PRESS_DURATION = 1500;

  type StopPressSource = 'pointer' | 'keyboard';
  const resolveStopPressSource = (sourceOrEvent?: StopPressSource | PointerEvent | MouseEvent | TouchEvent | KeyboardEvent): StopPressSource => (
    sourceOrEvent === 'keyboard' ? 'keyboard' : 'pointer'
  );

  const getPitchRuntimeReady = () => {
    if (typeof engine.getUiStatus === 'function') return engine.getUiStatus().ready;
    return !!trackAudio.transportEnabled;
  };

  const persistTrackSettings = () => {
    try {
      window.localStorage.setItem(livePitchStorageKey, JSON.stringify({
        mode: livePitchMode.value,
        semitones: livePitchSemitones.value,
        hqMemoryBudgetMiB: hqMemoryBudgetMiB.value,
      }));
      livePitchSelectionWasPersisted = true;
      return true;
    } catch {
      livePitchError.value = 'Could not save KeepPitch settings in this browser';
      return false;
    }
  };

  const pitchEnabled = (mode: Exclude<LivePitchMode, 'OFF'>) => mode === 'LIVE_MONO'
    ? livePitchTrack.liveMonoPitchEnabled === true
    : livePitchTrack.livePolyPitchEnabled === true;

  const syncLivePitchUi = () => {
    const mode = livePitchMode.value;
    const active = mode === 'LIVE_MONO'
      ? livePitchTrack.liveMonoPitchActive
      : mode === 'LIVE_POLY'
        ? livePitchTrack.livePolyPitchActive
        : false;
    const fallback = mode === 'LIVE_MONO'
      ? livePitchTrack.liveMonoPitchFallbackReason
      : mode === 'LIVE_POLY'
        ? livePitchTrack.livePolyPitchFallbackReason
        : null;
    const frames = mode === 'LIVE_MONO'
      ? livePitchTrack.liveMonoPitchLatencySamples
      : mode === 'LIVE_POLY'
        ? livePitchTrack.livePolyPitchLatencySamples
        : null;
    const sampleRate = Number(engine.selectedSampleRate);
    livePitchRuntimeReady.value = getPitchRuntimeReady();
    livePitchActive.value = active === true;
    livePitchFallbackReason.value = typeof fallback === 'string' ? fallback : '';
    livePitchLatencyFrames.value = typeof frames === 'number' && Number.isFinite(frames) ? frames : null;
    livePitchLatencyMs.value = livePitchLatencyFrames.value !== null && Number.isFinite(sampleRate) && sampleRate > 0
      ? livePitchLatencyFrames.value / sampleRate * 1000
      : null;
  };

  const applyLivePitchMode = async (mode: LivePitchMode, previousMode: LivePitchMode) => {
    if (isTrackBusyForPitch.value || trackAudio.state === TrackState.RECORDING || trackAudio.state === TrackState.REC_FINISHING) {
      livePitchError.value = 'KeepPitch controls are locked while recording or finalizing';
      syncLivePitchUi();
      return;
    }
    if (!livePitchRuntimeReady.value) {
      livePitchActionStatus.value = mode === 'OFF' ? '' : `SAVED ${mode}; WAITING FOR AUDIO RUNTIME`;
      return;
    }
    if (mode === 'LIVE_MONO' && !liveMonoPitchSupported.value) {
      livePitchError.value = 'LIVE_MONO is not available on this audio runtime';
      return;
    }
    if (mode === 'LIVE_POLY' && !livePolyPitchSupported.value) {
      livePitchError.value = 'LIVE_POLY is not available on this audio runtime';
      return;
    }
    if (mode !== 'OFF' && !trackAvailable.value) {
      livePitchError.value = disabledReason.value || 'This track is unavailable on the current audio runtime';
      return;
    }

    livePitchChanging.value = true;
    livePitchError.value = '';
    livePitchActionStatus.value = mode === 'OFF' ? 'DISABLING KEEP PITCH…' : `APPLYING ${mode}…`;
    const semitoneOptions = { semitones: clampSemitones(livePitchSemitones.value) };
    try {
      const modesToDisable = new Set<Exclude<LivePitchMode, 'OFF'>>();
      if (previousMode !== 'OFF' && previousMode !== mode) modesToDisable.add(previousMode);
      if (livePitchTrack.liveMonoPitchEnabled === true && mode !== 'LIVE_MONO') modesToDisable.add('LIVE_MONO');
      if (livePitchTrack.livePolyPitchEnabled === true && mode !== 'LIVE_POLY') modesToDisable.add('LIVE_POLY');
      for (const activeMode of modesToDisable) {
        if (activeMode === 'LIVE_MONO' && liveMonoPitchSupported.value) {
          await livePitchTrack.setLiveMonoPitchEnabled!(false, semitoneOptions);
        } else if (activeMode === 'LIVE_POLY' && livePolyPitchSupported.value) {
          await livePitchTrack.setLivePolyPitchEnabled!(false, semitoneOptions);
        }
      }
      if (mode === 'LIVE_MONO') await livePitchTrack.setLiveMonoPitchEnabled!(true, semitoneOptions);
      if (mode === 'LIVE_POLY') await livePitchTrack.setLivePolyPitchEnabled!(true, semitoneOptions);
      livePitchActionStatus.value = '';
    } catch (error) {
      livePitchError.value = error instanceof Error ? error.message : 'KeepPitch could not be applied';
      livePitchActionStatus.value = '';
    } finally {
      livePitchChanging.value = false;
      syncLivePitchUi();
    }
  };

  const restorePersistedLivePitchWhenReady = () => {
    const nextKey = getLivePitchStorageKey();
    if (nextKey !== livePitchStorageKey) {
      livePitchStorageKey = nextKey;
      const settings = readStoredTrackSettings(livePitchStorageKey);
      livePitchMode.value = settings.mode;
      livePitchSemitones.value = settings.semitones;
      lastLivePitchSemitones.value = settings.semitones;
      hqMemoryBudgetMiB.value = settings.hqMemoryBudgetMiB;
      lastLivePitchSelection.value = settings.mode;
      livePitchSelectionWasPersisted = settings.mode !== 'OFF' || settings.semitones !== 0;
      livePitchRestoreAttempted.value = false;
      livePitchError.value = '';
    }
    syncLivePitchUi();
    if (!livePitchRuntimeReady.value || livePitchRestoreAttempted.value || livePitchChanging.value || isTrackBusyForPitch.value) return;
    const hasEnabledRoute = pitchEnabled('LIVE_MONO') || pitchEnabled('LIVE_POLY');
    if (livePitchMode.value === 'OFF' && !hasEnabledRoute) {
      livePitchRestoreAttempted.value = true;
      return;
    }
    if (!livePitchSelectionWasPersisted && livePitchMode.value !== 'OFF') return;
    livePitchRestoreAttempted.value = true;
    void applyLivePitchMode(livePitchMode.value, lastLivePitchSelection.value);
  };

  const handleLivePitchModeChange = () => {
    if (isTrackBusyForPitch.value || trackAudio.state === TrackState.RECORDING || trackAudio.state === TrackState.REC_FINISHING) {
      livePitchMode.value = lastLivePitchSelection.value;
      livePitchError.value = 'KeepPitch controls are locked while recording or finalizing';
      return;
    }
    const nextMode = isLivePitchMode(livePitchMode.value) ? livePitchMode.value : 'OFF';
    const previousMode = lastLivePitchSelection.value;
    livePitchMode.value = nextMode;
    lastLivePitchSelection.value = nextMode;
    livePitchError.value = '';
    const settingsSaved = persistTrackSettings();
    if (!settingsSaved) livePitchSelectionWasPersisted = false;
    livePitchRestoreAttempted.value = livePitchRuntimeReady.value;
    void applyLivePitchMode(nextMode, previousMode);
  };

  const handleLivePitchSemitonesChange = () => {
    if (isTrackBusyForPitch.value || trackAudio.state === TrackState.RECORDING || trackAudio.state === TrackState.REC_FINISHING) {
      livePitchSemitones.value = lastLivePitchSemitones.value;
      livePitchError.value = 'KeepPitch controls are locked while recording or finalizing';
      return;
    }
    const nextValue = Number(livePitchSemitones.value);
    livePitchSemitones.value = clampSemitones(Number.isFinite(nextValue) ? nextValue : 0);
    lastLivePitchSemitones.value = livePitchSemitones.value;
    livePitchError.value = '';
    const settingsSaved = persistTrackSettings();
    if (!settingsSaved) livePitchSelectionWasPersisted = false;
    livePitchRestoreAttempted.value = livePitchRuntimeReady.value;
    if (livePitchMode.value !== 'OFF' && livePitchRuntimeReady.value) {
      void applyLivePitchMode(livePitchMode.value, lastLivePitchSelection.value);
    }
  };

  const handleHqMemoryBudgetChange = () => {
    const value = Number(hqMemoryBudgetMiB.value);
    hqMemoryBudgetMiB.value = clampHqMemoryBudgetMiB(Number.isFinite(value) ? value : DEFAULT_HQ_MEMORY_BUDGET_MIB);
    persistTrackSettings();
  };

  const handleHqPitchChange = () => {
    const value = Number(hqPitchSemitones.value);
    hqPitchSemitones.value = Math.max(-24, Math.min(24, Number.isFinite(value) ? Math.round(value) : 0));
  };

  const handleHqPlaybackRateChange = () => {
    const value = Number(hqPlaybackRate.value);
    hqPlaybackRate.value = Math.max(0.5, Math.min(2, Number.isFinite(value) ? value : 1));
  };

  const handleHqNativeEngineChange = () => {
    const selected: unknown = hqNativeEngine.value;
    if ((selected === 'R2' || selected === 'R3') && nativeHqRendererEngines.value.includes(selected)) return;
    hqNativeEngine.value = nativeHqRendererEngines.value.includes('R3')
      ? 'R3'
      : nativeHqRendererEngines.value[0] ?? 'R3';
  };

  const syncTrackUi = () => {
    trackState.value = trackAudio.state;
    currentAudioMode.value = readAudioMode();
    trackCapabilities.value = engine.getTrackCapabilities(trackId);
    const nativeRenderer = typeof engine.getNativeHqRenderer === 'function'
      ? engine.getNativeHqRenderer()
      : { available: false, engines: [] as NativeHqEngine[] };
    const supportedEngines = nativeRenderer.available && Array.isArray(nativeRenderer.engines)
      ? nativeRenderer.engines.filter((value): value is NativeHqEngine => value === 'R2' || value === 'R3')
      : [];
    nativeHqRendererEngines.value = [...new Set(supportedEngines)];
    nativeHqRendererAvailable.value = nativeHqRendererEngines.value.length > 0;
    if (nativeHqRendererAvailable.value && !nativeHqRendererEngines.value.includes(hqNativeEngine.value)) {
      hqNativeEngine.value = nativeHqRendererEngines.value.includes('R3') ? 'R3' : nativeHqRendererEngines.value[0]!;
    }
    playLevel.value = trackAudio.track.playLevel;
    trackAvailable.value = trackAudio.isAvailable;
    const audioStatus = engine.getUiStatus();
    trackTransportEnabled.value = trackAudio.transportEnabled && audioStatus.ready;
    disabledReason.value = trackCapabilities.value.availabilityReason || trackAudio.disabledReason || (!audioStatus.ready ? audioStatus.message : '');
    overdubDiagnostic.value = getOverdubDiagnostic();
    recordingDiagnostic.value = getRecordingDiagnostic();
    restorePersistedLivePitchWhenReady();
  };

  onMounted(() => {
    syncTrackUi();
    pollInterval = window.setInterval(syncTrackUi, 50);
  });

  onUnmounted(() => {
    window.clearInterval(pollInterval);
    cancelStopPress();
    if (clearVisualTimer !== null) window.clearTimeout(clearVisualTimer);
  });

  const isRecordingOrPlaying = computed(() => (
    trackState.value === TrackState.RECORDING ||
    trackState.value === TrackState.PLAYING ||
    trackState.value === TrackState.OVERDUBBING
  ));

  const buttonLedColor = computed(() => {
    if (isClearing.value) {
      return 'white';
    }

    switch (trackState.value) {
      case TrackState.RECORDING:
        return 'red';
      case TrackState.PLAYING:
        return 'green';
      case TrackState.OVERDUBBING:
        return 'yellow';
      default:
        return 'neutral';
    }
  });

  const faderLedColor = computed(() => {
    switch (trackState.value) {
      case TrackState.RECORDING:
        return 'red';
      case TrackState.PLAYING:
        return 'green';
      case TrackState.OVERDUBBING:
        return 'yellow';
      default:
        return 'white';
    }
  });

  const isCurrentTrack = computed(() => focus.state.currentTrackId === trackId);
  const isTrackFxApplied = computed(() => focus.state.trackFxApplyMap[trackId]);

  const levelControlEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.value.supportsTrackLevel);
  const trackFxControlEnabled = computed(() => trackAvailable.value && trackCapabilities.value.supportsTrackFx);
  const canExportHqWav = computed(() => {
    // Read this reactive snapshot before checking the non-reactive TrackAudio
    // getter. If the track starts empty, that getter short-circuits the old
    // expression before the state ref is tracked, leaving export disabled after
    // recording completes.
    const currentState = trackState.value;
    const nativeRendererAvailable = currentAudioMode.value !== 'native' || nativeHqRendererAvailable.value;
    return !!hqExportTrack
      && hqExportTrack.canExportHqWav
      && nativeRendererAvailable
      && currentState !== TrackState.EMPTY
      && currentState !== TrackState.RECORDING
      && currentState !== TrackState.REC_FINISHING;
  });
  const trackButtonAriaLabel = computed(() => isCurrentTrack.value
    ? `Track ${trackId} selected`
    : `Select track ${trackId}`);
  const fxButtonAriaLabel = computed(() => !trackFxControlEnabled.value
    ? `Track ${trackId} individual FX unavailable: ${trackCapabilities.value.trackFxReason || 'Track FX is unavailable'}`
    : isTrackFxApplied.value
      ? `Track FX applied to track ${trackId}`
      : `Apply Track FX to track ${trackId}`);
  const levelControlAriaLabel = computed(() => !levelControlEnabled.value
    ? `Track ${trackId} level unavailable: ${trackCapabilities.value.levelReason || 'Track level is unavailable'}`
    : `Track ${trackId} level`);

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  const handleRecPlay = () => {
    if (!trackTransportEnabled.value) return;
    trackAudio.triggerRecord();
  };

  const handleLevelChange = (value: number) => {
    if (!levelControlEnabled.value) return;

    const safeValue = clamp(Math.round(value), 0, 100);
    playLevel.value = safeValue;
    trackAudio.track.playLevel = safeValue;
    trackAudio.updateSettings();
  };

  const handleTrackSelect = () => {
    if (!trackAvailable.value) return;
    focus.setCurrentTrack(trackId);
  };

  const toggleTrackFx = () => {
    if (!trackFxControlEnabled.value) return;
    const nextState = !focus.state.trackFxApplyMap[trackId];
    trackAudio.track.fxSw = nextState ? 'ON' : 'OFF';
    focus.setTrackFxApplied(trackId, nextState);
  };

  const exportHqWav = async () => {
    if (!hqExportTrack || !canExportHqWav.value || isHqExporting.value) return;
    isHqExporting.value = true;
    hqExportProgress.value = 0;
    hqExportError.value = '';
    try {
      const exportOptions: HqWavExportRequestOptions = {
        // Browser stays on its existing Signalsmith Worker path.
        ...(currentAudioMode.value === 'native' ? { nativeHqEngine: hqNativeEngine.value } : {}),
        semitones: hqPitchSemitones.value,
        playbackRate: hqPlaybackRate.value,
        format: hqWavFormat.value,
        memoryBudgetBytes: hqMemoryBudgetMiB.value * 1024 * 1024,
      };
      const result = await hqExportTrack.exportHqWav(exportOptions, (fraction) => {
        hqExportProgress.value = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      });
      // Worker results are a full-length Uint8Array view over a transferred
      // ArrayBuffer; BlobPart's TS lib is stricter about SharedArrayBuffer.
      const wavBuffer = result.bytes.buffer as ArrayBuffer;
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `webrc505-track-${String(trackId).padStart(2, '0')}-hq-render.wav`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      hqExportProgress.value = 100;
    } catch (error) {
      hqExportError.value = error instanceof Error ? error.message : 'HQ WAV export failed';
    } finally {
      isHqExporting.value = false;
    }
  };

  const startStopPress = (sourceOrEvent?: StopPressSource | PointerEvent | MouseEvent | TouchEvent | KeyboardEvent) => {
    const source = resolveStopPressSource(sourceOrEvent);
    if (!trackTransportEnabled.value || stopPressActive.value) return;
    stopPressActive.value = true;
    stopPressTriggered = false;
    stopPressSource = source;
    stopPressTimer = window.setTimeout(() => {
      stopPressTimer = null;
      if (!stopPressActive.value || !trackTransportEnabled.value) {
        stopPressActive.value = false;
        stopPressSource = null;
        return;
      }
      stopPressTriggered = true;
      isClearing.value = true;
      trackAudio.clear();
      clearVisualTimer = window.setTimeout(() => {
        isClearing.value = false;
        clearVisualTimer = null;
      }, 300);
    }, LONG_PRESS_DURATION);
  };

  const endStopPress = (sourceOrEvent?: StopPressSource | PointerEvent | MouseEvent | TouchEvent | KeyboardEvent) => {
    const source = resolveStopPressSource(sourceOrEvent);
    if (!stopPressActive.value || stopPressSource !== source) return;
    stopPressActive.value = false;
    stopPressSource = null;
    if (stopPressTimer !== null) {
      window.clearTimeout(stopPressTimer);
      stopPressTimer = null;
    }
    if (!stopPressTriggered && trackTransportEnabled.value) trackAudio.triggerStop();
    stopPressTriggered = false;
  };

  const cancelStopPress = (sourceOrEvent?: StopPressSource | PointerEvent | MouseEvent | TouchEvent | KeyboardEvent) => {
    const source = sourceOrEvent === undefined ? null : resolveStopPressSource(sourceOrEvent);
    if (source && stopPressSource && stopPressSource !== source) return;
    stopPressActive.value = false;
    stopPressTriggered = false;
    stopPressSource = null;
    stopPressPointerId = null;
    if (stopPressTimer !== null) {
      window.clearTimeout(stopPressTimer);
      stopPressTimer = null;
    }
  };

  const handleStopKeyDown = (event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat) return;
    startStopPress('keyboard');
  };

  const handleStopKeyUp = (event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return;
    event.preventDefault();
    endStopPress('keyboard');
  };

  const handleStopPointerDown = (event: PointerEvent) => {
    if (!trackTransportEnabled.value || event.button !== 0 || event.isPrimary === false || stopPressPointerId !== null) return;
    stopPressPointerId = event.pointerId;
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some browser and test environments.
    }
    startStopPress('pointer');
  };

  const handleStopPointerUp = (event: PointerEvent) => {
    if (stopPressPointerId !== event.pointerId) return;
    const target = event.currentTarget as HTMLElement | null;
    const pointerId = stopPressPointerId;
    stopPressPointerId = null;
    endStopPress('pointer');
    try {
      if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    } catch {
      // The browser may have already released capture before pointerup.
    }
  };

  const handleStopPointerCancel = (event: PointerEvent) => {
    if (stopPressPointerId !== event.pointerId) return;
    stopPressPointerId = null;
    cancelStopPress('pointer');
  };

  const handleStopLostPointerCapture = (event: PointerEvent) => {
    if (stopPressPointerId !== event.pointerId) return;
    stopPressPointerId = null;
    cancelStopPress('pointer');
  };

  watch(trackTransportEnabled, (enabled) => {
    if (!enabled) cancelStopPress();
  });

  return {
    trackState,
    playLevel,
    trackAvailable,
    trackTransportEnabled,
    disabledReason,
    overdubDiagnostic,
    recordingDiagnostic,
    hqPitchSemitones,
    hqPlaybackRate,
    hqWavFormat,
    hqMemoryBudgetMiB,
    hqNativeEngine,
    nativeHqRendererAvailable,
    nativeHqRendererEngines,
    isHqExporting,
    hqExportProgress,
    hqExportError,
    canExportHqWav,
    livePitchMode,
    livePitchSemitones,
    liveMonoPitchSupported,
    livePolyPitchSupported,
    livePitchControlsDisabled,
    livePitchStatus,
    livePitchFallbackReason,
    livePitchActive,
    livePitchLatencyFrames,
    livePitchLatencyMs,
    livePitchError,
    isNativePitchMode,
    isNativeAudioMode,
    isCurrentTrack,
    isTrackFxApplied,
    isRecordingOrPlaying,
    buttonLedColor,
    faderLedColor,
    levelControlEnabled,
    trackFxControlEnabled,
    levelControlAriaLabel,
    trackFxUnavailableReason: computed(() => trackCapabilities.value.supportsTrackFx ? '' : trackCapabilities.value.trackFxReason),
    trackLevelUnavailableReason: computed(() => trackCapabilities.value.supportsTrackLevel ? '' : trackCapabilities.value.levelReason),
    trackButtonAriaLabel,
    fxButtonAriaLabel,
    handleRecPlay,
    handleLevelChange,
    handleTrackSelect,
    toggleTrackFx,
    exportHqWav,
    handleLivePitchModeChange,
    handleLivePitchSemitonesChange,
    handleHqMemoryBudgetChange,
    handleHqPitchChange,
    handleHqPlaybackRateChange,
    handleHqNativeEngineChange,
    startStopPress,
    stopPressActive,
    endStopPress,
    cancelStopPress,
    handleStopKeyDown,
    handleStopKeyUp,
    handleStopPointerDown,
    handleStopPointerUp,
    handleStopPointerCancel,
    handleStopLostPointerCapture,
  };
}
