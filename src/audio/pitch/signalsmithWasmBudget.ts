/**
 * Browser live Signalsmith processors each own a private Emscripten linear
 * memory. These caps bound that memory only; they are not JS heap, loop-buffer,
 * browser-process RSS, or realtime guarantees.
 */
export const SIGNALSMITH_WASM_PAGE_BYTES = 64 * 1024;
export const SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES = 20 * SIGNALSMITH_WASM_PAGE_BYTES;
export const SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES = 64 * SIGNALSMITH_WASM_PAGE_BYTES;
export const SIGNALSMITH_LIVE_WASM_BUDGET_BYTES = 128 * 1024 * 1024;

export type SignalsmithLiveWasmRole = 'LIVE_FX' | 'LIVE_POLY';

export interface SignalsmithLiveWasmSnapshot {
  readonly budgetBytes: number;
  readonly reservedBytes: number;
  readonly measuredBytes: number;
  readonly processorCount: number;
  readonly liveFxProcessorCount: number;
  readonly livePolyProcessorCount: number;
  readonly pendingCount: number;
  readonly releaseUnconfirmedCount: number;
}

export interface SignalsmithLiveWasmLease {
  readonly role: SignalsmithLiveWasmRole;
  readonly ceilingBytes: number;
  confirm(measuredBytes: number): void;
  observe(measuredBytes: number): void;
  markReleaseUnconfirmed(reason: string): void;
  release(): void;
}

interface LeaseEntry {
  readonly id: number;
  readonly role: SignalsmithLiveWasmRole;
  readonly ceilingBytes: number;
  measuredBytes: number | null;
  releaseUnconfirmed: boolean;
  reason: string | null;
}

const ceilingFor = (role: SignalsmithLiveWasmRole): number => role === 'LIVE_POLY'
  ? SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES
  : SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES;

/** Owner-based preflight for per-node WASM linear-memory reservations. */
export class SignalsmithLiveWasmLedger {
  private readonly entries = new Map<number, LeaseEntry>();
  private nextId = 1;
  readonly budgetBytes: number;

  constructor(budgetBytes = SIGNALSMITH_LIVE_WASM_BUDGET_BYTES) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
      throw new RangeError('Signalsmith live WASM budget must be a positive safe integer');
    }
    this.budgetBytes = budgetBytes;
  }

  reserve(role: SignalsmithLiveWasmRole): SignalsmithLiveWasmLease {
    const ceilingBytes = ceilingFor(role);
    const snapshot = this.snapshot();
    if (snapshot.reservedBytes + ceilingBytes > this.budgetBytes) {
      const format = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
      throw new RangeError(
        `Signalsmith ${role} was not allocated: its ${format(ceilingBytes)} per-processor WASM reservation `
        + `would exceed the ${format(this.budgetBytes)} per-AudioContext live WASM budget `
        + `(${format(snapshot.reservedBytes)} is already reserved). Clear another pitch effect or reduce the active pitch graph; the existing effect was kept.`,
      );
    }

    const id = this.nextId++;
    this.entries.set(id, {
      id,
      role,
      ceilingBytes,
      measuredBytes: null,
      releaseUnconfirmed: false,
      reason: null,
    });
    return Object.freeze({
      role,
      ceilingBytes,
      confirm: (bytes: number) => this.measure(id, bytes, true),
      observe: (bytes: number) => this.measure(id, bytes, false),
      markReleaseUnconfirmed: (reason: string) => this.markReleaseUnconfirmed(id, reason),
      release: () => this.release(id),
    });
  }

  snapshot(): SignalsmithLiveWasmSnapshot {
    let reservedBytes = 0;
    let measuredBytes = 0;
    let pendingCount = 0;
    let releaseUnconfirmedCount = 0;
    let liveFxProcessorCount = 0;
    let livePolyProcessorCount = 0;
    for (const entry of this.entries.values()) {
      // Keep the conservative per-role ceiling reserved for the full lifetime.
      // This also covers future in-instance growth without an unbudgeted callback.
      reservedBytes += entry.ceilingBytes;
      if (entry.measuredBytes === null) pendingCount += 1;
      else measuredBytes += entry.measuredBytes;
      if (entry.releaseUnconfirmed) releaseUnconfirmedCount += 1;
      if (entry.role === 'LIVE_FX') liveFxProcessorCount += 1;
      else livePolyProcessorCount += 1;
    }
    return Object.freeze({
      budgetBytes: this.budgetBytes,
      reservedBytes,
      measuredBytes,
      processorCount: this.entries.size,
      liveFxProcessorCount,
      livePolyProcessorCount,
      pendingCount,
      releaseUnconfirmedCount,
    });
  }

  /** Context closure terminates all of its worklets, making their leases safe to release. */
  releaseAll(): void {
    this.entries.clear();
  }

  private measure(id: number, bytes: number, initial: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Signalsmith WASM lease is no longer resident');
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % SIGNALSMITH_WASM_PAGE_BYTES !== 0) {
      throw new RangeError(`Signalsmith reported an invalid WASM linear-memory capacity: ${bytes}`);
    }
    if (bytes > entry.ceilingBytes) {
      throw new RangeError(
        `Signalsmith ${entry.role} requires ${bytes} bytes of WASM memory, above the ${entry.ceilingBytes}-byte per-processor cap; the effect was rejected.`,
      );
    }
    if (initial && entry.measuredBytes !== null) {
      throw new Error('Signalsmith WASM lease was already initialized');
    }
    if (entry.measuredBytes !== null && bytes < entry.measuredBytes) {
      // WebAssembly.Memory never shrinks; a lower report means the module was
      // disposed or a stale response arrived and must not lower accounting.
      throw new RangeError('Signalsmith reported a stale/shrinking WASM memory capacity');
    }
    entry.measuredBytes = bytes;
  }

  private markReleaseUnconfirmed(id: number, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.releaseUnconfirmed = true;
    entry.reason = reason.slice(0, 500);
  }

  private release(id: number): void {
    this.entries.delete(id);
  }
}

const contextLedgers = new WeakMap<BaseAudioContext, SignalsmithLiveWasmLedger>();

export function signalsmithLiveWasmLedger(context: BaseAudioContext): SignalsmithLiveWasmLedger {
  let ledger = contextLedgers.get(context);
  if (!ledger) {
    ledger = new SignalsmithLiveWasmLedger();
    contextLedgers.set(context, ledger);
    const ownedLedger = ledger;
    if (typeof context.addEventListener === 'function') {
      context.addEventListener('statechange', () => {
        if (context.state === 'closed') ownedLedger.releaseAll();
      });
    }
  }
  return ledger;
}

export function signalsmithLiveWasmSnapshot(context: BaseAudioContext): SignalsmithLiveWasmSnapshot {
  return signalsmithLiveWasmLedger(context).snapshot();
}
