import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decodeProjectArchive,
  encodeProjectArchive,
  PROJECT_ARCHIVE_DEFAULT_TRANSPORT,
  PROJECT_ARCHIVE_LIMITS,
  type ProjectArchiveInput,
  type ProjectArchiveTrack,
  type ProjectArchiveTrackList,
} from '../../src/audio/projectArchive';

const HEADER_BYTES = 12;
const MAGIC_BYTES = 8;

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto as unknown as Crypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function makeProject(includeTrackTempo = false): ProjectArchiveInput {
  return {
    name: 'Archive test',
    bpm: 120,
    tracks: [
      { pcm: new Float32Array(48_000), sampleRate: 48_000, frameCount: 48_000, channels: 1 },
      {
        channelData: [new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3])],
        sampleRate: 44_100,
        frameCount: 3,
        channels: 2,
        ...(includeTrackTempo ? { originalTempoBpm: 96 } : {}),
      },
      { pcm: new Float32Array([0]), sampleRate: 48_000, frameCount: 1, channels: 1 },
      null,
      null,
    ],
    transport: {
      masterTrackId: 1,
      measureLengthSeconds: 2,
      masterLoopLengthSamples: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
    },
  };
}

function readManifest(archive: Uint8Array): Record<string, any> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const manifestLength = view.getUint32(MAGIC_BYTES, true);
  return JSON.parse(new TextDecoder().decode(archive.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength))) as Record<string, any>;
}

function replaceManifest(
  archive: Uint8Array,
  mutate: (manifest: Record<string, any>) => void,
  payloadOverride?: Uint8Array,
): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const manifestLength = view.getUint32(MAGIC_BYTES, true);
  const manifest = JSON.parse(new TextDecoder().decode(archive.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength))) as Record<string, any>;
  const payload = payloadOverride ?? archive.subarray(HEADER_BYTES + manifestLength);
  mutate(manifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const result = new Uint8Array(HEADER_BYTES + manifestBytes.byteLength + payload.byteLength);
  result.set(archive.subarray(0, MAGIC_BYTES), 0);
  new DataView(result.buffer).setUint32(MAGIC_BYTES, manifestBytes.byteLength, true);
  result.set(manifestBytes, HEADER_BYTES);
  result.set(payload, HEADER_BYTES + manifestBytes.byteLength);
  return result;
}

function replaceRawManifest(archive: Uint8Array, mutate: (manifestText: string) => string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const manifestLength = view.getUint32(MAGIC_BYTES, true);
  const originalText = new TextDecoder().decode(archive.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength));
  const manifestBytes = new TextEncoder().encode(mutate(originalText));
  const payload = archive.subarray(HEADER_BYTES + manifestLength);
  const result = new Uint8Array(HEADER_BYTES + manifestBytes.byteLength + payload.byteLength);
  result.set(archive.subarray(0, MAGIC_BYTES), 0);
  new DataView(result.buffer).setUint32(MAGIC_BYTES, manifestBytes.byteLength, true);
  result.set(manifestBytes, HEADER_BYTES);
  result.set(payload, HEADER_BYTES + manifestBytes.byteLength);
  return result;
}

async function withNonFiniteFirstSample(archive: Uint8Array, value: number): Promise<Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const manifestLength = view.getUint32(MAGIC_BYTES, true);
  const manifest = JSON.parse(new TextDecoder().decode(archive.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength))) as Record<string, any>;
  const payload = archive.slice(HEADER_BYTES + manifestLength);
  const firstTrack = manifest.tracks[0];
  new DataView(payload.buffer).setFloat32(firstTrack.payloadOffset, value, true);
  const hashBytes = payload.subarray(firstTrack.payloadOffset, firstTrack.payloadOffset + firstTrack.byteLength);
  const digest = await webcrypto.subtle.digest('SHA-256', hashBytes);
  firstTrack.sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const encodedManifest = new TextEncoder().encode(JSON.stringify(manifest));
  const result = new Uint8Array(HEADER_BYTES + encodedManifest.byteLength + payload.byteLength);
  result.set(archive.subarray(0, MAGIC_BYTES), 0);
  new DataView(result.buffer).setUint32(MAGIC_BYTES, encodedManifest.byteLength, true);
  result.set(encodedManifest, HEADER_BYTES);
  result.set(payload, HEADER_BYTES + encodedManifest.byteLength);
  return result;
}

describe('project PCM archive codec', () => {
  it('round-trips mono/stereo PCM, null tracks, and transport metadata deterministically', async () => {
    const project = makeProject(true);
    const archive = await encodeProjectArchive(project, { version: 2 });
    const repeated = await encodeProjectArchive(project, { version: 2 });
    expect(Array.from(archive)).toEqual(Array.from(repeated));

    const decoded = await decodeProjectArchive(archive);
    expect(decoded.tracks).toHaveLength(5);
    expect(decoded.name).toBe(project.name);
    expect(decoded.bpm).toBe(project.bpm);
    expect(decoded.transport).toEqual(project.transport);
    expect(decoded.tracks[0]).toMatchObject({ sampleRate: 48_000, frameCount: 48_000, channels: 1 });
    expect(decoded.version).toBe(2);
    expect(decoded.tracks[0]?.originalTempoBpm).toBeNull();
    expect(decoded.tracks[0]?.pcm).toEqual(new Float32Array(48_000));
    expect(decoded.tracks[1]).toMatchObject({ sampleRate: 44_100, frameCount: 3, channels: 2 });
    expect(decoded.tracks[1]?.originalTempoBpm).toBe(96);
    expect(decoded.tracks[1]?.pcm).toEqual(new Float32Array([1, -1, 2, -2, 3, -3]));
    expect(decoded.tracks[2]).toMatchObject({ sampleRate: 48_000, frameCount: 1, channels: 1 });
    expect(decoded.tracks[2]?.pcm).toEqual(new Float32Array([0]));
    expect(decoded.tracks[3]).toBeNull();
    expect(decoded.tracks[4]).toBeNull();

    const manifest = readManifest(archive);
    expect(manifest.version).toBe(2);
    expect(manifest.tracks[0].originalTempoBpm).toBeNull();
    expect(manifest.tracks[1].originalTempoBpm).toBe(96);
    expect(Object.keys(manifest.project).sort()).toEqual(['bpm', 'name', 'transport']);
    expect(manifest).not.toHaveProperty('fx');
    expect(manifest).not.toHaveProperty('rhythm');
  });

  it('reads strict v1 manifests as unknown original tempo and requires the v2 nullable field', async () => {
    const v2 = await encodeProjectArchive(makeProject(true), { version: 2 });
    const legacyV1 = replaceManifest(v2, (manifest) => {
      manifest.version = 1;
      for (const track of manifest.tracks) if (track) delete track.originalTempoBpm;
    });
    const decodedV1 = await decodeProjectArchive(legacyV1);
    expect(decodedV1.version).toBe(1);
    expect(decodedV1.tracks[0]?.originalTempoBpm).toBeNull();
    expect(decodedV1.tracks[1]?.originalTempoBpm).toBeNull();

    const v1WithNewField = replaceManifest(legacyV1, (manifest) => {
      manifest.tracks[0].originalTempoBpm = null;
    });
    await expect(decodeProjectArchive(v1WithNewField)).rejects.toThrow(/schema/i);

    const v2MissingField = replaceManifest(v2, (manifest) => {
      delete manifest.tracks[0].originalTempoBpm;
    });
    await expect(decodeProjectArchive(v2MissingField)).rejects.toThrow(/schema/i);

    for (const invalid of [0, 39.9, 300.1, '120']) {
      const badTempo = replaceManifest(v2, (manifest) => {
        manifest.tracks[0].originalTempoBpm = invalid;
      });
      await expect(decodeProjectArchive(badTempo)).rejects.toThrow(/original tempo/i);
    }
  });

  it('keeps the default exporter on the exact v1 track schema', async () => {
    const archive = await encodeProjectArchive(makeProject());
    const manifest = readManifest(archive);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.tracks[0]).sort()).toEqual(['byteLength', 'channels', 'frameCount', 'payloadOffset', 'sampleRate', 'sha256']);
    const decoded = await decodeProjectArchive(archive);
    expect(decoded.version).toBe(1);
    expect(decoded.tracks[0]?.originalTempoBpm).toBeNull();

    await expect(encodeProjectArchive(makeProject(true))).rejects.toThrow(/requires ProjectArchive v2/i);
  });

  it.each([
    [6, 8, 1.5],
    [3, 4, 1.5],
    [5, 8, 1.25],
  ])('validates quarter-note BPM against %i/%i measure timing', async (numerator, denominator, measureSeconds) => {
    const base = makeProject();
    const project: ProjectArchiveInput = {
      ...base,
      transport: {
        ...base.transport!,
        timeSignatureNumerator: numerator,
        timeSignatureDenominator: denominator,
        measureLengthSeconds: measureSeconds,
      },
    };
    const decoded = await decodeProjectArchive(await encodeProjectArchive(project));
    expect(decoded.transport.measureLengthSeconds).toBe(measureSeconds);

    await expect(encodeProjectArchive({
      ...project,
      transport: { ...project.transport!, measureLengthSeconds: measureSeconds + 0.1 },
    })).rejects.toThrow(/inconsistent.*BPM/i);
  });

  it('decodes an omitted transport record with valid stopped defaults', async () => {
    const { transport: _transport, ...withoutTransport } = makeProject();
    const project = withoutTransport as ProjectArchiveInput;
    const archive = await encodeProjectArchive(project);
    const archiveWithoutTransport = replaceManifest(archive, (manifest) => { delete manifest.project.transport; });
    const decoded = await decodeProjectArchive(archiveWithoutTransport);
    expect(decoded.transport).toEqual(PROJECT_ARCHIVE_DEFAULT_TRANSPORT);
  });

  it('accepts a bounded ArrayBuffer or a view over exactly the archive bytes', async () => {
    const archive = await encodeProjectArchive(makeProject());
    const fromBuffer = await decodeProjectArchive(archive.buffer as ArrayBuffer);
    const framed = new Uint8Array(archive.byteLength + 2);
    framed.set(archive, 1);
    const fromView = await decodeProjectArchive(framed.subarray(1, framed.byteLength - 1));
    expect(fromBuffer.tracks[1]?.pcm).toEqual(fromView.tracks[1]?.pcm);
  });

  it('rejects bad magic, unsupported versions, and extra schema fields', async () => {
    const archive = await encodeProjectArchive(makeProject());
    const badMagic = archive.slice();
    badMagic[0] ^= 0xff;
    await expect(decodeProjectArchive(badMagic)).rejects.toThrow(/magic/i);

    const badVersion = replaceManifest(archive, (manifest) => { manifest.version = 3; });
    await expect(decodeProjectArchive(badVersion)).rejects.toThrow(/unsupported/i);

    const badSchema = replaceManifest(archive, (manifest) => { manifest.project.fx = { reverb: true }; });
    await expect(decodeProjectArchive(badSchema)).rejects.toThrow(/schema/i);

    const duplicateKey = replaceRawManifest(archive, (text) => text.replace('"version":1', '"version":1,"version":1'));
    await expect(decodeProjectArchive(duplicateKey)).rejects.toThrow(/duplicate JSON object keys/i);
  });

  it('rejects invalid track hashes and malformed payload extents', async () => {
    const archive = await encodeProjectArchive(makeProject());
    const badHash = replaceManifest(archive, (manifest) => { manifest.tracks[0].sha256 = 'f'.repeat(64); });
    await expect(decodeProjectArchive(badHash)).rejects.toThrow(/hash/i);

    const badOffset = replaceManifest(archive, (manifest) => { manifest.tracks[1].payloadOffset += 1; });
    await expect(decodeProjectArchive(badOffset)).rejects.toThrow(/contiguous/i);
  });

  it('rejects truncation, trailing bytes, and archives over the public bound', async () => {
    const archive = await encodeProjectArchive(makeProject());
    await expect(decodeProjectArchive(archive.slice(0, -1))).rejects.toThrow(/truncated|hash/i);

    const withTrailingByte = new Uint8Array(archive.byteLength + 1);
    withTrailingByte.set(archive);
    await expect(decodeProjectArchive(withTrailingByte)).rejects.toThrow(/trailing|unaccounted/i);

    const oversized = new Uint8Array(PROJECT_ARCHIVE_LIMITS.maxArchiveBytes + 1);
    await expect(decodeProjectArchive(oversized)).rejects.toThrow(/limit/i);
  });

  it('rejects NaN and infinity in payloads even when the corresponding hash is valid', async () => {
    const archive = await encodeProjectArchive(makeProject());
    await expect(decodeProjectArchive(await withNonFiniteFirstSample(archive, Number.NaN))).rejects.toThrow(/non-finite/i);
    await expect(decodeProjectArchive(await withNonFiniteFirstSample(archive, Number.POSITIVE_INFINITY))).rejects.toThrow(/non-finite/i);
  });

  it('rejects unsafe metadata and a master track that is missing or empty', async () => {
    const archive = await encodeProjectArchive(makeProject());
    const unsafeFrameCount = replaceManifest(archive, (manifest) => {
      manifest.tracks[0].frameCount = Number.MAX_SAFE_INTEGER;
      manifest.tracks[0].byteLength = Number.MAX_SAFE_INTEGER;
    });
    await expect(decodeProjectArchive(unsafeFrameCount)).rejects.toThrow(/overflow|size|safe integer/i);

    const emptyMaster = makeProject();
    await expect(encodeProjectArchive({
      ...emptyMaster,
      transport: { ...emptyMaster.transport!, masterTrackId: 4 },
    })).rejects.toThrow(/nonempty track/i);

    const validArchive = await encodeProjectArchive(makeProject());
    const manifestWithEmptyMaster = replaceManifest(validArchive, (manifest) => {
      manifest.project.transport.masterTrackId = 4;
    });
    await expect(decodeProjectArchive(manifestWithEmptyMaster)).rejects.toThrow(/nonempty track/i);

    const unmasteredWithLoopLength = replaceManifest(validArchive, (manifest) => {
      manifest.project.transport.masterTrackId = null;
      manifest.project.transport.masterLoopLengthSamples = 1;
    });
    await expect(decodeProjectArchive(unmasteredWithLoopLength)).rejects.toThrow(/unmastered/i);

    const missingMaster = makeProject();
    const tracks = [...missingMaster.tracks] as [
      ProjectArchiveTrack | null,
      ProjectArchiveTrack | null,
      ProjectArchiveTrack | null,
      ProjectArchiveTrack | null,
      ProjectArchiveTrack | null,
    ];
    tracks[0] = null;
    await expect(encodeProjectArchive({ ...missingMaster, tracks })).rejects.toThrow(/nonempty track/i);
  });

  it('rejects master loop length or measure timing inconsistent with its referenced PCM and BPM', async () => {
    const archive = await encodeProjectArchive(makeProject());
    const wrongLoopFrames = replaceManifest(archive, (manifest) => {
      manifest.project.transport.masterLoopLengthSamples -= 1;
    });
    await expect(decodeProjectArchive(wrongLoopFrames)).rejects.toThrow(/match.*PCM frame count/i);

    const wrongMeasureTempo = replaceManifest(archive, (manifest) => {
      manifest.project.transport.measureLengthSeconds = 1.5;
    });
    await expect(decodeProjectArchive(wrongMeasureTempo)).rejects.toThrow(/inconsistent.*BPM/i);

    const nonnullEmptyLoop = makeProject();
    const emptyTracks = [...nonnullEmptyLoop.tracks] as unknown as ProjectArchiveTrackList;
    emptyTracks[2] = { pcm: new Float32Array(0), sampleRate: 48_000, frameCount: 0, channels: 1 };
    await expect(encodeProjectArchive({ ...nonnullEmptyLoop, tracks: emptyTracks })).rejects.toThrow(/positive safe integer.*null/i);
  });

  it('rejects non-finite encoder input and mismatched channel lengths', async () => {
    const nanProject = makeProject();
    const tracks = [...nanProject.tracks] as unknown as ProjectArchiveTrackList;
    const nonFinitePcm = new Float32Array(48_000);
    nonFinitePcm[0] = Number.NaN;
    tracks[0] = { pcm: nonFinitePcm, sampleRate: 48_000, frameCount: 48_000, channels: 1 };
    await expect(encodeProjectArchive({ ...nanProject, tracks })).rejects.toThrow(/non-finite/i);

    const mismatch = makeProject();
    const invalidTracks = [...mismatch.tracks] as unknown as ProjectArchiveTrackList;
    invalidTracks[1] = {
      channelData: [new Float32Array([1, 2]), new Float32Array([1])],
      sampleRate: 48_000,
      frameCount: 2,
      channels: 2,
    };
    await expect(encodeProjectArchive({ ...mismatch, tracks: invalidTracks })).rejects.toThrow(/channel PCM lengths/i);
  });
});
