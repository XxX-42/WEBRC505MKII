/*
 * Browser-only loop I/O processors. The existing looper-processor.js remains
 * the recording capture worker; these separate processors own overdub DSP and
 * bounded loopback capture so capture semantics stay isolated.
 */
const DEFAULT_OVERDUB_POOL_SIZE = 3;
const DEFAULT_OVERDUB_BUFFER_FRAMES = 16384;
const DEFAULT_OVERDUB_STARTUP_BACKFILL_FRAMES = 8192;
const DEFAULT_OVERDUB_STARTUP_QUEUE_FRAMES = 8192;
const DEFAULT_OVERDUB_STARTUP_REPLAY_FRAMES = 256;
const MAX_OVERDUB_STARTUP_REPLAY_FRAMES = 512;
const EMPTY_CHANNELS = [];

class BrowserOverdubProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    this.bufferCapacity = this.positiveInteger(
      processorOptions.transferBufferFrames,
      DEFAULT_OVERDUB_BUFFER_FRAMES,
    );
    this.poolSize = this.positiveInteger(processorOptions.transferBufferPoolSize, DEFAULT_OVERDUB_POOL_SIZE);
    this.loopSamples = null;
    this.loopChannels = null;
    this.channelCount = 1;
    this.loopLength = 0;
    this.startFrame = 0;
    this.startOffsetSamples = 0;
    this.latencySamples = 0;
    this.recordingOffsetSamples = 0;
    this.reverse = false;
    // Production callers batch partial chunks to the existing bounded transfer
    // pool. The legacy test mode remains available for small, hand-authored
    // fixtures that intentionally expect one patch per process() call.
    this.batchPatchMessages = processorOptions.batchPatchMessages === true;
    // Production bounds the uncommitted range to four 128-frame quanta at
    // common block sizes (about 11.6 ms at 44.1 kHz). A full transfer buffer
    // is larger to also hold the bounded startup replay, but must not define
    // the normal live-update interval.
    this.patchFlushFrames = Math.min(
      this.bufferCapacity,
      this.positiveInteger(processorOptions.patchFlushFrames, 512),
    );
    this.active = false;
    this.stopped = false;
    this.stopAckPending = false;
    this.stopAckStartupCancelled = false;
    this.stopRequested = false;
    this.stopFrameTarget = null;
    this.appliedExclusiveEnd = null;
    this.processorStopFrame = null;
    this.patchPool = new Array(this.poolSize).fill(null);
    this.patchMessage = {
      type: 'OVERDUB_PATCH', sequence: 0, slotIndex: 0, validFrames: 0,
      patchFlushFrames: 0,
      startInputFrame: null, endInputFrame: null,
      indices: null, values: null, rightValues: null, oldValues: null, oldRightValues: null,
    };
    this.patchTransferList = [null, null, null, null, null];
    this.stopMessage = {
      type: 'OVERDUB_STOPPED', overflowFrames: 0, overflowEvents: 0,
      patchesSent: 0, startupCancelled: false,
      patchFlushFrames: 0,
      requestFrame: null, firstInputFrame: null, stopFrame: null,
      requestedStopFrame: null, appliedExclusiveEnd: null, processorStopFrame: null,
      channelCount: 0,
      backfillFrames: 0, replayBudgetFramesPerProcess: 0,
      replayedFrames: 0, maxReplayedFramesPerProcess: 0,
      liveQueueCapacityFrames: 0, liveQueueFrames: 0, liveQueuePeakFrames: 0,
    };
    this.patchSequence = 0;
    this.overflowFrames = 0;
    this.overflowEvents = 0;
    this.overflowActive = false;
    this.fallbackCurrentFrame = 0;
    // Exact-start overdubs stage the shared-tap gap and the first live samples
    // before publishing any PCM patch. Both buffers are bounded and allocated
    // once per processor, never in process().
    this.startupBackfillCapacity = Math.min(
      this.positiveInteger(processorOptions.startupBackfillFrames, DEFAULT_OVERDUB_STARTUP_BACKFILL_FRAMES),
      DEFAULT_OVERDUB_STARTUP_BACKFILL_FRAMES,
      Math.floor(this.bufferCapacity / 2),
    );
    this.startupQueueCapacity = Math.min(
      this.positiveInteger(processorOptions.startupQueueFrames, DEFAULT_OVERDUB_STARTUP_QUEUE_FRAMES),
      DEFAULT_OVERDUB_STARTUP_QUEUE_FRAMES,
      this.bufferCapacity - this.startupBackfillCapacity,
    );
    this.startupReplayBudget = Math.min(
      this.positiveInteger(processorOptions.startupReplayFramesPerProcess, DEFAULT_OVERDUB_STARTUP_REPLAY_FRAMES),
      MAX_OVERDUB_STARTUP_REPLAY_FRAMES,
    );
    this.startupRequestFrame = null;
    this.startupRequestFrameForDiagnostics = null;
    this.startupFirstInputFrame = null;
    this.startupFirstInputFrameForDiagnostics = null;
    this.startupPhase = 'live';
    this.startupBackfillChannels = null;
    this.startupBackfillFrames = 0;
    this.startupBackfillCursor = 0;
    this.startupLiveLeft = new Float32Array(this.startupQueueCapacity);
    this.startupLiveRight = new Float32Array(this.startupQueueCapacity);
    this.startupLiveFrames = 0;
    this.startupLiveCursor = 0;
    this.startupLiveQueuePeakFrames = 0;
    this.startupReplayedFrames = 0;
    this.startupMaxReplayedFramesPerProcess = 0;
    this.startupBackfillFramesForDiagnostics = 0;
    this.startupPatchSlot = -1;
    this.firstInputMessage = {
      type: 'OVERDUB_FIRST_INPUT_FRAME', requestFrame: 0, firstInputFrame: 0, channelCount: 0,
    };
    this.startupFailureSent = false;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message) return;

      if (message.type === 'OVERDUB_INIT') {
        this.initializeOverdub(message);
      } else if (message.type === 'RECYCLE_OVERDUB_BUFFER') {
        this.recyclePatchBuffer(
          message.slotIndex, message.indices, message.values, message.rightValues,
          message.oldValues, message.oldRightValues,
        );
      } else if (message.type === 'OVERDUB_STOP') {
        this.stopOverdub(message.stopFrame);
      } else if (message.type === 'OVERDUB_BACKFILL') {
        this.acceptStartupBackfill(message);
      } else if (message.type === 'OVERDUB_BACKFILL_ERROR') {
        this.failStartup(message.reason || 'input-backfill-failed');
      }
    };
  }

  positiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  initializeOverdub(message) {
    const channels = Array.isArray(message.channels)
      ? message.channels
      : message.samples instanceof Float32Array ? [message.samples] : null;
    const channelCount = Number.isInteger(message.channelCount) ? message.channelCount : channels?.length ?? 0;
    if (!channels || channels.length < 1 || channels.length > 2 || channels.some((samples) =>
      !(samples instanceof Float32Array) || samples.length === 0 || samples.length !== channels[0].length
    ) || channelCount !== channels.length || !Array.isArray(message.buffers)) {
      this.active = false;
      this.stopped = true;
      this.stopAckStartupCancelled = true;
      this.stopAckPending = true;
      this.port.postMessage({ type: 'OVERDUB_ERROR', message: 'Overdub loop data was invalid.' });
      return;
    }

    this.loopChannels = channels;
    this.loopSamples = channels[0];
    this.channelCount = channelCount;
    this.loopLength = channels[0].length;
    this.startFrame = Number.isFinite(message.startFrame) ? Math.floor(message.startFrame) : 0;
    this.startOffsetSamples = Number.isFinite(message.startOffsetSamples) ? Math.floor(message.startOffsetSamples) : 0;
    this.latencySamples = Number.isFinite(message.latencySamples) ? Math.floor(message.latencySamples) : 0;
    this.recordingOffsetSamples = Number.isFinite(message.recordingOffsetSamples)
      ? Math.trunc(message.recordingOffsetSamples)
      : 0;
    this.reverse = message.reverse === true;

    this.startupRequestFrame = Number.isSafeInteger(message.requestFrame) && message.requestFrame >= 0
      ? message.requestFrame : null;
    this.startupRequestFrameForDiagnostics = this.startupRequestFrame;
    this.startupFirstInputFrame = null;
    this.startupFirstInputFrameForDiagnostics = null;
    this.startupLiveQueuePeakFrames = 0;
    this.startupReplayedFrames = 0;
    this.startupMaxReplayedFramesPerProcess = 0;
    this.startupBackfillFramesForDiagnostics = 0;
    Object.assign(this.stopMessage, {
      requestFrame: this.startupRequestFrameForDiagnostics,
      firstInputFrame: null,
      stopFrame: null,
      requestedStopFrame: null,
      appliedExclusiveEnd: null,
      processorStopFrame: null,
      channelCount: 0,
      backfillFrames: 0,
      replayBudgetFramesPerProcess: this.startupReplayBudget,
      replayedFrames: 0,
      maxReplayedFramesPerProcess: 0,
      liveQueueCapacityFrames: this.startupQueueCapacity,
      liveQueueFrames: 0,
      liveQueuePeakFrames: 0,
    });
    this.startupPhase = this.startupRequestFrame === null ? 'live' : 'waiting-first-input';
    this.startupBackfillChannels = null;
    this.startupBackfillFrames = 0;
    this.startupBackfillCursor = 0;
    this.startupLiveFrames = 0;
    this.startupLiveCursor = 0;
    this.startupPatchSlot = -1;
    this.startupFailureSent = false;
    this.stopMessage.startupCancelled = false;
    this.stopAckPending = false;
    this.stopAckStartupCancelled = false;
    this.stopRequested = false;
    this.stopFrameTarget = null;
    this.processorStopFrame = null;
    this.appliedExclusiveEnd = null;

    for (let index = 0; index < this.poolSize; index += 1) {
      const buffer = message.buffers[index];
      if (
        buffer &&
        Number.isInteger(buffer.slotIndex) &&
        buffer.slotIndex >= 0 &&
        buffer.slotIndex < this.poolSize &&
        buffer.indices instanceof Uint32Array &&
        buffer.indices.length === this.bufferCapacity &&
        buffer.values instanceof Float32Array &&
        buffer.values.length === this.bufferCapacity &&
        buffer.oldValues instanceof Float32Array && buffer.oldValues.length === this.bufferCapacity &&
        (this.channelCount === 1 || (buffer.rightValues instanceof Float32Array && buffer.rightValues.length === this.bufferCapacity
          && buffer.oldRightValues instanceof Float32Array && buffer.oldRightValues.length === this.bufferCapacity))
      ) {
        this.patchPool[buffer.slotIndex] = {
          indices: buffer.indices,
          values: buffer.values,
          rightValues: this.channelCount > 1 ? buffer.rightValues : null,
          oldValues: buffer.oldValues,
          oldRightValues: this.channelCount > 1 ? buffer.oldRightValues : null,
          startInputFrame: null,
          endInputFrame: null,
          validFrames: 0,
        };
      }
    }
    this.active = true;
    this.stopped = false;
  }

  recyclePatchBuffer(slotIndex, indices, values, rightValues, oldValues, oldRightValues) {
    if (
      !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.poolSize ||
      !(indices instanceof Uint32Array) || indices.length !== this.bufferCapacity ||
      !(values instanceof Float32Array) || values.length !== this.bufferCapacity ||
      !(oldValues instanceof Float32Array) || oldValues.length !== this.bufferCapacity ||
      (this.channelCount > 1 && (!(rightValues instanceof Float32Array) || rightValues.length !== this.bufferCapacity
        || !(oldRightValues instanceof Float32Array) || oldRightValues.length !== this.bufferCapacity))
    ) return;

    this.patchPool[slotIndex] = {
      indices, values, rightValues: this.channelCount > 1 ? rightValues : null,
      oldValues, oldRightValues: this.channelCount > 1 ? oldRightValues : null,
      startInputFrame: null, endInputFrame: null, validFrames: 0,
    };
  }

  findAvailablePatch() {
    // Continue an already-open partial range before opening another empty
    // slot. AudioWorklet block sizes can be variable, so a large quantum may
    // flush the threshold and leave a tail in the same process() call. Picking
    // an earlier empty slot next callback would overtake that tail and publish
    // source-frame patches out of order.
    let oldestPartial = -1;
    let oldestStartFrame = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.poolSize; index += 1) {
      const buffer = this.patchPool[index];
      if (buffer && buffer.validFrames > 0 && buffer.validFrames < this.bufferCapacity
        && buffer.startInputFrame < oldestStartFrame) {
        oldestPartial = index;
        oldestStartFrame = buffer.startInputFrame;
      }
    }
    if (oldestPartial >= 0) return oldestPartial;
    for (let index = 0; index < this.poolSize; index += 1) {
      const buffer = this.patchPool[index];
      if (buffer && buffer.validFrames === 0) return index;
    }
    return -1;
  }

  findOldestPendingPatch() {
    let candidate = -1;
    let firstFrame = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.poolSize; index += 1) {
      const patch = this.patchPool[index];
      if (patch && patch.validFrames > 0 && patch.startInputFrame < firstFrame) {
        candidate = index;
        firstFrame = patch.startInputFrame;
      }
    }
    return candidate;
  }

  noteOverflow() {
    this.overflowFrames += 1;
    if (!this.overflowActive) {
      this.overflowEvents += 1;
      this.overflowActive = true;
    }
  }

  wrapIndex(value) {
    const length = this.loopLength;
    if (length <= 0) return 0;
    let wrapped = value % length;
    if (wrapped < 0) wrapped += length;
    return wrapped;
  }

  sendPatch(slotIndex) {
    const patch = this.patchPool[slotIndex];
    if (!patch || patch.validFrames <= 0) return;

    this.patchPool[slotIndex] = null;
    this.patchMessage.sequence = this.patchSequence;
    this.patchMessage.slotIndex = slotIndex;
    this.patchMessage.validFrames = patch.validFrames;
    this.patchMessage.patchFlushFrames = this.patchFlushFrames;
    this.patchMessage.startInputFrame = patch.startInputFrame;
    this.patchMessage.endInputFrame = patch.endInputFrame;
    this.patchMessage.indices = patch.indices;
    this.patchMessage.values = patch.values;
    this.patchMessage.rightValues = patch.rightValues;
    this.patchMessage.oldValues = patch.oldValues;
    this.patchMessage.oldRightValues = patch.oldRightValues;
    this.patchTransferList[0] = patch.indices.buffer;
    this.patchTransferList[1] = patch.values.buffer;
    this.patchTransferList[2] = patch.oldValues.buffer;
    this.patchTransferList.length = this.channelCount > 1 ? 5 : 3;
    if (patch.rightValues) this.patchTransferList[3] = patch.rightValues.buffer;
    if (patch.oldRightValues) this.patchTransferList[4] = patch.oldRightValues.buffer;
    this.port.postMessage(this.patchMessage, this.patchTransferList);
    this.patchSequence += 1;
  }

  postStopMessage(startupCancelled) {
    const processorStopFrame = Number.isSafeInteger(this.processorStopFrame)
      ? this.processorStopFrame
      : (typeof currentFrame === 'number' ? currentFrame : this.fallbackCurrentFrame);
    Object.assign(this.stopMessage, {
      overflowFrames: this.overflowFrames,
      overflowEvents: this.overflowEvents,
      patchesSent: this.patchSequence,
      patchFlushFrames: this.patchFlushFrames,
      startupCancelled,
      requestFrame: this.startupRequestFrameForDiagnostics,
      firstInputFrame: this.startupFirstInputFrameForDiagnostics,
      stopFrame: processorStopFrame,
      requestedStopFrame: this.stopFrameTarget,
      appliedExclusiveEnd: this.appliedExclusiveEnd,
      processorStopFrame,
      channelCount: this.channelCount,
      backfillFrames: this.startupBackfillFramesForDiagnostics,
      replayBudgetFramesPerProcess: this.startupReplayBudget,
      replayedFrames: this.startupReplayedFrames,
      maxReplayedFramesPerProcess: this.startupMaxReplayedFramesPerProcess,
      liveQueueCapacityFrames: this.startupQueueCapacity,
      liveQueueFrames: this.startupLiveFrames,
      liveQueuePeakFrames: this.startupLiveQueuePeakFrames,
    });
    this.port.postMessage(this.stopMessage);
  }

  emitPendingStopAck() {
    if (!this.stopped || !this.stopAckPending) return;
    this.stopAckPending = false;
    this.postStopMessage(this.stopAckStartupCancelled);
  }

  stopOverdub(requestedStopFrame) {
    if (this.stopped) return;
    if (this.startupPhase !== 'live') {
      // Before the first startup patch, all edits exist only in this private
      // loop copy. Cancelling here therefore cannot partially alter AudioBuffer
      // PCM or PCM history.
      this.startupPhase = 'cancelled';
      this.active = false;
      this.stopped = true;
      this.startupBackfillChannels = null;
      this.stopAckStartupCancelled = true;
      this.stopAckPending = true;
      this.processorStopFrame = typeof currentFrame === 'number' ? currentFrame : this.fallbackCurrentFrame;
      this.appliedExclusiveEnd = null;
      return;
    }
    this.stopRequested = true;
    this.stopFrameTarget = Number.isSafeInteger(requestedStopFrame) && requestedStopFrame >= 0
      ? requestedStopFrame
      : (typeof currentFrame === 'number' ? currentFrame : this.fallbackCurrentFrame);
    this.stopAckStartupCancelled = false;
  }

  acceptStartupBackfill(message) {
    if (this.startupPhase !== 'waiting-backfill' || !this.active || this.stopped) return;
    const channels = Array.isArray(message.channels) ? message.channels : null;
    const requestFrame = this.startupRequestFrame;
    const firstInputFrame = this.startupFirstInputFrame;
    const frames = message.validFrames;
    const expectedFrames = requestFrame !== null && firstInputFrame !== null
      ? firstInputFrame - requestFrame : -1;
    if (message.requestFrame !== requestFrame || message.firstInputFrame !== firstInputFrame
      || !Number.isInteger(frames) || frames < 0 || frames !== expectedFrames
      || frames > this.startupBackfillCapacity || frames + this.startupQueueCapacity > this.bufferCapacity
      || !Number.isInteger(message.channelCount) || message.channelCount < 1 || message.channelCount > 2
      || message.channelCount !== this.firstInputMessage.channelCount
      || !channels || channels.length !== message.channelCount
      || channels.some((samples) => !(samples instanceof Float32Array) || samples.length < frames)) {
      this.failStartup('invalid-input-backfill-range-or-format');
      return;
    }
    this.startupBackfillChannels = channels;
    this.startupBackfillFrames = frames;
    this.startupBackfillFramesForDiagnostics = frames;
    this.startupBackfillCursor = 0;
    this.startupPhase = 'replaying';
  }

  failStartup(reason) {
    if (this.startupFailureSent || this.stopped || this.startupPhase === 'live') return;
    this.startupFailureSent = true;
    this.active = false;
    this.stopped = true;
    this.startupPhase = 'failed';
    this.startupBackfillChannels = null;
    this.stopAckStartupCancelled = true;
    this.stopAckPending = true;
    this.port.postMessage({ type: 'OVERDUB_ERROR', message: `Overdub startup was cancelled before PCM commit (${reason}).` });
  }

  queueStartupInput(inputChannels, sourceStart, frames, frameStart) {
    if (frames <= 0) return true;
    const expectedFrame = this.startupFirstInputFrame + this.startupLiveFrames;
    if (frameStart + sourceStart !== expectedFrame
      || this.startupLiveFrames + frames > this.startupQueueCapacity
      || this.startupBackfillFrames + this.startupLiveFrames + frames > this.bufferCapacity) {
      this.failStartup('startup-live-queue-overrun-or-discontinuity');
      return false;
    }
    const left = inputChannels[0];
    const right = inputChannels[1] || left;
    if (!left || sourceStart + frames > left.length || !right || sourceStart + frames > right.length) {
      this.failStartup('startup-live-input-unavailable');
      return false;
    }
    const destination = this.startupLiveFrames;
    for (let frame = 0; frame < frames; frame += 1) {
      this.startupLiveLeft[destination + frame] = left[sourceStart + frame] || 0;
      this.startupLiveRight[destination + frame] = right[sourceStart + frame] || 0;
    }
    this.startupLiveFrames += frames;
    if (this.startupLiveFrames > this.startupLiveQueuePeakFrames) {
      this.startupLiveQueuePeakFrames = this.startupLiveFrames;
    }
    return true;
  }

  applyInputSample(absoluteFrame, inputChannels, inputFrame, patchSlot) {
    const loops = this.loopChannels;
    const left = inputChannels[0];
    if (!loops || !left) return false;
    const elapsedFrame = absoluteFrame - this.startFrame;
    const playIndex = this.wrapIndex(this.reverse
      ? this.startOffsetSamples - elapsedFrame
      : this.startOffsetSamples + elapsedFrame);
    const writeBase = this.reverse
      ? playIndex + this.latencySamples
      : playIndex - this.latencySamples;
    const writeIndex = this.wrapIndex(writeBase - this.recordingOffsetSamples);
    const patch = patchSlot >= 0 ? this.patchPool[patchSlot] : null;
    if (!patch || patch.validFrames >= this.bufferCapacity || !(patch.oldValues instanceof Float32Array)
      || (this.channelCount > 1 && !(patch.oldRightValues instanceof Float32Array))) return false;
    if (patch.validFrames === 0) patch.startInputFrame = absoluteFrame;
    else if (patch.endInputFrame !== absoluteFrame) return false;
    const patchOffset = patch.validFrames;
    const right = inputChannels[1] || left;
    const leftLoop = loops[0];
    const rightLoop = this.channelCount > 1 ? loops[1] : null;
    if (!leftLoop || !patch.values || !patch.oldValues || inputFrame >= left.length
      || (rightLoop && (!patch.rightValues || !patch.oldRightValues || inputFrame >= right.length))) return false;
    const leftOldValue = leftLoop[writeIndex];
    const rightOldValue = rightLoop ? rightLoop[writeIndex] : 0;
    const leftSample = left[inputFrame] || 0;
    const rightSample = right[inputFrame] || 0;
    // Validate the complete mono/stereo write before changing either channel.
    // A malformed right-channel buffer must never leave a half-applied frame.
    patch.oldValues[patchOffset] = leftOldValue;
    patch.values[patchOffset] = leftOldValue + leftSample;
    if (rightLoop && patch.oldRightValues && patch.rightValues) {
      patch.oldRightValues[patchOffset] = rightOldValue;
      patch.rightValues[patchOffset] = rightOldValue + rightSample;
    }
    leftLoop[writeIndex] = patch.values[patchOffset] || 0;
    if (rightLoop && patch.rightValues) rightLoop[writeIndex] = patch.rightValues[patchOffset] || 0;
    patch.endInputFrame = absoluteFrame + 1;
    patch.indices[patchOffset] = writeIndex;
    patch.validFrames += 1;
    this.overflowActive = false;
    return true;
  }

  replayStartup() {
    if (this.startupPhase !== 'replaying') return;
    let budget = this.startupReplayBudget;
    let patchSlot = this.startupPatchSlot;
    if (patchSlot < 0) patchSlot = this.findAvailablePatch();
    if (patchSlot < 0) {
      this.failStartup('patch-pool-unavailable');
      return;
    }
    this.startupPatchSlot = patchSlot;
    const backfill = this.startupBackfillChannels || [];
    let replayedThisProcess = 0;
    while (budget > 0) {
      let absoluteFrame;
      let channels;
      let sourceIndex;
      if (this.startupBackfillCursor < this.startupBackfillFrames) {
        absoluteFrame = this.startupRequestFrame + this.startupBackfillCursor;
        channels = backfill;
        sourceIndex = this.startupBackfillCursor;
        this.startupBackfillCursor += 1;
      } else if (this.startupLiveCursor < this.startupLiveFrames) {
        absoluteFrame = this.startupFirstInputFrame + this.startupLiveCursor;
        channels = this.channelCount > 1
          ? [this.startupLiveLeft, this.startupLiveRight]
          : [this.startupLiveLeft];
        sourceIndex = this.startupLiveCursor;
        this.startupLiveCursor += 1;
      } else {
        break;
      }
      if (!this.applyInputSample(absoluteFrame, channels, sourceIndex, patchSlot)) {
        this.failStartup('startup-patch-capacity-exceeded');
        return;
      }
      budget -= 1;
      replayedThisProcess += 1;
    }
    this.startupReplayedFrames += replayedThisProcess;
    if (replayedThisProcess > this.startupMaxReplayedFramesPerProcess) {
      this.startupMaxReplayedFramesPerProcess = replayedThisProcess;
    }

    if (this.startupBackfillCursor === this.startupBackfillFrames
      && this.startupLiveCursor === this.startupLiveFrames) {
      this.startupPhase = 'live';
      this.startupBackfillChannels = null;
      this.startupRequestFrame = null;
      this.startupFirstInputFrame = null;
      this.startupPatchSlot = -1;
      // This is the single commit point for all staged [R,F) backfill and
      // queued [F,current) live samples. No startup failure can publish a
      // prefix of those edits into the shared AudioBuffer.
      this.sendPatch(patchSlot);
    }
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || EMPTY_CHANNELS;
    const outputChannels = outputs[0] || EMPTY_CHANNELS;
    let frames = 0;
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (output && output.length > frames) frames = output.length;
    }

    const input = inputChannels[0] || null;
    const loops = this.loopChannels;
    if (this.active && loops && this.loopLength > 0) {
      const renderFrame = typeof currentFrame === 'number' ? currentFrame : this.fallbackCurrentFrame;
      let patchSlot = -1;
      let queuedStartupInput = false;

      if (this.startupPhase === 'waiting-first-input' && input && input.length > 0) {
        const requestFrame = this.startupRequestFrame;
        const firstInputFrame = requestFrame === null ? renderFrame : Math.max(renderFrame, requestFrame);
        const sourceStart = firstInputFrame - renderFrame;
        if (requestFrame === null || !Number.isSafeInteger(firstInputFrame) || sourceStart < 0
          || sourceStart >= input.length || firstInputFrame - requestFrame > this.startupBackfillCapacity) {
          this.failStartup('first-input-frame-outside-bounded-preroll');
        } else {
          this.startupFirstInputFrame = firstInputFrame;
          this.startupFirstInputFrameForDiagnostics = firstInputFrame;
          this.startupPhase = 'waiting-backfill';
          const firstMessage = this.firstInputMessage;
          firstMessage.requestFrame = requestFrame;
          firstMessage.firstInputFrame = firstInputFrame;
          firstMessage.channelCount = inputChannels[1] ? 2 : 1;
          this.port.postMessage(firstMessage);
          queuedStartupInput = this.queueStartupInput(inputChannels, sourceStart, input.length - sourceStart, renderFrame);
        }
      } else if (this.startupPhase === 'waiting-backfill' || this.startupPhase === 'replaying') {
        if (input && input.length > 0) {
          queuedStartupInput = this.queueStartupInput(inputChannels, 0, input.length, renderFrame);
        }
      }

      if (this.startupPhase === 'replaying') this.replayStartup();

      if (this.stopped) {
        for (let channel = 0; channel < outputChannels.length; channel += 1) {
          outputChannels[channel]?.fill(0);
        }
        if (typeof currentFrame !== 'number') this.fallbackCurrentFrame += frames;
        this.emitPendingStopAck();
        return false;
      }

      for (let frame = 0; frame < frames; frame += 1) {
        const elapsedFrame = renderFrame + frame - this.startFrame;
        const absoluteInputFrame = renderFrame + frame;
        const playIndex = this.wrapIndex(this.reverse
          ? this.startOffsetSamples - elapsedFrame
          : this.startOffsetSamples + elapsedFrame);

        if (this.stopRequested && this.stopFrameTarget !== null && absoluteInputFrame >= this.stopFrameTarget) {
          this.active = false;
          this.stopped = true;
          this.appliedExclusiveEnd = this.stopFrameTarget;
          this.stopAckPending = true;
          for (let channel = 0; channel < outputChannels.length; channel += 1) {
            outputChannels[channel]?.fill(0, frame);
          }
          break;
        }

        const hasInput = input && frame < input.length;
        if (this.startupPhase === 'live' && hasInput && !queuedStartupInput) {
          if (patchSlot < 0) patchSlot = this.findAvailablePatch();
          if (patchSlot < 0) {
            this.noteOverflow();
          } else {
            const existingPatch = this.patchPool[patchSlot];
            if (existingPatch?.validFrames && existingPatch.endInputFrame !== absoluteInputFrame) {
              this.sendPatch(patchSlot);
              patchSlot = this.findAvailablePatch();
            }
            if (patchSlot < 0) {
              this.noteOverflow();
            } else if (!this.applyInputSample(absoluteInputFrame, inputChannels, frame, patchSlot)) {
                this.noteOverflow();
            } else {
              const patch = this.patchPool[patchSlot];
              if (patch && (patch.validFrames === this.bufferCapacity
                || (this.batchPatchMessages && patch.validFrames >= this.patchFlushFrames))) {
                this.sendPatch(patchSlot);
                patchSlot = -1;
              }
            }
          }
        }

        for (let channel = 0; channel < outputChannels.length; channel += 1) {
          const output = outputChannels[channel];
          if (!output || frame >= output.length) continue;
          output[frame] = loops[channel]?.[playIndex] ?? loops[0]?.[playIndex] ?? 0;
        }
      }

      const stopBoundaryReached = this.stopRequested && this.stopFrameTarget !== null
        && renderFrame + frames >= this.stopFrameTarget;
      if (stopBoundaryReached) {
        // Flush every bounded partial segment in input-frame order. This also
        // covers a late STOP callback whose current quantum contains no input.
        let pendingSlot = this.findOldestPendingPatch();
        while (pendingSlot >= 0) {
          this.sendPatch(pendingSlot);
          pendingSlot = this.findOldestPendingPatch();
        }
      } else if (patchSlot >= 0) {
        const patch = this.patchPool[patchSlot];
        if (!this.batchPatchMessages || patch?.validFrames === this.bufferCapacity) {
          this.sendPatch(patchSlot);
        }
      }
      if (stopBoundaryReached) {
        this.active = false;
        this.stopped = true;
        // This is the process-quantum end that acknowledged STOP. It may be
        // later than the exact PCM boundary reported separately below.
        this.processorStopFrame = renderFrame + frames;
        this.appliedExclusiveEnd = this.stopFrameTarget;
        this.stopAckPending = true;
      }
    } else {
      for (let channel = 0; channel < outputChannels.length; channel += 1) {
        const output = outputChannels[channel];
        if (!output) continue;
        if (this.stopped && loops && this.loopLength > 0 && channel < this.channelCount) {
          for (let frame = 0; frame < output.length; frame += 1) output[frame] = 0;
        } else {
          output.fill(0);
        }
      }
    }

    if (typeof currentFrame !== 'number') this.fallbackCurrentFrame += frames;
    this.emitPendingStopAck();
    // Once the stop acknowledgement has been posted and all final patches have
    // been sent, no more audio work is needed. Returning true here kept every
    // retired overdub processor on the render thread until context shutdown.
    return !this.stopped;
  }
}

class BrowserLoopbackCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    const requestedFrames = processorOptions.captureFrames;
    this.captureFrames = Number.isInteger(requestedFrames) && requestedFrames > 0
      ? Math.min(requestedFrames, 1_000_000)
      : 44100;
    this.captureBuffer = new Float32Array(this.captureFrames);
    this.framesCaptured = 0;
    this.complete = false;
    this.captureMessage = { type: 'LOOPBACK_CAPTURE', framesCaptured: 0, samples: this.captureBuffer };
    this.captureTransferList = [this.captureBuffer.buffer];
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || EMPTY_CHANNELS;
    const outputChannels = outputs[0] || EMPTY_CHANNELS;
    let frames = 0;
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (output && output.length > frames) frames = output.length;
    }

    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (!output) continue;
      const input = inputChannels[channel] || (channel === 0 ? inputChannels[0] : null);
      if (!input) {
        output.fill(0);
      } else {
        const count = Math.min(output.length, input.length);
        for (let frame = 0; frame < count; frame += 1) output[frame] = input[frame] || 0;
        for (let frame = count; frame < output.length; frame += 1) output[frame] = 0;
      }
    }

    const input = inputChannels[0];
    if (!this.complete && input) {
      const remaining = this.captureFrames - this.framesCaptured;
      const count = Math.min(input.length, remaining);
      if (count > 0) {
        const writeStart = this.framesCaptured;
        for (let frame = 0; frame < count; frame += 1) {
          this.captureBuffer[writeStart + frame] = input[frame] || 0;
        }
        this.framesCaptured += count;
      }
      if (this.framesCaptured >= this.captureFrames) {
        this.complete = true;
        this.captureMessage.framesCaptured = this.framesCaptured;
        this.port.postMessage(this.captureMessage, this.captureTransferList);
      }
    }

    return true;
  }
}

registerProcessor('rc505-overdub-processor', BrowserOverdubProcessor);
registerProcessor('rc505-loopback-capture', BrowserLoopbackCaptureProcessor);
