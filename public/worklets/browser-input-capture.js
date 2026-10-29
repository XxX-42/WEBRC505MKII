/*
 * Engine-owned, bounded Browser input capture. This worklet is connected only
 * after the app's already-authorized input stream is connected. It never
 * monitors audio: its output is always silent. Recording sessions use explicit
 * AudioContext-frame boundaries and a short stereo pre-roll ring so a delayed
 * control message cannot move the requested start forward.
 */
const DEFAULT_TRACK_COUNT = 5;
const DEFAULT_CHUNK_SIZE = 16_384;
const DEFAULT_CHUNK_POOL_SIZE = 3;
const DEFAULT_PREROLL_FRAMES = 8_192;
const DEFAULT_MAX_RECORDING_BYTES = 384 * 1024 * 1024;
const MAX_TRACK_FX_APPLY_COMMANDS = 32;
const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;
const EMPTY_CHANNELS = [];

class BrowserInputCaptureProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const config = options.processorOptions || {};
    this.trackCount = this.positiveInteger(config.trackCount, DEFAULT_TRACK_COUNT);
    this.chunkSize = this.positiveInteger(config.chunkSize, DEFAULT_CHUNK_SIZE);
    this.chunkPoolSize = this.positiveInteger(config.chunkPoolSize, DEFAULT_CHUNK_POOL_SIZE);
    this.preRollFrames = this.positiveInteger(config.preRollFrames, DEFAULT_PREROLL_FRAMES);
    this.readyPreRollFrames = Math.min(this.preRollFrames,
      this.positiveInteger(config.readyPreRollFrames, this.preRollFrames));
    this.maxRecordingBytes = this.positiveInteger(config.maxRecordingBytes, DEFAULT_MAX_RECORDING_BYTES);
    this.rhythmPhaseEpochView = typeof SharedArrayBuffer !== 'undefined'
      && config.rhythmPhaseEpochBuffer instanceof SharedArrayBuffer
      ? new Int32Array(config.rhythmPhaseEpochBuffer) : null;

    // The ring is volatile pre-roll only. It is reset at every input/device or
    // timeline generation boundary and is never directly returned as a loop.
    this.preRollLeft = new Float32Array(this.preRollFrames);
    this.preRollRight = new Float32Array(this.preRollFrames);
    this.preRollRawLeft = new Float32Array(this.preRollFrames);
    this.preRollRawRight = new Float32Array(this.preRollFrames);
    this.preRollBounceLeft = Array.from({ length: this.trackCount }, () => new Float32Array(this.preRollFrames));
    this.preRollBounceRight = Array.from({ length: this.trackCount }, () => new Float32Array(this.preRollFrames));
    this.preRollGateMask = new Uint8Array(this.preRollFrames);
    this.preRollEndFrame = 0;
    this.preRollValidFrames = 0;
    this.preRollChannelCount = 0;
    const initialTrackFxApply = Array.isArray(config.initialTrackFxApply) ? config.initialTrackFxApply : [];
    this.trackFxApplyEnabled = new Uint8Array(this.trackCount);
    this.trackFxApplyAppliedRevision = new Float64Array(this.trackCount);
    for (let track = 0; track < this.trackCount; track += 1) {
      this.trackFxApplyEnabled[track] = initialTrackFxApply[track] === false ? 0 : 1;
    }
    this.trackFxApplyQueueTrack = new Uint8Array(MAX_TRACK_FX_APPLY_COMMANDS);
    this.trackFxApplyQueueEnabled = new Uint8Array(MAX_TRACK_FX_APPLY_COMMANDS);
    this.trackFxApplyQueueRevision = new Float64Array(MAX_TRACK_FX_APPLY_COMMANDS);
    this.trackFxApplyQueueFrame = new Float64Array(MAX_TRACK_FX_APPLY_COMMANDS);
    this.trackFxApplyQueueLength = 0;
    this.trackFxApplyAckMessages = new Array(MAX_TRACK_FX_APPLY_COMMANDS);
    for (let index = 0; index < MAX_TRACK_FX_APPLY_COMMANDS; index += 1) {
      this.trackFxApplyAckMessages[index] = {
        type: 'TRACK_FX_APPLY_ACK', route: 'input', ok: false,
        trackIndex: 0, revision: 0, enabled: false, requestedFrame: 0,
        appliedFrame: 0, reason: '',
      };
    }
    this.trackFxApplyImmediateAck = {
      type: 'TRACK_FX_APPLY_ACK', route: 'input', ok: false,
      trackIndex: 0, revision: 0, enabled: false, requestedFrame: 0,
      appliedFrame: 0, reason: '',
    };
    this.lastFrameEnd = null;
    this.diagnosticFrameStart = 0;
    this.diagnosticFrameCount = 0;
    this.diagnosticPreviousFrameEnd = -1;
    this.diagnosticPreRollEndFrame = 0;
    this.inputReady = false;
    this.inputGeneration = 0;
    this.captureReadyEpoch = 0;
    this.sampleRate = this.positiveInteger(config.sampleRate, 0);
    this.readyMessage = {
      type: 'INPUT_CAPTURE_READY', inputGeneration: 0, sampleRate: this.sampleRate,
      captureReadyEpoch: 0,
      firstFrame: 0, frameCount: 0, oldestAvailableFrame: 0, latestAvailableFrame: 0,
      preRollCapacityFrames: this.preRollFrames, preRollValidFrames: 0,
      requiredPreRollFrames: this.readyPreRollFrames,
    };
    this.notReadyMessage = {
      type: 'INPUT_CAPTURE_NOT_READY', inputGeneration: 0, sampleRate: this.sampleRate,
      captureReadyEpoch: 0,
      reason: '', frameStart: 0, oldestAvailableFrame: 0, latestAvailableFrame: 0,
      preRollCapacityFrames: this.preRollFrames, preRollValidFrames: 0,
      requiredPreRollFrames: this.readyPreRollFrames,
    };
    this.captureReadySent = false;
    this.fallbackCurrentFrame = 0;
    this.slots = new Array(this.trackCount);
    for (let index = 0; index < this.trackCount; index += 1) this.slots[index] = this.createSlot(index);

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  createSlot(trackIndex) {
    const chunkBuffers = new Array(this.chunkPoolSize);
    const monoRightBuffers = new Array(this.chunkPoolSize);
    const monoReturnPairs = new Array(this.chunkPoolSize);
    const monoChannelMessages = new Array(this.chunkPoolSize);
    for (let index = 0; index < this.chunkPoolSize; index += 1) {
      const pair = [new Float32Array(this.chunkSize), new Float32Array(this.chunkSize)];
      chunkBuffers[index] = pair;
      monoRightBuffers[index] = pair[1];
      monoReturnPairs[index] = [null, null];
      monoChannelMessages[index] = [null];
    }
    const transfers = [null, null];
    return {
      trackIndex,
      sessionId: 0,
      inputGeneration: 0,
      state: 'idle',
      poolLeasePending: false,
      autoRecThreshold: null,
      bounceSourceMask: 0,
      requestedStartFrame: 0,
      startReceivedFrame: 0,
      startAckSent: false,
      requestedMaxRecordingFrames: null,
      stopRequested: false,
      stopFrame: 0,
      rhythmPhaseEpoch: 0,
      channelCount: 0,
      maxFrames: 0,
      maxRecordingBytes: this.maxRecordingBytes,
      framesCaptured: 0,
      captureFramesProcessed: 0,
      droppedFrames: 0,
      timelineOverlapEvents: 0,
      timelineOverlapFrames: 0,
      overflowEvents: 0,
      overflowActive: false,
      stoppedForOverflow: false,
      limitReached: false,
      chunksSent: 0,
      activeChunkIndex: -1,
      activeChunkOffset: 0,
      chunkBuffers,
      monoRightBuffers,
      monoReturnPairs,
      monoChannelMessages,
      chunkTransferList: transfers,
      chunkMessage: {
        type: 'RECORD_CHUNK', trackIndex, sessionId: 0, inputGeneration: 0,
        chunkIndex: 0, sequence: 0, validFrames: 0, channelCount: 0,
        samples: null, channels: null, startFrame: 0,
      },
      completeMessage: {
        type: 'RECORD_COMPLETE', trackIndex, sessionId: 0, inputGeneration: 0,
        requestedStartFrame: 0, stopFrame: 0, framesCaptured: 0, droppedFrames: 0,
        overflowEvents: 0, maxRecordingFrames: 0, maxRecordingBytes: this.maxRecordingBytes,
        channelCount: 0, limitReached: false, chunksSent: 0, status: 'complete',
        startReceivedFrame: 0, requestAgeAtStartFrames: 0,
        preRollCapacityFrames: this.preRollFrames, preRollValidFrames: 0,
        timelineOverlapEvents: 0, timelineOverlapFrames: 0,
        rhythmPhaseEpoch: 0,
      },
      configMessage: {
        type: 'RECORD_CONFIGURED', trackIndex, sessionId: 0, inputGeneration: 0,
        channelCount: 0, requestedStartFrame: 0, captureStartFrame: 0, maxRecordingFrames: 0,
        maxRecordingBytes: this.maxRecordingBytes,
        startReceivedFrame: 0, requestAgeAtStartFrames: 0,
        preRollCapacityFrames: this.preRollFrames, preRollValidFrames: 0,
      },
      errorMessage: {
        type: 'CAPTURE_ERROR', trackIndex, sessionId: 0, inputGeneration: 0,
        startRejected: false,
        reason: '', requestedStartFrame: 0, stopFrame: 0,
        oldestAvailableFrame: 0, latestAvailableFrame: 0,
        startReceivedFrame: 0, requestAgeAtStartFrames: 0,
        callbackFrameStart: 0, previousCallbackEndFrame: -1, preRollEndAtCallbackStart: 0,
        preRollCapacityFrames: this.preRollFrames, preRollValidFrames: 0,
        inputReady: false, currentInputGeneration: 0, sampleRate: this.sampleRate,
      },
      abortedMessage: {
        type: 'RECORD_ABORTED', trackIndex, sessionId: 0, inputGeneration: 0,
        chunksSent: 0,
      },
      poolReleasedMessage: {
        type: 'CAPTURE_POOL_RELEASED', trackIndex, sessionId: 0, inputGeneration: 0,
      },
    };
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'CHECK_CAPTURE_READINESS') {
      this.port.postMessage({
        type: 'CAPTURE_READINESS_STATE',
        inputGeneration: this.inputGeneration,
        captureReadyEpoch: this.captureReadyEpoch,
        ready: this.inputReady && this.captureReadySent
          && this.preRollValidFrames >= this.readyPreRollFrames,
        oldestAvailableFrame: this.preRollEndFrame - this.preRollValidFrames,
        latestAvailableFrame: this.preRollEndFrame,
        preRollValidFrames: this.preRollValidFrames,
        requiredPreRollFrames: this.readyPreRollFrames,
      });
      return;
    }
    if (message.type === 'INPUT_READY') {
      this.setInputReady(message);
      return;
    }
    if (message.type === 'SET_TRACK_FX_APPLY') {
      this.queueTrackFxApply(message);
      return;
    }
    const trackIndex = message.trackIndex;
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= this.slots.length) return;
    const slot = this.slots[trackIndex];
    if (!slot) return;

    if (message.type === 'START_CAPTURE') {
      this.startCapture(slot, message);
    } else if (message.type === 'STOP_CAPTURE') {
      if (slot.sessionId === message.sessionId) this.requestStop(slot, message.stopFrame, message.rhythmPhaseEpoch);
    } else if (message.type === 'ABORT_CAPTURE') {
      if (slot.sessionId === message.sessionId && message.inputGeneration === slot.inputGeneration) {
        if (slot.state === 'armed' || slot.state === 'pending' || slot.state === 'recording') {
          this.abortCapture(slot, 'capture-aborted');
        } else if (slot.poolLeasePending) {
          slot.state = 'aborting';
          if (this.poolAvailable(slot)) {
            slot.poolLeasePending = false;
            slot.state = 'idle';
            this.postCapturePoolReleased(slot);
          }
        } else if (slot.state === 'idle' && this.poolAvailable(slot)) {
          // Clear may arrive just after normal completion and after the last
          // chunk was returned. Confirm the still-matching lease immediately.
          this.postCapturePoolReleased(slot);
        }
      }
    } else if (message.type === 'RECYCLE_CHUNK') {
      this.recycleChunk(slot, message);
    }
  }

  postTrackFxApplyFailure(message, reason) {
    const ack = this.trackFxApplyImmediateAck;
    ack.trackIndex = Number.isInteger(message?.trackIndex) ? message.trackIndex : -1;
    ack.revision = Number.isSafeInteger(message?.revision) ? message.revision : 0;
    ack.enabled = message?.enabled === true;
    ack.requestedFrame = Number.isSafeInteger(message?.applyFrame) ? message.applyFrame : 0;
    ack.appliedFrame = typeof currentFrame === 'number' && Number.isSafeInteger(currentFrame)
      ? currentFrame : this.fallbackCurrentFrame;
    ack.reason = reason;
    this.port.postMessage(ack);
  }

  queueTrackFxApply(message) {
    const trackIndex = message.trackIndex;
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= this.trackCount
      || typeof message.enabled !== 'boolean'
      || !Number.isSafeInteger(message.revision) || message.revision <= this.trackFxApplyAppliedRevision[trackIndex]
      || !Number.isSafeInteger(message.applyFrame) || message.applyFrame < 0) {
      this.postTrackFxApplyFailure(message, 'invalid-track-fx-apply-command');
      return;
    }
    if (this.trackFxApplyQueueLength >= MAX_TRACK_FX_APPLY_COMMANDS) {
      this.postTrackFxApplyFailure(message, 'track-fx-apply-queue-full');
      return;
    }
    let insertAt = this.trackFxApplyQueueLength;
    while (insertAt > 0 && this.trackFxApplyQueueFrame[insertAt - 1] > message.applyFrame) {
      this.trackFxApplyQueueTrack[insertAt] = this.trackFxApplyQueueTrack[insertAt - 1];
      this.trackFxApplyQueueEnabled[insertAt] = this.trackFxApplyQueueEnabled[insertAt - 1];
      this.trackFxApplyQueueRevision[insertAt] = this.trackFxApplyQueueRevision[insertAt - 1];
      this.trackFxApplyQueueFrame[insertAt] = this.trackFxApplyQueueFrame[insertAt - 1];
      insertAt -= 1;
    }
    this.trackFxApplyQueueTrack[insertAt] = trackIndex;
    this.trackFxApplyQueueEnabled[insertAt] = message.enabled ? 1 : 0;
    this.trackFxApplyQueueRevision[insertAt] = message.revision;
    this.trackFxApplyQueueFrame[insertAt] = message.applyFrame;
    this.trackFxApplyQueueLength += 1;
  }

  applyTrackFxApplyChanges(frame) {
    while (this.trackFxApplyQueueLength > 0 && this.trackFxApplyQueueFrame[0] <= frame) {
      const trackIndex = this.trackFxApplyQueueTrack[0];
      const revision = this.trackFxApplyQueueRevision[0];
      const enabled = this.trackFxApplyQueueEnabled[0] === 1;
      const requestedFrame = this.trackFxApplyQueueFrame[0];
      const ok = requestedFrame === frame;
      if (ok) {
        this.trackFxApplyEnabled[trackIndex] = enabled ? 1 : 0;
        this.trackFxApplyAppliedRevision[trackIndex] = revision;
      }
      const ack = this.trackFxApplyAckMessages[0];
      ack.trackIndex = trackIndex;
      ack.revision = revision;
      ack.enabled = enabled;
      ack.requestedFrame = requestedFrame;
      ack.appliedFrame = frame;
      ack.ok = ok;
      ack.reason = ok ? '' : 'track-fx-apply-frame-missed';
      this.port.postMessage(ack);
      for (let index = 1; index < this.trackFxApplyQueueLength; index += 1) {
        this.trackFxApplyQueueTrack[index - 1] = this.trackFxApplyQueueTrack[index];
        this.trackFxApplyQueueEnabled[index - 1] = this.trackFxApplyQueueEnabled[index];
        this.trackFxApplyQueueRevision[index - 1] = this.trackFxApplyQueueRevision[index];
        this.trackFxApplyQueueFrame[index - 1] = this.trackFxApplyQueueFrame[index];
      }
      this.trackFxApplyQueueLength -= 1;
    }
  }

  setInputReady(message) {
    if (!Number.isSafeInteger(message.generation) || message.generation <= this.inputGeneration) return;
    const hadInputGeneration = this.inputGeneration > 0;
    const sampleRateChanged = Number.isFinite(message.sampleRate) && message.sampleRate > 0
      && this.sampleRate > 0 && message.sampleRate !== this.sampleRate;
    if (hadInputGeneration) {
      const reason = sampleRateChanged
        ? 'sample-rate-changed'
        : message.ready === true ? 'input-generation-changed' : 'input-disconnected';
      this.failActiveSessions(reason);
    }
    this.inputGeneration = message.generation;
    this.inputReady = message.ready === true && !sampleRateChanged;
    this.captureReadyEpoch = 0;
    this.captureReadySent = false;
    this.resetPreRoll();
    if (sampleRateChanged) {
      for (let index = 0; index < this.slots.length; index += 1) {
        this.postError(this.slots[index], 0, 'sample-rate-changed');
      }
    }
  }

  resetPreRoll() {
    this.preRollValidFrames = 0;
    this.preRollEndFrame = 0;
    this.preRollChannelCount = 0;
    this.lastFrameEnd = null;
  }

  invalidateCaptureReadiness(reason, frameStart = this.preRollEndFrame) {
    if (this.captureReadyEpoch >= Number.MAX_SAFE_INTEGER) {
      // Never wrap an epoch: a wrapped value could make a stale READY look current.
      this.inputReady = false;
      this.captureReadySent = false;
      return;
    }
    this.captureReadyEpoch += 1;
    if (!this.captureReadySent) return;
    const message = this.notReadyMessage;
    message.inputGeneration = this.inputGeneration;
    message.captureReadyEpoch = this.captureReadyEpoch;
    message.sampleRate = this.sampleRate || (typeof sampleRate === 'number' ? sampleRate : 0);
    message.reason = reason;
    message.frameStart = Number.isSafeInteger(frameStart) ? frameStart : 0;
    message.oldestAvailableFrame = this.preRollEndFrame - this.preRollValidFrames;
    message.latestAvailableFrame = this.preRollEndFrame;
    message.preRollValidFrames = this.preRollValidFrames;
    this.port.postMessage(message);
    this.captureReadySent = false;
  }

  publishCaptureReadiness(frameStart, frameCount) {
    if (this.captureReadySent || this.preRollValidFrames < this.readyPreRollFrames) return;
    const message = this.readyMessage;
    message.inputGeneration = this.inputGeneration;
    message.captureReadyEpoch = this.captureReadyEpoch;
    message.sampleRate = this.sampleRate || (typeof sampleRate === 'number' ? sampleRate : 0);
    message.firstFrame = frameStart;
    message.frameCount = frameCount;
    message.oldestAvailableFrame = this.preRollEndFrame - this.preRollValidFrames;
    message.latestAvailableFrame = this.preRollEndFrame;
    message.preRollValidFrames = this.preRollValidFrames;
    this.port.postMessage(message);
    this.captureReadySent = true;
  }

  startCapture(slot, message) {
    // Snapshot the AudioWorklet timeline when START_CAPTURE reaches the tap.
    // This distinguishes a delayed main-thread message from later ring
    // eviction and makes an expired request immediately diagnosable.
    const startReceivedFrame = this.preRollEndFrame;
    if (slot.state !== 'idle') {
      this.postError(slot, message.sessionId, 'track-capture-busy', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }
    slot.startReceivedFrame = startReceivedFrame;
    const bounceSourceMask = message.bounceSourceMask === undefined ? 0 : message.bounceSourceMask;
    if (!Number.isSafeInteger(message.sessionId) || message.sessionId <= 0
      || !Number.isSafeInteger(message.startFrame) || message.startFrame < 0
      || (message.maxRecordingFrames !== undefined && (!Number.isSafeInteger(message.maxRecordingFrames)
        || message.maxRecordingFrames < 0 || message.maxRecordingFrames > 1_000_000))
      || (message.autoRecThreshold !== undefined && (!Number.isFinite(message.autoRecThreshold) || message.autoRecThreshold <= 0 || message.autoRecThreshold > 1))
      || !Number.isSafeInteger(bounceSourceMask) || bounceSourceMask < 0 || bounceSourceMask > 31
      || (bounceSourceMask & (1 << slot.trackIndex)) !== 0
      || !Number.isSafeInteger(message.inputGeneration) || message.inputGeneration !== this.inputGeneration
      || (message.rhythmPhaseEpoch !== undefined && (!Number.isSafeInteger(message.rhythmPhaseEpoch)
        || message.rhythmPhaseEpoch <= 0 || message.rhythmPhaseEpoch > 0x7fffffff))
      || !Number.isSafeInteger(message.captureReadyEpoch)) {
      this.postError(slot, message.sessionId, 'invalid-capture-request', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }
    if (message.captureReadyEpoch !== this.captureReadyEpoch) {
      this.postError(slot, message.sessionId, 'capture-readiness-epoch-changed', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }
    if (message.autoRecThreshold === undefined
      && message.startFrame < this.preRollEndFrame
      && (!this.captureReadySent || this.preRollValidFrames < this.readyPreRollFrames)) {
      this.postError(slot, message.sessionId, 'capture-preroll-not-ready', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }
    if (!this.inputReady) {
      this.postError(slot, message.sessionId, 'input-not-ready', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }
    // A media input can remain connected while the AudioWorklet timeline is
    // warming again after a frame gap. Do not use the stale main-thread ready
    // state to backfill from an invalidated pre-roll window. A start at or
    // beyond the current callback boundary needs no pre-roll and can remain
    // scheduled; any earlier start requires a fresh, fully warmed range.
    if (!this.poolAvailable(slot)) {
      this.postError(slot, message.sessionId, 'chunk-pool-not-reclaimed', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }
    const requestedBytes = this.positiveInteger(message.maxRecordingBytes, this.maxRecordingBytes);
    if (requestedBytes > this.maxRecordingBytes) {
      this.postError(slot, message.sessionId, 'recording-budget-exceeds-cap', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }

    const oldestAvailableFrame = this.preRollEndFrame - this.preRollValidFrames;
    if (message.autoRecThreshold === undefined && message.startFrame < oldestAvailableFrame) {
      this.postError(slot, message.sessionId, 'request-frame-outside-preroll', message.startFrame, 0, message.inputGeneration, startReceivedFrame, true);
      return;
    }

    slot.sessionId = message.sessionId;
    slot.inputGeneration = message.inputGeneration;
    slot.poolLeasePending = false;
    slot.autoRecThreshold = message.autoRecThreshold === undefined ? null : message.autoRecThreshold;
    slot.bounceSourceMask = bounceSourceMask;
    slot.state = slot.autoRecThreshold === null ? 'pending' : 'armed';
    slot.requestedStartFrame = message.startFrame;
    slot.requestedMaxRecordingFrames = Number.isSafeInteger(message.maxRecordingFrames)
      ? message.maxRecordingFrames : null;
    slot.stopRequested = false;
    slot.startAckSent = false;
    slot.stopFrame = 0;
    slot.rhythmPhaseEpoch = Number.isSafeInteger(message.rhythmPhaseEpoch) ? message.rhythmPhaseEpoch : 0;
    slot.channelCount = 0;
    slot.maxFrames = 0;
    slot.maxRecordingBytes = requestedBytes;
    slot.framesCaptured = 0;
    slot.captureFramesProcessed = 0;
    slot.droppedFrames = 0;
    slot.timelineOverlapEvents = 0;
    slot.timelineOverlapFrames = 0;
    slot.overflowEvents = 0;
    slot.overflowActive = false;
    slot.stoppedForOverflow = false;
    slot.limitReached = false;
    slot.chunksSent = 0;
    slot.activeChunkIndex = -1;
    slot.activeChunkOffset = 0;
  }

  postError(slot, sessionId, reason, requestedStartFrame = 0, stopFrame = 0, inputGeneration = slot.inputGeneration, startReceivedFrame = slot.startReceivedFrame, startRejected = false, rhythmPhaseInvalidation = null) {
    const message = slot.errorMessage;
    message.sessionId = sessionId;
    message.inputGeneration = Number.isSafeInteger(inputGeneration) ? inputGeneration : this.inputGeneration;
    message.startRejected = startRejected;
    message.reason = reason;
    message.requestedStartFrame = Number.isSafeInteger(requestedStartFrame) ? requestedStartFrame : 0;
    message.stopFrame = Number.isSafeInteger(stopFrame) ? stopFrame : 0;
    message.oldestAvailableFrame = this.preRollEndFrame - this.preRollValidFrames;
    message.latestAvailableFrame = this.preRollEndFrame;
    message.startReceivedFrame = Number.isSafeInteger(startReceivedFrame) ? startReceivedFrame : this.preRollEndFrame;
    message.requestAgeAtStartFrames = message.startReceivedFrame - message.requestedStartFrame;
    if (rhythmPhaseInvalidation) {
      message.rhythmPhaseInvalidationReasonCode = rhythmPhaseInvalidation.reasonCode;
      message.rhythmPhaseInvalidationFrame = rhythmPhaseInvalidation.frame;
    } else {
      message.rhythmPhaseInvalidationReasonCode = 0;
      message.rhythmPhaseInvalidationFrame = 0;
    }
    message.preRollCapacityFrames = this.preRollFrames;
    message.preRollValidFrames = this.preRollValidFrames;
    message.callbackFrameStart = this.diagnosticFrameStart;
    message.callbackFrameCount = this.diagnosticFrameCount;
    message.previousCallbackEndFrame = this.diagnosticPreviousFrameEnd;
    message.preRollEndAtCallbackStart = this.diagnosticPreRollEndFrame;
    message.inputReady = this.inputReady;
    message.captureReadyEpoch = this.captureReadyEpoch;
    message.currentInputGeneration = this.inputGeneration;
    message.sampleRate = this.sampleRate;
    this.port.postMessage(message);
  }

  requestStop(slot, stopFrame, rhythmPhaseEpoch) {
    if (slot.state === 'armed') { this.abortCapture(slot, 'auto-rec-canceled', false); return; }
    if (slot.state !== 'armed' && slot.state !== 'pending' && slot.state !== 'recording') return;
    if (!Number.isSafeInteger(stopFrame) || stopFrame < slot.requestedStartFrame) {
      this.postError(slot, slot.sessionId, 'invalid-stop-frame', slot.requestedStartFrame, stopFrame);
      this.abortCapture(slot, 'invalid-stop-frame');
      return;
    }
    if (rhythmPhaseEpoch !== undefined) {
      if (!Number.isSafeInteger(rhythmPhaseEpoch) || rhythmPhaseEpoch <= 0 || rhythmPhaseEpoch > 0x7fffffff
        || (slot.rhythmPhaseEpoch > 0 && slot.rhythmPhaseEpoch !== rhythmPhaseEpoch)) {
        this.postError(slot, slot.sessionId, 'rhythm-phase-epoch-mismatch', slot.requestedStartFrame, stopFrame);
        this.abortCapture(slot, 'rhythm-phase-epoch-mismatch', false);
        return;
      }
      slot.rhythmPhaseEpoch = rhythmPhaseEpoch;
    }
    slot.stopRequested = true;
    slot.stopFrame = stopFrame;
    const oldestFrame = this.preRollEndFrame - this.preRollValidFrames;
    if (slot.requestedStartFrame < oldestFrame && slot.state === 'pending') {
      this.postError(slot, slot.sessionId, 'request-frame-outside-preroll', slot.requestedStartFrame, stopFrame);
      this.abortCapture(slot, 'request-frame-outside-preroll', false);
      return;
    }
    if (slot.state === 'pending' && stopFrame <= this.preRollEndFrame) {
      if (stopFrame === slot.requestedStartFrame) {
        this.completeCapture(slot, 0);
        return;
      }
      if (!this.preRollChannelCount) {
        this.postError(slot, slot.sessionId, 'input-frame-unavailable', slot.requestedStartFrame, stopFrame);
        this.abortCapture(slot, 'input-frame-unavailable', false);
        return;
      }
      if (!this.beginCapture(slot, this.preRollChannelCount)) return;
      for (let frame = slot.requestedStartFrame; frame < stopFrame && slot.state === 'recording'; frame += 1) {
        this.recordFrame(slot, this.readPreRoll(frame, 0, slot.trackIndex, slot.bounceSourceMask), this.readPreRoll(frame, 1, slot.trackIndex, slot.bounceSourceMask), frame);
      }
      if (slot.state === 'recording') this.completeCapture(slot, stopFrame - slot.requestedStartFrame);
      return;
    }
    if (slot.state === 'recording' && stopFrame <= this.preRollEndFrame) {
      this.completeCapture(slot, stopFrame - slot.requestedStartFrame);
    }
  }

  beginCapture(slot, inputChannelCount) {
    if (slot.state !== 'pending') return false;
    // Both worklet ports are configured stereo. Mono devices are upmixed by
    // the Web Audio connection before reaching this fixed two-channel tap.
    slot.channelCount = 2;
    const byteFrameLimit = Math.floor(slot.maxRecordingBytes / BYTES_PER_SAMPLE / slot.channelCount);
    slot.maxFrames = slot.requestedMaxRecordingFrames === null
      ? byteFrameLimit : Math.min(byteFrameLimit, slot.requestedMaxRecordingFrames);
    slot.state = 'recording';
    return true;
  }

  noteDroppedFrame(slot) {
    slot.droppedFrames += 1;
    if (!slot.overflowActive) {
      slot.overflowEvents += 1;
      slot.overflowActive = true;
    }
  }

  recordFrame(slot, left, right, frame) {
    if (!Number.isSafeInteger(frame) || frame !== slot.requestedStartFrame + slot.captureFramesProcessed) {
      this.postError(slot, slot.sessionId, 'capture-frame-discontinuity', slot.requestedStartFrame, slot.stopFrame);
      this.abortCapture(slot, 'capture-frame-discontinuity', false);
      return;
    }
    slot.captureFramesProcessed += 1;
    if (slot.stoppedForOverflow) {
      this.noteDroppedFrame(slot);
      return;
    }
    if (slot.framesCaptured >= slot.maxFrames) {
      slot.limitReached = true;
      slot.stoppedForOverflow = true;
      this.noteDroppedFrame(slot);
      return;
    }
    if (slot.activeChunkIndex < 0) {
      for (let index = 0; index < slot.chunkBuffers.length; index += 1) {
        const candidate = slot.chunkBuffers[index];
        if (candidate && candidate[0] instanceof Float32Array
          && (slot.channelCount === 1 || candidate[1] instanceof Float32Array)) {
          slot.activeChunkIndex = index;
          slot.activeChunkOffset = 0;
          break;
        }
      }
      if (slot.activeChunkIndex < 0) {
        slot.stoppedForOverflow = true;
        this.noteDroppedFrame(slot);
        return;
      }
    }
    const chunkChannels = slot.chunkBuffers[slot.activeChunkIndex];
    if (!chunkChannels || !(chunkChannels[0] instanceof Float32Array)
      || (slot.channelCount > 1 && !(chunkChannels[1] instanceof Float32Array))) {
      slot.activeChunkIndex = -1;
      slot.activeChunkOffset = 0;
      slot.stoppedForOverflow = true;
      this.noteDroppedFrame(slot);
      return;
    }
    chunkChannels[0][slot.activeChunkOffset] = left;
    if (slot.channelCount > 1) chunkChannels[1][slot.activeChunkOffset] = right;
    slot.activeChunkOffset += 1;
    slot.framesCaptured += 1;
    slot.overflowActive = false;
    if (!slot.startAckSent) {
      const message = slot.configMessage;
      message.sessionId = slot.sessionId;
      message.inputGeneration = slot.inputGeneration;
      message.channelCount = slot.channelCount;
      message.requestedStartFrame = slot.requestedStartFrame;
      message.captureStartFrame = frame;
      message.maxRecordingFrames = slot.maxFrames;
      message.maxRecordingBytes = slot.maxRecordingBytes;
      message.startReceivedFrame = slot.startReceivedFrame;
      message.requestAgeAtStartFrames = slot.startReceivedFrame - slot.requestedStartFrame;
      message.preRollCapacityFrames = this.preRollFrames;
      message.preRollValidFrames = this.preRollValidFrames;
      this.port.postMessage(message);
      slot.startAckSent = true;
    }
    if (slot.activeChunkOffset === this.chunkSize) this.sendChunk(slot, this.chunkSize);
  }

  sendChunk(slot, validFrames) {
    const chunkIndex = slot.activeChunkIndex;
    const channels = slot.chunkBuffers[chunkIndex];
    if (!channels || validFrames <= 0) return;
    const channelCount = slot.channelCount;
    const startFrame = slot.requestedStartFrame + slot.chunksSent * this.chunkSize;
    slot.chunkBuffers[chunkIndex] = null;
    const message = slot.chunkMessage;
    message.sessionId = slot.sessionId;
    message.inputGeneration = slot.inputGeneration;
    message.chunkIndex = chunkIndex;
    message.sequence = slot.chunksSent;
    message.validFrames = validFrames;
    message.channelCount = channelCount;
    message.samples = channels[0];
    message.startFrame = startFrame;
    if (channelCount > 1) message.channels = channels;
    else {
      const oneChannel = slot.monoChannelMessages[chunkIndex];
      oneChannel[0] = channels[0];
      message.channels = oneChannel;
    }
    const transfers = slot.chunkTransferList;
    transfers[0] = channels[0].buffer;
    transfers.length = channelCount;
    if (channelCount > 1) transfers[1] = channels[1].buffer;
    this.port.postMessage(message, transfers);
    slot.chunksSent += 1;
    slot.activeChunkIndex = -1;
    slot.activeChunkOffset = 0;
  }

  recycleChunk(slot, message) {
    const index = message.chunkIndex;
    if (message.sessionId !== slot.sessionId || message.inputGeneration !== slot.inputGeneration
      || !Number.isInteger(index)
      || index < 0 || index >= slot.chunkBuffers.length || !Array.isArray(message.channels)
      || slot.chunkBuffers[index] !== null) return;
    const left = message.channels[0];
    const right = message.channels[1];
    if (!(left instanceof Float32Array) || left.length !== this.chunkSize) return;
    if (right !== undefined && (!(right instanceof Float32Array) || right.length !== this.chunkSize)) return;
    if (right instanceof Float32Array) {
      slot.chunkBuffers[index] = message.channels;
    } else {
      const pair = slot.monoReturnPairs[index];
      pair[0] = left;
      pair[1] = slot.monoRightBuffers[index];
      slot.chunkBuffers[index] = pair;
    }
    if (slot.poolLeasePending && this.poolAvailable(slot)) {
      slot.poolLeasePending = false;
      slot.state = 'idle';
      this.postCapturePoolReleased(slot);
    }
  }

  poolAvailable(slot) {
    for (let index = 0; index < slot.chunkBuffers.length; index += 1) {
      const channels = slot.chunkBuffers[index];
      if (!channels || !(channels[0] instanceof Float32Array) || channels[0].length !== this.chunkSize) return false;
    }
    return true;
  }

  readPreRoll(frame, channel, trackIndex, bounceSourceMask = 0) {
    const index = frame % this.preRollFrames;
    const processed = (this.preRollGateMask[index] & (1 << trackIndex)) !== 0;
    let value = processed
      ? (channel === 0 ? this.preRollLeft[index] : this.preRollRight[index])
      : (channel === 0 ? this.preRollRawLeft[index] : this.preRollRawRight[index]);
    for (let source = 0; source < this.trackCount; source += 1) {
      if (bounceSourceMask & (1 << source)) value += channel === 0
        ? this.preRollBounceLeft[source][index] : this.preRollBounceRight[source][index];
    }
    return value;
  }

  backfillPending(slot, frameStart, inputChannelCount) {
    if (slot.state !== 'pending' || slot.requestedStartFrame > frameStart) return;
    const oldestFrame = this.preRollEndFrame - this.preRollValidFrames;
    if (slot.requestedStartFrame < oldestFrame) {
      this.postError(slot, slot.sessionId, 'request-frame-outside-preroll', slot.requestedStartFrame);
      this.abortCapture(slot, 'request-frame-outside-preroll', false);
      return;
    }
    if (this.preRollEndFrame !== frameStart && slot.requestedStartFrame < frameStart) {
      this.postError(slot, slot.sessionId, 'input-frame-discontinuity', slot.requestedStartFrame);
      this.abortCapture(slot, 'input-frame-discontinuity', false);
      return;
    }
    const channelCount = this.preRollChannelCount || inputChannelCount;
    if (!channelCount || !this.beginCapture(slot, channelCount)) return;
    const backfillEnd = this.preRollEndFrame < frameStart ? this.preRollEndFrame : frameStart;
    for (let frame = slot.requestedStartFrame; frame < backfillEnd && slot.state === 'recording'; frame += 1) {
      this.recordFrame(slot, this.readPreRoll(frame, 0, slot.trackIndex, slot.bounceSourceMask), this.readPreRoll(frame, 1, slot.trackIndex, slot.bounceSourceMask), frame);
    }
  }

  abortCapture(slot, reason, postError = true) {
    if (slot.state !== 'armed' && slot.state !== 'pending' && slot.state !== 'recording') return;
    if (postError) this.postError(slot, slot.sessionId, reason, slot.requestedStartFrame, slot.stopFrame);
    slot.activeChunkIndex = -1;
    slot.activeChunkOffset = 0;
    const message = slot.abortedMessage;
    message.sessionId = slot.sessionId;
    message.inputGeneration = slot.inputGeneration;
    message.chunksSent = slot.chunksSent;
    this.port.postMessage(message);
    slot.poolLeasePending = !this.poolAvailable(slot);
    slot.state = slot.poolLeasePending ? 'aborting' : 'idle';
    if (slot.state === 'idle') this.postCapturePoolReleased(slot);
  }

  postCapturePoolReleased(slot) {
    if (slot.state !== 'idle' || !this.poolAvailable(slot)
      || !Number.isSafeInteger(slot.sessionId) || slot.sessionId <= 0
      || !Number.isSafeInteger(slot.inputGeneration)) return;
    const message = slot.poolReleasedMessage;
    message.sessionId = slot.sessionId;
    message.inputGeneration = slot.inputGeneration;
    this.port.postMessage(message);
  }

  completeCapture(slot, requestedFrames) {
    if (slot.state === 'pending' && requestedFrames > 0) return;
    if (slot.rhythmPhaseEpoch > 0 && (!this.rhythmPhaseEpochView
      || Atomics.load(this.rhythmPhaseEpochView, 0) !== slot.rhythmPhaseEpoch)) {
      const view = this.rhythmPhaseEpochView;
      const low = view ? Atomics.load(view, 2) >>> 0 : 0;
      const high = view ? Atomics.load(view, 3) >>> 0 : 0;
      this.postError(slot, slot.sessionId, 'rhythm-phase-epoch-mismatch', slot.requestedStartFrame, slot.stopFrame,
        slot.inputGeneration, slot.startReceivedFrame, false, {
          reasonCode: view ? Atomics.load(view, 1) : -1,
          frame: high * 0x1_0000_0000 + low,
        });
      this.abortCapture(slot, 'rhythm-phase-epoch-mismatch', false);
      return;
    }
    const frameLimit = Math.max(0, Math.floor(requestedFrames));
    const finalFrames = Math.min(slot.framesCaptured, frameLimit);
    if (slot.activeChunkIndex >= 0 && slot.activeChunkOffset > 0) {
      const sentFrames = slot.chunksSent * this.chunkSize;
      const finalPartialFrames = Math.min(slot.activeChunkOffset, Math.max(0, finalFrames - sentFrames));
      if (finalPartialFrames > 0) this.sendChunk(slot, finalPartialFrames);
      else {
        slot.activeChunkIndex = -1;
        slot.activeChunkOffset = 0;
      }
    }
    const complete = slot.completeMessage;
    complete.sessionId = slot.sessionId;
    complete.inputGeneration = slot.inputGeneration;
    complete.requestedStartFrame = slot.requestedStartFrame;
    complete.stopFrame = slot.stopFrame;
    complete.framesCaptured = finalFrames;
    complete.droppedFrames = slot.droppedFrames;
    complete.overflowEvents = slot.overflowEvents;
    complete.maxRecordingFrames = slot.maxFrames;
    complete.maxRecordingBytes = slot.maxRecordingBytes;
    complete.startReceivedFrame = slot.startReceivedFrame;
    complete.requestAgeAtStartFrames = slot.startReceivedFrame - slot.requestedStartFrame;
    complete.preRollCapacityFrames = this.preRollFrames;
    complete.preRollValidFrames = this.preRollValidFrames;
    complete.timelineOverlapEvents = slot.timelineOverlapEvents;
    complete.timelineOverlapFrames = slot.timelineOverlapFrames;
    complete.rhythmPhaseEpoch = slot.rhythmPhaseEpoch;
    complete.channelCount = slot.channelCount;
    complete.limitReached = slot.limitReached;
    complete.chunksSent = slot.chunksSent;
    complete.status = slot.droppedFrames > 0 || slot.limitReached ? 'incomplete' : 'complete';
    this.port.postMessage(complete);
    // A completed take can still have transferred chunks owned by the main
    // thread. Keep the slot unavailable until every exact-generation buffer
    // has returned, so a concurrent Clear can wait on the same release ACK as
    // an explicit abort.
    slot.poolLeasePending = !this.poolAvailable(slot);
    slot.state = 'idle';
    if (!slot.poolLeasePending) this.postCapturePoolReleased(slot);
  }

  storePreRoll(frame, rawLeft, rawRight, processedLeft, processedRight, inputs, offset) {
    const index = frame % this.preRollFrames;
    this.preRollRawLeft[index] = rawLeft;
    this.preRollRawRight[index] = rawRight;
    this.preRollLeft[index] = processedLeft;
    this.preRollRight[index] = processedRight;
    let mask = 0;
    for (let track = 0; track < this.trackCount; track += 1) {
      if (this.trackFxApplyEnabled[track] === 1) mask |= 1 << track;
    }
    this.preRollGateMask[index] = mask;
    for (let source = 0; source < this.trackCount; source += 1) {
      const channels = inputs[source + 2] || EMPTY_CHANNELS;
      const left = channels[0] || null;
      const right = channels[1] || left;
      this.preRollBounceLeft[source][index] = left && offset < left.length ? left[offset] : 0;
      this.preRollBounceRight[source][index] = right && offset < right.length ? right[offset] : 0;
    }
  }

  failActiveSessions(reason) {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (slot.state === 'armed' || slot.state === 'pending' || slot.state === 'recording') this.abortCapture(slot, reason);
    }
  }

  process(inputs, outputs) {
    const rawChannels = inputs[0] || EMPTY_CHANNELS;
    const processedChannels = inputs[1] || EMPTY_CHANNELS;
    const bounceChannels = inputs;
    const rawLeft = rawChannels[0] || null;
    const rawRight = rawChannels[1] || rawLeft;
    const processedLeft = processedChannels[0] || null;
    const processedRight = processedChannels[1] || processedLeft;
    const outputChannels = outputs[0] || EMPTY_CHANNELS;
    let frames = 0;
    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel];
      if (output && output.length > frames) frames = output.length;
      if (output) output.fill(0);
    }
    if (frames <= 0) return true;

    const frameStart = typeof currentFrame === 'number' && Number.isSafeInteger(currentFrame)
      ? currentFrame
      : this.fallbackCurrentFrame;
    const frameEnd = frameStart + frames;
    this.diagnosticFrameStart = frameStart;
    this.diagnosticFrameCount = frames;
    this.diagnosticPreviousFrameEnd = this.lastFrameEnd === null ? -1 : this.lastFrameEnd;
    this.diagnosticPreRollEndFrame = this.preRollEndFrame;
    const inputChannelCount = this.inputReady && rawLeft && processedLeft ? 2 : 0;
    if (inputChannelCount !== 2) {
      if (this.inputReady) this.failActiveSessions('input-frame-unavailable');
      this.invalidateCaptureReadiness('input-frame-unavailable', frameStart);
      this.resetPreRoll();
      this.preRollEndFrame = frameEnd;
      this.fallbackCurrentFrame = frameEnd;
      return true;
    }

    let firstNewOffset = 0;
    if (this.lastFrameEnd !== null && frameStart < this.lastFrameEnd) {
      // Some runtimes can repeat or partially overlap a previously processed
      // AudioWorklet quantum. Do not abort a take, replay those samples, or
      // rewind the pre-roll ring: only the unprocessed suffix is new input.
      // We cannot prove that a rewound frame contains identical source PCM,
      // so the overlap is counted and surfaced with the completed take.
      const overlapFrames = Math.min(frames, this.lastFrameEnd - frameStart);
      firstNewOffset = overlapFrames;
      for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
        const slot = this.slots[slotIndex];
        if (slot.state === 'pending' || slot.state === 'recording') {
          const relevantStart = Math.max(frameStart, slot.requestedStartFrame);
          const relevantEnd = Math.min(frameStart + overlapFrames,
            slot.stopRequested ? slot.stopFrame : frameStart + overlapFrames);
          if (relevantEnd > relevantStart) {
            slot.timelineOverlapEvents += 1;
            slot.timelineOverlapFrames += relevantEnd - relevantStart;
          }
        }
      }
      if (firstNewOffset >= frames) return true;
    } else if (this.lastFrameEnd !== null && frameStart > this.lastFrameEnd) {
      // A forward gap means samples were genuinely unavailable, so keep the
      // conservative failure behavior for captures whose requested interval
      // intersects the gap. A future pending capture has not started yet and
      // can remain scheduled; its requested samples are still available.
      for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
        const slot = this.slots[slotIndex];
        if (slot.state !== 'pending' && slot.state !== 'recording') continue;
        if (slot.state === 'pending' && slot.requestedStartFrame >= frameStart) continue;
        this.postError(slot, slot.sessionId, 'input-frame-discontinuity', slot.requestedStartFrame, slot.stopFrame);
        this.abortCapture(slot, 'input-frame-discontinuity', false);
      }
      this.invalidateCaptureReadiness('input-frame-discontinuity', frameStart);
      this.preRollValidFrames = 0;
      this.preRollEndFrame = frameStart;
      this.preRollChannelCount = 0;
    }
    if (this.preRollChannelCount && this.preRollChannelCount !== inputChannelCount) {
      this.failActiveSessions('input-channel-layout-changed');
      this.invalidateCaptureReadiness('input-channel-layout-changed', frameStart);
      this.preRollValidFrames = 0;
      this.preRollEndFrame = frameStart;
    }

    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
      this.backfillPending(this.slots[slotIndex], frameStart + firstNewOffset, inputChannelCount);
    }
    for (let offset = firstNewOffset; offset < frames; offset += 1) {
      const rawSampleLeft = offset < rawLeft.length ? rawLeft[offset] : 0;
      const rawSampleRight = rawRight && offset < rawRight.length ? rawRight[offset] : rawSampleLeft;
      const processedSampleLeft = offset < processedLeft.length ? processedLeft[offset] : 0;
      const processedSampleRight = processedRight && offset < processedRight.length ? processedRight[offset] : processedSampleLeft;
      const absoluteFrame = frameStart + offset;
      this.applyTrackFxApplyChanges(absoluteFrame);
      for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
        const slot = this.slots[slotIndex];
        // Detect against the raw input sample here, never a main-thread meter.
        // The triggering frame itself is captured; no pre-trigger audio is added.
        if (slot.state === 'armed' && absoluteFrame >= slot.requestedStartFrame
          && Math.max(Math.abs(rawSampleLeft), Math.abs(rawSampleRight)) > slot.autoRecThreshold) {
          slot.requestedStartFrame = absoluteFrame;
          slot.state = 'pending';
        }
        if (slot.state === 'pending' && absoluteFrame >= slot.requestedStartFrame) {
          this.beginCapture(slot, inputChannelCount);
        }
        if (slot.state === 'recording' && absoluteFrame >= slot.requestedStartFrame
          && (!slot.stopRequested || absoluteFrame < slot.stopFrame)) {
          const processed = this.trackFxApplyEnabled[slot.trackIndex] === 1;
          let inputLeft = processed ? processedSampleLeft : rawSampleLeft;
          let inputRight = processed ? processedSampleRight : rawSampleRight;
          for (let source = 0; source < this.trackCount; source += 1) {
            if (!(slot.bounceSourceMask & (1 << source))) continue;
            const channels = bounceChannels[source + 2] || EMPTY_CHANNELS;
            const sourceLeft = channels[0] || null;
            const sourceRight = channels[1] || sourceLeft;
            inputLeft += sourceLeft && offset < sourceLeft.length ? sourceLeft[offset] : 0;
            inputRight += sourceRight && offset < sourceRight.length ? sourceRight[offset] : 0;
          }
          this.recordFrame(slot, inputLeft, inputRight, absoluteFrame);
        }
      }
      this.storePreRoll(absoluteFrame, rawSampleLeft, rawSampleRight, processedSampleLeft, processedSampleRight, inputs, offset);
    }
    this.preRollEndFrame = frameEnd;
    this.preRollValidFrames = Math.min(this.preRollFrames, this.preRollValidFrames + frames - firstNewOffset);
    this.preRollChannelCount = inputChannelCount;
    this.lastFrameEnd = frameEnd;
    this.fallbackCurrentFrame = Math.max(this.fallbackCurrentFrame, frameEnd);
    this.publishCaptureReadiness(frameStart, frames);

    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
      const slot = this.slots[slotIndex];
      if (slot.stopRequested && (slot.state === 'pending' || slot.state === 'recording') && frameEnd >= slot.stopFrame) {
        if (slot.state === 'pending') {
          const oldestFrame = this.preRollEndFrame - this.preRollValidFrames;
          if (slot.requestedStartFrame < oldestFrame) {
            this.postError(slot, slot.sessionId, 'request-frame-outside-preroll', slot.requestedStartFrame, slot.stopFrame);
            this.abortCapture(slot, 'request-frame-outside-preroll', false);
          } else if (slot.stopFrame === slot.requestedStartFrame) {
            this.completeCapture(slot, 0);
          } else {
            this.beginCapture(slot, inputChannelCount);
            for (let frame = slot.requestedStartFrame; frame < slot.stopFrame && slot.state === 'recording'; frame += 1) {
              this.recordFrame(slot, this.readPreRoll(frame, 0, slot.trackIndex, slot.bounceSourceMask), this.readPreRoll(frame, 1, slot.trackIndex, slot.bounceSourceMask), frame);
            }
            if (slot.state === 'recording') this.completeCapture(slot, slot.stopFrame - slot.requestedStartFrame);
          }
        } else {
          this.completeCapture(slot, slot.stopFrame - slot.requestedStartFrame);
        }
      }
    }
    return true;
  }
}

registerProcessor('rc505-input-capture', BrowserInputCaptureProcessor);
