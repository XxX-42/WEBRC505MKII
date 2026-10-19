import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAudioContext } from '../helpers/audioTestUtils';

const exportHarness = vi.hoisted(() => ({
  createHqWavExport: vi.fn(),
}));

vi.mock('../../src/audio/export/hqWavExport', () => ({
  createHqWavExport: exportHarness.createHqWavExport,
}));

describe('TrackAudio HQ WAV export integration', () => {
  beforeEach(() => {
    exportHarness.createHqWavExport.mockReset();
  });

  async function makeTrack() {
    const [{ TrackAudio }, { Track, TrackState }] = await Promise.all([
      import('../../src/audio/TrackAudio'),
      import('../../src/core/types'),
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
      tracks: [],
    };
    const trackAudio = new TrackAudio(engine as never, new Track(2), 1, null, null);
    return { context, TrackState, trackAudio };
  }

  it('passes a read-only mono/stereo snapshot configuration to the offline renderer', async () => {
    const { context, TrackState, trackAudio } = await makeTrack();
    const buffer = context.createBuffer(2, 3, 48_000);
    buffer.getChannelData(0).set([0.1, 0.2, 0.3]);
    buffer.getChannelData(1).set([-0.1, -0.2, -0.3]);
    (trackAudio as any).audioBuffer = buffer;
    trackAudio.state = TrackState.STOPPED;
    const exportResult = { mode: 'HQ_RENDER', bytes: new Uint8Array(48), frameCount: 3 };
    exportHarness.createHqWavExport.mockResolvedValue(exportResult);
    const progress = vi.fn();

    const result = await trackAudio.exportHqWav({
      semitones: -7,
      playbackRate: 0.8,
      format: 'pcm24',
    }, progress);

    expect(trackAudio.canExportHqWav).toBe(true);
    expect(exportHarness.createHqWavExport).toHaveBeenCalledWith(
      [buffer.getChannelData(0), buffer.getChannelData(1)],
      { semitones: -7, playbackRate: 0.8, format: 'pcm24', sampleRate: 48_000 },
      progress,
    );
    expect(result).toBe(exportResult);
    expect(buffer.getChannelData(0)).toEqual(new Float32Array([0.1, 0.2, 0.3]));
    expect(buffer.getChannelData(1)).toEqual(new Float32Array([-0.1, -0.2, -0.3]));
  });

  it('preserves recorded Browser L/R identity through the HQ export handoff', async () => {
    const { context, TrackState, trackAudio } = await makeTrack();
    const privateApi = trackAudio as unknown as {
      processRecordedBuffer: (buffer: Float32Array, channelCount: 1 | 2) => void;
      resumeAfterRecording: boolean;
      audioBuffer: AudioBuffer | null;
    };
    privateApi.resumeAfterRecording = false;
    privateApi.processRecordedBuffer(Float32Array.from([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]), 2);
    trackAudio.state = TrackState.STOPPED;
    const exportResult = { mode: 'HQ_RENDER', bytes: new Uint8Array(48), frameCount: 3 };
    exportHarness.createHqWavExport.mockResolvedValue(exportResult);

    await expect(trackAudio.exportHqWav({
      semitones: 0,
      playbackRate: 1,
      format: 'pcm16',
    })).resolves.toBe(exportResult);

    const [channels, options] = exportHarness.createHqWavExport.mock.calls[0] ?? [];
    expect(Array.from(channels?.[0] ?? [])).toEqual(
      Array.from(new Float32Array([0.1, 0.2, 0.3])),
    );
    expect(Array.from(channels?.[1] ?? [])).toEqual(
      Array.from(new Float32Array([-0.1, -0.2, -0.3])),
    );
    expect(options).toMatchObject({ sampleRate: context.sampleRate, format: 'pcm16' });
  });

  it('rejects export while the track is recording and when it has no audio buffer', async () => {
    const { context, TrackState, trackAudio } = await makeTrack();
    await expect(trackAudio.exportHqWav({ semitones: 0, playbackRate: 1, format: 'pcm16' }))
      .rejects.toThrow(/no completed audio buffer/);

    (trackAudio as any).audioBuffer = context.createBuffer(1, 64, 48_000);
    trackAudio.state = TrackState.RECORDING;
    expect(trackAudio.canExportHqWav).toBe(false);
    await expect(trackAudio.exportHqWav({ semitones: 0, playbackRate: 1, format: 'pcm16' }))
      .rejects.toThrow(/no completed audio buffer/);
    expect(exportHarness.createHqWavExport).not.toHaveBeenCalled();
  });

  it('rejects buffers outside the renderer one/two-channel contract', async () => {
    const { context, TrackState, trackAudio } = await makeTrack();
    (trackAudio as any).audioBuffer = context.createBuffer(3, 64, 48_000);
    trackAudio.state = TrackState.STOPPED;

    await expect(trackAudio.exportHqWav({ semitones: 0, playbackRate: 1, format: 'pcm16' }))
      .rejects.toThrow(/one or two channels/);
    expect(exportHarness.createHqWavExport).not.toHaveBeenCalled();
  });
});
