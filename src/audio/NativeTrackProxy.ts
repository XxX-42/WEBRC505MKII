import { Track, TrackState } from '../core/types';
import type { NativeLooperState, NativeTrackMixSettings, NativeTrackStatus } from './NativeBridgeClient';
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
  public muted = false;
  public solo = false;
  public inputRouted = true;
  private settingsUpdate: Promise<void> = Promise.resolve();
  private pendingMixSettings: NativeTrackMixSettings | null = null;
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
    return this.engine.isTrackAvailable(this.trackId);
  }

  public get disabledReason(): string {
    if (!this.isAvailable) {
      return `NATIVE BRIDGE DOES NOT EXPOSE TRACK ${this.trackId}`;
    }
    return this.engine.isNativeReady() ? '' : 'START native_bridge_host';
  }

  public get transportEnabled(): boolean {
    return this.isAvailable && this.engine.isNativeReady();
  }

  public triggerRecord() {
    if (!this.transportEnabled) return;

    if (this.state === TrackState.EMPTY) {
      void this.engine.recordTrack(this.trackId);
    } else if (this.state === TrackState.RECORDING) {
      void this.engine.stopTrack(this.trackId);
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
    throw new Error('Reverse playback is not available from this Native host build.');
  }

  public updateSettings(): Promise<void> {
    if (!this.engine.supportsNativeTrackMix()) return Promise.resolve();
    const panText = this.track.pan;
    const pan = panText === 'CENTER' ? 0 : (panText.startsWith('L') ? -1 : 1) *
      Math.max(0, Math.min(1, Number.parseInt(panText.slice(1), 10) / 50));
    const settings = {
      gain: Math.max(0, Math.min(2, this.track.playLevel / 100)),
      pan: Math.max(-1, Math.min(1, pan)),
      muted: this.muted,
      solo: this.solo,
      inputRouted: this.inputRouted,
    };
    this.pendingMixSettings = settings;
    this.settingsUpdate = this.settingsUpdate.catch(() => undefined).then(() =>
      this.engine.updateNativeTrackSettings(this.trackId, settings)).catch((error: unknown) => {
      if (this.pendingMixSettings === settings) this.pendingMixSettings = null;
      throw error;
    });
    return this.settingsUpdate;
  }

  public setMuted(enabled: boolean): Promise<void> {
    this.muted = enabled;
    return this.updateSettings();
  }

  public setSolo(enabled: boolean): Promise<void> {
    this.solo = enabled;
    return this.updateSettings();
  }

  public setInputRoute(enabled: boolean): Promise<void> {
    this.inputRouted = enabled;
    return this.updateSettings();
  }

  public clearPendingSettings(): void {
    this.pendingMixSettings = null;
  }

  public syncNativeState(state: NativeLooperState, progress: number, mix?: NativeTrackStatus) {
    this.state = stateMap[state];
    if (mix) {
      const pending = this.pendingMixSettings;
      const matchesPending = pending !== null &&
        Math.abs(mix.gain - pending.gain) <= 1.0e-4 &&
        Math.abs(mix.pan - pending.pan) <= 1.0e-4 &&
        mix.muted === pending.muted && mix.solo === pending.solo &&
        mix.inputRouted === pending.inputRouted;
      if (matchesPending) this.pendingMixSettings = null;
      if (this.pendingMixSettings === null) {
        this.track.playLevel = Math.round(mix.gain * 100);
        this.track.pan = Math.round(mix.pan * 50);
        this.muted = mix.muted;
        this.solo = mix.solo;
        this.inputRouted = mix.inputRouted;
      }
    }
    this.engine.updateTrackTelemetry(this.trackId, this.state, progress);
  }

  public resetTelemetry() {
    this.clearPendingSettings();
    this.state = TrackState.EMPTY;
    this.engine.updateTrackTelemetry(this.trackId, this.state, 0);
  }
}
