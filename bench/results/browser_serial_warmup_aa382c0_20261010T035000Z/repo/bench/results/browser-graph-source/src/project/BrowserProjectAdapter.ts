import { Transport } from '../core/Transport';
import type { BrowserAudioEngine } from '../audio/BrowserAudioEngine';
import type { TrackAudio } from '../audio/TrackAudio';
import { defaultFXRegistry } from '../audio/fx/FXRegistry';
import {
  BROWSER_REALTIME_INITIAL_TRACK_FRAMES,
  BROWSER_REALTIME_MAX_TRACK_FRAMES,
  BROWSER_REALTIME_MAX_STORAGE_BYTES,
  BROWSER_REALTIME_STORAGE_BATCH_BLOCKS,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  TRACK_META_BYTES,
} from '../audio/browserRealtimeProtocol';
import type { RhythmRuntimeSnapshot } from '../audio/rhythmTypes';
import { parseRhythmRuntimeSnapshot } from '../controls/rhythmDocuments';
import { createDefaultProjectDocument } from './projectValidation';
import type {
  ProjectDocument,
  ProjectEngineAdapter,
  ProjectEngineCapture,
  ProjectFxBank,
  ProjectFxUnit,
  ProjectAudioAssetPlan,
  ProjectOfflineFxGraph,
  ProjectTrackSettings,
  JsonValue,
} from './projectTypes';

function parsePan(value: string): number {
  if (value === 'CENTER') return 0;
  if (value.startsWith('L')) return -Number(value.slice(1));
  if (value.startsWith('R')) return Number(value.slice(1));
  return 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneBankState(banks: ProjectFxBank[]): ProjectFxBank[] {
  return clone(banks);
}

/** Browser-only boundary from engine state to durable project data. */
export class BrowserProjectAdapter implements ProjectEngineAdapter {
  private readonly engine: BrowserAudioEngine;
  private currentProject: ProjectDocument;
  private projectLockToken: symbol | null = null;

  constructor(engine: BrowserAudioEngine) {
    this.engine = engine;
    this.currentProject = createDefaultProjectDocument();
  }

  async withProjectLock<T>(action: () => Promise<T>): Promise<T> {
    const runtime = this.requireRuntime();
    if (this.projectLockToken) throw new Error('A project operation is already holding the realtime lock.');
    const token = runtime.beginProjectLock();
    this.projectLockToken = token;
    try {
      return await action();
    } finally {
      this.projectLockToken = null;
      runtime.endProjectLock(token);
    }
  }

  async captureProject(): Promise<ProjectEngineCapture> {
    const runtime = this.requireRuntime();
    const metrics = runtime.getMetrics();
    const document = clone(this.currentProject);
    const settings = this.engine.memorySettings;
    const transport = Transport.getInstance();
    document.global = {
      bpm: transport.bpm,
      masterTrackId: transport.masterTrackId,
      loopSyncMode: settings.loopSyncMode,
      tempoSyncMode: settings.tempoSyncMode,
      bounceIn: settings.bounceIn,
      playMode: settings.playMode,
      recAction: settings.recAction,
      quantize: settings.quantize,
      autoRecSw: settings.autoRecSw,
      autoRecSens: settings.autoRecSens,
      bounceSw: settings.bounceSw,
      bounceTrack: settings.bounceTrack,
      singleTrackChange: settings.singleTrackChange,
      currentTrack: settings.currentTrack,
      fadeTimeIn: settings.fadeTimeIn,
      fadeTimeOut: settings.fadeTimeOut,
      allStartTrk: [...settings.allStartTrk],
      allStopTrk: [...settings.allStopTrk],
      loopLength: settings.loopLength,
      speedChange: settings.speedChange,
      syncAdjust: settings.syncAdjust,
    };
    document.routing = {
      inputMic1: settings.inputMic1,
      inputMic2: settings.inputMic2,
      inputInst1L: settings.inputInst1L,
      inputInst1R: settings.inputInst1R,
      inputInst2L: settings.inputInst2L,
      inputInst2R: settings.inputInst2R,
      inputRhythm: settings.inputRhythm,
      monitoringEnabled: this.engine.monitoringEnabled,
      inputDeviceId: this.engine.selectedInputDeviceId,
      outputDeviceId: this.engine.selectedOutputDeviceId,
      engine: clone(this.engine.getRoutingState()),
    };
    document.mixer = clone(this.engine.projectMixer);
    document.activeFxBankId = this.engine.getActiveFxBankId();
    document.fxBanks = cloneBankState(this.engine.getFxBanks());
    document.extensions.rhythm = clone(this.engine.getRhythmSnapshot()) as unknown as JsonValue;
    document.inputFxChain = this.engine.inputFxChain.getSnapshot();
    document.masterFxChain = this.engine.outputFxChain.getSnapshot();
    document.tracks = this.engine.tracks.map((track, index) => this.captureTrack(track, index, metrics.loopFrames[index] ?? 0));

    const audio = await Promise.all(this.engine.tracks.map(async (track, index) => {
      const frames = metrics.loopFrames[index] ?? 0;
      if (frames <= 0) return { trackId: index + 1, buffer: null };
      return { trackId: index + 1, buffer: await track.exportAudioBuffer() };
    }));
    return { document, audio };
  }

  async applyProject(document: ProjectDocument, audioAssets: ReadonlyMap<string, AudioBuffer>): Promise<void> {
    this.requireRuntime();
    const token = this.projectLockToken;
    if (!token) throw new Error('Project application must run under a project lock.');
    this.preflightProjectApply(document);

    const settings = this.engine.memorySettings;
    const transport = Transport.getInstance();
    await this.engine.stopTransportForProject(token);
    // A recalled project starts a fresh clock epoch. Never carry the old
    // project's master identity/phase into the restored project.
    transport.clearClockEpoch();
    this.engine.resetTransportMasterForProject(token);
    // A recall is a project boundary: drop the previous Memory's undo/redo and
    // marked PCM before loading assets, so no old take can leak into this one.
    await Promise.all(this.engine.tracks.map((track) => track.clearForProject(token)));
    Object.assign(settings, {
      loopSyncMode: document.global.loopSyncMode,
      tempoSyncMode: document.global.tempoSyncMode,
      bounceIn: document.global.bounceIn,
      playMode: document.global.playMode,
      recAction: document.global.recAction,
      quantize: document.global.quantize,
      autoRecSw: document.global.autoRecSw,
      autoRecSens: document.global.autoRecSens,
      bounceSw: document.global.bounceSw,
      bounceTrack: document.global.bounceTrack,
      singleTrackChange: document.global.singleTrackChange,
      currentTrack: document.global.currentTrack,
      fadeTimeIn: document.global.fadeTimeIn,
      fadeTimeOut: document.global.fadeTimeOut,
      allStartTrk: [...document.global.allStartTrk],
      allStopTrk: [...document.global.allStopTrk],
      loopLength: document.global.loopLength,
      speedChange: document.global.speedChange,
      syncAdjust: document.global.syncAdjust,
      inputMic1: document.routing.inputMic1,
      inputMic2: document.routing.inputMic2,
      inputInst1L: document.routing.inputInst1L,
      inputInst1R: document.routing.inputInst1R,
      inputInst2L: document.routing.inputInst2L,
      inputInst2R: document.routing.inputInst2R,
      inputRhythm: document.routing.inputRhythm,
    });
    this.engine.projectMixer = clone(document.mixer);
    await this.engine.applyFxBankStateForProject(cloneBankState(document.fxBanks), document.activeFxBankId, token);
    this.engine.inputFxChain.applySnapshot(document.inputFxChain);
    await this.engine.refreshInputRoutingFxForProject(token);
    this.engine.outputFxChain.applySnapshot(document.masterFxChain);

    if (document.routing.inputDeviceId !== this.engine.selectedInputDeviceId) {
      await this.engine.setInputDevice(document.routing.inputDeviceId ?? '', token);
      if (document.routing.inputDeviceId && this.engine.selectedInputDeviceId !== document.routing.inputDeviceId) {
        throw new Error('The project input device is unavailable; the project was not applied.');
      }
    }
    if (document.routing.outputDeviceId !== this.engine.selectedOutputDeviceId) {
      await this.engine.setOutputDevice(document.routing.outputDeviceId ?? '', token);
      if (document.routing.outputDeviceId && this.engine.selectedOutputDeviceId !== document.routing.outputDeviceId) {
        throw new Error('The project output device is unavailable; the project was not applied.');
      }
    }
    if (document.routing.engine) await this.engine.applyRoutingStateForProject(clone(document.routing.engine), token);
    else await this.engine.resetRoutingStateForProject(token);

    for (const projectTrack of document.tracks) {
      const index = projectTrack.id - 1;
      const trackAudio = this.engine.tracks[index]!;
      const next = projectTrack.settings;
      this.applyTrackModelSettings(trackAudio, next);
      const buffer = nextAudioBuffer(projectTrack, audioAssets);
      if (buffer) await trackAudio.importAudioBufferForProject(buffer, token);
      else await trackAudio.clearForProject(token);
      await trackAudio.updateRuntimeSettingsForProject(next.runtime, token);
      await this.engine.setTrackFxSend(projectTrack.id, next.fxSw === 'ON', token);
    }
    await this.engine.applyLoopSettingsForProject({
      bpm: document.global.bpm,
      masterTrackId: document.global.masterTrackId,
      loopSyncMode: document.global.loopSyncMode,
      tempoSyncMode: document.global.tempoSyncMode,
      quantize: document.global.quantize,
    }, token);
    const rhythm = document.extensions.rhythm;
    if (rhythm !== undefined) {
      await this.engine.applyRhythmSnapshotForProject(parseRhythmRuntimeSnapshot(rhythm) as RhythmRuntimeSnapshot, token);
    }
    this.currentProject = clone(document);
    await this.engine.applyMixerState(document.mixer, token);
    if (this.engine.monitoringEnabled !== document.routing.monitoringEnabled) {
      await this.engine.setMonitoringForProject(document.routing.monitoringEnabled, token);
    }
  }

  preflightProjectApply(document: ProjectDocument): void {
    const unsupportedTrack = document.tracks.find((track) => track.settings.fxSlots.some((slot) => slot?.enabled));
    if (unsupportedTrack) {
      throw new Error(`Track ${unsupportedTrack.id} contains enabled legacy FX slots that are not part of the live browser track graph; disable or migrate them before importing this project.`);
    }
  }

  async exportTrack(trackId: number): Promise<AudioBuffer | null> {
    const index = trackId - 1;
    if (!this.engine.tracks[index]) throw new RangeError(`Track id ${trackId} is unavailable.`);
    const frames = this.requireRuntime().getMetrics().loopFrames[index] ?? 0;
    return frames > 0 ? await this.engine.tracks[index]!.exportAudioBuffer() : null;
  }

  async importTrack(trackId: number, buffer: AudioBuffer): Promise<void> {
    const index = trackId - 1;
    if (!this.engine.tracks[index]) throw new RangeError(`Track id ${trackId} is unavailable.`);
    const track = this.engine.tracks[index]!;
    if (this.projectLockToken) await track.importAudioBufferForProject(buffer, this.projectLockToken);
    else await track.importAudioBuffer(buffer);
  }

  createAudioBuffer(sampleRate: number, left: Float32Array, right: Float32Array): AudioBuffer {
    const context = this.engine.context;
    const output = context.createBuffer(2, left.length, sampleRate);
    output.getChannelData(0).set(left);
    output.getChannelData(1).set(right);
    return output;
  }

  getAudioContext(): AudioContext { return this.engine.context; }

  async createTrackFxGraph(context: BaseAudioContext, trackId: number, document: ProjectDocument): Promise<ProjectOfflineFxGraph | null> {
    const track = document.tracks[trackId - 1];
    if (!track) throw new RangeError(`Track id ${trackId} is unavailable.`);
    if (track.settings.fxSlots.some((item) => item?.enabled)) {
      throw new Error(`Track ${trackId} contains enabled legacy FX slots that are not part of the live track graph.`);
    }
    const slots = Object.values(track.settings.fxChain).filter((item) => item.enabled);
    if (!slots.length) return null;
    return await this.createInitializedGraph(context, slots, `Track ${trackId} fixed FX`);
  }

  async createSelectedTrackFxGraph(context: BaseAudioContext, document: ProjectDocument): Promise<ProjectOfflineFxGraph | null> {
    const bank = document.fxBanks.find((entry) => entry.id === document.activeFxBankId);
    if (!bank) throw new Error(`FX bank ${document.activeFxBankId} is missing.`);
    const slots = bank.track.filter((item): item is NonNullable<typeof item> => item !== null && item.enabled);
    if (!slots.length) return null;
    return await this.createInitializedGraph(context, slots, 'Selected track-bank FX');
  }

  async createMasterFxGraph(context: BaseAudioContext, document: ProjectDocument): Promise<ProjectOfflineFxGraph | null> {
    const bank = document.fxBanks.find((entry) => entry.id === document.activeFxBankId);
    if (!bank) throw new Error(`FX bank ${document.activeFxBankId} is missing.`);
    const slots = [
      ...Object.values(document.masterFxChain).filter((item) => item.enabled),
      ...bank.output.filter((item): item is NonNullable<typeof item> => item !== null && item.enabled),
    ];
    if (!slots.length) return null;
    return await this.createInitializedGraph(context, slots, 'Master FX');
  }

  private async createInitializedGraph(context: BaseAudioContext, slots: ProjectFxUnit[], label: string): Promise<ProjectOfflineFxGraph> {
    const graph = await defaultFXRegistry.createGraph(context, slots, { instant: true });
    try {
      await graph.initialize();
      return graph;
    } catch (error) {
      graph.dispose();
      const wrapped = new Error(`${label} could not be initialized for the project mix.`);
      Object.assign(wrapped, { cause: error });
      throw wrapped;
    }
  }

  preflightProjectAudioLoad(assets: readonly ProjectAudioAssetPlan[]): void {
    const primaryBufferBytes = TRACK_META_BYTES + BROWSER_REALTIME_INITIAL_TRACK_FRAMES * 2 * Float32Array.BYTES_PER_ELEMENT;
    const takeSegmentBytes = TRACK_META_BYTES + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * 2 * Float32Array.BYTES_PER_ELEMENT + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
    const initialTrackBytes = primaryBufferBytes + (BROWSER_REALTIME_STORAGE_BATCH_BLOCKS - 1) * takeSegmentBytes;
    const framesByTrack = new Map<number, number>();
    for (const asset of assets) {
      if (!Number.isInteger(asset.trackId) || asset.trackId < 1 || asset.trackId > 5 ||
          !Number.isSafeInteger(asset.outputFrames) || asset.outputFrames <= 0 || asset.outputFrames > BROWSER_REALTIME_MAX_TRACK_FRAMES) {
        throw new RangeError('Project audio storage plan contains an invalid track or frame count.');
      }
      if (framesByTrack.has(asset.trackId)) throw new TypeError(`Project audio storage plan duplicates track ${asset.trackId}.`);
      framesByTrack.set(asset.trackId, asset.outputFrames);
    }
    // Five runtime tracks each keep the initial primary SAB plus the seven
    // pre-reserved take segments. Imports reuse that reserve and allocate only
    // blocks beyond it.
    let requiredBytes = initialTrackBytes * 5;
    for (const frames of framesByTrack.values()) {
      const segments = Math.ceil(frames / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
      requiredBytes += Math.max(0, segments - BROWSER_REALTIME_STORAGE_BATCH_BLOCKS) * takeSegmentBytes;
    }
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > BROWSER_REALTIME_MAX_STORAGE_BYTES) {
      throw new RangeError(`Project loops need approximately ${requiredBytes} bytes of realtime track storage; the engine limit is ${BROWSER_REALTIME_MAX_STORAGE_BYTES} bytes.`);
    }
  }
  readControls() { return clone(this.currentProject.controlState); }
  applyControls(state: ProjectDocument['controlState']): void {
    this.currentProject.controlState = clone(state);
  }

  private captureTrack(trackAudio: TrackAudio, index: number, loopFrames: number): ProjectDocument['tracks'][number] {
    const track = trackAudio.track;
    const runtime = trackAudio.getRuntimeSettings();
    const current = this.currentProject.tracks[index]!;
    const settings: ProjectTrackSettings = {
      measure: clone(track.measure),
      loopSyncSw: track.loopSyncSw,
      tempoSyncSw: track.tempoSyncSw,
      tempoSyncSpeed: track.tempoSyncSpeed,
      pan: parsePan(track.pan),
      playLevel: track.playLevel,
      fxSw: track.fxSw,
      filterEnabled: track.filterEnabled,
      filterValue: track.filterValue,
      filterResonance: track.filterResonance,
      loopFrames,
      runtime,
      fxChain: this.engine.tracks[index]!.fxChain.getSnapshot(),
      fxSlots: clone(current.settings.fxSlots),
    };
    return { ...current, id: index + 1, name: `Track ${index + 1}`, audioAssetId: null, settings };
  }

  private applyTrackModelSettings(trackAudio: TrackAudio, settings: ProjectTrackSettings): void {
    const track = trackAudio.track;
    track.measure = clone(settings.measure);
    track.loopSyncSw = settings.loopSyncSw;
    track.tempoSyncSw = settings.tempoSyncSw;
    track.tempoSyncSpeed = settings.tempoSyncSpeed;
    track.pan = settings.pan;
    track.playLevel = settings.playLevel;
    track.fxSw = settings.fxSw;
    track.filterEnabled = settings.filterEnabled;
    track.filterValue = settings.filterValue;
    track.filterResonance = settings.filterResonance;
    // Legacy normalized Filter controls are backed by this real FX instance.
    trackAudio.fxChain.filter.setEnabled(settings.filterEnabled);
    trackAudio.fxChain.filter.setParam('frequency', settings.filterValue);
    trackAudio.fxChain.filter.setParam('resonance', settings.filterResonance);
    trackAudio.fxChain.applySnapshot(settings.fxChain);
    trackAudio.updateSettings();
  }

  private requireRuntime(): BrowserRealtimeRuntimeLike {
    if (!this.engine.isReady || !this.engine.realtimeRuntime) throw new Error('Initialize browser audio before using project storage.');
    return this.engine.realtimeRuntime as unknown as BrowserRealtimeRuntimeLike;
  }
}

function nextAudioBuffer(track: ProjectDocument['tracks'][number], assets: ReadonlyMap<string, AudioBuffer>): AudioBuffer | null {
  return track.audioAssetId ? assets.get(track.audioAssetId) ?? null : null;
}

interface BrowserRealtimeRuntimeLike {
  getMetrics(): { loopFrames: number[]; renderedFrame: number };
  beginProjectLock(): symbol;
  endProjectLock(token: symbol): void;
}
