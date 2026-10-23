import type { TrackAudio } from './TrackAudio';
import { BrowserAudioEngine, type BrowserAudioLatencyInfo, type BrowserAudioUiStatus, type BrowserStepSlicerControl } from './BrowserAudioEngine';
import { NativeAudioEngine, type LatencyInfo as NativeLatencyInfo, type NativeDeviceSelection, type NativeUiStatus as NativeEngineUiStatus, type NativeCatalogFxSlotRuntime } from './NativeAudioEngine';
import type { NativeBackend, NativeCatalogMidiSlotStatus, NativeDeviceInfo, NativeFxParameterSchema, NativeFxSlot, NativeHqEngine, NativeLoopTransportConfig, NativeLoopTransportStatus, NativeProjectImportStatus, NativeStatus } from './NativeBridgeClient';
import type { NativeTrackProxy } from './NativeTrackProxy';
import type { BrowserFxAlgorithm, BrowserFxParameters } from './fx/dsp/BrowserFxDspCore';
import type { NativeFxPath } from './nativeFxCatalog';
import type { NativeStepSlicerParameters } from './nativeStepSlicerParameters';
import type { BrowserRecoverySnapshot } from './BrowserRecoverySnapshot';
import { buildBrowserRecoveryCandidate } from './BrowserRecoveryCandidate';
import { toBrowserPreampParameters, toNativePreampParameters, type PreampParameters } from './preampParameters';
import { MidiInputController, type MidiInputState, type MidiNoteEvent } from './MidiInputController';
import type { NativeCatalogMidiEvent } from './NativeBridgeClient';
import { mapMidiNoteToNativeCatalogEvent, type OscVocMidiTarget } from './nativeOscVocMidi';
import type { ProjectArchive, ProjectRestoreOperationToken } from './projectArchive';
import { Transport } from '../core/Transport';
import { unsupportedTrackMarkState, type TrackMarkState, type TrackMarkActionResult } from './TrackMark';
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
  inputCaptureReady?: boolean;
  inputCaptureWarming?: boolean;
  inputCaptureWarmupReason?: string;
  inputCaptureUnavailableReason?: string;
  inputState?: 'not-requested' | 'requesting' | 'ready' | 'error';
  inputError?: string;
  recoveryAwaitingUserResume?: boolean;
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

export interface TrackPcmHistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  unavailableReason: string;
}

export interface TrackFxSlotStatus {
  readonly slotIndex: number;
  readonly slot: NativeFxSlot;
  readonly type: string | null;
  readonly active: boolean;
  readonly bypassed: boolean;
  readonly state: 'empty' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  /** Optional Browser per-track adapter resource limitation or non-fatal rejection. */
  readonly warning?: string | null;
  readonly resourceNote?: string | null;
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
  private modeGeneration = 0;
  private browserOutputLevelPercent = 100;
  private nativeMidiInput: MidiInputController | null = null;
  private nativeMidiTarget: TrackFxMidiTarget | null = null;
  private nativeMidiInputState: MidiInputState = 'disconnected';
  private readonly midiInputListeners = new Set<(state: MidiInputState) => void>();
  private browserMidiInputUnsubscribe: (() => void) | null = null;
  private browserStatusListeners = new Set<(status: BrowserAudioUiStatus) => void>();
  private browserMonitoringListeners = new Set<(enabled: boolean) => void>();
  private browserLatencyListeners = new Set<(info: LatencyInfo) => void>();
  private browserUiBinding: { engine: BrowserAudioEngine; dispose: () => void } | null = null;
  /** Preserved master level applied only after the user explicitly resumes the recovered context. */
  private recoveredBrowserOutputGain: number | null = null;
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
    if (mode !== this.currentMode) {
      this.disconnectMidiInput();
      this.modeGeneration += 1;
    }
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
    if (this.currentMode === 'browser') {
      const browser = this.browser;
      await browser.init();
      this.applyRecoveredBrowserOutputGain(browser);
      return;
    }
    await this.nativeEngine.init();
  }

  /**
   * Atomically publish a fully prepared Browser replacement. This only swaps
   * the facade and its subscriptions. Old PCM/history remains intact until
   * publication; after that commit, only its closed context graph is retired.
   * The returned old engine still owns its PCM/history buffers for export.
   */
  public adoptRecoveredBrowserEngine(
    expectedOldEngine: BrowserAudioEngine,
    sourceSnapshot: BrowserRecoverySnapshot,
    candidate: BrowserAudioEngine,
    preparedSnapshot: BrowserRecoverySnapshot,
  ): BrowserAudioEngine {
    if (candidate === expectedOldEngine) {
      throw new Error('Browser recovery requires a distinct candidate engine.');
    }
    if (this.currentMode !== 'browser' || this.browserEngine !== expectedOldEngine) {
      throw new Error('Browser recovery adoption was canceled because the active engine changed.');
    }
    if (!expectedOldEngine.isRecoverySnapshotCurrent(sourceSnapshot)) {
      throw new Error('Browser recovery adoption was canceled because the old PCM, history, transport, or settings changed during preparation.');
    }
    expectedOldEngine.assertRetirableAfterRecoveryAdoption();
    candidate.prepareRecoveryAdoption(preparedSnapshot);
    if (!candidate.claimRecoveryAdoption(preparedSnapshot)) {
      throw new Error('Browser recovery candidate ownership was already claimed or is not prepared for this snapshot.');
    }

    // Register dormant bridges first. BrowserAudioEngine invokes each listener
    // once at subscription time; the identity guard below keeps that staged
    // initial callback from escaping before publication.
    let stagedBinding: { engine: BrowserAudioEngine; dispose: () => void } | null = null;
    let stagedMidiUnsubscribe: (() => void) | null = null;
    const oldHadTransportSubscription = expectedOldEngine.hasTransportBpmChangeSubscription();
    let oldTransportDetached = false;
    try {
      stagedBinding = this.createBrowserUiBinding(candidate);
      if (this.browserMidiInputUnsubscribe) {
        stagedMidiUnsubscribe = candidate.onMidiInputStateChange(() => {
          if (this.browserEngine === candidate) this.notifyMidiInputStateListenersSafely();
        });
      }
      candidate.attachTransportBpmChangeSubscription();
      // Listener setup may synchronously call user code. Recheck after staging
      // so a re-entrant edit cannot be overwritten by this recovery.
      if (!expectedOldEngine.isRecoverySnapshotCurrent(sourceSnapshot)) {
        throw new Error('Browser recovery adoption was canceled because the old PCM, history, transport, or settings changed during final validation.');
      }
      // The closed source and its AudioBuffer/history references remain intact.
      expectedOldEngine.detachTransportBpmChangeSubscription();
      oldTransportDetached = oldHadTransportSubscription;
      if (!candidate.completeRecoveryAdoption()) {
        throw new Error('Browser recovery candidate lost its ownership claim before publication.');
      }
    } catch (error) {
      this.rollbackBrowserRecoveryStaging(candidate, stagedBinding, stagedMidiUnsubscribe, oldTransportDetached ? expectedOldEngine : null, oldHadTransportSubscription);
      candidate.releaseRecoveryAdoptionClaim();
      throw error;
    }

    // No fallible work is permitted between ownership completion and this
    // synchronous pointer publication.
    const oldBinding = this.browserUiBinding;
    const oldMidiUnsubscribe = this.browserMidiInputUnsubscribe;
    this.browserEngine = candidate;
    this.browserUiBinding = stagedBinding;
    if (stagedMidiUnsubscribe) this.browserMidiInputUnsubscribe = stagedMidiUnsubscribe;
    // The prepared graph is intentionally at zero gain. Preserve the saved
    // authored level separately and apply it only after an explicit resume.
    // A replacement may itself close before that resume. Its actual gain is
    // still the safety mute, not a newly authored zero level. Keep any pending
    // authored gain; snapshot identity validation must still use the real graph.
    this.recoveredBrowserOutputGain ??= sourceSnapshot.outputGainValue;
    this.browserOutputLevelPercent = Math.max(0, Math.min(100, this.recoveredBrowserOutputGain * 100));

    // This is the commit point. Cleanup, Transport notifications, and UI
    // observers are best-effort and must never turn a committed swap into an
    // apparent failed transaction.
    this.runRecoveryPostCommitCleanup('old Browser UI subscription cleanup', () => oldBinding?.dispose());
    this.runRecoveryPostCommitCleanup('old Browser MIDI subscription cleanup', () => oldMidiUnsubscribe?.());
    try {
      // Once the candidate is published, the old context no longer needs its
      // render graph. Disposal preserves PCM/history references on the returned
      // old engine and removes stale Rhythm/Transport observers before STOP.
      expectedOldEngine.retireAfterRecoveryAdoption();
    } catch (error) {
      console.error('Recovered Browser engine was published, but old closed-graph retirement reported an error', error);
    }
    try { Transport.getInstance().stop(); } catch (error) {
      console.error('Recovered Browser engine was published, but Transport STOP listeners reported an error', error);
    }
    this.runRecoveryPostCommitCleanup('Browser UI notification', () => this.notifyBrowserUiListeners(candidate));
    this.notifyMidiInputStateListenersSafely();
    return expectedOldEngine;
  }

  public isBrowserContextClosed(): boolean {
    return this.currentMode === 'browser' && this.browserEngine?.context.state === 'closed';
  }

  public isBrowserRecoveryAwaitingUserResume(): boolean {
    return this.currentMode === 'browser' && this.browserEngine?.isRecoveryAwaitingUserResume() === true;
  }

  /**
   * Recover a permanently closed Browser context on the existing project.
   * Context creation is synchronous up to the first await in the candidate
   * builder, so callers must invoke this directly from a trusted user click.
   * The replacement remains suspended, stopped, muted, MIDI-disconnected and
   * microphone-disconnected after adoption.
   */
  public async recoverClosedBrowserAudioContext(): Promise<void> {
    if (this.currentMode !== 'browser' || !this.browserEngine) {
      throw new Error('Browser audio recovery requires the existing Browser engine.');
    }
    const oldEngine = this.browserEngine;
    if (oldEngine.context.state !== 'closed') throw new Error('The Browser AudioContext is not closed; ordinary resume remains available.');
    const sourceSnapshot = oldEngine.getRecoverySnapshot();
    const candidate = await buildBrowserRecoveryCandidate(sourceSnapshot, undefined, {
      // The replacement engine itself will materialize these paths. Preflight
      // their combined per-context reservation without allocating a detached
      // duplicate graph or pitch runtime in the same candidate context.
      preflightPersistedFxGraph: true,
      prepareRuntime: false,
    });
    let runtime: ReturnType<typeof candidate.takeRuntime> | null = null;
    let replacement: BrowserAudioEngine | null = null;
    try {
      runtime = candidate.takeRuntime();
      try { runtime.silentSink.disconnect(); } catch { /* the recovery candidate remains muted */ }
      replacement = new BrowserAudioEngine({
        context: runtime.context,
        deferTransportBpmChangeSubscription: true,
        loadDevicePreferences: false,
        historyBudgetBytes: sourceSnapshot.pcmHistoryBudget.limitBytes,
      });
      await replacement.restoreRecoverySnapshot(runtime.snapshot);
      this.adoptRecoveredBrowserEngine(oldEngine, sourceSnapshot, replacement, runtime.snapshot);
    } catch (error) {
      if (runtime) {
        try { if (runtime.context.state !== 'closed') await runtime.context.close(); }
        catch (cleanupError) { console.error('Unpublished Browser recovery context close failed', cleanupError); }
        try { replacement?.retireAfterRecoveryAdoption(); }
        catch (cleanupError) { console.error('Unpublished Browser recovery graph retirement failed', cleanupError); }
        try { await runtime.dispose(); }
        catch (cleanupError) { console.error('Unpublished Browser recovery candidate disposal failed', cleanupError); }
      } else {
        try { await candidate.dispose(); }
        catch (cleanupError) { console.error('Unpublished Browser recovery candidate disposal failed', cleanupError); }
      }
      throw error;
    }
  }

  /** Apply saved Native FX choices while the host is stopped, then restart audio. */
  public async restartNativeAudio(): Promise<void> {
    if (this.currentMode !== 'native') throw new Error('Restart Native audio is only available in Native mode.');
    await this.nativeEngine.restartAudio();
  }

  /** Resume a suspended Browser AudioContext directly from a trusted user gesture. */
  public resumeFromUserActivation(): Promise<void> {
    if (this.currentMode !== 'browser') return Promise.resolve();
    const browser = this.browser;
    return browser.resumeFromUserActivation().then(() => this.applyRecoveredBrowserOutputGain(browser));
  }

  /** Initialize output-only runtime after recovery from a separate trusted click. */
  public async resumeRecoveredBrowserOutputFromUserActivation(): Promise<void> {
    if (this.currentMode !== 'browser') return;
    const browser = this.browser;
    await browser.initializeRecoveredOutputFromUserActivation();
    this.applyRecoveredBrowserOutputGain(browser);
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
    this.recoveredBrowserOutputGain = null;
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

  /** Configure the Browser's separate per-loop source-readhead stage. */
  public setBrowserLoopTransport(trackId: number, config: NativeLoopTransportConfig): boolean {
    if (this.currentMode !== 'browser' || !this.browserEngine) return false;
    return this.browserEngine.setLoopTransport(trackId, config);
  }

  /** Remove a private Browser source-reader override and resume the legacy shared Track bank route. */
  public clearBrowserLoopTransportOverride(trackId: number): boolean {
    if (this.currentMode !== 'browser' || !this.browserEngine) return false;
    return this.browserEngine.clearLoopTransportOverride(trackId);
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
    if (this.currentMode === 'native') return this.nativeEngine.onMonitoringChange(listener);
    const engine = this.browser;
    this.browserMonitoringListeners.add(listener);
    const alreadyBound = this.browserUiBinding?.engine === engine;
    this.ensureBrowserUiBinding();
    if (alreadyBound) listener(engine.monitoringEnabled);
    return () => {
      this.browserMonitoringListeners.delete(listener);
      this.releaseBrowserUiBindingIfUnused();
    };
  }

  public onLatencyInfoChange(listener: (info: LatencyInfo) => void) {
    if (this.currentMode === 'native') {
      return this.nativeEngine.onLatencyInfoChange((info: NativeLatencyInfo) => {
        listener(this.mapNativeLatency(info));
      });
    }

    const engine = this.browser;
    this.browserLatencyListeners.add(listener);
    const alreadyBound = this.browserUiBinding?.engine === engine;
    this.ensureBrowserUiBinding();
    if (alreadyBound) listener(this.mapBrowserLatency(engine.getLatencyInfo()));
    return () => {
      this.browserLatencyListeners.delete(listener);
      this.releaseBrowserUiBindingIfUnused();
    };
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

    const engine = this.browser;
    this.browserStatusListeners.add(listener);
    const alreadyBound = this.browserUiBinding?.engine === engine;
    this.ensureBrowserUiBinding();
    if (alreadyBound) listener(engine.getUiStatus());
    return () => {
      this.browserStatusListeners.delete(listener);
      this.releaseBrowserUiBindingIfUnused();
    };
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

  /** UI metadata only: never infer a committed phrase from selection or input activity. */
  public getTrackHasPhrase(trackId: number): boolean | null {
    if (!this.isTrackAvailable(trackId)) return null;
    if (this.currentMode === 'browser') return this.browser.tracks[trackId - 1]?.hasCommittedPhrase ?? null;
    const state = this.nativeEngine.nativeTrackState(trackId);
    if (state === 'Empty' || state === 'Recording') return false;
    return state === 'Stopped' || state === 'Playing' || state === 'Overdubbing' ? true : null;
  }

  /** Immutable Browser shared-slot configuration, with actual processor readiness. */
  public getBrowserSharedFxSnapshot(path: 'input' | 'track') {
    return this.currentMode === 'browser' ? this.browser.getSharedFxSnapshot(path) : null;
  }

  public getMarkState(trackId: number): TrackMarkState {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || !this.isTrackAvailable(trackId)) {
      return unsupportedTrackMarkState('Select an available track before using MARK.');
    }
    return this.activeEngine.getMarkState(trackId);
  }

  public setMark(trackId: number): Promise<TrackMarkActionResult> { return this.activeEngine.setMark(trackId); }
  public clearMark(trackId: number): Promise<TrackMarkActionResult> { return this.activeEngine.clearMark(trackId); }
  public backToMark(trackId: number): Promise<TrackMarkActionResult> { return this.activeEngine.backToMark(trackId); }

  /** Last acknowledged one-step PCM history for the selected loop. */
  public getTrackHistoryStatus(trackId: number): TrackPcmHistoryStatus {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      return { canUndo: false, canRedo: false, busy: false, unavailableReason: 'Select a valid track.' };
    }
    if (!this.isTrackAvailable(trackId)) {
      return { canUndo: false, canRedo: false, busy: false, unavailableReason: `Track ${trackId} is unavailable in this audio runtime.` };
    }

    if (this.currentMode === 'native') {
      const history = this.nativeEngine.getNativeTrackHistoryStatus(trackId);
      if (!history) {
        return { canUndo: false, canRedo: false, busy: false, unavailableReason: 'Native PCM history status is unavailable from the connected bridge.' };
      }
      const state = this.nativeEngine.nativeTrackState(trackId);
      const busy = state !== 'Empty' && state !== 'Stopped';
      const reason = busy
        ? 'Stop this Native track before using PCM history.'
        : history.unavailableReason !== 'none'
          ? `Native PCM history unavailable: ${history.unavailableReason}.`
          : 'No saved PCM undo/redo step is available for this track.';
      return { canUndo: history.canUndo, canRedo: history.canRedo, busy, unavailableReason: reason };
    }

    const track = this.browser.tracks[trackId - 1];
    if (!track) return { canUndo: false, canRedo: false, busy: false, unavailableReason: `Track ${trackId} is unavailable.` };
    return {
      canUndo: track.canUndo,
      canRedo: track.canRedo,
      busy: track.historyBusy,
      unavailableReason: track.historyUnavailableReason ?? 'No saved PCM undo/redo step is available for this track.',
    };
  }

  public async undoTrack(trackId: number): Promise<boolean> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || !this.isTrackAvailable(trackId)) return false;
    if (this.currentMode === 'native') {
      await this.nativeEngine.undoTrack(trackId);
      return true;
    }
    return this.browser.tracks[trackId - 1]?.undo() ?? false;
  }

  public async redoTrack(trackId: number): Promise<boolean> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || !this.isTrackAvailable(trackId)) return false;
    if (this.currentMode === 'native') {
      await this.nativeEngine.redoTrack(trackId);
      return true;
    }
    return this.browser.tracks[trackId - 1]?.redo() ?? false;
  }

  /** Shared v1 binary project export for Browser and revision-verified Native snapshots. */
  public async exportProjectArchive(name: string): Promise<Uint8Array> {
    return this.currentMode === 'browser'
      ? this.browser.exportProjectArchive(name)
      : this.nativeEngine.exportProjectArchive(name);
  }

  /** Capture operation-start state before any asynchronous project archive read or decode. */
  public async captureProjectRestoreOperationToken(): Promise<ProjectRestoreOperationToken> {
    const mode = this.currentMode;
    const modeGeneration = this.modeGeneration;
    if (mode === 'browser') {
      return Object.freeze({ mode, modeGeneration, browser: this.browser.captureProjectRestoreToken() });
    }

    // Capture app-owned transport before the fresh host request, then verify it
    // remained stable while the authoritative Native content epoch was read.
    // This token is obtained before ProjectMemory reads or decodes the archive.
    const transportMutationRevision = this.nativeEngine.captureProjectTransportMutationRevision();
    const transport = this.captureProjectRestoreTransport();
    const native = await this.nativeEngine.captureProjectRestoreBaseline();
    if (mode !== this.currentMode || modeGeneration !== this.modeGeneration) {
      throw new Error('Project load canceled because the audio mode changed while its Native baseline was being captured; retry in the selected audio mode');
    }
    if (!this.matchesProjectRestoreTransport(transport) ||
        this.nativeEngine.captureProjectTransportMutationRevision() !== transportMutationRevision) {
      throw new Error('Project load canceled because transport changed while the Native content baseline was being captured; retry the load');
    }
    return Object.freeze({
      mode,
      modeGeneration,
      native: Object.freeze({ ...native, transport, projectTransportMutationRevision: transportMutationRevision }),
    });
  }

  /** Restore one validated project archive; Native commits at an audio callback boundary. */
  public async restoreProjectArchive(
    project: ProjectArchive,
    archive: ArrayBuffer | Uint8Array,
    operationToken: ProjectRestoreOperationToken,
  ): Promise<void> {
    if (operationToken.mode !== this.currentMode || operationToken.modeGeneration !== this.modeGeneration) {
      throw new Error('Project load canceled because the audio mode changed while the archive was being read; retry in the selected audio mode');
    }
    if (this.currentMode === 'native') {
      const native = operationToken.native;
      if (!native) throw new Error('Native project load is missing its operation-start host revision guard');
      if (!this.matchesProjectRestoreTransport(native.transport)) {
        throw new Error('Native project load canceled because transport changed while the archive was being read; current PCM and transport were left unchanged. Retry the load');
      }
      await this.nativeEngine.restoreProjectArchive(project, archive, native, () => {
        try {
          return this.currentMode === 'native'
            && this.modeGeneration === operationToken.modeGeneration
            && this.matchesProjectRestoreTransport(native.transport)
            && this.nativeEngine.captureProjectTransportMutationRevision() === native.projectTransportMutationRevision;
        } catch {
          // Treat an exhausted/unknown local revision as stale, so the bridge
          // can cancel while Pending or report the claimed generation rather
          // than losing track of an accepted import.
          return false;
        }
      });
      return;
    }
    if (!operationToken.browser) throw new Error('Browser project load is missing its operation-start revision guard');
    this.browser.restoreProjectArchive(project, archive.byteLength, operationToken.browser);
  }

  private captureProjectRestoreTransport(): NonNullable<ProjectRestoreOperationToken['native']>['transport'] {
    const transport = Transport.getInstance();
    return Object.freeze({
      bpm: transport.bpm,
      state: transport.state,
      masterTrackId: transport.masterTrackId,
      measureLengthSeconds: transport.measureLength,
      masterLoopLengthSamples: transport.masterLoopLengthSamples,
      timeSignatureNumerator: transport.timeSignature[0],
      timeSignatureDenominator: transport.timeSignature[1],
    });
  }

  private matchesProjectRestoreTransport(expected: NonNullable<ProjectRestoreOperationToken['native']>['transport']): boolean {
    const current = this.captureProjectRestoreTransport();
    return current.bpm === expected.bpm
      && current.state === expected.state
      && current.masterTrackId === expected.masterTrackId
      && current.measureLengthSeconds === expected.measureLengthSeconds
      && current.masterLoopLengthSamples === expected.masterLoopLengthSamples
      && current.timeSignatureNumerator === expected.timeSignatureNumerator
      && current.timeSignatureDenominator === expected.timeSignatureDenominator;
  }

  /** Check a Native import generation without uploading or changing the PCM bank again. */
  public async getNativeProjectArchiveImportStatus(generation: number): Promise<NativeProjectImportStatus> {
    if (this.currentMode !== 'native') throw new Error('Native project-import status is only available in Native audio mode.');
    return this.nativeEngine.getProjectArchiveImportStatus(generation);
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
    const engine = this.browser;
    this.browserMidiInputUnsubscribe = engine.onMidiInputStateChange(() => {
      if (this.browserEngine === engine) this.notifyMidiInputStateListenersSafely();
    });
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

  public getNativeCatalogFxParameterSchema(type: string, path: NativeFxPath, trackId = 0, currentParameters: Record<string, number> = {}, slotIndex = 0): NativeFxParameterSchema | null {
    if (this.currentMode !== 'native') return null;
    return this.nativeEngine.getCatalogFxParameterSchema(type, path, trackId, currentParameters, slotIndex);
  }

  public getNativeCatalogFxParameterSnapshot(path: NativeFxPath, slotIndex: number, trackId = 0, overrides?: Record<string, number>): Record<string, number> | null {
    if (this.currentMode !== 'native') return null;
    return this.nativeEngine.getCatalogFxParameterSnapshot(path, slotIndex, trackId, overrides);
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

  private createBrowserUiBinding(engine: BrowserAudioEngine): { engine: BrowserAudioEngine; dispose: () => void } {
    const unsubscribers: Array<() => void> = [];
    try {
      if (this.browserStatusListeners.size) unsubscribers.push(engine.onStatusChange((status) => {
        if (this.browserEngine !== engine) return;
        this.dispatchBrowserListenersSafely(this.browserStatusListeners, status, 'status');
      }));
      if (this.browserMonitoringListeners.size) unsubscribers.push(engine.onMonitoringChange((enabled) => {
        if (this.browserEngine !== engine) return;
        this.dispatchBrowserListenersSafely(this.browserMonitoringListeners, enabled, 'monitoring');
      }));
      if (this.browserLatencyListeners.size) unsubscribers.push(engine.onLatencyInfoChange((info) => {
        if (this.browserEngine !== engine) return;
        try {
          this.dispatchBrowserListenersSafely(this.browserLatencyListeners, this.mapBrowserLatency(info), 'latency');
        } catch (error) {
          console.error('Browser latency mapping failed', error);
        }
      }));
    } catch (error) {
      for (const unsubscribe of unsubscribers) {
        try { unsubscribe(); } catch (cleanupError) { console.error('Browser subscription staging rollback failed', cleanupError); }
      }
      throw error;
    }
    let disposed = false;
    return {
      engine,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const unsubscribe of unsubscribers) {
          try { unsubscribe(); } catch (error) { console.error('Browser subscription cleanup failed', error); }
        }
      },
    };
  }

  private rollbackBrowserRecoveryStaging(
    candidate: BrowserAudioEngine,
    stagedBinding: { engine: BrowserAudioEngine; dispose: () => void } | null,
    stagedMidiUnsubscribe: (() => void) | null,
    oldEngineToRestore: BrowserAudioEngine | null,
    oldHadTransportSubscription: boolean,
  ): void {
    const attempt = (label: string, action: () => void) => {
      try { action(); } catch (error) { console.error(`Browser recovery pre-publication rollback failed: ${label}`, error); }
    };
    attempt('candidate Transport listener', () => candidate.detachTransportBpmChangeSubscription());
    attempt('candidate UI subscriptions', () => stagedBinding?.dispose());
    attempt('candidate MIDI subscription', () => stagedMidiUnsubscribe?.());
    if (oldEngineToRestore && oldHadTransportSubscription) {
      attempt('old Transport listener', () => oldEngineToRestore.attachTransportBpmChangeSubscription());
    }
  }

  private runRecoveryPostCommitCleanup(label: string, action: () => void): void {
    try { action(); } catch (error) { console.error(`Browser recovery committed; ${label} failed`, error); }
  }

  private dispatchBrowserListenersSafely<T>(listeners: Set<(value: T) => void>, value: T, label: string): void {
    for (const listener of [...listeners]) {
      try { listener(value); } catch (error) { console.error(`Browser ${label} listener failed`, error); }
    }
  }

  private ensureBrowserUiBinding(): void {
    const engine = this.browser;
    if (this.browserUiBinding?.engine === engine) return;
    const next = this.createBrowserUiBinding(engine);
    const previous = this.browserUiBinding;
    this.browserUiBinding = next;
    previous?.dispose();
  }

  private releaseBrowserUiBindingIfUnused(): void {
    if (this.browserStatusListeners.size || this.browserMonitoringListeners.size || this.browserLatencyListeners.size
      || this.browserMidiInputUnsubscribe) return;
    this.browserUiBinding?.dispose();
    this.browserUiBinding = null;
  }

  private notifyBrowserUiListeners(engine: BrowserAudioEngine): void {
    try { this.dispatchBrowserListenersSafely(this.browserStatusListeners, engine.getUiStatus(), 'status'); }
    catch (error) { console.error('Browser status snapshot failed after recovery adoption', error); }
    try { this.dispatchBrowserListenersSafely(this.browserMonitoringListeners, engine.monitoringEnabled, 'monitoring'); }
    catch (error) { console.error('Browser monitoring snapshot failed after recovery adoption', error); }
    try { this.dispatchBrowserListenersSafely(this.browserLatencyListeners, this.mapBrowserLatency(engine.getLatencyInfo()), 'latency'); }
    catch (error) { console.error('Browser latency snapshot failed after recovery adoption', error); }
  }

  private notifyMidiInputStateListenersSafely(): void {
    let state: MidiInputState;
    try { state = this.getMidiInputState(); }
    catch (error) {
      console.error('Browser MIDI state snapshot failed after recovery adoption', error);
      return;
    }
    this.dispatchBrowserListenersSafely(this.midiInputListeners, state, 'MIDI state');
  }

  private applyRecoveredBrowserOutputGain(engine: BrowserAudioEngine): void {
    const gain = this.recoveredBrowserOutputGain;
    if (gain === null || this.browserEngine !== engine || engine.context.state !== 'running') return;
    engine.masterGainNode.gain.setValueAtTime(gain, engine.context.currentTime);
    this.recoveredBrowserOutputGain = null;
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
