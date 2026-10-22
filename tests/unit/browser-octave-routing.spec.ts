import { afterEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: pitchHarness.create,
}));

import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class MockGainNode extends MockAudioNode {
  readonly gain = { value: 1, setTargetAtTime: vi.fn((value: number) => { this.gain.value = value; }) };
}

class MockDelayNode extends MockAudioNode {
  readonly delayTime = { value: 0 };
}

class MockAudioWorkletNode {}

class MockPitchNode extends MockAudioNode {
  constructor(readonly latencySeconds: number) { super(); }
  readonly latencySamples = this.latencySeconds * 48_000;
  readonly setPitch = vi.fn(async () => undefined);
}

function makeEngine() {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  const context = {
    sampleRate: 48_000,
    currentTime: 0,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createGain: () => new MockGainNode(),
    createDelay: () => new MockDelayNode(),
  } as unknown as AudioContext;
  Object.assign(engine, {
    context,
    inputFxChain: { input: inputHead, output: inputTail },
    outputFxChain: { input: trackHead, output: trackTail },
    trackMixNode: trackMix,
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    inputFxActive: [false, false, false, false],
    trackFxTypes: [null, null, null, null],
    initialized: false,
    lastError: '',
    statusListeners: new Set(),
  });
  return { engine, inputHead, inputTail, trackHead, trackTail, trackMix };
}

describe('Browser OCTAVE dynamic-bank integration', () => {
  afterEach(() => {
    pitchHarness.create.mockReset();
    vi.unstubAllGlobals();
  });

  it('connects three Signalsmith voices through selected Input and shared Track slots and applies named controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
    const voices = Array.from({ length: 6 }, (_, index) => new MockPitchNode(index === 4 ? 0.024 : 0.02));
    voices.forEach((voice) => pitchHarness.create.mockResolvedValueOnce(voice));
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();

    engine.setFxType('input', 1, 'OCTAVE');
    engine.setFxType('track', 3, 'OCTAVE');
    engine.setFxActive('input', 1, true);
    engine.setFxActive('track', 3, true);
    engine.setFxNamedParameters('input', 1, {
      minus_24_level: 60,
      minus_12_level: 20,
      plus_12_level: 35,
      mix_percent: 80,
    });
    engine.setFxParam('track', 3, 55);

    const state = engine as unknown as {
      inputFxInstances: Array<{ input: AudioNode; output: AudioNode; ready: Promise<void> } | null>;
      trackFxInstances: Array<{ input: AudioNode; output: AudioNode; ready: Promise<void> } | null>;
    };
    const inputFx = state.inputFxInstances[1]!;
    const trackFx = state.trackFxInstances[3]!;
    await Promise.all([inputFx.ready, trackFx.ready]);
    expect(pitchHarness.create).toHaveBeenCalledTimes(6);
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx.input);
    expect((inputFx.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx.input);
    expect((trackFx.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);

    const inputGains = (inputFx as unknown as { voiceGains: MockGainNode[] }).voiceGains;
    const trackGains = (trackFx as unknown as { voiceGains: MockGainNode[] }).voiceGains;
    expect(inputGains.map((node) => node.gain.value)).toEqual([
      expect.closeTo(0.48, 8), expect.closeTo(0.16, 8), expect.closeTo(0.28, 8),
    ]);
    expect(trackGains.map((node) => node.gain.value)).toEqual([
      0, expect.closeTo(0.22, 8), 0,
    ]);
    voices.forEach((node) => expect(node.setPitch).not.toHaveBeenCalled());
    engine.setFxNamedParameters('input', 1, { tracking_percent: 50 });
    expect(engine.getUiStatus().lastError).toContain('tracking sensitivity is unavailable');
    engine.setFxNamedParameters('input', 1, { minus_24_level: 40 });
    expect(inputGains.map((node) => node.gain.value)).toEqual([0, 0, 0]);
    expect(engine.getUiStatus().lastError).toContain('tracking sensitivity is unavailable');
  });
});
