import {
  serializeNativeFxBankConfiguration,
  validateNativeFxControlEvent,
  type NativeFxBankConfiguration,
  type NativeFxControlEvent,
} from './nativeFxProtocol';

export type NativeBackend = 'WASAPI' | 'ASIO';
export type NativeLooperState = 'Empty' | 'Recording' | 'Stopped' | 'Playing' | 'Overdubbing';

export interface NativeDeviceInfo {
  id: string;
  name: string;
  sampleRates: number[];
  isDefault: boolean;
}

export interface NativeDeviceCatalog {
  ok: boolean;
  backends: NativeBackend[];
  inputsByBackend: Record<string, NativeDeviceInfo[]>;
  outputsByBackend: Record<string, NativeDeviceInfo[]>;
  defaultInputIdByBackend: Record<string, string>;
  defaultOutputIdByBackend: Record<string, string>;
  bufferOptions: number[];
}

export interface NativeStatus {
  ok: boolean;
  bridgeHealthy: boolean;
  engineRunning: boolean;
  softwareOnly?: boolean;
  backend: NativeBackend;
  inputDeviceId: string;
  outputDeviceId: string;
  inputDeviceName: string;
  outputDeviceName: string;
  sampleRate: number;
  bufferFrames: number;
  trackEngineVersion?: number;
  trackCount?: number;
  trackBufferSeconds?: number;
  trackMemoryBudgetBytes?: number;
  trackHistoryBytes?: number;
  nextAudioFrame?: number;
  fxGraphActive?: boolean;
  fxGraphGeneration?: number;
  fxGraphActiveGeneration?: number;
  fxDspFaultCount?: number;
  lastFxDspFaultFrame?: number;
  lastFxDspFaultCode?: number;
  lastFxDspFault?: string;
  tempoBpm?: number;
  tracks?: NativeTrackStatus[];
  monitoringEnabled: boolean;
  state: NativeLooperState;
  inputLatencyMs: number | null;
  outputLatencyMs: number | null;
  roundTripEstimateMs: number | null;
  physicalRoundTripMs: number | null;
  driverReportedStreamLatencyMs: number | null;
  inputLatencySource: string;
  outputLatencySource: string;
  driverReportedStreamLatencySource: string;
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
  lastError: string;
  loopProgress: number;
}

export interface NativeTrackStatus {
  id: number;
  state: NativeLooperState;
  recordedFrames: number;
  loopFrames: number;
  playhead: number;
  progress: number;
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  inputRouted: boolean;
  bufferPrepared: boolean;
}

export interface NativeTrackMixSettings {
  gain: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  inputRouted: boolean;
}

export interface NativeHealth {
  ok: boolean;
  version: string;
  engineRunning: boolean;
  backends: NativeBackend[];
  lastError: string;
}

export interface NativeConfig {
  backend: NativeBackend;
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  bufferFrames: number;
  monitoringEnabled: boolean;
  trackBufferSeconds?: number;
  trackMemoryBudgetBytes?: number;
}

export interface NativeFxCatalogParameter {
  id: number;
  name: string;
  unit: string;
  minimum: number;
  maximum: number;
  defaultValue: number;
  origin: number;
}

export interface NativeFxCatalogEntry {
  ordinal: number;
  id: string;
  displayName: string;
  family: string;
  inputFx: boolean;
  trackFx: boolean;
  processorAvailable: boolean;
  hostRouteable: boolean;
  routeLimitReason: string;
  parameters: NativeFxCatalogParameter[];
}

export interface NativeFxCatalogResponse {
  ok: boolean;
  entries: NativeFxCatalogEntry[];
  error?: string;
}

export interface NativeFxBankResponse {
  ok: boolean;
  configured: boolean;
  configuration: NativeFxBankConfiguration | null;
  stageAccepted: boolean;
  adopted: boolean;
  producerGeneration: number | null;
  activeGeneration: number | null;
  error?: string;
}

export interface NativeFxMutationResponse extends NativeFxBankResponse {
  status?: NativeStatus;
}

export type NativeRhythmSection = 'stopped' | 'intro' | 'A' | 'B' | 'C' | 'D' | 'fill' | 'ending';

export interface NativeRhythmStatus {
  prepared: boolean;
  playing: boolean;
  patternIndex: number | null;
  kitIndex: number | null;
  selectedPatternIndex: number | null;
  selectedKitIndex: number | null;
  variation: number;
  section: NativeRhythmSection;
  tempoPolicy: string;
  loopTempoPolicy?: string;
  requestedBpm: number;
  effectiveBpm: number;
  tempoPending: boolean;
  requestedVolume: number;
  effectiveVolume: number;
  volumePending: boolean;
  barIndex: number;
  absoluteFrame: number;
  lastTriggeredFrame?: number;
  triggerCount: number;
  activeVoices: number;
  queueDepth?: number;
  rejectedCommands: number;
  lateCommands?: number;
  faultCount: number;
  lastFaultFrame?: number;
}

export interface NativeRhythmStatusResponse {
  ok: true;
  rhythm: NativeRhythmStatus;
}

export interface NativeRhythmMutationResponse {
  ok: true;
  accepted: true;
  /** Exact frame accepted by the host; `absoluteFrame` is retained for older snapshots. */
  acceptedFrame: number;
  absoluteFrame?: number;
  applicationBoundary?: string;
  requestedBpm?: number;
  effectiveBpm: number;
  tempoPending: boolean;
  requestedVolume?: number;
  effectiveVolume?: number;
  volumePending?: boolean;
  rhythm: NativeRhythmStatus;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

export class NativeBridgeClient {
  private readonly baseUrl: string;
  private trackEngineVersion = 1;

  constructor(baseUrl = 'http://127.0.0.1:17755') {
    this.baseUrl = baseUrl;
  }

  public async health(): Promise<NativeHealth> {
    return this.request<NativeHealth>('/health');
  }

  public async getDevices(): Promise<NativeDeviceCatalog> {
    return this.request<NativeDeviceCatalog>('/v1/devices');
  }

  public async getStatus(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/status');
  }

  public async getFxCatalog(): Promise<NativeFxCatalogResponse> {
    return this.request<NativeFxCatalogResponse>('/v2/fx/catalog');
  }

  public async getFxBank(): Promise<NativeFxBankResponse> {
    return this.request<NativeFxBankResponse>('/v2/fx/bank');
  }

  public async configureFxBank(configuration: NativeFxBankConfiguration): Promise<NativeFxMutationResponse> {
    const body = serializeNativeFxBankConfiguration(configuration);
    return this.request<NativeFxMutationResponse>('/v2/fx/bank', {
      method: 'PUT',
      body,
    });
  }

  public async postFxParameterEvents(events: NativeFxControlEvent[]): Promise<NativeFxMutationResponse> {
    if (!Array.isArray(events) || events.length === 0 || events.length > 64) {
      throw new RangeError('Native FX parameter event batches must contain 1 through 64 events.');
    }
    for (let index = 0; index < events.length; index += 1) {
      const issues = validateNativeFxControlEvent(events[index]);
      if (issues.length !== 0) {
        const first = issues[0]!;
        throw new TypeError(`Invalid Native FX event at events[${index}].${first.path.slice(2)}: ${first.code}`);
      }
    }
    return this.request<NativeFxMutationResponse>('/v2/fx/parameters', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
  }

  public async postFxMidiEvents(events: Extract<NativeFxControlEvent, { kind: 'midi' }>[]): Promise<NativeFxMutationResponse> {
    if (!Array.isArray(events) || events.length === 0 || events.length > 64) {
      throw new RangeError('Native FX MIDI event batches must contain 1 through 64 events.');
    }
    for (let index = 0; index < events.length; index += 1) {
      const issues = validateNativeFxControlEvent(events[index]);
      if (issues.length !== 0) {
        const first = issues[0]!;
        throw new TypeError(`Invalid Native FX MIDI event at events[${index}].${first.path.slice(2)}: ${first.code}`);
      }
    }
    return this.postFxParameterEvents(events);
  }

  public async postFxSlotMix(
    busIndex: number,
    slotIndex: number,
    mix: number,
    smoothingMs: number,
    absoluteFrame: number,
  ): Promise<NativeFxMutationResponse> {
    if (!Number.isInteger(busIndex) || busIndex < 0 || busIndex > 7 ||
        !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 3 ||
        !Number.isSafeInteger(absoluteFrame) || absoluteFrame < 0 ||
        !Number.isFinite(mix) || mix < 0 || mix > 1 ||
        !Number.isFinite(smoothingMs) || smoothingMs < 0 || smoothingMs > 1000) {
      throw new RangeError('Native FX slot mix event is outside its supported range.');
    }
    return this.request<NativeFxMutationResponse>('/v2/fx/slot-mix', {
      method: 'POST',
      body: JSON.stringify({ busIndex, slotIndex, mix, smoothingMs, absoluteFrame }),
    });
  }

  public async applyConfig(config: NativeConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/config/apply', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async startEngine(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/engine/start', { method: 'POST' });
  }

  public async stopEngine(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/engine/stop', { method: 'POST' });
  }

  public setTrackEngineVersion(version: number | undefined): void {
    this.trackEngineVersion = Number.isInteger(version) && (version as number) >= 2
      ? version as number
      : 1;
  }

  public async record(trackId = 1): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.trackPath(trackId, 'record', '/v1/transport/record'), { method: 'POST' });
  }

  public async stopTransport(trackId = 1): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.trackPath(trackId, 'stop', '/v1/transport/stop'), { method: 'POST' });
  }

  public async play(trackId = 1): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.trackPath(trackId, 'play', '/v1/transport/play'), { method: 'POST' });
  }

  public async toggleOverdub(trackId = 1): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.trackPath(trackId, 'overdub', '/v1/transport/overdub-toggle'), { method: 'POST' });
  }

  public async clear(trackId = 1): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.trackPath(trackId, 'clear', '/v1/transport/clear'), { method: 'POST' });
  }

  public async setTrackInputRoute(trackId: number, enabled: boolean): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.requireV2TrackPath(trackId, 'input-route'), {
      method: 'POST', body: JSON.stringify({ enabled }),
    });
  }

  public async setTrackGain(trackId: number, value: number): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.requireV2TrackPath(trackId, 'gain'), {
      method: 'POST', body: JSON.stringify({ value }),
    });
  }

  public async setTrackPan(trackId: number, value: number): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.requireV2TrackPath(trackId, 'pan'), {
      method: 'POST', body: JSON.stringify({ value }),
    });
  }

  public async setTrackMute(trackId: number, enabled: boolean): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.requireV2TrackPath(trackId, 'mute'), {
      method: 'POST', body: JSON.stringify({ enabled }),
    });
  }

  public async setTrackSolo(trackId: number, enabled: boolean): Promise<NativeStatus> {
    return this.request<NativeStatus>(this.requireV2TrackPath(trackId, 'solo'), {
      method: 'POST', body: JSON.stringify({ enabled }),
    });
  }

  public async setTempo(bpm: number): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v2/tempo', {
      method: 'POST', body: JSON.stringify({ bpm }),
    });
  }

  public async getRhythmStatus(): Promise<NativeRhythmStatus> {
    const response = await this.request<NativeRhythmStatusResponse>('/v2/rhythm/status');
    return response.rhythm;
  }

  public async selectRhythmPatternKit(
    patternIndex: number, kitIndex: number, absoluteFrame?: number,
  ): Promise<NativeRhythmMutationResponse> {
    if (!Number.isInteger(patternIndex) || patternIndex < 0 || patternIndex > 239 ||
        !Number.isInteger(kitIndex) || kitIndex < 0 || kitIndex > 15) {
      throw new RangeError('Native clean-room rhythm selection is outside the 240-pattern/16-kit tables.');
    }
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/pattern-kit', { patternIndex, kitIndex, absoluteFrame });
  }

  public async startRhythm(playIntro = true, absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    if (typeof playIntro !== 'boolean') throw new TypeError('Rhythm playIntro must be a boolean.');
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/start', { playIntro, absoluteFrame });
  }

  public async queueRhythmVariation(variation: number, absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    if (!Number.isInteger(variation) || variation < 0 || variation > 3) {
      throw new RangeError('Native rhythm variation must be an integer from 0 through 3.');
    }
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/variation', { variation, absoluteFrame });
  }

  public async queueRhythmFill(absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/fill', { absoluteFrame });
  }

  public async queueRhythmEnding(absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/ending', { absoluteFrame });
  }

  public async stopRhythm(absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/stop', { absoluteFrame });
  }

  public async setRhythmTempo(bpm: number, absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      throw new RangeError('Native rhythm tempo must be between 20 and 300 BPM.');
    }
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/tempo', { bpm, absoluteFrame });
  }

  public async setRhythmVolume(volume: number, absoluteFrame?: number): Promise<NativeRhythmMutationResponse> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new RangeError('Native rhythm volume must be between 0 and 1.');
    }
    this.validateOptionalRhythmFrame(absoluteFrame);
    return this.postRhythmCommand('/v2/rhythm/volume', { volume, absoluteFrame });
  }

  public async setMonitoring(enabled: boolean): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/monitoring', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  private async request<T extends BridgeResponse>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          'Content-Type': 'application/json',
        },
        ...init,
      });
    } catch (error) {
      const wrappedError = new Error(`Native bridge is unreachable at ${this.baseUrl}.`);
      Object.defineProperty(wrappedError, 'cause', { value: error, configurable: true });
      throw wrappedError;
    }

    const payload = (await response.json()) as T;
    if (!payload.ok) {
      throw new Error(payload.error || 'Native bridge request failed.');
    }
    const trackEngineVersion = (payload as T & { trackEngineVersion?: unknown }).trackEngineVersion;
    if (Number.isInteger(trackEngineVersion)) {
      this.setTrackEngineVersion(trackEngineVersion as number);
    }
    return payload;
  }

  private async postRhythmCommand(
    path: string, body: Record<string, number | boolean | undefined>,
  ): Promise<NativeRhythmMutationResponse> {
    return this.request<NativeRhythmMutationResponse>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private validateOptionalRhythmFrame(absoluteFrame: number | undefined): void {
    if (absoluteFrame !== undefined && (!Number.isSafeInteger(absoluteFrame) || absoluteFrame < 0)) {
      throw new RangeError('Native rhythm frame must be a nonnegative safe integer.');
    }
  }

  private validTrackId(trackId: number): number {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      throw new RangeError('Native track IDs are one-based integers from 1 through 5.');
    }
    return trackId;
  }

  private trackPath(trackId: number, action: string, v1Path: string): string {
    const validId = this.validTrackId(trackId);
    if (this.trackEngineVersion < 2) {
      if (validId !== 1) {
        throw new RangeError('Native bridge v1 exposes only track 1.');
      }
      return v1Path;
    }
    return `/v2/tracks/${validId}/${action}`;
  }

  private requireV2TrackPath(trackId: number, action: string): string {
    const validId = this.validTrackId(trackId);
    if (this.trackEngineVersion < 2) {
      throw new Error('Native track mix controls require a v2 bridge.');
    }
    return `/v2/tracks/${validId}/${action}`;
  }
}
