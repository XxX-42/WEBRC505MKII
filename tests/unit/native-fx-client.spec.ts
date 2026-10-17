import { describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeConfig } from '../../src/audio/NativeBridgeClient';

describe('Native FX bridge client', () => {
  it('sends and round-trips the explicit Native loop-memory budget in engine config', async () => {
    const payload = { ok: true, nativeLooperStorageBudgetBytes: 1536 * 1024 * 1024 };
    const fetchMock = vi.fn(async () => ({ json: async () => payload }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const config: NativeConfig = {
      backend: 'WASAPI',
      inputDeviceId: 'WASAPI:1',
      outputDeviceId: 'WASAPI:1',
      sampleRate: 96000,
      bufferFrames: 128,
      monitoringEnabled: false,
      nativeLooperStorageBudgetBytes: 1536 * 1024 * 1024,
    };

    await expect(client.applyConfig(config)).resolves.toMatchObject(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/config/apply',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(config) }),
    );
  });

  it('sends bounded fractional-delay settings to the Native slot-A endpoint', async () => {
    const payload = { ok: true };
    const fetchMock = vi.fn(async () => ({ json: async () => payload }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const config = {
      slot: 'A' as const,
      enabled: true,
      algorithm: 'lagrange4' as const,
      delayMs: 350,
      wetMix: 0.4,
      feedback: 0.35,
    };

    await client.setFractionalDelay(config);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/native-fx/fractional-delay',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(config),
      }),
    );
  });

  it('sends validated peak-compressor settings to the Native slot-A endpoint', async () => {
    const payload = { ok: true };
    const fetchMock = vi.fn(async () => ({ json: async () => payload }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const config = {
      slot: 'A' as const,
      enabled: true,
      algorithm: 'peakCompressor' as const,
      thresholdDb: -18,
      ratio: 4,
      attackMs: 10,
      releaseMs: 120,
      wetMix: 1,
      makeupDb: 0,
    };

    await client.setCompressor(config);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/native-fx/compressor',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(config) }),
    );
  });

  it('sends stereo Lagrange chorus settings to the Native slot-A endpoint', async () => {
    const payload = { ok: true };
    const fetchMock = vi.fn(async () => ({ json: async () => payload }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const config = {
      slot: 'A' as const,
      enabled: true,
      algorithm: 'stereoLfoLagrange4' as const,
      rateHz: 0.8,
      depthMs: 8,
      feedback: 0.15,
      wetMix: 0.35,
    };

    await client.setChorus(config);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/native-fx/chorus',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(config) }),
    );
  });

  it('queues validated OSC VOC MIDI events at an absolute sample frame', async () => {
    const payload = { ok: true, nativeSampleFrame: 1024 };
    const fetchMock = vi.fn(async () => ({ json: async () => payload }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const event = {
      path: 'input' as const, slot: 'C' as const, type: 'noteOn' as const,
      channel: 2, note: 69, velocity: 110, frame: 2048,
    };

    await expect(client.queueOscVocMidiEvent(event)).resolves.toMatchObject(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/native-fx/osc-voc-midi',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(event) }),
    );
  });

  it('rejects unsafe or out-of-range OSC VOC MIDI fields before sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient('http://127.0.0.1:17755');
    const event = {
      path: 'track' as const, slot: 'A' as const, type: 'noteOff' as const,
      channel: 1, note: 60, velocity: 0, frame: 10,
    };

    await expect(client.queueOscVocMidiEvent({ ...event, channel: 0 })).rejects.toThrow(RangeError);
    await expect(client.queueOscVocMidiEvent({ ...event, note: 128 })).rejects.toThrow(RangeError);
    await expect(client.queueOscVocMidiEvent({ ...event, velocity: -1 })).rejects.toThrow(RangeError);
    await expect(client.queueOscVocMidiEvent({ ...event, frame: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
