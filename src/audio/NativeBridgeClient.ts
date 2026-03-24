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
  monitoringEnabled: boolean;
  state: NativeLooperState;
  inputLatencyMs: number;
  outputLatencyMs: number;
  roundTripEstimateMs: number;
  inputPeak: number;
  outputPeak: number;
  xrunsOrDropouts: number;
  lastError: string;
  loopProgress: number;
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
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

export class NativeBridgeClient {
  private readonly baseUrl: string;

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

  public async record(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/record', { method: 'POST' });
  }

  public async stopTransport(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/stop', { method: 'POST' });
  }

  public async play(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/play', { method: 'POST' });
  }

  public async toggleOverdub(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/overdub-toggle', { method: 'POST' });
  }

  public async clear(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/clear', { method: 'POST' });
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
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }

    const payload = (await response.json()) as T;
    if (!payload.ok) {
      throw new Error(payload.error || 'Native bridge request failed.');
    }
    return payload;
  }
}
