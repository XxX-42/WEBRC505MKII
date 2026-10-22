import { describe, expect, it } from 'vitest';
import { clampBrowserFxValue } from '../../src/audio/fx/dsp/BrowserFxDspCore';
import { clampModDelayValue } from '../../src/audio/fx/dsp/BrowserModDelayDsp';
import { clampTapeEchoValue } from '../../src/audio/fx/dsp/BrowserTapeEchoDsp';

const cases = [
  { name: 'core', clamp: clampBrowserFxValue, reference: (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value)) },
  { name: 'mod-delay', clamp: clampModDelayValue, reference: (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value)) },
  { name: 'tape-echo', clamp: clampTapeEchoValue, reference: (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value)) },
];

for (const testCase of cases) describe(`Browser FX exact in-range clamp: ${testCase.name}`, () => {
  it('preserves NaN, signed zero, infinities, equal and reversed bounds', () => {
    const values = [Number.NaN, -Infinity, -Number.MAX_VALUE, -4, -1, -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE, 1, 4, Number.MAX_VALUE, Infinity];
    for (const value of values) for (const minimum of values) for (const maximum of values) {
      const expected = testCase.reference(value, minimum, maximum);
      expect(Object.is(testCase.clamp(value, minimum, maximum), expected), `${value}/${minimum}/${maximum}`).toBe(true);
    }
  });

  it('matches the original expression for deterministic finite controls', () => {
    let random = 0x12345678;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random / 0x100000000 - 0.5) * 200; };
    for (let index = 0; index < 10000; index++) {
      const value = next(), minimum = next(), maximum = next();
      expect(Object.is(testCase.clamp(value, minimum, maximum), testCase.reference(value, minimum, maximum))).toBe(true);
    }
  });
});
