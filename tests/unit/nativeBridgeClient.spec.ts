import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient } from '../../src/audio/NativeBridgeClient';
import type { NativeFxBankConfiguration, NativeFxMidiEvent } from '../../src/audio/nativeFxProtocol';

function emptyNativeFxBank(sampleRateHz = 48000): NativeFxBankConfiguration {
  const emptySlot = () => ({ enabled: false, ordinal: 0, mix: 1, smoothingMs: 5, parameters: [] });
  return {
    sampleRateHz,
    channels: 2,
    maxBlockFrames: 64,
    buses: [
      { kind: 'input', slots: [emptySlot(), emptySlot(), emptySlot(), emptySlot()] },
      ...Array.from({ length: 5 }, (_, trackIndex) => ({
        kind: 'track' as const,
        trackIndex,
        slots: [emptySlot(), emptySlot(), emptySlot(), emptySlot()],
      })),
      { kind: 'send', slots: [emptySlot(), emptySlot(), emptySlot(), emptySlot()] },
      { kind: 'master', slots: [emptySlot(), emptySlot(), emptySlot(), emptySlot()] },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NativeBridgeClient transport version routing', () => {
  it('uses the legacy v1 endpoints for track 1 until a v2 status is observed', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname);
      return { json: async () => ({ ok: true }) } as Response;
    }));

    const bridge = new NativeBridgeClient('http://native.test');
    await bridge.record(1);
    await bridge.stopTransport(1);
    await bridge.play(1);
    await bridge.toggleOverdub(1);
    await bridge.clear(1);

    expect(paths).toEqual([
      '/v1/transport/record',
      '/v1/transport/stop',
      '/v1/transport/play',
      '/v1/transport/overdub-toggle',
      '/v1/transport/clear',
    ]);
    await expect(bridge.record(2)).rejects.toThrow('Native bridge v1 exposes only track 1');
    await expect(bridge.setTrackGain(1, 1)).rejects.toThrow('Native track mix controls require a v2 bridge');
    expect(paths).toHaveLength(5);
  });

  it('negotiates from the status payload and routes versioned tracks to v2', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      const payload = url.pathname === '/v1/status'
        ? { ok: true, trackEngineVersion: 2, trackCount: 5 }
        : { ok: true };
      return { json: async () => payload } as Response;
    }));

    const bridge = new NativeBridgeClient('http://native.test');
    await bridge.getStatus();
    await bridge.record(1);
    await bridge.record(5);
    await bridge.setTrackGain(5, 1.25);

    expect(paths).toEqual([
      '/v1/status',
      '/v2/tracks/1/record',
      '/v2/tracks/5/record',
      '/v2/tracks/5/gain',
    ]);
  });

  it('uses the Native FX bank endpoints and sends one validated atomic event batch', async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const payload = url.pathname === '/v2/fx/catalog'
        ? { ok: true, entries: [{ ordinal: 1, hostRouteable: true }] }
        : url.pathname === '/v2/fx/bank'
          ? { ok: true, configured: true, configuration: emptyNativeFxBank(), stageAccepted: true,
              adopted: true, producerGeneration: 2, activeGeneration: 2 }
          : { ok: true, configured: true, configuration: emptyNativeFxBank(), stageAccepted: true,
              adopted: false, producerGeneration: 3, activeGeneration: 2 };
      return { json: async () => payload } as Response;
    }));

    const bridge = new NativeBridgeClient('http://native.test');
    const catalog = await bridge.getFxCatalog();
    const current = await bridge.getFxBank();
    const configuration = emptyNativeFxBank();
    const staged = await bridge.configureFxBank(configuration);
    const events = [
      { absoluteFrame: 64, busIndex: 1, slotIndex: 0, parameterId: 48, value: 1 },
      { absoluteFrame: 64, busIndex: 2, slotIndex: 0, parameterId: 48, value: 1 },
    ];
    const posted = await bridge.postFxParameterEvents(events);
    await bridge.postFxSlotMix(1, 0, 0.75, 5, 64);

    expect(catalog.entries[0]?.hostRouteable).toBe(true);
    expect(current.configuration?.sampleRateHz).toBe(48000);
    expect(staged.stageAccepted).toBe(true);
    expect(posted.adopted).toBe(false);
    expect(requests.map(({ path, method }) => [path, method])).toEqual([
      ['/v2/fx/catalog', 'GET'],
      ['/v2/fx/bank', 'GET'],
      ['/v2/fx/bank', 'PUT'],
      ['/v2/fx/parameters', 'POST'],
      ['/v2/fx/slot-mix', 'POST'],
    ]);
    expect(requests[3]?.body).toEqual({ events });
  });

  it('rejects invalid event batches locally and preserves explicit bridge errors', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: false, error: 'Native FX bank is not prepared.' }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const bridge = new NativeBridgeClient('http://native.test');

    await expect(bridge.postFxParameterEvents([
      { absoluteFrame: 1.5, busIndex: 0, slotIndex: 0, parameterId: 1, value: 2 },
    ])).rejects.toThrow('safe-frame-required');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(bridge.configureFxBank(emptyNativeFxBank())).rejects.toThrow('Native FX bank is not prepared.');
  });

  it('serializes typed MIDI as one atomic event batch to the shared Native endpoint', async () => {
    let requestBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return { json: async () => ({ ok: true, configured: true, configuration: emptyNativeFxBank(),
        stageAccepted: true, adopted: false, producerGeneration: 2, activeGeneration: 1 }) } as Response;
    }));
    const bridge = new NativeBridgeClient('http://native.test');
    const event: NativeFxMidiEvent = {
      kind: 'midi', absoluteFrame: 1024, busIndex: 0, slotIndex: 2,
      midiType: 'NoteOn', channel: 3, note: 64, velocity: 96,
    };
    const response = await bridge.postFxMidiEvents([event]);
    expect(response.adopted).toBe(false);
    expect(requestBody).toEqual({ events: [event] });
  });
});
