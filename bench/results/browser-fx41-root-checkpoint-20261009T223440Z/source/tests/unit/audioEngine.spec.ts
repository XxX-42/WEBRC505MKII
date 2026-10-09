import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let audioEngineModule: typeof import('../../src/audio/AudioEngine') | null = null;

async function loadEngineForSearch(search: string) {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState({}, '', search);
  const module = await import('../../src/audio/AudioEngine');
  audioEngineModule = module;
  return module.AudioEngine.getInstance();
}

describe('AudioEngine capabilities', () => {
  beforeAll(async () => {
    // Warm the shared engine module outside individual assertions. Under a
    // parallel Vitest run this cold transform can outlast one test timeout.
    audioEngineModule = await import('../../src/audio/AudioEngine');
  }, 15000);

  beforeEach(() => {
    localStorage.clear();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports full browser capabilities', async () => {
    const engine = await loadEngineForSearch('/?audio=browser');

    expect(engine.getCapabilities()).toMatchObject({
      mode: 'browser',
      modeSummary: 'BROWSER: FULL TRACK CONTROLS',
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

  it('reports native v1 capability limits and unavailable tracks', async () => {
    const engine = await loadEngineForSearch('/?audio=native');

    expect(engine.getCapabilities()).toMatchObject({
      mode: 'native',
      modeSummary: 'NATIVE V1: TRACK 1 ONLY',
      supportedTrackCount: 1,
      supportsTrackFx: false,
      supportsRhythm: false,
      supportsReverse: false,
      supportsBeatFeedback: false,
    });
    expect(engine.getTrackCapabilities(1)).toMatchObject({
      isAvailable: true,
      supportsTrackLevel: false,
      levelReason: 'TRACK MIX IN BROWSER ONLY',
    });
    expect(engine.getTrackCapabilities(2)).toMatchObject({
      isAvailable: false,
      availabilityReason: 'TRACK 2 UNAVAILABLE IN NATIVE V1',
      trackFxReason: 'TRACK 2 UNAVAILABLE IN NATIVE V1',
      reverseReason: 'TRACK 2 UNAVAILABLE IN NATIVE V1',
    });
  });

  it('reports the versioned Native five-track host without claiming FX it has not wired', async () => {
    const engine = await loadEngineForSearch('/?audio=native');
    const native = (engine as unknown as { nativeEngine: { latestStatus: unknown } }).nativeEngine;
    native.latestStatus = { trackEngineVersion: 2, trackCount: 5 };

    expect(engine.getCapabilities()).toMatchObject({
      mode: 'native',
      modeSummary: 'NATIVE V2: FIVE STEREO TRACKS',
      supportedTrackCount: 5,
      supportsInputFx: false,
      supportsTrackFx: false,
      trackLevelReason: '',
    });
    expect(engine.getTrackCapabilities(5)).toMatchObject({
      isAvailable: true,
      supportsTrackLevel: true,
      supportsTrackFx: false,
    });
    expect(engine.getTrackCapabilities(6)).toMatchObject({ isAvailable: false });
  });

  it('sends Native v2 track mix settings to the bridge and syncs the acknowledged status', async () => {
    const engine = await loadEngineForSearch('/?audio=native');
    const native = (engine as unknown as {
      nativeEngine: { applyStatus: (status: unknown) => void };
    }).nativeEngine;
    const makeStatus = (
      mix?: Partial<{ gain: number; pan: number; muted: boolean; solo: boolean; inputRouted: boolean }>,
      trackState: 'Empty' | 'Playing' = 'Empty',
    ) => ({
      ok: true,
      bridgeHealthy: true,
      engineRunning: true,
      backend: 'WASAPI' as const,
      inputDeviceId: 'input',
      outputDeviceId: 'output',
      inputDeviceName: 'Input',
      outputDeviceName: 'Output',
      sampleRate: 48000,
      bufferFrames: 128,
      trackEngineVersion: 2,
      trackCount: 5,
      trackBufferSeconds: 60,
      trackMemoryBudgetBytes: 1_000_000,
      trackHistoryBytes: 1000,
      nextAudioFrame: 0,
      tempoBpm: 120,
      tracks: Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        state: trackState,
        recordedFrames: 0,
        loopFrames: 0,
        playhead: 0,
        progress: 0,
        gain: mix?.gain ?? 1,
        pan: mix?.pan ?? 0,
        muted: mix?.muted ?? false,
        solo: mix?.solo ?? false,
        inputRouted: mix?.inputRouted ?? true,
        bufferPrepared: true,
      })),
      monitoringEnabled: false,
      state: trackState,
      inputLatencyMs: null,
      outputLatencyMs: null,
      roundTripEstimateMs: null,
      physicalRoundTripMs: null,
      driverReportedStreamLatencyMs: null,
      inputLatencySource: '',
      outputLatencySource: '',
      driverReportedStreamLatencySource: '',
      roundTripLatencyNote: '',
      inputPeak: 0,
      outputPeak: 0,
      xrunsOrDropouts: 0,
      callbackStatusFaults: 0,
      inputQueueOverruns: 0,
      outputQueueUnderruns: 0,
      callbackFrameLimitViolations: 0,
      droppedCommands: 0,
      outputQueueDepthBlocks: 0,
      outputQueueCapacityBlocks: 0,
      callbackTicks: 0,
      inputCallbackTicks: 0,
      outputCallbackTicks: 0,
      callbackCountSkew: 0,
      lastError: '',
      loopProgress: 0,
    });
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    let rejectNextRequest = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (rejectNextRequest) {
        rejectNextRequest = false;
        return { json: async () => ({ ok: false, error: 'track command queue full' }) } as Response;
      }
      return { json: async () => makeStatus() } as Response;
    }));

    native.applyStatus(makeStatus());
    const track = engine.tracks[2] as unknown as {
      track: { playLevel: number; pan: number | string };
      muted: boolean;
      solo: boolean;
      inputRouted: boolean;
      updateSettings: () => Promise<void>;
    };
    track.track.playLevel = 150;
    track.track.pan = -25;
    track.muted = true;
    track.solo = true;
    track.inputRouted = false;
    await track.updateSettings();

    expect(requests.map((request) => request.path)).toEqual([
      '/v2/tracks/3/gain', '/v2/tracks/3/pan', '/v2/tracks/3/mute',
      '/v2/tracks/3/solo', '/v2/tracks/3/input-route',
    ]);
    expect(requests.map((request) => request.body)).toEqual([
      { value: 1.5 }, { value: -0.5 }, { enabled: true }, { enabled: true }, { enabled: false },
    ]);
    // The status endpoint may precede the callback boundary. Keep the UI's
    // pending values until the audio owner publishes the queued state.
    expect(track.track.playLevel).toBe(150);
    native.applyStatus(makeStatus({ gain: 1.5, pan: -0.5, muted: true, solo: true, inputRouted: false }));
    native.applyStatus(makeStatus({ gain: 0.8, pan: -0.5, muted: true, solo: true, inputRouted: false }));
    expect(track.track.playLevel).toBe(80);
    expect(track.track.pan).toBe('L25');
    expect(track.muted).toBe(true);
    expect(track.solo).toBe(true);
    expect(track.inputRouted).toBe(false);

    native.applyStatus(makeStatus(undefined, 'Playing'));
    const playingState = engine.tracks[2].state;
    rejectNextRequest = true;
    track.track.playLevel = 170;
    await expect(track.updateSettings()).rejects.toThrow('track command queue full');
    expect(engine.tracks[2].state).toBe(playingState);
    expect(engine.getUiStatus()).toMatchObject({
      bridgeAvailable: true,
      engineRunning: true,
      ready: true,
      lastError: 'track command queue full',
    });
    native.applyStatus({ ...makeStatus(), engineRunning: false });
    expect(track.track.playLevel).toBe(100);
  });

  it('keeps an unverified browser route calibration separate from physical round-trip latency', async () => {
    const engine = await loadEngineForSearch('/?audio=browser');

    engine.setLatency(8);

    expect(engine.getLatencyInfo()).toMatchObject({
      roundTripLatencyMs: 8,
      physicalRoundTripMs: null,
      roundTripLatencyNote: expect.stringContaining('not independently verified as analog hardware'),
    });
  });
});
