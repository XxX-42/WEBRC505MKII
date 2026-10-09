import {
  BROWSER_REALTIME_INITIAL_TRACK_FRAMES,
  BROWSER_REALTIME_MAX_TRACK_FRAMES,
  BROWSER_REALTIME_MAX_HISTORY_TAKES,
  BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE,
  BROWSER_REALTIME_MAX_STORAGE_BYTES,
  BROWSER_REALTIME_SAMPLE_RATE,
  BROWSER_REALTIME_STORAGE_BATCH_BLOCKS,
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
  BROWSER_REALTIME_TRACK_COUNT,
  BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
  BROWSER_REALTIME_LAYOUT_VERSION,
  BROWSER_REALTIME_LAYOUT_MONO,
  BROWSER_REALTIME_LAYOUT_PLANAR_LR,
  BrowserRealtimeOpcode,
  BrowserRealtimeStatus,
  ControlWord,
  CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
  CONTROL_TRACK_STATES_BYTE_OFFSET,
  TRACK_META_BYTES,
  TrackMetaWord,
  createTakeSegmentBuffer,
  createMonoLoopbackSharedBuffer,
  createTrackSharedBuffer,
  loadSharedFrame,
  frameFromWords,
  queueSharedCommand,
  type BrowserRealtimeAck,
  type BrowserRealtimeMetrics,
} from './browserRealtimeProtocol';
import type { TrackRuntimeSettings } from '../core/types';
import type {
  RhythmKitDocument,
  RhythmPatternDocument,
  RhythmRuntimeSnapshot,
  RhythmVoice,
} from './rhythmTypes';

export type BrowserRealtimeTakeMode = 'BASE' | 'OVERDUB' | 'REPLACE1' | 'REPLACE2';

type RuntimeTakeStore = {
  mode: BrowserRealtimeTakeMode;
  buffers: SharedArrayBuffer[];
  left: Float32Array[];
  right: Float32Array[];
  replaceMasks: Array<Uint8Array | null>;
  frameCount: number;
  startPosition: number;
  usedPrimary: boolean;
  metadata: Int32Array | null;
};

type RuntimeTrackStore = {
  buffer: SharedArrayBuffer;
  metadata: Int32Array;
  takes: Array<RuntimeTakeStore | null>;
  primaryUnused: boolean;
};

type StorageReservation = { remainingBytes: number; deferredBytes: number };

type HistoryCompactionPlan = {
  expectedCursor: number;
  prefixEnd: number;
  frameCount: number;
  segmentCount: number;
  recentSlots: number[];
  releasedPrefixBytes: number;
};

type RuntimeMarkSnapshot = {
  kind: 'planar-mark-snapshot';
  length: number;
  sampleRate: number;
  numberOfChannels: 2;
  left: Float32Array[];
  right: Float32Array[];
  byteLength: number;
};

export type BrowserRealtimeRuntimeMessage = {
  type: string;
  track?: number;
  frames?: number;
  startFrame?: number;
  message?: string;
  beatOrdinal?: number;
  frame?: number;
  channelCount?: number;
  layoutVersion?: number;
  storageLayout?: number;
  takeSlot?: number;
  segmentIndex?: number;
  firstSegment?: number;
  mode?: number;
  storageBytes?: number;
  historyCursor?: number;
  historyLength?: number;
  frameCount?: number;
  requestId?: number;
  ok?: boolean;
  takeMode?: number;
  capacityFrames?: number;
  } & Partial<BrowserRealtimeAck>;

type AckWaiter = {
  intentFrame: number;
  targetFrame: number;
  resolve: (ack: BrowserRealtimeAck) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const ACKNOWLEDGEMENT_GRACE_MS = 2_000;
const EXPORT_CHUNK_FRAMES = 4_096;
const RHYTHM_ACK_TIMEOUT_MS = 4_000;
const HISTORY_COMPACTION_THRESHOLD = 16;
const RECENT_HISTORY_TAKES = 8;
const HISTORY_COMPACTION_ATTACH_BATCH_SEGMENTS = BROWSER_REALTIME_STORAGE_BATCH_BLOCKS;
const TAKE_SEGMENT_BYTES = TRACK_META_BYTES +
  BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * (BROWSER_REALTIME_TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT);
const TRACK_STORAGE_BYTES = TRACK_META_BYTES +
  BROWSER_REALTIME_INITIAL_TRACK_FRAMES * BROWSER_REALTIME_TRACK_CHANNEL_COUNT * Float32Array.BYTES_PER_ELEMENT;
const RHYTHM_VOICE_ORDER: readonly RhythmVoice[] = ['kick', 'snare', 'hat'];
const DEFAULT_RHYTHM_PATTERN: RhythmPatternDocument = {
  version: 1, id: 'rock', name: 'Rock', steps: 16, stepsPerBeat: 4,
  lanes: [
    { voice: 'kick', velocities: Array.from({ length: 16 }, (_, step) => step === 0 || step === 6 || step === 8 ? 1 : 0) },
    { voice: 'snare', velocities: Array.from({ length: 16 }, (_, step) => step === 4 || step === 12 ? 1 : 0) },
    { voice: 'hat', velocities: Array.from({ length: 16 }, (_, step) => step % 2 === 0 ? 0.7 : 0) },
  ],
};
const DEFAULT_RHYTHM_KIT: RhythmKitDocument = {
  version: 1, id: 'standard', name: 'Standard',
  voices: {
    kick: { pitchHz: 150, decayMs: 46, noiseAmount: 0, toneGain: 0.85 },
    snare: { pitchHz: 180, decayMs: 33, noiseAmount: 0.75, toneGain: 0.25 },
    hat: { pitchHz: 7_000, decayMs: 8, noiseAmount: 1, toneGain: 0 },
  },
};

function cloneRhythmPattern(document: RhythmPatternDocument): RhythmPatternDocument {
  return { ...document, lanes: document.lanes.map((lane) => ({ ...lane, velocities: [...lane.velocities] })) };
}

function cloneRhythmKit(document: RhythmKitDocument): RhythmKitDocument {
  return { ...document, voices: {
    kick: { ...document.voices.kick },
    snare: { ...document.voices.snare },
    hat: { ...document.voices.hat },
  } };
}

function legacyRhythmPattern(patternIndex: number): RhythmPatternDocument {
  if (patternIndex === 1) {
    return {
      version: 1, id: 'techno', name: 'Techno', steps: 16, stepsPerBeat: 4,
      lanes: [
        { voice: 'kick', velocities: Array.from({ length: 16 }, (_, step) => step % 4 === 0 ? 1 : 0) },
        { voice: 'snare', velocities: Array.from({ length: 16 }, (_, step) => step === 4 || step === 12 ? 1 : 0) },
        { voice: 'hat', velocities: Array.from({ length: 16 }, (_, step) => [2, 6, 10, 14].includes(step) ? 0.7 : 0) },
      ],
    };
  }
  if (patternIndex === 2) {
    return {
      version: 1, id: 'metronome', name: 'Metronome', steps: 16, stepsPerBeat: 4,
      lanes: [
        { voice: 'kick', velocities: Array.from({ length: 16 }, (_, step) => step === 0 ? 1 : 0) },
        { voice: 'snare', velocities: Array.from({ length: 16 }, (_, step) => [4, 8, 12].includes(step) ? 1 : 0) },
      ],
    };
  }
  return cloneRhythmPattern(DEFAULT_RHYTHM_PATTERN);
}

function normalizeRhythmPattern(document: RhythmPatternDocument): RhythmPatternDocument {
  if (!document || document.version !== 1 || typeof document.id !== 'string' || !document.id.trim() ||
      document.id.length > 96 || typeof document.name !== 'string' || document.name.length > 96 ||
      !Number.isInteger(document.steps) || document.steps < 1 || document.steps > 64 ||
      !Number.isInteger(document.stepsPerBeat) || document.stepsPerBeat < 1 || document.stepsPerBeat > 8 ||
      !Array.isArray(document.lanes) || document.lanes.length > RHYTHM_VOICE_ORDER.length) {
    throw new TypeError('Rhythm pattern must be version 1 with 1–64 steps, 1–8 steps per beat, and at most three lanes.');
  }
  const seen = new Set<RhythmVoice>();
  const lanes = document.lanes.map((lane) => {
    if (!lane || !RHYTHM_VOICE_ORDER.includes(lane.voice) || seen.has(lane.voice) ||
        !Array.isArray(lane.velocities) || lane.velocities.length !== document.steps) {
      throw new TypeError('Each rhythm lane must use one unique voice and exactly one velocity per step.');
    }
    seen.add(lane.voice);
    const velocities = lane.velocities.map((value) => {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Rhythm velocities must be normalized to [0, 1].');
      return value;
    });
    return { voice: lane.voice, velocities };
  }).sort((left, right) => RHYTHM_VOICE_ORDER.indexOf(left.voice) - RHYTHM_VOICE_ORDER.indexOf(right.voice));
  return { version: 1, id: document.id.trim(), name: document.name.trim(), steps: document.steps, stepsPerBeat: document.stepsPerBeat, lanes };
}

function normalizeRhythmKit(document: RhythmKitDocument): RhythmKitDocument {
  if (!document || document.version !== 1 || typeof document.id !== 'string' || !document.id.trim() ||
      document.id.length > 96 || typeof document.name !== 'string' || document.name.length > 96 || !document.voices) {
    throw new TypeError('Rhythm kit must be a version 1 document with a bounded id and name.');
  }
  const voices = {} as RhythmKitDocument['voices'];
  for (const voice of RHYTHM_VOICE_ORDER) {
    const settings = document.voices[voice];
    if (!settings || !Number.isFinite(settings.pitchHz) || settings.pitchHz < 20 || settings.pitchHz > 12_000 ||
        !Number.isFinite(settings.decayMs) || settings.decayMs < 1 || settings.decayMs > 10_000 ||
        !Number.isFinite(settings.noiseAmount) || settings.noiseAmount < 0 || settings.noiseAmount > 1 ||
        !Number.isFinite(settings.toneGain) || settings.toneGain < 0 || settings.toneGain > 2) {
      throw new RangeError(`Rhythm kit ${voice} parameters are outside supported ranges.`);
    }
    voices[voice] = { ...settings };
  }
  return { version: 1, id: document.id.trim(), name: document.name.trim(), voices };
}

function encodeRhythmPattern(document: RhythmPatternDocument): Float32Array {
  const output = new Float32Array(3 * 64);
  for (const lane of document.lanes) {
    const voiceIndex = RHYTHM_VOICE_ORDER.indexOf(lane.voice);
    for (let step = 0; step < document.steps; step += 1) {
      output[voiceIndex * 64 + step] = lane.velocities[step] ?? 0;
    }
  }
  return output;
}

function encodeRhythmKit(document: RhythmKitDocument): Float32Array {
  const output = new Float32Array(12);
  for (let voiceIndex = 0; voiceIndex < RHYTHM_VOICE_ORDER.length; voiceIndex += 1) {
    const voice = RHYTHM_VOICE_ORDER[voiceIndex]!;
    const settings = document.voices[voice];
    const offset = voiceIndex * 4;
    output[offset] = settings.pitchHz;
    output[offset + 1] = settings.decayMs;
    output[offset + 2] = settings.noiseAmount;
    output[offset + 3] = settings.toneGain;
  }
  return output;
}

export class BrowserRealtimeRuntime {
  public readonly controlBuffer: SharedArrayBuffer;
  public readonly control: Int32Array;
  public readonly trackStates: Int32Array;
  public readonly trackPositions: Float32Array;

  private readonly node: AudioWorkletNode;
  private readonly sampleRate: number;
  private readonly trackBuffers: Array<SharedArrayBuffer | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackMetadata: Array<Int32Array | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackSamplesLeft: Array<Float32Array | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackSamplesRight: Array<Float32Array | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly trackStores: Array<RuntimeTrackStore | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly markSnapshots: Array<RuntimeMarkSnapshot | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly attachWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly takeWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly trackPreparationPromises: Array<Promise<void> | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly historyCompactionInProgress = new Uint8Array(BROWSER_REALTIME_TRACK_COUNT);
  private readonly historyCompactionPromises: Array<Promise<void> | null> = new Array(BROWSER_REALTIME_TRACK_COUNT).fill(null);
  private readonly ackWaiters = new Map<number, AckWaiter>();
  private readonly rhythmWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private loopbackArmWaiter: { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
  private sequence = 0;
  private storageAllocatedBytes = 0;
  private reservedStorageBytes = 0;
  private storageGrowthRequests = 0;
  private storageGrowthFailures = 0;
  private pendingWriteOperations = 0;
  private readonly pendingStorageGrowth = new Set<string>();
  private projectOperationLocked = false;
  private projectLockToken: symbol | null = null;
  private messageHandler: ((message: BrowserRealtimeRuntimeMessage) => void) | null = null;
  private disposed = false;
  private rhythmRequestSequence = 0;
  private rhythmUpdateQueue: Promise<void> = Promise.resolve();
  private rhythmEnabled = false;
  private rhythmVolume = 0.5;
  private rhythmPatternDocument = cloneRhythmPattern(DEFAULT_RHYTHM_PATTERN);
  private rhythmKitDocument = cloneRhythmKit(DEFAULT_RHYTHM_KIT);
  private cleanRoomRhythmPreset: RhythmRuntimeSnapshot['cleanRoomPreset'] = null;

  public constructor(node: AudioWorkletNode, controlBuffer: SharedArrayBuffer, sampleRate: number) {
    this.node = node;
    this.sampleRate = sampleRate;
    this.controlBuffer = controlBuffer;
    this.control = new Int32Array(this.controlBuffer);
    this.trackStates = new Int32Array(
      this.controlBuffer,
      CONTROL_TRACK_STATES_BYTE_OFFSET,
      BROWSER_REALTIME_TRACK_COUNT,
    );
    this.trackPositions = new Float32Array(
      this.controlBuffer,
      CONTROL_TRACK_POSITIONS_BYTE_OFFSET,
      BROWSER_REALTIME_TRACK_COUNT,
    );

    Atomics.store(this.control, ControlWord.BPM, 120);
    this.node.port.onmessage = (event: MessageEvent<BrowserRealtimeRuntimeMessage>) => this.handleMessage(event.data);
    this.node.port.onmessageerror = () => this.failAllWaiters(new Error('The browser realtime worklet message channel failed.'));
  }

  public setMessageHandler(handler: ((message: BrowserRealtimeRuntimeMessage) => void) | null) {
    this.messageHandler = handler;
  }

  public async prepareAllTracks(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      pending.push(this.prepareTrack(track));
    }
    await Promise.all(pending);
  }

  public async prepareTrack(track: number): Promise<void> {
    this.assertTrackIndex(track);
    const existingPreparation = this.trackPreparationPromises[track];
    if (existingPreparation) return await existingPreparation;
    if (this.trackBuffers[track]) return;
    if (this.disposed) throw new Error('Browser realtime runtime is closed.');

    const buffer = this.allocateStorage(TRACK_STORAGE_BYTES, () => createTrackSharedBuffer(BROWSER_REALTIME_INITIAL_TRACK_FRAMES));
    const metadata = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    const samplesLeft = new Float32Array(buffer, TRACK_META_BYTES, BROWSER_REALTIME_INITIAL_TRACK_FRAMES);
    const samplesRight = new Float32Array(
      buffer,
      TRACK_META_BYTES + BROWSER_REALTIME_INITIAL_TRACK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
      BROWSER_REALTIME_INITIAL_TRACK_FRAMES,
    );
    Atomics.store(metadata, TrackMetaWord.STATE, 0);
    Atomics.store(metadata, TrackMetaWord.CAPACITY_FRAMES, BROWSER_REALTIME_INITIAL_TRACK_FRAMES);
    Atomics.store(metadata, TrackMetaWord.ALIGNMENT_SAMPLES, 0);
    Atomics.store(metadata, TrackMetaWord.CHANNEL_COUNT, BROWSER_REALTIME_TRACK_CHANNEL_COUNT);
    Atomics.store(metadata, TrackMetaWord.LAYOUT_VERSION, BROWSER_REALTIME_LAYOUT_VERSION);
    Atomics.store(metadata, TrackMetaWord.STORAGE_LAYOUT, BROWSER_REALTIME_LAYOUT_PLANAR_LR);

    this.trackBuffers[track] = buffer;
    this.trackMetadata[track] = metadata;
    this.trackSamplesLeft[track] = samplesLeft;
    this.trackSamplesRight[track] = samplesRight;
    const primaryTake: RuntimeTakeStore = {
      mode: 'BASE', buffers: [buffer], left: [samplesLeft], right: [samplesRight],
      replaceMasks: [null], frameCount: 0, startPosition: 0, usedPrimary: true, metadata,
    };
    const trackStore: RuntimeTrackStore = {
      buffer, metadata, takes: new Array(BROWSER_REALTIME_MAX_HISTORY_TAKES).fill(null), primaryUnused: true,
    };
    trackStore.takes[0] = primaryTake;
    this.trackStores[track] = trackStore;

    const preparation = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.attachWaiters.delete(track);
        reject(new Error(`Realtime worklet did not attach storage for track ${track + 1}.`));
      }, 2_000);
      this.attachWaiters.set(track, { resolve, reject, timeout });
      this.node.port.postMessage({
        type: 'ATTACH_TRACK',
        track,
        buffer,
        channelCount: BROWSER_REALTIME_TRACK_CHANNEL_COUNT,
        layoutVersion: BROWSER_REALTIME_LAYOUT_VERSION,
        storageLayout: BROWSER_REALTIME_LAYOUT_PLANAR_LR,
      });
    });
    this.trackPreparationPromises[track] = preparation;
    try {
      await preparation;
      for (let segmentIndex = 1; segmentIndex < BROWSER_REALTIME_STORAGE_BATCH_BLOCKS; segmentIndex += 1) {
        await this.attachTakeSegment(track, 0, segmentIndex, primaryTake);
      }
      Atomics.store(metadata, TrackMetaWord.CAPACITY_FRAMES, primaryTake.buffers.length * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
    } catch (error) {
      if (this.trackBuffers[track] === buffer) {
        this.releaseTrackStorage(track);
        this.trackBuffers[track] = null;
        this.trackMetadata[track] = null;
        this.trackSamplesLeft[track] = null;
        this.trackSamplesRight[track] = null;
        this.trackStores[track] = null;
      }
      throw error;
    } finally {
      if (this.trackPreparationPromises[track] === preparation) {
        this.trackPreparationPromises[track] = null;
      }
    }
  }

  /** Prepare a new immutable history layer before its sample-clock REC/OD command. */
  public async beginTake(
    track: number,
    mode: BrowserRealtimeTakeMode,
    projectToken?: symbol,
    requiredFrames = 0,
  ): Promise<number> {
    this.assertTrackIndex(track);
    if (this.projectOperationLocked && projectToken !== this.projectLockToken) throw new Error('Track recording is blocked while a project operation is active.');
    if (!Number.isSafeInteger(requiredFrames) || requiredFrames < 0 || requiredFrames > BROWSER_REALTIME_MAX_TRACK_FRAMES) {
      throw new RangeError('A take storage reservation must fit the bounded realtime track capacity.');
    }
    this.pendingWriteOperations += 1;
    let reservation: StorageReservation | null = null;
    try {
    await this.prepareTrack(track);
    const store = this.trackStores[track];
    const metadata = this.trackMetadata[track];
    if (!store || !metadata) throw new Error(`Track ${track + 1} storage is unavailable.`);
    const state = Atomics.load(metadata, TrackMetaWord.STATE);
    if (state === 2 || state === 5 || state === 7) throw new Error('Cannot prepare a take while the track is recording or replacing.');

    const loopFrames = Math.max(0, Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES));
    const minimumCapacityFrames = Math.max(requiredFrames, mode === 'BASE' ? 0 : loopFrames);
    const requiredSegments = Math.max(
      BROWSER_REALTIME_STORAGE_BATCH_BLOCKS,
      Math.ceil(minimumCapacityFrames / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES),
    );
    if (requiredSegments > BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE) {
      throw new RangeError(`Track ${track + 1} take exceeds the bounded segment limit.`);
    }

    let cursor = Math.max(0, Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR));
    let historyLength = Math.max(0, Atomics.load(metadata, TrackMetaWord.HISTORY_LENGTH));
    if (cursor >= HISTORY_COMPACTION_THRESHOLD && cursor === historyLength) {
      if (this.historyCompactionPromises[track]) {
        throw new Error(`Track ${track + 1} history compaction is already active; retry the take after it finishes.`);
      }
      const plan = this.createHistoryCompactionPlan(track, store, cursor);
      const nextTakeBytes = requiredSegments * TAKE_SEGMENT_BYTES;
      const anchorBytes = plan.segmentCount * TAKE_SEGMENT_BYTES;
      const compactionReservation = this.reserveCompactionStorage(
        anchorBytes, nextTakeBytes, plan.releasedPrefixBytes, track,
      );
      reservation = compactionReservation;
      await this.ensureHistoryCompacted(track, store, metadata, plan, compactionReservation);
      cursor = Math.max(0, Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR));
      historyLength = Math.max(0, Atomics.load(metadata, TrackMetaWord.HISTORY_LENGTH));
      if (reservation.remainingBytes !== nextTakeBytes) {
        throw new Error(`Track ${track + 1} compaction did not preserve the reserved space for its pending take.`);
      }
    } else {
      if (cursor >= BROWSER_REALTIME_MAX_HISTORY_TAKES) throw new Error('Track history has reached its bounded take limit.');
      const slot = cursor;
      const usePrimary = slot === 0 && historyLength === 0 && store.primaryUnused;
      const reusableSegments = usePrimary ? (store.takes[slot]?.buffers.length ?? 0) : 0;
      const additionalSegments = Math.max(0, requiredSegments - reusableSegments);
      const additionalBytes = additionalSegments * TAKE_SEGMENT_BYTES;
      const releasableBytes = this.estimateReleasedTakeBytes(store, slot, usePrimary);
      reservation = this.reserveStorage(additionalBytes, releasableBytes, track);
    }

    if (cursor >= BROWSER_REALTIME_MAX_HISTORY_TAKES) throw new Error('Track history has reached its bounded take limit.');
    const slot = cursor;
    const usePrimary = slot === 0 && historyLength === 0 && store.primaryUnused;

    await this.waitForTakeMessage(`prepare:${track}`, 'TAKE_PREPARED', { type: 'PREPARE_TAKE', track, takeSlot: slot, mode, usePrimary });
    this.releaseTakesFrom(track, slot, usePrimary);

    let take = store.takes[slot];
    if (usePrimary && take) {
      take.mode = mode;
      take.frameCount = 0;
      store.primaryUnused = false;
      await this.ensureTakeSegments(track, slot, BROWSER_REALTIME_STORAGE_BATCH_BLOCKS, take, reservation ?? undefined);
    } else {
      take = {
        mode, buffers: [], left: [], right: [], replaceMasks: [], frameCount: 0,
        startPosition: Atomics.load(metadata, TrackMetaWord.PLAY_POSITION), usedPrimary: false, metadata: null,
      };
      store.takes[slot] = take;
      for (let segmentIndex = 0; segmentIndex < BROWSER_REALTIME_STORAGE_BATCH_BLOCKS; segmentIndex += 1) {
        await this.attachTakeSegment(track, slot, segmentIndex, take, reservation ?? undefined);
      }
    }
    if (take) take.mode = mode;
    Atomics.store(metadata, TrackMetaWord.ACTIVE_TAKE_SLOT, slot);
    Atomics.store(metadata, TrackMetaWord.TAKE_MODE, this.modeToCode(mode));

    await this.ensureTakeSegments(track, slot, requiredSegments, take!, reservation ?? undefined);
    Atomics.store(metadata, TrackMetaWord.CAPACITY_FRAMES, (take?.buffers.length ?? 0) * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
    return slot;
    } finally {
      if (reservation) this.releaseStorageReservation(reservation);
      this.pendingWriteOperations = Math.max(0, this.pendingWriteOperations - 1);
    }
  }

  private createHistoryCompactionPlan(
    track: number,
    store: RuntimeTrackStore,
    cursor: number,
  ): HistoryCompactionPlan {
    const prefixEnd = cursor - RECENT_HISTORY_TAKES;
    if (prefixEnd < 2) throw new Error(`Track ${track + 1} history has no safely compactable prefix.`);
    let hasBase = false;
    let frameCount = 0;
    for (let slot = prefixEnd - 1; slot >= 0; slot -= 1) {
      const take = store.takes[slot];
      if (take?.mode === 'BASE' && take.frameCount > 0) {
        hasBase = true;
        frameCount = take.frameCount;
        break;
      }
    }
    if (!hasBase || frameCount <= 0) throw new Error(`Track ${track + 1} has no immutable base to compact.`);

    const recentSlots = new Array<number>(cursor - prefixEnd);
    for (let index = 0; index < recentSlots.length; index += 1) {
      const sourceSlot = prefixEnd + index;
      const take = store.takes[sourceSlot];
      if (!take || take.frameCount <= 0 || take.usedPrimary) {
        throw new Error(`Track ${track + 1} recent history layer ${sourceSlot} is incomplete.`);
      }
      recentSlots[index] = sourceSlot;
    }

    let releasedPrefixBytes = 0;
    for (let slot = 1; slot < prefixEnd; slot += 1) {
      const take = store.takes[slot];
      if (!take) continue;
      for (let segment = 0; segment < take.buffers.length; segment += 1) {
        releasedPrefixBytes += take.buffers[segment]?.byteLength ?? 0;
      }
    }

    return {
      expectedCursor: cursor,
      prefixEnd,
      frameCount,
      segmentCount: Math.ceil(frameCount / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES),
      recentSlots,
      releasedPrefixBytes,
    };
  }

  /**
   * Collapse the old committed prefix into one immutable BASE checkpoint while
   * retaining the original first recording at slot zero for Rec Back and the
   * newest eight undoable takes. PCM copying stays on the main thread and is
   * chunked; the Worklet swaps its fixed slot references between render calls.
   */
  private async compactHistory(
    track: number,
    store: RuntimeTrackStore,
    metadata: Int32Array,
    plan: HistoryCompactionPlan,
    reservation: StorageReservation,
  ): Promise<void> {
    if (this.historyCompactionInProgress[track]) throw new Error(`Track ${track + 1} history compaction is already active.`);
    const { expectedCursor: cursor, prefixEnd, frameCount, segmentCount, recentSlots } = plan;

    const anchor: RuntimeTakeStore = {
      mode: 'BASE', buffers: [], left: [], right: [], replaceMasks: [],
      frameCount, startPosition: 0, usedPrimary: false, metadata: null,
    };
    this.historyCompactionInProgress[track] = 1;
    try {
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const buffer = this.allocateStorage(
          TAKE_SEGMENT_BYTES,
          () => createTakeSegmentBuffer(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES),
          reservation,
        );
        const segmentMetadata = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
        const left = new Float32Array(buffer, TRACK_META_BYTES, BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
        const right = new Float32Array(
          buffer,
          TRACK_META_BYTES + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
          BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
        );
        const mask = new Uint8Array(
          buffer,
          TRACK_META_BYTES + 2 * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
          BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
        );
        anchor.buffers.push(buffer);
        anchor.left.push(left);
        anchor.right.push(right);
        anchor.replaceMasks.push(mask);
        if (segment === 0) anchor.metadata = segmentMetadata;

        const begin = segment * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
        const count = Math.min(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES, frameCount - begin);
        for (let offset = 0; offset < count; offset += 1) {
          const frame = begin + offset;
          left[offset] = this.readHistorySample(track, frame, 0, prefixEnd);
          right[offset] = this.readHistorySample(track, frame, 1, prefixEnd);
        }
        if (begin + count < frameCount) await this.yieldToMainThread();
      }

      const expectedCursor = cursor;
      for (let firstSegment = 0; firstSegment < segmentCount; firstSegment += HISTORY_COMPACTION_ATTACH_BATCH_SEGMENTS) {
        const endSegment = Math.min(segmentCount, firstSegment + HISTORY_COMPACTION_ATTACH_BATCH_SEGMENTS);
        // Keep each Worklet message and its view-construction work bounded,
        // even when the flattened take is many minutes long.
        await this.waitForTakeMessage(
          `compact-segments:${track}:${firstSegment}`,
          'TRACK_COMPACTION_SEGMENTS_ATTACHED',
          {
            type: 'ATTACH_HISTORY_COMPACTION_SEGMENTS', track, expectedCursor, prefixEnd,
            frameCount, firstSegment, buffers: anchor.buffers.slice(firstSegment, endSegment),
          },
        );
      }
      await this.waitForTakeMessage(`compact:${track}`, 'TRACK_HISTORY_COMPACTED', {
        type: 'COMPACT_HISTORY', track, expectedCursor, prefixEnd, frameCount, recentSlots,
      });

      // The Worklet has atomically stopped referencing old prefix slots.
      const previousTakes = store.takes.slice();
      const retainedSlots = new Set<number>([0, ...recentSlots]);
      store.takes.fill(null);
      store.takes[0] = previousTakes[0] ?? null;
      store.takes[1] = anchor;
      for (let index = 0; index < recentSlots.length; index += 1) {
        const sourceSlot = recentSlots[index]!;
        const take = previousTakes[sourceSlot];
        if (!take) continue;
        store.takes[index + 2] = take;
      }
      for (let slot = 1; slot < previousTakes.length; slot += 1) {
        if (retainedSlots.has(slot)) continue;
        const take = previousTakes[slot];
        if (!take) continue;
        for (const buffer of take.buffers) {
          this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - buffer.byteLength);
        }
      }
      if (reservation.deferredBytes > 0) {
        reservation.remainingBytes += reservation.deferredBytes;
        this.reservedStorageBytes += reservation.deferredBytes;
        reservation.deferredBytes = 0;
      }
      store.primaryUnused = false;
    } catch (error) {
      // Ask the Worklet to drop any staged SharedArrayBuffer views before the
      // main thread releases their storage budget. The abort is idempotent and
      // bounded regardless of how many batches were previously attached.
      const workletHasSwapped = !this.takeWaiters.has(`compact:${track}`) &&
        Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR) === recentSlots.length + 2;
      if (!workletHasSwapped) {
        try {
          await this.waitForTakeMessage(`compact-abort:${track}`, 'TRACK_COMPACTION_ABORTED', {
            type: 'ABORT_HISTORY_COMPACTION', track,
          });
        } catch {
          // A timed-out Worklet is already unhealthy; retain conservative
          // storage accounting so a retry cannot exceed the configured cap.
          anchor.buffers.length = 0;
        }
        for (const buffer of anchor.buffers) {
          this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - buffer.byteLength);
        }
      }
      throw error;
    } finally {
      this.historyCompactionInProgress[track] = 0;
    }
  }

  private ensureHistoryCompacted(
    track: number,
    store: RuntimeTrackStore,
    metadata: Int32Array,
    plan: HistoryCompactionPlan,
    reservation: StorageReservation,
  ): Promise<void> {
    const existing = this.historyCompactionPromises[track];
    if (existing) return existing;
    this.pendingWriteOperations += 1;
    const operation = this.compactHistory(track, store, metadata, plan, reservation).finally(() => {
      this.pendingWriteOperations = Math.max(0, this.pendingWriteOperations - 1);
      if (this.historyCompactionPromises[track] === operation) this.historyCompactionPromises[track] = null;
    });
    this.historyCompactionPromises[track] = operation;
    return operation;
  }

  public beginProjectLock(): symbol {
    if (this.projectOperationLocked) throw new Error('Another project operation is already active.');
    if (this.pendingWriteOperations > 0 || this.trackPreparationPromises.some(Boolean) || this.ackWaiters.size > 0 ||
        Atomics.load(this.control, ControlWord.COMMAND_READ) !== Atomics.load(this.control, ControlWord.COMMAND_WRITE)) {
      throw new Error('Wait for pending realtime commands and take preparation to finish before starting a project operation.');
    }
    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      const metadata = this.trackMetadata[track];
      if (!metadata) continue;
      const state = Atomics.load(metadata, TrackMetaWord.STATE);
      if (state === 1 || state === 2 || state === 3 || state === 5 || state === 7) {
        throw new Error(`Stop recording, overdubbing, or replacing Track ${track + 1} before starting a project operation.`);
      }
    }
    const token = Symbol('project-operation');
    this.projectLockToken = token;
    this.projectOperationLocked = true;
    return token;
  }

  /** Guard an asynchronous browser-side mutation (FX graph, routing, or settings)
   * so a project snapshot cannot begin in the middle of that operation. */
  public acquireMutationLease(projectToken?: symbol): () => void {
    if (this.disposed) throw new Error('Browser realtime runtime is closed.');
    if (projectToken !== undefined) this.assertProjectToken(projectToken);
    else if (this.projectOperationLocked) throw new Error('Browser mutation is blocked while a project operation is active.');
    this.pendingWriteOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingWriteOperations = Math.max(0, this.pendingWriteOperations - 1);
    };
  }

  public endProjectLock(token: symbol): void {
    if (!this.projectOperationLocked || token !== this.projectLockToken) throw new Error('Invalid project operation lock token.');
    this.projectLockToken = null;
    this.projectOperationLocked = false;
  }

  /** Compatibility lock for callers that only need to reject ordinary UI mutations. */
  public setProjectOperationLock(locked: boolean): void {
    if (locked) {
      if (!this.projectOperationLocked) {
        this.projectOperationLocked = true;
        this.projectLockToken = Symbol('legacy-project-lock');
      }
    } else {
      this.projectOperationLocked = false;
      this.projectLockToken = null;
    }
  }

  public async syncExternalClock(bpm: number, beatOrdinal = 0, targetFrame?: number): Promise<BrowserRealtimeAck> {
    const safeBpm = Number.isFinite(bpm) ? Math.max(40, Math.min(300, bpm)) : 120;
    const safeOrdinal = Number.isFinite(beatOrdinal) ? Math.max(0, Math.floor(beatOrdinal)) : 0;
    return await this.enqueue(
      BrowserRealtimeOpcode.SYNC_EXTERNAL_CLOCK,
      -1,
      Math.round(safeBpm * 1_000),
      safeOrdinal,
      targetFrame,
      1,
    );
  }

  public async updateTrackSettings(track: number, settings: TrackRuntimeSettings, projectToken?: symbol): Promise<void> {
    this.assertTrackIndex(track);
    const targetFrame = this.getImmediateTargetFrame();
    const mode = this.modeToCode(settings.dubMode);
    const startMode = settings.startMode === 'FADE' ? 1 : 0;
    const stopMode = settings.stopMode === 'FADE' ? 1 : settings.stopMode === 'LOOP' ? 2 : 0;
    const fadeInFrames = Math.round(settings.fadeInMs * this.sampleRate / 1000);
    const fadeOutFrames = Math.round(settings.fadeOutMs * this.sampleRate / 1000);
    const debounceFrames = Math.max(1, Math.round(settings.autoRec.debounceMs * this.sampleRate / 1000));
    const tempoSyncFactorQ16 = settings.tempoSyncSpeed === 'HALF' ? 32_768
      : settings.tempoSyncSpeed === 'DOUBLE' ? 131_072 : 65_536;
    const tempoSyncMode = settings.tempoSyncMode === 'XFADE' ? 1 : 0;
    const commands = [
      this.enqueue(BrowserRealtimeOpcode.SET_REVERSE, track, settings.reverse ? 1 : 0, 0, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_SPEED, track, Math.round(settings.speed * 65_536), settings.keepPitch ? 1 : 0, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_ONE_SHOT, track, settings.oneShot ? 1 : 0, 0, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_STOP_MODE, track, stopMode, 0, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_START_MODE, track, startMode, 0, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_FADE, track, fadeInFrames, fadeOutFrames, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_AUTO_REC, track, settings.autoRec.enabled ? 1 : 0,
        Math.round(settings.autoRec.threshold * 32_767), targetFrame, debounceFrames, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_DUB_MODE, track, mode, 0, targetFrame, 0, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_TEMPO_SYNC, track, settings.tempoSyncEnabled ? 1 : 0,
        tempoSyncFactorQ16, targetFrame, tempoSyncMode, projectToken),
      this.enqueue(BrowserRealtimeOpcode.SET_RECORD_BPM, track,
        settings.recordBpm === null ? 0 : Math.round(settings.recordBpm * 1_000), 0, targetFrame, 0, projectToken),
    ];
    const acks = await Promise.all(commands);
    if (acks.some((ack) => ack.status !== BrowserRealtimeStatus.OK && ack.status !== BrowserRealtimeStatus.LATE)) {
      throw new Error(`Track ${track + 1} settings were rejected by the realtime worklet.`);
    }
  }

  public getCurrentFrame(): number {
    return loadSharedFrame(
      this.control,
      ControlWord.RENDER_FRAME_SEQUENCE,
      ControlWord.RENDER_FRAME_LOW,
      ControlWord.RENDER_FRAME_HIGH,
    );
  }

  public getSafeTargetFrame(): number {
    // The shared frame is the most recently completed sample. A command that
    // misses the next quantum is executed late at the first available sample;
    // adding a fixed lookahead here would impose avoidable trigger latency.
    return this.getCurrentFrame();
  }

  public getImmediateTargetFrame(): number {
    return this.getCurrentFrame();
  }

  public async enqueue(
    opcode: number,
    track: number,
    arg0 = 0,
    arg1 = 0,
    targetFrame?: number,
    flags = 0,
    projectToken?: symbol,
  ): Promise<BrowserRealtimeAck> {
    if (this.disposed) throw new Error('Browser realtime runtime is closed.');
    if (projectToken !== undefined) this.assertProjectToken(projectToken);
    if (track >= 0 && track < BROWSER_REALTIME_TRACK_COUNT && this.historyCompactionInProgress[track] &&
        this.isProjectMutationOpcode(opcode)) {
      throw new Error(`Track ${track + 1} is compacting immutable history storage.`);
    }
    if (this.projectOperationLocked && this.isProjectMutationOpcode(opcode) && projectToken !== this.projectLockToken) {
      throw new Error('Realtime mutation is blocked while a project operation is active.');
    }
    const intentFrame = this.getCurrentFrame();
    const scheduledTargetFrame = targetFrame ?? intentFrame;
    const sequence = this.nextSequence();
    const intentionalWaitMs = Math.max(0, ((scheduledTargetFrame - intentFrame) / this.sampleRate) * 1000);
    const timeoutMs = Math.min(0x7fff_ffff, Math.ceil(intentionalWaitMs) + ACKNOWLEDGEMENT_GRACE_MS);
    return await new Promise<BrowserRealtimeAck>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ackWaiters.delete(sequence);
        reject(new Error(`Realtime worklet did not acknowledge command ${sequence}.`));
      }, timeoutMs);
      this.ackWaiters.set(sequence, { intentFrame, targetFrame: scheduledTargetFrame, resolve, reject, timeout });

      const queued = queueSharedCommand(this.control, {
        sequence,
        opcode,
        track,
        targetFrame: scheduledTargetFrame,
        arg0,
        arg1,
        flags,
      });
      if (!queued) {
        clearTimeout(timeout);
        this.ackWaiters.delete(sequence);
        reject(new Error('Realtime command queue is full.'));
      }
    });
  }

  public async setAlignmentSamples(track: number, samples: number): Promise<BrowserRealtimeAck> {
    this.assertTrackIndex(track);
    return await this.enqueue(
      BrowserRealtimeOpcode.SET_ALIGNMENT,
      track,
      Math.max(-BROWSER_REALTIME_SAMPLE_RATE, Math.min(BROWSER_REALTIME_SAMPLE_RATE, Math.round(samples))),
    );
  }

  public async setRhythm(
    running: boolean,
    pattern: number,
    projectToken?: symbol,
    preserveCustomPattern = false,
  ): Promise<BrowserRealtimeAck> {
    const ack = await this.enqueue(
      BrowserRealtimeOpcode.SET_RHYTHM,
      -1,
      running ? 1 : 0,
      pattern,
      undefined,
      preserveCustomPattern ? 2 : 1,
      projectToken,
    );
    if (ack.status === BrowserRealtimeStatus.OK || ack.status === BrowserRealtimeStatus.LATE) {
      this.rhythmEnabled = running;
      if (!preserveCustomPattern) {
        this.cleanRoomRhythmPreset = null;
        this.rhythmPatternDocument = legacyRhythmPattern(Math.max(0, Math.min(2, Math.round(pattern))));
      }
    }
    return ack;
  }

  public setRhythmVolume(value: number): number {
    this.rhythmVolume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : this.rhythmVolume;
    return this.rhythmVolume;
  }

  public getRhythmSnapshot(): RhythmRuntimeSnapshot {
    return {
      version: 1,
      enabled: this.rhythmEnabled,
      volume: this.rhythmVolume,
      pattern: cloneRhythmPattern(this.rhythmPatternDocument),
      kit: cloneRhythmKit(this.rhythmKitDocument),
      cleanRoomPreset: this.cleanRoomRhythmPreset ? { ...this.cleanRoomRhythmPreset } : null,
    };
  }

  public async selectCleanRoomRhythm(patternIndex: number, kitIndex: number, projectToken?: symbol): Promise<void> {
    if (!Number.isInteger(patternIndex) || patternIndex < 0 || patternIndex >= 240 ||
        !Number.isInteger(kitIndex) || kitIndex < 0 || kitIndex >= 16) {
      throw new RangeError('Clean-room rhythm selection must reference one of 240 patterns and 16 kits.');
    }
    await this.requestRhythmUpdate('LOAD_RHYTHM_BUILTIN', { patternIndex, kitIndex }, projectToken);
    this.cleanRoomRhythmPreset = { patternIndex, kitIndex };
  }

  public async loadRhythmPattern(document: RhythmPatternDocument, projectToken?: symbol): Promise<void> {
    const normalized = normalizeRhythmPattern(document);
    const velocities = encodeRhythmPattern(normalized);
    await this.requestRhythmUpdate('LOAD_RHYTHM_PATTERN', {
      version: 1,
      id: normalized.id,
      steps: normalized.steps,
      stepsPerBeat: normalized.stepsPerBeat,
      velocities,
    }, projectToken);
    this.cleanRoomRhythmPreset = null;
    this.rhythmPatternDocument = normalized;
  }

  public async loadRhythmKit(document: RhythmKitDocument, projectToken?: symbol): Promise<void> {
    const normalized = normalizeRhythmKit(document);
    await this.requestRhythmUpdate('LOAD_RHYTHM_KIT', {
      version: 1,
      id: normalized.id,
      parameters: encodeRhythmKit(normalized),
    }, projectToken);
    this.cleanRoomRhythmPreset = null;
    this.rhythmKitDocument = normalized;
  }

  public async applyRhythmSnapshot(snapshot: RhythmRuntimeSnapshot, projectToken?: symbol): Promise<void> {
    if (!snapshot || snapshot.version !== 1 || typeof snapshot.enabled !== 'boolean' ||
        !Number.isFinite(snapshot.volume) || snapshot.volume < 0 || snapshot.volume > 1) {
      throw new TypeError('Rhythm snapshot must be version 1 with a normalized volume and enabled flag.');
    }
    const pattern = normalizeRhythmPattern(snapshot.pattern);
    const kit = normalizeRhythmKit(snapshot.kit);
    if (snapshot.cleanRoomPreset) {
      await this.selectCleanRoomRhythm(snapshot.cleanRoomPreset.patternIndex, snapshot.cleanRoomPreset.kitIndex, projectToken);
    } else {
      await this.requestRhythmUpdate('LOAD_RHYTHM_SNAPSHOT', {
        version: 1,
        pattern: {
          id: pattern.id,
          steps: pattern.steps,
          stepsPerBeat: pattern.stepsPerBeat,
          velocities: encodeRhythmPattern(pattern),
        },
        kit: { id: kit.id, parameters: encodeRhythmKit(kit) },
      }, projectToken);
      this.cleanRoomRhythmPreset = null;
    }
    this.rhythmPatternDocument = pattern;
    this.rhythmKitDocument = kit;
    this.rhythmVolume = snapshot.volume;
    if (snapshot.enabled !== this.rhythmEnabled) {
      const currentPatternIndex = Atomics.load(this.control, ControlWord.RHYTHM_PATTERN);
      const ack = await this.setRhythm(snapshot.enabled, currentPatternIndex, projectToken, true);
      if (ack.status !== BrowserRealtimeStatus.OK && ack.status !== BrowserRealtimeStatus.LATE) {
        throw new Error(`Rhythm snapshot enable state was rejected (status ${ack.status}).`);
      }
    }
  }

  private requestRhythmUpdate(
    type: 'LOAD_RHYTHM_PATTERN' | 'LOAD_RHYTHM_KIT' | 'LOAD_RHYTHM_SNAPSHOT' | 'LOAD_RHYTHM_BUILTIN',
    payload: Record<string, unknown>,
    projectToken?: symbol,
  ): Promise<void> {
    if (projectToken !== undefined) this.assertProjectToken(projectToken);
    if (this.projectOperationLocked && projectToken !== this.projectLockToken) {
      return Promise.reject(new Error('Rhythm editing is blocked while a project operation is active.'));
    }
    this.pendingWriteOperations += 1;
    const operation = this.rhythmUpdateQueue
      .catch(() => undefined)
      .then(() => this.sendRhythmUpdate(type, payload, projectToken))
      .finally(() => { this.pendingWriteOperations = Math.max(0, this.pendingWriteOperations - 1); });
    this.rhythmUpdateQueue = operation.catch(() => undefined);
    return operation;
  }

  private async sendRhythmUpdate(
    type: 'LOAD_RHYTHM_PATTERN' | 'LOAD_RHYTHM_KIT' | 'LOAD_RHYTHM_SNAPSHOT' | 'LOAD_RHYTHM_BUILTIN',
    payload: Record<string, unknown>,
    projectToken?: symbol,
  ): Promise<void> {
    if (this.disposed) throw new Error('Browser realtime runtime is closed.');
    if (this.projectOperationLocked && projectToken !== this.projectLockToken) {
      throw new Error('Rhythm editing is blocked while a project operation is active.');
    }
    const requestId = (this.rhythmRequestSequence = (this.rhythmRequestSequence + 1) >>> 0) || 1;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rhythmWaiters.delete(requestId);
        reject(new Error(`Realtime worklet did not apply ${type} at a rhythm boundary.`));
      }, RHYTHM_ACK_TIMEOUT_MS);
      this.rhythmWaiters.set(requestId, { resolve, reject, timeout });
      try {
        this.node.port.postMessage({ type, requestId, ...payload });
      } catch (error) {
        clearTimeout(timeout);
        this.rhythmWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public setBpm(bpm: number, projectToken?: symbol): Promise<BrowserRealtimeAck> {
    return this.enqueue(
      BrowserRealtimeOpcode.SET_BPM,
      -1,
      Math.round(Math.max(40, Math.min(300, bpm)) * 1_000),
      0,
      undefined,
      1,
      projectToken,
    );
  }

  public setClock(running: boolean, projectToken?: symbol): Promise<BrowserRealtimeAck> {
    return this.enqueue(BrowserRealtimeOpcode.SET_CLOCK, -1, running ? 1 : 0, 0, undefined, 0, projectToken);
  }

  /** Align the Worklet clock and rhythm step phase to an immutable master sample epoch. */
  public setMasterClockEpoch(
    originFrame: number,
    bpm: number,
    projectToken?: symbol,
    startClock = false,
  ): Promise<BrowserRealtimeAck> {
    if (!Number.isFinite(originFrame)) throw new RangeError('Master clock origin must be a finite sample frame.');
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 300) throw new RangeError('Master clock BPM must be between 40 and 300.');
    const [originLow, originHigh] = float64ToWords(originFrame);
    const targetFrame = this.getImmediateTargetFrame();
    return this.enqueue(
      BrowserRealtimeOpcode.SET_MASTER_CLOCK_EPOCH,
      -1,
      Math.round(bpm * 1_000) * (startClock ? -1 : 1),
      originLow,
      targetFrame,
      originHigh,
      projectToken,
    );
  }

  public async armLoopbackCapture(buffer: SharedArrayBuffer, startFrame: number, frames: number): Promise<void> {
    const meta = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    const capacityFrames = Atomics.load(meta, TrackMetaWord.CAPACITY_FRAMES);
    const validMonoLoopback = Atomics.load(meta, TrackMetaWord.CHANNEL_COUNT) === 1 &&
      Atomics.load(meta, TrackMetaWord.LAYOUT_VERSION) === BROWSER_REALTIME_LAYOUT_VERSION &&
      Atomics.load(meta, TrackMetaWord.STORAGE_LAYOUT) === BROWSER_REALTIME_LAYOUT_MONO &&
      buffer.byteLength === TRACK_META_BYTES + capacityFrames * Float32Array.BYTES_PER_ELEMENT &&
      Number.isInteger(frames) && frames > 0 && frames <= capacityFrames;
    if (!validMonoLoopback) {
      throw new Error('Loopback capture storage must use the versioned mono layout with sufficient capacity.');
    }
    if (this.loopbackArmWaiter) throw new Error('A loopback capture request is already awaiting worklet acknowledgement.');
    Atomics.store(meta, TrackMetaWord.RECORDING_FRAMES, 0);
    Atomics.store(meta, TrackMetaWord.LOOP_FRAMES, 0);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.loopbackArmWaiter = null;
        reject(new Error('Realtime worklet did not acknowledge loopback capture storage.'));
      }, 2_000);
      this.loopbackArmWaiter = { resolve, reject, timeout };
      this.node.port.postMessage({ type: 'ARM_LOOPBACK', buffer, startFrame, frames });
    });
  }

  public createLoopbackCaptureBuffer(frames: number): SharedArrayBuffer {
    return createMonoLoopbackSharedBuffer(frames);
  }

  public hasMarkSnapshot(track: number): boolean {
    this.assertTrackIndex(track);
    return this.markSnapshots[track] !== null;
  }

  /** Capture a real immutable PCM checkpoint outside the AudioWorklet thread. */
  public async markTrack(track: number): Promise<void> {
    this.assertTrackIndex(track);
    const metadata = this.trackMetadata[track];
    if (!metadata || !this.trackStores[track]) throw new Error(`Track ${track + 1} storage is unavailable.`);
    const token = this.beginProjectLock();
    try {
      const cursor = Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR);
      const loopFrames = Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES);
      if (cursor <= 0 || loopFrames <= 0) throw new Error(`Track ${track + 1} has no audio to mark.`);

      // Keep the previous checkpoint alive until the replacement has been fully
      // copied and the Worklet accepts the matching mark command.
      const snapshot: RuntimeMarkSnapshot = {
        kind: 'planar-mark-snapshot', length: loopFrames, sampleRate: this.sampleRate,
        numberOfChannels: 2, left: [], right: [], byteLength: 0,
      };
      try {
        for (let start = 0; start < loopFrames; start += BROWSER_REALTIME_STORAGE_BLOCK_FRAMES) {
          const length = Math.min(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES, loopFrames - start);
          const chunkBytes = length * Float32Array.BYTES_PER_ELEMENT;
          if (this.storageAllocatedBytes + this.reservedStorageBytes + chunkBytes * 2 > BROWSER_REALTIME_MAX_STORAGE_BYTES) {
            throw new Error(`Track ${track + 1} mark snapshot would exceed the ${BROWSER_REALTIME_MAX_STORAGE_BYTES}-byte realtime storage budget.`);
          }
          const left = new Float32Array(length);
          snapshot.byteLength += left.byteLength;
          this.storageAllocatedBytes += left.byteLength;
          snapshot.left.push(left);
          const right = new Float32Array(length);
          snapshot.byteLength += right.byteLength;
          this.storageAllocatedBytes += right.byteLength;
          snapshot.right.push(right);
          for (let offset = 0; offset < length; offset += 1) {
            const frame = start + offset;
            left[offset] = this.readHistorySample(track, frame, 0, cursor);
            right[offset] = this.readHistorySample(track, frame, 1, cursor);
          }
          if (start + length < loopFrames) await this.yieldToMainThread();
        }
      } catch (error) {
        this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - snapshot.byteLength);
        throw error;
      }
      let markAck: BrowserRealtimeAck;
      try {
        markAck = await this.enqueue(
          BrowserRealtimeOpcode.MARK,
          track,
          0,
          0,
          this.getImmediateTargetFrame(),
          0,
          token,
        );
      } catch (error) {
        this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - snapshot.byteLength);
        throw error;
      }
      if (markAck.status !== BrowserRealtimeStatus.OK && markAck.status !== BrowserRealtimeStatus.LATE) {
        this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - snapshot.byteLength);
        throw new Error(`Track ${track + 1} mark was rejected by the realtime worklet (status ${markAck.status}).`);
      }
      const previousSnapshot = this.markSnapshots[track];
      this.markSnapshots[track] = snapshot;
      if (previousSnapshot) {
        this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - previousSnapshot.byteLength);
      }
    } finally {
      this.endProjectLock(token);
    }
  }

  /** Restore marked PCM as a new immutable BASE take, retaining the original base for Rec Back. */
  public async restoreMarkedTrack(track: number): Promise<void> {
    this.assertTrackIndex(track);
    const snapshot = this.markSnapshots[track];
    if (!snapshot) throw new Error(`Track ${track + 1} has no captured mark snapshot.`);
    const token = this.beginProjectLock();
    try {
      await this.loadTrackSourceForProject(track, snapshot, token);
    } finally {
      this.endProjectLock(token);
    }
  }

  public clearMarkSnapshot(track: number): void {
    this.assertTrackIndex(track);
    this.releaseMarkSnapshot(track);
  }

  public async exportTrack(track: number, context: AudioContext): Promise<AudioBuffer> {
    this.assertTrackIndex(track);
    const hadProjectLock = this.projectOperationLocked;
    const metadata = this.trackMetadata[track];
    const store = this.trackStores[track];
    if (!metadata || !store) throw new Error(`Track ${track + 1} storage is unavailable.`);
    try {
      if (!hadProjectLock) this.projectOperationLocked = true;
      const state = Atomics.load(metadata, TrackMetaWord.STATE);
      if (state === 1 || state === 2 || state === 3 || state === 5 || state === 7) {
        throw new Error(`Track ${track + 1} cannot be exported while a take is being written.`);
      }
      const cursor = Atomics.load(metadata, TrackMetaWord.HISTORY_CURSOR);
      if (cursor <= 0) throw new Error(`Track ${track + 1} has no recorded audio.`);
      let baseSlot = -1;
      let loopFrames = 0;
      for (let slot = cursor - 1; slot >= 0; slot -= 1) {
        const take = store.takes[slot];
        if (take?.mode === 'BASE') {
          baseSlot = slot;
          loopFrames = take.frameCount;
          break;
        }
      }
      if (baseSlot < 0 || loopFrames <= 0) throw new Error(`Track ${track + 1} has no committed base recording.`);

      const audioBuffer = context.createBuffer(BROWSER_REALTIME_TRACK_CHANNEL_COUNT, loopFrames, context.sampleRate);
      const outputLeft = audioBuffer.getChannelData(0);
      const outputRight = audioBuffer.getChannelData(1);
      for (let chunkStart = 0; chunkStart < loopFrames; chunkStart += EXPORT_CHUNK_FRAMES) {
        const chunkEnd = Math.min(loopFrames, chunkStart + EXPORT_CHUNK_FRAMES);
        for (let frame = chunkStart; frame < chunkEnd; frame += 1) {
          let leftSample = 0;
          let rightSample = 0;
          for (let slot = baseSlot; slot < cursor; slot += 1) {
            const take = store.takes[slot];
            if (!take || take.frameCount <= 0) continue;
            const sourceFrame = frame % take.frameCount;
            const segmentIndex = Math.floor(sourceFrame / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
            const sampleIndex = sourceFrame % BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
            const layerLeft = take.left[segmentIndex]?.[sampleIndex] ?? 0;
            const layerRight = take.right[segmentIndex]?.[sampleIndex] ?? 0;
            if (take.mode === 'BASE') {
              leftSample = layerLeft;
              rightSample = layerRight;
            } else if (take.mode === 'OVERDUB') {
              leftSample += layerLeft;
              rightSample += layerRight;
            } else {
              const mask = take.replaceMasks[segmentIndex];
              if (mask?.[sampleIndex]) {
                leftSample = layerLeft;
                rightSample = layerRight;
              }
            }
          }
          outputLeft[frame] = leftSample;
          outputRight[frame] = rightSample;
        }
        if (chunkEnd < loopFrames) await this.yieldToMainThread();
      }
      return audioBuffer;
    } finally {
      if (!hadProjectLock) this.projectOperationLocked = false;
    }
  }

  public async loadTrack(track: number, source: AudioBuffer): Promise<void> {
    if (this.projectOperationLocked) {
      throw new Error('Track import requires the active project operation lock token.');
    }
    const ownedToken = this.beginProjectLock();
    try {
      await this.loadTrackForProject(track, source, ownedToken);
    } finally {
      if (ownedToken) this.endProjectLock(ownedToken);
    }
  }

  public async loadTrackForProject(track: number, source: AudioBuffer, token: symbol): Promise<void> {
    await this.loadTrackSourceForProject(track, source, token);
  }

  private async loadTrackSourceForProject(
    track: number,
    source: AudioBuffer | RuntimeMarkSnapshot,
    token: symbol,
  ): Promise<void> {
    this.assertTrackIndex(track);
    this.assertProjectToken(token);
    if (source.numberOfChannels < 1 || source.numberOfChannels > 2 || source.length <= 0 || source.length > BROWSER_REALTIME_MAX_TRACK_FRAMES) {
      throw new RangeError('Imported audio must contain one or two channels and fit within the bounded realtime storage limit.');
    }
    if (Math.abs(source.sampleRate - this.sampleRate) > 0.5) {
      throw new RangeError(`Imported audio must be resampled to ${this.sampleRate} Hz before loading.`);
    }
    const metadata = this.trackMetadata[track];
    if (metadata) {
      const state = Atomics.load(metadata, TrackMetaWord.STATE);
      if (state === 1 || state === 2 || state === 3 || state === 5 || state === 7) {
        throw new Error('Stop the track before importing audio.');
      }
    }
    try {
      await this.beginTake(track, 'BASE', token, source.length);
      const store = this.trackStores[track];
      if (!store) throw new Error(`Track ${track + 1} storage is unavailable.`);
      const slot = Atomics.load(store.metadata, TrackMetaWord.ACTIVE_TAKE_SLOT);
      const take = store.takes[slot];
      if (!take) throw new Error(`Track ${track + 1} import storage was not prepared.`);
      const required = Math.ceil(source.length / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
      await this.ensureTakeSegments(track, slot, required, take);
      const sourceLeft = 'kind' in source ? null : source.getChannelData(0);
      const sourceRight = 'kind' in source ? null : source.numberOfChannels > 1 ? source.getChannelData(1) : sourceLeft;
      for (let segment = 0; segment < required; segment += 1) {
        const begin = segment * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
        const count = Math.min(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES, source.length - begin);
        const destinationLeft = take.left[segment];
        const destinationRight = take.right[segment];
        if (!destinationLeft || !destinationRight) {
          throw new Error(`Track ${track + 1} import segment ${segment} was not allocated.`);
        }
        if ('kind' in source) {
          const sourceChunkLeft = source.left[segment];
          const sourceChunkRight = source.right[segment];
          if (!sourceChunkLeft || !sourceChunkRight) throw new Error(`Track ${track + 1} mark snapshot segment ${segment} is missing.`);
          destinationLeft.set(sourceChunkLeft.subarray(0, count), 0);
          destinationRight.set(sourceChunkRight.subarray(0, count), 0);
        } else {
          destinationLeft.set(sourceLeft!.subarray(begin, begin + count), 0);
          destinationRight.set(sourceRight!.subarray(begin, begin + count), 0);
        }
      }
      take.frameCount = source.length;
      if (take.metadata) {
        Atomics.store(take.metadata, TrackMetaWord.RECORDING_FRAMES, source.length);
        Atomics.store(take.metadata, TrackMetaWord.LOOP_FRAMES, source.length);
      }
      const ack = await this.enqueue(BrowserRealtimeOpcode.LOAD_TRACK, track, source.length, slot, this.getImmediateTargetFrame(), 0, token);
      if (ack.status !== BrowserRealtimeStatus.OK && ack.status !== BrowserRealtimeStatus.LATE) {
        throw new Error(`Track ${track + 1} import was rejected by the realtime worklet (status ${ack.status}).`);
      }
    } finally { /* The caller owns the project lock. */ }
  }

  public async clearTrackForProject(track: number, token: symbol): Promise<void> {
    this.assertTrackIndex(track);
    this.assertProjectToken(token);
    const ack = await this.enqueue(BrowserRealtimeOpcode.CLEAR, track, 0, 0, this.getImmediateTargetFrame(), 0, token);
    if (ack.status !== BrowserRealtimeStatus.OK && ack.status !== BrowserRealtimeStatus.LATE) {
      throw new Error(`Track ${track + 1} project clear was rejected (status ${ack.status}).`);
    }
    await this.releaseTrackHistory(track);
  }

  public async updateTrackSettingsForProject(track: number, settings: TrackRuntimeSettings, token: symbol): Promise<void> {
    this.assertProjectToken(token);
    await this.updateTrackSettings(track, settings, token);
  }

  public async releaseTrackHistory(track: number): Promise<void> {
    this.assertTrackIndex(track);
    const store = this.trackStores[track];
    if (!store) return;
    this.pendingWriteOperations += 1;
    try {
      await this.waitForTakeMessage(`release:${track}`, 'TRACK_HISTORY_RELEASED', { type: 'RELEASE_TRACK_HISTORY', track });
    this.releaseMarkSnapshot(track);
    const primary = store.takes[0];
    for (let slot = 0; slot < store.takes.length; slot += 1) {
      const take = store.takes[slot];
      if (!take) continue;
      for (let segment = 0; segment < take.buffers.length; segment += 1) {
        const buffer = take.buffers[segment];
        if (!buffer) continue;
        if (slot === 0 && segment === 0 && buffer === store.buffer) continue;
        this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - buffer.byteLength);
      }
      store.takes[slot] = null;
    }
    if (primary) {
      const primaryTake: RuntimeTakeStore = {
        mode: 'BASE', buffers: [store.buffer],
        left: [this.trackSamplesLeft[track]!], right: [this.trackSamplesRight[track]!],
        replaceMasks: [null], frameCount: 0, startPosition: 0, usedPrimary: true, metadata: store.metadata,
      };
      store.takes[0] = primaryTake;
    }
    store.primaryUnused = true;
    Atomics.store(store.metadata, TrackMetaWord.CAPACITY_FRAMES, BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
    } finally {
      this.pendingWriteOperations = Math.max(0, this.pendingWriteOperations - 1);
    }
  }

  public getMetrics(): BrowserRealtimeMetrics {
    const renderedFrame = this.getCurrentFrame();
    const read = Atomics.load(this.control, ControlWord.COMMAND_READ);
    const write = Atomics.load(this.control, ControlWord.COMMAND_WRITE);
    const loopFrames = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const recordingFrames = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const trackCapacityFrames = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const trackStates = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const trackPositions = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const historyDepth = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);
    const storageSegments = new Array<number>(BROWSER_REALTIME_TRACK_COUNT);

    for (let track = 0; track < BROWSER_REALTIME_TRACK_COUNT; track += 1) {
      const metadata = this.trackMetadata[track];
      loopFrames[track] = metadata ? Atomics.load(metadata, TrackMetaWord.LOOP_FRAMES) : 0;
      recordingFrames[track] = metadata ? Atomics.load(metadata, TrackMetaWord.RECORDING_FRAMES) : 0;
      trackCapacityFrames[track] = metadata ? Atomics.load(metadata, TrackMetaWord.CAPACITY_FRAMES) : 0;
      trackStates[track] = Atomics.load(this.trackStates, track);
      trackPositions[track] = this.trackPositions[track] ?? 0;
      historyDepth[track] = metadata ? Atomics.load(metadata, TrackMetaWord.HISTORY_LENGTH) : 0;
      const store = this.trackStores[track];
      const activeSlot = metadata ? Atomics.load(metadata, TrackMetaWord.ACTIVE_TAKE_SLOT) : -1;
      storageSegments[track] = store?.takes[activeSlot]?.buffers.length ?? 0;
    }

    const deadlineMetricAvailable = Atomics.load(this.control, ControlWord.DEADLINE_METRIC_AVAILABLE) !== 0;
    const deadlineMisses = Atomics.load(this.control, ControlWord.DEADLINE_MISSES);

    return {
      sampleRate: this.sampleRate,
      quantumFrames: (() => {
        const observed = Atomics.load(this.control, ControlWord.LAST_QUANTUM_FRAMES);
        return observed > 0 ? observed : null;
      })(),
      renderedFrame,
      underruns: Atomics.load(this.control, ControlWord.UNDERRUNS),
      commandQueueDepth: (write - read) >>> 0,
      loopFrames,
      recordingFrames,
      trackStates,
      trackPositions,
      outputMonitorEnabled: Atomics.load(this.control, ControlWord.OUTPUT_MONITOR_ENABLED) !== 0,
      backendMode: 'sab-worklet',
      lastAckSequence: Atomics.load(this.control, ControlWord.LAST_ACK_SEQUENCE) >>> 0,
      commandOverruns: Atomics.load(this.control, ControlWord.COMMAND_OVERRUNS),
      processDeadlineMisses: deadlineMetricAvailable ? deadlineMisses : null,
      deadlineMetricAvailable,
      inputDropoutBlocks: Atomics.load(this.control, ControlWord.INPUT_DROPOUT_BLOCKS),
      trackCapacityOverruns: Atomics.load(this.control, ControlWord.TRACK_CAPACITY_OVERRUNS),
      maxTrackFrames: BROWSER_REALTIME_MAX_TRACK_FRAMES,
      trackCapacityFrames,
      inputDropoutFrames: Atomics.load(this.control, ControlWord.INPUT_DROPOUT_FRAMES),
      sharedDspProcessFailures: Atomics.load(this.control, ControlWord.SHARED_DSP_PROCESS_FAILURES),
      storageAllocatedBytes: this.storageAllocatedBytes,
      storageGrowthRequests: this.storageGrowthRequests,
      storageGrowthFailures: this.storageGrowthFailures,
      historyDepth,
      storageSegments,
    };
  }

  public getTrackMetadata(track: number): Int32Array | null {
    this.assertTrackIndex(track);
    return this.trackMetadata[track] ?? null;
  }

  /** Return the Worklet sample frame at which this take actually began. */
  public getTrackRecordingStartFrame(track: number): number | null {
    this.assertTrackIndex(track);
    const metadata = this.trackMetadata[track];
    if (!metadata) return null;
    return frameFromWords(
      Atomics.load(metadata, TrackMetaWord.RECORD_START_LOW),
      Atomics.load(metadata, TrackMetaWord.RECORD_START_HIGH),
    );
  }

  public getTrackSamples(track: number, channel: 0 | 1 = 0): Float32Array | null {
    this.assertTrackIndex(track);
    return (channel === 0 ? this.trackSamplesLeft[track] : this.trackSamplesRight[track]) ?? null;
  }

  public getTrackChannelSamples(track: number, channel: 0 | 1): Float32Array | null {
    return this.getTrackSamples(track, channel);
  }

  public dispose() {
    this.disposed = true;
    this.failAllWaiters(new Error('Browser realtime runtime closed before acknowledgement.'));
    this.node.port.onmessage = null;
    this.node.port.onmessageerror = null;
  }

  private allocateStorage(
    expectedBytes: number,
    create: () => SharedArrayBuffer,
    reservation?: StorageReservation,
  ): SharedArrayBuffer {
    const coveredBytes = Math.min(expectedBytes, reservation?.remainingBytes ?? 0);
    if (this.storageAllocatedBytes + this.reservedStorageBytes - coveredBytes + expectedBytes > BROWSER_REALTIME_MAX_STORAGE_BYTES) {
      throw new Error(`Realtime track storage limit of ${BROWSER_REALTIME_MAX_STORAGE_BYTES} bytes would be exceeded.`);
    }
    const buffer = create();
    if (buffer.byteLength !== expectedBytes) throw new Error('Realtime storage allocation did not match its preflight size.');
    if (reservation && coveredBytes > 0) {
      reservation.remainingBytes -= coveredBytes;
      this.reservedStorageBytes -= coveredBytes;
    }
    this.storageAllocatedBytes += buffer.byteLength;
    return buffer;
  }

  private reserveStorage(additionalBytes: number, releasableBytes: number, track: number): StorageReservation {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0 ||
        !Number.isSafeInteger(releasableBytes) || releasableBytes < 0) {
      throw new RangeError('Realtime storage reservation is invalid.');
    }
    if (this.storageAllocatedBytes + this.reservedStorageBytes + additionalBytes - releasableBytes >
        BROWSER_REALTIME_MAX_STORAGE_BYTES) {
      throw new Error(`Track ${track + 1} take would exceed the ${BROWSER_REALTIME_MAX_STORAGE_BYTES}-byte realtime storage budget; existing history was preserved.`);
    }
    this.reservedStorageBytes += additionalBytes;
    return { remainingBytes: additionalBytes, deferredBytes: 0 };
  }

  /** Reserve both the temporary flatten and its following take before any history mutation. */
  private reserveCompactionStorage(
    anchorBytes: number,
    takeBytes: number,
    releasedPrefixBytes: number,
    track: number,
  ): StorageReservation {
    if (![anchorBytes, takeBytes, releasedPrefixBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new RangeError('History compaction storage reservation is invalid.');
    }
    // The reservation protects the temporary anchor first. Only the portion
    // of the following take not covered by prefix buffers that compaction will
    // release is held concurrently; those release credits are promoted to a
    // full take reservation at the atomic Worklet swap.
    const deferredBytes = Math.min(takeBytes, releasedPrefixBytes);
    const stagedTakeBytes = takeBytes - deferredBytes;
    const additionalBytes = anchorBytes + stagedTakeBytes;
    if (this.storageAllocatedBytes + this.reservedStorageBytes + additionalBytes > BROWSER_REALTIME_MAX_STORAGE_BYTES) {
      throw new Error(
        `Track ${track + 1} cannot compact history and prepare its take within the ${BROWSER_REALTIME_MAX_STORAGE_BYTES}-byte realtime storage budget; existing history was preserved.`,
      );
    }
    this.reservedStorageBytes += additionalBytes;
    return { remainingBytes: additionalBytes, deferredBytes };
  }

  private releaseStorageReservation(reservation: StorageReservation): void {
    this.reservedStorageBytes = Math.max(0, this.reservedStorageBytes - reservation.remainingBytes);
    reservation.remainingBytes = 0;
    reservation.deferredBytes = 0;
  }

  private estimateReleasedTakeBytes(store: RuntimeTrackStore, slot: number, preservePrimary: boolean): number {
    const begin = preservePrimary ? 1 : slot;
    let releasedBytes = 0;
    for (let index = begin; index < store.takes.length; index += 1) {
      const take = store.takes[index];
      if (!take) continue;
      const firstReleasedSegment = take.usedPrimary ? 1 : 0;
      for (let segment = firstReleasedSegment; segment < take.buffers.length; segment += 1) {
        releasedBytes += take.buffers[segment]?.byteLength ?? 0;
      }
    }
    return releasedBytes;
  }

  private async attachTakeSegment(
    track: number,
    slot: number,
    segmentIndex: number,
    take: RuntimeTakeStore,
    reservation?: StorageReservation,
  ): Promise<void> {
    if (segmentIndex >= BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE) throw new Error('Track take reached its segment limit.');
    if (take.buffers[segmentIndex]) return;
    const buffer = this.allocateStorage(
      TAKE_SEGMENT_BYTES,
      () => createTakeSegmentBuffer(BROWSER_REALTIME_STORAGE_BLOCK_FRAMES),
      reservation,
    );
    const metadata = new Int32Array(buffer, 0, TRACK_META_BYTES / Int32Array.BYTES_PER_ELEMENT);
    const left = new Float32Array(buffer, TRACK_META_BYTES, BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
    const right = new Float32Array(
      buffer,
      TRACK_META_BYTES + BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
      BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
    );
    const mask = new Uint8Array(
      buffer,
      TRACK_META_BYTES + 2 * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
      BROWSER_REALTIME_STORAGE_BLOCK_FRAMES,
    );
    try {
      await this.waitForTakeMessage(
        `segment:${track}:${slot}:${segmentIndex}`,
        'TAKE_SEGMENT_ATTACHED',
        { type: 'ATTACH_TAKE_SEGMENT', track, takeSlot: slot, segmentIndex, buffer },
      );
    } catch (error) {
      this.storageAllocatedBytes -= buffer.byteLength;
      throw error;
    }
    take.buffers[segmentIndex] = buffer;
    take.left[segmentIndex] = left;
    take.right[segmentIndex] = right;
    take.replaceMasks[segmentIndex] = mask;
    if (segmentIndex === 0) take.metadata = metadata;
    const store = this.trackStores[track];
    if (store && Atomics.load(store.metadata, TrackMetaWord.ACTIVE_TAKE_SLOT) === slot) {
      Atomics.store(store.metadata, TrackMetaWord.CAPACITY_FRAMES, take.buffers.length * BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
    }
  }

  private async waitForTakeMessage(
    key: string,
    expectedType: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.takeWaiters.delete(key);
        reject(new Error(`Realtime worklet did not acknowledge ${expectedType}.`));
      }, 2_000);
      this.takeWaiters.set(key, { resolve, reject, timeout });
      this.node.port.postMessage(message);
    });
  }

  private releaseTakesFrom(track: number, slot: number, preservePrimary: boolean): void {
    const store = this.trackStores[track];
    if (!store) return;
    const begin = preservePrimary ? 1 : slot;
    for (let index = begin; index < store.takes.length; index += 1) {
      const take = store.takes[index];
      if (!take) continue;
      if (take.usedPrimary) {
        // The first SAB remains attached as the track metadata anchor. Other
        // primary reserve chunks can be reclaimed after the worklet drops the
        // old take references in PREPARE_TAKE.
        for (let segment = 1; segment < take.buffers.length; segment += 1) {
          this.storageAllocatedBytes -= take.buffers[segment]?.byteLength ?? 0;
        }
        store.takes[index] = null;
      } else {
        for (const buffer of take.buffers) this.storageAllocatedBytes -= buffer.byteLength;
        store.takes[index] = null;
      }
    }
  }

  private releaseTrackStorage(track: number): void {
    const store = this.trackStores[track];
    if (!store) return;
    for (const take of store.takes) {
      if (!take || take.usedPrimary) continue;
      for (const buffer of take.buffers) this.storageAllocatedBytes -= buffer.byteLength;
    }
    this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - store.buffer.byteLength);
    const primary = store.takes[0];
    if (primary) {
      for (let index = 1; index < primary.buffers.length; index += 1) {
        this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - (primary.buffers[index]?.byteLength ?? 0));
      }
    }
  }

  private modeToCode(mode: BrowserRealtimeTakeMode | TrackRuntimeSettings['dubMode']): number {
    if (mode === 'REPLACE1') return 2;
    if (mode === 'REPLACE2') return 3;
    if (mode === 'OVERDUB') return 1;
    return 0;
  }

  private isProjectMutationOpcode(opcode: number): boolean {
    return opcode === BrowserRealtimeOpcode.START_RECORD || opcode === BrowserRealtimeOpcode.STOP_RECORD ||
      opcode === BrowserRealtimeOpcode.PLAY || opcode === BrowserRealtimeOpcode.STOP ||
      opcode === BrowserRealtimeOpcode.START_OVERDUB || opcode === BrowserRealtimeOpcode.STOP_OVERDUB ||
      opcode === BrowserRealtimeOpcode.CLEAR || opcode === BrowserRealtimeOpcode.UNDO ||
      opcode === BrowserRealtimeOpcode.REDO || opcode === BrowserRealtimeOpcode.MARK ||
      opcode === BrowserRealtimeOpcode.RESTORE_MARK || opcode === BrowserRealtimeOpcode.CLEAR_MARK ||
      opcode === BrowserRealtimeOpcode.RESET_BACK || opcode === BrowserRealtimeOpcode.LOAD_TRACK ||
      opcode === BrowserRealtimeOpcode.SET_REVERSE || opcode === BrowserRealtimeOpcode.SET_SPEED ||
      opcode === BrowserRealtimeOpcode.SET_ONE_SHOT || opcode === BrowserRealtimeOpcode.SET_STOP_MODE ||
      opcode === BrowserRealtimeOpcode.SET_START_MODE || opcode === BrowserRealtimeOpcode.SET_FADE ||
      opcode === BrowserRealtimeOpcode.SET_AUTO_REC || opcode === BrowserRealtimeOpcode.SET_DUB_MODE ||
      opcode === BrowserRealtimeOpcode.SET_RECORD_BPM || opcode === BrowserRealtimeOpcode.SET_TEMPO_SYNC ||
      opcode === BrowserRealtimeOpcode.SET_ALIGNMENT || opcode === BrowserRealtimeOpcode.SET_BPM ||
      opcode === BrowserRealtimeOpcode.SET_CLOCK || opcode === BrowserRealtimeOpcode.SET_MASTER_CLOCK_EPOCH ||
      opcode === BrowserRealtimeOpcode.SET_RHYTHM ||
      opcode === BrowserRealtimeOpcode.SYNC_EXTERNAL_CLOCK;
  }

  private yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  private releaseMarkSnapshot(track: number): void {
    const snapshot = this.markSnapshots[track];
    if (!snapshot) return;
    this.storageAllocatedBytes = Math.max(0, this.storageAllocatedBytes - snapshot.byteLength);
    this.markSnapshots[track] = null;
  }

  private readHistorySample(track: number, frame: number, channel: 0 | 1, cursor: number): number {
    const store = this.trackStores[track];
    if (!store) return 0;
    let sample = 0;
    for (let slot = 0; slot < cursor; slot += 1) {
      const take = store.takes[slot];
      if (!take || take.frameCount <= 0) continue;
      const sourceFrame = frame % take.frameCount;
      const segment = Math.floor(sourceFrame / BROWSER_REALTIME_STORAGE_BLOCK_FRAMES);
      const offset = sourceFrame % BROWSER_REALTIME_STORAGE_BLOCK_FRAMES;
      const value = (channel === 0 ? take.left[segment] : take.right[segment])?.[offset] ?? 0;
      if (take.mode === 'BASE') {
        sample = value;
      } else if (take.mode === 'OVERDUB') {
        sample += value;
      } else if (take.replaceMasks[segment]?.[offset]) {
        sample = value;
      }
    }
    return sample;
  }

  private handleMessage(message: BrowserRealtimeRuntimeMessage) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'TAKE_COMMITTED' && typeof message.track === 'number' &&
        typeof message.takeSlot === 'number' && typeof message.frameCount === 'number') {
      const take = this.trackStores[message.track]?.takes[message.takeSlot];
      if (take && message.frameCount >= 0) {
        take.frameCount = Math.floor(message.frameCount);
        take.mode = message.mode === 1 ? 'OVERDUB'
          : message.mode === 2 ? 'REPLACE1' : message.mode === 3 ? 'REPLACE2' : 'BASE';
      }
    } else if (message.type === 'TRACK_ATTACHED' && typeof message.track === 'number') {
      const waiter = this.attachWaiters.get(message.track);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.attachWaiters.delete(message.track);
        if (message.channelCount !== BROWSER_REALTIME_TRACK_CHANNEL_COUNT ||
            message.layoutVersion !== BROWSER_REALTIME_LAYOUT_VERSION ||
            message.storageLayout !== BROWSER_REALTIME_LAYOUT_PLANAR_LR) {
          waiter.reject(new Error(
            `Track ${message.track + 1} storage handshake mismatch: expected ${BROWSER_REALTIME_TRACK_CHANNEL_COUNT}-channel planar LR layout v${BROWSER_REALTIME_LAYOUT_VERSION}.`,
          ));
        } else {
          waiter.resolve();
        }
      }
    } else if (message.type === 'TRACK_HISTORY_RELEASED' && typeof message.track === 'number') {
      this.resolveTakeWaiter(`release:${message.track}`);
    } else if (message.type === 'TRACK_HISTORY_COMPACTED' && typeof message.track === 'number') {
      this.resolveTakeWaiter(`compact:${message.track}`);
    } else if (message.type === 'TRACK_HISTORY_COMPACT_ERROR' && typeof message.track === 'number') {
      this.rejectTakeWaiter(
        `compact:${message.track}`,
        new Error(message.message || 'Realtime worklet rejected history compaction.'),
      );
    } else if (message.type === 'TRACK_COMPACTION_SEGMENTS_ATTACHED' &&
        typeof message.track === 'number' && typeof message.firstSegment === 'number') {
      this.resolveTakeWaiter(`compact-segments:${message.track}:${message.firstSegment}`);
    } else if (message.type === 'TRACK_COMPACTION_SEGMENTS_ERROR' &&
        typeof message.track === 'number' && typeof message.firstSegment === 'number') {
      this.rejectTakeWaiter(
        `compact-segments:${message.track}:${message.firstSegment}`,
        new Error(message.message || 'Realtime worklet rejected history compaction storage.'),
      );
    } else if (message.type === 'TRACK_COMPACTION_ABORTED' && typeof message.track === 'number') {
      this.resolveTakeWaiter(`compact-abort:${message.track}`);
    } else if (message.type === 'TAKE_PREPARED' && typeof message.track === 'number') {
      this.resolveTakeWaiter(`prepare:${message.track}`);
    } else if (message.type === 'TAKE_PREPARE_ERROR' && typeof message.track === 'number') {
      this.rejectTakeWaiter(`prepare:${message.track}`, new Error(message.message || 'Realtime worklet rejected the take allocation.'));
    } else if (message.type === 'TAKE_SEGMENT_ATTACHED' && typeof message.track === 'number' &&
        typeof message.takeSlot === 'number' && typeof message.segmentIndex === 'number') {
      this.resolveTakeWaiter(`segment:${message.track}:${message.takeSlot}:${message.segmentIndex}`);
    } else if (message.type === 'TAKE_SEGMENT_ERROR' && typeof message.track === 'number' &&
        typeof message.takeSlot === 'number' && typeof message.segmentIndex === 'number') {
      this.rejectTakeWaiter(
        `segment:${message.track}:${message.takeSlot}:${message.segmentIndex}`,
        new Error(message.message || 'Realtime worklet rejected a take storage segment.'),
      );
    } else if (message.type === 'TRACK_STORAGE_LOW' && typeof message.track === 'number' &&
        typeof message.takeSlot === 'number') {
      void this.growTakeStorage(message.track, message.takeSlot);
    } else if (message.type === 'LOOPBACK_ARMED') {
      const waiter = this.loopbackArmWaiter;
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.loopbackArmWaiter = null;
        waiter.resolve();
      }
    } else if (message.type === 'LOOPBACK_ARM_ERROR') {
      const waiter = this.loopbackArmWaiter;
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.loopbackArmWaiter = null;
        waiter.reject(new Error(message.message || 'Loopback capture storage was rejected by the worklet.'));
      }
    } else if (message.type === 'RHYTHM_UPDATE_ACK' && typeof message.requestId === 'number') {
      const requestId = message.requestId >>> 0;
      const waiter = this.rhythmWaiters.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.rhythmWaiters.delete(requestId);
        if (message.ok === true) waiter.resolve();
        else waiter.reject(new Error(message.message || 'Realtime worklet rejected the rhythm update.'));
      }
    } else if (message.type === 'TRACK_ATTACH_ERROR' && typeof message.track === 'number') {
      const waiter = this.attachWaiters.get(message.track);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.attachWaiters.delete(message.track);
        waiter.reject(new Error(message.message || `Track ${message.track + 1} storage layout was rejected by the worklet.`));
      }
    } else if (message.type === 'ACK' && typeof message.sequence === 'number') {
      const sequence = message.sequence >>> 0;
      const waiter = this.ackWaiters.get(sequence);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.ackWaiters.delete(sequence);
        const executedFrame = message.executedFrame ?? 0;
        const targetFrame = message.targetFrame ?? waiter.targetFrame;
        const intentToScheduledFrames = targetFrame - waiter.intentFrame;
        const scheduledToActualFrames = executedFrame - targetFrame;
        waiter.resolve({
          sequence,
          opcode: message.opcode ?? 0,
          track: message.track ?? -1,
          intentFrame: waiter.intentFrame,
          executedFrame,
          targetFrame,
          intentToScheduledFrames,
          scheduledToActualFrames,
          intentToScheduledMs: (intentToScheduledFrames / this.sampleRate) * 1000,
          scheduledToActualMs: (scheduledToActualFrames / this.sampleRate) * 1000,
          status: message.status ?? BrowserRealtimeStatus.INVALID_STATE,
          loopFrames: message.loopFrames ?? 0,
          recordingFrames: message.recordingFrames ?? 0,
        });
      }
    }

    this.messageHandler?.(message);
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) >>> 0;
    if (this.sequence === 0) this.sequence = 1;
    return this.sequence;
  }

  private assertTrackIndex(track: number) {
    if (!Number.isInteger(track) || track < 0 || track >= BROWSER_REALTIME_TRACK_COUNT) {
      throw new RangeError(`Track index must be between 0 and ${BROWSER_REALTIME_TRACK_COUNT - 1}.`);
    }
  }

  private assertProjectToken(token: symbol): void {
    if (!this.projectOperationLocked || token !== this.projectLockToken) {
      throw new Error('Project operation requires the currently active lock token.');
    }
  }

  private failAllWaiters(error: Error) {
    for (const waiter of this.attachWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.attachWaiters.clear();
    for (const waiter of this.takeWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.takeWaiters.clear();
    for (const waiter of this.ackWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.ackWaiters.clear();
    for (const waiter of this.rhythmWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.rhythmWaiters.clear();
    if (this.loopbackArmWaiter) {
      clearTimeout(this.loopbackArmWaiter.timeout);
      this.loopbackArmWaiter.reject(error);
      this.loopbackArmWaiter = null;
    }
  }

  private resolveTakeWaiter(key: string): void {
    const waiter = this.takeWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.takeWaiters.delete(key);
    waiter.resolve();
  }

  private rejectTakeWaiter(key: string, error: Error): void {
    const waiter = this.takeWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.takeWaiters.delete(key);
    waiter.reject(error);
  }

  private async growTakeStorage(track: number, slot: number): Promise<void> {
    const key = `${track}:${slot}`;
    if (this.pendingStorageGrowth.has(key) || this.disposed) return;
    const store = this.trackStores[track];
    const take = store?.takes[slot];
    if (!store || !take) return;
    this.pendingStorageGrowth.add(key);
    this.storageGrowthRequests += 1;
    try {
      const targetCount = Math.min(BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE, take.buffers.length + BROWSER_REALTIME_STORAGE_BATCH_BLOCKS);
      await this.ensureTakeSegments(track, slot, targetCount, take);
      this.node.port.postMessage({ type: 'STORAGE_GROWTH_COMPLETE', track, takeSlot: slot, segmentCount: take.buffers.length });
    } catch (error) {
      this.storageGrowthFailures += 1;
      this.node.port.postMessage({
        type: 'STORAGE_GROWTH_FAILED', track, takeSlot: slot,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pendingStorageGrowth.delete(key);
    }
  }

  private async ensureTakeSegments(
    track: number,
    slot: number,
    segmentCount: number,
    take: RuntimeTakeStore,
    reservation?: StorageReservation,
  ): Promise<void> {
    if (!Number.isInteger(segmentCount) || segmentCount < 0 || segmentCount > BROWSER_REALTIME_MAX_SEGMENTS_PER_TAKE) {
      throw new RangeError('Requested take capacity exceeds the bounded segment limit.');
    }
    for (let index = take.buffers.length; index < segmentCount; index += 1) {
      await this.attachTakeSegment(track, slot, index, take, reservation);
    }
  }

}

function float64ToWords(value: number): [number, number] {
  const view = new DataView(new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT));
  view.setFloat64(0, value, true);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}
