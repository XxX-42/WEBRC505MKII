export interface ActiveWorkletCoverageItem {
  readonly slot: number;
  readonly role: string;
  readonly trackId?: number | null;
  readonly expectedStartFrame?: number | null;
  readonly startCountersFromZero?: boolean;
}

export interface WorkletCoverageCounters {
  readonly frames: number;
  readonly callbacks: number;
  readonly callbackErrors: number;
  /** End frame of the most recent completed AudioWorklet process() call. */
  readonly processorFrameEnd?: number | null;
  /** Frame at which process() returned false; only a stop-request ACK may make this an end boundary. */
  readonly processorStopFrame?: number | null;
  readonly stopAcknowledged?: boolean;
  readonly stopAcknowledgementType?: string | null;
  /** Unexpected false returns observed while this tracked worklet was active. */
  readonly unexpectedTerminationCount?: number;
  /** Complete processor-frame gaps detected between adjacent measured callbacks. */
  readonly missingProcessorFrames?: number;
  /** First processor frame that actually ran the role's active audio path. */
  readonly firstActiveFrame?: number | null;
  /** Independently sampled frame boundary from the instrumented block-meter processor. */
  readonly timelineFrame?: number | null;
  readonly timelineStable?: boolean;
  readonly timelineSnapshotAttempts?: number;
  readonly boundarySource?: string;
  /** False when the worklet-side sequence changed during the atomic snapshot. */
  readonly snapshotStable?: boolean;
  readonly snapshotAttempts?: number;
}

export interface ActiveWorkletInterval {
  readonly slot: number;
  readonly role: string;
  readonly trackId: number | null;
  readonly startedAtFrame: number;
  readonly endedAtFrame: number;
  readonly expectedFrames: number;
  readonly eligibleForCoverage: boolean;
  readonly observedFrames: number;
  readonly callbacks: number;
  readonly callbackErrors: number;
  readonly processorStopFrame: number | null;
  readonly stopAcknowledged: boolean;
  readonly stopAcknowledgementType: string | null;
  readonly unexpectedTerminations: number;
  readonly missingProcessorFrames: number;
  readonly requestedStartFrame: number | null;
  readonly firstActiveFrame: number | null;
  readonly activationDelayFrames: number | null;
  readonly processorFrameEndAtStart: number | null;
  readonly processorFrameEndAtStop: number | null;
  readonly processorFrameAdvance: number | null;
  readonly coverageRatio: number | null;
  readonly snapshotStable: boolean;
  readonly snapshotAttempts: number;
  readonly boundarySource: string;
  readonly coverageStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  readonly passed: boolean | null;
}

export interface ActiveWorkletCoverageSummary {
  readonly coverageStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  /** False for both failed and not-evaluated summaries so callers cannot pass an empty sample. */
  readonly passed: boolean;
  readonly expectedFrames: number;
  readonly observedFrames: number;
  readonly coverageRatio: number | null;
  readonly eligibleIntervalCount: number;
  readonly notEvaluatedIntervalCount: number;
  readonly observedFramesInNotEvaluatedIntervals: number;
}

/**
 * Aggregates only intervals with a positive expected audio-frame span. A
 * zero-frame lifecycle interval is reported as not evaluated, but cannot
 * poison a valid neighboring interval. Conversely, an empty eligible set is
 * never a pass, and every eligible interval must independently meet the gate.
 */
export function summarizeActiveWorkletCoverage(
  intervals: readonly ActiveWorkletInterval[],
  minimumCoverageRatio = 0.95,
): ActiveWorkletCoverageSummary {
  if (!Number.isFinite(minimumCoverageRatio) || minimumCoverageRatio <= 0 || minimumCoverageRatio > 1) {
    throw new RangeError(`minimumCoverageRatio must be greater than zero and at most one, got ${minimumCoverageRatio}`);
  }
  const eligible = intervals.filter((interval) => interval.eligibleForCoverage && interval.expectedFrames > 0);
  const notEvaluated = intervals.filter((interval) => !interval.eligibleForCoverage || interval.expectedFrames <= 0);
  const expectedFrames = eligible.reduce((sum, interval) => sum + interval.expectedFrames, 0);
  const observedFrames = eligible.reduce((sum, interval) => sum + interval.observedFrames, 0);
  const passed = eligible.length > 0 && eligible.every((interval) => interval.passed === true
    && interval.coverageRatio !== null && interval.coverageRatio >= minimumCoverageRatio);
  return {
    coverageStatus: eligible.length === 0 ? 'NOT_EVALUATED' : passed ? 'PASS' : 'FAIL',
    passed,
    expectedFrames,
    observedFrames,
    coverageRatio: expectedFrames > 0 ? observedFrames / expectedFrames : null,
    eligibleIntervalCount: eligible.length,
    notEvaluatedIntervalCount: notEvaluated.length,
    observedFramesInNotEvaluatedIntervals: notEvaluated.reduce((sum, interval) => sum + interval.observedFrames, 0),
  };
}

export interface WorkletCounterAtomicLayout {
  readonly callbacksIndex: number;
  readonly framesIndex: number;
  readonly callbackErrorsIndex: number;
  readonly snapshotVersionIndex: number;
  readonly processorFrameEndIndex: number;
  readonly processorStopFrameIndex: number;
  readonly coverageCallbacksIndex: number;
  readonly coverageFramesIndex: number;
  readonly unexpectedTerminationCountIndex: number;
  readonly missingProcessorFramesIndex: number;
  readonly firstActiveFrameIndex: number;
}

/**
 * Reads the callback/frame counters under a worklet-written sequence lock.
 * Returning an unstable sample is deliberately not treated as usable coverage.
 */
export function readCoherentWorkletCounters(
  meta: Int32Array,
  base: number,
  layout: WorkletCounterAtomicLayout,
  maxAttempts = 8,
): WorkletCoverageCounters {
  if (!Number.isSafeInteger(base) || base < 0 || base >= meta.length) {
    throw new RangeError(`Invalid worklet counter base: ${base}`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 64) {
    throw new RangeError(`Counter snapshot attempts must be from 1 through 64, got ${maxAttempts}`);
  }
  const indexes = [layout.callbackErrorsIndex, layout.snapshotVersionIndex, layout.processorFrameEndIndex,
    layout.processorStopFrameIndex, layout.coverageCallbacksIndex, layout.coverageFramesIndex,
    layout.unexpectedTerminationCountIndex, layout.missingProcessorFramesIndex, layout.firstActiveFrameIndex];
  if (indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || base + index >= meta.length)) {
    throw new RangeError('Worklet counter snapshot indexes are outside the metadata array');
  }

  let last = {
    callbacks: 0,
    frames: 0,
    callbackErrors: 0,
    processorFrameEnd: null as number | null,
    processorStopFrame: null as number | null,
    unexpectedTerminationCount: 0,
    missingProcessorFrames: 0,
    firstActiveFrame: null,
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const versionBefore = Atomics.load(meta, base + layout.snapshotVersionIndex);
    if ((versionBefore & 1) !== 0) continue;
    const callbacks = Atomics.load(meta, base + layout.coverageCallbacksIndex);
    const frameEnd = Atomics.load(meta, base + layout.processorFrameEndIndex);
    const stopFrame = Atomics.load(meta, base + layout.processorStopFrameIndex);
    const firstActiveFrame = Atomics.load(meta, base + layout.firstActiveFrameIndex);
    last = {
      callbacks,
      frames: Atomics.load(meta, base + layout.coverageFramesIndex),
      callbackErrors: Atomics.load(meta, base + layout.callbackErrorsIndex),
      processorFrameEnd: frameEnd >= 0 ? frameEnd : null,
      processorStopFrame: stopFrame >= 0 ? stopFrame : null,
      unexpectedTerminationCount: Atomics.load(meta, base + layout.unexpectedTerminationCountIndex),
      missingProcessorFrames: Atomics.load(meta, base + layout.missingProcessorFramesIndex),
      firstActiveFrame: firstActiveFrame >= 0 ? firstActiveFrame : null,
    };
    const versionAfter = Atomics.load(meta, base + layout.snapshotVersionIndex);
    if (versionBefore === versionAfter && (versionAfter & 1) === 0) {
      return { ...last, snapshotStable: true, snapshotAttempts: attempt };
    }
  }
  return { ...last, snapshotStable: false, snapshotAttempts: maxAttempts };
}

interface OpenInterval {
  slot: number;
  role: string;
  trackId: number | null;
  startedAtFrame: number;
  expectedStartFrame: number | null;
  startCounters: WorkletCoverageCounters;
}

/**
 * Test-side accounting for worklet nodes whose expected lifetime is shorter
 * than the complete measurement window (for example a TrackAudio pitch node
 * replaced after a recording). Counters are sampled only at lifecycle edges;
 * the worklet wraps its completed-counter update in a short seqlock window.
 */
export class ActiveWorkletCoverageTracker {
  #open = new Map<number, OpenInterval>();
  #closed = new Map<number, ActiveWorkletInterval[]>();
  #lastFrame = -1;

  sync(
    audioFrame: number,
    activeNodes: readonly ActiveWorkletCoverageItem[],
    readCounters: (slot: number) => WorkletCoverageCounters,
  ) {
    this.#assertFrame(audioFrame);
    const desired = new Map<number, ActiveWorkletCoverageItem>();
    for (const item of activeNodes) {
      if (!Number.isSafeInteger(item.slot) || item.slot < 0) {
        throw new RangeError(`Invalid active worklet slot: ${item.slot}`);
      }
      if (item.expectedStartFrame !== undefined && item.expectedStartFrame !== null
        && (!Number.isSafeInteger(item.expectedStartFrame) || item.expectedStartFrame < 0)) {
        throw new RangeError(`Invalid expected start frame for worklet slot ${item.slot}: ${item.expectedStartFrame}`);
      }
      if (!item.role || typeof item.role !== 'string') {
        throw new TypeError(`Active worklet slot ${item.slot} must have a role`);
      }
      if (desired.has(item.slot)) throw new Error(`Worklet slot ${item.slot} was classified as active more than once`);
      desired.set(item.slot, item);
    }

    const changes: Array<Record<string, unknown>> = [];
    for (const [slot, open] of this.#open) {
      const replacement = desired.get(slot);
      if (replacement && replacement.role === open.role && replacement.trackId === open.trackId) continue;
      changes.push(this.#close(audioFrame, slot, readCounters));
    }
    for (const [slot, item] of desired) {
      if (this.#open.has(slot)) continue;
      const sampledCounters = normalizeCounters(readCounters(slot));
      const counters = item.startCountersFromZero ? {
        ...sampledCounters,
        frames: 0,
        callbacks: 0,
        callbackErrors: 0,
        processorFrameEnd: null,
        processorStopFrame: null,
        unexpectedTerminationCount: 0,
        missingProcessorFrames: 0,
        firstActiveFrame: null,
      } : sampledCounters;
      const boundaryFrame = item.expectedStartFrame ?? sampledCounters.timelineFrame ?? audioFrame;
      this.#open.set(slot, {
        slot,
        role: item.role,
        trackId: item.trackId ?? null,
        startedAtFrame: boundaryFrame,
        expectedStartFrame: item.expectedStartFrame ?? null,
        startCounters: normalizeCounters(counters),
      });
      changes.push({ type: 'opened', slot, role: item.role, trackId: item.trackId ?? null, frame: boundaryFrame });
    }
    this.#lastFrame = audioFrame;
    return changes;
  }

  finish(audioFrame: number, readCounters: (slot: number) => WorkletCoverageCounters) {
    this.#assertFrame(audioFrame);
    const closed: Array<Record<string, unknown>> = [];
    for (const slot of [...this.#open.keys()]) closed.push(this.#close(audioFrame, slot, readCounters));
    this.#lastFrame = audioFrame;
    return closed;
  }

  intervalsForSlot(slot: number): ActiveWorkletInterval[] {
    return [...(this.#closed.get(slot) ?? [])];
  }

  allIntervals(): ActiveWorkletInterval[] {
    return [...this.#closed.values()].flat().sort((left, right) => left.startedAtFrame - right.startedAtFrame || left.slot - right.slot);
  }

  #close(audioFrame: number, slot: number, readCounters: (slot: number) => WorkletCoverageCounters) {
    const open = this.#open.get(slot);
    if (!open) throw new Error(`Cannot close inactive worklet slot ${slot}`);
    const endCounters = normalizeCounters(readCounters(slot));
    const expectedAckType = open.role === 'recorder' ? 'RECORD_COMPLETE'
      : open.role === 'overdub' ? 'OVERDUB_STOPPED' : null;
    const stopAcknowledged = endCounters.stopAcknowledged === true
      && (expectedAckType === null || endCounters.stopAcknowledgementType === expectedAckType);
    const boundaryFrame = endCounters.processorStopFrame !== null && endCounters.processorStopFrame !== undefined
      && stopAcknowledged
      ? endCounters.processorStopFrame
      : endCounters.timelineFrame ?? audioFrame;
    if (boundaryFrame < open.startedAtFrame) {
      throw new RangeError(`Processor audio frame moved backwards for slot ${slot}: ${open.startedAtFrame} to ${boundaryFrame}`);
    }
    const expectedFrames = boundaryFrame - open.startedAtFrame;
    const eligibleForCoverage = expectedFrames > 0;
    const observedFrames = Math.max(0, endCounters.frames - open.startCounters.frames);
    const callbacks = Math.max(0, endCounters.callbacks - open.startCounters.callbacks);
    const callbackErrors = Math.max(0, endCounters.callbackErrors - open.startCounters.callbackErrors);
    const unexpectedTerminations = Math.max(0,
      (endCounters.unexpectedTerminationCount ?? 0) - (open.startCounters.unexpectedTerminationCount ?? 0));
    const missingProcessorFrames = Math.max(0,
      (endCounters.missingProcessorFrames ?? 0) - (open.startCounters.missingProcessorFrames ?? 0));
    const firstActiveFrame = endCounters.firstActiveFrame ?? null;
    const activationDelayFrames = open.expectedStartFrame !== null && firstActiveFrame !== null
      ? firstActiveFrame - open.expectedStartFrame : null;
    const initialGapFrames = activationDelayFrames !== null && activationDelayFrames > 0 ? activationDelayFrames : 0;
    const terminalReturnWithoutAck = endCounters.processorStopFrame !== null
      && endCounters.processorStopFrame !== undefined && !stopAcknowledged;
    const snapshotStable = open.startCounters.snapshotStable !== false && endCounters.snapshotStable !== false
      && open.startCounters.timelineStable !== false && endCounters.timelineStable !== false;
    const snapshotAttempts = (open.startCounters.snapshotAttempts ?? 1) + (endCounters.snapshotAttempts ?? 1);
    const processorFrameEndAtStart = open.startCounters.processorFrameEnd ?? null;
    const processorFrameEndAtStop = endCounters.processorFrameEnd ?? null;
    const intervalPassed = snapshotStable && callbackErrors === 0 && unexpectedTerminations === 0 && missingProcessorFrames === 0
      && initialGapFrames === 0
      && (open.expectedStartFrame === null || firstActiveFrame !== null && activationDelayFrames === 0)
      && !terminalReturnWithoutAck && eligibleForCoverage
      && callbacks > 0 && observedFrames / expectedFrames >= 0.95;
    const interval: ActiveWorkletInterval = {
      slot,
      role: open.role,
      trackId: open.trackId,
      startedAtFrame: open.startedAtFrame,
      endedAtFrame: boundaryFrame,
      expectedFrames,
      eligibleForCoverage,
      observedFrames,
      callbacks,
      callbackErrors,
      processorFrameEndAtStart,
      processorFrameEndAtStop,
      processorFrameAdvance: processorFrameEndAtStart !== null && processorFrameEndAtStop !== null
        ? processorFrameEndAtStop - processorFrameEndAtStart : null,
      processorStopFrame: endCounters.processorStopFrame ?? null,
      stopAcknowledged,
      stopAcknowledgementType: stopAcknowledged
        ? endCounters.stopAcknowledgementType ?? null : null,
      unexpectedTerminations,
      missingProcessorFrames: missingProcessorFrames + initialGapFrames,
      requestedStartFrame: open.expectedStartFrame,
      firstActiveFrame,
      activationDelayFrames,
      coverageRatio: expectedFrames > 0 ? observedFrames / expectedFrames : null,
      snapshotStable,
      snapshotAttempts,
      boundarySource: open.startCounters.boundarySource ?? endCounters.boundarySource
        ?? 'AudioContext sample-frame fallback',
      coverageStatus: !eligibleForCoverage ? 'NOT_EVALUATED' : intervalPassed ? 'PASS' : 'FAIL',
      passed: !eligibleForCoverage ? null : intervalPassed,
    };
    const list = this.#closed.get(slot) ?? [];
    list.push(interval);
    this.#closed.set(slot, list);
    this.#open.delete(slot);
    return { type: 'closed', ...interval };
  }

  #assertFrame(audioFrame: number) {
    if (!Number.isSafeInteger(audioFrame) || audioFrame < 0) {
      throw new RangeError(`Audio frame must be a non-negative safe integer, got ${audioFrame}`);
    }
    if (this.#lastFrame >= 0 && audioFrame < this.#lastFrame) {
      throw new RangeError(`Audio frame moved backwards from ${this.#lastFrame} to ${audioFrame}`);
    }
  }
}

function normalizeCounters(value: WorkletCoverageCounters): WorkletCoverageCounters {
  if (!value || !Number.isSafeInteger(value.frames) || value.frames < 0
    || !Number.isSafeInteger(value.callbacks) || value.callbacks < 0
    || !Number.isSafeInteger(value.callbackErrors) || value.callbackErrors < 0
    || (value.processorFrameEnd !== undefined && value.processorFrameEnd !== null
      && (!Number.isSafeInteger(value.processorFrameEnd) || value.processorFrameEnd < 0))
    || (value.processorStopFrame !== undefined && value.processorStopFrame !== null
      && (!Number.isSafeInteger(value.processorStopFrame) || value.processorStopFrame < 0))
    || (value.stopAcknowledged !== undefined && typeof value.stopAcknowledged !== 'boolean')
    || (value.stopAcknowledgementType !== undefined && value.stopAcknowledgementType !== null
      && typeof value.stopAcknowledgementType !== 'string')
    || (value.unexpectedTerminationCount !== undefined
      && (!Number.isSafeInteger(value.unexpectedTerminationCount) || value.unexpectedTerminationCount < 0))
    || (value.missingProcessorFrames !== undefined
      && (!Number.isSafeInteger(value.missingProcessorFrames) || value.missingProcessorFrames < 0))
    || (value.firstActiveFrame !== undefined && value.firstActiveFrame !== null
      && (!Number.isSafeInteger(value.firstActiveFrame) || value.firstActiveFrame < 0))
    || (value.timelineFrame !== undefined && value.timelineFrame !== null
      && (!Number.isSafeInteger(value.timelineFrame) || value.timelineFrame < 0))
    || (value.snapshotStable !== undefined && typeof value.snapshotStable !== 'boolean')
    || (value.timelineStable !== undefined && typeof value.timelineStable !== 'boolean')
    || (value.boundarySource !== undefined && typeof value.boundarySource !== 'string')
    || (value.snapshotAttempts !== undefined && (!Number.isSafeInteger(value.snapshotAttempts) || value.snapshotAttempts < 1))
    || (value.timelineSnapshotAttempts !== undefined
      && (!Number.isSafeInteger(value.timelineSnapshotAttempts) || value.timelineSnapshotAttempts < 1))) {
    throw new TypeError('Worklet counters must contain non-negative safe integers for frames, callbacks, and callbackErrors');
  }
  return value;
}
