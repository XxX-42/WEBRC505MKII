import { describe, expect, it } from 'vitest';
import { defaultRc505FxSwitchSettings, Rc505FxSwitchController } from '../../src/ui/rc505/Rc505FxSwitchController';

describe('RC505 switch intent independent of runtime ACK', () => {
  const active = { A: false, B: false, C: false, D: false };
  it('keeps legacy toggle and supports a paired momentary hold', () => {
    const c = new Rc505FxSwitchController();
    const settings = defaultRc505FxSwitchSettings();
    expect(c.press('A', settings, active).writes).toEqual([{ slot: 'A', active: true }]);
    expect(c.release('A')).toEqual([]);
    settings.switchModes.B = 'MOMENT';
    expect(c.press('B', settings, active).writes).toEqual([{ slot: 'B', active: true }]);
    expect(c.press('B', settings, active).writes).toEqual([]);
    expect(c.release('B')).toEqual([{ slot: 'B', active: false }]);
    expect(c.release('B')).toEqual([]);
  });
  it('cancel turns off all and only original held targets', () => {
    const c = new Rc505FxSwitchController();
    const settings = defaultRc505FxSwitchSettings();
    settings.switchModes.A = settings.switchModes.D = 'MOMENT';
    c.press('A', settings, active); c.press('D', settings, active);
    expect(c.cancel()).toEqual([{ slot: 'A', active: false }, { slot: 'D', active: false }]);
    expect(c.cancel()).toEqual([]);
  });
  it('SINGLE disables other active effects but refuses unknown overlapping holds', () => {
    const c = new Rc505FxSwitchController();
    const settings = defaultRc505FxSwitchSettings(); settings.mode = 'SINGLE'; settings.switchModes.B = 'MOMENT';
    expect(c.press('B', settings, { ...active, A: true }).writes).toEqual([
      { slot: 'A', active: false }, { slot: 'B', active: true },
    ]);
    expect(c.press('C', settings, active).reason).toMatch(/hardware verification/);
    expect(c.release('B')).toEqual([{ slot: 'B', active: false }]);
  });
});
