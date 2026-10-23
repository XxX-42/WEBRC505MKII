import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadEngineForSearch(search: string) {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState({}, '', search);
  const module = await import('../../src/audio/AudioEngine');
  return module.AudioEngine.getInstance();
}

describe('AudioEngine capabilities', () => {
  beforeEach(async () => {
    localStorage.clear();
    // Transform cold dependencies in the hook; each loader still resets module state.
    await import('../../src/audio/AudioEngine');
  });

  it('routes the Browser output knob through the master gain and bounds its value', async () => {
    const engine = await loadEngineForSearch('/?audio=browser');
    expect(engine.getCapabilities().supportsOutputLevel).toBe(true);
    expect(engine.getOutputLevel()).toBe(100);
    await engine.setOutputLevel(35);
    expect(engine.getOutputLevel()).toBe(35);
    expect((engine as any).browser.masterGainNode.gain.value).toBe(0.35);
    await engine.setOutputLevel(180);
    expect(engine.getOutputLevel()).toBe(100);
    await expect(engine.setOutputLevel(NaN)).rejects.toThrow('finite');
  });

  it('keeps the Native output knob unavailable for an older host without mixer readback', async () => {
    const engine = await loadEngineForSearch('/?audio=native');
    expect(engine.getCapabilities().supportsOutputLevel).toBe(false);
    expect(engine.getCapabilities().outputLevelReason).toContain('does not expose software mixer levels');
    await expect(engine.setOutputLevel(50)).rejects.toThrow('does not expose software mixer levels');
    expect(engine.getOutputLevel()).toBe(0);
  });

  it('publishes Native output levels only from confirmed mixer readback', async () => {
    const engine = await loadEngineForSearch('/?audio=native');
    const native = (engine as any).nativeEngine;
    const status = {
      ok: true, bridgeHealthy: true, engineRunning: true, backend: 'WASAPI',
      inputDeviceId: 'in', outputDeviceId: 'out', sampleRate: 48000, bufferFrames: 256,
      nativeSampleFrame: 48000, monitoringEnabled: false, state: 'Empty',
      inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0,
      inputPeak: 0, outputPeak: 0, xrunsOrDropouts: 0, lastError: '', loopProgress: 0,
      mixerLevels: [100, 100, 100, 100, 100, 100, 100],
    };
    native.latestStatus = status;
    let acknowledge!: (value: typeof status) => void;
    native.bridge.setMixerLevel = vi.fn(() => new Promise<typeof status>((resolve) => { acknowledge = resolve; }));
    expect(engine.getCapabilities().supportsOutputLevel).toBe(true);
    const pending = engine.setOutputLevel(35);
    expect(native.bridge.setMixerLevel).toHaveBeenCalledExactlyOnceWith(1, 35);
    expect(engine.getOutputLevel()).toBe(100);
    acknowledge({ ...status, mixerLevels: [100, 34, 100, 100, 100, 100, 100] });
    await pending;
    expect(engine.getOutputLevel()).toBe(34);
    await expect(engine.setOutputLevel(NaN)).rejects.toThrow('finite');
    expect(engine.getOutputLevel()).toBe(34);
  });

  it('reports browser track capabilities and incomplete DSP parity', async () => {
    const engine = await loadEngineForSearch('/?audio=browser');

    expect(engine.getCapabilities()).toMatchObject({
      mode: 'browser',
      modeSummary: 'BROWSER: 5 TRACKS; LIMITED EFFECTS/RHYTHM; DSP PARITY INCOMPLETE',
      supportedTrackCount: 5,
      supportsInputFx: true,
      supportsTrackFx: true,
      supportsReverse: true,
      supportsRhythm: true,
      supportsBeatFeedback: true,
    });
    expect(engine.getTrackCapabilities(3)).toMatchObject({
      isAvailable: true,
      supportsTrackLevel: true,
      supportsTrackFx: true,
      supportsReverse: true,
    });
  });

  it('keeps Native catalog FX unavailable until the host reports its capabilities', async () => {
    const engine = await loadEngineForSearch('/?audio=native');

    expect(engine.getCapabilities()).toMatchObject({
      mode: 'native',
      modeSummary: 'NATIVE: 1 LOOP TRACK; INPUT A–D UNAVAILABLE; TRACK A–D UNAVAILABLE',
      supportedTrackCount: 1,
      supportsTrackFx: false,
      supportsInputFx: false,
      supportsRhythm: false,
      supportsReverse: false,
      supportsBeatFeedback: false,
      fxReason: 'Connect the Native bridge to read the available Input and Track catalog FX.',
    });
    expect(engine.supportsFx()).toBe(false);
    expect(engine.getTrackCapabilities(1)).toMatchObject({
      isAvailable: true,
      supportsTrackLevel: false,
      levelReason: 'TRACK MIX IN BROWSER ONLY',
      supportsTrackFx: false,
    });
    expect(engine.getTrackCapabilities(2)).toMatchObject({
      isAvailable: false,
      availabilityReason: 'TRACK 2 IS NOT EXPOSED BY THE NATIVE HOST',
      trackFxReason: 'TRACK 2 IS NOT EXPOSED BY THE NATIVE HOST',
      reverseReason: 'TRACK 2 IS NOT EXPOSED BY THE NATIVE HOST',
    });
  });

  it('enables only host-reported Native loops and keeps per-strip FX distinct from the shared Track bank', async () => {
    const engine = await loadEngineForSearch('/?audio=native');
    const nativeEngine = (engine as any).nativeEngine;
    nativeEngine.bridgeAvailable = true;
    nativeEngine.engineRunning = true;
    nativeEngine.latestStatus = {
      state: 'Empty',
      nativeLooperTrackCount: 5,
      nativeLooperMultiTrackImplemented: true,
      nativeLooperTracksStereo: true,
      nativeTracks: Array.from({ length: 5 }, (_, index) => ({
        trackId: index + 1, state: 'Empty', loopProgress: 0,
      })),
      nativeFx: {
        catalogGraphAvailable: true,
        implementedCatalogEffects: ['filter.lpf'],
        catalogEffectAvailability: [{ effectId: 'filter.lpf', input: true, track: true }],
      },
    };

    expect(engine.tracks).toHaveLength(5);
    expect(engine.getCapabilities()).toMatchObject({
      supportedTrackCount: 5,
      modeSummary: 'NATIVE: 5 LOOP TRACKS; INPUT A–D AVAILABLE; TRACK A–D AVAILABLE',
      supportsTrackFx: true,
    });
    for (let trackId = 1; trackId <= 5; trackId += 1) {
      expect(engine.isTrackAvailable(trackId)).toBe(true);
      expect(engine.getTrackCapabilities(trackId)).toMatchObject({
        isAvailable: true,
        supportsTrackLevel: false,
        supportsTrackFx: false,
        trackFxReason: 'NATIVE TRACK A–D FX USE A SHARED POSTMIX BUS; PER-TRACK FILTER CONTROLS ARE UNAVAILABLE',
      });
    }
    expect(engine.isTrackAvailable(6)).toBe(false);
    expect(engine.getTrackCapabilities(6).isAvailable).toBe(false);
  });

  it('routes Native Web MIDI notes only to the acknowledged OSC VOC slot at an absolute sample frame', async () => {
    const engine = await loadEngineForSearch('/?audio=native');
    const nativeEngine = (engine as any).nativeEngine;
    nativeEngine.bridgeAvailable = true;
    nativeEngine.engineRunning = true;
    nativeEngine.nativeCatalogFxStates.input[1].type = 'OSC VOC (M)';
    nativeEngine.nativeCatalogFxRuntime.set('input:B', {
      path: 'input', slot: 'B', requestedEffectId: 'osc_voc_m', acknowledgedEffectId: 'osc_voc_m',
      requestedParameters: {}, acknowledgedParameters: {}, acknowledged: true, pendingRestart: false, error: '',
    });
    nativeEngine.latestStatus = {
      ok: true, bridgeHealthy: true, engineRunning: true, backend: 'WASAPI', inputDeviceId: 'in', outputDeviceId: 'out',
      inputDeviceName: 'Input', outputDeviceName: 'Output', sampleRate: 48_000, bufferFrames: 256,
      nativeSampleFrame: 48_000, monitoringEnabled: false, state: 'Empty', inputLatencyMs: 0, outputLatencyMs: 0,
      roundTripEstimateMs: 0, inputPeak: 0, outputPeak: 0, xrunsOrDropouts: 0, lastError: '', loopProgress: 0,
      nativeFx: { inputCatalogSlots: [{ slot: 'B', effectId: 'osc_voc_m' }], catalogSlots: [] },
    };
    nativeEngine.nativeOscVocFrameObservedAtMs = performance.now();
    const queueEvent = vi.fn(async (event: unknown) => event);
    nativeEngine.queueCatalogMidiEvent = queueEvent;

    const midiListeners = new Set<(event: { data: number[]; timeStamp: number }) => void>();
    const input = {
      addEventListener: (_type: 'midimessage', listener: (event: { data: number[]; timeStamp: number }) => void) => midiListeners.add(listener),
      removeEventListener: (_type: 'midimessage', listener: (event: { data: number[]; timeStamp: number }) => void) => midiListeners.delete(listener),
    };
    const stateListeners = new Set<() => void>();
    const access = {
      inputs: { forEach: (callback: (value: typeof input) => void) => callback(input) },
      addEventListener: (_type: 'statechange', listener: () => void) => stateListeners.add(listener),
      removeEventListener: (_type: 'statechange', listener: () => void) => stateListeners.delete(listener),
    };
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: vi.fn(async () => access) });

    expect(await engine.connectMidiInput({ path: 'input', slot: 'B' })).toBe('connected');
    const anchor = nativeEngine.getOscVocMidiFrameAnchor();
    expect(anchor).not.toBeNull();
    const timestamp = anchor!.observedAtPerformanceTimeMs + 12;
    for (const listener of midiListeners) listener({ data: [0x93, 69, 100], timeStamp: timestamp });
    await vi.waitFor(() => expect(queueEvent).toHaveBeenCalledOnce());
    expect(queueEvent).toHaveBeenCalledWith({
      effectId: 'osc_voc_m', path: 'input', slot: 'B', type: 'noteOn', channel: 4, note: 69, velocity: 100,
      frame: 48_000 + 960 + 576,
    });

    for (const listener of midiListeners) listener({ data: [0x83, 69, 0], timeStamp: timestamp + 8 });
    await vi.waitFor(() => expect(queueEvent).toHaveBeenCalledTimes(2));
    expect(queueEvent).toHaveBeenLastCalledWith({
      effectId: 'osc_voc_m', path: 'input', slot: 'B', type: 'noteOff', channel: 4, note: 69, velocity: 0,
      frame: 48_000 + 960 + 960,
    });

    for (const listener of midiListeners) listener({ data: [0x93, 70, 80], timeStamp: timestamp + 16 });
    await vi.waitFor(() => expect(queueEvent).toHaveBeenCalledTimes(3));
    engine.disconnectMidiInput();
    await vi.waitFor(() => expect(queueEvent).toHaveBeenCalledTimes(4));
    expect(queueEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      effectId: 'osc_voc_m', path: 'input', slot: 'B', type: 'noteOff', channel: 4, note: 70, velocity: 0,
    }));
  });
});
