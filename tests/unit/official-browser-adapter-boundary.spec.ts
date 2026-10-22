import { describe, expect, it } from 'vitest';
import { BrowserWorkletFX, type BrowserWorkletFxName } from '../../src/audio/fx/BrowserWorkletFX';
import type { BrowserFxParameters } from '../../src/audio/fx/dsp/BrowserFxDspCore';
function make(name: BrowserWorkletFxName, initial: BrowserFxParameters = {}): BrowserWorkletFX {
  const context = { createGain: () => ({ connect() {}, disconnect() {} }) } as unknown as AudioContext;
  return new BrowserWorkletFX(context, name, async () => {}, undefined, initial);
}
describe('official Browser adapter boundary validation', () => {
  it.each([1000, -3.14159, 0.5])('rejects invalid official rate %s without changing the snapshot', invalid => {
    const fx = make('DSP LPF');
    fx.setParam('official_rate', invalid);
    expect(fx.error).toContain('Invalid official');
    expect(fx.getParameterSnapshot().official_rate).toBeUndefined();
  });
  it('accepts documented free and synced rate values', () => {
    const fx = make('PHASER');
    fx.setParam('official_rate', 100);
    fx.setParam('official_rate', -0.125);
    expect(fx.error).toBe('');
    expect(fx.getParameterSnapshot().official_rate).toBe(-0.125);
  });
  it('rejects invalid initial parameters before installing a processor', async () => {
    const fx = make('DSP LPF', { official_cutoff: 101 });
    await fx.ready;
    expect(fx.error).toContain('Invalid initial');
    expect(fx.processorReady).toBe(false);
  });
  it('clears obsolete variant controls and rejects wrong-variant fields', () => {
    const fx = make('TAPE ECHO');
    fx.setParam('official_variant', 1);
    fx.setParam('official_bass', 30);
    fx.setParam('official_variant', 2);
    expect(fx.getParameterSnapshot().official_bass).toBeUndefined();
    fx.setParam('official_repeat_rate', -2);
    expect(fx.error).toBe('');
    fx.setParam('official_bass', 10);
    expect(fx.error).toContain('Unsupported official');
  });
});
