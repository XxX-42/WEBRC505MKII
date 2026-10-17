import { describe, expect, it, vi } from 'vitest';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

describe('Browser HRM AUTO worklet integration', () => {
  it('keeps analyzer audio transparent and emits frame-stamped MIDI voice targets across variable blocks', () => {
    const host = globalThis as unknown as { currentFrame?: number };
    const previousFrame = host.currentFrame;
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'hrm-auto',
        sampleRate: 8_000,
        parameters: { hrmAutoKey: 0, hrmAutoScale: 0, hrmAutoMidiChannel: 1 },
        bypassed: false,
      },
    });
    const postMessage = vi.fn();
    processor.port.postMessage = postMessage;
    processor.port.onmessage?.({
      data: { type: 'midi-note-on', channel: 1, note: 60, velocity: 100, frame: 1_500 },
    });

    let frame = 0;
    const blockLengths = [31, 127, 64, 83] as const;
    try {
      while (frame < 8_000) {
        const length = Math.min(blockLengths[(frame >>> 5) & 3]!, 8_000 - frame);
        host.currentFrame = frame;
        const input = new Float32Array(length);
        const outputL = new Float32Array(length);
        const outputR = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          const absolute = frame + i;
          input[i] = 0.25 * Math.sin((2 * Math.PI * 220 * absolute) / 8_000);
        }
        processor.process([[input]], [[outputL, outputR]]);
        expect(outputL).toEqual(input);
        expect(outputR).toEqual(input);
        frame += length;
      }
    } finally {
      if (previousFrame === undefined) delete host.currentFrame;
      else host.currentFrame = previousFrame;
    }

    const targets = postMessage.mock.calls
      .map(([message]) => message as { type?: string; frame?: number; voiceCount?: number; target1?: number; target2?: number })
      .filter((message) => message.type === 'hrm-auto-target');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]?.frame).toBe(1_500);
    expect(targets[0]?.voiceCount).toBe(2);
    expect(targets[0]?.target1).toBeCloseTo(-5, 0);
    expect(targets[0]?.target2).toBeCloseTo(-2, 0);
    expect(targets.every(({ frame: eventFrame }) => Number.isSafeInteger(eventFrame) && eventFrame! < 8_000)).toBe(true);
  });

  it('rejects MIDI messages on unrelated algorithms and reports a bounded-queue overflow', () => {
    const oscillator = new FxProcessor({
      processorOptions: { algorithm: 'lpf', sampleRate: 8_000, bypassed: false },
    });
    const oscillatorPost = vi.fn();
    oscillator.port.postMessage = oscillatorPost;
    oscillator.port.onmessage?.({
      data: { type: 'midi-note-on', channel: 1, note: 60, velocity: 100, frame: 0 },
    });
    expect(oscillatorPost).toHaveBeenCalledWith({
      type: 'error',
      message: 'MIDI note events are only supported by OSC VOC (M) and HRM AUTO (M).',
    });

    const hrm = new FxProcessor({
      processorOptions: { algorithm: 'hrm-auto', sampleRate: 8_000, bypassed: false },
    });
    // Exercise the bounded queue through the exact public core event path.
    for (let note = 0; note < 128; note += 1) hrm.core.scheduleMidiNoteOn(1, note, 100, 10_000 + note);
    expect(() => hrm.core.scheduleMidiNoteOn(1, 0, 100, 20_000)).toThrow(/bounded queue full/);
    expect(hrm.core.hrmAutoMidiOverflowCount).toBe(1);
  });
});
