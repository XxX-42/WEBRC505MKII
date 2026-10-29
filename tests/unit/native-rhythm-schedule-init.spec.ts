import { describe, expect, it, vi } from 'vitest';
import { NativeAudioEngine } from '../../src/audio/NativeAudioEngine';
import type { NativeBridgeClient, NativeRhythmScheduleReceipt, NativeStatus } from '../../src/audio/NativeBridgeClient';

function createEngine(ownerReceipt: NativeRhythmScheduleReceipt | null, reconcile: () => Promise<NativeStatus>) {
  const engine = Object.create(NativeAudioEngine.prototype) as NativeAudioEngine & {
    bridge: NativeBridgeClient;
    reconcileRhythmScheduleForInit(status: NativeStatus): Promise<NativeStatus>;
  };
  const reconcilePendingRhythmSchedule = vi.fn(reconcile);
  engine.bridge = {
    getPendingRhythmSchedule: vi.fn(() => ownerReceipt),
    reconcilePendingRhythmSchedule,
  } as unknown as NativeBridgeClient;
  return { engine, reconcilePendingRhythmSchedule };
}

describe('Native Rhythm schedule initialization reconciliation', () => {
  it('reconciles a local owner receipt even when the host already reports a terminal ACK', async () => {
    const ownerReceipt: NativeRhythmScheduleReceipt = { trackId: 1, action: 'record', revision: 9,
      baselineRevision: 8, absoluteFrame: 48_000, phaseEpoch: 3, settingsRevision: 4,
      hostIncarnationId: 'a'.repeat(32), intentId: 'b'.repeat(32) };
    const status = { nativeLoopFrameScheduling: { requests: [{ requestedRevision: 9, appliedRevision: 9,
      cancelledRevision: 0, faultRevision: 0 }] } } as NativeStatus;
    const { engine, reconcilePendingRhythmSchedule } = createEngine(ownerReceipt, async () => status);

    await expect((engine as any).reconcileRhythmScheduleForInit(status)).resolves.toBe(status);
    expect(reconcilePendingRhythmSchedule).toHaveBeenCalledOnce();
  });

  it('delegates an orphan pending status to the read-only client recovery path', async () => {
    const status = { nativeLoopFrameScheduling: { requests: [{ requestedRevision: 5, appliedRevision: 0,
      cancelledRevision: 0, faultRevision: 0 }] } } as NativeStatus;
    const unknown = new Error('pending receipt has no local owner');
    const { engine, reconcilePendingRhythmSchedule } = createEngine(null, async () => { throw unknown; });

    await expect((engine as any).reconcileRhythmScheduleForInit(status)).rejects.toBe(unknown);
    expect(reconcilePendingRhythmSchedule).toHaveBeenCalledOnce();
  });
});
