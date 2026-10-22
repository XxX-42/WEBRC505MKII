import { describe, expect, it } from 'vitest';
import {
  SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
  SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES,
  SIGNALSMITH_LIVE_WASM_BUDGET_BYTES,
  SIGNALSMITH_WASM_PAGE_BYTES,
  SignalsmithLiveWasmLedger,
} from '../../../../src/audio/pitch/signalsmithWasmBudget';

const MIB = 1024 * 1024;

describe('Signalsmith live WASM budget ledger', () => {
  it('reserves the role-specific LIVE_FX and LIVE_POLY page ceilings', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    const liveFx = ledger.reserve('LIVE_FX');
    const livePoly = ledger.reserve('LIVE_POLY');

    expect(SIGNALSMITH_WASM_PAGE_BYTES).toBe(64 * 1024);
    expect(SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES).toBe(20 * SIGNALSMITH_WASM_PAGE_BYTES);
    expect(SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES).toBe(64 * SIGNALSMITH_WASM_PAGE_BYTES);
    expect(liveFx).toMatchObject({ role: 'LIVE_FX', ceilingBytes: 20 * SIGNALSMITH_WASM_PAGE_BYTES });
    expect(livePoly).toMatchObject({ role: 'LIVE_POLY', ceilingBytes: 64 * SIGNALSMITH_WASM_PAGE_BYTES });
    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: 84 * SIGNALSMITH_WASM_PAGE_BYTES,
      processorCount: 2,
      pendingCount: 2,
      measuredBytes: 0,
    });
  });

  it('allows the exact 128 MiB aggregate ceiling and rejects another reservation', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    expect(SIGNALSMITH_LIVE_WASM_BUDGET_BYTES).toBe(128 * MIB);
    expect(SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES).toBe(4 * MIB);

    // Thirty-two per-processor LIVE_POLY ceilings exactly fill the AudioContext budget.
    const leases = Array.from({ length: 32 }, () => ledger.reserve('LIVE_POLY'));
    expect(ledger.snapshot()).toMatchObject({
      budgetBytes: 128 * MIB,
      reservedBytes: 32 * 4 * MIB,
      processorCount: 32,
      pendingCount: 32,
    });
    expect(ledger.snapshot().reservedBytes).toBe(ledger.snapshot().budgetBytes);
    const fullSnapshot = ledger.snapshot();

    expect(() => ledger.reserve('LIVE_FX')).toThrow(/would exceed the 128\.00 MiB per-AudioContext live WASM budget/);
    expect(ledger.snapshot()).toEqual(fullSnapshot);
    expect(leases).toHaveLength(32);
  });

  it('budgets the complete supported graph and only admits replacement overlap within the 3 MiB margin', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    const steadyGraph = [
      ...Array.from({ length: 84 }, () => ledger.reserve('LIVE_FX')),
      ...Array.from({ length: 5 }, () => ledger.reserve('LIVE_POLY')),
    ];
    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: 125 * MIB,
      budgetBytes: 128 * MIB,
      liveFxProcessorCount: 84,
      livePolyProcessorCount: 5,
    });

    // A three-voice OCTAVE replacement needs 3.75 MiB. At the full steady
    // graph, two voices fit temporarily but the third must be rejected.
    const candidateVoices = [ledger.reserve('LIVE_FX'), ledger.reserve('LIVE_FX')];
    expect(ledger.snapshot().reservedBytes).toBe(127.5 * MIB);
    expect(() => ledger.reserve('LIVE_FX')).toThrow(/would exceed the 128\.00 MiB/);
    candidateVoices.forEach((lease) => lease.release());
    expect(ledger.snapshot().reservedBytes).toBe(125 * MIB);
    expect(steadyGraph).toHaveLength(89);
  });

  it('admits a synchronous burst without overbooking the shared budget', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    const results = Array.from({ length: 40 }, () => {
      try {
        return { lease: ledger.reserve('LIVE_POLY'), error: null };
      } catch (error) {
        return { lease: null, error };
      }
    });

    expect(results.filter((result) => result.lease !== null)).toHaveLength(32);
    expect(results.filter((result) => result.error !== null)).toHaveLength(8);
    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: SIGNALSMITH_LIVE_WASM_BUDGET_BYTES,
      processorCount: 32,
      pendingCount: 32,
    });
  });

  it('denies an over-budget request without changing or dropping incumbent leases', () => {
    const ledger = new SignalsmithLiveWasmLedger(
      SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES + SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
    );
    const incumbents = [ledger.reserve('LIVE_POLY'), ledger.reserve('LIVE_FX')];
    incumbents[0]!.confirm(SIGNALSMITH_WASM_PAGE_BYTES);
    const beforeDeniedRequest = ledger.snapshot();

    expect(() => ledger.reserve('LIVE_FX')).toThrow(/existing effect was kept/);
    expect(ledger.snapshot()).toEqual(beforeDeniedRequest);

    incumbents[1]!.confirm(SIGNALSMITH_WASM_PAGE_BYTES);
    expect(ledger.snapshot()).toMatchObject({
      processorCount: 2,
      pendingCount: 0,
      reservedBytes: SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES + SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
    });
  });

  it('validates measured page counts and per-role ceilings without corrupting accounting', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    const liveFx = ledger.reserve('LIVE_FX');
    const livePoly = ledger.reserve('LIVE_POLY');
    const beforeMeasurements = ledger.snapshot();

    for (const invalidBytes of [0, -SIGNALSMITH_WASM_PAGE_BYTES, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => liveFx.confirm(invalidBytes)).toThrow(/invalid WASM linear-memory capacity/);
    }
    expect(() => liveFx.confirm(SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES + SIGNALSMITH_WASM_PAGE_BYTES))
      .toThrow(/above the .* per-processor cap/);
    expect(() => livePoly.confirm(SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES + SIGNALSMITH_WASM_PAGE_BYTES))
      .toThrow(/above the .* per-processor cap/);
    expect(ledger.snapshot()).toEqual(beforeMeasurements);

    liveFx.confirm(SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES);
    livePoly.confirm(SIGNALSMITH_WASM_PAGE_BYTES);
    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES + SIGNALSMITH_LIVE_POLY_MAX_WASM_BYTES,
      measuredBytes: SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES + SIGNALSMITH_WASM_PAGE_BYTES,
      processorCount: 2,
      pendingCount: 0,
    });

    livePoly.observe(2 * SIGNALSMITH_WASM_PAGE_BYTES);
    expect(ledger.snapshot().measuredBytes).toBe(SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES + 2 * SIGNALSMITH_WASM_PAGE_BYTES);
    expect(() => livePoly.observe(SIGNALSMITH_WASM_PAGE_BYTES)).toThrow(/stale\/shrinking/);
    expect(ledger.snapshot().measuredBytes).toBe(SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES + 2 * SIGNALSMITH_WASM_PAGE_BYTES);
    expect(() => liveFx.confirm(SIGNALSMITH_WASM_PAGE_BYTES)).toThrow(/already initialized/);
  });

  it('retains a lease marked for unconfirmed release until release is confirmed', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    const lease = ledger.reserve('LIVE_FX');
    lease.confirm(SIGNALSMITH_WASM_PAGE_BYTES);
    lease.markReleaseUnconfirmed('dispose acknowledgement timed out');

    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: SIGNALSMITH_LIVE_FX_MAX_WASM_BYTES,
      measuredBytes: SIGNALSMITH_WASM_PAGE_BYTES,
      processorCount: 1,
      pendingCount: 0,
      releaseUnconfirmedCount: 1,
    });

    lease.release();
    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: 0,
      measuredBytes: 0,
      processorCount: 0,
      pendingCount: 0,
      releaseUnconfirmedCount: 0,
    });
  });

  it('releases all leases when the AudioContext closes and invalidates stale measurements', () => {
    const ledger = new SignalsmithLiveWasmLedger();
    const leases = [ledger.reserve('LIVE_FX'), ledger.reserve('LIVE_POLY')];

    ledger.releaseAll();

    expect(ledger.snapshot()).toMatchObject({
      reservedBytes: 0,
      measuredBytes: 0,
      processorCount: 0,
      pendingCount: 0,
      releaseUnconfirmedCount: 0,
    });
    expect(() => leases[0]!.observe(SIGNALSMITH_WASM_PAGE_BYTES)).toThrow(/no longer resident/);
    expect(() => leases[1]!.confirm(SIGNALSMITH_WASM_PAGE_BYTES)).toThrow(/no longer resident/);
  });
});
