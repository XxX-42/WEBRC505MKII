import { describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeLoopTransportConfig } from '../../src/audio/NativeBridgeClient';

describe('Native multi-track bridge client', () => {
  it('keeps Track 1 routes compatible and targets selected higher tracks for transport', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await client.recordTrack(1);
    await client.stopTrack(5);
    await client.playTrack(5);
    await client.toggleTrackOverdub(5);
    await client.clearTrack(5);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:17755/v1/transport/record',
      'http://127.0.0.1:17755/v1/transport/stop?trackId=5',
      'http://127.0.0.1:17755/v1/transport/play?trackId=5',
      'http://127.0.0.1:17755/v1/transport/overdub-toggle?trackId=5',
      'http://127.0.0.1:17755/v1/transport/clear?trackId=5',
    ]);
  });

  it('parses interleaved stereo snapshots for the selected Native track', async () => {
    const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const bytes = samples.buffer.slice(0);
    const headerValues: Record<string, string> = {
      'X-Native-Loop-Sample-Rate': '48000',
      'X-Native-Loop-Frame-Count': '2',
      'X-Native-Loop-Channels': '2',
      'X-Native-Loop-Sample-Format': 'float32le',
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: (name: string) => headerValues[name] ?? headerValues[name.toLowerCase()] ?? null },
      arrayBuffer: async () => bytes,
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const snapshot = await client.getLoopSnapshot(3);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/export/loop-snapshot?trackId=3',
      { method: 'GET' },
    );
    expect(snapshot).toMatchObject({ sampleRate: 48_000, frameCount: 2, channels: 2 });
    expect([...snapshot.samples]).toEqual([...samples]);
  });

  it('rejects track selectors outside the 1–5 host contract before making requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.recordTrack(0)).rejects.toThrow(/between 1 and 5/);
    await expect(client.getLoopSnapshot(6)).rejects.toThrow(/between 1 and 5/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends typed per-track loop transport settings using the 1-based Native track ID', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const config: NativeLoopTransportConfig = {
      mode: 'vinylFlick',
      beatOffsetBeats: -0.5,
      bpm: 128,
      crossfadeMs: 5,
      vinylSpeedPercent: -100,
      motorReturnSeconds: 0.5,
      brakePercent: 60,
      vinylMixPercent: 82,
    };

    await client.setLoopTransport(3, config);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/native-loop-transport/config',
      {
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify({ trackId: 3, ...config }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects invalid loop-transport track IDs and config values before making requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const config: NativeLoopTransportConfig = {
      mode: 'beatShift',
      beatOffsetBeats: 0,
      bpm: 120,
      crossfadeMs: 5,
      vinylSpeedPercent: 0,
      motorReturnSeconds: 1,
      brakePercent: 0,
      vinylMixPercent: 100,
    };

    await expect(client.setLoopTransport(0, config)).rejects.toThrow(/between 1 and 5/);
    await expect(client.setLoopTransport(2, { ...config, bpm: 300.1 })).rejects.toThrow(/loop transport settings/);
    await expect(client.setLoopTransport(2, { ...config, beatOffsetBeats: Number.NaN })).rejects.toThrow(/loop transport settings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces Native bridge loop-transport rejection details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: false, error: 'Track 3 transport command queue is full.' }),
    }) as Response));
    const client = new NativeBridgeClient();
    const config: NativeLoopTransportConfig = {
      mode: 'vinylFlick',
      beatOffsetBeats: 0,
      bpm: 120,
      crossfadeMs: 5,
      vinylSpeedPercent: 20,
      motorReturnSeconds: 1,
      brakePercent: 30,
      vinylMixPercent: 100,
    };

    await expect(client.setLoopTransport(3, config)).rejects.toThrow('Track 3 transport command queue is full.');
  });
});
