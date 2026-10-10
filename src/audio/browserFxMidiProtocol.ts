import type { FxMidiInputEvent } from './nativeFxProtocol';

/** Shared Browser-to-Worklet MIDI transport. One SPSC ring is owned by each Worklet. */
export const BROWSER_FX_MIDI_RING_VERSION = 1;
export const BROWSER_FX_MIDI_RING_CAPACITY = 64;
export const BROWSER_FX_MIDI_HEADER_WORDS = 8;
export const BROWSER_FX_MIDI_SLOT_WORDS = 6;

const WRITE_SEQUENCE = 0;
const READ_SEQUENCE = 1;
const DROPPED_EVENTS = 2;
const LAST_FRAME_LOW = 3;
const LAST_FRAME_HIGH = 4;
const HAS_LAST_FRAME = 5;
const RING_MAGIC = 0x46584d31;

const TYPE_TO_WIRE: Readonly<Record<FxMidiInputEvent['type'], number>> = Object.freeze({
  NoteOn: 0,
  NoteOff: 1,
  AllNotesOff: 2,
});

export function createBrowserFxMidiBuffer(): SharedArrayBuffer {
  const byteLength = (BROWSER_FX_MIDI_HEADER_WORDS + BROWSER_FX_MIDI_RING_CAPACITY * BROWSER_FX_MIDI_SLOT_WORDS) * 4;
  const buffer = new SharedArrayBuffer(byteLength);
  const header = new Int32Array(buffer, 0, BROWSER_FX_MIDI_HEADER_WORDS);
  Atomics.store(header, 6, BROWSER_FX_MIDI_RING_VERSION);
  Atomics.store(header, 7, RING_MAGIC);
  return buffer;
}

export class BrowserFxMidiQueueWriter {
  public readonly buffer: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly view: DataView;

  public constructor(buffer: SharedArrayBuffer) {
    this.buffer = buffer;
    const expectedBytes = (BROWSER_FX_MIDI_HEADER_WORDS + BROWSER_FX_MIDI_RING_CAPACITY * BROWSER_FX_MIDI_SLOT_WORDS) * 4;
    if (buffer.byteLength !== expectedBytes) throw new RangeError('Browser FX MIDI ring has an unsupported byte length.');
    this.header = new Int32Array(buffer, 0, BROWSER_FX_MIDI_HEADER_WORDS);
    this.view = new DataView(buffer);
    if (Atomics.load(this.header, 6) !== BROWSER_FX_MIDI_RING_VERSION || Atomics.load(this.header, 7) !== RING_MAGIC) {
      throw new TypeError('Browser FX MIDI ring header is invalid.');
    }
  }

  public canEnqueue(event: FxMidiInputEvent, targetFrame: number): boolean {
    if (!isValidEvent(event) || !Number.isSafeInteger(targetFrame) || targetFrame < 0) return false;
    const write = Atomics.load(this.header, WRITE_SEQUENCE) >>> 0;
    const read = Atomics.load(this.header, READ_SEQUENCE) >>> 0;
    if (((write - read) >>> 0) >= BROWSER_FX_MIDI_RING_CAPACITY) return false;
    if (Atomics.load(this.header, HAS_LAST_FRAME) !== 0 && targetFrame < this.lastTargetFrame()) return false;
    return true;
  }

  public enqueue(event: FxMidiInputEvent, targetFrame: number): boolean {
    if (!this.canEnqueue(event, targetFrame)) {
      Atomics.add(this.header, DROPPED_EVENTS, 1);
      return false;
    }
    const write = Atomics.load(this.header, WRITE_SEQUENCE) >>> 0;
    const slot = write % BROWSER_FX_MIDI_RING_CAPACITY;
    const byteOffset = (BROWSER_FX_MIDI_HEADER_WORDS + slot * BROWSER_FX_MIDI_SLOT_WORDS) * 4;
    const low = targetFrame >>> 0;
    const high = Math.floor(targetFrame / 0x1_0000_0000) >>> 0;
    this.view.setUint32(byteOffset, low, true);
    this.view.setUint32(byteOffset + 4, high, true);
    this.view.setUint32(byteOffset + 8, TYPE_TO_WIRE[event.type], true);
    this.view.setUint32(byteOffset + 12, event.channel, true);
    this.view.setUint32(byteOffset + 16, event.type === 'AllNotesOff' ? 0 : event.note, true);
    this.view.setUint32(byteOffset + 20, event.type === 'NoteOn' ? event.velocity : 0, true);
    Atomics.store(this.header, LAST_FRAME_LOW, low | 0);
    Atomics.store(this.header, LAST_FRAME_HIGH, high | 0);
    Atomics.store(this.header, HAS_LAST_FRAME, 1);
    Atomics.store(this.header, WRITE_SEQUENCE, (write + 1) | 0);
    return true;
  }

  public get droppedEvents(): number {
    return Atomics.load(this.header, DROPPED_EVENTS) >>> 0;
  }

  /** Earliest frame a later event can use without violating ring order. */
  public get minimumNextTargetFrame(): number {
    return Atomics.load(this.header, HAS_LAST_FRAME) === 0 ? 0 : this.lastTargetFrame();
  }

  private lastTargetFrame(): number {
    const low = Atomics.load(this.header, LAST_FRAME_LOW) >>> 0;
    const high = Atomics.load(this.header, LAST_FRAME_HIGH) >>> 0;
    return high * 0x1_0000_0000 + low;
  }
}

export function isValidFxMidiInputEvent(event: FxMidiInputEvent): boolean {
  return isValidEvent(event);
}

function isValidEvent(event: FxMidiInputEvent): boolean {
  return Boolean(event && (event.type === 'NoteOn' || event.type === 'NoteOff' || event.type === 'AllNotesOff') &&
    Number.isInteger(event.channel) && event.channel >= 0 && event.channel <= 15 &&
    Number.isInteger(event.note) && event.note >= 0 && event.note <= 127 &&
    Number.isInteger(event.velocity) && event.velocity >= 0 && event.velocity <= 127 &&
    Number.isFinite(event.timestampMs) && event.timestampMs >= 0);
}
