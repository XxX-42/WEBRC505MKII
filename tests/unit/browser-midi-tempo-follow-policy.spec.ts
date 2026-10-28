import { describe, expect, it } from 'vitest';
import { TrackState } from '../../src/core/types';
import {
  getBrowserMidiTempoFollowEligibility,
  getSingleBrowserMidiTempoFollowCandidate,
  LatestTargetRunner,
} from '../../src/audio/BrowserMidiTempoFollowPolicy';

const eligible = () => ({
  hasCommittedPhrase: true,
  originalRecordingBpm: 120,
  livePolyPitchActive: true,
  state: TrackState.PLAYING,
});

describe('Browser MIDI LIVE_POLY tempo-follow policy', () => {
  it('allows only the single playing loop with known recording BPM and active LIVE_POLY', () => {
    const track = eligible();
    expect(getSingleBrowserMidiTempoFollowCandidate([track])).toEqual({ track, sourceBpm: 120 });
  });

  it('fails closed for empty, multiple, unknown-tempo, stopped, or non-LIVE_POLY loops', () => {
    expect(getSingleBrowserMidiTempoFollowCandidate([])).toBeNull();
    expect(getSingleBrowserMidiTempoFollowCandidate([eligible(), eligible()])).toBeNull();
    expect(getSingleBrowserMidiTempoFollowCandidate([{ ...eligible(), originalRecordingBpm: null }])).toBeNull();
    expect(getSingleBrowserMidiTempoFollowCandidate([{ ...eligible(), state: TrackState.STOPPED }])).toBeNull();
    expect(getSingleBrowserMidiTempoFollowCandidate([{ ...eligible(), livePolyPitchActive: false }])).toBeNull();
    expect(getSingleBrowserMidiTempoFollowCandidate([{ ...eligible(), livePolyTempoFollowPending: true }])).not.toBeNull();
  });

  it('explains and rejects one-shot loops and source-aware loop transport effects', () => {
    const oneShot = getBrowserMidiTempoFollowEligibility([{
      ...eligible(),
      track: { oneShot: 'ON' as const },
    }]);
    expect(oneShot.candidate).toBeNull();
    expect(oneShot.reason).toContain('one-shot');

    const configuredTransportFx = getBrowserMidiTempoFollowEligibility([{
      ...eligible(),
      loopTransportUnavailableReason: 'BEAT SHIFT and VINYL FLICK loop read-heads are unavailable while LIVE_POLY playback is enabled',
    }]);
    expect(configuredTransportFx.candidate).toBeNull();
    expect(configuredTransportFx.reason).toContain('source-aware loop transport effect');

    const activeTransportFx = getBrowserMidiTempoFollowEligibility([{
      ...eligible(),
      loopTransportActive: true,
    }]);
    expect(activeTransportFx.candidate).toBeNull();
    expect(activeTransportFx.reason).toContain('source-aware loop transport effect');
  });

  it('serializes retargets and coalesces intermediate tempo values to the latest target', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const applied: number[] = [];
    const runner = new LatestTargetRunner<number>(async (target) => {
      applied.push(target);
      if (applied.length === 1) await firstPending;
    });

    runner.offer(120);
    runner.offer(121);
    runner.offer(123);
    expect(applied).toEqual([120]);
    releaseFirst();
    await runner.waitForIdle();
    expect(applied).toEqual([120, 123]);
  });

  it('drops a queued target after stop or source change invalidates the session', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const applied: number[] = [];
    const runner = new LatestTargetRunner<number>(async (target) => {
      applied.push(target);
      await firstPending;
    });

    runner.offer(120);
    runner.offer(125);
    runner.invalidate();
    releaseFirst();
    await runner.waitForIdle();
    expect(applied).toEqual([120]);
  });
});
