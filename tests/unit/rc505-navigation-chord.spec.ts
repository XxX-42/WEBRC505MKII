import { describe, expect, it } from 'vitest';
import { Rc505NavigationChord } from '../../src/ui/rc505/Rc505NavigationChord';

describe('EXIT + ENTER hardware chord', () => {
  it.each(['ENTER', 'EXIT'] as const)('defers a lone %s until release and consumes repeats', key => {
    const chord = new Rc505NavigationChord();
    expect(chord.press(key)).toBe(false); expect(chord.press(key)).toBe(false);
    expect(chord.release(key)).toBe(key); expect(chord.release(key)).toBeNull();
  });
  it.each([['ENTER', 'EXIT'], ['EXIT', 'ENTER']] as const)('consumes both release actions after %s + %s', (first, second) => {
    const chord = new Rc505NavigationChord();
    expect(chord.press(first)).toBe(false); expect(chord.press(second)).toBe(true);
    expect(chord.press(first)).toBe(false);
    expect(chord.release(second)).toBeNull(); expect(chord.release(first)).toBeNull();
    chord.press(first); expect(chord.release(first)).toBe(first);
  });
  it('cancels capture/blur without dispatching a lone or residual chord release', () => {
    const chord = new Rc505NavigationChord();
    chord.press('EXIT'); chord.cancel('EXIT'); expect(chord.release('EXIT')).toBeNull();
    chord.press('EXIT'); chord.press('ENTER'); chord.cancel('EXIT'); expect(chord.release('ENTER')).toBeNull();
    chord.press('ENTER'); chord.cancel(); expect(chord.release('ENTER')).toBeNull();
  });
});
