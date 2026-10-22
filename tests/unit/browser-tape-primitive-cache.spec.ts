import { describe, expect, it } from 'vitest';
import { BrowserTapeEchoDsp } from '../../src/audio/fx/dsp/BrowserTapeEchoDsp';

describe('Browser TAPE ECHO exact primitive cache', () => {
  it('matches uncached ADAA through saturation disable/restore, reset and channel-specific silence', () => {
    for (const rate of [44100, 48000]) for (const saturation of [0, 25, 100]) {
      const parameters = { timeMs: 20, saturation, feedback: 40, wow: 50 };
      const optimized = new BrowserTapeEchoDsp(rate, parameters);
      const reference = new BrowserTapeEchoDsp(rate, parameters);
      const flags = new Uint8Array(2);
      (reference as unknown as { primitiveValid: Uint8Array }).primitiveValid = new Proxy(flags, {
        get(target, property) {
          if (property === '0' || property === '1') return 0;
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      let audibleFrames = 0;
      for (let frame = 0; frame < 8000; frame++) {
        if (frame === 512) for (const dsp of [optimized, reference]) dsp.setParameters({ saturation: 75 });
        if (frame === 3000) for (const dsp of [optimized, reference]) { dsp.setParameters({ saturation: 0 }); dsp.reset(); }
        if (frame === 4000) for (const dsp of [optimized, reference]) dsp.setParameters({ saturation: 100 });
        const scale = frame >= 7000 ? 0.3 : frame > 6000 ? 1e-14 : frame > 5500 ? 0 : 0.3;
        const left = frame >= 7000 && frame < 7500 ? 0 : scale * Math.sin(2 * Math.PI * 317 * frame / rate);
        const right = frame >= 7500 ? 0 : scale * Math.cos(2 * Math.PI * 911 * frame / rate);
        optimized.processSample(left, right);
        reference.processSample(left, right);
        expect(optimized.wetOutputLeft, `${rate}/${saturation}/${frame}/left`).toBe(reference.wetOutputLeft);
        expect(optimized.wetOutputRight, `${rate}/${saturation}/${frame}/right`).toBe(reference.wetOutputRight);
        if (Math.abs(optimized.wetOutputLeft) + Math.abs(optimized.wetOutputRight) > 1e-4) audibleFrames++;
      }
      expect(audibleFrames).toBeGreaterThan(1000);
    }
  });
});
