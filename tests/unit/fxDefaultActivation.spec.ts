import { describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';

const parameters = [
  { id: 48, key: 'active', unit: 'boolean', minimum: 0, maximum: 1, defaultValue: 0 },
  { id: 3, key: 'mix', unit: 'linear', minimum: 0, maximum: 1, defaultValue: 1 },
  { id: 125, key: 'pitchProfile', unit: 'choice', minimum: 0, maximum: 2, defaultValue: 1 },
  { id: 93, key: 'semitones', unit: 'semitones', minimum: -12, maximum: 12, defaultValue: 0 },
];

describe('new enabled FX must activate its DSP independently of safe factory defaults', () => {
  it('Browser selection activates TRANSPOSE while preserving the module catalog defaults', () => {
    const engine = Object.create(BrowserAudioEngine.prototype);
    engine.sharedDspFxCatalog = [{ ordinal: 14, parameters: structuredClone(parameters) }];
    const snapshot = engine.createFxSnapshot('SHARED_DSP_FX_14');
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.params['48']).toBe(1);
    expect(snapshot.params['125']).toBe(1);
    expect(engine.sharedDspFxCatalog[0].parameters[0].defaultValue).toBe(0);
  });

  it('Native public type selection submits an active TRANSPOSE instead of silent bypass', async () => {
    const engine = Object.create(NativeAudioEngine.prototype);
    engine.fxCatalog = [{ ordinal: 14, id: 'rc505mkii.fx.transpose', displayName: 'TRANSPOSE',
      inputFx: true, trackFx: true, processorAvailable: true, hostRouteable: true,
      parameters: structuredClone(parameters) }];
    engine.updateFxBankSlot = vi.fn(async () => undefined);
    await engine.setFxType('track', 0, 'SHARED_DSP_FX_14');
    const snapshot = engine.updateFxBankSlot.mock.calls[0][2];
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.params['48']).toBe(1);
    expect(snapshot.params['125']).toBe(1);
    expect(engine.fxCatalog[0].parameters[0].defaultValue).toBe(0);
  });

  it.each(['Browser', 'Native'])('%s continuous FX control changes Pitch without bypassing or changing its profile', async runtime => {
    const engine = Object.create(runtime === 'Browser' ? BrowserAudioEngine.prototype : NativeAudioEngine.prototype);
    const unit = { type: 'SHARED_DSP_FX_14', enabled: true,
      params: { '48': 1, '3': 1, '125': 1, '93': 0 } };
    const bank = { id: 'bank', input: [null, null, null, null],
      track: [unit, null, null, null], output: [null, null, null, null] };
    const catalog = [{ ordinal: 14, id: 'rc505mkii.fx.transpose', displayName: 'TRANSPOSE',
      inputFx: true, trackFx: true, processorAvailable: true, hostRouteable: true,
      parameters: structuredClone(parameters) }];
    engine.activeFxBankId = 'bank';
    engine.fxBanks = [bank];
    engine.getFxState = () => ({ banks: [bank], activeBankId: 'bank' });
    engine.fxCatalog = catalog;
    engine.sharedDspFxCatalog = catalog;
    engine.updateFxBankSlot = vi.fn(async () => undefined);
    await engine.setFxParam('track', 0, 37);
    expect(engine.updateFxBankSlot).toHaveBeenCalledTimes(1);
    const updated = engine.updateFxBankSlot.mock.calls[0][2];
    expect(updated.params['93']).toBeCloseTo(-3.12);
    expect(updated.params['48']).toBe(1);
    expect(updated.params['125']).toBe(1);
    expect(unit.params['93']).toBe(0);
  });
});
