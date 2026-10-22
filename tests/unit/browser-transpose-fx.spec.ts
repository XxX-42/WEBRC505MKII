import { afterEach, describe, expect, it, vi } from 'vitest';

const transposeHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: transposeHarness.create,
}));

import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserPitchBendFX } from '../../src/audio/fx/BrowserPitchBendFX';
import { BrowserTransposeFX } from '../../src/audio/fx/BrowserTransposeFX';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class MockGainNode extends MockAudioNode {
  readonly gain = {
    value: 1,
    setTargetAtTime(value: number) {
      this.value = value;
    },
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
    setPitch: vi.fn(async (_semitones?: number, _outputTime?: number, _replaceFuture?: boolean) => undefined),
  });
}

function getGain(node: AudioNode): MockGainNode {
  return node as unknown as MockGainNode;
}

function makeEngine() {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  Object.assign(engine, {
    context: makeContext(),
    inputFxChain: { input: inputHead, output: inputTail },
    outputFxChain: { input: trackHead, output: trackTail },
    trackMixNode: trackMix,
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    inputFxActive: [false, false, false, false],
    trackFxTypes: [null, null, null, null],
    lastError: '',
    statusListeners: new Set(),
  });
  return { engine, inputHead, inputTail, trackHead, trackTail, trackMix };
}

describe('Browser TRANSPOSE FX', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transposeHarness.create.mockReset();
  });

  it('routes PITCH BEND through Input and shared post-mix Track slots with named controls', async () => {
    vi.stubGlobal('AudioWorkletNode', class {});
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    const inputNode = makePitchNode();
    const trackNode = makePitchNode();
    transposeHarness.create
      .mockResolvedValueOnce(inputNode)
      .mockResolvedValueOnce(trackNode);

    engine.setFxType('input', 1, 'PITCH BEND');
    engine.setFxType('track', 2, 'PITCH BEND');
    const inputFx = (engine as unknown as { inputFxInstances: Array<BrowserPitchBendFX | null> }).inputFxInstances[1]!;
    const trackFx = (engine as unknown as { trackFxInstances: Array<BrowserPitchBendFX | null> }).trackFxInstances[2]!;
    await Promise.all([inputFx.ready, trackFx.ready]);

    engine.setFxNamedParameters('input', 1, { range: 6, time_ms: 100, direction: 1, mix_percent: 70 });
    engine.setFxNamedParameters('track', 2, { range: 12, time_ms: 200, direction: 0, mix_percent: 80 });
    engine.setFxActive('input', 1, true);
    engine.setFxActive('track', 2, true);

    expect(transposeHarness.create).toHaveBeenCalledTimes(2);
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx.input);
    expect(inputFx.output.connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx.input);
    expect(trackFx.output.connect).toHaveBeenCalledWith(trackTail);
    expect(inputNode.setPitch).toHaveBeenCalledTimes(6);
    expect(inputNode.setPitch.mock.calls[0]).toEqual([0, 2.02, true]);
    expect(inputNode.setPitch.mock.calls.at(-1)?.[0]).toBe(-6);
    expect(trackNode.setPitch.mock.calls[0]?.[0]).toBe(0);
    expect(trackNode.setPitch.mock.calls.at(-1)?.[0]).toBe(12);
    inputFx.dispose();
    trackFx.dispose();
  });

  it('routes Input and shared post-mix Track slots through Signalsmith', async () => {
    vi.stubGlobal('AudioWorkletNode', class {});
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    const inputNode = makePitchNode();
    const trackNode = makePitchNode();
    transposeHarness.create
      .mockResolvedValueOnce(inputNode)
      .mockResolvedValueOnce(trackNode);

    engine.setFxType('input', 0, 'TRANSPOSE');
    engine.setFxType('track', 3, 'TRANSPOSE');
    const inputFx = (engine as unknown as { inputFxInstances: BrowserTransposeFX[] }).inputFxInstances[0]!;
    const trackFx = (engine as unknown as { trackFxInstances: BrowserTransposeFX[] }).trackFxInstances[3]!;
    await Promise.all([inputFx.ready, trackFx.ready]);

    expect(transposeHarness.create).toHaveBeenCalledTimes(2);
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx.input);
    expect(inputFx.output.connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx.input);
    expect(trackFx.output.connect).toHaveBeenCalledWith(trackTail);
    expect(trackNode.connect).toHaveBeenCalledWith(expect.any(MockGainNode));
  });

  it('aligns the active dry path to measured Signalsmith latency and bypasses with zero latency', async () => {
    const pitchNode = makePitchNode();
    transposeHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserTransposeFX(makeContext());
    await fx.ready;

    const dryDelay = (fx as unknown as { dryDelay: MockDelayNode }).dryDelay;
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const dryGain = getGain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const wetGain = getGain((fx as unknown as { wetGain: AudioNode }).wetGain);
    expect(dryDelay.delayTime.value).toBe(0.02);
    expect(fx.latencySamples).toBe(960);

    fx.setParam('mix', 50);
    fx.setBypass(false);
    expect(directGain.gain.value).toBe(0);
    expect(dryGain.gain.value).toBe(0.5);
    expect(wetGain.gain.value).toBe(0.5);

    fx.setBypass(true);
    expect(directGain.gain.value).toBe(1);
    expect(dryGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0);
    fx.dispose();
  });

  it('fails closed on out-of-range, non-finite, and unsupported parameters', async () => {
    const pitchNode = makePitchNode();
    transposeHarness.create.mockResolvedValue(pitchNode);
    const fx = new BrowserTransposeFX(makeContext());
    await fx.ready;
    fx.setBypass(false);
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const dryGain = getGain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const wetGain = getGain((fx as unknown as { wetGain: AudioNode }).wetGain);

    fx.setParam('shift', 24.01);
    expect(directGain.gain.value).toBe(1);
    expect(dryGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(0);
    expect(fx.error).toMatch(/between -24 and \+24/);
    expect(pitchNode.setPitch).not.toHaveBeenCalled();

    fx.setParam('shift', Number.NaN);
    expect(directGain.gain.value).toBe(1);
    expect(fx.error).toMatch(/finite number/);

    const { engine } = makeEngine();
    Object.assign(engine, { inputFxInstances: [fx, null, null, null] });
    engine.setFxNamedParameters('input', 0, { shift: Number.NaN });
    expect(directGain.gain.value).toBe(1);
    expect(fx.error).toMatch(/finite number/);

    fx.setParam('formant', 0);
    expect(directGain.gain.value).toBe(1);
    expect(fx.error).toMatch(/does not support the formant/);

    fx.setParam('shift', -24);
    await vi.waitFor(() => expect(pitchNode.setPitch).toHaveBeenCalledWith(-24));
    expect(directGain.gain.value).toBe(0);
    expect(wetGain.gain.value).toBe(1);
    fx.dispose();
  });

  it('does not clear a processor installation failure when parameters are later valid', async () => {
    transposeHarness.create.mockRejectedValue(new Error('test worklet failure'));
    const fx = new BrowserTransposeFX(makeContext());
    await fx.ready;

    expect(fx.error).toContain('test worklet failure');
    fx.setParam('shift', 12);
    expect(fx.error).toContain('test worklet failure');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    fx.dispose();
  });
});
