import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeRhythmConfig } from '../../src/audio/NativeBridgeClient';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

const config: NativeRhythmConfig = {
  enabled: true, bpm: 143, patternIndex: 240, kitIndex: 16, variation: 'D', section: 'fill',
  swingPercent: 75, quantizeGrid: '1/8', volume: 83,
};

describe('Native rhythm bridge client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs every shared setting and returns the authoritative rhythm status', async () => {
    const status = nativeRhythmStatus(config);
    const fetchMock = vi.fn(async () => ({ json: async () => status }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().setRhythm(config)).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17755/v1/native-rhythm/config', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
    }));
  });

  it.each([
    { patternIndex: 0 }, { patternIndex: 241 }, { patternIndex: 1.5 }, { kitIndex: 0 }, { kitIndex: 17 },
    { bpm: 39 }, { bpm: 301 }, { bpm: NaN }, { variation: 'E' }, { section: 'verse' },
    { swingPercent: 49 }, { swingPercent: 76 }, { swingPercent: 60.5 }, { quantizeGrid: '1/32' },
    { volume: -1 }, { volume: 101 }, { volume: 50.5 }, { volume: Infinity }, { enabled: 1 },
  ])('rejects invalid config before fetching: %j', async (patch) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().setRhythm({ ...config, ...patch } as NativeRhythmConfig)).rejects.toThrow('Native rhythm settings');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces unsupported endpoint and unreachable bridge errors', async () => {
    const client = new NativeBridgeClient();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false, error: 'Native rhythm is unavailable in this host' }) })));
    await expect(client.setRhythm(config)).rejects.toThrow('Native rhythm is unavailable in this host');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connection refused'); }));
    await expect(client.setRhythm(config)).rejects.toThrow('Native bridge is unreachable');
  });
});
