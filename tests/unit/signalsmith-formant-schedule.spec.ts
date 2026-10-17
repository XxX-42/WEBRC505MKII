import { afterEach, describe, expect, it, vi } from 'vitest';

const nodeHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/vendor/SignalsmithStretch.mjs', () => ({
  default: nodeHarness.create,
}));

import { createLiveInputTransposeNode } from '../../src/audio/pitch/signalsmith';

describe('Signalsmith LIVE_FX formant scheduling', () => {
  afterEach(() => nodeHarness.create.mockReset());

  it('keeps pitch, preserve/independent formant control, and tracked base in one vendor schedule event', async () => {
    const schedule = vi.fn(async (_event: unknown) => undefined);
    const vendorNode = {
      configure: vi.fn(async () => undefined),
      latency: vi.fn(async () => 0.024),
      schedule,
      disconnect: vi.fn(),
    };
    nodeHarness.create.mockResolvedValue(vendorNode);
    const context = { sampleRate: 48_000, currentTime: 1 } as unknown as BaseAudioContext;
    const node = await createLiveInputTransposeNode(context, { mode: 'LIVE_FX', channels: 2, semitones: 0 });

    await node.setPitch(0, 1.1, false, 0, 220, true);
    expect(schedule).toHaveBeenLastCalledWith({
      active: true,
      output: 1.1,
      outputTime: 1.1,
      rate: 1,
      semitones: 0,
      tonalityHz: 8_000,
      formantSemitones: 0,
      formantCompensation: true,
      formantBaseHz: 220,
    });

    await node.setPitch(7, 1.2, false, 4, 220, true);
    expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({
      output: 1.2,
      semitones: 7,
      formantSemitones: 4,
      formantCompensation: true,
      formantBaseHz: 220,
    }));

    await node.setPitch(7, 1.3, false, 0, 220, true);
    expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({
      semitones: 7,
      formantSemitones: 0,
      formantCompensation: true,
      formantBaseHz: 220,
    }));
  });
});
