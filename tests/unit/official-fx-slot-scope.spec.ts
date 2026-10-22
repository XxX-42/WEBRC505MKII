import { describe, expect, it, vi } from 'vitest';
import { isOfficialFxSlotAllowed } from '../../src/audio/fx/official/parameters';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeStatus } from '../../src/audio/NativeBridgeClient';
import { createBrowserRecoverySharedFxBank } from '../../src/audio/BrowserRecoverySharedFxBank';
import type { BrowserRecoveryFxSlot } from '../../src/audio/BrowserRecoverySnapshot';

describe('Official Track-only MULTI slot restrictions', () => {
  it.each(['BEAT SCATTER', 'BEAT REPEAT', 'BEAT SHIFT', 'VINYL FLICK'])('%s permits only Track A', type => {
    expect(isOfficialFxSlotAllowed(type, 'track', 0)).toBe(true);
    for (let index = 0; index < 4; index += 1) {
      expect(isOfficialFxSlotAllowed(type, 'input', index)).toBe(false);
      if (index) expect(isOfficialFxSlotAllowed(type, 'track', index)).toBe(false);
    }
  });
  it('does not constrain other official algorithms or legacy extension schemas', () => {
    for (const path of ['input', 'track'] as const) expect(isOfficialFxSlotAllowed('PHASER', path, 3)).toBe(true);
    const engine = NativeAudioEngine.getInstance();
    const internal = engine as unknown as { latestStatus: NativeStatus; areOfficialCatalogParametersSupported(type: string, path: 'input'|'track', trackId: number, parameters: Record<string, number>, slotIndex: number): boolean };
    const d = (id: string, minimum: number, maximum: number, defaultValue: number) => ({ id, label: id, minimum, maximum, defaultValue, smoothingMs: 5, discrete: false });
    internal.latestStatus = { nativeFx: { parameterSchemaVersion: 1, catalogEffectAvailability: [{ effectId: 'vinyl_flick', input: true, track: true, parameters: [d('speed', 0, 2, 1)], officialParameters: [d('official_flick', 0, 100, 50)], legacyParameterAliases: [] }] } } as NativeStatus;
    expect(engine.getCatalogFxParameterSchema('VINYL FLICK', 'track', 0, {}, 0)?.parameters.map(p => p.id)).toContain('official_flick');
    expect(engine.getCatalogFxParameterSchema('VINYL FLICK', 'track', 0, {}, 1)?.parameters.map(p => p.id)).toEqual(['speed']);
    expect(internal.areOfficialCatalogParametersSupported('VINYL FLICK', 'track', 0, { official_flick: 50 }, 1)).toBe(false);
    expect(internal.areOfficialCatalogParametersSupported('VINYL FLICK', 'input', 0, { official_flick: 50 }, 0)).toBe(false);
    expect(internal.areOfficialCatalogParametersSupported('VINYL FLICK', 'track', 0, { speed: 1 }, 3)).toBe(true);
  });
  it('validates original recovery slot before source-reader metadata can bypass the chain', () => {
    const context = { createGain: () => ({ connect: vi.fn(), disconnect: vi.fn() }) } as unknown as AudioContext;
    const empty = { slot: 'A', type: null, parameters: {} } as BrowserRecoveryFxSlot;
    const invalid = { ...empty, slot: 'B', type: 'VINYL FLICK', parameters: { official_flick: 50 } } as BrowserRecoveryFxSlot;
    expect(() => createBrowserRecoverySharedFxBank(context, 'sharedTrack', [empty, invalid], async () => {}, () => 120)).toThrow('requires Track slot A');
    const legacy = { ...invalid, parameters: { vinylFlickSpeed: 0 } };
    const bank = createBrowserRecoverySharedFxBank(context, 'sharedTrack', [empty, legacy], async () => {}, () => 120);
    expect(bank.getStatuses()[1]?.state).toBe('metadata-only');
    bank.dispose();
  });
});
