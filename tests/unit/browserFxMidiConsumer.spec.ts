import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BrowserFxMidiQueueWriter, createBrowserFxMidiBuffer } from '../../src/audio/browserFxMidiProtocol';
const note = { type: 'NoteOn' as const, channel: 0, note: 64, velocity: 100, timestampMs: 1 };
function fixture() {
  let registered: { prototype: object } | undefined;
  runInNewContext(readFileSync(resolve('public/worklets/master-fx-processor.js'), 'utf8'), {
    AudioWorkletProcessor: class {}, registerProcessor: (_name: string, type: { prototype: object }) => { registered = type; },
    SharedArrayBuffer, Int32Array, Float32Array, DataView, Atomics, Math, Number, sampleRate: 48000, currentFrame: 0,
  });
  if (!registered) throw new Error('Master processor did not register');
  const buffer = createBrowserFxMidiBuffer();
  const header = new Int32Array(buffer, 0, 8);
  const events = new DataView(new ArrayBuffer(64 * 8));
  const processor = Object.create(registered.prototype) as {
    dsp: { fxMidiHeader: Int32Array; fxMidiView: DataView; fxMidiEventsView: DataView; fxCurrentMidiEventCount: number };
    collectFxMidiEvents(frame: number, frames: number): void;
  };
  processor.dsp = { fxMidiHeader: header, fxMidiView: new DataView(buffer), fxMidiEventsView: events, fxCurrentMidiEventCount: 0 };
  return { writer: new BrowserFxMidiQueueWriter(buffer), header, events, processor };
}
describe('Production Browser MIDI writer and Master consumer boundaries', () => {
  it.each([32, 64, 128, 256])('uses actual %i-frame quantum and leaves end-boundary events for the next block', frames => {
    const f = fixture();
    expect(f.writer.enqueue(note, 100)).toBe(true);
    expect(f.writer.enqueue({ ...note, type: 'NoteOff', velocity: 0 }, 100 + frames)).toBe(true);
    f.processor.collectFxMidiEvents(100, frames);
    expect(f.processor.dsp.fxCurrentMidiEventCount).toBe(1);
    expect(f.events.getUint32(0, true)).toBe(0);
    expect(Atomics.load(f.header, 1)).toBe(1);
    f.processor.collectFxMidiEvents(100 + frames, frames);
    expect(f.processor.dsp.fxCurrentMidiEventCount).toBe(1);
    expect(f.events.getUint8(4)).toBe(1);
    f.processor.collectFxMidiEvents(100 + 2 * frames, frames);
    expect(f.processor.dsp.fxCurrentMidiEventCount).toBe(0);
  });
  it('clamps a late event to offset zero without dropping it', () => {
    const f = fixture(); f.writer.enqueue(note, 7); f.processor.collectFxMidiEvents(100, 64);
    expect(f.processor.dsp.fxCurrentMidiEventCount).toBe(1);
    expect(f.events.getUint32(0, true)).toBe(0);
  });
  it('rejects the 65th event without overwriting the 64 accepted records', () => {
    const f = fixture();
    for (let i = 0; i < 64; i++) expect(f.writer.enqueue({ ...note, note: i }, 100)).toBe(true);
    expect(f.writer.enqueue(note, 100)).toBe(false);
    expect(f.writer.droppedEvents).toBe(1);
    f.processor.collectFxMidiEvents(100, 64);
    expect(f.processor.dsp.fxCurrentMidiEventCount).toBe(64);
    for (let i = 0; i < 64; i++) expect(f.events.getUint8(i * 8 + 6)).toBe(i);
  });
  it('preserves timestamps above 32 bits while queue sequence counters wrap', () => {
    const f = fixture(); Atomics.store(f.header, 0, -1); Atomics.store(f.header, 1, -1);
    const start = 0x1_0000_0000 + 123;
    expect(f.writer.enqueue(note, start + 17)).toBe(true);
    expect(Atomics.load(f.header, 0)).toBe(0);
    f.processor.collectFxMidiEvents(start, 64);
    expect(f.processor.dsp.fxCurrentMidiEventCount).toBe(1);
    expect(f.events.getUint32(0, true)).toBe(17);
    expect(Atomics.load(f.header, 1)).toBe(0);
  });
  it('keeps independent consumer cursors so reading one ring does not consume another', () => {
    const a = fixture(), b = fixture(); a.writer.enqueue(note, 100); b.writer.enqueue(note, 100);
    a.processor.collectFxMidiEvents(100, 64);
    expect(Atomics.load(b.header, 1)).toBe(0);
    b.processor.collectFxMidiEvents(100, 64);
    expect(a.events.getUint8(6)).toBe(64); expect(b.events.getUint8(6)).toBe(64);
  });
});
