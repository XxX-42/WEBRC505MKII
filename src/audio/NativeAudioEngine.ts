import { TrackState } from '../core/types';
import { Transport } from '../core/Transport';
import { assertNativeFxTarget, NativeBridgeClient, NativeBridgeRequestTimeoutError, type NativeCatalogSlotStatus, type NativeCatalogMidiSlotStatus, type NativeBackend, type NativeCatalogMidiEvent, type NativeCatalogSlotConfig, type NativeConfig, type NativeDeviceCatalog, type NativeDeviceInfo, type NativeFxSlot, type NativeHqEngine, type NativeLoopTransportConfig, type NativeLoopTransportStatus, type NativeOscVocMidiEvent, type NativePitchConfig, type NativePitchStatus, type NativeStatus } from './NativeBridgeClient';
import {
  assertHqWavExportMemoryBudget,
  type HqWavExportOptions,
  type HqWavExportRequestOptions,
  type HqWavExportResult,
} from './export/hqWavExport';
import { encodeWav } from './export/wavEncoder';
import { NativeTrackProxy } from './NativeTrackProxy';
import { NativeRhythmEngine } from './NativeRhythmEngine';
import { sanitizeNativeStepSlicerParameters, type NativeStepSlicerParameters } from './nativeStepSlicerParameters';
import {
  NATIVE_CATALOG_EMPTY_LABEL,
  NATIVE_FX_SLOT_IDS,
  nativeCatalogEffectId,
  nativeCatalogFxOptions,
  nativeCatalogMacroParameters,
  nativeCatalogSlotConfig,
  type NativeCatalogFxState,
  type NativeFxPath,
} from './nativeFxCatalog';

export interface NativeDeviceSelection {
  backends: NativeBackend[];
  selectedBackend: NativeBackend;
  inputs: NativeDeviceInfo[];
  outputs: NativeDeviceInfo[];
  sampleRates: number[];
  bufferOptions: number[];
}

export interface LatencyInfo {
  backend: NativeBackend | null;
  sampleRate: number;
  bufferFrames: number;
  inputLatencyMs: number | null;
  outputLatencyMs: number | null;
  roundTripLatencyMs: number | null;
  inputPeak: number;
  outputPeak: number;
  xrunsOrDropouts: number;
  bridgeAvailable: boolean;
  engineRunning: boolean;
}

export interface NativeUiStatus {
  bridgeAvailable: boolean;
  engineRunning: boolean;
  ready: boolean;
  message: string;
  lastError: string;
}

export interface NativeCatalogFxSlotRuntime {
  path: NativeFxPath;
  slot: NativeFxSlot;
  trackId: number;
  requestedBypassed: boolean;
  appliedBypassed: boolean | null;
  prepared: boolean | null;
  processingFaulted: boolean;
  controlFaulted: boolean;
  pendingApply: boolean;
  requestedRevision: number | null;
  appliedRevision: number | null;
  requestedEffectId: string | null;
  acknowledgedEffectId: string | null;
  requestedParameters: Record<string, number>;
  acknowledgedParameters: Record<string, number> | null;
  acknowledged: boolean;
  pendingRestart: boolean;
  error: string;
}

export interface NativeTrackFxStatus {
  trackId: number;
  available: boolean;
  routeMode: 'per-track-pre-mix' | 'unavailable';
  perTrackFxChainAvailable: boolean;
  legacySharedPostmix: true;
  slots: Array<NativeCatalogFxSlotRuntime & {
    slotIndex: number;
    type: string | null;
    value: number;
    active: boolean;
    bypassed: boolean;
    parameters: Record<string, number>;
    state: 'empty' | 'loading' | 'ready' | 'error';
  }>;
}

export interface NativeOscVocFrameAnchor {
  /** Native callback frame sampled when the last status response arrived. */
  sampleFrame: number;
  /** `performance.now()` time paired with sampleFrame, in milliseconds. */
  observedAtPerformanceTimeMs: number;
  sampleRate: number;
  bufferFrames: number;
  /** Suggested future-frame margin for loopback and callback scheduling jitter. */
  suggestedLeadFrames: number;
}

const TRACK_STATE_VALUES = Object.values(TrackState);
export const DEFAULT_NATIVE_HQ_ENGINE: NativeHqEngine = 'R3';

export class NativeAudioEngine {
  private static instance: NativeAudioEngine;

  public readonly tracks: NativeTrackProxy[];
  public readonly rhythmEngine: NativeRhythmEngine;
  public readonly trackStates: Int32Array;
  public readonly trackPositions: Float32Array;
  public readonly sharedBuffer: SharedArrayBuffer;

  public selectedInputDeviceId: string | null = null;
  public selectedOutputDeviceId: string | null = null;
  public selectedBackend: NativeBackend = 'WASAPI';
  public selectedSampleRate = 48000;
  public selectedBufferFrames = 128;
  public nativeLooperStorageBudgetBytes = 768 * 1024 * 1024;
  public monitoringEnabled = false;

  private readonly bridge = new NativeBridgeClient();
  private readonly monitoringListeners = new Set<(enabled: boolean) => void>();
  private readonly latencyListeners = new Set<(info: LatencyInfo) => void>();
  private readonly statusListeners = new Set<(status: NativeUiStatus) => void>();

  private deviceCatalog: NativeDeviceCatalog | null = null;
  private latestStatus: NativeStatus | null = null;
  private nativeOscVocFrameObservedAtMs = 0;
  private bridgeAvailable = false;
  private engineRunning = false;
  private initInFlight: Promise<void> | null = null;
  private restartInFlight: Promise<void> | null = null;
  private pollHandle: number | null = null;
  private lastError = '';
  private readonly nativeCatalogFxStates: Record<NativeFxPath, NativeCatalogFxState[]> = {
    input: NATIVE_FX_SLOT_IDS.map(() => ({ type: '', value: 0, active: false, parameters: {} })),
    track: NATIVE_FX_SLOT_IDS.map(() => ({ type: '', value: 0, active: false, parameters: {} })),
  };
  private readonly nativeStepSlicerParameters: Record<NativeFxPath, NativeStepSlicerParameters[]> = {
    input: NATIVE_FX_SLOT_IDS.map(() => sanitizeNativeStepSlicerParameters(undefined)),
    track: NATIVE_FX_SLOT_IDS.map(() => sanitizeNativeStepSlicerParameters(undefined)),
  };
  private readonly nativePerTrackFxStates = Array.from({ length: 5 }, () =>
    NATIVE_FX_SLOT_IDS.map((): NativeCatalogFxState => ({ type: '', value: 0, active: false, parameters: {} })));
  private readonly nativePerTrackStepSlicerParameters = Array.from({ length: 5 }, () =>
    NATIVE_FX_SLOT_IDS.map(() => sanitizeNativeStepSlicerParameters(undefined)));
  private readonly nativePerTrackFxEdited = new Set<number>();
  private readonly nativeCatalogFxRuntime = new Map<string, NativeCatalogFxSlotRuntime>();
  private readonly nativeCatalogSlotEditRevisions = new Map<string, number>();
  private nativeFxSyncRevision = 0;
  private nativeFxSyncRunning = false;
  private nativeFxSyncScheduled = false;
  private syncingNativeRhythmBpm = false;
  private readonly onTransportBpmChange = () => {
    this.scheduleNativeFxSync();
    const bpm = Transport.getInstance().bpm;
    if (!this.syncingNativeRhythmBpm && this.rhythmEngine.available && this.rhythmEngine.settings?.bpm !== bpm) void this.rhythmEngine.setBpm(bpm);
  };

  private constructor() {
    this.rhythmEngine = new NativeRhythmEngine({
      bridge: () => this.bridge,
      status: () => this.latestStatus,
      bridgeAvailable: () => this.bridgeAvailable,
      applyStatus: (status) => this.applyStatus(status),
      reportError: (error) => {
        if (error instanceof NativeBridgeRequestTimeoutError && error.reconciledStatus) this.handleBridgeFailure(error, false);
        else if (/Native bridge is unreachable/i.test(String(error))) this.handleBridgeFailure(error);
        else {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.syncNativeRhythmBpm();
        }
      },
      notify: () => this.emitAll(),
    });
    this.sharedBuffer = new SharedArrayBuffer(1024);
    this.trackStates = new Int32Array(this.sharedBuffer, 0, 5);
    this.trackPositions = new Float32Array(this.sharedBuffer, 20, 5);
    this.tracks = Array.from({ length: 5 }, (_, index) => new NativeTrackProxy(this, index + 1));
    this.resetAllTrackTelemetry();
    this.loadPreferences();
    Transport.getInstance().on('bpm-change', this.onTransportBpmChange);
  }

  public static getInstance(): NativeAudioEngine {
    if (!NativeAudioEngine.instance) {
      NativeAudioEngine.instance = new NativeAudioEngine();
    }
    return NativeAudioEngine.instance;
  }

  public async init() {
    if (this.initInFlight) {
      return this.initInFlight;
    }

    this.initInFlight = this.initializeNative();
    try {
      await this.initInFlight;
    } finally {
      this.initInFlight = null;
    }
  }

  /** Stop the live host before applying saved FX type changes, then restore audio. */
  public async restartAudio(): Promise<void> {
    if (this.initInFlight) await this.initInFlight;
    if (this.restartInFlight) return this.restartInFlight;

    const restart = this.performRestartAudio();
    this.restartInFlight = restart;
    try {
      await restart;
    } finally {
      if (this.restartInFlight === restart) this.restartInFlight = null;
    }
  }

  private async performRestartAudio(): Promise<void> {
    this.stopPolling();
    let failureHandled = false;
    try {
      if (!this.bridgeAvailable) {
        failureHandled = true;
        await this.init();
        return;
      }
      if (!this.deviceCatalog) await this.refreshCatalog();

      if (this.engineRunning) {
        const stopped = await this.bridge.stopEngine();
        this.applyStatus(stopped);
        if (stopped.engineRunning) {
          throw new Error('Native audio host acknowledged the stop request but still reports running; saved FX were not applied.');
        }
      }

      // applyAndStart applies the latest configuration, synchronizes every
      // shared and per-track catalog slot while stopped, then starts the host.
      failureHandled = true;
      await this.applyAndStart();
      this.emitAll();
    } catch (error) {
      if (!failureHandled) this.handleBridgeFailure(error, false);
      throw error;
    } finally {
      if (this.bridgeAvailable) this.startPolling();
    }
  }

  public async getDevices(): Promise<NativeDeviceSelection> {
    if (!this.deviceCatalog) {
      await this.refreshCatalog();
    }

    if (!this.deviceCatalog) {
      throw new Error('Native device catalog is unavailable.');
    }

    return this.buildSelectionFromCatalog(this.deviceCatalog);
  }

  public async setBackend(backend: NativeBackend) {
    this.selectedBackend = backend;
    const selection = await this.getDevices();
    this.selectedInputDeviceId = this.selectedInputDeviceId || this.deviceCatalog?.defaultInputIdByBackend[backend] || selection.inputs[0]?.id || null;
    this.selectedOutputDeviceId = this.selectedOutputDeviceId || this.deviceCatalog?.defaultOutputIdByBackend[backend] || selection.outputs[0]?.id || null;

    const supportedRates = this.deriveSampleRates(selection.inputs, selection.outputs);
    if (!supportedRates.includes(this.selectedSampleRate)) {
      this.selectedSampleRate = supportedRates[0] ?? 48000;
    }

    await this.applyAndStart();
  }

  public async setInputDevice(deviceId: string) {
    this.selectedInputDeviceId = deviceId || null;
    await this.applyAndStart();
  }

  public async setOutputDevice(deviceId: string) {
    this.selectedOutputDeviceId = deviceId || null;
    await this.applyAndStart();
  }

  public async setSampleRate(sampleRate: number) {
    const previousSampleRate = this.selectedSampleRate;
    this.selectedSampleRate = sampleRate;
    try {
      await this.applyAndStart();
    } catch (error) {
      this.selectedSampleRate = previousSampleRate;
      throw error;
    }
  }

  public async setNativeLooperStorageBudget(budgetBytes: number) {
    const previousBudget = this.nativeLooperStorageBudgetBytes;
    this.nativeLooperStorageBudgetBytes = budgetBytes;
    try {
      await this.applyAndStart();
    } catch (error) {
      this.nativeLooperStorageBudgetBytes = previousBudget;
      throw error;
    }
  }

  public async setBufferFrames(bufferFrames: number) {
    this.selectedBufferFrames = bufferFrames;
    await this.applyAndStart();
  }

  public async setMonitoring(enabled: boolean) {
    try {
      const status = await this.bridge.setMonitoring(enabled);
      this.applyStatus(status);
    } catch (error) {
      this.handleBridgeFailure(error);
      throw error;
    }
  }

  /**
   * Returns the latest Native sample-clock/Browser monotonic-time anchor.
   * Callers can convert Web MIDI `timeStamp` values to an absolute frame and
   * add suggestedLeadFrames before queueOscVocMidiEvent().
   */
  public getOscVocMidiFrameAnchor(): NativeOscVocFrameAnchor | null {
    const status = this.latestStatus;
    const sampleFrame = status?.nativeSampleFrame;
    const sampleRate = status?.sampleRate;
    const bufferFrames = status?.bufferFrames;
    if (!this.engineRunning || !Number.isSafeInteger(sampleFrame) || sampleFrame! < 0 ||
        !Number.isInteger(sampleRate) || sampleRate! <= 0 ||
        !Number.isInteger(bufferFrames) || bufferFrames! <= 0) {
      return null;
    }
    return {
      sampleFrame: sampleFrame!,
      observedAtPerformanceTimeMs: this.nativeOscVocFrameObservedAtMs,
      sampleRate: sampleRate!,
      bufferFrames: bufferFrames!,
      suggestedLeadFrames: Math.max(bufferFrames! * 2, Math.ceil(sampleRate! * 0.02)),
    };
  }

  /** Queues one bounded MIDI note event at an absolute Native sample frame. */
  public async queueOscVocMidiEvent(event: NativeOscVocMidiEvent): Promise<NativeStatus> {
    const status = await this.bridge.queueOscVocMidiEvent(event);
    this.applyStatus(status);
    return status;
  }

  /** Queues one event only to the exact selected MIDI-driven catalog slot. */
  public async queueCatalogMidiEvent(event: NativeCatalogMidiEvent): Promise<NativeStatus> {
    const status = await this.bridge.queueCatalogMidiEvent(event);
    this.applyStatus(status);
    return status;
  }

  /** Configures the single Native looper's callback-owned pitch route. */
  public async setPitch(config: NativePitchConfig): Promise<NativeStatus> {
    try {
      const status = await this.bridge.setPitch(config);
      this.applyStatus(status);
      return status;
    } catch (error) {
      this.handleBridgeFailure(error, false);
      throw error;
    }
  }

  /** Applies source-aware Native transport to one stored loop and adopts the host's status acknowledgement. */
  public async setLoopTransport(trackId: number, config: NativeLoopTransportConfig): Promise<NativeStatus> {
    try {
      const status = await this.bridge.setLoopTransport(trackId, config);
      this.applyStatus(status);
      return status;
    } catch (error) {
      this.handleBridgeFailure(error, false);
      throw error;
    }
  }

  /** Latest per-track loop-transport runtime status; old bridge builds report no status. */
  public getLoopTransportStatus(trackId: number): NativeLoopTransportStatus | null {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) return null;
    return this.latestStatus?.nativeTracks?.find((track) => track.trackId === trackId)?.loopTransportStatus ?? null;
  }

  /** Latest Native pitch route acknowledgement, including its selected track ID. */
  public getNativePitchStatus(): NativePitchStatus | null {
    return this.latestStatus?.nativePitch ?? null;
  }

  public getNativeSampleRate(): number {
    return this.latestStatus?.sampleRate ?? this.selectedSampleRate;
  }

  public onMonitoringChange(listener: (enabled: boolean) => void) {
    this.monitoringListeners.add(listener);
    listener(this.monitoringEnabled);
    return () => {
      this.monitoringListeners.delete(listener);
    };
  }

  public onLatencyInfoChange(listener: (info: LatencyInfo) => void) {
    this.latencyListeners.add(listener);
    listener(this.getLatencyInfo());
    return () => {
      this.latencyListeners.delete(listener);
    };
  }

  public onStatusChange(listener: (status: NativeUiStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.getUiStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public getLatencyInfo(): LatencyInfo {
    return {
      backend: this.latestStatus?.backend ?? null,
      sampleRate: this.latestStatus?.sampleRate ?? this.selectedSampleRate,
      bufferFrames: this.latestStatus?.bufferFrames ?? this.selectedBufferFrames,
      inputLatencyMs: this.latestStatus?.inputLatencyMs ?? null,
      outputLatencyMs: this.latestStatus?.outputLatencyMs ?? null,
      roundTripLatencyMs: this.latestStatus?.roundTripEstimateMs ?? null,
      inputPeak: this.latestStatus?.inputPeak ?? 0,
      outputPeak: this.latestStatus?.outputPeak ?? 0,
      xrunsOrDropouts: this.latestStatus?.xrunsOrDropouts ?? 0,
      bridgeAvailable: this.bridgeAvailable,
      engineRunning: this.engineRunning,
    };
  }

  public getUiStatus(): NativeUiStatus {
    if (!this.bridgeAvailable) {
      return {
        bridgeAvailable: false,
        engineRunning: false,
        ready: false,
        message: 'NATIVE AUDIO UNAVAILABLE',
        lastError: this.lastError || 'Start native_bridge_host on http://127.0.0.1:17755.',
      };
    }

    if (!this.engineRunning) {
      return {
        bridgeAvailable: true,
        engineRunning: false,
        ready: false,
        message: 'NATIVE ENGINE STOPPED',
        lastError: this.lastError,
      };
    }

    return {
      bridgeAvailable: true,
      engineRunning: true,
      ready: true,
      message: 'NATIVE AUDIO READY',
      lastError: this.lastError,
    };
  }

  public isNativeReady() {
    return this.bridgeAvailable && this.engineRunning;
  }

  public isBridgeAvailable() {
    return this.bridgeAvailable;
  }

  public supportsFx() {
    return this.getCatalogFxOptions('input').length > 0 || this.getCatalogFxOptions('track').length > 0;
  }

  public supportsRhythm() {
    return this.rhythmEngine.available;
  }

  public supportsReverse() {
    return false;
  }

  public isTrackAvailable(trackId: number) {
    return this.isNativeTrackAvailable(trackId);
  }

  public getNativeTrackCount() {
    if (this.latestStatus?.nativeLooperMultiTrackImplemented !== true) return 1;
    const reported = this.latestStatus.nativeLooperTrackCount ?? 1;
    return Number.isInteger(reported) ? Math.max(1, Math.min(5, reported)) : 1;
  }

  public isNativeTrackAvailable(trackId: number) {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) return false;
    if (trackId === 1) return true;
    return this.latestStatus?.nativeLooperMultiTrackImplemented === true &&
      trackId <= (this.latestStatus.nativeLooperTrackCount ?? 0);
  }

  public nativeTrackState(trackId: number) {
    const reported = this.latestStatus?.nativeTracks?.find((track) => track.trackId === trackId);
    if (reported) return reported.state;
    return trackId === 1 ? this.latestStatus?.state ?? 'Empty' : 'Empty';
  }

  public canExportHqWav(trackId = 1) {
    const state = this.nativeTrackState(trackId);
    return this.isNativeReady() && this.isNativeTrackAvailable(trackId) && this.getNativeHqRenderer().available &&
      (state === 'Stopped' || state === 'Playing');
  }

  /** Returns only explicitly advertised, supported Native Rubber Band engines. */
  public getNativeHqRenderer(): { available: boolean; engines: NativeHqEngine[] } {
    const capability = this.latestStatus?.nativeHqRenderer;
    if (capability?.available !== true || !Array.isArray(capability.engines)) {
      return { available: false, engines: [] };
    }
    const engines = [...new Set(capability.engines.filter((engine): engine is NativeHqEngine => engine === 'R2' || engine === 'R3'))];
    return { available: engines.length > 0, engines };
  }

  public async exportHqWav(
    options: HqWavExportRequestOptions,
    onProgress?: (fraction: number) => void,
    trackId = 1,
  ): Promise<HqWavExportResult> {
    if (!this.canExportHqWav(trackId)) {
      throw new Error('Native HQ WAV export requires a completed loop while stopped or playing.');
    }
    if (options.nativeHqEngine !== undefined && options.nativeHqEngine !== 'R2' && options.nativeHqEngine !== 'R3') {
      throw new TypeError('Native HQ engine must be R2 or R3.');
    }
    if (!Number.isFinite(options.semitones) || options.semitones < -24 || options.semitones > 24) {
      throw new RangeError('semitones must be between -24 and +24');
    }
    if (!Number.isFinite(options.playbackRate) || options.playbackRate < 0.5 || options.playbackRate > 2) {
      throw new RangeError('playbackRate must be between 0.5 and 2');
    }
    const engine = options.nativeHqEngine ?? DEFAULT_NATIVE_HQ_ENGINE;
    if (!this.getNativeHqRenderer().engines.includes(engine)) {
      throw new Error(`Native HQ renderer engine ${engine} is not available in the connected bridge.`);
    }

    // The metadata-only response lets us reject oversized renders before POST
    // starts the offline renderer or its Float32 response body is read.
    const metadata = await this.bridge.getTrackMetadata(trackId);
    if (metadata.trackId !== trackId || metadata.channels !== 2 || metadata.frameCount <= 0) {
      throw new Error('Native bridge returned inconsistent HQ render track metadata.');
    }
    const wavOptions: HqWavExportOptions = {
      sampleRate: metadata.sampleRate,
      semitones: options.semitones,
      playbackRate: options.playbackRate,
      format: options.format,
      memoryBudgetBytes: options.memoryBudgetBytes,
    };
    assertHqWavExportMemoryBudget(metadata.frameCount, metadata.channels, wavOptions, 'native');

    onProgress?.(0);
    const rendered = await this.bridge.renderHqTrack(trackId, {
      semitones: options.semitones,
      playbackRate: options.playbackRate,
      engine,
      memoryBudgetBytes: options.memoryBudgetBytes ?? 512 * 1024 * 1024,
      format: options.format,
    }, metadata);
    const expectedFrames = Math.ceil(metadata.frameCount / options.playbackRate);
    if (rendered.trackId !== trackId || rendered.sampleRate !== metadata.sampleRate ||
        rendered.frameCount !== expectedFrames || rendered.channels !== 2 || rendered.engine !== engine ||
        rendered.latencySamples !== 0 || rendered.samples.length !== expectedFrames * 2) {
      throw new Error('Native HQ renderer returned output with an unexpected engine, duration, or PCM shape.');
    }

    const left = new Float32Array(rendered.frameCount);
    const right = new Float32Array(rendered.frameCount);
    for (let frame = 0; frame < rendered.frameCount; frame += 1) {
      left[frame] = rendered.samples[frame * 2]!;
      right[frame] = rendered.samples[(frame * 2) + 1]!;
    }
    const bytes = encodeWav([left, right], { sampleRate: rendered.sampleRate, format: options.format });
    onProgress?.(1);
    return Object.freeze({
      mode: 'HQ_RENDER' as const,
      bytes,
      sampleRate: rendered.sampleRate,
      format: options.format,
      semitones: options.semitones,
      playbackRate: options.playbackRate,
      frameCount: rendered.frameCount,
      leadingLatencySamples: rendered.latencySamples,
    });
  }

  public async recordTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.recordTrack(trackId));
  }

  public async stopTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.stopTrack(trackId));
  }

  public async playTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.playTrack(trackId));
  }

  public async toggleOverdub(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.toggleTrackOverdub(trackId));
  }

  public async clearTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.clearTrack(trackId));
  }

  public stopAllTracks() {
    for (const track of this.tracks) {
      if (this.isNativeTrackAvailable(track.trackId) && this.nativeTrackState(track.trackId) !== 'Empty') {
        void this.stopTrack(track.trackId);
      }
    }
  }

  public playAllTracks() {
    for (const track of this.tracks) {
      if (this.isNativeTrackAvailable(track.trackId)) void this.playTrack(track.trackId);
    }
  }

  public setFxType(location: NativeFxPath, slotIndex: number, type: string, trackId = 0) {
    const state = this.nativeCatalogStates(location, trackId)[slotIndex];
    if (!state || typeof type !== 'string') return;
    const nextType = type === NATIVE_CATALOG_EMPTY_LABEL ? '' : type;
    if (state.type !== nextType) state.parameters = {};
    state.type = nextType;
    this.nativeCatalogSlotEdited(location, slotIndex, trackId);
  }

  public setFxParam(location: NativeFxPath, slotIndex: number, value: number, trackId = 0) {
    const state = this.nativeCatalogStates(location, trackId)[slotIndex];
    if (!state || !Number.isFinite(value)) return;
    state.value = Math.max(0, Math.min(100, value));
    this.nativeCatalogSlotEdited(location, slotIndex, trackId);
  }

  public setFxActive(location: NativeFxPath, slotIndex: number, active: boolean, trackId = 0) {
    const state = this.nativeCatalogStates(location, trackId)[slotIndex];
    if (!state) return;
    state.active = Boolean(active);
    this.nativeCatalogSlotEdited(location, slotIndex, trackId);
  }

  public setTrackFxType(trackId: number, slotIndex: number, type: string): boolean {
    if (!this.isValidTrackFxSlot(trackId, slotIndex) || typeof type !== 'string') return false;
    this.setFxType('track', slotIndex, type, trackId);
    const effectId = nativeCatalogEffectId(type);
    return !type || type === NATIVE_CATALOG_EMPTY_LABEL || (effectId !== null && effectId !== 'vinyl_flick' && effectId !== 'beat_shift' &&
      this.latestStatus?.nativeFx?.catalogEffectAvailability?.find((entry) => entry.effectId === effectId)?.perTrackInsert !== false);
  }

  public setTrackFxParameter(trackId: number, slotIndex: number, value: number): boolean {
    if (!this.isValidTrackFxSlot(trackId, slotIndex) || !Number.isFinite(value) || value < 0 || value > 100) return false;
    this.setFxParam('track', slotIndex, value, trackId);
    return true;
  }

  public setTrackFxNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
    if (!this.isValidTrackFxSlot(trackId, slotIndex) || !this.isValidCatalogParameters(parameters)) return false;
    this.setCatalogFxParameters('track', slotIndex, parameters, trackId);
    return true;
  }

  public setTrackFxActive(trackId: number, slotIndex: number, active: boolean): boolean {
    if (!this.isValidTrackFxSlot(trackId, slotIndex) || typeof active !== 'boolean') return false;
    this.setFxActive('track', slotIndex, active, trackId);
    return true;
  }

  public getTrackFxStatus(trackId?: number): NativeTrackFxStatus[] {
    if (trackId !== undefined && !this.isValidTrackFxSlot(trackId, 0)) return [];
    return (trackId === undefined ? [1, 2, 3, 4, 5] : [trackId]).map((id) => {
      const available = this.isPerTrackCatalogAvailable(id);
      return {
        trackId: id,
        available,
        routeMode: available ? 'per-track-pre-mix' : 'unavailable',
        perTrackFxChainAvailable: available,
        legacySharedPostmix: true,
        slots: this.nativeCatalogStates('track', id).map((state, slotIndex) => {
          const runtime = this.getCatalogFxSlotStatus('track', slotIndex, id);
          return {
            ...runtime, slotIndex, type: state.type || null, value: state.value,
            active: state.active, bypassed: runtime.appliedBypassed ?? !state.active,
            parameters: { ...state.parameters },
            state: runtime.error || (!available && state.type) ? 'error'
              : !state.type ? 'empty'
                : runtime.acknowledged ? 'ready' : 'loading',
          };
        }),
      };
    });
  }

  public isPerTrackCatalogAvailable(trackId: number): boolean {
    return this.isValidTrackFxSlot(trackId, 0) && this.bridgeAvailable &&
      this.latestStatus?.nativeFx?.perTrackCatalogAvailable === true &&
      this.latestStatus.nativeFx.perTrackCatalogBanks?.some((bank) => bank.trackId === trackId) === true;
  }

  /** Stores the editable Native Step Slicer sequence for one target's A–D slot. */
  public setCatalogStepSlicerParameters(path: NativeFxPath, slotIndex: number, parameters: NativeStepSlicerParameters, trackId = 0) {
    assertNativeFxTarget(path, trackId);
    const bank = trackId ? this.nativePerTrackStepSlicerParameters[trackId - 1]! : this.nativeStepSlicerParameters[path];
    if (!bank[slotIndex]) return;
    bank[slotIndex] = sanitizeNativeStepSlicerParameters(parameters);
    this.nativeCatalogSlotEdited(path, slotIndex, trackId);
  }

  /** Stores per-slot named controls; caller supplies a complete current parameter set. */
  public setCatalogFxParameters(path: NativeFxPath, slotIndex: number, parameters: Record<string, number>, trackId = 0) {
    const state = this.nativeCatalogStates(path, trackId)[slotIndex];
    if (!state || !this.isValidCatalogParameters(parameters)) return;
    state.parameters = { ...parameters };
    this.nativeCatalogSlotEdited(path, slotIndex, trackId);
  }

  public getCatalogFxOptions(path: NativeFxPath, trackId = 0) {
    assertNativeFxTarget(path, trackId);
    if (trackId && !this.isPerTrackCatalogAvailable(trackId)) return [];
    const options = nativeCatalogFxOptions(this.latestStatus, path);
    return trackId ? options.filter((type) => {
      const effectId = nativeCatalogEffectId(type);
      return effectId !== 'vinyl_flick' && effectId !== 'beat_shift' &&
        this.latestStatus?.nativeFx?.catalogEffectAvailability?.find((entry) => entry.effectId === effectId)?.perTrackInsert !== false;
    }) : options;
  }

  public getCatalogFxSlotStatus(path: NativeFxPath, slotIndex: number, trackId = 0): NativeCatalogFxSlotRuntime {
    const state = this.nativeCatalogStates(path, trackId)[slotIndex];
    const slot = NATIVE_FX_SLOT_IDS[slotIndex];
    if (!state || !slot) throw new RangeError('Invalid Native catalog slot index; expected 0–3.');
    const reported = this.nativeCatalogSlotFromStatus(path, slot, trackId);
    const runtime = this.nativeCatalogFxRuntime.get(this.nativeCatalogSlotKey(path, slot, trackId));
    return runtime ? {
      ...runtime,
      requestedParameters: { ...runtime.requestedParameters },
      acknowledgedParameters: runtime.acknowledgedParameters ? { ...runtime.acknowledgedParameters } : null,
    } : {
      path, slot, trackId,
      requestedEffectId: nativeCatalogEffectId(state.type),
      acknowledgedEffectId: this.nativeCatalogEffectIdFromStatus(path, slot, trackId),
      requestedParameters: this.nativeCatalogParameters(path, slotIndex, trackId),
      acknowledgedParameters: null,
      requestedBypassed: state.type ? !state.active : false,
      appliedBypassed: reported?.appliedBypassed ?? reported?.bypassed ?? null,
      prepared: reported?.prepared ?? null, processingFaulted: reported?.processingFaulted === true,
      controlFaulted: reported?.controlFaulted === true, pendingApply: false,
      requestedRevision: null, appliedRevision: reported?.appliedRevision ?? null,
      acknowledged: false, pendingRestart: false,
      error: trackId && !this.isPerTrackCatalogAvailable(trackId) ? 'Native per-track catalog FX is unavailable in this bridge status.' : '',
    };
  }

  public getCatalogMidiSlotStatus(path: NativeFxPath, slotIndex: number, trackId = 0): NativeCatalogMidiSlotStatus | null {
    assertNativeFxTarget(path, trackId);
    const slot = NATIVE_FX_SLOT_IDS[slotIndex];
    if (!slot) throw new RangeError('Invalid Native catalog slot index; expected 0–3.');
    const slots = trackId
      ? this.latestStatus?.nativeFx?.perTrackCatalogBanks?.find((bank) => bank.trackId === trackId)?.midiSlots
      : path === 'input' ? this.latestStatus?.nativeFx?.catalogMidi?.inputSlots : this.latestStatus?.nativeFx?.catalogMidi?.trackSlots;
    const reported = slots?.find((entry) => entry.slot === slot);
    return reported ? { ...reported } : null;
  }

  public getCatalogFxSlotStates(path: NativeFxPath, trackId = 0): NativeCatalogFxState[] {
    return this.nativeCatalogStates(path, trackId).map((state) => ({ ...state, parameters: { ...state.parameters } }));
  }

  private isValidTrackFxSlot(trackId: number, slotIndex: number): boolean {
    return Number.isInteger(trackId) && trackId >= 1 && trackId <= 5 &&
      Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < 4;
  }

  private isValidCatalogParameters(parameters: Record<string, number>): boolean {
    return parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters) &&
      Object.entries(parameters).every(([key, value]) => key.length > 0 && Number.isFinite(value));
  }

  private nativeCatalogStates(path: NativeFxPath, trackId: number): NativeCatalogFxState[] {
    assertNativeFxTarget(path, trackId);
    return trackId ? this.nativePerTrackFxStates[trackId - 1]! : this.nativeCatalogFxStates[path];
  }

  private nativeCatalogParameters(path: NativeFxPath, slotIndex: number, trackId: number): Record<string, number> {
    const state = this.nativeCatalogStates(path, trackId)[slotIndex]!;
    return state.type === 'STEP SLICER'
      ? { ...this.nativeStepSlicerBridgeParameters(path, slotIndex, trackId), ...state.parameters }
      : state.type ? { ...nativeCatalogMacroParameters(state.type, state.value), ...state.parameters } : {};
  }

  private nativeCatalogSlotEdited(path: NativeFxPath, slotIndex: number, trackId: number) {
    if (trackId) this.nativePerTrackFxEdited.add(trackId);
    const slot = NATIVE_FX_SLOT_IDS[slotIndex]!;
    const key = this.nativeCatalogSlotKey(path, slot, trackId);
    this.nativeCatalogSlotEditRevisions.set(key, (this.nativeCatalogSlotEditRevisions.get(key) ?? 0) + 1);
    const runtime = this.nativeCatalogFxRuntime.get(key);
    if (runtime) {
      const state = this.nativeCatalogStates(path, trackId)[slotIndex]!;
      runtime.requestedEffectId = nativeCatalogEffectId(state.type);
      runtime.requestedParameters = this.nativeCatalogParameters(path, slotIndex, trackId);
      runtime.requestedBypassed = state.type ? !state.active : false;
      runtime.acknowledged = false;
      runtime.pendingApply = false;
      runtime.error = '';
    }
    this.scheduleNativeFxSync();
  }
  public playTestTone() { return; }
  public runLoopbackTest() { return Promise.reject(new Error('Loopback test is not implemented in native v1.')); }
  public setLatency(_latencyMs: number) { return; }

  public updateTrackTelemetry(trackId: number, state: TrackState, progress: number) {
    const stateIndex = TRACK_STATE_VALUES.indexOf(state);
    Atomics.store(this.trackStates, trackId - 1, Math.max(0, stateIndex));
    this.trackPositions[trackId - 1] = progress;
  }

  private async initializeNative() {
    try {
      await this.bridge.health();
      this.bridgeAvailable = true;
      await this.refreshCatalog();
      await this.applyAndStart();
      await this.refreshStatus();
      this.startPolling();
      this.emitAll();
    } catch (error) {
      this.handleBridgeFailure(error, !this.bridgeAvailable);
      throw error;
    }
  }

  private async refreshCatalog() {
    this.deviceCatalog = await this.bridge.getDevices();
  }

  private buildSelectionFromCatalog(catalog: NativeDeviceCatalog): NativeDeviceSelection {
    const selectedBackend = catalog.backends.includes(this.selectedBackend) ? this.selectedBackend : (catalog.backends[0] ?? 'WASAPI');
    const inputs = catalog.inputsByBackend[selectedBackend] ?? [];
    const outputs = catalog.outputsByBackend[selectedBackend] ?? [];

    if (!this.selectedInputDeviceId || !inputs.some((device) => device.id === this.selectedInputDeviceId)) {
      this.selectedInputDeviceId = catalog.defaultInputIdByBackend[selectedBackend] || inputs[0]?.id || null;
    }
    if (!this.selectedOutputDeviceId || !outputs.some((device) => device.id === this.selectedOutputDeviceId)) {
      this.selectedOutputDeviceId = catalog.defaultOutputIdByBackend[selectedBackend] || outputs[0]?.id || null;
    }

    const sampleRates = this.deriveSampleRates(inputs, outputs);
    if (!sampleRates.includes(this.selectedSampleRate)) {
      this.selectedSampleRate = sampleRates[0] ?? 48000;
    }

    if (!(catalog.bufferOptions ?? []).includes(this.selectedBufferFrames)) {
      this.selectedBufferFrames = catalog.bufferOptions[0] ?? 128;
    }

    this.selectedBackend = selectedBackend;

    return {
      backends: catalog.backends,
      selectedBackend,
      inputs,
      outputs,
      sampleRates,
      bufferOptions: catalog.bufferOptions,
    };
  }

  private deriveSampleRates(inputs: NativeDeviceInfo[], outputs: NativeDeviceInfo[]) {
    const inputRates = new Set((inputs.find((device) => device.id === this.selectedInputDeviceId) ?? inputs[0])?.sampleRates ?? []);
    const outputRates = new Set((outputs.find((device) => device.id === this.selectedOutputDeviceId) ?? outputs[0])?.sampleRates ?? []);
    const overlap = [...inputRates].filter((rate) => outputRates.has(rate)).sort((a, b) => a - b);
    return overlap.length > 0 ? overlap : [44100, 48000];
  }

  private currentConfig(): NativeConfig {
    return {
      backend: this.selectedBackend,
      inputDeviceId: this.selectedInputDeviceId || '',
      outputDeviceId: this.selectedOutputDeviceId || '',
      sampleRate: this.selectedSampleRate,
      bufferFrames: this.selectedBufferFrames,
      monitoringEnabled: this.monitoringEnabled,
      nativeLooperStorageBudgetBytes: this.nativeLooperStorageBudgetBytes,
    };
  }

  private async applyAndStart() {
    if (!this.deviceCatalog) {
      await this.refreshCatalog();
    }

    try {
      const applied = await this.bridge.applyConfig(this.currentConfig());
      this.applyStatus(applied);
      // The Native host currently permits effect type replacement only while
      // stopped. Rebuild shared and per-loop A–D banks before audio starts.
      await this.syncNativeFxCatalogSlots(true);
      const started = await this.bridge.startEngine();
      this.applyStatus(started);
      this.savePreferences();
    } catch (error) {
      this.handleBridgeFailure(error, false);
      throw error;
    }
  }

  private async dispatchStatusRequest(request: () => Promise<NativeStatus>) {
    try {
      const status = await request();
      this.applyStatus(status);
    } catch (error) {
      this.handleBridgeFailure(error, false);
      throw error;
    }
  }

  /** Coalesce rapid UI edits and keep desired states separate from Native ACKs. */
  private scheduleNativeFxSync() {
    this.nativeFxSyncRevision += 1;
    if (!this.bridgeAvailable || this.nativeFxSyncRunning || this.nativeFxSyncScheduled) return;
    this.nativeFxSyncScheduled = true;
    queueMicrotask(() => {
      this.nativeFxSyncScheduled = false;
      if (this.bridgeAvailable && !this.nativeFxSyncRunning) void this.runNativeFxSync();
    });
  }

  private async runNativeFxSync() {
    this.nativeFxSyncRunning = true;
    let attemptedRevision = this.nativeFxSyncRevision;
    try {
      do {
        attemptedRevision = this.nativeFxSyncRevision;
        await this.syncNativeFxCatalogSlots(false);
      } while (this.bridgeAvailable && attemptedRevision !== this.nativeFxSyncRevision);
    } finally {
      this.nativeFxSyncRunning = false;
      if (this.bridgeAvailable && attemptedRevision !== this.nativeFxSyncRevision) this.scheduleNativeFxSync();
    }
  }

  private async syncNativeFxCatalogSlots(allowTypeChange: boolean) {
    const targets: Array<{ path: NativeFxPath; trackId: number }> = [{ path: 'input', trackId: 0 }, { path: 'track', trackId: 0 }];
    for (let trackId = 1; trackId <= 5; trackId += 1) {
      if (this.isPerTrackCatalogAvailable(trackId) || this.nativePerTrackFxEdited.has(trackId)) targets.push({ path: 'track', trackId });
    }
    for (const { path, trackId } of targets) {
      for (let slotIndex = 0; slotIndex < NATIVE_FX_SLOT_IDS.length; slotIndex += 1) {
        const state = this.nativeCatalogStates(path, trackId)[slotIndex]!;
        const slot = NATIVE_FX_SLOT_IDS[slotIndex]!;
        let config = nativeCatalogSlotConfig(path, slotIndex, state);
        if (config) config = {
          ...config, ...(trackId ? { trackId } : {}),
          parameters: this.nativeCatalogParameters(path, slotIndex, trackId),
        };
        const requestedId = config?.effectId || null;
        const currentId = this.nativeCatalogEffectIdFromStatus(path, slot, trackId);
        const key = this.nativeCatalogSlotKey(path, slot, trackId);
        const options = this.getCatalogFxOptions(path, trackId);
        const editRevision = this.nativeCatalogSlotEditRevisions.get(key) ?? 0;
        const previousRuntime = this.nativeCatalogFxRuntime.get(key);
        if (trackId && !allowTypeChange && config && previousRuntime &&
            (previousRuntime.acknowledged || previousRuntime.pendingApply) &&
            previousRuntime.requestedEffectId === requestedId && previousRuntime.requestedBypassed === config.bypassed &&
            JSON.stringify(previousRuntime.requestedParameters) === JSON.stringify(config.parameters ?? {})) {
          // Poll the original application revision instead of queueing unchanged
          // controls for all other tracks on every slider edit.
          this.reconcileNativeCatalogRuntime(previousRuntime);
          if (previousRuntime.acknowledged || previousRuntime.pendingApply) continue;
        }
        // A UI edit may arrive while this request awaits its response. Keep the
        // in-flight request snapshot separate so an old ACK cannot accept it.
        const runtime: NativeCatalogFxSlotRuntime = previousRuntime ? { ...previousRuntime } : {
          path, slot, trackId, requestedEffectId: requestedId, acknowledgedEffectId: currentId,
          requestedParameters: config?.parameters ?? {}, acknowledgedParameters: null,
          requestedBypassed: config?.bypassed ?? false, appliedBypassed: null,
          prepared: null, processingFaulted: false, controlFaulted: false, pendingApply: false,
          requestedRevision: null, appliedRevision: null,
          acknowledged: false, pendingRestart: false, error: '',
        };
        runtime.requestedEffectId = requestedId;
        runtime.requestedParameters = { ...(config?.parameters ?? {}) };
        runtime.requestedBypassed = config?.bypassed ?? false;
        runtime.error = '';
        runtime.pendingRestart = false;
        runtime.pendingApply = false;

        if (trackId && !this.isPerTrackCatalogAvailable(trackId)) {
          runtime.acknowledged = false;
          runtime.error = 'Native per-track catalog FX is unavailable in this bridge status.';
        } else if (!config || (requestedId && !options.includes(state.type))) {
          const error = config
            ? `Native ${path} catalog does not support ${state.type}.`
            : `Native catalog selection “${state.type}” has no implemented effect ID.`;
          await this.rejectUnsupportedCatalogSelection(path, slot, currentId, allowTypeChange, runtime, error, trackId);
        } else if (this.engineRunning && !allowTypeChange && requestedId !== currentId) {
          runtime.acknowledgedEffectId = currentId;
          runtime.acknowledged = false;
          runtime.pendingRestart = true;
          runtime.error = 'Effect type changes are saved and apply after restarting Native audio; the running engine rejects live slot replacement.';
        } else if (requestedId === currentId && !requestedId && !allowTypeChange && trackId) {
          // Clearing even an already-empty slot requires stopped audio. Read its
          // current application state rather than issuing a live clear command.
          runtime.requestedRevision = this.nativeCatalogSlotFromStatus(path, slot, trackId)?.requestedRevision ?? null;
          this.reconcileNativeCatalogRuntime(runtime);
        } else if (requestedId === currentId && !requestedId && !allowTypeChange && !trackId) {
          runtime.acknowledgedEffectId = null;
          runtime.acknowledgedParameters = {};
          runtime.acknowledged = true;
          runtime.appliedBypassed = false;
        } else {
          try {
            const status = await this.bridge.setCatalogSlot(config);
            this.applyStatus(status);
            if (trackId) {
              runtime.requestedRevision = this.nativeCatalogSlotFromStatus(path, slot, trackId)?.requestedRevision ?? null;
              this.reconcileNativeCatalogRuntime(runtime);
            } else {
              const reported = this.nativeCatalogSlotFromStatus(path, slot, 0);
              runtime.acknowledgedEffectId = reported?.effectId || null;
              runtime.appliedBypassed = reported?.bypassed ?? null;
              runtime.acknowledged = reported !== undefined && runtime.acknowledgedEffectId === requestedId &&
                reported.bypassed === config.bypassed;
              if (runtime.acknowledged) runtime.acknowledgedParameters = { ...(config.parameters ?? {}) };
              runtime.error = runtime.acknowledged ? '' : 'Native returned an ACK with a different or missing selected effect/bypass.';
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            runtime.acknowledgedEffectId = currentId;
            runtime.acknowledged = false;
            runtime.pendingRestart = /stop native audio|live parameter edits require/i.test(message);
            runtime.error = message;
            this.lastError = message;
          }
        }
        if ((this.nativeCatalogSlotEditRevisions.get(key) ?? 0) !== editRevision) {
          const desired = this.nativeCatalogStates(path, trackId)[slotIndex]!;
          runtime.requestedEffectId = nativeCatalogEffectId(desired.type);
          runtime.requestedParameters = this.nativeCatalogParameters(path, slotIndex, trackId);
          runtime.requestedBypassed = desired.type ? !desired.active : false;
          runtime.acknowledged = false;
          runtime.pendingApply = false;
          runtime.pendingRestart = false;
          runtime.error = '';
        }
        this.nativeCatalogFxRuntime.set(key, runtime);
        this.emitAll();
      }
    }
  }

  private async rejectUnsupportedCatalogSelection(
    path: NativeFxPath,
    slot: NativeFxSlot,
    currentId: string | null,
    allowTypeChange: boolean,
    runtime: NativeCatalogFxSlotRuntime,
    reason: string,
    trackId = 0,
  ) {
    runtime.acknowledged = false;
    runtime.acknowledgedEffectId = currentId;
    runtime.pendingRestart = Boolean(currentId && this.engineRunning && !allowTypeChange);
    runtime.error = currentId && this.engineRunning && !allowTypeChange
      ? `${reason} The previous Native effect is being bypassed; restart audio to clear it.`
      : reason;

    if (!currentId) return;
    const canReplace = allowTypeChange || !this.engineRunning;
    const safetyConfig: NativeCatalogSlotConfig = {
      path, slot, ...(trackId ? { trackId } : {}),
      effectId: canReplace ? '' : currentId, parameters: {}, bypassed: !canReplace,
    };
    try {
      const status = await this.bridge.setCatalogSlot(safetyConfig);
      this.applyStatus(status);
      runtime.acknowledgedEffectId = this.nativeCatalogEffectIdFromStatus(path, slot, trackId);
      runtime.acknowledgedParameters = canReplace ? {} : null;
      this.updateNativeCatalogTelemetry(runtime);
      runtime.pendingRestart = !canReplace;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.error = `${runtime.error} ${message}`;
    }
  }

  private nativeCatalogSlotKey(path: NativeFxPath, slot: NativeFxSlot, trackId = 0) {
    return trackId ? `${path}:${trackId}:${slot}` : `${path}:${slot}`;
  }

  private nativeStepSlicerBridgeParameters(path: NativeFxPath, slotIndex: number, trackId = 0): Record<string, number> {
    const bpm = Transport.getInstance().bpm;
    const bank = trackId ? this.nativePerTrackStepSlicerParameters[trackId - 1]! : this.nativeStepSlicerParameters[path];
    return {
      ...bank[slotIndex],
      bpm: Number.isFinite(bpm) ? Math.max(30, Math.min(300, bpm)) : 120,
    };
  }

  private nativeCatalogSlotFromStatus(path: NativeFxPath, slot: NativeFxSlot, trackId: number):
    (Pick<NativeCatalogSlotStatus, 'slot' | 'effectId' | 'bypassed'> & Partial<NativeCatalogSlotStatus>) | undefined {
    const slots = trackId
      ? this.latestStatus?.nativeFx?.perTrackCatalogBanks?.find((bank) => bank.trackId === trackId)?.slots
      : path === 'input' ? this.latestStatus?.nativeFx?.inputCatalogSlots : this.latestStatus?.nativeFx?.catalogSlots;
    return slots?.find((entry) => entry.slot === slot);
  }

  private nativeCatalogEffectIdFromStatus(path: NativeFxPath, slot: NativeFxSlot, trackId = 0): string | null {
    return this.nativeCatalogSlotFromStatus(path, slot, trackId)?.effectId || null;
  }

  /** HTTP acceptance and callback application are separate for per-track commands. */
  private reconcileNativeCatalogRuntime(runtime: NativeCatalogFxSlotRuntime) {
    const reported = this.updateNativeCatalogTelemetry(runtime);
    runtime.acknowledged = false;
    runtime.pendingApply = false;
    if (!reported || !Number.isSafeInteger(runtime.requestedRevision) || runtime.requestedRevision! < 0) {
      runtime.error = 'Native returned no per-track slot application acknowledgement.';
    } else if (runtime.controlFaulted) {
      runtime.error = 'Native per-track slot control application failed; reconfigure the slot to retry.';
    } else if (runtime.processingFaulted) {
      runtime.error = 'Native per-track slot processor faulted; reconfigure the slot to retry.';
    } else if (runtime.acknowledgedEffectId !== runtime.requestedEffectId ||
        reported.bypassed !== runtime.requestedBypassed || reported.requestedRevision !== runtime.requestedRevision) {
      runtime.error = 'Native returned an ACK for a different per-track slot selection or revision.';
    } else {
      runtime.acknowledged = runtime.appliedRevision === runtime.requestedRevision &&
        runtime.appliedBypassed === runtime.requestedBypassed && (!runtime.requestedEffectId || runtime.prepared === true);
      runtime.pendingApply = !runtime.acknowledged;
      runtime.error = '';
      if (runtime.acknowledged) runtime.acknowledgedParameters = { ...runtime.requestedParameters };
    }
  }

  private updateNativeCatalogTelemetry(runtime: NativeCatalogFxSlotRuntime) {
    const reported = this.nativeCatalogSlotFromStatus(runtime.path, runtime.slot, runtime.trackId);
    runtime.acknowledgedEffectId = reported?.effectId || null;
    runtime.appliedBypassed = reported?.appliedBypassed ?? null;
    runtime.prepared = reported?.prepared ?? null;
    runtime.processingFaulted = reported?.processingFaulted === true;
    runtime.controlFaulted = reported?.controlFaulted === true;
    runtime.appliedRevision = reported?.appliedRevision ?? null;
    return reported;
  }

  private async refreshStatus() {
    try {
      const status = await this.bridge.getStatus();
      this.applyStatus(status);
    } catch (error) {
      this.handleBridgeFailure(error);
    }
  }

  private syncNativeRhythmBpm() {
    const rhythm = this.rhythmEngine.settings;
    if (!this.rhythmEngine.available || !rhythm || rhythm.bpm === Transport.getInstance().bpm) return;
    this.syncingNativeRhythmBpm = true;
    try { Transport.getInstance().setBpm(rhythm.bpm); }
    finally { this.syncingNativeRhythmBpm = false; }
  }

  private applyStatus(status: NativeStatus) {
    this.latestStatus = status;
    this.nativeOscVocFrameObservedAtMs = performance.now();
    this.bridgeAvailable = true;
    this.engineRunning = status.engineRunning;
    this.monitoringEnabled = status.monitoringEnabled;
    this.selectedBackend = status.backend;
    this.selectedInputDeviceId = status.inputDeviceId || this.selectedInputDeviceId;
    this.selectedOutputDeviceId = status.outputDeviceId || this.selectedOutputDeviceId;
    this.selectedSampleRate = status.sampleRate || this.selectedSampleRate;
    this.selectedBufferFrames = status.bufferFrames || this.selectedBufferFrames;
    this.nativeLooperStorageBudgetBytes = status.nativeLooperStorageBudgetBytes || this.nativeLooperStorageBudgetBytes;
    this.lastError = status.lastError || '';
    this.syncNativeRhythmBpm();
    for (const runtime of this.nativeCatalogFxRuntime.values()) {
      if (!runtime.trackId) continue;
      if (runtime.pendingApply || runtime.acknowledged) this.reconcileNativeCatalogRuntime(runtime);
      else this.updateNativeCatalogTelemetry(runtime);
    }

    for (const track of this.tracks) {
      const reported = status.nativeTracks?.find((entry) => entry.trackId === track.trackId);
      const state = reported?.state ?? (track.trackId === 1 ? status.state : 'Empty');
      const progress = reported?.loopProgress ?? (track.trackId === 1 ? status.loopProgress : 0);
      track.syncNativeState(state, progress);
    }

    this.emitAll();
  }

  private handleBridgeFailure(error: unknown, markBridgeMissing = true) {
    if (error instanceof NativeBridgeRequestTimeoutError && error.reconciledStatus) {
      // The request may have been applied before its response timed out. Keep
      // the bridge's acknowledged transport state, but surface the timeout so
      // the user can see that the command response itself was lost.
      this.applyStatus(error.reconciledStatus);
      this.lastError = error.message;
      this.emitAll();
      return;
    }

    if (markBridgeMissing) {
      this.bridgeAvailable = false;
      this.engineRunning = false;
      this.stopPolling();
    }

    this.lastError = error instanceof Error ? error.message : String(error);
    this.latestStatus = null;
    for (const runtime of this.nativeCatalogFxRuntime.values()) {
      runtime.acknowledged = false;
      runtime.pendingApply = false;
      runtime.error = this.lastError;
    }
    this.monitoringEnabled = false;
    this.resetAllTrackTelemetry();
    this.emitAll();
  }

  private resetAllTrackTelemetry() {
    for (let trackId = 1; trackId <= 5; trackId += 1) {
      this.updateTrackTelemetry(trackId, TrackState.EMPTY, 0);
    }
  }

  private startPolling() {
    if (this.pollHandle !== null) {
      return;
    }
    this.pollHandle = window.setInterval(() => {
      void this.refreshStatus();
    }, 100);
  }

  private stopPolling() {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private emitAll() {
    const latency = this.getLatencyInfo();
    const status = this.getUiStatus();
    this.monitoringListeners.forEach((listener) => listener(this.monitoringEnabled));
    this.latencyListeners.forEach((listener) => listener(latency));
    this.statusListeners.forEach((listener) => listener(status));
  }

  private savePreferences() {
    localStorage.setItem('nativeBackend', this.selectedBackend);
    localStorage.setItem('nativeInputDeviceId', this.selectedInputDeviceId || '');
    localStorage.setItem('nativeOutputDeviceId', this.selectedOutputDeviceId || '');
    localStorage.setItem('nativeSampleRate', String(this.selectedSampleRate));
    localStorage.setItem('nativeBufferFrames', String(this.selectedBufferFrames));
    localStorage.setItem('nativeLooperStorageBudgetBytes', String(this.nativeLooperStorageBudgetBytes));
  }

  private loadPreferences() {
    const backend = localStorage.getItem('nativeBackend');
    if (backend === 'WASAPI' || backend === 'ASIO') {
      this.selectedBackend = backend;
    }

    this.selectedInputDeviceId = localStorage.getItem('nativeInputDeviceId') || null;
    this.selectedOutputDeviceId = localStorage.getItem('nativeOutputDeviceId') || null;

    const sampleRate = Number(localStorage.getItem('nativeSampleRate') || '');
    if (Number.isFinite(sampleRate) && sampleRate > 0) {
      this.selectedSampleRate = sampleRate;
    }

    const bufferFrames = Number(localStorage.getItem('nativeBufferFrames') || '');
    if (Number.isFinite(bufferFrames) && bufferFrames > 0) {
      this.selectedBufferFrames = bufferFrames;
    }

    const loopStorageBudgetBytes = Number(localStorage.getItem('nativeLooperStorageBudgetBytes') || '');
    if ([768, 1536, 2560].some((mibibytes) => loopStorageBudgetBytes === mibibytes * 1024 * 1024)) {
      this.nativeLooperStorageBudgetBytes = loopStorageBudgetBytes;
    }
  }
}
