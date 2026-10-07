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
import { Switch, Track, TrackState, TransportState } from '../core/types';
import { Transport } from '../core/Transport';

const SUCCESS_STATUSES = new Set<number>([BrowserRealtimeStatus.OK, BrowserRealtimeStatus.LATE]);

type TrackEngine = IAudioEngine & {
  realtimeRuntime?: BrowserRealtimeRuntime | null;
  isReady?: boolean;
  tracks?: Array<{ state: TrackState }>;
};

/**
 * Browser track controller. Audio lives in the persistent AudioWorklet; this
 * class only translates UI intent into frame-addressed commands and reflects
 * their acknowledgements in UI/transport state.
 */
export class TrackAudio {
  public track: Track;
  public state: TrackState = TrackState.EMPTY;
  public isReverse = false;
  public readonly fxChain: FXChain;

  private readonly engine: TrackEngine;
  private readonly transport: Transport;
  private readonly trackIndex: number;
  private readonly sharedStates: Int32Array | null;
  private readonly sharedPositions: Float32Array | null;
  private commandGeneration = 0;
  private isRecording = false;

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

  public get disabledReason(): string {
    return this.transportEnabled ? '' : 'BROWSER AUDIO NOT READY';
  }

  public get transportEnabled(): boolean {
    return Boolean(this.engine.isReady && this.engine.realtimeRuntime);
  }

  private get runtime(): BrowserRealtimeRuntime | null {
    return this.engine.realtimeRuntime ?? null;
  }

  public updateSettings() {
    this.gainNode.gain.value = this.track.playLevel / 100;

    const pan = this.track.pan;
    if (pan === 'CENTER') {
      this.panNode.pan.value = 0;
    } else if (pan.startsWith('L')) {
      this.panNode.pan.value = -Math.max(0, Math.min(1, parseInt(pan.substring(1), 10) / 50));
    } else if (pan.startsWith('R')) {
      this.panNode.pan.value = Math.max(0, Math.min(1, parseInt(pan.substring(1), 10) / 50));
    }
  }

  public triggerRecord() {
    if (!this.transportEnabled) return;

    switch (this.state) {
      case TrackState.EMPTY:
        void this.startRecording();
        break;
      case TrackState.RECORDING:
        void this.stopRecording(true);
        break;
      case TrackState.REC_STANDBY:
        void this.cancelPendingRecording();
        break;
      case TrackState.REC_FINISHING:
        void this.cancelPendingStop();
        break;
      case TrackState.PLAYING:
        void this.startOverdub();
        break;
      case TrackState.OVERDUBBING:
        void this.stopOverdub();
        break;
      case TrackState.STOPPED:
        void this.play();
        break;
    }
  }

  public triggerStop() {
    if (!this.transportEnabled) return;

    if (this.state === TrackState.REC_STANDBY) {
      void this.cancelPendingRecording();
      return;
    }
    if (this.state === TrackState.RECORDING || this.state === TrackState.REC_FINISHING) {
      void this.stopRecording(false);
      return;
    }
    if (this.state === TrackState.OVERDUBBING) {
      void this.stopOverdubAndPlayback();
      return;
    }

    void this.stop();
  }

  public async startRecording(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime || (this.state !== TrackState.EMPTY && this.state !== TrackState.STOPPED)) return;

    try {
      await runtime.prepareTrack(this.trackIndex);
      const generation = ++this.commandGeneration;
      const targetFrame = this.getRecordingStartFrame(runtime);
      this.state = TrackState.REC_STANDBY;
      this.isRecording = false;
      this.ensureTransportRunning();

      const ack = await runtime.enqueue(BrowserRealtimeOpcode.START_RECORD, this.trackIndex, 0, 0, targetFrame);
      if (generation !== this.commandGeneration || ack.status === BrowserRealtimeStatus.CANCELLED) return;
      if (!SUCCESS_STATUSES.has(ack.status)) {
        this.state = this.readWorkletState() ?? TrackState.EMPTY;
        return;
      }

      this.isRecording = true;
      this.state = TrackState.RECORDING;
      this.syncTransportState();
    } catch (error) {
      this.state = TrackState.EMPTY;
      this.isRecording = false;
      this.reportError(error);
    }
  }

  public async stopRecording(resumeAfterRecording = true): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime || (!this.isRecording && this.state !== TrackState.RECORDING && this.state !== TrackState.REC_FINISHING)) return;

    const generation = ++this.commandGeneration;
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
        this.state = this.readWorkletState() ?? TrackState.STOPPED;
        return;
      }

      this.isRecording = false;
      if (ack.loopFrames > 0 && !this.transport.hasMasterTrack()) {
        this.transport.setMasterTrack(
          this.track.id,
          ack.loopFrames / this.engine.context.sampleRate,
          this.engine.context.sampleRate,
          ack.loopFrames,
          ack.executedFrame,
        );
      }
      this.state = ack.loopFrames > 0 && resumeAfterRecording ? TrackState.PLAYING : TrackState.STOPPED;
      this.syncTransportState();
    } catch (error) {
      this.reportError(error);
      this.state = this.readWorkletState() ?? TrackState.STOPPED;
    }
  }

  public async play(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime || (this.state !== TrackState.STOPPED && this.state !== TrackState.PLAYING)) return;

    const targetFrame = runtime.getImmediateTargetFrame();
    try {
      const ack = await runtime.enqueue(BrowserRealtimeOpcode.PLAY, this.trackIndex, 1, 0, targetFrame);
      if (SUCCESS_STATUSES.has(ack.status)) {
        this.state = TrackState.PLAYING;
        this.ensureTransportRunning();
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  public async stop(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const generation = ++this.commandGeneration;
    try {
      const ack = await runtime.enqueue(BrowserRealtimeOpcode.STOP, this.trackIndex, 0, 0, runtime.getImmediateTargetFrame());
      if (generation !== this.commandGeneration || !SUCCESS_STATUSES.has(ack.status)) return;
      this.isRecording = false;
      this.state = ack.loopFrames > 0 ? TrackState.STOPPED : TrackState.EMPTY;
      this.syncTransportState();
    } catch (error) {
      this.reportError(error);
    }
  }

  public async clear(): Promise<void> {
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
      if (generation !== this.commandGeneration || !SUCCESS_STATUSES.has(clearAck.status)) return;
      this.isReverse = false;
      if (this.sharedPositions) this.sharedPositions[this.trackIndex] = 0;
      this.engine.checkAndResetMaster(this.track.id);
      this.syncTransportState();
      if (!SUCCESS_STATUSES.has(cancelAck.status)) this.reportError(new Error('Worklet did not cancel pending track commands before clear.'));
    } catch (error) {
      this.reportError(error);
      this.state = this.readWorkletState() ?? TrackState.EMPTY;
    }
  }

  public toggleReverse() {
    if (!this.transportEnabled) return;
    this.isReverse = !this.isReverse;
    const runtime = this.runtime;
    if (!runtime) return;
    void runtime.enqueue(
      BrowserRealtimeOpcode.SET_REVERSE,
      this.trackIndex,
      this.isReverse ? 1 : 0,
      0,
      runtime.getImmediateTargetFrame(),
    ).catch((error) => {
      this.isReverse = !this.isReverse;
      this.reportError(error);
    });
  }

  public async exportAudioBuffer(): Promise<AudioBuffer> {
    const runtime = this.requireRuntime();
    if (!runtime) throw new Error('Browser audio is not ready.');
    return await runtime.exportTrack(this.trackIndex, this.engine.context);
  }

  /** Called by the worklet when the fixed, preallocated storage is exhausted. */
  public handleCapacityReached(frame: number) {
    const runtime = this.runtime;
    const metadata = runtime?.getTrackMetadata(this.trackIndex);
    const loopFrames = metadata ? Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES) : 0;
    this.isRecording = false;
    this.state = loopFrames > 0 ? TrackState.PLAYING : TrackState.STOPPED;
    if (loopFrames > 0 && !this.transport.hasMasterTrack()) {
      this.transport.setMasterTrack(
        this.track.id,
        loopFrames / this.engine.context.sampleRate,
        this.engine.context.sampleRate,
        loopFrames,
        frame,
      );
    }
    this.ensureTransportRunning();
    this.syncTransportState();
  }

  private async startOverdub(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime || this.state !== TrackState.PLAYING) return;
    const alignmentSamples = this.getOverdubAlignmentSamples();
    const generation = ++this.commandGeneration;
    const targetFrame = runtime.getImmediateTargetFrame();
    try {
      const [alignment, ack] = await Promise.all([
        runtime.enqueue(BrowserRealtimeOpcode.SET_ALIGNMENT, this.trackIndex, alignmentSamples, 0, targetFrame),
        runtime.enqueue(BrowserRealtimeOpcode.START_OVERDUB, this.trackIndex, 0, 0, targetFrame),
      ]);
      if (!SUCCESS_STATUSES.has(alignment.status) || generation !== this.commandGeneration) return;
      if (generation === this.commandGeneration && SUCCESS_STATUSES.has(ack.status)) {
        this.state = TrackState.OVERDUBBING;
        this.ensureTransportRunning();
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async stopOverdub(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime || this.state !== TrackState.OVERDUBBING) return;
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
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async cancelPendingRecording(): Promise<void> {
    const runtime = this.requireRuntime();
    if (!runtime) return;
    const generation = ++this.commandGeneration;
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.CANCEL_PENDING,
        this.trackIndex,
        0,
        0,
        runtime.getImmediateTargetFrame(),
      );
      if (generation !== this.commandGeneration || !SUCCESS_STATUSES.has(ack.status)) return;
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
    try {
      const ack = await runtime.enqueue(
        BrowserRealtimeOpcode.CANCEL_PENDING,
        this.trackIndex,
        0,
        0,
        runtime.getImmediateTargetFrame(),
      );
      if (generation !== this.commandGeneration || !SUCCESS_STATUSES.has(ack.status)) return;
      const workletState = this.readWorkletState();
      this.isRecording = workletState === TrackState.RECORDING;
      this.state = workletState ?? TrackState.RECORDING;
    } catch (error) {
      this.reportError(error);
    }
  }

  private getRecordingStartFrame(runtime: BrowserRealtimeRuntime): number {
    if (!this.isQuantizedWithMaster()) return runtime.getImmediateTargetFrame();
    return this.transport.getNextMeasureStartFrame(
      runtime.getCurrentFrame(),
      0,
    );
  }

  private getRecordingStopFrame(runtime: BrowserRealtimeRuntime): number {
    if (!this.isQuantizedWithMaster()) return runtime.getImmediateTargetFrame();
    return this.transport.getNextMeasureStartFrame(
      runtime.getCurrentFrame(),
      0,
    );
  }

  private isQuantizedWithMaster(): boolean {
    return this.transport.hasMasterTrack() && this.track.loopSyncSw === Switch.ON;
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

  private isActiveTransportState(state: TrackState) {
    return state === TrackState.REC_STANDBY ||
      state === TrackState.RECORDING ||
      state === TrackState.REC_FINISHING ||
      state === TrackState.PLAYING ||
      state === TrackState.OVERDUBBING;
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
    const states = [
      TrackState.EMPTY,
      TrackState.REC_STANDBY,
      TrackState.RECORDING,
      TrackState.REC_FINISHING,
      TrackState.PLAYING,
      TrackState.OVERDUBBING,
      TrackState.STOPPED,
    ];
    return raw !== null ? states[raw] ?? null : null;
  }

  private reportError(error: unknown) {
    console.error(`Track ${this.track.id} realtime command failed:`, error);
  }
}
