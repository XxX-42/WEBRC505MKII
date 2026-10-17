import { afterEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: pitchHarness.create,
}));

import { BrowserPitchBendFX } from '../../src/audio/fx/BrowserPitchBendFX';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class MockGainNode extends MockAudioNode {
  readonly gain = {
    value: 1,
    setTargetAtTime: vi.fn((value: number) => { this.gain.value = value; }),
  };
}

class MockDelayNode extends MockAudioNode {
  readonly delayTime = { value: 0 };
}

function makeContext(): AudioContext {
  return {
    currentTime: 2,
    sampleRate: 48_000,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createGain: () => new MockGainNode(),
    createDelay: () => new MockDelayNode(),
  } as unknown as AudioContext;
}

function makePitchNode() {
  return Object.assign(new MockAudioNode(), {
    latencySeconds: 0.02,
    latencySamples: 960,
    setPitch: vi.fn(async (_semitones: number, _outputTime?: number) => undefined),
  });
}

function getGain(node: AudioNode): MockGainNode {
  return node as unknown as MockGainNode;
}

function flushSchedulePromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Browser PITCH BEND FX', () => {
  afterEach(() => pitchHarness.create.mockReset());

  it('schedules a bounded 10–20 ms upward sweep and holds its endpoint', async () => {
    const pitchNode = makePitchNode();
    pitchHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserPitchBendFX(makeContext());
    fx.setParam('range', 12);
    fx.setParam('time_ms', 120);
    await fx.ready;

    expect(pitchNode.setPitch).not.toHaveBeenCalled();
    fx.setBypass(false);
    const points = pitchNode.setPitch.mock.calls;
    expect(points).toHaveLength(7);
    expect(points[0]![0]).toBe(0);
    expect(points.at(-1)![0]).toBe(12);
    expect(points[0]![1]).toBeCloseTo(2.02, 5);
    expect(points.at(-1)![1]).toBeCloseTo(2.14, 5);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]![1]! - points[i - 1]![1]!).toBeCloseTo(0.02, 5);
      expect(points[i]![0]).toBeGreaterThanOrEqual(points[i - 1]![0]!);
    }
    // Repeated active state does not restart the sweep or extend its schedule.
    fx.setBypass(false);
    expect(pitchNode.setPitch).toHaveBeenCalledTimes(7);
    fx.dispose();
  });

  it('sweeps downward, resets to zero on bypass, and starts a fresh bend on reactivation', async () => {
    const pitchNode = makePitchNode();
    pitchHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserPitchBendFX(makeContext());
    fx.setParam('range', 24);
    fx.setParam('time_ms', 4000);
    fx.setParam('direction', 1);
    await fx.ready;
    fx.setBypass(false);

    const firstSweep = pitchNode.setPitch.mock.calls.slice();
    expect(firstSweep).toHaveLength(201);
    expect(firstSweep[0]![0]).toBe(0);
    expect(firstSweep.at(-1)![0]).toBe(-24);
    expect(firstSweep.at(-1)![1]! - firstSweep[0]![1]!).toBeCloseTo(4, 5);
    expect(Math.max(...firstSweep.map(([semitones]) => Math.abs(semitones!)))).toBe(24);

    fx.setBypass(true);
    expect(pitchNode.setPitch.mock.calls.at(-1)![0]).toBe(0);
    fx.setBypass(false);
    const retrigger = pitchNode.setPitch.mock.calls.slice(firstSweep.length + 1);
    expect(retrigger[0]![0]).toBe(0);
    expect(retrigger.at(-1)![0]).toBe(-24);
    expect(retrigger).toHaveLength(201);
    expect(pitchNode.setPitch.mock.calls.length).toBeLessThanOrEqual(403);
    fx.dispose();
  });

  it('aligns dry audio, mixes safely, fails closed on invalid parameters, and cleans up', async () => {
    const pitchNode = makePitchNode();
    pitchHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserPitchBendFX(makeContext());
    await fx.ready;

    const dryDelay = (fx as unknown as { dryDelay: MockDelayNode }).dryDelay;
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const dryGain = getGain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const wetGain = getGain((fx as unknown as { wetGain: AudioNode }).wetGain);
    expect(fx.latencySamples).toBe(960);
    expect(dryDelay.delayTime.value).toBe(0.02);
    expect(directGain.gain.value).toBe(1);

    fx.setParam('mix_percent', 50);
    fx.setBypass(false);
    expect(directGain.gain.value).toBe(0);
    expect(dryGain.gain.value).toBe(0.5);
    expect(wetGain.gain.value).toBe(0.5);
    fx.setParam('range', 24.1);
    expect(directGain.gain.value).toBe(1);
    expect(dryGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0);
    expect(fx.error).toContain('between 0 and 24');
    const callsBeforeUnsupported = pitchNode.setPitch.mock.calls.length;
    fx.setParam('formant', 1);
    expect(fx.error).toContain('does not support the formant');
    expect(pitchNode.setPitch.mock.calls.length).toBe(callsBeforeUnsupported);
    fx.setParam('range', 12);
    await flushSchedulePromises();
    expect(directGain.gain.value).toBe(0);
    expect(dryGain.gain.value).toBe(0.5);
    expect(wetGain.gain.value).toBe(0.5);
    fx.dispose();
    expect(pitchNode.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a failed installation on the direct path after later valid controls', async () => {
    pitchHarness.create.mockRejectedValue(new Error('test worklet failure'));
    const fx = new BrowserPitchBendFX(makeContext());
    await fx.ready;
    expect(fx.error).toContain('test worklet failure');
    fx.setParam('range', 18);
    expect(fx.error).toContain('test worklet failure');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    fx.dispose();
  });

  it('does not clear a rejected schedule with mix-only edits, but recovers after a pitch-control restart', async () => {
    const pitchNode = makePitchNode();
    pitchNode.setPitch.mockRejectedValueOnce(new Error('worklet queue full'));
    pitchHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserPitchBendFX(makeContext());
    await fx.ready;

    fx.setBypass(false);
    await Promise.resolve();
    await Promise.resolve();
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const wetGain = getGain((fx as unknown as { wetGain: AudioNode }).wetGain);
    expect(fx.error).toContain('worklet queue full');
    expect(directGain.gain.value).toBe(1);
    fx.setParam('mix_percent', 40);
    expect(directGain.gain.value).toBe(1);
    expect(wetGain.gain.value).toBe(0);
    expect(fx.error).toContain('worklet queue full');

    fx.setParam('range', 13);
    await flushSchedulePromises();
    expect(fx.error).toBe('');
    expect(directGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0.4);
    fx.dispose();
  });

  it('retries a runtime scheduling failure after bypass and reactivation, but not from mix-only edits', async () => {
    const pitchNode = makePitchNode();
    pitchNode.setPitch.mockRejectedValueOnce(new Error('transient schedule failure'));
    pitchHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserPitchBendFX(makeContext());
    await fx.ready;

    fx.setBypass(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const wetGain = getGain((fx as unknown as { wetGain: AudioNode }).wetGain);
    expect(fx.error).toContain('transient schedule failure');
    expect(directGain.gain.value).toBe(1);

    fx.setParam('mix_percent', 60);
    expect(fx.error).toContain('transient schedule failure');
    expect(directGain.gain.value).toBe(1);
    expect(wetGain.gain.value).toBe(0);

    fx.setBypass(true);
    fx.setBypass(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fx.error).toBe('');
    expect(directGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0.6);
    fx.dispose();
  });

  it('keeps an invalid mix fail-closed until a valid pitch control is applied', async () => {
    const pitchNode = makePitchNode();
    pitchHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserPitchBendFX(makeContext());
    await fx.ready;
    fx.setBypass(false);

    fx.setParam('mix_percent', 101);
    expect(fx.error).toContain('between 0 and 100');
    fx.setParam('mix_percent', 50);
    expect(fx.error).toContain('between 0 and 100');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);

    fx.setParam('time_ms', 600);
    await flushSchedulePromises();
    expect(fx.error).toBe('');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(0);
    fx.dispose();
  });
});
