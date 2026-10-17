import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface RegisteredWorklet {
  new (): {
    port: { messages: unknown[] };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  };
}

function loadProcessor(): InstanceType<RegisteredWorklet> {
  let Processor: RegisteredWorklet | undefined;
  class MockAudioWorkletProcessor {
    port = { messages: [] as unknown[], postMessage(message: unknown) { this.messages.push(message); } };
  }

  const source = readFileSync(resolve(process.cwd(), 'public/worklets/browser-block-meter.js'), 'utf8');
  runInNewContext(source, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor: (_name: string, processor: RegisteredWorklet) => { Processor = processor; },
  });
  if (!Processor) throw new Error('Worklet processor was not registered');
  return new Processor() as InstanceType<RegisteredWorklet>;
}

describe('browser master block meter worklet', () => {
  it('passes samples through and reports the actual non-128 frame quantum', () => {
    const processor = loadProcessor();
    const left = Float32Array.from({ length: 127 }, (_, index) => index / 127);
    const right = Float32Array.from({ length: 127 }, (_, index) => -index / 127);
    const outLeft = new Float32Array(127);
    const outRight = new Float32Array(127);

    expect(processor.process([[left, right]], [[outLeft, outRight]])).toBe(true);
    expect(outLeft).toEqual(left);
    expect(outRight).toEqual(right);
    expect(processor.port.messages).toEqual([{
      type: 'render-quantum-shape', frames: 127, inputChannels: 2, outputChannels: 2,
    }]);
  });

  it('updates its measurement when block size changes and zeros unmatched channels', () => {
    const processor = loadProcessor();
    const prior = processor.port.messages.length;
    const left = Float32Array.from([0.25, -0.5, 1]);
    const outLeft = new Float32Array(3);
    const outRight = new Float32Array(3);

    processor.process([[left]], [[outLeft, outRight]]);
    expect(outLeft).toEqual(left);
    expect(outRight).toEqual(new Float32Array(3));
    expect(processor.port.messages.length).toBe(prior + 1);
    expect(processor.port.messages.at(-1)).toEqual({
      type: 'render-quantum-shape', frames: 3, inputChannels: 1, outputChannels: 2,
    });
  });
});
