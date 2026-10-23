import { Track, TrackState } from '../core/types';
import type { NativeLooperState, NativePitchStatus } from './NativeBridgeClient';
import type { HqWavExportRequestOptions, HqWavExportResult } from './export/hqWavExport';
import type { NativeAudioEngine } from './NativeAudioEngine';

const stateMap: Record<NativeLooperState, TrackState> = {
  Empty: TrackState.EMPTY,
  Recording: TrackState.RECORDING,
  Stopped: TrackState.STOPPED,
  Playing: TrackState.PLAYING,
  Overdubbing: TrackState.OVERDUBBING,
};

export class NativeTrackProxy {
  private readonly engine: NativeAudioEngine;
  public readonly trackId: number;
  public readonly track: Track;
  public state: TrackState = TrackState.EMPTY;
  public isReverse = false;
  public readonly fxChain = {
    setFilterEnabled: (_enabled: boolean) => { return; },
    setFilterParam: (_paramName: string, _value: number) => { return; },
    setFilterValue: (_value: number) => { return; },
  };

  constructor(engine: NativeAudioEngine, trackId: number) {
    this.engine = engine;
    this.trackId = trackId;
    this.track = new Track(trackId);
  }

  public get isAvailable(): boolean {
    return this.engine.isNativeTrackAvailable(this.trackId);
  }

  public get disabledReason(): string {
    if (!this.isAvailable) {
      return 'NATIVE HOST DOES NOT EXPOSE THIS LOOP TRACK';
    }
    return this.engine.isNativeReady() ? '' : 'START native_bridge_host';
  }

  public get transportEnabled(): boolean {
    return this.isAvailable && this.engine.isNativeReady();
  }

  public get canExportHqWav(): boolean {
    return this.isAvailable && this.engine.canExportHqWav(this.trackId);
  }

  public exportHqWav(
    options: HqWavExportRequestOptions,
    onProgress?: (fraction: number) => void,
  ): Promise<HqWavExportResult> {
    if (!this.canExportHqWav) {
      return Promise.reject(new Error('This Native track has no completed loop available to export'));
    }
    return this.engine.exportHqWav(options, onProgress, this.trackId);
  }

  public get liveMonoPitchEnabled(): boolean {
    return this.getPitchStatus('liveMonoKeepPitch')?.enabled ?? false;
  }

  public get liveMonoPitchActive(): boolean {
    return this.getPitchStatus('liveMonoKeepPitch')?.active ?? false;
  }

  public get liveMonoPitchLatencySamples(): number | null {
    return this.getPitchStatus('liveMonoKeepPitch')?.latencySamples ?? null;
  }

  public get liveMonoPitchLatencySeconds(): number | null {
    const latency = this.liveMonoPitchLatencySamples;
    return latency === null ? null : latency / this.engine.getNativeSampleRate();
  }

  public get liveMonoPitchFallbackReason(): string | null {
    return this.pitchFallbackReason('liveMonoKeepPitch');
  }

  public get livePolyPitchEnabled(): boolean {
    return this.getPitchStatus('livePolyPhaseVocoder')?.enabled ?? false;
  }

  public get livePolyPitchActive(): boolean {
    return this.getPitchStatus('livePolyPhaseVocoder')?.active ?? false;
  }

  public get livePolyPitchLatencySamples(): number | null {
    return this.getPitchStatus('livePolyPhaseVocoder')?.latencySamples ?? null;
  }

  public get livePolyPitchLatencySeconds(): number | null {
    const latency = this.livePolyPitchLatencySamples;
    return latency === null ? null : latency / this.engine.getNativeSampleRate();
  }

  public get livePolyPitchFallbackReason(): string | null {
    return this.pitchFallbackReason('livePolyPhaseVocoder');
  }

  /** Selects this Native loop for the shared, single-processor LIVE_MONO route. */
  public async setLiveMonoPitchEnabled(
    enabled: boolean,
    options: { semitones?: number; minimumFrequencyHz?: number; maximumFrequencyHz?: number } = {},
  ): Promise<void> {
    if (options.semitones !== undefined && (!Number.isFinite(options.semitones) || options.semitones < -12 || options.semitones > 12)) {
      throw new RangeError('LIVE_MONO semitones must be between -12 and +12');
    }
    if ((options.minimumFrequencyHz !== undefined && options.minimumFrequencyHz !== 70) ||
        (options.maximumFrequencyHz !== undefined && options.maximumFrequencyHz !== 1200)) {
      throw new RangeError('Native LIVE_MONO uses a fixed 70-1200 Hz detector range');
    }
    const current = this.engine.getNativePitchStatus();
    if (!enabled && (current?.trackId !== this.trackId || current.mode !== 'liveMonoKeepPitch')) return;
    const previous = current?.trackId === this.trackId && current.mode === 'liveMonoKeepPitch' ? current : null;
    await this.engine.setPitch({
      enabled,
      mode: 'liveMonoKeepPitch',
      trackId: this.trackId,
      semitones: options.semitones ?? previous?.semitones ?? 0,
      reversePlayback: this.isReverse,
    });
  }

  /** Selects this Native loop for the shared, single-processor LIVE_POLY route. */
  public async setLivePolyPitchEnabled(
    enabled: boolean,
    options: { semitones?: number; playbackRate?: number; tonalityLimitHz?: number } = {},
  ): Promise<void> {
    if (options.semitones !== undefined && (!Number.isFinite(options.semitones) || options.semitones < -12 || options.semitones > 12)) {
      throw new RangeError('Native LIVE_POLY semitones must be between -12 and +12');
    }
    if (options.playbackRate !== undefined && options.playbackRate !== 1) {
      throw new RangeError('Native LIVE_POLY does not expose playback-rate adjustment');
    }
    if (options.tonalityLimitHz !== undefined) {
      throw new RangeError('Native LIVE_POLY does not expose a tonality-limit setting');
    }
    const current = this.engine.getNativePitchStatus();
    if (!enabled && (current?.trackId !== this.trackId || current.mode !== 'livePolyPhaseVocoder')) return;
    const previous = current?.trackId === this.trackId && current.mode === 'livePolyPhaseVocoder' ? current : null;
    await this.engine.setPitch({
      enabled,
      mode: 'livePolyPhaseVocoder',
      trackId: this.trackId,
      semitones: options.semitones ?? previous?.semitones ?? 0,
      reversePlayback: this.isReverse,
    });
  }

  public triggerRecord() {
    if (!this.transportEnabled) return;

    if (this.state === TrackState.EMPTY) {
      void this.engine.recordTrack(this.trackId);
    } else if (this.state === TrackState.RECORDING) {
      if (this.engine.getRecordPlaySettings().recActionAvailable) void this.engine.finishRecordingTrack(this.trackId);
      else void this.engine.stopTrack(this.trackId);
    } else if (this.state === TrackState.STOPPED) {
      void this.engine.playTrack(this.trackId);
    } else if (this.state === TrackState.PLAYING || this.state === TrackState.OVERDUBBING) {
      void this.engine.toggleOverdub(this.trackId);
    }
  }

  public triggerStop() {
    if (!this.transportEnabled) return;
    void this.engine.stopTrack(this.trackId);
  }

  public clear() {
    if (!this.transportEnabled) return;
    void this.engine.clearTrack(this.trackId);
  }

  public play() {
    if (!this.transportEnabled) return;
    void this.engine.playTrack(this.trackId);
  }

  public toggleReverse() {
    return;
  }

  public updateSettings() {
    if (!this.transportEnabled || !this.engine.getMixerState().available) return;
    return this.engine.setMixerLevel(this.trackId as 1 | 2 | 3 | 4 | 5, this.track.playLevel);
  }

  public syncNativeState(state: NativeLooperState, progress: number) {
    this.state = stateMap[state];
    this.engine.updateTrackTelemetry(this.trackId, this.state, progress);
  }

  public resetTelemetry() {
    this.state = TrackState.EMPTY;
    this.engine.updateTrackTelemetry(this.trackId, this.state, 0);
  }

  private getPitchStatus(mode: NativePitchStatus['mode']): NativePitchStatus | null {
    const status = this.engine.getNativePitchStatus();
    return status?.trackId === this.trackId && status.mode === mode ? status : null;
  }

  private pitchFallbackReason(mode: NativePitchStatus['mode']): string | null {
    const reason = this.getPitchStatus(mode)?.fallbackReason;
    return reason && reason !== 'none' && reason !== 'notRequested' ? reason : null;
  }
}
