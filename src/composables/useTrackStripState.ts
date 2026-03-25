import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { TrackState } from '../core/types';
import { usePanelFocus } from './usePanelFocus';

export function useTrackStripState(trackId: number) {
  const engine = AudioEngine.getInstance();
  const trackAudio = engine.tracks[trackId - 1]!;
  const trackCapabilities = engine.getTrackCapabilities(trackId);
  const focus = usePanelFocus();

  const trackState = ref(trackAudio.state);
  const playLevel = ref(trackAudio.track.playLevel);
  const trackAvailable = ref(trackAudio.isAvailable);
  const trackTransportEnabled = ref(trackAudio.transportEnabled);
  const disabledReason = ref(trackCapabilities.availabilityReason || trackAudio.disabledReason);
  const isClearing = ref(false);
  let pollInterval = 0;
  let stopPressTimer: number | null = null;
  const LONG_PRESS_DURATION = 1500;

  const syncTrackUi = () => {
    trackState.value = trackAudio.state;
    playLevel.value = trackAudio.track.playLevel;
    trackAvailable.value = trackAudio.isAvailable;
    trackTransportEnabled.value = trackAudio.transportEnabled;
    disabledReason.value = trackCapabilities.availabilityReason || trackAudio.disabledReason;
  };

  onMounted(() => {
    syncTrackUi();
    pollInterval = window.setInterval(syncTrackUi, 50);
  });

  onUnmounted(() => {
    window.clearInterval(pollInterval);
    if (stopPressTimer) {
      window.clearTimeout(stopPressTimer);
    }
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

  const levelControlEnabled = computed(() => trackTransportEnabled.value && trackCapabilities.supportsTrackLevel);
  const trackButtonAriaLabel = computed(() => isCurrentTrack.value
    ? `Track ${trackId} selected`
    : `Select track ${trackId}`);
  const fxButtonAriaLabel = computed(() => isTrackFxApplied.value
    ? `Track FX applied to track ${trackId}`
    : `Apply Track FX to track ${trackId}`);

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
    if (!trackAvailable.value) return;
    const nextState = !focus.state.trackFxApplyMap[trackId];
    trackAudio.track.fxSw = nextState ? 'ON' : 'OFF';
    focus.setTrackFxApplied(trackId, nextState);
  };

  const startStopPress = () => {
    if (!trackTransportEnabled.value || stopPressTimer) return;
    stopPressTimer = window.setTimeout(() => {
      isClearing.value = true;
      trackAudio.clear();
      window.setTimeout(() => {
        isClearing.value = false;
      }, 300);
      stopPressTimer = null;
    }, LONG_PRESS_DURATION);
  };

  const endStopPress = () => {
    if (!trackTransportEnabled.value) return;
    if (stopPressTimer) {
      window.clearTimeout(stopPressTimer);
      stopPressTimer = null;
      trackAudio.triggerStop();
    }
  };

  const cancelStopPress = () => {
    if (stopPressTimer) {
      window.clearTimeout(stopPressTimer);
      stopPressTimer = null;
    }
  };

  return {
    trackState,
    playLevel,
    trackAvailable,
    trackTransportEnabled,
    disabledReason,
    isCurrentTrack,
    isTrackFxApplied,
    isRecordingOrPlaying,
    buttonLedColor,
    faderLedColor,
    levelControlEnabled,
    trackButtonAriaLabel,
    fxButtonAriaLabel,
    handleRecPlay,
    handleLevelChange,
    handleTrackSelect,
    toggleTrackFx,
    startStopPress,
    endStopPress,
    cancelStopPress,
  };
}
