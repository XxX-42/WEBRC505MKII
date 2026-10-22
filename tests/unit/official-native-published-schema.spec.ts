import { describe, expect, it } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeStatus } from '../../src/audio/NativeBridgeClient';
import { NATIVE_CATALOG_FX_LABELS, nativeCatalogEffectId } from '../../src/audio/nativeFxCatalog';
import published from '../../docs/fx-official-20261022/native-runtime-schema.json';

type PublishedControl = { id: string; applicableVariants?: number[] };
const effects = published.catalogEffectAvailability.filter(entry => entry.officialParameters.length);

describe('tested Native host schema reaches the public editor without missing families', () => {
  for (const entry of effects) {
    const controls = entry.officialParameters as PublishedControl[];
    const variants = controls.some(control => control.id === 'official_variant') ? [1, 2] : [undefined];
    for (const variant of variants) it(`${entry.effectId}${variant ? ` variant ${variant}` : ''}`, () => {
      const label = NATIVE_CATALOG_FX_LABELS[entry.effectId];
      expect(label, 'Every published official family must have a selectable catalog label').toBeTruthy();
      expect(nativeCatalogEffectId(label!)).toBe(entry.effectId);
      const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
      (engine as unknown as { latestStatus: NativeStatus }).latestStatus = { nativeFx: published } as unknown as NativeStatus;
      const parameters = variant === undefined ? {} : { official_variant: variant };
      const schema = engine.getCatalogFxParameterSchema(label!, entry.input ? 'input' : 'track', 0, parameters, 0);
      expect(schema).not.toBeNull();
      const expected = controls.filter(control => !control.applicableVariants || variant === undefined || control.applicableVariants.includes(variant)).map(control => control.id);
      const actual = schema!.parameters.filter(control => control.provenance !== 'extension').map(control => control.id);
      expect(actual).toEqual(expected);
      for (const control of schema!.parameters) {
        expect(control.defaultValue).toBeGreaterThanOrEqual(control.minimum);
        expect(control.defaultValue).toBeLessThanOrEqual(control.maximum);
        if (control.provenance === 'official-interface') {
          const validate = (engine as unknown as {
            areOfficialCatalogParametersSupported(type: string, path: 'input' | 'track', trackId: number, values: Record<string, number>, slotIndex: number): boolean;
          }).areOfficialCatalogParametersSupported.bind(engine);
          expect(validate(label!, entry.input ? 'input' : 'track', 0, { ...parameters, [control.id]: control.defaultValue }, 0), `${entry.effectId} ${control.id} displayed default must be accepted`).toBe(true);
        }
      }
    });
  }
});

it.each([
  ['input', 0], ['track', 0], ['track', 1],
] as const)('keeps VOCODER physical inputs unavailable on %s / track %s', (path, trackId) => {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  (engine as unknown as { latestStatus: NativeStatus }).latestStatus = { nativeFx: published } as unknown as NativeStatus;
  const schema = engine.getCatalogFxParameterSchema('VOCODER', path, trackId, {}, 0)!;
  const carrier = schema.parameters.find(control => control.id === 'official_carrier');
  expect(carrier).toMatchObject({
    minimum: 6, maximum: 10, defaultValue: 6, discreteValues: [6, 7, 8, 9, 10],
    semanticSupport: 'partial_source_modes',
  });
  expect(carrier?.limitation).toMatch(/physical/i);
  expect(schema.parameters.some(control => control.id === 'official_carrier_thru')).toBe(false);
  const validate = (engine as unknown as {
    areOfficialCatalogParametersSupported(type: string, path: 'input' | 'track', trackId: number, values: Record<string, number>, slotIndex: number): boolean;
  }).areOfficialCatalogParametersSupported.bind(engine);
  for (const value of [6, 7, 8, 9, 10]) {
    expect(validate('VOCODER', path, trackId, { official_carrier: value }, 0)).toBe(true);
    expect(carrier?.options?.find(option => option.value === value)?.label).toMatch(/track/i);
  }
  for (const value of [0, 1, 2, 3, 4, 5, 6.5, 11, Infinity, NaN]) {
    expect(validate('VOCODER', path, trackId, { official_carrier: value }, 0)).toBe(false);
  }
  expect(validate('VOCODER', path, trackId, { official_carrier_thru: 1 }, 0)).toBe(false);
});
