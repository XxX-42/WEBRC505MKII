export const BROWSER_REALTIME_WORKLET_NAME = 'webrc505-realtime';
export const BROWSER_REALTIME_SAMPLE_RATE = 48_000;
export const BROWSER_REALTIME_QUANTUM_FRAMES = 128;
export const BROWSER_REALTIME_TRACK_COUNT = 5;
export const BROWSER_REALTIME_LAYOUT_VERSION = 2;
export const BROWSER_REALTIME_WORKLET_URL = `/worklets/looper-processor.js?layout=${BROWSER_REALTIME_LAYOUT_VERSION}`;
export const BROWSER_REALTIME_TRACK_CHANNEL_COUNT = 2;
export const BROWSER_REALTIME_LAYOUT_MONO = 0;
export const BROWSER_REALTIME_LAYOUT_PLANAR_LR = 1;
export const BROWSER_REALTIME_MAX_TRACK_SECONDS = 180;
export const BROWSER_REALTIME_MAX_TRACK_FRAMES =
  BROWSER_REALTIME_SAMPLE_RATE * BROWSER_REALTIME_MAX_TRACK_SECONDS;
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

export const TRACK_META_BYTES = 64;
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
  MASTER_ORIGIN_LOW: 17,
  MASTER_ORIGIN_HIGH: 18,
  TRACK_CAPACITY_OVERRUNS: 19,
  DEADLINE_METRIC_AVAILABLE: 20,
  INPUT_DROPOUT_BLOCKS: 21,
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
}

export function createControlSharedBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(CONTROL_BUFFER_BYTE_LENGTH);
}

export function createTrackSharedBuffer(
  capacityFrames = BROWSER_REALTIME_MAX_TRACK_FRAMES,
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
  let before = 0;
  let low = 0;
  let high = 0;
  let after = 0;
  do {
    before = Atomics.load(view, sequenceWord);
    if (before & 1) continue;
    low = Atomics.load(view, lowWord);
    high = Atomics.load(view, highWord);
    after = Atomics.load(view, sequenceWord);
  } while (before !== after || (after & 1) !== 0);
  return frameFromWords(low, high);
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
