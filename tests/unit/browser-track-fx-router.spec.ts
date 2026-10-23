import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

class WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly messages: any[] = [];
  postMessage(message: any) { this.messages.push({ ...message }); }
  receive(message: unknown) { this.onmessage?.({ data: message }); }
}

class WorkletBase {
  readonly port = new WorkletPort();
  constructor(_options?: unknown) {}
}

function loadProcessor() {
  const source = readFileSync(resolve(process.cwd(), 'public/worklets/browser-track-fx-router.js'), 'utf8');
  const factory = new Function('AudioWorkletProcessor', 'registerProcessor', `${source}\nreturn BrowserTrackFxRouterProcessor;`) as (
    base: typeof WorkletBase,
    register: (name: string, processor: new (options?: any) => any) => void,
  ) => new (options?: any) => any;
  return factory(WorkletBase, () => {});
}

function createRouter() {
  const Processor = loadProcessor();
  const processor = new Processor({ processorOptions: { trackCount: 5 } });
  const process = (frameStart: number, inputs: number[][][]) => {
    const frames = inputs[0]?.[0]?.length ?? 0;
    const outputs = Array.from({ length: 10 }, () => [new Float32Array(frames), new Float32Array(frames)]);
    const runtimeGlobal = globalThis as typeof globalThis & { currentFrame?: number };
    const hadFrame = Object.prototype.hasOwnProperty.call(runtimeGlobal, 'currentFrame');
    const previousFrame = runtimeGlobal.currentFrame;
    runtimeGlobal.currentFrame = frameStart;
    try { expect(processor.process(inputs.map((track) => track.map((channel) => Float32Array.from(channel))), outputs)).toBe(true); }
    finally {
      if (hadFrame) runtimeGlobal.currentFrame = previousFrame;
      else delete runtimeGlobal.currentFrame;
    }
    return outputs;
  };
  return { processor, process };
}

describe('Browser per-track shared Track FX router', () => {
  it('routes each stereo track independently and switches wet to dry on the requested frame', () => {
    const router = createRouter();
    router.processor.port.receive({
      type: 'SET_TRACK_FX_APPLY', trackIndex: 1, enabled: false, revision: 1, applyFrame: 102,
    });
    const outputs = router.process(100, [
      [[1, 2, 3, 4], [11, 12, 13, 14]],
      [[21, 22, 23, 24], [31, 32, 33, 34]],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
      [[0, 0, 0, 0], [0, 0, 0, 0]],
    ]);

    expect(Array.from(outputs[0]![0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(outputs[0]![1]!)).toEqual([11, 12, 13, 14]);
    expect(Array.from(outputs[2]![0]!)).toEqual([21, 22, 0, 0]);
    expect(Array.from(outputs[2]![1]!)).toEqual([31, 32, 0, 0]);
    expect(Array.from(outputs[3]![0]!)).toEqual([0, 0, 23, 24]);
    expect(Array.from(outputs[3]![1]!)).toEqual([0, 0, 33, 34]);
    expect(Array.from(outputs[4]![0]!)).toEqual([0, 0, 0, 0]);
    expect(router.processor.port.messages).toContainEqual(expect.objectContaining({
      type: 'TRACK_FX_APPLY_ACK', route: 'track', trackIndex: 1, revision: 1,
      enabled: false, requestedFrame: 102, appliedFrame: 102, ok: true,
    }));
  });

  it('rejects a route change if its requested render frame has already passed', () => {
    const router = createRouter();
    router.processor.port.receive({
      type: 'SET_TRACK_FX_APPLY', trackIndex: 0, enabled: false, revision: 1, applyFrame: 99,
    });
    const outputs = router.process(100, [
      [[1, 2], [3, 4]], [], [], [], [],
    ]);
    expect(Array.from(outputs[0]![0]!)).toEqual([1, 2]);
    expect(Array.from(outputs[1]![0]!)).toEqual([0, 0]);
    expect(router.processor.port.messages).toContainEqual(expect.objectContaining({
      route: 'track', revision: 1, ok: false, reason: 'track-fx-apply-frame-missed',
    }));
  });
});
