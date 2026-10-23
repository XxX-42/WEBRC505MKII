import { describe, expect, it, vi } from 'vitest';
import { PcmHistoryBudget } from '../../src/audio/PcmHistoryBudget';
import { TrackAudio } from '../../src/audio/TrackAudio';
import { TrackState, Track } from '../../src/core/types';
import { createMockAudioContext } from '../helpers/audioTestUtils';

function createTrack(limitBytes = 128) {
  const context = createMockAudioContext();
  const budget = new PcmHistoryBudget(limitBytes);
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
    tracks: [] as TrackAudio[],
  };
  const trackAudio = new TrackAudio(engine as never, new Track(1), 0, null, null, budget);
  engine.tracks = [trackAudio];
  return { context, budget, trackAudio };
}

function installStereoLoop(context: AudioContext, trackAudio: TrackAudio) {
  const live = context.createBuffer(2, 4, context.sampleRate);
  const left = new Float32Array([-0.75, -0.25, 0.25, 0.75]);
  const right = new Float32Array([0.9, 0.7, -0.7, -0.9]);
  live.copyToChannel(left, 0);
  live.copyToChannel(right, 1);
  (trackAudio as any).audioBuffer = live;
  (trackAudio as any).hasCommittedOverdub = true;
  trackAudio.state = TrackState.STOPPED;
  return { live, left: Array.from(left), right: Array.from(right) };
}

describe('Browser independent MARK SET/CLEAR', () => {
  it('only allows stable committed overdubs, clones stereo PCM independently, and clear preserves history', () => {
    const { context, budget, trackAudio } = createTrack();
    const historyOwner = {};
    expect(budget.replace(historyOwner, 32)).toBe(true);
    const { live, left, right } = installStereoLoop(context, trackAudio);

    expect(trackAudio.getMarkState()).toMatchObject({ supported: true, exists: false, canSet: true, canClear: false });
    const set = trackAudio.setMark();
    expect(set.ok).toBe(true);
    expect(set.state).toMatchObject({ exists: true, canSet: false, canClear: true, backSupported: false });
    expect(set.state.retainedPcmBytes).toBe(32);
    expect(budget.retainedBytes).toBe(64);

    const marked = (trackAudio as any).markedPcm as AudioBuffer;
    expect(marked).not.toBe(live);
    expect(Array.from(marked.getChannelData(0))).toEqual(left);
    expect(Array.from(marked.getChannelData(1))).toEqual(right);

    live.getChannelData(0).fill(0.125);
    live.getChannelData(1).fill(-0.25);
    expect(Array.from(marked.getChannelData(0))).toEqual(left);
    expect(Array.from(marked.getChannelData(1))).toEqual(right);
    expect(trackAudio.setMark().ok).toBe(false);

    const historyBytesBeforeClear = budget.retainedBytes;
    const clear = trackAudio.clearMark();
    expect(clear.ok).toBe(true);
    expect(clear.state).toMatchObject({ exists: false, canSet: true, canClear: false, backSupported: false });
    expect(clear.state.requestedGeneration).toBe(2);
    expect(clear.state.appliedGeneration).toBe(2);
    expect(budget.retainedBytes).toBe(historyBytesBeforeClear - 32);
    expect(Array.from(live.getChannelData(0))).toEqual([0.125, 0.125, 0.125, 0.125]);
    expect(Array.from(live.getChannelData(1))).toEqual([-0.25, -0.25, -0.25, -0.25]);
  });

  it('rejects empty, uncommitted, recording, and overdubbing states', () => {
    const { context, trackAudio } = createTrack();
    expect(trackAudio.getMarkState().canSet).toBe(false);

    installStereoLoop(context, trackAudio);
    (trackAudio as any).hasCommittedOverdub = false;
    expect(trackAudio.getMarkState().canSet).toBe(false);
    (trackAudio as any).hasCommittedOverdub = true;

    trackAudio.state = TrackState.RECORDING;
    expect(trackAudio.getMarkState().canSet).toBe(false);
    trackAudio.state = TrackState.OVERDUBBING;
    expect(trackAudio.getMarkState().canSet).toBe(false);
  });

  it('checks the shared history budget before allocating the independent mark clone', () => {
    const { context, budget, trackAudio } = createTrack(48);
    installStereoLoop(context, trackAudio);
    const historyOwner = {};
    expect(budget.replace(historyOwner, 24)).toBe(true);
    const createBuffer = vi.spyOn(context, 'createBuffer');
    const callsBeforeSet = createBuffer.mock.calls.length;

    const result = trackAudio.setMark();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/512 MiB|history budget/i);
    expect(createBuffer).toHaveBeenCalledTimes(callsBeforeSet);
    expect((trackAudio as any).markedPcm).toBeNull();
    expect(budget.retainedBytes).toBe(24);
  });
});
