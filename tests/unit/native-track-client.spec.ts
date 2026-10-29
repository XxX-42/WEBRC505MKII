import { describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, NativeRhythmScheduleOutcomeUnknownError, type NativeLoopTransportConfig } from '../../src/audio/NativeBridgeClient';

describe('Native multi-track bridge client', () => {
  it('keeps Track 1 routes compatible and targets selected higher tracks for transport', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await client.recordTrack(1);
    await client.stopTrack(5);
    await client.playTrack(5);
    await client.toggleTrackOverdub(5);
    await client.clearTrack(5);
    await client.undoTrack(1);
    await client.redoTrack(3);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:17755/v1/transport/record',
      'http://127.0.0.1:17755/v1/transport/stop?trackId=5',
      'http://127.0.0.1:17755/v1/transport/play?trackId=5',
      'http://127.0.0.1:17755/v1/transport/overdub-toggle?trackId=5',
      'http://127.0.0.1:17755/v1/transport/clear?trackId=5',
      'http://127.0.0.1:17755/v1/transport/undo',
      'http://127.0.0.1:17755/v1/transport/redo?trackId=3',
    ]);
  });

  it('requires callback ACK for Rhythm-scheduled REC and sends the phase token unchanged', async () => {
    const hostIncarnationId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const baseline = { trackIndex: 1, requestedRevision: 6, requestedAbsoluteFrame: 0, requestedIntentId: '0'.repeat(32),
      requestedPhaseEpoch: 0, requestedSettingsRevision: 0, requestedAction: 'record', appliedRevision: 0,
      appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 };
    let submittedIntentId = '';
    const accepted = () => ({ ...baseline, requestedRevision: 7, requestedAbsoluteFrame: 19_200,
      requestedIntentId: submittedIntentId,
      requestedPhaseEpoch: 4, requestedSettingsRevision: 9, requestedAction: 'record', appliedRevision: 7,
      appliedAbsoluteFrame: 19_200 });
    let statusReads = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/transport/rhythm-schedule')) {
        submittedIntentId = (JSON.parse(String(init?.body)) as { intentId: string }).intentId;
      }
      const response = String(url).endsWith('/v1/status') && ++statusReads === 1
        ? { ok: true, hostIncarnationId, nativeLoopFrameScheduling: { requests: [{}, baseline] } }
        : { ok: true, hostIncarnationId, nativeLoopFrameScheduling: { version: 1, available: true,
          acceptedTrackId: 2, acceptedRevision: 7, requests: [{}, accepted()] } };
      return { json: async () => response } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const status = await client.scheduleRhythmRecordOrStop(2, 'record', {
      absoluteFrame: 19_200, epoch: 4, settingsRevision: 9,
    });

    expect(status.nativeLoopFrameScheduling?.requests?.[1]).toMatchObject({ appliedRevision: 7, appliedAbsoluteFrame: 19_200 });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17755/v1/transport/rhythm-schedule', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ trackId: 2, action: 'record', absoluteFrame: 19_200, phaseEpoch: 4,
        settingsRevision: 9, intentId: submittedIntentId, hostIncarnationId, expectedRevision: 6 }), signal: expect.any(AbortSignal),
    }));
  });

  it('reports an applied schedule from host status after reconnect without issuing transport writes', async () => {
    const hostIncarnationId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const applied = { trackIndex: 0, requestedRevision: 12, requestedAbsoluteFrame: 48_000, requestedIntentId: 'c'.repeat(32),
      requestedPhaseEpoch: 3, requestedSettingsRevision: 8, requestedAction: 'stop', appliedRevision: 12,
      appliedAbsoluteFrame: 48_000, cancelledRevision: 0, faultRevision: 0, fault: 0 };
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, hostIncarnationId,
      nativeLoopFrameScheduling: { available: false, requests: [{}, applied] } }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const status = await client.reconcilePendingRhythmSchedule();

    expect(status.nativeLoopFrameScheduling?.requests?.[1]).toMatchObject({
      requestedRevision: 12, requestedIntentId: 'c'.repeat(32), appliedRevision: 12, appliedAbsoluteFrame: 48_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks on an orphan pending schedule and never cancels another tab intent', async () => {
    const hostIncarnationId = 'dddddddddddddddddddddddddddddddd';
    const pending = { trackIndex: 2, requestedRevision: 21, requestedAbsoluteFrame: 96_000, requestedIntentId: 'e'.repeat(32),
      requestedPhaseEpoch: 6, requestedSettingsRevision: 11, requestedAction: 'record', appliedRevision: 0,
      appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 };
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, hostIncarnationId,
      nativeLoopFrameScheduling: { available: false, requests: [{}, {}, pending] } }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.reconcilePendingRhythmSchedule()).rejects.toMatchObject({
      name: 'NativeRhythmScheduleOutcomeUnknownError',
      receipt: { trackId: 3, action: 'record', revision: 21, hostIncarnationId, intentId: 'e'.repeat(32) },
      lastStatus: { hostIncarnationId, nativeLoopFrameScheduling: { requests: [{}, {}, pending] } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:17755/v1/status');
  });

  it.each([
    ['cancelled', { appliedRevision: 0, cancelledRevision: 7, faultRevision: 0 }],
    ['fault', { appliedRevision: 0, cancelledRevision: 0, faultRevision: 7, fault: 3 }],
  ] as const)('retains a known owner %s terminal status without relabeling it unknown', async (outcome, terminal) => {
    const hostIncarnationId = 'abababababababababababababababab';
    const receipt = { trackId: 1, action: 'record' as const, revision: 7, baselineRevision: 6,
      absoluteFrame: 24_000, phaseEpoch: 2, settingsRevision: 3, hostIncarnationId, intentId: 'a'.repeat(32) };
    const item = { trackIndex: 0, requestedRevision: 7, requestedAbsoluteFrame: 24_000,
      requestedIntentId: receipt.intentId, requestedPhaseEpoch: 2, requestedSettingsRevision: 3,
      requestedAction: 'record', appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0,
      ...terminal };
    const status = { ok: true, hostIncarnationId, nativeLoopFrameScheduling: { requests: [item] } };
    const fetchMock = vi.fn(async () => ({ json: async () => status }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    (client as any).pendingRhythmSchedule = receipt;

    await expect(client.reconcilePendingRhythmSchedule()).rejects.toMatchObject({
      name: 'NativeRhythmScheduleTerminalError', outcome, receipt, lastStatus: status,
    });
    expect(client.getPendingRhythmSchedule()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:17755/v1/status');
  });

  it('rejects an unacknowledged or out-of-range Rhythm schedule request', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, hostIncarnationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      nativeLoopFrameScheduling: { requests: [{ trackIndex: 0, requestedRevision: 0, requestedAbsoluteFrame: 0,
        requestedPhaseEpoch: 0, requestedSettingsRevision: 0, requestedAction: 'record', appliedRevision: 0,
        requestedIntentId: '0'.repeat(32), appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 }] } }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.scheduleRhythmRecordOrStop(1, 'record', { absoluteFrame: 0, epoch: 1, settingsRevision: 1 }))
      .rejects.toThrow(/status receipt matching/);
    await expect(client.scheduleRhythmRecordOrStop(6, 'record', { absoluteFrame: 0, epoch: 1, settingsRevision: 1 }))
      .rejects.toThrow(/Invalid Rhythm-scheduled/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts cancellation only after the Native bridge publishes the cancelled revision', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const item = String(url).endsWith('/cancel')
        ? { trackIndex: 0, requestedRevision: 3, requestedAbsoluteFrame: 10, requestedIntentId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', appliedRevision: 0, appliedAbsoluteFrame: 0, cancelledRevision: 3, faultRevision: 0, fault: 0 }
        : { trackIndex: 0, requestedRevision: 3, requestedAbsoluteFrame: 10, requestedIntentId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', appliedRevision: 0, appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 };
      return { json: async () => ({ ok: true, hostIncarnationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        nativeLoopFrameScheduling: { requests: [item] } }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const status = await client.cancelRhythmScheduledLoop({ trackId: 1, action: 'record', revision: 3,
      baselineRevision: 2, absoluteFrame: 10, phaseEpoch: 1, settingsRevision: 1,
      hostIncarnationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', intentId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });

    expect(status.nativeLoopFrameScheduling?.requests?.[0]?.cancelledRevision).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:17755/v1/transport/rhythm-schedule/cancel', {
      headers: { 'Content-Type': 'application/json' }, method: 'POST', body: JSON.stringify({ trackId: 1, revision: 3,
        hostIncarnationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', intentId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      signal: expect.any(AbortSignal),
    });
  });

  it.each(['cancel response reports fault', 'cancel response is lost before fault status'] as const)(
    'preserves the owner fault terminal when a cancellation race returns %s', async (race) => {
      const hostIncarnationId = 'cccccccccccccccccccccccccccccccc';
      const receipt = { trackId: 1, action: 'record' as const, revision: 11, baselineRevision: 10,
        absoluteFrame: 48_000, phaseEpoch: 2, settingsRevision: 5, hostIncarnationId, intentId: 'b'.repeat(32) };
      const pending = { trackIndex: 0, requestedRevision: 11, requestedAbsoluteFrame: receipt.absoluteFrame,
        requestedIntentId: receipt.intentId, requestedPhaseEpoch: receipt.phaseEpoch,
        requestedSettingsRevision: receipt.settingsRevision, requestedAction: 'record', appliedRevision: 0,
        appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 };
      const faulted = { ...pending, faultRevision: 11, fault: 4 };
      let reads = 0;
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith('/v1/transport/rhythm-schedule/cancel')) {
          if (race === 'cancel response is lost before fault status') throw new Error('connection reset after cancel race');
          return { json: async () => ({ ok: true, hostIncarnationId,
            nativeLoopFrameScheduling: { requests: [faulted] } }) } as Response;
        }
        reads += 1;
        const item = reads === 1 ? pending : faulted;
        return { json: async () => ({ ok: true, hostIncarnationId,
          nativeLoopFrameScheduling: { requests: [item] } }) } as Response;
      });
      vi.stubGlobal('fetch', fetchMock);
      const client = new NativeBridgeClient();
      (client as any).pendingRhythmSchedule = receipt;
      const pendingStatus = { ok: true, hostIncarnationId, nativeLoopFrameScheduling: { requests: [pending] } };

      await expect((client as any).finishRhythmCancellationReconcile(1, 11, receipt, pendingStatus, new Error('cancel race'))).rejects.toMatchObject({
        name: 'NativeRhythmScheduleTerminalError', outcome: 'fault', receipt,
        lastStatus: { hostIncarnationId, nativeLoopFrameScheduling: { requests: [faulted] } },
      });
      expect(client.getPendingRhythmSchedule()).toBeNull();
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(1);
      expect(reads).toBe(race === 'cancel response is lost before fault status' ? 2 : 1);
    });

  it('retains the accepted schedule revision across a disconnect and cancels only that revision after reconnect', async () => {
    let statusReads = 0;
    let scheduleAccepted = false;
    const hostIncarnationId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const baseline = { trackIndex: 0, requestedRevision: 0, requestedAbsoluteFrame: 0, requestedPhaseEpoch: 0,
      requestedSettingsRevision: 0, requestedAction: 'record', requestedIntentId: '0'.repeat(32), appliedRevision: 0, appliedAbsoluteFrame: 0,
      cancelledRevision: 0, faultRevision: 0, fault: 0 };
    const pending = { trackIndex: 0, requestedRevision: 9, requestedAbsoluteFrame: 19_200,
      requestedPhaseEpoch: 2, requestedSettingsRevision: 3, requestedAction: 'record', requestedIntentId: '',
      appliedRevision: 0, appliedAbsoluteFrame: 0,
      cancelledRevision: 0, faultRevision: 0, fault: 0 };
    let acceptedIntentId = '';
    const cancelled = () => ({ ...pending, requestedIntentId: acceptedIntentId, cancelledRevision: 9 });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/transport/rhythm-schedule')) {
        scheduleAccepted = true;
        acceptedIntentId = (JSON.parse(String(init?.body)) as { intentId: string }).intentId;
        return { json: async () => ({ ok: true, nativeLoopFrameScheduling: {
          version: 1, available: false, acceptedTrackId: 1, acceptedRevision: 9,
          requests: [{ ...pending, requestedIntentId: acceptedIntentId }],
        }, hostIncarnationId }) } as Response;
      }
      if (String(url).endsWith('/v1/status')) {
        if (!scheduleAccepted) return { json: async () => ({ ok: true, hostIncarnationId,
          nativeLoopFrameScheduling: { requests: [baseline] } }) } as Response;
        statusReads += 1;
        if (statusReads <= 2) throw new Error('disconnected');
        const item = init?.method === 'POST' ? cancelled() : { ...pending, requestedIntentId: acceptedIntentId };
        return { json: async () => ({ ok: true, hostIncarnationId, nativeLoopFrameScheduling: { requests: [item] } }) } as Response;
      }
      if (String(url).endsWith('/v1/transport/rhythm-schedule/cancel')) {
        return { json: async () => ({ ok: true, hostIncarnationId, nativeLoopFrameScheduling: { requests: [cancelled()] } }) } as Response;
      }
      throw new Error(`Unexpected request ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.scheduleRhythmRecordOrStop(1, 'record', {
      absoluteFrame: 19_200, epoch: 2, settingsRevision: 3,
    })).rejects.toBeInstanceOf(NativeRhythmScheduleOutcomeUnknownError);
    expect(client.getPendingRhythmSchedule()).toEqual({
      trackId: 1, action: 'record', revision: 9, baselineRevision: 0, absoluteFrame: 19_200,
      phaseEpoch: 2, settingsRevision: 3, hostIncarnationId, intentId: expect.any(String),
    });
    const status = await client.reconcilePendingRhythmSchedule();
    expect(status.nativeLoopFrameScheduling?.requests?.[0]?.cancelledRevision).toBe(9);
    expect(client.getPendingRhythmSchedule()).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:17755/v1/status',
      'http://127.0.0.1:17755/v1/transport/rhythm-schedule',
      'http://127.0.0.1:17755/v1/status',
      'http://127.0.0.1:17755/v1/status',
      'http://127.0.0.1:17755/v1/status',
      'http://127.0.0.1:17755/v1/status',
      'http://127.0.0.1:17755/v1/transport/rhythm-schedule/cancel',
    ]);
  });

  it('keeps an unresolved intent after a POST network error and binds it only to a matching new revision', async () => {
    const hostIncarnationId = 'cccccccccccccccccccccccccccccccc';
    const baseline = { trackIndex: 0, requestedRevision: 4, requestedAbsoluteFrame: 10,
      requestedPhaseEpoch: 1, requestedSettingsRevision: 2, requestedAction: 'record', requestedIntentId: '0'.repeat(32), appliedRevision: 0,
      appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 };
    let submittedIntentId = '';
    const acceptedPending = () => ({ ...baseline, requestedRevision: 5, requestedAbsoluteFrame: 20,
      requestedPhaseEpoch: 7, requestedSettingsRevision: 8, requestedAction: 'record', requestedIntentId: submittedIntentId });
    const cancelled = () => ({ ...acceptedPending(), cancelledRevision: 5 });
    let schedulePosts = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/v1/status')) return { json: async () => ({ ok: true, hostIncarnationId,
        nativeLoopFrameScheduling: { requests: [schedulePosts === 0 ? baseline : acceptedPending()] } }) } as Response;
      if (value.endsWith('/v1/transport/rhythm-schedule')) {
        schedulePosts += 1;
        submittedIntentId = (JSON.parse(String(init?.body)) as { intentId: string }).intentId;
        throw new Error('connection reset after submit');
      }
      if (value.endsWith('/v1/transport/rhythm-schedule/cancel')) {
        return { json: async () => ({ ok: true, hostIncarnationId,
          nativeLoopFrameScheduling: { requests: [cancelled()] } }) } as Response;
      }
      throw new Error(`Unexpected request ${value}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.scheduleRhythmRecordOrStop(1, 'record', {
      absoluteFrame: 20, epoch: 7, settingsRevision: 8,
    })).rejects.toBeInstanceOf(NativeRhythmScheduleOutcomeUnknownError);
    expect(client.getPendingRhythmSchedule()).toMatchObject({ revision: null, baselineRevision: 4,
      absoluteFrame: 20, phaseEpoch: 7, settingsRevision: 8, hostIncarnationId, intentId: expect.any(String) });
    const reconciled = await client.reconcilePendingRhythmSchedule();
    expect(reconciled.nativeLoopFrameScheduling?.requests?.[0]?.cancelledRevision).toBe(5);
    expect(schedulePosts).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(1);
  });

  it('never sends a cancellation against a restarted Native host', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true,
      hostIncarnationId: 'dddddddddddddddddddddddddddddddd',
      nativeLoopFrameScheduling: { requests: [{ trackIndex: 0, requestedRevision: 5, requestedAbsoluteFrame: 20,
        requestedPhaseEpoch: 7, requestedSettingsRevision: 8, requestedAction: 'record',
        requestedIntentId: 'ffffffffffffffffffffffffffffffff', appliedRevision: 0,
        appliedAbsoluteFrame: 0, cancelledRevision: 0, faultRevision: 0, fault: 0 }] },
    }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const oldReceipt = { trackId: 1, action: 'record' as const, revision: 5, baselineRevision: 4,
      absoluteFrame: 20, phaseEpoch: 7, settingsRevision: 8, hostIncarnationId: 'cccccccccccccccccccccccccccccccc',
      intentId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' };

    await expect(client.cancelRhythmScheduledLoop(oldReceipt)).rejects.toBeInstanceOf(NativeRhythmScheduleOutcomeUnknownError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/status');
  });

  it('parses interleaved stereo snapshots for the selected Native track', async () => {
    const samples = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const bytes = samples.buffer.slice(0);
    const headerValues: Record<string, string> = {
      'X-Native-Loop-Sample-Rate': '48000',
      'X-Native-Loop-Frame-Count': '2',
      'X-Native-Loop-Channels': '2',
      'X-Native-Loop-Sample-Format': 'float32le',
      'X-Native-Loop-Revision': '17',
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: (name: string) => headerValues[name] ?? headerValues[name.toLowerCase()] ?? null },
      arrayBuffer: async () => bytes,
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const snapshot = await client.getLoopSnapshot(3);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/export/loop-snapshot?trackId=3',
      { method: 'GET' },
    );
    expect(snapshot).toMatchObject({ sampleRate: 48_000, frameCount: 2, channels: 2, contentRevision: 17 });
    expect([...snapshot.samples]).toEqual([...samples]);
  });

  it('rejects track selectors outside the 1–5 host contract before making requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.recordTrack(0)).rejects.toThrow(/between 1 and 5/);
    await expect(client.undoTrack(0)).rejects.toThrow(/between 1 and 5/);
    await expect(client.getLoopSnapshot(6)).rejects.toThrow(/between 1 and 5/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends typed per-track loop transport settings using the 1-based Native track ID', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const config: NativeLoopTransportConfig = {
      mode: 'vinylFlick',
      beatOffsetBeats: -0.5,
      bpm: 128,
      crossfadeMs: 5,
      vinylSpeedPercent: -100,
      motorReturnSeconds: 0.5,
      brakePercent: 60,
      vinylMixPercent: 82,
    };

    await client.setLoopTransport(3, config);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17755/v1/native-loop-transport/config',
      {
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify({ trackId: 3, ...config }),
        signal: expect.any(AbortSignal),
      },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('applies editor source FX parameters with CAS while preserving host REVERSE and 1SHOT', async () => {
    const current = { mode: 0, oneShot: true, reverse: true, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const applied = { ...current, mode: 2, vinylSpeedPercent: 25, motorReturnSeconds: 2 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [current] },
        nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 5, loopTransportAppliedRevision: 5 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [applied] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 6, loopTransportRequestedRevision: 6,
          loopTransportAppliedRevision: 6, loopTransportFaultRevision: 0 }] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const editorConfig: NativeLoopTransportConfig = { mode: 'vinylFlick', oneShot: false, reverse: false,
      beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5, vinylSpeedPercent: 25, motorReturnSeconds: 2,
      brakePercent: 0, vinylMixPercent: 100 };

    const status = await client.setLoopTransportFx(1, editorConfig);

    expect(status.nativeMemory?.loopTransports[0]?.oneShot).toBe(true);
    expect(status.nativeMemory?.loopTransports[0]?.reverse).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      trackId: 1, mode: 'vinylFlick', oneShot: true, reverse: true, vinylSpeedPercent: 25, expectedRevision: 5,
    });
  });

  it('refuses a stale full-editor update instead of overwriting a newer transport or its flags', async () => {
    const current = { mode: 0, oneShot: true, reverse: true, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [current] },
        nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 8, loopTransportAppliedRevision: 8 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'Native loop transport settings changed concurrently.' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const editorConfig: NativeLoopTransportConfig = { mode: 'off', oneShot: false, reverse: false,
      beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5, vinylSpeedPercent: 0, motorReturnSeconds: 1,
      brakePercent: 0, vinylMixPercent: 100 };

    await expect(client.setLoopTransportFx(1, editorConfig)).rejects.toThrow(/changed concurrently/);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      trackId: 1, mode: 'off', oneShot: true, reverse: true, expectedRevision: 8,
    });
  });

  it('enables Native 1SHOT only after the applied revision and setting read back', async () => {
    const config = { mode: 0, oneShot: false, reverse: true, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const returned = { ...config, oneShot: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 3, loopTransportAppliedRevision: 3 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [returned] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 4, loopTransportRequestedRevision: 4,
          loopTransportAppliedRevision: 4, loopTransportFaultRevision: 0, loopTransportAppliedOneShot: true }] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const status = await client.setOneShot(1, true);

    expect(status.nativeMemory?.loopTransports[0]?.oneShot).toBe(true);
    expect(status.nativeMemory?.loopTransports[0]?.reverse).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      trackId: 1, oneShot: true, reverse: true, expectedRevision: 3,
    });
  });

  it('uses stale-revision CAS for 1SHOT without clearing REVERSE', async () => {
    const config = { mode: 0, oneShot: false, reverse: true, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 3, loopTransportAppliedRevision: 3 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'Native loop transport settings changed concurrently.' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/changed concurrently/);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      trackId: 1, oneShot: true, reverse: true, expectedRevision: 3,
    });
  });

  it('applies Native REVERSE with a revision compare-and-set', async () => {
    const config = { mode: 0, oneShot: true, reverse: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const returned = { ...config, reverse: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 12, loopTransportAppliedRevision: 12 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [returned] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 13, loopTransportRequestedRevision: 13,
          loopTransportAppliedRevision: 13, loopTransportFaultRevision: 0, loopTransportAppliedReverse: true }] }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    const status = await client.setReverse(1, true);

    expect(status.nativeMemory?.loopTransports[0]?.reverse).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      trackId: 1, oneShot: true, reverse: true, expectedRevision: 12,
    });
  });

  it('does not retry a stale Native REVERSE config after concurrent transport changes', async () => {
    const config = { mode: 0, oneShot: false, reverse: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 12, loopTransportAppliedRevision: 12 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'Native loop transport settings changed concurrently.' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.setReverse(1, true)).rejects.toThrow(/changed concurrently/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not derive REVERSE from a transport snapshot that is still being applied', async () => {
    const config = { mode: 0, oneShot: false, reverse: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true,
      nativeMemory: { version: 1, loopTransports: [config] },
      nativeTracks: [{ trackId: 1, loopTransportRequestedRevision: 13, loopTransportAppliedRevision: 12 }] }) } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();

    await expect(client.setReverse(1, true)).rejects.toThrow(/settled loop-transport readback/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not treat a callback-rejected requested 1SHOT value as applied', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const requested = { ...config, oneShot: true };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportAppliedOneShot: false, loopTransportRequestedRevision: 7, loopTransportAppliedRevision: 7 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [requested] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 8, loopTransportRequestedRevision: 8,
          loopTransportAppliedRevision: 7, loopTransportFaultRevision: 8, loopTransportAppliedOneShot: false }] }) } as Response));
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/callback rejected/);
    expect(client.getOneShot(1)).toBe(false);
  });

  it('does not treat a superseded requested 1SHOT value as applied', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const requested = { ...config, oneShot: true };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportAppliedOneShot: false, loopTransportRequestedRevision: 7, loopTransportAppliedRevision: 7 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [requested] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 8, loopTransportRequestedRevision: 9,
          loopTransportAppliedRevision: 9, loopTransportFaultRevision: 0, loopTransportAppliedOneShot: false }] }) } as Response));
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/superseded/);
    expect(client.getOneShot(1)).toBe(false);
  });

  it('keeps the prior applied 1SHOT state visible after an acknowledgement timeout', async () => {
    const config = { mode: 0, oneShot: false, beatOffsetBeats: 0, bpm: 120, crossfadeMs: 5,
      vinylSpeedPercent: 0, motorReturnSeconds: 1, brakePercent: 0, vinylMixPercent: 100 };
    const requested = { ...config, oneShot: true };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [config] },
        nativeTracks: [{ trackId: 1, loopTransportAppliedOneShot: false, loopTransportRequestedRevision: 7, loopTransportAppliedRevision: 7 }] }) } as Response)
      .mockResolvedValueOnce({ json: async () => ({ ok: true, nativeMemory: { version: 1, loopTransports: [requested] },
        nativeTracks: [{ trackId: 1, loopTransportAcceptedRevision: 8, loopTransportRequestedRevision: 8,
          loopTransportAppliedRevision: 7, loopTransportFaultRevision: 0, loopTransportAppliedOneShot: false }] }) } as Response));
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(2001);
    const client = new NativeBridgeClient();

    await expect(client.setOneShot(1, true)).rejects.toThrow(/acknowledgement timed out/);
    expect(client.getOneShot(1)).toBe(false);
    vi.restoreAllMocks();
  });

  it('rejects invalid loop-transport track IDs and config values before making requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new NativeBridgeClient();
    const config: NativeLoopTransportConfig = {
      mode: 'beatShift',
      beatOffsetBeats: 0,
      bpm: 120,
      crossfadeMs: 5,
      vinylSpeedPercent: 0,
      motorReturnSeconds: 1,
      brakePercent: 0,
      vinylMixPercent: 100,
    };

    await expect(client.setLoopTransport(0, config)).rejects.toThrow(/between 1 and 5/);
    await expect(client.setLoopTransport(2, { ...config, bpm: 300.1 })).rejects.toThrow(/loop transport settings/);
    await expect(client.setLoopTransport(2, { ...config, beatOffsetBeats: Number.NaN })).rejects.toThrow(/loop transport settings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces Native bridge loop-transport rejection details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: false, error: 'Track 3 transport command queue is full.' }),
    }) as Response));
    const client = new NativeBridgeClient();
    const config: NativeLoopTransportConfig = {
      mode: 'vinylFlick',
      beatOffsetBeats: 0,
      bpm: 120,
      crossfadeMs: 5,
      vinylSpeedPercent: 20,
      motorReturnSeconds: 1,
      brakePercent: 30,
      vinylMixPercent: 100,
    };

    await expect(client.setLoopTransport(3, config)).rejects.toThrow('Track 3 transport command queue is full.');
  });
});
