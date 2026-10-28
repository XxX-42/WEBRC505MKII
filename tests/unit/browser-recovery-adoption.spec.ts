import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAudioEngine } from '../../src/audio/BrowserAudioEngine';

async function loadBrowserFacade() {
  vi.resetModules();
  localStorage.clear();
  window.history.replaceState({}, '', '/?audio=browser');
  const module = await import('../../src/audio/AudioEngine');
  return module.AudioEngine.getInstance();
}

function makeEngine(contextState: AudioContextState, label: string) {
  const statusListeners = new Set<(status: any) => void>();
  const monitoringListeners = new Set<(enabled: boolean) => void>();
  const latencyListeners = new Set<(info: any) => void>();
  const status = { mode: 'browser', ready: false, engineRunning: false, bridgeAvailable: true, message: label, lastError: '' };
  const latency = { sampleRate: 44_100, baseLatencyMs: 2, outputLatencyMs: 3, estimatedMonitoringLatencyMs: 5, roundTripLatencyMs: null };
  let adoptionState: 'new' | 'prepared' | 'claimed' | 'adopted' = 'new';
  let bpmSubscribed = contextState === 'closed';
  let throwOnMidiUnsubscribe = false;
  let midiState = 'disconnected';
  const midiListeners = new Set<(state: string) => void>();
  const engine = {
    context: { state: contextState, sampleRate: 44_100 },
    monitoringEnabled: false,
    isRecoverySnapshotCurrent: vi.fn(() => true),
    assertRetirableAfterRecoveryAdoption: vi.fn(),
    retireAfterRecoveryAdoption: vi.fn(),
    prepareRecoveryAdoption: vi.fn(() => { adoptionState = 'prepared'; }),
    claimRecoveryAdoption: vi.fn(() => {
      if (adoptionState !== 'prepared') return false;
      adoptionState = 'claimed';
      return true;
    }),
    releaseRecoveryAdoptionClaim: vi.fn(() => {
      if (adoptionState === 'claimed') adoptionState = 'prepared';
    }),
    completeRecoveryAdoption: vi.fn(() => {
      if (adoptionState !== 'claimed') return false;
      adoptionState = 'adopted';
      return true;
    }),
    getRecoveryAdoptionState: () => adoptionState,
    hasTransportBpmChangeSubscription: () => bpmSubscribed,
    attachTransportBpmChangeSubscription: vi.fn(() => { bpmSubscribed = true; }),
    detachTransportBpmChangeSubscription: vi.fn(() => { bpmSubscribed = false; }),
    getUiStatus: vi.fn(() => status),
    getLatencyInfo: vi.fn(() => latency),
    onStatusChange: vi.fn((listener: (value: any) => void) => {
      statusListeners.add(listener); listener(status); return () => statusListeners.delete(listener);
    }),
    onMonitoringChange: vi.fn((listener: (value: boolean) => void) => {
      monitoringListeners.add(listener); listener(false); return () => monitoringListeners.delete(listener);
    }),
    onLatencyInfoChange: vi.fn((listener: (value: any) => void) => {
      latencyListeners.add(listener); listener(latency); return () => latencyListeners.delete(listener);
    }),
    onMidiInputStateChange: vi.fn((listener: (value: string) => void) => {
      midiListeners.add(listener);
      listener('disconnected');
      return () => {
        midiListeners.delete(listener);
        if (throwOnMidiUnsubscribe) throw new Error('injected MIDI unsubscribe failure');
      };
    }),
    setThrowOnMidiUnsubscribe(value: boolean) { throwOnMidiUnsubscribe = value; },
    getMidiInputState: () => midiState,
    emitMidiState(value: string) {
      midiState = value;
      for (const listener of [...midiListeners]) listener(value);
    },
    emitStatus(value: any) { for (const listener of [...statusListeners]) listener(value); },
    status,
  };
  return engine;
}

const snapshot = { schemaVersion: 4 } as any;

describe('Browser recovery facade adoption', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each([0, 0.37])('preserves pending authored gain %s through repeated adoption until explicit resume', async (gain) => {
    const facade = await loadBrowserFacade();
    const oldEngine = makeEngine('closed', 'original');
    const first = makeEngine('suspended', 'first replacement');
    const second = makeEngine('suspended', 'second replacement');
    const authoredSnapshot = { ...snapshot, outputGainValue: gain };
    const mutedSnapshot = { ...snapshot, outputGainValue: 0 };
    (facade as any).browserEngine = oldEngine;
    facade.adoptRecoveredBrowserEngine(oldEngine as any, authoredSnapshot, first as any, authoredSnapshot);
    first.context.state = 'closed';
    facade.adoptRecoveredBrowserEngine(first as any, mutedSnapshot, second as any, mutedSnapshot);
    expect(facade.getOutputLevel()).toBe(gain * 100);
    expect((facade as any).recoveredBrowserOutputGain).toBe(gain);
    const output = { value: 0, setValueAtTime: vi.fn((value: number) => { output.value = value; }) };
    Object.assign(second, {
      masterGainNode: { gain: output },
      initializeRecoveredOutputFromUserActivation: vi.fn(async () => { second.context.state = 'running'; }),
    });
    expect(output.value).toBe(0);
    await facade.resumeRecoveredBrowserOutputFromUserActivation();
    expect(output.value).toBe(gain);
    expect((facade as any).recoveredBrowserOutputGain).toBeNull();
    // Once consumed, a later recovery uses its new source setting, not stale gain.
    second.context.state = 'closed';
    const third = makeEngine('suspended', 'third replacement');
    const laterSnapshot = { ...snapshot, outputGainValue: 0.61 };
    facade.adoptRecoveredBrowserEngine(second as any, laterSnapshot, third as any, laterSnapshot);
    expect(facade.getOutputLevel()).toBe(61);
  });

  it('stages listeners, switches them at publication, and leaves old data owner alive', async () => {
    const facade = await loadBrowserFacade();
    const oldEngine = makeEngine('closed', 'old closed engine');
    const candidate = makeEngine('suspended', 'recovered candidate');
    (facade as any).browserEngine = oldEngine;

    const statuses: string[] = [];
    const unsubscribe = facade.onStatusChange((status: any) => statuses.push(status.message));
    const midiStates: string[] = [];
    const unsubscribeMidi = facade.onMidiInputStateChange((state: string) => midiStates.push(state));
    const initialMidiNotifications = midiStates.length;
    expect(statuses).toEqual(['old closed engine']);

    const returnedOld = facade.adoptRecoveredBrowserEngine(oldEngine as any, snapshot, candidate as any, snapshot);
    expect(returnedOld).toBe(oldEngine);
    expect((facade as any).browserEngine).toBe(candidate);
    expect(candidate.prepareRecoveryAdoption).toHaveBeenCalledWith(snapshot);
    expect(candidate.claimRecoveryAdoption).toHaveBeenCalledWith(snapshot);
    expect(candidate.completeRecoveryAdoption).toHaveBeenCalledOnce();
    expect(candidate.getRecoveryAdoptionState()).toBe('adopted');
    expect(candidate.attachTransportBpmChangeSubscription).toHaveBeenCalledOnce();
    expect(oldEngine.detachTransportBpmChangeSubscription).toHaveBeenCalledOnce();
    expect(oldEngine.retireAfterRecoveryAdoption).toHaveBeenCalledOnce();
    expect(statuses).toEqual(['old closed engine', 'recovered candidate']);

    oldEngine.emitStatus({ ...oldEngine.status, message: 'late old event' });
    oldEngine.emitMidiState('connected');
    candidate.emitStatus({ ...candidate.status, message: 'candidate running state update' });
    candidate.emitMidiState('connected');
    expect(statuses).toEqual(['old closed engine', 'recovered candidate', 'candidate running state update']);
    expect(midiStates.slice(0, initialMidiNotifications).every((state) => state === 'disconnected')).toBe(true);
    expect(midiStates.slice(initialMidiNotifications)).toEqual(['disconnected', 'connected']);
    unsubscribe();
    unsubscribeMidi();
  });

  it('releases the candidate claim when staged subscriptions fail before publication', async () => {
    const facade = await loadBrowserFacade();
    const oldEngine = makeEngine('closed', 'old remains active');
    const candidate = makeEngine('suspended', 'must not publish');
    candidate.attachTransportBpmChangeSubscription.mockImplementation(() => { throw new Error('injected BPM listener failure'); });
    (facade as any).browserEngine = oldEngine;
    const unsubscribe = facade.onStatusChange(() => undefined);

    expect(() => facade.adoptRecoveredBrowserEngine(oldEngine as any, snapshot, candidate as any, snapshot))
      .toThrow('injected BPM listener failure');
    expect((facade as any).browserEngine).toBe(oldEngine);
    expect(candidate.getRecoveryAdoptionState()).toBe('prepared');
    expect(candidate.detachTransportBpmChangeSubscription).toHaveBeenCalledOnce();
    expect(oldEngine.detachTransportBpmChangeSubscription).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps a committed candidate active when old cleanup or user notification throws', async () => {
    const facade = await loadBrowserFacade();
    const oldEngine = makeEngine('closed', 'old closed engine');
    const candidate = makeEngine('suspended', 'recovered candidate');
    oldEngine.retireAfterRecoveryAdoption.mockImplementation(() => { throw new Error('injected retire failure'); });
    (facade as any).browserEngine = oldEngine;
    let shouldThrow = false;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unsubscribeStatus = facade.onStatusChange(() => {
      if (shouldThrow) throw new Error('injected UI listener failure');
    });
    const unsubscribeMidi = facade.onMidiInputStateChange(() => {
      if (shouldThrow) throw new Error('injected MIDI listener failure');
    });
    oldEngine.setThrowOnMidiUnsubscribe(true);
    shouldThrow = true;

    let retired: unknown;
    expect(() => { retired = facade.adoptRecoveredBrowserEngine(oldEngine as any, snapshot, candidate as any, snapshot); }).not.toThrow();
    expect(retired).toBe(oldEngine);
    expect((facade as any).browserEngine).toBe(candidate);
    expect(candidate.getRecoveryAdoptionState()).toBe('adopted');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    unsubscribeStatus();
    unsubscribeMidi();
  });

  it('does not retain a listener when BrowserAudioEngine subscription callbacks throw', () => {
    const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
    const midiListeners = new Set<(state: string) => void>();
    const monitoringListeners = new Set<(enabled: boolean) => void>();
    const latencyListeners = new Set<(info: any) => void>();
    const statusListeners = new Set<(status: any) => void>();
    (engine as any).midiInputListeners = midiListeners;
    (engine as any).monitoringListeners = monitoringListeners;
    (engine as any).latencyListeners = latencyListeners;
    (engine as any).statusListeners = statusListeners;
    (engine as any).midiInputState = 'disconnected';
    (engine as any).monitoringEnabled = false;
    (engine as any).getLatencyInfo = () => ({ sampleRate: 44_100 });
    (engine as any).getUiStatus = () => ({ mode: 'browser', ready: false });
    const fail = () => { throw new Error('listener rejected initial snapshot'); };

    expect(() => engine.onMidiInputStateChange(fail as any)).toThrow('listener rejected initial snapshot');
    expect(() => engine.onMonitoringChange(fail as any)).toThrow('listener rejected initial snapshot');
    expect(() => engine.onLatencyInfoChange(fail as any)).toThrow('listener rejected initial snapshot');
    expect(() => engine.onStatusChange(fail as any)).toThrow('listener rejected initial snapshot');
    expect(midiListeners.size).toBe(0);
    expect(monitoringListeners.size).toBe(0);
    expect(latencyListeners.size).toBe(0);
    expect(statusListeners.size).toBe(0);
  });

  it('enforces one-shot prepare, claim, complete, and rollback transitions on real engine methods', () => {
    const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
    (engine as any).recoveryAdoptionState = 'prepared';
    (engine as any).preparedRecoverySnapshot = snapshot;
    expect(engine.claimRecoveryAdoption(snapshot)).toBe(true);
    expect(engine.claimRecoveryAdoption(snapshot)).toBe(false);
    expect(engine.completeRecoveryAdoption()).toBe(true);
    expect(engine.getRecoveryAdoptionState()).toBe('adopted');
    expect(engine.completeRecoveryAdoption()).toBe(false);
    expect(engine.claimRecoveryAdoption(snapshot)).toBe(false);
    expect(() => engine.prepareRecoveryAdoption(snapshot)).toThrow('already been claimed or adopted');
  });

  it('keeps the old engine and subscriptions when source freshness validation fails', async () => {
    const facade = await loadBrowserFacade();
    const oldEngine = makeEngine('closed', 'old remains active');
    const candidate = makeEngine('suspended', 'must not publish');
    oldEngine.isRecoverySnapshotCurrent.mockReturnValue(false);
    (facade as any).browserEngine = oldEngine;
    const statuses: string[] = [];
    const unsubscribe = facade.onStatusChange((status: any) => statuses.push(status.message));

    expect(() => facade.adoptRecoveredBrowserEngine(oldEngine as any, snapshot, candidate as any, snapshot))
      .toThrow('changed during preparation');
    expect((facade as any).browserEngine).toBe(oldEngine);
    expect(candidate.prepareRecoveryAdoption).not.toHaveBeenCalled();
    expect(candidate.attachTransportBpmChangeSubscription).not.toHaveBeenCalled();
    oldEngine.emitStatus({ ...oldEngine.status, message: 'old still receives updates' });
    expect(statuses).toEqual(['old remains active', 'old still receives updates']);
    unsubscribe();
  });

  it('rolls back staged candidate listeners if subscription setup throws', async () => {
    const facade = await loadBrowserFacade();
    const oldEngine = makeEngine('closed', 'old remains active');
    const candidate = makeEngine('suspended', 'must not publish');
    candidate.onLatencyInfoChange.mockImplementation(() => { throw new Error('injected listener setup failure'); });
    (facade as any).browserEngine = oldEngine;
    const statuses: string[] = [];
    const unsubscribeStatus = facade.onStatusChange((status: any) => statuses.push(status.message));
    const unsubscribeLatency = facade.onLatencyInfoChange(() => undefined);

    expect(() => facade.adoptRecoveredBrowserEngine(oldEngine as any, snapshot, candidate as any, snapshot))
      .toThrow('injected listener setup failure');
    expect((facade as any).browserEngine).toBe(oldEngine);
    expect(oldEngine.detachTransportBpmChangeSubscription).not.toHaveBeenCalled();
    oldEngine.emitStatus({ ...oldEngine.status, message: 'old still receives updates' });
    expect(statuses).toEqual(['old remains active', 'old still receives updates']);
    unsubscribeStatus();
    unsubscribeLatency();
  });

  it('rejects a stale recovery snapshot when PCM/history identity or authored state changed', () => {
    const currentBuffer = {} as AudioBuffer;
    const historyBuffer = {} as AudioBuffer;
    const makeSnapshot = (buffer = currentBuffer, bpm = 120, revision = 3) => ({
      schemaVersion: 4,
      source: { contextState: 'closed', sampleRate: 44_100, inputDevicePreference: null, outputDevicePreference: null, lastObservedRenderBlockFrames: 128 },
      transport: { bpm, timeSignature: [4, 4], state: 'STOPPED', masterTrackId: null, masterLoopLengthSamples: 0, measureLength: 0, projectMutationRevision: 7 },
      rhythm: { patternIndex: 106, kitIndex: 1, variation: 'A', section: 'main', swingPercent: 50, quantizeGrid: '1/16', volumePercent: 50, wasRunning: false, error: '' },
      tracks: [{
        trackId: 1, state: 'STOPPED', wasPlaying: false, projectPcmRevision: revision, buffer, bufferBytes: 4, isReverse: false,
        settings: { pan: 'CENTER' }, pitch: { mode: 'off' }, sourceTransport: [null],
        history: { buffer: historyBuffer, direction: 'undo', isReverse: false, master: null, retainedBytes: 4, unavailableReason: null },
      }],
      fx: {}, midi: {}, monitoringWasEnabled: false, outputGainValue: 1, mainGainValue: 0.75, trackMixGainValue: 1,
      pcmHistoryBudget: { retainedBytes: 4, limitBytes: 512 }, recoveryPolicy: { playback: 'start-stopped' },
    });
    const snapshot = makeSnapshot() as any;
    const engine = Object.create(BrowserAudioEngine.prototype) as BrowserAudioEngine;
    (engine as any).context = { state: 'closed' };
    (engine as any).getRecoverySnapshot = vi.fn(() => makeSnapshot() as any);
    expect(engine.isRecoverySnapshotCurrent(snapshot)).toBe(true);
    (engine as any).getRecoverySnapshot = vi.fn(() => makeSnapshot({} as AudioBuffer) as any);
    expect(engine.isRecoverySnapshotCurrent(snapshot)).toBe(false);
    // In-place overdub/rollback writes preserve AudioBuffer identity but advance
    // the project PCM revision; recovery must reject that stale clone too.
    (engine as any).getRecoverySnapshot = vi.fn(() => makeSnapshot(currentBuffer, 120, 4) as any);
    expect(engine.isRecoverySnapshotCurrent(snapshot)).toBe(false);
    (engine as any).getRecoverySnapshot = vi.fn(() => makeSnapshot(currentBuffer, 121) as any);
    expect(engine.isRecoverySnapshotCurrent(snapshot)).toBe(false);
  });
});
