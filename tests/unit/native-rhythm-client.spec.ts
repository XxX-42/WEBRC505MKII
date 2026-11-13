import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeRhythmConfig } from '../../src/audio/NativeBridgeClient';
import { nativeRhythmStatus } from '../helpers/nativeRhythmStatus';

const config: NativeRhythmConfig = {
  enabled: true, bpm: 143, patternIndex: 240, kitIndex: 16, variation: 'D', section: 'fill',
  swingPercent: 75, quantizeGrid: '1/8', volume: 83,
};

describe('Native rhythm bridge client', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

  it('waits for the callback revision while retaining the exact request identity', async () => {
    const host = 'a'.repeat(32);
    const initial = { ...nativeRhythmStatus({ ...config, bpm: 120 }), hostIncarnationId: host,
      nativeRhythm: { ...nativeRhythmStatus({ ...config, bpm: 120 }).nativeRhythm!, tempoRequestReceiptVersion: 1,
        tempoRequestIntentId: '0'.repeat(32), configRequestIntentId: '0'.repeat(32), configRequestedRevision: 5, tempoRequestedRevision: 3, tempoAppliedRevision: 3, tempoAppliedValid: true } };
    let intent = '';
    let reads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/config')) {
        intent = (init!.headers as Record<string, string>)['X-Native-Operation-Id']!;
        return { ok: true, json: async () => ({ ...initial, nativeRhythm: { ...initial.nativeRhythm, ...config,
          tempoRequestIntentId: intent, configRequestIntentId: intent, acceptedTempoRevision: 4, tempoRequestedRevision: 4, tempoAppliedRevision: 3 } }) } as Response;
      }
      reads += 1;
      return { ok: true, json: async () => reads === 1 ? initial : { ...initial, nativeRhythm: { ...initial.nativeRhythm,
        ...config, tempoRequestIntentId: intent, configRequestIntentId: intent, tempoRequestedRevision: 4, tempoAppliedRevision: 4 } } } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const status = await new NativeBridgeClient().setRhythm(config);
    expect(status.nativeRhythm).toMatchObject({ bpm: 143, tempoRequestedRevision: 4, tempoAppliedRevision: 4 });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/config'))).toHaveLength(1);
    expect(sessionStorage.getItem('rc505.native.rhythm-tempo-request')).toBeNull();
  });

  it('finishes a pending BPM when another client changes only volume', async () => {
    const host = 'a'.repeat(32); let originalIntent = '';
    const base = { ...nativeRhythmStatus({ ...config, bpm: 120 }), hostIncarnationId: host };
    const initial = { ...base, nativeRhythm: { ...base.nativeRhythm!, tempoRequestReceiptVersion: 1,
      tempoRequestIntentId: '0'.repeat(32), configRequestIntentId: '0'.repeat(32), configRequestedRevision: 5, tempoRequestedRevision: 8, tempoAppliedRevision: 8, tempoAppliedValid: true } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/config')) {
        originalIntent = (init!.headers as Record<string, string>)['X-Native-Operation-Id']!;
        return { ok: true, json: async () => ({ ...initial, nativeRhythm: { ...initial.nativeRhythm, ...config,
          tempoRequestIntentId: originalIntent, configRequestIntentId: originalIntent, acceptedTempoRevision: 9,
          tempoRequestedRevision: 9, tempoAppliedRevision: 8 } }) } as Response;
      }
      if (!originalIntent) return { ok: true, json: async () => initial } as Response;
      return { ok: true, json: async () => ({ ...initial, nativeRhythm: { ...initial.nativeRhythm, ...config, volume: 20,
        tempoRequestIntentId: originalIntent, configRequestIntentId: 'b'.repeat(32), tempoRequestedRevision: 9, tempoAppliedRevision: 9 } }) } as Response;
    }));
    const status = await new NativeBridgeClient().setRhythm(config);
    expect(status.nativeRhythm).toMatchObject({ bpm: 143, volume: 20, tempoRequestedRevision: 9, tempoAppliedRevision: 9 });
  });

  it('queries the same intent after a lost POST response and never resends', async () => {
    const host = 'a'.repeat(32);
    const base = { ...nativeRhythmStatus({ ...config, bpm: 120 }), hostIncarnationId: host };
    const initial = { ...base, nativeRhythm: { ...base.nativeRhythm!, tempoRequestReceiptVersion: 1,
      tempoRequestIntentId: '0'.repeat(32), configRequestIntentId: '0'.repeat(32), configRequestedRevision: 5,
      tempoRequestedRevision: 3, tempoAppliedRevision: 3, tempoAppliedValid: true } };
    let intent = ''; let reads = 0; let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/config')) { posts += 1; intent = (init!.headers as Record<string, string>)['X-Native-Operation-Id']!; throw new Error('response lost'); }
      reads += 1;
      if (reads === 1) return { ok: true, json: async () => initial } as Response;
      if (reads === 2) throw new Error('disconnected');
      return { ok: true, json: async () => ({ ...initial, nativeRhythm: { ...initial.nativeRhythm, ...config,
        tempoRequestIntentId: intent, configRequestIntentId: 'b'.repeat(32), configRequestedRevision: 7,
        tempoRequestedRevision: 4, tempoAppliedRevision: 4 } }) } as Response;
    }));
    const client = new NativeBridgeClient();
    await expect(client.setRhythm(config)).rejects.toThrow();
    expect(sessionStorage.getItem('rc505.native.rhythm-tempo-request')).not.toBeNull();
    await expect(client.reconcilePendingRhythmTempo(config.bpm, host)).resolves.toMatchObject({ nativeRhythm: { bpm: 143, tempoAppliedRevision: 4 } });
    expect(posts).toBe(1);
  });

  it('rejects a later same-BPM revision when the import bound an earlier exact ACK', async () => {
    const host = 'a'.repeat(32); const intent = 'b'.repeat(32);
    const newer = { ...nativeRhythmStatus(config), hostIncarnationId: host,
      nativeRhythm: { ...nativeRhythmStatus(config).nativeRhythm!, tempoRequestReceiptVersion: 1,
        tempoRequestIntentId: 'c'.repeat(32), tempoRequestedRevision: 6, tempoAppliedRevision: 6, tempoAppliedValid: true } };
    await expect(new NativeBridgeClient().waitForRhythmTempoBarrier(143, host, newer,
      { host, revision: 4, intent, bpm: 143 })).rejects.toThrow(/superseded after the exact/);
  });

  it('merges a volume patch onto the fresh other-client kit before its CAS', async () => {
    const host = 'a'.repeat(32);
    const fresh = { ...nativeRhythmStatus({ ...config, kitIndex: 3, bpm: 120 }), hostIncarnationId: host };
    const initial = { ...fresh, nativeRhythm: { ...fresh.nativeRhythm!, tempoRequestReceiptVersion: 1,
      tempoRequestIntentId: '0'.repeat(32), configRequestIntentId: 'c'.repeat(32), configRequestedRevision: 9,
      tempoRequestedRevision: 3, tempoAppliedRevision: 3, tempoAppliedValid: true } };
    let sent: NativeRhythmConfig | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/config')) {
        sent = JSON.parse(init!.body as string) as NativeRhythmConfig;
        const intent = (init!.headers as Record<string, string>)['X-Native-Operation-Id'];
        expect((init!.headers as Record<string, string>)['X-Native-Rhythm-Revision']).toBe('9');
        return { ok: true, json: async () => ({ ...initial, nativeRhythm: { ...initial.nativeRhythm, ...sent,
          configRequestIntentId: intent, acceptedTempoRevision: 3, configRequestedRevision: 10 } }) } as Response;
      }
      return { ok: true, json: async () => initial } as Response;
    }));
    await new NativeBridgeClient().setRhythm({ ...config, bpm: 120, kitIndex: 1, volume: 20 }, undefined, undefined, { volume: 20 });
    expect(sent).toMatchObject({ kitIndex: 3, volume: 20, bpm: 120 });
  });

  it('only reads an existing same-BPM pending callback barrier', async () => {
    const host = 'a'.repeat(32); const intent = 'b'.repeat(32);
    const base = { ...nativeRhythmStatus(config), hostIncarnationId: host };
    const pending = { ...base, nativeRhythm: { ...base.nativeRhythm!, tempoRequestReceiptVersion: 1,
      tempoRequestIntentId: intent, tempoRequestedRevision: 4, tempoAppliedRevision: 3, tempoAppliedValid: true } };
    const applied = { ...pending, nativeRhythm: { ...pending.nativeRhythm, tempoAppliedRevision: 4 } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => applied }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().waitForRhythmTempoBarrier(143, host, pending)).resolves.toMatchObject({ nativeRhythm: { tempoAppliedRevision: 4 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/status');
  });

  it.each(['superseded', 'restarted'] as const)('fails closed if a pending receipt is %s', async (mode) => {
    const host = 'a'.repeat(32); const intent = 'b'.repeat(32);
    sessionStorage.setItem('rc505.native.rhythm-tempo-request', JSON.stringify({ host, intent, baseline: 3,
      baselineConfig: 5, baselineBpm: 120, baselineTempoIntent: '0'.repeat(32), owner: null, config }));
    const status = { ...nativeRhythmStatus(config), hostIncarnationId: mode === 'restarted' ? 'c'.repeat(32) : host,
      nativeRhythm: { ...nativeRhythmStatus(config).nativeRhythm!, tempoRequestReceiptVersion: 1,
        tempoRequestIntentId: mode === 'superseded' ? 'd'.repeat(32) : intent,
        configRequestedRevision: 6, tempoRequestedRevision: 4, tempoAppliedRevision: 4, tempoAppliedValid: true } };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => status }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().reconcilePendingRhythmTempo(config.bpm, host)).rejects.toThrow(/superseded or its host changed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('rc505.native.rhythm-tempo-request')).not.toBeNull();
  });

  it.each([
    { patternIndex: 0 }, { patternIndex: 241 }, { patternIndex: 1.5 }, { kitIndex: 0 }, { kitIndex: 17 },
    { bpm: 39 }, { bpm: 301 }, { bpm: NaN }, { variation: 'E' }, { section: 'verse' },
    { swingPercent: 49 }, { swingPercent: 76 }, { swingPercent: 60.5 }, { quantizeGrid: '1/32' },
    { volume: -1 }, { volume: 101 }, { volume: 50.5 }, { volume: Infinity }, { enabled: 1 },
  ])('rejects invalid config before fetching: %j', async (patch) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new NativeBridgeClient().setRhythm({ ...config, ...patch } as NativeRhythmConfig)).rejects.toThrow('Native rhythm settings');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses old hosts before sending a rhythm write', async () => {
    const status = nativeRhythmStatus(config);
    delete status.hostIncarnationId;
    delete status.nativeRhythm!.tempoRequestReceiptVersion;
    delete status.nativeRhythm!.tempoRequestIntentId;
    delete status.nativeRhythm!.configRequestIntentId;
    delete status.nativeRhythm!.configRequestedRevision;
    delete status.nativeRhythm!.tempoRequestedRevision;
    delete status.nativeRhythm!.tempoAppliedRevision;
    delete status.nativeRhythm!.tempoAppliedValid;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status }) as Response));
    await expect(new NativeBridgeClient().setRhythm(config)).rejects.toThrow(/settled host revision/);
  });
});
