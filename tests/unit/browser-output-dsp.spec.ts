import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

class MockWorkletNode {
  static instances: MockWorkletNode[] = [];
  static failNextConfigure = false;
  readonly port = {
    postMessage: vi.fn((message: any) => {
      if (message?.type !== 'configure') return;
      const fail = MockWorkletNode.failNextConfigure;
      MockWorkletNode.failNextConfigure = false;
      queueMicrotask(() => this.port.onmessage?.({
        data: fail ? { type: 'error', message: 'injected output DSP config failure' }
          : { type: 'configure-ack', parameterKeys: Object.keys(message.parameters ?? {}) },
      } as MessageEvent));
    }),
    onmessage: null as ((event: MessageEvent) => void) | null,
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;

  constructor(
    readonly context: BaseAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    MockWorkletNode.instances.push(this);
  }
}

function mockBrowserEngine(): {
  engine: BrowserAudioEngine;
  output: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  master: object;
  addModule: ReturnType<typeof vi.fn>;
} {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const output = { connect: vi.fn(), disconnect: vi.fn() };
  const master = {};
  const wet = { connect: vi.fn() };
  const dry = { connect: vi.fn() };
  wet.connect(output);
  dry.connect(output);
  const addModule = vi.fn(async (_url: string) => undefined);
  const destination = {};
  const context = {
    sampleRate: 48000,
    audioWorklet: { addModule },
    destination,
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
  } as unknown as AudioContext;
  Object.assign(engine, {
    context,
    outputFxChain: { output: wet },
    sharedTrackFxJoinNode: output,
    dryTrackMixGainNode: dry,
    mainGainNode: master,
    outputDspFxNode: null,
    fxWorkletModuleReady: null,
    fxWorkletGeneration: 0,
    selectedBufferFrames: 127,
  });
  return { engine, output, master, addModule };
}

describe('Browser master output DSP routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWorkletNode.instances = [];
    MockWorkletNode.failNextConfigure = false;
  });

  it('loads the checked-in worklet and routes the selected algorithm after the joined wet/dry paths and before MAIN', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, output, master, addModule } = mockBrowserEngine();

    const installed = await engine.setOutputDspFx('reverb', { mix: 0.32, decaySeconds: 3.5 }, true);

    expect(installed).toBe(true);
    expect(addModule).toHaveBeenCalledOnce();
    expect(addModule).toHaveBeenCalledWith('/worklets/fx-processor.js');
    expect(MockWorkletNode.instances).toHaveLength(1);
    const node = MockWorkletNode.instances[0]!;
    expect(node.name).toBe('rc505-fx-processor');
    expect(node.options.processorOptions).toMatchObject({
      algorithm: 'reverb',
      sampleRate: 48000,
      parameters: { mix: 0.32, decaySeconds: 3.5 },
      bypassed: false,
    });
    expect((engine as any).outputFxChain.output.connect).toHaveBeenCalledExactlyOnceWith(output);
    expect((engine as any).dryTrackMixGainNode.connect).toHaveBeenCalledExactlyOnceWith(output);
    expect(output.disconnect).toHaveBeenCalledWith(master);
    expect(output.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(master);

    engine.setOutputDspFxEnabled(false, 31);
    engine.configureOutputDspFx({ mix: 0.12 });
    expect(node.port.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'configure', parameters: { mix: 0.32, decaySeconds: 3.5 },
    });
    expect(node.port.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'set-bypass', value: true, rampFrames: 31,
    });
    expect(node.port.postMessage).toHaveBeenNthCalledWith(3, {
      type: 'configure', parameters: { mix: 0.12 },
    });
  });

  it('replaces the previous stage rather than accumulating multiple DSP nodes', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, output, master } = mockBrowserEngine();

    await engine.setOutputDspFx('lpf', { cutoffHz: 1000 });
    const previous = MockWorkletNode.instances[0]!;
    await engine.setOutputDspFx('ring-mod', { ringModHz: 220 });
    const next = MockWorkletNode.instances[1]!;

    expect(output.disconnect).toHaveBeenNthCalledWith(1, master);
    expect(output.disconnect).toHaveBeenNthCalledWith(2, previous);
    expect(previous.disconnect).toHaveBeenCalledTimes(2); // temporary readiness sink, then replaced live route
    expect(output.connect).toHaveBeenNthCalledWith(2, next);
    expect(next.connect).toHaveBeenCalledWith(master);
    expect(engine.outputDspFxNode).toBe(next);
  });

  it('reports unavailable instead of silently claiming a fallback path', async () => {
    const { engine, addModule } = mockBrowserEngine();
    Object.assign(engine, { context: { sampleRate: 48000, audioWorklet: undefined } });

    await expect(engine.setOutputDspFx('hpf')).resolves.toBe(false);
    expect(addModule).not.toHaveBeenCalled();
  });

  it('keeps the old output route when a candidate processor rejects readiness', async () => {
    vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
    const { engine, output } = mockBrowserEngine();
    await engine.setOutputDspFx('lpf', { cutoffHz: 1_000 });
    const previous = MockWorkletNode.instances[0]!;
    MockWorkletNode.failNextConfigure = true;

    const replacement = engine.setOutputDspFx('ring-mod', { ringModHz: 220 });
    const rejected = expect(replacement).rejects.toThrow('injected output DSP config failure');
    await vi.waitFor(() => expect(MockWorkletNode.instances).toHaveLength(2));
    const candidate = MockWorkletNode.instances[1]!;
    await rejected;
    expect(engine.outputDspFxNode).toBe(previous);
    expect(previous.disconnect).toHaveBeenCalledTimes(1); // only its original readiness sink was detached
    expect(candidate.disconnect).toHaveBeenCalledOnce();
    expect(output.disconnect).not.toHaveBeenCalledWith(previous);
  });
});
