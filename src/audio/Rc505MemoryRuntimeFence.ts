import type { Rc505MemoryRuntime } from './Rc505Memory';

export interface Rc505MemoryRuntimeContext {
  /** Must change on mode switches, including a switch away and back. */
  revision(): string;
  active(): boolean;
  /** Blocks backend replacement until the prepared transaction is disposed. */
  acquire(): () => void;
}

export function fenceRc505MemoryRuntime(runtime: Rc505MemoryRuntime, context: Rc505MemoryRuntimeContext): Rc505MemoryRuntime {
  const revision = () => JSON.stringify([context.revision(), context.active(), runtime.revision()]);
  const assert = (expected: string) => {
    if (!context.active() || revision() !== expected) throw new Error('Audio backend changed during Memory operation; switch canceled.');
  };
  return {
    revision,
    canSwitch: () => context.active() ? runtime.canSwitch() : { allowed: false, reason: 'This Memory belongs to an inactive audio backend.' },
    capture: async () => { const expected = revision(); assert(expected); const document = await runtime.capture(); assert(expected); return document; },
    prepare: async (document, expected) => {
      assert(expected);
      const rawRevision = runtime.revision();
      const release = context.acquire();
      let prepared: Awaited<ReturnType<Rc505MemoryRuntime['prepare']>> | undefined;
      try { prepared = await runtime.prepare(document, rawRevision); assert(expected); }
      catch (error) { try { await prepared?.dispose(); } finally { release(); } throw error; }
      let disposed = false;
      return {
        commit: async () => { if (disposed) throw new Error('Memory candidate is disposed.'); assert(expected); await prepared!.commit(); },
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          try { await prepared!.dispose(); } finally { release(); }
        },
      };
    },
  };
}
