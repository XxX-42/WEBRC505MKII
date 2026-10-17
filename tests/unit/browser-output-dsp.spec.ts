import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

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

function mockBrowserEngine(): {
  engine: BrowserAudioEngine;
  output: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  master: object;
  addModule: ReturnType<typeof vi.fn>;
} {
  const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
  const output = { connect: vi.fn(), disconnect: vi.fn() };
  const master = {};
  const addModule = vi.fn(async (_url: string) => undefined);
  const context = {
    sampleRate: 48000,
    audioWorklet: { addModule },
  } as unknown as AudioContext;
  Object.assign(engine, {
    context,
    outputFxChain: { output },
    masterGainNode: master,
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
  });

  it('loads the checked-in worklet and routes the selected algorithm between output FX and master', async () => {
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
    expect(output.disconnect).toHaveBeenCalledWith(master);
    expect(output.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(master);

    engine.setOutputDspFxEnabled(false, 31);
    engine.configureOutputDspFx({ mix: 0.12 });
    expect(node.port.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'set-bypass', value: true, rampFrames: 31,
    });
    expect(node.port.postMessage).toHaveBeenNthCalledWith(2, {
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
    expect(previous.disconnect).toHaveBeenCalledOnce();
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
});
