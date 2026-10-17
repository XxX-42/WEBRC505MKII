import { afterEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: pitchHarness.create,
}));

import { BrowserOctaveFX } from '../../src/audio/fx/BrowserOctaveFX';

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

function makeContext() {
  const gains: MockGainNode[] = [];
  const delays: MockDelayNode[] = [];
  const context = {
    currentTime: 2,
    sampleRate: 48_000,
    createGain: () => {
      const node = new MockGainNode();
      gains.push(node);
      return node;
    },
    createDelay: () => {
      const node = new MockDelayNode();
      delays.push(node);
      return node;
    },
  } as unknown as AudioContext;
  return { context, gains, delays };
}

function makePitchNode(latencySeconds = 0.02) {
  return Object.assign(new MockAudioNode(), {
    latencySeconds,
    latencySamples: Math.round(latencySeconds * 48_000),
    setPitch: vi.fn(async (_semitones: number) => undefined),
  });
}

function gain(node: AudioNode): MockGainNode {
  return node as unknown as MockGainNode;
}

describe('Browser OCTAVE FX', () => {
  afterEach(() => pitchHarness.create.mockReset());

  it('creates three independent stereo Signalsmith voices and aligns dry and voice paths', async () => {
    const { context, delays } = makeContext();
    const voices = [makePitchNode(0.02), makePitchNode(0.024), makePitchNode(0.019)];
    voices.forEach((voice) => pitchHarness.create.mockResolvedValueOnce(voice));
    const fx = new BrowserOctaveFX(context);
    await fx.ready;

    expect(pitchHarness.create).toHaveBeenCalledTimes(3);
    expect(pitchHarness.create.mock.calls.map((call) => call[1])).toEqual([
      { mode: 'LIVE_FX', channels: 2, semitones: -24 },
      { mode: 'LIVE_FX', channels: 2, semitones: -12 },
      { mode: 'LIVE_FX', channels: 2, semitones: 12 },
    ]);
    expect(fx.latencySeconds).toBe(0.024);
    expect(fx.latencySamples).toBe(1152);
    expect(delays.map((node) => node.delayTime.value)).toEqual([
      expect.closeTo(0.024, 8), expect.closeTo(0.004, 8), 0, expect.closeTo(0.005, 8),
    ]);
    expect(fx.input.connect).toHaveBeenCalledWith(voices[0]);
    expect(fx.input.connect).toHaveBeenCalledWith(voices[1]);
    expect(fx.input.connect).toHaveBeenCalledWith(voices[2]);

    const direct = gain((fx as unknown as { directGain: AudioNode }).directGain);
    const dry = gain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const voiceGains = (fx as unknown as { voiceGains: [GainNode, GainNode, GainNode] }).voiceGains.map(gain);
    expect(direct.gain.value).toBe(1);
    expect(dry.gain.value).toBe(0);
    fx.setBypass(false);
    expect(direct.gain.value).toBe(0);
    expect(dry.gain.value).toBe(1);
    // Existing provisional defaults are -24: 0%, -12: 40%, +12: 0%, mix: 70%.
    expect(voiceGains.map((node) => node.gain.value)).toEqual([0, expect.closeTo(0.28, 8), 0]);

    fx.setParam('minus_24_level', 50);
    fx.setParam('plus_12_level', 25);
    expect(voiceGains.map((node) => node.gain.value)).toEqual([
      expect.closeTo(0.35, 8), expect.closeTo(0.28, 8), expect.closeTo(0.175, 8),
    ]);
    fx.setParam('mix_percent', 0);
    expect(dry.gain.value).toBe(1);
    expect(voiceGains.map((node) => node.gain.value)).toEqual([0, 0, 0]);
    fx.setParam('mix_percent', 100);
    fx.setBypass(true);
    expect(direct.gain.value).toBe(1);
    expect(dry.gain.value).toBe(0);
    expect(voiceGains.map((node) => node.gain.value)).toEqual([0, 0, 0]);

    fx.dispose();
    expect(voices.map((voice) => voice.disconnect).map((disconnect) => disconnect.mock.calls.length)).toEqual([1, 1, 1]);
    expect(delays.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(voiceGains.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it('fails closed for non-finite, out-of-range, formant, tracking, and unknown parameters', async () => {
    const voices = [makePitchNode(), makePitchNode(), makePitchNode()];
    voices.forEach((voice) => pitchHarness.create.mockResolvedValueOnce(voice));
    const onFailure = vi.fn();
    const fx = new BrowserOctaveFX(makeContext().context, onFailure);
    await fx.ready;
    fx.setBypass(false);
    const direct = gain((fx as unknown as { directGain: AudioNode }).directGain);
    const dry = gain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const voiceGains = (fx as unknown as { voiceGains: [GainNode, GainNode, GainNode] }).voiceGains.map(gain);
    const assertClosed = () => {
      expect(direct.gain.value).toBe(1);
      expect(dry.gain.value).toBe(0);
      expect(voiceGains.map((node) => node.gain.value)).toEqual([0, 0, 0]);
    };

    fx.setParam('minus_24_level', Number.NaN);
    expect(fx.error).toContain('finite number');
    assertClosed();
    fx.setParam('mix_percent', 50);
    assertClosed(); // A different valid control cannot clear a bad control.
    fx.setParam('minus_24_level', 30);
    expect(fx.error).toBe('');
    expect(direct.gain.value).toBe(0);

    fx.setParam('minus_12_level', 100.01);
    expect(fx.error).toContain('between 0 and 100');
    assertClosed();
    fx.setParam('minus_12_level', 40);
    expect(fx.error).toBe('');

    fx.setParam('formant', 50);
    expect(fx.error).toContain('formant processing is unavailable');
    assertClosed();
    fx.setParam('tracking_sensitivity', 60);
    expect(fx.error).toContain('tracking sensitivity is unavailable');
    assertClosed();
    fx.setParam('tracking_percent', 60);
    expect(fx.error).toContain('tracking sensitivity is unavailable');
    assertClosed();
    fx.setParam('made_up_control', 5);
    expect(fx.error).toContain('does not support');
    assertClosed();
    expect(onFailure).toHaveBeenCalledTimes(5);
    fx.dispose();
  });

  it('fails closed and disconnects successful voices if any voice initialization fails', async () => {
    const working1 = makePitchNode();
    const working3 = makePitchNode();
    pitchHarness.create
      .mockResolvedValueOnce(working1)
      .mockRejectedValueOnce(new Error('voice retune rejected during initialization'))
      .mockResolvedValueOnce(working3);
    const fx = new BrowserOctaveFX(makeContext().context);
    await fx.ready;

    expect(fx.error).toContain('voice retune rejected during initialization');
    expect(gain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    expect(working1.disconnect).toHaveBeenCalledOnce();
    expect(working3.disconnect).toHaveBeenCalledOnce();
    fx.setBypass(false);
    fx.setParam('minus_12_level', 20);
    expect(gain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    fx.dispose();
  });

  it('cleans up voices that finish initialization after dispose', async () => {
    let resolveFirst!: (node: ReturnType<typeof makePitchNode>) => void;
    const first = new Promise<ReturnType<typeof makePitchNode>>((resolve) => { resolveFirst = resolve; });
    const otherVoices = [makePitchNode(), makePitchNode()];
    pitchHarness.create
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(otherVoices[0])
      .mockResolvedValueOnce(otherVoices[1]);
    const fx = new BrowserOctaveFX(makeContext().context);
    fx.dispose();
    const lateVoice = makePitchNode();
    resolveFirst(lateVoice);
    await fx.ready;
    expect([lateVoice, ...otherVoices].map((voice) => voice.disconnect.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
