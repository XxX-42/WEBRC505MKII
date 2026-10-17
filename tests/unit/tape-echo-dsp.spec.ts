import { describe, expect, it } from 'vitest';
import { BrowserTapeEchoDsp } from '../../src/audio/fx/dsp/BrowserTapeEchoDsp';

function makeEcho(sampleRate = 8000, overrides: ConstructorParameters<typeof BrowserTapeEchoDsp>[1] = {}) {
  return new BrowserTapeEchoDsp(sampleRate, {
    timeMs: 20,
    feedback: 0,
    wow: 0,
    saturation: 0,
    toneHz: 16000,
    mix: 100,
    ...overrides,
  });
}

function render(dsp: BrowserTapeEchoDsp, left: Float32Array, right: Float32Array | null = null) {
  const outputLeft = new Float32Array(left.length);
  const outputRight = right === null ? null : new Float32Array(right.length);
  dsp.processBlock(left, right, outputLeft, outputRight);
  return { outputLeft, outputRight };
}

describe('Browser TAPE ECHO DSP', () => {
  it('uses three timed fractional-delay heads at 1x, 2x, and 3x base time', () => {
    const sampleRate = 8000;
    const delay = Math.round(sampleRate * 0.02);
    const input = new Float32Array(delay * 3 + 40);
    input[0] = 1;
    const { outputLeft } = render(makeEcho(sampleRate), input);

    expect(Math.abs(outputLeft[delay] ?? 0)).toBeGreaterThan(0.25);
    expect(Math.abs(outputLeft[delay * 2] ?? 0)).toBeGreaterThan(0.12);
    expect(Math.abs(outputLeft[delay * 3] ?? 0)).toBeGreaterThan(0.05);
    for (let index = 0; index < delay; index += 1) {
      expect(Math.abs(outputLeft[index] ?? 0)).toBeLessThan(0.01);
    }
  });

  it('keeps a half-sample head position fractional instead of rounding it', () => {
    const sampleRate = 8000;
    const input = new Float32Array(230);
    input[0] = 1;
    const { outputLeft } = render(makeEcho(sampleRate, { timeMs: 20.0625 }), input);
    expect(Math.abs(outputLeft[160] ?? 0)).toBeGreaterThan(0.2);
    expect(Math.abs(outputLeft[161] ?? 0)).toBeGreaterThan(0.2);
    expect(Math.abs((outputLeft[161] ?? 0) - (outputLeft[160] ?? 0))).toBeLessThan(0.08);
  });

  it('honors mix, feedback, saturation, and tone controls', () => {
    const sampleRate = 8000;
    const delay = Math.round(sampleRate * 0.02);
    const impulse = new Float32Array(delay * 2 + 80);
    impulse[0] = 2;

    const dry = render(makeEcho(sampleRate, { mix: 0 }), impulse).outputLeft;
    expect(dry[0]).toBe(2);
    expect(Math.abs(dry[delay] ?? 0)).toBeLessThan(0.01);

    const noFeedback = render(makeEcho(sampleRate, { feedback: 0 }), impulse).outputLeft;
    const feedback = render(makeEcho(sampleRate, { feedback: 90 }), impulse).outputLeft;
    expect(Math.abs(feedback[delay * 2] ?? 0)).toBeGreaterThan(Math.abs(noFeedback[delay * 2] ?? 0) * 1.5);

    const clean = render(makeEcho(sampleRate, { saturation: 0 }), impulse).outputLeft;
    const saturated = render(makeEcho(sampleRate, { saturation: 100 }), impulse).outputLeft;
    expect(Math.abs(saturated[delay] ?? 0)).toBeLessThan(Math.abs(clean[delay] ?? 0) * 0.5);

    const toneInput = new Float32Array(800);
    for (let index = 0; index < toneInput.length; index += 1) {
      toneInput[index] = Math.sin(2 * Math.PI * 2000 * index / sampleRate) * 0.5;
    }
    const lowTone = render(makeEcho(sampleRate, { toneHz: 500 }), toneInput).outputLeft;
    const brightTone = render(makeEcho(sampleRate, { toneHz: 16000 }), toneInput).outputLeft;
    let lowEnergy = 0;
    let brightEnergy = 0;
    for (let index = delay + 20; index < delay + 100; index += 1) {
      lowEnergy += (lowTone[index] ?? 0) ** 2;
      brightEnergy += (brightTone[index] ?? 0) ** 2;
    }
    expect(lowEnergy).toBeLessThan(brightEnergy * 0.35);
  });

  it('applies updated controls through a smooth target ramp', () => {
    const dsp = makeEcho(8000, { mix: 0 });
    const input = new Float32Array(400);
    input[0] = 1;
    dsp.setParameters({ mix: 100 });
    const outputLeft = new Float32Array(input.length);
    dsp.processBlock(input, null, outputLeft, null);
    expect(outputLeft[0]).toBeGreaterThan(0.8);
    expect(outputLeft[0]).toBeLessThan(1);
    expect(outputLeft[160] ?? 0).toBeGreaterThan(0.2);
  });

  it('keeps long high-feedback runs finite and bounded for hostile input', () => {
    const dsp = makeEcho(48000, { feedback: 95, saturation: 100, mix: 100, wow: 100 });
    const inputLeft = new Float32Array(24000);
    const inputRight = new Float32Array(24000);
    for (let index = 0; index < inputLeft.length; index += 1) {
      inputLeft[index] = index % 2 === 0 ? 100 : -100;
      inputRight[index] = index % 3 === 0 ? Number.NaN : 100;
    }
    inputLeft[1] = Number.POSITIVE_INFINITY;
    const outputLeft = new Float32Array(inputLeft.length);
    const outputRight = new Float32Array(inputRight.length);
    dsp.processBlock(inputLeft, inputRight, outputLeft, outputRight);

    for (let index = 0; index < outputLeft.length; index += 1) {
      expect(Number.isFinite(outputLeft[index])).toBe(true);
      expect(Number.isFinite(outputRight[index])).toBe(true);
      expect(Math.abs(outputLeft[index] ?? 0)).toBeLessThanOrEqual(8);
      expect(Math.abs(outputRight[index] ?? 0)).toBeLessThanOrEqual(8);
    }
  });

  it('is invariant to render chunk boundaries', () => {
    const frames = 6000;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      inputLeft[index] = Math.sin(index * 0.071) * 0.7;
      inputRight[index] = Math.cos(index * 0.043) * 0.4;
    }
    const wholeLeft = new Float32Array(frames);
    const wholeRight = new Float32Array(frames);
    makeEcho(8000, { timeMs: 37.25, feedback: 83, wow: 76, saturation: 67, toneHz: 3400, mix: 91 })
      .processBlock(inputLeft, inputRight, wholeLeft, wholeRight);

    const chunkedDsp = makeEcho(8000, { timeMs: 37.25, feedback: 83, wow: 76, saturation: 67, toneHz: 3400, mix: 91 });
    const chunkedLeft = new Float32Array(frames);
    const chunkedRight = new Float32Array(frames);
    const chunks = [1, 37, 128, 9, 511, 64];
    let offset = 0;
    let chunkIndex = 0;
    while (offset < frames) {
      const count = Math.min(chunks[chunkIndex % chunks.length] ?? 1, frames - offset);
      chunkedDsp.processBlock(
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

  it('keeps the wet-only sample API aligned with block processing', () => {
    const frames = 1400;
    const inputLeft = new Float32Array(frames);
    const inputRight = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
      inputLeft[index] = Math.sin(index * 0.031) * 0.5;
      inputRight[index] = Math.cos(index * 0.027) * 0.4;
    }
    const parameters = { timeMs: 23.5, feedback: 52, wow: 30, saturation: 43, toneHz: 4500, mix: 100 };
    const blockOutputLeft = new Float32Array(frames);
    const blockOutputRight = new Float32Array(frames);
    makeEcho(8000, parameters).processBlock(inputLeft, inputRight, blockOutputLeft, blockOutputRight);

    const sampleDsp = makeEcho(8000, parameters);
    for (let index = 0; index < frames; index += 1) {
      sampleDsp.processSample(inputLeft[index] ?? 0, inputRight[index] ?? 0);
      expect(sampleDsp.wetOutputLeft).toBeCloseTo(blockOutputLeft[index] ?? 0, 6);
      expect(sampleDsp.wetOutputRight).toBeCloseTo(blockOutputRight[index] ?? 0, 6);
    }
  });

  it('does not construct typed audio buffers while processing', () => {
    const dsp = makeEcho();
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
