export const BROWSER_REALTIME_WORKLET_NAME = 'webrc505-realtime';
export const BROWSER_REALTIME_SAMPLE_RATE = 48_000;
export const BROWSER_REALTIME_QUANTUM_FRAMES = 128;
export const BROWSER_REALTIME_TRACK_COUNT = 5;
// v4 changes SET_MASTER_CLOCK_EPOCH's arg1/flags payload to an exact Float64
// phase origin. Bind the Worklet URL to this version so cached v3 processors
// cannot ACK the new command while interpreting its origin as integer words.
export const BROWSER_REALTIME_LAYOUT_VERSION = 4;
export const BROWSER_REALTIME_WORKLET_URL = `/worklets/looper-processor.js?layout=${BROWSER_REALTIME_LAYOUT_VERSION}`;
export const BROWSER_REALTIME_TRACK_CHANNEL_COUNT = 2;
export const BROWSER_REALTIME_LAYOUT_MONO = 0;
export const BROWSER_REALTIME_LAYOUT_PLANAR_LR = 1;
export const BROWSER_REALTIME_STORAGE_BLOCK_FRAMES = 16_384;
/** Eight bounded storage blocks reserve about 2.73 seconds at the 48 kHz baseline. */
export const BROWSER_REALTIME_STORAGE_BATCH_BLOCKS = 8;
export const BROWSER_REALTIME_STORAGE_BATCH_FRAMES =
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * BROWSER_REALTIME_STORAGE_BATCH_BLOCKS;
export const BROWSER_REALTIME_INITIAL_TRACK_FRAMES = BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
export const BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE = 4_096;
export const BROWSER_REALTIME_MAX_HISTORY_TAKES = 32;
export const BROWSER_REALTIME_MAX_STORAGE_BYTES = 512 * 1024 * 1024;
/** Upper per-track frame boundary; storage is allocated in bounded blocks on demand. */
export const BROWSER_REALTIME_MAX_TRACK_FRAMES =
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE;
export const BROWSER_REALTIME_STORAGE_LOW_WATERMARK_FRAMES =
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * 4;
export const BROWSER_REALTIME_COMMAND_CAPACITY = 256;
export const BROWSER_REALTIME_COMMAND_WORDS = 8;

export const CONTROL_HEADER_BYTES = 96;
export const CONTROL_COMMANDS_BYTE_OFFSET = CONTROL_HEADER_BYTES;
export const CONTROL_COMMANDS_WORD_OFFSET = CONTROL_COMMANDS_BYTE_OFFSET / Int32Array.BYTES_PER_ELEMENT;
export const CONTROL_COMMANDS_BYTE_LENGTH =
  BROWSER_REALTIME_COMMAND_CAPACITY * BROWSER_REALTIME_COMMAND_WORDS * Int32Array.BYTES_PER_ELEMENT;
export const CONTROL_TRACK_STATES_BYTE_OFFSET = CONTROL_COMMANDS_BYTE_OFFSET + CONTROL_COMMANDS_BYTE_LENGTH;
export const CONTROL_TRACK_POSITIONS_BYTE_OFFSET =
  CONTROL_TRACK_STATES_BYTE_OFFSET + BROWSER_REALTIME_TRACK_COUNT * Int32Array.BYTES_PER_ELEMENT;
export const CONTROL_BUFFER_BYTE_LENGTH =
  CONTROL_TRACK_POSITIONS_BYTE_OFFSET + BROWSER_REALTIME_TRACK_COUNT * Float32Array.BYTES_PER_ELEMENT;

export const TRACK_META_BYTES = 128;
export const TRACK_META_WORDS = TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT;

export const ControlWord = {
  COMMAND_READ: 0,
  COMMAND_WRITE: 1,
  RENDER_FRAME_SEQUENCE: 2,
  RENDER_FRAME_LOW: 3,
  RENDER_FRAME_HIGH: 4,
  UNDERRUNS: 5,
  LAST_ACK_SEQUENCE: 6,
  LAST_ACK_FRAME_SEQUENCE: 7,
  LAST_ACK_FRAME_LOW: 8,
  LAST_ACK_FRAME_HIGH: 9,
  OUTPUT_MONITOR_ENABLED: 10,
  BPM: 11,
  RHYTHM_RUNNING: 12,
  RHYTHM_PATTERN: 13,
  COMMAND_OVERRUNS: 14,
  DEADLINE_MISSES: 15,
  LAST_QUANTUM_FRAMES: 16,
  // Signed integer diagnostics only. The authoritative master clock epoch is
  // a Float64 in the SET_MASTER_CLOCK_EPOCH command payload and can be fractional.
  MASTER_ORIGIN_LOW: 17,
  MASTER_ORIGIN_HIGH: 18,
  TRACK_CAPACITY_OVERRUNS: 19,
  DEADLINE_METRIC_AVAILABLE: 20,
  INPUT_DROPOUT_BLOCKS: 21,
  INPUT_DROPOUT_FRAMES: 22,
} as const;

export const TrackMetaWord = {
  STATE: 0,
  LOOP_FRAMES: 1,
  RECORDING_FRAMES: 2,
  PLAY_POSITION: 3,
  CAPACITY_FRAMES: 4,
  RECORD_START_LOW: 5,
  RECORD_START_HIGH: 6,
  REVERSE: 7,
  ALIGNMENT_SAMPLES: 8,
  CHANNEL_COUNT: 9,
  LAYOUT_VERSION: 10,
  STORAGE_LAYOUT: 11,
  HISTORY_CURSOR: 12,
  HISTORY_LENGTH: 13,
  MARK_CURSOR: 14,
  MARK_POSITION: 15,
  MARK_STATE: 16,
  TAKE_MODE: 17,
  SPEED_Q16: 18,
  PLAYBACK_FLAGS: 19,
  STOP_MODE: 20,
  START_MODE: 21,
  FADE_IN_FRAMES: 22,
  FADE_OUT_FRAMES: 23,
  AUTO_REC_THRESHOLD_Q15: 24,
  AUTO_REC_DEBOUNCE_FRAMES: 25,
  ACTIVE_TAKE_SLOT: 26,
  PENDING_STOP_MODE: 27,
  RECORD_BPM: 28,
  PENDING_RECORD_FRAMES: 29,
  GAIN_Q16: 30,
  TEMPO_SYNC_FACTOR_Q16: 30,
  TEMPO_SYNC_FLAGS: 31,
} as const;

export const BrowserRealtimeOpcode = {
  START_RECORD: 1,
  STOP_RECORD: 2,
  PLAY: 3,
  STOP: 4,
  START_OVERDUB: 5,
  STOP_OVERDUB: 6,
  CLEAR: 7,
  SET_REVERSE: 8,
  SET_MONITOR: 9,
  SET_RHYTHM: 10,
  SET_BPM: 11,
  SET_CLOCK: 12,
  EXPORT_TRACK: 13,
  SET_ALIGNMENT: 14,
  CANCEL_PENDING: 15,
  UNDO: 16,
  REDO: 17,
  MARK: 18,
  RESTORE_MARK: 19,
  RESET_BACK: 20,
  SET_SPEED: 21,
  SET_ONE_SHOT: 22,
  SET_STOP_MODE: 23,
  SET_FADE: 24,
  SET_AUTO_REC: 25,
  SET_DUB_MODE: 26,
  SET_START_MODE: 27,
  SET_RECORD_BPM: 28,
  LOAD_TRACK: 29,
  CLEAR_MARK: 30,
  SYNC_EXTERNAL_CLOCK: 31,
  SET_TEMPO_SYNC: 32,
  SET_MASTER_CLOCK_EPOCH: 33,
} as const;

export const BrowserRealtimeStatus = {
  OK: 0,
  LATE: 1,
  MISSING_TRACK_STORAGE: 2,
  TRACK_CAPACITY_REACHED: 3,
  INVALID_STATE: 4,
  COMMAND_OVERFLOW: 5,
  CANCELLED: 6,
  INVALID_TRACK: 7,
  NO_UNDO: 8,
  NO_REDO: 9,
  NO_MARK: 10,
  HISTORY_FULL: 11,
  LOAD_INVALID: 12,
  STORAGE_LIMIT: 13,
  INVALID_SETTINGS: 14,
} as const;

export interface BrowserRealtimeCommand {
  sequence: number;
  opcode: number;
  track: number;
  targetFrame: number;
  arg0?: number;
  arg1?: number;
  flags?: number;
}

export interface BrowserRealtimeAck {
  sequence: number;
  opcode: number;
  track: number;
  intentFrame: number;
  executedFrame: number;
  targetFrame: number;
  intentToScheduledFrames: number;
  scheduledToActualFrames: number;
  intentToScheduledMs: number;
  scheduledToActualMs: number;
  status: number;
  loopFrames: number;
  recordingFrames: number;
  historyCursor?: number;
  historyLength?: number;
  markCursor?: number;
  markPosition?: number;
}

export interface BrowserRealtimeMetrics {
  sampleRate: number;
  quantumFrames: number;
  renderedFrame: number;
  underruns: number;
  commandQueueDepth: number;
  loopFrames: number[];
  recordingFrames: number[];
  trackStates: number[];
  trackPositions: number[];
  outputMonitorEnabled: boolean;
  backendMode: 'sab-worklet';
  lastAckSequence: number;
  commandOverruns: number;
  processDeadlineMisses: number | null;
  deadlineMetricAvailable: boolean;
  inputDropoutBlocks: number;
  trackCapacityOverruns: number;
  maxTrackFrames: number;
  trackCapacityFrames: number[];
  inputDropoutFrames: number;
  storageAllocatedBytes: number;
  storageGrowthRequests: number;
  storageGrowthFailures: number;
  historyDepth: number[];
  storageSegments: number[];
}

export function createControlSharedBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(CONTROL_BUFFER_BYTE_LENGTH);
}

export function createTrackSharedBuffer(
  capacityFrames = BROWSER_REALTIME_INITIAL_TRACK_FRAMES,
): SharedArrayBuffer {
  if (!Number.isSafeInteger(capacityFrames) || capacityFrames <= 0) {
    throw new RangeError('Track storage capacity must be a positive safe integer.');
  }
  const buffer = new SharedArrayBuffer(
    TRACK_META_BYTES + capacityFrames * BROWSER_REALTIME_TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT,
  );
  initializeTrackStorageMetadata(buffer, capacityFrames, BROWSER_REALTIME_TRACK_CHANNEL_COUNT, BROWSER_REALTIME_LAYOUT_PLANAR_LR);
  return buffer;
}

/** A bounded planar LR take segment with a per-frame written mask for replace modes. */
export function createTakeSegmentBuffer(capacityFrames = BROWSER_REALTIME_STORAGE_BLOCK_FRAMES): SharedArrayBuffer {
  if (!Number.isSafeInteger(capacityFrames) || capacityFrames <= 0) {
    throw new RangeError('Take segment capacity must be a positive safe integer.');
  }
  const sampleBytes = capacityFrames * BROWSER_REALTIME_TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT;
  const buffer = new SharedArrayBuffer(TRACK_META_BYTES + sampleBytes + capacityFrames);
  initializeTrackStorageMetadata(buffer, capacityFrames, BROWSER_REALTIME_TRACK_CHANNEL_COUNT, BROWSER_REALTIME_LAYOUT_PLANAR_LR);
  return buffer;
}

/** Mono capture storage is reserved for loopback calibration and is never attached as a loop track. */
export function createMonoLoopbackSharedBuffer(capacityFrames: number): SharedArrayBuffer {
  if (!Number.isSafeInteger(capacityFrames) || capacityFrames <= 0) {
    throw new RangeError('Loopback capture capacity must be a positive safe integer.');
  }
  const buffer = new SharedArrayBuffer(TRACK_META_BYTES + capacityFrames * Float32Array.BYTES_PER_ELEMENT);
  initializeTrackStorageMetadata(buffer, capacityFrames, 1, BROWSER_REALTIME_LAYOUT_MONO);
  return buffer;
}

function initializeTrackStorageMetadata(
  buffer: SharedArrayBuffer,
  capacityFrames: number,
  channelCount: number,
  layout: number,
): void {
  const metadata = new Int32Array(buffer, 0, TRACK_META_WORDS);
  Atomics.store(metadata, TrackMetaWord.CAPACITY_FRAMES, capacityFrames);
  Atomics.store(metadata, TrackMetaWord.CHANNEL_COUNT, channelCount);
  Atomics.store(metadata, TrackMetaWord.LAYOUT_VERSION, BROWSER_REALTIME_LAYOUT_VERSION);
  Atomics.store(metadata, TrackMetaWord.STORAGE_LAYOUT, layout);
}

export function frameToWords(frame: number): [low: number, high: number] {
  const safeFrame = Number.isFinite(frame) && frame > 0 ? Math.floor(frame) : 0;
  const high = Math.floor(safeFrame / 0x1_0000_0000);
  const low = safeFrame - high * 0x1_0000_0000;
  return [low | 0, high | 0];
}

export function frameFromWords(low: number, high: number): number {
  return (high >>> 0) * 0x1_0000_0000 + (low >>> 0);
}

export function loadSharedFrame(view: Int32Array, sequenceWord: number, lowWord: number, highWord: number): number {
  while (true) {
    const before = Atomics.load(view, sequenceWord);
    if (before & 1) continue;
    const low = Atomics.load(view, lowWord);
    const high = Atomics.load(view, highWord);
    const after = Atomics.load(view, sequenceWord);
    if (before === after && (after & 1) === 0) return frameFromWords(low, high);
  }
}

export function storeSharedFrame(view: Int32Array, sequenceWord: number, lowWord: number, highWord: number, frame: number) {
  const sequence = Atomics.load(view, sequenceWord);
  const oddSequence = (sequence & 1) === 0 ? sequence + 1 : sequence + 2;
  Atomics.store(view, sequenceWord, oddSequence);
  const [low, high] = frameToWords(frame);
  Atomics.store(view, lowWord, low);
  Atomics.store(view, highWord, high);
  Atomics.store(view, sequenceWord, oddSequence + 1);
}

export function queueSharedCommand(view: Int32Array, command: BrowserRealtimeCommand): boolean {
  const read = Atomics.load(view, ControlWord.COMMAND_READ);
  const write = Atomics.load(view, ControlWord.COMMAND_WRITE);
  const depth = (write - read) >>> 0;
  if (depth >= BROWSER_REALTIME_COMMAND_CAPACITY) {
    Atomics.add(view, ControlWord.COMMAND_OVERRUNS, 1);
    return false;
  }

  const slot = write % BROWSER_REALTIME_COMMAND_CAPACITY;
  const offset = CONTROL_COMMANDS_WORD_OFFSET + slot * BROWSER_REALTIME_COMMAND_WORDS;
  const [frameLow, frameHigh] = frameToWords(command.targetFrame);

  Atomics.store(view, offset, command.sequence | 0);
  Atomics.store(view, offset + 1, command.opcode | 0);
  Atomics.store(view, offset + 2, command.track | 0);
  Atomics.store(view, offset + 3, frameLow);
  Atomics.store(view, offset + 4, frameHigh);
  Atomics.store(view, offset + 5, command.arg0 ?? 0);
  Atomics.store(view, offset + 6, command.arg1 ?? 0);
  Atomics.store(view, offset + 7, command.flags ?? 0);
  Atomics.store(view, ControlWord.COMMAND_WRITE, write + 1);
  return true;
}
