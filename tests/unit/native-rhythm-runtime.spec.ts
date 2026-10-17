import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { NativeRhythmEngine } from '../../src/audio/NativeRhythmEngine';
import type { NativeBridgeClient, NativeLoopTransportConfig, NativeRhythmConfig, NativeStatus } from '../../src/audio/NativeBridgeClient';
import { Transport } from '../../src/core/Transport';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

function createRuntime(initial = nativeRhythmStatus()) {
  let status: NativeStatus | null = initial;
  let connected = true;
  const setRhythm = vi.fn(async (config: NativeRhythmConfig) => ({ ...status!, nativeRhythm: { ...status!.nativeRhythm!, ...config } }));
  const reportError = vi.fn();
  const notify = vi.fn();
  const rhythm = new NativeRhythmEngine({
    bridge: () => ({ setRhythm }) as unknown as NativeBridgeClient,
    status: () => status, bridgeAvailable: () => connected,
    applyStatus: (next) => { status = next; }, reportError, notify,
  });
  return { rhythm, setRhythm, reportError, notify, setStatus: (next: NativeStatus | null) => { status = next; }, disconnect: () => { connected = false; } };
}

describe('Native rhythm runtime adapter', () => {
  it('routes all Browser-compatible selections and preserves legacy pattern indices', async () => {
    const { rhythm, setRhythm } = createRuntime();
    for (const [legacy, patternIndex] of [['ROCK', 106], ['TECHNO', 198], ['METRONOME', 210]] as const) {
      await expect(rhythm.setPattern(legacy)).resolves.toBe(true);
      expect(setRhythm).toHaveBeenLastCalledWith(expect.objectContaining({ patternIndex }));
      expect(rhythm.patternMetadata.globalIndex).toBe(patternIndex);
    }
    await rhythm.setSettings({ patternIndex: 240, kitIndex: 16, variation: 'D', section: 'fill', swingPercent: 75, quantizeGrid: '1/4' });
    await rhythm.setVolume(0);
    await rhythm.setBpm(143);
    expect(rhythm.settings).toEqual({ enabled: false, bpm: 143, patternIndex: 240, kitIndex: 16, variation: 'D', section: 'fill', swingPercent: 75, quantizeGrid: '1/4', volume: 0 });
    await rhythm.setKit('STUDIO');
    await rhythm.setVariation('B');
    await rhythm.setSection('intro');
    await rhythm.setSwingPercent(67);
    await rhythm.setQuantizeGrid('1/8');
    expect(rhythm.settings).toMatchObject({ kitIndex: 1, variation: 'B', section: 'intro', swingPercent: 67, quantizeGrid: '1/8' });
    await rhythm.start();
    expect(rhythm.isRunning).toBe(true);
    expect(setRhythm).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, bpm: Transport.getInstance().bpm }));
    await rhythm.stop();
    expect(rhythm.isRunning).toBe(false);
  });

  it('fails closed for missing, unavailable, unhealthy, disconnected and old/incomplete statuses', async () => {
    const runtime = createRuntime();
    const unavailable = nativeRhythmStatus();
    unavailable.nativeRhythm!.available = false;
    unavailable.nativeRhythm!.statusNote = 'Native rhythm DSP was not built.';
    runtime.setStatus(unavailable);
    expect(runtime.rhythm.available).toBe(false);
    await expect(runtime.rhythm.start()).resolves.toBe(false);
    expect(runtime.rhythm.error).toContain('DSP was not built');
    runtime.setStatus({ ...nativeRhythmStatus(), nativeRhythm: undefined });
    expect(runtime.rhythm.available).toBe(false);
    const incomplete = nativeRhythmStatus();
    delete (incomplete.nativeRhythm as Partial<NativeRhythmConfig>).swingPercent;
    runtime.setStatus(incomplete);
    expect(runtime.rhythm.available).toBe(false);
    expect(runtime.rhythm.unavailableReason).toContain('does not report');
    runtime.setStatus({ ...nativeRhythmStatus(), bridgeHealthy: false });
    expect(runtime.rhythm.available).toBe(false);
    runtime.setStatus(nativeRhythmStatus({ enabled: true }));
    expect(runtime.rhythm.isRunning).toBe(true);
    runtime.disconnect();
    expect(runtime.rhythm.available).toBe(false);
    expect(runtime.rhythm.isRunning).toBe(false);
    expect(runtime.setRhythm).not.toHaveBeenCalled();
  });

  it('does not optimistically claim playback and serializes rapid edits against their preceding ACK', async () => {
    const runtime = createRuntime();
    let acknowledge!: (status: NativeStatus) => void;
    runtime.setRhythm.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const start = runtime.rhythm.start();
    const select = runtime.rhythm.setCatalogPattern(240);
    const volume = runtime.rhythm.setVolume(100);
    await Promise.resolve();
    expect(runtime.rhythm.isRunning).toBe(false);
    expect(runtime.setRhythm).toHaveBeenCalledTimes(1);
    acknowledge(nativeRhythmStatus({ enabled: true }));
    await expect(start).resolves.toBe(true);
    await expect(select).resolves.toBe(true);
    await expect(volume).resolves.toBe(true);
    expect(runtime.setRhythm).toHaveBeenNthCalledWith(3, expect.objectContaining({ enabled: true, patternIndex: 240, volume: 100 }));
    expect(runtime.rhythm.isRunning).toBe(true);
  });

  it('surfaces rejected/unsupported settings and errors without poisoning later commands', async () => {
    const runtime = createRuntime();
    runtime.setRhythm.mockRejectedValueOnce(new Error('Native host rejected live rhythm changes'));
    await expect(runtime.rhythm.start()).resolves.toBe(false);
    expect(runtime.rhythm.isRunning).toBe(false);
    expect(runtime.rhythm.error).toContain('rejected live');
    expect(runtime.reportError).toHaveBeenCalledOnce();
    await expect(runtime.rhythm.setVolume(101)).resolves.toBe(false);
    expect(runtime.setRhythm).toHaveBeenCalledOnce();
    await expect(runtime.rhythm.setVolume(77)).resolves.toBe(true);
    expect(runtime.rhythm.error).toBe('');
    runtime.setRhythm.mockResolvedValueOnce(nativeRhythmStatus({ volume: 12 }));
    await expect(runtime.rhythm.setVolume(20)).resolves.toBe(false);
    expect(runtime.rhythm.volume).toBe(12);
    expect(runtime.rhythm.error).toContain('not acknowledged');
  });

  it('wires capabilities and live shared BPM changes to the same Native client without ACK echoes', async () => {
    const engine = NativeAudioEngine.getInstance();
    const internals = engine as unknown as { bridge: NativeBridgeClient; applyStatus(status: NativeStatus): void; bridgeAvailable: boolean; latestStatus: NativeStatus | null };
    const setRhythm = vi.fn(async (config: NativeRhythmConfig) => nativeRhythmStatus(config));
    internals.bridge = { setRhythm } as unknown as NativeBridgeClient;
    internals.applyStatus(nativeRhythmStatus({ bpm: 91 }));
    expect(engine.supportsRhythm()).toBe(true);
    const facade = AudioEngine.getInstance();
    facade.setMode('native');
    expect(facade.getCapabilities()).toMatchObject({ supportsRhythm: true, rhythmReason: '' });
    expect(Transport.getInstance().bpm).toBe(91);
    expect(setRhythm).not.toHaveBeenCalled();
    Transport.getInstance().setBpm(137);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setRhythm).toHaveBeenCalledOnce();
    expect(setRhythm).toHaveBeenCalledWith(expect.objectContaining({ bpm: 137 }));
    setRhythm.mockRejectedValueOnce(new Error('Native rhythm BPM change rejected'));
    Transport.getInstance().setBpm(149);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Transport.getInstance().bpm).toBe(137);
    expect(engine.rhythmEngine.error).toContain('BPM change rejected');
    expect(setRhythm).toHaveBeenCalledTimes(2);
    internals.bridgeAvailable = false;
    expect(engine.supportsRhythm()).toBe(false);
    expect(facade.getCapabilities()).toMatchObject({ supportsRhythm: false, rhythmReason: expect.stringContaining('Connect the Native bridge') });
    internals.latestStatus = null;
    Transport.getInstance().setBpm(120);
  });

  it('routes per-track Native loop transport through AudioEngine and refreshes status from the host ACK', async () => {
    const status: NativeStatus = {
      ...nativeRhythmStatus(),
      nativeTracks: [{ trackId: 3, state: 'Stopped', loopProgress: 1, loopTransportStatus: 'waitingForPlayback' }],
    };
    const setLoopTransport = vi.fn(async (_trackId: number, _config: NativeLoopTransportConfig) => status);
    const engine = NativeAudioEngine.getInstance();
    const internals = engine as unknown as { bridge: NativeBridgeClient; bridgeAvailable: boolean; latestStatus: NativeStatus | null };
    internals.bridge = { setLoopTransport } as unknown as NativeBridgeClient;
    internals.bridgeAvailable = true;
    const facade = AudioEngine.getInstance();
    facade.setMode('native');
    const config: NativeLoopTransportConfig = {
      mode: 'beatShift', beatOffsetBeats: 0.5, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100,
    };

    await expect(facade.setNativeLoopTransport(3, config)).resolves.toBe(status);

    expect(setLoopTransport).toHaveBeenCalledWith(3, config);
    expect(facade.getNativeLoopTransportStatus(3)).toBe('waitingForPlayback');
    expect(facade.getNativeLoopTransportStatus(6)).toBeNull();
    setLoopTransport.mockRejectedValueOnce(new Error('Native loop-transport update was rejected'));
    await expect(facade.setNativeLoopTransport(3, config)).rejects.toThrow('Native loop-transport update was rejected');
  });
});
