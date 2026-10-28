import { describe, expect, it } from 'vitest';
import { useRc505LoopIndicator, type Rc505LoopIndicatorMode } from '../../src/composables/useRc505LoopIndicator';

describe('Classic Loop Indicator setting', () => {
  it('persists only the validated display mode under its dedicated preference key', () => {
    const indicator = useRc505LoopIndicator();
    localStorage.removeItem('webrc505_classic_loop_indicator_mode');
    indicator.setMode('STATUS');
    indicator.setMode('LEVEL');
    expect(indicator.mode.value).toBe('LEVEL');
    expect(localStorage.getItem('webrc505_classic_loop_indicator_mode')).toBe('LEVEL');
    expect(localStorage.getItem('rc505_memory')).toBeNull();
    expect(() => indicator.setMode('METER' as Rc505LoopIndicatorMode)).toThrow('Unsupported RC-505 Loop Indicator mode');
    expect(indicator.mode.value).toBe('LEVEL');
    indicator.setMode('STATUS');
  });
});
