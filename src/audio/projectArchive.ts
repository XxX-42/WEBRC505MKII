/**
 * Versioned, bounded project archives for five tracks of mono/stereo PCM.
 *
 * Archive layout (all integers little-endian):
 *   8 bytes magic | u32 manifest byte length | UTF-8 JSON manifest | PCM payload
 * PCM samples are raw Float32 values in little-endian interleaved frame order.
 * The manifest intentionally contains project name/BPM and track audio metadata
 * only; effects and rhythm settings are outside this archive format.
 */

const MAGIC = new Uint8Array([0x52, 0x43, 0x35, 0x30, 0x35, 0x50, 0x41, 0x00]); // "RC505PA\0"
const HEADER_BYTES = MAGIC.byteLength + 4;
const FORMAT = 'rc505-project-archive';
const LEGACY_VERSION = 1;
const VERSION = 2;
const TRACK_COUNT = 5;
const MAX_PAYLOAD_BYTES = 768 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = MAX_PAYLOAD_BYTES + HEADER_BYTES + MAX_MANIFEST_BYTES;
const MAX_NAME_BYTES = 512;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 384_000;
const MIN_BPM = 40;
const MAX_BPM = 300;

/** Public limits for storage-layer preflight checks. */
export const PROJECT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxProjectNameUtf8Bytes: MAX_NAME_BYTES,
});

export interface ProjectArchiveTransport {
  masterTrackId: number | null;
  measureLengthSeconds: number;
  masterLoopLengthSamples: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
}

/**
 * A synchronous snapshot of Browser state when a user starts an asynchronous
 * project load. It prevents a later decode/read completion from overwriting
 * edits made while the archive was being prepared. This is deliberately not
 * serialized into the project format.
 */
export interface BrowserProjectRestoreToken {
  readonly tracks: readonly {
    readonly revision: number;
    readonly historyBusy: boolean;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly retainedHistoryBytes: number;
    readonly unavailableReason: string | null;
  }[];
  readonly transport: {
    readonly bpm: number;
    readonly state: string;
    readonly masterTrackId: number | null;
    readonly measureLengthSeconds: number;
    readonly masterLoopLengthSamples: number;
    readonly timeSignatureNumerator: number;
    readonly timeSignatureDenominator: number;
  };
}

/** Fresh Native host revision plus the app-owned project transport state at load start. */
export interface NativeProjectRestoreToken {
  readonly projectContentRevision: number;
  /** App-owned project transport mutation epoch; unlike values alone it detects an edit-and-revert race. */
  readonly projectTransportMutationRevision: number;
  readonly sampleRate: number;
  readonly transport: {
    readonly bpm: number;
    readonly state: string;
    readonly masterTrackId: number | null;
    readonly measureLengthSeconds: number;
    readonly masterLoopLengthSamples: number;
    readonly timeSignatureNumerator: number;
    readonly timeSignatureDenominator: number;
  };
}

/** Operation-start guard shared by every ProjectMemory import entry point. */
export interface ProjectRestoreOperationToken {
  readonly mode: 'browser' | 'native';
  readonly modeGeneration: number;
  readonly browser?: BrowserProjectRestoreToken;
  readonly native?: NativeProjectRestoreToken;
}

export const PROJECT_ARCHIVE_DEFAULT_TRANSPORT: Readonly<ProjectArchiveTransport> = Object.freeze({
  masterTrackId: null,
  measureLengthSeconds: 0,
  masterLoopLengthSamples: 0,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4,
});

export interface ProjectArchiveTrackMetadata {
  sampleRate: number;
  frameCount: number;
  channels: 1 | 2;
  /** Original take tempo when verified at capture/import time; null means unknown. */
  originalTempoBpm?: number | null;
}

export type ProjectArchiveTrack = ProjectArchiveTrackMetadata & (
  /** Interleaved mono or stereo samples, frame by frame. */
  | { pcm: Float32Array; channelData?: never }
  /** One Float32Array per channel; the encoder interleaves into the archive. */
  | { channelData: readonly Float32Array[]; pcm?: never }
);

export type ProjectArchiveTrackList = readonly [
  ProjectArchiveTrack | null,
  ProjectArchiveTrack | null,
  ProjectArchiveTrack | null,
  ProjectArchiveTrack | null,
  ProjectArchiveTrack | null,
];

export interface DecodedProjectArchiveTrack extends ProjectArchiveTrackMetadata {
  originalTempoBpm: number | null;
  pcm: Float32Array;
}

export type DecodedProjectArchiveTrackList = readonly [
  DecodedProjectArchiveTrack | null,
  DecodedProjectArchiveTrack | null,
  DecodedProjectArchiveTrack | null,
  DecodedProjectArchiveTrack | null,
  DecodedProjectArchiveTrack | null,
];

export interface ProjectArchiveInput {
  name: string;
  bpm: number;
  tracks: ProjectArchiveTrackList;
  /** Omit to use stopped, unmastered 4/4 transport defaults. */
  transport?: ProjectArchiveTransport;
}

export interface ProjectArchive extends Omit<ProjectArchiveInput, 'transport' | 'tracks'> {
  version: 1 | 2;
  tracks: DecodedProjectArchiveTrackList;
  transport: ProjectArchiveTransport;
}

interface TrackManifest {
  sampleRate: number;
  frameCount: number;
  channels: 1 | 2;
  originalTempoBpm?: number | null;
  payloadOffset: number;
  byteLength: number;
  sha256: string;
}

interface ArchiveManifest {
  format: typeof FORMAT;
  version: 1 | typeof VERSION;
  project: {
    name: string;
    bpm: number;
    transport: ProjectArchiveTransport;
  };
  tracks: Array<TrackManifest | null>;
}

export interface ProjectArchiveEncodeOptions {
  /** Defaults to v1 until the Native project load/save path is proven v2-compatible. */
  version?: 1 | 2;
}

/**
 * Read only the declared archive version for UI/slot labels. This is not an
 * archive validator; callers must still use decodeProjectArchive before load.
 */
export function readProjectArchiveVersion(input: ArrayBuffer | ArrayBufferView): 1 | 2 {
  const bytes = toBytes(input);
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Project archive is truncated before its header.');
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new Error('Project archive has invalid magic bytes.');
  }
  const manifestByteLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(MAGIC.byteLength, true);
  const payloadStart = checkedAdd(HEADER_BYTES, manifestByteLength, 'manifest end');
  if (manifestByteLength === 0 || manifestByteLength > MAX_MANIFEST_BYTES || payloadStart > bytes.byteLength) {
    throw new Error('Project archive manifest length is invalid.');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES, payloadStart))) as unknown;
  } catch {
    throw new Error('Project archive manifest is not valid UTF-8 JSON.');
  }
  if (!isRecord(manifest) || (manifest.version !== 1 && manifest.version !== 2)) {
    throw new Error('Project archive version is unsupported.');
  }
  return manifest.version;
}

/** Encode a project as a bounded, versioned binary archive. */
export async function encodeProjectArchive(project: ProjectArchiveInput, options: ProjectArchiveEncodeOptions = {}): Promise<Uint8Array> {
  const version = options.version ?? LEGACY_VERSION;
  if (version !== LEGACY_VERSION && version !== VERSION) throw new Error('Project archive version is unsupported.');
  validateProject(project, version);

  const payloadByteLength = project.tracks.reduce((total, track) => {
    if (track === null) return total;
    const byteLength = checkedPcmByteLength(track.frameCount, track.channels);
    return checkedAdd(total, byteLength, 'PCM payload size');
  }, 0);
  if (payloadByteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Project PCM payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
  }
  const estimatedMinimum = checkedAdd(HEADER_BYTES + 2, payloadByteLength, 'archive size');
  if (estimatedMinimum > MAX_ARCHIVE_BYTES) {
    throw new Error(`Project archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit.`);
  }

  const trackManifests: Array<TrackManifest | null> = [];
  let payloadOffset = 0;

  for (const track of project.tracks) {
    if (track === null) {
      trackManifests.push(null);
      continue;
    }

    const byteLength = checkedPcmByteLength(track.frameCount, track.channels);
    trackManifests.push({
      sampleRate: track.sampleRate,
      frameCount: track.frameCount,
      channels: track.channels,
      ...(version === VERSION ? { originalTempoBpm: track.originalTempoBpm ?? null } : {}),
      payloadOffset,
      byteLength,
      // SHA-256 has a fixed-width hex encoding, so this placeholder can be
      // replaced in-place after writing and hashing the final PCM bytes.
      sha256: '0'.repeat(64),
    });
    payloadOffset = checkedAdd(payloadOffset, byteLength, 'PCM payload offset');
  }

  const manifest: ArchiveManifest = {
    format: FORMAT,
    version,
    project: { name: project.name, bpm: project.bpm, transport: normalizeTransport(project.transport) },
    tracks: trackManifests,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`Project archive manifest exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`);
  }

  const archiveByteLength = checkedAdd(checkedAdd(HEADER_BYTES, manifestBytes.byteLength, 'archive size'), payloadByteLength, 'archive size');
  if (archiveByteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Project archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit.`);
  }

  const archive = new Uint8Array(archiveByteLength);
  archive.set(MAGIC, 0);
  new DataView(archive.buffer).setUint32(MAGIC.byteLength, manifestBytes.byteLength, true);
  archive.set(manifestBytes, HEADER_BYTES);

  const payloadStart = HEADER_BYTES + manifestBytes.byteLength;
  const archiveView = new DataView(archive.buffer);
  for (let index = 0; index < TRACK_COUNT; index += 1) {
    const track = project.tracks[index]!;
    const descriptor = trackManifests[index]!;
    if (track === null || descriptor === null) continue;
    const absoluteOffset = payloadStart + descriptor.payloadOffset;
    writeTrackPcm(track, archiveView, absoluteOffset, index + 1);
    descriptor.sha256 = await sha256Hex(archive.subarray(absoluteOffset, absoluteOffset + descriptor.byteLength));
  }

  const finalManifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (finalManifestBytes.byteLength !== manifestBytes.byteLength) {
    throw new Error('Project archive manifest changed size while writing track hashes.');
  }
  archive.set(finalManifestBytes, HEADER_BYTES);
  return archive;
}

/**
 * Decode and fully validate an archive before returning any project data.
 * `input` can be a complete ArrayBuffer or any view containing exactly the
 * archive bytes (for example a Uint8Array returned by fetch).
 */
export async function decodeProjectArchive(input: ArrayBuffer | ArrayBufferView): Promise<ProjectArchive> {
  const bytes = toBytes(input);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`Project archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit.`);
  }
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error('Project archive is truncated before its header.');
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new Error('Project archive has invalid magic bytes.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestByteLength = view.getUint32(MAGIC.byteLength, true);
  if (manifestByteLength === 0 || manifestByteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Project archive manifest length is invalid.');
  }
  const payloadStart = checkedAdd(HEADER_BYTES, manifestByteLength, 'manifest end');
  if (payloadStart > bytes.byteLength) throw new Error('Project archive is truncated inside its manifest.');

  let manifest: unknown;
  let manifestText = '';
  try {
    manifestText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES, payloadStart));
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    throw new Error('Project archive manifest is not valid UTF-8 JSON.');
  }
  assertNoDuplicateJsonObjectKeys(manifestText);
  const parsedManifest = validateManifest(manifest);

  const payload = bytes.subarray(payloadStart);
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Project PCM payload exceeds the ${MAX_PAYLOAD_BYTES}-byte limit.`);
  }
  const decodedTracks: Array<ProjectArchiveTrack | null> = [];
  let expectedOffset = 0;
  const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  for (let index = 0; index < TRACK_COUNT; index += 1) {
    const descriptor = parsedManifest.tracks[index]!;
    if (descriptor === null) {
      decodedTracks.push(null);
      continue;
    }

    const expectedByteLength = checkedPcmByteLength(descriptor.frameCount, descriptor.channels);
    if (descriptor.byteLength !== expectedByteLength) {
      throw new Error(`Track ${index + 1} has inconsistent PCM byte length.`);
    }
    if (descriptor.payloadOffset !== expectedOffset) {
      throw new Error(`Track ${index + 1} payload is not contiguous.`);
    }
    const endOffset = checkedAdd(expectedOffset, expectedByteLength, 'track payload end');
    if (endOffset > payload.byteLength) throw new Error(`Track ${index + 1} PCM payload is truncated.`);

    const trackBytes = payload.subarray(expectedOffset, endOffset);
    if (await sha256Hex(trackBytes) !== descriptor.sha256) {
      throw new Error(`Track ${index + 1} PCM hash does not match the manifest.`);
    }

    const sampleCount = checkedMultiply(descriptor.frameCount, descriptor.channels, 'sample count');
    const pcm = new Float32Array(sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const sample = payloadView.getFloat32(expectedOffset + sampleIndex * 4, true);
      if (!Number.isFinite(sample)) {
        throw new Error(`Track ${index + 1} contains a non-finite PCM sample.`);
      }
      pcm[sampleIndex] = sample;
    }
    decodedTracks.push({
      sampleRate: descriptor.sampleRate,
      frameCount: descriptor.frameCount,
      channels: descriptor.channels,
      originalTempoBpm: descriptor.originalTempoBpm,
      pcm,
    });
    expectedOffset = endOffset;
  }

  if (expectedOffset !== payload.byteLength) {
    throw new Error('Project archive contains trailing or unaccounted payload bytes.');
  }

  return {
    version: parsedManifest.version,
    name: parsedManifest.project.name,
    bpm: parsedManifest.project.bpm,
    tracks: decodedTracks as unknown as DecodedProjectArchiveTrackList,
    transport: parsedManifest.project.transport,
  };
}

function validateProject(project: ProjectArchiveInput, version: 1 | 2): void {
  if (!isRecord(project) || !hasAllowedKeys(project, ['name', 'bpm', 'tracks', 'transport'], ['name', 'bpm', 'tracks'])) {
    throw new Error('Project must contain name, bpm, tracks, and optional transport metadata only.');
  }
  validateProjectMetadata(project.name, project.bpm);
  if (!Array.isArray(project.tracks) || project.tracks.length !== TRACK_COUNT) {
    throw new Error(`Project must contain exactly ${TRACK_COUNT} tracks.`);
  }
  for (let index = 0; index < TRACK_COUNT; index += 1) {
    const track = project.tracks[index]!;
    if (track === null) continue;
    if (!isRecord(track)) {
      throw new Error(`Track ${index + 1} must contain only PCM data and its audio metadata.`);
    }
    const candidate = track as unknown as ProjectArchiveTrack;
    const hasInterleavedPcm = Object.prototype.hasOwnProperty.call(track, 'pcm');
    const hasChannelData = Object.prototype.hasOwnProperty.call(track, 'channelData');
    const expectedKeys = hasInterleavedPcm
      ? ['sampleRate', 'frameCount', 'channels', 'originalTempoBpm', 'pcm']
      : ['sampleRate', 'frameCount', 'channels', 'originalTempoBpm', 'channelData'];
    const legacyKeys = hasInterleavedPcm
      ? ['sampleRate', 'frameCount', 'channels', 'pcm']
      : ['sampleRate', 'frameCount', 'channels', 'channelData'];
    if (hasInterleavedPcm === hasChannelData || !(hasExactKeys(track, expectedKeys) || hasExactKeys(track, legacyKeys))) {
      throw new Error(`Track ${index + 1} must contain one PCM representation and its audio metadata only.`);
    }
    validateOriginalTempoBpm(candidate.originalTempoBpm, index + 1);
    if (version === LEGACY_VERSION && candidate.originalTempoBpm !== undefined && candidate.originalTempoBpm !== null) {
      throw new Error(`Track ${index + 1} original tempo requires ProjectArchive v2; v1 export remains unchanged.`);
    }
    if (!Number.isSafeInteger(candidate.sampleRate) || candidate.sampleRate < MIN_SAMPLE_RATE || candidate.sampleRate > MAX_SAMPLE_RATE) {
      throw new Error(`Track ${index + 1} sample rate is outside the supported range.`);
    }
    if (!Number.isSafeInteger(candidate.frameCount) || candidate.frameCount < 1) {
      throw new Error(`Track ${index + 1} frame count must be a positive safe integer; use null for an empty track.`);
    }
    if (candidate.channels !== 1 && candidate.channels !== 2) {
      throw new Error(`Track ${index + 1} must be mono or stereo.`);
    }
    const sampleCount = checkedMultiply(candidate.frameCount, candidate.channels, `track ${index + 1} sample count`);
    if (hasInterleavedPcm) {
      if (!(candidate.pcm instanceof Float32Array) || sampleCount !== candidate.pcm.length) {
        throw new Error(`Track ${index + 1} interleaved PCM length does not match its frame and channel metadata.`);
      }
    } else {
      if (!Array.isArray(candidate.channelData) || candidate.channelData.length !== candidate.channels ||
          candidate.channelData.some((channel) => !(channel instanceof Float32Array) || channel.length !== candidate.frameCount)) {
        throw new Error(`Track ${index + 1} channel PCM lengths do not match its frame and channel metadata.`);
      }
    }
    checkedPcmByteLength(candidate.frameCount, candidate.channels);
  }
  const transport = project.transport === undefined ? PROJECT_ARCHIVE_DEFAULT_TRANSPORT : project.transport;
  validateTransport(transport, project.tracks, project.bpm);
}

function validateManifest(value: unknown): ArchiveManifest {
  if (!isRecord(value) || !hasExactKeys(value, ['format', 'version', 'project', 'tracks'])) {
    throw new Error('Project archive manifest has an unsupported schema.');
  }
  if (value.format !== FORMAT) throw new Error('Project archive manifest format is unsupported.');
  if (value.version !== 1 && value.version !== VERSION) throw new Error(`Project archive version ${String(value.version)} is unsupported.`);
  const version = value.version;
  if (!isRecord(value.project) || !hasAllowedKeys(value.project, ['name', 'bpm', 'transport'], ['name', 'bpm'])) {
    throw new Error('Project archive project metadata has an unsupported schema.');
  }
  validateProjectMetadata(value.project.name, value.project.bpm);
  if (!Array.isArray(value.tracks) || value.tracks.length !== TRACK_COUNT) {
    throw new Error(`Project archive manifest must contain exactly ${TRACK_COUNT} tracks.`);
  }

  const tracks: Array<TrackManifest | null> = [];
  for (let index = 0; index < TRACK_COUNT; index += 1) {
    const track = value.tracks[index];
    if (track === null) {
      tracks.push(null);
      continue;
    }
    const v1TrackKeys = ['sampleRate', 'frameCount', 'channels', 'payloadOffset', 'byteLength', 'sha256'];
    const v2TrackKeys = [...v1TrackKeys, 'originalTempoBpm'];
    if (!isRecord(track) || !(version === 1
      ? hasExactKeys(track, v1TrackKeys)
      : hasExactKeys(track, v2TrackKeys))) {
      throw new Error(`Track ${index + 1} metadata has an unsupported schema.`);
    }
    const sampleRate = track.sampleRate;
    const frameCount = track.frameCount;
    const channels = track.channels;
    const originalTempoBpm = version === 1 ? null : track.originalTempoBpm;
    validateOriginalTempoBpm(originalTempoBpm, index + 1);
    const payloadOffset = track.payloadOffset;
    const byteLength = track.byteLength;
    const sha256 = track.sha256;
    if (typeof sampleRate !== 'number' || !Number.isSafeInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
      throw new Error(`Track ${index + 1} sample rate is outside the supported range.`);
    }
    if (typeof frameCount !== 'number' || !Number.isSafeInteger(frameCount) || frameCount < 1) {
      throw new Error(`Track ${index + 1} frame count must be a positive safe integer; use null for an empty track.`);
    }
    if (channels !== 1 && channels !== 2) {
      throw new Error(`Track ${index + 1} must be mono or stereo.`);
    }
    if (typeof payloadOffset !== 'number' || !Number.isSafeInteger(payloadOffset) || payloadOffset < 0 ||
        typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(`Track ${index + 1} payload offsets must be non-negative safe integers.`);
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Track ${index + 1} SHA-256 digest is malformed.`);
    }
    checkedPcmByteLength(frameCount, channels);
    tracks.push({
      sampleRate,
      frameCount,
      channels,
      originalTempoBpm: originalTempoBpm as number | null,
      payloadOffset,
      byteLength,
      sha256,
    });
  }

  const transport = value.project.transport === undefined
    ? PROJECT_ARCHIVE_DEFAULT_TRANSPORT
    : value.project.transport;
  validateTransport(transport, tracks, value.project.bpm as number);

  return {
    format: FORMAT,
    version,
    project: {
      name: value.project.name as string,
      bpm: value.project.bpm as number,
      transport: normalizeTransport(transport as ProjectArchiveTransport),
    },
    tracks,
  };
}

function validateOriginalTempoBpm(value: unknown, trackNumber: number): void {
  if (value !== undefined && value !== null
    && (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM)) {
    throw new Error(`Track ${trackNumber} original tempo must be null or between ${MIN_BPM} and ${MAX_BPM} BPM.`);
  }
}

function validateProjectMetadata(name: unknown, bpm: unknown): void {
  if (typeof name !== 'string' || new TextEncoder().encode(name).byteLength > MAX_NAME_BYTES) {
    throw new Error(`Project name must be a string of at most ${MAX_NAME_BYTES} UTF-8 bytes.`);
  }
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new Error(`Project BPM must be between ${MIN_BPM} and ${MAX_BPM}.`);
  }
}

function validateTransport(value: unknown, tracks: readonly (ProjectArchiveTrack | TrackManifest | null)[], bpm: number): void {
  if (!isRecord(value) || !hasExactKeys(value, [
    'masterTrackId',
    'measureLengthSeconds',
    'masterLoopLengthSamples',
    'timeSignatureNumerator',
    'timeSignatureDenominator',
  ])) {
    throw new Error('Transport metadata has an unsupported schema.');
  }
  const masterTrackId = value.masterTrackId;
  if (masterTrackId !== null && (typeof masterTrackId !== 'number' || !Number.isSafeInteger(masterTrackId) || masterTrackId < 1 || masterTrackId > TRACK_COUNT)) {
    throw new Error('Master track ID must be null or an integer from 1 to 5.');
  }
  if (typeof value.measureLengthSeconds !== 'number' || !Number.isFinite(value.measureLengthSeconds) ||
      value.measureLengthSeconds < 0 || value.measureLengthSeconds > 86_400) {
    throw new Error('Measure length must be between zero and 24 hours.');
  }
  if (typeof value.masterLoopLengthSamples !== 'number' || !Number.isSafeInteger(value.masterLoopLengthSamples) || value.masterLoopLengthSamples < 0) {
    throw new Error('Master loop length must be a non-negative safe integer.');
  }
  if (typeof value.timeSignatureNumerator !== 'number' || !Number.isSafeInteger(value.timeSignatureNumerator) || value.timeSignatureNumerator < 1 || value.timeSignatureNumerator > 32) {
    throw new Error('Time signature numerator must be an integer from 1 to 32.');
  }
  if (![1, 2, 4, 8, 16, 32].includes(value.timeSignatureDenominator as number)) {
    throw new Error('Time signature denominator must be a supported power of two from 1 to 32.');
  }
  if (masterTrackId === null) {
    if (value.masterLoopLengthSamples !== 0 || value.measureLengthSeconds !== 0) {
      throw new Error('An unmastered project must have zero master loop and measure lengths.');
    }
    return;
  }

  const masterTrack = tracks[masterTrackId - 1];
  if (!masterTrack || masterTrack.frameCount === 0) {
    throw new Error('Master track ID must point to a nonempty track.');
  }
  if (value.masterLoopLengthSamples === 0 || value.measureLengthSeconds === 0) {
    throw new Error('A mastered project must have positive loop and measure lengths.');
  }
  if (value.masterLoopLengthSamples !== masterTrack.frameCount) {
    throw new Error('Master loop sample length must exactly match the referenced master track PCM frame count.');
  }
  // BPM is quarter-notes per minute; the denominator converts the notated beats
  // per measure to quarter-note beats (for example, 6/8 is three quarter notes).
  const quarterNotesPerMeasure = (value.timeSignatureNumerator as number) * 4 / (value.timeSignatureDenominator as number);
  const expectedMeasureLengthSeconds = quarterNotesPerMeasure * 60 / bpm;
  const measureTolerance = Math.max(1e-9, expectedMeasureLengthSeconds * 1e-9);
  if (Math.abs((value.measureLengthSeconds as number) - expectedMeasureLengthSeconds) > measureTolerance) {
    throw new Error('Master measure length is inconsistent with the saved BPM and time-signature numerator.');
  }
}

function normalizeTransport(value: ProjectArchiveTransport | undefined): ProjectArchiveTransport {
  if (value === undefined) return { ...PROJECT_ARCHIVE_DEFAULT_TRANSPORT };
  return {
    masterTrackId: value.masterTrackId,
    measureLengthSeconds: value.measureLengthSeconds,
    masterLoopLengthSamples: value.masterLoopLengthSamples,
    timeSignatureNumerator: value.timeSignatureNumerator,
    timeSignatureDenominator: value.timeSignatureDenominator,
  };
}

function checkedPcmByteLength(frameCount: number, channels: number): number {
  const samples = checkedMultiply(frameCount, channels, 'PCM sample count');
  const bytes = checkedMultiply(samples, Float32Array.BYTES_PER_ELEMENT, 'PCM byte length');
  if (bytes > MAX_ARCHIVE_BYTES) throw new Error('Track PCM exceeds the project archive size limit.');
  return bytes;
}

function writeTrackPcm(track: ProjectArchiveTrack, destination: DataView, absoluteOffset: number, trackNumber: number): void {
  for (let frame = 0; frame < track.frameCount; frame += 1) {
    for (let channel = 0; channel < track.channels; channel += 1) {
      const sampleIndex = frame * track.channels + channel;
      const sample = track.pcm instanceof Float32Array
        ? track.pcm[sampleIndex]
        : track.channelData?.[channel]?.[frame];
      if (typeof sample !== 'number' || !Number.isFinite(sample)) {
        throw new Error(`Track ${trackNumber} contains a non-finite PCM sample.`);
      }
      destination.setFloat32(absoluteOffset + sampleIndex * Float32Array.BYTES_PER_ELEMENT, sample, true);
    }
  }
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} overflows a safe integer.`);
  return result;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} overflows a safe integer.`);
  return result;
}

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (!ArrayBuffer.isView(input)) throw new Error('Project archive input must be an ArrayBuffer or view.');
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasAllowedKeys(value: Record<string, unknown>, allowedKeys: string[], requiredKeys: string[]): boolean {
  const actual = Object.keys(value);
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => allowedKeys.includes(key));
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  const stack: Array<{ kind: 'object' | 'array'; expectingKey: boolean; keys: Set<string> }> = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      const current = stack[stack.length - 1];
      if (current?.kind === 'object' && current.expectingKey) {
        const key = JSON.parse(text.slice(start, index)) as string;
        if (current.keys.has(key)) throw new Error('Project archive manifest contains duplicate JSON object keys.');
        current.keys.add(key);
        current.expectingKey = false;
      }
      continue;
    }
    if (character === '{') {
      stack.push({ kind: 'object', expectingKey: true, keys: new Set<string>() });
    } else if (character === '[') {
      stack.push({ kind: 'array', expectingKey: false, keys: new Set<string>() });
    } else if (character === '}' || character === ']') {
      stack.pop();
    } else if (character === ',') {
      const current = stack[stack.length - 1];
      if (current?.kind === 'object') current.expectingKey = true;
    }
    index += 1;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 requires Web Crypto support in this browser.');
  // Reuse a standalone buffer; only offset views (such as one track inside the
  // archive) need a per-track copy, never a copy of the entire project archive.
  const input = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : Uint8Array.from(bytes).buffer;
  const digest = await subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
