import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BROWSER_WORKLET_FX_TYPES } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserReverseReverbDsp } from '../../src/audio/fx/dsp/BrowserReverseReverbDsp';
import { BROWSER_FX_ALGORITHM_INFO, BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class MockWorkletNode {
  static instances: MockWorkletNode[] = [];
  readonly port = { postMessage: vi.fn() };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    MockWorkletNode.instances.push(this);
  }
}

function makeEngine(): BrowserAudioEngine {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  const context = {
    sampleRate: 48000,
    currentTime: 1,
    audioWorklet: { addModule: vi.fn(async (_url: string) => undefined) },
    createGain: () => new MockAudioNode(),
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
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    lastError: '',
    statusListeners: new Set(),
  });
  return engine;
}

function renderCore(core: BrowserFxDspCore, left: Float32Array, right: Float32Array, blockSizes: readonly number[]): [Float32Array, Float32Array] {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < left.length) {
    const frames = Math.min(blockSizes[blockIndex % blockSizes.length] ?? left.length, left.length - offset);
    core.processBlock(
      left.subarray(offset, offset + frames),
      right.subarray(offset, offset + frames),
      outputLeft.subarray(offset, offset + frames),
      outputRight.subarray(offset, offset + frames),
      frames,
    );
    offset += frames;
    blockIndex += 1;
  }
  return [outputLeft, outputRight];
}

describe('Browser experimental REVERSE REVERB (FX #49)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('routes both Browser banks to the reverse-reverb worklet and accepts shared named controls', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const engine = makeEngine();
    engine.setFxType('input', 0, 'REVERSE REVERB (EXPERIMENTAL)');
    engine.setFxType('track', 3, 'REVERSE REVERB (EXPERIMENTAL)');

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(MockWorkletNode.instances.map(({ options }) => options.processorOptions?.algorithm)).toEqual([
      'reverse-reverb', 'reverse-reverb',
    ]);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({ bpm: expect.any(Number) });

    engine.setFxNamedParameters('input', 0, {
      segment_beats: 0.25,
      feedback_percent: 45,
      crossfade_ms: 40,
      decay_seconds: 3,
      damping_cutoff_hz: 6500,
      mix_percent: 35,
    });
    engine.setFxParam('track', 3, 45);
    const inputMessages = MockWorkletNode.instances[0]!.port.postMessage.mock.calls;
    expect(inputMessages).toContainEqual([{ type: 'configure', parameters: { reverseReverbSegmentBeats: 0.25 } }]);
    expect(inputMessages).toContainEqual([{ type: 'configure', parameters: { reverseReverbFeedbackPercent: 45 } }]);
    expect(inputMessages).toContainEqual([{ type: 'configure', parameters: { reverseReverbCrossfadeMs: 40 } }]);
    expect(inputMessages).toContainEqual([{ type: 'configure', parameters: { reverseReverbDecaySeconds: 3 } }]);
    expect(inputMessages).toContainEqual([{ type: 'configure', parameters: { reverseReverbDampingCutoffHz: 6500 } }]);
    expect(inputMessages).toContainEqual([{ type: 'configure', parameters: { mix: 0.35 } }]);
    expect(MockWorkletNode.instances[1]!.port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'configure',
      parameters: { mix: 0.45 },
    });
  });

  it('captures beat segments, reverses them into a diffuse 16-line stereo FDN tail, and reports segment pre-delay', () => {
    expect(BROWSER_WORKLET_FX_TYPES['REVERSE REVERB']).toBe('reverse-reverb');
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-reverb']).toMatchObject({
      catalogFunction: 'REVERSE REVERB (catalog ID 49)',
      formulaIds: ['F17', 'F18', 'F25'],
      implementationStatus: 'experimental',
      algorithmicLatencySamples: 12_000,
    });

    const dsp = new BrowserReverseReverbDsp(8000, {
      bpm: 300,
      segmentBeats: 0.25,
      feedbackPercent: 0,
      crossfadeMs: 20,
      decaySeconds: 2,
      dampingCutoffHz: 8000,
    });
    expect(dsp.latencySamples).toBe(400);

    for (let frame = 0; frame < 400; frame += 1) {
      const impulse = frame === 0 ? 0.8 : 0;
      dsp.processSample(impulse, -impulse);
      if (frame < 399) expect(dsp.wetLeft).toBe(0);
    }
    expect(dsp.hasCaptured).toBe(true);
    expect(dsp.diagnostics).toMatchObject({ boundaryCount: 1, activeBpm: 300, activeSegmentBeats: 0.25, activeSegmentFrames: 400 });

    let nonZeroTailSamples = 0;
    let firstTailFrame = -1;
    for (let frame = 0; frame < 1400; frame += 1) {
      dsp.processSample(0, 0);
      if (Math.abs(dsp.wetLeft) > 1e-7 || Math.abs(dsp.wetRight) > 1e-7) {
        if (firstTailFrame < 0) firstTailFrame = frame;
        nonZeroTailSamples += 1;
      }
    }
    // The reverse source reaches its first captured transient near the end of
    // the segment; the FDN then adds its own diffuse delay and decay.
    expect(firstTailFrame).toBeGreaterThan(500);
    expect(nonZeroTailSamples).toBeGreaterThan(20);
    expect(dsp.diagnostics.maxBufferSamples).toBeLessThan(2_000_000);
  });

  it('overlaps adjacent reverse segments, bounds parameters and resets all audible state', () => {
    const dsp = new BrowserReverseReverbDsp(8000, {
      bpm: 300,
      segmentBeats: 0.25,
      feedbackPercent: 95,
      crossfadeMs: 500,
      decaySeconds: 0.1,
      dampingCutoffHz: 100_000,
    });
    expect(dsp.diagnostics).toMatchObject({ activeSegmentFrames: 400, overlapFrames: 200, dampingCutoffHz: 3992 });
    for (let frame = 0; frame < 1200; frame += 1) {
      const input = frame % 400 < 40 ? 4 : 0;
      dsp.processSample(input, -input);
      expect(Number.isFinite(dsp.wetLeft) && Number.isFinite(dsp.wetRight)).toBe(true);
      expect(Math.abs(dsp.wetLeft)).toBeLessThanOrEqual(8);
      expect(Math.abs(dsp.wetRight)).toBeLessThanOrEqual(8);
    }
    expect(dsp.diagnostics).toMatchObject({ boundaryCount: 3, crossfadeCount: 2 });

    dsp.reset();
    expect(dsp.hasCaptured).toBe(false);
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.wetRight).toBe(0);
    expect(dsp.diagnostics).toMatchObject({ framesProcessed: 0, boundaryCount: 0, crossfadeCount: 0 });
    dsp.processSample(Number.NaN, Number.POSITIVE_INFINITY);
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.wetRight).toBe(0);
  });

  it('renders identically across variable core and worklet callback lengths and rejects no finite state', () => {
    const inputLeft = new Float32Array(1800);
    const inputRight = new Float32Array(1800);
    for (let frame = 0; frame < inputLeft.length; frame += 1) {
      inputLeft[frame] = Math.sin(frame * 0.17) * 0.3 + ((frame * 23) % 71) / 200;
      inputRight[frame] = Math.cos(frame * 0.071) * 0.24;
    }
    const createCore = (): BrowserFxDspCore => {
      const core = new BrowserFxDspCore('reverse-reverb', 8000, {
        bpm: 300,
        reverseReverbSegmentBeats: 0.25,
        reverseReverbFeedbackPercent: 25,
        reverseReverbCrossfadeMs: 20,
        reverseReverbDecaySeconds: 2,
        reverseReverbDampingCutoffHz: 7000,
        mix: 0.75,
      });
      core.setBypass(false, 0);
      return core;
    };
    const wholeCore = createCore();
    const chunkedCore = createCore();
    expect(wholeCore.algorithmicLatencySamples).toBe(400);
    const whole = renderCore(wholeCore, inputLeft, inputRight, [inputLeft.length]);
    const chunked = renderCore(chunkedCore, inputLeft, inputRight, [1, 31, 128, 257, 3, 17]);
    expect(chunked[0]).toEqual(whole[0]);
    expect(chunked[1]).toEqual(whole[1]);
    expect(whole[0].some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
    expect(whole[1].every(Number.isFinite)).toBe(true);
    expect(chunkedCore.reverseReverbDiagnostics?.boundaryCount).toBe(4);

    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'reverse-reverb',
        sampleRate: 8000,
        parameters: {
          bpm: 300,
          reverseReverbSegmentBeats: 0.25,
          reverseReverbFeedbackPercent: 10,
          mix: 0.8,
        },
        bypassed: false,
      },
    });
    const inputBlock = [inputLeft.subarray(0, 149), inputRight.subarray(0, 149)];
    const outputBlock = [new Float32Array(149), new Float32Array(149)];
    expect(processor.process([inputBlock], [outputBlock])).toBe(true);
    expect(outputBlock[0]!.every(Number.isFinite)).toBe(true);
    expect(processor.core.reverseReverbDiagnostics?.framesProcessed).toBe(149);
  });
});
