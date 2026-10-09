import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BOUNCE_CAPTURE_HEADER_BYTES,
  BOUNCE_CAPTURE_HEADER_WORDS,
  BounceCaptureError,
  BounceCaptureState,
  BounceCaptureWord,
  assertBounceCaptureBuffer,
  createBounceCaptureBuffer,
  readStartFrame,
} from '../../src/project/bounceCaptureProtocol';

interface ProcessorPort {
  onmessage: ((event: { data: { type: string } }) => void) | null;
}

class AudioWorkletProcessorStub {
  port: ProcessorPort = { onmessage: null };
}

interface BounceProcessor extends AudioWorkletProcessorStub {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function createProcessor(sharedBuffer: SharedArrayBuffer, targetFrames: number, startFrame: number): {
  processor: BounceProcessor;
  sandbox: { currentFrame: number };
} {
  const source = readFileSync(path.join(process.cwd(), 'public', 'worklets', 'bounce-capture-processor.js'), 'utf8');
  let RegisteredProcessor: (new (options: unknown) => AudioWorkletProcessorStub) | null = null;
  const sandbox = {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    registerProcessor(_name: string, processor: new (options: unknown) => AudioWorkletProcessorStub) {
      RegisteredProcessor = processor;
    },
    SharedArrayBuffer,
    Int32Array,
    Float32Array,
    Atomics,
    Number,
    Math,
    currentFrame: 0,
  };
  vm.runInNewContext(source, sandbox, { filename: 'bounce-capture-processor.js' });
  if (!RegisteredProcessor) throw new Error('The production bounce capture processor did not register.');
  const processor = new RegisteredProcessor({ processorOptions: { buffer: sharedBuffer, targetFrames, startFrame } }) as BounceProcessor;
  return { processor, sandbox };
}

function makeOutput(frames: number): Float32Array[][] {
  return [[new Float32Array(frames), new Float32Array(frames)]];
}

describe('realtime bounce capture Worklet', () => {
  it('validates bounded layout, supports high frame epochs, and captures exact stereo chunks', () => {
    const startFrame = 0x2_0000_0010;
    const targetFrames = 140;
    const buffer = createBounceCaptureBuffer({ targetFrames, startFrame, chunkFrames: 128, slotCount: 64 });
    assertBounceCaptureBuffer(buffer, { targetFrames, startFrame });
    const header = new Int32Array(buffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
    expect(buffer.byteLength).toBe(BOUNCE_CAPTURE_HEADER_BYTES + 64 * 128 * 2 * Float32Array.BYTES_PER_ELEMENT);
    expect(readStartFrame(header)).toBe(startFrame);

    const { processor, sandbox } = createProcessor(buffer, targetFrames, startFrame);
    const silence = makeOutput(128);
    sandbox.currentFrame = startFrame - 128;
    expect(processor.process([[]], silence)).toBe(true);
    expect(Atomics.load(header, BounceCaptureWord.CAPTURED_FRAMES)).toBe(0);

    const left = Float32Array.from({ length: 128 }, (_, index) => index / 128);
    const right = Float32Array.from({ length: 128 }, (_, index) => -index / 256);
    sandbox.currentFrame = startFrame;
    expect(processor.process([[left, right]], makeOutput(128))).toBe(true);
    const tailLeft = Float32Array.from({ length: 128 }, (_, index) => 0.5 + index / 256);
    const tailRight = Float32Array.from({ length: 128 }, (_, index) => -0.25 - index / 512);
    sandbox.currentFrame = startFrame + 128;
    expect(processor.process([[tailLeft, tailRight]], makeOutput(128))).toBe(false);

    expect(Atomics.load(header, BounceCaptureWord.STATE)).toBe(BounceCaptureState.COMPLETE);
    expect(Atomics.load(header, BounceCaptureWord.CAPTURED_FRAMES)).toBe(targetFrames);
    expect(Atomics.load(header, BounceCaptureWord.WRITE_SEQUENCE)).toBe(2);
    expect(Atomics.load(header, BounceCaptureWord.SLOT_LENGTHS)).toBe(128);
    expect(Atomics.load(header, BounceCaptureWord.SLOT_LENGTHS + 1)).toBe(12);
    const samples = new Float32Array(buffer, BOUNCE_CAPTURE_HEADER_BYTES);
    expect(samples[0]).toBeCloseTo(0, 7);
    expect(samples[127]).toBeCloseTo(127 / 128, 7);
    expect(Math.abs(samples[128])).toBe(0);
    expect(samples[128 + 127]).toBeCloseTo(-127 / 256, 7);
    const secondSlot = 128 * 2;
    expect(samples[secondSlot]).toBeCloseTo(0.5, 7);
    expect(samples[secondSlot + 128]).toBeCloseTo(-0.25, 7);
  });

  it('keeps sample time moving through missing input and fails rather than overwriting a full ring', () => {
    const startFrame = 512;
    const missingInputBuffer = createBounceCaptureBuffer({ targetFrames: 16, startFrame, chunkFrames: 8, slotCount: 2 });
    const { processor, sandbox } = createProcessor(missingInputBuffer, 16, startFrame);
    sandbox.currentFrame = startFrame;
    expect(processor.process([[]], makeOutput(8))).toBe(true);
    sandbox.currentFrame = startFrame + 8;
    expect(processor.process([[]], makeOutput(8))).toBe(false);
    const silenceHeader = new Int32Array(missingInputBuffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
    const silenceData = new Float32Array(missingInputBuffer, BOUNCE_CAPTURE_HEADER_BYTES);
    expect(Atomics.load(silenceHeader, BounceCaptureWord.CAPTURED_FRAMES)).toBe(16);
    expect(silenceData.every((sample) => sample === 0)).toBe(true);

    const overflowBuffer = createBounceCaptureBuffer({ targetFrames: 8, startFrame, chunkFrames: 2, slotCount: 2 });
    const overflow = createProcessor(overflowBuffer, 8, startFrame);
    overflow.sandbox.currentFrame = startFrame;
    expect(overflow.processor.process([[new Float32Array(6), new Float32Array(6)]], makeOutput(6))).toBe(false);
    const overflowHeader = new Int32Array(overflowBuffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
    expect(Atomics.load(overflowHeader, BounceCaptureWord.STATE)).toBe(BounceCaptureState.FAILED);
    expect(Atomics.load(overflowHeader, BounceCaptureWord.ERROR)).toBe(BounceCaptureError.RING_OVERFLOW);
  });

  it('stops promptly when the caller cancels a live capture', () => {
    const startFrame = 0;
    const buffer = createBounceCaptureBuffer({ targetFrames: 64, startFrame });
    const { processor, sandbox } = createProcessor(buffer, 64, startFrame);
    const header = new Int32Array(buffer, 0, BOUNCE_CAPTURE_HEADER_WORDS);
    processor.port.onmessage?.({ data: { type: 'CANCEL' } });
    sandbox.currentFrame = startFrame;
    expect(processor.process([[new Float32Array(128), new Float32Array(128)]], makeOutput(128))).toBe(false);
    expect(Atomics.load(header, BounceCaptureWord.STATE)).toBe(BounceCaptureState.CANCELLED);
  });
});
