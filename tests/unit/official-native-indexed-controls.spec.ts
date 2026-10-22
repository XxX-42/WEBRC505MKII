import { afterEach, describe, expect, it } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { Transport } from '../../src/core/Transport';

const originalTempo = Transport.getInstance().bpm;
afterEach(() => { Transport.getInstance().bpm = originalTempo; });

function harness(effectId: string, descriptors: unknown[]) {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  const internal = engine as unknown as {
    latestStatus: unknown;
    nativeCatalogStates: () => unknown[];
    nativeCatalogParameters(path: 'input', slotIndex: number, trackId: number): Record<string, number>;
  };
  internal.latestStatus = { nativeFx: { parameterSchemaVersion: 1, catalogEffectAvailability: [{
    effectId, input: true, track: true, parameters: [], legacyParameterAliases: [], officialParameters: descriptors,
  }] } };
  return { engine, internal };
}

describe('Native indexed official controls and auxiliary tempo', () => {
  it('labels every indexed step individually without inventing extra manual parameter rows', () => {
    const { engine } = harness('step_slicer', Array.from({ length: 16 }, (_, index) => ({
      id: `official_step_level_${index + 1}`, label: 'Step level', minimum: 0, maximum: 100,
      defaultValue: 100, smoothingMs: 5, discrete: false,
    })));
    const controls = engine.getCatalogFxParameterSchema('STEP SLICER', 'input')!.parameters;
    expect(controls).toHaveLength(16);
    expect(controls.map(control => control.label)).toEqual(Array.from({ length: 16 }, (_, index) => `STEP LEVEL ${index + 1}`));
    expect(controls.every(control => control.defaultValue === 100 && control.minimum === 0 && control.maximum === 100)).toBe(true);
  });
  it.each([[30, 40], [0, 40], [999, 300], [Number.NaN, 120], [90, 90]])('bounds official tempo %s while preserving the legacy project clock', (tempo, expected) => {
    const { internal } = harness('filter.lpf', [{ id: 'official_rate' }]);
    internal.nativeCatalogStates = () => [{ type: 'DSP LPF', value: 50, active: true, parameters: { official_rate: -1 } }];
    Transport.getInstance().bpm = tempo;
    expect(internal.nativeCatalogParameters('input', 0, 0).official_bpm).toBe(expected);
    expect(Transport.getInstance().bpm).toBe(tempo);
  });
});
