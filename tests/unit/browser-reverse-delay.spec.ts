import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserWorkletFX } from '../../src/audio/fx/BrowserWorkletFX';
import { BrowserFxDspCore, BROWSER_FX_ALGORITHM_INFO } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserReverseDelayDsp } from '../../src/audio/fx/dsp/BrowserReverseDelayDsp';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';
import { Transport } from '../../src/core/Transport';

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

function makeEngine(): {
  engine: BrowserAudioEngine;
  inputHead: MockAudioNode;
  inputTail: MockAudioNode;
  trackHead: MockAudioNode;
  trackTail: MockAudioNode;
  trackMix: MockAudioNode;
} {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
  const inputTail = new MockAudioNode();
  const trackHead = new MockAudioNode();
  const trackTail = new MockAudioNode();
  const trackMix = new MockAudioNode();
  const context = {
    sampleRate: 48000,
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
  return { engine, inputHead, inputTail, trackHead, trackTail, trackMix };
}

function renderCore(core: BrowserFxDspCore, input: Float32Array, blockSizes: readonly number[]): Float32Array {
  const output = new Float32Array(input.length);
  let offset = 0;
  let blockIndex = 0;
  while (offset < input.length) {
    const frames = Math.min(blockSizes[blockIndex % blockSizes.length] ?? input.length, input.length - offset);
    core.processBlock(
      input.subarray(offset, offset + frames),
      input.subarray(offset, offset + frames),
      output.subarray(offset, offset + frames),
      null,
      frames,
    );
    offset += frames;
    blockIndex += 1;
  }
  return output;
}

describe('Browser clean-room REVERSE DELAY (catalog source ID 38)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('captures a complete tempo segment before reading its samples backward', () => {
    const dsp = new BrowserReverseDelayDsp(8000, {
      bpm: 300,
      segmentBeats: 0.25,
      feedback: 0,
      crossfadeMs: 1,
    });
    const segmentFrames = 400;
    const left = new Float32Array(segmentFrames);
    const right = new Float32Array(segmentFrames);
    for (let frame = 0; frame < segmentFrames; frame += 1) {
      left[frame] = (frame + 1) / 500;
      right[frame] = -(frame + 1) / 1000;
      dsp.processSample(left[frame]!, right[frame]!);
      expect(dsp.wetLeft).toBe(0);
      expect(dsp.wetRight).toBe(0);
    }

    expect(dsp.hasCaptured).toBe(true);
    expect(dsp.diagnostics).toMatchObject({
      boundaryCount: 1,
      activeBpm: 300,
      activeSegmentBeats: 0.25,
      activeSegmentFrames: segmentFrames,
      playbackDurationFrames: segmentFrames,
      overlapFrames: 8,
    });

    for (let frame = 0; frame < segmentFrames; frame += 1) {
      dsp.processSample(0, 0);
      // The first 8 frames fade from silence. Past the fade the reverse head
      // reads the original segment from its final sample back toward its first.
      if (frame >= 8) {
        expect(dsp.wetLeft).toBe(left[segmentFrames - 1 - frame]);
        expect(dsp.wetRight).toBe(right[segmentFrames - 1 - frame]);
      }
    }
    expect(dsp.wetLeft).toBe(left[0]);
    expect(dsp.wetRight).toBe(right[0]);
  });

  it('crossfades adjacent segments, bounds feedback and stays finite under hot input', () => {
    const dsp = new BrowserReverseDelayDsp(8000, {
      bpm: 300,
      segmentBeats: 0.25,
      feedback: 0.95,
      crossfadeMs: 1,
    });
    for (let frame = 0; frame < 400; frame += 1) dsp.processSample(4, -4);
    expect(dsp.wetLeft).toBe(0);
    for (let frame = 0; frame < 400; frame += 1) dsp.processSample(0, 0);
    expect(dsp.diagnostics.crossfadeCount).toBe(1);
    expect(dsp.wetLeft).toBeCloseTo(4, 4);

    // Capture a third segment while the second is being reversed. Its first
    // frames overlap the preserved prior tail and exercise the real boundary.
    const boundaryWet: number[] = [];
    for (let frame = 0; frame < 400; frame += 1) {
      dsp.processSample(1e20, -1e20);
      if (frame < 12) boundaryWet.push(dsp.wetLeft);
    }
    expect(dsp.diagnostics).toMatchObject({ boundaryCount: 3, crossfadeCount: 2 });
    expect(boundaryWet[0]).toBeCloseTo(4, 4);
    expect(boundaryWet[7]).toBeCloseTo(0.95, 4);
    expect(boundaryWet[10]).toBeCloseTo(0.95, 4);
    expect(Number.isFinite(dsp.wetLeft) && Number.isFinite(dsp.wetRight)).toBe(true);
    expect(Math.abs(dsp.wetLeft)).toBeLessThanOrEqual(8);
    expect(Math.abs(dsp.wetRight)).toBeLessThanOrEqual(8);
    expect(dsp.maxSegmentFrames).toBe(8000 * 6);
  });

  it('latches tempo and stepped segment controls at a sample-clocked boundary', () => {
    const dsp = new BrowserReverseDelayDsp(8000, {
      bpm: 120,
      segmentBeats: 0.25,
      feedback: 0,
      crossfadeMs: 10,
    });
    for (let frame = 0; frame < 123; frame += 1) dsp.processSample(0.1, -0.1);
    dsp.setParameters({ bpm: 60, segmentBeats: 0.49, feedback: 0.75, crossfadeMs: 40 });
    expect(dsp.diagnostics.activeBpm).toBe(120);
    expect(dsp.diagnostics.pendingBpm).toBe(60);
    for (let frame = 123; frame < 1000; frame += 1) dsp.processSample(0.1, -0.1);

    expect(dsp.diagnostics).toMatchObject({
      activeBpm: 60,
      activeSegmentBeats: 0.5,
      activeSegmentFrames: 4000,
      overlapFrames: 320,
      remainingFramesToBoundary: 4000,
    });
    expect(dsp.latencySamples).toBe(4000);
    expect(dsp.latencySamples).toBeGreaterThanOrEqual(dsp.diagnostics.activeSegmentFrames / 2);
  });

  it('reports segment buffering latency and renders identically across callback partitions', () => {
    expect(BROWSER_FX_ALGORITHM_INFO['reverse-delay']).toMatchObject({
      catalogFunction: 'REVERSE DELAY (catalog ID 38)',
      formulaIds: ['F14', 'F20', 'F25'],
      algorithmicLatencySamples: 24_000,
    });

    const input = new Float32Array(900);
    for (let frame = 0; frame < input.length; frame += 1) {
      input[frame] = Math.sin(frame * 0.17) * 0.3 + ((frame * 23) % 71) / 200;
    }
    const makeCore = () => {
      const core = new BrowserFxDspCore('reverse-delay', 8000, {
        bpm: 300,
        reverseDelaySegmentBeats: 0.25,
        reverseDelayCrossfadeMs: 1,
        reverseDelayFeedback: 0.3,
        mix: 0.7,
      });
      core.setBypass(false, 0);
      return core;
    };
    const wholeCore = makeCore();
    const blockCore = makeCore();
    expect(wholeCore.algorithmicLatencySamples).toBe(400);
    const whole = renderCore(wholeCore, input, [input.length]);
    const partitioned = renderCore(blockCore, input, [1, 31, 128, 257, 3, 17]);
    expect(partitioned).toEqual(whole);
    expect(partitioned.every(Number.isFinite)).toBe(true);
    expect(wholeCore.reverseDelayDiagnostics?.boundaryCount).toBe(blockCore.reverseDelayDiagnostics?.boundaryCount);
  });

  it('supports the FxProcessor algorithm selector and variable worklet frame lengths', () => {
    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'reverse-delay',
        sampleRate: 8000,
        parameters: { bpm: 300, reverseDelaySegmentBeats: 0.25, reverseDelayCrossfadeMs: 1 },
        bypassed: false,
      },
    });
    const input = new Float32Array(47);
    input[0] = 1;
    const output = new Float32Array(47);
    expect(processor.process([[input, input]], [[output, new Float32Array(47)]])).toBe(true);
    expect(processor.core.algorithm).toBe('reverse-delay');
    expect(processor.core.framesProcessed).toBe(47);
    expect(output.every(Number.isFinite)).toBe(true);
  });

  it('routes Browser Input and every shared Track A–D slot through reverse-delay Worklets', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, inputTail, trackHead, trackTail, trackMix } = makeEngine();
    for (let slot = 0; slot < 4; slot += 1) {
      engine.setFxType('input', slot, 'REVERSE DELAY');
      engine.setFxType('track', slot, 'REVERSE DELAY');
    }
    engine.setFxParam('input', 0, 60);
    const inputFx = (engine as unknown as {
      inputFxInstances: BrowserWorkletFX[];
      trackFxInstances: BrowserWorkletFX[];
    }).inputFxInstances;
    const trackFx = (engine as unknown as {
      inputFxInstances: BrowserWorkletFX[];
      trackFxInstances: BrowserWorkletFX[];
    }).trackFxInstances;
    inputFx[0]!.setParam('time', 2);
    inputFx[0]!.setParam('feedback', 75);
    inputFx[0]!.setParam('crossfade', 40);

    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(8));
    const transport = Transport.getInstance();
    const originalBpm = transport.bpm;
    transport.bpm = 140;
    (engine as unknown as { handleTransportBpmChange(): void }).handleTransportBpmChange();
    transport.bpm = originalBpm;
    const names = MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm);
    expect(names).toEqual(Array(8).fill('reverse-delay'));
    const installedInput = MockWorkletNode.instances[0]!.options.processorOptions?.parameters;
    expect(installedInput).toMatchObject({
      bpm: expect.any(Number),
      mix: 0.6,
      reverseDelaySegmentBeats: 2,
      reverseDelayFeedback: 0.75,
      reverseDelayCrossfadeMs: 40,
    });
    for (const node of MockWorkletNode.instances) {
      expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'configure', parameters: { bpm: 140 } });
    }

    expect(inputHead.connect).toHaveBeenCalledWith(inputFx[0]!.input);
    expect((inputFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(inputTail);
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[3]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
  });
});
