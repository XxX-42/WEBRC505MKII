import { describe, it, expect, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { useRc505Memory } from '../../src/composables/useRc505Memory';
import { latestMixerWrites } from '../../src/composables/latestMixerWrites';
const host = 'a'.repeat(32);
const snapshot = (id = host) => ({ hostIncarnationId: id, mixerLevels: [100, 75, 100, 100, 100, 100, 100] });
function fixture() {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine;
  const bridge = { getStatus: vi.fn().mockResolvedValue(snapshot()), setMixerLevel: vi.fn() };
  const applyStatus = vi.fn((status) => { Object.assign(engine, { latestStatus: status }); });
  Object.assign(engine, { latestStatus: snapshot(), bridge, applyStatus });
  return { engine, bridge, applyStatus };
}
describe('mixer explicit readback fences', () => {
  it('reads confirmed levels with GET only', async () => {
    const { engine, bridge } = fixture();
    expect((await engine.refreshMixerState()).master).toBe(75);
    expect(bridge.getStatus).toHaveBeenCalledOnce();
    expect(bridge.setMixerLevel).not.toHaveBeenCalled();
  });
  it('rejects a replacement host without applying its response', async () => {
    const { engine, bridge, applyStatus } = fixture();
    bridge.getStatus.mockResolvedValue(snapshot('b'.repeat(32)));
    await expect(engine.refreshMixerState()).rejects.toThrow('host changed');
    expect(applyStatus).not.toHaveBeenCalled();
  });
  it('does not apply late readback after local reconnect', async () => {
    const { engine, bridge, applyStatus } = fixture();
    bridge.getStatus.mockImplementation(async () => {
      Object.assign(engine, { latestStatus: snapshot('b'.repeat(32)) }); return snapshot();
    });
    await expect(engine.refreshMixerState()).rejects.toThrow('host changed');
    expect(applyStatus).not.toHaveBeenCalled();
  });
  it('propagates GET failure without retrying the write', async () => {
    const { engine, bridge } = fixture();
    bridge.getStatus.mockRejectedValue(new Error('offline'));
    await expect(engine.refreshMixerState()).rejects.toThrow('offline');
    expect(bridge.getStatus).toHaveBeenCalledOnce(); expect(bridge.setMixerLevel).not.toHaveBeenCalled();
  });
  it('changes browser gesture identity when its context is replaced', () => {
    const engine = Object.create(AudioEngine.prototype) as AudioEngine;
    const browser = { context: { state: 'running' } };
    Object.defineProperty(engine, 'browser', { value: browser });
    Object.assign(engine, { currentMode: 'browser', modeGeneration: 1, mixerContextIds: new WeakMap(), mixerContextSequence: 0 });
    const first = engine.getMixerControlIdentity(); browser.context = { state: 'running' };
    expect(engine.getMixerControlIdentity()).not.toBe(first);
  });
  it('blocks Memory before capture when a mixer acknowledgement is in flight', async () => {
    const spy = vi.spyOn(latestMixerWrites, 'hasPending').mockReturnValue(true);
    try { await expect(useRc505Memory().load(2)).rejects.toThrow('mixer level readback'); }
    finally { spy.mockRestore(); }
  });
});
