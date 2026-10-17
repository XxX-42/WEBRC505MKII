import { describe, expect, it } from 'vitest';
import { getLiveMonoPitchLatencySamples } from '../../src/audio/pitch/liveMono';
import { LiveMonoPitchWorkletProcessor } from '../../src/audio/pitch/liveMonoWorklet';

interface TestWorkletPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  readonly messages?: unknown[];
}

function sine(sampleRate: number, frequency: number, frameCount: number): Float32Array {
  const output = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    output[i] = 0.35 * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return output;
}

function newProcessor(semitones = 0): LiveMonoPitchWorkletProcessor {
  return new LiveMonoPitchWorkletProcessor({
    processorOptions: { sampleRate: 48_000, semitones },
  });
}

function testPort(processor: LiveMonoPitchWorkletProcessor): TestWorkletPort {
  return processor.port as unknown as TestWorkletPort;
}

function processBlocks(
  processor: LiveMonoPitchWorkletProcessor,
  input: Float32Array,
  output: Float32Array,
  blockSizes: readonly number[],
  secondOutput?: Float32Array,
): void {
  let offset = 0;
  let block = 0;
  while (offset < input.length) {
    const frames = Math.min(blockSizes[block % blockSizes.length]!, input.length - offset);
    const inputBlock = input.subarray(offset, offset + frames);
    const outputBlock = output.subarray(offset, offset + frames);
    const rightBlock = secondOutput?.subarray(offset, offset + frames);
    processor.process([[inputBlock]], [[outputBlock, ...(rightBlock ? [rightBlock] : [])]]);
    offset += frames;
    block += 1;
  }
}

describe('LIVE_MONO AudioWorklet protocol', () => {
  it('reports exact startup latency, accepts semitone control, and only sends status on request', () => {
    const processor = newProcessor();
    const port = testPort(processor);
    const startupMessages = port.messages;
    expect(startupMessages).toHaveLength(1);
    expect(startupMessages?.[0]).toMatchObject({
      type: 'ready',
      sampleRate: 48_000,
      latencySamples: getLiveMonoPitchLatencySamples(48_000),
      latencySeconds: getLiveMonoPitchLatencySamples(48_000) / 48_000,
      semitones: 0,
    });

    const control = port.onmessage;
    expect(control).not.toBeNull();
    control?.({ data: { type: 'set-semitones', semitones: 7 } });

    const input = sine(48_000, 220, 16_000);
    const left = new Float32Array(input.length);
    const right = new Float32Array(input.length);
    processBlocks(processor, input, left, [1, 17, 128, 511, 64], right);
    expect(port.messages).toHaveLength(1);
    for (let i = 0; i < left.length; i += 1) expect(right[i]).toBe(left[i]);

    control?.({ data: { type: 'get-status', requestId: 29 } });
    expect(port.messages).toHaveLength(2);
    expect(port.messages?.[1]).toMatchObject({
      type: 'status',
      requestId: 29,
      semitones: 7,
      voiced: true,
      frequencyHz: expect.closeTo(220, 1),
      latencySamples: getLiveMonoPitchLatencySamples(48_000),
    });
  });

  it('is bit-exact across different render block boundaries', () => {
    const input = sine(48_000, 330, 12_000);
    const contiguous = new Float32Array(input.length);
    const variable = new Float32Array(input.length);
    processBlocks(newProcessor(-5), input, contiguous, [input.length]);
    processBlocks(newProcessor(-5), input, variable, [3, 128, 509, 1, 64, 257]);

    let maximumDifference = 0;
    for (let i = 0; i < contiguous.length; i += 1) {
      maximumDifference = Math.max(maximumDifference, Math.abs(contiguous[i]! - variable[i]!));
    }
    expect(maximumDifference).toBe(0);
  });

  it('keeps disconnected worklet input silent while clocking its fixed delay', () => {
    const processor = newProcessor(7);
    const output = new Float32Array(513);
    const right = new Float32Array(513);
    expect(processor.process([[]], [[output, right]])).toBe(true);
    expect(output.every((sample) => sample === 0)).toBe(true);
    expect(right).toEqual(output);
    expect(testPort(processor).messages).toHaveLength(1);
  });
});
