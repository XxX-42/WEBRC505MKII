import type { TrackAudio } from './TrackAudio';
import { BrowserAudioEngine, type BrowserAudioLatencyInfo, type BrowserAudioUiStatus, type BrowserStepSlicerControl } from './BrowserAudioEngine';
import { NativeAudioEngine, type LatencyInfo as NativeLatencyInfo, type NativeDeviceSelection, type NativeUiStatus as NativeEngineUiStatus, type NativeCatalogFxSlotRuntime } from './NativeAudioEngine';
import type { NativeBackend, NativeCatalogMidiSlotStatus, NativeDeviceInfo, NativeFxSlot, NativeHqEngine, NativeLoopTransportConfig, NativeLoopTransportStatus, NativeStatus } from './NativeBridgeClient';
import type { NativeTrackProxy } from './NativeTrackProxy';
import type { BrowserFxAlgorithm, BrowserFxParameters } from './fx/dsp/BrowserFxDspCore';
import type { NativeFxPath } from './nativeFxCatalog';
import type { NativeStepSlicerParameters } from './nativeStepSlicerParameters';
import { toBrowserPreampParameters, toNativePreampParameters, type PreampParameters } from './preampParameters';
import { MidiInputController, type MidiInputState, type MidiNoteEvent } from './MidiInputController';
import type { NativeCatalogMidiEvent } from './NativeBridgeClient';
import { mapMidiNoteToNativeCatalogEvent, type OscVocMidiTarget } from './nativeOscVocMidi';
export type TrackFxMidiTarget = OscVocMidiTarget & { trackId?: number };
export type { OscVocMidiTarget } from './nativeOscVocMidi';

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
  inputReady?: boolean;
  inputState?: 'not-requested' | 'requesting' | 'ready' | 'error';
  inputError?: string;
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
  supportsOutputLevel?: boolean;
  outputLevelReason?: string;
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

export interface TrackFxSlotStatus {
  readonly slotIndex: number;
  readonly slot: NativeFxSlot;
  readonly type: string | null;
  readonly active: boolean;
  readonly bypassed: boolean;
  readonly state: 'empty' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly requestedEffectId?: string | null;
  readonly acknowledgedEffectId?: string | null;
  readonly acknowledged?: boolean;
  readonly pendingApply?: boolean;
  readonly pendingRestart?: boolean;
  readonly prepared?: boolean | null;
  readonly processingFaulted?: boolean;
  readonly controlFaulted?: boolean;
  readonly requestedRevision?: number | null;
  readonly appliedRevision?: number | null;
}

export interface TrackFxStatus {
  readonly trackId: number;
  readonly available: boolean;
  readonly routeMode: 'per-track-pre-mix' | 'unavailable';
  readonly perTrackFxChainAvailable: boolean;
  readonly legacySharedPostmix: boolean;
  readonly slots: readonly TrackFxSlotStatus[];
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
  private browserOutputLevelPercent = 100;
  private nativeMidiInput: MidiInputController | null = null;
  private nativeMidiTarget: TrackFxMidiTarget | null = null;
  private nativeMidiInputState: MidiInputState = 'disconnected';
  private readonly midiInputListeners = new Set<(state: MidiInputState) => void>();
  private browserMidiInputUnsubscribe: (() => void) | null = null;
  private nativeMidiQueue: NativeCatalogMidiEvent[] = [];
  private nativeMidiFlushRunning = false;
  private suppressNativeMidiCallbacks = false;

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
    if (mode !== this.currentMode) this.disconnectMidiInput();
    this.currentMode = mode;
    if (mode === 'browser' && this.midiInputListeners.size > 0) this.ensureBrowserMidiStateSubscription();
    AudioEngine.setPreferredMode(mode);
    this.emitMidiInputState();
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

  public get nativeLooperStorageBudgetBytes(): number {
    return this.nativeEngine.nativeLooperStorageBudgetBytes;
  }

  public get selectedBufferFrames(): number {
    if (this.currentMode === 'browser') {
      return this.browser.selectedBufferFrames;
    }
    return this.nativeEngine.selectedBufferFrames;
  }

  /** Select a real clean-room Browser master-output DSP stage; Native currently returns false. */
  public async setOutputDspFx(
    algorithm: BrowserFxAlgorithm,
    parameters: BrowserFxParameters = {},
    enabled = true,
  ): Promise<boolean> {
    if (this.currentMode !== 'browser') return false;
    return this.browser.setOutputDspFx(algorithm, parameters, enabled);
  }

  public setOutputDspFxEnabled(enabled: boolean, rampFrames?: number): void {
    if (this.currentMode !== 'browser') return;
    this.browser.setOutputDspFxEnabled(enabled, rampFrames);
  }

  public configureOutputDspFx(parameters: BrowserFxParameters): void {
    if (this.currentMode !== 'browser') return;
    this.browser.configureOutputDspFx(parameters);
  }

  public get monitoringEnabled(): boolean {
    return (this.activeEngine as { monitoringEnabled?: boolean }).monitoringEnabled ?? false;
  }

  public async init() {
    await this.activeEngine.init();
  }

  /** Apply saved Native FX choices while the host is stopped, then restart audio. */
  public async restartNativeAudio(): Promise<void> {
    if (this.currentMode !== 'native') throw new Error('Restart Native audio is only available in Native mode.');
    await this.nativeEngine.restartAudio();
  }

  /** Resume a suspended Browser AudioContext directly from a trusted user gesture. */
  public resumeFromUserActivation(): Promise<void> {
    if (this.currentMode !== 'browser') return Promise.resolve();
    return this.browser.resumeFromUserActivation();
  }

  /** Request the recording input separately so playback survives a denied microphone. */
  public async prepareInputFromUserActivation(): Promise<void> {
    if (this.currentMode === 'browser') await this.browser.getInputStream();
  }

  public getOutputLevel(): number {
    return this.currentMode === 'browser' ? this.browserOutputLevelPercent : 0;
  }

  public setOutputLevel(percent: number): void {
    if (this.currentMode !== 'browser') throw new Error('Native master output level is not exposed by this bridge.');
    if (!Number.isFinite(percent)) throw new RangeError('Output level must be finite.');
    this.browserOutputLevelPercent = Math.max(0, Math.min(100, percent));
    this.browser.masterGainNode.gain.setTargetAtTime(this.browserOutputLevelPercent / 100, this.browser.context.currentTime, 0.005);
  }

  public hasUnsavedLoops(): boolean {
    return this.tracks.some((track) => track.state !== 'EMPTY');
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
      // Browser render quantum is runtime-defined and reported by the
      // AudioWorklet; it is not a selectable hardware buffer size.
      bufferOptions: [],
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

  public async setNativeLooperStorageBudget(budgetBytes: number) {
    if (this.currentMode === 'native') {
      await this.nativeEngine.setNativeLooperStorageBudget(budgetBytes);
    }
  }

  /** Configure source-aware Native playback on one stored loop. */
  public async setNativeLoopTransport(trackId: number, config: NativeLoopTransportConfig): Promise<NativeStatus> {
    if (this.currentMode !== 'native') {
      throw new Error('Native per-track loop transport is only available in Native audio mode.');
    }
    return this.nativeEngine.setLoopTransport(trackId, config);
  }

  /** Read the latest acknowledged Native per-track loop-transport state. */
  public getNativeLoopTransportStatus(trackId: number): NativeLoopTransportStatus | null {
    if (this.currentMode !== 'native') return null;
    return this.nativeEngine.getLoopTransportStatus(trackId);
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

  /** Browser rendering remains Signalsmith; this capability is Native-only. */
  public getNativeHqRenderer(): { available: boolean; engines: NativeHqEngine[] } {
    if (this.currentMode !== 'native') return { available: false, engines: [] };
    return this.nativeEngine.getNativeHqRenderer();
  }

  public getCapabilities(): AudioCapabilities {
    if (this.currentMode === 'browser') {
      return {
        mode: 'browser',
        modeSummary: 'BROWSER: 5 TRACKS; LIMITED EFFECTS/RHYTHM; DSP PARITY INCOMPLETE',
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
        supportsOutputLevel: true,
        outputLevelReason: '',
      };
    }

    const supportsInputFx = this.nativeEngine.getCatalogFxOptions('input').length > 0;
    const supportsTrackFx = this.nativeEngine.getCatalogFxOptions('track').length > 0;
    const supportedTrackCount = this.nativeEngine.getNativeTrackCount();
    const status = this.nativeEngine.getUiStatus();
    const fxReason = status.bridgeAvailable
      ? !supportsInputFx && !supportsTrackFx
        ? 'Native catalog FX is unavailable in the current bridge status.'
        : !supportsInputFx
          ? 'Native catalog Input A–D FX is unavailable; Track A–D availability is reported separately.'
          : !supportsTrackFx
            ? 'Native catalog Track A–D FX is unavailable; Input A–D availability is reported separately.'
            : ''
      : 'Connect the Native bridge to read the available Input and Track catalog FX.';
    return {
      mode: 'native',
      modeSummary: `NATIVE: ${supportedTrackCount} LOOP TRACK${supportedTrackCount === 1 ? '' : 'S'}; INPUT A–D ${supportsInputFx ? 'AVAILABLE' : 'UNAVAILABLE'}; TRACK A–D ${supportsTrackFx ? 'AVAILABLE' : 'UNAVAILABLE'}`,
      supportedTrackCount,
      supportsInputFx,
      supportsTrackFx,
      supportsReverse: false,
      supportsRhythm: this.nativeEngine.supportsRhythm(),
      supportsBeatFeedback: false,
      fxReason,
      reverseReason: 'NO REVERSE IN NATIVE V1',
      rhythmReason: this.nativeEngine.rhythmEngine.unavailableReason,
      beatReason: 'NO BEAT IN NATIVE V1',
      trackLevelReason: 'TRACK MIX IN BROWSER ONLY',
      supportsOutputLevel: false,
      outputLevelReason: 'Native master output level is not exposed by this bridge.',
    };
  }

  public getTrackCapabilities(trackId: number): TrackCapabilities {
    const capabilities = this.getCapabilities();
    const isAvailable = this.isTrackAvailable(trackId);
    const availabilityReason = isAvailable || capabilities.mode === 'browser'
      ? ''
      : `TRACK ${trackId} IS NOT EXPOSED BY THE NATIVE HOST`;
    const controlReason = availabilityReason || capabilities.trackLevelReason;
    const nativePerTrackFxUnavailable = capabilities.mode === 'native' && isAvailable;
    const trackFxReason = availabilityReason || (nativePerTrackFxUnavailable
      ? 'NATIVE TRACK A–D FX USE A SHARED POSTMIX BUS; PER-TRACK FILTER CONTROLS ARE UNAVAILABLE'
      : capabilities.fxReason);
    const reverseReason = availabilityReason || capabilities.reverseReason;
    const supportsTrackStripFx = capabilities.mode === 'browser' && capabilities.supportsTrackFx && isAvailable;

    return {
      trackId,
      isAvailable,
      availabilityReason,
      supportsTrackLevel: capabilities.mode === 'browser' && isAvailable,
      levelReason: capabilities.mode === 'browser' && isAvailable ? '' : controlReason,
      supportsTrackFx: supportsTrackStripFx,
      trackFxReason: supportsTrackStripFx ? '' : trackFxReason,
      supportsReverse: capabilities.supportsReverse && isAvailable,
      reverseReason: capabilities.supportsReverse && isAvailable ? '' : reverseReason,
    };
  }

  public isTrackAvailable(trackId: number) {
    if (this.currentMode === 'native') {
      return this.nativeEngine.isNativeTrackAvailable(trackId);
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

  /** Independent pre-mix track A–D chains; legacy setFxType still edits the shared bank. */
  public setTrackFxType(trackId: number, slotIndex: number, type: string): boolean {
    return this.activeEngine.setTrackFxType(trackId, slotIndex, type);
  }

  public setTrackFxParameter(trackId: number, slotIndex: number, value: number): boolean {
    return this.activeEngine.setTrackFxParameter(trackId, slotIndex, value);
  }

  public setTrackFxNamedParameters(trackId: number, slotIndex: number, parameters: Record<string, number>): boolean {
    return this.activeEngine.setTrackFxNamedParameters(trackId, slotIndex, parameters);
  }

  public setTrackFxActive(trackId: number, slotIndex: number, active: boolean): boolean {
    return this.activeEngine.setTrackFxActive(trackId, slotIndex, active);
  }

  public getTrackFxStatus(trackId?: number): TrackFxStatus[] {
    return this.activeEngine.getTrackFxStatus(trackId);
  }

  /** Web MIDI permission is opt-in; Native routing requires a selected, running MIDI-driven catalog slot. */
  public connectMidiInput(target?: TrackFxMidiTarget): Promise<MidiInputState> {
    if (this.currentMode === 'browser') {
      this.ensureBrowserMidiStateSubscription();
      return this.browser.connectMidiInput(target).then((state) => {
        this.emitMidiInputState();
        return state;
      });
    }
    if (!target) {
      this.setNativeMidiInputState('runtime-unavailable');
      return Promise.resolve(this.nativeMidiInputState);
    }
    const slotIndex = ['A', 'B', 'C', 'D'].indexOf(target.slot);
    if (slotIndex < 0 || (target.path !== 'input' && target.path !== 'track') ||
        (target.trackId !== undefined && (!Number.isInteger(target.trackId) || target.trackId < 0 || target.trackId > 5 ||
          (target.path === 'input' && target.trackId !== 0)))) {
      this.setNativeMidiInputState('runtime-unavailable');
      return Promise.resolve(this.nativeMidiInputState);
    }
    const runtime = this.nativeEngine.getCatalogFxSlotStatus(target.path, slotIndex, target.trackId ?? 0);
    if (!this.nativeEngine.isNativeReady() || !runtime.acknowledged ||
        runtime.acknowledgedEffectId !== (target.effectId ?? 'osc_voc_m') || runtime.pendingRestart) {
      this.setNativeMidiInputState('runtime-unavailable');
      return Promise.resolve(this.nativeMidiInputState);
    }

    if (this.nativeMidiInput && (this.nativeMidiTarget?.path !== target.path ||
        this.nativeMidiTarget?.slot !== target.slot ||
        this.nativeMidiTarget?.effectId !== target.effectId ||
        (this.nativeMidiTarget?.trackId ?? 0) !== (target.trackId ?? 0))) {
      this.nativeMidiInput.disconnect();
      this.nativeMidiInput = null;
    }
    if (!this.nativeMidiInput) {
      const route = { ...target };
      this.nativeMidiTarget = route;
      this.nativeMidiInput = new MidiInputController(
        (event) => this.handleNativeMidiNote(event, route),
        { onStateChange: (state) => this.setNativeMidiInputState(state) },
      );
    }
    return this.nativeMidiInput.connect();
  }

  public disconnectMidiInput(): void {
    this.browserEngine?.disconnectMidiInput();
    this.nativeMidiInput?.disconnect();
    this.nativeMidiInput = null;
    this.nativeMidiTarget = null;
    this.setNativeMidiInputState('disconnected');
    this.emitMidiInputState();
  }

  public getMidiInputState(): MidiInputState {
    if (this.currentMode === 'browser') {
      return this.browserEngine ? this.browserEngine.getMidiInputState() : 'disconnected';
    }
    return this.nativeMidiInputState;
  }

  public onMidiInputStateChange(listener: (state: MidiInputState) => void): () => void {
    this.midiInputListeners.add(listener);
    if (this.currentMode === 'browser') this.ensureBrowserMidiStateSubscription();
    listener(this.getMidiInputState());
    return () => {
      this.midiInputListeners.delete(listener);
      if (this.midiInputListeners.size === 0) {
        this.browserMidiInputUnsubscribe?.();
        this.browserMidiInputUnsubscribe = null;
      }
    };
  }

  private setNativeMidiInputState(state: MidiInputState): void {
    if (state === this.nativeMidiInputState) return;
    this.nativeMidiInputState = state;
    this.emitMidiInputState();
  }

  private ensureBrowserMidiStateSubscription(): void {
    if (this.browserMidiInputUnsubscribe) return;
    this.browserMidiInputUnsubscribe = this.browser.onMidiInputStateChange(() => this.emitMidiInputState());
  }

  private emitMidiInputState(): void {
    const state = this.getMidiInputState();
    for (const listener of this.midiInputListeners) listener(state);
  }

  private handleNativeMidiNote(event: MidiNoteEvent, target: TrackFxMidiTarget): void {
    if (this.suppressNativeMidiCallbacks) return;
    const anchor = this.nativeEngine.getOscVocMidiFrameAnchor();
    if (!anchor) {
      this.setNativeMidiInputState('runtime-unavailable');
      return;
    }
    let nativeEvent: NativeCatalogMidiEvent;
    try {
      nativeEvent = { ...mapMidiNoteToNativeCatalogEvent(event, target, anchor), ...(target.trackId !== undefined ? { trackId: target.trackId } : {}) };
    } catch {
      if (this.currentMode === 'native') this.disconnectNativeMidiWithError();
      return;
    }
    if (this.nativeMidiQueue.length >= 128) {
      this.disconnectNativeMidiWithError();
      return;
    }
    this.nativeMidiQueue.push(nativeEvent);
    void this.flushNativeMidiQueue();
  }

  private async flushNativeMidiQueue(): Promise<void> {
    if (this.nativeMidiFlushRunning) return;
    this.nativeMidiFlushRunning = true;
    try {
      while (this.nativeMidiQueue.length > 0) {
        const queued = this.nativeMidiQueue.shift()!;
        await this.nativeEngine.queueCatalogMidiEvent(queued);
      }
    } catch {
      this.disconnectNativeMidiWithError();
    } finally {
      this.nativeMidiFlushRunning = false;
      if (this.nativeMidiQueue.length > 0) void this.flushNativeMidiQueue();
    }
  }

  private disconnectNativeMidiWithError(): void {
    const input = this.nativeMidiInput;
    this.nativeMidiInput = null;
    this.nativeMidiTarget = null;
    this.nativeMidiQueue = [];
    this.suppressNativeMidiCallbacks = true;
    input?.disconnect();
    this.suppressNativeMidiCallbacks = false;
    this.setNativeMidiInputState('error');
  }

  public getNativeCatalogFxOptions(path: NativeFxPath, trackId = 0): string[] {
    if (this.currentMode !== 'native') return [];
    return this.nativeEngine.getCatalogFxOptions(path, trackId);
  }

  public getNativeCatalogFxSlotStatus(path: NativeFxPath, slotIndex: number, trackId = 0): NativeCatalogFxSlotRuntime | null {
    if (this.currentMode !== 'native') return null;
    return this.nativeEngine.getCatalogFxSlotStatus(path, slotIndex, trackId);
  }

  public getNativeCatalogMidiSlotStatus(path: NativeFxPath, slotIndex: number, trackId = 0): NativeCatalogMidiSlotStatus | null {
    return this.currentMode === 'native' ? this.nativeEngine.getCatalogMidiSlotStatus(path, slotIndex, trackId) : null;
  }

  public setNativeStepSlicerParameters(path: NativeFxPath, slotIndex: number, parameters: NativeStepSlicerParameters, trackId = 0) {
    if (this.currentMode !== 'native') return;
    this.nativeEngine.setCatalogStepSlicerParameters(path, slotIndex, parameters, trackId);
  }

  /** Apply effect-specific parameters to the selected runtime's A–D catalog slot. */
  public setCatalogFxParameters(path: NativeFxPath, slotIndex: number, parameters: Record<string, number>) {
    if (this.currentMode === 'native') {
      this.nativeEngine.setCatalogFxParameters(path, slotIndex, parameters);
      return;
    }
    this.browser.setFxNamedParameters(path, slotIndex, parameters);
  }

  /** Apply the six canonical PREAMP controls to Browser or Native key names. */
  public setPreampParameters(path: NativeFxPath, slotIndex: number, parameters: PreampParameters) {
    if (this.currentMode === 'native') {
      this.nativeEngine.setCatalogFxParameters(path, slotIndex, toNativePreampParameters(parameters));
      return;
    }
    this.browser.setFxNamedParameters(path, slotIndex, toBrowserPreampParameters(parameters));
  }

  public setFxParam(location: 'input' | 'track', slotIndex: number, value: number) {
    this.activeEngine.setFxParam(location, slotIndex, value);
  }

  public setBrowserStepSlicerStep(location: 'input' | 'track', slotIndex: number, stepIndex: number, amplitudePercent: number) {
    if (this.currentMode !== 'browser') return;
    this.browserEngine?.setStepSlicerStep(location, slotIndex, stepIndex, amplitudePercent);
  }

  public setBrowserStepSlicerControl(location: 'input' | 'track', slotIndex: number, control: BrowserStepSlicerControl, value: number) {
    if (this.currentMode !== 'browser') return;
    this.browserEngine?.setStepSlicerControl(location, slotIndex, control, value);
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
