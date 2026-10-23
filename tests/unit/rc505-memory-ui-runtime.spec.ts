import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rc505MemoryCommittedError, type Rc505MemoryDocument, type Rc505MemoryRuntime } from '../../src/audio/Rc505Memory';
import { createFxPresetBankDocument, createEmptyFxPresetSlots, fxPresetBankStorageKey, type FxPresetLocation, type FxPresetRuntime } from '../../src/ui/rc505/Rc505FxBankStore';
import { defaultRc505FxSwitchSettings } from '../../src/ui/rc505/Rc505FxSwitchController';
import { registerRc505MemoryBankUiPort, registerRc505MemorySwitchUiPort, wrapRc505MemoryUiRuntime, type Rc505MemorySwitchSnapshot } from '../../src/composables/wrapRc505MemoryUiRuntime';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((dispose) => dispose()); vi.restoreAllMocks(); localStorage.clear(); });
function harness(mode: FxPresetRuntime = 'browser') {
  let audioRevision = 0, uiRevision = 0;
  const documents = Object.fromEntries(['input', 'track'].map((location) => [location, createFxPresetBankDocument(mode, location as FxPresetLocation, createEmptyFxPresetSlots())])) as any;
  let switches = Object.fromEntries(['input', 'track'].map((location) => [location, Object.fromEntries(['A', 'B', 'C', 'D'].map((bank) => [bank, defaultRc505FxSwitchSettings()]))])) as Rc505MemorySwitchSnapshot;
  const adopts = vi.fn();
  for (const location of ['input', 'track'] as const) cleanups.push(registerRc505MemoryBankUiPort(mode, location, {
    revision: () => String(uiRevision), canCapture: () => true,
    capture: () => structuredClone(documents[location]), validate: () => {},
    adopt: (document, error) => { documents[location] = structuredClone(document); uiRevision++; adopts(location, document.activeBank, error); },
  }));
  registerRc505MemorySwitchUiPort(mode, {
    revision: () => String(uiRevision), capture: () => structuredClone(switches),
    adopt: (value) => { switches = structuredClone(value); uiRevision++; },
  });
  const document: Rc505MemoryDocument = { version: 1, memoryNumber: 1, name: 'MEMORY', archive: new Uint8Array([1]), semantics: { tempo: 120, meter: [4, 4], fields: {} },
    extensions: { WEBRC: mode === 'browser' ? { browserMemory: { fx: { input: ['A', 'B', 'C', 'D'].map((slot) => ({ slot, type: null, active: false, parameters: {} })), sharedTrack: ['A', 'B', 'C', 'D'].map((slot) => ({ slot, type: null, active: false, parameters: {} })) } } }
      : { nativeMemory: { banks: [0, 1].map(() => ['A', 'B', 'C', 'D'].map(() => ({ effectId: null, bypassed: false, parameters: {} }))) } } } };
  const commit = vi.fn(async () => { audioRevision++; });
  const base: Rc505MemoryRuntime = { revision: () => String(audioRevision), canSwitch: () => ({ allowed: true, reason: '' }), capture: async () => structuredClone(document),
    prepare: vi.fn(async (_document, revision) => { expect(revision).toBe(String(audioRevision)); return { commit, dispose: vi.fn(async () => {}) }; }) };
  const runtime = wrapRc505MemoryUiRuntime(base, mode);
  return { runtime, base, documents, switches: () => switches, adopts, commit, edit: () => { uiRevision++; } };
}

describe('semantic Memory UI sidecars', () => {
  it.each(['browser', 'native'] as const)('captures and recalls all four banks and switch profiles for %s after audio publication', async (mode) => {
    const h = harness(mode);
    h.documents.input.activeBank = 'C'; h.documents.track.activeBank = 'D';
    h.switches().input.C.mode = 'SINGLE'; h.switches().input.C.switchModes.B = 'MOMENT';
    h.switches().track.A.switchModes.D = 'MOMENT';
    const document = await h.runtime.capture();
    h.documents.input.activeBank = 'A'; h.switches().input.C.mode = 'MULTI'; h.edit();
    const candidate = await h.runtime.prepare(document, h.runtime.revision());
    expect(h.documents.input.activeBank).toBe('A'); expect(h.adopts).not.toHaveBeenCalled();
    await candidate.commit(); await candidate.dispose();
    expect(h.commit).toHaveBeenCalledOnce(); expect(h.documents.input.activeBank).toBe('C'); expect(h.documents.track.activeBank).toBe('D');
    expect(h.switches().input.C).toEqual({ mode: 'SINGLE', switchModes: { A: 'TOGGLE', B: 'MOMENT', C: 'TOGGLE', D: 'TOGGLE' } });
    expect(h.switches().track.A.switchModes.D).toBe('MOMENT');
    expect(JSON.parse(localStorage.getItem(fxPresetBankStorageKey(mode, 'input'))!).activeBank).toBe('C');
  });

  it('is stable per base/runtime and catches UI edit-and-revert before audio commit', async () => {
    const h = harness(); expect(wrapRc505MemoryUiRuntime(h.base, 'browser')).toBe(h.runtime);
    const document = await h.runtime.capture(), before = h.runtime.revision();
    const candidate = await h.runtime.prepare(document, before);
    h.switches().input.A.mode = 'SINGLE'; h.edit(); h.switches().input.A.mode = 'MULTI'; h.edit();
    await expect(candidate.commit()).rejects.toThrow(/changed/); expect(h.commit).not.toHaveBeenCalled(); expect(h.adopts).not.toHaveBeenCalled();
  });

  it('rejects malformed MODE and selected-bank/engine contradictions before preparing audio', async () => {
    const h = harness(), document = await h.runtime.capture();
    (document.extensions.WEBRC.rc505FxUi as any).switches.input.A.mode = 'INVALID';
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/switch settings/);
    (document.extensions.WEBRC.rc505FxUi as any).switches.input.A.mode = 'SINGLE';
    (document.extensions.WEBRC.rc505FxUi as any).banks.input.banks.A.slots[0].type = 'DELAY';
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/disagrees/);
    expect(h.base.prepare).not.toHaveBeenCalled();
  });

  it('quota-preflights before audio preparation and preserves prior UI/storage', async () => {
    const h = harness(), document = await h.runtime.capture();
    localStorage.setItem('prior', 'retained');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    await expect(h.runtime.prepare(document, h.runtime.revision())).rejects.toThrow(/storage/);
    expect(h.base.prepare).not.toHaveBeenCalled(); expect(h.adopts).not.toHaveBeenCalled(); expect(localStorage.getItem('prior')).toBe('retained');
  });

  it('leaves sidecars unchanged when audio candidate fails', async () => {
    const h = harness(), document = await h.runtime.capture();
    const candidate = await h.runtime.prepare(document, h.runtime.revision());
    h.commit.mockRejectedValueOnce(new Error('audio candidate rejected'));
    await expect(candidate.commit()).rejects.toThrow('audio candidate rejected');
    expect(h.adopts).not.toHaveBeenCalled(); expect(localStorage.getItem(fxPresetBankStorageKey('browser', 'input'))).toBeNull();
  });

  it('loads older semantic envelopes while retaining profiles and clearing unknown bank identity', async () => {
    const h = harness(), document = await h.base.capture();
    h.documents.input.activeBank = 'C'; h.documents.input.banks.D.slots[0].type = 'DELAY';
    h.switches().input.D.switchModes.A = 'MOMENT';
    const candidate = await h.runtime.prepare(document, h.runtime.revision());
    await candidate.commit(); await candidate.dispose();
    expect(h.documents.input.activeBank).toBeNull(); expect(h.documents.track.activeBank).toBeNull();
    expect(h.documents.input.banks.D.slots[0].type).toBe('DELAY'); expect(h.switches().input.D.switchModes.A).toBe('MOMENT');
  });

  it('reports postcommit storage failure as committed and adopts without bank confirmation', async () => {
    const h = harness(), document = await h.runtime.capture();
    const candidate = await h.runtime.prepare(document, h.runtime.revision());
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === fxPresetBankStorageKey('browser', 'input')) throw new Error('late storage failure');
      return original.call(this, key, value);
    });
    await expect(candidate.commit()).rejects.toBeInstanceOf(Rc505MemoryCommittedError);
    expect(h.commit).toHaveBeenCalledOnce(); expect(h.adopts).toHaveBeenCalledTimes(2);
    expect(h.adopts.mock.calls.every((call) => call[2].includes('committed'))).toBe(true);
  });

  it('adopts the real switch settings store and signals stale MOMENT hold invalidation without DSP writes', async () => {
    const h = harness();
    const { useRc505FxSwitchSettings } = await import('../../src/composables/useRc505FxSwitchSettings');
    const selected = useRc505FxSwitchSettings('browser', 'input', 'C');
    expect(selected.update({ mode: 'SINGLE', switchModes: { A: 'TOGGLE', B: 'MOMENT', C: 'TOGGLE', D: 'MOMENT' } })).toBe(true);
    const document = await h.runtime.capture();
    selected.update(defaultRc505FxSwitchSettings());
    const adoptionRevision = selected.state.adoptionRevision;
    const candidate = await h.runtime.prepare(document, h.runtime.revision()); await candidate.commit();
    expect(selected.state.settings.mode).toBe('SINGLE'); expect(selected.state.settings.switchModes.B).toBe('MOMENT');
    expect(selected.state.adoptionRevision).toBe(adoptionRevision + 1);
    const before = JSON.stringify(selected.state.settings);
    expect(selected.update({ mode: 'INVALID' } as never)).toBe(false);
    expect(JSON.stringify(selected.state.settings)).toBe(before);
  });
});
