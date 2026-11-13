import { describe, expect, it } from 'vitest';
import { rc505LcdFieldText } from '../../src/ui/rc505/Rc505LcdFieldText';

describe('LCD concise text and full details', () => {
  it('uses explicit abbreviations without changing the semantic label or formatter', () => {
    const field = { label: 'MODULATION FREQUENCY', value: 23, max: 100, format: (value: number) => `${value} Hz` };
    expect(rc505LcdFieldText(field)).toEqual({ shortLabel: 'MOD FREQ', shortValue: '23 Hz', fullText: 'MODULATION FREQUENCY: 23 Hz' });
    expect(field.label).toBe('MODULATION FREQUENCY');
  });
  it('keeps full enum names and unsupported reasons alongside the concise visible value', () => {
    expect(rc505LcdFieldText({ label: 'PATTERN', value: 198, kind: 'enum', shortValue: 'TRESILLO',
      options: [{ value: 198, label: '198 · DANCE / TRESILLO' }], reason: 'Awaiting runtime readback.' }))
      .toEqual({ shortLabel: 'PATTERN', shortValue: 'TRESILLO', fullText: 'PATTERN: 198 · DANCE / TRESILLO\nAwaiting runtime readback.' });
  });
  it('does not invent a value for an invalid parameter reading', () => {
    expect(rc505LcdFieldText({ label: 'RATE', value: Number.NaN })).toMatchObject({ shortValue: '--', fullText: 'RATE: --' });
  });
});
