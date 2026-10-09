import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient } from '../../src/audio/NativeBridgeClient';

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
});
