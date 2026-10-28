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
    await client.undoTrack(1);
    await client.redoTrack(3);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:17755/v1/transport/record',
      'http://127.0.0.1:17755/v1/transport/stop?trackId=5',
      'http://127.0.0.1:17755/v1/transport/play?trackId=5',
      'http://127.0.0.1:17755/v1/transport/overdub-toggle?trackId=5',
      'http://127.0.0.1:17755/v1/transport/clear?trackId=5',
      'http://127.0.0.1:17755/v1/transport/undo',
      'http://127.0.0.1:17755/v1/transport/redo?trackId=3',
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
      'X-Native-Loop-Revision': '17',
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
    expect(snapshot).toMatchObject({ sampleRate: 48_000, frameCount: 2, channels: 2, contentRevision: 17 });
    expect([...snapshot.samples]).toEqual([...samples]);
  });

  it('rejects track selectors outside the 1–5 host contract before making requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.recordTrack(0)).rejects.toThrow(/between 1 and 5/);
    await expect(client.undoTrack(0)).rejects.toThrow(/between 1 and 5/);
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

  it('enables Native 1SHOT only after the applied revision and setting read back', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const returned = { ...config, oneShot: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] } }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [returned] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 4, loopTransportRequestedRevision: 4,
          loopTransportAppliedRevision: 4, loopTransportFaultRevision: 0, loopTransportAppliedOneShot: true }] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const status = await client.setOneShot(1, true);

    expect(status.nativeMemory?.loopTransports[0]?.oneShot).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ trackId: 1, oneShot: true });
  });

  it('does not treat a callback-rejected requested 1SHOT value as applied', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const requested = { ...config, oneShot: true };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportAppliedOneShot: false }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [requested] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 8, loopTransportRequestedRevision: 8,
          loopTransportAppliedRevision: 7, loopTransportFaultRevision: 8, loopTransportAppliedOneShot: false }] }) } as Response));
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/callback rejected/);
    expect(client.getOneShot(1)).toBe(false);
  });

  it('does not treat a superseded requested 1SHOT value as applied', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const requested = { ...config, oneShot: true };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportAppliedOneShot: false }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [requested] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 8, loopTransportRequestedRevision: 9,
          loopTransportAppliedRevision: 9, loopTransportFaultRevision: 0, loopTransportAppliedOneShot: false }] }) } as Response));
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/superseded/);
    expect(client.getOneShot(1)).toBe(false);
  });

  it('keeps the prior applied 1SHOT state visible after an acknowledgement timeout', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const requested = { ...config, oneShot: true };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportAppliedOneShot: false }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [requested] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 8, loopTransportRequestedRevision: 8,
          loopTransportAppliedRevision: 7, loopTransportFaultRevision: 0, loopTransportAppliedOneShot: false }] }) } as Response));
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2001);
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/acknowledgement timed out/);
    expect(client.getOneShot(1)).toBe(false);
    vi.restoreAllMocks();
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
