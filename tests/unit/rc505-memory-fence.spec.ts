import { describe, expect, it, vi } from 'vitest';
import type { Rc505MemoryDocument, Rc505MemoryRuntime } from '../../src/audio/Rc505Memory';
import { fenceRc505MemoryRuntime } from '../../src/audio/Rc505MemoryRuntimeFence';

function harness() {
  let generation = 0, active = true, leases = 0;
  const commit = vi.fn(async () => {}), dispose = vi.fn(async () => {});
  const raw: Rc505MemoryRuntime = { revision: () => 'PCM1', canSwitch: () => ({ allowed: true, reason: '' }),
    capture: vi.fn(async () => ({} as Rc505MemoryDocument)), prepare: vi.fn(async () => ({ commit, dispose })) };
  const runtime = fenceRc505MemoryRuntime(raw, { revision: () => String(generation), active: () => active,
    acquire: () => { leases++; return () => { leases--; }; } });
  return { raw, runtime, commit, dispose, leaseCount: () => leases, aba: () => { generation += 2; }, deactivate: () => { active = false; } };
}
describe('semantic Memory backend identity and mode generation fence', () => {
  it('rejects an away-and-back mode change during capture', async () => {
    const h = harness(); vi.mocked(h.raw.capture).mockImplementation(async () => { h.aba(); return {} as Rc505MemoryDocument; });
    await expect(h.runtime.capture()).rejects.toThrow(/backend changed/);
  });
  it('rejects a stale generation before preparation without acquiring a backend lease', async () => {
    const h = harness(), before = h.runtime.revision(); h.aba();
    await expect(h.runtime.prepare({} as Rc505MemoryDocument, before)).rejects.toThrow(/backend changed/);
    expect(h.raw.prepare).not.toHaveBeenCalled(); expect(h.leaseCount()).toBe(0);
  });
  it('retains its backend lease across commit until disposal and releases exactly once', async () => {
    const h = harness(), staged = await h.runtime.prepare({} as Rc505MemoryDocument, h.runtime.revision());
    expect(h.leaseCount()).toBe(1); await staged.commit(); expect(h.commit).toHaveBeenCalledOnce();
    expect(h.leaseCount()).toBe(1); await staged.dispose(); await staged.dispose();
    expect(h.leaseCount()).toBe(0); expect(h.dispose).toHaveBeenCalledOnce();
    await expect(staged.commit()).rejects.toThrow(/disposed/);
  });
  it('disposes a candidate invalidated while preparing and releases the lease even if cleanup fails', async () => {
    const h = harness(); vi.mocked(h.raw.prepare).mockImplementation(async () => { h.deactivate(); return { commit: h.commit, dispose: h.dispose }; });
    await expect(h.runtime.prepare({} as Rc505MemoryDocument, h.runtime.revision())).rejects.toThrow(/backend changed/);
    expect(h.dispose).toHaveBeenCalledOnce(); expect(h.leaseCount()).toBe(0);
    expect(h.runtime.canSwitch()).toMatchObject({ allowed: false });
    const h2 = harness(), staged = await h2.runtime.prepare({} as Rc505MemoryDocument, h2.runtime.revision());
    h2.dispose.mockRejectedValue(new Error('cleanup failed'));
    await expect(staged.dispose()).rejects.toThrow('cleanup failed'); expect(h2.leaseCount()).toBe(0);
  });
});
