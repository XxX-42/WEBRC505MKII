import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, NativeTransportBatchOutcomeUnknownError, type NativeStatus } from '../../src/audio/NativeBridgeClient';

const host = 'a'.repeat(32);
const intentPlaceholder = '0'.repeat(32);
const initialStatuses = new Map<string, NativeStatus>();

function status(action: 'play' | 'stop', states: string[] = ['Stopped', 'Stopped', 'Empty', 'Empty', 'Empty']): NativeStatus {
  const recording = action === 'stop' && states.some(value => value === 'Recording');
  return {
    ok: true, bridgeHealthy: true, engineRunning: true, backend: 'WASAPI', inputDeviceId: '', outputDeviceId: '',
    inputDeviceName: '', outputDeviceName: '', sampleRate: 48_000, bufferFrames: 128, monitoringEnabled: false,
    state: 'Stopped', inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0, inputPeak: 0, outputPeak: 0,
    xrunsOrDropouts: 0, lastError: '', hostIncarnationId: host, nativeSampleFrame: 1_000,
    nativeMemory: { version: 1, loopTransports: [], loopSync: [false, false, false, false, false] },
    nativeRecordPlay: { version: 1, recActionAvailable: true, quantizeAvailable: false, recAction: 'REC->PLAY',
      requestedRevision: 0, appliedRevision: 0, finishRequested: [0, 0, 0, 0, 0], finishApplied: [0, 0, 0, 0, 0],
      stopRequested: [0, 0, 0, 0, 0], stopApplied: [0, 0, 0, 0, 0], stopCommittedRevision: [0, 0, 0, 0, 0] },
    nativeLoopFrameScheduling: { version: 1, available: false, batchTransportAvailable: true, requests: Array.from({ length: 5 }, (_, index) => ({
      trackIndex: index, requestedRevision: 0, requestedAbsoluteFrame: 0, requestedPhaseEpoch: 0,
      requestedSettingsRevision: 0, requestedAction: 'play' as const, requestedIntentId: intentPlaceholder,
      batchId: 0, batchMask: 0, stopRevision: 0, provenanceValid: false, provenanceBpm: null, provenanceRevision: 0,
      appliedRevision: 0, appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0,
    })) },
    nativeRecordingTempoTokens: states.map((state, index) => ({ trackId: index + 1, valid: state === 'Recording' && recording,
      bpm: state === 'Recording' && recording ? 120 + index : null, revision: state === 'Recording' && recording ? 70 + index : 0 })),
    nativeTracks: states.map((state, index) => ({ trackId: index + 1, state: state as NativeStatus['nativeTracks'][number]['state'],
      stateCode: ({ Empty: 0, Recording: 1, Stopped: 2, Playing: 3, Overdubbing: 4 } as Record<string, number>)[state],
      loopProgress: 0, loopLengthSamples: state === 'Stopped' ? 8_000 : 0, contentRevision: index + 1 })),
  } as NativeStatus;
}

function response(value: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(value), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
}

function mockBatch(action: 'play' | 'stop', loseScheduleResponse = false, hostRestarts = false,
    afterAck: 'mutate' | 'fail' | null = null) {
  let latest = status(action, action === 'play'
    ? ['Stopped', 'Stopped', 'Empty', 'Empty', 'Empty']
    : ['Recording', 'Recording', 'Empty', 'Empty', 'Empty']);
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let cancelled = false;
  let ackRead = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.pathname === '/v1/status') {
      if (ackRead && afterAck === 'fail') { afterAck = null; throw new Error('status unavailable'); }
      if (ackRead && afterAck === 'mutate') {
        latest.nativeTracks![0] = { ...latest.nativeTracks![0]!, state: 'Stopped', stateCode: 2 };
        latest.nativeLoopFrameScheduling!.requests![0]!.requestedRevision += 1;
        afterAck = null;
      }
      if (hostRestarts && posts.length > 0) latest = { ...latest, hostIncarnationId: 'b'.repeat(32) };
      return response(latest);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    posts.push({ path: url.pathname, body });
    if (url.pathname === '/v1/transport/batch-schedule') {
      const revisions = body.expectedScheduleRevisions as number[];
      const stopRevisions = body.expectedStopRevisions as number[];
      const mask = body.trackMask as number;
      const actionValue = body.action as 'play' | 'stop';
      const requested = latest.nativeLoopFrameScheduling!.requests!.map(item => ({ ...item }));
      const acceptedRevisions = [0, 0, 0, 0, 0];
      for (let index = 0; index < 5; index += 1) {
        if ((mask & (1 << index)) === 0) continue;
        const revision = revisions[index]! + 1;
        acceptedRevisions[index] = revision;
        const appliedState = actionValue === 'play' ? 'Playing' : 'Stopped';
        requested[index] = { ...requested[index]!, requestedRevision: revision,
          requestedAbsoluteFrame: body.absoluteFrame as number, requestedAction: actionValue,
          requestedIntentId: body.intentId as string, batchId: 77, batchMask: mask,
          appliedRevision: revision, appliedAbsoluteFrame: body.absoluteFrame as number,
          stopRevision: actionValue === 'stop' ? stopRevisions[index]! + 1 : 0,
          provenanceValid: actionValue === 'stop' && index < 2,
          provenanceBpm: actionValue === 'stop' && index < 2 ? 120 + index : null,
          provenanceRevision: actionValue === 'stop' && index < 2 ? 70 + index : 0 };
        latest.nativeTracks![index] = { ...latest.nativeTracks![index]!, state: appliedState,
          stateCode: appliedState === 'Playing' ? 3 : 2 };
        if (actionValue === 'stop' && index < 2) {
          latest.nativeRecordPlay!.stopCommittedRevision[index] = stopRevisions[index]! + 1;
        }
      }
      latest = { ...latest, nativeLoopFrameScheduling: { ...latest.nativeLoopFrameScheduling!, requests: requested,
        acceptedBatchId: 77, acceptedBatchMask: mask, acceptedBatchIntentId: body.intentId as string,
        acceptedBatchRevisions: acceptedRevisions } };
      if (loseScheduleResponse) throw new Error('simulated lost schedule response');
      return response(latest);
    }
    if (url.pathname === '/v1/transport/batch-status') {
      ackRead = true;
      const mask = body.trackMask as number;
      const members = latest.nativeLoopFrameScheduling!.requests!.flatMap((item, index) =>
        (mask & (1 << index)) === 0 ? [] : [{ trackId: index + 1, revision: item.requestedRevision,
          requestedAbsoluteFrame: item.requestedAbsoluteFrame, action: item.requestedAction,
          stopRevision: item.stopRevision ?? 0, appliedRevision: item.requestedRevision,
          appliedAbsoluteFrame: item.requestedAbsoluteFrame, cancelledRevision: 0, faultRevision: 0, fault: 0 }]);
      return response({ ok: true, state: cancelled ? 4 : 5, hostIncarnationId: host, batchId: 77, trackMask: mask,
        intentId: body.intentId, members });
    }
    if (url.pathname === '/v1/transport/batch-cancel') {
      cancelled = true;
      return response(latest);
    }
    throw new Error(`Unexpected Native mock request: ${method} ${url.pathname}`);
  }));
  return { posts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.removeItem('webrc.nativeTransportBatchReceipt.v1');
});

describe('Native ALL atomic transport batches', () => {
  it('posts a shared PLAY frame and waits for exact all-member ACKs', async () => {
    mockBatch('play');
    const client = new NativeBridgeClient('http://native.test');
    const result = await client.scheduleNativeTransportBatch('play');
    expect(result.nativeTransportBatchAcknowledgement).toMatchObject({ action: 'play', batchId: 77, trackMask: 3 });
    expect(client.getPendingNativeTransportBatch()).toBeNull();
  });

  it('accepts an archived ACK even when later track state and schedule have changed', async () => {
    mockBatch('play', false, false, 'mutate');
    const client = new NativeBridgeClient('http://native.test');
    const result = await client.scheduleNativeTransportBatch('play');
    expect(result.nativeTracks![0]!.state).toBe('Stopped');
    expect(result.nativeTransportBatchAcknowledgement?.revisions[0]).toBe(1);
    expect(client.getPendingNativeTransportBatch()).toBeNull();
  });

  it('retains the exact receipt across a status failure after the ACK', async () => {
    const { posts } = mockBatch('stop', false, false, 'fail');
    const client = new NativeBridgeClient('http://native.test');
    await expect(client.scheduleNativeTransportBatch('stop')).rejects.toBeInstanceOf(NativeTransportBatchOutcomeUnknownError);
    const pending = client.getPendingNativeTransportBatch();
    expect(pending?.recordingTempoTokens[0]).toEqual({ bpm: 120, revision: 70 });
    const restored = new NativeBridgeClient('http://native.test');
    expect(restored.getPendingNativeTransportBatch()).toEqual(pending);
    const result = await restored.reconcilePendingNativeTransportBatch();
    expect(result.nativeTransportBatchAcknowledgement?.recordingTempoTokens[0]).toEqual({ bpm: 120, revision: 70 });
    expect(posts.filter(item => item.path === '/v1/transport/batch-schedule')).toHaveLength(1);
  });

  it('reconciles a lost schedule response by its one exact intent without replaying', async () => {
    const { posts } = mockBatch('stop', true);
    const client = new NativeBridgeClient('http://native.test');
    const result = await client.scheduleNativeTransportBatch('stop');
    expect(result.nativeTransportBatchAcknowledgement?.recordingTempoTokens.slice(0, 2)).toEqual([
      { bpm: 120, revision: 70 }, { bpm: 121, revision: 71 },
    ]);
    expect(posts.filter(item => item.path === '/v1/transport/batch-schedule')).toHaveLength(1);
    expect(posts.find(item => item.path === '/v1/transport/batch-schedule')?.body).toMatchObject({
      trackMask: 3, provenanceMask: 3, provenanceRevisions: [70, 71, 0, 0, 0],
    });
  });

  it('keeps a receipt unknown and blocks replay when the host incarnation changes', async () => {
    mockBatch('play', true, true);
    const client = new NativeBridgeClient('http://native.test');
    await expect(client.scheduleNativeTransportBatch('play')).rejects.toBeInstanceOf(NativeTransportBatchOutcomeUnknownError);
    expect(client.getPendingNativeTransportBatch()?.batchId).toBeNull();
    await expect(client.scheduleNativeTransportBatch('play')).rejects.toBeInstanceOf(NativeTransportBatchOutcomeUnknownError);
  });

  it('cancels by the complete exact batch identity and waits for the group cancellation ACK', async () => {
    const { posts } = mockBatch('play');
    const client = new NativeBridgeClient('http://native.test');
    const receipt = { batchId: 77, trackMask: 3, action: 'play' as const, intentId: 'c'.repeat(32),
      hostIncarnationId: host, absoluteFrame: 25_000, revisions: [1, 1, 0, 0, 0],
      recordingTempoTokens: [null, null, null, null, null] };
    await client.cancelNativeTransportBatch(receipt);
    expect(posts.find(item => item.path === '/v1/transport/batch-cancel')?.body).toEqual({
      hostIncarnationId: host, batchId: 77, trackMask: 3, intentId: receipt.intentId, revisions: receipt.revisions,
    });
    expect(client.getPendingNativeTransportBatch()).toBeNull();
  });
});
