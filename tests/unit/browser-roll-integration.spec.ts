import { describe, expect, it } from 'vitest';
import { FxProcessor } from '../../src/audio/worklet/FxProcessor';

function processBlock(processor: FxProcessor, left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
  const outLeft = new Float32Array(left.length);
  const outRight = new Float32Array(right.length);
  expect(processor.process([[left, right]], [[outLeft, outRight]])).toBe(true);
  return [outLeft, outRight];
}

describe('Browser ROLL worklet integration', () => {
  it('preserves dry input during first capture and emits the captured stereo slice at sample-clock boundaries', () => {
    const processor = new FxProcessor({ processorOptions: {
      algorithm: 'roll', sampleRate: 8000, bypassed: false,
      parameters: { bpm: 120, rollSliceBeats: 0.25, rollDecayPercent: 100, rollPitchSemitones: 0, rollDirection: 0, mix: 1 },
    } });
    const captureLeft = new Float32Array(1000);
    const captureRight = new Float32Array(1000);
    for (let frame = 0; frame < 1000; frame += 1) {
      captureLeft[frame] = frame / 1000;
      captureRight[frame] = -(frame / 1000);
    }
    const initial = processBlock(processor, captureLeft, captureRight);
    for (let frame = 0; frame < captureLeft.length; frame += 1) {
      expect(initial[0][frame]).toBeCloseTo(captureLeft[frame]!, 6);
      expect(initial[1][frame]).toBeCloseTo(captureRight[frame]!, 6);
    }
    expect(processor.core.algorithm).toBe('roll');

    // Host quanta intentionally vary; ROLL's local beat clock is sample based.
    const lengths = [1, 37, 128, 257, 3, 64];
    let processed = 0;
    let block = 0;
    let positiveLeftSeen = false;
    let negativeRightSeen = false;
    while (processed < 500) {
      const length = Math.min(lengths[block % lengths.length]!, 500 - processed);
      const liveLeft = new Float32Array(length).fill(-0.4);
      const liveRight = new Float32Array(length).fill(0.4);
      const output = processBlock(processor, liveLeft, liveRight);
      for (let frame = 24; frame < length; frame += 1) {
        if (output[0][frame]! > 0.03) positiveLeftSeen = true;
        if (output[1][frame]! < -0.03) negativeRightSeen = true;
      }
      processed += length;
      block += 1;
    }
    expect(positiveLeftSeen).toBe(true);
    expect(negativeRightSeen).toBe(true);
  });

  it('applies queued ROLL changes through the worklet configure message', () => {
    const processor = new FxProcessor({ processorOptions: {
      algorithm: 'roll', sampleRate: 8000, bypassed: false,
      parameters: { bpm: 120, rollSliceBeats: 0.25, mix: 1 },
    } });
    processor.port.onmessage?.({ data: { type: 'configure', parameters: { rollSliceBeats: 0.5, rollPitchSemitones: 12, rollDirection: 1 } } });
    const core = processor.core as unknown as { roll: { diagnostics: { activeSliceBeats: number; activePitchSemitones: number; activeDirection: string } } };
    // Updates latch at the next 0.25-beat boundary.
    processBlock(processor, new Float32Array(1000), new Float32Array(1000));
    expect(core.roll.diagnostics).toMatchObject({ activeSliceBeats: 0.5, activePitchSemitones: 12, activeDirection: 'reverse' });
  });
});
