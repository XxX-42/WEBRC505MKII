import { describe, expect, it } from 'vitest';
import {
  ActiveWorkletCoverageTracker,
  readCoherentWorkletCounters,
  summarizeActiveWorkletCoverage,
} from '../../bench/active_worklet_coverage';

describe('Browser stress worklet active-interval coverage', () => {
  it('measures a retired processor only over its actual active interval', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    const counters = { frames: 0, callbacks: 0, callbackErrors: 0 };
    const read = () => ({ ...counters });

    tracker.sync(0, [{ slot: 30, role: 'live-poly', trackId: 1 }], read);
    counters.frames = 30 * 48_000;
    counters.callbacks = (30 * 48_000) / 128;
    tracker.sync(30 * 48_000, [], read);
    const oldNode = tracker.intervalsForSlot(30)[0];

    expect(oldNode).toMatchObject({
      startedAtFrame: 0,
      endedAtFrame: 30 * 48_000,
      expectedFrames: 30 * 48_000,
      observedFrames: 30 * 48_000,
      passed: true,
    });
    // The old node's observed 30 seconds are not incorrectly divided by the
    // entire 90-second AudioContext window after a correct track replacement.
    expect(oldNode.coverageRatio).toBe(1);
  });

  it('closes one node and starts its replacement at the same sampled frame', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    const counters = new Map([
      [30, { frames: 0, callbacks: 0, callbackErrors: 0 }],
      [37, { frames: 0, callbacks: 0, callbackErrors: 0 }],
    ]);
    const read = (slot: number) => ({ ...counters.get(slot)! });

    tracker.sync(1_000, [{ slot: 30, role: 'live-poly', trackId: 1 }], read);
    counters.set(30, { frames: 12_800, callbacks: 100, callbackErrors: 0 });
    tracker.sync(13_800, [{ slot: 37, role: 'live-poly', trackId: 1 }], read);
    expect(tracker.intervalsForSlot(30)[0]).toMatchObject({
      endedAtFrame: 13_800,
      expectedFrames: 12_800,
      observedFrames: 12_800,
      passed: true,
    });

    counters.set(37, { frames: 25_600, callbacks: 200, callbackErrors: 0 });
    tracker.finish(39_400, read);
    expect(tracker.intervalsForSlot(37)[0]).toMatchObject({
      startedAtFrame: 13_800,
      endedAtFrame: 39_400,
      expectedFrames: 25_600,
      observedFrames: 25_600,
      passed: true,
    });
    expect(tracker.allIntervals().map((interval) => interval.slot)).toEqual([30, 37]);
  });

  it('fails a real gap, missing callbacks, or callback errors inside an active interval', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = { frames: 0, callbacks: 0, callbackErrors: 0 };
    const read = () => ({ ...counters });

    tracker.sync(0, [{ slot: 4, role: 'live-poly', trackId: 2 }], read);
    counters = { frames: 9_400, callbacks: 73, callbackErrors: 1 };
    tracker.finish(10_000, read);
    expect(tracker.intervalsForSlot(4)[0]).toMatchObject({
      coverageRatio: 0.94,
      callbackErrors: 1,
      coverageStatus: 'FAIL',
      passed: false,
    });
    expect(summarizeActiveWorkletCoverage(tracker.intervalsForSlot(4))).toMatchObject({
      coverageStatus: 'FAIL',
      passed: false,
      eligibleIntervalCount: 1,
      expectedFrames: 10_000,
      observedFrames: 9_400,
    });
  });

  it('passes a fully covered processor-frame quantum and fails a real one-quantum gap', () => {
    const covered = new ActiveWorkletCoverageTracker();
    let counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 4_096,
      timelineFrame: 4_096, timelineStable: true, snapshotStable: true,
      boundarySource: 'independent test clock AudioWorklet frame',
    };
    const read = () => ({ ...counters });
    // The caller's context-frame arguments deliberately differ. Coverage must
    // use the coherent AudioWorklet processor-frame anchor returned with counters.
    covered.sync(17, [{ slot: 12, role: 'live-poly', trackId: 3 }], read);
    counters = {
      frames: 128, callbacks: 1, callbackErrors: 0, processorFrameEnd: 4_224,
      timelineFrame: 4_224, timelineStable: true, snapshotStable: true,
      boundarySource: 'independent test clock AudioWorklet frame',
    };
    covered.finish(18, read);
    expect(covered.intervalsForSlot(12)[0]).toMatchObject({
      startedAtFrame: 4_096,
      endedAtFrame: 4_224,
      expectedFrames: 128,
      observedFrames: 128,
      callbacks: 1,
      boundarySource: 'independent test clock AudioWorklet frame',
      processorFrameEndAtStart: 4_096,
      processorFrameEndAtStop: 4_224,
      passed: true,
    });

    const missing = new ActiveWorkletCoverageTracker();
    counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 8_192,
      timelineFrame: 8_192, timelineStable: true, snapshotStable: true,
      boundarySource: 'independent test clock AudioWorklet frame',
    };
    missing.sync(19, [{ slot: 13, role: 'live-poly', trackId: 4 }], read);
    counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 8_192,
      timelineFrame: 8_320, timelineStable: true, snapshotStable: true,
      boundarySource: 'independent test clock AudioWorklet frame',
    };
    missing.finish(20, read);
    expect(missing.intervalsForSlot(13)[0]).toMatchObject({
      expectedFrames: 128,
      observedFrames: 0,
      callbacks: 0,
      passed: false,
    });
  });

  it('ends a requested recorder or overdub interval on the terminal process frame only after its matching ACK', () => {
    const acknowledged = new ActiveWorkletCoverageTracker();
    let counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 4_096,
      timelineFrame: 4_096, timelineStable: true, snapshotStable: true,
      boundarySource: 'independent block-meter AudioWorklet frame',
    };
    const read = () => ({ ...counters });
    acknowledged.sync(1, [{ slot: 20, role: 'recorder', trackId: 1 }], read);
    counters = {
      frames: 256, callbacks: 2, callbackErrors: 0, processorFrameEnd: 4_352,
      processorStopFrame: 4_352, stopAcknowledged: true,
      stopAcknowledgementType: 'RECORD_COMPLETE',
      timelineFrame: 4_608, timelineStable: true, snapshotStable: true,
      boundarySource: 'AudioWorklet false-return frame correlated with RECORD_COMPLETE ACK',
    };
    acknowledged.sync(2, [], read);
    expect(acknowledged.intervalsForSlot(20)[0]).toMatchObject({
      startedAtFrame: 4_096,
      endedAtFrame: 4_352,
      expectedFrames: 256,
      observedFrames: 256,
      stopAcknowledged: true,
      stopAcknowledgementType: 'RECORD_COMPLETE',
      passed: true,
    });

    const missingAck = new ActiveWorkletCoverageTracker();
    counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 8_192,
      timelineFrame: 8_192, timelineStable: true, snapshotStable: true,
    };
    missingAck.sync(3, [{ slot: 21, role: 'overdub', trackId: 2 }], read);
    counters = {
      frames: 256, callbacks: 2, callbackErrors: 0, processorFrameEnd: 8_448,
      processorStopFrame: 8_448, stopAcknowledged: false,
      stopAcknowledgementType: null,
      timelineFrame: 8_704, timelineStable: true, snapshotStable: true,
    };
    missingAck.sync(4, [], read);
    expect(missingAck.intervalsForSlot(21)[0]).toMatchObject({
      expectedFrames: 512,
      observedFrames: 256,
      stopAcknowledged: false,
      passed: false,
    });
  });

  it('fails an unrequested false return even if later frames appear covered', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 10_000,
      timelineFrame: 10_000, timelineStable: true, snapshotStable: true,
      unexpectedTerminationCount: 0,
    };
    const read = () => ({ ...counters });
    tracker.sync(1, [{ slot: 22, role: 'live-poly', trackId: 3 }], read);
    counters = {
      frames: 128, callbacks: 1, callbackErrors: 0, processorFrameEnd: 10_128,
      processorStopFrame: 10_128, stopAcknowledged: false,
      timelineFrame: 10_128, timelineStable: true, snapshotStable: true,
      unexpectedTerminationCount: 1,
    };
    tracker.sync(2, [], read);
    expect(tracker.intervalsForSlot(22)[0]).toMatchObject({
      unexpectedTerminations: 1,
      stopAcknowledged: false,
      passed: false,
    });
  });

  it('fails a full missing quantum in an otherwise long interval even at the 95% ratio boundary', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 40_000,
      timelineFrame: 40_000, timelineStable: true, snapshotStable: true,
      missingProcessorFrames: 0,
    };
    const read = () => ({ ...counters });
    tracker.sync(1, [{ slot: 24, role: 'live-poly', trackId: 5 }], read);
    counters = {
      frames: 19 * 128, callbacks: 19, callbackErrors: 0, processorFrameEnd: 42_560,
      timelineFrame: 42_560, timelineStable: true, snapshotStable: true,
      missingProcessorFrames: 128,
    };
    tracker.sync(2, [], read);
    expect(tracker.intervalsForSlot(24)[0]).toMatchObject({
      expectedFrames: 2_560,
      observedFrames: 2_432,
      coverageRatio: 0.95,
      missingProcessorFrames: 128,
      passed: false,
    });
  });

  it('anchors a new recorder to the processor-frame start request and exposes activation delay', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: null,
      timelineFrame: 1_128, timelineStable: true, snapshotStable: true,
      firstActiveFrame: null,
    };
    const read = () => ({ ...counters });
    tracker.sync(1, [{
      slot: 25, role: 'recorder', trackId: 1, expectedStartFrame: 1_000, startCountersFromZero: true,
    }], read);
    counters = {
      frames: 18 * 128, callbacks: 18, callbackErrors: 0, processorFrameEnd: 3_304,
      processorStopFrame: 3_304, stopAcknowledged: true, stopAcknowledgementType: 'RECORD_COMPLETE',
      timelineFrame: 3_432, timelineStable: true, snapshotStable: true, firstActiveFrame: 1_000,
    };
    tracker.sync(2, [], read);
    expect(tracker.intervalsForSlot(25)[0]).toMatchObject({
      requestedStartFrame: 1_000,
      firstActiveFrame: 1_000,
      activationDelayFrames: 0,
      expectedFrames: 2_304,
      observedFrames: 2_304,
      passed: true,
    });

    const lateStart = new ActiveWorkletCoverageTracker();
    counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: null,
      timelineFrame: 5_128, timelineStable: true, snapshotStable: true,
      firstActiveFrame: null,
    };
    lateStart.sync(3, [{
      slot: 26, role: 'recorder', trackId: 2, expectedStartFrame: 5_000, startCountersFromZero: true,
    }], read);
    counters = {
      frames: 18 * 128, callbacks: 18, callbackErrors: 0, processorFrameEnd: 7_432,
      processorStopFrame: 7_432, stopAcknowledged: true, stopAcknowledgementType: 'RECORD_COMPLETE',
      timelineFrame: 7_560, timelineStable: true, snapshotStable: true, firstActiveFrame: 5_128,
    };
    lateStart.sync(4, [], read);
    expect(lateStart.intervalsForSlot(26)[0]).toMatchObject({
      requestedStartFrame: 5_000,
      firstActiveFrame: 5_128,
      activationDelayFrames: 128,
      missingProcessorFrames: 128,
      passed: false,
    });
  });

  it('does not accept a terminal frame paired with the wrong stop acknowledgement type', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = {
      frames: 0, callbacks: 0, callbackErrors: 0, processorFrameEnd: 32_000,
      timelineFrame: 32_000, timelineStable: true, snapshotStable: true,
    };
    const read = () => ({ ...counters });
    tracker.sync(1, [{ slot: 23, role: 'recorder', trackId: 4 }], read);
    counters = {
      frames: 128, callbacks: 1, callbackErrors: 0, processorFrameEnd: 32_128,
      processorStopFrame: 32_128, stopAcknowledged: true,
      stopAcknowledgementType: 'OVERDUB_STOPPED',
      timelineFrame: 32_256, timelineStable: true, snapshotStable: true,
    };
    tracker.sync(2, [], read);
    expect(tracker.intervalsForSlot(23)[0]).toMatchObject({
      expectedFrames: 256,
      observedFrames: 128,
      stopAcknowledged: false,
      passed: false,
    });
  });

  it('rejects a coverage interval if either counter snapshot cannot be read coherently', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = { frames: 0, callbacks: 0, callbackErrors: 0, snapshotStable: true };
    const read = () => ({ ...counters });
    tracker.sync(0, [{ slot: 19, role: 'overdub', trackId: 5 }], read);
    counters = { frames: 128, callbacks: 1, callbackErrors: 0, snapshotStable: false };
    tracker.finish(128, read);
    expect(tracker.intervalsForSlot(19)[0]).toMatchObject({
      observedFrames: 128,
      callbacks: 1,
      snapshotStable: false,
      passed: false,
    });
  });

  it('reads callback/frame/error counters consistently under the worklet sequence version', () => {
    const meta = new Int32Array(new SharedArrayBuffer(4 * 26));
    const layout = {
      callbacksIndex: 0,
      framesIndex: 1,
      callbackErrorsIndex: 12,
      snapshotVersionIndex: 17,
      processorFrameEndIndex: 18,
      processorStopFrameIndex: 20,
      coverageCallbacksIndex: 22,
      coverageFramesIndex: 23,
      unexpectedTerminationCountIndex: 21,
      missingProcessorFramesIndex: 24,
      firstActiveFrameIndex: 25,
    };
    Atomics.store(meta, 22, 7);
    Atomics.store(meta, 23, 896);
    Atomics.store(meta, 12, 1);
    Atomics.store(meta, 17, 2);
    Atomics.store(meta, 18, 1_024);
    Atomics.store(meta, 20, -1);
    Atomics.store(meta, 21, 0);
    Atomics.store(meta, 24, 0);
    Atomics.store(meta, 25, -1);
    expect(readCoherentWorkletCounters(meta, 0, layout)).toMatchObject({
      callbacks: 7,
      frames: 896,
      callbackErrors: 1,
      processorFrameEnd: 1_024,
      processorStopFrame: null,
      unexpectedTerminationCount: 0,
      missingProcessorFrames: 0,
      firstActiveFrame: null,
      snapshotStable: true,
      snapshotAttempts: 1,
    });

    Atomics.store(meta, 17, 3);
    expect(readCoherentWorkletCounters(meta, 0, layout, 3)).toMatchObject({
      callbacks: 0,
      frames: 0,
      callbackErrors: 0,
      snapshotStable: false,
      snapshotAttempts: 3,
    });
  });

  it('fails an active state with no measured audio span instead of silently exempting it', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    const counters = { frames: 0, callbacks: 0, callbackErrors: 0 };
    const read = () => ({ ...counters });
    tracker.sync(100, [{ slot: 8, role: 'live-poly', trackId: 3 }], read);
    counters.frames = 128;
    counters.callbacks = 1;
    tracker.sync(100, [], read);
    expect(tracker.intervalsForSlot(8)[0]).toMatchObject({
      expectedFrames: 0,
      eligibleForCoverage: false,
      observedFrames: 128,
      coverageStatus: 'NOT_EVALUATED',
      passed: null,
    });
    expect(summarizeActiveWorkletCoverage(tracker.intervalsForSlot(8))).toMatchObject({
      coverageStatus: 'NOT_EVALUATED',
      passed: false,
      eligibleIntervalCount: 0,
      notEvaluatedIntervalCount: 1,
      expectedFrames: 0,
      observedFrames: 0,
      observedFramesInNotEvaluatedIntervals: 128,
    });
    expect(summarizeActiveWorkletCoverage([])).toMatchObject({
      coverageStatus: 'NOT_EVALUATED',
      passed: false,
      eligibleIntervalCount: 0,
      expectedFrames: 0,
    });
  });

  it('excludes NOT_EVALUATED zero-frame intervals when a positive interval is covered', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    let counters = { frames: 0, callbacks: 0, callbackErrors: 0 };
    const read = () => ({ ...counters });

    tracker.sync(100, [{ slot: 9, role: 'live-poly', trackId: 3 }], read);
    counters = { frames: 128, callbacks: 1, callbackErrors: 0 };
    tracker.sync(100, [], read); // No measured lifetime: diagnostic only.
    tracker.sync(200, [{ slot: 9, role: 'live-poly', trackId: 3 }], read);
    counters = { frames: 256, callbacks: 2, callbackErrors: 0 };
    tracker.finish(328, read);

    const intervals = tracker.intervalsForSlot(9);
    expect(intervals.map(({ coverageStatus }) => coverageStatus)).toEqual(['NOT_EVALUATED', 'PASS']);
    expect(summarizeActiveWorkletCoverage(intervals)).toMatchObject({
      coverageStatus: 'PASS',
      passed: true,
      expectedFrames: 128,
      observedFrames: 128,
      coverageRatio: 1,
      eligibleIntervalCount: 1,
      notEvaluatedIntervalCount: 1,
      observedFramesInNotEvaluatedIntervals: 128,
    });
  });

  it('rejects backwards audio time and duplicate slot classifications', () => {
    const tracker = new ActiveWorkletCoverageTracker();
    const read = () => ({ frames: 0, callbacks: 0, callbackErrors: 0 });
    tracker.sync(10, [{ slot: 1, role: 'live-poly', trackId: 1 }], read);
    expect(() => tracker.sync(9, [], read)).toThrow(/moved backwards/);
    expect(() => tracker.sync(10, [
      { slot: 2, role: 'recorder', trackId: 1 },
      { slot: 2, role: 'overdub', trackId: 1 },
    ], read)).toThrow(/more than once/);
  });
});
