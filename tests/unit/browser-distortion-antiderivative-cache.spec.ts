import { describe, expect, it } from 'vitest';
import { BrowserFxDspCore, type BrowserDistortionMode } from '../../src/audio/fx/dsp/BrowserFxDspCore';

type CacheAccess = { distortionPrimitiveValid: Uint8Array };
function forcePrimitiveMisses(core: BrowserFxDspCore) {
  const flags = new Uint8Array(2);
  (core as unknown as CacheAccess).distortionPrimitiveValid = new Proxy(flags, {
    get(target, property) {
      if (property === '0' || property === '1') return 0;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('Browser DIST exact ADAA primitive cache', () => {
  it('matches uncached primitives through modes, interrupted crossfades, drive, reset and silence', () => {
    const modes: BrowserDistortionMode[] = ['overdrive', 'hard-clip', 'fuzz'];
    for (const rate of [44100, 48000]) for (const mode of modes) {
      const parameters = { distortionMode: mode, driveDb: 24, outputDb: -6, mix: 0.7 };
      const optimized = new BrowserFxDspCore('distortion', rate, parameters);
      const reference = new BrowserFxDspCore('distortion', rate, parameters);
      forcePrimitiveMisses(reference);
      optimized.setBypass(false, 0);
      reference.setBypass(false, 0);
      const left = new Float32Array(1), right = new Float32Array(1);
      const actualLeft = new Float32Array(1), actualRight = new Float32Array(1);
      const expectedLeft = new Float32Array(1), expectedRight = new Float32Array(1);
      for (let frame = 0; frame < 4096; frame++) {
        if (frame === 311) for (const core of [optimized, reference]) core.setParameters({ distortionMode: 'fuzz', driveDb: 32 });
        if (frame === 319) for (const core of [optimized, reference]) core.setParameters({ distortionMode: 'hard-clip', outputDb: -12 });
        if (frame === 327) for (const core of [optimized, reference]) core.setParameters({ distortionMode: 'overdrive', driveDb: 0 });
        if (frame === 1701) for (const core of [optimized, reference]) core.reset();
        if (frame === 1951) for (const core of [optimized, reference]) core.setBypass(true, 137);
        if (frame === 2203) for (const core of [optimized, reference]) core.setBypass(false, 91);
        const scale = frame > 3600 ? 0.3 : frame > 3000 ? 1e-14 : frame > 2700 ? 0 : 0.3;
        left[0] = frame > 3600 && frame < 3800 ? 0 : scale * Math.sin(2 * Math.PI * 317 * frame / rate);
        right[0] = frame >= 3800 ? 0 : scale * Math.cos(2 * Math.PI * 911 * frame / rate);
        optimized.processBlock(left, right, actualLeft, actualRight, 1);
        reference.processBlock(left, right, expectedLeft, expectedRight, 1);
        expect(actualLeft[0], `${rate}/${mode}/${frame}/left`).toBe(expectedLeft[0]);
        expect(actualRight[0], `${rate}/${mode}/${frame}/right`).toBe(expectedRight[0]);
      }
    }
  });
});
