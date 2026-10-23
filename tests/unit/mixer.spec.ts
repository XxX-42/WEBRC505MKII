import { describe, expect, it, vi } from 'vitest';
import { assertMixerLevel, mixerChannelIndex, mixerState } from '../../src/audio/Mixer';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

describe('software mixer provider', () => {
  it('fails unavailable without a complete provider and returns immutable detached snapshots', () => {
    expect(mixerState().available).toBe(false);
    expect(mixerState([100]).main).toBeNull();
    const source = [100, 80, 10, 20, 30, 40, 50];
    const state = mixerState(source); source[2] = 0;
    expect(state.tracks[0]).toBe(10);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tracks)).toBe(true);
    expect(() => assertMixerLevel(NaN)).toThrow();
    expect(() => assertMixerLevel(201)).toThrow();
    expect(mixerChannelIndex('MAIN')).toBe(0);
    expect(mixerChannelIndex('MASTER')).toBe(1);
    expect(mixerChannelIndex(5)).toBe(6);
  });
  it('changes independent Browser AudioParams and binds track faders', () => {
    const main = { value: 1, setValueAtTime: vi.fn() };
    const master = { value: 0.8, setValueAtTime: vi.fn() };
    const tracks = Array.from({ length: 5 }, () => ({ track: { playLevel: 100 }, updateSettings: vi.fn() }));
    const provider = { mainGainNode: {gain: main}, masterGainNode: {gain: master}, context: { currentTime: 3 }, tracks };
    BrowserAudioEngine.prototype.setMixerLevel.call(provider as any, 'MAIN', 50);
    expect(main.setValueAtTime).toHaveBeenCalledWith(0.5, 3);
    expect(master.setValueAtTime).not.toHaveBeenCalled();
    BrowserAudioEngine.prototype.setMixerLevel.call(provider as any, 'MASTER', 75);
    expect(master.setValueAtTime).toHaveBeenCalledWith(0.75, 3);
    BrowserAudioEngine.prototype.setMixerLevel.call(provider as any, 3, 25);
    expect(tracks[2]!.track.playLevel).toBe(25);
    expect(tracks[2]!.updateSettings).toHaveBeenCalledOnce();
    expect(tracks[1]!.track.playLevel).toBe(100);
  });
});
