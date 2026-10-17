import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, NativeBridgeRequestTimeoutError, NATIVE_BRIDGE_REQUEST_TIMEOUT_MS, type NativeStatus } from '../../src/audio/NativeBridgeClient';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

function statusSnapshot(overrides: Partial<NativeStatus> = {}): NativeStatus {
  return {
    ok: true,
    bridgeHealthy: true,
    engineRunning: true,
    backend: 'WASAPI',
    inputDeviceId: 'input-default',
    outputDeviceId: 'output-default',
    inputDeviceName: 'Default input',
    outputDeviceName: 'Default output',
    sampleRate: 48000,
    bufferFrames: 128,
    monitoringEnabled: false,
    state: 'Playing',
    inputLatencyMs: 3,
    outputLatencyMs: 4,
    roundTripEstimateMs: 7,
    inputPeak: 0.2,
    outputPeak: 0.3,
    xrunsOrDropouts: 0,
    lastError: '',
    loopProgress: 0.5,
    nativeTracks: [{ trackId: 1, state: 'Playing', loopProgress: 0.5 }],
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Native bridge request deadline', () => {
  it('reads status once after a timed-out write without replaying the write', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    const status = statusSnapshot({ monitoringEnabled: true });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/status')) return Promise.resolve(jsonResponse(status));
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');

    const pending = client.setMonitoring(true);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      path: '/v1/monitoring',
      method: 'POST',
      reconciledStatus: status,
    });
    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/monitoring'))).toHaveLength(1);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:17755/v1/status', expect.objectContaining({
      headers: { 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    }));
  });

  it('does not recursively recover when the bounded status read times out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');

    const pending = client.getStatus();
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      path: '/v1/status',
      method: 'GET',
      reconciledStatus: null,
    });
    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_REQUEST_TIMEOUT_MS);
    await rejection;

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps acknowledged Native transport state after a write response times out', async () => {
    vi.useFakeTimers();
    const status = statusSnapshot({ monitoringEnabled: true });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/status')) return Promise.resolve(jsonResponse(status));
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);
    const engine = NativeAudioEngine.getInstance();

    const pending = engine.setMonitoring(true);
    const rejection = expect(pending).rejects.toBeInstanceOf(NativeBridgeRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_REQUEST_TIMEOUT_MS);
    await rejection;

    expect(engine.getUiStatus()).toMatchObject({
      bridgeAvailable: true,
      engineRunning: true,
      ready: true,
      lastError: 'Native bridge request /v1/monitoring timed out after 5000 ms.',
    });
    expect(engine.tracks[0]!.state).toBe('PLAYING');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/monitoring'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/status'))).toHaveLength(1);
  });

  it('leaves a long Native HQ render running past the ordinary request deadline', async () => {
    vi.useFakeTimers();
    let resolveRender!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveRender = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const options = {
      semitones: 0,
      playbackRate: 1,
      engine: 'R2' as const,
      memoryBudgetBytes: 1024,
      format: 'float32' as const,
    };
    const render = client.renderHqTrack(1, options);

    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_REQUEST_TIMEOUT_MS * 2);
    const headers = new Headers({
      'X-Native-Loop-Sample-Rate': '44100',
      'X-Native-Loop-Frame-Count': '1',
      'X-Native-Loop-Channels': '2',
      'X-Native-HQ-Latency-Samples': '0',
      'X-Native-Loop-Sample-Format': 'float32le',
      'X-Native-HQ-Engine': 'R2',
    });
    resolveRender({
      ok: true,
      headers,
      arrayBuffer: async () => new Float32Array([0.25, -0.25]).buffer,
    } as unknown as Response);

    await expect(render).resolves.toMatchObject({
      trackId: 1,
      frameCount: 1,
      samples: new Float32Array([0.25, -0.25]),
      engine: 'R2',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
