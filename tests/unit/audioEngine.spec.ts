import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadEngineForSearch(search: string) {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState({}, '', search);
  const module = await import('../../src/audio/AudioEngine');
  return module.AudioEngine.getInstance();
}

describe('AudioEngine capabilities', () => {
  beforeEach(() => {
    localStorage.clear();
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
});
