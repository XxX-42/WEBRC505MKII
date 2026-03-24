import { TrackState } from '../core/types';
import { NativeBridgeClient, type NativeBackend, type NativeConfig, type NativeDeviceCatalog, type NativeDeviceInfo, type NativeStatus } from './NativeBridgeClient';
import { NativeTrackProxy } from './NativeTrackProxy';

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

type RhythmPattern = 'ROCK' | 'TECHNO' | 'METRONOME';

class NativeRhythmStub {
  public start() { return; }
  public stop() { return; }
  public setPattern(_pattern: RhythmPattern) { return; }
  public setVolume(_volume: number) { return; }
}

const TRACK_STATE_VALUES = Object.values(TrackState);

export class NativeAudioEngine {
  private static instance: NativeAudioEngine;

  public readonly tracks: NativeTrackProxy[];
  public readonly rhythmEngine = new NativeRhythmStub();
  public readonly trackStates: Int32Array;
  public readonly trackPositions: Float32Array;
  public readonly sharedBuffer: SharedArrayBuffer;

  public selectedInputDeviceId: string | null = null;
  public selectedOutputDeviceId: string | null = null;
  public selectedBackend: NativeBackend = 'WASAPI';
  public selectedSampleRate = 48000;
  public selectedBufferFrames = 128;
  public monitoringEnabled = false;

  private readonly bridge = new NativeBridgeClient();
  private readonly monitoringListeners = new Set<(enabled: boolean) => void>();
  private readonly latencyListeners = new Set<(info: LatencyInfo) => void>();
  private readonly statusListeners = new Set<(status: NativeUiStatus) => void>();

  private deviceCatalog: NativeDeviceCatalog | null = null;
  private latestStatus: NativeStatus | null = null;
  private bridgeAvailable = false;
  private engineRunning = false;
  private initInFlight: Promise<void> | null = null;
  private pollHandle: number | null = null;
  private lastError = '';

  private constructor() {
    this.sharedBuffer = new SharedArrayBuffer(1024);
    this.trackStates = new Int32Array(this.sharedBuffer, 0, 5);
    this.trackPositions = new Float32Array(this.sharedBuffer, 20, 5);
    this.tracks = Array.from({ length: 5 }, (_, index) => new NativeTrackProxy(this, index + 1));
    this.resetAllTrackTelemetry();
    this.loadPreferences();
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
    this.selectedSampleRate = sampleRate;
    await this.applyAndStart();
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
    return false;
  }

  public supportsRhythm() {
    return false;
  }

  public supportsReverse() {
    return false;
  }

  public isTrackAvailable(trackId: number) {
    return trackId === 1;
  }

  public async recordTrack() {
    await this.dispatchStatusRequest(() => this.bridge.record());
  }

  public async stopTrack() {
    await this.dispatchStatusRequest(() => this.bridge.stopTransport());
  }

  public async playTrack() {
    await this.dispatchStatusRequest(() => this.bridge.play());
  }

  public async toggleOverdub() {
    await this.dispatchStatusRequest(() => this.bridge.toggleOverdub());
  }

  public async clearTrack() {
    await this.dispatchStatusRequest(() => this.bridge.clear());
  }

  public stopAllTracks() {
    void this.stopTrack();
  }

  public playAllTracks() {
    void this.playTrack();
  }

  public setFxType(_location: 'input' | 'track', _slotIndex: number, _type: string) { return; }
  public setFxParam(_location: 'input' | 'track', _slotIndex: number, _value: number) { return; }
  public setFxActive(_location: 'input' | 'track', _slotIndex: number, _active: boolean) { return; }
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
    };
  }

  private async applyAndStart() {
    if (!this.deviceCatalog) {
      await this.refreshCatalog();
    }

    try {
      const applied = await this.bridge.applyConfig(this.currentConfig());
      this.applyStatus(applied);
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

  private async refreshStatus() {
    try {
      const status = await this.bridge.getStatus();
      this.applyStatus(status);
    } catch (error) {
      this.handleBridgeFailure(error);
    }
  }

  private applyStatus(status: NativeStatus) {
    this.latestStatus = status;
    this.bridgeAvailable = true;
    this.engineRunning = status.engineRunning;
    this.monitoringEnabled = status.monitoringEnabled;
    this.selectedBackend = status.backend;
    this.selectedInputDeviceId = status.inputDeviceId || this.selectedInputDeviceId;
    this.selectedOutputDeviceId = status.outputDeviceId || this.selectedOutputDeviceId;
    this.selectedSampleRate = status.sampleRate || this.selectedSampleRate;
    this.selectedBufferFrames = status.bufferFrames || this.selectedBufferFrames;
    this.lastError = status.lastError || '';

    this.tracks[0]?.syncNativeState(status.state, status.loopProgress);
    for (let index = 1; index < this.tracks.length; index += 1) {
      this.tracks[index]?.resetTelemetry();
    }

    this.emitAll();
  }

  private handleBridgeFailure(error: unknown, markBridgeMissing = true) {
    if (markBridgeMissing) {
      this.bridgeAvailable = false;
      this.engineRunning = false;
      this.stopPolling();
    }

    this.lastError = error instanceof Error ? error.message : String(error);
    this.latestStatus = null;
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
  }
}
