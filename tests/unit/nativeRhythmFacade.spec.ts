import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeBridgeClient, type NativeRhythmMutationResponse, type NativeRhythmStatus } from '../../src/audio/NativeBridgeClient';
import { NativeRhythmFacade } from '../../src/audio/NativeRhythmFacade';

function rhythmStatus(prepared = true): NativeRhythmStatus {
  return {
    prepared,
    playing: false,
    patternIndex: 0,
    kitIndex: 0,
    selectedPatternIndex: 0,
    selectedKitIndex: 0,
    variation: 0,
    section: 'stopped',
    tempoPolicy: 'shared-next-bar',
    loopTempoPolicy: 'sample-locked-no-tempo-resampling',
    requestedBpm: 120,
    effectiveBpm: 120,
    tempoPending: false,
    requestedVolume: 0.7,
    effectiveVolume: 0.7,
    volumePending: false,
    barIndex: 0,
    absoluteFrame: 0,
    lastTriggeredFrame: 0,
    triggerCount: 0,
    activeVoices: 0,
    rejectedCommands: 0,
    lateCommands: 0,
    faultCount: 0,
    lastFaultFrame: 0,
  };
}

function acceptedMutation(status = rhythmStatus()): NativeRhythmMutationResponse {
  return {
    ok: true,
    accepted: true,
    acceptedFrame: 64,
    effectiveBpm: status.effectiveBpm,
    tempoPending: status.tempoPending,
    rhythm: status,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Native rhythm facade', () => {
  it('does not start a mutation request until a prepared status is known', async () => {
    const bridge = {
      getRhythmStatus: vi.fn(async () => rhythmStatus(false)),
      startRhythm: vi.fn(async () => acceptedMutation()),
    } as unknown as NativeBridgeClient;
    const facade = new NativeRhythmFacade(bridge);

    expect(await facade.refresh()).toMatchObject({ prepared: false });
    await expect(facade.start()).rejects.toThrow('NOT PREPARED');
    expect(bridge.startRhythm).not.toHaveBeenCalled();
  });

  it('publishes only the server-reported status after an accepted command', async () => {
    const started = { ...rhythmStatus(), playing: true, section: 'intro' as const };
    const bridge = {
      getRhythmStatus: vi.fn(async () => rhythmStatus()),
      startRhythm: vi.fn(async () => acceptedMutation(started)),
    } as unknown as NativeBridgeClient;
    const facade = new NativeRhythmFacade(bridge);
    const notifications: Array<boolean | null> = [];
    facade.subscribe((status) => notifications.push(status?.playing ?? null));
    await facade.refresh();
    const response = await facade.start();

    expect(response.acceptedFrame).toBe(64);
    expect(facade.status?.playing).toBe(true);
    expect(notifications).toEqual([null, false, true]);
  });

  it('marks a failed status refresh unavailable and exposes the route error', async () => {
    const bridge = {
      getRhythmStatus: vi.fn(async () => { throw new Error('Native rhythm route is missing.'); }),
    } as unknown as NativeBridgeClient;
    const facade = new NativeRhythmFacade(bridge);

    expect(await facade.refresh()).toBeNull();
    expect(facade.isAvailable).toBe(false);
    expect(facade.unavailableReason).toBe('Native rhythm route is missing.');
  });

  it('uses the versioned status and command routes with exact bounded payloads', async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const payload = path.endsWith('/status')
        ? { ok: true, rhythm: rhythmStatus() }
        : { ...acceptedMutation(), requestedVolume: 0.25, effectiveVolume: 0.7, volumePending: true };
      return { json: async () => payload } as Response;
    }));
    const bridge = new NativeBridgeClient('http://native.test');

    expect((await bridge.getRhythmStatus()).prepared).toBe(true);
    await bridge.selectRhythmPatternKit(239, 15);
    await bridge.setRhythmVolume(0.25);
    expect(requests).toEqual([
      { path: '/v2/rhythm/status', body: undefined },
      { path: '/v2/rhythm/pattern-kit', body: { patternIndex: 239, kitIndex: 15 } },
      { path: '/v2/rhythm/volume', body: { volume: 0.25 } },
    ]);
  });
});
