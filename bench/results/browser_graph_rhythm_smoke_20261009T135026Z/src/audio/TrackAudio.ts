import type { IAudioEngine } from './AudioEngineInterface';
import { FXChain } from './FXChain';
import { BrowserRealtimeRuntime } from './BrowserRealtimeRuntime';
import { getBrowserRecordingOffsetConfig } from './browserRecordingOffset';
import {
  BROWSER_REALTIME_QUANTUM_FRAMES,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  TrackMetaWord,
} from './browserRealtimeProtocol';
import {
  DubMode,
  Switch,
  Track,
  LoopSyncMode,
  QuantizeMode,
  TempoSyncMode,
  TempoSyncSpeed,
  TrackState,
  TransportState,
  type TrackRuntimeSettings,
  type MemorySettings,
} from '../core/types';
import { Transport } from '../core/Transport';

export type { TrackRuntimeSettings } from '../core/types';
export type TrackRuntimeSettingsPatch = Partial<Omit<TrackRuntimeSettings, 'autoRec'>> & {
  autoRec?: Partial<TrackRuntimeSettings['autoRec']>;
};

export interface TrackHistoryState {
  cursor: number;
  length: number;
  canUndo: boolean;
  canRedo: boolean;
  hasMark: boolean;
}

const SUCCESS_STATUSES = new Set<number>([BrowserRealtimeStatus.OK, BrowserRealtimeStatus.LATE]);
const WORKLET_TRACK_STATES: readonly TrackState[] = [
  TrackState.EMPTY,
  TrackState.REC_STANDBY,
  TrackState.RECORDING,
  TrackState.REC_FINISHING,
  TrackState.PLAYING,
  TrackState.OVERDUBBING,
  TrackState.STOPPED,
  TrackState.REPLACING,
];

type TrackEngine = IAudioEngine & {
  realtimeRuntime?: BrowserRealtimeRuntime | null;
  isReady?: boolean;
  tempoSyncMode?: TempoSyncMode;
  memorySettings?: Pick<MemorySettings, 'quantize' | 'loopSyncMode'>;
  reportRuntimeError?: (error: unknown) => void;
  tracks?: Array<{ state: TrackState }>;
};

/**
 * Browser track controller. Audio lives in the persistent AudioWorklet; this
 * class only translates UI intent into frame-addressed commands and reflects
 * their acknowledgements in UI/transport state.
 */
export class TrackAudio {
  public track: Track;
  private localState: TrackState = TrackState.EMPTY;
  public isReverse = false;
  public readonly fxChain: FXChain;
  private runtimeSettings: TrackRuntimeSettings;

  private readonly engine: TrackEngine;
  private readonly transport: Transport;
  private readonly trackIndex: number;
  private readonly sharedStates: Int32Array | null;
  private readonly sharedPositions: Float32Array | null;
  private commandGeneration = 0;
  private isRecording = false;
  private lastActionError: string | null = null;
  private mixerLevel = 1;
  private mixerPan = 0;
  private mixerMuted = false;
  private pendingUiState: TrackState | null = null;
  private pendingTakeMode: 'BASE' | 'OVERDUB' | null = null;
  private pendingAction: Promise<void> | null = null;

  constructor(
    engine: IAudioEngine,
    track: Track,
    index: number,
    sharedStates: Int32Array | null,
    sharedPositions: Float32Array | null,
  ) {
    this.engine = engine as TrackEngine;
    this.track = track;
    this.trackIndex = index;
    this.sharedStates = sharedStates;
    this.sharedPositions = sharedPositions;
    this.transport = Transport.getInstance();
    this.isReverse = track.reverse === Switch.ON;
    this.runtimeSettings = {
      reverse: this.isReverse,
      oneShot: track.oneShot === Switch.ON,
      startMode: track.startMode,
      stopMode: track.stopMode,
      fadeInMs: track.fadeInMs,
      fadeOutMs: track.fadeOutMs,
      speed: track.speed,
      keepPitch: track.keepPitch,
      tempoSyncEnabled: track.tempoSyncSw === Switch.ON,
      tempoSyncSpeed: track.tempoSyncSpeed,
      tempoSyncMode: this.engine.tempoSyncMode ?? TempoSyncMode.PITCH,
      recordBpm: track.recordBpm,
      autoRec: {
        enabled: track.autoRecEnabled,
        threshold: track.autoRecThreshold,
        debounceMs: track.autoRecDebounceMs,
      },
      dubMode: track.dubMode,
    };

    const context = this.engine.context;
    const gainNode = context.createGain();
    const panNode = context.createStereoPanner();
    this.fxChain = new FXChain(context);
    this.fxChain.output.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(this.engine.trackMixNode);
    this.gainNode = gainNode;
    this.panNode = panNode;
    this.updateSettings();
  }

  private readonly gainNode: GainNode;
  private readonly panNode: StereoPannerNode;

  public get isAvailable(): boolean {
    return true;
  }

  /** Reflects the worklet's sample-clock state when available. */
  public get state(): TrackState {
    if (this.pendingUiState) return this.pendingUiState;
    const raw = this.sharedStates ? Atomics.load(this.sharedStates, this.trackIndex) : -1;
    return raw >= 0 ? WORKLET_TRACK_STATES[raw] ?? this.localState : this.localState;
  }

  public set state(value: TrackState) {
    this.localState = value;
  }

  public get disabledReason(): string {
    return this.transportEnabled ? '' : 'BROWSER AUDIO NOT READY';
  }

  public get transportEnabled(): boolean {
    return Boolean(this.engine.isReady && this.engine.realtimeRuntime);
  }

  /** Audio node after this track's level and pan, for engine-owned routing. */
  public get outputNode(): AudioNode {
    return this.panNode;
  }

  private get runtime(): BrowserRealtimeRuntime | null {
    return this.engine.realtimeRuntime ?? null;
  }

  public updateSettings() {
    this.gainNode.gain.value = this.mixerMuted ? 0 : (this.track.playLevel / 100) * this.mixerLevel;

    const pan = this.track.pan;
    let trackPan = 0;
    if (pan === 'CENTER') {
      trackPan = 0;
    } else if (pan.startsWith('L')) {
      trackPan = -Math.max(0, Math.min(1, parseInt(pan.substring(1), 10) / 50));
    } else if (pan.startsWith('R')) {
      trackPan = Math.max(0, Math.min(1, parseInt(pan.substring(1), 10) / 50));
    }
    this.panNode.pan.value = Math.max(-1, Math.min(1, trackPan + this.mixerPan));
  }

  public setMixerState(state: { level: number; pan: number; muted: boolean; solo: boolean }, anySolo: boolean): void {
    this.mixerLevel = Math.max(0, Math.min(2, state.level));
    this.mixerPan = Math.max(-1, Math.min(1, state.pan));
    this.mixerMuted = state.muted || (anySolo && !state.solo);
    this.updateSettings();
  }

  public triggerRecord(): Promise<void> {
    this.lastActionError = null;
    if (!this.transportEnabled) return Promise.resolve();
    if (this.pendingTakeMode === 'OVERDUB' && this.pendingAction) return this.pendingAction;

    switch (this.state) {
      case TrackState.EMPTY:
        return this.startRecording();
      case TrackState.RECORDING:
        return this.stopRecording(true);
      case TrackState.REC_STANDBY:
        return this.cancelPendingRecording();
      case TrackState.REC_FINISHING:
        return this.cancelPendingStop();
      case TrackState.PLAYING:
        return this.runtimeSettings.oneShot ? this.play() : this.startOverdub();
      case TrackState.OVERDUBBING:
      case TrackState.REPLACING:
        return this.stopOverdub();
      case TrackState.STOPPED:
        return this.play();
    }
    return Promise.resolve();
  }

  public triggerStop(): Promise<void> {
    this.lastActionError = null;
    if (!this.transportEnabled) return Promise.resolve();
    if (this.pendingTakeMode === 'OVERDUB') {
      const pendingAction = this.pendingAction;
      this.commandGeneration += 1;
      return (pendingAction ?? Promise.resolve()).finally(() => {
        this.pendingTakeMode = null;
        this.pendingAction = null;
      });
    }

    if (this.state === TrackState.REC_STANDBY) {
      return this.cancelPendingRecording();
    }
    if (this.state === TrackState.RECORDING || this.state === TrackState.REC_FINISHING) {
      return this.stopRecording(false);
    }
    if (this.state === TrackState.OVERDUBBING || this.state === TrackState.REPLACING) {
      return this.stopOverdubAndPlayback();
    }

    return this.stop();
  }

  public async startRecording(): Promise<void> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (this.pendingAction && this.pendingTakeMode === 'BASE') return await this.pendingAction;
    if (!runtime || (this.state !== TrackState.EMPTY && this.state !== TrackState.STOPPED)) return;
    const generation = ++this.commandGeneration;
    this.pendingTakeMode = 'BASE';
    this.pendingUiState = TrackState.REC_STANDBY;
    this.pendingAction = this.runStartRecording(runtime, generation).finally(() => {
      if (this.pendingTakeMode === 'BASE' && generation === this.commandGeneration) {
        this.pendingTakeMode = null;
        this.pendingUiState = null;
        this.pendingAction = null;
      }
    });
    return await this.pendingAction;
  }

  private async runStartRecording(runtime: BrowserRealtimeRuntime, generation: number): Promise<void> {

    try {
      await runtime.prepareTrack(this.trackIndex);
      if (generation !== this.commandGeneration) return;
      await runtime.beginTake(this.trackIndex, 'BASE');
      if (generation !== this.commandGeneration) return;
      const targetFrame = this.getRecordingStartFrame(runtime);
      this.pendingUiState = TrackState.REC_STANDBY;
      this.isRecording = false;
      this.ensureTransportRunning();

      const ack = await runtime.enqueue(BrowserRealtimeOpcode.START_RECORD, this.trackIndex, 0, 0, targetFrame);
      if (generation !== this.commandGeneration || ack.status === BrowserRealtimeStatus.CANCELLED) return;
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.reportError(new Error(`Track ${this.track.id} record request failed (status ${ack.status}).`));
        this.pendingUiState = null;
        this.state = this.readWorkletState() ?? TrackState.EMPTY;
        return;
      }

      this.isRecording = this.readWorkletState() !== TrackState.REC_STANDBY;
      this.pendingUiState = null;
      this.state = this.isRecording ? TrackState.RECORDING : TrackState.REC_STANDBY;
      this.syncTransportState();
    } catch (error) {
      this.pendingUiState = null;
      this.state = TrackState.EMPTY;
      this.isRecording = false;
      this.reportError(error);
    }
  }

  public async stopRecording(resumeAfterRecording = true): Promise<void> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime || (!this.isRecording && this.state !== TrackState.RECORDING && this.state !== TrackState.REC_FINISHING)) return;

    const generation = ++this.commandGeneration;
    this.pendingUiState = TrackState.REC_FINISHING;
    const targetFrame = this.getRecordingStopFrame(runtime);
    this.state = TrackState.REC_FINISHING;
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.STOP_RECORD,
        this.trackIndex,
        resumeAfterRecording ? 1 : 0,
        0,
        targetFrame,
      );
      if (generation !== this.commandGeneration) return;
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.reportError(new Error(`Track ${this.track.id} record stop failed (status ${ack.status}).`));
        this.pendingUiState = null;
        this.state = this.readWorkletState() ?? TrackState.STOPPED;
        return;
      }

      this.isRecording = false;
      this.pendingUiState = null;
      if (ack.loopFrames > 0 && !this.transport.hasMasterTrack()) {
        this.transport.setMasterTrack(
          this.track.id,
          ack.loopFrames / this.engine.context.sampleRate,
          this.engine.context.sampleRate,
          ack.loopFrames,
          runtime.getTrackRecordingStartFrame(this.trackIndex) ?? ack.executedFrame,
        );
      }
      this.state = ack.loopFrames > 0 && resumeAfterRecording ? TrackState.PLAYING : TrackState.STOPPED;
      const metadata = runtime.getTrackMetadata(this.trackIndex);
      const recordedBpm = metadata ? Atomics.load(metadata, TrackMetaWord.RECORD_BPM) / 1000 : 0;
      if (recordedBpm >= 40 && recordedBpm <= 300) {
        this.runtimeSettings.recordBpm = recordedBpm;
        this.track.recordBpm = recordedBpm;
      }
      this.syncMasterPlaybackSpeed();
      this.syncTransportState();
    } catch (error) {
      this.pendingUiState = null;
      this.reportError(error);
      this.state = this.readWorkletState() ?? TrackState.STOPPED;
    }
  }

  public async play(): Promise<void> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime || (this.state !== TrackState.STOPPED && this.state !== TrackState.PLAYING)) return;

    const targetFrame = this.getTrackActionTargetFrame(runtime);
    const phaseAligned = !this.runtimeSettings.oneShot && this.track.loopSyncSw === Switch.ON &&
      this.engine.memorySettings?.loopSyncMode === LoopSyncMode.IMMEDIATE &&
      this.transport.hasMasterTrack();
    const metadata = runtime.getTrackMetadata(this.trackIndex);
    const loopFrames = metadata ? Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES) : 0;
    const phasePosition = phaseAligned
      ? this.transport.getTrackFrameAtMasterPhase(targetFrame, loopFrames, this.isReverse)
      : 0;
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.PLAY,
        this.trackIndex,
        1,
        phasePosition,
        targetFrame,
        phaseAligned ? 1 : 0,
      );
      if (SUCCESS_STATUSES.has(ack.status)) {
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
      } else {
        this.reportError(new Error(`Track ${this.track.id} play failed (status ${ack.status}).`));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  public async stop(): Promise<void> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const generation = ++this.commandGeneration;
    try {
      const ack = await runtime.enqueue(BrowserRealtimeOpcode.STOP, this.trackIndex, 0, 0, runtime.getImmediateTargetFrame());
      if (generation !== this.commandGeneration) return;
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.reportError(new Error(`Track ${this.track.id} stop failed (status ${ack.status}).`));
        return;
      }
      this.isRecording = false;
      // FADE/LOOP stop ACKs mean the request was accepted; the Worklet owns
      // the eventual sample-frame transition to STOPPED.
      this.refreshRuntimeStateFromWorklet();
    } catch (error) {
      this.reportError(error);
    }
  }

  public async clear(): Promise<void> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const generation = ++this.commandGeneration;
    const targetFrame = runtime.getImmediateTargetFrame();
    this.state = TrackState.EMPTY;
    this.isRecording = false;
    try {
      const cancel = runtime.enqueue(BrowserRealtimeOpcode.CANCEL_PENDING, this.trackIndex, 0, 0, targetFrame);
      const clear = runtime.enqueue(BrowserRealtimeOpcode.CLEAR, this.trackIndex, 0, 0, targetFrame);
      const [cancelAck, clearAck] = await Promise.all([cancel, clear]);
      if (generation !== this.commandGeneration) return;
      if (!SUCCESS_STATUSES.has(clearAck.status)) {
        this.reportError(new Error(`Track ${this.track.id} clear failed (status ${clearAck.status}).`));
        this.state = this.readWorkletState() ?? TrackState.EMPTY;
        return;
      }
      await runtime.releaseTrackHistory(this.trackIndex);
      this.isReverse = false;
      this.runtimeSettings.reverse = false;
      this.runtimeSettings.recordBpm = null;
      this.track.reverse = Switch.OFF;
      this.track.recordBpm = null;
      if (this.sharedPositions) this.sharedPositions[this.trackIndex] = 0;
      this.engine.checkAndResetMaster(this.track.id);
      this.syncTransportState();
      if (!SUCCESS_STATUSES.has(cancelAck.status)) this.reportError(new Error('Worklet did not cancel pending track commands before clear.'));
    } catch (error) {
      this.reportError(error);
      this.state = this.readWorkletState() ?? TrackState.EMPTY;
    }
  }

  public async clearForProject(token: symbol): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) throw new Error('Browser audio is not ready.');
    await runtime.clearTrackForProject(this.trackIndex, token);
    this.isRecording = false;
    this.pendingUiState = null;
    this.isReverse = false;
    this.runtimeSettings.reverse = false;
    this.runtimeSettings.recordBpm = null;
    this.track.reverse = Switch.OFF;
    this.track.recordBpm = null;
    this.state = TrackState.EMPTY;
    if (this.sharedPositions) this.sharedPositions[this.trackIndex] = 0;
    this.engine.checkAndResetMaster(this.track.id);
    this.syncTransportState();
  }

  public toggleReverse() {
    if (!this.transportEnabled) return;
    this.isReverse = !this.isReverse;
    this.track.reverse = this.isReverse ? Switch.ON : Switch.OFF;
    this.runtimeSettings.reverse = this.isReverse;
    const runtime = this.runtime;
    if (!runtime) return;
    void runtime.enqueue(
      BrowserRealtimeOpcode.SET_REVERSE,
      this.trackIndex,
      this.isReverse ? 1 : 0,
      0,
      runtime.getImmediateTargetFrame(),
    ).then((ack) => {
      if (!SUCCESS_STATUSES.has(ack.status)) throw new Error(`Track ${this.track.id} reverse update failed (status ${ack.status}).`);
      this.syncMasterPlaybackSpeed();
    }).catch((error: unknown) => {
      this.isReverse = !this.isReverse;
      this.runtimeSettings.reverse = this.isReverse;
      this.track.reverse = this.isReverse ? Switch.ON : Switch.OFF;
      this.reportError(error);
    });
  }

  public async exportAudioBuffer(): Promise<AudioBuffer> {
    const runtime = this.requireRuntime();
    if (!runtime) throw new Error('Browser audio is not ready.');
    return await runtime.exportTrack(this.trackIndex, this.engine.context);
  }

  public async importAudioBuffer(buffer: AudioBuffer): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) throw new Error('Browser audio is not ready.');
    await runtime.loadTrack(this.trackIndex, buffer);
    this.isRecording = false;
    this.state = TrackState.STOPPED;
    this.runtimeSettings.recordBpm = null;
    this.track.recordBpm = null;
    this.syncMasterPlaybackSpeed();
    this.syncTransportState();
  }

  public async importAudioBufferForProject(buffer: AudioBuffer, token: symbol): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) throw new Error('Browser audio is not ready.');
    await runtime.loadTrackForProject(this.trackIndex, buffer, token);
    this.isRecording = false;
    this.pendingUiState = null;
    this.state = TrackState.STOPPED;
    this.syncMasterPlaybackSpeed();
    this.syncTransportState();
  }

  public getRuntimeSettings(): TrackRuntimeSettings {
    return { ...this.runtimeSettings, autoRec: { ...this.runtimeSettings.autoRec } };
  }

  public async updateRuntimeSettings(patch: TrackRuntimeSettingsPatch): Promise<void> {
    this.lastActionError = null;
    const current = this.getRuntimeSettings();
    const next: TrackRuntimeSettings = {
      ...current,
      ...patch,
      autoRec: { ...current.autoRec, ...patch.autoRec },
    };
    next.speed = clampFinite(next.speed, 0.25, 4, current.speed);
    next.fadeInMs = clampFinite(next.fadeInMs, 0, 10_000, current.fadeInMs);
    next.fadeOutMs = clampFinite(next.fadeOutMs, 0, 10_000, current.fadeOutMs);
    next.autoRec.threshold = clampFinite(next.autoRec.threshold, 0, 1, current.autoRec.threshold);
    next.autoRec.debounceMs = clampFinite(next.autoRec.debounceMs, 1, 1_000, current.autoRec.debounceMs);
    next.tempoSyncEnabled = Boolean(next.tempoSyncEnabled);
    next.tempoSyncSpeed = next.tempoSyncSpeed === TempoSyncSpeed.HALF || next.tempoSyncSpeed === TempoSyncSpeed.DOUBLE
      ? next.tempoSyncSpeed : TempoSyncSpeed.NORMAL;
    next.tempoSyncMode = next.tempoSyncMode === TempoSyncMode.XFADE ? TempoSyncMode.XFADE : TempoSyncMode.PITCH;
    next.recordBpm = next.recordBpm === null ? null : clampFinite(next.recordBpm, 40, 300, current.recordBpm ?? 120);

    const runtime = this.requireRuntime();
    if (runtime) await runtime.updateTrackSettings(this.trackIndex, next);
    this.runtimeSettings = next;
    this.syncModelSettings(next);
    this.updateSettings();
    this.syncMasterPlaybackSpeed();
  }

  public async updateRuntimeSettingsForProject(settings: TrackRuntimeSettings, token: symbol): Promise<void> {
    const next: TrackRuntimeSettings = {
      ...settings,
      reverse: Boolean(settings.reverse),
      oneShot: Boolean(settings.oneShot),
      speed: clampFinite(settings.speed, 0.25, 4, 1),
      fadeInMs: clampFinite(settings.fadeInMs, 0, 10_000, 0),
      fadeOutMs: clampFinite(settings.fadeOutMs, 0, 10_000, 0),
      tempoSyncEnabled: Boolean(settings.tempoSyncEnabled),
      tempoSyncSpeed: settings.tempoSyncSpeed === TempoSyncSpeed.HALF || settings.tempoSyncSpeed === TempoSyncSpeed.DOUBLE
        ? settings.tempoSyncSpeed : TempoSyncSpeed.NORMAL,
      tempoSyncMode: settings.tempoSyncMode === TempoSyncMode.XFADE ? TempoSyncMode.XFADE : TempoSyncMode.PITCH,
      recordBpm: settings.recordBpm === null ? null : clampFinite(settings.recordBpm, 40, 300, 120),
      autoRec: {
        enabled: Boolean(settings.autoRec?.enabled),
        threshold: clampFinite(settings.autoRec?.threshold, 0, 1, 0.01),
        debounceMs: clampFinite(settings.autoRec?.debounceMs, 1, 1_000, 20),
      },
    };
    const runtime = this.requireRuntime();
    if (!runtime) throw new Error('Browser audio is not ready.');
    await runtime.updateTrackSettingsForProject(this.trackIndex, next, token);
    this.runtimeSettings = next;
    this.syncModelSettings(next);
    this.updateSettings();
    this.syncMasterPlaybackSpeed();
  }

  public getHistoryState(): TrackHistoryState {
    const metadata = this.runtime?.getTrackMetadata(this.trackIndex);
    const cursor = metadata ? Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR) : 0;
    const length = metadata ? Atomics.load(metadata, TrackMetaWord.HISTORY_LENGTH) : 0;
    return { cursor, length, canUndo: cursor > 0, canRedo: cursor < length, hasMark: this.runtime?.hasMarkSnapshot(this.trackIndex) ?? false };
  }

  public getLastActionError(): string | null {
    return this.lastActionError;
  }

  /** Re-anchor master-loop phase when this track's effective playback speed changes. */
  public syncMasterPlaybackSpeed(): void {
    if (!this.transport.hasMasterTrack() || this.transport.masterTrackId !== this.track.id) return;
    const runtime = this.runtime;
    const metadata = runtime?.getTrackMetadata(this.trackIndex);
    const loopFrames = metadata ? Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES) : 0;
    if (!runtime || !metadata || loopFrames <= 0) return;

    const normalizedPosition = this.sharedPositions?.[this.trackIndex];
    const metadataPosition = Atomics.load(metadata, TrackMetaWord.PLAY_POSITION);
    const hasLivePosition = this.isActiveTransportState(this.state) &&
      typeof normalizedPosition === 'number' && Number.isFinite(normalizedPosition);
    const sourcePosition = hasLivePosition
      ? Math.max(0, Math.min(loopFrames - 1, normalizedPosition! * loopFrames))
      : Math.max(0, Math.min(loopFrames - 1, metadataPosition));
    this.transport.setMasterPlaybackSpeed(
      this.getEffectivePlaybackSpeed(),
      runtime.getCurrentFrame(),
      sourcePosition,
      this.isReverse ? -1 : 1,
    );
  }

  /** Reconcile low-rate Worklet transitions (AutoRec, one-shot, and timed stop). */
  public refreshRuntimeStateFromWorklet(): void {
    const runtimeState = this.readWorkletState();
    if (runtimeState === null) return;
    this.pendingUiState = null;
    this.localState = runtimeState;
    this.isRecording = runtimeState === TrackState.RECORDING;
    if (this.isActiveTransportState(runtimeState)) this.ensureTransportRunning();
    else this.syncTransportState();
  }

  public async undo(): Promise<boolean> { return await this.runHistoryAction(BrowserRealtimeOpcode.UNDO); }
  public async redo(): Promise<boolean> { return await this.runHistoryAction(BrowserRealtimeOpcode.REDO); }
  public async mark(): Promise<boolean> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime) return false;
    try {
      await runtime.markTrack(this.trackIndex);
      this.refreshRuntimeStateFromWorklet();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  public async restoreMark(): Promise<boolean> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime) return false;
    try {
      // RC-505 Mark Back without an explicit mark returns to the original
      // completed recording. The runtime keeps that BASE take immutable.
      if (!runtime.hasMarkSnapshot(this.trackIndex)) return await this.resetBack();
      await runtime.restoreMarkedTrack(this.trackIndex);
      this.isRecording = false;
      this.state = TrackState.STOPPED;
      this.syncTransportState();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  public async clearMark(): Promise<boolean> {
    const cleared = await this.runHistoryAction(BrowserRealtimeOpcode.CLEAR_MARK);
    if (cleared) this.runtime?.clearMarkSnapshot(this.trackIndex);
    return cleared;
  }
  public async resetBack(): Promise<boolean> { return await this.runHistoryAction(BrowserRealtimeOpcode.RESET_BACK); }
  public async recBack(): Promise<boolean> { return await this.resetBack(); }

  /** Called by the worklet when the fixed, preallocated storage is exhausted. */
  public handleCapacityReached(frame: number) {
    const runtime = this.runtime;
    const metadata = runtime?.getTrackMetadata(this.trackIndex);
    const loopFrames = metadata ? Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES) : 0;
    this.isRecording = false;
    // The worklet has already committed the exact terminal state; capacity
    // exhaustion can leave a valid BASE stopped, rather than playing.
    this.refreshRuntimeStateFromWorklet();
    if (loopFrames > 0 && !this.transport.hasMasterTrack()) {
      this.transport.setMasterTrack(
        this.track.id,
        loopFrames / this.engine.context.sampleRate,
        this.engine.context.sampleRate,
        loopFrames,
        runtime?.getTrackRecordingStartFrame(this.trackIndex) ?? frame,
      );
      this.syncMasterPlaybackSpeed();
    }
    if (this.isActiveTransportState(this.state)) this.ensureTransportRunning();
    else this.syncTransportState();
  }

  private async startOverdub(): Promise<void> {
    const runtime = this.requireRuntime();
    if (this.pendingAction && this.pendingTakeMode === 'OVERDUB') return await this.pendingAction;
    if (!runtime || this.state !== TrackState.PLAYING) return;
    const generation = ++this.commandGeneration;
    this.pendingTakeMode = 'OVERDUB';
    this.pendingAction = this.runStartOverdub(runtime, generation).finally(() => {
      if (this.pendingTakeMode === 'OVERDUB' && generation === this.commandGeneration) {
        this.pendingTakeMode = null;
        this.pendingAction = null;
      }
    });
    return await this.pendingAction;
  }

  private async runStartOverdub(runtime: BrowserRealtimeRuntime, generation: number): Promise<void> {
    const alignmentSamples = this.getOverdubAlignmentSamples();
    try {
      const takeMode = this.track.dubMode === DubMode.OVERDUB ? 'OVERDUB' : this.track.dubMode;
      await runtime.beginTake(this.trackIndex, takeMode);
      if (generation !== this.commandGeneration) return;
      // Storage reservation/compaction may cross a measure or loop edge. Pick
      // the target after preparation so quantization uses the next reachable edge.
      const targetFrame = this.getTrackActionTargetFrame(runtime);
      const [alignment, ack] = await Promise.all([
        runtime.enqueue(BrowserRealtimeOpcode.SET_ALIGNMENT, this.trackIndex, alignmentSamples, 0, targetFrame),
        runtime.enqueue(BrowserRealtimeOpcode.START_OVERDUB, this.trackIndex, 0, 0, targetFrame),
      ]);
      if (!SUCCESS_STATUSES.has(alignment.status) || generation !== this.commandGeneration) return;
      if (generation === this.commandGeneration && SUCCESS_STATUSES.has(ack.status)) {
        this.refreshRuntimeStateFromWorklet();
      } else if (generation === this.commandGeneration) {
        this.reportError(new Error(`Track ${this.track.id} overdub failed (status ${ack.status}).`));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async stopOverdub(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime || (this.state !== TrackState.OVERDUBBING && this.state !== TrackState.REPLACING)) return;
    const generation = ++this.commandGeneration;
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.STOP_OVERDUB,
        this.trackIndex,
        0,
        0,
        runtime.getImmediateTargetFrame(),
      );
      if (generation === this.commandGeneration && SUCCESS_STATUSES.has(ack.status)) {
        this.state = TrackState.PLAYING;
        this.syncTransportState();
      } else if (generation === this.commandGeneration) {
        this.reportError(new Error(`Track ${this.track.id} stop overdub failed (status ${ack.status}).`));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async stopOverdubAndPlayback(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const targetFrame = runtime.getImmediateTargetFrame();
    const generation = ++this.commandGeneration;
    try {
      const [overdubAck, stopAck] = await Promise.all([
        runtime.enqueue(BrowserRealtimeOpcode.STOP_OVERDUB, this.trackIndex, 0, 0, targetFrame),
        runtime.enqueue(BrowserRealtimeOpcode.STOP, this.trackIndex, 0, 0, targetFrame),
      ]);
      if (generation === this.commandGeneration && SUCCESS_STATUSES.has(overdubAck.status) && SUCCESS_STATUSES.has(stopAck.status)) {
        this.state = TrackState.STOPPED;
        this.syncTransportState();
      } else if (generation === this.commandGeneration) {
        const failed = !SUCCESS_STATUSES.has(overdubAck.status) ? overdubAck : stopAck;
        this.reportError(new Error(`Track ${this.track.id} stop overdub and playback failed (status ${failed.status}).`));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async cancelPendingRecording(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const generation = ++this.commandGeneration;
    this.pendingUiState = null;
    const pendingAction = this.pendingAction;
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.CANCEL_PENDING,
        this.trackIndex,
        0,
        0,
        runtime.getImmediateTargetFrame(),
      );
      if (generation !== this.commandGeneration) return;
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.reportError(new Error(`Track ${this.track.id} cancel pending recording failed (status ${ack.status}).`));
        return;
      }
      if (pendingAction) await pendingAction.catch(() => undefined);
      this.pendingTakeMode = null;
      this.pendingAction = null;
      const workletState = this.readWorkletState();
      this.state = workletState === TrackState.RECORDING
        ? TrackState.RECORDING
        : (ack.loopFrames > 0 ? TrackState.STOPPED : TrackState.EMPTY);
      this.isRecording = this.state === TrackState.RECORDING;
      this.syncTransportState();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async cancelPendingStop(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const generation = ++this.commandGeneration;
    this.pendingUiState = null;
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.CANCEL_PENDING,
        this.trackIndex,
        0,
        0,
        runtime.getImmediateTargetFrame(),
      );
      if (generation !== this.commandGeneration) return;
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.reportError(new Error(`Track ${this.track.id} cancel pending stop failed (status ${ack.status}).`));
        return;
      }
      const workletState = this.readWorkletState();
      this.isRecording = workletState === TrackState.RECORDING;
      this.state = workletState ?? TrackState.RECORDING;
    } catch (error) {
      this.reportError(error);
    }
  }

  private getRecordingStartFrame(runtime: BrowserRealtimeRuntime): number {
    return this.getTrackActionTargetFrame(runtime, true);
  }

  private getRecordingStopFrame(runtime: BrowserRealtimeRuntime): number {
    return this.getTrackActionTargetFrame(runtime, true);
  }

  private getTrackActionTargetFrame(runtime: BrowserRealtimeRuntime, recording = false): number {
    const currentFrame = runtime.getCurrentFrame();
    if (!this.transport.hasMasterTrack()) return currentFrame;
    const memory = this.engine.memorySettings;
    if (recording && memory?.quantize === QuantizeMode.MEASURE) {
      return this.transport.getNextMeasureStartFrame(currentFrame);
    }
    if (this.track.loopSyncSw !== Switch.ON) return currentFrame;
    switch (memory?.loopSyncMode ?? LoopSyncMode.MEASURE) {
      case LoopSyncMode.IMMEDIATE:
        return currentFrame;
      case LoopSyncMode.LOOP_LENGTH:
        return this.transport.getNextLoopBoundaryFrame(currentFrame);
      case LoopSyncMode.MEASURE:
      default:
        return this.transport.getNextMeasureStartFrame(currentFrame);
    }
  }

  private getOverdubAlignmentSamples(): number {
    const sampleRate = this.engine.context.sampleRate;
    const userOffset = getBrowserRecordingOffsetConfig(sampleRate, {
      inputDeviceId: this.engine.selectedInputDeviceId ?? null,
      outputDeviceId: this.engine.selectedOutputDeviceId ?? null,
      sampleRate,
      bufferFrames: this.engine.selectedBufferFrames ?? BROWSER_REALTIME_QUANTUM_FRAMES,
    }).recordingOffsetSamples;
    const measuredLoopbackSamples = Math.round(this.engine.roundTripLatency * sampleRate);
    // In reverse the playback cursor moves in the opposite direction, so a
    // positive manual trim moves opposite to physical loopback compensation.
    return this.isReverse
      ? measuredLoopbackSamples - userOffset
      : measuredLoopbackSamples + userOffset;
  }

  private ensureTransportRunning() {
    if (this.transport.state !== TransportState.PLAYING) this.transport.start();
  }

  private getEffectivePlaybackSpeed(masterBpm = this.transport.bpm): number {
    const manualSpeed = clampFinite(this.runtimeSettings.speed, 0.25, 4, 1);
    if (!this.runtimeSettings.tempoSyncEnabled) return manualSpeed;
    const factor = this.runtimeSettings.tempoSyncSpeed === TempoSyncSpeed.HALF
      ? 0.5
      : this.runtimeSettings.tempoSyncSpeed === TempoSyncSpeed.DOUBLE ? 2 : 1;
    const recordBpm = this.runtimeSettings.recordBpm;
    const tempoRatio = recordBpm !== null && Number.isFinite(recordBpm) && recordBpm > 0
      ? masterBpm / recordBpm
      : 1;
    return Math.max(0.25, Math.min(4, manualSpeed * factor * tempoRatio));
  }

  private isActiveTransportState(state: TrackState) {
    return state === TrackState.REC_STANDBY ||
      state === TrackState.RECORDING ||
      state === TrackState.REC_FINISHING ||
      state === TrackState.PLAYING ||
      state === TrackState.OVERDUBBING ||
      state === TrackState.REPLACING;
  }

  private syncTransportState() {
    const hasActiveTracks = this.engine.tracks?.some((track) => this.isActiveTransportState(track.state)) ?? false;
    if (hasActiveTracks) {
      this.ensureTransportRunning();
    } else if (this.transport.state === TransportState.PLAYING) {
      this.transport.stop();
    }
  }

  private requireRuntime(): BrowserRealtimeRuntime | null {
    if (!this.transportEnabled || !this.runtime) return null;
    return this.runtime;
  }

  private readWorkletState(): TrackState | null {
    const raw = this.sharedStates ? Atomics.load(this.sharedStates, this.trackIndex) : null;
    return raw !== null ? WORKLET_TRACK_STATES[raw] ?? null : null;
  }

  private reportError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.lastActionError = message;
    this.engine.reportRuntimeError?.(error);
    console.error(`Track ${this.track.id} realtime command failed:`, error);
  }

  private async runHistoryAction(opcode: number): Promise<boolean> {
    this.lastActionError = null;
    const runtime = this.requireRuntime();
    if (!runtime) return false;
    try {
      const ack = await runtime.enqueue(opcode, this.trackIndex, 0, 0, runtime.getImmediateTargetFrame());
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.reportError(new Error(`Track ${this.track.id} history action failed (status ${ack.status}).`));
        return false;
      }
      if (opcode === BrowserRealtimeOpcode.MARK || opcode === BrowserRealtimeOpcode.CLEAR_MARK) {
        this.refreshRuntimeStateFromWorklet();
      } else {
        this.isRecording = false;
        this.state = ack.loopFrames > 0 ? TrackState.STOPPED : TrackState.EMPTY;
        this.syncTransportState();
      }
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private syncModelSettings(settings: TrackRuntimeSettings) {
    this.isReverse = settings.reverse;
    this.track.reverse = settings.reverse ? Switch.ON : Switch.OFF;
    this.track.tempoSyncSw = settings.tempoSyncEnabled ? Switch.ON : Switch.OFF;
    this.track.tempoSyncSpeed = settings.tempoSyncSpeed;
    this.track.recordBpm = settings.recordBpm;
    this.track.oneShot = settings.oneShot ? Switch.ON : Switch.OFF;
    this.track.startMode = settings.startMode;
    this.track.stopMode = settings.stopMode;
    this.track.fadeInMs = settings.fadeInMs;
    this.track.fadeOutMs = settings.fadeOutMs;
    this.track.speed = settings.speed;
    this.track.keepPitch = settings.keepPitch;
    this.track.autoRecEnabled = settings.autoRec.enabled;
    this.track.autoRecThreshold = settings.autoRec.threshold;
    this.track.autoRecDebounceMs = settings.autoRec.debounceMs;
    this.track.dubMode = settings.dubMode;
    this.isReverse = settings.reverse;
  }
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
