import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { FxMidiInputEvent, NativeFxMidiEvent, NativeFxBankConfiguration, NativeFxSlotConfiguration } from '../../src/audio/nativeFxProtocol';

const note: FxMidiInputEvent = { type: 'NoteOn', channel: 0, note: 64, velocity: 96, timestampMs: 10 };
function fixture(slots: NativeFxSlotConfiguration[]) {
  const bank: NativeFxBankConfiguration = { sampleRateHz: 48000, channels: 2, maxBlockFrames: 64,
    buses: slots.map((slot, index) => ({ kind: index === 0 ? 'input' : 'master', slots: [slot] })) };
  const post = vi.fn(async (_events: NativeFxMidiEvent[]) => ({ ok: true, activeGeneration: 8, producerGeneration: 8, adopted: true, stageAccepted: true }));
  const target = {
    queueFxMutation: <T>(fn: () => Promise<T>) => fn(),
    ensureFxControlState: async () => ({ bank }),
    bridge: { getStatus: vi.fn(async () => ({ nextAudioFrame: 4096, sampleRate: 48000 })), postFxMidiEvents: post },
    applyStatus: vi.fn(), latestStatusReceivedAtMs: 10,
    fxGraphActiveGeneration: 7, fxGraphProducerGeneration: 7,
    fxGraphAdopted: true, fxGraphStageAccepted: true,
  };
  const send = (event = note) => NativeAudioEngine.prototype.postFxMidiInput.call(target as unknown as NativeAudioEngine, event);
  return { target, post, send };
}
const slot = (ordinal: number, mode?: number): NativeFxSlotConfiguration => ({ enabled: true, ordinal, mix: 1, smoothingMs: 5,
  parameters: mode === undefined ? [] : [{ id: 107, value: mode }] });

describe('Native FX MIDI facade admission and fanout', () => {
  it('fans one note to compatible buses with one atomic batch and a common frame', async () => {
    const f = fixture([slot(19, 0), slot(21)]);
    expect(await f.send()).toBe(true);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[0]?.[0]).toEqual([0, 1].map(busIndex => ({ kind: 'midi', absoluteFrame: 4160,
      busIndex, slotIndex: 0, midiType: 'NoteOn', channel: 0, note: 64, velocity: 96 })));
  });
  it('does not query or enqueue a MIDI batch for incompatible modes and disabled slots', async () => {
    const disabled = { ...slot(21), enabled: false };
    const f = fixture([slot(19, 2), disabled]);
    expect(await f.send()).toBe(false);
    expect(f.target.bridge.getStatus).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
  it('normalizes AllNotesOff payload without changing its timestamped fanout', async () => {
    const f = fixture([slot(21)]);
    expect(await f.send({ type: 'AllNotesOff', channel: 0, note: 0, velocity: 0, timestampMs: 10 })).toBe(true);
    expect(f.post.mock.calls[0]?.[0]?.[0]).toMatchObject({ absoluteFrame: 4160, midiType: 'AllNotesOff', note: 0, velocity: 0 });
  });
  it('rejects unsupported channels without remapping or contacting the bridge', async () => {
    const f = fixture([slot(21)]);
    await expect(f.send({ ...note, channel: 1 })).rejects.toThrow('channel 1 only');
    expect(f.target.bridge.getStatus).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
  it('rejects an unavailable sample clock before enqueue', async () => {
    const f = fixture([slot(21)]);
    f.target.bridge.getStatus.mockResolvedValue({ nextAudioFrame: -1, sampleRate: 48000 });
    await expect(f.send()).rejects.toThrow('frame clock is unavailable');
    expect(f.post).not.toHaveBeenCalled();
  });
  it('keeps accepted generations unchanged when the host rejects the batch', async () => {
    const f = fixture([slot(21)]);
    f.post.mockResolvedValue({ ok: false, activeGeneration: 99, producerGeneration: 99, adopted: false, stageAccepted: false });
    await expect(f.send()).rejects.toThrow('batch was rejected');
    expect(f.target.fxGraphActiveGeneration).toBe(7);
    expect(f.target.fxGraphProducerGeneration).toBe(7);
    expect(f.target.fxGraphAdopted).toBe(true);
  });
});
