import type { RecordPlaySettings, RecordPlaySettingsPatch } from './RecordPlaySettings';
import { createNativeRc505MemoryRuntime } from './NativeRc505MemoryRuntime';
import type { Rc505MemoryRuntime } from './Rc505Memory';
import { isOfficialFxSlotAllowed } from './fx/official/parameters';
import { findOfficialRuntimeParameter, isOfficialRuntimeValueValid, resolveOfficialEffect, officialParameterDomain, encodeOfficialValue } from './fx/official/parameters';
import { mixerState, mixerChannelIndex, assertMixerLevel, type MixerChannel, type MixerState } from './Mixer';
import { TrackState } from '../core/types';
import { Transport } from '../core/Transport';
import { assertNativeFxTarget, NativeBridgeClient, NativeBridgeRequestTimeoutError, NativeTrackFxApplyAcknowledgementError, type NativeCatalogSlotStatus, type NativeCatalogMidiSlotStatus, type NativeBackend, type NativeCatalogMidiEvent, type NativeCatalogSlotConfig, type NativeConfig, type NativeDeviceCatalog, type NativeDeviceInfo, type NativeFxParameterDescriptor, type NativeFxParameterSchema, type NativeFxSlot, type NativeHqEngine, type NativeLoopTransportConfig, type NativeLoopTransportStatus, type NativeOscVocMidiEvent, type NativePitchConfig, type NativePitchStatus, type NativeProjectImportStatus, type NativeStatus, type NativeTrackHistoryStatus, type NativeTrackMarkStatus } from './NativeBridgeClient';
import {
  assertHqWavExportMemoryBudget,
  type HqWavExportOptions,
  type HqWavExportRequestOptions,
  type HqWavExportResult,
} from './export/hqWavExport';
import { encodeWav } from './export/wavEncoder';
import { NativeTrackProxy } from './NativeTrackProxy';
import type { TrackFxApplyStatus } from './TrackFxApplyStatus';
import { NativeRhythmEngine } from './NativeRhythmEngine';
import { unsupportedTrackMarkState, type TrackMarkActionResult, type TrackMarkState } from './TrackMark';
import { encodeProjectArchive, PROJECT_ARCHIVE_LIMITS, type NativeProjectRestoreToken, type ProjectArchive, type ProjectArchiveTrackList } from './projectArchive';
import { sanitizeNativeStepSlicerParameters, type NativeStepSlicerParameters } from './nativeStepSlicerParameters';
import {
  NATIVE_CATALOG_EMPTY_LABEL,
  NATIVE_CATALOG_FX_LABELS,
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

export class NativeProjectArchiveCommittedError extends Error {
  public readonly generation: number;
  public readonly archiveCommitted = true;

  public constructor(generation: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Project audio was imported successfully (generation ${generation}), but the user-interface transport state could not be synchronized: ${detail}`);
    this.name = 'NativeProjectArchiveCommittedError';
    this.generation = generation;
  }
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
  /** A timed-out write is never replayed; reconcile its revision before deciding whether it applied. */
  outcomeUnknown?: boolean;
  baselineRequestedRevision?: number | null;
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

function isNativeTrackMarkStatus(value: NativeTrackMarkStatus): boolean {
  return typeof value.exists === 'boolean'
    && typeof value.canSet === 'boolean'
    && typeof value.canClear === 'boolean'
    && typeof value.busy === 'boolean'
    && Number.isSafeInteger(value.retainedPcmBytes) && value.retainedPcmBytes >= 0
    && typeof value.unavailableReason === 'string'
    && Number.isSafeInteger(value.requestedGeneration) && value.requestedGeneration >= 0
    && Number.isSafeInteger(value.appliedGeneration) && value.appliedGeneration >= 0
    && value.appliedGeneration <= value.requestedGeneration;
}
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
  /** Slots explicitly edited in this frontend session and not yet confirmed by host readback. */
  private readonly nativeCatalogFxDirtySlots = new Set<string>();
  /** Edit revision associated with each in-flight Native catalog write. */
  private readonly nativeCatalogFxSubmittedEditRevisions = new Map<string, number>();
  /** Host-authored snapshots adopted without issuing writes. */
  private readonly nativeCatalogFxHydratedSlots = new Set<string>();
  /** Legacy host status can omit parameters; bypass edits must then stay patch-only. */
  private readonly nativeCatalogFxUnknownParameterSlots = new Set<string>();
  private nativeFxSyncRevision = 0;
  private nativeFxSyncRunning = false;
  private nativeFxSyncScheduled = false;
  private syncingNativeRhythmBpm = false;
  private readonly pendingProjectImportSync = new Map<number, Pick<ProjectArchive, 'bpm' | 'transport'> & {
    operationStartTransport: NativeProjectRestoreToken['transport'];
    operationStartTransportRevision: number;
  }>();
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
    Transport.getInstance().on('time-signature-change', this.onTransportBpmChange);
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

  /** Latest callback-acknowledged Native PCM history for one loop track. */
  public getNativeTrackHistoryStatus(trackId: number): NativeTrackHistoryStatus | null {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) return null;
    return this.latestStatus?.nativeTracks?.find((track) => track.trackId === trackId)?.history ?? null;
  }

  public getMarkState(trackId: number): TrackMarkState {
    const nativeMark = this.latestStatus?.nativeTracks?.find((track) => track.trackId === trackId)?.mark;
    if (this.latestStatus?.nativeMarkVersion !== 1 || !this.latestStatus.nativeMarks || !nativeMark
      || !this.isNativeTrackAvailable(trackId)) {
      return unsupportedTrackMarkState('The connected Native host does not advertise MARK SET/CLEAR version 1.');
    }
    if (!isNativeTrackMarkStatus(nativeMark)) {
      return unsupportedTrackMarkState('The connected Native host returned an invalid mark status.');
    }
    return {
      supported: true,
      exists: nativeMark.exists,
      canSet: nativeMark.canSet && !nativeMark.exists && !nativeMark.busy,
      canClear: nativeMark.canClear && nativeMark.exists && !nativeMark.busy,
      backSupported: false,
      busy: nativeMark.busy,
      retainedPcmBytes: nativeMark.retainedPcmBytes,
      unavailableReason: nativeMark.unavailableReason === 'none' ? null : nativeMark.unavailableReason,
      requestedGeneration: nativeMark.requestedGeneration,
      appliedGeneration: nativeMark.appliedGeneration,
    };
  }

  public async setMark(trackId: number): Promise<TrackMarkActionResult> {
    const before = this.getMarkState(trackId);
    if (!before.supported) return { ok: false, unsupported: true, reason: before.unavailableReason, state: before };
    if (!before.canSet) {
      const reason = before.unavailableReason ?? 'Native MARK SET is unavailable for this track.';
      return { ok: false, reason, state: before };
    }
    const generation = before.requestedGeneration + 1;
    try {
      this.applyStatus(await this.bridge.setTrackMark(trackId, generation));
      const state = this.getMarkState(trackId);
      if (state.appliedGeneration === generation && state.exists) return { ok: true, reason: null, state };
      const reason = state.unavailableReason ?? 'Native MARK SET did not return its applied-generation acknowledgement.';
      this.lastError = reason;
      this.emitAll();
      return { ok: false, reason, state };
    } catch (error) {
      const readback = await this.readBackMarkStatusAfterFailure(error);
      if (readback) this.applyStatus(readback);
      const state = this.getMarkState(trackId);
      if (state.supported && state.appliedGeneration === generation && state.exists) {
        return { ok: true, reason: null, state };
      }
      const reason = error instanceof NativeBridgeRequestTimeoutError && !readback
        ? 'Native MARK SET timed out and its status could not be read. Check mark status before trying again.'
        : state.unavailableReason ?? (error instanceof Error ? error.message : String(error));
      this.lastError = reason;
      this.emitAll();
      return { ok: false, unsupported: !state.supported, reason, state };
    }
  }

  public async clearMark(trackId: number): Promise<TrackMarkActionResult> {
    const before = this.getMarkState(trackId);
    if (!before.supported) return { ok: false, unsupported: true, reason: before.unavailableReason, state: before };
    if (!before.canClear) {
      const reason = before.unavailableReason ?? 'Native MARK CLEAR is unavailable for this track.';
      return { ok: false, reason, state: before };
    }
    const generation = before.requestedGeneration + 1;
    try {
      this.applyStatus(await this.bridge.clearTrackMark(trackId, generation));
      const state = this.getMarkState(trackId);
      if (state.appliedGeneration === generation && !state.exists) return { ok: true, reason: null, state };
      const reason = state.unavailableReason ?? 'Native MARK CLEAR did not return its applied-generation acknowledgement.';
      this.lastError = reason;
      this.emitAll();
      return { ok: false, reason, state };
    } catch (error) {
      const readback = await this.readBackMarkStatusAfterFailure(error);
      if (readback) this.applyStatus(readback);
      const state = this.getMarkState(trackId);
      if (state.supported && state.appliedGeneration === generation && !state.exists) {
        return { ok: true, reason: null, state };
      }
      const reason = error instanceof NativeBridgeRequestTimeoutError && !readback
        ? 'Native MARK CLEAR timed out and its status could not be read. Check mark status before trying again.'
        : state.unavailableReason ?? (error instanceof Error ? error.message : String(error));
      this.lastError = reason;
      this.emitAll();
      return { ok: false, unsupported: !state.supported, reason, state };
    }
  }

  public async backToMark(_trackId: number): Promise<TrackMarkActionResult> {
    const state = unsupportedTrackMarkState('MARK BACK is unsupported because its recording-state transition is ambiguous.');
    return { ok: false, unsupported: true, reason: state.unavailableReason, state };
  }

  private async readBackMarkStatusAfterFailure(error: unknown): Promise<NativeStatus | null> {
    if (error instanceof NativeBridgeRequestTimeoutError) return error.reconciledStatus;
    try { return await this.bridge.getStatus(); }
    catch { return null; }
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

  /**
   * Exports the same v1 PCM/transport archive as Browser. Native projects are
   * read through callback-pinned snapshots; every track's monotonic content
   * revision is checked before, during, and after capture so five sequential
   * HTTP reads can never be persisted as a mixed-generation project.
   */
  public createRc505MemoryRuntime(): Rc505MemoryRuntime {
    return createNativeRc505MemoryRuntime({
      bridge: this.bridge,
      status: () => this.latestStatus,
      editRevision: () => `${this.nativeFxSyncRevision}:${[...this.nativeCatalogSlotEditRevisions.values()].reduce((sum, value) => sum + value, 0)}`,
      archive: () => this.exportProjectArchive(''),
      publish: (status) => this.applyStatus(status),
      pendingEdits: () => this.nativeFxSyncRunning || this.nativeFxSyncScheduled || this.nativeCatalogFxDirtySlots.size > 0,
      install: (status) => {
        this.nativeCatalogFxDirtySlots.clear();
        this.nativeCatalogFxSubmittedEditRevisions.clear();
        this.nativeCatalogFxHydratedSlots.clear();
        this.nativeCatalogFxUnknownParameterSlots.clear();
        this.nativeCatalogFxRuntime.clear();
        this.nativePerTrackFxEdited.clear();
        this.applyStatus(status);
        this.hydrateNativeCatalogFromStatus(status);
        this.emitAll();
      },
    });
  }

  public async exportProjectArchive(name: string): Promise<Uint8Array> {
    const initial = await this.bridge.getStatus();
    if (!initial.engineRunning || initial.nativeLooperMultiTrackImplemented !== true ||
        initial.nativeLooperTrackCount !== 5 || !Array.isArray(initial.nativeTracks) || initial.nativeTracks.length !== 5) {
      throw new Error('Native project export requires a running five-track Native host with content-revision support');
    }
    const initialTracks = [1, 2, 3, 4, 5].map((trackId) => {
      const track = initial.nativeTracks!.find((entry) => entry.trackId === trackId);
      if (!track || !Number.isSafeInteger(track.contentRevision) || track.contentRevision! < 0) {
        throw new Error(`Native Track ${trackId} host does not report a valid content revision; update the Native host before saving project memory`);
      }
      if (track.state === 'Recording' || track.state === 'Overdubbing') {
        throw new Error(`Stop recording or overdubbing on Native Track ${trackId} before saving project memory`);
      }
      return track;
    });
    if (initial.sampleRate < 8_000 || initial.sampleRate > 192_000) {
      throw new Error('Native project sample rate is outside the archive-supported range');
    }

    const transport = Transport.getInstance();
    const transportSnapshot = {
      bpm: transport.bpm,
      masterTrackId: transport.masterTrackId,
      masterLoopLengthSamples: transport.masterLoopLengthSamples,
      timeSignatureNumerator: transport.timeSignature[0],
      timeSignatureDenominator: transport.timeSignature[1],
      measureLengthSeconds: transport.masterTrackId === null ? 0 : transport.getMeasureDuration(),
    };
    const descriptors = new Array<null | { sampleRate: number; frameCount: number; channels: 2; contentRevision: number }>(5).fill(null);
    let payloadBytes = 0;
    for (let index = 0; index < 5; index += 1) {
      const reported = initialTracks[index]!;
      if (reported.state === 'Empty') continue;
      const metadata = await this.bridge.getTrackMetadata(index + 1);
      if (metadata.trackId !== index + 1 || metadata.channels !== 2 || metadata.sampleRate !== initial.sampleRate ||
          !Number.isSafeInteger(metadata.contentRevision) || metadata.contentRevision !== reported.contentRevision) {
        throw new Error(`Native Track ${index + 1} changed or returned inconsistent metadata while project export was being prepared`);
      }
      if (!Number.isSafeInteger(metadata.frameCount * 2 * Float32Array.BYTES_PER_ELEMENT)) {
        throw new Error(`Native Track ${index + 1} PCM size is outside the supported integer range`);
      }
      payloadBytes += metadata.frameCount * 2 * Float32Array.BYTES_PER_ELEMENT;
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes > PROJECT_ARCHIVE_LIMITS.maxPayloadBytes) {
        throw new Error(`Native project PCM exceeds the ${Math.floor(PROJECT_ARCHIVE_LIMITS.maxPayloadBytes / (1024 * 1024))} MiB archive payload limit`);
      }
      descriptors[index] = { sampleRate: metadata.sampleRate, frameCount: metadata.frameCount, channels: 2, contentRevision: metadata.contentRevision! };
    }

    if (transportSnapshot.masterTrackId !== null) {
      const masterId = transportSnapshot.masterTrackId;
      if (!Number.isInteger(masterId) || masterId < 1 || masterId > 5 || descriptors[masterId - 1] === null ||
          descriptors[masterId - 1]!.frameCount !== transportSnapshot.masterLoopLengthSamples) {
        throw new Error('Native project transport master does not match the referenced track PCM; project was not saved');
      }
    } else if (transportSnapshot.masterLoopLengthSamples !== 0) {
      throw new Error('Native project has loop timing without a master track; project was not saved');
    }

    const tracks: Array<null | { sampleRate: number; frameCount: number; channels: 2; pcm: Float32Array }> = new Array(5).fill(null);
    for (let index = 0; index < 5; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor) continue;
      const snapshot = await this.bridge.getLoopSnapshot(index + 1);
      if (snapshot.sampleRate !== descriptor.sampleRate || snapshot.frameCount !== descriptor.frameCount ||
          snapshot.channels !== 2 || snapshot.contentRevision !== descriptor.contentRevision ||
          snapshot.samples.length !== descriptor.frameCount * 2) {
        throw new Error(`Native Track ${index + 1} changed between metadata and PCM snapshot; project save was canceled`);
      }
      // contentRevision is a host consistency token, not part of the shared
      // archive schema. Keep the encoded track object restricted to v1 keys.
      tracks[index] = {
        sampleRate: descriptor.sampleRate,
        frameCount: descriptor.frameCount,
        channels: 2,
        pcm: snapshot.samples,
      };
    }

    const after = await this.bridge.getStatus();
    if (!after.engineRunning || after.sampleRate !== initial.sampleRate || !Array.isArray(after.nativeTracks) || after.nativeTracks.length !== 5 ||
        after.nativeTracks.some((track, index) => track.contentRevision !== initialTracks[index]!.contentRevision ||
          track.state === 'Recording' || track.state === 'Overdubbing') ||
        transport.bpm !== transportSnapshot.bpm || transport.masterTrackId !== transportSnapshot.masterTrackId ||
        transport.masterLoopLengthSamples !== transportSnapshot.masterLoopLengthSamples ||
        transport.timeSignature[0] !== transportSnapshot.timeSignatureNumerator ||
        transport.timeSignature[1] !== transportSnapshot.timeSignatureDenominator) {
      throw new Error('Native project export canceled because a track or transport changed during snapshot capture');
    }

    return encodeProjectArchive({
      name,
      bpm: transportSnapshot.bpm,
      transport: {
        masterTrackId: transportSnapshot.masterTrackId,
        measureLengthSeconds: transportSnapshot.measureLengthSeconds,
        masterLoopLengthSamples: transportSnapshot.masterLoopLengthSamples,
        timeSignatureNumerator: transportSnapshot.timeSignatureNumerator,
        timeSignatureDenominator: transportSnapshot.timeSignatureDenominator,
      },
      tracks: tracks as unknown as ProjectArchiveTrackList,
    });
  }

  /**
   * Restore Native PCM via the host's callback-boundary five-track transaction.
   * The decoded archive bytes are sent intact so the host independently checks
   * the manifest, hashes, sample values, rate, and all-track capacity.
   */
  public async captureProjectRestoreBaseline(): Promise<{ projectContentRevision: number; sampleRate: number }> {
    // Read directly from the host, never from latestStatus: the latter is
    // polled asynchronously and may predate edits made just before load.
    const status = await this.bridge.getStatus();
    if (!status.engineRunning || status.nativeLooperMultiTrackImplemented !== true ||
        status.nativeLooperTrackCount !== 5 || !Array.isArray(status.nativeTracks) || status.nativeTracks.length !== 5) {
      throw new Error('Native project load requires a running five-track host with operation-start revision support.');
    }
    if (status.projectContentRevisionSnapshotStable !== true) {
      throw new Error('Native host could not capture a stable project revision/status snapshot; current loops were left unchanged. Retry project load.');
    }
    if (!Number.isSafeInteger(status.projectContentRevision) || (status.projectContentRevision ?? -1) < 0) {
      throw new Error('Native host does not provide the operation-start project content revision required to protect loops during archive decoding; update the Native host before loading project memory.');
    }
    if (status.projectContentRevision! >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Native host project revision reached the safe integer limit; restart the Native host before loading project memory.');
    }
    if (!Number.isSafeInteger(status.sampleRate) || status.sampleRate < 8_000 || status.sampleRate > 192_000) {
      throw new Error('Native host reported an unsupported sample rate while project load was starting.');
    }
    const busy = status.nativeTracks.find((track) => track.state === 'Recording' || track.state === 'Overdubbing');
    if (busy) throw new Error(`Stop Native Track ${busy.trackId} recording or overdubbing before loading project memory.`);
    return { projectContentRevision: status.projectContentRevision!, sampleRate: status.sampleRate };
  }

  public captureProjectTransportMutationRevision(): number {
    const revision = Transport.getInstance().projectMutationRevision;
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Native project load cannot safely track more transport changes in this session; restart the Native audio engine before loading project memory.');
    }
    return revision;
  }

  public async restoreProjectArchive(
    project: ProjectArchive,
    archive: ArrayBuffer | Uint8Array,
    operationStart: NativeProjectRestoreToken,
    operationStillCurrent: () => boolean,
  ): Promise<void> {
    const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
    if (bytes.byteLength < 12 || bytes.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new Error('Project archive is empty or exceeds the supported Native import size');
    }
    if (!this.latestStatus?.engineRunning) {
      throw new Error('Start the Native audio engine before importing project memory');
    }
    if (!Number.isFinite(project.bpm) || project.bpm < 40 || project.bpm > 300) {
      throw new Error('Project BPM must be between 40 and 300');
    }
    const saved = project.transport;
    const master = saved.masterTrackId === null ? null : project.tracks[saved.masterTrackId - 1];
    if (!Number.isInteger(saved.timeSignatureNumerator) || saved.timeSignatureNumerator < 1 || saved.timeSignatureNumerator > 32 ||
        ![1, 2, 4, 8, 16, 32].includes(saved.timeSignatureDenominator) ||
        !Number.isFinite(saved.measureLengthSeconds) || saved.measureLengthSeconds < 0 ||
        !Number.isSafeInteger(saved.masterLoopLengthSamples) || saved.masterLoopLengthSamples < 0 ||
        (saved.masterTrackId !== null && (!Number.isInteger(saved.masterTrackId) || saved.masterTrackId < 1 || saved.masterTrackId > 5 ||
          !master || master.frameCount !== saved.masterLoopLengthSamples)) ||
        (saved.masterTrackId === null && (saved.masterLoopLengthSamples !== 0 || saved.measureLengthSeconds !== 0))) {
      throw new Error('Project transport metadata does not match its imported loops');
    }
    if (saved.masterTrackId !== null) {
      const quarterNotesPerMeasure = saved.timeSignatureNumerator * 4 / saved.timeSignatureDenominator;
      const expectedMeasureLength = quarterNotesPerMeasure * 60 / project.bpm;
      if (Math.abs(saved.measureLengthSeconds - expectedMeasureLength) > Math.max(1e-9, expectedMeasureLength * 1e-9)) {
        throw new Error('Project master measure timing is inconsistent with its BPM and time signature');
      }
    }

    if (!operationStillCurrent()) {
      throw new Error('Native project load was canceled because the user changed transport before the host import was submitted; the existing project remains loaded. Retry the load.');
    }
    const generation = await this.bridge.beginProjectArchiveImport(bytes, operationStart.projectContentRevision);
    this.pendingProjectImportSync.set(generation, {
      bpm: project.bpm,
      transport: saved,
      operationStartTransport: operationStart.transport,
      operationStartTransportRevision: operationStart.projectTransportMutationRevision,
    });
    const status = await this.bridge.waitForProjectArchiveImport(generation, 10_000, operationStillCurrent);
    if (status.state !== 'committed') {
      this.pendingProjectImportSync.delete(generation);
      throw new Error(status.error || `Native project import generation ${generation} was cancelled; the previous project remains loaded`);
    }

    await this.synchronizeCommittedProjectArchive(generation);
  }

  /** Reconcile a previously accepted generation without uploading/mutating again. */
  public async getProjectArchiveImportStatus(generation: number): Promise<NativeProjectImportStatus> {
    const status = await this.bridge.getProjectArchiveImportStatus(generation);
    if (status.state === 'committed') await this.synchronizeCommittedProjectArchive(generation);
    else if (status.state === 'cancelled') this.pendingProjectImportSync.delete(generation);
    return status;
  }

  private async synchronizeCommittedProjectArchive(generation: number): Promise<void> {
    const savedProject = this.pendingProjectImportSync.get(generation);
    if (!savedProject) return;
    const { bpm, transport: saved, operationStartTransport, operationStartTransportRevision } = savedProject;
    // The five PCM banks are already atomically committed at this point.
    // Keep that fact explicit if a UI listener or transport sync rejects.
    try {
      const transport = Transport.getInstance();
      if (!this.matchesProjectRestoreTransport(operationStartTransport, operationStartTransportRevision)) {
        // PCM has crossed the host callback commit point. Do not roll back or
        // overwrite user transport edits made while the generation was
        // pending; keep the generation's committed status explicit instead.
        this.pendingProjectImportSync.delete(generation);
        throw new Error('Transport changed while the Native import was pending. The new PCM is committed, and the user\'s newer transport values were preserved; the imported BPM and loop metadata were not applied.');
      }
      const syncFailures: string[] = [];
      try { transport.stop(); } catch (error) { syncFailures.push(error instanceof Error ? error.message : String(error)); }
      transport.resetMasterTrack();
      transport.timeSignature = [saved.timeSignatureNumerator, saved.timeSignatureDenominator];
      transport.masterTrackId = saved.masterTrackId;
      transport.measureLength = saved.measureLengthSeconds;
      transport.masterLoopLengthSamples = saved.masterLoopLengthSamples;
      this.syncingNativeRhythmBpm = true;
      try { transport.setBpm(bpm); }
      catch (error) { syncFailures.push(error instanceof Error ? error.message : String(error)); }
      finally { this.syncingNativeRhythmBpm = false; }

      if (this.rhythmEngine.available && this.rhythmEngine.settings?.bpm !== bpm) {
        if (!await this.rhythmEngine.setBpm(bpm)) {
          syncFailures.push(this.rhythmEngine.error || 'Native rhythm did not acknowledge the imported project BPM');
        }
      }
      try { this.applyStatus(await this.bridge.getStatus()); }
      catch (error) { syncFailures.push(error instanceof Error ? error.message : String(error)); }
      if (syncFailures.length > 0) throw new Error(syncFailures.join('; '));
      this.pendingProjectImportSync.delete(generation);
    } catch (error) {
      const preserveUserTransport = !this.matchesProjectRestoreTransport(operationStartTransport, operationStartTransportRevision);
      try { this.applyStatus(await this.bridge.getStatus(), !preserveUserTransport); } catch { /* The committed-generation error remains primary. */ }
      throw new NativeProjectArchiveCommittedError(generation, error);
    }
  }

  private matchesProjectRestoreTransport(
    expected: NativeProjectRestoreToken['transport'],
    expectedRevision?: number,
  ): boolean {
    const current = Transport.getInstance();
    return (expectedRevision === undefined || current.projectMutationRevision === expectedRevision)
      && current.bpm === expected.bpm
      && current.state === expected.state
      && current.masterTrackId === expected.masterTrackId
      && current.measureLength === expected.measureLengthSeconds
      && current.masterLoopLengthSamples === expected.masterLoopLengthSamples
      && current.timeSignature[0] === expected.timeSignatureNumerator
      && current.timeSignature[1] === expected.timeSignatureDenominator;
  }

  public getRecordPlaySettings(): RecordPlaySettings {
    return Object.freeze({ available: false, reason: 'Native does not expose record action or measure recording quantization', recAction: null, quantize: null, autoRecAvailable: false, bounceAvailable: false });
  }
  public setRecordPlaySettings(_patch: RecordPlaySettingsPatch): never { throw new Error(this.getRecordPlaySettings().reason); }
  public getMixerState(): MixerState { return mixerState(this.latestStatus?.mixerLevels); }

  public async setMixerLevel(channel: MixerChannel, percent: number): Promise<void> {
    assertMixerLevel(percent);
    if (!this.getMixerState().available) throw new Error(this.getMixerState().reason);
    await this.dispatchStatusRequest(() => this.bridge.setMixerLevel(mixerChannelIndex(channel), percent));
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

  public async undoTrack(trackId = 1) {
    await this.dispatchHistoryStatusRequest(() => this.bridge.undoTrack(trackId));
  }

  public async redoTrack(trackId = 1) {
    await this.dispatchHistoryStatusRequest(() => this.bridge.redoTrack(trackId));
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
    if (state.type !== nextType) {
      state.parameters = {};
      const key = this.nativeCatalogSlotKey(location, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId);
      this.nativeCatalogFxHydratedSlots.delete(key);
      this.nativeCatalogFxUnknownParameterSlots.delete(key);
    }
    state.type = nextType;
    this.nativeCatalogSlotEdited(location, slotIndex, trackId);
  }

  public setFxParam(location: NativeFxPath, slotIndex: number, value: number, trackId = 0) {
    const state = this.nativeCatalogStates(location, trackId)[slotIndex];
    if (!state || !Number.isFinite(value)) return;
    state.value = Math.max(0, Math.min(100, value));
    this.nativeCatalogFxUnknownParameterSlots.delete(this.nativeCatalogSlotKey(location, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId));
    if (this.nativeCatalogFxHydratedSlots.has(this.nativeCatalogSlotKey(location, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId))) {
      const macro = state.type === 'STEP SLICER'
        ? this.nativeStepSlicerBridgeParameters(location, slotIndex, trackId)
        : nativeCatalogMacroParameters(state.type, state.value);
      state.parameters = { ...state.parameters, ...macro };
    }
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
    const state = this.nativeCatalogStates('track', trackId)[slotIndex]!;
    if (!this.areOfficialCatalogParametersSupported(state.type, 'track', trackId, parameters, slotIndex)) return false;
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

  public getTrackFxApply(trackId?: number): TrackFxApplyStatus[] {
    if (trackId !== undefined && (!Number.isInteger(trackId) || trackId < 1 || trackId > 5)) return [];
    const requestedTracks = trackId === undefined ? [1, 2, 3, 4, 5] : [trackId];
    const advertised = this.latestStatus?.nativeFx?.trackFxApplyAvailable === true;
    return requestedTracks.map((id) => {
      const runtime = this.latestStatus?.nativeFx?.trackFxApply?.find((item) => item.trackId === id);
      const available = advertised && runtime !== undefined && this.isNativeTrackAvailable(id);
      const requestedRevision = runtime?.requestedRevision ?? 0;
      const appliedRevision = runtime?.appliedRevision ?? 0;
      const requested = available ? runtime!.requested : false;
      const applied = available ? runtime!.applied : false;
      const pending = available && appliedRevision < requestedRevision;
      return {
        trackId: id,
        available,
        requested,
        applied,
        requestedRevision,
        appliedRevision,
        semanticRevision: runtime?.semanticRevision ?? 0,
        inputAppliedRevision: appliedRevision,
        trackAppliedRevision: appliedRevision,
        pending,
        controlFaulted: available && runtime!.controlFaulted,
        peak: available ? runtime!.peak : 0,
        rms: available ? runtime!.rms : 0,
        error: !available ? 'Native host does not expose callback-acknowledged per-track shared Track FX routing.'
          : runtime!.controlFaulted ? 'Native callback rejected the requested shared Track FX route.' : '',
      };
    });
  }

  public async setTrackFxApply(trackId: number, enabled: boolean): Promise<TrackFxApplyStatus> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      throw new RangeError('Native Track FX apply requires a track ID between 1 and 5.');
    }
    if (typeof enabled !== 'boolean') throw new TypeError('Native Track FX apply must be a boolean.');
    const current = this.getTrackFxApply(trackId)[0];
    if (!current?.available) throw new Error(current?.error || 'Native per-track shared Track FX routing is unavailable.');
    try {
      const status = await this.bridge.setTrackFxApply(trackId, enabled);
      this.applyStatus(status);
      const applied = this.getTrackFxApply(trackId)[0]!;
      if (applied.applied !== enabled || applied.appliedRevision < applied.requestedRevision || applied.pending || applied.controlFaulted) {
        throw new NativeTrackFxApplyAcknowledgementError(
          `Native callback did not leave Track ${trackId} shared Track FX at the requested state.`, status,
        );
      }
      return applied;
    } catch (error) {
      if (error instanceof NativeBridgeRequestTimeoutError) {
        if (error.reconciledStatus) this.applyStatus(error.reconciledStatus);
      } else if (error instanceof NativeTrackFxApplyAcknowledgementError && error.reconciledStatus) {
        this.applyStatus(error.reconciledStatus);
      }
      throw error;
    }
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
    const key = this.nativeCatalogSlotKey(path, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId);
    if (this.nativeCatalogFxHydratedSlots.has(key)) {
      const state = this.nativeCatalogStates(path, trackId)[slotIndex]!;
      // The typed sequence editor owns these fields even when the slot was
      // hydrated from Native. Keep unrelated host-authored fields intact.
      state.parameters = { ...state.parameters, ...this.nativeStepSlicerBridgeParameters(path, slotIndex, trackId) };
    }
    this.nativeCatalogSlotEdited(path, slotIndex, trackId);
  }

  /** Stores per-slot named controls; caller supplies a complete current parameter set. */
  public setCatalogFxParameters(path: NativeFxPath, slotIndex: number, parameters: Record<string, number>, trackId = 0) {
    const state = this.nativeCatalogStates(path, trackId)[slotIndex];
    if (!state || !this.isValidCatalogParameters(parameters) || !this.areOfficialCatalogParametersSupported(state.type, path, trackId, parameters, slotIndex)) return;
    state.parameters = { ...parameters };
    this.nativeCatalogFxUnknownParameterSlots.delete(this.nativeCatalogSlotKey(path, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId));
    this.nativeCatalogSlotEdited(path, slotIndex, trackId);
  }

  private areOfficialCatalogParametersSupported(type: string, path: NativeFxPath, trackId: number, parameters: Record<string, number>, slotIndex = 0): boolean {
    const entries = Object.entries(parameters).filter(([key]) => key.startsWith('official_'));
    if (!entries.length) return true;
    const schema = this.getCatalogFxParameterSchema(type, path, trackId, parameters, slotIndex);
    const official = resolveOfficialEffect(type, parameters);
    return entries.every(([key, value]) => {
      if (key === 'official_variant') return (value === 1 || value === 2) && !!schema?.parameters.some(item => item.id === key && item.provenance === 'routing');
      const parameter = findOfficialRuntimeParameter(official, key);
      const descriptor = schema?.parameters.find(item => item.id === key && item.provenance === 'official-interface');
      // A host may implement a strict subset of the documented domain, such as
      // track carriers without physical inputs. Never accept the wider manual
      // range merely because the parameter name is advertised.
      return !!parameter && !!descriptor && isOfficialRuntimeValueValid(parameter, value) &&
        value >= descriptor.minimum && value <= descriptor.maximum &&
        (!descriptor.discrete || descriptor.discreteValues?.includes(value) === true);
    });
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

  /** Returns validated host-authored bounds/choices; null means an old/invalid schema. */
  public getCatalogFxParameterSchema(type: string, path: NativeFxPath, trackId = 0, currentParameters: Record<string, number> = {}, slotIndex = 0): NativeFxParameterSchema | null {
    assertNativeFxTarget(path, trackId);
    const effectId = nativeCatalogEffectId(type);
    const nativeFx = this.latestStatus?.nativeFx;
    if (!effectId || nativeFx?.parameterSchemaVersion !== 1) return null;
    const entry = nativeFx.catalogEffectAvailability?.find((item) => item.effectId === effectId);
    if (!entry || entry[path] !== true || (trackId !== 0 && entry.perTrackInsert === false)) {
      return { version: 1, parameters: [], legacyAliases: [] };
    }
    const readList = (items: NativeFxParameterDescriptor[] | undefined): NativeFxParameterDescriptor[] | null => {
      if (!Array.isArray(items)) return null;
      // Some Native adapters expose descriptors through float32 storage. Turn
      // those exact float32 encodings back into their shortest practical
      // decimal values so range controls do not submit e.g. 2.50000000074506
      // for a user-selected 2.5 step. Preserve genuine JS/double precision.
      const normalizeDescriptorNumber = (value: number) => {
        const float32 = Math.fround(value);
        return float32 === value ? Number(value.toPrecision(7)) : value;
      };
      const output: NativeFxParameterDescriptor[] = [];
      const ids = new Set<string>();
      for (const item of items) {
        if (item?.id?.startsWith('official_') && !isOfficialFxSlotAllowed(type, path, slotIndex)) continue;
        if (!item || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id) ||
            typeof item.label !== 'string' || !Number.isFinite(item.minimum) || !Number.isFinite(item.maximum) ||
            item.minimum > item.maximum || !Number.isFinite(item.defaultValue) ||
            item.defaultValue < item.minimum || item.defaultValue > item.maximum ||
            !Number.isFinite(item.smoothingMs) || item.smoothingMs < 0 || typeof item.discrete !== 'boolean') return null;
        const discreteValues = item.discreteValues;
        if (item.discrete && (!Array.isArray(discreteValues) || discreteValues.length === 0 ||
            discreteValues.some((value) => !Number.isFinite(value) || value < item.minimum || value > item.maximum) ||
            !discreteValues.includes(item.defaultValue))) return null;
        if (!item.discrete && discreteValues !== undefined) return null;
        ids.add(item.id);
        const minimum = normalizeDescriptorNumber(item.minimum);
        const maximum = normalizeDescriptorNumber(item.maximum);
        const defaultValue = normalizeDescriptorNumber(item.defaultValue);
        const smoothingMs = normalizeDescriptorNumber(item.smoothingMs);
        const normalizedDiscreteValues = item.discrete ? discreteValues!.map(normalizeDescriptorNumber) : undefined;
        if (minimum > maximum || defaultValue < minimum || defaultValue > maximum ||
            (item.discrete && (!normalizedDiscreteValues || !normalizedDiscreteValues.includes(defaultValue) ||
              normalizedDiscreteValues.some((value) => value < minimum || value > maximum)))) return null;
        output.push({
          id: item.id, label: item.label, minimum, maximum,
          defaultValue, smoothingMs, discrete: item.discrete,
          ...(item.discrete ? { discreteValues: normalizedDiscreteValues } : {}),
          ...(item.legacyAlias === true ? { legacyAlias: true } : {}),
          ...((item.semanticSupport === 'partial_live_stream' || item.semanticSupport === 'partial_source_modes') ? { semanticSupport: item.semanticSupport, limitation: typeof item.limitation === 'string' ? item.limitation : (item.semanticSupport === 'partial_source_modes' ? 'Source-aware loop playback only; recording/overdub modes are not supported.' : 'Partial live-history implementation; not source-aware transport.') } : {}),
        });
      }
      return output;
    };
    const parameters = readList(entry.parameters);
    const legacyAliases = readList(entry.legacyParameterAliases);
    if (!parameters || !legacyAliases) return null;
    const officialParameters = entry.officialParameters === undefined ? [] : readList(entry.officialParameters);
    if (!officialParameters) return null;
    const officialEffect = resolveOfficialEffect(type, currentParameters);
    for (const parameter of parameters) parameter.provenance = 'extension';
    const enrichedOfficial = officialParameters.flatMap((descriptor): NativeFxParameterDescriptor[] => {
      if (descriptor.id === 'official_variant' && ['TAPE ECHO', 'ROLL'].includes(type)) return [{ ...descriptor, label: 'Algorithm variant', provenance: 'routing', options: [{ value: 1, label: `${type} 1` }, { value: 2, label: `${type} 2` }] }];
      const parameter = findOfficialRuntimeParameter(officialEffect, descriptor.id);
      if (!parameter) return []; // never present private adapter state as a hardware control
      const domain = officialParameterDomain(parameter);
      const bounds = domain.options.map(option => option.runtime);
      if (domain.range) bounds.push(domain.range.min, domain.range.max);
      if (!bounds.length) return [];
      const minimum = Math.max(descriptor.minimum, Math.min(...bounds));
      const maximum = Math.min(descriptor.maximum, Math.max(...bounds));
      if (minimum > maximum) return [];
      const documentedDefault = parameter.default === null ? null : encodeOfficialValue(parameter, parameter.default);
      return [{ ...descriptor, minimum, maximum, ...(descriptor.discrete ? { discreteValues: descriptor.discreteValues?.filter(value => value >= minimum && value <= maximum && isOfficialRuntimeValueValid(parameter, value)) } : {}), step: domain.range?.step ?? 1,
        defaultValue: documentedDefault !== null && documentedDefault >= minimum && documentedDefault <= maximum ? documentedDefault : Math.min(maximum, Math.max(minimum, descriptor.defaultValue)), label: /^official_step_level_\d+$/.test(descriptor.id) ? `${parameter.name} ${descriptor.id.replace('official_step_level_', '')}` : parameter.name, provenance: 'official-interface', unit: domain.unit,
        sourcePage: officialEffect!.page, officialEffectName: officialEffect!.name,
        documentedDefault: parameter.default === null ? null : encodeOfficialValue(parameter, parameter.default),
        options: domain.options.map(option => ({ value: option.runtime, label: option.label })) }];
    });
    return { version: 1, parameters: [...enrichedOfficial, ...parameters], legacyAliases };
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

  /** Canonical submission snapshot, including typed STEP SLICER state. Does not mutate or send. */
  public getCatalogFxParameterSnapshot(path: NativeFxPath, slotIndex: number, trackId = 0, overrides?: Record<string, number>): Record<string, number> | null {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= NATIVE_FX_SLOT_IDS.length) return null;
    if (!this.nativeCatalogStates(path, trackId)[slotIndex]?.type) return null;
    const desired = this.nativeCatalogParameters(path, slotIndex, trackId, overrides);
    // The UI submits named edits as a complete authored snapshot. After an
    // explicit restart the local override map may be empty while the host
    // retains macro controls. Preserve that confirmed baseline when composing
    // an edit; explicit reset/removal remains the caller's separate intent.
    const reported = overrides === undefined ? undefined
      : this.nativeCatalogSlotFromStatus(path, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId);
    const baseline = reported?.effectId === nativeCatalogEffectId(this.nativeCatalogStates(path, trackId)[slotIndex]!.type)
      ? reported?.parameters : undefined;
    return { ...baseline, ...desired };
  }

  private nativeCatalogParameters(path: NativeFxPath, slotIndex: number, trackId: number, overrides?: Record<string, number>): Record<string, number> {
    const state = this.nativeCatalogStates(path, trackId)[slotIndex]!;
    const key = this.nativeCatalogSlotKey(path, NATIVE_FX_SLOT_IDS[slotIndex]!, trackId);
    if (this.nativeCatalogFxUnknownParameterSlots?.has(key)) return { ...(overrides ?? {}) };
    if (this.nativeCatalogFxHydratedSlots?.has(key)) {
      return { ...state.parameters, ...(overrides ?? {}) };
    }
    const parameters = state.type === 'STEP SLICER'
      ? { ...this.nativeStepSlicerBridgeParameters(path, slotIndex, trackId), ...(overrides ?? state.parameters) }
      : state.type ? { ...nativeCatalogMacroParameters(state.type, state.value), ...(overrides ?? state.parameters) } : {};
    if (Object.keys(parameters).some(key => key.startsWith('official_'))) {
      const effectId = nativeCatalogEffectId(state.type);
      const advertised = this.latestStatus?.nativeFx?.catalogEffectAvailability?.find(entry => entry.effectId === effectId)?.officialParameters;
      if (advertised?.length) {
        const tempo = Transport.getInstance().bpm;
        parameters.official_bpm = Number.isFinite(tempo) ? Math.max(40, Math.min(300, tempo)) : 120;
        parameters.official_quarter_notes_per_measure = Transport.getInstance().quarterNotesPerMeasure;
      }
    }
    return parameters;
  }

  private nativeCatalogSlotEdited(path: NativeFxPath, slotIndex: number, trackId: number) {
    if (trackId) this.nativePerTrackFxEdited.add(trackId);
    const slot = NATIVE_FX_SLOT_IDS[slotIndex]!;
    const key = this.nativeCatalogSlotKey(path, slot, trackId);
    this.nativeCatalogFxDirtySlots.add(key);
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
      const status = await this.bridge.getStatus();
      this.applyStatus(status);
      this.hydrateNativeCatalogFromStatus(status);
      if (status.engineRunning) {
        // Connecting to an already-running host is observational: applying a
        // device config here can reopen WASAPI, interrupt transport and make
        // otherwise valid live FX writes return HTTP 409.
        await this.syncNativeFxCatalogSlots(false);
      } else {
        await this.applyAndStart();
      }
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

  private hydrateNativeCatalogFromStatus(status: NativeStatus) {
    const targets: Array<{ path: NativeFxPath; trackId: number }> = [
      { path: 'input', trackId: 0 }, { path: 'track', trackId: 0 },
      ...[1, 2, 3, 4, 5].map((trackId) => ({ path: 'track' as const, trackId })),
    ];
    for (const { path, trackId } of targets) {
      for (let slotIndex = 0; slotIndex < NATIVE_FX_SLOT_IDS.length; slotIndex += 1) {
        const slot = NATIVE_FX_SLOT_IDS[slotIndex]!;
        const key = this.nativeCatalogSlotKey(path, slot, trackId);
        if (this.nativeCatalogFxDirtySlots.has(key)) continue;
        const reported = trackId
          ? status.nativeFx?.perTrackCatalogBanks?.find((bank) => bank.trackId === trackId)?.slots.find((item) => item.slot === slot)
          : path === 'input' ? status.nativeFx?.inputCatalogSlots?.find((item) => item.slot === slot)
            : status.nativeFx?.catalogSlots?.find((item) => item.slot === slot);
        if (!reported) continue;
        const effectId = reported.effectId || '';
        const type = effectId ? (NATIVE_CATALOG_FX_LABELS[effectId] ?? '') : '';
        const previous = this.nativeCatalogFxRuntime.get(key);
        const runtime: NativeCatalogFxSlotRuntime = previous ? { ...previous } : {
          path, slot, trackId, requestedBypassed: reported.bypassed, appliedBypassed: null,
          prepared: null, processingFaulted: false, controlFaulted: false, pendingApply: false,
          requestedRevision: null, appliedRevision: null, requestedEffectId: effectId || null,
          acknowledgedEffectId: effectId || null, requestedParameters: {}, acknowledgedParameters: null,
          acknowledged: false, pendingRestart: false, error: '',
        };
        if (effectId && !type) {
          runtime.requestedEffectId = effectId;
          runtime.acknowledgedEffectId = effectId;
          runtime.acknowledged = false;
          runtime.pendingApply = false;
          runtime.error = `Native host effect “${effectId}” is not mapped by this frontend; its slot was preserved without a write.`;
          this.nativeCatalogFxRuntime.set(key, runtime);
          continue;
        }

        const state = this.nativeCatalogStates(path, trackId)[slotIndex]!;
        const parameters = reported.parameters && typeof reported.parameters === 'object'
          ? { ...reported.parameters } : {};
        state.type = type;
        state.active = Boolean(type) && !reported.bypassed;
        state.parameters = parameters;
        state.value = this.nativeCatalogMacroValue(type, parameters, state.value);
        if (reported.parameters && typeof reported.parameters === 'object') {
          this.nativeCatalogFxHydratedSlots.add(key);
          this.nativeCatalogFxUnknownParameterSlots.delete(key);
        } else {
          this.nativeCatalogFxHydratedSlots.delete(key);
          if (effectId) this.nativeCatalogFxUnknownParameterSlots.add(key);
          else this.nativeCatalogFxUnknownParameterSlots.delete(key);
        }
        runtime.requestedEffectId = effectId || null;
        runtime.requestedParameters = { ...parameters };
        runtime.requestedBypassed = Boolean(type) && reported.bypassed;
        runtime.requestedRevision = reported.requestedRevision ?? null;
        runtime.baselineRequestedRevision = reported.requestedRevision ?? null;
        runtime.acknowledged = false;
        runtime.pendingApply = false;
        runtime.pendingRestart = false;
        runtime.outcomeUnknown = false;
        runtime.error = '';
        this.reconcileNativeCatalogRuntime(runtime);
        this.nativeCatalogFxRuntime.set(key, runtime);
      }
    }
  }

  private nativeCatalogMacroValue(type: string, parameters: Record<string, number>, fallback: number) {
    const macroParameter = nativeCatalogEffectId(type) === 'phaser' || nativeCatalogEffectId(type) === 'flanger'
      ? parameters.depth
      : nativeCatalogEffectId(type) === 'dist' ? parameters.mix_percent
        : parameters.mix ?? parameters.wet_mix;
    return Number.isFinite(macroParameter) ? Math.max(0, Math.min(100, macroParameter! <= 1 ? macroParameter! * 100 : macroParameter!)) : fallback;
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

  private async dispatchHistoryStatusRequest(request: () => Promise<NativeStatus>) {
    try {
      const status = await request();
      this.applyStatus(status);
    } catch (error) {
      // Undo/redo may be rejected because there is no history step, the track
      // is active, or the retained-byte budget was exceeded. Keep the last
      // acknowledged Native status and history controls while surfacing the
      // error; a command rejection is not evidence that the bridge disappeared.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitAll();
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
          ...(this.latestStatus?.nativeFx?.catalogParameterReplacement === true && !this.nativeCatalogFxUnknownParameterSlots.has(this.nativeCatalogSlotKey(path, slot, trackId)) ? { replaceParameters: true } : {}),
        };
        const requestedId = config?.effectId || null;
        const currentId = this.nativeCatalogEffectIdFromStatus(path, slot, trackId);
        const key = this.nativeCatalogSlotKey(path, slot, trackId);
        const options = this.getCatalogFxOptions(path, trackId);
        const editRevision = this.nativeCatalogSlotEditRevisions.get(key) ?? 0;
        const isDirty = this.nativeCatalogFxDirtySlots.has(key);
        const previousRuntime = this.nativeCatalogFxRuntime.get(key);
        const reportedBeforeWrite = this.nativeCatalogSlotFromStatus(path, slot, trackId);
        let statusToApplyAfterSave: NativeStatus | null = null;
        if (!isDirty && (!allowTypeChange || !this.nativeCatalogFxHydratedSlots.has(key))) {
          // A connection must never turn frontend constructor defaults into
          // writes. Only explicit edits, or a previously hydrated bank being
          // restored after an intentional stopped reconfiguration, are eligible.
          continue;
        }
        if (isDirty && previousRuntime?.outcomeUnknown) {
          const runtime = { ...previousRuntime };
          this.reconcileNativeCatalogRuntime(runtime);
          if (runtime.acknowledged && (this.nativeCatalogSlotEditRevisions.get(key) ?? 0) === editRevision) {
            this.nativeCatalogFxDirtySlots.delete(key);
            this.nativeCatalogFxSubmittedEditRevisions.delete(key);
            this.nativeCatalogFxHydratedSlots.add(key);
            this.nativeCatalogFxUnknownParameterSlots.delete(key);
          }
          this.nativeCatalogFxRuntime.set(key, runtime);
          this.emitAll();
          // A timed-out POST is never replayed automatically. Keep the desired
          // state pending until status uniquely identifies its callback ACK.
          continue;
        }
        if (config && reportedBeforeWrite && this.nativeCatalogReadbackMatchesConfig(config, reportedBeforeWrite)) {
          const runtime: NativeCatalogFxSlotRuntime = previousRuntime ? { ...previousRuntime } : {
            path, slot, trackId, requestedEffectId: requestedId, acknowledgedEffectId: currentId,
            requestedParameters: {}, acknowledgedParameters: null, requestedBypassed: config.bypassed,
            appliedBypassed: null, prepared: null, processingFaulted: false, controlFaulted: false,
            pendingApply: false, requestedRevision: null, appliedRevision: null,
            acknowledged: false, pendingRestart: false, error: '',
          };
          runtime.requestedEffectId = requestedId;
          runtime.requestedParameters = { ...(config.parameters ?? {}) };
          runtime.requestedBypassed = config.bypassed;
          runtime.requestedRevision = reportedBeforeWrite.requestedRevision ?? null;
          runtime.baselineRequestedRevision = reportedBeforeWrite.requestedRevision ?? null;
          runtime.outcomeUnknown = false;
          runtime.error = '';
          this.reconcileNativeCatalogRuntime(runtime);
          if (runtime.acknowledged && (this.nativeCatalogSlotEditRevisions.get(key) ?? 0) === editRevision) {
            this.nativeCatalogFxDirtySlots.delete(key);
            this.nativeCatalogFxSubmittedEditRevisions.delete(key);
            this.nativeCatalogFxHydratedSlots.add(key);
          }
          this.nativeCatalogFxRuntime.set(key, runtime);
          this.emitAll();
          continue;
        }
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
        runtime.outcomeUnknown = false;
        runtime.baselineRequestedRevision = reportedBeforeWrite?.requestedRevision ?? null;

        if (trackId && !this.isPerTrackCatalogAvailable(trackId)) {
          runtime.acknowledged = false;
          runtime.error = 'Native per-track catalog FX is unavailable in this bridge status.';
        } else if (!config || (requestedId && !options.includes(state.type))) {
          const error = config
            ? `Native ${path} catalog does not support ${state.type}.`
            : `Native catalog selection “${state.type}” has no implemented effect ID.`;
          await this.rejectUnsupportedCatalogSelection(path, slot, currentId, allowTypeChange, runtime, error, trackId);
        } else if (this.latestStatus?.nativeFx?.catalogParameterReplacement !== true &&
            [config.parameters, requestedId === currentId ? previousRuntime?.acknowledgedParameters : undefined].some(parameters =>
              Object.keys(parameters ?? {}).some(key => key.startsWith('official_')))) {
          // Old patch-only hosts cannot truthfully acknowledge removed official
          // fields or leaving official mode. Keep their legacy-only path intact.
          runtime.acknowledged = false;
          runtime.error = 'Native host lacks safe official parameter replacement; update the Native host before applying these controls.';
        } else if (this.engineRunning && !allowTypeChange && requestedId !== currentId) {
          runtime.acknowledgedEffectId = currentId;
          runtime.acknowledged = false;
          runtime.pendingRestart = true;
          runtime.error = 'Effect type changes are saved and apply after restarting Native audio; the running engine rejects live slot replacement.';
        } else if (requestedId === currentId && !requestedId) {
          // An empty selection is acknowledged only by a matching host snapshot;
          // do not issue an empty-slot write during live reconnect.
          runtime.requestedRevision = reportedBeforeWrite?.requestedRevision ?? null;
          runtime.error = 'Native host did not provide a complete readback for the empty FX slot.';
        } else {
          try {
            this.nativeCatalogFxSubmittedEditRevisions.set(key, editRevision);
            const status = await this.bridge.setCatalogSlot(config);
            this.applyStatus(status);
            const reported = this.nativeCatalogSlotFromStatus(path, slot, trackId);
            if (this.nativeCatalogFxUnknownParameterSlots.has(key) && reported?.parameters &&
                reported.effectId === requestedId && reported.bypassed === config.bypassed &&
                Object.keys(config.parameters ?? {}).length === 0 && !config.replaceParameters) {
              // Legacy host had no parameter snapshot before this bypass-only
              // patch. Adopt the returned authored set rather than inventing
              // macro defaults or claiming an empty replacement.
              runtime.requestedParameters = { ...reported.parameters };
              this.nativeCatalogStates(path, trackId)[slotIndex]!.parameters = { ...reported.parameters };
            }
            runtime.requestedRevision = reported?.requestedRevision ?? null;
            this.reconcileNativeCatalogRuntime(runtime);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            runtime.acknowledgedEffectId = currentId;
            runtime.acknowledged = false;
            runtime.pendingRestart = /stop native audio|live parameter edits require/i.test(message);
            if (error instanceof NativeBridgeRequestTimeoutError) {
              // Never resend a possibly accepted Native write. Keep its
              // outcome explicitly indeterminate until a later status read
              // reports a revision beyond the pre-request baseline.
              runtime.outcomeUnknown = true;
              runtime.pendingApply = true;
              runtime.error = `Native catalog FX write timed out; outcome unknown. Checking host revision. ${message}`;
              if (error.reconciledStatus) {
                const reported = trackId
                  ? error.reconciledStatus.nativeFx?.perTrackCatalogBanks?.find((bank) => bank.trackId === trackId)?.slots.find((item) => item.slot === slot)
                  : path === 'input' ? error.reconciledStatus.nativeFx?.inputCatalogSlots?.find((item) => item.slot === slot)
                    : error.reconciledStatus.nativeFx?.catalogSlots?.find((item) => item.slot === slot);
                runtime.requestedRevision = reported?.requestedRevision ?? null;
                statusToApplyAfterSave = error.reconciledStatus;
              } else {
                void this.refreshStatus();
              }
            } else {
              runtime.error = message;
            }
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
        if (runtime.acknowledged && (this.nativeCatalogSlotEditRevisions.get(key) ?? 0) === editRevision) {
          this.nativeCatalogFxDirtySlots.delete(key);
          this.nativeCatalogFxSubmittedEditRevisions.delete(key);
          this.nativeCatalogFxHydratedSlots.add(key);
          this.nativeCatalogFxUnknownParameterSlots.delete(key);
        }
        this.nativeCatalogFxRuntime.set(key, runtime);
        this.emitAll();
        if (statusToApplyAfterSave) {
          const status = statusToApplyAfterSave;
          statusToApplyAfterSave = null;
          this.applyStatus(status);
        }
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

  private nativeCatalogParametersMatch(expected: Record<string, number>, actual: Record<string, number> | undefined) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const comparable = (values: Record<string, number>) => Object.fromEntries(
      Object.entries(values)
        // Tempo/meter are derived from the live transport and intentionally not
        // retained in the host's authored FX snapshot.
        .filter(([key]) => key !== 'official_bpm' && key !== 'official_quarter_notes_per_measure')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Math.fround(value)]),
    );
    return JSON.stringify(comparable(expected)) === JSON.stringify(comparable(actual));
  }

  private nativeCatalogReadbackMatchesConfig(
    config: NativeCatalogSlotConfig,
    reported: Pick<NativeCatalogSlotStatus, 'slot' | 'effectId' | 'bypassed'> & Partial<NativeCatalogSlotStatus>,
  ) {
    if (reported.effectId !== config.effectId || reported.bypassed !== config.bypassed ||
        reported.appliedBypassed !== config.bypassed || reported.processingFaulted || reported.controlFaulted ||
        (config.effectId !== '' && reported.prepared !== true) ||
        !Number.isSafeInteger(reported.requestedRevision) || reported.requestedRevision !== reported.appliedRevision) return false;
    return this.nativeCatalogParametersMatch(config.parameters ?? {}, reported.parameters);
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

  /** Confirm the complete host snapshot, including callback-applied revision and authored parameters. */
  private reconcileNativeCatalogRuntime(runtime: NativeCatalogFxSlotRuntime) {
    const reported = this.updateNativeCatalogTelemetry(runtime);
    runtime.acknowledged = false;
    runtime.pendingApply = false;
    if (runtime.outcomeUnknown) {
      const baseline = runtime.baselineRequestedRevision;
      const expectedRevision = baseline !== null && baseline !== undefined && Number.isSafeInteger(baseline)
        ? baseline + 1
        : null;
      const uniquelyMatchesRequest = expectedRevision !== null && Number.isSafeInteger(expectedRevision) &&
        reported?.requestedRevision === expectedRevision && reported.appliedRevision === expectedRevision &&
        reported.effectId === runtime.requestedEffectId && reported.bypassed === runtime.requestedBypassed &&
        reported.appliedBypassed === runtime.requestedBypassed &&
        (!runtime.requestedEffectId || reported.prepared === true) &&
        !reported.processingFaulted && !reported.controlFaulted &&
        this.nativeCatalogParametersMatch(runtime.requestedParameters, reported.parameters);
      if (!uniquelyMatchesRequest) {
        runtime.pendingApply = true;
        runtime.error = 'Native catalog FX write outcome is still unknown; host status does not confirm the exact slot revision, parameters and applied state.';
        return;
      }
      runtime.requestedRevision = reported?.requestedRevision ?? null;
      runtime.outcomeUnknown = false;
    }
    if (!reported || !Number.isSafeInteger(runtime.requestedRevision) || runtime.requestedRevision! < 0 ||
        !Number.isSafeInteger(reported.requestedRevision) || !Number.isSafeInteger(reported.appliedRevision) ||
        !reported.parameters || typeof reported.parameters !== 'object') {
      runtime.error = 'Native host status lacks the parameter and revision readback required to confirm this FX slot.';
    } else if (runtime.controlFaulted) {
      runtime.error = 'Native FX control application failed; reconfigure the slot to retry.';
    } else if (runtime.processingFaulted) {
      runtime.error = 'Native FX processor faulted; reconfigure the slot to retry.';
    } else if (runtime.acknowledgedEffectId !== runtime.requestedEffectId ||
        reported.bypassed !== runtime.requestedBypassed || reported.requestedRevision !== runtime.requestedRevision ||
        !this.nativeCatalogParametersMatch(runtime.requestedParameters, reported.parameters)) {
      runtime.error = 'Native returned an ACK for a different FX selection, bypass state, parameter snapshot or revision.';
    } else if ((runtime.appliedRevision ?? -1) < (runtime.requestedRevision ?? 0)) {
      runtime.pendingApply = true;
      runtime.error = 'Native accepted the FX request but its audio callback has not acknowledged the requested revision yet.';
    } else if (runtime.appliedRevision !== runtime.requestedRevision || runtime.appliedBypassed !== runtime.requestedBypassed) {
      runtime.error = 'Native audio callback applied a different FX bypass state or revision.';
    } else {
      runtime.acknowledged = !runtime.requestedEffectId || runtime.prepared === true;
      runtime.pendingApply = false;
      runtime.error = runtime.acknowledged ? '' : 'Native FX processor is not prepared for the requested configuration.';
      if (runtime.acknowledged) runtime.acknowledgedParameters = { ...reported.parameters };
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

  private applyStatus(status: NativeStatus, synchronizeRhythmBpm = true) {
    this.latestStatus = status;
    if (mixerState(status.mixerLevels).available) this.tracks.forEach((track, index) => { track.track.playLevel = status.mixerLevels![index + 2]!; });
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
    if (synchronizeRhythmBpm) this.syncNativeRhythmBpm();
    for (const runtime of this.nativeCatalogFxRuntime.values()) {
      if (runtime.pendingApply || runtime.acknowledged || runtime.outcomeUnknown) this.reconcileNativeCatalogRuntime(runtime);
      else this.updateNativeCatalogTelemetry(runtime);
      if (runtime.acknowledged) {
        const key = this.nativeCatalogSlotKey(runtime.path, runtime.slot, runtime.trackId);
        const submittedRevision = this.nativeCatalogFxSubmittedEditRevisions.get(key);
        const currentEditRevision = this.nativeCatalogSlotEditRevisions.get(key) ?? 0;
        if (this.nativeCatalogFxDirtySlots.has(key) && submittedRevision === currentEditRevision) {
          this.nativeCatalogFxDirtySlots.delete(key);
          this.nativeCatalogFxSubmittedEditRevisions.delete(key);
        }
        if (status.nativeFx) {
          const reported = this.nativeCatalogSlotFromStatus(runtime.path, runtime.slot, runtime.trackId);
          if (reported?.parameters && typeof reported.parameters === 'object') {
            this.nativeCatalogFxHydratedSlots.add(key);
            this.nativeCatalogFxUnknownParameterSlots.delete(key);
          }
        }
      }
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
