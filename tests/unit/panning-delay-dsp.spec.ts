import { describe, expect, it } from 'vitest';
import { BrowserPanningDelayDsp } from '../../src/audio/fx/dsp/BrowserPanningDelayDsp';

function makeDelay(sampleRate = 8000, overrides: ConstructorParameters<typeof BrowserPanningDelayDsp>[1] = {}) {
  return new BrowserPanningDelayDsp(sampleRate, {
    timeMs: 4,
    feedback: 0,
    pan: 0,
    mix: 100,
    ...overrides,
  });
}

function render(
  dsp: BrowserPanningDelayDsp,
  inputLeft: Float32Array,
  inputRight: Float32Array | null = null,
) {
  const outputLeft = new Float32Array(inputLeft.length);
  const outputRight = inputRight === null ? null : new Float32Array(inputRight.length);
  dsp.processBlock(inputLeft, inputRight, outputLeft, outputRight);
  return { outputLeft, outputRight };
}

describe('Browser PANNING DELAY DSP', () => {
  it('places the first impulse repeat at the selected equal-power pan position', () => {
    const frames = 96;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    inputLeft[0] = 1;

    const leftPan = render(makeDelay(8000, { pan: -100 }), inputLeft, inputRight);
    const centerPan = render(makeDelay(8000, { pan: 0 }), inputLeft, inputRight);
    const rightPan = render(makeDelay(8000, { pan: 100 }), inputLeft, inputRight);

    // 4 ms at 8 kHz is exactly 32 samples; the downmixed repeat is 1/sqrt(2).
    expect(leftPan.outputLeft[32] ?? 0).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(leftPan.outputRight?.[32] ?? 0)).toBeLessThan(1e-6);
    expect(centerPan.outputLeft[32] ?? 0).toBeCloseTo(0.5, 6);
    expect(centerPan.outputRight?.[32] ?? 0).toBeCloseTo(0.5, 6);
    expect(Math.abs(rightPan.outputLeft[32] ?? 0)).toBeLessThan(1e-6);
    expect(rightPan.outputRight?.[32] ?? 0).toBeCloseTo(Math.SQRT1_2, 6);

    for (let index = 0; index < 32; index += 1) {
      expect(Math.abs(centerPan.outputLeft[index] ?? 0)).toBeLessThan(1e-6);
      expect(Math.abs(centerPan.outputRight?.[index] ?? 0)).toBeLessThan(1e-6);
    }
  });

  it('uses fractional delay taps rather than rounding the delay time', () => {
    const input = new Float32Array(80);
    const right = new Float32Array(80);
    input[0] = 1;
    const { outputLeft, outputRight } = render(makeDelay(8000, { timeMs: 4.0625, pan: 0 }), input, right);

    expect(Math.abs(outputLeft[32] ?? 0)).toBeGreaterThan(0.1);
    expect(Math.abs(outputLeft[33] ?? 0)).toBeGreaterThan(0.2);
    expect(Math.abs((outputLeft[33] ?? 0) - (outputLeft[32] ?? 0))).toBeGreaterThan(0.1);
    expect(outputRight?.[32]).toBeCloseTo(outputLeft[32] ?? 0, 6);
  });

  it('cross-feeds repeats to the opposite line and applies feedback to later repeats', () => {
    const frames = 112;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    inputLeft[0] = 1;
    const noFeedback = render(makeDelay(8000, { feedback: 0, pan: -100 }), inputLeft, inputRight);
    const feedback = render(makeDelay(8000, { feedback: 80, pan: -100 }), inputLeft, inputRight);

    expect(noFeedback.outputLeft[32] ?? 0).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(noFeedback.outputLeft[64] ?? 0)).toBeLessThan(1e-6);
    expect(feedback.outputLeft[64] ?? 0).toBeGreaterThan(0.2);
    expect(feedback.outputLeft[64] ?? 0).toBeLessThan(feedback.outputLeft[32] ?? 0);
  });

  it('is invariant to variable callback lengths and mid-stream control updates', () => {
    const frames = 6000;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      inputLeft[index] = Math.sin(index * 0.071) * 0.7;
      inputRight[index] = Math.cos(index * 0.043) * 0.4;
    }

    const whole = makeDelay(8000, { timeMs: 37.25, feedback: 83, pan: -65, mix: 91 });
    const chunked = makeDelay(8000, { timeMs: 37.25, feedback: 83, pan: -65, mix: 91 });
    const wholeLeft = new Float32Array(frames);
    const wholeRight = new Float32Array(frames);
    const chunkedLeft = new Float32Array(frames);
    const chunkedRight = new Float32Array(frames);
    const changeAt = 1703;
    const newParameters = { timeMs: 51.125, feedback: 67, pan: 42, mix: 78 };

    whole.processBlock(inputLeft.subarray(0, changeAt), inputRight.subarray(0, changeAt), wholeLeft.subarray(0, changeAt), wholeRight.subarray(0, changeAt));
    whole.setParameters(newParameters);
    whole.processBlock(inputLeft.subarray(changeAt), inputRight.subarray(changeAt), wholeLeft.subarray(changeAt), wholeRight.subarray(changeAt));

    const chunks = [1, 37, 128, 9, 511, 64];
    let offset = 0;
    let chunkIndex = 0;
    let controlsChanged = false;
    while (offset < frames) {
      if (!controlsChanged && offset >= changeAt) {
        chunked.setParameters(newParameters);
        controlsChanged = true;
      }
      const boundary = controlsChanged ? frames : changeAt;
      const count = Math.min(chunks[chunkIndex % chunks.length] ?? 1, boundary - offset, frames - offset);
      chunked.processBlock(
        inputLeft.subarray(offset, offset + count),
        inputRight.subarray(offset, offset + count),
        chunkedLeft.subarray(offset, offset + count),
        chunkedRight.subarray(offset, offset + count),
        count,
      );
      offset += count;
      chunkIndex += 1;
    }

    for (let index = 0; index < frames; index += 1) {
      expect(chunkedLeft[index]).toBeCloseTo(wholeLeft[index] ?? 0, 6);
      expect(chunkedRight[index]).toBeCloseTo(wholeRight[index] ?? 0, 6);
    }
  });

  it('keeps long high-feedback runs finite and bounded for hostile input', () => {
    const frames = 24000;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      inputLeft[index] = index % 2 === 0 ? 100 : -100;
      inputRight[index] = index % 3 === 0 ? Number.NaN : 100;
    }
    inputLeft[1] = Number.POSITIVE_INFINITY;
    inputRight[2] = Number.NEGATIVE_INFINITY;
    const outputLeft = new Float32Array(frames);
    const outputRight = new Float32Array(frames);
    makeDelay(8000, { feedback: 95, pan: 28, mix: 100 })
      .processBlock(inputLeft, inputRight, outputLeft, outputRight);

    for (let index = 0; index < frames; index += 1) {
      expect(Number.isFinite(outputLeft[index])).toBe(true);
      expect(Number.isFinite(outputRight[index])).toBe(true);
      expect(Math.abs(outputLeft[index] ?? 0)).toBeLessThanOrEqual(8);
      expect(Math.abs(outputRight[index] ?? 0)).toBeLessThanOrEqual(8);
    }
  });

  it('clamps constructor and updated parameter values to the catalog ranges', () => {
    const input = new Float32Array(64);
    const right = new Float32Array(64);
    input[0] = 1;
    const highOutOfRange = render(
      makeDelay(8000, { timeMs: -20, feedback: 200, pan: 180, mix: 130 }),
      input,
      right,
    );
    const highAtEdge = render(
      makeDelay(8000, { timeMs: 1, feedback: 95, pan: 100, mix: 100 }),
      input,
      right,
    );
    const lowOutOfRange = render(
      makeDelay(8000, { timeMs: 5000, feedback: -50, pan: -200, mix: -10 }),
      input,
      right,
    );
    const lowAtEdge = render(
      makeDelay(8000, { timeMs: 2000, feedback: 0, pan: -100, mix: 0 }),
      input,
      right,
    );

    // The long-delay pair has no echo in this short render. The wet mix clamp
    // is still observable through the direct signal.
    for (let index = 0; index < input.length; index += 1) {
      expect(highOutOfRange.outputLeft[index]).toBeCloseTo(highAtEdge.outputLeft[index] ?? 0, 6);
      expect(highOutOfRange.outputRight?.[index]).toBeCloseTo(highAtEdge.outputRight?.[index] ?? 0, 6);
      expect(lowOutOfRange.outputLeft[index]).toBeCloseTo(lowAtEdge.outputLeft[index] ?? 0, 6);
      expect(lowOutOfRange.outputRight?.[index]).toBeCloseTo(lowAtEdge.outputRight?.[index] ?? 0, 6);
    }

    const longFrames = 16080;
    const longImpulse = new Float32Array(longFrames);
    const longRight = new Float32Array(longFrames);
    longImpulse[0] = 1;
    const maxTimeOutOfRange = render(
      makeDelay(8000, { timeMs: 5000, feedback: 0, pan: 0, mix: 100 }),
      longImpulse,
      longRight,
    );
    const maxTimeAtEdge = render(
      makeDelay(8000, { timeMs: 2000, feedback: 0, pan: 0, mix: 100 }),
      longImpulse,
      longRight,
    );
    expect(Math.abs(maxTimeAtEdge.outputLeft[16000] ?? 0)).toBeGreaterThan(0.4);
    for (let index = 0; index < longFrames; index += 1) {
      expect(maxTimeOutOfRange.outputLeft[index]).toBeCloseTo(maxTimeAtEdge.outputLeft[index] ?? 0, 6);
      expect(maxTimeOutOfRange.outputRight?.[index]).toBeCloseTo(maxTimeAtEdge.outputRight?.[index] ?? 0, 6);
    }

    const updatedOutOfRange = makeDelay(8000, { timeMs: 4, feedback: 0, pan: 0, mix: 100 });
    const updatedAtEdge = makeDelay(8000, { timeMs: 4, feedback: 0, pan: 0, mix: 100 });
    updatedOutOfRange.setParameters({ timeMs: -10, feedback: 101, pan: 200, mix: 101 });
    updatedAtEdge.setParameters({ timeMs: 1, feedback: 95, pan: 100, mix: 100 });
    const outOfRangeOutput = render(updatedOutOfRange, input, right);
    const atEdgeOutput = render(updatedAtEdge, input, right);
    for (let index = 0; index < input.length; index += 1) {
      expect(outOfRangeOutput.outputLeft[index]).toBeCloseTo(atEdgeOutput.outputLeft[index] ?? 0, 6);
      expect(outOfRangeOutput.outputRight?.[index]).toBeCloseTo(atEdgeOutput.outputRight?.[index] ?? 0, 6);
    }
  });

  it('does not allocate typed audio buffers while processing', () => {
    const dsp = makeDelay();
    const input = new Float32Array(256);
    const output = new Float32Array(256);
    const originalFloat32Array = globalThis.Float32Array;
    let constructions = 0;
    const countedFloat32Array = new Proxy(originalFloat32Array, {
      construct(target, argumentsList, newTarget) {
        constructions += 1;
        return Reflect.construct(target, argumentsList, newTarget) as Float32Array;
      },
    });

    try {
      globalThis.Float32Array = countedFloat32Array as typeof Float32Array;
      dsp.processBlock(input, null, output, null);
    } finally {
      globalThis.Float32Array = originalFloat32Array;
    }
    expect(constructions).toBe(0);
  });
});
