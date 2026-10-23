import { webcrypto } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { encodeProjectArchive, decodeProjectArchive, PROJECT_ARCHIVE_DEFAULT_TRANSPORT } from '../../src/audio/projectArchive';
import { Rc505Memory, encodeRc505Memory, decodeRc505Memory, type Rc505MemoryDocument, type Rc505MemoryRuntime, type Rc505MemoryPersistence } from '../../src/audio/Rc505Memory';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());
async function document(number: number | null = null): Promise<Rc505MemoryDocument> {
  return { version: 1, memoryNumber: number, name: 'TEST',
    semantics: { tempo: 120, meter: [4, 4], fields: {
      'track.1.playLevel': { value: 87, availability: 'supported' },
      'routing.physical': { value: null, availability: 'unknown', reason: 'No hardware mapping.' },
    } }, extensions: { WEBRC: { projectDisplayName: 'Original project title is retained' } },
    archive: await encodeProjectArchive({ name: 'Legacy archive name remains intact', bpm: 120,
      tracks: [{ pcm: new Float32Array([0.5, -0.25, 0.125, -0.75]), sampleRate: 48000, channels: 2, frameCount: 2 }, null, null, null, null],
      transport: { ...PROJECT_ARCHIVE_DEFAULT_TRANSPORT } }),
  };
}
describe('independent RC505 semantic Memory envelope', () => {
  it('preserves exact v1 bytes, stereo content and separate extension name', async () => {
    const original = await document(2);
    const restored = await decodeRc505Memory(await encodeRc505Memory(original));
    expect(restored).toEqual(original);
    expect((await decodeProjectArchive(restored.archive)).name).toBe('Legacy archive name remains intact');
  });
  it('rejects corrupt payload rather than loading an unchecked semantic shell', async () => {
    const bytes = await encodeRc505Memory(await document(1));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await expect(decodeRc505Memory(bytes)).rejects.toThrow();
  });
  it('rejects inconsistent duplicated tempo/meter, invalid number and long names', async () => {
    const d = await document(1);
    await expect(encodeRc505Memory({ ...d, semantics: { ...d.semantics, tempo: 121 } })).rejects.toThrow(/does not match/);
    await expect(encodeRc505Memory({ ...d, memoryNumber: 100 })).rejects.toThrow(/metadata/);
    await expect(encodeRc505Memory({ ...d, name: '1234567890123' })).rejects.toThrow(/metadata/);
  });
  it('rejects invented values for fields explicitly marked unavailable', async () => {
    const d = await document(); d.semantics.fields['routing.physical']!.value = 0;
    await expect(encodeRc505Memory(d)).rejects.toThrow(/field/);
  });
});

async function harness() {
  const live = await document(); const target = await encodeRc505Memory(await document(3));
  let epoch = 1; let allowed = true;
  const order: string[] = [];
  const runtime: Rc505MemoryRuntime = {
    revision: () => String(epoch), canSwitch: () => ({ allowed, reason: 'Stop all tracks and return to Play.' }),
    capture: vi.fn(async () => { order.push('capture'); return live; }),
    prepare: vi.fn(async () => { order.push('prepare'); return {
      commit: vi.fn(async () => { order.push('commit'); epoch++; }),
      dispose: vi.fn(async () => { order.push('dispose'); }),
    }; }),
  };
  const store: Rc505MemoryPersistence = {
    read: vi.fn(async () => target), write: vi.fn(async () => {}), clear: vi.fn(async () => {}),
    recovery: vi.fn(async () => { order.push('recovery'); }),
  };
  const memory = new Rc505Memory(runtime, store);
  return { runtime, store, memory, order, mutate: () => epoch++, forbid: () => { allowed = false; } };
}
describe('Memory switch transaction guard', () => {
  it('secures recovery before preparation and publishes selection only after commit', async () => {
    const h = await harness(); await h.memory.load(3);
    expect(h.order).toEqual(['capture', 'recovery', 'prepare', 'commit', 'dispose']);
    expect(h.memory.currentNumber).toBe(3); expect(h.memory.dirty).toBe(false);
  });
  it('does not prepare or change selection when recovery storage fails', async () => {
    const h = await harness(); vi.mocked(h.store.recovery).mockRejectedValue(new Error('Quota'));
    await expect(h.memory.load(3)).rejects.toThrow('Quota');
    expect(h.runtime.prepare).not.toHaveBeenCalled(); expect(h.memory.currentNumber).toBeNull(); expect(h.memory.busy).toBe(false);
  });
  it('blocks recording/playing and rejects edits that occur while securing recovery', async () => {
    const h = await harness(); h.forbid(); await expect(h.memory.load(3)).rejects.toThrow(/Stop/);
    expect(h.store.read).not.toHaveBeenCalled();
    const h2 = await harness(); vi.mocked(h2.store.recovery).mockImplementation(async () => h2.mutate());
    await expect(h2.memory.load(3)).rejects.toThrow(/changed/); expect(h2.runtime.prepare).not.toHaveBeenCalled();
  });
  it('rejects edit-and-revert epochs before commit and disposes the prepared candidate', async () => {
    const h = await harness(); const dispose = vi.fn(async () => {}); const commit = vi.fn(async () => {});
    vi.mocked(h.runtime.prepare).mockImplementation(async () => { h.mutate(); h.mutate(); return { commit, dispose }; });
    await expect(h.memory.load(3)).rejects.toThrow(/changed/);
    expect(commit).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  });
  it('does not report a later edit as saved when IndexedDB WRITE completes', async () => {
    const h = await harness(); vi.mocked(h.store.write).mockImplementation(async () => h.mutate());
    await h.memory.save(4, 'SAVED'); expect(h.memory.dirty).toBe(true); expect(h.memory.currentNumber).toBeNull();
  });
  it('retains selection and releases staging after a rejected commit', async () => {
    const h = await harness(); const dispose = vi.fn(async () => {});
    vi.mocked(h.runtime.prepare).mockResolvedValue({ commit: async () => { throw new Error('revision mismatch'); }, dispose });
    await expect(h.memory.load(3)).rejects.toThrow('revision mismatch');
    expect(h.memory.currentNumber).toBeNull(); expect(dispose).toHaveBeenCalledOnce();
  });
});
