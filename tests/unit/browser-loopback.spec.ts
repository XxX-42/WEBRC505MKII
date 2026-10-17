import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

class FakeWorkletPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly posted: Array<{ message: Record<string, unknown>; transferList: Transferable[] }> = [];

  postMessage(message: Record<string, unknown>, transferList: Transferable[] = []) {
    this.posted.push({ message: { ...message }, transferList });
  }

  receive(message: unknown) {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = new FakeWorkletPort();
  readonly connections: unknown[] = [];
  disconnected = false;

  constructor(
    _context: AudioContext,
    public readonly name: string,
    public readonly options?: AudioWorkletNodeOptions,
  ) {
    FakeAudioWorkletNode.instances.push(this);
  }

  connect(target: unknown) { this.connections.push(target); }
  disconnect() { this.disconnected = true; }
}

describe('BrowserAudioEngine loopback worklet capture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    FakeAudioWorkletNode.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the worklet and measures ordered samples from its bounded capture buffer', async () => {
    const engine = new BrowserAudioEngine();
    const addModule = vi.spyOn(engine.context.audioWorklet!, 'addModule');
    const latencyPromise = engine.runLoopbackTest();
    for (let index = 0; index < 64 && FakeAudioWorkletNode.instances.length === 0; index += 1) {
      await Promise.resolve();
    }

    const recorder = FakeAudioWorkletNode.instances.find((node) => node.name === 'rc505-loopback-capture');
    expect(recorder).toBeDefined();
    expect(addModule).toHaveBeenCalledWith('/worklets/browser-track-io.js');
    expect(recorder?.options?.processorOptions).toEqual({ captureFrames: engine.context.sampleRate });
    expect(recorder?.connections).toHaveLength(1); // A muted sink keeps the capture node pulled.

    const samples = new Float32Array(engine.context.sampleRate);
    samples[5000] = 0.8;
    recorder?.port.receive({ type: 'LOOPBACK_CAPTURE', framesCaptured: samples.length, samples });
    await vi.advanceTimersByTimeAsync(1200);

    await expect(latencyPromise).resolves.toBeCloseTo(((5000 / engine.context.sampleRate) - 0.1) * 1000, 4);
    expect(recorder?.disconnected).toBe(true);
  });

  it('surfaces an explicit AudioWorklet error without requesting a microphone stream', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const engine = new BrowserAudioEngine();

    await expect(engine.runLoopbackTest()).rejects.toThrow('Loopback capture requires AudioWorklet');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(engine.getUiStatus().lastError).toContain('AudioWorklet');
  });
});
