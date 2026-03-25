import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';

describe('TrackAudio transport sync helpers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function createTrackAudioHarness() {
    const [{ TrackAudio }, { Track, TrackState, TransportState }, { Transport }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
      import('../../src/core/Transport'),
    ]);

    const context = createMockAudioContext();
    const engine = {
      context,
      trackMixNode: context.createGain(),
      roundTripLatency: 0,
      selectedInputDeviceId: null,
      selectedOutputDeviceId: null,
      selectedBufferFrames: 128,
      getInputStream: async () => context.createMediaStreamSource({} as MediaStream),
      getProcessedInputNode: async () => context.createGain(),
      checkAndResetMaster: vi.fn(),
      tracks: [] as Array<{ state: typeof TrackState[keyof typeof TrackState] }>,
    };

    const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null);
    engine.tracks = [trackAudio];

    return { TrackState, TransportState, Transport: Transport.getInstance(), trackAudio };
  }

  it('starts transport when an active track is present', async () => {
    const { TrackState, TransportState, Transport, trackAudio } = await createTrackAudioHarness();
    Transport.stop();
    trackAudio.state = TrackState.PLAYING;

    (trackAudio as any).syncTransportState();

    expect(Transport.state).toBe(TransportState.PLAYING);
  });

  it('stops transport when all tracks are stopped or empty', async () => {
    const { TrackState, TransportState, Transport, trackAudio } = await createTrackAudioHarness();
    trackAudio.state = TrackState.STOPPED;
    Transport.start();

    (trackAudio as any).syncTransportState();

    expect(Transport.state).toBe(TransportState.STOPPED);
  });
});
