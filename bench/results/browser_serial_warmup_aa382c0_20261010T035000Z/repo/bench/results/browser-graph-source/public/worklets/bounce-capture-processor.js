const HEADER_WORDS = 80;
const HEADER_BYTES = HEADER_WORDS * Int32Array.BYTES_PER_ELEMENT;
const MAGIC = 0x42434d50;
const VERSION = 1;
const STATE = 2;
const WRITE_SEQUENCE = 3;
const READ_SEQUENCE = 4;
const TARGET_FRAMES = 5;
const CAPTURED_FRAMES = 6;
const START_FRAME_LOW = 7;
const START_FRAME_HIGH = 8;
const ERROR = 9;
const CHUNK_FRAMES = 10;
const SLOT_COUNT = 11;
const SLOT_LENGTHS = 16;
const RUNNING = 1;
const COMPLETE = 2;
const FAILED = 3;
const CANCELLED = 4;
const INVALID_BUFFER = 1;
const RING_OVERFLOW = 2;

class BounceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options && options.processorOptions || {};
    const buffer = processorOptions.buffer;
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
      this.header = null;
      this.samples = null;
      return;
    }
    const header = new Int32Array(buffer, 0, HEADER_WORDS);
    const chunkFrames = Atomics.load(header, CHUNK_FRAMES);
    const slotCount = Atomics.load(header, SLOT_COUNT);
    const targetFrames = Atomics.load(header, TARGET_FRAMES);
    const startFrame = (Atomics.load(header, START_FRAME_HIGH) >>> 0) * 0x1_0000_0000 +
      (Atomics.load(header, START_FRAME_LOW) >>> 0);
    const expectedBytes = HEADER_BYTES + slotCount * chunkFrames * 2 * Float32Array.BYTES_PER_ELEMENT;
    if (Atomics.load(header, 0) !== MAGIC || Atomics.load(header, 1) !== VERSION ||
        !Number.isInteger(chunkFrames) || chunkFrames < 1 || chunkFrames > 16_384 ||
        !Number.isInteger(slotCount) || slotCount < 2 || slotCount > 64 ||
        !Number.isInteger(targetFrames) || targetFrames < 1 || targetFrames >= 0x7fffffff ||
        !Number.isSafeInteger(startFrame) || startFrame < 0 || buffer.byteLength !== expectedBytes ||
        processorOptions.targetFrames !== targetFrames || processorOptions.startFrame !== startFrame) {
      Atomics.store(header, ERROR, INVALID_BUFFER);
      Atomics.store(header, STATE, FAILED);
      this.header = null;
      this.samples = null;
      return;
    }

    this.header = header;
    this.samples = new Float32Array(buffer, HEADER_BYTES);
    this.chunkFrames = chunkFrames;
    this.slotCount = slotCount;
    this.targetFrames = targetFrames;
    this.startFrame = startFrame;
    this.capturedFrames = 0;
    this.partialFrames = 0;
    this.port.onmessage = (event) => {
      if (event && event.data && event.data.type === 'CANCEL' && this.header) {
        Atomics.store(this.header, STATE, CANCELLED);
      }
    };
    Atomics.store(this.header, STATE, RUNNING);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      if (output[0]) output[0].fill(0);
      if (output[1]) output[1].fill(0);
    }
    const header = this.header;
    if (!header) return false;
    const state = Atomics.load(header, STATE);
    if (state !== RUNNING) return false;

    const input = inputs[0];
    const leftInput = input && input[0];
    const rightInput = input && (input[1] || input[0]);
    const frames = output && output[0] ? output[0].length : leftInput ? leftInput.length : 128;
    let writeSequence = Atomics.load(header, WRITE_SEQUENCE);
    let offset = Math.max(0, this.startFrame - currentFrame);
    if (offset > frames) offset = frames;

    for (; offset < frames && this.capturedFrames < this.targetFrames; offset += 1) {
      if (this.partialFrames === 0) {
        const readSequence = Atomics.load(header, READ_SEQUENCE);
        if ((writeSequence - readSequence) >>> 0 >= this.slotCount) {
          Atomics.store(header, ERROR, RING_OVERFLOW);
          Atomics.store(header, STATE, FAILED);
          return false;
        }
      }
      const slot = writeSequence % this.slotCount;
      const slotOffset = slot * this.chunkFrames * 2;
      const writeOffset = this.partialFrames;
      this.samples[slotOffset + writeOffset] = leftInput ? leftInput[offset] : 0;
      this.samples[slotOffset + this.chunkFrames + writeOffset] = rightInput ? rightInput[offset] : 0;
      this.partialFrames += 1;
      this.capturedFrames += 1;

      if (this.partialFrames === this.chunkFrames || this.capturedFrames === this.targetFrames) {
        Atomics.store(header, SLOT_LENGTHS + slot, this.partialFrames);
        writeSequence = (writeSequence + 1) >>> 0;
        Atomics.store(header, WRITE_SEQUENCE, writeSequence);
        this.partialFrames = 0;
      }
    }

    Atomics.store(header, CAPTURED_FRAMES, this.capturedFrames);
    if (this.capturedFrames >= this.targetFrames) {
      Atomics.store(header, STATE, COMPLETE);
      return false;
    }
    return true;
  }
}

registerProcessor('webrc505mk2-bounce-capture', BounceCaptureProcessor);
