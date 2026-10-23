import { describe, expect, it } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

describe('Native named edit composition after explicit restart', () => {
  it('preserves independent host macro values while editing one named control', () => {
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    const authored = { depth: 0.73, wet_mix: 0.21, rate_hz: 0.5 };
    Object.assign(engine, {
      nativeCatalogStates: () => [{ type: 'PHASER', value: 73, active: true, parameters: {} }],
      nativeCatalogFxHydratedSlots: new Set(['input:A']), nativeCatalogFxUnknownParameterSlots: new Set(),
      latestStatus: { nativeFx: { inputCatalogSlots: [{ slot: 'A', effectId: 'phaser', parameters: authored }] } },
    });
    expect(engine.getCatalogFxParameterSnapshot('input', 0, 0, { rate_hz: 2.5 }))
      .toEqual({ depth: 0.73, wet_mix: 0.21, rate_hz: 2.5 });
    expect(authored).toEqual({ depth: 0.73, wet_mix: 0.21, rate_hz: 0.5 });
  });
  it('does not adopt a different host effect or silently undo an explicit replacement', () => {
    const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
    Object.assign(engine, {
      nativeCatalogStates: () => [{ type: 'PHASER', value: 0, active: true, parameters: {} }],
      nativeCatalogFxHydratedSlots: new Set(['input:A']), nativeCatalogFxUnknownParameterSlots: new Set(),
      latestStatus: { nativeFx: { inputCatalogSlots: [{ slot: 'A', effectId: 'chorus', parameters: { wrong: 12 } }] } },
    });
    expect(engine.getCatalogFxParameterSnapshot('input', 0, 0, { rate_hz: 2.5 })).toEqual({ rate_hz: 2.5 });
    expect(engine.getCatalogFxParameterSnapshot('input', 0)).toEqual({});
  });
});
