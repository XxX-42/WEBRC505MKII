import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { TrackState } from '../core/types';
import { usePanelFocus } from './usePanelFocus';
import { useControlDispatcher } from './useControlDispatcher';

export function useTrackStripState(trackId: number) {
  const engine = AudioEngine.getInstance();
  const trackAudio = engine.tracks[trackId - 1]!;
  const trackCapabilities = engine.getTrackCapabilities(trackId);
  const focus = usePanelFocus();
  const { dispatcher } = useControlDispatcher();

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
    focus.setTrackFxApplied(trackId, trackAudio.track.fxSw === 'ON', false);
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
    trackState.value === TrackState.OVERDUBBING ||
    trackState.value === TrackState.REPLACING
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
      case TrackState.REPLACING:
        return 'purple';
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
      case TrackState.REPLACING:
        return 'purple';
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
    void dispatcher.dispatch({ type: 'record-track', trackId });
  };

  const handleLevelChange = (value: number) => {
    if (!levelControlEnabled.value) return;

    const safeValue = clamp(Math.round(value), 0, 200);
    playLevel.value = safeValue;
    void dispatcher.dispatch({ type: 'set-track-level', trackId, value: safeValue });
  };

  const handleTrackSelect = () => {
    if (!trackAvailable.value) return;
    focus.setCurrentTrack(trackId);
  };

  const toggleTrackFx = () => {
    if (!trackAvailable.value) return;
    const nextState = !focus.state.trackFxApplyMap[trackId];
    void dispatcher.dispatch({ type: 'set-track-fx-send', trackId, enabled: nextState });
  };

  const startStopPress = () => {
    if (!trackTransportEnabled.value || stopPressTimer) return;
    stopPressTimer = window.setTimeout(() => {
      isClearing.value = true;
      void dispatcher.dispatch({ type: 'clear-track', trackId });
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
      void dispatcher.dispatch({ type: 'stop-track', trackId });
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
