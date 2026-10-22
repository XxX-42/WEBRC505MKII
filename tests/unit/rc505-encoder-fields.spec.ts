import { describe, expect, it } from 'vitest';
import { advanceRc505EncoderField as advance } from '../../src/ui/rc505/Rc505EncoderFields';
describe('Classic encoder field detents', () => {
  it('advances nonconsecutive musical note values by option index', () => {
    const field = { value: .125, min: .0625, max: 4, step: 1, kind: 'enum' as const, options: [{ value: .0625 }, { value: .125 }, { value: .25 }, { value: .5 }, { value: 1 }, { value: 4 }] };
    expect(advance(field, 1)).toBe(.25);
    expect(advance(field, -1)).toBe(.0625);
    expect(advance(field, 1, true)).toBe(4);
    expect(advance(field, -100)).toBe(.0625);
  });
  it('clamps numeric endpoints and keeps a single accelerated modification', () => {
    const field = { value: 99, min: 0, max: 100, step: 1 };
    expect(advance(field, 1, true)).toBe(100);
    expect(advance({ ...field, value: 1 }, -1, true)).toBe(0);
    expect(advance({ ...field, value: .1, step: .1 }, 2)).toBe(.3);
    expect(advance(field, Number.NaN)).toBe(99);
  });
});
