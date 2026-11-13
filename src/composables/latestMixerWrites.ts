/** Coalesce continuous mixer gestures while preserving confirmed backend writes. */
export class LatestMixerWrites {
  private readonly pending = new Map<string, { latest: number | null; target: number; invalidated: boolean; settled: Array<() => void> }>();
  hasPending(): boolean { return this.pending.size > 0; }
  invalidate(): void { for (const state of this.pending.values()) { state.latest = null; state.invalidated = true; } }
  target(key: string, fallback: number): number { return this.pending.get(key)?.target ?? fallback; }
  submit(key: string, value: number, write: (value: number) => Promise<void>, valid: () => boolean, onError: (error: unknown) => void | Promise<void>, onSettled: () => void = () => {}): void {
    const current = this.pending.get(key);
    if (current) { current.settled.push(onSettled); if (!current.invalidated) { current.latest = value; current.target = value; } return; }
    const state = { latest: null as number | null, target: value, invalidated: false, settled: [onSettled] };
    this.pending.set(key, state);
    const drain = async () => {
      let next: number | null = value;
      try {
        while (next !== null && !state.invalidated && valid()) {
          await write(next);
          next = state.latest;
          state.latest = null;
        }
      } catch (error) { state.latest = null; try { await onError(error); } catch { /* reconciliation failure must not retry or leak a rejection */ } }
      finally { this.pending.delete(key); for (const settled of state.settled) { try { settled(); } catch { /* observers cannot break the queue */ } } }
    };
    void drain();
  }
}
export const latestMixerWrites = new LatestMixerWrites();
