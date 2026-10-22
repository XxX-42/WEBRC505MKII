import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserOfficialReverseReverbDsp,
  type BrowserOfficialReverseReverbParameters,
} from '../../src/audio/fx/dsp/BrowserOfficialReverseReverbDsp';

const RATE = 8000;
const IMPULSE_PARAMETERS: BrowserOfficialReverseReverbParameters = {
  timeSeconds: 0.4, gateTimeSeconds: 0.2, preDelayMs: 100, lowCutHz: -1000, highCutHz: -1000,
};

function renderImpulse(
  parameters: BrowserOfficialReverseReverbParameters,
  seconds = 1.5,
  sampleRate = RATE,
): [Float32Array, Float32Array] {
  const dsp = new BrowserOfficialReverseReverbDsp(sampleRate, parameters);
  const left = new Float32Array(Math.ceil(seconds * sampleRate));
  const right = new Float32Array(left.length);
  for (let i = 0; i < left.length; i += 1) {
    dsp.processSample(i === 0 ? 1 : 0, i === 0 ? 0.7 : 0);
    left[i] = dsp.wetLeft;
    right[i] = dsp.wetRight;
  }
  return [left, right];
}

function energy(data: Float32Array, from = 0, to = data.length): number {
  let total = 0;
  for (let i = from; i < Math.min(to, data.length); i += 1) total += data[i]! * data[i]!;
  return total;
}

function firstNonzero(data: Float32Array): number {
  return data.findIndex((sample) => Math.abs(sample) > 1e-10);
}

function normalizedShiftError(reference: Float32Array, shifted: Float32Array, shift: number): number {
  let difference = 0;
  for (let i = shift; i < shifted.length; i += 1) {
    const delta = shifted[i]! - reference[i - shift]!;
    difference += delta * delta;
  }
  return difference / energy(shifted);
}

function sineEnergy(frequency: number, cuts: BrowserOfficialReverseReverbParameters): number {
  const dsp = new BrowserOfficialReverseReverbDsp(RATE, {
    timeSeconds: 0.1, gateTimeSeconds: 0.1, preDelayMs: 0, ...cuts,
  });
  let result = 0;
  for (let i = 0; i < RATE; i += 1) {
    const input = 0.1 * Math.sin(2 * Math.PI * frequency * i / RATE);
    dsp.processSample(input, input * 0.5);
    if (i >= RATE * 0.6) result += dsp.wetLeft ** 2 + dsp.wetRight ** 2;
  }
  return result;
}

describe('Browser official REVERSE REVERB rising wet tail', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses manual defaults and waits for independent pre-delay, gate time and diffuser onset', () => {
    const defaults = new BrowserOfficialReverseReverbDsp(RATE);
    // 251 = first authored FDN line, the next prime above 1493*8000/48000.
    expect(defaults.latencySamples).toBe(4000 + 4000 + 251);
    const dsp = new BrowserOfficialReverseReverbDsp(RATE, IMPULSE_PARAMETERS);
    const [left, right] = renderImpulse(IMPULSE_PARAMETERS);
    expect(dsp.latencySamples).toBe(800 + 1600 + 251);
    expect(firstNonzero(left)).toBe(dsp.latencySamples);
    expect(firstNonzero(right)).toBe(dsp.latencySamples);
    expect(energy(left, 0, dsp.latencySamples)).toBe(0);
    expect(energy(right, 0, dsp.latencySamples)).toBe(0);
  });

  it('builds a fading-in diffuse tail, not a reversed input segment', () => {
    const [left, right] = renderImpulse(IMPULSE_PARAMETERS);
    const early = energy(left, 2800, 3600) + energy(right, 2800, 3600);
    const late = energy(left, 4800, 5600) + energy(right, 4800, 5600);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early * 5);
    expect(late).toBeGreaterThan(1e-5);
    expect(left.filter((sample) => Math.abs(sample) > 1e-6).length).toBeGreaterThan(1000);
    expect(right).not.toEqual(left);
  });

  it('moves the same impulse tail when GATE TIME or PRE DELAY changes independently', () => {
    const reference = renderImpulse(IMPULSE_PARAMETERS);
    const gateShift = renderImpulse({ ...IMPULSE_PARAMETERS, gateTimeSeconds: 0.4 });
    const preShift = renderImpulse({ ...IMPULSE_PARAMETERS, preDelayMs: 300 });
    for (const channel of [0, 1] as const) {
      expect(firstNonzero(gateShift[channel]) - firstNonzero(reference[channel])).toBe(1600);
      expect(firstNonzero(preShift[channel]) - firstNonzero(reference[channel])).toBe(1600);
      expect(normalizedShiftError(reference[channel], gateShift[channel], 1600)).toBeLessThan(1e-10);
      expect(normalizedShiftError(reference[channel], preShift[channel], 1600)).toBeLessThan(1e-10);
    }
  });

  it('makes TIME control rising-tail duration without shifting the start', () => {
    const shorter = renderImpulse({ ...IMPULSE_PARAMETERS, timeSeconds: 0.1 });
    const longer = renderImpulse({ ...IMPULSE_PARAMETERS, timeSeconds: 0.7 });
    expect(firstNonzero(shorter[0])).toBe(firstNonzero(longer[0]));
    const shortLate = energy(shorter[0], 6400, 8400) + energy(shorter[1], 6400, 8400);
    const longLate = energy(longer[0], 6400, 8400) + energy(longer[1], 6400, 8400);
    expect(longLate).toBeGreaterThan(1e-4);
    expect(longLate).toBeGreaterThan(shortLate * 1e6);
    // The finite tap window ends, with only the deliberately short diffuser
    // residue remaining, rather than a recursive ten-second feedback tail.
    expect(energy(longer[0], 11600)).toBeLessThan(1e-12);
  });

  it('applies independent wet-only spectral cuts and treats FLAT as bypass', () => {
    const lowFlat = sineEnergy(100, {});
    const highFlat = sineEnergy(2000, {});
    expect(lowFlat).toBeGreaterThan(1e-6);
    expect(highFlat).toBeGreaterThan(1e-6);
    expect(sineEnergy(100, { lowCutHz: 800 })).toBeLessThan(lowFlat * 0.002);
    expect(sineEnergy(2000, { highCutHz: 300 })).toBeLessThan(highFlat * 0.002);
    expect(sineEnergy(100, { highCutHz: 300 })).toBeGreaterThan(lowFlat * 0.9);
    expect(sineEnergy(2000, { lowCutHz: 800 })).toBeGreaterThan(highFlat * 0.9);
    expect(renderImpulse({ ...IMPULSE_PARAMETERS, lowCutHz: -1000, highCutHz: -1000 }))
      .toEqual(renderImpulse(IMPULSE_PARAMETERS));
  });

  it.each([8000, 44100, 48000, 96000])('stays finite, bounded and stereo at %i Hz', (sampleRate) => {
    const dsp = new BrowserOfficialReverseReverbDsp(sampleRate, {
      timeSeconds: 0.1, gateTimeSeconds: 0.1, preDelayMs: 0, lowCutHz: 20, highCutHz: 12500,
    });
    let outputEnergy = 0;
    let difference = 0;
    let valid = true;
    let peak = 0;
    for (let i = 0; i < sampleRate * 0.5; i += 1) {
      const input = i % 257 === 0 ? 1 : 0.1 * Math.sin(i * 0.071);
      dsp.processSample(input, -0.3 * input);
      valid &&= Number.isFinite(dsp.wetLeft) && Number.isFinite(dsp.wetRight);
      peak = Math.max(peak, Math.abs(dsp.wetLeft), Math.abs(dsp.wetRight));
      outputEnergy += dsp.wetLeft ** 2 + dsp.wetRight ** 2;
      difference += (dsp.wetLeft - dsp.wetRight) ** 2;
    }
    expect(valid).toBe(true);
    expect(peak).toBeLessThanOrEqual(8);
    expect(outputEnergy).toBeGreaterThan(1e-4);
    expect(difference).toBeGreaterThan(1e-4);
  });

  it('supports the full 10-second TIME, 1-second gate and 500-ms pre-delay without wrapping early', () => {
    const parameters = { timeSeconds: 10, gateTimeSeconds: 1, preDelayMs: 500 };
    const dsp = new BrowserOfficialReverseReverbDsp(RATE, parameters);
    const [left, right] = renderImpulse(parameters, 12.2);
    expect(firstNonzero(left)).toBe(12000 + 251);
    expect(energy(left, 0, 12000 + 251)).toBe(0);
    expect(energy(left, RATE * 11, RATE * 11.6) + energy(right, RATE * 11, RATE * 11.6))
      .toBeGreaterThan(1e-4);
    expect(energy(left, RATE * 12)).toBeLessThan(1e-14);
    expect(dsp.bufferCapacitySamples).toBe(11 * RATE + 4);
    expect(dsp.maxBufferSamples).toBeLessThan(RATE * 25);
  });

  it('preserves stereo histories and ongoing ramps on unchanged updates across callback chunk sizes', () => {
    const frames = 12000;
    const create = () => new BrowserOfficialReverseReverbDsp(RATE, IMPULSE_PARAMETERS);
    const render = (chunks: readonly number[], repeatParameters: boolean) => {
      const dsp = create();
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      let offset = 0;
      let block = 0;
      const changed = { timeSeconds: 0.2, gateTimeSeconds: 0.1, preDelayMs: 75, lowCutHz: 120, highCutHz: 2500 };
      while (offset < frames) {
        const count = Math.min(chunks[block++ % chunks.length]!, frames - offset);
        for (let frame = offset; frame < offset + count; frame += 1) {
          if (frame === 3500 || (repeatParameters && frame > 3500)) dsp.setParameters(changed);
          const x = frame < 6000 ? Math.sin(frame * 0.071) * 0.2 : 0;
          const y = frame < 6000 ? Math.cos(frame * 0.031) * 0.1 : 0;
          dsp.processSample(x, y);
          left[frame] = dsp.wetLeft;
          right[frame] = dsp.wetRight;
        }
        offset += count;
      }
      return [left, right];
    };
    const whole = render([frames], false);
    const chunked = render([1, 31, 128, 257, 3, 17], true);
    expect(chunked).toEqual(whole);
    expect(energy(whole[0]!)).toBeGreaterThan(0);
  });

  it('allocates no arrays while rendering or changing parameters and keeps preallocated storage', () => {
    const dsp = new BrowserOfficialReverseReverbDsp(RATE, IMPULSE_PARAMETERS);
    const capacity = dsp.bufferCapacitySamples;
    const allocations = vi.fn(() => { throw new Error('Unexpected render allocation'); });
    vi.stubGlobal('Float32Array', allocations);
    vi.stubGlobal('Float64Array', allocations);
    vi.stubGlobal('Int32Array', allocations);
    vi.stubGlobal('Array', allocations);
    for (let i = 0; i < 5000; i += 1) {
      if (i === 100) dsp.setParameters({ timeSeconds: 10, gateTimeSeconds: 1, preDelayMs: 500 });
      if (i === 900) dsp.setParameters({ timeSeconds: 0.1, gateTimeSeconds: 0.1, preDelayMs: 0 });
      dsp.processSample(i === 0 ? 1 : 0, 0);
    }
    // Vitest and its assertion machinery need the real global Array.
    vi.unstubAllGlobals();
    expect(allocations).not.toHaveBeenCalled();
    expect(dsp.bufferCapacitySamples).toBe(capacity);
    expect(dsp.framesProcessed).toBe(5000);
  });

  it('sanitizes invalid input, clamps controls, and resets every audible state reproducibly', () => {
    const parameters = { timeSeconds: -50, gateTimeSeconds: -50, preDelayMs: -50, lowCutHz: 0, highCutHz: 1e6 };
    const dsp = new BrowserOfficialReverseReverbDsp(RATE, parameters);
    const fresh = new BrowserOfficialReverseReverbDsp(RATE, {
      timeSeconds: 0.1, gateTimeSeconds: 0.1, preDelayMs: 0, lowCutHz: 20, highCutHz: 12500,
    });
    for (let i = 0; i < 5000; i += 1) dsp.processSample(i % 257 === 0 ? 1 : 0, i % 211 === 0 ? -1 : 0);
    dsp.setParameters({ timeSeconds: Number.NaN, gateTimeSeconds: Infinity, preDelayMs: -Infinity });
    dsp.reset();
    expect(dsp.wetLeft).toBe(0);
    expect(dsp.wetRight).toBe(0);
    expect(dsp.framesProcessed).toBe(0);
    expect(dsp.latencySamples).toBe(800 + 251);
    let matching = true;
    for (let i = 0; i < 4000; i += 1) {
      const input = i === 0 ? 1 : 0;
      dsp.processSample(input, i === 5 ? Number.NaN : i === 7 ? Infinity : 0);
      fresh.processSample(input, 0);
      matching &&= dsp.wetLeft === fresh.wetLeft && dsp.wetRight === fresh.wetRight;
    }
    expect(matching).toBe(true);
    dsp.reset();
    let residual = 0;
    for (let i = 0; i < 12000; i += 1) {
      dsp.processSample(0, 0);
      residual += Math.abs(dsp.wetLeft) + Math.abs(dsp.wetRight);
    }
    expect(residual).toBe(0);
  });
});
