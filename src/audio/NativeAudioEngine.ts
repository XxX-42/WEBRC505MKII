import { TrackState } from '../core/types';
import type { ProjectFxBank, ProjectFxUnit } from '../project/projectTypes';
import type { FxBankLocation, FxStateSnapshot } from './BrowserAudioEngine';
import {
  NativeBridgeClient,
  type NativeBackend,
  type NativeConfig,
  type NativeDeviceCatalog,
  type NativeDeviceInfo,
  type NativeFxCatalogEntry,
  type NativeRhythmStatus,
  type NativeStatus,
  type NativeTrackMixSettings,
} from './NativeBridgeClient';
import { NativeTrackProxy } from './NativeTrackProxy';
import {
  NATIVE_FX_MAXIMUM_BLOCK_FRAMES,
  NATIVE_FX_SLOTS_PER_BUS,
  validateFxMidiInputEvent,
  type FxMidiInputEvent,
  type NativeFxMidiEvent,
  type NativeFxBankConfiguration,
  type NativeFxBusConfiguration,
  type NativeFxSlotConfiguration,
} from './nativeFxProtocol';
import type { SharedDspFxCatalogEntry } from './sharedDspGraph';
import { createEnabledFxParameters, selectContinuousFxParameter } from './fxParameterControls';
import { NativeRhythmFacade, type NativeRhythmListener } from './NativeRhythmFacade';

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
  physicalRoundTripMs: number | null;
  driverReportedStreamLatencyMs: number | null;
  inputLatencySource: string | null;
  outputLatencySource: string | null;
  driverReportedStreamLatencySource: string | null;
  roundTripLatencyNote: string;
  inputPeak: number;
  outputPeak: number;
  xrunsOrDropouts: number;
  callbackStatusFaults: number;
  inputQueueOverruns: number;
  outputQueueUnderruns: number;
  callbackFrameLimitViolations: number;
  droppedCommands: number;
  outputQueueDepthBlocks: number;
  outputQueueCapacityBlocks: number;
  callbackTicks: number;
  inputCallbackTicks: number;
  outputCallbackTicks: number;
  callbackCountSkew: number;
  fxDspFaultCount: number;
  lastFxDspFaultFrame: number | null;
  lastFxDspFaultCode: number | null;
  lastFxDspFault: string;
  softwareOnly: boolean;
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

const TRACK_STATE_VALUES = Object.values(TrackState);

function emptyFxSlot(): NativeFxSlotConfiguration {
  return { enabled: false, ordinal: 0, mix: 1, smoothingMs: 5, parameters: [] };
}

function emptyFxBank(sampleRateHz: number): NativeFxBankConfiguration {
  const bus = (kind: NativeFxBusConfiguration['kind'], trackIndex?: number): NativeFxBusConfiguration => ({
    kind,
    ...(trackIndex === undefined ? {} : { trackIndex }),
    slots: Array.from({ length: NATIVE_FX_SLOTS_PER_BUS }, emptyFxSlot),
  });
  return {
    sampleRateHz,
    channels: 2,
    maxBlockFrames: NATIVE_FX_MAXIMUM_BLOCK_FRAMES,
    buses: [bus('input'), ...Array.from({ length: 5 }, (_, index) => bus('track', index)), bus('send'), bus('master')],
  };
}

function emptyProjectFxBank(index: number): ProjectFxBank {
  const empty = (): Array<ProjectFxUnit | null> => [null, null, null, null];
  return {
    id: `native-bank-${index + 1}`,
    name: `Native Bank ${index + 1}`,
    input: empty(),
    track: empty(),
    output: empty(),
  };
}

function copyProjectFxBank(source: ProjectFxBank): ProjectFxBank {
  const copyUnits = (items: Array<ProjectFxUnit | null>) => items.map((unit) => unit
    ? { type: unit.type, enabled: unit.enabled, params: { ...unit.params } }
    : null);
  return {
    id: source.id,
    name: source.name,
    input: copyUnits(source.input),
    track: copyUnits(source.track),
    output: copyUnits(source.output),
  };
}

function copyProjectFxUnit(source: ProjectFxUnit): ProjectFxUnit {
  return { type: source.type, enabled: source.enabled, params: { ...source.params } };
}

function copyFxBank(source: NativeFxBankConfiguration): NativeFxBankConfiguration {
  return {
    sampleRateHz: source.sampleRateHz,
    channels: 2,
    maxBlockFrames: NATIVE_FX_MAXIMUM_BLOCK_FRAMES,
    buses: source.buses.map((bus) => ({
      kind: bus.kind,
      ...(bus.trackIndex === undefined ? {} : { trackIndex: bus.trackIndex }),
      slots: bus.slots.map((slot) => ({
        enabled: slot.enabled,
        ordinal: slot.ordinal,
        mix: slot.mix,
        smoothingMs: slot.smoothingMs,
        parameters: slot.parameters.map((parameter) => ({ ...parameter })),
      })),
    })),
  };
}

function fxBusesForLocation(location: FxBankLocation): number[] {
  if (location === 'input') return [0];
  if (location === 'output') return [7];
  return [1, 2, 3, 4, 5];
}

function fxSlotKey(location: FxBankLocation, slotIndex: number): string {
  return `${location}:${slotIndex}`;
}

const PREPARE_TIME_PARAMETER_IDS = new Set([82, 83, 84, 85, 86, 125]);
const NATIVE_FX_BANK_PREFERENCES_KEY = 'nativeFxBanks.v1';

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface StoredNativeFxBankPreferences {
  schemaVersion: 1;
  activeBankId: string;
  banks: ProjectFxBank[];
}

export class NativeAudioEngine {
  private static instance: NativeAudioEngine;

  public readonly tracks: NativeTrackProxy[];
  public readonly nativeRhythm: NativeRhythmFacade;
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
  private readonly fxStateListeners = new Set<(state: FxStateSnapshot) => void>();

  private deviceCatalog: NativeDeviceCatalog | null = null;
  private latestStatus: NativeStatus | null = null;
  private latestStatusReceivedAtMs = 0;
  private bridgeAvailable = false;
  private engineRunning = false;
  private initInFlight: Promise<void> | null = null;
  private pollHandle: number | null = null;
  private rhythmPollHandle: number | null = null;
  private lastError = '';
  private fxCatalog: NativeFxCatalogEntry[] | null = null;
  private fxBanks: ProjectFxBank[] = Array.from({ length: 4 }, (_, index) => emptyProjectFxBank(index));
  private activeFxBankId = 'native-bank-1';
  private fxControlLoaded = false;
  private fxControlError = '';
  private fxControlLoad: Promise<void> | null = null;
  private storedFxBankPreferences: string | null = null;
  private fxBankPreferencesNeedRestore = false;
  private fxBankRestoreInFlight: Promise<void> | null = null;
  private fxBankPreferencesError = '';
  private fxGraphConfigured = false;
  private fxGraphStageAccepted = false;
  private fxGraphAdopted = false;
  private fxGraphProducerGeneration: number | null = null;
  private fxGraphActiveGeneration: number | null = null;
  // This is the latest accepted target configuration. Timestamped parameter
  // events update it only after the Native host admits the complete batch.
  private fxBank: NativeFxBankConfiguration | null = null;
  private readonly rememberedFxSlots = new Map<string, NativeFxSlotConfiguration>();
  private fxMutationTail: Promise<void> = Promise.resolve();

  private constructor() {
    this.sharedBuffer = new SharedArrayBuffer(1024);
    this.nativeRhythm = new NativeRhythmFacade(this.bridge);
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
      roundTripLatencyMs: this.latestStatus?.physicalRoundTripMs ?? null,
      physicalRoundTripMs: this.latestStatus?.physicalRoundTripMs ?? null,
      driverReportedStreamLatencyMs: this.latestStatus?.driverReportedStreamLatencyMs ?? null,
      inputLatencySource: this.latestStatus?.inputLatencySource || null,
      outputLatencySource: this.latestStatus?.outputLatencySource || null,
      driverReportedStreamLatencySource: this.latestStatus?.driverReportedStreamLatencySource || null,
      roundTripLatencyNote: this.latestStatus?.roundTripLatencyNote || 'Physical round-trip latency has not been measured.',
      inputPeak: this.latestStatus?.inputPeak ?? 0,
      outputPeak: this.latestStatus?.outputPeak ?? 0,
      xrunsOrDropouts: this.latestStatus?.xrunsOrDropouts ?? 0,
      callbackStatusFaults: this.latestStatus?.callbackStatusFaults ?? 0,
      inputQueueOverruns: this.latestStatus?.inputQueueOverruns ?? 0,
      outputQueueUnderruns: this.latestStatus?.outputQueueUnderruns ?? 0,
      callbackFrameLimitViolations: this.latestStatus?.callbackFrameLimitViolations ?? 0,
      droppedCommands: this.latestStatus?.droppedCommands ?? 0,
      outputQueueDepthBlocks: this.latestStatus?.outputQueueDepthBlocks ?? 0,
      outputQueueCapacityBlocks: this.latestStatus?.outputQueueCapacityBlocks ?? 0,
      callbackTicks: this.latestStatus?.callbackTicks ?? 0,
      inputCallbackTicks: this.latestStatus?.inputCallbackTicks ?? 0,
      outputCallbackTicks: this.latestStatus?.outputCallbackTicks ?? 0,
      callbackCountSkew: this.latestStatus?.callbackCountSkew ?? 0,
      fxDspFaultCount: this.latestStatus?.fxDspFaultCount ?? 0,
      lastFxDspFaultFrame: this.latestStatus?.lastFxDspFaultFrame ?? null,
      lastFxDspFaultCode: this.latestStatus?.lastFxDspFaultCode ?? null,
      lastFxDspFault: this.latestStatus?.lastFxDspFault ?? 'Ok',
      softwareOnly: this.latestStatus?.softwareOnly ?? false,
      bridgeAvailable: this.bridgeAvailable,
      engineRunning: this.engineRunning,
    };
  }

  public getUiStatus(): NativeUiStatus {
    const reportedError = this.lastError || this.fxBankPreferencesError || this.fxControlError;
    if (!this.bridgeAvailable) {
      return {
        bridgeAvailable: false,
        engineRunning: false,
        ready: false,
        message: 'NATIVE AUDIO UNAVAILABLE',
        lastError: reportedError || 'Start native_bridge_host on http://127.0.0.1:17755.',
      };
    }

    if (!this.engineRunning) {
      return {
        bridgeAvailable: true,
        engineRunning: false,
        ready: false,
        message: 'NATIVE ENGINE STOPPED',
        lastError: reportedError,
      };
    }

    return {
      bridgeAvailable: true,
      engineRunning: true,
      ready: true,
      message: 'NATIVE AUDIO READY',
      lastError: reportedError,
    };
  }

  public isNativeReady() {
    return this.bridgeAvailable && this.engineRunning;
  }

  public isBridgeAvailable() {
    return this.bridgeAvailable;
  }

  public supportsFx() {
    return this.supportsInputFx() || this.supportsTrackFx();
  }

  public supportsInputFx() {
    return this.isNativeReady() && this.fxControlLoaded &&
      (this.fxCatalog?.some((entry) => entry.hostRouteable && entry.processorAvailable && entry.inputFx) ?? false);
  }

  public supportsTrackFx() {
    return this.isNativeReady() && this.fxControlLoaded && this.getSupportedTrackCount() > 0 &&
      (this.fxCatalog?.some((entry) => entry.hostRouteable && entry.processorAvailable && entry.trackFx) ?? false);
  }

  public getFxUnavailableReason(location?: FxBankLocation): string {
    if (!this.isNativeReady()) return 'Native FX requires a ready Native audio host.';
    if (!this.fxControlLoaded) return this.fxControlError || 'Native FX bank control is unavailable.';
    const routeable = this.fxCatalog?.some((entry) => entry.hostRouteable && entry.processorAvailable &&
      (location === 'input' ? entry.inputFx : entry.trackFx)) ?? false;
    if (location && !routeable) return `The Native host has no routeable ${location} FX processors.`;
    if (!routeable) return 'The Native host has no routeable FX processors.';
    return '';
  }

  public getAvailableFxTypes(location?: FxBankLocation): string[] {
    if (!this.fxControlLoaded) return [];
    return (this.fxCatalog ?? [])
      .filter((entry) => entry.hostRouteable && entry.processorAvailable &&
        (location === 'input' ? entry.inputFx : location === 'track' || location === 'output'
          ? entry.trackFx : entry.inputFx || entry.trackFx))
      .map((entry) => `SHARED_DSP_FX_${entry.ordinal}`);
  }

  public getNativeFxCatalog(): NativeFxCatalogEntry[] {
    return (this.fxCatalog ?? []).map((entry) => ({
      ...entry,
      parameters: entry.parameters.map((parameter) => ({ ...parameter })),
    }));
  }

  public getSharedDspFxCatalog(): SharedDspFxCatalogEntry[] {
    if (!this.fxControlLoaded) return [];
    return (this.fxCatalog ?? []).filter((entry) => entry.hostRouteable && entry.processorAvailable).map((entry) => ({
      ordinal: entry.ordinal,
      id: entry.id,
      displayName: entry.displayName,
      family: entry.family,
      officialParametersValidated: false,
      parameters: entry.parameters.map((parameter) => ({
        id: parameter.id,
        name: parameter.name,
        unit: parameter.unit,
        minimum: parameter.minimum,
        maximum: parameter.maximum,
        defaultValue: parameter.defaultValue,
        origin: parameter.origin,
      })),
    }));
  }

  public getFxState(): FxStateSnapshot {
    if (!this.fxControlLoaded) throw new Error(this.getFxUnavailableReason());
    return {
      activeBankId: this.activeFxBankId,
      banks: this.fxBanks.map(copyProjectFxBank),
    };
  }

  public getFxBanks(): ProjectFxBank[] {
    return this.fxBanks.map(copyProjectFxBank);
  }

  public getActiveFxBankId(): string {
    return this.activeFxBankId;
  }

  public getFxGraphStatus(): {
    configured: boolean;
    stageAccepted: boolean;
    adopted: boolean;
    producerGeneration: number | null;
    activeGeneration: number | null;
  } {
    return {
      configured: this.fxGraphConfigured,
      stageAccepted: this.fxGraphStageAccepted,
      adopted: this.fxGraphAdopted,
      producerGeneration: this.fxGraphProducerGeneration,
      activeGeneration: this.fxGraphActiveGeneration,
    };
  }

  public subscribeFxState(listener: (state: FxStateSnapshot) => void): () => void {
    this.fxStateListeners.add(listener);
    if (this.fxControlLoaded) listener(this.getFxState());
    return () => this.fxStateListeners.delete(listener);
  }

  /**
   * Routes a normalized WebMIDI note into each active Native MIDI-capable FX
   * slot. Native HTTP does not share the browser AudioContext clock, so the
   * current host frame is refreshed and the event is queued one 64-frame block
   * ahead. This gives the callback a bounded admission margin; it is not a
   * hardware-timestamp synchronization claim.
   */
  public postFxMidiInput(event: FxMidiInputEvent): Promise<boolean> {
    return this.queueFxMutation(async () => {
      const issues = validateFxMidiInputEvent(event);
      if (issues.length !== 0) {
        const first = issues[0]!;
        throw new TypeError(`Invalid FX MIDI input at ${first.path}: ${first.code}`);
      }
      if (event.channel !== 0) {
        throw new Error('The current Native MIDI FX route accepts channel 1 only; no channel remapping is applied.');
      }
      const state = await this.ensureFxControlState();
      const configuration = state.bank;
      const destinations: Array<{ busIndex: number; slotIndex: number }> = [];
      for (let busIndex = 0; busIndex < configuration.buses.length; busIndex += 1) {
        const bus = configuration.buses[busIndex]!;
        for (let slotIndex = 0; slotIndex < bus.slots.length; slotIndex += 1) {
          const slot = bus.slots[slotIndex]!;
          if (!slot.enabled) continue;
          let acceptsMidi = slot.ordinal === 21;
          if (slot.ordinal === 19) {
            const mode = slot.parameters.find((parameter) => parameter.id === 107)?.value ?? 2;
            acceptsMidi = mode < 1.5;
          }
          if (acceptsMidi) destinations.push({ busIndex, slotIndex });
        }
      }
      if (destinations.length === 0) return false;

      const status = await this.bridge.getStatus();
      this.applyStatus(status);
      const frame = status.nextAudioFrame;
      const sampleRate = status.sampleRate;
      if (!Number.isSafeInteger(frame) || (frame as number) < 0 ||
          !Number.isFinite(sampleRate) || sampleRate < 8000) {
        throw new Error('Native audio frame clock is unavailable for FX MIDI routing.');
      }
      const futureTimestampMs = Math.max(0, event.timestampMs - this.latestStatusReceivedAtMs);
      const absoluteFrame = (frame as number) + NATIVE_FX_MAXIMUM_BLOCK_FRAMES +
        Math.round(futureTimestampMs * sampleRate / 1000);
      if (!Number.isSafeInteger(absoluteFrame)) {
        throw new RangeError('FX MIDI event time exceeds the Native sample-frame clock.');
      }
      const events: NativeFxMidiEvent[] = destinations.map(({ busIndex, slotIndex }) => ({
        kind: 'midi',
        absoluteFrame,
        busIndex,
        slotIndex,
        midiType: event.type,
        channel: event.channel,
        note: event.type === 'AllNotesOff' ? 0 : event.note,
        velocity: event.type === 'NoteOn' ? event.velocity : 0,
      }));
      const response = await this.bridge.postFxMidiEvents(events);
      if (!response.ok) throw new Error(response.error || 'Native FX MIDI event batch was rejected.');
      if (response.configuration) this.fxBank = copyFxBank(response.configuration);
      this.fxGraphActiveGeneration = response.activeGeneration;
      this.fxGraphProducerGeneration = response.producerGeneration;
      this.fxGraphAdopted = response.adopted;
      this.fxGraphStageAccepted = response.stageAccepted;
      return true;
    });
  }

  public async selectFxBank(id: string): Promise<void> {
    return this.queueFxMutation(async () => {
      const state = await this.ensureFxControlState();
      const candidate = state.banks.find((bank) => bank.id === id);
      if (!candidate) throw new RangeError(`Native FX bank ${id} does not exist.`);
      if (id === this.activeFxBankId) return;
      await this.stageProjectBank(candidate);
      this.activeFxBankId = id;
      this.saveFxBankPreferences();
      this.emitFxState();
    });
  }

  public async updateFxBankSlot(location: FxBankLocation, index: number, slot: ProjectFxUnit | null): Promise<void> {
    return this.queueFxMutation(async () => {
      this.validateFxAddress(location, index);
      const state = await this.ensureFxControlState();
      const bankIndex = state.banks.findIndex((bank) => bank.id === this.activeFxBankId);
      if (bankIndex < 0) throw new Error(`Active Native FX bank ${this.activeFxBankId} is missing.`);
      const candidateBanks = state.banks.map(copyProjectFxBank);
      const active = candidateBanks[bankIndex]!;
      const normalized = this.validateProjectFxSlot(slot, location, state.catalog);
      const previous = active[location][index] ?? null;
      if ((!previous || !previous.enabled) && (!normalized || !normalized.enabled) &&
          JSON.stringify(previous) === JSON.stringify(normalized)) return;
      active[location][index] = normalized;

      if ((!previous || !previous.enabled) && (!normalized || !normalized.enabled)) {
        this.fxBanks = candidateBanks;
        this.saveFxBankPreferences();
        if (normalized) this.rememberedFxSlots.set(fxSlotKey(location, index), this.toNativeSlot(normalized, state.catalog, location));
        else this.rememberedFxSlots.delete(fxSlotKey(location, index));
        this.emitFxState();
        return;
      }

      if (this.canPostFxParameterDiff(previous, normalized, location, index, state.catalog)) {
        const events = this.buildParameterDiffEvents(previous!, normalized!, location, index, state.catalog);
        if (events.length > 0) await this.postFxParameterDiff(events);
        this.fxBanks = candidateBanks;
        const nativeConfig = this.buildNativeBankConfiguration(active);
        this.fxBank = nativeConfig;
      } else {
        await this.stageProjectBank(active);
        this.fxBanks = candidateBanks;
      }
      const committed = active[location][index];
      this.saveFxBankPreferences();
      if (committed) this.rememberedFxSlots.set(fxSlotKey(location, index), this.toNativeSlot(committed, state.catalog, location));
      else this.rememberedFxSlots.delete(fxSlotKey(location, index));
      this.emitFxState();
    });
  }

  public async setTrackFxSend(trackId: number, enabled: boolean): Promise<void> {
    if (!this.isTrackAvailable(trackId)) throw new RangeError(`Native track ${trackId} is unavailable.`);
    return this.queueFxMutation(async () => {
      const state = await this.ensureFxControlState();
      const track = this.tracks[trackId - 1]!;
      const current = track.track.fxSw === 'ON';
      if (current === enabled) return;
      const bank = state.banks.find((candidate) => candidate.id === this.activeFxBankId);
      if (!bank) throw new Error(`Active Native FX bank ${this.activeFxBankId} is missing.`);
      await this.stageProjectBank(bank, { trackId, enabled });
      track.track.fxSw = enabled ? 'ON' : 'OFF';
      this.emitFxState();
    });
  }

  public supportsRhythm() {
    return this.engineRunning && this.nativeRhythm.isAvailable;
  }

  public getRhythmStatus(): NativeRhythmStatus | null {
    return this.nativeRhythm.status;
  }

  public getRhythmUnavailableReason(): string {
    if (!this.engineRunning) return 'NATIVE AUDIO HOST IS NOT RUNNING';
    return this.nativeRhythm.unavailableReason;
  }

  public subscribeRhythmStatus(listener: NativeRhythmListener): () => void {
    return this.nativeRhythm.subscribe(listener);
  }

  public async refreshRhythmStatus(): Promise<NativeRhythmStatus | null> {
    return this.nativeRhythm.refresh();
  }

  public supportsReverse() {
    return false;
  }

  public isTrackAvailable(trackId: number) {
    return Number.isInteger(trackId) && trackId >= 1 && trackId <= this.getSupportedTrackCount();
  }

  public getSupportedTrackCount() {
    const reported = this.latestStatus?.trackCount;
    // A bridge that predates the versioned track status still exposes the
    // original single-track v1 endpoints. Keep that route usable until the
    // current host reports its explicit five-track capability.
    return Number.isInteger(reported) ? Math.max(0, Math.min(5, reported as number)) : 1;
  }

  public getTrackEngineVersion() {
    const reported = this.latestStatus?.trackEngineVersion;
    return Number.isInteger(reported) && (reported as number) >= 1 ? reported as number : 1;
  }

  public supportsNativeTrackMix() {
    return this.getTrackEngineVersion() >= 2;
  }

  public async recordTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.record(trackId));
  }

  public async stopTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.stopTransport(trackId));
  }

  public async playTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.play(trackId));
  }

  public async toggleOverdub(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.toggleOverdub(trackId));
  }

  public async clearTrack(trackId = 1) {
    await this.dispatchStatusRequest(() => this.bridge.clear(trackId));
  }

  public async updateNativeTrackSettings(trackId: number, settings: NativeTrackMixSettings): Promise<void> {
    if (!this.supportsNativeTrackMix() || !this.isTrackAvailable(trackId)) {
      throw new Error(`Native track mix controls are unavailable for track ${trackId}.`);
    }
    if (!Number.isFinite(settings.gain) || settings.gain < 0 || settings.gain > 2 ||
        !Number.isFinite(settings.pan) || settings.pan < -1 || settings.pan > 1) {
      throw new RangeError('Native track gain and pan must be within their supported ranges.');
    }
    try {
      // Each request is independently queued by the host. Keep the controls
      // ordered, but do not imply an atomic sample boundary across HTTP calls.
      await this.bridge.setTrackGain(trackId, settings.gain);
      await this.bridge.setTrackPan(trackId, settings.pan);
      await this.bridge.setTrackMute(trackId, settings.muted);
      await this.bridge.setTrackSolo(trackId, settings.solo);
      const status = await this.bridge.setTrackInputRoute(trackId, settings.inputRouted);
      this.applyStatus(status);
    } catch (error) {
      this.handleBridgeFailure(error, false);
      throw error;
    }
  }

  public async stopAllTracks(): Promise<void> {
    await Promise.all(this.tracks.filter((track) => track.isAvailable).map((track) => this.stopTrack(track.trackId)));
  }

  public async playAllTracks(): Promise<void> {
    await Promise.all(this.tracks.filter((track) => track.isAvailable).map((track) => this.playTrack(track.trackId)));
  }

  public setFxType(location: 'input' | 'track', slotIndex: number, type: string): Promise<void> {
    this.validateFxAddress(location, slotIndex);
    if (type.trim() === '' || type.trim().toUpperCase() === 'NONE') {
      return this.updateFxBankSlot(location, slotIndex, null);
    }
    const entry = this.resolveFxEntry(type, location, this.fxCatalog ?? []);
    const unit: ProjectFxUnit = {
      type: `SHARED_DSP_FX_${entry.ordinal}`,
      enabled: true,
      params: createEnabledFxParameters(entry.parameters),
    };
    return this.updateFxBankSlot(location, slotIndex, unit);
  }

  public setFxParam(location: 'input' | 'track', slotIndex: number, value: number): Promise<void> {
    this.validateFxAddress(location, slotIndex);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return Promise.reject(new RangeError('Native FX primary control must be between 0 and 100.'));
    }
    const state = this.getFxState();
    const bank = state.banks.find((candidate) => candidate.id === this.activeFxBankId)!;
    const current = bank[location][slotIndex];
    if (!current) return Promise.reject(new Error(`Native FX ${location} slot ${slotIndex + 1} has no configured processor.`));
    const entry = this.resolveFxEntry(current.type, location, this.fxCatalog ?? []);
    const parameter = selectContinuousFxParameter(entry.parameters);
    if (!parameter) return Promise.reject(new Error(`Native FX ${entry.displayName} has no continuous primary control.`));
    const next = copyProjectFxUnit(current);
    next.params[String(parameter.id)] = parameter.minimum +
      (parameter.maximum - parameter.minimum) * (value / 100);
    return this.updateFxBankSlot(location, slotIndex, next);
  }

  public setFxActive(location: 'input' | 'track', slotIndex: number, active: boolean): Promise<void> {
    this.validateFxAddress(location, slotIndex);
    const state = this.getFxState();
    const bank = state.banks.find((candidate) => candidate.id === this.activeFxBankId)!;
    const current = bank[location][slotIndex];
    if (!current) return Promise.reject(new Error(`Choose a supported Native FX type for ${location} slot ${slotIndex + 1} before activating it.`));
    if (current.enabled === active) return Promise.resolve();
    return this.updateFxBankSlot(location, slotIndex, { ...copyProjectFxUnit(current), enabled: active });
  }
  private queueFxMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fxMutationTail.catch(() => undefined).then(operation);
    this.fxMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private validateFxAddress(location: FxBankLocation, index: number): void {
    if (location !== 'input' && location !== 'track' && location !== 'output') {
      throw new TypeError(`Invalid Native FX bank location: ${String(location)}.`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= NATIVE_FX_SLOTS_PER_BUS) {
      throw new RangeError('Native FX slot index must be from 0 through 3.');
    }
  }

  private async ensureFxControlState(): Promise<{
    catalog: NativeFxCatalogEntry[];
    bank: NativeFxBankConfiguration;
    banks: ProjectFxBank[];
  }> {
    if (!this.isNativeReady()) throw new Error('Native FX controls require a ready Native audio host.');
    if (this.fxControlLoaded && this.fxCatalog && this.fxBank) {
      await this.restoreSavedFxBankIfNeeded();
      return { catalog: this.fxCatalog, bank: this.fxBank, banks: this.fxBanks };
    }
    if (!this.fxControlLoad) {
      this.fxControlLoad = (async () => {
        try {
          const [catalogResponse, bankResponse] = await Promise.all([
            this.bridge.getFxCatalog(),
            this.bridge.getFxBank(),
          ]);
          if (!Array.isArray(catalogResponse.entries) || catalogResponse.entries.some((entry) =>
            !Number.isInteger(entry.ordinal) || !Array.isArray(entry.parameters))) {
            throw new TypeError('Native FX catalog response has an invalid schema.');
          }
          this.fxCatalog = catalogResponse.entries.map((entry) => ({
            ...entry,
            parameters: entry.parameters.map((parameter) => ({ ...parameter })),
          }));
          const savedPreferences = this.readSavedFxBankPreferences(this.fxCatalog);
          this.fxGraphConfigured = bankResponse.configured === true;
          this.fxGraphStageAccepted = bankResponse.stageAccepted === true;
          this.fxGraphAdopted = bankResponse.adopted === true;
          this.fxGraphProducerGeneration = bankResponse.producerGeneration ?? null;
          this.fxGraphActiveGeneration = bankResponse.activeGeneration ?? null;
          if (bankResponse.configured && bankResponse.configuration) {
            const initial = copyFxBank(bankResponse.configuration);
            this.fxBank = initial;
            if (savedPreferences) {
              this.fxBanks = savedPreferences.banks;
              this.activeFxBankId = savedPreferences.activeBankId;
              this.fxBankPreferencesNeedRestore = true;
            } else {
              this.fxBanks = this.fxBanks.map((bank, index) => index === 0
                ? this.projectBankFromConfiguration(initial, this.fxCatalog!, bank.id, bank.name)
                : bank);
            }
          } else {
            this.fxBank = emptyFxBank(this.latestStatus?.sampleRate ?? this.selectedSampleRate);
            if (savedPreferences) {
              this.fxBanks = savedPreferences.banks;
              this.activeFxBankId = savedPreferences.activeBankId;
              this.fxBankPreferencesNeedRestore = true;
            }
          }
          this.fxControlLoaded = true;
          this.fxControlError = this.fxBankPreferencesError;
          if (bankResponse.configured && bankResponse.configuration &&
              this.storedFxBankPreferences === null && !savedPreferences) {
            this.saveFxBankPreferences();
          }
          if (!this.fxBankPreferencesNeedRestore) this.emitFxState();
        } catch (error) {
          this.fxControlLoaded = false;
          this.fxControlError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          this.fxControlLoad = null;
        }
      })();
    }
    await this.fxControlLoad;
    if (!this.fxCatalog || !this.fxBank) throw new Error(this.fxControlError || 'Native FX state is unavailable.');
    await this.restoreSavedFxBankIfNeeded();
    return { catalog: this.fxCatalog, bank: this.fxBank, banks: this.fxBanks };
  }

  private readSavedFxBankPreferences(catalog: NativeFxCatalogEntry[]): StoredNativeFxBankPreferences | null {
    this.fxBankPreferencesError = '';
    const serialized = this.storedFxBankPreferences;
    if (serialized === null) return null;
    try {
      const value: unknown = JSON.parse(serialized);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('saved bank record is not an object');
      const record = value as Record<string, unknown>;
      if (record.schemaVersion !== 1 || typeof record.activeBankId !== 'string' ||
          !Array.isArray(record.banks) || record.banks.length !== 4) {
        throw new TypeError('saved bank record has an unsupported schema');
      }
      const banks: ProjectFxBank[] = [];
      for (let bankIndex = 0; bankIndex < 4; bankIndex += 1) {
        if (!Object.prototype.hasOwnProperty.call(record.banks, bankIndex))
          throw new TypeError('saved bank list is sparse');
        const candidate = record.banks[bankIndex];
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
          throw new TypeError(`saved bank ${bankIndex + 1} is malformed`);
        const source = candidate as Record<string, unknown>;
        const expectedId = `native-bank-${bankIndex + 1}`;
        if (source.id !== expectedId || typeof source.name !== 'string' ||
            source.name.trim().length === 0 || source.name.length > 256) {
          throw new TypeError(`saved bank ${bankIndex + 1} has an invalid identity or name`);
        }
        const readSlots = (location: FxBankLocation): Array<ProjectFxUnit | null> => {
          const slots = source[location];
          if (!Array.isArray(slots) || slots.length !== NATIVE_FX_SLOTS_PER_BUS)
            throw new TypeError(`saved bank ${bankIndex + 1} ${location} slots are malformed`);
          const result: Array<ProjectFxUnit | null> = [];
          for (let slotIndex = 0; slotIndex < NATIVE_FX_SLOTS_PER_BUS; slotIndex += 1) {
            if (!Object.prototype.hasOwnProperty.call(slots, slotIndex))
              throw new TypeError(`saved bank ${bankIndex + 1} ${location} slots are sparse`);
            const unit = slots[slotIndex];
            if (unit === null) result.push(null);
            else {
              if (!unit || typeof unit !== 'object' || Array.isArray(unit))
                throw new TypeError(`saved bank ${bankIndex + 1} ${location} slot ${slotIndex + 1} is malformed`);
              const candidateUnit = unit as ProjectFxUnit;
              if (!candidateUnit.params || typeof candidateUnit.params !== 'object' ||
                  Array.isArray(candidateUnit.params)) {
                throw new TypeError(`saved bank ${bankIndex + 1} ${location} slot ${slotIndex + 1} has malformed parameters`);
              }
              result.push(this.validateProjectFxSlot(candidateUnit, location, catalog));
            }
          }
          return result;
        };
        banks.push({
          id: expectedId,
          name: source.name,
          input: readSlots('input'),
          track: readSlots('track'),
          output: readSlots('output'),
        });
      }
      if (!banks.some((bank) => bank.id === record.activeBankId))
        throw new TypeError('saved active bank does not exist');
      return { schemaVersion: 1, activeBankId: record.activeBankId, banks };
    } catch (error) {
      this.fxBankPreferencesError = `Saved Native FX banks were ignored: ${error instanceof Error ? error.message : String(error)}.`;
      return null;
    }
  }

  private async restoreSavedFxBankIfNeeded(): Promise<void> {
    if (!this.fxBankPreferencesNeedRestore) return;
    if (!this.fxBankRestoreInFlight) {
      this.fxBankRestoreInFlight = (async () => {
        try {
          const activeBank = this.fxBanks.find((bank) => bank.id === this.activeFxBankId);
          if (!activeBank) throw new Error(`Saved active Native FX bank ${this.activeFxBankId} is missing.`);
          await this.stageProjectBank(activeBank);
          this.fxBankPreferencesNeedRestore = false;
          this.fxBankPreferencesError = '';
          this.emitFxState();
        } catch (error) {
          this.fxControlLoaded = false;
          this.fxControlError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          this.fxBankRestoreInFlight = null;
        }
      })();
    }
    await this.fxBankRestoreInFlight;
  }

  private saveFxBankPreferences(): void {
    const record: StoredNativeFxBankPreferences = {
      schemaVersion: 1,
      activeBankId: this.activeFxBankId,
      banks: this.fxBanks.map(copyProjectFxBank),
    };
    const previousPreferencesError = this.fxBankPreferencesError;
    try {
      const serialized = JSON.stringify(record);
      localStorage.setItem(NATIVE_FX_BANK_PREFERENCES_KEY, serialized);
      this.storedFxBankPreferences = serialized;
      this.fxBankPreferencesError = '';
      this.fxControlError = '';
      if (this.lastError === previousPreferencesError) this.lastError = '';
    } catch (error) {
      this.fxBankPreferencesError = `Native FX changes were accepted but could not be saved: ${error instanceof Error ? error.message : String(error)}.`;
      this.fxControlError = this.fxBankPreferencesError;
      this.lastError = this.fxBankPreferencesError;
      this.emitAll();
    }
  }

  private async refreshFxControlState(): Promise<void> {
    try {
      await this.ensureFxControlState();
    } catch (error) {
      this.fxControlError = error instanceof Error ? error.message : String(error);
      this.fxControlLoaded = false;
    }
  }

  private emitFxState(): void {
    if (!this.fxControlLoaded) return;
    const snapshot = this.getFxState();
    this.fxStateListeners.forEach((listener) => listener(snapshot));
  }

  private resolveFxEntry(type: string, location: FxBankLocation, catalog: NativeFxCatalogEntry[]): NativeFxCatalogEntry {
    const normalized = type.trim().toUpperCase();
    const match = /^SHARED_DSP_FX_(\d+)$/.exec(normalized);
    const entry = catalog.find((candidate) => match
      ? candidate.ordinal === Number(match[1])
      : candidate.id.toUpperCase() === normalized || candidate.displayName.toUpperCase() === normalized);
    const canRoute = entry && (location === 'input' ? entry.inputFx : entry.trackFx);
    if (!entry || !entry.processorAvailable || !entry.hostRouteable || !canRoute) {
      const reason = entry?.routeLimitReason ? ` ${entry.routeLimitReason}` : '';
      throw new TypeError(`Native FX type ${type} is not routeable at ${location}.${reason}`);
    }
    return entry;
  }

  private validateProjectFxSlot(
    unit: ProjectFxUnit | null,
    location: FxBankLocation,
    catalog: NativeFxCatalogEntry[],
  ): ProjectFxUnit | null {
    if (unit === null) return null;
    if (!unit || typeof unit.type !== 'string' || typeof unit.enabled !== 'boolean' ||
        typeof unit.params !== 'object' || unit.params === null || Array.isArray(unit.params)) {
      throw new TypeError('Native FX slot must contain a type, enabled flag and parameter map.');
    }
    const entry = this.resolveFxEntry(unit.type, location, catalog);
    const known = new Map(entry.parameters.map((parameter) => [parameter.id, parameter]));
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries(unit.params)) {
      const id = Number(key);
      const descriptor = known.get(id);
      if (!Number.isInteger(id) || String(id) !== key || !descriptor ||
          !Number.isFinite(value) || value < descriptor.minimum || value > descriptor.maximum) {
        throw new RangeError(`Native FX ${entry.displayName} parameter ${key} is unknown or outside its safe range.`);
      }
      params[key] = value;
    }
    return { type: `SHARED_DSP_FX_${entry.ordinal}`, enabled: unit.enabled, params };
  }

  private toNativeSlot(unit: ProjectFxUnit, catalog: NativeFxCatalogEntry[], location: FxBankLocation): NativeFxSlotConfiguration {
    if (!unit.enabled) return emptyFxSlot();
    const entry = this.resolveFxEntry(unit.type, location, catalog);
    const values = new Map<number, number>(entry.parameters.map((parameter) => [parameter.id, parameter.defaultValue]));
    for (const [key, value] of Object.entries(unit.params)) values.set(Number(key), value);
    return {
      enabled: true,
      ordinal: entry.ordinal,
      mix: 1,
      smoothingMs: 5,
      parameters: entry.parameters.map((parameter) => ({ id: parameter.id, value: values.get(parameter.id)! })),
    };
  }

  private buildNativeBankConfiguration(
    bank: ProjectFxBank,
    trackSendOverride?: { trackId: number; enabled: boolean },
  ): NativeFxBankConfiguration {
    const sampleRate = this.latestStatus?.sampleRate ?? this.selectedSampleRate;
    const configuration = emptyFxBank(sampleRate);
    const catalog = this.fxCatalog ?? [];
    const setSlots = (busIndex: number, units: Array<ProjectFxUnit | null>, location: FxBankLocation, enabled = true) => {
      if (!enabled) return;
      for (let slotIndex = 0; slotIndex < NATIVE_FX_SLOTS_PER_BUS; slotIndex += 1) {
        const unit = units[slotIndex] ?? null;
        if (unit?.enabled) configuration.buses[busIndex]!.slots[slotIndex] = this.toNativeSlot(unit, catalog, location);
      }
    };
    setSlots(0, bank.input, 'input');
    for (let trackIndex = 0; trackIndex < 5; trackIndex += 1) {
      const trackId = trackIndex + 1;
      const currentlyEnabled = this.tracks[trackIndex]?.track.fxSw === 'ON';
      const sendEnabled = trackSendOverride?.trackId === trackId ? trackSendOverride.enabled : currentlyEnabled;
      setSlots(trackIndex + 1, bank.track, 'track', sendEnabled && this.isTrackAvailable(trackId));
    }
    setSlots(7, bank.output, 'output');
    return configuration;
  }

  private projectBankFromConfiguration(
    configuration: NativeFxBankConfiguration,
    catalog: NativeFxCatalogEntry[],
    id: string,
    name: string,
  ): ProjectFxBank {
    const fromBus = (busIndex: number): Array<ProjectFxUnit | null> =>
      configuration.buses[busIndex]!.slots.map((slot) => {
        if (!slot.enabled) return null;
        const entry = catalog.find((candidate) => candidate.ordinal === slot.ordinal);
        if (!entry) return null;
        return {
          type: `SHARED_DSP_FX_${entry.ordinal}`,
          enabled: true,
          params: Object.fromEntries(slot.parameters.map((parameter) => [String(parameter.id), parameter.value])),
        };
      });
    return {
      id,
      name,
      input: fromBus(0),
      track: fromBus(1),
      output: fromBus(7),
    };
  }

  private async stageProjectBank(
    bank: ProjectFxBank,
    trackSendOverride?: { trackId: number; enabled: boolean },
  ): Promise<void> {
    await this.stageFxBank(this.buildNativeBankConfiguration(bank, trackSendOverride));
  }

  private async stageFxBank(configuration: NativeFxBankConfiguration): Promise<void> {
    const response = await this.bridge.configureFxBank(configuration);
    if (!response.stageAccepted) throw new Error(response.error || 'Native FX graph was not accepted for staging.');
    this.fxBank = response.configuration ? copyFxBank(response.configuration) : copyFxBank(configuration);
    this.fxGraphConfigured = true;
    this.fxGraphStageAccepted = true;
    this.fxGraphAdopted = response.adopted;
    this.fxGraphProducerGeneration = response.producerGeneration;
    this.fxGraphActiveGeneration = response.activeGeneration;
  }

  private canPostFxParameterDiff(
    previous: ProjectFxUnit | null,
    next: ProjectFxUnit | null,
    location: FxBankLocation,
    slotIndex: number,
    catalog: NativeFxCatalogEntry[],
  ): boolean {
    if (!previous || !next || !previous.enabled || !next.enabled || previous.type !== next.type) return false;
    const entry = this.resolveFxEntry(next.type, location, catalog);
    const ids = new Set([...Object.keys(previous.params), ...Object.keys(next.params)]);
    const changed = [...ids].filter((id) => previous.params[id] !== next.params[id]);
    if (changed.length === 0) return true;
    if (changed.some((id) => PREPARE_TIME_PARAMETER_IDS.has(Number(id)))) return false;
    if (entry.ordinal === 19 && changed.includes('107')) return false;
    const busCount = location === 'track'
      ? this.tracks.filter((track) => this.isTrackAvailable(track.trackId) && track.track.fxSw === 'ON').length
      : 1;
    return changed.every((id) => entry.parameters.some((parameter) => String(parameter.id) === id)) &&
      changed.length * busCount <= 64 && slotIndex >= 0;
  }

  private buildParameterDiffEvents(
    previous: ProjectFxUnit,
    next: ProjectFxUnit,
    location: FxBankLocation,
    slotIndex: number,
    catalog: NativeFxCatalogEntry[],
  ): Array<{ absoluteFrame: number; busIndex: number; slotIndex: number; parameterId: number; value: number }> {
    const entry = this.resolveFxEntry(next.type, location, catalog);
    const changedIds = [...new Set([...Object.keys(previous.params), ...Object.keys(next.params)])]
      .filter((id) => previous.params[id] !== next.params[id]);
    const buses = fxBusesForLocation(location).filter((bus) => location !== 'track' ||
      (this.isTrackAvailable(bus) && this.tracks[bus - 1]?.track.fxSw === 'ON'));
    return buses.flatMap((busIndex) => changedIds.map((id) => {
      const descriptor = entry.parameters.find((parameter) => String(parameter.id) === id);
      if (!descriptor) throw new TypeError(`Native FX parameter ${id} is not in the current catalog.`);
      const value = next.params[id] ?? descriptor.defaultValue;
      return {
        absoluteFrame: this.requireFxEventFrame(),
        busIndex,
        slotIndex,
        parameterId: descriptor.id,
        value,
      };
    }));
  }

  private requireFxEventFrame(): number {
    const frame = this.latestStatus?.nextAudioFrame;
    if (!Number.isSafeInteger(frame) || (frame as number) < 0) {
      throw new Error('Native FX event clock is unavailable; refresh Native engine status before changing a parameter.');
    }
    return frame as number;
  }

  private async postFxParameterDiff(
    events: Array<{ absoluteFrame: number; busIndex: number; slotIndex: number; parameterId: number; value: number }>,
  ): Promise<void> {
    this.requireFxEventFrame();
    const response = await this.bridge.postFxParameterEvents(events);
    if (!response.ok) throw new Error(response.error || 'Native FX parameter event batch was rejected.');
    if (response.configuration) this.fxBank = copyFxBank(response.configuration);
    this.fxGraphActiveGeneration = response.activeGeneration;
    this.fxGraphProducerGeneration = response.producerGeneration;
    this.fxGraphAdopted = response.adopted;
    this.fxGraphStageAccepted = response.stageAccepted;
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
      await this.refreshRhythmStatus();
      await this.refreshFxControlState();
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
      trackBufferSeconds: 60,
    };
  }

  private async applyAndStart() {
    this.tracks.forEach((track) => track.clearPendingSettings());
    if (!this.deviceCatalog) {
      await this.refreshCatalog();
    }

    try {
      const applied = await this.bridge.applyConfig(this.currentConfig());
      this.applyStatus(applied);
      const started = await this.bridge.startEngine();
      this.applyStatus(started);
      if (this.fxControlLoaded) {
        const activeBank = this.fxBanks.find((bank) => bank.id === this.activeFxBankId);
        if (activeBank) {
          try {
            await this.stageProjectBank(activeBank);
            this.fxControlError = '';
          } catch (error) {
            this.fxControlLoaded = false;
            this.fxControlError = error instanceof Error ? error.message : String(error);
          }
        }
      }
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
    this.latestStatusReceivedAtMs = monotonicNowMs();
    if (Number.isSafeInteger(status.fxGraphGeneration) &&
        Number.isSafeInteger(status.fxGraphActiveGeneration) &&
        typeof status.fxGraphActive === 'boolean') {
      this.fxGraphProducerGeneration = status.fxGraphGeneration!;
      this.fxGraphActiveGeneration = status.fxGraphActiveGeneration! > 0
        ? status.fxGraphActiveGeneration! : null;
      this.fxGraphStageAccepted = status.fxGraphGeneration! > 0;
      this.fxGraphConfigured = this.fxGraphStageAccepted;
      this.fxGraphAdopted = this.fxGraphStageAccepted && status.fxGraphActive &&
        status.fxGraphActiveGeneration === status.fxGraphGeneration;
    }
    this.bridge.setTrackEngineVersion(status.trackEngineVersion);
    if (!status.engineRunning || (Number.isInteger(status.trackCount) && status.trackCount === 0) ||
        this.getTrackEngineVersion() < 2) {
      this.tracks.forEach((track) => track.clearPendingSettings());
    }
    this.bridgeAvailable = true;
    this.engineRunning = status.engineRunning;
    if (!this.engineRunning) this.nativeRhythm.clear('NATIVE AUDIO HOST IS NOT RUNNING');
    this.monitoringEnabled = status.monitoringEnabled;
    this.selectedBackend = status.backend;
    this.selectedInputDeviceId = status.inputDeviceId || this.selectedInputDeviceId;
    this.selectedOutputDeviceId = status.outputDeviceId || this.selectedOutputDeviceId;
    this.selectedSampleRate = status.sampleRate || this.selectedSampleRate;
    this.selectedBufferFrames = status.bufferFrames || this.selectedBufferFrames;
    this.lastError = status.lastError || '';

    const nativeTracks = status.tracks ?? [];
    if (nativeTracks.length > 0) {
      for (const track of this.tracks) {
        const nativeTrack = nativeTracks.find((candidate) => candidate.id === track.trackId);
        if (nativeTrack) track.syncNativeState(nativeTrack.state, nativeTrack.progress, nativeTrack);
        else track.resetTelemetry();
      }
    } else {
      this.tracks[0]?.syncNativeState(status.state, status.loopProgress);
      for (let index = 1; index < this.tracks.length; index += 1) this.tracks[index]?.resetTelemetry();
    }

    this.emitAll();
  }

  private handleBridgeFailure(error: unknown, markBridgeMissing = true) {
    if (markBridgeMissing) {
      this.bridgeAvailable = false;
      this.engineRunning = false;
      this.stopPolling();
      this.latestStatus = null;
      this.monitoringEnabled = false;
      this.nativeRhythm.clear('Native bridge is unavailable.');
      this.resetAllTrackTelemetry();
    }

    this.lastError = error instanceof Error ? error.message : String(error);
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
    if (this.rhythmPollHandle === null) {
      this.rhythmPollHandle = window.setInterval(() => {
        if (this.bridgeAvailable && this.engineRunning) void this.refreshRhythmStatus();
      }, 500);
    }
  }

  private stopPolling() {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.rhythmPollHandle !== null) {
      clearInterval(this.rhythmPollHandle);
      this.rhythmPollHandle = null;
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
    this.storedFxBankPreferences = localStorage.getItem(NATIVE_FX_BANK_PREFERENCES_KEY);
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
