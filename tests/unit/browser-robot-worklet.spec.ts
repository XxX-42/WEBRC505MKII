import { describe, expect, it, vi } from 'vitest';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

const SAMPLE_RATE = 48_000;
const FRAME_COUNT = 24_000;

interface RobotTarget {
  type?: string;
  frame?: number;
  semitones?: number;
  sourceMidi?: number;
  targetMidi?: number;
  sourceHz?: number;
  confidence?: number;
  voiced?: boolean;
}

interface RobotMode {
  type?: string;
  frame?: number;
  mode?: string;
  reason?: string;
  trackerLatencyFrames?: number;
  psolaLatencySamples?: number;
}

function measurePositiveCrossings(signal: Float32Array, start: number, end: number): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let frame = Math.max(1, start); frame < Math.min(end, signal.length); frame += 1) {
    if (signal[frame - 1]! <= 0 && signal[frame]! > 0) {
      if (first < 0) first = frame;
      last = frame;
      count += 1;
    }
  }
  if (count < 2) throw new Error('Not enough worklet output crossings to measure pitch');
  return ((count - 1) * SAMPLE_RATE) / (last - first);
}

function render(blockSizes: readonly number[]) {
  const host = globalThis as unknown as { currentFrame?: number };
  const processor = new FxProcessor({
    processorOptions: {
      algorithm: 'robot',
      sampleRate: SAMPLE_RATE,
      parameters: { robotPitch: 7, robotFormantSemitones: 0 },
      bypassed: false,
    },
  });
  const postMessage = vi.fn();
  processor.port.postMessage = postMessage;
  const output = new Float32Array(FRAME_COUNT);
  let frame = 0;
  let blockIndex = 0;
  while (frame < FRAME_COUNT) {
    const length = Math.min(blockSizes[blockIndex % blockSizes.length]!, FRAME_COUNT - frame);
    const input = new Float32Array(length);
    const outputLeft = new Float32Array(length);
    const outputRight = new Float32Array(length);
    for (let offset = 0; offset < length; offset += 1) {
      input[offset] = 0.25 * Math.sin((2 * Math.PI * 220 * (frame + offset)) / SAMPLE_RATE);
    }
    host.currentFrame = frame;
    processor.process([[input]], [[outputLeft, outputRight]]);
    output.set(outputLeft, frame);
    expect(outputRight).toEqual(outputLeft);
    frame += length;
    blockIndex += 1;
  }
  return { processor, postMessage, output, host };
}

describe('Browser ROBOT worklet integration', () => {
  it('renders PSOLA-lite voiced output, reports its gate, and is block-segmentation invariant', () => {
    const previousFrame = (globalThis as unknown as { currentFrame?: number }).currentFrame;
    try {
      const whole = render([FRAME_COUNT]);
      const split = render([31, 127, 64, 83, 257]);
      const wholeMessages = whole.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
      const splitMessages = split.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
      const targets = splitMessages.filter((message) => message.type === 'robot-pitch-target') as RobotTarget[];
      const modes = splitMessages.filter((message) => message.type === 'robot-mode') as RobotMode[];

      expect(targets.length).toBeGreaterThan(0);
      expect(targets[0]).toMatchObject({ voiced: true, targetMidi: 64 });
      expect(targets[0]?.frame).toBeGreaterThan(0);
      expect(targets[0]?.semitones).toBeCloseTo(7, 0);
      expect(targets[0]?.sourceMidi).toBeCloseTo(57, 0);
      expect(targets[0]?.sourceHz).toBeCloseTo(220, 0);
      expect(targets.every((event) => Number.isSafeInteger(event.frame) && Number.isFinite(event.semitones))).toBe(true);
      for (let index = 1; index < targets.length; index += 1) {
        expect(targets[index]!.frame).toBeGreaterThan(targets[index - 1]!.frame!);
      }
      expect(modes.some((event) => event.mode === 'psola' && event.reason === 'stable-voiced')).toBe(true);
      expect(modes.every((event) => Number.isSafeInteger(event.frame) && event.trackerLatencyFrames! > 0)).toBe(true);
      expect(modes.find((event) => event.mode === 'psola')?.psolaLatencySamples).toBe(1_416);

      const pitch = measurePositiveCrossings(split.output, 7_000, 22_000);
      expect(Math.abs(pitch - 220 * 2 ** (7 / 12)) / (220 * 2 ** (7 / 12))).toBeLessThan(0.03);
      let finiteCount = 0;
      let activeSamples = 0;
      for (let frame = 0; frame < split.output.length; frame += 1) {
        const sample = split.output[frame]!;
        if (Number.isFinite(sample)) finiteCount += 1;
        if (Math.abs(sample) > 1e-8) activeSamples += 1;
      }
      expect(finiteCount).toBe(FRAME_COUNT);
      expect(activeSamples).toBeGreaterThan(10_000);
      expect(split.output).toEqual(whole.output);
      expect(wholeMessages.filter((message) => message.type === 'robot-pitch-target').length).toBe(targets.length);

      const silence = new Float32Array(8_000);
      const silenceOut = new Float32Array(silence.length);
      const frame = FRAME_COUNT;
      split.host.currentFrame = frame;
      split.processor.process([[silence]], [[silenceOut, new Float32Array(silence.length)]]);
      const afterSilence = split.postMessage.mock.calls
        .map(([message]) => message as RobotMode)
        .filter((message) => message.type === 'robot-mode');
      expect(afterSilence.at(-1)).toMatchObject({ mode: 'signalsmith', reason: 'unvoiced' });
    } finally {
      const host = globalThis as unknown as { currentFrame?: number };
      if (previousFrame === undefined) delete host.currentFrame;
      else host.currentFrame = previousFrame;
    }
  });
});
