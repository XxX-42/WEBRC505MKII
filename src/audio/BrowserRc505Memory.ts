import type { BrowserAudioEngine } from './BrowserAudioEngine';
import type { BrowserRecoverySnapshot, BrowserRecoveryTrack } from './BrowserRecoverySnapshot';
import { Transport } from '../core/Transport';
import { TrackState, TransportState } from '../core/types';
import { decodeProjectArchive } from './projectArchive';
import type { Rc505Json, Rc505MemoryDocument, Rc505MemoryRuntime } from './Rc505Memory';

/** Authored configuration only: PCM lives exclusively in the legacy archive. */
export interface BrowserMemoryConfiguration {
  version: 1;
  tracks: Array<Pick<BrowserRecoveryTrack, 'settings' | 'pitch' | 'isReverse'>>;
  fx: BrowserRecoverySnapshot['fx'];
  rhythm: BrowserRecoverySnapshot['rhythm'];
  trackFxApply: boolean[];
  outputGain: number;
  trackMixGain: number;
}

const runtimes = new WeakMap<BrowserAudioEngine, Rc505MemoryRuntime>();

/** Observe writes on the existing Track identity, including edit-and-revert. */
function observeData(object: object, changed: () => void): void {
  for (const key of Object.keys(object)) {
    if (key === 'id') continue;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.configurable || !('value' in descriptor) || !descriptor.writable) continue;
    let value = descriptor.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) observeData(value, changed);
    Object.defineProperty(object, key, {
      configurable: true, enumerable: descriptor.enumerable,
      get: () => value,
      set: (next) => {
        if (Object.is(next, value)) return;
        value = next;
        if (value && typeof value === 'object' && !Array.isArray(value)) observeData(value, changed);
        changed();
      },
    });
  }
}

function observeMethods(object: object, names: string[], changed: () => void): void {
  const target = object as Record<string, unknown>;
  for (const name of names) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(object, name, { configurable: true, writable: true, value: function (this: unknown, ...args: unknown[]) {
      if (this === object) changed();
      return original.apply(this, args);
    } });
  }
}

export function createBrowserRc505MemoryRuntime(engine: BrowserAudioEngine): Rc505MemoryRuntime {
  const existing = runtimes.get(engine);
  if (existing) return existing;
  let epoch = 0;
  const changed = () => { if (++epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Browser Memory edit epoch exhausted.'); };
  for (const track of engine.tracks) {
    observeData(track.track, changed);
    observeMethods(track, ['updateSettings', 'setLiveMonoPitchEnabled', 'setLivePolyPitchEnabled',
      'triggerRecord', 'triggerStop', 'play', 'stop', 'toggleReverse', 'configureLoopTransportFx', 'setLoopTransportFxParameter'], changed);
  }
  observeMethods(engine, ['setFxType', 'setFxParam', 'setFxNamedParameters', 'setFxActive', 'setStepSlicerStep',
    'setStepSlicerControl', 'setTrackFxType', 'setTrackFxParameter', 'setTrackFxNamedParameters', 'setTrackFxActive',
    'setTrackFxApply', 'setLoopTransport', 'setOutputDspFx', 'setOutputDspFxEnabled', 'configureOutputDspFx'], changed);
  observeMethods(engine.rhythmEngine, ['setPattern', 'setCatalogPattern', 'setKit', 'setVariation', 'setSection',
    'setSwingPercent', 'setQuantizeGrid', 'setSettings', 'setVolume', 'start', 'stop', 'toggle'], changed);
  const revision = () => JSON.stringify([
    epoch, Transport.getInstance().projectMutationRevision,
    engine.tracks.map((track) => [track.projectRevision, track.state, track.historyBusy]),
    engine.getTrackFxApply().map((gate) => [gate.semanticRevision, gate.requestedRevision, gate.pending]),
    engine.masterGainNode.gain.value, engine.trackMixNode.gain.value,
  ]);
  const canSwitch = () => {
    const allowed = engine.context.state !== 'closed' && engine.tracks.length === 5
      && Transport.getInstance().state === TransportState.STOPPED && !engine.rhythmEngine.isRunning
      && engine.tracks.every((track) => !track.historyBusy && [TrackState.EMPTY, TrackState.STOPPED].includes(track.state as typeof TrackState.EMPTY))
      && engine.getTrackFxApply().every((gate) => !gate.pending && !gate.controlFaulted)
      && engine.getTrackFxStatus().every((bank) => bank.slots.every((slot) => !slot.pendingApply && slot.state !== 'loading' && slot.state !== 'error'))
      && [...engine.getSharedFxSnapshot('input'), ...engine.getSharedFxSnapshot('track')].every((slot) => slot.state !== 'loading' && slot.state !== 'error');
    return { allowed, reason: allowed ? '' : 'Stop all five tracks and Rhythm, and finish PCM/FX/gate operations before switching Memory.' };
  };
  const assertStable = (expected: string) => {
    const state = canSwitch();
    if (!state.allowed) throw new Error(state.reason);
    if (revision() !== expected) throw new Error('Browser Memory changed during preparation; incumbent audio is unchanged.');
  };
  const runtime: Rc505MemoryRuntime = {
    revision, canSwitch,
    capture: async () => {
      const expected = revision(); assertStable(expected);
      const state = engine.captureMemoryConfiguration();
      const archive = await engine.exportProjectArchive('Memory');
      assertStable(expected);
      const transport = Transport.getInstance();
      const fields: Rc505MemoryDocument['semantics']['fields'] = {};
      state.tracks.forEach((track, index) => {
        for (const [key, value] of Object.entries(track.settings)) {
          fields[`track.${index + 1}.${key}`] = { availability: 'supported', value: value as Rc505Json };
        }
      });
      return { version: 1, memoryNumber: null, name: '', archive,
        semantics: { tempo: transport.bpm, meter: [...transport.timeSignature], fields },
        extensions: { WEBRC: { browserMemory: JSON.parse(JSON.stringify(state)) as Rc505Json } } };
    },
    prepare: async (document, expectedRevision) => {
      assertStable(expectedRevision);
      const state = document.extensions.WEBRC.browserMemory as unknown as BrowserMemoryConfiguration;
      if (!state || state.version !== 1 || !Array.isArray(state.tracks) || state.tracks.length !== 5
        || !state.fx || !state.rhythm || !Array.isArray(state.trackFxApply) || state.trackFxApply.length !== 5) {
        throw new Error('Memory lacks a complete supported Browser configuration.');
      }
      const project = await decodeProjectArchive(document.archive);
      assertStable(expectedRevision);
      const prepared = await engine.prepareMemoryConfiguration(state, project, document.archive.byteLength,
        () => assertStable(expectedRevision));
      return { commit: async () => { assertStable(expectedRevision); await prepared.commit(); changed(); }, dispose: prepared.dispose };
    },
  };
  runtimes.set(engine, runtime);
  return runtime;
}
