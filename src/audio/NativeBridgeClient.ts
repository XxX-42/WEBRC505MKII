import { nativeBridgeEndpoint } from './nativeBridgeEndpoint';
import { NATIVE_CATALOG_FX_LABELS } from './nativeFxCatalog';
import { PROJECT_ARCHIVE_LIMITS } from './projectArchive';

export type NativeBackend = 'WASAPI' | 'ASIO';
export type NativeLooperState = 'Empty' | 'Recording' | 'Stopped' | 'Playing' | 'Overdubbing';
export type NativeHqEngine = 'R2' | 'R3';
export type NativeLoopTransportMode = 'off' | 'beatShift' | 'vinylFlick';
export type NativeDubMode = 'OVERDUB' | 'REPLACE1' | 'REPLACE2';
export interface NativeDubModeStatus {
  applied: NativeDubMode;
  requested: NativeDubMode;
  requestedRevision: number;
  appliedRevision: number;
  acceptedRevision?: number;
}
export type NativeLoopTransportStatus =
  | 'disabled'
  | 'waitingForLoop'
  | 'waitingForPlayback'
  | 'active'
  | 'unsupportedRecording'
  | 'unsupportedOverdubbing'
  | 'unsupportedPitchProcessing';

export interface NativeMemoryLoopTransport {
  mode: number;
  oneShot?: boolean;
  reverse?: boolean;
  beatOffsetBeats: number;
  bpm: number;
  crossfadeMs: number;
  vinylSpeedPercent: number;
  motorReturnSeconds: number;
  brakePercent: number;
  vinylMixPercent: number;
}

/** Real playback-only carrier source availability, when advertised by the host. */
export type NativeVocoderCarrierStatus =
  | 'notRequested' | 'ready' | 'empty' | 'stopped'
  | 'unsupportedRecording' | 'unsupportedOverdubbing' | 'unsupportedPitchProcessing'
  | 'historyPinned' | 'bufferUnavailable';

export interface NativeLoopTransportConfig {
  mode: NativeLoopTransportMode;
  /** Native finite playback. Missing on older callers means OFF. */
  oneShot?: boolean;
  /** Reverse the read cursor without rewriting finalized PCM. */
  reverse?: boolean;
  beatOffsetBeats: number;
  bpm: number;
  crossfadeMs: number;
  vinylSpeedPercent: number;
  motorReturnSeconds: number;
  brakePercent: number;
  vinylMixPercent: number;
}

export interface NativeHqRendererCapability {
  available: boolean;
  engines: NativeHqEngine[];
}

export interface NativeTrackHistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  retainedPcmBytes: number;
  unavailableReason: 'none' | 'budgetExceeded' | 'snapshotUnavailable' | 'noUndo' | 'noRedo' | 'trackMustBeStopped' | 'unknown';
}

export interface NativeTrackMarkStatus {
  exists: boolean;
  canSet: boolean;
  canClear: boolean;
  busy: boolean;
  retainedPcmBytes: number;
  unavailableReason: string;
  requestedGeneration: number;
  appliedGeneration: number;
}

export type NativeProjectImportState = 'prepared' | 'pending' | 'claimed' | 'committed' | 'cancelled' | 'unavailable';

export function isNativeHostIncarnationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function createNativeRhythmIntentId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Cryptographic randomness is unavailable; Native scheduled REC/STOP was not submitted.');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function nativeProjectArchiveSha256(value: ArrayBuffer | Uint8Array): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Secure archive fingerprinting is unavailable; Native import was not submitted.');
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface NativeProjectImportAcceptance {
  readonly generation: number;
  readonly hostIncarnationId: string;
  readonly operationId: string;
}

export class NativeProjectImportOutcomeUnknownError extends Error {
  public constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`The Native bridge did not acknowledge an import generation, so the request outcome is unknown. Do not retry until the host state is checked. ${detail}`);
    this.name = 'NativeProjectImportOutcomeUnknownError';
  }
}

export interface NativeProjectImportStatus {
  ok: true;
  generation: number;
  state: NativeProjectImportState;
  error?: string;
  projectContentRevision?: number;
  committedProjectContentRevision?: number;
  projectTransportMutationRevision?: number;
  /** The host confirmed commit, but this client no longer has enough operation state to publish undo recovery safely. */
  recoveryUnavailable?: boolean;
  hostIncarnationId?: string;
  hostIncarnationMismatch?: boolean;
  operationId?: string;
  archiveSha256?: string;
  expectedProjectContentRevision?: number;
}

export class NativeProjectImportIndeterminateError extends Error {
  public readonly generation: number;

  public constructor(generation: number, detail?: unknown) {
    const reason = detail === undefined ? '' : ` The last bridge request failed: ${detail instanceof Error ? detail.message : String(detail)}`;
    super(`Native project import generation ${generation} has an indeterminate outcome; check its status before retrying.${reason}`);
    this.name = 'NativeProjectImportIndeterminateError';
    this.generation = generation;
  }
}

export interface NativeDeviceInfo {
  id: string;
  name: string;
  sampleRates: number[];
  isDefault: boolean;
}

export interface NativeDeviceCatalog {
  ok: boolean;
  backends: NativeBackend[];
  inputsByBackend: Record<string, NativeDeviceInfo[]>;
  outputsByBackend: Record<string, NativeDeviceInfo[]>;
  defaultInputIdByBackend: Record<string, string>;
  defaultOutputIdByBackend: Record<string, string>;
  bufferOptions: number[];
}

/** Authoritative per-effect range/choice metadata published by a Native host. */
export interface NativeFxParameterDescriptor {
  id: string;
  label: string;
  minimum: number;
  maximum: number;
  defaultValue: number;
  smoothingMs: number;
  discrete: boolean;
  discreteValues?: number[];
  /** Present only for accepted pre-schema compatibility names such as LPF/HPF `q`. */
  legacyAlias?: boolean;
  provenance?: 'official-interface' | 'extension' | 'routing';
  unit?: string;
  step?: number;
  semanticSupport?: 'partial_live_stream' | 'partial_source_modes';
  limitation?: string;
  options?: Array<{ value: number; label: string }>;
  sourcePage?: number;
  officialEffectName?: string;
  documentedDefault?: number | null;
}

export interface NativeFxParameterSchema {
  version: 1;
  parameters: NativeFxParameterDescriptor[];
  legacyAliases: NativeFxParameterDescriptor[];
}

export interface NativeRhythmConfig {
  enabled: boolean;
  bpm: number;
  kitIndex: number;
  patternIndex: number;
  variation: 'A' | 'B' | 'C' | 'D';
  section: 'main' | 'intro' | 'ending' | 'fill';
  swingPercent: number;
  quantizeGrid: '1/16' | '1/8' | '1/4';
  volume: number;
}

/** Validate at the boundary so unsupported selections never silently become defaults. */
export function isNativeRhythmConfig(config: NativeRhythmConfig): boolean {
  return typeof config.enabled === 'boolean'
    && Number.isFinite(config.bpm) && config.bpm >= 40 && config.bpm <= 300
    && Number.isInteger(config.kitIndex) && config.kitIndex >= 1 && config.kitIndex <= 16
    && Number.isInteger(config.patternIndex) && config.patternIndex >= 1 && config.patternIndex <= 240
    && ['A', 'B', 'C', 'D'].includes(config.variation)
    && ['main', 'intro', 'ending', 'fill'].includes(config.section)
    && Number.isInteger(config.swingPercent) && config.swingPercent >= 50 && config.swingPercent <= 75
    && ['1/16', '1/8', '1/4'].includes(config.quantizeGrid)
    && Number.isInteger(config.volume) && config.volume >= 0 && config.volume <= 100;
}

export interface NativeCallbackTelemetry {
  schemaVersion: 1;
  sourceKind: 'NO_CALLBACKS' | 'NO_HARDWARE_SIMULATION' | 'RTAUDIO_STREAM' | 'MIXED_CALLBACK_SOURCES';
  observed: boolean;
  counterScope: string;
  callbackCount: number | null;
  hardwareCallbackCount: number | null;
  byKind: Array<{kind: 'duplex' | 'input' | 'output'; callbacks: number | null; latestSampleRateHz: number | null; latestBufferFrames: number | null; latestBudgetNs: number | null}>;
  statusFlags: {sourceKind: string; inputOverflow: number | null; outputUnderflow: number | null; unknownStatus: number | null};
  driver: {sourceKind: string; inputOverflow: number | null; outputUnderflow: number | null; resetCount: null; globalStatistics: null};
  software: {sourceKind: string; audioQueueOverflow: number | null; audioQueueUnderflow: number | null; controlQueueReject: number | null; oversizeCallback: number | null; nonFiniteInput: number | null; nonFiniteOutput: number | null; deadlineMiss: number | null; deadlineEvaluatedCallbacks: number | null; runtimeResetCount: number | null};
  duration: {sourceKind: string; scope: string; samples: number | null; sampleResolutionFraction: number | null; recommendedMinimumSamplesForP999: number; binWidthNs: number; binCount: number; overflowSamples: number | null; histogram: number[] | null; p99UpperBoundNs: number | null; p999UpperBoundNs: number | null; quantileUnavailableReason: string | null; maximumNs: number | null};
}

export interface NativeStatus {
  /** Cryptographically random process incarnation; missing means the host cannot be safely correlated across restarts. */
  hostIncarnationId?: string;
  nativeStopTrackAcknowledgement?: { trackId: number; requestedRevision: number; appliedRevision: number; committedRevision: number };
  /** Host callback support for per-take BPM provenance tokens. */
  nativeTempoRecordProvenanceVersion?: number;
  nativeMemory?: { version: number; loopTransports: NativeMemoryLoopTransport[]; dubModes?: NativeDubMode[];
    bounce?: { bounceSw: boolean; bounceIn: boolean[]; bounceTrack: boolean[] } };
  nativeBounce?: { version: 1; bounceSw: boolean; bounceIn: boolean[]; bounceTrack: boolean[]; requestedRevision: number; appliedRevision: number; acceptedRevision?: number; sourceTap: 'pre-track-insert'; hardwareFxPlacementVerified: false };
  callbackTelemetry?: NativeCallbackTelemetry;
  mixerLevels?: number[];
  nativeRecordPlay?: { version: 1; recActionAvailable: boolean; quantizeAvailable: false;
    recAction: 'REC->PLAY' | 'REC->DUB'; requestedRevision: number; appliedRevision: number;
    finishRequested: number[]; finishApplied: number[]; finishCancelled?: number[];
    stopRequested?: number[]; stopApplied?: number[]; stopCommittedRevision?: number[];
    acceptedStopRequestRevision?: number };
  nativeLoopFrameScheduling?: { version: 1; available: boolean; acceptedTrackId?: number;
    acceptedRevision?: number; requests?: Array<{ trackIndex: number; requestedRevision: number;
      requestedAbsoluteFrame: number; requestedPhaseEpoch: number; requestedSettingsRevision: number;
      requestedAction: 'record' | 'stop'; requestedIntentId: string; appliedRevision: number; appliedAbsoluteFrame: number;
      cancelledRevision: number; faultRevision: number; fault: number }> };
  nativeRecordTempoProvenance?: { version: 1; requestedRevision: number[]; appliedRevision: number[];
    acceptedRevision: number[]; acceptedRequestRevision?: number };
  ok: boolean;
  bridgeHealthy: boolean;
  engineRunning: boolean;
  backend: NativeBackend;
  inputDeviceId: string;
  outputDeviceId: string;
  inputDeviceName: string;
  outputDeviceName: string;
  sampleRate: number;
  bufferFrames: number;
  /** Absolute frame cursor used for Native sample-clocked MIDI events. */
  nativeSampleFrame?: number;
  monitoringEnabled: boolean;
  state: NativeLooperState;
  inputLatencyMs: number;
  outputLatencyMs: number;
  roundTripEstimateMs: number;
  inputPeak: number;
  outputPeak: number;
  xrunsOrDropouts: number;
  lastError: string;
  loopProgress: number;
  nativeLooperTrackCount?: number;
  nativeLooperMultiTrackImplemented?: boolean;
  nativeLooperTracksStereo?: boolean;
  nativeLooperMaxRecordSeconds?: number;
  /** Explicit host codec/import capability; absent means v1 only. */
  projectArchiveV2Supported?: boolean;
  nativeLooperPreallocatedBytes?: number;
  nativeLooperStorageBudgetBytes?: number;
  /** Host-wide epoch for loop PCM/history edits and track-state transitions a project load replaces. */
  projectContentRevision?: number;
  /** Host marks the revision/status pair unstable if it raced a callback edit. */
  projectContentRevisionSnapshotStable?: boolean;
  nativeTracks?: Array<{
    trackId: number;
    state: NativeLooperState;
    loopProgress: number;
    /** Monotonic loop-content revision; older hosts omit it. */
    contentRevision?: number;
    loopTransportStatus?: NativeLoopTransportStatus;
    loopTransportRequestedRevision?: number;
    loopTransportAppliedRevision?: number;
    loopTransportFaultRevision?: number;
    loopTransportAcceptedRevision?: number;
    loopTransportAppliedOneShot?: boolean;
    loopTransportAppliedReverse?: boolean;
    dubMode?: NativeDubModeStatus;
    vocoderCarrierStatus?: NativeVocoderCarrierStatus;
    history?: NativeTrackHistoryStatus;
    mark?: NativeTrackMarkStatus;
  }>;
  nativeHistory?: { budgetBytes: number; retainedBytes: number };
  /** Missing or unknown versions mean Native MARK SET/CLEAR is unavailable. */
  nativeMarkVersion?: number;
  nativeMarks?: { budgetBytes: number; retainedBytes: number };
  nativePitch?: NativePitchStatus;
  /** Missing status is treated as unavailable; old bridge builds cannot render Native HQ. */
  nativeHqRenderer?: NativeHqRendererCapability;
  nativeRhythm?: NativeRhythmConfig & {
    available: boolean;
    patternCatalogAvailable: boolean;
    patternId: string;
    genre: string;
    pattern: string;
    beat: string;
    meterNumerator: number;
    meterDenominator: number;
    eventsCleanRoomProcedural: boolean;
    tempoRequestedRevision?: number;
    tempoAppliedRevision?: number;
    tempoAppliedValid?: boolean;
    phase?: {
      version: 1;
      available: boolean;
      snapshotStable: boolean;
      snapshotRevision: number;
      epoch: number;
      sampleFrame: number;
      originFrame: number;
      measureOrdinal: number;
      measureStartFrame: number;
      nextMeasureFrame: number;
      meterNumerator: number;
      meterDenominator: number;
      frameSchedulingAvailable: boolean;
      frameSchedulingReason: string;
    };
    patternSource: 'metadata-only-240-pattern-catalog';
    statusNote: string;
  };
  nativeFx?: {
    /** Missing/unknown means this host predates descriptor-backed parameter controls. */
    parameterSchemaVersion?: number;
    /** Host accepts complete authored snapshots; live removals may require stopped audio. */
    catalogParameterReplacement?: boolean;
    implementedCatalogEffects?: string[];
    catalogEffectAvailability?: Array<{
      effectId: string;
      sourceIndex?: number;
      input: boolean;
      track: boolean;
      perTrackInsert?: boolean;
      parameters?: NativeFxParameterDescriptor[];
      legacyParameterAliases?: NativeFxParameterDescriptor[];
      officialParameters?: NativeFxParameterDescriptor[];
    }>;
    catalogGraphAvailable?: boolean;
    /** Missing means this host predates callback-acknowledged per-track FX apply. */
    trackFxApplyAvailable?: boolean;
    trackFxApply?: NativeTrackFxApplyRuntime[];
    /** Independent pre-sum loop chains, separate from the legacy postmix bank. */
    perTrackCatalogAvailable?: boolean;
    catalogControlFaultCount?: number;
    perTrackCatalogBanks?: NativePerTrackCatalogBank[];
    sourceAwareLoopTransport?: {
      experimental: boolean;
      stage: 'preInsert';
      orderedInsertPlacementSupported: boolean;
      effects: string[];
      statusNote: string;
    };
    catalogSlots?: NativeCatalogSlotStatus[];
    inputCatalogSlots?: NativeCatalogSlotStatus[];
    trackOutputBank?: {
      layout: NativeFxSlot[];
      activeSlots: NativeFxSlot[];
      multiTrackImplemented: boolean;
    };
    fractionalDelay?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'lagrange4';
      delayMs: number;
      wetMix: number;
      feedback: number;
      maxDelayMs: number;
    };
    compressor?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'peakCompressor';
      thresholdDb: number;
      ratio: number;
      attackMs: number;
      releaseMs: number;
      wetMix: number;
      makeupDb: number;
    };
    chorus?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'stereoLfoLagrange4';
      rateHz: number;
      depthMs: number;
      feedback: number;
      wetMix: number;
    };
    autoPan?: {
      available: boolean;
      enabled: boolean;
      slot: NativeFxSlot;
      algorithm: 'equalPowerMidSideLfo';
      rateHz: number;
      depth: number;
      waveform: NativeAutoPanWaveform;
      wetMix: number;
    };
    oscVocMidi?: {
      eventQueueCapacity: number;
      currentSampleFrame: number;
      inputSlots: NativeOscVocSlotStatus[];
      trackSlots: NativeOscVocSlotStatus[];
      statusNote: string;
    };
    catalogMidi?: {
      inputSlots: NativeCatalogMidiSlotStatus[];
      trackSlots: NativeCatalogMidiSlotStatus[];
      statusNote: string;
    };
  };
}

export interface NativeTrackFxApplyRuntime {
  trackId: number;
  requested: boolean;
  applied: boolean;
  requestedRevision: number;
  appliedRevision: number;
  semanticRevision?: number;
  controlFaulted: boolean;
  peak: number;
  rms: number;
}

export interface NativeCatalogSlotStatus {
  slot: NativeFxSlot;
  effectId: string;
  /** Exact authored parameter snapshot associated with requestedRevision. */
  parameters?: Record<string, number>;
  /** Requested control-thread bypass, which may be waiting for a callback. */
  bypassed: boolean;
  appliedBypassed: boolean;
  prepared: boolean;
  processingFaulted: boolean;
  controlFaulted: boolean;
  requestedRevision: number;
  appliedRevision: number;
}

export interface NativePerTrackCatalogBank {
  trackId: number;
  slots: NativeCatalogSlotStatus[];
  midiSlots: NativeCatalogMidiSlotStatus[];
}

export interface NativeOscVocSlotStatus {
  slot: NativeFxSlot;
  selected: boolean;
  currentFrame: number;
  queuedEvents: number;
  overflowEventCount: number;
  lateEventCount: number;
  rejectedEventCount: number;
}

export interface NativeCatalogMidiSlotStatus extends NativeOscVocSlotStatus {
  effectId: string;
  queueCapacity: number;
}

export interface NativePitchStatus {
    pitchCorrectionAvailable: boolean;
    pitchCorrectionImplemented: boolean;
    enabled: boolean;
    active: boolean;
    /** 0 is the legacy summed bus; 1..5 identifies the selected loop. */
    trackId: number;
    reversePlayback: boolean;
    mode: 'liveMonoKeepPitch' | 'livePolyPhaseVocoder';
    algorithm: 'cleanRoomYinPsola' | 'signalsmithStretch132Cheaper';
    semitones: number;
    frequencyHz: number;
    confidence: number;
    voiced: boolean;
    latencySamples: number;
    fallbackReason: 'none' | 'notRequested' | 'processorNotPrepared' | 'playbackBufferUnavailable' |
      'reversePlayback' | 'unsupportedChannelCount' | 'loopShorterThanLatency' | 'unknown';
    statusNote: string;
}

export interface NativeHealth {
  ok: boolean;
  version: string;
  engineRunning: boolean;
  backends: NativeBackend[];
  lastError: string;
}

export interface NativeLoopSnapshot {
  readonly sampleRate: number;
  readonly frameCount: number;
  /** 1 for legacy hosts; 2 for the current Native stereo-track snapshot. */
  readonly channels: 1 | 2;
  /** Monotonic content revision captured by the same callback pin as PCM. */
  readonly contentRevision?: number;
  readonly samples: Float32Array;
}

export interface NativeLoopSnapshotMetadata {
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly channels: 1 | 2;
  readonly contentRevision?: number;
}

export interface NativeTrackMetadata {
  readonly trackId: number;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly channels: 2;
  readonly contentRevision?: number;
  readonly originalTempoBpm?: number | null;
}

export interface NativeRecordTempoToken {
  readonly bpm: number;
  readonly revision: number;
}

/** Returns a provenance token only for hosts that explicitly support it. */
export function nativeRecordTempoToken(
  status: NativeStatus | null | undefined, bpm: number, revision: number,
): NativeRecordTempoToken | undefined {
  if (status?.nativeTempoRecordProvenanceVersion !== 1 || !Number.isFinite(bpm) || bpm < 40 || bpm > 300 ||
      !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) return undefined;
  return { bpm, revision };
}

export function nativeRecordTempoTokenMatches(
  expected: NativeRecordTempoToken | undefined, actual: NativeRecordTempoToken | undefined,
): boolean {
  return expected !== undefined && actual !== undefined && expected.bpm === actual.bpm && expected.revision === actual.revision;
}

export interface NativeHqRenderOptions {
  readonly semitones: number;
  readonly playbackRate: number;
  readonly engine: NativeHqEngine;
  readonly memoryBudgetBytes: number;
  readonly format: 'pcm16' | 'pcm24' | 'float32';
}

export interface NativeHqRenderResult extends NativeTrackMetadata {
  readonly samples: Float32Array;
  readonly engine: NativeHqEngine;
  readonly latencySamples: 0;
}

export interface NativeConfig {
  backend: NativeBackend;
  inputDeviceId: string;
  outputDeviceId: string;
  sampleRate: number;
  bufferFrames: number;
  monitoringEnabled: boolean;
  nativeLooperStorageBudgetBytes: number;
}

export type NativeFxSlot = 'A' | 'B' | 'C' | 'D';

export interface NativeFractionalDelayConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'lagrange4';
  delayMs: number;
  wetMix: number;
  feedback: number;
}

export interface NativeCompressorConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'peakCompressor';
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  wetMix: number;
  makeupDb: number;
}

export interface NativeChorusConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'stereoLfoLagrange4';
  rateHz: number;
  depthMs: number;
  feedback: number;
  wetMix: number;
}

export type NativeAutoPanWaveform = 'sine' | 'triangle' | 'square';

export interface NativeAutoPanConfig {
  slot: NativeFxSlot;
  enabled: boolean;
  algorithm: 'equalPowerMidSideLfo';
  rateHz: number;
  depth: number;
  waveform: NativeAutoPanWaveform;
  wetMix: number;
}

export interface NativeCatalogSlotConfig {
  path?: 'input' | 'track';
  /** 0/omitted is the legacy bank; Track 1..5 selects an independent loop chain. */
  trackId?: number;
  slot: NativeFxSlot;
  effectId: string;
  parameters?: Record<string, number>;
  /** Omitted/false preserves legacy patch-client semantics. */
  replaceParameters?: boolean;
  bypassed: boolean;
}

export interface NativeOscVocMidiEvent {
  path: 'input' | 'track';
  trackId?: number;
  slot: NativeFxSlot;
  type: 'noteOn' | 'noteOff';
  /** 1-based MIDI channel, in the range 1–16. */
  channel: number;
  note: number;
  velocity: number;
  /** Absolute Native sample frame, as an integer exactly representable in JS. */
  frame: number;
}

export interface NativeCatalogMidiEvent extends NativeOscVocMidiEvent {
  effectId: 'osc_voc_m' | 'hrm_auto_m';
}

export interface NativePitchConfig {
  enabled: boolean;
  /** Optional per-track route; omission preserves the legacy global bus (0). */
  trackId?: number;
  mode?: 'liveMonoKeepPitch' | 'livePolyPhaseVocoder';
  semitones: number;
  reversePlayback?: boolean;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
}

export const NATIVE_BRIDGE_REQUEST_TIMEOUT_MS = 5_000;

export class NativeBridgeRequestTimeoutError extends Error {
  public readonly path: string;
  public readonly method: string;
  public readonly timeoutMs: number;
  public readonly reconciledStatus: NativeStatus | null;
  public readonly statusReadError: unknown | null;

  public constructor(
    path: string,
    method: string,
    timeoutMs: number,
    reconciledStatus: NativeStatus | null = null,
    statusReadError: unknown | null = null,
  ) {
    super(`Native bridge request ${path} timed out after ${timeoutMs} ms.`);
    this.name = 'TimeoutError';
    this.path = path;
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.reconciledStatus = reconciledStatus;
    this.statusReadError = statusReadError;
  }
}

export class NativeBridgeHttpError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = 'NativeBridgeHttpError';
    this.status = status;
  }
}

export class NativeTrackFxApplyAcknowledgementError extends Error {
  public readonly reconciledStatus: NativeStatus | null;

  public constructor(message: string, reconciledStatus: NativeStatus | null = null) {
    super(message);
    this.name = 'NativeTrackFxApplyAcknowledgementError';
    this.reconciledStatus = reconciledStatus;
  }
}

export interface NativeRhythmScheduleReceipt {
  readonly trackId: number;
  readonly action: 'record' | 'stop';
  readonly revision: number | null;
  readonly baselineRevision: number;
  readonly absoluteFrame: number;
  readonly phaseEpoch: number;
  readonly settingsRevision: number;
  readonly hostIncarnationId: string;
  readonly intentId: string;
}

export class NativeRhythmScheduleOutcomeUnknownError extends Error {
  public readonly receipt: NativeRhythmScheduleReceipt;
  public readonly lastStatus: NativeStatus | null;

  public constructor(receipt: NativeRhythmScheduleReceipt, lastStatus: NativeStatus | null, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Native scheduled ${receipt.action.toUpperCase()} ${receipt.revision === null ? 'intent' : `revision ${receipt.revision}`} on Track ${receipt.trackId} has an unknown outcome. Reconcile or cancel this exact request after reconnecting; do not submit another transport command. ${detail}`);
    this.name = 'NativeRhythmScheduleOutcomeUnknownError';
    this.receipt = receipt;
    this.lastStatus = lastStatus;
  }
}

export class NativeRhythmScheduleTerminalError extends Error {
  public readonly receipt: NativeRhythmScheduleReceipt;
  public readonly lastStatus: NativeStatus;
  public readonly outcome: 'cancelled' | 'fault' | 'appliedFrameMismatch';

  public constructor(receipt: NativeRhythmScheduleReceipt, lastStatus: NativeStatus,
      outcome: NativeRhythmScheduleTerminalError['outcome'], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Native scheduled ${receipt.action.toUpperCase()} revision ${receipt.revision} on Track ${receipt.trackId} is terminal (${outcome}); its host status is known. ${detail}`);
    this.name = 'NativeRhythmScheduleTerminalError';
    this.receipt = receipt;
    this.lastStatus = lastStatus;
    this.outcome = outcome;
  }
}

export class NativeRhythmScheduleRecoveryBlockedError extends Error {
  public readonly lastStatus: NativeStatus;

  public constructor(lastStatus: NativeStatus, message: string) {
    super(message);
    this.name = 'NativeRhythmScheduleRecoveryBlockedError';
    this.lastStatus = lastStatus;
  }
}

export class NativeBridgeClient {
  private readonly baseUrl: string;
  private latestStatus: NativeStatus | null = null;
  private pendingRhythmSchedule: NativeRhythmScheduleReceipt | null = null;

  constructor(baseUrl = nativeBridgeEndpoint()) {
    this.baseUrl = baseUrl;
  }

  public async health(): Promise<NativeHealth> {
    return this.request<NativeHealth>('/health');
  }

  public async getDevices(): Promise<NativeDeviceCatalog> {
    return this.request<NativeDeviceCatalog>('/v1/devices');
  }

  public async getStatus(): Promise<NativeStatus> {
    const status = await this.request<NativeStatus>('/v1/status');
    this.latestStatus = status;
    return status;
  }

  public getPendingRhythmSchedule(): NativeRhythmScheduleReceipt | null {
    return this.pendingRhythmSchedule ? { ...this.pendingRhythmSchedule } : null;
  }

  public getOneShot(trackId: number): boolean | null {
    assertNativeTrackId(trackId);
    const value = this.latestStatus?.nativeTracks?.find((track) => track.trackId === trackId)?.loopTransportAppliedOneShot;
    return typeof value === 'boolean' ? value : null;
  }

  /** Writes once and returns only after the Native audio callback has applied the requested revision. */
  public async setTrackFxApply(trackId: number, enabled: boolean): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (typeof enabled !== 'boolean') throw new TypeError('Native Track FX apply must be a boolean.');
    try {
      const status = await this.request<NativeStatus>('/v1/native-track-fx/apply', {
        method: 'POST',
        body: JSON.stringify({ trackId, enabled }),
      });
      const apply = status.nativeFx?.trackFxApply?.find((item) => item.trackId === trackId);
      if (status.nativeFx?.trackFxApplyAvailable !== true || !apply ||
          apply.requested !== enabled || apply.applied !== enabled ||
          !Number.isSafeInteger(apply.requestedRevision) || apply.requestedRevision <= 0 ||
          !Number.isSafeInteger(apply.appliedRevision) || apply.appliedRevision !== apply.requestedRevision ||
          apply.controlFaulted !== false) {
        throw new NativeTrackFxApplyAcknowledgementError(
          `Native status did not confirm callback application of Track ${trackId} FX apply.`, status,
        );
      }
      return status;
    } catch (error) {
      if (error instanceof NativeBridgeRequestTimeoutError) {
        // request() already performed its one status readback after timing out.
        throw new NativeTrackFxApplyAcknowledgementError(error.message, error.reconciledStatus);
      }
      if (error instanceof NativeTrackFxApplyAcknowledgementError && error.reconciledStatus) throw error;

      // HTTP 504 and transport errors can leave the command outcome uncertain.
      // Reconcile once, and never replay the write.
      let status: NativeStatus | null = null;
      try { status = await this.getStatus(); } catch { /* Preserve the original write failure. */ }
      throw new NativeTrackFxApplyAcknowledgementError(
        error instanceof Error ? error.message : String(error), status,
      );
    }
  }

  /** Upload a validated v1 archive with its operation-start host revision. */
  public async beginProjectArchiveImport(archive: ArrayBuffer | Uint8Array, expectedProjectContentRevision: number,
      expectedHostIncarnationId: string, operationId: string): Promise<NativeProjectImportAcceptance> {
    const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
    if (bytes.byteLength < 12 || bytes.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new RangeError('Native project archive is empty or exceeds the supported archive-size limit.');
    }
    if (!(bytes.buffer instanceof ArrayBuffer)) {
      throw new TypeError('Native project archive input must be backed by a regular ArrayBuffer.');
    }
    if (!Number.isSafeInteger(expectedProjectContentRevision) || expectedProjectContentRevision < 0) {
      throw new RangeError('Native project import requires a valid operation-start content revision.');
    }
    if (!isNativeHostIncarnationId(expectedHostIncarnationId)) {
      throw new RangeError('Native project import requires a valid operation-start host incarnation ID.');
    }
    if (!/^[0-9a-f]{32}$/i.test(operationId)) throw new RangeError('Native project import requires its persisted 128-bit operation ID.');
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/project/import?expectedContentRevision=${expectedProjectContentRevision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Native-Host-Incarnation': expectedHostIncarnationId,
          'X-Native-Operation-Id': operationId },
        // Fetch supports ArrayBufferView request bodies. TS 5.9's DOM type is
        // narrower for Uint8Array<ArrayBufferLike>; validated project inputs
        // are ordinary ArrayBuffers, so preserve the view without another
        // full-size copy of a potentially large PCM archive.
        body: bytes as unknown as Uint8Array<ArrayBuffer>,
      });
    } catch (error) {
      throw new NativeProjectImportOutcomeUnknownError(
        new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    if (!response.ok) throw await this.readHttpError(response, 'Native project archive import was rejected');
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new NativeProjectImportOutcomeUnknownError('Native bridge returned invalid project-import JSON.'); }
    if (!isObject(payload) || payload.ok !== true || !Number.isSafeInteger(payload.generation) ||
        (payload.generation as number) <= 0) {
      throw new NativeProjectImportOutcomeUnknownError('Native bridge returned an invalid project-import generation.');
    }
    if (!isNativeHostIncarnationId(payload.hostIncarnationId)) {
      throw new NativeProjectImportIndeterminateError(payload.generation as number,
        'The import was accepted by a host that did not identify its incarnation; keep the recovery snapshot and do not retry.');
    }
    if (payload.operationId !== operationId) throw new NativeProjectImportIndeterminateError(payload.generation as number,
      'The Native host acknowledged a different operation ID; keep the recovery snapshot and do not retry.');
    return { generation: payload.generation as number, hostIncarnationId: payload.hostIncarnationId, operationId };
  }

  public async getProjectArchiveImportStatusByOperationId(operationId: string, hostIncarnationId: string): Promise<NativeProjectImportStatus> {
    if (!/^[0-9a-f]{32}$/i.test(operationId) || !isNativeHostIncarnationId(hostIncarnationId)) {
      throw new RangeError('Operation status requires a valid operation ID and host incarnation.');
    }
    const payload = await this.request<BridgeResponse>(`/v1/project/import/status-by-operation?operationId=${operationId}`, {
      headers: { 'X-Native-Host-Incarnation': hostIncarnationId },
    });
    const generation = isObject(payload) ? payload.generation : undefined;
    const status = await this.validateProjectImportStatusPayload(payload, generation);
    if (!isObject(payload) || payload.operationId !== operationId || payload.hostIncarnationId !== hostIncarnationId ||
        typeof payload.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.archiveSha256) ||
        !Number.isSafeInteger(payload.expectedProjectContentRevision) || (payload.expectedProjectContentRevision as number) < 0) {
      throw new Error('Native bridge returned an invalid operation status binding.');
    }
    return { ...status, operationId, archiveSha256: payload.archiveSha256,
      expectedProjectContentRevision: payload.expectedProjectContentRevision as number };
  }

  public async commitPreparedMemory(generation: number, hostIncarnationId: string): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new RangeError('Memory generation must be a positive safe integer.');
    if (!isNativeHostIncarnationId(hostIncarnationId)) throw new RangeError('Memory commit requires a valid host incarnation ID.');
    await this.request(`/v1/project/import/commit`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Native-Host-Incarnation': hostIncarnationId }, body: String(generation),
    });
  }

  public async getProjectArchiveImportStatus(generation: number): Promise<NativeProjectImportStatus> {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new RangeError('Project import generation must be a positive safe integer.');
    const payload = await this.request<BridgeResponse>(`/v1/project/import/status?generation=${generation}`);
    return this.validateProjectImportStatusPayload(payload, generation);
  }

  private validateProjectImportStatusPayload(payload: BridgeResponse, expectedGeneration: unknown): NativeProjectImportStatus {
    const hostImportStates = ['prepared', 'pending', 'claimed', 'committed', 'cancelled'] as const;
    if (!isObject(payload) || payload.ok !== true || !Number.isSafeInteger(expectedGeneration) || payload.generation !== expectedGeneration ||
        !hostImportStates.includes(payload.state as typeof hostImportStates[number]) ||
        (payload.hostIncarnationId !== undefined && !isNativeHostIncarnationId(payload.hostIncarnationId)) ||
        (payload.error !== undefined && typeof payload.error !== 'string') ||
        (payload.projectContentRevision !== undefined && (!Number.isSafeInteger(payload.projectContentRevision) ||
          (payload.projectContentRevision as number) < 0)) ||
        (payload.state === 'committed' && !Number.isSafeInteger(payload.projectContentRevision))) {
      throw new Error('Native bridge returned an invalid project-import status.');
    }
    return {
      ok: true,
      generation: expectedGeneration as number,
      state: payload.state as NativeProjectImportState,
      ...(isNativeHostIncarnationId(payload.hostIncarnationId) ? { hostIncarnationId: payload.hostIncarnationId } : {}),
      ...(typeof payload.error === 'string' && payload.error.length > 0 ? { error: payload.error } : {}),
      ...(Number.isSafeInteger(payload.projectContentRevision)
        ? { projectContentRevision: payload.projectContentRevision as number } : {}),
    };
  }

  public async cancelProjectArchiveImport(generation: number, hostIncarnationId: string): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new RangeError('Project import generation must be a positive safe integer.');
    if (!isNativeHostIncarnationId(hostIncarnationId)) throw new RangeError('Project import cancellation requires a valid host incarnation ID.');
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/project/import/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'X-Native-Host-Incarnation': hostIncarnationId },
        body: JSON.stringify({ generation }),
      });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }
    // A 409 can mean the callback has claimed the transaction. Callers must
    // poll status and must never treat that response as a completed cancel.
    if (!response.ok && response.status !== 409) throw await this.readHttpError(response, 'Native project import cancellation failed');
  }

  /** Wait for callback commit; cancellation only succeeds while the generation is pending. */
  public async waitForProjectArchiveImport(
    generation: number,
    expectedHostIncarnationId: string,
    timeoutMs = 10_000,
    operationStillCurrent: () => boolean = () => true,
  ): Promise<NativeProjectImportStatus> {
    if (!isNativeHostIncarnationId(expectedHostIncarnationId)) {
      throw new RangeError('Project import polling requires its accepted host incarnation ID.');
    }
    const readStatus = async (): Promise<NativeProjectImportStatus> => {
      try {
        const status = await this.getProjectArchiveImportStatus(generation);
        if (!isNativeHostIncarnationId(status.hostIncarnationId) || status.hostIncarnationId !== expectedHostIncarnationId) {
          return { ...status, state: 'unavailable', hostIncarnationMismatch: true };
        }
        return status;
      } catch (error) {
        // Once the upload has returned a generation, a lost bridge response
        // cannot prove rollback: the audio callback may still commit it.
        throw new NativeProjectImportIndeterminateError(generation, error);
      }
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await readStatus();
      if (status.state === 'committed' || status.state === 'cancelled' || status.state === 'unavailable') return status;
      // A project operation can become stale after the archive has been
      // accepted but before the audio callback claims it. Cancel only while
      // the host still reports Pending; a claimed generation is never treated
      // as cancelled or rolled back by the client.
      if (status.state === 'pending' && !operationStillCurrent()) {
        try {
          await this.cancelProjectArchiveImport(generation, expectedHostIncarnationId);
        } catch (error) {
          throw new NativeProjectImportIndeterminateError(generation, error);
        }
        const afterCancel = await readStatus();
        if (afterCancel.state === 'committed' || afterCancel.state === 'cancelled') return afterCancel;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    const latest = await readStatus();
    if (latest.state === 'committed' || latest.state === 'cancelled' || latest.state === 'unavailable') return latest;
    if (latest.state === 'pending') {
      try {
        await this.cancelProjectArchiveImport(generation, expectedHostIncarnationId);
      } catch (error) {
        throw new NativeProjectImportIndeterminateError(generation, error);
      }
      const afterCancel = await readStatus();
      if (afterCancel.state === 'committed' || afterCancel.state === 'cancelled') return afterCancel;
    }
    // Once claimed, cancellation cannot safely release callback-owned memory.
    // Keep the generation visible so the caller can poll instead of retrying.
    throw new NativeProjectImportIndeterminateError(generation);
  }

  /** Gets the small loop description before requesting any rendered PCM bytes. */
  public async getTrackMetadata(trackId = 1): Promise<NativeTrackMetadata> {
    assertNativeTrackId(trackId);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/export/track-metadata?trackId=${trackId}`, { method: 'GET' });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }
    if (!response.ok) throw await this.readHttpError(response, 'Native track metadata request failed');

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Native bridge returned invalid track metadata JSON.');
    }
    if (!isObject(payload) || payload.ok !== true || payload.trackId !== trackId ||
        !Number.isInteger(payload.sampleRate) || (payload.sampleRate as number) < 8_000 || (payload.sampleRate as number) > 192_000 ||
        !Number.isSafeInteger(payload.frameCount) || (payload.frameCount as number) <= 0 || payload.channels !== 2 ||
        (payload.originalTempoBpm !== undefined && payload.originalTempoBpm !== null &&
          (typeof payload.originalTempoBpm !== 'number' || !Number.isFinite(payload.originalTempoBpm) || payload.originalTempoBpm < 40 || payload.originalTempoBpm > 300))) {
      throw new Error('Native bridge returned invalid HQ render track metadata.');
    }
    return {
      trackId,
      sampleRate: payload.sampleRate as number,
      frameCount: payload.frameCount as number,
      channels: 2,
      // Older Native hosts omit this field. Treat that protocol generation as
      // unknown provenance instead of inferring a tempo from current state.
      originalTempoBpm: payload.originalTempoBpm === undefined ? null : payload.originalTempoBpm as number | null,
      ...(Number.isSafeInteger(payload.contentRevision) && (payload.contentRevision as number) >= 0
        ? { contentRevision: payload.contentRevision as number } : {}),
    };
  }

  /** Requests rendered interleaved Float32LE PCM from the Native Rubber Band renderer. */
  public async renderHqTrack(
    trackId: number,
    options: NativeHqRenderOptions,
    expectedMetadata?: NativeTrackMetadata,
  ): Promise<NativeHqRenderResult> {
    assertNativeTrackId(trackId);
    if (!Number.isFinite(options.semitones) || options.semitones < -24 || options.semitones > 24) {
      throw new RangeError('semitones must be between -24 and +24');
    }
    if (!Number.isFinite(options.playbackRate) || options.playbackRate < 0.5 || options.playbackRate > 2) {
      throw new RangeError('playbackRate must be between 0.5 and 2');
    }
    if (options.engine !== 'R2' && options.engine !== 'R3') {
      throw new TypeError('Native HQ engine must be R2 or R3.');
    }
    if (!Number.isSafeInteger(options.memoryBudgetBytes) || options.memoryBudgetBytes <= 0) {
      throw new RangeError('HQ WAV export memory budget must be a positive safe integer number of bytes');
    }
    if (options.format !== 'pcm16' && options.format !== 'pcm24' && options.format !== 'float32') {
      throw new TypeError(`Unsupported WAV sample format: ${String(options.format)}`);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/export/hq-render?trackId=${trackId}`, {
        method: 'POST',
        // text/plain is a CORS-safelisted content type. The bridge parses the
        // JSON body itself; avoiding a JSON preflight keeps this local-host
        // endpoint usable from the app's separate origin without OPTIONS.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(options),
      });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }
    if (!response.ok) throw await this.readHttpError(response, 'Native HQ render request failed');

    const sampleRateHeader = response.headers.get('X-Native-Loop-Sample-Rate');
    const frameCountHeader = response.headers.get('X-Native-Loop-Frame-Count');
    const channelsHeader = response.headers.get('X-Native-Loop-Channels');
    const latencyHeader = response.headers.get('X-Native-HQ-Latency-Samples');
    const sampleRate = Number(sampleRateHeader);
    const frameCount = Number(frameCountHeader);
    const channels = Number(channelsHeader);
    const sampleFormat = response.headers.get('X-Native-Loop-Sample-Format');
    const returnedEngine = response.headers.get('X-Native-HQ-Engine');
    const latencySamples = Number(latencyHeader);
    if (sampleRateHeader == null || frameCountHeader == null || channelsHeader == null || latencyHeader == null ||
        !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
        !Number.isSafeInteger(frameCount) || frameCount <= 0 || channels !== 2 ||
        sampleFormat !== 'float32le' || returnedEngine !== options.engine || latencySamples !== 0) {
      await cancelResponseBody(response);
      throw new Error('Native HQ renderer returned invalid output metadata or engine headers.');
    }
    if (expectedMetadata && (sampleRate !== expectedMetadata.sampleRate ||
        frameCount !== Math.ceil(expectedMetadata.frameCount / options.playbackRate) || channels !== expectedMetadata.channels)) {
      await cancelResponseBody(response);
      throw new Error('Native HQ renderer output does not match the admitted loop metadata and playback rate.');
    }

    const bytes = await response.arrayBuffer();
    const sampleCount = frameCount * channels;
    if (!Number.isSafeInteger(sampleCount) || bytes.byteLength !== sampleCount * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('Native HQ renderer returned a truncated or oversized PCM response.');
    }
    const isLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    let samples: Float32Array;
    if (isLittleEndian) {
      samples = new Float32Array(bytes);
    } else {
      const view = new DataView(bytes);
      samples = new Float32Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        samples[sample] = view.getFloat32(sample * Float32Array.BYTES_PER_ELEMENT, true);
      }
    }
    return { trackId, sampleRate, frameCount, channels: 2, samples, engine: options.engine, latencySamples: 0 };
  }

  public async getLoopSnapshot(
    trackId = 1,
    beforeRead?: (metadata: NativeLoopSnapshotMetadata) => void,
  ): Promise<NativeLoopSnapshot> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      throw new RangeError('Native track ID must be an integer between 1 and 5.');
    }
    let response: Response;
    try {
      // Keep this a simple GET so the loopback bridge does not require a CORS
      // preflight. The bridge exposes only the four metadata headers below to
      // trusted loopback app origins.
      const trackQuery = trackId === 1 ? '' : `?trackId=${trackId}`;
      response = await fetch(`${this.baseUrl}/v1/export/loop-snapshot${trackQuery}`, { method: 'GET' });
    } catch (error) {
      throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
    }

    if (!response.ok) {
      let message = `Native loop snapshot request failed with HTTP ${response.status}.`;
      try {
        const payload = await response.json() as BridgeResponse;
        if (payload.error) message = payload.error;
      } catch {
        // Retain the status-based message for a non-JSON bridge error.
      }
      throw new Error(message);
    }

    const sampleRate = Number(response.headers.get('X-Native-Loop-Sample-Rate'));
    const frameCount = Number(response.headers.get('X-Native-Loop-Frame-Count'));
    const channelHeader = response.headers.get('X-Native-Loop-Channels');
    const channelsValue = channelHeader == null ? 1 : Number(channelHeader);
    const channels = channelsValue === 2 ? 2 : channelsValue === 1 ? 1 : 0;
    const sampleFormat = response.headers.get('X-Native-Loop-Sample-Format');
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 ||
        !Number.isSafeInteger(frameCount) || frameCount <= 0 || (channels !== 1 && channels !== 2) ||
        sampleFormat !== 'float32le') {
      throw new Error('Native bridge returned invalid loop snapshot metadata.');
    }

    // Native responses expose validated size metadata before their raw PCM
    // body is materialized as an ArrayBuffer. Callers can reject an over-budget
    // render here, leaving both the Native loop and the large response body
    // untouched.
    try {
      beforeRead?.({ sampleRate, frameCount, channels });
    } catch (error) {
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the admission error; cancelling is only a best-effort release.
      }
      throw error;
    }

    const bytes = await response.arrayBuffer();
    const sampleCount = frameCount * channels;
    if (!Number.isSafeInteger(sampleCount) || bytes.byteLength !== sampleCount * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('Native bridge returned a truncated or oversized loop snapshot.');
    }

    const isLittleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    let samples: Float32Array;
    if (isLittleEndian) {
      samples = new Float32Array(bytes);
    } else {
      const view = new DataView(bytes);
      samples = new Float32Array(sampleCount);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        samples[sample] = view.getFloat32(sample * Float32Array.BYTES_PER_ELEMENT, true);
      }
    }

    const revisionHeader = response.headers.get('X-Native-Loop-Revision');
    const contentRevision = revisionHeader == null ? undefined : Number(revisionHeader);
    return {
      sampleRate, frameCount, channels, samples,
      ...(contentRevision !== undefined && Number.isSafeInteger(contentRevision) && contentRevision >= 0 ? { contentRevision } : {}),
    };
  }

  public async applyConfig(config: NativeConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/config/apply', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async startEngine(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/engine/start', { method: 'POST' });
  }

  public async stopEngine(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/engine/stop', { method: 'POST' });
  }

  public async setRecordAction(recAction: 'REC->PLAY' | 'REC->DUB'): Promise<NativeStatus> {
    if (recAction !== 'REC->PLAY' && recAction !== 'REC->DUB') throw new RangeError('Invalid REC ACTION');
    let status = await this.request<NativeStatus>('/v1/record/settings', { method: 'POST', body: JSON.stringify({ recAction }) });
    const revision = status.nativeRecordPlay?.requestedRevision;
    if (!Number.isSafeInteger(revision)) throw new Error('Native REC ACTION acknowledgement is unavailable.');
    const deadline = Date.now() + NATIVE_BRIDGE_REQUEST_TIMEOUT_MS;
    for (;;) {
      const settings = status.nativeRecordPlay;
      if (settings?.requestedRevision === revision && settings?.appliedRevision === revision && settings?.recAction === recAction) return status;
      if (Date.now() >= deadline) throw new Error('Native REC ACTION callback acknowledgement timed out; do not resend automatically.');
      await new Promise(resolve => setTimeout(resolve, 10)); status = await this.getStatus();
    }
  }

  public async finishRecordingTrack(trackId: number, tempo?: NativeRecordTempoToken): Promise<NativeStatus> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) throw new RangeError('Invalid Native REC completion track');
    const body = { trackId, ...(tempo ? { tempoBpm: tempo.bpm, tempoRevision: tempo.revision } : {}) };
    let status = await this.request<NativeStatus>('/v1/transport/finish-record', { method: 'POST', body: JSON.stringify(body) });
    const revision = status.nativeRecordPlay?.finishRequested[trackId - 1];
    if (!Number.isSafeInteger(revision) || revision! <= 0) throw new Error('Native REC completion acknowledgement is unavailable.');
    const deadline = Date.now() + NATIVE_BRIDGE_REQUEST_TIMEOUT_MS;
    for (;;) {
      if (status.nativeRecordPlay?.finishCancelled?.[trackId - 1] === revision) throw new Error('Native REC completion was cancelled by a runtime reset; recording state must be checked before retry.');
      const track = status.nativeTracks?.find(track => track.trackId === trackId);
      const expected = status.nativeRecordPlay?.recAction === 'REC->DUB' ? 'Overdubbing' : 'Playing';
      if (status.nativeRecordPlay?.finishApplied[trackId - 1] === revision && track && (track.state === expected || track.state === 'Empty')) return status;
      if (Date.now() >= deadline) throw new Error('Native REC completion callback acknowledgement timed out; do not resend automatically.');
      await new Promise(resolve => setTimeout(resolve, 10)); status = await this.getStatus();
    }
  }

  public async confirmTrackTempoProvenance(trackId: number, expectedContentRevision: number,
      tempo: NativeRecordTempoToken, expectedStopRevision?: number): Promise<NativeStatus> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) throw new RangeError('Invalid Native REC tempo confirmation track.');
    if (!Number.isSafeInteger(expectedContentRevision) || expectedContentRevision < 0) throw new RangeError('Invalid Native REC tempo content revision.');
    if (expectedStopRevision !== undefined && (!Number.isSafeInteger(expectedStopRevision) || expectedStopRevision <= 0)) {
      throw new RangeError('Invalid Native STOP commit revision for tempo confirmation.');
    }
    let status = await this.request<NativeStatus>('/v1/transport/record-tempo/confirm', {
      method: 'POST', body: JSON.stringify({ trackId, expectedContentRevision, tempoBpm: tempo.bpm, tempoRevision: tempo.revision,
        ...(expectedStopRevision === undefined ? {} : { stopRevision: expectedStopRevision }) }),
    });
    const revision = status.nativeRecordTempoProvenance?.acceptedRequestRevision;
    if (!Number.isSafeInteger(revision) || revision! <= 0) throw new Error('Native REC tempo confirmation acknowledgement is unavailable; provenance remains unknown.');
    const deadline = Date.now() + NATIVE_BRIDGE_REQUEST_TIMEOUT_MS;
    for (;;) {
      const provenance = status.nativeRecordTempoProvenance;
      if (provenance && provenance.appliedRevision?.[trackId - 1] === revision) {
        if (provenance.acceptedRevision?.[trackId - 1] !== revision) throw new Error('Native REC tempo confirmation was rejected; provenance remains unknown.');
        return status;
      }
      if (Date.now() >= deadline) throw new Error('Native REC tempo confirmation callback acknowledgement timed out; provenance remains unknown.');
      await new Promise(resolve => setTimeout(resolve, 10)); status = await this.getStatus();
    }
  }

  public async setMixerLevel(channel: number, percent: number): Promise<NativeStatus> {
    if (!Number.isInteger(channel) || channel < 0 || channel > 6 || !Number.isInteger(percent) || percent < 0 || percent > 200) throw new RangeError("Invalid mixer channel or level");
    return this.request<NativeStatus>('/v1/mixer/level', { method: 'POST', body: JSON.stringify({ channel, percent }) });
  }

  public async record(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/record', { method: 'POST' });
  }

  public async recordTrack(trackId: number, tempo?: NativeRecordTempoToken): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/record', trackId, tempo);
  }

  public async scheduleRhythmRecordOrStop(trackId: number, action: 'record' | 'stop', phase: {
      absoluteFrame: number; epoch: number; settingsRevision: number }, expectedHostIncarnationId?: string): Promise<NativeStatus> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || !['record', 'stop'].includes(action)
      || !Number.isSafeInteger(phase.absoluteFrame) || phase.absoluteFrame < 0
      || !Number.isSafeInteger(phase.epoch) || phase.epoch < 0
      || !Number.isSafeInteger(phase.settingsRevision) || phase.settingsRevision < 0) {
      throw new RangeError('Invalid Rhythm-scheduled Native REC/STOP request.');
    }
    if (this.pendingRhythmSchedule) throw new NativeRhythmScheduleOutcomeUnknownError(this.pendingRhythmSchedule, null,
      new Error('An earlier scheduled request is unresolved; reconcile it before submitting another transport command.'));
    const intentId = createNativeRhythmIntentId();
    const before = await this.getStatus();
    const beforeItem = before.nativeLoopFrameScheduling?.requests?.[trackId - 1];
    if (!isNativeHostIncarnationId(before.hostIncarnationId) ||
        (expectedHostIncarnationId !== undefined && before.hostIncarnationId !== expectedHostIncarnationId) || !beforeItem ||
        !Number.isSafeInteger(beforeItem.requestedRevision) || beforeItem.requestedRevision < 0) {
      throw new Error('Native status lacks the host incarnation or Rhythm schedule revision baseline; request was not submitted.');
    }
    const baselineRevision = beforeItem.requestedRevision;
    const baselineHostIncarnationId = before.hostIncarnationId!;
    const intent = (revision: number | null, hostIncarnationId = baselineHostIncarnationId): NativeRhythmScheduleReceipt => ({
      trackId, action, revision, baselineRevision, absoluteFrame: phase.absoluteFrame,
      phaseEpoch: phase.epoch, settingsRevision: phase.settingsRevision, hostIncarnationId, intentId,
    });
    let status: NativeStatus;
    try {
      status = await this.request<NativeStatus>('/v1/transport/rhythm-schedule', { method: 'POST',
        body: JSON.stringify({ trackId, action, absoluteFrame: phase.absoluteFrame, phaseEpoch: phase.epoch,
          settingsRevision: phase.settingsRevision, intentId, hostIncarnationId: baselineHostIncarnationId,
          expectedRevision: baselineRevision }) });
    } catch (error) {
      if (error instanceof NativeBridgeHttpError && error.status >= 400 && error.status < 500) throw error;
      const reconciled = error instanceof NativeBridgeRequestTimeoutError ? error.reconciledStatus : null;
      const acceptedTrackId = reconciled?.nativeLoopFrameScheduling?.acceptedTrackId;
      const acceptedRevision = reconciled?.nativeLoopFrameScheduling?.acceptedRevision;
      const acceptedItem = reconciled?.nativeLoopFrameScheduling?.requests?.[trackId - 1];
      if (acceptedTrackId === trackId && Number.isSafeInteger(acceptedRevision) && acceptedRevision! > 0 &&
          acceptedItem?.requestedRevision === acceptedRevision && this.rhythmScheduleMatchesIntent(acceptedItem, intent(acceptedRevision!))) {
        const receipt = intent(acceptedRevision!, reconciled?.hostIncarnationId ?? '');
        this.pendingRhythmSchedule = receipt;
        if (!isNativeHostIncarnationId(receipt.hostIncarnationId)) {
          throw new NativeRhythmScheduleOutcomeUnknownError(receipt, reconciled,
            new Error('The host omitted its incarnation ID; the accepted revision cannot be safely cancelled or correlated.'));
        }
        return this.reconcileRhythmScheduledLoop(receipt, error);
      }
      const unresolved = intent(null);
      this.pendingRhythmSchedule = unresolved;
      throw new NativeRhythmScheduleOutcomeUnknownError(unresolved, reconciled, error);
    }
    const revision = status.nativeLoopFrameScheduling?.acceptedRevision;
    const acceptedItem = status.nativeLoopFrameScheduling?.requests?.[trackId - 1];
    if (status.hostIncarnationId !== baselineHostIncarnationId || status.nativeLoopFrameScheduling?.acceptedTrackId !== trackId || !Number.isSafeInteger(revision) || revision! <= 0 ||
        acceptedItem?.requestedRevision !== revision || !this.rhythmScheduleMatchesIntent(acceptedItem, intent(revision!))) {
      const unresolved = intent(null, status.hostIncarnationId ?? before.hostIncarnationId);
      this.pendingRhythmSchedule = unresolved;
      throw new NativeRhythmScheduleOutcomeUnknownError(unresolved, status,
        new Error('Native did not return a status receipt matching the submitted schedule intent.'));
    }
    const receipt = intent(revision!, status.hostIncarnationId ?? '');
    this.pendingRhythmSchedule = receipt;
    if (!isNativeHostIncarnationId(receipt.hostIncarnationId)) {
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status,
        new Error('The host omitted its incarnation ID; this accepted revision cannot be safely correlated.'));
    }
    return this.waitForRhythmSchedule({ ...receipt, revision: revision! });
  }

  public async reconcilePendingRhythmSchedule(): Promise<NativeStatus> {
    const receipt = this.pendingRhythmSchedule;
    if (!receipt) {
      // A page reload can discard the in-memory receipt while the Native host
      // still owns the accepted callback request. Rebuild only from a complete
      // status record tied to the currently reported host incarnation.
      const status = await this.getStatus();
      const scheduling = status.nativeLoopFrameScheduling;
      const hostIncarnationId = status.hostIncarnationId;
      if (!isNativeHostIncarnationId(hostIncarnationId) || !Array.isArray(scheduling?.requests)) {
        throw new NativeRhythmScheduleRecoveryBlockedError(status,
          'Native status cannot identify a pending Rhythm schedule receipt; no transport action was retried.');
      }
      const pending = scheduling.requests.flatMap((item, index) => item && item.requestedRevision > 0 &&
        item.appliedRevision !== item.requestedRevision && item.cancelledRevision !== item.requestedRevision &&
        item.faultRevision !== item.requestedRevision ? [{ item, trackId: index + 1 }] : []);
      if (pending.length === 0 && scheduling.requests.some((item) => item?.requestedRevision > 0)) return status;
      if (pending.length !== 1) {
        throw new NativeRhythmScheduleRecoveryBlockedError(status,
          'Native status contains no uniquely pending Rhythm schedule; no transport action was retried.');
      }
      const { item, trackId } = pending[0]!;
      if (!['record', 'stop'].includes(item.requestedAction) ||
          !Number.isSafeInteger(item.requestedAbsoluteFrame) || !Number.isSafeInteger(item.requestedPhaseEpoch) ||
          !Number.isSafeInteger(item.requestedSettingsRevision) || typeof item.requestedIntentId !== 'string') {
        throw new NativeRhythmScheduleRecoveryBlockedError(status,
          'Native status has an incomplete pending Rhythm schedule receipt; no transport action was retried.');
      }
      const revision = item.requestedRevision;
      const orphanReceipt: NativeRhythmScheduleReceipt = { trackId, action: item.requestedAction, revision, baselineRevision: revision - 1,
        absoluteFrame: item.requestedAbsoluteFrame, phaseEpoch: item.requestedPhaseEpoch,
        settingsRevision: item.requestedSettingsRevision, hostIncarnationId, intentId: item.requestedIntentId };
      // Status proves what the host is doing, but not that this tab owns the
      // command. Never cancel another tab's future REC/STOP from a reconstructed
      // receipt. Block until the exact request reaches a terminal state.
      throw new NativeRhythmScheduleOutcomeUnknownError(orphanReceipt, status,
        new Error('A pending Native Rhythm schedule has no local owner receipt; this tab will not cancel or replace it.'));
    }
    return this.reconcileRhythmScheduledLoop(receipt, new Error('Reconciled after reconnect.'));
  }

  public async cancelRhythmScheduledLoop(receipt: NativeRhythmScheduleReceipt & { revision: number }): Promise<NativeStatus> {
    const { trackId, revision } = receipt;
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5 || revision === null || !Number.isSafeInteger(revision) || revision <= 0 ||
        !isNativeHostIncarnationId(receipt.hostIncarnationId)) {
      throw new RangeError('Invalid Native Rhythm-scheduled cancellation token.');
    }
    const existing = await this.getStatus();
    if (existing.hostIncarnationId !== receipt.hostIncarnationId) {
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, existing,
        new Error('Native host incarnation changed; this revision cannot be cancelled against the restarted host.'));
    }
    const itemBeforeCancel = existing.nativeLoopFrameScheduling?.requests?.[trackId - 1];
    if (itemBeforeCancel?.requestedRevision !== revision || itemBeforeCancel.requestedIntentId !== receipt.intentId) {
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, existing,
        new Error('Native status does not identify this exact schedule intent; refusing cancellation.'));
    }
    if (itemBeforeCancel?.appliedRevision === revision) {
      if (this.pendingRhythmSchedule?.revision === revision) this.pendingRhythmSchedule = null;
      return existing;
    }
    if (itemBeforeCancel?.cancelledRevision === revision) {
      if (this.pendingRhythmSchedule?.revision === revision) this.pendingRhythmSchedule = null;
      return existing;
    }
    if (itemBeforeCancel?.faultRevision === revision) {
      if (this.pendingRhythmSchedule?.revision === revision) this.pendingRhythmSchedule = null;
      throw new Error(`Native Rhythm-scheduled request failed before cancellation (fault ${itemBeforeCancel.fault}).`);
    }
    if (itemBeforeCancel?.requestedRevision !== revision) {
      throw new Error('Native Rhythm-scheduled revision is absent or superseded; inspect track state before any retry.');
    }
    if (itemBeforeCancel.requestedIntentId !== receipt.intentId) {
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, existing,
        new Error('Native status intent ID does not match this receipt; refusing to cancel another request.'));
    }
    let status: NativeStatus;
    try {
      status = await this.request<NativeStatus>('/v1/transport/rhythm-schedule/cancel', { method: 'POST',
        body: JSON.stringify({ trackId, revision, hostIncarnationId: receipt.hostIncarnationId, intentId: receipt.intentId }) });
    } catch (error) {
      let reconciled = error instanceof NativeBridgeRequestTimeoutError ? error.reconciledStatus : null;
      if (!reconciled) {
        try { reconciled = await this.getStatus(); } catch { /* Preserve the host-bound receipt for recovery after reconnect. */ }
      }
      if (reconciled) return this.finishRhythmCancellationReconcile(trackId, revision, receipt, reconciled, error, false);
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, null, error);
    }
    const deadline = Date.now() + NATIVE_BRIDGE_REQUEST_TIMEOUT_MS;
    for (;;) {
      if (status.hostIncarnationId !== receipt.hostIncarnationId) {
        throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status,
          new Error('Native host restarted during cancellation acknowledgement polling.'));
      }
      const item = status.nativeLoopFrameScheduling?.requests?.[trackId - 1];
      if (item?.requestedRevision !== revision || item.requestedIntentId !== receipt.intentId) {
        throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status,
          new Error('Native status revision or intent changed during cancellation acknowledgement polling.'));
      }
      if (item?.cancelledRevision === revision) {
        if (this.pendingRhythmSchedule?.revision === revision) this.pendingRhythmSchedule = null;
        return status;
      }
      if (item?.appliedRevision === revision || item?.faultRevision === revision) {
        if (this.pendingRhythmSchedule?.revision === revision) this.pendingRhythmSchedule = null;
        return status;
      }
      if (Date.now() >= deadline) throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status,
        new Error('Native Rhythm-scheduled cancellation acknowledgement timed out.'));
      await new Promise(resolve => setTimeout(resolve, 10));
      try { status = await this.getStatus(); }
      catch (error) {
        let latest: NativeStatus | null = null;
        try { latest = await this.getStatus(); } catch { /* Preserve the last receipt when the host remains unreachable. */ }
        const latestItem = latest?.nativeLoopFrameScheduling?.requests?.[trackId - 1];
        if (latest && (latest.hostIncarnationId !== receipt.hostIncarnationId ||
            latestItem?.requestedRevision !== revision || latestItem.requestedIntentId !== receipt.intentId)) {
          throw new NativeRhythmScheduleOutcomeUnknownError(receipt, latest,
            new Error('Native host or intent changed while reconciling a lost cancellation response.'));
        }
        throw new NativeRhythmScheduleOutcomeUnknownError(receipt, latest ?? status, error);
      }
    }
  }

  private async waitForRhythmSchedule(receipt: NativeRhythmScheduleReceipt & { revision: number }): Promise<NativeStatus> {
    const deadline = Date.now() + NATIVE_BRIDGE_REQUEST_TIMEOUT_MS;
    let status: NativeStatus | null = null;
    try {
      for (;;) {
        status = await this.getStatus();
        if (status.hostIncarnationId !== receipt.hostIncarnationId) throw new Error('Native host restarted while this scheduled request was pending.');
        const item = status.nativeLoopFrameScheduling?.requests?.[receipt.trackId - 1];
        if (!item || item.requestedRevision !== receipt.revision) throw new Error('Native Rhythm-scheduled request was superseded; inspect track state.');
        if (item.requestedIntentId !== receipt.intentId) throw new Error('Native Rhythm schedule intent ID does not match the accepted request.');
        if (item.appliedRevision === receipt.revision) {
          if (item.appliedAbsoluteFrame !== receipt.absoluteFrame) throw new Error('Native callback ACK frame differs from the scheduled transition frame.');
          this.pendingRhythmSchedule = null;
          return status;
        }
        if (item.cancelledRevision === receipt.revision) {
          this.pendingRhythmSchedule = null;
          throw new Error('Native Rhythm-scheduled request was cancelled before dispatch.');
        }
        if (item.faultRevision === receipt.revision) {
          this.pendingRhythmSchedule = null;
          throw new Error(`Native Rhythm-scheduled REC/STOP failed (fault ${item.fault}).`);
        }
        if (Date.now() >= deadline) throw new Error('Native callback ACK wait timed out.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) {
      try {
        const reconciled = status ?? await this.getStatus();
        return await this.finishRhythmCancellationReconcile(receipt.trackId, receipt.revision, receipt, reconciled, error);
      } catch (reconcileError) {
        if (reconcileError instanceof NativeRhythmScheduleOutcomeUnknownError) throw reconcileError;
        if (reconcileError instanceof NativeRhythmScheduleTerminalError) throw reconcileError;
        throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status, reconcileError);
      }
    }
  }

  private async reconcileRhythmScheduledLoop(receipt: NativeRhythmScheduleReceipt, cause: unknown): Promise<NativeStatus> {
    let lastStatus: NativeStatus | null = null;
    try {
      const status = await this.getStatus();
      lastStatus = status;
      if (status.hostIncarnationId !== receipt.hostIncarnationId) {
        throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status,
          new Error('Native host incarnation changed; this pending intent belongs to another process.'));
      }
      let resolved = receipt;
      if (resolved.revision === null) {
        const item = status.nativeLoopFrameScheduling?.requests?.[resolved.trackId - 1];
        if (!item || item.requestedRevision <= resolved.baselineRevision || !this.rhythmScheduleMatchesIntent(item, resolved)) {
          throw new NativeRhythmScheduleOutcomeUnknownError(receipt, status,
            new Error('No unique host revision matches this unresolved request intent; no cancellation was sent.'));
        }
        resolved = { ...resolved, revision: item.requestedRevision };
        this.pendingRhythmSchedule = resolved;
      }
      if (resolved.revision === null) throw new Error('Could not bind the pending request to a host revision.');
      const exact = { ...resolved, revision: resolved.revision };
      return await this.finishRhythmCancellationReconcile(resolved.trackId, exact.revision, exact, status, cause);
    } catch (error) {
      if (error instanceof NativeRhythmScheduleOutcomeUnknownError) throw error;
      if (error instanceof NativeRhythmScheduleTerminalError) throw error;
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, lastStatus, error);
    }
  }

  private async finishRhythmCancellationReconcile(trackId: number, revision: number,
      receipt: NativeRhythmScheduleReceipt & { revision: number }, initialStatus: NativeStatus, cause: unknown,
      allowCancel = true): Promise<NativeStatus> {
    if (initialStatus.hostIncarnationId !== receipt.hostIncarnationId) {
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, initialStatus,
        new Error('Native host incarnation changed; the pending request belongs to another process.'));
    }
    const item = initialStatus.nativeLoopFrameScheduling?.requests?.[trackId - 1];
    if (!item || item.requestedRevision !== revision || item.requestedIntentId !== receipt.intentId) {
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, initialStatus,
        new Error('Native status does not identify this exact request; no cancellation was sent.'));
    }
    if (item?.appliedRevision === revision) {
      if (receipt.absoluteFrame > 0 && item.appliedAbsoluteFrame !== receipt.absoluteFrame) {
        this.pendingRhythmSchedule = null;
        throw new NativeRhythmScheduleTerminalError(receipt, initialStatus, 'appliedFrameMismatch',
          new Error(`Callback applied at frame ${item.appliedAbsoluteFrame}, expected ${receipt.absoluteFrame}; inspect track PCM before retrying.`));
      }
      this.pendingRhythmSchedule = null;
      return initialStatus;
    }
    if (item?.cancelledRevision === revision) {
      this.pendingRhythmSchedule = null;
      throw new NativeRhythmScheduleTerminalError(receipt, initialStatus, 'cancelled',
        new Error('The host confirms it was cancelled before dispatch.'));
    }
    if (item?.faultRevision === revision) {
      this.pendingRhythmSchedule = null;
      throw new NativeRhythmScheduleTerminalError(receipt, initialStatus, 'fault',
        new Error(`The host reports callback fault ${item.fault}; inspect track status.`));
    }
    if (item?.requestedRevision !== revision) throw new NativeRhythmScheduleOutcomeUnknownError(receipt, initialStatus, cause);
    if (!allowCancel) throw new NativeRhythmScheduleOutcomeUnknownError(receipt, initialStatus,
      new Error('Cancellation write timed out while this revision remains pending; reconcile status before further action.'));
    try {
      return await this.cancelRhythmScheduledLoop(receipt);
    } catch (cancelError) {
      if (cancelError instanceof NativeRhythmScheduleOutcomeUnknownError) throw cancelError;
      let latest: NativeStatus | null = null;
      try { latest = await this.getStatus(); } catch { /* The saved receipt remains available for recovery after reconnect. */ }
      const latestItem = latest?.nativeLoopFrameScheduling?.requests?.[trackId - 1];
      if (latestItem?.appliedRevision === revision) {
        this.pendingRhythmSchedule = null;
        return latest!;
      }
      if (latestItem?.cancelledRevision === revision) {
        this.pendingRhythmSchedule = null;
        throw new NativeRhythmScheduleTerminalError(receipt, latest!, 'cancelled',
          new Error('The host confirms it was cancelled before dispatch.'));
      }
      throw new NativeRhythmScheduleOutcomeUnknownError(receipt, latest ?? initialStatus, cancelError);
    }
  }

  private rhythmScheduleMatchesIntent(item: NonNullable<NonNullable<NativeStatus['nativeLoopFrameScheduling']>['requests']>[number] | undefined,
      receipt: NativeRhythmScheduleReceipt): boolean {
    return item !== undefined && item.requestedAbsoluteFrame === receipt.absoluteFrame &&
      item.requestedPhaseEpoch === receipt.phaseEpoch && item.requestedSettingsRevision === receipt.settingsRevision &&
      item.requestedAction === receipt.action && item.requestedIntentId === receipt.intentId;
  }

  public async stopTransport(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/stop', { method: 'POST' });
  }

  public async stopTrack(trackId: number, tempo?: NativeRecordTempoToken, callbackAckSupported = tempo !== undefined): Promise<NativeStatus> {
    let status = await this.requestTrackTransport('/v1/transport/stop', trackId, tempo);
    if (!callbackAckSupported) return status;
    const revision = status.nativeRecordPlay?.acceptedStopRequestRevision;
    if (!Number.isSafeInteger(revision) || revision! <= 0) throw new Error('Native STOP callback acknowledgement is unavailable.');
    const deadline = Date.now() + NATIVE_BRIDGE_REQUEST_TIMEOUT_MS;
    for (;;) {
      if (status.nativeRecordPlay?.stopRequested?.[trackId - 1] !== revision) throw new Error('Native STOP request was superseded before callback acknowledgement.');
      const appliedRevision = status.nativeRecordPlay?.stopApplied?.[trackId - 1];
      if (appliedRevision === revision) {
        const committedRevision = status.nativeRecordPlay?.stopCommittedRevision?.[trackId - 1];
        if (!Number.isSafeInteger(committedRevision)) throw new Error('Native STOP commit acknowledgement is unavailable.');
        return { ...status, nativeStopTrackAcknowledgement: {
          trackId, requestedRevision: revision!, appliedRevision: appliedRevision!, committedRevision: committedRevision!,
        } };
      }
      if (Number.isSafeInteger(appliedRevision) && appliedRevision! > revision!) {
        throw new Error('Native STOP callback acknowledgement for this request was superseded.');
      }
      if (Date.now() >= deadline) throw new Error('Native STOP callback acknowledgement timed out; do not resend automatically.');
      await new Promise(resolve => setTimeout(resolve, 10)); status = await this.getStatus();
    }
  }

  public async play(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/play', { method: 'POST' });
  }

  public async playTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/play', trackId);
  }

  public async toggleOverdub(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/overdub-toggle', { method: 'POST' });
  }

  public async toggleTrackOverdub(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/overdub-toggle', trackId);
  }

  public async clear(): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/transport/clear', { method: 'POST' });
  }

  public async clearTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/clear', trackId);
  }

  public async undoTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/undo', trackId);
  }

  public async redoTrack(trackId: number): Promise<NativeStatus> {
    return this.requestTrackTransport('/v1/transport/redo', trackId);
  }

  public async setTrackMark(trackId: number, generation: number): Promise<NativeStatus> {
    return this.requestTrackMark('/v1/transport/mark-set', trackId, generation);
  }

  public async clearTrackMark(trackId: number, generation: number): Promise<NativeStatus> {
    return this.requestTrackMark('/v1/transport/mark-clear', trackId, generation);
  }

  public async setLoopTransport(trackId: number, config: NativeLoopTransportConfig, expectedRevision?: number): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new RangeError('Native loop transport expectedRevision must be a non-negative safe integer.');
    }
    if (!isNativeLoopTransportConfig(config)) {
      throw new RangeError('Native loop transport settings are outside the supported mode, Beat Shift, or Vinyl Flick ranges.');
    }
    return this.request<NativeStatus>('/v1/native-loop-transport/config', {
      method: 'POST',
      body: JSON.stringify({ trackId, ...config, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
    });
  }

  /** Applies editor-owned transport FX fields while preserving REVERSE/1SHOT and CASing the host revision. */
  public async setLoopTransportFx(trackId: number, config: NativeLoopTransportConfig): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    const before = await this.getStatus();
    const current = before.nativeMemory?.loopTransports[trackId - 1];
    const beforeTrack = before.nativeTracks?.find((track) => track.trackId === trackId);
    const expectedRevision = beforeTrack?.loopTransportRequestedRevision;
    if (!current || !Number.isInteger(current.mode) || typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        beforeTrack?.loopTransportAppliedRevision !== expectedRevision) {
      throw new Error('Native source FX update requires a settled loop-transport config and revision.');
    }
    const mode = current.mode === 0 ? 'off' : current.mode === 1 ? 'beatShift' : current.mode === 2 ? 'vinylFlick' : null;
    if (!mode) throw new Error('Native loop transport readback contains an unsupported mode.');
    const expectedMode = config.mode === 'off' ? 0 : config.mode === 'beatShift' ? 1 : 2;
    const merged: NativeLoopTransportConfig = { ...config, mode: config.mode };
    if (typeof current.oneShot === 'boolean') merged.oneShot = current.oneShot;
    else delete merged.oneShot;
    if (typeof current.reverse === 'boolean') merged.reverse = current.reverse;
    else delete merged.reverse;

    let status = await this.setLoopTransport(trackId, merged, expectedRevision);
    const accepted = status.nativeTracks?.find((track) => track.trackId === trackId)?.loopTransportAcceptedRevision;
    if (typeof accepted !== 'number' || !Number.isSafeInteger(accepted) || accepted <= expectedRevision) {
      throw new Error('Native bridge did not identify an accepted source FX revision.');
    }
    const deadline = Date.now() + 2000;
    for (;;) {
      const track = status.nativeTracks?.find((item) => item.trackId === trackId);
      const requested = track?.loopTransportRequestedRevision;
      const applied = track?.loopTransportAppliedRevision;
      const faulted = track?.loopTransportFaultRevision;
      const readback = status.nativeMemory?.loopTransports[trackId - 1];
      if (typeof requested !== 'number' || typeof applied !== 'number' || typeof faulted !== 'number' || !readback) {
        throw new Error('Native bridge omitted source FX callback readback.');
      }
      if (faulted === accepted) throw new Error('Native callback rejected the source FX update; the prior settings remain active.');
      if (requested > accepted || applied > accepted) throw new Error('Native source FX update was superseded before callback acknowledgement.');
      const preservedOneShot = current.oneShot === undefined || readback.oneShot === current.oneShot;
      const preservedReverse = current.reverse === undefined || readback.reverse === current.reverse;
      if (requested === accepted && applied === accepted && readback.mode === expectedMode && preservedOneShot && preservedReverse) {
        this.latestStatus = status;
        return status;
      }
      if (Date.now() >= deadline) throw new Error('Native source FX callback acknowledgement timed out; check the track setting before retrying.');
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await this.getStatus();
    }
  }

  /** Changes Native 1SHOT only after the callback confirms the requested revision and readback. */
  public async setOneShot(trackId: number, enabled: boolean): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (typeof enabled !== 'boolean') throw new TypeError('Native 1SHOT must be a boolean.');
    const currentStatus = await this.getStatus();
    const current = currentStatus.nativeMemory?.loopTransports[trackId - 1];
    if (!current || !Number.isInteger(current.mode)) throw new Error('This Native bridge does not advertise 1SHOT settings.');
    const currentTrack = currentStatus.nativeTracks?.find((track) => track.trackId === trackId);
    const expectedRevision = currentTrack?.loopTransportRequestedRevision;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        currentTrack?.loopTransportAppliedRevision !== expectedRevision) {
      throw new Error('Native 1SHOT requires a settled loop-transport readback; the setting was not changed.');
    }
    const mode = current.mode === 0 ? 'off' : current.mode === 1 ? 'beatShift' : current.mode === 2 ? 'vinylFlick' : null;
    if (!mode) throw new Error('Native loop transport readback contains an unsupported mode.');
    let status = await this.setLoopTransport(trackId, { ...current, mode, oneShot: enabled }, expectedRevision);
    const accepted = status.nativeTracks?.find((track) => track.trackId === trackId)?.loopTransportAcceptedRevision;
    if (typeof accepted !== 'number' || !Number.isSafeInteger(accepted) || accepted <= 0) {
      throw new Error('Native bridge did not identify the accepted 1SHOT revision.');
    }
    const deadline = Date.now() + 2000;
    for (;;) {
      const track = status.nativeTracks?.find((item) => item.trackId === trackId);
      const requested = track?.loopTransportRequestedRevision;
      const applied = track?.loopTransportAppliedRevision;
      const faulted = track?.loopTransportFaultRevision;
      const appliedOneShot = track?.loopTransportAppliedOneShot;
      const requestedOneShot = status.nativeMemory?.loopTransports[trackId - 1]?.oneShot;
      if (typeof requested !== 'number' || typeof applied !== 'number' || typeof faulted !== 'number' ||
          typeof appliedOneShot !== 'boolean' || typeof requestedOneShot !== 'boolean') {
        throw new Error('Native bridge omitted 1SHOT revision or setting readback.');
      }
      if (faulted === accepted) throw new Error('Native callback rejected the 1SHOT setting; the prior setting remains active.');
      if (requested > accepted || applied > accepted) throw new Error('Native 1SHOT request was superseded before callback acknowledgement.');
      if (requested === accepted && applied === accepted && requestedOneShot === enabled && appliedOneShot === enabled) {
        this.latestStatus = status;
        return status;
      }
      if (Date.now() >= deadline) throw new Error('Native 1SHOT callback acknowledgement timed out; check the track setting before retrying.');
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await this.getStatus();
    }
  }

  /** Changes Native REVERSE only after the callback confirms its revision and readback. */
  public async setReverse(trackId: number, enabled: boolean): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (typeof enabled !== 'boolean') throw new TypeError('Native REVERSE must be a boolean.');
    const currentStatus = await this.getStatus();
    const current = currentStatus.nativeMemory?.loopTransports[trackId - 1];
    if (!current || !Number.isInteger(current.mode)) throw new Error('This Native bridge does not advertise REVERSE settings.');
    const currentTrack = currentStatus.nativeTracks?.find((track) => track.trackId === trackId);
    const expectedRevision = currentTrack?.loopTransportRequestedRevision;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        currentTrack?.loopTransportAppliedRevision !== expectedRevision) {
      throw new Error('Native REVERSE requires a settled loop-transport readback; the setting was not changed.');
    }
    const mode = current.mode === 0 ? 'off' : current.mode === 1 ? 'beatShift' : current.mode === 2 ? 'vinylFlick' : null;
    if (!mode) throw new Error('Native loop transport readback contains an unsupported mode.');
    let status = await this.setLoopTransport(trackId, { ...current, mode, reverse: enabled }, expectedRevision);
    const accepted = status.nativeTracks?.find((track) => track.trackId === trackId)?.loopTransportAcceptedRevision;
    if (typeof accepted !== 'number' || !Number.isSafeInteger(accepted) || accepted <= 0) {
      throw new Error('Native bridge did not identify the accepted REVERSE revision.');
    }
    const deadline = Date.now() + 2000;
    for (;;) {
      const track = status.nativeTracks?.find((item) => item.trackId === trackId);
      const requested = track?.loopTransportRequestedRevision;
      const applied = track?.loopTransportAppliedRevision;
      const faulted = track?.loopTransportFaultRevision;
      const appliedReverse = track?.loopTransportAppliedReverse;
      const requestedReverse = status.nativeMemory?.loopTransports[trackId - 1]?.reverse;
      if (typeof requested !== 'number' || typeof applied !== 'number' || typeof faulted !== 'number' ||
          typeof appliedReverse !== 'boolean' || typeof requestedReverse !== 'boolean') {
        throw new Error('Native bridge omitted REVERSE revision or setting readback.');
      }
      if (faulted === accepted) throw new Error('Native callback rejected REVERSE; the prior setting remains active.');
      if (requested > accepted || applied > accepted) throw new Error('Native REVERSE request was superseded before callback acknowledgement.');
      if (requested === accepted && applied === accepted && requestedReverse === enabled && appliedReverse === enabled) {
        this.latestStatus = status;
        return status;
      }
      if (Date.now() >= deadline) throw new Error('Native REVERSE callback acknowledgement timed out; check the track setting before retrying.');
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await this.getStatus();
    }
  }

  public async setDubMode(trackId: number, mode: NativeDubMode): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (mode !== 'OVERDUB' && mode !== 'REPLACE1' && mode !== 'REPLACE2') {
      throw new RangeError('Native DUB MODE must be OVERDUB, REPLACE1, or REPLACE2.');
    }
    const status = await this.request<NativeStatus>('/v1/native-dub-mode/config', {
      method: 'POST', body: JSON.stringify({ trackId, mode }),
    });
    const readback = status.nativeTracks?.find((track) => track.trackId === trackId)?.dubMode;
    if (!readback || readback.requested !== mode || typeof readback.acceptedRevision !== 'number' ||
        typeof readback.requestedRevision !== 'number' || typeof readback.appliedRevision !== 'number' ||
        !Number.isSafeInteger(readback.acceptedRevision) || !Number.isSafeInteger(readback.requestedRevision) ||
        !Number.isSafeInteger(readback.appliedRevision) ||
        readback.acceptedRevision !== readback.requestedRevision || readback.appliedRevision > readback.requestedRevision) {
      throw new Error('Native bridge did not identify the accepted DUB MODE revision.');
    }
    return status;
  }

  public async setNativeBounceSettings(settings: { bounceSw: boolean; bounceIn: boolean[]; bounceTrack: boolean[] }): Promise<NativeStatus> {
    if (typeof settings.bounceSw !== 'boolean' || settings.bounceIn.length !== 5 || settings.bounceTrack.length !== 5
      || settings.bounceIn.some((value) => typeof value !== 'boolean') || settings.bounceTrack.some((value) => typeof value !== 'boolean')) {
      throw new RangeError('Native Bounce requires BOUNCE SW and five BOUNCE IN / BOUNCE TRACK switches.');
    }
    const status = await this.request<NativeStatus>('/v1/native-bounce/settings', { method: 'POST', body: JSON.stringify(settings) });
    const revision = status.nativeBounce?.acceptedRevision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || !status.nativeBounce) throw new Error('Native bridge did not identify the accepted Bounce revision.');
    const acknowledged = (candidate: NativeStatus): boolean => {
      const bounce = candidate.nativeBounce;
      if (!bounce) throw new Error('Native bridge omitted Bounce readback.');
      if (bounce.requestedRevision > revision || bounce.appliedRevision > revision) {
        throw new Error('Native Bounce request was superseded before its callback acknowledgement.');
      }
      if (bounce.appliedRevision !== revision) return false;
      if (bounce.requestedRevision !== revision || bounce.bounceSw !== settings.bounceSw
        || bounce.bounceIn.length !== 5 || bounce.bounceTrack.length !== 5
        || bounce.bounceIn.some((value, index) => value !== settings.bounceIn[index])
        || bounce.bounceTrack.some((value, index) => value !== settings.bounceTrack[index])) {
        throw new Error('Native Bounce applied revision did not match the requested switches.');
      }
      return true;
    };
    if (acknowledged(status)) return status;
    const deadline = Date.now() + 2500;
    let latest = status;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      latest = await this.getStatus();
      if (acknowledged(latest)) return latest;
    }
    throw new Error('Native Bounce callback acknowledgement timed out; read back the current switches before retrying.');
  }

  private async requestTrackTransport(path: string, trackId: number, tempo?: NativeRecordTempoToken): Promise<NativeStatus> {
    if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
      throw new RangeError('Native track ID must be an integer between 1 and 5.');
    }
    // Keep the original track-one routes unchanged for compatibility; higher
    // track IDs use the same command endpoint with an explicit 1-based selector.
    const params = new URLSearchParams();
    if (trackId !== 1) params.set('trackId', String(trackId));
    if (tempo) {
      if (!Number.isFinite(tempo.bpm) || tempo.bpm < 40 || tempo.bpm > 300 || !Number.isSafeInteger(tempo.revision) || tempo.revision < 0) {
        throw new RangeError('Native record tempo token must contain BPM 40..300 and a nonnegative safe revision.');
      }
      params.set('tempoBpm', String(tempo.bpm));
      params.set('tempoRevision', String(tempo.revision));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<NativeStatus>(`${path}${suffix}`, { method: 'POST' });
  }

  private async requestTrackMark(path: string, trackId: number, generation: number): Promise<NativeStatus> {
    assertNativeTrackId(trackId);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError('Native mark operation generation must be a positive safe integer.');
    }
    return this.request<NativeStatus>(`${path}?trackId=${trackId}&generation=${generation}`, { method: 'POST' });
  }

  public async setMonitoring(enabled: boolean): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/monitoring', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }

  public async setFractionalDelay(config: NativeFractionalDelayConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/fractional-delay', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setCompressor(config: NativeCompressorConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/compressor', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setChorus(config: NativeChorusConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/chorus', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setAutoPan(config: NativeAutoPanConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-fx/auto-pan', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setRhythm(config: NativeRhythmConfig, expectedHostIncarnationId?: string): Promise<NativeStatus> {
    if (!isNativeRhythmConfig(config)) {
      throw new RangeError('Native rhythm settings require BPM 40–300, pattern 1–240, kit 1–16, variation A–D, a supported section, swing 50–75, quantize 1/16|1/8|1/4, and volume 0–100.');
    }
    if (expectedHostIncarnationId !== undefined && !isNativeHostIncarnationId(expectedHostIncarnationId)) {
      throw new RangeError('Native rhythm synchronization requires a valid host incarnation ID.');
    }
    return this.request<NativeStatus>('/v1/native-rhythm/config', {
      method: 'POST',
      ...(expectedHostIncarnationId ? { headers: { 'X-Native-Host-Incarnation': expectedHostIncarnationId } } : {}),
      body: JSON.stringify(config),
    });
  }

  public async setPitch(config: NativePitchConfig): Promise<NativeStatus> {
    return this.request<NativeStatus>('/v1/native-pitch/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async setCatalogSlot(config: NativeCatalogSlotConfig): Promise<NativeStatus> {
    assertNativeFxTarget(config.path === undefined ? 'track' : config.path, config.trackId === undefined ? 0 : config.trackId);
    if (!(['A', 'B', 'C', 'D'] as const).includes(config.slot) ||
        typeof config.effectId !== 'string' ||
        (config.effectId !== '' && config.effectId !== 'hrm_auto_m' && !Object.prototype.hasOwnProperty.call(NATIVE_CATALOG_FX_LABELS, config.effectId)) ||
        typeof config.bypassed !== 'boolean' ||
        (config.replaceParameters !== undefined && typeof config.replaceParameters !== 'boolean') ||
        (config.parameters !== undefined && (!isObject(config.parameters) ||
          Object.entries(config.parameters).some(([key, value]) => !key || !Number.isFinite(value))))) {
      throw new RangeError('Native catalog slot has an invalid slot, effect type, bypass, or parameter value.');
    }
    return this.request<NativeStatus>('/v1/native-fx/catalog-slot', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  public async queueOscVocMidiEvent(event: NativeOscVocMidiEvent): Promise<NativeStatus> {
    assertNativeFxTarget(event.path, event.trackId === undefined ? 0 : event.trackId);
    if ((event.path !== 'input' && event.path !== 'track') ||
        !(['A', 'B', 'C', 'D'] as const).includes(event.slot) ||
        (event.type !== 'noteOn' && event.type !== 'noteOff') ||
        !Number.isInteger(event.channel) || event.channel < 1 || event.channel > 16 ||
        !Number.isInteger(event.note) || event.note < 0 || event.note > 127 ||
        !Number.isInteger(event.velocity) || event.velocity < 0 || event.velocity > 127 ||
        !Number.isSafeInteger(event.frame) || event.frame < 0) {
      throw new RangeError('Native OSC VOC MIDI event has an invalid path, slot, type, channel, note, velocity, or absolute frame.');
    }
    return this.request<NativeStatus>('/v1/native-fx/osc-voc-midi', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  public async queueCatalogMidiEvent(event: NativeCatalogMidiEvent): Promise<NativeStatus> {
    assertNativeFxTarget(event.path, event.trackId === undefined ? 0 : event.trackId);
    if ((event.effectId !== 'osc_voc_m' && event.effectId !== 'hrm_auto_m') ||
        (event.path !== 'input' && event.path !== 'track') ||
        !(['A', 'B', 'C', 'D'] as const).includes(event.slot) ||
        (event.type !== 'noteOn' && event.type !== 'noteOff') ||
        !Number.isInteger(event.channel) || event.channel < 1 || event.channel > 16 ||
        !Number.isInteger(event.note) || event.note < 0 || event.note > 127 ||
        !Number.isInteger(event.velocity) || event.velocity < 0 || event.velocity > 127 ||
        !Number.isSafeInteger(event.frame) || event.frame < 0) {
      throw new RangeError('Native catalog MIDI event has an invalid effect, path, slot, type, channel, note, velocity, or absolute frame.');
    }
    return this.request<NativeStatus>('/v1/native-fx/catalog-midi', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  private async request<T extends BridgeResponse>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(`Native bridge request ${path} timed out after ${NATIVE_BRIDGE_REQUEST_TIMEOUT_MS} ms.`);
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, NATIVE_BRIDGE_REQUEST_TIMEOUT_MS);
    });

    const operation = (async () => {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          headers: {
            'Content-Type': 'application/json',
          },
          ...init,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw timeoutError;
        throw new Error(`Native bridge is unreachable at ${this.baseUrl}: ${error}`);
      }

      const payload = (await response.json()) as T;
      if (response.ok === false || !payload.ok) {
        throw new NativeBridgeHttpError(payload.error || `Native bridge request failed${response.status ? ` with HTTP ${response.status}` : ''}.`,
          response.status || 0);
      }
      return payload;
    })();

    try {
      // The timeout covers both receiving headers and reading the JSON body.
      // Timed-out commands are aborted and never replayed automatically.
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (!timedOut) throw error;

      // A timed-out write may have reached the host even though its response
      // did not reach us. Read the host state once; never replay the write.
      // GET timeouts do not enter this branch and therefore cannot recurse.
      let reconciledStatus: NativeStatus | null = null;
      let statusReadError: unknown | null = null;
      if (method === 'POST') {
        try {
          reconciledStatus = await this.getStatus();
        } catch (readError) {
          statusReadError = readError;
        }
      }
      throw new NativeBridgeRequestTimeoutError(
        path,
        method,
        NATIVE_BRIDGE_REQUEST_TIMEOUT_MS,
        reconciledStatus,
        statusReadError,
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private async readHttpError(response: Response, fallback: string): Promise<Error> {
    let message = `${fallback} with HTTP ${response.status}.`;
    try {
      const payload = await response.json() as BridgeResponse;
      if (payload.error) message = payload.error;
    } catch {
      // Keep the status-based message for non-JSON bridge errors.
    }
    return new Error(message);
  }
}

/** Input accepts only target 0; Track accepts legacy 0 or explicit loop IDs 1..5. */
export function assertNativeFxTarget(path: string, trackId: number): void {
  if ((path !== 'input' && path !== 'track') || !Number.isInteger(trackId) || trackId < 0 || trackId > 5 ||
      (path === 'input' && trackId !== 0)) {
    throw new RangeError('Native FX target requires Input track ID 0 or Track ID 0–5.');
  }
}

function assertNativeTrackId(trackId: number): void {
  if (!Number.isInteger(trackId) || trackId < 1 || trackId > 5) {
    throw new RangeError('Native track ID must be an integer between 1 and 5.');
  }
}

/** Validate every Native endpoint before making a request, matching LooperCore's current transport ranges. */
export function isNativeLoopTransportConfig(config: NativeLoopTransportConfig): boolean {
  return (config.mode === 'off' || config.mode === 'beatShift' || config.mode === 'vinylFlick')
    && (config.oneShot === undefined || typeof config.oneShot === 'boolean')
    && (config.reverse === undefined || typeof config.reverse === 'boolean')
    && Number.isFinite(config.beatOffsetBeats) && config.beatOffsetBeats >= -4 && config.beatOffsetBeats <= 4
    && Number.isFinite(config.bpm) && config.bpm >= 20 && config.bpm <= 300
    && Number.isFinite(config.crossfadeMs) && config.crossfadeMs >= 1 && config.crossfadeMs <= 10
    && Number.isFinite(config.vinylSpeedPercent) && config.vinylSpeedPercent >= -100 && config.vinylSpeedPercent <= 100
    && Number.isFinite(config.motorReturnSeconds) && config.motorReturnSeconds >= 0.05 && config.motorReturnSeconds <= 10
    && Number.isFinite(config.brakePercent) && config.brakePercent >= 0 && config.brakePercent <= 100
    && Number.isFinite(config.vinylMixPercent) && config.vinylMixPercent >= 0 && config.vinylMixPercent <= 100;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Keep the metadata validation error; cancelling only releases the body early.
  }
}
