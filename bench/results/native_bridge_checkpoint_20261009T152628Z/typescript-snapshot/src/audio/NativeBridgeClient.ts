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
