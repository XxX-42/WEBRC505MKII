import { afterEach, describe, expect, it, vi } from 'vitest';

const pitchHarness = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/audio/pitch/signalsmith', () => ({
  createLiveInputTransposeNode: pitchHarness.create,
}));

import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserManualHarmonistFX } from '../../src/audio/fx/BrowserManualHarmonistFX';

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

class MockStereoPannerNode extends MockAudioNode {
  readonly pan = {
    value: 0,
    setTargetAtTime: vi.fn((value: number) => { this.pan.value = value; }),
  };
}

function makeContext(): AudioContext {
  return {
    currentTime: 2,
    sampleRate: 48_000,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createGain: () => new MockGainNode(),
    createDelay: () => new MockDelayNode(),
    createStereoPanner: () => new MockStereoPannerNode(),
  } as unknown as AudioContext;
}

function makePitchNode(latencySeconds = 0.02) {
  return Object.assign(new MockAudioNode(), {
    latencySeconds,
    latencySamples: Math.round(latencySeconds * 48_000),
    setPitch: vi.fn(async (_semitones: number) => undefined),
  });
}

function getGain(node: AudioNode): MockGainNode {
  return node as unknown as MockGainNode;
}

function flushSchedulePromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeEngine() {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  // The constructor owns the fixed bus anchor, outside dynamic FX rebuilds.
  trackMix.connect(trackHead);
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

describe('Browser HRM MANUAL FX', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pitchHarness.create.mockReset();
  });

  it('routes Input and all shared post-mix Track A–D slots through two independent Signalsmith voices', async () => {
    vi.stubGlobal('AudioWorkletNode', class {});
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    const pitchNodes = Array.from({ length: 10 }, makePitchNode);
    pitchNodes.forEach((node) => pitchHarness.create.mockResolvedValueOnce(node));

    engine.setFxType('input', 0, 'HRM MANUAL');
    for (let slot = 0; slot < 4; slot += 1) engine.setFxType('track', slot, 'HRM MANUAL');
    const inputFx = (engine as unknown as { inputFxInstances: BrowserManualHarmonistFX[] }).inputFxInstances[0]!;
    const trackFx = (engine as unknown as { trackFxInstances: BrowserManualHarmonistFX[] }).trackFxInstances;
    engine.setFxNamedParameters('input', 0, {
      voice_1_interval: 12,
      voice_2_interval: 7,
      mix_percent: 50,
      pan_percent: -60,
    });
    engine.setFxNamedParameters('track', 0, { voice_1_interval: 7, voice_2_interval: -12 });
    engine.setFxActive('input', 0, true);
    engine.setFxActive('track', 0, true);
    await Promise.all([inputFx.ready, ...trackFx.map((fx) => fx!.ready)]);

    expect(pitchHarness.create).toHaveBeenCalledTimes(10);
    expect(pitchHarness.create.mock.calls[0]![1]).toMatchObject({ mode: 'LIVE_FX', channels: 2, semitones: 7 });
    expect(pitchHarness.create.mock.calls[1]![1]).toMatchObject({ mode: 'LIVE_FX', channels: 2, semitones: 12 });
    expect(pitchHarness.create.mock.calls[2]![1]).toMatchObject({ mode: 'LIVE_FX', channels: 2, semitones: 7 });
    expect(pitchHarness.create.mock.calls[3]![1]).toMatchObject({ mode: 'LIVE_FX', channels: 2, semitones: 12 });
    expect(inputHead.connect).toHaveBeenCalledWith(inputFx.input);
    expect(inputFx.output.connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledExactlyOnceWith(trackHead);
    expect(trackMix.disconnect).not.toHaveBeenCalled();
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect(trackFx[0]!.output.connect).toHaveBeenCalledWith(trackFx[1]!.input);
    expect(trackFx[1]!.output.connect).toHaveBeenCalledWith(trackFx[2]!.input);
    expect(trackFx[2]!.output.connect).toHaveBeenCalledWith(trackFx[3]!.input);
    expect(trackFx[3]!.output.connect).toHaveBeenCalledWith(trackTail);
    expect(pitchNodes[0]!.setPitch).toHaveBeenCalledWith(12);
    expect(pitchNodes[1]!.setPitch).toHaveBeenCalledWith(7);
    expect(pitchNodes[3]!.setPitch).toHaveBeenCalledWith(-12);
    inputFx.dispose();
    trackFx.forEach((fx) => fx!.dispose());
  });

  it('keeps dry at unity and latency-aligned, mixes two voices additively, pans their sum, and bypasses directly', async () => {
    const voice1 = makePitchNode(0.02);
    const voice2 = makePitchNode(0.024);
    pitchHarness.create.mockResolvedValueOnce(voice1).mockResolvedValueOnce(voice2);
    const fx = new BrowserManualHarmonistFX(makeContext());
    await fx.ready;

    const dryDelay = (fx as unknown as { dryDelay: MockDelayNode }).dryDelay;
    const alignDelays = (fx as unknown as { voiceAlignmentDelays: [MockDelayNode, MockDelayNode] }).voiceAlignmentDelays;
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const dryGain = getGain((fx as unknown as { dryGain: AudioNode }).dryGain);
    const voiceGain = getGain((fx as unknown as { voiceGain: AudioNode }).voiceGain);
    const voicePan = (fx as unknown as { voicePan: MockStereoPannerNode }).voicePan;
    expect(fx.latencySamples).toBe(1152);
    expect(fx.latencySeconds).toBe(0.024);
    expect(dryDelay.delayTime.value).toBe(0.024);
    expect(alignDelays[0].delayTime.value).toBeCloseTo(0.004, 8);
    expect(alignDelays[1].delayTime.value).toBe(0);
    expect(directGain.gain.value).toBe(1);

    fx.setParam('voice_1_interval', 12);
    fx.setParam('voice_2_interval', 7);
    fx.setParam('mix_percent', 50);
    fx.setParam('pan_percent', -100);
    fx.setBypass(false);
    expect(voice1.setPitch).toHaveBeenCalledWith(12);
    expect(voice2.setPitch).toHaveBeenCalledWith(7);
    expect(voicePan.pan.value).toBe(-1);
    expect(directGain.gain.value).toBe(0);
    expect(dryGain.gain.value).toBe(1);
    expect(voiceGain.gain.value).toBe(0.5);

    fx.setParam('mix_percent', 0);
    expect(dryGain.gain.value).toBe(1);
    expect(voiceGain.gain.value).toBe(0);
    fx.setParam('mix_percent', 100);
    expect(dryGain.gain.value).toBe(1);
    expect(voiceGain.gain.value).toBe(1);
    fx.setBypass(true);
    expect(directGain.gain.value).toBe(1);
    expect(dryGain.gain.value).toBe(0);
    expect(voiceGain.gain.value).toBe(0);
    fx.dispose();
    expect(voice1.disconnect).toHaveBeenCalledOnce();
    expect(voice2.disconnect).toHaveBeenCalledOnce();
  });

  it('fails closed on invalid, unsupported, and formant controls, then recovers from a valid parameter', async () => {
    const voice1 = makePitchNode();
    const voice2 = makePitchNode();
    pitchHarness.create.mockResolvedValueOnce(voice1).mockResolvedValueOnce(voice2);
    const fx = new BrowserManualHarmonistFX(makeContext());
    await fx.ready;
    fx.setBypass(false);
    const directGain = getGain((fx as unknown as { directGain: AudioNode }).directGain);
    const voiceGain = getGain((fx as unknown as { voiceGain: AudioNode }).voiceGain);

    fx.setParam('voice_1_interval', 24.1);
    expect(directGain.gain.value).toBe(1);
    expect(voiceGain.gain.value).toBe(0);
    expect(fx.error).toContain('between -24 and +24');
    fx.setParam('mix_percent', 45);
    expect(directGain.gain.value).toBe(1);
    expect(voiceGain.gain.value).toBe(0);
    expect(fx.error).toContain('between -24 and +24');
    fx.setParam('voice_1_interval', 12);
    await flushSchedulePromises();
    expect(directGain.gain.value).toBe(0);
    expect(voiceGain.gain.value).toBe(0.45);

    fx.setParam('pan_percent', Number.NaN);
    expect(directGain.gain.value).toBe(1);
    expect(fx.error).toContain('finite number');
    fx.setParam('pan_percent', 0);
    expect(directGain.gain.value).toBe(0);

    fx.setParam('formant', 0);
    expect(fx.error).toContain('formant processing is unavailable');
    fx.setParam('mix_percent', 55);
    expect(directGain.gain.value).toBe(1);
    expect(voiceGain.gain.value).toBe(0);
    expect(fx.error).toContain('formant processing is unavailable');
    expect(voice1.setPitch).toHaveBeenCalledWith(12);
    expect(voice2.setPitch).not.toHaveBeenCalled();
    fx.dispose();
  });

  it('fails closed if either independent voice fails to install and cleans up the other', async () => {
    const installedVoice = makePitchNode();
    pitchHarness.create.mockResolvedValueOnce(installedVoice).mockRejectedValueOnce(new Error('second voice unavailable'));
    const fx = new BrowserManualHarmonistFX(makeContext());
    await fx.ready;

    expect(fx.error).toContain('second voice unavailable');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    expect(installedVoice.disconnect).toHaveBeenCalledOnce();
    fx.dispose();
  });

  it('fails closed when live retuning a voice is rejected', async () => {
    const voice1 = makePitchNode();
    const voice2 = makePitchNode();
    voice1.setPitch.mockRejectedValueOnce(new Error('pitch schedule rejected'));
    pitchHarness.create.mockResolvedValueOnce(voice1).mockResolvedValueOnce(voice2);
    const fx = new BrowserManualHarmonistFX(makeContext());
    await fx.ready;
    fx.setBypass(false);
    fx.setParam('voice_1_interval', 10);
    await flushSchedulePromises();

    expect(fx.error).toContain('pitch schedule rejected');
    expect(getGain((fx as unknown as { directGain: AudioNode }).directGain).gain.value).toBe(1);
    expect(getGain((fx as unknown as { voiceGain: AudioNode }).voiceGain).gain.value).toBe(0);
    fx.dispose();
  });
});
