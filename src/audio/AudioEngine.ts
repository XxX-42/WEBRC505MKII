import type { TrackAudio } from './TrackAudio';
import { BrowserAudioEngine, type BrowserAudioLatencyInfo, type BrowserAudioUiStatus } from './BrowserAudioEngine';
import { NativeAudioEngine, type LatencyInfo as NativeLatencyInfo, type NativeDeviceSelection, type NativeUiStatus as NativeEngineUiStatus } from './NativeAudioEngine';
import type { NativeBackend, NativeDeviceInfo } from './NativeBridgeClient';
import type { NativeTrackProxy } from './NativeTrackProxy';

export type AudioMode = 'native' | 'browser';
export type AudioBackend = NativeBackend | 'BROWSER';
export type EngineTrack = TrackAudio | NativeTrackProxy;

export interface AudioDeviceInfo {
  id: string;
  name: string;
  sampleRates: number[];
}

export interface AudioDeviceSelection {
  backends: AudioBackend[];
  selectedBackend: AudioBackend;
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
  sampleRates: number[];
  bufferOptions: number[];
}

export interface LatencyInfo {
  mode: AudioMode;
  backend: AudioBackend | null;
  sampleRate: number;
  bufferFrames: number;
  inputLatencyMs: number | null;
  outputLatencyMs: number | null;
  baseLatencyMs: number | null;
  estimatedMonitoringLatencyMs: number | null;
  roundTripLatencyMs: number | null;
  inputPeak: number;
  outputPeak: number;
  xrunsOrDropouts: number;
  bridgeAvailable: boolean;
  engineRunning: boolean;
}

export interface AudioUiStatus {
  mode: AudioMode;
  bridgeAvailable: boolean;
  engineRunning: boolean;
  ready: boolean;
  message: string;
  lastError: string;
}

export interface AudioCapabilities {
  mode: AudioMode;
  modeSummary: string;
  supportedTrackCount: number;
  supportsInputFx: boolean;
  supportsTrackFx: boolean;
  supportsReverse: boolean;
  supportsRhythm: boolean;
  supportsBeatFeedback: boolean;
  fxReason: string;
  reverseReason: string;
  rhythmReason: string;
  beatReason: string;
  trackLevelReason: string;
}

export interface TrackCapabilities {
  trackId: number;
  isAvailable: boolean;
  availabilityReason: string;
  supportsTrackLevel: boolean;
  levelReason: string;
  supportsTrackFx: boolean;
  trackFxReason: string;
  supportsReverse: boolean;
  reverseReason: string;
}

export type NativeUiStatus = AudioUiStatus;

const AUDIO_MODE_KEY = 'webrc505_audio_mode';

function resolveInitialMode(): AudioMode {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('audio');
  if (requested === 'browser' || requested === 'native') {
    localStorage.setItem(AUDIO_MODE_KEY, requested);
    return requested;
  }

  const stored = localStorage.getItem(AUDIO_MODE_KEY);
  return stored === 'browser' ? 'browser' : 'native';
}

function mapNativeDevices(devices: NativeDeviceInfo[]): AudioDeviceInfo[] {
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    sampleRates: [...device.sampleRates],
  }));
}

function mapBrowserDevices(devices: MediaDeviceInfo[], sampleRate: number): AudioDeviceInfo[] {
  return devices.map((device, index) => ({
    id: device.deviceId || `${device.kind}-${index}`,
    name: device.label || `Default ${device.kind === 'audioinput' ? 'Input' : 'Output'} ${index + 1}`,
    sampleRates: [sampleRate],
  }));
}

export class AudioEngine {
  private static instance: AudioEngine;

  private readonly nativeEngine = NativeAudioEngine.getInstance();
  private browserEngine: BrowserAudioEngine | null = null;
  private currentMode: AudioMode = resolveInitialMode();

  public static getInstance(): AudioEngine {
    if (!AudioEngine.instance) {
      AudioEngine.instance = new AudioEngine();
    }
    return AudioEngine.instance;
  }

  public static getPreferredMode(): AudioMode {
    return resolveInitialMode();
  }

  public static setPreferredMode(mode: AudioMode) {
    localStorage.setItem(AUDIO_MODE_KEY, mode);
  }

  public getMode(): AudioMode {
    return this.currentMode;
  }

  public setMode(mode: AudioMode) {
    this.currentMode = mode;
    AudioEngine.setPreferredMode(mode);
  }

  public get tracks(): EngineTrack[] {
    return this.activeEngine.tracks as EngineTrack[];
  }

  public get rhythmEngine() {
    return this.activeEngine.rhythmEngine;
  }

  public get trackStates(): Int32Array | null {
    return this.activeEngine.trackStates ?? null;
  }

  public get trackPositions(): Float32Array | null {
    return this.activeEngine.trackPositions ?? null;
  }

  public get sharedBuffer(): SharedArrayBuffer | null {
    return this.activeEngine.sharedBuffer ?? null;
  }

  public get selectedInputDeviceId(): string | null {
    return (this.activeEngine as { selectedInputDeviceId?: string | null }).selectedInputDeviceId ?? null;
  }

  public get selectedOutputDeviceId(): string | null {
    return (this.activeEngine as { selectedOutputDeviceId?: string | null }).selectedOutputDeviceId ?? null;
  }

  public get selectedBackend(): AudioBackend {
    if (this.currentMode === 'browser') {
      return 'BROWSER';
    }
    return this.nativeEngine.selectedBackend;
  }

  public get selectedSampleRate(): number {
    if (this.currentMode === 'browser') {
      return this.browser.context.sampleRate;
    }
    return this.nativeEngine.selectedSampleRate;
  }

  public get selectedBufferFrames(): number {
    if (this.currentMode === 'browser') {
      return 128;
    }
    return this.nativeEngine.selectedBufferFrames;
  }

  public get monitoringEnabled(): boolean {
    return (this.activeEngine as { monitoringEnabled?: boolean }).monitoringEnabled ?? false;
  }

  public async init() {
    await this.activeEngine.init();
  }

  public async getDevices(): Promise<AudioDeviceSelection> {
    if (this.currentMode === 'native') {
      const selection: NativeDeviceSelection = await this.nativeEngine.getDevices();
      return {
        backends: selection.backends,
        selectedBackend: selection.selectedBackend,
        inputs: mapNativeDevices(selection.inputs),
        outputs: mapNativeDevices(selection.outputs),
        sampleRates: [...selection.sampleRates],
        bufferOptions: [...selection.bufferOptions],
      };
    }

    const devices = await this.browser.getDevices();
    const sampleRate = this.browser.context.sampleRate;
    return {
      backends: ['BROWSER'],
      selectedBackend: 'BROWSER',
      inputs: mapBrowserDevices(devices.inputs, sampleRate),
      outputs: mapBrowserDevices(devices.outputs, sampleRate),
      sampleRates: [sampleRate],
      bufferOptions: [128],
    };
  }

  public async setBackend(backend: AudioBackend) {
    if (this.currentMode === 'native' && backend !== 'BROWSER') {
      await this.nativeEngine.setBackend(backend);
    }
  }

  public async setInputDevice(deviceId: string) {
    await this.activeEngine.setInputDevice(deviceId);
  }

  public async setOutputDevice(deviceId: string) {
    await this.activeEngine.setOutputDevice(deviceId);
  }

  public async setSampleRate(sampleRate: number) {
    if (this.currentMode === 'native') {
      await this.nativeEngine.setSampleRate(sampleRate);
    }
  }

  public async setBufferFrames(bufferFrames: number) {
    if (this.currentMode === 'native') {
      await this.nativeEngine.setBufferFrames(bufferFrames);
    }
  }

  public async setMonitoring(enabled: boolean) {
    if (this.currentMode === 'native') {
      await this.nativeEngine.setMonitoring(enabled);
      return;
    }
    this.browser.setMonitoring(enabled);
  }

  public onMonitoringChange(listener: (enabled: boolean) => void) {
    return this.activeEngine.onMonitoringChange(listener);
  }

  public onLatencyInfoChange(listener: (info: LatencyInfo) => void) {
    if (this.currentMode === 'native') {
      return this.nativeEngine.onLatencyInfoChange((info: NativeLatencyInfo) => {
        listener(this.mapNativeLatency(info));
      });
    }

    return this.browser.onLatencyInfoChange((info: BrowserAudioLatencyInfo) => {
      listener(this.mapBrowserLatency(info));
    });
  }

  public onStatusChange(listener: (status: AudioUiStatus) => void) {
    if (this.currentMode === 'native') {
      return this.nativeEngine.onStatusChange((status: NativeEngineUiStatus) => {
        listener({
          ...status,
          mode: 'native',
        });
      });
    }

    return this.browser.onStatusChange((status: BrowserAudioUiStatus) => {
      listener(status);
    });
  }

  public getLatencyInfo(): LatencyInfo {
    if (this.currentMode === 'native') {
      return this.mapNativeLatency(this.nativeEngine.getLatencyInfo());
    }
    return this.mapBrowserLatency(this.browser.getLatencyInfo());
  }

  public getUiStatus(): AudioUiStatus {
    if (this.currentMode === 'native') {
      return {
        ...this.nativeEngine.getUiStatus(),
        mode: 'native',
      };
    }
    return this.browser.getUiStatus();
  }

  public isNativeReady() {
    return this.getUiStatus().ready;
  }

  public isBridgeAvailable() {
    return this.getUiStatus().bridgeAvailable;
  }

  public supportsFx() {
    return this.activeEngine.supportsFx();
  }

  public supportsRhythm() {
    return this.activeEngine.supportsRhythm();
  }

  public supportsReverse() {
    return this.activeEngine.supportsReverse();
  }

  public getCapabilities(): AudioCapabilities {
    if (this.currentMode === 'browser') {
      return {
        mode: 'browser',
        modeSummary: 'BROWSER: FULL TRACK CONTROLS',
        supportedTrackCount: 5,
        supportsInputFx: true,
        supportsTrackFx: true,
        supportsReverse: true,
        supportsRhythm: true,
        supportsBeatFeedback: true,
        fxReason: '',
        reverseReason: '',
        rhythmReason: '',
        beatReason: '',
        trackLevelReason: '',
      };
    }

    return {
      mode: 'native',
      modeSummary: 'NATIVE V1: TRACK 1 ONLY',
      supportedTrackCount: 1,
      supportsInputFx: false,
      supportsTrackFx: false,
      supportsReverse: false,
      supportsRhythm: false,
      supportsBeatFeedback: false,
      fxReason: 'NO FX IN NATIVE V1',
      reverseReason: 'NO REVERSE IN NATIVE V1',
      rhythmReason: 'NO RHYTHM IN NATIVE V1',
      beatReason: 'NO BEAT IN NATIVE V1',
      trackLevelReason: 'TRACK MIX IN BROWSER ONLY',
    };
  }

  public getTrackCapabilities(trackId: number): TrackCapabilities {
    const capabilities = this.getCapabilities();
    const isAvailable = this.isTrackAvailable(trackId);
    const availabilityReason = isAvailable || capabilities.mode === 'browser'
      ? ''
      : `TRACK ${trackId} UNAVAILABLE IN NATIVE V1`;
    const controlReason = availabilityReason || capabilities.trackLevelReason;
    const trackFxReason = availabilityReason || capabilities.fxReason;
    const reverseReason = availabilityReason || capabilities.reverseReason;

    return {
      trackId,
      isAvailable,
      availabilityReason,
      supportsTrackLevel: capabilities.mode === 'browser' && isAvailable,
      levelReason: capabilities.mode === 'browser' && isAvailable ? '' : controlReason,
      supportsTrackFx: capabilities.supportsTrackFx && isAvailable,
      trackFxReason: capabilities.supportsTrackFx && isAvailable ? '' : trackFxReason,
      supportsReverse: capabilities.supportsReverse && isAvailable,
      reverseReason: capabilities.supportsReverse && isAvailable ? '' : reverseReason,
    };
  }

  public isTrackAvailable(trackId: number) {
    if (this.currentMode === 'native') {
      return this.nativeEngine.isTrackAvailable(trackId);
    }
    return this.browser.isTrackAvailable(trackId);
  }

  public async recordTrack() {
    if (this.currentMode === 'native') {
      await this.nativeEngine.recordTrack();
      return;
    }
    this.browser.tracks[0]?.triggerRecord();
  }

  public async stopTrack() {
    if (this.currentMode === 'native') {
      await this.nativeEngine.stopTrack();
      return;
    }
    this.browser.tracks[0]?.triggerStop();
  }

  public async playTrack() {
    if (this.currentMode === 'native') {
      await this.nativeEngine.playTrack();
      return;
    }
    this.browser.tracks[0]?.play();
  }

  public async toggleOverdub() {
    if (this.currentMode === 'native') {
      await this.nativeEngine.toggleOverdub();
      return;
    }
    this.browser.tracks[0]?.triggerRecord();
  }

  public async clearTrack() {
    if (this.currentMode === 'native') {
      await this.nativeEngine.clearTrack();
      return;
    }
    this.browser.tracks[0]?.clear();
  }

  public stopAllTracks() {
    this.activeEngine.stopAllTracks();
  }

  public playAllTracks() {
    this.activeEngine.playAllTracks();
  }

  public setFxType(location: 'input' | 'track', slotIndex: number, type: string) {
    this.activeEngine.setFxType(location, slotIndex, type);
  }

  public setFxParam(location: 'input' | 'track', slotIndex: number, value: number) {
    this.activeEngine.setFxParam(location, slotIndex, value);
  }

  public setFxActive(location: 'input' | 'track', slotIndex: number, active: boolean) {
    this.activeEngine.setFxActive(location, slotIndex, active);
  }

  public playTestTone() {
    this.activeEngine.playTestTone();
  }

  public runLoopbackTest() {
    return this.activeEngine.runLoopbackTest();
  }

  public setLatency(latencyMs: number) {
    this.activeEngine.setLatency(latencyMs);
  }

  public toggleReverse(trackIndex: number) {
    if ('toggleReverse' in this.activeEngine && typeof this.activeEngine.toggleReverse === 'function') {
      this.activeEngine.toggleReverse(trackIndex);
    }
  }

  private get activeEngine() {
    return this.currentMode === 'native' ? this.nativeEngine : this.browser;
  }

  private get browser(): BrowserAudioEngine {
    if (!this.browserEngine) {
      this.browserEngine = new BrowserAudioEngine();
    }
    return this.browserEngine;
  }

  private mapNativeLatency(info: NativeLatencyInfo): LatencyInfo {
    return {
      mode: 'native',
      backend: info.backend,
      sampleRate: info.sampleRate,
      bufferFrames: info.bufferFrames,
      inputLatencyMs: info.inputLatencyMs,
      outputLatencyMs: info.outputLatencyMs,
      baseLatencyMs: null,
      estimatedMonitoringLatencyMs: info.roundTripLatencyMs,
      roundTripLatencyMs: info.roundTripLatencyMs,
      inputPeak: info.inputPeak,
      outputPeak: info.outputPeak,
      xrunsOrDropouts: info.xrunsOrDropouts,
      bridgeAvailable: info.bridgeAvailable,
      engineRunning: info.engineRunning,
    };
  }

  private mapBrowserLatency(info: BrowserAudioLatencyInfo): LatencyInfo {
    return {
      mode: 'browser',
      backend: 'BROWSER',
      sampleRate: info.sampleRate,
      bufferFrames: 128,
      inputLatencyMs: info.baseLatencyMs,
      outputLatencyMs: info.outputLatencyMs,
      baseLatencyMs: info.baseLatencyMs,
      estimatedMonitoringLatencyMs: info.estimatedMonitoringLatencyMs,
      roundTripLatencyMs: info.roundTripLatencyMs,
      inputPeak: 0,
      outputPeak: 0,
      xrunsOrDropouts: 0,
      bridgeAvailable: true,
      engineRunning: this.browser.getUiStatus().ready,
    };
  }
}
