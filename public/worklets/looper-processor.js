import {
  TIME_STRETCH_WINDOW_FRAMES,
  TIME_STRETCH_HOP_FRAMES,
  createTimeStretchState,
  prepareTimeStretchHop,
  resetTimeStretchState,
  processTimeStretchFrame,
} from './time-stretch-core.js';

const TRACK_COUNT = 5;
let sharedDspLooperInstanceSequence = 0;
const FX_MIDI_RING_CAPACITY = 64;
const FX_MIDI_HEADER_WORDS = 8;
const FX_MIDI_SLOT_WORDS = 6;
const FX_MIDI_RING_VERSION = 1;
const FX_MIDI_RING_MAGIC = 0x46584d31;
const COMMAND_CAPACITY = 256;
const COMMAND_WORDS = 8;
const COMMAND_WORD_OFFSET = 24;
const COMMAND_READ = 0;
const COMMAND_WRITE = 1;
const RENDER_FRAME_SEQUENCE = 2;
const RENDER_FRAME_LOW = 3;
const RENDER_FRAME_HIGH = 4;
const UNDERRUNS = 5;
const LAST_ACK_SEQUENCE = 6;
const LAST_ACK_FRAME_SEQUENCE = 7;
const LAST_ACK_FRAME_LOW = 8;
const LAST_ACK_FRAME_HIGH = 9;
const OUTPUT_MONITOR_ENABLED = 10;
const BPM_WORD = 11;
const RHYTHM_RUNNING = 12;
const RHYTHM_PATTERN = 13;
const COMMAND_OVERRUNS = 14;
const DEADLINE_MISSES = 15;
const LAST_QUANTUM_FRAMES = 16;
const MASTER_ORIGIN_LOW = 17;
const MASTER_ORIGIN_HIGH = 18;
const TRACK_CAPACITY_OVERRUNS = 19;
const DEADLINE_METRIC_AVAILABLE = 20;
const INPUT_DROPOUT_BLOCKS = 21;
const INPUT_DROPOUT_FRAMES = 22;
const TRACK_STATES_WORD_OFFSET = 24 + COMMAND_CAPACITY * COMMAND_WORDS;
const TRACK_POSITIONS_WORD_OFFSET = TRACK_STATES_WORD_OFFSET + TRACK_COUNT;
const TRACK_META_WORDS = 32;
const LAYOUT_VERSION = 4;
const TRACK_CHANNEL_COUNT = 2;
const LAYOUT_MONO = 0;
const LAYOUT_PLANAR_LR = 1;
const STORAGE_BLOCK_FRAMES = 16384;
const MAX_SEGMENTS_PER_TAKE = 4096;
const MAX_HISTORY_TAKES = 32;
const PITCH_COMPOSITE_CACHE_FRAMES = 4096;
const TRACK_STATE = 0;
const LOOP_FRAMES = 1;
const RECORDING_FRAMES = 2;
const PLAY_POSITION = 3;
const CAPACITY_FRAMES = 4;
const RECORD_START_LOW = 5;
const RECORD_START_HIGH = 6;
const REVERSE = 7;
const ALIGNMENT_SAMPLES = 8;
const CHANNEL_COUNT = 9;
const STORAGE_LAYOUT_VERSION = 10;
const STORAGE_LAYOUT = 11;
const HISTORY_CURSOR = 12;
const HISTORY_LENGTH = 13;
const MARK_CURSOR = 14;
const MARK_POSITION = 15;
const MARK_STATE = 16;
const TAKE_MODE = 17;
const SPEED_Q16 = 18;
const PLAYBACK_FLAGS = 19;
const STOP_MODE = 20;
const START_MODE = 21;
const FADE_IN_FRAMES = 22;
const FADE_OUT_FRAMES = 23;
const AUTO_REC_THRESHOLD_Q15 = 24;
const AUTO_REC_DEBOUNCE_FRAMES = 25;
const ACTIVE_TAKE_SLOT = 26;
const PENDING_STOP_MODE = 27;
const RECORD_BPM = 28;
const TEMPO_SYNC_FACTOR_Q16 = 30;
const TEMPO_SYNC_FLAGS = 31;

const OPCODE_START_RECORD = 1;
const OPCODE_STOP_RECORD = 2;
const OPCODE_PLAY = 3;
const OPCODE_STOP = 4;
const OPCODE_START_OVERDUB = 5;
const OPCODE_STOP_OVERDUB = 6;
const OPCODE_CLEAR = 7;
const OPCODE_SET_REVERSE = 8;
const OPCODE_SET_MONITOR = 9;
const OPCODE_SET_RHYTHM = 10;
const OPCODE_SET_BPM = 11;
const OPCODE_SET_CLOCK = 12;
const OPCODE_EXPORT_TRACK = 13;
const OPCODE_SET_ALIGNMENT = 14;
const OPCODE_CANCEL_PENDING = 15;
const OPCODE_UNDO = 16;
const OPCODE_REDO = 17;
const OPCODE_MARK = 18;
const OPCODE_RESTORE_MARK = 19;
const OPCODE_RESET_BACK = 20;
const OPCODE_SET_SPEED = 21;
const OPCODE_SET_ONE_SHOT = 22;
const OPCODE_SET_STOP_MODE = 23;
const OPCODE_SET_FADE = 24;
const OPCODE_SET_AUTO_REC = 25;
const OPCODE_SET_DUB_MODE = 26;
const OPCODE_SET_START_MODE = 27;
const OPCODE_SET_RECORD_BPM = 28;
const OPCODE_LOAD_TRACK = 29;
const OPCODE_CLEAR_MARK = 30;
const OPCODE_SYNC_EXTERNAL_CLOCK = 31;
const OPCODE_SET_TEMPO_SYNC = 32;
const OPCODE_SET_MASTER_CLOCK_EPOCH = 33;

const STATUS_OK = 0;
const STATUS_LATE = 1;
const STATUS_MISSING_TRACK_STORAGE = 2;
const STATUS_INVALID_STATE = 4;
const STATUS_COMMAND_OVERFLOW = 5;
const STATUS_CANCELLED = 6;
const STATUS_INVALID_TRACK = 7;
const STATUS_NO_UNDO = 8;
const STATUS_NO_REDO = 9;
const STATUS_LOAD_INVALID = 12;
const STATUS_INVALID_SETTINGS = 14;
const STATUS_TIMELINE_DISCONTINUITY = 15;
const STATE_EMPTY = 0;
const STATE_REC_STANDBY = 1;
const STATE_RECORDING = 2;
const STATE_REC_FINISHING = 3;
const STATE_PLAYING = 4;
const STATE_OVERDUBBING = 5;
const STATE_STOPPED = 6;
const STATE_REPLACING = 7;

const TRACK_META_BYTES = 128;
const FRAME_WORD_MODULUS = 0x100000000;
const TWO_PI = Math.PI * 2;
// Web Audio currently emits 128-frame blocks in common browsers, but the
// Worklet always prepares more than that and passes each observed block size
// through unchanged. A larger fixed ceiling keeps unusual render quanta from
// silently falling back to an unfiltered path.
const SHARED_DSP_MAX_BLOCK_FRAMES = 4096;
const TIMELINE_EVENT_CAPACITY = 64;
const TIMELINE_AUTORECOVERY_MAX_GAP_FRAMES = 4096;
const SHARED_DSP_PROCESS_FAILURES = 23;
const SHARED_DSP_MAX_MANAGED_BYTES = 48 * 1024 * 1024;
const SHARED_DSP_FAILURE_KIND = Object.freeze({
  stereoProcess: 0,
  filterReset: 1,
  inputOversize: 2,
  rhythmFrame: 3,
  rhythmProcess: 4,
  rhythmCommand: 5,
});
const SHARED_DSP_FILTER_CONTROLS = Object.freeze({
  lowpass: 2,
  highpass: 3,
  bandpass: 4,
  peaking: 5,
  lowShelf: 14,
  highShelf: 15,
});
// Spread the five per-track FFT jobs across separate 128-frame callbacks.
// This changes only when the next hop is prepared, never source/playback phase.
const PITCH_PREFETCH_FRACTIONS = [0.2, 0.4, 0.6, 0.8, 0.98];

class BrowserLooperProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sharedDspProcessorInstanceId = ++sharedDspLooperInstanceSequence;

    const controlBuffer = options.processorOptions && options.processorOptions.controlBuffer;
    if (!(controlBuffer instanceof SharedArrayBuffer)) {
      this.control = null;
      this.port.postMessage({ type: 'BOOT_ERROR', message: 'A shared realtime control buffer is required.' });
      return;
    }

    this.control = new Int32Array(controlBuffer);
    const fxTransitionBuffer = options.processorOptions && options.processorOptions.fxTransitionBuffer;
    this.fxTransitionControl = fxTransitionBuffer instanceof SharedArrayBuffer &&
      fxTransitionBuffer.byteLength >= Int32Array.BYTES_PER_ELEMENT * 2
      ? new Int32Array(fxTransitionBuffer) : null;
    this.fxTransitionIndex = 0;
    this.clockEpochWordView = new DataView(new ArrayBuffer(8));
    this.perTrackInputs = Boolean(options.processorOptions && options.processorOptions.perTrackInputs === true);
    this.timelineSilenceLeft = new Float32Array(SHARED_DSP_MAX_BLOCK_FRAMES);
    this.timelineSilenceRight = new Float32Array(SHARED_DSP_MAX_BLOCK_FRAMES);
    this.timelineSilenceBus = [this.timelineSilenceLeft, this.timelineSilenceRight];
    this.timelineSilenceInputs = this.perTrackInputs
      ? [this.timelineSilenceBus, this.timelineSilenceBus, this.timelineSilenceBus,
        this.timelineSilenceBus, this.timelineSilenceBus, this.timelineSilenceBus]
      : [this.timelineSilenceBus];
    this.timelineGapOutputs = Array.from({ length: 7 }, () => [
      new Float32Array(SHARED_DSP_MAX_BLOCK_FRAMES),
      new Float32Array(SHARED_DSP_MAX_BLOCK_FRAMES),
    ]);
    this.timelineReplayOutputs = Array.from({ length: 7 }, () => [
      new Float32Array(SHARED_DSP_MAX_BLOCK_FRAMES),
      new Float32Array(SHARED_DSP_MAX_BLOCK_FRAMES),
    ]);
    this.timelineLastOutputFrames = 0;
    this.timelineHasSuccessfulBlock = false;
    this.timelineLastBlockStartFrame = -1;
    this.timelineLastBlockFrames = 0;
    this.timelineExpectedFrame = -1;
    this.timelineLastActualFrame = -1;
    this.timelineLastStatus = 0;
    this.timelineEventLog = new Float64Array(TIMELINE_EVENT_CAPACITY * 4);
    this.timelineEventCount = 0;
    this.timelineDuplicateCallbacks = 0;
    this.timelineForwardGapCount = 0;
    this.timelineForwardGapFrames = 0;
    this.timelineFailureCount = 0;
    this.timelineLastQuantumFrames = 0;
    this.timelineRecoveryActive = false;
    this.timelineRecoveryNeeded = false;
    this.timelineRecoveryStartExpectedFrame = -1;
    this.timelineRecoveryStartActualFrame = -1;
    this.timelineRecoveryCount = 0;
    this.timelineRecoveryCompleteCount = 0;
    this.timelineRecoveryCatchupFrames = 0;
    this.timelineUnrecoveredGapFrames = 0;
    this.timelineDroppedOutputCallbacks = 0;
    this.timelineDroppedOutputFrames = 0;
    this.timelineDroppedInputCallbacks = 0;
    this.timelineDroppedInputFrames = 0;
    this.timelineUniqueAdvancedFrames = 0;
    this.timelineUniqueOutputFrames = 0;
    this.timelineOutputEndFrame = -1;
    this.timelineXrunCount = 0;
    this.timelineExplicitRecoveryCount = 0;
    this.timelineExplicitRecoverySkippedFrames = 0;
    this.timelineDiscontinuityEpoch = 0;
    this.timelineBackwardDiscontinuityCount = 0;
    this.timelineBackwardResetCount = 0;
    this.timelineRecoveryNeededLastObservedEndFrame = -1;
    this.timelineLastDroppedBlockStartFrame = -1;
    this.timelineLastDroppedBlockFrames = 0;
    this.pendingTimelineRecoveryRequestId = 0;
    this.controlPositions = new Float32Array(controlBuffer, (TRACK_POSITIONS_WORD_OFFSET) * Int32Array.BYTES_PER_ELEMENT, TRACK_COUNT);
    this.deadlineMetricAvailable = typeof performance !== 'undefined' && typeof performance.now === 'function';
    Atomics.store(this.control, DEADLINE_METRIC_AVAILABLE, this.deadlineMetricAvailable ? 1 : 0);
    this.trackMeta = new Array(TRACK_COUNT).fill(null);
    this.trackDataLeft = new Array(TRACK_COUNT).fill(null);
    this.trackDataRight = new Array(TRACK_COUNT).fill(null);
    this.primaryLeft = new Array(TRACK_COUNT).fill(null);
    this.primaryRight = new Array(TRACK_COUNT).fill(null);
    this.takeLeft = new Array(TRACK_COUNT);
    this.takeRight = new Array(TRACK_COUNT);
    this.takeMask = new Array(TRACK_COUNT);
    this.takeMeta = new Array(TRACK_COUNT);
    this.compactionStage = new Array(TRACK_COUNT);
    this.takeSegmentCounts = new Int16Array(TRACK_COUNT * MAX_HISTORY_TAKES);
    this.takeModes = new Int8Array(TRACK_COUNT * MAX_HISTORY_TAKES);
    this.takeFrames = new Int32Array(TRACK_COUNT * MAX_HISTORY_TAKES);
    this.takeLowWaterPending = new Uint8Array(TRACK_COUNT * MAX_HISTORY_TAKES);
    this.takeActive = new Uint8Array(TRACK_COUNT * MAX_HISTORY_TAKES);
    this.historyBaseSlots = new Int8Array(TRACK_COUNT);
    this.historyBaseSlots.fill(-1);
    this.validatedPrimarySegmentCounts = new Int16Array(TRACK_COUNT);
    this.playPositions = new Float64Array(TRACK_COUNT);
    this.playbackFrames = new Float64Array(TRACK_COUNT);
    this.oneShotRemaining = new Int32Array(TRACK_COUNT);
    this.compositeIntegerScratch = new Float64Array(TRACK_COUNT * 4);
    this.compositeSampleLeft = new Float64Array(TRACK_COUNT);
    this.compositeSampleRight = new Float64Array(TRACK_COUNT);
    this.pitchTimeStretch = new Array(TRACK_COUNT);
    this.pitchReadLeft = new Array(TRACK_COUNT);
    this.pitchReadRight = new Array(TRACK_COUNT);
    this.pitchVisibleTakes = new Int16Array(TRACK_COUNT);
    this.pitchReaderCacheValid = new Uint8Array(TRACK_COUNT);
    this.pitchReaderCacheFrames = new Float64Array(TRACK_COUNT);
    this.pitchReaderCacheVisibleTakes = new Int16Array(TRACK_COUNT);
    this.pitchReaderCacheLoopFrames = new Int32Array(TRACK_COUNT);
    this.pitchCompositeCacheLeft = new Float32Array(TRACK_COUNT * PITCH_COMPOSITE_CACHE_FRAMES);
    this.pitchCompositeCacheRight = new Float32Array(TRACK_COUNT * PITCH_COMPOSITE_CACHE_FRAMES);
    this.pitchCompositeCacheFrameKeys = new Uint32Array(TRACK_COUNT * PITCH_COMPOSITE_CACHE_FRAMES);
    this.pitchCompositeCacheGenerations = new Uint32Array(TRACK_COUNT * PITCH_COMPOSITE_CACHE_FRAMES);
    this.pitchCompositeCacheGeneration = new Uint32Array(TRACK_COUNT);
    this.pitchCompositeCacheVisibleTakes = new Int16Array(TRACK_COUNT);
    this.pitchCompositeCacheLoopFrames = new Int32Array(TRACK_COUNT);
    this.pitchCompositeCacheGeneration.fill(1);
    this.pitchPrefetchThresholds = new Int16Array(TRACK_COUNT);
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      this.pitchTimeStretch[track] = createTimeStretchState(
        TIME_STRETCH_WINDOW_FRAMES,
        TIME_STRETCH_HOP_FRAMES,
      );
      this.pitchReadLeft[track] = (sourceFrame) => this.readPitchSample(track, sourceFrame, 0);
      this.pitchReadRight[track] = (sourceFrame) => this.readPitchSample(track, sourceFrame, 1);
      this.pitchPrefetchThresholds[track] = Math.max(
        1,
        Math.min(TIME_STRETCH_HOP_FRAMES - 1, Math.round(TIME_STRETCH_HOP_FRAMES * PITCH_PREFETCH_FRACTIONS[track])),
      );
    }
    this.autoRecCounters = new Int32Array(TRACK_COUNT);
    this.autoRecEnvelopes = new Float32Array(TRACK_COUNT);
    this.autoRecAttackCoefficient = Math.exp(-1 / Math.max(1, sampleRate * 0.001));
    this.autoRecReleaseCoefficient = Math.exp(-1 / Math.max(1, sampleRate * 0.008));
    this.fadeInRemaining = new Int32Array(TRACK_COUNT);
    this.fadeOutRemaining = new Int32Array(TRACK_COUNT);
    this.fadeOutInitial = new Int32Array(TRACK_COUNT);
    this.storageFailure = new Uint8Array(TRACK_COUNT * MAX_HISTORY_TAKES);
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      this.takeLeft[track] = new Array(MAX_HISTORY_TAKES);
      this.takeRight[track] = new Array(MAX_HISTORY_TAKES);
      this.takeMask[track] = new Array(MAX_HISTORY_TAKES);
      this.takeMeta[track] = new Array(MAX_HISTORY_TAKES).fill(null);
      this.compactionStage[track] = {
        expectedCursor: -1,
        prefixEnd: -1,
        frameCount: 0,
        segmentCount: 0,
        firstMeta: null,
        left: [],
        right: [],
        mask: [],
      };
      for (let slot = 0; slot < MAX_HISTORY_TAKES; slot += 1) {
        this.takeLeft[track][slot] = new Array(MAX_SEGMENTS_PER_TAKE).fill(null);
        this.takeRight[track][slot] = new Array(MAX_SEGMENTS_PER_TAKE).fill(null);
        this.takeMask[track][slot] = new Array(MAX_SEGMENTS_PER_TAKE).fill(null);
      }
    }
    this.steadyTrackMeta = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackDataLeft = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackDataRight = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackLeft = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackRight = new Array(TRACK_COUNT).fill(null);
    this.steadyTrackLengths = new Int32Array(TRACK_COUNT);
    this.steadyTrackPositions = new Int32Array(TRACK_COUNT);
    this.steadyTrackSteps = new Int8Array(TRACK_COUNT);
    this.notifiedTrackStates = new Int8Array(TRACK_COUNT);
    this.notifiedTrackStates.fill(-1);
    this.pendingCommands = new Int32Array(COMMAND_CAPACITY * COMMAND_WORDS);
    this.pendingCommandCount = 0;
    this.quantumFrames = 0;
    this.bpm = Math.max(40, Math.min(300, Atomics.load(this.control, BPM_WORD) || 120));
    this.outputMonitorEnabled = Atomics.load(this.control, OUTPUT_MONITOR_ENABLED) !== 0;

    this.rhythmRunning = Atomics.load(this.control, RHYTHM_RUNNING) !== 0;
    this.rhythmPattern = Math.max(0, Math.min(2, Atomics.load(this.control, RHYTHM_PATTERN)));
    this.rhythmUsesCustomPattern = false;
    this.rhythmUsesCleanRoom = false;
    this.cleanRoomRhythmStarted = false;
    this.rhythmPatternSteps = 16;
    this.rhythmStepsPerBeat = 4;
    this.rhythmPatternVelocities = new Float32Array(3 * 64);
    this.rhythmPatternVelocities[0] = 1;
    this.rhythmPatternVelocities[6] = 1;
    this.rhythmPatternVelocities[8] = 1;
    this.rhythmPatternVelocities[64 + 4] = 1;
    this.rhythmPatternVelocities[64 + 12] = 1;
    for (let step = 0; step < 16; step += 2) this.rhythmPatternVelocities[128 + step] = 0.7;
    this.rhythmPatternStaging = new Float32Array(3 * 64);
    this.rhythmKitParameters = new Float32Array([150, 46, 0, 0.85, 180, 33, 0.75, 0.25, 7000, 8, 1, 0]);
    this.rhythmKitStaging = new Float32Array(12);
    this.rhythmDecayCoefficients = new Float32Array(3);
    this.refreshRhythmDecayCoefficients(this.rhythmKitParameters);
    this.rhythmPatternStagingSteps = 16;
    this.rhythmPatternStagingStepsPerBeat = 4;
    this.pendingRhythmRequestId = 0;
    this.pendingRhythmPattern = false;
    this.pendingRhythmKit = false;
    this.rhythmNextStepFrame = -1;
    this.rhythmStep = 0;
    this.rhythmStepOrdinal = 0;
    this.rhythmOriginFrame = 0;
    this.kickPhase = 0;
    this.kickEnvelope = 0;
    this.kickFrequency = 150;
    this.snareEnvelope = 0;
    this.snareTonePhase = 0;
    this.hihatEnvelope = 0;
    this.hihatTonePhase = 0;
    this.noiseState = 0x51f15e;
    this.snareFilterState = 0;
    this.hihatFilterState = 0;

    this.sharedDsp = null;
    this.sharedTrackFxSendEnabled = new Uint8Array(TRACK_COUNT);
    const initialTrackFxSendMask = options.processorOptions && options.processorOptions.trackFxSendMask;
    if (initialTrackFxSendMask && typeof initialTrackFxSendMask.length === 'number') {
      for (let track = 0; track < TRACK_COUNT; track += 1) {
        this.sharedTrackFxSendEnabled[track] = initialTrackFxSendMask[track] ? 1 : 0;
      }
    }
    this.processCallbackCount = 0;
    this.processFrameCount = 0;
    this.rhythmProcessStatusCounts = new Uint32Array(16);
    this.rhythmProcessLastStatus = 0;
    this.rhythmProcessFirstFailureFrame = -1;
    this.rhythmProcessLastFailureFrame = -1;
    this.rhythmCallLastEndFrame = -1;
    this.rhythmCallDiscontinuityCount = 0;
    this.rhythmCallExpectedFrame = -1;
    this.rhythmCallActualFrame = -1;
    const sharedDspModule = options.processorOptions && options.processorOptions.sharedDspModule;
    if (sharedDspModule) {
      try {
        this.prepareSharedDspGraph(sharedDspModule,
          options.processorOptions.sharedDspMaxBlockFrames ?? SHARED_DSP_MAX_BLOCK_FRAMES,
          options.processorOptions);
      } catch (error) {
        this.disposeSharedDspGraph();
        this.port.postMessage({ type: 'SHARED_DSP_BOOT_ERROR', message: String(error && error.message || error) });
      }
    }

    this.clockRunning = false;
    this.clockOriginFrame = 0;
    this.clockBeatOrdinal = 0;
    this.clockNextBeatFrame = -1;

    this.calibrationMeta = null;
    this.calibrationData = null;
    this.calibrationStartFrame = 0;
    this.calibrationWriteIndex = 0;
    this.calibrationFrames = 0;
    this.calibrationActive = false;

    this.port.onmessage = (event) => this.handlePortMessage(event.data);
  }

  handlePortMessage(message) {
    if (!message || !this.control) return;

    if (message.type === 'SHARED_DSP_CONFIGURE_FILTER') {
      this.configureSharedDspFilter(message);
      return;
    }
    if (message.type === 'SHARED_DSP_FX_BANK_STAGE') {
      this.stageSharedDspFxBankPlan(message);
      return;
    }
    if (message.type === 'SHARED_DSP_FX_BANK_COMMIT') {
      this.commitSharedDspFxBankPlan(message);
      return;
    }
    if (message.type === 'SHARED_DSP_FX_BANK_ROLLBACK') {
      this.rollbackSharedDspFxBankPlan(message);
      return;
    }
    if (message.type === 'SHARED_DSP_FX_BANK_FINALIZE') {
      this.finalizeSharedDspFxBankPlan(message);
      return;
    }
    if (message.type === 'SHARED_DSP_FX_BANK_ABORT') {
      this.abortSharedDspFxBankPlan(message);
      return;
    }
    if (message.type === 'SHARED_DSP_TRACK_FX_SEND') {
      const track = Number(message.track);
      const enabled = message.enabled;
      const ok = Number.isInteger(track) && track >= 0 && track < TRACK_COUNT && typeof enabled === 'boolean';
      if (ok) {
        this.sharedTrackFxSendEnabled[track] = enabled ? 1 : 0;
        const route = this.sharedDsp && this.sharedDsp.fxTrackRoutes[track];
        if (route) this.setSharedDspFxWetTarget(route, enabled && route.handles.length > 0 ? 1 : 0);
      }
      this.port.postMessage({ type: 'SHARED_DSP_TRACK_FX_SEND_ACK', requestId: message.requestId,
        ok, track, enabled: ok ? enabled : false, message: ok ? undefined : 'Track FX send settings are malformed.' });
      return;
    }
    if (message.type === 'SHARED_DSP_CLEAR_FILTER') {
      this.clearSharedDspFilter(message);
      return;
    }
    if (message.type === 'SHARED_DSP_DISPOSE') {
      this.disposeSharedDspGraph();
      this.port.postMessage({ type: 'SHARED_DSP_DISPOSED' });
      return;
    }
    if (message.type === 'SHARED_DSP_FAILURE_DIAGNOSTICS') {
      const dsp = this.sharedDsp;
      this.port.postMessage({
        type: 'SHARED_DSP_FAILURE_DIAGNOSTICS_REPLY',
        requestId: Number(message.requestId) >>> 0,
        failureCounts: dsp && dsp.failureCounts ? Array.from(dsp.failureCounts) : [0, 0, 0, 0, 0, 0],
        aggregateCount: this.control ? Atomics.load(this.control, SHARED_DSP_PROCESS_FAILURES) : 0,
        processCallbackCount: this.processCallbackCount,
        processFrameCount: this.processFrameCount,
        rhythmProcessStatusCounts: Array.from(this.rhythmProcessStatusCounts),
        rhythmProcessLastStatus: this.rhythmProcessLastStatus,
        rhythmProcessFirstFailureFrame: this.rhythmProcessFirstFailureFrame,
        rhythmProcessLastFailureFrame: this.rhythmProcessLastFailureFrame,
        rhythmCallDiscontinuityCount: this.rhythmCallDiscontinuityCount,
        rhythmCallExpectedFrame: this.rhythmCallExpectedFrame,
        rhythmCallActualFrame: this.rhythmCallActualFrame,
        timelineDuplicateCallbacks: this.timelineDuplicateCallbacks,
        timelineForwardGapCount: this.timelineForwardGapCount,
        timelineForwardGapFrames: this.timelineForwardGapFrames,
        timelineFailureCount: this.timelineFailureCount,
        timelineRecoveryActive: this.timelineRecoveryActive,
        timelineRecoveryNeeded: this.timelineRecoveryNeeded,
        timelineRecoveryStartExpectedFrame: this.timelineRecoveryStartExpectedFrame,
        timelineRecoveryStartActualFrame: this.timelineRecoveryStartActualFrame,
        timelineRecoveryCount: this.timelineRecoveryCount,
        timelineRecoveryCompleteCount: this.timelineRecoveryCompleteCount,
        timelineRecoveryCatchupFrames: this.timelineRecoveryCatchupFrames,
        timelineUnrecoveredGapFrames: this.timelineUnrecoveredGapFrames,
        timelineDroppedOutputCallbacks: this.timelineDroppedOutputCallbacks,
        timelineDroppedOutputFrames: this.timelineDroppedOutputFrames,
        timelineDroppedInputCallbacks: this.timelineDroppedInputCallbacks,
        timelineDroppedInputFrames: this.timelineDroppedInputFrames,
        timelineUniqueAdvancedFrames: this.timelineUniqueAdvancedFrames,
        timelineUniqueOutputFrames: this.timelineUniqueOutputFrames,
        timelineOutputEndFrame: this.timelineOutputEndFrame,
        timelineXrunCount: this.timelineXrunCount,
        timelineExplicitRecoveryCount: this.timelineExplicitRecoveryCount,
        timelineExplicitRecoverySkippedFrames: this.timelineExplicitRecoverySkippedFrames,
        timelineDiscontinuityEpoch: this.timelineDiscontinuityEpoch,
        timelineBackwardDiscontinuityCount: this.timelineBackwardDiscontinuityCount,
        timelineBackwardResetCount: this.timelineBackwardResetCount,
        timelineExpectedFrame: this.timelineExpectedFrame,
        timelineLastActualFrame: this.timelineLastActualFrame,
        timelineLastStatus: this.timelineLastStatus,
        timelineEventCount: this.timelineEventCount,
        timelineEvents: this.timelineEventSnapshot(),
      });
      return;
    }
    if (message.type === 'TIMELINE_RECOVERY_REQUEST') {
      const requestId = Number(message.requestId) >>> 0;
      if (requestId !== 0) this.pendingTimelineRecoveryRequestId = requestId;
      return;
    }

    if (message.type === 'LOAD_RHYTHM_BUILTIN') {
      this.selectCleanRoomRhythm(message);
      return;
    }

    if (message.type === 'LOAD_RHYTHM_PATTERN' || message.type === 'LOAD_RHYTHM_KIT' ||
        message.type === 'LOAD_RHYTHM_SNAPSHOT') {
      this.stageRhythmUpdate(message);
      return;
    }

    if (message.type === 'ATTACH_TRACK') {
      const track = message.track | 0;
      const buffer = message.buffer;
      if (track < 0 || track >= TRACK_COUNT) return;
      const rejectAttach = (reason) => this.port.postMessage({
        type: 'TRACK_ATTACH_ERROR',
        track,
        message: reason,
        channelCount: message.channelCount ?? null,
        layoutVersion: message.layoutVersion ?? null,
        storageLayout: message.storageLayout ?? null,
      });
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < TRACK_META_BYTES) {
        rejectAttach('Track storage is not a valid shared buffer with a complete metadata header.');
        return;
      }
      const meta = new Int32Array(buffer, 0, TRACK_META_WORDS);
      const capacity = Atomics.load(meta, CAPACITY_FRAMES);
      const channelCount = Atomics.load(meta, CHANNEL_COUNT);
      const layoutVersion = Atomics.load(meta, STORAGE_LAYOUT_VERSION);
      const storageLayout = Atomics.load(meta, STORAGE_LAYOUT);
      const expectedBytes = TRACK_META_BYTES + capacity * TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT;
      if (channelCount !== TRACK_CHANNEL_COUNT || layoutVersion !== LAYOUT_VERSION || storageLayout !== LAYOUT_PLANAR_LR ||
          capacity !== STORAGE_BLOCK_FRAMES || buffer.byteLength !== expectedBytes ||
          message.channelCount !== TRACK_CHANNEL_COUNT || message.layoutVersion !== LAYOUT_VERSION ||
          message.storageLayout !== LAYOUT_PLANAR_LR) {
        rejectAttach(`Track layout mismatch: requires ${TRACK_CHANNEL_COUNT}-channel planar LR storage v${LAYOUT_VERSION}.`);
        return;
      }
      this.trackMeta[track] = meta;
      this.trackDataLeft[track] = new Float32Array(buffer, TRACK_META_BYTES, capacity);
      this.trackDataRight[track] = new Float32Array(
        buffer,
        TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT,
        capacity,
      );
      this.primaryLeft[track] = this.trackDataLeft[track];
      this.primaryRight[track] = this.trackDataRight[track];
      this.takeLeft[track][0][0] = this.trackDataLeft[track];
      this.takeRight[track][0][0] = this.trackDataRight[track];
      this.takeMeta[track][0] = meta;
      this.takeSegmentCounts[this.takeIndex(track, 0)] = 1;
      this.validatedPrimarySegmentCounts[track] = 0;
      meta[MARK_CURSOR] = -1;
      meta[SPEED_Q16] = 65536;
      meta[AUTO_REC_THRESHOLD_Q15] = 327;
      meta[AUTO_REC_DEBOUNCE_FRAMES] = Math.round(sampleRate * 0.02);
      meta[TEMPO_SYNC_FACTOR_Q16] = 65536;
      meta[TEMPO_SYNC_FLAGS] = 0;
      this.port.postMessage({
        type: 'TRACK_ATTACHED',
        track,
        channelCount,
        layoutVersion,
        storageLayout,
      });
      return;
    }

    if (message.type === 'PREPARE_TAKE') {
      const track = Number(message.track);
      const slot = Number(message.takeSlot);
      const meta = this.trackMeta[track];
      if (!Number.isInteger(track) || track < 0 || track >= TRACK_COUNT || !meta ||
          !Number.isInteger(slot) || slot < 0 || slot >= MAX_HISTORY_TAKES ||
          meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_OVERDUBBING ||
          meta[TRACK_STATE] === STATE_REPLACING || slot !== meta[HISTORY_CURSOR]) {
        this.port.postMessage({ type: 'TAKE_PREPARE_ERROR', track, message: 'Take slot/state does not match the committed history cursor.' });
        return;
      }
      const usePrimary = message.usePrimary === true;
      if (usePrimary && (slot !== 0 || meta[HISTORY_LENGTH] !== 0 || this.primaryLeft[track] === null)) {
        this.port.postMessage({ type: 'TAKE_PREPARE_ERROR', track, message: 'Primary storage cannot be reused for this history state.' });
        return;
      }
      if (!usePrimary) this.clearTakeSlotsFrom(track, slot);
      const index = this.takeIndex(track, slot);
      this.takeModes[index] = this.modeCode(message.mode);
      this.takeFrames[index] = 0;
      this.takeActive[index] = 1;
      this.takeLowWaterPending[index] = 0;
      this.storageFailure[index] = 0;
      if (usePrimary) {
        this.takeModes[index] = 0;
        this.takeSegmentCounts[index] = Math.max(1, this.takeSegmentCounts[index]);
        this.takeMeta[track][slot] = meta;
      }
      meta[ACTIVE_TAKE_SLOT] = slot;
      meta[TAKE_MODE] = this.modeCode(message.mode);
      meta[CAPACITY_FRAMES] = this.takeSegmentCounts[index] * STORAGE_BLOCK_FRAMES;
      this.port.postMessage({ type: 'TAKE_PREPARED', track, takeSlot: slot, mode: this.takeModes[index] });
      return;
    }

    if (message.type === 'ATTACH_HISTORY_COMPACTION_SEGMENTS') {
      this.attachHistoryCompactionSegments(message);
      return;
    }

    if (message.type === 'ABORT_HISTORY_COMPACTION') {
      this.abortHistoryCompaction(message);
      return;
    }

    if (message.type === 'COMPACT_HISTORY') {
      this.compactHistoryFromMessage(message);
      return;
    }

    if (message.type === 'ATTACH_TAKE_SEGMENT') {
      const track = Number(message.track);
      const slot = Number(message.takeSlot);
      const segmentIndex = Number(message.segmentIndex);
      const buffer = message.buffer;
      const rejectSegment = (reason) => this.port.postMessage({
        type: 'TAKE_SEGMENT_ERROR', track, takeSlot: slot, segmentIndex, message: reason,
      });
      if (!Number.isInteger(track) || track < 0 || track >= TRACK_COUNT || !this.trackMeta[track] ||
          !Number.isInteger(slot) || slot < 0 || slot >= MAX_HISTORY_TAKES ||
          !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= MAX_SEGMENTS_PER_TAKE ||
          !(buffer instanceof SharedArrayBuffer) || buffer.byteLength < TRACK_META_BYTES) {
        rejectSegment('Take segment identity or shared storage is invalid.');
        return;
      }
      const meta = new Int32Array(buffer, 0, TRACK_META_WORDS);
      const capacity = Atomics.load(meta, CAPACITY_FRAMES);
      const sampleBytes = capacity * TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT;
      const index = this.takeIndex(track, slot);
      if (capacity !== STORAGE_BLOCK_FRAMES || Atomics.load(meta, CHANNEL_COUNT) !== TRACK_CHANNEL_COUNT ||
          Atomics.load(meta, STORAGE_LAYOUT_VERSION) !== LAYOUT_VERSION || Atomics.load(meta, STORAGE_LAYOUT) !== LAYOUT_PLANAR_LR ||
          buffer.byteLength !== TRACK_META_BYTES + sampleBytes + capacity ||
          segmentIndex > this.takeSegmentCounts[index]) {
        rejectSegment('Take segment must be planar-LR layout v4 with a bounded replace mask.');
        return;
      }
      this.takeLeft[track][slot][segmentIndex] = new Float32Array(buffer, TRACK_META_BYTES, capacity);
      this.takeRight[track][slot][segmentIndex] = new Float32Array(
        buffer,
        TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT,
        capacity,
      );
      this.takeMask[track][slot][segmentIndex] = new Uint8Array(buffer, TRACK_META_BYTES + sampleBytes, capacity);
      if (slot === 0) this.validatedPrimarySegmentCounts[track] = 0;
      if (segmentIndex === 0) this.takeMeta[track][slot] = meta;
      this.takeSegmentCounts[index] = Math.max(this.takeSegmentCounts[index], segmentIndex + 1);
      const trackMeta = this.trackMeta[track];
      if (trackMeta[ACTIVE_TAKE_SLOT] === slot) {
        trackMeta[CAPACITY_FRAMES] = this.takeSegmentCounts[index] * STORAGE_BLOCK_FRAMES;
      }
      this.port.postMessage({ type: 'TAKE_SEGMENT_ATTACHED', track, takeSlot: slot, segmentIndex, capacityFrames: this.takeSegmentCounts[index] * STORAGE_BLOCK_FRAMES });
      return;
    }

    if (message.type === 'STORAGE_GROWTH_COMPLETE') {
      const track = Number(message.track);
      const slot = Number(message.takeSlot);
      if (track >= 0 && track < TRACK_COUNT && slot >= 0 && slot < MAX_HISTORY_TAKES) {
        this.takeLowWaterPending[this.takeIndex(track, slot)] = 0;
      }
      return;
    }

    if (message.type === 'STORAGE_GROWTH_FAILED') {
      const track = Number(message.track);
      const slot = Number(message.takeSlot);
      if (track >= 0 && track < TRACK_COUNT && slot >= 0 && slot < MAX_HISTORY_TAKES) {
        this.storageFailure[this.takeIndex(track, slot)] = 1;
      }
      return;
    }

    if (message.type === 'RELEASE_TRACK_HISTORY') {
      const track = Number(message.track);
      if (track >= 0 && track < TRACK_COUNT && this.trackMeta[track]) {
        this.resetTrackHistoryStorage(track);
        this.port.postMessage({ type: 'TRACK_HISTORY_RELEASED', track });
      }
      return;
    }

    if (message.type === 'ARM_LOOPBACK') {
      const buffer = message.buffer;
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < TRACK_META_BYTES) {
        this.port.postMessage({ type: 'LOOPBACK_ARM_ERROR', message: 'Loopback storage is not a valid shared buffer.' });
        return;
      }
      const meta = new Int32Array(buffer, 0, TRACK_META_WORDS);
      const capacity = Atomics.load(meta, CAPACITY_FRAMES);
      const requestedFrames = Number(message.frames);
      if (Atomics.load(meta, CHANNEL_COUNT) !== 1 || Atomics.load(meta, STORAGE_LAYOUT_VERSION) !== LAYOUT_VERSION ||
          Atomics.load(meta, STORAGE_LAYOUT) !== LAYOUT_MONO ||
          buffer.byteLength !== TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT ||
          !Number.isInteger(requestedFrames) || requestedFrames <= 0 || requestedFrames > capacity) {
        this.port.postMessage({ type: 'LOOPBACK_ARM_ERROR', message: 'Loopback storage must use the versioned mono layout.' });
        return;
      }
      this.calibrationMeta = meta;
      this.calibrationData = new Float32Array(buffer, TRACK_META_BYTES, capacity);
      this.calibrationStartFrame = Number(message.startFrame) || 0;
      this.calibrationFrames = requestedFrames;
      this.calibrationWriteIndex = 0;
      this.calibrationActive = this.calibrationFrames > 0;
      Atomics.store(meta, RECORDING_FRAMES, 0);
      Atomics.store(meta, LOOP_FRAMES, 0);
      this.port.postMessage({ type: 'LOOPBACK_ARMED', frames: requestedFrames });
    }
  }

  prepareSharedDspGraph(wasmModule, maxBlockFrames, processorOptions = {}) {
    if (!(wasmModule instanceof WebAssembly.Module)) throw new Error('Shared DSP setup requires a compiled WebAssembly.Module.');
    if (!Number.isInteger(maxBlockFrames) || maxBlockFrames < 1 || maxBlockFrames > SHARED_DSP_MAX_BLOCK_FRAMES) {
      throw new RangeError('Shared DSP maximum block size is outside the prepared Worklet bound.');
    }

    const fxHistoryFrames = Math.max(maxBlockFrames, Math.ceil(sampleRate * 0.1));
    const fxMidiBuffer = processorOptions.fxMidiBuffer;
    if (!(fxMidiBuffer instanceof SharedArrayBuffer) ||
        fxMidiBuffer.byteLength !== (FX_MIDI_HEADER_WORDS + FX_MIDI_RING_CAPACITY * FX_MIDI_SLOT_WORDS) * 4) {
      throw new Error('Shared DSP MIDI transport must be a prepared fixed-capacity SharedArrayBuffer.');
    }
    const fxMidiHeader = new Int32Array(fxMidiBuffer, 0, FX_MIDI_HEADER_WORDS);
    if (Atomics.load(fxMidiHeader, 6) !== FX_MIDI_RING_VERSION || Atomics.load(fxMidiHeader, 7) !== FX_MIDI_RING_MAGIC) {
      throw new Error('Shared DSP MIDI transport header is invalid.');
    }
    const fxCarrierControlBuffer = processorOptions.fxCarrierControl;
    if (!(fxCarrierControlBuffer instanceof SharedArrayBuffer) || fxCarrierControlBuffer.byteLength !== 4) {
      throw new Error('Shared DSP carrier control must be a prepared SharedArrayBuffer.');
    }
    const candidate = {
      wasm: null,
      memory: null,
      fxContextApiVersion: 0,
      fxMidiBuffer,
      fxMidiHeader,
      fxMidiView: new DataView(fxMidiBuffer),
      fxCarrierControl: new Int32Array(fxCarrierControlBuffer),
      fxMidiEventsAddress: 0,
      fxMidiEventsView: null,
      fxCurrentMidiEventCount: 0,
      fxCurrentCarrierChannels: 0,
      fxCarrierLeftAddress: 0,
      fxCarrierRightAddress: 0,
      fxCarrierLeft: null,
      fxCarrierRight: null,
      maxBlockFrames,
      fxHistoryFrames,
      fxCarrierHistoryLeft: new Float32Array(fxHistoryFrames),
      fxCarrierHistoryRight: new Float32Array(fxHistoryFrames),
      fxCarrierHistoryWrite: 0,
      fxCarrierHistoryCount: 0,
      handles: [],
      routes: new Array(12),
      recordRoutes: new Array(TRACK_COUNT),
      playbackRoutes: new Array(TRACK_COUNT),
      monitorRoute: null,
      rhythmRoute: null,
      filteredInputLeft: new Array(TRACK_COUNT),
      filteredInputRight: new Array(TRACK_COUNT),
      filteredInputReady: new Uint8Array(TRACK_COUNT),
      outputStageLeft: new Float32Array(maxBlockFrames),
      outputStageRight: new Float32Array(maxBlockFrames),
      scratchToken: 0,
      scratchAddress: 0,
      scratchInput: null,
      scratchOutput: null,
      configureValues: null,
      configureAddress: 0,
      configureParameterIds: null,
      configureParameterValues: null,
      configureParameterIdsAddress: 0,
      configureParameterValuesAddress: 0,
      startupWarmupOut: null,
      rhythmHandle: 0,
      fxScratchToken: 0,
      fxScratchAddress: 0,
      fxScratchLeftA: null,
      fxScratchRightA: null,
      fxScratchLeftB: null,
      fxScratchRightB: null,
      fxScratchLeftAAddress: 0,
      fxScratchRightAAddress: 0,
      fxScratchLeftBAddress: 0,
      fxScratchRightBAddress: 0,
      fxTransitionSourceLeft: new Float32Array(maxBlockFrames),
      fxTransitionSourceRight: new Float32Array(maxBlockFrames),
      fxTransitionOldLeft: new Float32Array(maxBlockFrames),
      fxTransitionOldRight: new Float32Array(maxBlockFrames),
      fxWarmSilenceLeft: new Float32Array(maxBlockFrames),
      fxWarmSilenceRight: new Float32Array(maxBlockFrames),
      fxTransitionFrames: 0,
      fxTransitionElapsed: 0,
      fxInputRoutes: Array.from({ length: TRACK_COUNT }, () => this.createSharedDspFxRoute([], fxHistoryFrames)),
      fxInputMonitorRoute: this.createSharedDspFxRoute([], fxHistoryFrames),
      fxTrackRoutes: Array.from({ length: TRACK_COUNT }, () => this.createSharedDspFxRoute([], fxHistoryFrames)),
      fxActiveHandles: [],
      fxStaged: null,
      fxWarming: null,
      fxRetired: null,
      fxStageSerial: 0,
      lastFinalizedFxStageId: 0,
      failureCounts: new Uint32Array(6),
      wasiCalls: { fd_close: 0, fd_write: 0, fd_seek: 0 },
      disposed: false,
    };
    this.sharedDsp = candidate;
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      candidate.filteredInputLeft[track] = new Float32Array(maxBlockFrames);
      candidate.filteredInputRight[track] = new Float32Array(maxBlockFrames);
    }

    const io = candidate.wasiCalls;
    const instance = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: {
      fd_close() { io.fd_close += 1; return 8; },
      fd_write() { io.fd_write += 1; return 8; },
      fd_seek() { io.fd_seek += 1; return 8; },
    } });
    candidate.wasm = instance.exports;
    const wasm = candidate.wasm;
    if (typeof wasm._initialize === 'function') wasm._initialize();
    candidate.memory = wasm.memory;
    if (!(candidate.memory instanceof WebAssembly.Memory) || candidate.memory.buffer.byteLength !== 64 * 1024 * 1024 ||
        wasm.webrc_dsp_abi_version() !== 2 || wasm.webrc_dsp_extended_api_version() !== 1 ||
        wasm.webrc_dsp_capabilities() !== 7 ||
        typeof wasm.webrc_dsp_fx_api_version !== 'function' || wasm.webrc_dsp_fx_api_version() !== 1 ||
        typeof wasm.webrc_dsp_fx_create_v2_api_version !== 'function' || wasm.webrc_dsp_fx_create_v2_api_version() !== 2 ||
        typeof wasm.webrc_dsp_fx_profile_setup_api_version !== 'function' || wasm.webrc_dsp_fx_profile_setup_api_version() !== 1 ||
        typeof wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters !== 'function' ||
        wasm.webrc_dsp_fx_catalog_size() !== 53) {
      throw new Error('Shared DSP module memory or ABI does not match the pinned Browser contract.');
    }
    candidate.fxContextApiVersion = typeof wasm.webrc_dsp_fx_context_api_version === 'function'
      ? wasm.webrc_dsp_fx_context_api_version() : 0;
    if ((candidate.fxContextApiVersion !== 0 && candidate.fxContextApiVersion !== 1) ||
        (candidate.fxContextApiVersion === 1 && typeof wasm.webrc_dsp_fx_process_stereo_context_v1 !== 'function')) {
      throw new Error('Shared DSP typed-context exports do not match their declared version.');
    }

    const scratchFrames = maxBlockFrames * 2 + 12 + 128 + 128;
    candidate.scratchToken = wasm.webrc_dsp_alloc_f32_token(scratchFrames);
    if (!candidate.scratchToken) throw new Error('Shared DSP could not reserve its bounded transfer scratch.');
    candidate.scratchAddress = wasm.webrc_dsp_transfer_address(candidate.scratchToken);
    if (!candidate.scratchAddress || candidate.scratchAddress % Float32Array.BYTES_PER_ELEMENT !== 0 ||
        candidate.scratchAddress + scratchFrames * Float32Array.BYTES_PER_ELEMENT > candidate.memory.buffer.byteLength) {
      throw new Error('Shared DSP transfer scratch is outside linear memory.');
    }
    candidate.scratchInput = new Float32Array(candidate.memory.buffer, candidate.scratchAddress, maxBlockFrames);
    candidate.scratchOutput = new Float32Array(candidate.memory.buffer,
      candidate.scratchAddress + maxBlockFrames * Float32Array.BYTES_PER_ELEMENT, maxBlockFrames);
    candidate.configureAddress = candidate.scratchAddress + maxBlockFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
    candidate.configureValues = new Float32Array(candidate.memory.buffer, candidate.configureAddress, 4);
    candidate.startupWarmupOut = new Uint32Array(candidate.memory.buffer, candidate.configureAddress, 1);
    candidate.configureParameterValuesAddress = candidate.configureAddress + 12 * Float32Array.BYTES_PER_ELEMENT;
    candidate.configureParameterIdsAddress = candidate.configureParameterValuesAddress + 64 * Float32Array.BYTES_PER_ELEMENT;
    candidate.configureParameterValues = new Float32Array(candidate.memory.buffer,
      candidate.configureParameterValuesAddress, 64);
    candidate.configureParameterIds = new Uint32Array(candidate.memory.buffer,
      candidate.configureParameterIdsAddress, 64);
    candidate.fxMidiEventsAddress = candidate.configureParameterIdsAddress + 64 * Float32Array.BYTES_PER_ELEMENT;
    candidate.fxMidiEventsView = new DataView(candidate.memory.buffer, candidate.fxMidiEventsAddress, 64 * 8);

    candidate.fxScratchToken = wasm.webrc_dsp_alloc_f32_token(maxBlockFrames * 6);
    if (!candidate.fxScratchToken) throw new Error('Shared DSP could not reserve bounded FX-chain scratch.');
    candidate.fxScratchAddress = wasm.webrc_dsp_transfer_address(candidate.fxScratchToken);
    const fxScratchBytes = maxBlockFrames * Float32Array.BYTES_PER_ELEMENT;
    if (!candidate.fxScratchAddress || candidate.fxScratchAddress % Float32Array.BYTES_PER_ELEMENT !== 0 ||
        candidate.fxScratchAddress + fxScratchBytes * 6 > candidate.memory.buffer.byteLength) {
      throw new Error('Shared DSP FX-chain scratch is outside linear memory.');
    }
    candidate.fxScratchLeftAAddress = candidate.fxScratchAddress;
    candidate.fxScratchRightAAddress = candidate.fxScratchAddress + fxScratchBytes;
    candidate.fxScratchLeftBAddress = candidate.fxScratchAddress + fxScratchBytes * 2;
    candidate.fxScratchRightBAddress = candidate.fxScratchAddress + fxScratchBytes * 3;
    candidate.fxScratchLeftA = new Float32Array(candidate.memory.buffer, candidate.fxScratchLeftAAddress, maxBlockFrames);
    candidate.fxScratchRightA = new Float32Array(candidate.memory.buffer, candidate.fxScratchRightAAddress, maxBlockFrames);
    candidate.fxScratchLeftB = new Float32Array(candidate.memory.buffer, candidate.fxScratchLeftBAddress, maxBlockFrames);
    candidate.fxScratchRightB = new Float32Array(candidate.memory.buffer, candidate.fxScratchRightBAddress, maxBlockFrames);
    candidate.fxCarrierLeftAddress = candidate.fxScratchAddress + fxScratchBytes * 4;
    candidate.fxCarrierRightAddress = candidate.fxScratchAddress + fxScratchBytes * 5;
    candidate.fxCarrierLeft = new Float32Array(candidate.memory.buffer, candidate.fxCarrierLeftAddress, maxBlockFrames);
    candidate.fxCarrierRight = new Float32Array(candidate.memory.buffer, candidate.fxCarrierRightAddress, maxBlockFrames);

    const addRoute = (index, routeName, track) => {
      const left = wasm.webrc_dsp_create(2, sampleRate, maxBlockFrames, 1, 0);
      if (!left) throw new Error(`Shared DSP ${routeName} left filter create failed (${wasm.webrc_dsp_last_create_status()}).`);
      candidate.handles.push(left);
      const right = wasm.webrc_dsp_create(2, sampleRate, maxBlockFrames, 1, 0);
      if (!right) throw new Error(`Shared DSP ${routeName} right filter create failed (${wasm.webrc_dsp_last_create_status()}).`);
      candidate.handles.push(right);
      const state = {
        index, route: routeName, track, left, right, enabled: false, filter: null, valueCount: 0,
        values: new Float32Array(4), wetGain: 0, wetTarget: 0, wetStep: 0,
        wetRampRemaining: 0, pendingReset: false,
      };
      candidate.routes[index] = state;
      if (routeName === 'recordInput') candidate.recordRoutes[track] = state;
      else if (routeName === 'trackLoopOutput') candidate.playbackRoutes[track] = state;
      else if (routeName === 'monitor') candidate.monitorRoute = state;
      else candidate.rhythmRoute = state;
    };
    for (let track = 0; track < TRACK_COUNT; track += 1) addRoute(track, 'recordInput', track);
    for (let track = 0; track < TRACK_COUNT; track += 1) addRoute(TRACK_COUNT + track, 'trackLoopOutput', track);
    addRoute(10, 'monitor', -1);
    addRoute(11, 'rhythm', -1);

    candidate.configureValues.set([0, 0, 120]);
    candidate.rhythmHandle = wasm.webrc_dsp_extended_create(
      121, sampleRate, maxBlockFrames, 2, candidate.configureAddress, 3, 0n,
    );
    if (!candidate.rhythmHandle) {
      throw new Error(`Shared DSP clean-room rhythm create failed (${wasm.webrc_dsp_extended_last_create_status()}).`);
    }
    candidate.handles.push(candidate.rhythmHandle);
    if (wasm.webrc_dsp_extended_rhythm_pattern_count() !== 240 ||
        wasm.webrc_dsp_extended_rhythm_kit_count() !== 16) {
      throw new Error('Shared DSP clean-room table counts do not match the Browser host contract.');
    }

    if (candidate.wasiCalls.fd_close !== 0 || candidate.wasiCalls.fd_write !== 0 || candidate.wasiCalls.fd_seek !== 0) {
      throw new Error('Shared DSP setup unexpectedly attempted WASI I/O.');
    }
    const managedBytes = wasm.webrc_dsp_managed_memory_bytes();
    if (managedBytes > SHARED_DSP_MAX_MANAGED_BYTES || candidate.memory.buffer.byteLength !== 64 * 1024 * 1024) {
      throw new Error(`Shared DSP setup exceeds its bounded module budget (${managedBytes} bytes).`);
    }
    const availableFxCatalog = [];
    const fxInfoView = new DataView(candidate.memory.buffer, candidate.configureAddress, 28);
    const fxMemoryBytes = new Uint8Array(candidate.memory.buffer);
    const readFxString = (pointer) => {
      if (!Number.isInteger(pointer) || pointer <= 0 || pointer >= fxMemoryBytes.length) return '';
      let end = pointer;
      const endLimit = Math.min(fxMemoryBytes.length, pointer + 512);
      while (end < endLimit && fxMemoryBytes[end] !== 0) end += 1;
      let value = '';
      for (let index = pointer; index < end; index += 1) {
        const code = fxMemoryBytes[index];
        if (code > 0x7f) return '';
        value += String.fromCharCode(code);
      }
      return value;
    };
    for (let ordinal = 1; ordinal <= 53; ordinal += 1) {
      if (wasm.webrc_dsp_fx_is_processor_available(ordinal) !== 1) continue;
      const parameterCount = wasm.webrc_dsp_fx_parameter_count(ordinal);
      const entry = {
        ordinal,
        id: readFxString(wasm.webrc_dsp_fx_id_pointer(ordinal)),
        displayName: readFxString(wasm.webrc_dsp_fx_name_pointer(ordinal)),
        family: readFxString(wasm.webrc_dsp_fx_family_pointer(ordinal)),
        officialParametersValidated: wasm.webrc_dsp_fx_official_parameters_validated(ordinal) === 1,
        parameters: [],
      };
      for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex += 1) {
        if (wasm.webrc_dsp_fx_parameter_info(ordinal, parameterIndex, candidate.configureAddress) !== 0) {
          throw new Error(`Shared DSP FX descriptor ${ordinal}:${parameterIndex} is unreadable.`);
        }
        entry.parameters.push({
          id: fxInfoView.getUint32(0, true),
          minimum: fxInfoView.getFloat32(4, true),
          maximum: fxInfoView.getFloat32(8, true),
          defaultValue: fxInfoView.getFloat32(12, true),
          name: readFxString(fxInfoView.getUint32(16, true)),
          unit: readFxString(fxInfoView.getUint32(20, true)),
          origin: fxInfoView.getUint32(24, true),
        });
      }
      availableFxCatalog.push(entry);
    }
    this.port.postMessage({
      type: 'SHARED_DSP_READY', abiVersion: 2, maxBlockFrames,
      processorInstanceId: this.sharedDspProcessorInstanceId,
      managedBytes, memoryBytes: candidate.memory.buffer.byteLength,
      routes: 12, availableFxCatalog,
    });
  }

  stageSharedDspFxBankPlan(message) {
    const dsp = this.sharedDsp;
    const wasm = dsp && dsp.wasm;
    const plan = message.plan;
    let error = '';
    if (!dsp || dsp.disposed || !wasm) error = 'Shared DSP FX registry is unavailable.';
    else if (dsp.fxStaged || dsp.fxWarming || dsp.fxRetired) error = 'A shared DSP FX candidate is already staged, warming, or awaiting finalization.';
    else if (!plan || !Array.isArray(plan.input) || !Array.isArray(plan.track) || !Array.isArray(plan.output) ||
        plan.input.length > 4 || plan.track.length > 4 || plan.output.length > 4) {
      error = 'Shared DSP FX bank plan must contain at most four slots per route.';
    }
    const candidate = { stageId: 0, handles: [], inputRoutes: [], inputMonitorRoute: this.createSharedDspFxRoute([], dsp.fxHistoryFrames), trackRoutes: [], warmupFrames: 0, warmedFrames: 0, failed: false };
    const createChain = (units, routeName, initialTarget) => {
      const chain = [];
      const ordinals = [];
      const midiCapable = [];
      let warmupFrames = 0;
      for (let slot = 0; !error && slot < units.length; slot += 1) {
        const unit = units[slot];
        if (!unit || !Number.isInteger(unit.ordinal) || unit.ordinal < 1 || unit.ordinal > 53 ||
            wasm.webrc_dsp_fx_is_processor_available(unit.ordinal) !== 1 ||
            !Array.isArray(unit.parameters) || unit.parameters.length > 64) {
          error = `Shared DSP ${routeName} slot ${slot} is unavailable or malformed.`;
          break;
        }
        if (unit.ordinal === 20 && Atomics.load(dsp.fxCarrierControl, 0) !== 1) {
          error = 'VOCODER requires an explicitly selected independent stereo carrier source.';
          break;
        }
        if ((unit.ordinal === 19 || unit.ordinal === 20 || unit.ordinal === 21) && dsp.fxContextApiVersion !== 1) {
          error = `Shared DSP ordinal ${unit.ordinal} requires typed carrier/MIDI context API v1.`;
          break;
        }
        for (let parameterIndex = 0; parameterIndex < unit.parameters.length; parameterIndex += 1) {
          const parameter = unit.parameters[parameterIndex];
          if (!parameter || !Number.isInteger(parameter.id) || parameter.id < 0 ||
              !Number.isFinite(parameter.value) || !Number.isFinite(Math.fround(parameter.value))) {
            error = `Shared DSP ${routeName} ordinal ${unit.ordinal} parameter is invalid.`;
            break;
          }
          dsp.configureParameterIds[parameterIndex] = parameter.id;
          dsp.configureParameterValues[parameterIndex] = Math.fround(parameter.value);
        }
        if (error) break;
        const handle = wasm.webrc_dsp_fx_create_v2(unit.ordinal, sampleRate, dsp.maxBlockFrames, 2,
          dsp.configureParameterIdsAddress, dsp.configureParameterValuesAddress, unit.parameters.length);
        if (!handle) {
          error = `Shared DSP ${routeName} ordinal ${unit.ordinal} could not be prepared (${wasm.webrc_dsp_fx_last_create_status()}).`;
          break;
        }
        chain.push(handle);
        ordinals.push(unit.ordinal);
        const modeParameter = unit.ordinal === 19
          ? unit.parameters.find((parameter) => parameter.id === 107)
          : null;
        const modeValue = modeParameter ? modeParameter.value : 2;
        // Harmony Auto's mode 2 is not MIDI driven. Missing mode metadata uses
        // the registry default (mode 2), so do not broadcast MIDI to it.
        midiCapable.push(unit.ordinal === 21 || (unit.ordinal === 19 &&
          Number.isFinite(modeValue) && modeValue < 1.5));
        candidate.handles.push(handle);
        const latencyModel = wasm.webrc_dsp_fx_latency_model(handle);
        const fixedLatencyFrames = wasm.webrc_dsp_fx_fixed_latency_samples(handle);
        if (!Number.isInteger(latencyModel) || latencyModel < 0 || latencyModel > 2 ||
            (latencyModel === 0 && (!Number.isInteger(fixedLatencyFrames) || fixedLatencyFrames < 0))) {
          error = `Shared DSP ${routeName} ordinal ${unit.ordinal} reported an invalid latency contract.`;
          break;
        }
        const upperBoundStatus = wasm.webrc_dsp_fx_startup_warmup_upper_bound_samples_for_parameters(
          unit.ordinal, sampleRate, dsp.maxBlockFrames, 2,
          dsp.configureParameterIdsAddress, dsp.configureParameterValuesAddress,
          unit.parameters.length, dsp.startupWarmupOut.byteOffset);
        if (upperBoundStatus !== 0) {
          error = `Shared DSP ${routeName} ordinal ${unit.ordinal} has no supported startup warmup bound (${upperBoundStatus}).`;
          break;
        }
        const startupFrames = wasm.webrc_dsp_fx_startup_warmup_frames(handle);
        const startupUpperBound = dsp.startupWarmupOut[0];
        if (!Number.isInteger(startupFrames) || startupFrames < 0 || startupFrames > startupUpperBound) {
          error = `Shared DSP ${routeName} ordinal ${unit.ordinal} startup warmup exceeds its declared upper bound.`;
          break;
        }
        warmupFrames += startupFrames;
      }
      const route = this.createSharedDspFxRoute(chain, dsp.fxHistoryFrames, warmupFrames, ordinals, midiCapable);
      route.wetTarget = initialTarget > 0 ? 1 : 0;
      route.wetGain = route.wetTarget;
      route.wetStep = 0;
      route.wetRampRemaining = 0;
      route.prewarming = true;
      candidate.warmupFrames = Math.max(candidate.warmupFrames, warmupFrames);
      return route;
    };
    if (!error) {
      for (let track = 0; track < TRACK_COUNT && !error; track += 1) {
        candidate.inputRoutes[track] = createChain(plan.input, `input ${track + 1}`, plan.input.length > 0 ? 1 : 0);
      }
      if (!error) candidate.inputMonitorRoute = createChain(plan.input, 'monitor input', plan.input.length > 0 ? 1 : 0);
      for (let track = 0; track < TRACK_COUNT && !error; track += 1) {
        const enabled = this.sharedTrackFxSendEnabled[track] !== 0;
        candidate.trackRoutes[track] = createChain(plan.track, `track ${track + 1}`, enabled && plan.track.length > 0 ? 1 : 0);
      }
    }
    if (!error && (wasm.webrc_dsp_managed_memory_bytes() > SHARED_DSP_MAX_MANAGED_BYTES ||
        dsp.memory.buffer.byteLength !== 64 * 1024 * 1024)) error = 'Shared DSP FX candidate exceeds its bounded module budget.';
    if (error) {
      if (wasm) for (let index = candidate.handles.length - 1; index >= 0; index -= 1) wasm.webrc_dsp_fx_destroy(candidate.handles[index]);
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_STAGED', requestId: message.requestId, ok: false, message: error });
      return;
    }
    let stageId = (dsp.fxStageSerial + 1) >>> 0;
    if (stageId === 0) stageId = 1;
    dsp.fxStageSerial = stageId;
    candidate.stageId = stageId;
    dsp.fxStaged = candidate;
    this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_STAGED', requestId: message.requestId, ok: true, stageId,
      handleCount: candidate.handles.length, warmupFrames: candidate.warmupFrames,
      managedBytes: wasm.webrc_dsp_managed_memory_bytes() });
  }

  commitSharedDspFxBankPlan(message) {
    const dsp = this.sharedDsp;
    const staged = dsp && dsp.fxStaged;
    if (!staged || staged.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: false,
        message: 'Shared DSP FX stage token is stale.' });
      return;
    }
    dsp.fxTransitionFrames = Math.max(1, Math.round(sampleRate * 0.01));
    dsp.fxTransitionElapsed = 0;
    if (message.allowHistoryWarmup === true) {
      const previous = {
        handles: dsp.fxActiveHandles,
        inputRoutes: dsp.fxInputRoutes,
        inputMonitorRoute: dsp.fxInputMonitorRoute,
        trackRoutes: dsp.fxTrackRoutes,
      };
      if (!this.primeSharedDspFxBankCandidate(staged, previous)) {
        this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: false,
          message: 'Shared DSP FX candidate needs more real input history than is available; the old routes remain active.' });
        return;
      }
      this.activateSharedDspFxBankCandidate(staged);
      staged.handles = previous.handles;
      staged.inputRoutes = previous.inputRoutes;
      staged.inputMonitorRoute = previous.inputMonitorRoute;
      staged.trackRoutes = previous.trackRoutes;
      dsp.fxRetired = staged;
      dsp.fxStaged = null;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, dsp.fxTransitionFrames);
    } else {
      staged.warmedFrames = 0;
      staged.failed = false;
      dsp.fxWarming = staged;
      dsp.fxStaged = null;
      if (staged.warmupFrames === 0) {
        this.activateSharedDspFxBankCandidate(staged);
        dsp.fxRetired = staged;
        dsp.fxWarming = null;
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, dsp.fxTransitionFrames);
      } else if (this.fxTransitionControl) {
        Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, staged.warmupFrames + dsp.fxTransitionFrames);
      }
    }
    this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_COMMITTED', requestId: message.requestId, ok: true,
      warming: dsp.fxWarming === staged,
      inputHandleCount: dsp.fxInputRoutes.reduce((count, route) => count + route.handles.length, 0) + dsp.fxInputMonitorRoute.handles.length,
      trackHandleCount: dsp.fxTrackRoutes.reduce((count, route) => count + route.handles.length, 0),
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  rollbackSharedDspFxBankPlan(message) {
    const dsp = this.sharedDsp;
    const warming = dsp && dsp.fxWarming;
    if (warming && warming.stageId === (Number(message.stageId) >>> 0)) {
      for (let index = warming.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(warming.handles[index]);
      dsp.fxWarming = null;
      dsp.fxTransitionFrames = 0;
      dsp.fxTransitionElapsed = 0;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: true,
        managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
      return;
    }
    const retired = dsp && dsp.fxRetired;
    if (!retired || retired.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: false,
        message: 'Shared DSP FX rollback token is stale.' });
      return;
    }
    for (let index = dsp.fxActiveHandles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.fxActiveHandles[index]);
    dsp.fxActiveHandles = retired.handles;
    dsp.fxInputRoutes = retired.inputRoutes;
    dsp.fxInputMonitorRoute = retired.inputMonitorRoute;
    dsp.fxTrackRoutes = retired.trackRoutes;
    dsp.fxRetired = null;
    dsp.fxTransitionFrames = 0;
    dsp.fxTransitionElapsed = 0;
    if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
    this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_ROLLED_BACK', requestId: message.requestId, ok: true,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  finalizeSharedDspFxBankPlan(message) {
    const dsp = this.sharedDsp;
    const retired = dsp && dsp.fxRetired;
    const requestedStageId = Number(message.stageId) >>> 0;
    if (!retired && dsp && dsp.lastFinalizedFxStageId === requestedStageId) {
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: true,
        idempotent: true, managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
      return;
    }
    if (!retired || retired.stageId !== requestedStageId) {
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: false,
        message: 'Shared DSP FX finalization token is stale.' });
      return;
    }
    if (dsp.fxTransitionElapsed < dsp.fxTransitionFrames) {
      if (message.allowUnrenderedFinalize !== true) {
        this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: false,
          message: 'Shared DSP FX replacement output has not completed its crossfade.' });
        return;
      }
      // A context that was already stopped has no audible old output to
      // preserve. The candidate has been pre-rolled from captured input; use
      // a bounded dry→new ramp for its first callbacks after the context resumes.
      const routes = dsp.fxInputRoutes.concat(dsp.fxTrackRoutes, [dsp.fxInputMonitorRoute]);
      for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        route.wetGain = 0;
        this.setSharedDspFxWetTarget(route, route.handles.length > 0 && route.wetTarget > 0 ? 1 : 0);
      }
      dsp.fxTransitionFrames = 0;
      dsp.fxTransitionElapsed = 0;
      if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, 0);
    }
    for (let index = retired.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(retired.handles[index]);
    dsp.lastFinalizedFxStageId = requestedStageId;
    dsp.fxRetired = null;
    this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_FINALIZED', requestId: message.requestId, ok: true,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  abortSharedDspFxBankPlan(message) {
    const dsp = this.sharedDsp;
    const staged = dsp && dsp.fxStaged;
    if (!staged || staged.stageId !== (Number(message.stageId) >>> 0)) {
      this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_ABORTED', requestId: message.requestId, ok: false,
        message: 'Shared DSP FX stage token is stale.' });
      return;
    }
    for (let index = staged.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(staged.handles[index]);
    dsp.fxStaged = null;
    this.port.postMessage({ type: 'SHARED_DSP_FX_BANK_ABORTED', requestId: message.requestId, ok: true,
      managedBytes: dsp.wasm.webrc_dsp_managed_memory_bytes() });
  }

  selectCleanRoomRhythm(message) {
    const patternIndex = message.patternIndex;
    const kitIndex = message.kitIndex;
    const dsp = this.sharedDsp;
    let error = '';
    if (!dsp || dsp.disposed || !dsp.rhythmHandle) error = 'Clean-room rhythm renderer is unavailable.';
    else if (!Number.isInteger(patternIndex) || patternIndex < 0 || patternIndex >= 240 ||
        !Number.isInteger(kitIndex) || kitIndex < 0 || kitIndex >= 16) error = 'Clean-room rhythm selection is outside the table bounds.';
    if (!error) {
      const status = dsp.wasm.webrc_dsp_extended_rhythm_queue_pattern_kit(dsp.rhythmHandle, patternIndex, kitIndex);
      if (status !== 0) error = `Clean-room rhythm selection was rejected (${status}).`;
      else {
        this.rhythmUsesCleanRoom = true;
        this.rhythmUsesCustomPattern = false;
        if (this.rhythmRunning && !this.cleanRoomRhythmStarted) {
          const startFrame = Number.isSafeInteger(currentFrame) && currentFrame >= 0 ? currentFrame : 0;
          const startStatus = dsp.wasm.webrc_dsp_extended_rhythm_start_words(
            dsp.rhythmHandle, startFrame >>> 0, Math.floor(startFrame / 0x1_0000_0000) >>> 0, 1,
          );
          if (startStatus !== 0) error = `Clean-room rhythm start was rejected (${startStatus}).`;
        }
      }
    }
    this.port.postMessage({
      type: 'RHYTHM_UPDATE_ACK', requestId: message.requestId,
      ok: !error, message: error || undefined, queued: !error,
      selectedPatternIndex: patternIndex, selectedKitIndex: kitIndex,
    });
  }

  disposeSharedDspGraph() {
    const dsp = this.sharedDsp;
    if (!dsp || dsp.disposed) return;
    dsp.disposed = true;
    if (dsp.wasm) {
      if (dsp.fxStaged) {
        for (let index = dsp.fxStaged.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.fxStaged.handles[index]);
        dsp.fxStaged = null;
      }
      if (dsp.fxWarming) {
        for (let index = dsp.fxWarming.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.fxWarming.handles[index]);
        dsp.fxWarming = null;
      }
      if (dsp.fxRetired) {
        for (let index = dsp.fxRetired.handles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.fxRetired.handles[index]);
        dsp.fxRetired = null;
      }
      for (let index = dsp.fxActiveHandles.length - 1; index >= 0; index -= 1) dsp.wasm.webrc_dsp_fx_destroy(dsp.fxActiveHandles[index]);
      dsp.fxActiveHandles.length = 0;
      for (let index = dsp.handles.length - 1; index >= 0; index -= 1) {
        dsp.wasm.webrc_dsp_destroy(dsp.handles[index]);
      }
      dsp.handles.length = 0;
      if (dsp.fxScratchToken) dsp.wasm.webrc_dsp_free_transfer_token(dsp.fxScratchToken);
      if (dsp.scratchToken) dsp.wasm.webrc_dsp_free_transfer_token(dsp.scratchToken);
    }
    this.sharedDsp = null;
  }

  sharedDspRouteForMessage(message) {
    const dsp = this.sharedDsp;
    if (!dsp || dsp.disposed) return null;
    const route = message.route;
    if (route === 'recordInput' || route === 'trackLoopOutput') {
      const track = Number(message.track);
      if (!Number.isInteger(track) || track < 0 || track >= TRACK_COUNT) return null;
      return route === 'recordInput' ? dsp.recordRoutes[track] : dsp.playbackRoutes[track];
    }
    if (message.track !== undefined) return null;
    if (route === 'monitor') return dsp.monitorRoute;
    if (route === 'rhythm') return dsp.rhythmRoute;
    return null;
  }

  sharedDspFilterControl(filter, values, valueCount) {
    const control = SHARED_DSP_FILTER_CONTROLS[filter];
    if (!control || !(values instanceof Float32Array) || valueCount < 2 || valueCount > 4) return 0;
    if (filter === 'lowpass' || filter === 'highpass' || filter === 'bandpass') {
      if (valueCount !== 2 && valueCount !== 3) return 0;
      if (values[0] < 0.5 || values[0] > sampleRate * 0.49 || values[1] < 0.1 || values[1] > 50) return 0;
      if (valueCount === 3 && (values[2] < 0 || values[2] > 10000)) return 0;
    } else if (filter === 'peaking') {
      if (valueCount !== 3 && valueCount !== 4) return 0;
      if (values[0] < 0.5 || values[0] > sampleRate * 0.49 || values[1] < 0.1 || values[1] > 50 ||
          values[2] < -36 || values[2] > 36) return 0;
      if (valueCount === 4 && (values[3] < 0 || values[3] > 10000)) return 0;
    } else {
      if (valueCount !== 3 && valueCount !== 4) return 0;
      if (values[0] < 0.5 || values[0] > sampleRate * 0.49 || values[1] < -36 || values[1] > 36 ||
          values[2] < 0.1 || values[2] > 1) return 0;
      if (valueCount === 4 && (values[3] < 0 || values[3] > 10000)) return 0;
    }
    return control;
  }

  configureSharedDspFilter(message) {
    const route = this.sharedDspRouteForMessage(message);
    const dsp = this.sharedDsp;
    let error = '';
    if (!dsp || !route) error = 'Shared DSP route is unavailable.';
    const filter = message.filter;
    const values = message.values;
    if (!error && (!Object.prototype.hasOwnProperty.call(SHARED_DSP_FILTER_CONTROLS, filter) ||
        !Array.isArray(values) || values.some((value) => !Number.isFinite(value)) || values.length > 4)) {
      error = 'Filter settings are malformed.';
    }
    let control = 0;
    if (!error) {
      dsp.configureValues.fill(0);
      for (let index = 0; index < values.length; index += 1) dsp.configureValues[index] = values[index];
      control = this.sharedDspFilterControl(filter, dsp.configureValues, values.length);
      if (!control) error = 'Filter settings are outside the prepared parameter bounds.';
      for (let index = 0; !error && index < values.length; index += 1) {
        if (!Number.isFinite(dsp.configureValues[index])) error = 'Filter settings exceed float32 range.';
      }
    }
    if (!error) {
      const leftStatus = dsp.wasm.webrc_dsp_configure(route.left, control, dsp.configureAddress, values.length);
      const rightStatus = dsp.wasm.webrc_dsp_configure(route.right, control, dsp.configureAddress, values.length);
      if (leftStatus !== 0 || rightStatus !== 0) error = `Filter configure failed (left ${leftStatus}, right ${rightStatus}).`;
      else {
        route.filter = filter;
        route.valueCount = values.length;
        route.values.set(dsp.configureValues.subarray(0, values.length));
        route.enabled = true;
        route.pendingReset = false;
        this.setSharedDspWetTarget(route, 1);
      }
    }
    this.port.postMessage({ type: 'SHARED_DSP_FILTER_CONFIGURED', requestId: message.requestId,
      route: message.route, track: message.track ?? null, ok: !error, message: error || undefined });
  }

  clearSharedDspFilter(message) {
    const route = this.sharedDspRouteForMessage(message);
    const dsp = this.sharedDsp;
    let error = '';
    if (!dsp || !route) error = 'Shared DSP route is unavailable.';
    if (!error) {
      route.pendingReset = true;
      this.setSharedDspWetTarget(route, 0);
    }
    this.port.postMessage({ type: 'SHARED_DSP_FILTER_CLEARED', requestId: message.requestId,
      route: message.route, track: message.track ?? null, ok: !error, message: error || undefined });
  }

  setSharedDspWetTarget(route, target) {
    if (!route) return;
    const boundedTarget = target > 0 ? 1 : 0;
    const rampFrames = Math.max(1, Math.round(sampleRate * 0.01));
    route.wetTarget = boundedTarget;
    route.wetRampRemaining = rampFrames;
    route.wetStep = (boundedTarget - route.wetGain) / rampFrames;
  }

  nextSharedDspWetGain(route) {
    if (route.wetRampRemaining > 0) {
      route.wetGain += route.wetStep;
      route.wetRampRemaining -= 1;
      if (route.wetRampRemaining === 0) route.wetGain = route.wetTarget;
    }
    return route.wetGain;
  }

  processSharedDspChannel(handle, source, output, frames) {
    const dsp = this.sharedDsp;
    if (!dsp || !dsp.wasm || !source || source.length < frames || frames > dsp.maxBlockFrames) return false;
    for (let index = 0; index < frames; index += 1) dsp.scratchInput[index] = source[index];
    const status = dsp.wasm.webrc_dsp_process(handle, dsp.scratchAddress, 0,
      dsp.scratchAddress + dsp.maxBlockFrames * Float32Array.BYTES_PER_ELEMENT, 0, 0, 0, frames);
    if (status !== 0) return false;
    for (let index = 0; index < frames; index += 1) output[index] = dsp.scratchOutput[index];
    return true;
  }

  createSharedDspFxRoute(handles, historyFrames = 0, warmupFrames = 0, ordinals = [], midiCapable = []) {
    const capacity = Math.max(1, historyFrames || (this.sharedDsp && this.sharedDsp.fxHistoryFrames) || Math.ceil(sampleRate * 0.1));
    return {
      handles, ordinals, midiCapable, wetGain: 0, wetTarget: 0, wetStep: 0, wetRampRemaining: 0,
      warmupFrames, warmedFrames: 0, prewarming: false,
      historyFrames: capacity,
      historyLeft: new Float32Array(capacity),
      historyRight: new Float32Array(capacity),
      historyWrite: 0,
      historyCount: 0,
    };
  }

  collectSharedDspFxMidiEvents(blockStartFrame, frames) {
    const dsp = this.sharedDsp;
    if (!dsp || !dsp.fxMidiHeader || !dsp.fxMidiView || !dsp.fxMidiEventsView ||
        !Number.isSafeInteger(blockStartFrame) || blockStartFrame < 0 || !Number.isInteger(frames) || frames < 1) return;
    const header = dsp.fxMidiHeader;
    let read = Atomics.load(header, 1) >>> 0;
    const write = Atomics.load(header, 0) >>> 0;
    const blockEndFrame = blockStartFrame + frames;
    let count = 0;
    while (read !== write && count < FX_MIDI_RING_CAPACITY) {
      const slot = read % FX_MIDI_RING_CAPACITY;
      const slotOffset = (FX_MIDI_HEADER_WORDS + slot * FX_MIDI_SLOT_WORDS) * 4;
      const low = dsp.fxMidiView.getUint32(slotOffset, true);
      const high = dsp.fxMidiView.getUint32(slotOffset + 4, true);
      const targetFrame = high * 0x1_0000_0000 + low;
      if (!Number.isSafeInteger(targetFrame)) {
        Atomics.add(header, 2, 1);
        read = (read + 1) >>> 0;
        continue;
      }
      if (targetFrame >= blockEndFrame) break;
      const type = dsp.fxMidiView.getUint32(slotOffset + 8, true);
      const channel = dsp.fxMidiView.getUint32(slotOffset + 12, true);
      const note = dsp.fxMidiView.getUint32(slotOffset + 16, true);
      const velocity = dsp.fxMidiView.getUint32(slotOffset + 20, true);
      if (type > 2 || channel !== 0 || note > 127 || velocity > 127) {
        Atomics.add(header, 2, 1);
        read = (read + 1) >>> 0;
        continue;
      }
      const eventOffset = count * 8;
      dsp.fxMidiEventsView.setUint32(eventOffset, Math.max(0, targetFrame - blockStartFrame), true);
      dsp.fxMidiEventsView.setUint8(eventOffset + 4, type);
      dsp.fxMidiEventsView.setUint8(eventOffset + 5, channel);
      dsp.fxMidiEventsView.setUint8(eventOffset + 6, note);
      dsp.fxMidiEventsView.setUint8(eventOffset + 7, velocity);
      count += 1;
      read = (read + 1) >>> 0;
    }
    dsp.fxCurrentMidiEventCount = count;
    Atomics.store(header, 1, read | 0);
  }

  prepareSharedDspFxCarrier(inputs, frames) {
    const dsp = this.sharedDsp;
    if (!dsp || !dsp.fxCarrierLeft || !dsp.fxCarrierRight) return;
    const input = inputs && inputs[6];
    const left = input && input.length >= 2 ? input[0] : null;
    const right = input && input.length >= 2 ? input[1] : null;
    const stereoPresent = Boolean(left && right && left.length >= frames && right.length >= frames);
    dsp.fxCurrentCarrierChannels = stereoPresent ? 2 : (input && input.length === 1 ? 1 : 0);
    for (let frame = 0; frame < frames && frame < dsp.maxBlockFrames; frame += 1) {
      const leftSample = stereoPresent ? left[frame] : 0;
      const rightSample = stereoPresent ? right[frame] : 0;
      dsp.fxCarrierLeft[frame] = Number.isFinite(leftSample) ? leftSample : 0;
      dsp.fxCarrierRight[frame] = Number.isFinite(rightSample) ? rightSample : 0;
    }
  }

  recordSharedDspFxCarrierHistory(frames) {
    const dsp = this.sharedDsp;
    if (!dsp || !dsp.fxCarrierHistoryLeft || !dsp.fxCarrierHistoryRight) return;
    // A missing or mono carrier breaks continuity. Never pad the missing
    // interval with zeros and then claim that a vocoder candidate was primed.
    if (dsp.fxCurrentCarrierChannels !== 2) {
      dsp.fxCarrierHistoryCount = 0;
      return;
    }
    let write = dsp.fxCarrierHistoryWrite;
    let count = dsp.fxCarrierHistoryCount;
    const capacity = dsp.fxHistoryFrames;
    for (let frame = 0; frame < frames; frame += 1) {
      dsp.fxCarrierHistoryLeft[write] = dsp.fxCarrierLeft[frame];
      dsp.fxCarrierHistoryRight[write] = dsp.fxCarrierRight[frame];
      write += 1;
      if (write === capacity) write = 0;
      if (count < capacity) count += 1;
    }
    dsp.fxCarrierHistoryWrite = write;
    dsp.fxCarrierHistoryCount = count;
  }

  recordSharedDspFxHistory(route, sourceLeft, sourceRight, frames) {
    if (!route || !route.historyLeft || !route.historyRight || !sourceLeft || !sourceRight ||
        sourceLeft.length < frames || sourceRight.length < frames) return;
    const capacity = route.historyFrames;
    let write = route.historyWrite;
    let count = route.historyCount;
    for (let frame = 0; frame < frames; frame += 1) {
      const left = sourceLeft[frame];
      const right = sourceRight[frame];
      route.historyLeft[write] = Number.isFinite(left) ? left : 0;
      route.historyRight[write] = Number.isFinite(right) ? right : 0;
      write += 1;
      if (write === capacity) write = 0;
      if (count < capacity) count += 1;
    }
    route.historyWrite = write;
    route.historyCount = count;
  }

  primeSharedDspFxRoute(route, historyRoute) {
    const dsp = this.sharedDsp;
    const warmupFrames = route && route.warmupFrames;
    if (!dsp || !route || !Number.isInteger(warmupFrames) || warmupFrames < 0 || warmupFrames > dsp.fxHistoryFrames) return false;
    const hasVocoder = route.ordinals.includes(20);
    const primeFrames = hasVocoder ? Math.max(1, warmupFrames) : warmupFrames;
    if (primeFrames > 0) {
      const historyFrames = historyRoute && Number.isInteger(historyRoute.historyFrames) ? historyRoute.historyFrames : 0;
      const validFrames = historyRoute && Number.isInteger(historyRoute.historyCount) ? historyRoute.historyCount : 0;
      if (historyFrames < primeFrames || validFrames < primeFrames) return false;
      if (hasVocoder && dsp.fxCarrierHistoryCount < primeFrames) return false;
      const firstHistoryFrame = historyFrames > 0
        ? (historyRoute.historyWrite - primeFrames + historyFrames) % historyFrames
        : 0;
      const firstCarrierFrame = hasVocoder
        ? (dsp.fxCarrierHistoryWrite - primeFrames + dsp.fxHistoryFrames) % dsp.fxHistoryFrames
        : 0;
      for (let offset = 0; offset < primeFrames;) {
        const frames = Math.min(dsp.maxBlockFrames, primeFrames - offset);
        for (let frame = 0; frame < frames; frame += 1) {
          const historyFrame = offset + frame;
          const index = (firstHistoryFrame + historyFrame) % historyFrames;
          dsp.fxScratchLeftA[frame] = historyRoute.historyLeft[index];
          dsp.fxScratchRightA[frame] = historyRoute.historyRight[index];
          if (hasVocoder) {
            const carrierIndex = (firstCarrierFrame + historyFrame) % dsp.fxHistoryFrames;
            dsp.fxCarrierLeft[frame] = dsp.fxCarrierHistoryLeft[carrierIndex];
            dsp.fxCarrierRight[frame] = dsp.fxCarrierHistoryRight[carrierIndex];
          }
        }
        let sourceL = dsp.fxScratchLeftA;
        let sourceR = dsp.fxScratchRightA;
        let sourceLAddress = dsp.fxScratchLeftAAddress;
        let sourceRAddress = dsp.fxScratchRightAAddress;
        let destinationL = dsp.fxScratchLeftB;
        let destinationR = dsp.fxScratchRightB;
        let destinationLAddress = dsp.fxScratchLeftBAddress;
        let destinationRAddress = dsp.fxScratchRightBAddress;
        for (let index = 0; index < route.handles.length; index += 1) {
          const ordinal = route.ordinals[index];
          const isVocoder = ordinal === 20;
          const status = dsp.fxContextApiVersion === 1
            ? dsp.wasm.webrc_dsp_fx_process_stereo_context_v1(route.handles[index],
              sourceLAddress, sourceRAddress, destinationLAddress, destinationRAddress, frames,
              0, 0, 0, 0,
              isVocoder ? dsp.fxCarrierLeftAddress : 0,
              isVocoder ? dsp.fxCarrierRightAddress : 0,
              isVocoder ? frames : 0,
              isVocoder ? 2 : 0,
              0, 0)
            : dsp.wasm.webrc_dsp_fx_process_stereo(route.handles[index], sourceLAddress, sourceRAddress,
              destinationLAddress, destinationRAddress, frames);
          if (status !== 0) return false;
          const swapL = sourceL; sourceL = destinationL; destinationL = swapL;
          const swapR = sourceR; sourceR = destinationR; destinationR = swapR;
          const swapLAddress = sourceLAddress; sourceLAddress = destinationLAddress; destinationLAddress = swapLAddress;
          const swapRAddress = sourceRAddress; sourceRAddress = destinationRAddress; destinationRAddress = swapRAddress;
        }
        offset += frames;
      }
    }
    if (historyRoute && historyRoute.historyLeft && historyRoute.historyRight &&
        route.historyFrames === historyRoute.historyFrames) {
      route.historyLeft.set(historyRoute.historyLeft);
      route.historyRight.set(historyRoute.historyRight);
      route.historyWrite = historyRoute.historyWrite;
      route.historyCount = historyRoute.historyCount;
    }
    route.wetGain = route.wetTarget;
    route.wetStep = 0;
    route.wetRampRemaining = 0;
    route.warmedFrames = warmupFrames;
    return true;
  }

  primeSharedDspFxBankCandidate(candidate, previous) {
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      if (!this.primeSharedDspFxRoute(candidate.inputRoutes[track], previous.inputRoutes[track])) return false;
    }
    if (!this.primeSharedDspFxRoute(candidate.inputMonitorRoute, previous.inputMonitorRoute)) return false;
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      if (!this.primeSharedDspFxRoute(candidate.trackRoutes[track], previous.trackRoutes[track])) return false;
    }
    return true;
  }

  activateSharedDspFxBankCandidate(candidate) {
    const dsp = this.sharedDsp;
    if (!dsp || !candidate) return false;
    const oldHandles = dsp.fxActiveHandles;
    const oldInputRoutes = dsp.fxInputRoutes;
    const oldInputMonitorRoute = dsp.fxInputMonitorRoute;
    const oldTrackRoutes = dsp.fxTrackRoutes;
    dsp.fxActiveHandles = candidate.handles;
    dsp.fxInputRoutes = candidate.inputRoutes;
    dsp.fxInputMonitorRoute = candidate.inputMonitorRoute;
    dsp.fxTrackRoutes = candidate.trackRoutes;
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      candidate.inputRoutes[track].prewarming = false;
      candidate.trackRoutes[track].prewarming = false;
    }
    candidate.inputMonitorRoute.prewarming = false;
    candidate.handles = oldHandles;
    candidate.inputRoutes = oldInputRoutes;
    candidate.inputMonitorRoute = oldInputMonitorRoute;
    candidate.trackRoutes = oldTrackRoutes;
    return true;
  }

  warmSharedDspFxRoute(route, sourceLeft, sourceRight, frames) {
    const dsp = this.sharedDsp;
    const warming = dsp && dsp.fxWarming;
    if (!warming || warming.failed || !route || frames > dsp.maxBlockFrames) return;
    const warmLeft = dsp.fxTransitionSourceLeft;
    const warmRight = dsp.fxTransitionSourceRight;
    for (let frame = 0; frame < frames; frame += 1) {
      const left = sourceLeft && sourceLeft.length > frame ? sourceLeft[frame] : 0;
      const right = sourceRight && sourceRight.length > frame ? sourceRight[frame] : 0;
      warmLeft[frame] = Number.isFinite(left) ? left : 0;
      warmRight[frame] = Number.isFinite(right) ? right : 0;
    }
    this.recordSharedDspFxHistory(route, warmLeft, warmRight, frames);
    if (route.handles.length > 0) {
      const before = dsp.failureCounts[SHARED_DSP_FAILURE_KIND.stereoProcess];
      this.renderSharedDspFxChain(route, warmLeft, warmRight,
        dsp.fxTransitionOldLeft, dsp.fxTransitionOldRight, frames);
      if (dsp.failureCounts[SHARED_DSP_FAILURE_KIND.stereoProcess] !== before) {
        warming.failed = true;
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, -1);
        return;
      }
    }
    route.warmedFrames = Math.min(route.warmupFrames, route.warmedFrames + frames);
  }

  sharedDspFxWarmupComplete(candidate) {
    if (!candidate || candidate.failed) return false;
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      if (candidate.inputRoutes[track].warmedFrames < candidate.inputRoutes[track].warmupFrames ||
          candidate.trackRoutes[track].warmedFrames < candidate.trackRoutes[track].warmupFrames) return false;
    }
    return candidate.inputMonitorRoute.warmedFrames >= candidate.inputMonitorRoute.warmupFrames;
  }

  sharedDspFxWarmupRemaining(candidate) {
    let remaining = 0;
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      remaining = Math.max(remaining, candidate.inputRoutes[track].warmupFrames - candidate.inputRoutes[track].warmedFrames);
      remaining = Math.max(remaining, candidate.trackRoutes[track].warmupFrames - candidate.trackRoutes[track].warmedFrames);
    }
    return Math.max(remaining, candidate.inputMonitorRoute.warmupFrames - candidate.inputMonitorRoute.warmedFrames);
  }

  setSharedDspFxWetTarget(route, target) {
    if (!route) return;
    const boundedTarget = target > 0 ? 1 : 0;
    const rampFrames = Math.max(1, Math.round(sampleRate * 0.01));
    route.wetTarget = boundedTarget;
    route.wetRampRemaining = rampFrames;
    route.wetStep = (boundedTarget - route.wetGain) / rampFrames;
  }

  nextSharedDspFxWetGain(route) {
    if (route.wetRampRemaining > 0) {
      route.wetGain += route.wetStep;
      route.wetRampRemaining -= 1;
      if (route.wetRampRemaining === 0) route.wetGain = route.wetTarget;
    }
    return route.wetGain;
  }

  processSharedDspFxChain(route, sourceLeft, sourceRight, outputLeft, outputRight, frames, previousRoute = null, warmingRoute = null) {
    const dsp = this.sharedDsp;
    this.recordSharedDspFxHistory(route, sourceLeft, sourceRight, frames);
    if (warmingRoute) this.warmSharedDspFxRoute(warmingRoute, sourceLeft, sourceRight, frames);
    if (dsp && dsp.fxRetired && dsp.fxTransitionElapsed < dsp.fxTransitionFrames) {
      const oldRoute = previousRoute;
      const oldHasHandles = Boolean(oldRoute && oldRoute.handles && oldRoute.handles.length > 0);
      const newHasHandles = Boolean(route && route.handles && route.handles.length > 0);
      if (!oldHasHandles && !newHasHandles) return false;
      if (!dsp || dsp.disposed || frames > dsp.maxBlockFrames || !sourceLeft || !sourceRight ||
          sourceLeft.length < frames || sourceRight.length < frames || !outputLeft || !outputRight ||
          outputLeft.length < frames || outputRight.length < frames) {
        if (outputLeft && outputLeft.length >= frames) outputLeft.fill(0, 0, frames);
        if (outputRight && outputRight.length >= frames) outputRight.fill(0, 0, frames);
        this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.stereoProcess);
        return true;
      }
      const dryLeft = dsp.fxTransitionSourceLeft;
      const dryRight = dsp.fxTransitionSourceRight;
      const oldLeft = dsp.fxTransitionOldLeft;
      const oldRight = dsp.fxTransitionOldRight;
      for (let frame = 0; frame < frames; frame += 1) {
        dryLeft[frame] = Number.isFinite(sourceLeft[frame]) ? sourceLeft[frame] : 0;
        dryRight[frame] = Number.isFinite(sourceRight[frame]) ? sourceRight[frame] : 0;
      }
      if (oldHasHandles) this.renderSharedDspFxChain(oldRoute, dryLeft, dryRight, oldLeft, oldRight, frames);
      else {
        for (let frame = 0; frame < frames; frame += 1) { oldLeft[frame] = dryLeft[frame]; oldRight[frame] = dryRight[frame]; }
      }
      if (newHasHandles) this.renderSharedDspFxChain(route, dryLeft, dryRight, outputLeft, outputRight, frames);
      else {
        for (let frame = 0; frame < frames; frame += 1) { outputLeft[frame] = dryLeft[frame]; outputRight[frame] = dryRight[frame]; }
      }
      const transitionStart = dsp.fxTransitionElapsed;
      const transitionFrames = dsp.fxTransitionFrames;
      for (let frame = 0; frame < frames; frame += 1) {
        const blend = Math.min(1, (transitionStart + frame + 1) / transitionFrames);
        outputLeft[frame] = oldLeft[frame] + (outputLeft[frame] - oldLeft[frame]) * blend;
        outputRight[frame] = oldRight[frame] + (outputRight[frame] - oldRight[frame]) * blend;
      }
      return true;
    }
    return this.renderSharedDspFxChain(route, sourceLeft, sourceRight, outputLeft, outputRight, frames);
  }

  renderSharedDspFxChain(route, sourceLeft, sourceRight, outputLeft, outputRight, frames) {
    const dsp = this.sharedDsp;
    const handles = route && route.handles;
    if (!handles || handles.length === 0) return false;
    if (route.wetGain === 0 && route.wetTarget === 0 && route.wetRampRemaining === 0 && !route.prewarming) return false;
    if (!dsp || dsp.disposed || frames > dsp.maxBlockFrames || !sourceLeft || !sourceRight ||
        sourceLeft.length < frames || sourceRight.length < frames || !outputLeft || !outputRight ||
        outputLeft.length < frames || outputRight.length < frames) {
      if (outputLeft && outputLeft.length >= frames) outputLeft.fill(0, 0, frames);
      if (outputRight && outputRight.length >= frames) outputRight.fill(0, 0, frames);
      this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.stereoProcess);
      return true;
    }
    const leftA = dsp.fxScratchLeftA;
    const rightA = dsp.fxScratchRightA;
    const leftB = dsp.fxScratchLeftB;
    const rightB = dsp.fxScratchRightB;
    for (let frame = 0; frame < frames; frame += 1) {
      leftA[frame] = sourceLeft[frame];
      rightA[frame] = sourceRight[frame];
    }
    let sourceL = leftA;
    let sourceR = rightA;
    let sourceLAddress = dsp.fxScratchLeftAAddress;
    let sourceRAddress = dsp.fxScratchRightAAddress;
    let destinationL = leftB;
    let destinationR = rightB;
    let destinationLAddress = dsp.fxScratchLeftBAddress;
    let destinationRAddress = dsp.fxScratchRightBAddress;
    for (let index = 0; index < handles.length; index += 1) {
      const ordinal = route.ordinals && route.ordinals[index];
      const isMidiProcessor = ordinal === 21 || (ordinal === 19 && route.midiCapable[index]);
      const isVocoder = ordinal === 20;
      const midiCount = isMidiProcessor ? dsp.fxCurrentMidiEventCount : 0;
      const carrierChannels = isVocoder && dsp.fxCurrentCarrierChannels === 2 ? 2 : 0;
      const status = dsp.fxContextApiVersion === 1
        ? dsp.wasm.webrc_dsp_fx_process_stereo_context_v1(handles[index],
          sourceLAddress, sourceRAddress, destinationLAddress, destinationRAddress, frames,
          0, 0, 0, 0,
          isVocoder && carrierChannels === 2 ? dsp.fxCarrierLeftAddress : 0,
          isVocoder && carrierChannels === 2 ? dsp.fxCarrierRightAddress : 0,
          isVocoder && carrierChannels === 2 ? frames : 0,
          carrierChannels,
          midiCount > 0 ? dsp.fxMidiEventsAddress : 0,
          midiCount)
        : dsp.wasm.webrc_dsp_fx_process_stereo(handles[index], sourceLAddress, sourceRAddress,
          destinationLAddress, destinationRAddress, frames);
      if (status !== 0) {
        outputLeft.fill(0, 0, frames);
        outputRight.fill(0, 0, frames);
        this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.stereoProcess);
        return true;
      }
      const swapL = sourceL; sourceL = destinationL; destinationL = swapL;
      const swapR = sourceR; sourceR = destinationR; destinationR = swapR;
      const swapLAddress = sourceLAddress; sourceLAddress = destinationLAddress; destinationLAddress = swapLAddress;
      const swapRAddress = sourceRAddress; sourceRAddress = destinationRAddress; destinationRAddress = swapRAddress;
    }
    for (let frame = 0; frame < frames; frame += 1) {
      const wet = this.nextSharedDspFxWetGain(route);
      const dry = 1 - wet;
      outputLeft[frame] = sourceLeft[frame] * dry + sourceL[frame] * wet;
      outputRight[frame] = sourceRight[frame] * dry + sourceR[frame] * wet;
    }
    return true;
  }

  recordSharedDspFailure(kind) {
    const dsp = this.sharedDsp;
    if (dsp && dsp.failureCounts) dsp.failureCounts[kind] += 1;
    if (this.control) Atomics.add(this.control, SHARED_DSP_PROCESS_FAILURES, 1);
  }

  processSharedDspStereo(route, sourceLeft, sourceRight, outputLeft, outputRight, frames) {
    const dsp = this.sharedDsp;
    if (!route || !route.enabled) return false;
    const valid = sourceLeft && sourceLeft.length >= frames && sourceRight && sourceRight.length >= frames &&
      outputLeft && outputLeft.length >= frames && outputRight && outputRight.length >= frames &&
      this.processSharedDspChannel(route.left, sourceLeft, dsp.outputStageLeft, frames) &&
      this.processSharedDspChannel(route.right, sourceRight, dsp.outputStageRight, frames);
    if (!valid) {
      if (outputLeft && outputLeft.length >= frames) outputLeft.fill(0, 0, frames);
      if (outputRight && outputRight.length >= frames) outputRight.fill(0, 0, frames);
      this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.stereoProcess);
      return true;
    }
    for (let index = 0; index < frames; index += 1) {
      const wetGain = this.nextSharedDspWetGain(route);
      const dryGain = 1 - wetGain;
      outputLeft[index] = sourceLeft[index] * dryGain + dsp.outputStageLeft[index] * wetGain;
      outputRight[index] = sourceRight[index] * dryGain + dsp.outputStageRight[index] * wetGain;
    }
    if (route.pendingReset && route.wetRampRemaining === 0 && route.wetGain === 0) {
      const leftStatus = dsp.wasm.webrc_dsp_reset(route.left);
      const rightStatus = dsp.wasm.webrc_dsp_reset(route.right);
      route.pendingReset = false;
      route.enabled = false;
      route.filter = null;
      route.valueCount = 0;
      route.values.fill(0);
      if (leftStatus !== 0 || rightStatus !== 0) {
        this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.filterReset);
      }
    }
    return true;
  }

  prepareSharedDspRecordInputs(inputs, frames) {
    const dsp = this.sharedDsp;
    if (!dsp || dsp.disposed) return;
    dsp.filteredInputReady.fill(0);
    if (frames > dsp.maxBlockFrames) {
      this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.inputOversize);
      for (let track = 0; track < TRACK_COUNT; track += 1) {
        if (!dsp.recordRoutes[track].enabled) continue;
        dsp.filteredInputLeft[track].fill(0, 0, Math.min(frames, dsp.maxBlockFrames));
        dsp.filteredInputRight[track].fill(0, 0, Math.min(frames, dsp.maxBlockFrames));
        dsp.filteredInputReady[track] = 1;
      }
      return;
    }
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      const route = dsp.recordRoutes[track];
      const warmingRoute = dsp.fxWarming ? dsp.fxWarming.inputRoutes[track] : null;
      const trackInput = this.perTrackInputs ? inputs[track + 1] : inputs[0];
      const sourceLeft = trackInput && trackInput.length > 0 ? trackInput[0] : null;
      const sourceRight = trackInput && trackInput.length > 1 ? trackInput[1] : sourceLeft;
      if (!sourceLeft || sourceLeft.length < frames || !sourceRight || sourceRight.length < frames) {
        if (warmingRoute) this.warmSharedDspFxRoute(warmingRoute, dsp.fxWarmSilenceLeft, dsp.fxWarmSilenceRight, frames);
        continue;
      }
      let inputLeft = sourceLeft;
      let inputRight = sourceRight;
      const retired = dsp.fxRetired;
      const oldRoute = retired ? retired.inputRoutes[track] : null;
      const bankProcessed = this.processSharedDspFxChain(dsp.fxInputRoutes[track], sourceLeft, sourceRight,
        dsp.filteredInputLeft[track], dsp.filteredInputRight[track], frames, oldRoute, warmingRoute);
      if (bankProcessed) {
        inputLeft = dsp.filteredInputLeft[track];
        inputRight = dsp.filteredInputRight[track];
      }
      if (route.enabled) {
        const ok = this.processSharedDspStereo(route, inputLeft, inputRight,
          dsp.filteredInputLeft[track], dsp.filteredInputRight[track], frames);
        if (ok) dsp.filteredInputReady[track] = 1;
      } else if (bankProcessed) dsp.filteredInputReady[track] = 1;
    }
  }

  processSharedDspRenderedOutputs(outputs, frames, blockStartFrame) {
    const dsp = this.sharedDsp;
    if (!dsp || dsp.disposed) return;
    for (let track = 0; track < TRACK_COUNT; track += 1) {
      const output = outputs[track];
      const route = dsp.playbackRoutes[track];
      const trackFxRoute = dsp.fxTrackRoutes[track];
      const retired = dsp.fxRetired;
      const oldTrackFxRoute = retired ? retired.trackRoutes[track] : null;
      const warmingRoute = dsp.fxWarming ? dsp.fxWarming.trackRoutes[track] : null;
      if (output && output[0] && output[1]) {
        this.processSharedDspFxChain(trackFxRoute, output[0], output[1], output[0], output[1], frames,
          oldTrackFxRoute, warmingRoute);
      } else if (warmingRoute) {
        this.warmSharedDspFxRoute(warmingRoute, dsp.fxWarmSilenceLeft, dsp.fxWarmSilenceRight, frames);
      }
      if (route.enabled && output && output[0] && output[1]) {
        this.processSharedDspStereo(route, output[0], output[1], output[0], output[1], frames);
      }
    }
    const monitor = outputs[5];
    if (monitor && monitor[0] && monitor[1]) {
      const retired = dsp.fxRetired;
      this.processSharedDspFxChain(dsp.fxInputMonitorRoute, monitor[0], monitor[1], monitor[0], monitor[1], frames,
        retired ? retired.inputMonitorRoute : null,
        dsp.fxWarming ? dsp.fxWarming.inputMonitorRoute : null);
    } else if (dsp.fxWarming) {
      this.warmSharedDspFxRoute(dsp.fxWarming.inputMonitorRoute, dsp.fxWarmSilenceLeft, dsp.fxWarmSilenceRight, frames);
    }
    if (dsp.monitorRoute.enabled && monitor && monitor[0] && monitor[1]) {
      this.processSharedDspStereo(dsp.monitorRoute, monitor[0], monitor[1], monitor[0], monitor[1], frames);
    }
    const rhythm = outputs[6];
    if (dsp.rhythmHandle) {
      if (!Number.isSafeInteger(blockStartFrame) || blockStartFrame < 0) {
        if (rhythm && rhythm[0]) rhythm[0].fill(0, 0, frames);
        if (rhythm && rhythm[1]) rhythm[1].fill(0, 0, frames);
        this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.rhythmFrame);
        this.recordRhythmProcessFailure(-1, blockStartFrame);
        return;
      }
      if (this.rhythmCallLastEndFrame >= 0 && blockStartFrame !== this.rhythmCallLastEndFrame) {
        this.rhythmCallDiscontinuityCount += 1;
        this.rhythmCallExpectedFrame = this.rhythmCallLastEndFrame;
        this.rhythmCallActualFrame = blockStartFrame;
      }
      const frameLow = blockStartFrame >>> 0;
      const frameHigh = Math.floor(blockStartFrame / 0x1_0000_0000) >>> 0;
      const status = dsp.wasm.webrc_dsp_extended_rhythm_process_block_words(
        dsp.rhythmHandle, frameLow, frameHigh, dsp.scratchAddress,
        dsp.scratchAddress + dsp.maxBlockFrames * Float32Array.BYTES_PER_ELEMENT, frames,
      );
      if (status !== 0) {
        if (this.rhythmUsesCleanRoom && rhythm && rhythm[0]) rhythm[0].fill(0, 0, frames);
        if (this.rhythmUsesCleanRoom && rhythm && rhythm[1]) rhythm[1].fill(0, 0, frames);
        this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.rhythmProcess);
        this.recordRhythmProcessFailure(status, blockStartFrame);
      } else {
        if (this.rhythmUsesCleanRoom && rhythm && rhythm[0] && rhythm[0].length >= frames) {
          for (let frame = 0; frame < frames; frame += 1) rhythm[0][frame] = dsp.scratchInput[frame];
        }
        if (this.rhythmUsesCleanRoom && rhythm && rhythm[1] && rhythm[1].length >= frames) {
          for (let frame = 0; frame < frames; frame += 1) rhythm[1][frame] = dsp.scratchOutput[frame];
        }
        this.cleanRoomRhythmStarted = dsp.wasm.webrc_dsp_extended_rhythm_is_playing(dsp.rhythmHandle) !== 0;
      }
      this.rhythmCallLastEndFrame = blockStartFrame + frames;
    }
    if (dsp.rhythmRoute.enabled && rhythm && rhythm[0] && rhythm[1]) {
      this.processSharedDspStereo(dsp.rhythmRoute, rhythm[0], rhythm[1], rhythm[0], rhythm[1], frames);
    }
  }

  recordRhythmProcessFailure(status, blockStartFrame) {
    this.rhythmProcessLastStatus = status;
    if (this.rhythmProcessFirstFailureFrame < 0 && Number.isSafeInteger(blockStartFrame)) {
      this.rhythmProcessFirstFailureFrame = blockStartFrame;
    }
    if (Number.isSafeInteger(blockStartFrame)) this.rhythmProcessLastFailureFrame = blockStartFrame;
    const statusIndex = Number.isInteger(status) && status >= 0 && status < this.rhythmProcessStatusCounts.length
      ? status : 0;
    this.rhythmProcessStatusCounts[statusIndex] += 1;
  }

  process(inputs, outputs) {
    if (!this.control) return true;

    const startedAt = this.deadlineMetricAvailable ? performance.now() : 0;
    const blockStartFrame = currentFrame;
    const frames = outputs[0] && outputs[0][0] ? outputs[0][0].length : 0;
    if (!Number.isInteger(frames) || frames <= 0) return true;
    let recoveredGap = false;
    let explicitRecovery = false;
    this.processCallbackCount += 1;
    this.processFrameCount += frames;

    if (this.quantumFrames !== frames) {
      this.quantumFrames = frames;
      this.port.postMessage({ type: 'QUANTUM_OBSERVED', frames, frame: blockStartFrame });
    }

    if (!Number.isSafeInteger(blockStartFrame) || blockStartFrame < 0 || frames > SHARED_DSP_MAX_BLOCK_FRAMES) {
      this.timelineFailureCount += 1;
      const reportedFrame = Number.isSafeInteger(blockStartFrame) && blockStartFrame >= 0 ? blockStartFrame : -1;
      this.timelineExpectedFrame = this.timelineHasSuccessfulBlock ? this.timelineExpectedFrame : reportedFrame;
      this.timelineLastActualFrame = reportedFrame;
      this.timelineLastStatus = frames > SHARED_DSP_MAX_BLOCK_FRAMES ? 5 : 6;
      this.recordTimelineEvent(this.timelineLastStatus, this.timelineExpectedFrame, reportedFrame, frames);
      this.rejectTimelineCommands(blockStartFrame);
      this.silenceTimelineOutputs(outputs, frames);
      this.timelineDroppedOutputCallbacks += 1;
      this.timelineDroppedOutputFrames += frames;
      this.finishProcessDeadline(startedAt, frames);
      return true;
    }

    const expectedBeforeRecovery = this.timelineExpectedFrame;
    const gapBeforeRecovery = this.timelineHasSuccessfulBlock
      ? blockStartFrame - expectedBeforeRecovery
      : 0;
    const pendingRecoveryId = this.pendingTimelineRecoveryRequestId;
    const explicitRecoveryRequired = this.timelineRecoveryNeeded ||
      (this.timelineHasSuccessfulBlock && (gapBeforeRecovery < 0 || gapBeforeRecovery > TIMELINE_AUTORECOVERY_MAX_GAP_FRAMES));
    if (pendingRecoveryId !== 0 && explicitRecoveryRequired) {
      if (!this.timelineRecoveryNeeded) this.beginTimelineRecoveryNeeded(expectedBeforeRecovery, blockStartFrame, frames);
      this.applyExplicitTimelineRecovery(pendingRecoveryId, blockStartFrame, frames);
      explicitRecovery = true;
    } else if (pendingRecoveryId !== 0) {
      this.acknowledgeTimelineRecovery(pendingRecoveryId, false, expectedBeforeRecovery, blockStartFrame, 0);
    }

    if (this.timelineRecoveryNeeded) {
      const previousDroppedEnd = this.timelineRecoveryNeededLastObservedEndFrame;
      if (previousDroppedEnd >= 0 && blockStartFrame > previousDroppedEnd) {
        this.timelineUnrecoveredGapFrames += blockStartFrame - previousDroppedEnd;
      }
      if (blockStartFrame === this.timelineLastDroppedBlockStartFrame && frames === this.timelineLastDroppedBlockFrames) {
        this.timelineDuplicateCallbacks += 1;
      }
      this.timelineLastDroppedBlockStartFrame = blockStartFrame;
      this.timelineLastDroppedBlockFrames = frames;
      this.timelineRecoveryNeededLastObservedEndFrame = Math.max(previousDroppedEnd, blockStartFrame + frames);
      this.timelineLastActualFrame = blockStartFrame;
      this.timelineLastStatus = 8;
      this.timelineDroppedOutputCallbacks += 1;
      this.timelineDroppedOutputFrames += frames;
      this.timelineDroppedInputCallbacks += 1;
      this.timelineDroppedInputFrames += frames;
      this.recordTimelineEvent(8, this.timelineExpectedFrame, blockStartFrame, frames);
      this.rejectTimelineCommands(blockStartFrame);
      this.silenceTimelineOutputs(outputs, frames);
      this.finishProcessDeadline(startedAt, frames);
      return true;
    }

    if (this.timelineHasSuccessfulBlock) {
      const expectedFrame = this.timelineExpectedFrame;
      if (blockStartFrame === this.timelineLastBlockStartFrame && frames === this.timelineLastBlockFrames &&
          this.timelineLastOutputFrames === frames) {
        this.timelineDuplicateCallbacks += 1;
        this.timelineLastActualFrame = blockStartFrame;
        this.timelineLastStatus = 1;
        this.recordTimelineEvent(1, expectedFrame, blockStartFrame, frames);
        this.copyTimelineOutputs(this.timelineReplayOutputs, outputs, frames);
        this.finishProcessDeadline(startedAt, frames);
        return true;
      }

      if (blockStartFrame < expectedFrame) {
        this.beginTimelineRecoveryNeeded(expectedFrame, blockStartFrame, frames);
        this.timelineLastDroppedBlockStartFrame = blockStartFrame;
        this.timelineLastDroppedBlockFrames = frames;
        this.timelineRecoveryNeededLastObservedEndFrame = blockStartFrame + frames;
        this.timelineLastActualFrame = blockStartFrame;
        this.timelineDroppedOutputCallbacks += 1;
        this.timelineDroppedOutputFrames += frames;
        this.timelineDroppedInputCallbacks += 1;
        this.timelineDroppedInputFrames += frames;
        this.rejectTimelineCommands(blockStartFrame);
        this.silenceTimelineOutputs(outputs, frames);
        this.finishProcessDeadline(startedAt, frames);
        return true;
      }

      if (blockStartFrame > expectedFrame) {
        const gapFrames = blockStartFrame - expectedFrame;
        if (!Number.isSafeInteger(gapFrames)) {
          this.beginTimelineRecoveryNeeded(expectedFrame, blockStartFrame, frames);
          this.timelineLastDroppedBlockStartFrame = blockStartFrame;
          this.timelineLastDroppedBlockFrames = frames;
          this.timelineRecoveryNeededLastObservedEndFrame = blockStartFrame + frames;
          this.timelineLastActualFrame = blockStartFrame;
          this.timelineDroppedOutputCallbacks += 1;
          this.timelineDroppedOutputFrames += frames;
          this.timelineDroppedInputCallbacks += 1;
          this.timelineDroppedInputFrames += frames;
          this.rejectTimelineCommands(blockStartFrame);
          this.silenceTimelineOutputs(outputs, frames);
          this.finishProcessDeadline(startedAt, frames);
          return true;
        }
        if (!this.timelineRecoveryActive) {
          if (gapFrames > TIMELINE_AUTORECOVERY_MAX_GAP_FRAMES) {
            this.beginTimelineRecoveryNeeded(expectedFrame, blockStartFrame, gapFrames);
            this.timelineLastDroppedBlockStartFrame = blockStartFrame;
            this.timelineLastDroppedBlockFrames = frames;
            this.timelineRecoveryNeededLastObservedEndFrame = blockStartFrame + frames;
            this.timelineLastActualFrame = blockStartFrame;
            this.timelineDroppedOutputCallbacks += 1;
            this.timelineDroppedOutputFrames += frames;
            this.timelineDroppedInputCallbacks += 1;
            this.timelineDroppedInputFrames += frames;
            this.rejectTimelineCommands(blockStartFrame);
            this.silenceTimelineOutputs(outputs, frames);
            this.finishProcessDeadline(startedAt, frames);
            return true;
          }
          this.timelineRecoveryActive = true;
          this.timelineRecoveryStartExpectedFrame = expectedFrame;
          this.timelineRecoveryStartActualFrame = blockStartFrame;
          this.timelineRecoveryCount += 1;
          this.timelineForwardGapCount += 1;
          this.timelineXrunCount += 1;
          this.recordTimelineEvent(6, expectedFrame, blockStartFrame, gapFrames);
        }

        if (blockStartFrame === this.timelineLastDroppedBlockStartFrame && frames === this.timelineLastDroppedBlockFrames) {
          this.timelineDuplicateCallbacks += 1;
        }
        const quantumFrames = Math.max(this.timelineLastQuantumFrames, frames);
        const maximumCatchupFrames = Math.min(SHARED_DSP_MAX_BLOCK_FRAMES, quantumFrames * 2);
        const catchupFrames = Math.min(gapFrames, maximumCatchupFrames);
        const maxCoreFrames = this.sharedDsp && this.sharedDsp.maxBlockFrames > 0
          ? Math.min(SHARED_DSP_MAX_BLOCK_FRAMES, this.sharedDsp.maxBlockFrames)
          : SHARED_DSP_MAX_BLOCK_FRAMES;
        for (let offset = 0; offset < catchupFrames; offset += maxCoreFrames) {
          const chunkFrames = Math.min(maxCoreFrames, catchupFrames - offset);
          this.processBlockCore(this.timelineSilenceInputs, this.timelineGapOutputs,
            chunkFrames, expectedFrame + offset, true);
        }
        this.timelineExpectedFrame = expectedFrame + catchupFrames;
        this.timelineForwardGapFrames += catchupFrames;
        this.timelineRecoveryCatchupFrames += catchupFrames;
        this.timelineUniqueAdvancedFrames += catchupFrames;
        this.timelineLastActualFrame = blockStartFrame;
        if (this.timelineExpectedFrame < blockStartFrame) {
          this.timelineLastStatus = 7;
          this.timelineLastDroppedBlockStartFrame = blockStartFrame;
          this.timelineLastDroppedBlockFrames = frames;
          this.timelineDroppedOutputCallbacks += 1;
          this.timelineDroppedOutputFrames += frames;
          this.timelineDroppedInputCallbacks += 1;
          this.timelineDroppedInputFrames += frames;
          this.recordTimelineEvent(7, this.timelineExpectedFrame, blockStartFrame, catchupFrames);
          this.silenceTimelineOutputs(outputs, frames);
          this.finishProcessDeadline(startedAt, frames);
          return true;
        }

        this.timelineRecoveryActive = false;
        this.timelineRecoveryCompleteCount += 1;
        this.recordTimelineEvent(2, this.timelineExpectedFrame, blockStartFrame,
          blockStartFrame - this.timelineRecoveryStartExpectedFrame);
        this.timelineRecoveryStartExpectedFrame = -1;
        this.timelineRecoveryStartActualFrame = -1;
        this.timelineLastDroppedBlockStartFrame = -1;
        this.timelineLastDroppedBlockFrames = 0;
        this.timelineRecoveryNeededLastObservedEndFrame = -1;
        recoveredGap = true;
      }
      if (blockStartFrame === expectedFrame && this.timelineRecoveryActive) {
        this.timelineRecoveryActive = false;
        this.timelineRecoveryCompleteCount += 1;
        this.recordTimelineEvent(2, expectedFrame, blockStartFrame,
          blockStartFrame - this.timelineRecoveryStartExpectedFrame);
        this.timelineRecoveryStartExpectedFrame = -1;
        this.timelineRecoveryStartActualFrame = -1;
        recoveredGap = true;
      }
    }

    this.processBlockCore(inputs, outputs, frames, blockStartFrame);
    this.timelineUniqueAdvancedFrames += frames;
    this.timelineUniqueOutputFrames += frames;
    this.timelineOutputEndFrame = blockStartFrame + frames;
    this.copyTimelineOutputs(outputs, this.timelineReplayOutputs, frames);
    this.timelineLastOutputFrames = frames;
    this.timelineHasSuccessfulBlock = true;
    this.timelineLastBlockStartFrame = blockStartFrame;
    this.timelineLastBlockFrames = frames;
    this.timelineExpectedFrame = blockStartFrame + frames;
    this.timelineLastActualFrame = blockStartFrame;
    this.timelineLastStatus = explicitRecovery ? 9 : (recoveredGap ? 2 : 0);
    this.timelineLastQuantumFrames = frames;
    this.finishProcessDeadline(startedAt, frames);
    return true;
  }

  beginTimelineRecoveryNeeded(expectedFrame, actualFrame, frames) {
    if (!this.timelineRecoveryNeeded) {
      if (!this.timelineRecoveryActive && Number.isSafeInteger(actualFrame) &&
          Number.isSafeInteger(expectedFrame) && actualFrame > expectedFrame) {
        this.timelineForwardGapCount += 1;
        this.timelineXrunCount += 1;
      }
      this.timelineRecoveryNeeded = true;
      this.timelineRecoveryActive = false;
      this.timelineFailureCount += 1;
      if (Number.isSafeInteger(expectedFrame) && Number.isSafeInteger(actualFrame) && actualFrame > expectedFrame) {
        this.timelineUnrecoveredGapFrames += actualFrame - expectedFrame;
      } else if (Number.isSafeInteger(expectedFrame) && Number.isSafeInteger(actualFrame) && actualFrame < expectedFrame) {
        this.timelineBackwardDiscontinuityCount += 1;
      }
      this.timelineLastStatus = actualFrame < expectedFrame ? 3 : 8;
      this.recordTimelineEvent(actualFrame < expectedFrame ? 3 : 8, expectedFrame, actualFrame, frames);
    }
  }

  applyExplicitTimelineRecovery(requestId, actualFrame, frames) {
    const previousFrame = this.timelineExpectedFrame;
    const frameDelta = Number.isSafeInteger(previousFrame) ? actualFrame - previousFrame : 0;
    const skippedFrames = frameDelta > 0 ? frameDelta : 0;
    const rewoundFrames = frameDelta < 0 ? -frameDelta : 0;
    if (skippedFrames > 0) {
      this.timelineForwardGapFrames += skippedFrames;
      this.timelineExplicitRecoverySkippedFrames += skippedFrames;
      this.timelineUnrecoveredGapFrames = Math.max(this.timelineUnrecoveredGapFrames, skippedFrames);
      let recordingTracks = 0;
      for (let track = 0; track < TRACK_COUNT; track += 1) {
        const meta = this.trackMeta[track];
        const state = meta ? meta[TRACK_STATE] : STATE_EMPTY;
        if (state === STATE_RECORDING || state === STATE_OVERDUBBING || state === STATE_REPLACING) recordingTracks += 1;
      }
      if (recordingTracks > 0) {
        Atomics.add(this.control, UNDERRUNS, 1);
        Atomics.add(this.control, INPUT_DROPOUT_BLOCKS, 1);
        Atomics.add(this.control, INPUT_DROPOUT_FRAMES, Math.min(0x7fffffff, skippedFrames * recordingTracks));
      }
    }
    if (rewoundFrames > 0) this.timelineBackwardResetCount += 1;

    this.timelineDiscontinuityEpoch += 1;
    this.timelineExplicitRecoveryCount += 1;
    this.timelineRecoveryNeeded = false;
    this.timelineRecoveryActive = false;
    this.timelineRecoveryStartExpectedFrame = -1;
    this.timelineRecoveryStartActualFrame = -1;
    this.timelineRecoveryNeededLastObservedEndFrame = -1;
    this.timelineLastDroppedBlockStartFrame = -1;
    this.timelineLastDroppedBlockFrames = 0;
    this.timelineExpectedFrame = actualFrame;
    this.timelineLastActualFrame = actualFrame;
    this.timelineLastStatus = 9;
    this.timelineHasSuccessfulBlock = false;
    this.timelineLastOutputFrames = 0;
    this.timelineLastBlockStartFrame = -1;
    this.timelineLastBlockFrames = 0;
    this.rhythmCallLastEndFrame = -1;
    this.rhythmCallExpectedFrame = -1;
    this.rhythmCallActualFrame = -1;
    if (this.sharedDsp && this.sharedDsp.rhythmHandle) {
      const dsp = this.sharedDsp;
      const resetStatus = dsp.wasm.webrc_dsp_extended_reset(dsp.rhythmHandle);
      if (resetStatus !== 0) this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.rhythmProcess);
      this.cleanRoomRhythmStarted = false;
      if (resetStatus === 0 && this.rhythmUsesCleanRoom && this.rhythmRunning) {
        const startStatus = dsp.wasm.webrc_dsp_extended_rhythm_start_words(
          dsp.rhythmHandle, actualFrame >>> 0, Math.floor(actualFrame / 0x1_0000_0000) >>> 0, 1,
        );
        if (startStatus !== 0) this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.rhythmCommand);
        else this.cleanRoomRhythmStarted = true;
      }
    }
    this.recordTimelineEvent(9, previousFrame, actualFrame, skippedFrames || rewoundFrames || frames);
    this.pendingTimelineRecoveryRequestId = 0;
    this.port.postMessage({
      type: 'TIMELINE_RECOVERY_ACK', requestId,
      recovered: true, previousFrame, actualFrame, skippedFrames, rewoundFrames,
      discontinuityEpoch: this.timelineDiscontinuityEpoch,
    });
  }

  acknowledgeTimelineRecovery(requestId, recovered, previousFrame, actualFrame, skippedFrames) {
    this.pendingTimelineRecoveryRequestId = 0;
    this.port.postMessage({
      type: 'TIMELINE_RECOVERY_ACK', requestId,
      recovered, previousFrame, actualFrame, skippedFrames,
      rewoundFrames: 0, discontinuityEpoch: this.timelineDiscontinuityEpoch,
    });
  }

  processBlockCore(inputs, outputs, frames, blockStartFrame, isTimelineGapBlock = false) {
    this.collectSharedDspFxMidiEvents(blockStartFrame, frames);
    this.prepareSharedDspFxCarrier(inputs, frames);
    this.recordSharedDspFxCarrierHistory(frames);
    const input = inputs[0];
    const inputLeft = input && input.length > 0 ? input[0] : null;
    const inputRight = input && input.length > 1 ? input[1] : inputLeft;
    const globalHasInput = Boolean(inputLeft && inputLeft.length >= frames);
    const globalLeftSamples = inputLeft;
    const globalRightSamples = inputRight;

    this.drainCommands(blockStartFrame);
    this.prepareSharedDspRecordInputs(inputs, frames);

    let missingInputTrackFrames = 0;
    if (this.prepareSteadyPlayback(outputs)) {
      this.processSteadyPlaybackBlock(outputs, frames, blockStartFrame);
    } else {
      for (let offset = 0; offset < frames; offset += 1) {
        const frame = blockStartFrame + offset;
        if (this.pendingCommandCount > 0) this.executeDueCommands(frame);

        const globalSampleLeft = globalHasInput ? globalLeftSamples[offset] : 0;
        const globalSampleRight = globalHasInput && globalRightSamples && globalRightSamples.length >= frames
          ? globalRightSamples[offset]
          : globalSampleLeft;

        if (this.calibrationActive && frame >= this.calibrationStartFrame) {
          if (this.calibrationWriteIndex < this.calibrationFrames) {
            this.calibrationData[this.calibrationWriteIndex] = (globalSampleLeft + globalSampleRight) * 0.5;
            this.calibrationWriteIndex += 1;
            this.calibrationMeta[RECORDING_FRAMES] = this.calibrationWriteIndex;
          }
          if (this.calibrationWriteIndex >= this.calibrationFrames) {
            this.calibrationActive = false;
            Atomics.store(this.calibrationMeta, LOOP_FRAMES, this.calibrationWriteIndex);
            this.port.postMessage({
              type: 'LOOPBACK_CAPTURE_COMPLETE',
              frames: this.calibrationWriteIndex,
              startFrame: this.calibrationStartFrame,
            });
          }
        }

        const monitor = outputs[5];
        if (monitor && monitor[0]) monitor[0][offset] = this.outputMonitorEnabled ? globalSampleLeft : 0;
        if (monitor && monitor[1]) monitor[1][offset] = this.outputMonitorEnabled ? globalSampleRight : 0;

        for (let track = 0; track < TRACK_COUNT; track += 1) {
          const trackInput = this.perTrackInputs ? inputs[track + 1] : input;
          const trackLeft = trackInput && trackInput.length > 0 ? trackInput[0] : null;
          const trackRight = trackInput && trackInput.length > 1 ? trackInput[1] : trackLeft;
          const trackHasInput = Boolean(trackLeft && trackLeft.length >= frames);
          const trackHasRight = Boolean(trackRight && trackRight.length >= frames);
          const sharedDsp = this.sharedDsp;
          const filteredInput = sharedDsp && sharedDsp.filteredInputReady[track] !== 0;
          const inputSampleLeft = trackHasInput
            ? (filteredInput ? (offset < sharedDsp.maxBlockFrames ? sharedDsp.filteredInputLeft[track][offset] : 0) : trackLeft[offset])
            : 0;
          const inputSampleRight = trackHasRight
            ? (filteredInput ? (offset < sharedDsp.maxBlockFrames ? sharedDsp.filteredInputRight[track][offset] : 0) : trackRight[offset])
            : inputSampleLeft;
          const output = outputs[track];
          const left = output && output[0];
          const right = output && output[1];
          this.renderTrackSample(track, frame, offset, inputSampleLeft, inputSampleRight, trackHasInput, left, right);
          const meta = this.trackMeta[track];
          const state = meta ? meta[TRACK_STATE] : STATE_EMPTY;
          if ((isTimelineGapBlock || !trackHasInput) &&
              (state === STATE_RECORDING || state === STATE_OVERDUBBING || state === STATE_REPLACING)) {
            missingInputTrackFrames += 1;
          }
        }

        const rhythmSample = this.rhythmUsesCleanRoom ? 0 : this.renderRhythmSample(frame);
        const rhythm = outputs[6];
        if (rhythm && rhythm[0]) rhythm[0][offset] = rhythmSample;
        if (rhythm && rhythm[1]) rhythm[1][offset] = rhythmSample;
        this.renderClockTick(frame);
      }
    }

    this.processSharedDspRenderedOutputs(outputs, frames, blockStartFrame);
    const sharedDsp = this.sharedDsp;
    let activatedWarmingThisBlock = false;
    if (sharedDsp && sharedDsp.fxWarming) {
      const candidate = sharedDsp.fxWarming;
      if (candidate.failed) {
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, -1);
      } else if (this.sharedDspFxWarmupComplete(candidate)) {
        candidate.warmedFrames = candidate.warmupFrames;
        this.activateSharedDspFxBankCandidate(candidate);
        sharedDsp.fxWarming = null;
        sharedDsp.fxRetired = candidate;
        sharedDsp.fxTransitionElapsed = 0;
        activatedWarmingThisBlock = true;
        if (this.fxTransitionControl) Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, sharedDsp.fxTransitionFrames);
      } else if (this.fxTransitionControl) {
        const remaining = this.sharedDspFxWarmupRemaining(candidate);
        candidate.warmedFrames = Math.max(0, candidate.warmupFrames - remaining);
        Atomics.store(this.fxTransitionControl, this.fxTransitionIndex, remaining + sharedDsp.fxTransitionFrames);
      }
    }
    if (!activatedWarmingThisBlock && sharedDsp && sharedDsp.fxRetired && sharedDsp.fxTransitionElapsed < sharedDsp.fxTransitionFrames) {
      sharedDsp.fxTransitionElapsed = Math.min(sharedDsp.fxTransitionFrames, sharedDsp.fxTransitionElapsed + frames);
      if (this.fxTransitionControl) {
        Atomics.store(this.fxTransitionControl, this.fxTransitionIndex,
          Math.max(0, sharedDsp.fxTransitionFrames - sharedDsp.fxTransitionElapsed));
      }
    }

    if (missingInputTrackFrames > 0) {
      Atomics.add(this.control, UNDERRUNS, 1);
      Atomics.add(this.control, INPUT_DROPOUT_BLOCKS, 1);
      Atomics.add(this.control, INPUT_DROPOUT_FRAMES, missingInputTrackFrames);
    }

    for (let track = 0; track < TRACK_COUNT; track += 1) {
      const meta = this.trackMeta[track];
      const loopFrames = meta ? meta[LOOP_FRAMES] : 0;
      const state = meta ? meta[TRACK_STATE] : STATE_EMPTY;
      const position = this.playPositions[track];
      const uiState = this.toUiState(state);
      this.control[TRACK_STATES_WORD_OFFSET + track] = uiState;
      this.controlPositions[track] = loopFrames > 0 &&
        (state === STATE_PLAYING || state === STATE_OVERDUBBING || state === STATE_REPLACING)
        ? position / loopFrames
        : 0;
      if (this.notifiedTrackStates[track] !== state) {
        this.notifiedTrackStates[track] = state;
        this.port.postMessage({ type: 'TRACK_STATE_CHANGED', track, state, frame: blockStartFrame + frames });
      }
    }

    this.storeFrame(RENDER_FRAME_SEQUENCE, RENDER_FRAME_LOW, RENDER_FRAME_HIGH, blockStartFrame + frames);
    Atomics.store(this.control, LAST_QUANTUM_FRAMES, frames);

  }

  recordTimelineEvent(status, expectedFrame, actualFrame, frames) {
    const slot = this.timelineEventCount % TIMELINE_EVENT_CAPACITY;
    const offset = slot * 4;
    this.timelineEventLog[offset] = status;
    this.timelineEventLog[offset + 1] = expectedFrame;
    this.timelineEventLog[offset + 2] = actualFrame;
    this.timelineEventLog[offset + 3] = frames;
    this.timelineEventCount += 1;
  }

  timelineEventSnapshot() {
    const count = Math.min(this.timelineEventCount, TIMELINE_EVENT_CAPACITY);
    const snapshot = new Float64Array(count * 4);
    const firstSlot = this.timelineEventCount > TIMELINE_EVENT_CAPACITY
      ? this.timelineEventCount % TIMELINE_EVENT_CAPACITY
      : 0;
    for (let event = 0; event < count; event += 1) {
      const sourceOffset = ((firstSlot + event) % TIMELINE_EVENT_CAPACITY) * 4;
      const destinationOffset = event * 4;
      snapshot[destinationOffset] = this.timelineEventLog[sourceOffset];
      snapshot[destinationOffset + 1] = this.timelineEventLog[sourceOffset + 1];
      snapshot[destinationOffset + 2] = this.timelineEventLog[sourceOffset + 2];
      snapshot[destinationOffset + 3] = this.timelineEventLog[sourceOffset + 3];
    }
    return snapshot;
  }

  finishProcessDeadline(startedAt, frames) {
    if (this.deadlineMetricAvailable) {
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs > (frames / sampleRate) * 1000) {
        Atomics.add(this.control, DEADLINE_MISSES, 1);
      }
    }
  }

  rejectTimelineCommands(observedFrame) {
    const ackFrame = Number.isSafeInteger(observedFrame) && observedFrame >= 0
      ? observedFrame
      : (Number.isSafeInteger(this.timelineExpectedFrame) && this.timelineExpectedFrame >= 0
        ? this.timelineExpectedFrame : 0);
    this.drainCommands(ackFrame);
    while (this.pendingCommandCount > 0) {
      const offset = 0;
      const sequence = this.pendingCommands[offset];
      const opcode = this.pendingCommands[offset + 1];
      const track = this.pendingCommands[offset + 2];
      const target = this.frameFromWords(this.pendingCommands[offset + 3], this.pendingCommands[offset + 4]);
      this.acknowledge(sequence, opcode, track, ackFrame, target,
        STATUS_TIMELINE_DISCONTINUITY, 0, 0);
      this.pendingCommandCount -= 1;
      const end = this.pendingCommandCount * COMMAND_WORDS;
      for (let word = 0; word < end; word += 1) {
        this.pendingCommands[word] = this.pendingCommands[word + COMMAND_WORDS];
      }
    }
  }

  silenceTimelineOutputs(outputs, frames) {
    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
      const output = outputs[outputIndex];
      if (!output) continue;
      for (let channel = 0; channel < output.length; channel += 1) {
        const samples = output[channel];
        if (samples) samples.fill(0, 0, Math.min(frames, samples.length));
      }
    }
  }

  copyTimelineOutputs(source, destination, frames) {
    for (let outputIndex = 0; outputIndex < 7; outputIndex += 1) {
      const sourceOutput = source[outputIndex];
      const destinationOutput = destination[outputIndex];
      if (!sourceOutput || !destinationOutput) continue;
      for (let channel = 0; channel < 2; channel += 1) {
        const sourceSamples = sourceOutput[channel];
        const destinationSamples = destinationOutput[channel];
        if (!sourceSamples || !destinationSamples) continue;
        const count = Math.min(frames, sourceSamples.length, destinationSamples.length);
        for (let frame = 0; frame < count; frame += 1) {
          destinationSamples[frame] = sourceSamples[frame];
        }
      }
    }
  }

  takeIndex(track, slot) {
    return track * MAX_HISTORY_TAKES + slot;
  }

  modeCode(mode) {
    if (mode === 'REPLACE1' || mode === 2) return 2;
    if (mode === 'REPLACE2' || mode === 3) return 3;
    if (mode === 'OVERDUB' || mode === 1) return 1;
    return 0;
  }

  clearTakeSlotsFrom(track, firstSlot, forcedEndSlot) {
    this.invalidatePitchCompositeCache(track);
    if (firstSlot === 0) this.validatedPrimarySegmentCounts[track] = 0;
    const meta = this.trackMeta[track];
    const endSlot = Math.min(MAX_HISTORY_TAKES, forcedEndSlot ?? Math.max(firstSlot + 1, meta ? meta[HISTORY_LENGTH] : firstSlot + 1));
    for (let slot = firstSlot; slot < endSlot; slot += 1) {
      const index = this.takeIndex(track, slot);
      const left = this.takeLeft[track][slot];
      const right = this.takeRight[track][slot];
      const mask = this.takeMask[track][slot];
      const segmentCount = this.takeSegmentCounts[index];
      for (let segment = 0; segment < segmentCount; segment += 1) {
        left[segment] = null;
        right[segment] = null;
        mask[segment] = null;
      }
      this.takeMeta[track][slot] = null;
      this.takeSegmentCounts[index] = 0;
      this.takeModes[index] = 0;
      this.takeFrames[index] = 0;
      this.takeActive[index] = 0;
      this.takeLowWaterPending[index] = 0;
      this.storageFailure[index] = 0;
    }
  }

  attachHistoryCompactionSegments(message) {
    const track = Number(message.track);
    const meta = Number.isInteger(track) && track >= 0 && track < TRACK_COUNT ? this.trackMeta[track] : null;
    const expectedCursor = Number(message.expectedCursor);
    const prefixEnd = Number(message.prefixEnd);
    const frameCount = Number(message.frameCount);
    const firstSegment = Number(message.firstSegment);
    const buffers = message.buffers;
    const totalSegments = Math.ceil(frameCount / STORAGE_BLOCK_FRAMES);
    const fail = (reason) => {
      if (Number.isInteger(track) && track >= 0 && track < TRACK_COUNT) this.resetCompactionStage(track);
      this.port.postMessage({ type: 'TRACK_COMPACTION_SEGMENTS_ERROR', track, firstSegment, message: reason });
    };
    if (!meta || !Number.isInteger(expectedCursor) || expectedCursor !== meta[HISTORY_CURSOR] ||
        !Number.isInteger(prefixEnd) || prefixEnd < 2 || prefixEnd >= expectedCursor ||
        !Number.isInteger(frameCount) || frameCount <= 0 || frameCount > MAX_SEGMENTS_PER_TAKE * STORAGE_BLOCK_FRAMES ||
        !Number.isInteger(firstSegment) || firstSegment < 0 || !Array.isArray(buffers) ||
        buffers.length <= 0 || buffers.length > 8 || firstSegment + buffers.length > totalSegments ||
        meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_REC_STANDBY ||
        meta[TRACK_STATE] === STATE_OVERDUBBING || meta[TRACK_STATE] === STATE_REPLACING) {
      fail('History compaction segment batch is invalid or does not match a safe committed prefix.');
      return;
    }

    let stage = this.compactionStage[track];
    if (firstSegment === 0) {
      stage = {
        expectedCursor,
        prefixEnd,
        frameCount,
        segmentCount: 0,
        firstMeta: null,
        left: [],
        right: [],
        mask: [],
      };
      this.compactionStage[track] = stage;
    }
    if (stage.expectedCursor !== expectedCursor || stage.prefixEnd !== prefixEnd ||
        stage.frameCount !== frameCount || stage.segmentCount !== firstSegment) {
      fail('History compaction segment batches must be attached in order for one immutable cursor.');
      return;
    }

    for (let offset = 0; offset < buffers.length; offset += 1) {
      const segment = firstSegment + offset;
      const buffer = buffers[offset];
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < TRACK_META_BYTES) {
        fail(`Flattened history segment ${segment} is not a shared buffer.`);
        return;
      }
      const segmentMeta = new Int32Array(buffer, 0, TRACK_META_WORDS);
      const capacity = Atomics.load(segmentMeta, CAPACITY_FRAMES);
      const sampleBytes = capacity * TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT;
      if (capacity !== STORAGE_BLOCK_FRAMES || Atomics.load(segmentMeta, CHANNEL_COUNT) !== TRACK_CHANNEL_COUNT ||
          Atomics.load(segmentMeta, STORAGE_LAYOUT_VERSION) !== LAYOUT_VERSION ||
          Atomics.load(segmentMeta, STORAGE_LAYOUT) !== LAYOUT_PLANAR_LR ||
          buffer.byteLength !== TRACK_META_BYTES + sampleBytes + capacity) {
        fail(`Flattened history segment ${segment} layout is invalid.`);
        return;
      }
      stage.left[segment] = new Float32Array(buffer, TRACK_META_BYTES, capacity);
      stage.right[segment] = new Float32Array(
        buffer,
        TRACK_META_BYTES + capacity * Float32Array.BYTES_PER_ELEMENT,
        capacity,
      );
      stage.mask[segment] = new Uint8Array(buffer, TRACK_META_BYTES + sampleBytes, capacity);
      if (segment === 0) stage.firstMeta = segmentMeta;
      stage.segmentCount += 1;
    }
    this.port.postMessage({ type: 'TRACK_COMPACTION_SEGMENTS_ATTACHED', track, firstSegment, segmentCount: buffers.length });
  }

  resetCompactionStage(track) {
    this.compactionStage[track] = {
      expectedCursor: -1,
      prefixEnd: -1,
      frameCount: 0,
      segmentCount: 0,
      firstMeta: null,
      left: [],
      right: [],
      mask: [],
    };
  }

  abortHistoryCompaction(message) {
    const track = Number(message.track);
    if (!Number.isInteger(track) || track < 0 || track >= TRACK_COUNT) return;
    this.resetCompactionStage(track);
    this.port.postMessage({ type: 'TRACK_COMPACTION_ABORTED', track });
  }

  compactHistoryFromMessage(message) {
    const track = Number(message.track);
    const meta = Number.isInteger(track) && track >= 0 && track < TRACK_COUNT ? this.trackMeta[track] : null;
    const expectedCursor = Number(message.expectedCursor);
    const prefixEnd = Number(message.prefixEnd);
    const frameCount = Number(message.frameCount);
    const recentSlots = message.recentSlots;
    const fail = (reason) => this.port.postMessage({ type: 'TRACK_HISTORY_COMPACT_ERROR', track, message: reason });
    const stage = meta && Number.isInteger(track) && track >= 0 && track < TRACK_COUNT
      ? this.compactionStage[track]
      : null;
    const expectedSegments = Math.ceil(frameCount / STORAGE_BLOCK_FRAMES);
    if (!meta || !Number.isInteger(expectedCursor) || expectedCursor !== meta[HISTORY_CURSOR] ||
        !Number.isInteger(prefixEnd) || prefixEnd < 2 || prefixEnd >= expectedCursor ||
        !Number.isInteger(frameCount) || frameCount <= 0 || frameCount > MAX_SEGMENTS_PER_TAKE * STORAGE_BLOCK_FRAMES ||
        !stage || stage.expectedCursor !== expectedCursor || stage.prefixEnd !== prefixEnd ||
        stage.frameCount !== frameCount || stage.segmentCount !== expectedSegments || !stage.firstMeta ||
        !Array.isArray(recentSlots) || recentSlots.length !== expectedCursor - prefixEnd ||
        meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_REC_STANDBY ||
        meta[TRACK_STATE] === STATE_OVERDUBBING || meta[TRACK_STATE] === STATE_REPLACING) {
      fail('History compaction request does not match a safe committed prefix.');
      return;
    }

    this.invalidatePitchCompositeCache(track);
    const recentLayers = new Array(recentSlots.length);
    for (let index = 0; index < recentSlots.length; index += 1) {
      const sourceSlot = Number(recentSlots[index]);
      if (!Number.isInteger(sourceSlot) || sourceSlot !== prefixEnd + index || sourceSlot <= 0 || sourceSlot >= expectedCursor) {
        fail('Recent history slot list is not contiguous.');
        return;
      }
      const sourceIndex = this.takeIndex(track, sourceSlot);
      const segments = this.takeSegmentCounts[sourceIndex];
      const frames = this.takeFrames[sourceIndex];
      const mode = this.takeModes[sourceIndex];
      if (!this.takeActive[sourceIndex] || frames <= 0 || segments <= 0 || mode < 0 || mode > 3) {
        fail(`Recent history slot ${sourceSlot} is not a committed layer.`);
        return;
      }
      const left = this.takeLeft[track][sourceSlot];
      const right = this.takeRight[track][sourceSlot];
      const mask = this.takeMask[track][sourceSlot];
      for (let segment = 0; segment < segments; segment += 1) {
        if (!left[segment] || !right[segment] || (mode === 2 || mode === 3) && !mask[segment]) {
          fail(`Recent history slot ${sourceSlot} has incomplete planar data.`);
          return;
        }
      }
      recentLayers[index] = {
        segments, frames, mode, left, right, mask, meta: this.takeMeta[track][sourceSlot],
      };
    }

    const newCursor = recentSlots.length + 2;
    for (let slot = 1; slot < MAX_HISTORY_TAKES; slot += 1) {
      const index = this.takeIndex(track, slot);
      this.takeLeft[track][slot] = [];
      this.takeRight[track][slot] = [];
      this.takeMask[track][slot] = [];
      this.takeMeta[track][slot] = null;
      this.takeSegmentCounts[index] = 0;
      this.takeModes[index] = 0;
      this.takeFrames[index] = 0;
      this.takeActive[index] = 0;
      this.takeLowWaterPending[index] = 0;
      this.storageFailure[index] = 0;
    }
    const anchorIndex = this.takeIndex(track, 1);
    this.takeLeft[track][1] = stage.left;
    this.takeRight[track][1] = stage.right;
    this.takeMask[track][1] = stage.mask;
    this.takeMeta[track][1] = stage.firstMeta;
    this.takeSegmentCounts[anchorIndex] = expectedSegments;
    this.takeModes[anchorIndex] = 0;
    this.takeFrames[anchorIndex] = frameCount;
    this.takeActive[anchorIndex] = 1;

    for (let index = 0; index < recentLayers.length; index += 1) {
      const layer = recentLayers[index];
      const slot = index + 2;
      const takeIndex = this.takeIndex(track, slot);
      this.takeLeft[track][slot] = layer.left;
      this.takeRight[track][slot] = layer.right;
      this.takeMask[track][slot] = layer.mask;
      this.takeMeta[track][slot] = layer.meta;
      this.takeSegmentCounts[takeIndex] = layer.segments;
      this.takeModes[takeIndex] = layer.mode;
      this.takeFrames[takeIndex] = layer.frames;
      this.takeActive[takeIndex] = 1;
    }

    Atomics.store(stage.firstMeta, LOOP_FRAMES, frameCount);
    Atomics.store(stage.firstMeta, RECORDING_FRAMES, frameCount);
    Atomics.store(stage.firstMeta, TAKE_MODE, 0);
    meta[HISTORY_CURSOR] = newCursor;
    meta[HISTORY_LENGTH] = newCursor;
    meta[ACTIVE_TAKE_SLOT] = newCursor - 1;
    meta[MARK_CURSOR] = -1;
    meta[CAPACITY_FRAMES] = recentLayers[recentLayers.length - 1]?.segments * STORAGE_BLOCK_FRAMES || expectedSegments * STORAGE_BLOCK_FRAMES;
    this.updateVisibleLoopFrames(track);
    // The three staged arrays now belong to anchor slot one. Drop the staging
    // references in constant time; old history arrays become collectible.
    stage.left = [];
    stage.right = [];
    stage.mask = [];
    stage.firstMeta = null;
    stage.expectedCursor = -1;
    stage.prefixEnd = -1;
    stage.frameCount = 0;
    stage.segmentCount = 0;
    this.port.postMessage({ type: 'TRACK_HISTORY_COMPACTED', track, oldCursor: expectedCursor, historyCursor: newCursor, frameCount });
  }

  resetTrackHistoryStorage(track) {
    const meta = this.trackMeta[track];
    this.clearTakeSlotsFrom(track, 0, MAX_HISTORY_TAKES);
    const initialMeta = meta;
    const initialLeft = this.primaryLeft[track];
    const initialRight = this.primaryRight[track];
    if (initialMeta && initialLeft && initialRight) {
      this.takeLeft[track][0][0] = initialLeft;
      this.takeRight[track][0][0] = initialRight;
      this.takeMeta[track][0] = initialMeta;
      this.takeSegmentCounts[this.takeIndex(track, 0)] = 1;
      this.takeActive[this.takeIndex(track, 0)] = 0;
    }
  }

  maybeRequestStorage(track, slot, writtenFrames) {
    const index = this.takeIndex(track, slot);
    const capacity = this.takeSegmentCounts[index] * STORAGE_BLOCK_FRAMES;
    const remaining = capacity - writtenFrames;
    if (remaining > STORAGE_BLOCK_FRAMES * 4 || this.takeLowWaterPending[index] || this.storageFailure[index]) return;
    if (this.takeSegmentCounts[index] >= MAX_SEGMENTS_PER_TAKE) return;
    this.takeLowWaterPending[index] = 1;
    this.port.postMessage({
      type: 'TRACK_STORAGE_LOW', track, takeSlot: slot,
      recordingFrames: writtenFrames, capacityFrames: capacity,
    });
  }

  writeTakeSample(track, slot, frame, leftSample, rightSample, replace) {
    const index = this.takeIndex(track, slot);
    if (frame < 0 || frame >= this.takeSegmentCounts[index] * STORAGE_BLOCK_FRAMES) return false;
    const segment = Math.floor(frame / STORAGE_BLOCK_FRAMES);
    const offset = frame - segment * STORAGE_BLOCK_FRAMES;
    const left = this.takeLeft[track][slot][segment];
    const right = this.takeRight[track][slot][segment];
    if (!left || !right) return false;
    const mode = this.takeModes[index];
    if (replace && (mode === 2 || mode === 3)) {
      const mask = this.takeMask[track][slot][segment];
      if (!mask) return false;
      left[offset] = leftSample;
      right[offset] = rightSample;
      mask[offset] = 1;
    } else if (mode === 0) {
      // A base recording owns its frame range. Reusing primary storage after
      // CLEAR must replace old samples, including when the new take is shorter.
      left[offset] = leftSample;
      right[offset] = rightSample;
    } else {
      left[offset] += leftSample;
      right[offset] += rightSample;
    }
    this.invalidatePitchCompositeFrame(track, frame);
    return true;
  }

  readCompositeStereoSample(track, frame, visibleTakes) {
    const meta = this.trackMeta[track];
    const loopFrames = meta ? meta[LOOP_FRAMES] : 0;
    if (loopFrames <= 0 || visibleTakes <= 0) {
      this.compositeSampleLeft[track] = 0;
      this.compositeSampleRight[track] = 0;
      return;
    }
    let wrappedFrame = frame % loopFrames;
    if (wrappedFrame < 0) wrappedFrame += loopFrames;
    const firstFrame = Math.floor(wrappedFrame);
    const fraction = wrappedFrame - firstFrame;
    const secondFrame = firstFrame + 1 >= loopFrames ? 0 : firstFrame + 1;
    const scratchOffset = track * 4;
    this.readCompositeIntegerStereoPair(
      track,
      firstFrame,
      secondFrame,
      fraction !== 0,
      visibleTakes,
      loopFrames,
      scratchOffset,
    );
    const firstLeft = this.compositeIntegerScratch[scratchOffset];
    const firstRight = this.compositeIntegerScratch[scratchOffset + 1];
    if (fraction === 0) {
      this.compositeSampleLeft[track] = firstLeft;
      this.compositeSampleRight[track] = firstRight;
      return;
    }
    const secondLeft = this.compositeIntegerScratch[scratchOffset + 2];
    const secondRight = this.compositeIntegerScratch[scratchOffset + 3];
    this.compositeSampleLeft[track] = firstLeft + (secondLeft - firstLeft) * fraction;
    this.compositeSampleRight[track] = firstRight + (secondRight - firstRight) * fraction;
  }

  readCompositeIntegerStereoPair(track, firstFrame, secondFrame, hasSecond, visibleTakes, loopFrames, scratchOffset) {
    let firstLeft = 0;
    let firstRight = 0;
    let secondLeft = 0;
    let secondRight = 0;
    let firstSlot = this.historyBaseSlots[track];
    if (firstSlot < 0) {
      // Compatibility for externally restored fixtures; the live runtime
      // installs this once when committed history changes.
      for (let slot = visibleTakes - 1; slot >= 0; slot -= 1) {
        const index = this.takeIndex(track, slot);
        if (this.takeActive[index] && this.takeModes[index] === 0 && this.takeFrames[index] > 0) {
          firstSlot = slot;
          break;
        }
      }
    }
    if (firstSlot < 0 || firstSlot >= visibleTakes) {
      this.compositeIntegerScratch[scratchOffset] = 0;
      this.compositeIntegerScratch[scratchOffset + 1] = 0;
      this.compositeIntegerScratch[scratchOffset + 2] = 0;
      this.compositeIntegerScratch[scratchOffset + 3] = 0;
      return;
    }
    for (let slot = firstSlot; slot < visibleTakes; slot += 1) {
      const index = this.takeIndex(track, slot);
      if (!this.takeActive[index]) continue;
      const mode = this.takeModes[index];
      const frames = this.takeFrames[index];
      if (frames <= 0) continue;
      let firstPosition = frames === loopFrames ? firstFrame : firstFrame % frames;
      if (firstPosition < 0) firstPosition += frames;
      const firstSegment = Math.floor(firstPosition / STORAGE_BLOCK_FRAMES);
      const firstOffset = firstPosition - firstSegment * STORAGE_BLOCK_FRAMES;
      const firstSegmentLeft = this.takeLeft[track][slot][firstSegment];
      const firstSegmentRight = this.takeRight[track][slot][firstSegment];
      const valueFirstLeft = firstSegmentLeft ? firstSegmentLeft[firstOffset] : 0;
      const valueFirstRight = firstSegmentRight ? firstSegmentRight[firstOffset] : 0;
      let valueSecondLeft = 0;
      let valueSecondRight = 0;
      let secondSegment = 0;
      let secondOffset = 0;
      if (hasSecond) {
        let secondPosition = frames === loopFrames ? secondFrame : secondFrame % frames;
        if (secondPosition < 0) secondPosition += frames;
        secondSegment = Math.floor(secondPosition / STORAGE_BLOCK_FRAMES);
        secondOffset = secondPosition - secondSegment * STORAGE_BLOCK_FRAMES;
        const secondSegmentLeft = this.takeLeft[track][slot][secondSegment];
        const secondSegmentRight = this.takeRight[track][slot][secondSegment];
        valueSecondLeft = secondSegmentLeft ? secondSegmentLeft[secondOffset] : 0;
        valueSecondRight = secondSegmentRight ? secondSegmentRight[secondOffset] : 0;
      }
      if (mode === 0) {
        firstLeft = valueFirstLeft;
        firstRight = valueFirstRight;
        if (hasSecond) {
          secondLeft = valueSecondLeft;
          secondRight = valueSecondRight;
        }
      } else if (mode === 1) {
        firstLeft += valueFirstLeft;
        firstRight += valueFirstRight;
        if (hasSecond) {
          secondLeft += valueSecondLeft;
          secondRight += valueSecondRight;
        }
      } else {
        const firstMask = this.takeMask[track][slot][firstSegment];
        if (firstMask && firstMask[firstOffset]) {
          firstLeft = valueFirstLeft;
          firstRight = valueFirstRight;
        }
        if (hasSecond) {
          const secondMask = this.takeMask[track][slot][secondSegment];
          if (secondMask && secondMask[secondOffset]) {
            secondLeft = valueSecondLeft;
            secondRight = valueSecondRight;
          }
        }
      }
    }
    this.compositeIntegerScratch[scratchOffset] = firstLeft;
    this.compositeIntegerScratch[scratchOffset + 1] = firstRight;
    this.compositeIntegerScratch[scratchOffset + 2] = secondLeft;
    this.compositeIntegerScratch[scratchOffset + 3] = secondRight;
  }

  renderTrackSample(track, frame, offset, inputLeft, inputRight, hasInput, leftOut, rightOut) {
    const meta = this.trackMeta[track];
    if (!meta) {
      if (leftOut) leftOut[offset] = 0;
      if (rightOut) rightOut[offset] = 0;
      return;
    }
    let state = meta[TRACK_STATE];
    const loopFrames = meta[LOOP_FRAMES];
    const reverse = meta[REVERSE] !== 0;
    const speed = this.effectiveSpeed(meta);
    const activeSlot = Math.max(0, Math.min(MAX_HISTORY_TAKES - 1, meta[ACTIVE_TAKE_SLOT]));
    const activeIndex = this.takeIndex(track, activeSlot);
    let inputLeftValue = inputLeft;
    let inputRightValue = inputRight;

    if (state === STATE_REC_STANDBY) {
      const autoEnabled = (meta[PLAYBACK_FLAGS] & 4) !== 0;
      if (autoEnabled) {
        const threshold = Math.max(1 / 32767, meta[AUTO_REC_THRESHOLD_Q15] / 32767);
        const magnitude = hasInput ? Math.max(Math.abs(inputLeftValue), Math.abs(inputRightValue)) : 0;
        const envelope = this.autoRecEnvelopes[track];
        const coefficient = magnitude > envelope ? this.autoRecAttackCoefficient : this.autoRecReleaseCoefficient;
        const nextEnvelope = magnitude + (envelope - magnitude) * coefficient;
        this.autoRecEnvelopes[track] = nextEnvelope;
        if (hasInput && nextEnvelope >= threshold) this.autoRecCounters[track] += 1;
        else if (!hasInput || nextEnvelope < threshold * 0.7) this.autoRecCounters[track] = 0;
        if (this.autoRecCounters[track] >= Math.max(1, meta[AUTO_REC_DEBOUNCE_FRAMES])) {
          state = STATE_RECORDING;
          meta[TRACK_STATE] = STATE_RECORDING;
          // The previous committed clip remains the visible BASE while
          // waiting for threshold. Replace it only on the first real sample
          // of the newly-triggered recording so cancelling standby restores
          // the old clip and its length unchanged.
          meta[LOOP_FRAMES] = 0;
          meta[RECORDING_FRAMES] = 0;
          meta[RECORD_BPM] = Math.round(this.bpm * 1000);
          this.takeFrames[activeIndex] = 0;
          const takeMeta = this.takeMeta[track][activeSlot];
          if (takeMeta) {
            takeMeta[RECORDING_FRAMES] = 0;
            takeMeta[LOOP_FRAMES] = 0;
          }
          this.storeTrackStartFrame(meta, frame);
          this.autoRecCounters[track] = 0;
          this.autoRecEnvelopes[track] = 0;
        }
      } else {
        state = STATE_RECORDING;
        meta[TRACK_STATE] = STATE_RECORDING;
      }
    }

    if (state === STATE_RECORDING) {
      const writeIndex = meta[RECORDING_FRAMES];
      const capacity = this.takeSegmentCounts[activeIndex] * STORAGE_BLOCK_FRAMES;
      if (writeIndex < capacity && this.writeTakeSample(track, activeSlot, writeIndex, inputLeftValue, inputRightValue, false)) {
        meta[RECORDING_FRAMES] = writeIndex + 1;
        this.takeFrames[activeIndex] = writeIndex + 1;
        const takeMeta = this.takeMeta[track][activeSlot];
        if (takeMeta) takeMeta[RECORDING_FRAMES] = writeIndex + 1;
        this.maybeRequestStorage(track, activeSlot, writeIndex + 1);
      } else {
        this.finishAtCapacity(track, frame, activeSlot, writeIndex);
        state = meta[TRACK_STATE];
      }
    }

    if ((state === STATE_OVERDUBBING || state === STATE_REPLACING) && loopFrames > 0) {
      this.pitchReaderCacheValid[track] = 0;
      const position = this.playPositions[track];
      const correction = meta[ALIGNMENT_SAMPLES] || 0;
      let writePosition = Math.round(position + (reverse ? correction : -correction));
      writePosition %= loopFrames;
      if (writePosition < 0) writePosition += loopFrames;
      if (this.writeTakeSample(track, activeSlot, writePosition, inputLeftValue, inputRightValue, true)) {
        const takeMeta = this.takeMeta[track][activeSlot];
        if (takeMeta) takeMeta[RECORDING_FRAMES] += 1;
        this.maybeRequestStorage(track, activeSlot, Math.floor(position) + 1);
      }
    }

    let outputLeft = 0;
    let outputRight = 0;
    if ((state === STATE_PLAYING || state === STATE_OVERDUBBING || state === STATE_REPLACING) && loopFrames > 0) {
      let position = this.playPositions[track];
      if (!Number.isFinite(position) || position < 0 || position >= loopFrames) position = reverse ? loopFrames - 1 : 0;
      const cursor = meta[HISTORY_CURSOR];
      const includeCurrent = state === STATE_OVERDUBBING || (state === STATE_REPLACING && meta[TAKE_MODE] === 3);
      const visibleTakes = Math.max(0, Math.min(MAX_HISTORY_TAKES, cursor + (includeCurrent ? 1 : 0)));
      const flags = meta[PLAYBACK_FLAGS];
      const oneShot = (flags & 1) !== 0;
      const tempoSyncFlags = meta[TEMPO_SYNC_FLAGS];
      const keepPitch = ((flags & 2) !== 0 || ((tempoSyncFlags & 1) !== 0 && (tempoSyncFlags & 2) !== 0)) &&
        Math.abs(speed - 1) > 1e-6 &&
        !(state === STATE_REPLACING && meta[TAKE_MODE] === 3);
      if (state === STATE_REPLACING && meta[TAKE_MODE] === 3) {
        outputLeft = hasInput ? inputLeftValue : 0;
        outputRight = hasInput ? inputRightValue : 0;
      } else if (!keepPitch) {
        // The phase vocoder will request source samples through its readers.
        // Avoid computing and discarding a full history-layer composite here.
        this.readCompositeStereoSample(track, position, visibleTakes);
        outputLeft = this.compositeSampleLeft[track];
        outputRight = this.compositeSampleRight[track];
      }

      if (keepPitch) {
        this.pitchVisibleTakes[track] = visibleTakes;
        const stretch = this.pitchTimeStretch[track];
        if (stretch.pendingIndex >= this.pitchPrefetchThresholds[track] &&
            stretch.pendingIndex < TIME_STRETCH_HOP_FRAMES && !stretch.nextReady) {
          prepareTimeStretchHop(
            stretch,
            oneShot ? 0 : loopFrames,
            speed,
            reverse,
            this.pitchReadLeft[track],
            this.pitchReadRight[track],
          );
        }
        processTimeStretchFrame(
          stretch,
          oneShot ? 0 : loopFrames,
          speed,
          reverse,
          this.pitchReadLeft[track],
          this.pitchReadRight[track],
        );
        outputLeft = stretch.outLeft;
        outputRight = stretch.outRight;
      }

      let nextPosition = position + (reverse ? -speed : speed);
      const wrapped = nextPosition >= loopFrames || nextPosition < 0;
      const remainingOneShotFrames = this.oneShotRemaining[track];
      if (oneShot && remainingOneShotFrames > 0) this.oneShotRemaining[track] = remainingOneShotFrames - 1;
      const oneShotCompleted = oneShot && (remainingOneShotFrames <= 1 || (!keepPitch && wrapped));
      if (oneShotCompleted) {
        nextPosition = reverse ? 0 : loopFrames - 1;
        meta[TRACK_STATE] = STATE_STOPPED;
        meta[PENDING_STOP_MODE] = 0;
      } else {
        nextPosition %= loopFrames;
        if (nextPosition < 0) nextPosition += loopFrames;
        if (meta[PENDING_STOP_MODE] === 2 && wrapped) {
          meta[TRACK_STATE] = STATE_STOPPED;
          meta[PENDING_STOP_MODE] = 0;
        }
      }
      this.playPositions[track] = nextPosition;
      this.playbackFrames[track] += 1;
      meta[PLAY_POSITION] = Math.floor(nextPosition);

      let gain = 1;
      if (this.fadeInRemaining[track] > 0) {
        const total = Math.max(1, meta[FADE_IN_FRAMES]);
        gain *= 1 - this.fadeInRemaining[track] / total;
        this.fadeInRemaining[track] -= 1;
      }
      if (meta[PENDING_STOP_MODE] === 1 && this.fadeOutRemaining[track] > 0) {
        gain *= this.fadeOutRemaining[track] / Math.max(1, this.fadeOutInitial[track]);
        this.fadeOutRemaining[track] -= 1;
        if (this.fadeOutRemaining[track] <= 0) {
          meta[TRACK_STATE] = STATE_STOPPED;
          meta[PENDING_STOP_MODE] = 0;
        }
      }
      outputLeft *= gain;
      outputRight *= gain;
    } else if (state === STATE_REPLACING && meta[TAKE_MODE] === 3) {
      outputLeft = hasInput ? inputLeftValue : 0;
      outputRight = hasInput ? inputRightValue : 0;
    }

    if (leftOut) leftOut[offset] = outputLeft;
    if (rightOut) rightOut[offset] = outputRight;
    if (meta[TRACK_STATE] === STATE_STOPPED && meta[LOOP_FRAMES] > 0) {
      meta[PLAY_POSITION] = Math.floor(this.playPositions[track]);
    }
  }

  readPitchSample(track, sourceFrame, channel) {
    const meta = this.trackMeta[track];
    if (!meta) return 0;
    const loopFrames = meta[LOOP_FRAMES];
    if (loopFrames <= 0 || !Number.isFinite(sourceFrame)) return 0;
    const oneShot = (meta[PLAYBACK_FLAGS] & 1) !== 0;
    if (oneShot && (sourceFrame < 0 || sourceFrame >= loopFrames)) return 0;
    const visibleTakes = this.pitchVisibleTakes[track];
    if (!this.pitchReaderCacheValid[track] || this.pitchReaderCacheFrames[track] !== sourceFrame ||
        this.pitchReaderCacheVisibleTakes[track] !== visibleTakes ||
        this.pitchReaderCacheLoopFrames[track] !== loopFrames) {
      this.readPitchCompositeStereoSample(track, sourceFrame, visibleTakes, loopFrames);
      this.pitchReaderCacheFrames[track] = sourceFrame;
      this.pitchReaderCacheVisibleTakes[track] = visibleTakes;
      this.pitchReaderCacheLoopFrames[track] = loopFrames;
      this.pitchReaderCacheValid[track] = 1;
    }
    return channel === 0 ? this.compositeSampleLeft[track] : this.compositeSampleRight[track];
  }

  readPitchCompositeStereoSample(track, frame, visibleTakes, loopFrames) {
    this.ensurePitchCompositeCacheContext(track, visibleTakes, loopFrames);
    let wrappedFrame = frame % loopFrames;
    if (wrappedFrame < 0) wrappedFrame += loopFrames;
    const firstFrame = Math.floor(wrappedFrame);
    const fraction = wrappedFrame - firstFrame;
    const secondFrame = firstFrame + 1 >= loopFrames ? 0 : firstFrame + 1;
    const scratchOffset = track * 4;
    this.readPitchCompositeIntegerFrame(track, firstFrame, visibleTakes, loopFrames, scratchOffset);
    const firstLeft = this.compositeIntegerScratch[scratchOffset];
    const firstRight = this.compositeIntegerScratch[scratchOffset + 1];
    if (fraction === 0) {
      this.compositeSampleLeft[track] = firstLeft;
      this.compositeSampleRight[track] = firstRight;
      return;
    }
    this.readPitchCompositeIntegerFrame(track, secondFrame, visibleTakes, loopFrames, scratchOffset + 2);
    const secondLeft = this.compositeIntegerScratch[scratchOffset + 2];
    const secondRight = this.compositeIntegerScratch[scratchOffset + 3];
    this.compositeSampleLeft[track] = firstLeft + (secondLeft - firstLeft) * fraction;
    this.compositeSampleRight[track] = firstRight + (secondRight - firstRight) * fraction;
  }

  readPitchCompositeIntegerFrame(track, frame, visibleTakes, loopFrames, scratchOffset) {
    const trackOffset = track * PITCH_COMPOSITE_CACHE_FRAMES;
    const cacheIndex = trackOffset + (frame % PITCH_COMPOSITE_CACHE_FRAMES);
    const frameKey = frame + 1;
    const generation = this.pitchCompositeCacheGeneration[track];
    if (this.pitchCompositeCacheGenerations[cacheIndex] === generation &&
        this.pitchCompositeCacheFrameKeys[cacheIndex] === frameKey) {
      this.compositeIntegerScratch[scratchOffset] = this.pitchCompositeCacheLeft[cacheIndex];
      this.compositeIntegerScratch[scratchOffset + 1] = this.pitchCompositeCacheRight[cacheIndex];
      return;
    }
    this.readCompositeIntegerStereoPair(track, frame, frame, false, visibleTakes, loopFrames, scratchOffset);
    this.pitchCompositeCacheLeft[cacheIndex] = this.compositeIntegerScratch[scratchOffset];
    this.pitchCompositeCacheRight[cacheIndex] = this.compositeIntegerScratch[scratchOffset + 1];
    this.pitchCompositeCacheFrameKeys[cacheIndex] = frameKey;
    this.pitchCompositeCacheGenerations[cacheIndex] = generation;
  }

  ensurePitchCompositeCacheContext(track, visibleTakes, loopFrames) {
    if (this.pitchCompositeCacheVisibleTakes[track] === visibleTakes &&
        this.pitchCompositeCacheLoopFrames[track] === loopFrames) return;
    this.invalidatePitchCompositeCache(track);
    this.pitchCompositeCacheVisibleTakes[track] = visibleTakes;
    this.pitchCompositeCacheLoopFrames[track] = loopFrames;
  }

  invalidatePitchCompositeCache(track) {
    if (!Number.isInteger(track) || track < 0 || track >= TRACK_COUNT) return;
    let generation = (this.pitchCompositeCacheGeneration[track] + 1) >>> 0;
    if (generation === 0) {
      const start = track * PITCH_COMPOSITE_CACHE_FRAMES;
      this.pitchCompositeCacheGenerations.fill(0, start, start + PITCH_COMPOSITE_CACHE_FRAMES);
      generation = 1;
    }
    this.pitchCompositeCacheGeneration[track] = generation;
    this.pitchReaderCacheValid[track] = 0;
  }

  invalidatePitchCompositeFrame(track, frame) {
    const meta = this.trackMeta[track];
    const loopFrames = meta ? meta[LOOP_FRAMES] : 0;
    if (loopFrames <= 0 || !Number.isFinite(frame)) return;
    let wrappedFrame = frame % loopFrames;
    if (wrappedFrame < 0) wrappedFrame += loopFrames;
    if (this.pitchReaderCacheValid[track]) {
      let cachedFrame = this.pitchReaderCacheFrames[track] % loopFrames;
      if (cachedFrame < 0) cachedFrame += loopFrames;
      const firstCachedFrame = Math.floor(cachedFrame);
      const secondCachedFrame = firstCachedFrame + 1 >= loopFrames ? 0 : firstCachedFrame + 1;
      const writtenFrame = Math.floor(wrappedFrame);
      if (firstCachedFrame === writtenFrame || secondCachedFrame === writtenFrame) {
        this.pitchReaderCacheValid[track] = 0;
      }
    }
    const cacheIndex = track * PITCH_COMPOSITE_CACHE_FRAMES +
      (Math.floor(wrappedFrame) % PITCH_COMPOSITE_CACHE_FRAMES);
    this.pitchCompositeCacheGenerations[cacheIndex] = 0;
  }

  resetPitchReader(track, sourceFrame) {
    const meta = this.trackMeta[track];
    if (!meta) return;
    this.pitchReaderCacheValid[track] = 0;
    resetTimeStretchState(this.pitchTimeStretch[track], sourceFrame, this.playbackFrames[track]);
  }

  effectiveSpeed(meta) {
    const manualSpeed = Math.max(0.25, Math.min(4, (meta[SPEED_Q16] || 65536) / 65536));
    if ((meta[TEMPO_SYNC_FLAGS] & 1) === 0) return manualSpeed;
    const recordBpm = meta[RECORD_BPM] / 1000;
    const factor = (meta[TEMPO_SYNC_FACTOR_Q16] || 65536) / 65536;
    const tempoRatio = recordBpm > 0 ? this.bpm / recordBpm : 1;
    return Math.max(0.25, Math.min(4, manualSpeed * factor * tempoRatio));
  }

  recalculateOneShotRemaining(track, meta) {
    if ((meta[PLAYBACK_FLAGS] & 1) === 0 || meta[LOOP_FRAMES] <= 0) return;
    const sourceRemaining = meta[REVERSE] !== 0
      ? this.playPositions[track] + 1
      : Math.max(0, meta[LOOP_FRAMES] - this.playPositions[track]);
    this.oneShotRemaining[track] = Math.ceil(sourceRemaining / this.effectiveSpeed(meta));
  }

  finishAtCapacity(track, frame, slot, writtenFrames) {
    const meta = this.trackMeta[track];
    if (!meta) return;
    const activeIndex = this.takeIndex(track, slot);
    Atomics.add(this.control, TRACK_CAPACITY_OVERRUNS, 1);
    this.storageFailure[activeIndex] = 1;
    if (this.takeModes[activeIndex] === 0 && writtenFrames > 0) {
      this.takeFrames[activeIndex] = writtenFrames;
      meta[LOOP_FRAMES] = writtenFrames;
      meta[HISTORY_CURSOR] = slot + 1;
      meta[HISTORY_LENGTH] = slot + 1;
      meta[TRACK_STATE] = STATE_STOPPED;
      this.notifyTakeCommitted(track, slot, writtenFrames);
    } else {
      meta[TRACK_STATE] = meta[LOOP_FRAMES] > 0 ? STATE_PLAYING : STATE_STOPPED;
    }
    this.port.postMessage({ type: 'TRACK_CAPACITY_REACHED', track, frame, takeSlot: slot, recordedFrames: writtenFrames });
  }

  prepareSteadyPlayback(outputs) {
    if (this.pendingCommandCount > 0 || this.calibrationActive || this.outputMonitorEnabled || this.rhythmRunning) return false;

    for (let track = 0; track < TRACK_COUNT; track += 1) {
      const meta = this.trackMeta[track];
      const dataLeft = this.takeLeft[track][0];
      const dataRight = this.takeRight[track][0];
      const output = outputs[track];
      const left = output && output[0] ? output[0] : null;
      const right = output && output[1] ? output[1] : null;
      if (!meta) return false;
      const state = meta[TRACK_STATE];
      const length = meta ? meta[LOOP_FRAMES] : 0;
      if (meta[HISTORY_CURSOR] > 1) return false;
      if (state !== STATE_PLAYING && state !== STATE_EMPTY && state !== STATE_STOPPED) return false;
      const requiredSegments = length > 0 ? Math.ceil(length / STORAGE_BLOCK_FRAMES) : 0;
      const validatedSegments = this.validatedPrimarySegmentCounts[track];
      let hasRequiredSegments = Boolean(dataLeft && dataRight) && requiredSegments > 0 &&
        requiredSegments <= this.takeSegmentCounts[this.takeIndex(track, 0)];
      for (let segment = validatedSegments; hasRequiredSegments && segment < requiredSegments; segment += 1) {
        if (!dataLeft[segment] || !dataRight[segment]) hasRequiredSegments = false;
      }
      if (hasRequiredSegments && requiredSegments > validatedSegments) {
        this.validatedPrimarySegmentCounts[track] = requiredSegments;
      }
      if (state === STATE_PLAYING && (!dataLeft || !dataRight || !hasRequiredSegments || (!left && !right) || length <= 0 ||
          Math.abs(this.effectiveSpeed(meta) - 1) > 1e-6 || meta[PENDING_STOP_MODE] !== 0 ||
          this.fadeInRemaining[track] > 0 || this.fadeOutRemaining[track] > 0 ||
          (meta[PLAYBACK_FLAGS] & 3) !== 0 || (meta[TEMPO_SYNC_FLAGS] & 3) !== 0 ||
          Math.abs(this.playPositions[track] - Math.round(this.playPositions[track])) > 1e-9)) return false;
      if (state === STATE_PLAYING) {
        const baseIndex = this.takeIndex(track, 0);
        if (!this.takeActive[baseIndex] || this.takeModes[baseIndex] !== 0 || this.takeFrames[baseIndex] < length) return false;
      }

      const rawPosition = this.playPositions[track];
      this.steadyTrackMeta[track] = meta;
      this.steadyTrackDataLeft[track] = state === STATE_PLAYING ? dataLeft : null;
      this.steadyTrackDataRight[track] = state === STATE_PLAYING ? dataRight : null;
      this.steadyTrackLeft[track] = left;
      this.steadyTrackRight[track] = right;
      this.steadyTrackLengths[track] = state === STATE_PLAYING ? length : 0;
      this.steadyTrackPositions[track] = state !== STATE_PLAYING || rawPosition < 0 || rawPosition >= length ? 0 : rawPosition;
      this.steadyTrackSteps[track] = state === STATE_PLAYING && meta[REVERSE] !== 0 ? -1 : 1;
    }

    return true;
  }

  processSteadyPlaybackBlock(outputs, frames, blockStartFrame) {
    const monitor = outputs[5];
    const rhythm = outputs[6];
    if (monitor && monitor[0]) monitor[0].fill(0, 0, frames);
    if (monitor && monitor[1]) monitor[1].fill(0, 0, frames);
    if (rhythm && rhythm[0]) rhythm[0].fill(0, 0, frames);
    if (rhythm && rhythm[1]) rhythm[1].fill(0, 0, frames);

    for (let offset = 0; offset < frames; offset += 1) {
      for (let track = 0; track < TRACK_COUNT; track += 1) {
        const length = this.steadyTrackLengths[track];
        let sampleLeft = 0;
        let sampleRight = 0;
        if (length > 0) {
          const position = this.steadyTrackPositions[track];
          const segment = Math.floor(position / STORAGE_BLOCK_FRAMES);
          const segmentOffset = position - segment * STORAGE_BLOCK_FRAMES;
          sampleLeft = this.steadyTrackDataLeft[track][segment][segmentOffset] || 0;
          sampleRight = this.steadyTrackDataRight[track][segment][segmentOffset] || 0;
          let nextPosition = position + this.steadyTrackSteps[track];
          if (nextPosition >= length) nextPosition = 0;
          else if (nextPosition < 0) nextPosition = length - 1;
          this.steadyTrackPositions[track] = nextPosition;
        }

        const left = this.steadyTrackLeft[track];
        const right = this.steadyTrackRight[track];
        if (left) left[offset] = sampleLeft;
        if (right) right[offset] = sampleRight;
        if (length > 0) {
          this.playPositions[track] = this.steadyTrackPositions[track];
          this.steadyTrackMeta[track][PLAY_POSITION] = this.steadyTrackPositions[track];
          this.playbackFrames[track] += 1;
        }
      }
      if (this.clockRunning) this.renderClockTick(blockStartFrame + offset);
    }
  }

  drainCommands(blockStartFrame) {
    let read = Atomics.load(this.control, COMMAND_READ);
    const write = Atomics.load(this.control, COMMAND_WRITE);
    while (read !== write && this.pendingCommandCount < COMMAND_CAPACITY) {
      const ringOffset = COMMAND_WORD_OFFSET + (read % COMMAND_CAPACITY) * COMMAND_WORDS;
      const sequence = Atomics.load(this.control, ringOffset);
      const opcode = Atomics.load(this.control, ringOffset + 1);
      const track = Atomics.load(this.control, ringOffset + 2);
      const frameLow = Atomics.load(this.control, ringOffset + 3);
      const frameHigh = Atomics.load(this.control, ringOffset + 4);
      const arg0 = Atomics.load(this.control, ringOffset + 5);
      const arg1 = Atomics.load(this.control, ringOffset + 6);
      const flags = Atomics.load(this.control, ringOffset + 7);
      this.insertPendingCommand(sequence, opcode, track, frameLow, frameHigh, arg0, arg1, flags, blockStartFrame);
      read += 1;
    }
    Atomics.store(this.control, COMMAND_READ, read);
  }

  insertPendingCommand(sequence, opcode, track, frameLow, frameHigh, arg0, arg1, flags, blockStartFrame) {
    if (this.pendingCommandCount >= COMMAND_CAPACITY) {
      Atomics.add(this.control, COMMAND_OVERRUNS, 1);
      this.acknowledge(sequence, opcode, track, blockStartFrame, this.frameFromWords(frameLow, frameHigh), STATUS_COMMAND_OVERFLOW, 0, 0);
      return;
    }

    let insertAt = this.pendingCommandCount;
    while (insertAt > 0) {
      const previous = (insertAt - 1) * COMMAND_WORDS;
      const previousFrame = this.frameFromWords(this.pendingCommands[previous + 3], this.pendingCommands[previous + 4]);
      const nextFrame = this.frameFromWords(frameLow, frameHigh);
      if (previousFrame <= nextFrame) break;
      const destination = insertAt * COMMAND_WORDS;
      for (let field = 0; field < COMMAND_WORDS; field += 1) {
        this.pendingCommands[destination + field] = this.pendingCommands[previous + field];
      }
      insertAt -= 1;
    }

    const commandOffset = insertAt * COMMAND_WORDS;
    this.pendingCommands[commandOffset] = sequence;
    this.pendingCommands[commandOffset + 1] = opcode;
    this.pendingCommands[commandOffset + 2] = track;
    this.pendingCommands[commandOffset + 3] = frameLow;
    this.pendingCommands[commandOffset + 4] = frameHigh;
    this.pendingCommands[commandOffset + 5] = arg0;
    this.pendingCommands[commandOffset + 6] = arg1;
    this.pendingCommands[commandOffset + 7] = flags;
    this.pendingCommandCount += 1;
  }

  executeDueCommands(frame) {
    while (this.pendingCommandCount > 0) {
      const target = this.frameFromWords(this.pendingCommands[3], this.pendingCommands[4]);
      if (target > frame) return;

      const sequence = this.pendingCommands[0];
      const opcode = this.pendingCommands[1];
      const track = this.pendingCommands[2];
      const arg0 = this.pendingCommands[5];
      const arg1 = this.pendingCommands[6];
      const flags = this.pendingCommands[7];
      const late = target < frame;
      let status = late ? STATUS_LATE : STATUS_OK;
      let loopFrames = 0;
      let recordingFrames = 0;
      let meta;

      if (opcode === OPCODE_SET_MONITOR) {
        this.outputMonitorEnabled = arg0 !== 0;
        Atomics.store(this.control, OUTPUT_MONITOR_ENABLED, this.outputMonitorEnabled ? 1 : 0);
      } else if (opcode === OPCODE_SET_RHYTHM) {
        this.rhythmRunning = arg0 !== 0;
        this.rhythmPattern = Math.max(0, Math.min(2, arg1));
        if ((flags & 1) !== 0) {
          this.rhythmUsesCustomPattern = false;
          if (this.rhythmUsesCleanRoom) {
            this.sharedDsp?.wasm?.webrc_dsp_extended_rhythm_queue_stop(this.sharedDsp.rhythmHandle);
            this.rhythmUsesCleanRoom = false;
          }
        }
        if (this.rhythmUsesCleanRoom && this.sharedDsp?.rhythmHandle) {
          const rhythmStatus = this.rhythmRunning
          ? (this.cleanRoomRhythmStarted ? 0 : this.sharedDsp.wasm.webrc_dsp_extended_rhythm_start_words(
              this.sharedDsp.rhythmHandle, frame >>> 0,
              Math.floor(frame / 0x1_0000_0000) >>> 0, 1,
            ))
            : this.sharedDsp.wasm.webrc_dsp_extended_rhythm_queue_stop(this.sharedDsp.rhythmHandle);
          if (rhythmStatus !== 0) this.recordSharedDspFailure(SHARED_DSP_FAILURE_KIND.rhythmCommand);
        }
        Atomics.store(this.control, RHYTHM_RUNNING, this.rhythmRunning ? 1 : 0);
        Atomics.store(this.control, RHYTHM_PATTERN, this.rhythmPattern);
        this.rhythmOriginFrame = frame;
        this.rhythmStepOrdinal = 0;
        this.rhythmNextStepFrame = this.rhythmRunning ? frame : -1;
        this.rhythmStep = 0;
      } else if (opcode === OPCODE_SET_MASTER_CLOCK_EPOCH) {
        // A negative milli-BPM is an atomic start-at-epoch request. Positive
        // values only rephase and preserve the current running/stopped state.
        const startsClock = arg0 < 0;
        const requestedBpm = Math.abs(arg0) / 1000;
        const epochOriginFrame = this.float64FromWords(arg1, flags);
        if (!Number.isFinite(requestedBpm) || requestedBpm < 40 || requestedBpm > 300 || !Number.isFinite(epochOriginFrame)) {
          status = STATUS_INVALID_SETTINGS;
        } else {
          const previousBpm = this.bpm;
          this.bpm = requestedBpm;
          Atomics.store(this.control, BPM_WORD, Math.round(this.bpm));

          // The sample-clock phase uses the exact signed/fractional Float64
          // value. Header words are a truncated signed-integer diagnostic only.
          const diagnosticOrigin = Math.trunc(epochOriginFrame);
          const diagnosticHigh = Math.floor(diagnosticOrigin / FRAME_WORD_MODULUS);
          const diagnosticLow = diagnosticOrigin - diagnosticHigh * FRAME_WORD_MODULUS;
          Atomics.store(this.control, MASTER_ORIGIN_LOW, diagnosticLow | 0);
          Atomics.store(this.control, MASTER_ORIGIN_HIGH, diagnosticHigh | 0);

          const elapsedFrames = Math.max(0, frame - epochOriginFrame);
          const beatFrames = sampleRate * 60 / this.bpm;
          const beatOrdinal = Math.ceil(elapsedFrames / beatFrames - 1e-9);
          this.clockOriginFrame = epochOriginFrame;
          this.clockBeatOrdinal = beatOrdinal;
          this.clockNextBeatFrame = Math.round(epochOriginFrame + beatOrdinal * beatFrames);
          if (startsClock) this.clockRunning = true;

          const stepFrames = sampleRate * 60 / (this.bpm * this.rhythmStepsPerBeat);
          const stepOrdinal = Math.ceil(elapsedFrames / stepFrames - 1e-9);
          this.rhythmOriginFrame = epochOriginFrame;
          this.rhythmStepOrdinal = stepOrdinal;
          this.rhythmStep = stepOrdinal % this.rhythmPatternSteps;
          this.rhythmNextStepFrame = this.rhythmRunning
            ? Math.round(epochOriginFrame + stepOrdinal * stepFrames)
            : -1;

          if (Math.abs(this.bpm - previousBpm) > 1e-6) {
            for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
              const trackMeta = this.trackMeta[trackIndex];
              if (!trackMeta) continue;
              this.recalculateOneShotRemaining(trackIndex, trackMeta);
              const keepPitch = (trackMeta[PLAYBACK_FLAGS] & 2) !== 0 || (trackMeta[TEMPO_SYNC_FLAGS] & 2) !== 0;
              if ((trackMeta[TEMPO_SYNC_FLAGS] & 1) !== 0 && keepPitch &&
                  (trackMeta[TRACK_STATE] === STATE_PLAYING || trackMeta[TRACK_STATE] === STATE_OVERDUBBING ||
                   trackMeta[TRACK_STATE] === STATE_REPLACING)) {
                this.resetPitchReader(trackIndex, this.playPositions[trackIndex]);
              }
            }
          }
        }
      } else if (opcode === OPCODE_SET_BPM) {
        const previousBpm = this.bpm;
        const requestedBpm = (flags & 1) !== 0 ? arg0 / 1000 : arg0;
        this.bpm = Math.max(40, Math.min(300, requestedBpm));
        Atomics.store(this.control, BPM_WORD, Math.round(this.bpm));
        if (this.clockRunning) {
          const oldBeatFrames = sampleRate * 60 / previousBpm;
          const phase = Math.max(0, (frame - this.clockOriginFrame) / oldBeatFrames);
          const nextOrdinal = Math.ceil(phase - 1e-9);
          const newBeatFrames = sampleRate * 60 / this.bpm;
          this.clockOriginFrame = frame - phase * newBeatFrames;
          this.clockBeatOrdinal = nextOrdinal;
          this.clockNextBeatFrame = Math.round(this.clockOriginFrame + nextOrdinal * newBeatFrames);
        }
        if (this.rhythmRunning) {
          const oldStepFrames = sampleRate * 60 / (previousBpm * this.rhythmStepsPerBeat);
          const phase = Math.max(0, (frame - this.rhythmOriginFrame) / oldStepFrames);
          const nextOrdinal = Math.ceil(phase - 1e-9);
          const newStepFrames = sampleRate * 60 / (this.bpm * this.rhythmStepsPerBeat);
          this.rhythmOriginFrame = frame - phase * newStepFrames;
          this.rhythmStepOrdinal = nextOrdinal;
          this.rhythmStep = nextOrdinal % this.rhythmPatternSteps;
          this.rhythmNextStepFrame = Math.round(this.rhythmOriginFrame + nextOrdinal * newStepFrames);
        }
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
          const trackMeta = this.trackMeta[trackIndex];
          if (trackMeta) {
            this.recalculateOneShotRemaining(trackIndex, trackMeta);
            if (Math.abs(this.bpm - previousBpm) > 1e-6 &&
                (trackMeta[TEMPO_SYNC_FLAGS] & 1) !== 0 &&
                ((trackMeta[PLAYBACK_FLAGS] & 2) !== 0 || (trackMeta[TEMPO_SYNC_FLAGS] & 2) !== 0) &&
                (trackMeta[TRACK_STATE] === STATE_PLAYING || trackMeta[TRACK_STATE] === STATE_OVERDUBBING ||
                 trackMeta[TRACK_STATE] === STATE_REPLACING)) {
              this.resetPitchReader(trackIndex, this.playPositions[trackIndex]);
            }
          }
        }
      } else if (opcode === OPCODE_SET_CLOCK) {
        this.clockRunning = arg0 !== 0;
        if (this.clockRunning) {
          this.clockOriginFrame = frame;
          this.clockBeatOrdinal = 0;
          this.clockNextBeatFrame = frame;
        } else {
          this.clockNextBeatFrame = -1;
        }
      } else if (opcode === OPCODE_SYNC_EXTERNAL_CLOCK) {
        const previousBpm = this.bpm;
        this.bpm = Math.max(40, Math.min(300, arg0 / 1000));
        Atomics.store(this.control, BPM_WORD, Math.round(this.bpm));
        for (let trackIndex = 0; trackIndex < TRACK_COUNT; trackIndex += 1) {
          const trackMeta = this.trackMeta[trackIndex];
          if (trackMeta) {
            this.recalculateOneShotRemaining(trackIndex, trackMeta);
            if (Math.abs(this.bpm - previousBpm) > 1e-6 &&
                (trackMeta[TEMPO_SYNC_FLAGS] & 1) !== 0 &&
                ((trackMeta[PLAYBACK_FLAGS] & 2) !== 0 || (trackMeta[TEMPO_SYNC_FLAGS] & 2) !== 0) &&
                (trackMeta[TRACK_STATE] === STATE_PLAYING || trackMeta[TRACK_STATE] === STATE_OVERDUBBING ||
                 trackMeta[TRACK_STATE] === STATE_REPLACING)) {
              this.resetPitchReader(trackIndex, this.playPositions[trackIndex]);
            }
          }
        }
        this.clockRunning = true;
        const beatOrdinal = Math.max(0, arg1);
        const beatFrames = sampleRate * 60 / this.bpm;
        const stepFrames = sampleRate * 60 / (this.bpm * this.rhythmStepsPerBeat);
        const phaseFrame = target;
        this.clockOriginFrame = phaseFrame - beatOrdinal * beatFrames;
        this.clockBeatOrdinal = beatOrdinal;
        this.clockNextBeatFrame = phaseFrame;
        this.rhythmOriginFrame = phaseFrame - beatOrdinal * this.rhythmStepsPerBeat * stepFrames;
        this.rhythmStepOrdinal = beatOrdinal * this.rhythmStepsPerBeat;
        this.rhythmStep = this.rhythmStepOrdinal % this.rhythmPatternSteps;
        this.rhythmNextStepFrame = this.rhythmRunning ? phaseFrame : -1;
      } else {
        const validTrack = Number.isInteger(track) && track >= 0 && track < TRACK_COUNT;
        meta = validTrack ? this.trackMeta[track] : null;
        if (!validTrack) {
          status = STATUS_INVALID_TRACK;
        } else if (!meta) {
          status = STATUS_MISSING_TRACK_STORAGE;
        } else if (opcode === OPCODE_SET_ALIGNMENT) {
          meta[ALIGNMENT_SAMPLES] = arg0;
        } else if (opcode === OPCODE_SET_REVERSE) {
          meta[REVERSE] = arg0 !== 0 ? 1 : 0;
          this.recalculateOneShotRemaining(track, meta);
          this.resetPitchReader(track, this.playPositions[track]);
        } else if (opcode === OPCODE_SET_SPEED) {
        if (arg0 < 16384 || arg0 > 262144) status = STATUS_INVALID_SETTINGS;
        else {
          meta[SPEED_Q16] = arg0;
          meta[PLAYBACK_FLAGS] = (meta[PLAYBACK_FLAGS] & ~2) | (arg1 !== 0 ? 2 : 0);
          this.recalculateOneShotRemaining(track, meta);
          this.resetPitchReader(track, this.playPositions[track]);
        }
      } else if (opcode === OPCODE_SET_ONE_SHOT) {
        meta[PLAYBACK_FLAGS] = (meta[PLAYBACK_FLAGS] & ~1) | (arg0 !== 0 ? 1 : 0);
        this.recalculateOneShotRemaining(track, meta);
        this.resetPitchReader(track, this.playPositions[track]);
        } else if (opcode === OPCODE_SET_STOP_MODE) {
          if (arg0 < 0 || arg0 > 2) status = STATUS_INVALID_SETTINGS;
          else meta[STOP_MODE] = arg0;
        } else if (opcode === OPCODE_SET_START_MODE) {
          if (arg0 < 0 || arg0 > 1) status = STATUS_INVALID_SETTINGS;
          else meta[START_MODE] = arg0;
        } else if (opcode === OPCODE_SET_FADE) {
          if (arg0 < 0 || arg1 < 0) status = STATUS_INVALID_SETTINGS;
          else {
            meta[FADE_IN_FRAMES] = arg0;
            meta[FADE_OUT_FRAMES] = arg1;
          }
        } else if (opcode === OPCODE_SET_AUTO_REC) {
          if (arg1 < 0 || arg1 > 32767 || flags < 1) status = STATUS_INVALID_SETTINGS;
          else {
            meta[PLAYBACK_FLAGS] = (meta[PLAYBACK_FLAGS] & ~4) | (arg0 !== 0 ? 4 : 0);
            meta[AUTO_REC_THRESHOLD_Q15] = arg1;
            meta[AUTO_REC_DEBOUNCE_FRAMES] = flags;
          }
        } else if (opcode === OPCODE_SET_DUB_MODE) {
          if (arg0 < 1 || arg0 > 3) status = STATUS_INVALID_SETTINGS;
          else meta[TAKE_MODE] = arg0;
        } else if (opcode === OPCODE_SET_RECORD_BPM) {
          if (arg0 !== 0 && (arg0 < 40000 || arg0 > 300000)) status = STATUS_INVALID_SETTINGS;
          else {
            const previousSpeed = this.effectiveSpeed(meta);
            meta[RECORD_BPM] = arg0;
            this.recalculateOneShotRemaining(track, meta);
            if (Math.abs(this.effectiveSpeed(meta) - previousSpeed) > 1e-6 &&
                (meta[TRACK_STATE] === STATE_PLAYING || meta[TRACK_STATE] === STATE_OVERDUBBING || meta[TRACK_STATE] === STATE_REPLACING) &&
                ((meta[PLAYBACK_FLAGS] & 2) !== 0 || ((meta[TEMPO_SYNC_FLAGS] & 3) === 3))) {
              this.resetPitchReader(track, this.playPositions[track]);
            }
          }
        } else if (opcode === OPCODE_SET_TEMPO_SYNC) {
          const supportedFactor = arg1 === 32768 || arg1 === 65536 || arg1 === 131072;
          if ((arg0 !== 0 && arg0 !== 1) || !supportedFactor || (flags !== 0 && flags !== 1)) {
            status = STATUS_INVALID_SETTINGS;
          } else {
            const previousFlags = meta[TEMPO_SYNC_FLAGS];
            const previousSpeed = this.effectiveSpeed(meta);
            meta[TEMPO_SYNC_FACTOR_Q16] = arg1;
            meta[TEMPO_SYNC_FLAGS] = (arg0 !== 0 ? 1 : 0) | (flags === 1 ? 2 : 0);
            this.recalculateOneShotRemaining(track, meta);
            const previousKeepPitch = (meta[PLAYBACK_FLAGS] & 2) !== 0 || (previousFlags & 3) === 3;
            const nextKeepPitch = (meta[PLAYBACK_FLAGS] & 2) !== 0 || (meta[TEMPO_SYNC_FLAGS] & 3) === 3;
            if ((Math.abs(this.effectiveSpeed(meta) - previousSpeed) > 1e-6 || previousKeepPitch !== nextKeepPitch) &&
                (meta[TRACK_STATE] === STATE_PLAYING || meta[TRACK_STATE] === STATE_OVERDUBBING || meta[TRACK_STATE] === STATE_REPLACING) &&
                nextKeepPitch) {
              this.resetPitchReader(track, this.playPositions[track]);
            }
          }
        } else if (opcode === OPCODE_START_RECORD) {
          const slot = meta[ACTIVE_TAKE_SLOT];
          const takeIndex = this.takeIndex(track, slot);
          const autoRecArmed = (meta[PLAYBACK_FLAGS] & 4) !== 0;
          if (!this.takeActive[takeIndex] || this.takeModes[takeIndex] !== 0 || meta[HISTORY_CURSOR] !== slot ||
              (meta[TRACK_STATE] !== STATE_EMPTY && meta[TRACK_STATE] !== STATE_STOPPED)) {
            status = STATUS_INVALID_STATE;
          } else {
            this.takeFrames[takeIndex] = 0;
            const takeMeta = this.takeMeta[track][slot];
            if (takeMeta) {
              takeMeta[RECORDING_FRAMES] = 0;
              if (!autoRecArmed) takeMeta[LOOP_FRAMES] = 0;
            }
            if (!autoRecArmed) meta[LOOP_FRAMES] = 0;
            meta[RECORDING_FRAMES] = 0;
            meta[PENDING_STOP_MODE] = 0;
            this.autoRecCounters[track] = 0;
            this.autoRecEnvelopes[track] = 0;
            this.playbackFrames[track] = 0;
            this.oneShotRemaining[track] = 0;
            if (!autoRecArmed) meta[RECORD_BPM] = Math.round(this.bpm * 1000);
            this.resetPitchReader(track, autoRecArmed ? this.playPositions[track] : 0);
            meta[TRACK_STATE] = autoRecArmed ? STATE_REC_STANDBY : STATE_RECORDING;
            this.storeTrackStartFrame(meta, frame);
          }
        } else if (opcode === OPCODE_STOP_RECORD) {
          if (meta[TRACK_STATE] !== STATE_RECORDING) {
            status = STATUS_INVALID_STATE;
          } else {
            const slot = meta[ACTIVE_TAKE_SLOT];
            recordingFrames = meta[RECORDING_FRAMES];
            if (recordingFrames <= 0) {
              status = STATUS_INVALID_STATE;
              meta[TRACK_STATE] = meta[HISTORY_CURSOR] > 0 ? STATE_STOPPED : STATE_EMPTY;
            } else {
            this.commitTake(track, slot, recordingFrames);
            loopFrames = recordingFrames;
            this.playPositions[track] = meta[REVERSE] !== 0 ? loopFrames - 1 : 0;
            this.playbackFrames[track] = 0;
            this.recalculateOneShotRemaining(track, meta);
              meta[PLAY_POSITION] = Math.floor(this.playPositions[track]);
              this.resetPitchReader(track, this.playPositions[track]);
              meta[TRACK_STATE] = arg0 !== 0 ? STATE_PLAYING : STATE_STOPPED;
              meta[PENDING_STOP_MODE] = 0;
              if (arg0 !== 0 && meta[START_MODE] === 1 && meta[FADE_IN_FRAMES] > 0) this.fadeInRemaining[track] = meta[FADE_IN_FRAMES];
            }
          }
        } else if (opcode === OPCODE_PLAY) {
          if (meta[LOOP_FRAMES] <= 0 || meta[HISTORY_CURSOR] <= 0) {
            status = STATUS_INVALID_STATE;
          } else {
            if (arg0 !== 0) {
              this.playPositions[track] = (flags & 1) !== 0
                ? Math.max(0, Math.min(meta[LOOP_FRAMES] - 1, arg1))
                : meta[REVERSE] !== 0 ? meta[LOOP_FRAMES] - 1 : 0;
              this.playbackFrames[track] = 0;
              this.recalculateOneShotRemaining(track, meta);
              this.resetPitchReader(track, this.playPositions[track]);
            }
            meta[PLAY_POSITION] = Math.floor(this.playPositions[track]);
            meta[TRACK_STATE] = STATE_PLAYING;
            meta[PENDING_STOP_MODE] = 0;
            this.fadeOutRemaining[track] = 0;
            if (meta[START_MODE] === 1 && meta[FADE_IN_FRAMES] > 0) this.fadeInRemaining[track] = meta[FADE_IN_FRAMES];
          }
        } else if (opcode === OPCODE_STOP) {
          const state = meta[TRACK_STATE];
          if (state === STATE_RECORDING || state === STATE_REC_STANDBY || state === STATE_OVERDUBBING || state === STATE_REPLACING) {
            status = STATUS_INVALID_STATE;
          } else if (meta[PENDING_STOP_MODE] !== 0) {
            meta[TRACK_STATE] = meta[LOOP_FRAMES] > 0 ? STATE_STOPPED : STATE_EMPTY;
            meta[PENDING_STOP_MODE] = 0;
            this.fadeOutRemaining[track] = 0;
          } else if (meta[STOP_MODE] === 2 && state === STATE_PLAYING) {
            meta[PENDING_STOP_MODE] = 2;
          } else if (meta[STOP_MODE] === 1 && state === STATE_PLAYING && meta[FADE_OUT_FRAMES] > 0) {
            meta[PENDING_STOP_MODE] = 1;
            this.fadeOutRemaining[track] = meta[FADE_OUT_FRAMES];
            this.fadeOutInitial[track] = meta[FADE_OUT_FRAMES];
          } else {
            meta[TRACK_STATE] = meta[LOOP_FRAMES] > 0 ? STATE_STOPPED : STATE_EMPTY;
          }
        } else if (opcode === OPCODE_START_OVERDUB) {
          const slot = meta[ACTIVE_TAKE_SLOT];
          const takeIndex = this.takeIndex(track, slot);
          if (meta[TRACK_STATE] !== STATE_PLAYING || meta[LOOP_FRAMES] <= 0 || (meta[PLAYBACK_FLAGS] & 1) !== 0 ||
              meta[PENDING_STOP_MODE] !== 0 || !this.takeActive[takeIndex] || this.takeModes[takeIndex] === 0 ||
              slot !== meta[HISTORY_CURSOR]) {
            status = STATUS_INVALID_STATE;
          } else {
            this.takeFrames[takeIndex] = meta[LOOP_FRAMES];
            this.takeModes[takeIndex] = meta[TAKE_MODE];
            const takeMeta = this.takeMeta[track][slot];
            if (takeMeta) {
              takeMeta[RECORDING_FRAMES] = 0;
              takeMeta[LOOP_FRAMES] = meta[LOOP_FRAMES];
              takeMeta[TAKE_MODE] = meta[TAKE_MODE];
            }
            meta[TRACK_STATE] = meta[TAKE_MODE] === 2 || meta[TAKE_MODE] === 3 ? STATE_REPLACING : STATE_OVERDUBBING;
          }
        } else if (opcode === OPCODE_STOP_OVERDUB) {
          if (meta[TRACK_STATE] !== STATE_OVERDUBBING && meta[TRACK_STATE] !== STATE_REPLACING) {
            status = STATUS_INVALID_STATE;
          } else {
            const slot = meta[ACTIVE_TAKE_SLOT];
            this.commitTake(track, slot, meta[LOOP_FRAMES]);
            meta[TRACK_STATE] = STATE_PLAYING;
          }
        } else if (opcode === OPCODE_CLEAR) {
          this.invalidatePitchCompositeCache(track);
          meta[TRACK_STATE] = STATE_EMPTY;
          meta[LOOP_FRAMES] = 0;
          meta[RECORDING_FRAMES] = 0;
          meta[PLAY_POSITION] = 0;
          meta[HISTORY_CURSOR] = 0;
          meta[HISTORY_LENGTH] = 0;
          meta[MARK_CURSOR] = -1;
          meta[MARK_POSITION] = 0;
          meta[MARK_STATE] = STATE_EMPTY;
          meta[ACTIVE_TAKE_SLOT] = 0;
          meta[PENDING_STOP_MODE] = 0;
          meta[RECORD_BPM] = 0;
          this.playPositions[track] = 0;
          this.playbackFrames[track] = 0;
          this.oneShotRemaining[track] = 0;
          this.fadeInRemaining[track] = 0;
          this.fadeOutRemaining[track] = 0;
          this.isClearedByCommand = true;
        } else if (opcode === OPCODE_CANCEL_PENDING) {
          this.cancelPendingTrackCommands(track, frame);
          if (meta[TRACK_STATE] === STATE_REC_STANDBY) meta[TRACK_STATE] = meta[LOOP_FRAMES] > 0 ? STATE_STOPPED : STATE_EMPTY;
          else if (meta[PENDING_STOP_MODE] !== 0) {
            meta[TRACK_STATE] = meta[LOOP_FRAMES] > 0 ? STATE_STOPPED : STATE_EMPTY;
            meta[PENDING_STOP_MODE] = 0;
            this.fadeOutRemaining[track] = 0;
          }
        } else if (opcode === OPCODE_EXPORT_TRACK) {
          if (meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_REC_STANDBY ||
              meta[TRACK_STATE] === STATE_OVERDUBBING || meta[TRACK_STATE] === STATE_REPLACING) status = STATUS_INVALID_STATE;
        } else if (opcode === OPCODE_UNDO || opcode === OPCODE_REDO || opcode === OPCODE_MARK ||
            opcode === OPCODE_RESTORE_MARK || opcode === OPCODE_RESET_BACK || opcode === OPCODE_CLEAR_MARK) {
          if (meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_REC_STANDBY ||
              meta[TRACK_STATE] === STATE_OVERDUBBING || meta[TRACK_STATE] === STATE_REPLACING) {
            status = STATUS_INVALID_STATE;
          } else if (opcode === OPCODE_UNDO) {
            if (meta[HISTORY_CURSOR] <= 0) status = STATUS_NO_UNDO;
            else meta[HISTORY_CURSOR] -= 1;
          } else if (opcode === OPCODE_REDO) {
            if (meta[HISTORY_CURSOR] >= meta[HISTORY_LENGTH]) status = STATUS_NO_REDO;
            else meta[HISTORY_CURSOR] += 1;
          } else if (opcode === OPCODE_MARK) {
            meta[MARK_CURSOR] = meta[HISTORY_CURSOR];
            meta[MARK_POSITION] = Math.floor(this.playPositions[track]);
            meta[MARK_STATE] = meta[TRACK_STATE];
          } else if (opcode === OPCODE_RESTORE_MARK) {
            const cursor = meta[MARK_CURSOR] >= 0 ? meta[MARK_CURSOR] : Math.min(1, meta[HISTORY_LENGTH]);
            meta[HISTORY_CURSOR] = cursor;
            meta[PLAY_POSITION] = meta[MARK_CURSOR] >= 0 ? meta[MARK_POSITION] : 0;
            this.playPositions[track] = meta[PLAY_POSITION];
          } else if (opcode === OPCODE_RESET_BACK) {
            meta[HISTORY_CURSOR] = Math.min(1, meta[HISTORY_LENGTH]);
            meta[PLAY_POSITION] = 0;
            this.playPositions[track] = 0;
          } else {
            meta[MARK_CURSOR] = -1;
          }
          if (status === STATUS_OK || status === STATUS_LATE) {
            if (opcode !== OPCODE_MARK && opcode !== OPCODE_CLEAR_MARK) {
              this.invalidatePitchCompositeCache(track);
              meta[TRACK_STATE] = meta[HISTORY_CURSOR] > 0 ? STATE_STOPPED : STATE_EMPTY;
              this.updateVisibleLoopFrames(track);
              this.resetPitchReader(track, this.playPositions[track]);
            }
          }
        } else if (opcode === OPCODE_LOAD_TRACK) {
          const slot = arg1;
          const takeIndex = this.takeIndex(track, slot);
          const capacity = this.takeSegmentCounts[takeIndex] * STORAGE_BLOCK_FRAMES;
          if (meta[TRACK_STATE] === STATE_RECORDING || meta[TRACK_STATE] === STATE_OVERDUBBING ||
              slot !== meta[HISTORY_CURSOR] || arg0 <= 0 || arg0 > capacity || !this.takeActive[takeIndex]) {
            status = STATUS_LOAD_INVALID;
          } else {
            this.takeModes[takeIndex] = 0;
            this.takeFrames[takeIndex] = arg0;
            meta[RECORD_BPM] = 0;
            const takeMeta = this.takeMeta[track][slot];
            if (takeMeta) {
              takeMeta[RECORDING_FRAMES] = arg0;
              takeMeta[LOOP_FRAMES] = arg0;
              takeMeta[TAKE_MODE] = 0;
            }
            this.commitTake(track, slot, arg0);
            meta[TRACK_STATE] = STATE_STOPPED;
            this.playPositions[track] = 0;
            this.resetPitchReader(track, 0);
            // LOAD_TRACK is acknowledged before this callback's final state
            // publication pass. Publish the authoritative shared UI state
            // before the ACK so a caller can immediately issue PLAY without
            // observing the stale EMPTY value from the prior take.
            Atomics.store(this.control, TRACK_STATES_WORD_OFFSET + track, this.toUiState(STATE_STOPPED));
            if (this.notifiedTrackStates[track] !== STATE_STOPPED) {
              this.notifiedTrackStates[track] = STATE_STOPPED;
              this.port.postMessage({ type: 'TRACK_STATE_CHANGED', track, state: STATE_STOPPED, frame });
            }
          }
        } else {
          status = STATUS_INVALID_STATE;
        }
        if (meta) {
          loopFrames = meta[LOOP_FRAMES];
          recordingFrames = meta[RECORDING_FRAMES];
        }
      }

      this.acknowledge(sequence, opcode, track, frame, target, status, loopFrames, recordingFrames);
      this.removeFirstPendingCommand();
    }
  }

  commitTake(track, slot, frames) {
    const meta = this.trackMeta[track];
    if (!meta || slot < 0 || slot >= MAX_HISTORY_TAKES) return;
    const index = this.takeIndex(track, slot);
    this.invalidatePitchCompositeCache(track);
    const boundedFrames = Math.max(0, Math.min(frames, this.takeSegmentCounts[index] * STORAGE_BLOCK_FRAMES));
    this.takeFrames[index] = boundedFrames;
    this.takeActive[index] = boundedFrames > 0 ? 1 : 0;
    const takeMeta = this.takeMeta[track][slot];
    if (takeMeta) {
      takeMeta[RECORDING_FRAMES] = boundedFrames;
      takeMeta[LOOP_FRAMES] = boundedFrames;
      takeMeta[TAKE_MODE] = this.takeModes[index];
    }
    meta[HISTORY_CURSOR] = slot + 1;
    meta[HISTORY_LENGTH] = slot + 1;
    meta[ACTIVE_TAKE_SLOT] = slot;
    if (this.takeModes[index] === 0) meta[LOOP_FRAMES] = boundedFrames;
    this.updateVisibleLoopFrames(track);
    this.notifyTakeCommitted(track, slot, boundedFrames);
  }

  notifyTakeCommitted(track, slot, frameCount) {
    const meta = this.trackMeta[track];
    if (!meta) return;
    this.port.postMessage({
      type: 'TAKE_COMMITTED', track, takeSlot: slot,
      mode: this.takeModes[this.takeIndex(track, slot)], frameCount,
      historyCursor: meta[HISTORY_CURSOR], historyLength: meta[HISTORY_LENGTH],
    });
  }

  updateVisibleLoopFrames(track) {
    const meta = this.trackMeta[track];
    if (!meta) return;
    const cursor = meta[HISTORY_CURSOR];
    let loopFrames = 0;
    let baseSlot = -1;
    for (let slot = cursor - 1; slot >= 0; slot -= 1) {
      const index = this.takeIndex(track, slot);
      if (this.takeActive[index] && this.takeModes[index] === 0) {
        loopFrames = this.takeFrames[index];
        baseSlot = slot;
        break;
      }
    }
    this.historyBaseSlots[track] = baseSlot;
    meta[LOOP_FRAMES] = loopFrames;
    if (loopFrames <= 0) {
      meta[PLAY_POSITION] = 0;
      this.playPositions[track] = 0;
      meta[TRACK_STATE] = STATE_EMPTY;
    } else if (this.playPositions[track] >= loopFrames) {
      this.playPositions[track] %= loopFrames;
      meta[PLAY_POSITION] = Math.floor(this.playPositions[track]);
    }
  }

  removeFirstPendingCommand() {
    this.pendingCommandCount -= 1;
    for (let index = 0; index < this.pendingCommandCount * COMMAND_WORDS; index += 1) {
      this.pendingCommands[index] = this.pendingCommands[index + COMMAND_WORDS];
    }
  }

  cancelPendingTrackCommands(track, frame) {
    let index = 1;
    while (index < this.pendingCommandCount) {
      const offset = index * COMMAND_WORDS;
      const pendingTrack = this.pendingCommands[offset + 2];
      const pendingOpcode = this.pendingCommands[offset + 1];
      const targetFrame = this.frameFromWords(this.pendingCommands[offset + 3], this.pendingCommands[offset + 4]);
      const canCancel = pendingTrack === track && targetFrame > frame &&
        (pendingOpcode === OPCODE_START_RECORD || pendingOpcode === OPCODE_STOP_RECORD);
      if (!canCancel) {
        index += 1;
        continue;
      }

      this.acknowledge(
        this.pendingCommands[offset],
        pendingOpcode,
        track,
        frame,
        targetFrame,
        STATUS_CANCELLED,
        0,
        0,
      );
      this.pendingCommandCount -= 1;
      const end = this.pendingCommandCount * COMMAND_WORDS;
      for (let word = offset; word < end; word += 1) {
        this.pendingCommands[word] = this.pendingCommands[word + COMMAND_WORDS];
      }
    }
  }

  acknowledge(sequence, opcode, track, frame, targetFrame, status, loopFrames, recordingFrames) {
    this.storeFrame(LAST_ACK_FRAME_SEQUENCE, LAST_ACK_FRAME_LOW, LAST_ACK_FRAME_HIGH, frame);
    Atomics.store(this.control, LAST_ACK_SEQUENCE, sequence);
    this.port.postMessage({
      type: 'ACK',
      sequence: sequence >>> 0,
      opcode,
      track,
      executedFrame: frame,
      targetFrame,
      status,
      loopFrames,
      recordingFrames,
    });
  }

  stageRhythmUpdate(message) {
    const requestId = Number(message.requestId) >>> 0;
    const reject = (reason) => this.port.postMessage({
      type: 'RHYTHM_UPDATE_ACK', requestId, ok: false, message: reason,
    });
    if (requestId === 0) {
      reject('Rhythm update requires a non-zero request id.');
      return;
    }
    if (this.pendingRhythmRequestId !== 0) {
      this.port.postMessage({
        type: 'RHYTHM_UPDATE_ACK', requestId: this.pendingRhythmRequestId,
        ok: false, message: 'Rhythm update was superseded before its step boundary.',
      });
      this.pendingRhythmRequestId = 0;
    }

    const hasPattern = message.type === 'LOAD_RHYTHM_PATTERN' || message.type === 'LOAD_RHYTHM_SNAPSHOT';
    const hasKit = message.type === 'LOAD_RHYTHM_KIT' || message.type === 'LOAD_RHYTHM_SNAPSHOT';
    const pattern = message.type === 'LOAD_RHYTHM_SNAPSHOT' ? message.pattern : message;
    const kit = message.type === 'LOAD_RHYTHM_SNAPSHOT' ? message.kit : message;
    if (hasPattern) {
      const steps = Number(pattern && pattern.steps);
      const stepsPerBeat = Number(pattern && pattern.stepsPerBeat);
      const velocities = pattern && pattern.velocities;
      if (!Number.isInteger(steps) || steps < 1 || steps > 64 ||
          !Number.isInteger(stepsPerBeat) || stepsPerBeat < 1 || stepsPerBeat > 8 ||
          !(velocities instanceof Float32Array) || velocities.length !== 192) {
        reject('Rhythm pattern payload is outside its bounded v1 layout.');
        return;
      }
      for (let index = 0; index < velocities.length; index += 1) {
        const value = velocities[index];
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          reject('Rhythm pattern velocities must be finite and normalized.');
          return;
        }
      }
      this.rhythmPatternStaging.set(velocities);
      this.rhythmPatternStagingSteps = steps;
      this.rhythmPatternStagingStepsPerBeat = stepsPerBeat;
    }
    if (hasKit) {
      const parameters = kit && kit.parameters;
      if (!(parameters instanceof Float32Array) || parameters.length !== 12) {
        reject('Rhythm kit payload must contain twelve bounded parameters.');
        return;
      }
      for (let voice = 0; voice < 3; voice += 1) {
        const offset = voice * 4;
        const pitchHz = parameters[offset];
        const decayMs = parameters[offset + 1];
        const noiseAmount = parameters[offset + 2];
        const toneGain = parameters[offset + 3];
        if (!Number.isFinite(pitchHz) || pitchHz < 20 || pitchHz > 12_000 ||
            !Number.isFinite(decayMs) || decayMs < 1 || decayMs > 10_000 ||
            !Number.isFinite(noiseAmount) || noiseAmount < 0 || noiseAmount > 1 ||
            !Number.isFinite(toneGain) || toneGain < 0 || toneGain > 2) {
          reject('Rhythm kit values are outside their supported ranges.');
          return;
        }
      }
      this.rhythmKitStaging.set(parameters);
    }

    if (this.rhythmUsesCleanRoom && this.sharedDsp?.rhythmHandle) {
      this.sharedDsp.wasm.webrc_dsp_extended_rhythm_queue_stop(this.sharedDsp.rhythmHandle);
      this.rhythmUsesCleanRoom = false;
    }

    this.pendingRhythmPattern = hasPattern;
    this.pendingRhythmKit = hasKit;
    this.pendingRhythmRequestId = requestId;
    if (!this.rhythmRunning) this.applyPendingRhythm(currentFrame);
  }

  applyPendingRhythm(frame) {
    const requestId = this.pendingRhythmRequestId;
    if (requestId === 0) return;
    if (this.pendingRhythmPattern) {
      const previousStepFrames = sampleRate * 60 / (this.bpm * this.rhythmStepsPerBeat);
      const beatFrames = sampleRate * 60 / this.bpm;
      const beatPhase = this.rhythmRunning && previousStepFrames > 0
        ? Math.max(0, (frame - this.rhythmOriginFrame) / previousStepFrames / this.rhythmStepsPerBeat)
        : 0;
      const oldActive = this.rhythmPatternVelocities;
      this.rhythmPatternVelocities = this.rhythmPatternStaging;
      this.rhythmPatternStaging = oldActive;
      this.rhythmPatternSteps = this.rhythmPatternStagingSteps;
      this.rhythmStepsPerBeat = this.rhythmPatternStagingStepsPerBeat;
      this.rhythmUsesCustomPattern = true;
      if (this.rhythmRunning) {
        const nextOrdinal = Math.ceil(beatPhase * this.rhythmStepsPerBeat - 1e-9);
        const newStepFrames = beatFrames / this.rhythmStepsPerBeat;
        this.rhythmOriginFrame = frame - beatPhase * beatFrames;
        this.rhythmStepOrdinal = nextOrdinal;
        this.rhythmStep = nextOrdinal % this.rhythmPatternSteps;
        this.rhythmNextStepFrame = Math.round(this.rhythmOriginFrame + nextOrdinal * newStepFrames);
      } else {
        this.rhythmStepOrdinal = 0;
        this.rhythmStep = 0;
        this.rhythmNextStepFrame = -1;
      }
    }
    if (this.pendingRhythmKit) {
      const oldActive = this.rhythmKitParameters;
      this.rhythmKitParameters = this.rhythmKitStaging;
      this.rhythmKitStaging = oldActive;
      this.refreshRhythmDecayCoefficients(this.rhythmKitParameters);
    }
    this.pendingRhythmPattern = false;
    this.pendingRhythmKit = false;
    this.pendingRhythmRequestId = 0;
    this.port.postMessage({ type: 'RHYTHM_UPDATE_ACK', requestId, ok: true, appliedFrame: frame });
  }

  refreshRhythmDecayCoefficients(parameters) {
    for (let voice = 0; voice < 3; voice += 1) {
      const decayMs = parameters[voice * 4 + 1];
      this.rhythmDecayCoefficients[voice] = Math.exp(-1 / Math.max(1, sampleRate * decayMs / 1000));
    }
  }

  renderRhythmSample(frame) {
    if (!this.rhythmRunning) return 0;
    if (this.rhythmNextStepFrame < 0) this.rhythmNextStepFrame = frame;
    if (frame >= this.rhythmNextStepFrame) {
      this.applyPendingRhythm(frame);
      this.triggerRhythmStep(this.rhythmPattern, this.rhythmStep);
      this.rhythmStepOrdinal += 1;
      this.rhythmStep = this.rhythmStepOrdinal % this.rhythmPatternSteps;
      this.rhythmNextStepFrame = this.rhythmOriginFrame + Math.round(
        this.rhythmStepOrdinal * sampleRate * 60 / (this.bpm * this.rhythmStepsPerBeat),
      );
    }

    let sample = 0;
    if (this.kickEnvelope > 0.00001) {
      this.kickPhase += TWO_PI * this.kickFrequency / sampleRate;
      if (this.kickPhase > TWO_PI) this.kickPhase -= TWO_PI;
      const settings = this.rhythmKitParameters;
      const toneGain = settings[3];
      const noiseAmount = settings[2];
      const kickNoise = noiseAmount > 0 ? this.nextNoise() : 0;
      sample += (Math.sin(this.kickPhase) * toneGain + kickNoise * noiseAmount) * this.kickEnvelope;
      this.kickEnvelope *= this.rhythmDecayCoefficients[0];
    }

    if (this.snareEnvelope > 0.00001) {
      const settings = this.rhythmKitParameters;
      this.snareTonePhase += TWO_PI * settings[4] / sampleRate;
      if (this.snareTonePhase > TWO_PI) this.snareTonePhase -= TWO_PI;
      const noise = this.nextNoise();
      this.snareFilterState += 0.08 * (noise - this.snareFilterState);
      const highNoise = noise - this.snareFilterState;
      sample += (highNoise * settings[6] + Math.sin(this.snareTonePhase) * settings[7]) * this.snareEnvelope;
      this.snareEnvelope *= this.rhythmDecayCoefficients[1];
    }

    if (this.hihatEnvelope > 0.00001) {
      const settings = this.rhythmKitParameters;
      const noise = this.nextNoise();
      const cutoffCoefficient = Math.min(1, TWO_PI * settings[8] / sampleRate);
      this.hihatFilterState += cutoffCoefficient * (noise - this.hihatFilterState);
      this.hihatTonePhase += TWO_PI * settings[8] / sampleRate;
      if (this.hihatTonePhase > TWO_PI) this.hihatTonePhase -= TWO_PI;
      sample += ((noise - this.hihatFilterState) * settings[10] +
        Math.sin(this.hihatTonePhase) * settings[11]) * this.hihatEnvelope;
      this.hihatEnvelope *= this.rhythmDecayCoefficients[2];
    }

    return sample;
  }

  triggerRhythmStep(pattern, step) {
    let kick;
    let snare;
    let hihat = 0;
    if (this.rhythmUsesCustomPattern) {
      const boundedStep = step % this.rhythmPatternSteps;
      kick = this.rhythmPatternVelocities[boundedStep] ?? 0;
      snare = this.rhythmPatternVelocities[64 + boundedStep] ?? 0;
      hihat = this.rhythmPatternVelocities[128 + boundedStep] ?? 0;
    } else if (pattern === 0) {
      kick = step === 0 || step === 6 || step === 8 ? 1 : 0;
      snare = step === 4 || step === 12 ? 1 : 0;
      hihat = (step & 1) === 0 ? 0.7 : 0;
    } else if (pattern === 1) {
      kick = step === 0 || step === 4 || step === 8 || step === 12 ? 1 : 0;
      snare = step === 4 || step === 12 ? 1 : 0;
      hihat = step === 2 || step === 6 || step === 10 || step === 14 ? 0.7 : 0;
    } else {
      kick = step === 0 ? 1 : 0;
      snare = step === 4 || step === 8 || step === 12 ? 1 : 0;
    }

    if (kick > 0) {
      this.kickEnvelope = Math.max(this.kickEnvelope, kick);
      this.kickFrequency = this.rhythmKitParameters[0];
    }
    if (snare > 0) this.snareEnvelope = Math.max(this.snareEnvelope, snare);
    if (hihat > 0) this.hihatEnvelope = Math.max(this.hihatEnvelope, hihat);
  }

  renderClockTick(frame) {
    if (!this.clockRunning) return;
    if (this.clockNextBeatFrame < 0) this.clockNextBeatFrame = frame;
    if (frame >= this.clockNextBeatFrame) {
      this.port.postMessage({
        type: 'CLOCK_TICK',
        beatOrdinal: this.clockBeatOrdinal,
        frame,
      });
      this.clockBeatOrdinal += 1;
      this.clockNextBeatFrame = this.clockOriginFrame + Math.round(this.clockBeatOrdinal * sampleRate * 60 / this.bpm);
    }
  }

  nextNoise() {
    let state = this.noiseState;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.noiseState = state;
    return ((state >>> 0) / 2147483648) - 1;
  }

  toUiState(state) {
    if (state === STATE_REC_STANDBY) return 1;
    if (state === STATE_RECORDING) return 2;
    if (state === STATE_REC_FINISHING) return 3;
    if (state === STATE_PLAYING) return 4;
    if (state === STATE_OVERDUBBING) return 5;
    if (state === STATE_STOPPED) return 6;
    if (state === STATE_REPLACING) return 7;
    return 0;
  }

  storeFrame(sequenceWord, lowWord, highWord, frame) {
    const sequence = Atomics.load(this.control, sequenceWord);
    const odd = (sequence & 1) === 0 ? sequence + 1 : sequence + 2;
    Atomics.store(this.control, sequenceWord, odd);
    const high = Math.floor(frame / FRAME_WORD_MODULUS);
    const low = frame - high * FRAME_WORD_MODULUS;
    Atomics.store(this.control, lowWord, low | 0);
    Atomics.store(this.control, highWord, high | 0);
    Atomics.store(this.control, sequenceWord, odd + 1);
  }

  storeTrackStartFrame(meta, frame) {
    const high = Math.floor(frame / FRAME_WORD_MODULUS);
    const low = frame - high * FRAME_WORD_MODULUS;
    meta[RECORD_START_LOW] = low | 0;
    meta[RECORD_START_HIGH] = high | 0;
  }

  float64FromWords(low, high) {
    this.clockEpochWordView.setInt32(0, low | 0, true);
    this.clockEpochWordView.setInt32(4, high | 0, true);
    return this.clockEpochWordView.getFloat64(0, true);
  }

  frameFromWords(low, high) {
    return (high >>> 0) * FRAME_WORD_MODULUS + (low >>> 0);
  }
}

registerProcessor('webrc505-realtime', BrowserLooperProcessor);
