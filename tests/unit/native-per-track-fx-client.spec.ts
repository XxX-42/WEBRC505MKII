import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeCatalogMidiEvent, type NativeCatalogSlotConfig } from '../../src/audio/NativeBridgeClient';

const slots = ['A', 'B', 'C', 'D'] as const;
const config: NativeCatalogSlotConfig = { path: 'track', slot: 'A', effectId: 'filter.lpf', parameters: { cutoff_hz: 1500 }, bypassed: false };
const event: NativeCatalogMidiEvent = { path: 'track', slot: 'D', effectId: 'osc_voc_m', type: 'noteOn', channel: 1, note: 60, velocity: 90, frame: 1234 };

afterEach(() => vi.unstubAllGlobals());

describe('Native independent-track FX HTTP boundary', () => {
  it('routes all five A–D banks in order and preserves omitted/zero legacy targets', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    for (let trackId = 1; trackId <= 5; trackId += 1) {
      for (const slot of slots) await client.setCatalogSlot({ ...config, trackId, slot });
      await client.queueCatalogMidiEvent({ ...event, trackId });
      await client.queueOscVocMidiEvent({ ...event, trackId });
    }
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies.filter((body) => body.effectId === 'filter.lpf').map(({ trackId, slot }) => `${trackId}:${slot}`)).toEqual(
      [1, 2, 3, 4, 5].flatMap((trackId) => slots.map((slot) => `${trackId}:${slot}`)),
    );
    for (const trackId of [1, 2, 3, 4, 5]) expect(bodies.filter((body) => body.trackId === trackId)).toHaveLength(6);
    await client.setCatalogSlot(config);
    await client.setCatalogSlot({ ...config, trackId: 0 });
    expect(JSON.parse((fetchMock.mock.lastCall as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ trackId: 0 });
    expect((fetchMock.mock.calls.at(-2) as unknown as [string, RequestInit])[1].body).toBe(JSON.stringify(config));
  });

  it('rejects unknown target/path/type, malformed slot/parameters and out-of-range MIDI before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    for (const trackId of [-1, 6, 1.5, NaN, Infinity, null, '1']) {
      await expect(client.setCatalogSlot({ ...config, trackId } as NativeCatalogSlotConfig)).rejects.toThrow(RangeError);
      await expect(client.queueCatalogMidiEvent({ ...event, trackId } as NativeCatalogMidiEvent)).rejects.toThrow(RangeError);
      await expect(client.queueOscVocMidiEvent({ ...event, trackId } as NativeCatalogMidiEvent)).rejects.toThrow(RangeError);
    }
    for (const invalid of [
      { path: 'input', trackId: 1 }, { path: 'unknown' }, { path: null }, { slot: 'E' }, { effectId: 'made_up' },
      { parameters: { cutoff_hz: NaN } }, { parameters: [] }, { parameters: { '': 1 } }, { bypassed: 0 },
    ]) await expect(client.setCatalogSlot({ ...config, ...invalid } as NativeCatalogSlotConfig)).rejects.toThrow(RangeError);
    await expect(client.queueCatalogMidiEvent({ ...event, path: 'input', trackId: 5 })).rejects.toThrow(RangeError);
    await expect(client.queueCatalogMidiEvent({ ...event, frame: -1 })).rejects.toThrow(RangeError);
    await expect(client.queueCatalogMidiEvent({ ...event, effectId: 'chorus' } as unknown as NativeCatalogMidiEvent)).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains exact server rejection and rejects non-success HTTP even if the body says ok', async () => {
    const client = new NativeBridgeClient();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'Track 4 slot C: stop Native audio before replacement' }) }) as Response));
    await expect(client.setCatalogSlot({ ...config, trackId: 4, slot: 'C' })).rejects.toThrow('Track 4 slot C: stop Native audio before replacement');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ ok: true }) }) as Response));
    await expect(client.setCatalogSlot(config)).rejects.toThrow('HTTP 400');
  });
});
