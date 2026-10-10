import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeFxBankConfiguration } from '../../src/audio/nativeFxProtocol';
import type { NativeFxCatalogResponse, NativeStatus } from '../../src/audio/NativeBridgeClient';

const preferencesKey = 'nativeFxBanks.v1';

function emptyBank(sampleRateHz = 48000): NativeFxBankConfiguration {
  const emptySlot = () => ({ enabled: false, ordinal: 0, mix: 1, smoothingMs: 5, parameters: [] });
  const bus = (kind: 'input' | 'track' | 'send' | 'master', trackIndex?: number) => ({
    kind,
    ...(trackIndex === undefined ? {} : { trackIndex }),
    slots: Array.from({ length: 4 }, emptySlot),
  });
  return {
    sampleRateHz,
    channels: 2,
    maxBlockFrames: 64,
    buses: [bus('input'), ...Array.from({ length: 5 }, (_, index) => bus('track', index)), bus('send'), bus('master')],
  };
}

const pannerCatalog: NativeFxCatalogResponse = {
  ok: true,
  entries: [{
    ordinal: 30,
    id: 'rc505mkii.fx.panner',
    displayName: 'Panner',
    family: 'spatial',
    inputFx: true,
    trackFx: true,
    processorAvailable: true,
    hostRouteable: true,
    routeLimitReason: '',
    parameters: [
      { id: 48, name: 'Active', unit: '', minimum: 0, maximum: 1, defaultValue: 1, origin: 0 },
      { id: 56, name: 'Pan', unit: '%', minimum: -1, maximum: 1, defaultValue: 0, origin: 0 },
    ],
  }],
};

function readyStatus(): NativeStatus {
  return {
    ok: true,
    bridgeHealthy: true,
    engineRunning: true,
    softwareOnly: false,
    backend: 'WASAPI',
    inputDeviceId: 'in',
    outputDeviceId: 'out',
    inputDeviceName: 'Input',
    outputDeviceName: 'Output',
    sampleRate: 48000,
    bufferFrames: 128,
    trackEngineVersion: 2,
    trackCount: 5,
    nextAudioFrame: 0,
    monitoringEnabled: false,
    state: 'Empty',
    inputLatencyMs: null,
    outputLatencyMs: null,
    roundTripEstimateMs: null,
    physicalRoundTripMs: null,
    driverReportedStreamLatencyMs: null,
    inputLatencySource: '',
    outputLatencySource: '',
    driverReportedStreamLatencySource: '',
    roundTripLatencyNote: '',
    inputPeak: 0,
    outputPeak: 0,
    xrunsOrDropouts: 0,
    callbackStatusFaults: 0,
    inputQueueOverruns: 0,
    outputQueueUnderruns: 0,
    callbackFrameLimitViolations: 0,
    droppedCommands: 0,
    outputQueueDepthBlocks: 0,
    outputQueueCapacityBlocks: 0,
    callbackTicks: 0,
    inputCallbackTicks: 0,
    outputCallbackTicks: 0,
    callbackCountSkew: 0,
    lastError: '',
    loopProgress: 0,
  };
}

function newReadyEngine(): NativeAudioEngine {
  const Constructor = NativeAudioEngine as unknown as { new(): NativeAudioEngine };
  const engine = new Constructor();
  const internals = engine as unknown as {
    bridgeAvailable: boolean;
    engineRunning: boolean;
    latestStatus: NativeStatus;
  };
  internals.bridgeAvailable = true;
  internals.engineRunning = true;
  internals.latestStatus = readyStatus();
  return engine;
}

function installNativeFxServer() {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  let configuration: NativeFxBankConfiguration | null = null;
  let generation = 0;
  let rejectNextMutation = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, method, body });
    let payload: Record<string, unknown>;
    if (url.pathname === '/v2/fx/catalog') {
      payload = pannerCatalog;
    } else if (url.pathname === '/v2/fx/bank' && method === 'GET') {
      payload = {
        ok: true,
        configured: configuration !== null,
        configuration,
        stageAccepted: configuration !== null,
        adopted: false,
        producerGeneration: generation || null,
        activeGeneration: null,
      };
    } else if ((url.pathname === '/v2/fx/bank' && method === 'PUT') ||
               (url.pathname === '/v2/fx/parameters' && method === 'POST')) {
      if (rejectNextMutation) {
        rejectNextMutation = false;
        payload = { ok: false, error: 'synthetic stage rejection' };
      } else {
        if (url.pathname === '/v2/fx/bank') {
          configuration = body as NativeFxBankConfiguration;
        } else if (configuration && Array.isArray(body?.events)) {
          configuration = structuredClone(configuration);
          for (const event of body.events as Array<{ busIndex: number; slotIndex: number; parameterId: number; value: number }>) {
            const slot = configuration.buses[event.busIndex]?.slots[event.slotIndex];
            const parameter = slot?.parameters.find((candidate) => candidate.id === event.parameterId);
            if (parameter) parameter.value = event.value;
          }
        }
        generation += 1;
        payload = {
          ok: true,
          configured: true,
          configuration,
          stageAccepted: true,
          adopted: false,
          producerGeneration: generation,
          activeGeneration: null,
        };
      }
    } else {
      payload = { ok: false, error: `Unexpected fake Native request ${method} ${url.pathname}` };
    }
    return { ok: Boolean(payload.ok), status: payload.ok ? 200 : 400, json: async () => payload } as Response;
  }));
  return {
    requests,
    setRejectNextMutation: () => { rejectNextMutation = true; },
    getConfiguration: () => configuration,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Native four-bank FX persistence', () => {
  it('restores all four banks and stages the saved active bank on a new engine instance', async () => {
    const server = installNativeFxServer();
    const first = newReadyEngine();
    await first.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': -0.25 },
    });
    await first.selectFxBank('native-bank-2');

    const stored = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null') as {
      schemaVersion: number; activeBankId: string; banks: Array<{ id: string; input: Array<unknown> }>;
    } | null;
    expect(stored?.schemaVersion).toBe(1);
    expect(stored?.activeBankId).toBe('native-bank-2');
    expect(stored?.banks).toHaveLength(4);
    expect(stored?.banks[0]?.input[0]).toMatchObject({ type: 'SHARED_DSP_FX_30', params: { '56': -0.25 } });

    const putCountBeforeRestore = server.requests.filter((request) => request.method === 'PUT').length;
    const restored = newReadyEngine();
    const internal = restored as unknown as { ensureFxControlState(): Promise<unknown> };
    await internal.ensureFxControlState();
    expect(restored.getFxState().activeBankId).toBe('native-bank-2');
    expect(restored.getFxState().banks[0]?.input[0]).toMatchObject({
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': -0.25 },
    });
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(putCountBeforeRestore + 1);
    expect(server.getConfiguration()?.buses[0]?.slots[0]?.enabled).toBe(false);
    expect(server.getConfiguration()?.buses[0]?.slots[1]?.enabled).toBe(false);
  });

  it('keeps the accepted bank and saved bytes when a replacement stage is rejected', async () => {
    const server = installNativeFxServer();
    const engine = newReadyEngine();
    await engine.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': 0.2 },
    });
    const beforeState = engine.getFxState();
    const beforeStorage = localStorage.getItem(preferencesKey);
    server.setRejectNextMutation();

    await expect(engine.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': 0.75 },
    })).rejects.toThrow('synthetic stage rejection');

    expect(engine.getFxState()).toEqual(beforeState);
    expect(localStorage.getItem(preferencesKey)).toBe(beforeStorage);
  });

  it('keeps malformed saved bytes intact and exposes the ignored-record error', async () => {
    installNativeFxServer();
    const malformed = '{"schemaVersion":1,"activeBankId":"native-bank-9","banks":[]}';
    localStorage.setItem(preferencesKey, malformed);
    const engine = newReadyEngine();
    const internal = engine as unknown as { ensureFxControlState(): Promise<unknown> };

    await internal.ensureFxControlState();

    expect(localStorage.getItem(preferencesKey)).toBe(malformed);
    expect(engine.getFxState().activeBankId).toBe('native-bank-1');
    expect(engine.getUiStatus().lastError).toContain('Saved Native FX banks were ignored');
  });

  it('does not publish a saved active bank when its restore stage fails', async () => {
    const server = installNativeFxServer();
    const first = newReadyEngine();
    await first.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': 0.6 },
    });
    const stored = localStorage.getItem(preferencesKey);
    expect(stored).not.toBeNull();
    server.setRejectNextMutation();

    const restored = newReadyEngine();
    const internal = restored as unknown as { ensureFxControlState(): Promise<unknown> };
    const listener = vi.fn();
    restored.subscribeFxState(listener);
    await expect(internal.ensureFxControlState()).rejects.toThrow('synthetic stage rejection');

    expect(localStorage.getItem(preferencesKey)).toBe(stored);
    expect(listener).not.toHaveBeenCalled();
    expect(() => restored.getFxState()).toThrow('synthetic stage rejection');
    expect(restored.getUiStatus().lastError).toContain('synthetic stage rejection');
  });

  it('deduplicates concurrent saved-bank restoration into one stage request', async () => {
    const server = installNativeFxServer();
    const first = newReadyEngine();
    await first.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': -0.4 },
    });
    const putsBeforeRestore = server.requests.filter((request) => request.method === 'PUT').length;
    const restored = newReadyEngine();
    const internal = restored as unknown as { ensureFxControlState(): Promise<unknown> };

    await Promise.all([internal.ensureFxControlState(), internal.ensureFxControlState()]);

    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(putsBeforeRestore + 1);
    expect(restored.getFxState().banks[0]?.input[0]?.params['56']).toBe(-0.4);
  });

  it('reports storage quota failure after Native accepts and keeps the accepted in-memory target', async () => {
    const server = installNativeFxServer();
    const engine = newReadyEngine();
    await engine.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': 0.2 },
    });
    const persistedBefore = localStorage.getItem(preferencesKey);
    const originalSetItem = Storage.prototype.setItem;
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key: string, value: string) {
      if (key === preferencesKey) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      originalSetItem.call(this, key, value);
    });

    await engine.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': 0.7 },
    });

    expect(server.getConfiguration()?.buses[0]?.slots[0]?.parameters.find((parameter) => parameter.id === 56)?.value).toBe(0.7);
    expect(engine.getFxState().banks[0]?.input[0]?.params['56']).toBe(0.7);
    expect(localStorage.getItem(preferencesKey)).toBe(persistedBefore);
    expect(engine.getUiStatus().lastError).toContain('changes were accepted but could not be saved');

    storageWrite.mockRestore();
    await engine.updateFxBankSlot('input', 0, {
      type: 'SHARED_DSP_FX_30', enabled: true, params: { '48': 1, '56': 0.8 },
    });
    expect(localStorage.getItem(preferencesKey)).not.toBe(persistedBefore);
    expect(engine.getUiStatus().lastError).toBe('');
  });
});
