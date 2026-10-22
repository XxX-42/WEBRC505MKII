import { describe, expect, it, vi } from 'vitest';
import { BrowserPreampDsp } from '../../src/audio/fx/dsp/BrowserPreampDsp';

type CacheAccess = { antiderivativeValid: Uint8Array; antiderivativeShape: number; cachedModelPosition: number; cachedGainPercent: number; cachedLevelDb: number };
function uncached(processor: BrowserPreampDsp) {
  // Every lookup misses, including the second oversample of a frame. The DSP
  // then evaluates both primitives as the pre-optimization implementation did.
  const access = processor as unknown as CacheAccess;
  const flags = new Uint8Array(2);
  access.antiderivativeValid = new Proxy(flags, {
    get(target, property) {
      if (property === '0' || property === '1') return 0;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return access;
}

describe('Browser PREAMP exact ADAA primitive cache', () => {
  it('is sample-identical to cache misses through every model, automation, reset and tiny inputs', () => {
    for (const rate of [44100, 48000]) for (let model = 0; model < 5; model++) {
      const parameters = { model, gainPercent: 90, levelDb: -6 };
      const optimized = new BrowserPreampDsp(rate, parameters);
      const reference = new BrowserPreampDsp(rate, parameters);
      const referenceCache = uncached(reference);
      for (let frame = 0; frame < 4096; frame++) {
        if (frame === 511) for (const dsp of [optimized, reference]) dsp.setParameters({ model: 4 - model, gainPercent: 100, bassDb: 12 });
        if (frame === 1703) for (const dsp of [optimized, reference]) dsp.setParameters({ model: 2, gainPercent: 0, levelDb: 0 });
        if (frame === 2381) for (const dsp of [optimized, reference]) dsp.reset();
        const scale = frame > 3600 ? 0.3 : frame > 3000 ? 1e-14 : frame > 2600 ? 0 : 0.3;
        const left = frame > 3600 && frame < 3800 ? 0 : scale * Math.sin(2 * Math.PI * 317 * frame / rate);
        const right = frame >= 3800 ? 0 : scale * Math.cos(2 * Math.PI * 911 * frame / rate);
        optimized.processSample(left, right);
        // Also force invariant bias/slope recomputation to validate that cache.
        referenceCache.antiderivativeShape = Number.NaN;
        referenceCache.cachedModelPosition = Number.NaN;
        referenceCache.cachedGainPercent = Number.NaN;
        referenceCache.cachedLevelDb = Number.NaN;
        reference.processSample(left, right);
        expect(optimized.outputLeft, `${rate}/${model}/${frame}/left`).toBe(reference.outputLeft);
        expect(optimized.outputRight, `${rate}/${model}/${frame}/right`).toBe(reference.outputRight);
      }
    }
  });

  it('reduces primitive evaluations without changing finite output', () => {
    const optimized = new BrowserPreampDsp(48000, { model: 4, gainPercent: 100 });
    const reference = new BrowserPreampDsp(48000, { model: 4, gainPercent: 100 });
    uncached(reference);
    const log = vi.spyOn(Math, 'log1p');
    try {
      for (let frame = 0; frame < 256; frame++) optimized.processSample(Math.sin(frame * 0.17) * 0.4, Math.cos(frame * 0.13) * 0.3);
      const cachedCalls = log.mock.calls.length;
      log.mockClear();
      for (let frame = 0; frame < 256; frame++) reference.processSample(Math.sin(frame * 0.17) * 0.4, Math.cos(frame * 0.13) * 0.3);
      expect(cachedCalls).toBeLessThan(log.mock.calls.length * 0.6);
      expect(optimized.outputLeft).toBe(reference.outputLeft);
      expect(optimized.outputRight).toBe(reference.outputRight);
      expect(Number.isFinite(optimized.outputLeft)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
