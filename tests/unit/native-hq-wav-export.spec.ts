import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeHqEngine, type NativeStatus } from '../../src/audio/NativeBridgeClient';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

const TRACK_METADATA = { trackId: 2, sampleRate: 48_000, frameCount: 2, channels: 2 as const };
const CAPABILITY = { available: true, engines: ['R2', 'R3'] as NativeHqEngine[] };

function nativeEngine(bridge: Record<string, unknown>, status: Partial<NativeStatus> = {}) {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  Object.assign(engine, {
    bridge,
    bridgeAvailable: true,
    engineRunning: true,
    latestStatus: {
      state: 'Stopped',
      nativeHqRenderer: CAPABILITY,
      nativeLooperMultiTrackImplemented: true,
      nativeLooperTrackCount: 5,
      nativeTracks: [{ trackId: 2, state: 'Stopped', loopProgress: 0 }],
      ...status,
    },
  });
  return engine;
}

function renderResponse(samples: Float32Array, overrides: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    'X-Native-Loop-Sample-Rate': '48000',
    'X-Native-Loop-Frame-Count': String(samples.length / 2),
    'X-Native-Loop-Channels': '2',
    'X-Native-Loop-Sample-Format': 'float32le',
    'X-Native-HQ-Engine': 'R3',
    'X-Native-HQ-Latency-Samples': '0',
    ...overrides,
  };
  return {
    ok: true,
    headers: { get: (name: string) => headers[name] ?? null },
    arrayBuffer: async () => samples.buffer as ArrayBuffer,
  } as Response;
}

describe('Native Rubber Band HQ WAV export', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gets validated track metadata before rendering and decodes the requested Float32LE output', async () => {
    const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const metadataResponse = { ok: true, json: async () => ({ ok: true, ...TRACK_METADATA }) } as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(metadataResponse)
      .mockResolvedValueOnce(renderResponse(samples, { 'X-Native-HQ-Engine': 'R2' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');

    const metadata = await client.getTrackMetadata(2);
    const rendered = await client.renderHqTrack(2, {
      semitones: -3,
      playbackRate: 1,
      engine: 'R2',
      memoryBudgetBytes: 128 * 1024 * 1024,
      format: 'pcm24',
    }, metadata);

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      'http://127.0.0.1:17755/v1/export/track-metadata?trackId=2', { method: 'GET' });
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'http://127.0.0.1:17755/v1/export/hq-render?trackId=2', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          semitones: -3, playbackRate: 1, engine: 'R2',
          memoryBudgetBytes: 128 * 1024 * 1024, format: 'pcm24',
        }),
      }));
    expect(metadata).toEqual(TRACK_METADATA);
    expect(rendered).toMatchObject({ ...TRACK_METADATA, engine: 'R2', latencySamples: 0 });
    expect(rendered.samples).toEqual(samples);
  });

  it('rejects bad metadata, engine/headers, truncated PCM, and bridge failures', async () => {
    const badMetadata = new NativeBridgeClient();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, ...TRACK_METADATA, trackId: 1 }),
    }) as Response));
    await expect(badMetadata.getTrackMetadata(2)).rejects.toThrow(/invalid HQ render track metadata/);

    const noRead = vi.fn(async () => new Float32Array([0, 0]).buffer);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: (name: string) => name === 'X-Native-HQ-Engine' ? 'R2' : null },
      body: { cancel: vi.fn(async () => undefined) },
      arrayBuffer: noRead,
    }) as unknown as Response));
    await expect(new NativeBridgeClient().renderHqTrack(2, {
      semitones: 0, playbackRate: 1, engine: 'R3', memoryBudgetBytes: 64, format: 'pcm16',
    })).rejects.toThrow(/invalid output metadata or engine headers/);
    expect(noRead).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 413,
      json: async () => ({ ok: false, error: 'HQ_RENDER exceeds the configured Native memory estimate.' }),
    }) as Response));
    await expect(new NativeBridgeClient().renderHqTrack(2, {
      semitones: 0, playbackRate: 1, engine: 'R3', memoryBudgetBytes: 64, format: 'pcm16',
    })).rejects.toThrow(/configured Native memory estimate/);
  });

  it('preflights memory from metadata before requesting rendered PCM, then encodes stereo with zero latency', async () => {
    const renderHqTrack = vi.fn(async () => ({
      ...TRACK_METADATA,
      samples: new Float32Array([0.25, -0.25, 0.5, -0.5]),
      engine: 'R3' as const,
      latencySamples: 0 as const,
    }));
    const getTrackMetadata = vi.fn(async () => TRACK_METADATA);
    const native = nativeEngine({ getTrackMetadata, renderHqTrack });
    const options = {
      semitones: 0,
      playbackRate: 1,
      format: 'pcm16' as const,
      memoryBudgetBytes: 128 * 1024 * 1024,
      nativeHqEngine: 'R3' as const,
    };

    const result = await native.exportHqWav(options, undefined, 2);

    expect(getTrackMetadata).toHaveBeenCalledWith(2);
    expect(renderHqTrack).toHaveBeenCalledWith(2, {
      semitones: 0,
      playbackRate: 1,
      engine: 'R3',
      memoryBudgetBytes: options.memoryBudgetBytes,
      format: 'pcm16',
    }, TRACK_METADATA);
    expect(result).toMatchObject({
      mode: 'HQ_RENDER', sampleRate: 48_000, format: 'pcm16', semitones: 0,
      playbackRate: 1, frameCount: 2, leadingLatencySamples: 0,
    });
    expect(new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint16(22, true)).toBe(2);
    const wav = new DataView(result.bytes.buffer, result.bytes.byteOffset);
    expect(wav.getInt16(44, true)).toBe(8192);
    expect(wav.getInt16(46, true)).toBe(-8192);
  });

  it('rejects over-budget exports before the render request and treats absent capability as unavailable', async () => {
    const renderHqTrack = vi.fn();
    const getTrackMetadata = vi.fn(async () => TRACK_METADATA);
    const native = nativeEngine({ getTrackMetadata, renderHqTrack });
    await expect(native.exportHqWav({
      semitones: 0, playbackRate: 1, format: 'pcm16', memoryBudgetBytes: 1,
    }, undefined, 2)).rejects.toThrow(/above the .* export budget/);
    expect(getTrackMetadata).toHaveBeenCalledOnce();
    expect(renderHqTrack).not.toHaveBeenCalled();

    const legacy = nativeEngine({ getTrackMetadata: vi.fn() }, { nativeHqRenderer: undefined });
    expect(legacy.getNativeHqRenderer()).toEqual({ available: false, engines: [] });
    expect(legacy.canExportHqWav()).toBe(false);
    await expect(legacy.exportHqWav({ semitones: 0, playbackRate: 1, format: 'pcm16' }))
      .rejects.toThrow(/completed loop/);
  });

  it('rejects engine and audio-control values outside the advertised native range', async () => {
    const native = nativeEngine({ getTrackMetadata: vi.fn(), renderHqTrack: vi.fn() }, {
      nativeHqRenderer: { available: true, engines: ['R2'] },
    });
    expect(native.getNativeHqRenderer()).toEqual({ available: true, engines: ['R2'] });
    await expect(native.exportHqWav({
      semitones: 0, playbackRate: 1, format: 'pcm16', nativeHqEngine: 'R3',
    })).rejects.toThrow(/engine R3 is not available/);
    await expect(native.exportHqWav({
      semitones: 25, playbackRate: 1, format: 'pcm16', nativeHqEngine: 'R2',
    })).rejects.toThrow(/semitones must be between/);
  });
});
