import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { MemorySettings, TrackState } from '../../src/core/types';

interface MockTrack {
  track: { id: number };
  state: string;
  play: ReturnType<typeof vi.fn>;
  triggerStop: ReturnType<typeof vi.fn>;
  getLastActionError: ReturnType<typeof vi.fn>;
}

function mockTrack(id: number, state: string): MockTrack {
  return {
    track: { id },
    state,
    play: vi.fn().mockResolvedValue(undefined),
    triggerStop: vi.fn().mockResolvedValue(undefined),
    getLastActionError: vi.fn().mockReturnValue(null),
  };
}

function engineWith(tracks: MockTrack[], settings = new MemorySettings()): BrowserAudioEngine {
  return Object.assign(Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine, {
    tracks,
    memorySettings: settings,
  });
}

describe('BrowserAudioEngine bulk transport', () => {
  it('awaits all stopped tracks by default and skips empty tracks', async () => {
    const tracks = [
      mockTrack(1, TrackState.STOPPED),
      mockTrack(2, TrackState.EMPTY),
      mockTrack(3, TrackState.STOPPED),
      mockTrack(4, TrackState.PLAYING),
      mockTrack(5, TrackState.STOPPED),
    ];
    const engine = engineWith(tracks);

    await engine.playAllTracks();

    expect(tracks.map((track) => track.play.mock.calls.length)).toEqual([1, 0, 1, 0, 1]);
  });

  it('uses explicit all-start and all-stop masks from the active Memory', async () => {
    const tracks = [
      mockTrack(1, TrackState.STOPPED),
      mockTrack(2, TrackState.STOPPED),
      mockTrack(3, TrackState.PLAYING),
      mockTrack(4, TrackState.STOPPED),
      mockTrack(5, TrackState.PLAYING),
    ];
    const settings = new MemorySettings();
    settings.allStartTrk = [false, true, false, false, false];
    settings.allStopTrk = [false, false, true, false, true];
    const engine = engineWith(tracks, settings);

    await engine.playAllTracks();
    await engine.stopAllTracks();

    expect(tracks.map((track) => track.play.mock.calls.length)).toEqual([0, 1, 0, 0, 0]);
    expect(tracks.map((track) => track.triggerStop.mock.calls.length)).toEqual([0, 0, 1, 0, 1]);
  });

  it('rejects after all selected commands settle and includes per-track ACK failures', async () => {
    const tracks = [mockTrack(1, TrackState.STOPPED), mockTrack(2, TrackState.STOPPED)];
    const delayed = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    tracks[0].play = delayed;
    tracks[1].play.mockImplementation(async () => {
      tracks[1].getLastActionError.mockReturnValue('Worklet rejected PLAY (status 7).');
    });
    const engine = engineWith(tracks);

    await expect(engine.playAllTracks()).rejects.toThrow('Track 2 play failed: Worklet rejected PLAY (status 7).');
    expect(delayed).toHaveResolved();
  });
});
