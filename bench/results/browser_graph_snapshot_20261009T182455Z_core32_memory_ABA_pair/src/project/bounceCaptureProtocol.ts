export const BOUNCE_CAPTURE_MAGIC = 0x42434d50;
export const BOUNCE_CAPTURE_VERSION = 1;
export const BOUNCE_CAPTURE_HEADER_WORDS = 80;
export const BOUNCE_CAPTURE_HEADER_BYTES = BOUNCE_CAPTURE_HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
export const BOUNCE_CAPTURE_CHUNK_FRAMES = 1_024;
export const BOUNCE_CAPTURE_RING_SLOTS = 8;

export const BounceCaptureWord = {
  MAGIC: 0,
  VERSION: 1,
  STATE: 2,
  WRITE_SEQUENCE: 3,
  READ_SEQUENCE: 4,
  TARGET_FRAMES: 5,
  CAPTURED_FRAMES: 6,
  START_FRAME_LOW: 7,
  START_FRAME_HIGH: 8,
  ERROR: 9,
  CHUNK_FRAMES: 10,
  SLOT_COUNT: 11,
  SLOT_LENGTHS: 16,
} as const;

export const BounceCaptureState = {
  IDLE: 0,
  RUNNING: 1,
  COMPLETE: 2,
  FAILED: 3,
  CANCELLED: 4,
} as const;

export const BounceCaptureError = {
  NONE: 0,
  INVALID_BUFFER: 1,
  RING_OVERFLOW: 2,
} as const;

export interface BounceCaptureBufferOptions {
  targetFrames: number;
  startFrame: number;
  chunkFrames?: number;
  slotCount?: number;
}

export function createBounceCaptureBuffer({
  targetFrames,
  startFrame,
  chunkFrames = BOUNCE_CAPTURE_CHUNK_FRAMES,
  slotCount = BOUNCE_CAPTURE_RING_SLOTS,
}: BounceCaptureBufferOptions): SharedArrayBuffer {
  if (!Number.isSafeInteger(targetFrames) || targetFrames < 1 || targetFrames >= 0x7fffffff) {
    throw new RangeError('Bounce capture target must be a positive frame count below 2^31.');
  }
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
    throw new RangeError('Bounce capture start frame must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > 16_384 ||
      !Number.isSafeInteger(slotCount) || slotCount < 2 || slotCount > 64) {
    throw new RangeError('Bounce capture ring dimensions are outside their bounded limits.');
  }
  const byteLength = BOUNCE_CAPTURE_HEADER_BYTES + slotCount * chunkFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(byteLength)) throw new RangeError('Bounce capture ring byte length overflowed.');
  const buffer = new SharedArrayBuffer(byteLength);
  const header = new Int32Array(buffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
  header[BounceCaptureWord.MAGIC] = BOUNCE_CAPTURE_MAGIC;
  header[BounceCaptureWord.VERSION] = BOUNCE_CAPTURE_VERSION;
  header[BounceCaptureWord.STATE] = BounceCaptureState.IDLE;
  header[BounceCaptureWord.TARGET_FRAMES] = targetFrames;
  header[BounceCaptureWord.START_FRAME_LOW] = startFrame | 0;
  header[BounceCaptureWord.START_FRAME_HIGH] = Math.floor(startFrame / 0x1_0000_0000) | 0;
  header[BounceCaptureWord.CHUNK_FRAMES] = chunkFrames;
  header[BounceCaptureWord.SLOT_COUNT] = slotCount;
  return buffer;
}

export function assertBounceCaptureBuffer(
  buffer: SharedArrayBuffer,
  expected?: Pick<BounceCaptureBufferOptions, 'targetFrames' | 'startFrame'>,
): asserts buffer is SharedArrayBuffer {
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < BOUNCE_CAPTURE_HEADER_BYTES) {
    throw new TypeError('Bounce capture requires a versioned SharedArrayBuffer.');
  }
  const header = new Int32Array(buffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
  const targetFrames = Atomics.load(header, BounceCaptureWord.TARGET_FRAMES);
  const chunkFrames = Atomics.load(header, BounceCaptureWord.CHUNK_FRAMES);
  const slotCount = Atomics.load(header, BounceCaptureWord.SLOT_COUNT);
  const byteLength = BOUNCE_CAPTURE_HEADER_BYTES + slotCount * chunkFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
  if (Atomics.load(header, BounceCaptureWord.MAGIC) !== BOUNCE_CAPTURE_MAGIC ||
      Atomics.load(header, BounceCaptureWord.VERSION) !== BOUNCE_CAPTURE_VERSION ||
      !Number.isInteger(targetFrames) || targetFrames < 1 || targetFrames >= 0x7fffffff ||
      !Number.isInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > 16_384 ||
      !Number.isInteger(slotCount) || slotCount < 2 || slotCount > 64 ||
      buffer.byteLength !== byteLength ||
      (expected && (targetFrames !== expected.targetFrames || readStartFrame(header) !== expected.startFrame))) {
    throw new TypeError('Bounce capture SharedArrayBuffer header or ring bounds are invalid.');
  }
}

export function readStartFrame(header: Int32Array): number {
  const low = Atomics.load(header, BounceCaptureWord.START_FRAME_LOW) >>> 0;
  const high = Atomics.load(header, BounceCaptureWord.START_FRAME_HIGH) >>> 0;
  return high * 0x1_0000_0000 + low;
}
