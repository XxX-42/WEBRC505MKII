import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { BrowserFxDspCore } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { BrowserBeatShiftDsp } from '../../src/audio/fx/dsp/BrowserBeatShiftDsp';
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
  trackHead: MockAudioNode;
  trackTail: MockAudioNode;
  trackMix: MockAudioNode;
} {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const inputHead = new MockAudioNode();
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
    inputFxChain: { input: inputHead, output: new MockAudioNode() },
    outputFxChain: { input: trackHead, output: trackTail },
    trackMixNode: trackMix,
    currentInputStream: null,
    inputFxInstances: [null, null, null, null],
    trackFxInstances: [null, null, null, null],
    inputFxTypes: [null, null, null, null],
    trackFxTypes: [null, null, null, null],
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    lastError: '',
    statusListeners: new Set(),
  });
  return { engine, inputHead, trackHead, trackTail, trackMix };
}

function makeSignal(frames: number): Float32Array {
  const signal = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // Aperiodic enough that different beat offsets are unambiguous.
    const n = frame + 1;
    signal[frame] = (((n * 127 + (n >>> 3) * 31) % 997) / 997) * 0.7 - 0.35;
  }
  return signal;
}

function renderCore(
  core: BrowserFxDspCore,
  left: Float32Array,
  right: Float32Array,
  blocks: readonly number[],
): [Float32Array, Float32Array] {
  const outputLeft = new Float32Array(left.length);
  const outputRight = new Float32Array(right.length);
  let offset = 0;
  let block = 0;
  while (offset < left.length) {
    const frames = Math.min(blocks[block % blocks.length] ?? left.length, left.length - offset);
    core.processBlock(
      left.subarray(offset, offset + frames),
      right.subarray(offset, offset + frames),
      outputLeft.subarray(offset, offset + frames),
      outputRight.subarray(offset, offset + frames),
      frames,
    );
    offset += frames;
    block += 1;
  }
  return [outputLeft, outputRight];
}

describe('Browser clean-room BEAT SHIFT (catalog source ID 52)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
  });

  it('uses the provisional signed-offset contract with explicit four-beat live look-ahead', () => {
    const atZero = new BrowserBeatShiftDsp(8000, { bpm: 120, offsetBeats: 0, crossfadeMs: 5 });
    const future = new BrowserBeatShiftDsp(8000, { bpm: 120, offsetBeats: 1, crossfadeMs: 5 });
    const past = new BrowserBeatShiftDsp(8000, { bpm: 120, offsetBeats: -1, crossfadeMs: 5 });

    expect(atZero.diagnostics.currentDelayFrames).toBe(16_000); // Four beats at 120 BPM.
    expect(future.diagnostics.currentDelayFrames).toBe(12_000); // +1 is three beats old.
    expect(past.diagnostics.currentDelayFrames).toBe(20_000); // -1 is five beats old.
    expect(future.diagnostics.maxDelayFrames).toBe(96_004); // Eight beats at 40 BPM, plus interpolation guard.
    expect(new BrowserBeatShiftDsp(48000, { bpm: 120, offsetBeats: 1 }).diagnostics.currentDelayFrames)
      .toBe(72_000);

    const source = makeSignal(21_000);
    const run = (offsetBeats: number) => {
      const core = new BrowserFxDspCore('beat-shift', 8000, {
        bpm: 120,
        beatShiftOffsetBeats: offsetBeats,
        beatShiftCrossfadeMs: 5,
        mix: 1,
      });
      core.setBypass(false, 0);
      const output = renderCore(core, source, source, [source.length]);
      return { core, output };
    };
    const plus = run(1);
    const minus = run(-1);
    expect(plus.core.algorithmicLatencySamples).toBe(12_000);
    expect(minus.core.algorithmicLatencySamples).toBe(20_000);
    expect(plus.output[0][12_100]).toBeCloseTo(source[100] ?? 0, 5);
    expect(minus.output[0][20_100]).toBeCloseTo(source[100] ?? 0, 5);
    expect(plus.output[0].slice(20_100)).not.toEqual(minus.output[0].slice(20_100));
    expect(plus.output[0].every(Number.isFinite)).toBe(true);
    expect(minus.output[1].every(Number.isFinite)).toBe(true);
  });

  it('is invariant to variable process-block segmentation and crossfades tempo/offset updates', () => {
    const source = makeSignal(27_000);
    const render = (blocks: readonly number[]) => {
      const core = new BrowserFxDspCore('beat-shift', 8000, {
        bpm: 120,
        beatShiftOffsetBeats: 1,
        beatShiftCrossfadeMs: 5,
        mix: 1,
      });
      core.setBypass(false, 0);
      return { core, output: renderCore(core, source, source, blocks) };
    };
    const whole = render([source.length]);
    const variable = render([1, 31, 128, 257, 3, 511, 17]);
    expect(variable.output[0]).toEqual(whole.output[0]);
    expect(variable.output[1]).toEqual(whole.output[1]);

    const dsp = new BrowserBeatShiftDsp(8000, { bpm: 120, offsetBeats: 1, crossfadeMs: 5 });
    for (let frame = 0; frame < 13_000; frame += 1) dsp.processSample(0.1, -0.1);
    dsp.setParameters({ bpm: 60, offsetBeats: -1 });
    for (let frame = 0; frame < 40_100; frame += 1) dsp.processSample(0.1, -0.1);
    expect(dsp.diagnostics).toMatchObject({
      currentBpm: 60,
      currentOffsetBeats: -1,
      currentDelayFrames: 40_000,
      transitionCount: 1,
      transitionRemainingFrames: 0,
      hasHistory: true,
    });
    expect(Number.isFinite(dsp.wetLeft) && Number.isFinite(dsp.wetRight)).toBe(true);
  });

  it('moves between fixed read heads with a bounded equal-power crossfade', () => {
    const sampleRate = 8000;
    const core = new BrowserFxDspCore('beat-shift', sampleRate, {
      bpm: 120, beatShiftOffsetBeats: 1, beatShiftCrossfadeMs: 10, mix: 1,
    });
    core.setBypass(false, 0);
    const warm = new Float32Array(20_000);
    for (let frame = 0; frame < warm.length; frame += 1) {
      warm[frame] = Math.sin((2 * Math.PI * 7 * frame) / sampleRate) * 0.3;
    }
    renderCore(core, warm, warm, [warm.length]);
    core.setParameters({ beatShiftOffsetBeats: -1, beatShiftCrossfadeMs: 10 });

    const transitionInput = new Float32Array(1_000);
    for (let frame = 0; frame < transitionInput.length; frame += 1) {
      transitionInput[frame] = Math.sin((2 * Math.PI * 7 * (warm.length + frame)) / sampleRate) * 0.3;
    }
    const transitionOutput = renderCore(core, transitionInput, transitionInput, [1, 37, 128, 3])[0];
    let maximumStep = 0;
    for (let frame = 1; frame < transitionOutput.length; frame += 1) {
      maximumStep = Math.max(maximumStep, Math.abs((transitionOutput[frame] ?? 0) - (transitionOutput[frame - 1] ?? 0)));
    }
    expect(core.beatShiftDiagnostics?.transitionCount).toBe(1);
    expect(maximumStep).toBeLessThan(0.15);
  });

  it('keeps exact dry output while bypassed, warms its buffer, and fades on user activation', () => {
    const core = new BrowserFxDspCore('beat-shift', 8000, {
      bpm: 120,
      beatShiftOffsetBeats: 1,
      beatShiftCrossfadeMs: 5,
      mix: 1,
    });
    core.setBypass(true, 0);
    const warm = makeSignal(13_000);
    const warmOut = renderCore(core, warm, warm, [7, 128, 11]);
    expect(warmOut[0]).toEqual(warm);
    expect(core.beatShiftDiagnostics?.hasHistory).toBe(true);

    core.setBypass(false, 128);
    const activation = makeSignal(1024);
    const activeOut = renderCore(core, activation, activation, [31, 128, 17]);
    expect(activeOut[0].every(Number.isFinite)).toBe(true);
    expect(activeOut[0]).not.toEqual(activation);

    const direct = makeSignal(14_000);
    const noMixControl = (mix: number) => {
      const instance = new BrowserFxDspCore('beat-shift', 8000, {
        bpm: 120, beatShiftOffsetBeats: 1, beatShiftCrossfadeMs: 5, mix,
      });
      instance.setBypass(false, 0);
      return renderCore(instance, direct, direct, [1, 129, 9])[0];
    };
    expect(noMixControl(0)).toEqual(noMixControl(1));
    expect(noMixControl(1)[12_100]).toBeCloseTo(direct[100] ?? 0, 5);
  });

  it('keeps the shared Track A–D adapters dry for source-aware routing and preserves variable channels', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, inputHead, trackHead, trackTail, trackMix } = makeEngine();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    engine.setFxType('input', 0, 'BEAT SHIFT');
    expect(warning).toHaveBeenCalledWith('BEAT SHIFT is available only in the Browser Track FX bank.');
    expect(inputHead.connect).not.toHaveBeenCalled();
    expect(MockWorkletNode.instances).toHaveLength(0);

    engine.setFxType('track', 0, 'BEAT SHIFT');
    engine.setFxType('track', 1, 'BEAT SHIFT');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    expect(trackMix.connect).toHaveBeenCalledWith(trackHead);
    const trackFx = (engine as unknown as { trackFxInstances: Array<{ input: AudioNode; output: AudioNode; setParam(key: string, value: number): void } | null> }).trackFxInstances;
    expect(trackHead.connect).toHaveBeenCalledWith(trackFx[0]!.input);
    expect((trackFx[0]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackFx[1]!.input);
    expect((trackFx[1]!.output as unknown as MockAudioNode).connect).toHaveBeenCalledWith(trackTail);
    expect(MockWorkletNode.instances.map((node) => node.options.processorOptions?.algorithm)).toEqual(['beat-shift', 'beat-shift']);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.bypassed).toBe(true);
    expect(MockWorkletNode.instances[0]!.options.processorOptions?.parameters).toMatchObject({ bpm: 120 });

    const transport = Transport.getInstance();
    const savedBpm = transport.bpm;
    transport.bpm = 132;
    (engine as unknown as { handleTransportBpmChange(): void }).handleTransportBpmChange();
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { bpm: 132 },
    });
    transport.bpm = savedBpm;

    trackFx[0]!.setParam('offset', -2);
    trackFx[0]!.setParam('crossfade', 10);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { beatShiftOffsetBeats: -2 },
    });
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'configure', parameters: { beatShiftCrossfadeMs: 10 },
    });
    trackFx[0]!.setParam('mix', 75);
    expect(MockWorkletNode.instances[0]!.port.postMessage).not.toHaveBeenCalledWith({
      type: 'configure', parameters: { mix: 0.75 },
    });
    engine.setFxActive('track', 0, true);
    expect(MockWorkletNode.instances[0]!.port.postMessage).toHaveBeenCalledWith({
      type: 'set-bypass', value: true, rampFrames: 128,
    });

    const processor = new FxProcessor({
      processorOptions: {
        algorithm: 'beat-shift', sampleRate: 8000,
        parameters: { bpm: 300, beatShiftOffsetBeats: 4, mix: 1 }, bypassed: false,
      },
    });
    for (const frames of [1, 17, 129, 43]) {
      const mono = new Float32Array(frames).fill(0.2);
      const extraInput = new Float32Array(frames).fill(-0.3);
      const outputs = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
      expect(processor.process([[mono, mono, extraInput]], [outputs])).toBe(true);
      expect(outputs[0]!.every(Number.isFinite)).toBe(true);
      expect(outputs[1]!.every(Number.isFinite)).toBe(true);
      expect(outputs[2]).toEqual(extraInput);
    }
    warning.mockRestore();
  });
});
