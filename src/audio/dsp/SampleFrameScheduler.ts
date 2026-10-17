/** A fixed-capacity, allocation-free scheduler for events on an audio frame clock. */
export class SampleFrameScheduler {
  readonly capacity: number;

  currentFrame: number;
  blockStartFrame = 0;
  blockEndFrame = 0;
  eventFrame = 0;
  eventCode = 0;
  eventValue = 0;
  droppedEvents = 0;

  private count = 0;
  private blockActive = false;
  private readonly eventFrames: Float64Array;
  private readonly eventCodes: Int32Array;
  private readonly eventValues: Float64Array;

  constructor(capacity: number, initialFrame = 0) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }
    if (!Number.isFinite(initialFrame)) throw new RangeError('initialFrame must be finite');
    this.capacity = capacity;
    this.currentFrame = Math.max(0, Math.floor(initialFrame));
    this.eventFrames = new Float64Array(capacity);
    this.eventCodes = new Int32Array(capacity);
    this.eventValues = new Float64Array(capacity);
  }

  get queuedCount(): number {
    return this.count;
  }

  /** Inserts events in frame order; equal-frame events retain insertion order. */
  scheduleAtFrame(frame: number, code: number, value = 0): boolean {
    if (
      !Number.isInteger(frame) ||
      !Number.isInteger(code) ||
      !Number.isFinite(value) ||
      frame < this.currentFrame
    ) {
      return false;
    }
    if (this.count === this.capacity) {
      this.droppedEvents += 1;
      return false;
    }

    const scheduledFrame = frame;
    let insertionIndex = this.count;
    while (insertionIndex > 0 && this.eventFrames[insertionIndex - 1]! > scheduledFrame) {
      this.eventFrames[insertionIndex] = this.eventFrames[insertionIndex - 1]!;
      this.eventCodes[insertionIndex] = this.eventCodes[insertionIndex - 1]!;
      this.eventValues[insertionIndex] = this.eventValues[insertionIndex - 1]!;
      insertionIndex -= 1;
    }
    this.eventFrames[insertionIndex] = scheduledFrame;
    this.eventCodes[insertionIndex] = code;
    this.eventValues[insertionIndex] = value;
    this.count += 1;
    return true;
  }

  peekNextFrame(): number | null {
    return this.count > 0 ? this.eventFrames[0]! : null;
  }

  /** Starts a half-open processing interval [currentFrame, currentFrame + frameCount). */
  beginBlock(frameCount: number): boolean {
    if (!Number.isInteger(frameCount) || frameCount < 0 || this.blockActive) return false;
    this.blockStartFrame = this.currentFrame;
    this.blockEndFrame = this.currentFrame + frameCount;
    this.blockActive = true;
    return true;
  }

  /** Sample offset of the next event in the active block, or -1 if none is due. */
  nextEventOffset(): number {
    if (!this.blockActive || this.count === 0) return -1;
    const frame = this.eventFrames[0]!;
    if (frame < this.blockStartFrame || frame >= this.blockEndFrame) return -1;
    return frame - this.blockStartFrame;
  }

  /** Removes the next queued event and copies its scalar payload to public fields. */
  dequeueNextEvent(): boolean {
    if (this.count === 0) return false;
    this.eventFrame = this.eventFrames[0]!;
    this.eventCode = this.eventCodes[0]!;
    this.eventValue = this.eventValues[0]!;
    this.count -= 1;
    for (let index = 0; index < this.count; index += 1) {
      this.eventFrames[index] = this.eventFrames[index + 1]!;
      this.eventCodes[index] = this.eventCodes[index + 1]!;
      this.eventValues[index] = this.eventValues[index + 1]!;
    }
    return true;
  }

  endBlock(): boolean {
    if (!this.blockActive) return false;
    // Keep a due event visible if the caller forgot to process it this block.
    if (this.count > 0 && this.eventFrames[0]! < this.blockEndFrame) return false;
    this.currentFrame = this.blockEndFrame;
    this.blockActive = false;
    return true;
  }

  /** Advances the frame cursor outside a block interval. */
  advanceFrames(frameCount: number): boolean {
    if (!Number.isInteger(frameCount) || frameCount < 0 || this.blockActive) return false;
    this.currentFrame += frameCount;
    return true;
  }
}
