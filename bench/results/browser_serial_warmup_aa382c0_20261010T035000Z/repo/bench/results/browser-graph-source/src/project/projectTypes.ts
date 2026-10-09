import type {
  ControlAssignment,
  ControlDispatcherState,
} from '../controls/commandDispatcher';
import type {
  LoopSyncMode,
  MeasureSetting,
  PlayMode,
  QuantizeMode,
  RecAction,
  SingleTrackChange,
  SpeedChange,
  Switch,
  SyncAdjust,
  TempoSyncMode,
  TempoSyncSpeed,
  TrackRuntimeSettings,
} from '../core/types';
import type { BrowserRoutingState } from '../audio/browserRouting';

export const PROJECT_SCHEMA_VERSION = 1 as const;
export const PROJECT_TRACK_COUNT = 5 as const;
export const PROJECT_MEMORY_SLOT_MIN = 1 as const;
export const PROJECT_MEMORY_SLOT_MAX = 99 as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A versioned, structured snapshot of one effect instance. Parameters use the
 * exact units expected by that FX class (some controls are normalized). */
export interface ProjectFxUnit {
  type: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface ProjectTrackSettings {
  measure: MeasureSetting;
  loopSyncSw: Switch;
  tempoSyncSw: Switch;
  tempoSyncSpeed: TempoSyncSpeed;
  pan: number;
  playLevel: number;
  fxSw: Switch;
  filterEnabled: boolean;
  filterValue: number;
  filterResonance: number;
  loopFrames: number;
  runtime: TrackRuntimeSettings;
  fxChain: Record<string, ProjectFxUnit>;
  fxSlots: Array<ProjectFxUnit | null>;
}

export interface ProjectTrack {
  id: number;
  name: string;
  audioAssetId: string | null;
  settings: ProjectTrackSettings;
}

export interface ProjectGlobalSettings {
  bpm: number;
  /** Project master loop. Restore creates a fresh sample-clock epoch at the current frame. */
  masterTrackId: number | null;
  loopSyncMode: LoopSyncMode;
  tempoSyncMode: TempoSyncMode;
  bounceIn: Switch;
  playMode: PlayMode;
  recAction: RecAction;
  quantize: QuantizeMode;
  autoRecSw: Switch;
  autoRecSens: number;
  bounceSw: Switch;
  bounceTrack: number;
  singleTrackChange: SingleTrackChange;
  currentTrack: number;
  fadeTimeIn: string;
  fadeTimeOut: string;
  allStartTrk: boolean[];
  allStopTrk: boolean[];
  loopLength: string | number;
  speedChange: SpeedChange;
  syncAdjust: SyncAdjust;
}

export interface ProjectRouting {
  inputMic1: Switch;
  inputMic2: Switch;
  inputInst1L: Switch;
  inputInst1R: Switch;
  inputInst2L: Switch;
  inputInst2R: Switch;
  inputRhythm: Switch;
  monitoringEnabled: boolean;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /** Channel-accurate browser routing graph. Optional on legacy schema-v1 memories. */
  engine?: BrowserRoutingState;
}

export interface ProjectMixer {
  masterLevel: number;
  tracks: Array<{ trackId: number; level: number; pan: number; muted: boolean; solo: boolean }>;
}

export interface ProjectFxBank {
  id: string;
  name: string;
  input: Array<ProjectFxUnit | null>;
  track: Array<ProjectFxUnit | null>;
  output: Array<ProjectFxUnit | null>;
}

export interface ProjectDocument {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  global: ProjectGlobalSettings;
  routing: ProjectRouting;
  mixer: ProjectMixer;
  activeFxBankId: string;
  fxBanks: ProjectFxBank[];
  inputFxChain: Record<string, ProjectFxUnit>;
  masterFxChain: Record<string, ProjectFxUnit>;
  tracks: ProjectTrack[];
  controlState: ControlDispatcherState;
  extensions: Record<string, JsonValue>;
}

export interface ProjectOfflineFxGraph {
  input: AudioNode;
  output: AudioNode;
}

export interface ProjectAudioAssetPlan {
  trackId: number;
  sourceFrames: number;
  sourceSampleRate: number;
  outputFrames: number;
  outputSampleRate: number;
  decodedPcmBytes: number;
}

export interface ProjectMemoryInfo {
  slot: number;
  name: string;
  updatedAt: string;
  trackCount: number;
  assetCount: number;
}

export type ProjectOperation = 'idle' | 'save' | 'load' | 'delete' | 'import' | 'export' | 'track-import' | 'track-export' | 'bounce';

export interface ProjectServiceState {
  busy: boolean;
  operation: ProjectOperation;
  progress: number | null;
  error: string | null;
}

export interface ProjectEngineCapture {
  document: ProjectDocument;
  /** One-based track id (1..5) to unprocessed stereo recording buffer. */
  audio: Array<{ trackId: number; buffer: AudioBuffer | null }>;
}

export interface ProjectEngineAdapter {
  withProjectLock?<T>(action: () => Promise<T>): Promise<T>;
  /** Reject semantically unsupported documents before audio decode or mutation. */
  preflightProjectApply?(document: ProjectDocument): void;
  captureProject(): Promise<ProjectEngineCapture>;
  applyProject(document: ProjectDocument, audioAssets: ReadonlyMap<string, AudioBuffer>): Promise<void>;
  exportTrack(trackId: number): Promise<AudioBuffer | null>;
  importTrack(trackId: number, buffer: AudioBuffer): Promise<void>;
  createAudioBuffer(sampleRate: number, left: Float32Array, right: Float32Array): AudioBuffer;
  getAudioContext(): AudioContext;
  /** Must instantiate the real project FX graph. Missing/unsupported graphs reject. */
  createTrackFxGraph?(context: BaseAudioContext, trackId: number, document: ProjectDocument): Promise<ProjectOfflineFxGraph | null>;
  createSelectedTrackFxGraph?(context: BaseAudioContext, document: ProjectDocument): Promise<ProjectOfflineFxGraph | null>;
  createMasterFxGraph?(context: BaseAudioContext, document: ProjectDocument): Promise<ProjectOfflineFxGraph | null>;
  preflightProjectAudioLoad?(assets: readonly ProjectAudioAssetPlan[]): void;
  readControls?(): ControlDispatcherState;
  applyControls?(state: ControlDispatcherState): void | Promise<void>;
}

export interface ProjectMemoryRecord {
  slot: number;
  name: string;
  updatedAt: string;
  document: ProjectDocument;
  audioAssets: Record<string, Blob>;
}

export interface ProjectMemoryStore {
  list(): Promise<ProjectMemoryInfo[]>;
  get(slot: number): Promise<ProjectMemoryRecord | null>;
  put(record: ProjectMemoryRecord): Promise<ProjectMemoryInfo>;
  delete(slot: number): Promise<void>;
}

export interface ProjectBounceOptions {
  selectedTrackIds: number[];
  durationFrames?: number;
  durationSeconds?: number;
  realtime?: boolean;
}

export interface ProjectServiceOptions {
  store?: ProjectMemoryStore;
  resourcePolicy?: ProjectResourcePolicy;
  controls?: {
    read: () => ControlDispatcherState;
    apply: (state: ControlDispatcherState) => void | Promise<void>;
  };
}

export interface ProjectResourcePolicy {
  maxAssetBytes: number;
  maxArchiveBytes: number;
  /** Aggregate PCM decoded into AudioBuffers before engine application. */
  maxDecodedPcmBytes?: number;
  /** Combined intermediate and final mix renderer allocation bound. */
  maxBounceMemoryBytes?: number;
}

export const DEFAULT_PROJECT_RESOURCE_POLICY: ProjectResourcePolicy = {
  maxAssetBytes: 512 * 1024 * 1024,
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxDecodedPcmBytes: 512 * 1024 * 1024,
  maxBounceMemoryBytes: 512 * 1024 * 1024,
};

export const DEFAULT_CONTROL_STATE: ControlDispatcherState = {
  version: 1,
  assignments: Array.from({ length: 16 }, () => null as ControlAssignment | null),
};
