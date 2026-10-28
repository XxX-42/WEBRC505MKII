import type { BrowserAutoRecSettings } from './BrowserAutoRecSettings';
import { normalizeBrowserBounceSettings, type BrowserBounceSettings } from './BrowserBounceSettings';
import type { BrowserAudioEngine } from './BrowserAudioEngine';
import type { BrowserRecoverySnapshot, BrowserRecoveryTrack } from './BrowserRecoverySnapshot';
import { Transport } from '../core/Transport';
import { TrackState, TransportState } from '../core/types';
import { decodeProjectArchive } from './projectArchive';
import type { Rc505Json, Rc505MemoryDocument, Rc505MemoryRuntime } from './Rc505Memory';

/** Authored configuration only: PCM lives exclusively in the legacy archive. */
export interface BrowserMemoryConfiguration {
  version: 1;
  /** Missing on older envelopes: disabled with SENS 50. */
  autoRec?: BrowserAutoRecSettings;
  /** Missing on older envelopes: all Bounce switches OFF. */
  bounce?: BrowserBounceSettings;
  tracks: Array<Pick<BrowserRecoveryTrack, 'settings' | 'pitch' | 'isReverse' | 'sourceTransport'>>;
  fx: BrowserRecoverySnapshot['fx'];
  rhythm: BrowserRecoverySnapshot['rhythm'];
  trackFxApply: boolean[];
  outputGain: number;
  mainGain: number;
  trackMixGain: number;
  recordPlay: { recAction: 'REC->PLAY' | 'REC->DUB'; quantize: 'MEASURE' | 'OFF' };
}

const runtimes = new WeakMap<BrowserAudioEngine, Rc505MemoryRuntime>();
const trackSettingKeys = ['measure', 'loopSyncSw', 'tempoSyncSw', 'reverse', 'oneShot', 'pan', 'playLevel',
  'startMode', 'stopMode', 'dubMode', 'fxSw', 'filterEnabled', 'filterValue', 'filterResonance'] as const;

function supportedValues(configuration: BrowserMemoryConfiguration): Record<string, Rc505Json> {
  const values: Record<string, Rc505Json> = {};
  configuration.tracks.forEach((track, index) => {
    for (const key of trackSettingKeys) values[`track.${index + 1}.${key}`] = track.settings[key] as Rc505Json;
  });
  values['record.recAction'] = configuration.recordPlay.recAction;
  values['record.quantize'] = configuration.recordPlay.quantize;
  // Legacy envelopes retain their original supported-field set.
  if (configuration.autoRec) {
    values['record.autoRecSw'] = configuration.autoRec.enabled;
    values['record.autoRecSens'] = configuration.autoRec.sensitivity;
  }
  if (configuration.bounce) {
    values['record.bounceSw'] = configuration.bounce.bounceSw;
    for (let index = 0; index < 5; index += 1) {
      values[`track.${index + 1}.bounceIn`] = configuration.bounce.bounceIn[index]!;
      values[`track.${index + 1}.bounceTrack`] = configuration.bounce.bounceTrack[index]!;
    }
  }
  values['mixer.main'] = Math.round(configuration.mainGain * 100);
  values['mixer.master'] = Math.round(configuration.outputGain * 100);
  return values;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const aEntries = Object.entries(a), bEntries = Object.entries(b);
  return aEntries.length === bEntries.length && aEntries.every(([key, value]) => Object.prototype.hasOwnProperty.call(b, key)
    && sameJson(value, (b as Record<string, unknown>)[key]));
}

function assertSemanticIntegrity(document: Rc505MemoryDocument, state: BrowserMemoryConfiguration): void {
  const expected = supportedValues(state);
  for (const [address, field] of Object.entries(document.semantics.fields)) {
    if (field.availability !== 'supported') continue;
    if (!(address in expected)) throw new Error(`Browser Memory claims an unsupported semantic field: ${address}.`);
    if (!sameJson(field.value, expected[address])) throw new Error(`Browser Memory semantic field disagrees with its authored configuration: ${address}.`);
  }
  for (const [address, value] of Object.entries(expected)) {
    const field = document.semantics.fields[address];
    if (!field || field.availability !== 'supported' || !sameJson(field.value, value)) {
      throw new Error(`Browser Memory lacks its supported authored semantic field: ${address}.`);
    }
  }
}

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
  let epoch = 0n;
  let preservedExtensions: Record<string, Rc505Json> = {};
  let preservedFields: Rc505MemoryDocument['semantics']['fields'] = {};
  const changed = () => { epoch += 1n; };
  for (const track of engine.tracks) {
    observeData(track.track, changed);
    observeMethods(track, ['updateSettings', 'setLiveMonoPitchEnabled', 'setLivePolyPitchEnabled',
      'triggerRecord', 'triggerStop', 'play', 'stop', 'toggleReverse', 'configureLoopTransportFx', 'setLoopTransportFxParameter'], changed);
  }
  observeMethods(engine, ['setFxType', 'setFxParam', 'setFxNamedParameters', 'setFxActive', 'setStepSlicerStep',
    'setStepSlicerControl', 'setTrackFxType', 'setTrackFxParameter', 'setTrackFxNamedParameters', 'setTrackFxActive',
    'setTrackFxApply', 'setLoopTransport', 'clearLoopTransportOverride', 'setOutputDspFx', 'setOutputDspFxEnabled', 'configureOutputDspFx', 'setMixerLevel', 'setRecordPlaySettings', 'setBrowserAutoRecSettings', 'setBrowserBounceSettings'], changed);
  observeMethods(engine.rhythmEngine, ['setPattern', 'setCatalogPattern', 'setKit', 'setVariation', 'setSection',
    'setSwingPercent', 'setQuantizeGrid', 'setSettings', 'setVolume', 'start', 'stop', 'toggle'], changed);
  const revision = () => JSON.stringify([
    epoch.toString(), Transport.getInstance().projectMutationRevision,
    engine.tracks.map((track) => [track.projectRevision, track.state, track.historyBusy]),
    engine.getTrackFxApply().map((gate) => [gate.semanticRevision, gate.requestedRevision, gate.pending]),
    engine.masterGainNode.gain.value, engine.mainGainNode.gain.value, engine.trackMixNode.gain.value,
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
      state.bounce = normalizeBrowserBounceSettings(state.bounce);
      const archive = await engine.exportProjectArchive('Memory');
      assertStable(expected);
      const transport = Transport.getInstance();
      const fields: Rc505MemoryDocument['semantics']['fields'] = structuredClone(preservedFields);
      for (const [address, value] of Object.entries(supportedValues(state))) fields[address] = { availability: 'supported', value };
      return { version: 1, memoryNumber: null, name: '', archive,
        semantics: { tempo: transport.bpm, meter: [...transport.timeSignature], fields },
        extensions: { WEBRC: { ...structuredClone(preservedExtensions), browserMemory: JSON.parse(JSON.stringify(state)) as Rc505Json } } };
    },
    prepare: async (document, expectedRevision) => {
      assertStable(expectedRevision);
      const state = document.extensions.WEBRC.browserMemory as unknown as BrowserMemoryConfiguration;
      if (!state || state.version !== 1 || !Array.isArray(state.tracks) || state.tracks.length !== 5
        || !state.fx || !state.rhythm || !state.recordPlay || !Array.isArray(state.trackFxApply) || state.trackFxApply.length !== 5) {
        throw new Error('Memory lacks a complete supported Browser configuration.');
      }
      assertSemanticIntegrity(document, state);
      state.bounce = normalizeBrowserBounceSettings(state.bounce);
      const project = await decodeProjectArchive(document.archive);
      if (project.bpm !== document.semantics.tempo || project.transport.timeSignatureNumerator !== document.semantics.meter[0]
        || project.transport.timeSignatureDenominator !== document.semantics.meter[1]) throw new Error('Memory tempo/meter disagrees with its PCM archive.');
      const nextExtensions = structuredClone(document.extensions.WEBRC);
      const nextFields = structuredClone(document.semantics.fields);
      assertStable(expectedRevision);
      const prepared = await engine.prepareMemoryConfiguration(state, project, document.archive.byteLength,
        () => assertStable(expectedRevision));
      return { commit: async () => {
        assertStable(expectedRevision); await prepared.commit();
        preservedExtensions = nextExtensions; preservedFields = nextFields;
        changed();
      }, dispose: prepared.dispose };
    },
  };
  runtimes.set(engine, runtime);
  return runtime;
}
