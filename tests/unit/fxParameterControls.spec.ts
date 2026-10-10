import { describe, expect, it } from 'vitest';
import { createEnabledFxParameters, selectContinuousFxParameter } from '../../src/audio/fxParameterControls';

const descriptor = (id: number, unit: string, minimum = 0, maximum = 1, defaultValue = 0) =>
  ({ id, unit, minimum, maximum, defaultValue });

describe('shared FX controls for Native, Browser and the panel', () => {
  it('new enabled units activate the processor without changing factory defaults', () => {
    const catalog = [descriptor(48, 'boolean'), descriptor(125, 'choice', 0, 2, 1)];
    expect(createEnabledFxParameters(catalog)).toEqual({ '48': 1, '125': 1 });
    expect(catalog[0]?.defaultValue).toBe(0);
    expect(createEnabledFxParameters([descriptor(1, 'Hz', 20, 20000, 1000)]))
      .toEqual({ '1': 1000 });
  });

  it('a continuous Pitch knob changes semitones rather than bypass, profile or Mix', () => {
    const catalog = [descriptor(48, 'boolean'), descriptor(3, 'linear', 0, 1, 1),
      descriptor(125, 'choice', 0, 2, 1), descriptor(93, 'semitones', -12, 12)];
    const selected = selectContinuousFxParameter(catalog);
    expect(selected?.id).toBe(93);
    expect(selected!.minimum + (selected!.maximum - selected!.minimum) * .37).toBeCloseTo(-3.12);
  });

  it('never maps fractional UI values into categorical, setup or invalid-range controls', () => {
    const excluded = [descriptor(48, 'boolean'), descriptor(107, 'linear', 0, 2),
      descriptor(82, 'linear', 0, 4), descriptor(99, 'MIDI note', 0, 127),
      descriptor(100, 'index', 0, 12), descriptor(101, 'selector', 0, 3),
      descriptor(102, 'voices', 0, 2), descriptor(103, 'linear', 0, Infinity),
      descriptor(104, 'linear', 1, 1)];
    expect(selectContinuousFxParameter(excluded)).toBeUndefined();
    const frequency = descriptor(1, 'Hz', 20, 20000, 1000);
    expect(selectContinuousFxParameter([...excluded, frequency])).toBe(frequency);
  });
});
