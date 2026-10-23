import { reactive } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { Rc505Memory, type Rc505MemoryRuntime } from '../audio/Rc505Memory';
import { Rc505MemoryStore } from '../audio/Rc505MemoryStore';
import { adoptCommittedBrowserFxState } from './useFxPanelState';

const sessions = new WeakMap<Rc505MemoryRuntime, Rc505Memory>();
const store = new Rc505MemoryStore();
const state = reactive({ number: null as number | null, name: '', dirty: true, busy: false, available: false, reason: '', error: '' });
const getSession = () => {
  const engine = AudioEngine.getInstance();
  const runtime = engine.createRc505MemoryRuntime();
  let session = sessions.get(runtime);
  if (!session) { session = new Rc505Memory(runtime, store); sessions.set(runtime, session); }
  return session;
};

/** Shared Classic semantic Memory. Legacy Enhanced project archives stay separate. */
export function useRc505Memory() {
  function refresh(): void {
    try {
      const engine = AudioEngine.getInstance();
      const session = getSession();
      const readiness = engine.createRc505MemoryRuntime().canSwitch();
      Object.assign(state, { number: session.currentNumber, name: session.currentName, dirty: session.dirty,
        busy: session.busy, available: typeof indexedDB !== 'undefined' && readiness.allowed,
        reason: typeof indexedDB === 'undefined' ? 'Persistent Memory storage is unavailable.' : readiness.reason });
    } catch (error) { state.available = false; state.reason = error instanceof Error ? error.message : String(error); }
  }
  async function perform(action: (session: Rc505Memory) => Promise<void>): Promise<void> {
    if (state.busy) throw new Error('A Memory transaction is already pending.');
    state.error = ''; state.busy = true;
    try { await action(getSession()); }
    catch (error) { state.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { state.busy = false; refresh(); }
  }
  return { state, refresh,
    setName: (name: string) => { getSession().setName(name); refresh(); },
    save: (slot: number) => perform(session => session.save(slot, session.currentName)),
    load: (slot: number) => perform(async session => {
      await session.load(slot);
      const configuration = AudioEngine.getInstance().getBrowserMemoryConfiguration();
      if (configuration) await adoptCommittedBrowserFxState(configuration);
    }),
    clear: (slot: number) => perform(session => session.clear(slot)),
  };
}
