import { describe, expect, it } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeFxParameterDescriptor, NativeStatus } from '../../src/audio/NativeBridgeClient';

function installSchema() {
  const descriptor = (id: string, minimum: number, maximum: number): NativeFxParameterDescriptor => ({
    id, label: id, minimum, maximum, defaultValue: minimum, smoothingMs: 5, discrete: false,
  });
  const engine = NativeAudioEngine.getInstance();
  const internal = engine as unknown as {
    latestStatus: NativeStatus;
    areOfficialCatalogParametersSupported(type: string, path: 'input' | 'track', trackId: number, values: Record<string, number>): boolean;
  };
  internal.latestStatus = { nativeFx: {
    parameterSchemaVersion: 1,
    catalogEffectAvailability: [{ effectId: 'tape_echo', input: true, track: true, parameters: [], legacyParameterAliases: [],
      officialParameters: [
        { ...descriptor('official_variant', 1, 2), discrete: true, discreteValues: [1, 2] },
        descriptor('official_repeat_rate', -2, 2000), descriptor('official_bass', -50, 50), descriptor('official_treble', -50, 50),
        descriptor('official_low_cut', 0, 12500), descriptor('official_high_cut', 0, 12500),
      ],
    }],
  } } as NativeStatus;
  return { engine, internal };
}

describe('Native official algorithm-variant routing', () => {
  it('requires an explicit variant rather than guessing Tape Echo 1', () => {
    const { engine } = installSchema();
    const schema = engine.getCatalogFxParameterSchema('TAPE ECHO', 'input');
    expect(schema?.parameters.map(p => p.id)).toEqual(['official_variant']);
    expect(schema?.parameters[0]?.provenance).toBe('routing');
  });
  it('shows each variant’s actual source controls without cross-variant aliases', () => {
    const { engine } = installSchema();
    expect(engine.getCatalogFxParameterSchema('TAPE ECHO', 'input', 0, { official_variant: 1 })?.parameters.map(p => p.id))
      .toEqual(['official_variant', 'official_repeat_rate', 'official_bass', 'official_treble']);
    expect(engine.getCatalogFxParameterSchema('TAPE ECHO', 'track', 0, { official_variant: 2 })?.parameters.map(p => p.id))
      .toEqual(['official_variant', 'official_repeat_rate', 'official_low_cut', 'official_high_cut']);
  });
  it('rejects missing, invalid and cross-variant public writes atomically', () => {
    const { internal } = installSchema();
    const valid = (values: Record<string, number>) => internal.areOfficialCatalogParametersSupported('TAPE ECHO', 'input', 0, values);
    expect(valid({ official_variant: 1, official_repeat_rate: 50 })).toBe(true);
    expect(valid({ official_variant: 2, official_repeat_rate: 2000 })).toBe(true);
    for (const values of [{ official_repeat_rate: 50 }, { official_variant: 3 }, { official_variant: 1, official_repeat_rate: 500 }, { official_variant: 2, official_bass: 50 }, { official_variant: 2, official_repeat_rate: 2001 }]) expect(valid(values)).toBe(false);
  });
});
