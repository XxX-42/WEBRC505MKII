import { Track, TrackState } from '../core/types';
import type { NativeLooperState } from './NativeBridgeClient';
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
  public readonly isAvailable: boolean;
  public readonly fxChain = {
    setFilterEnabled: (_enabled: boolean) => { return; },
    setFilterParam: (_paramName: string, _value: number) => { return; },
    setFilterValue: (_value: number) => { return; },
  };

  constructor(engine: NativeAudioEngine, trackId: number) {
    this.engine = engine;
    this.trackId = trackId;
    this.track = new Track(trackId);
    this.isAvailable = trackId === 1;
  }

  public get disabledReason(): string {
    if (!this.isAvailable) {
      return 'NATIVE V1 ONLY TRACK 1';
    }
    return this.engine.isNativeReady() ? '' : 'START native_bridge_host';
  }

  public get transportEnabled(): boolean {
    return this.isAvailable && this.engine.isNativeReady();
  }

  public triggerRecord() {
    if (!this.transportEnabled) return;

    if (this.state === TrackState.EMPTY) {
      void this.engine.recordTrack();
    } else if (this.state === TrackState.RECORDING) {
      void this.engine.stopTrack();
    } else if (this.state === TrackState.STOPPED) {
      void this.engine.playTrack();
    } else if (this.state === TrackState.PLAYING || this.state === TrackState.OVERDUBBING) {
      void this.engine.toggleOverdub();
    }
  }

  public triggerStop() {
    if (!this.transportEnabled) return;
    void this.engine.stopTrack();
  }

  public clear() {
    if (!this.transportEnabled) return;
    void this.engine.clearTrack();
  }

  public play() {
    if (!this.transportEnabled) return;
    void this.engine.playTrack();
  }

  public toggleReverse() {
    return;
  }

  public updateSettings() {
    return;
  }

  public syncNativeState(state: NativeLooperState, progress: number) {
    this.state = stateMap[state];
    this.engine.updateTrackTelemetry(this.trackId, this.state, progress);
  }

  public resetTelemetry() {
    this.state = TrackState.EMPTY;
    this.engine.updateTrackTelemetry(this.trackId, this.state, 0);
  }
}
