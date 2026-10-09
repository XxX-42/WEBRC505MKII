import { assertProjectDocument } from './projectValidation';
import { inspectWavHeader } from './wavCodec';
import { isBlobLike, readBlobArrayBuffer, readBlobText } from './blobUtils';
import { DEFAULT_PROJECT_RESOURCE_POLICY, type ProjectDocument, type ProjectResourcePolicy } from './projectTypes';

const MAGIC = 'WRCPRJ01';
const HEADER_BYTES = 16;
const ARCHIVE_VERSION = 1;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface ProjectArchiveAsset {
  id: string;
  fileName: string;
  offset: number;
  byteLength: number;
}

export interface DecodedProjectArchive {
  document: ProjectDocument;
  assets: Map<string, Blob>;
}

function assertAssetIds(document: ProjectDocument, assetIds: Iterable<string>): void {
  const expected = new Set(document.tracks.map((track) => track.audioAssetId).filter((id): id is string => id !== null));
  const provided = new Set(assetIds);
  if (provided.size !== expected.size || [...expected].some((id) => !provided.has(id))) {
    throw new TypeError('Project audio assets must match the document track references exactly.');
  }
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function utf8Length(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export async function encodeProjectArchive(
  document: ProjectDocument,
  assets: ReadonlyMap<string, Blob | Uint8Array>,
  policy: ProjectResourcePolicy = DEFAULT_PROJECT_RESOURCE_POLICY,
): Promise<Blob> {
  assertProjectDocument(document);
  assertAssetIds(document, assets.keys());
  const assetEntries: Array<{ id: string; fileName: string; offset: number; byteLength: number; data: Blob | Uint8Array }> = [];
  let offset = 0;
  for (const [id, data] of assets) {
    const byteLength = isBlobLike(data) ? data.size : data.byteLength;
    if (byteLength < 44 || byteLength > policy.maxAssetBytes) throw new RangeError(`Audio asset "${id}" has an invalid size.`);
    await inspectWavHeader(data, policy.maxAssetBytes);
    assetEntries.push({ id, fileName: `${id}.wav`, offset, byteLength, data });
    offset += byteLength;
  }

  const manifest = utf8Length(JSON.stringify({
    archiveVersion: ARCHIVE_VERSION,
    document,
    assets: assetEntries.map(({ id, fileName, offset: start, byteLength }) => ({ id, fileName, offset: start, byteLength })),
  }));
  if (manifest.byteLength > MAX_MANIFEST_BYTES || HEADER_BYTES + manifest.byteLength + offset > policy.maxArchiveBytes) {
    throw new RangeError('Project archive exceeds the supported size limit.');
  }
  const header = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < MAGIC.length; i += 1) header[i] = MAGIC.charCodeAt(i);
  const view = new DataView(header.buffer);
  view.setUint32(8, manifest.byteLength, true);
  view.setUint32(12, assetEntries.length, true);
  const parts: BlobPart[] = [header.buffer as ArrayBuffer, manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength) as ArrayBuffer];
  for (const entry of assetEntries) {
    parts.push(isBlobLike(entry.data) ? entry.data : arrayBufferOf(entry.data as Uint8Array));
  }
  return new Blob(parts, { type: 'application/x-webrc505-project' });
}

export async function decodeProjectArchive(
  input: Blob | ArrayBuffer | Uint8Array,
  policy: ProjectResourcePolicy = DEFAULT_PROJECT_RESOURCE_POLICY,
): Promise<DecodedProjectArchive> {
  const archive = isBlobLike(input)
    ? input
    : new Blob([input instanceof Uint8Array ? arrayBufferOf(input) : input]);
  if (archive.size < HEADER_BYTES || archive.size > policy.maxArchiveBytes) throw new RangeError('Project archive size is outside the supported range.');
  const headerBytes = new Uint8Array(await readBlobArrayBuffer(archive.slice(0, HEADER_BYTES)));
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  let magic = '';
  for (let i = 0; i < MAGIC.length; i += 1) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== MAGIC) throw new TypeError('File is not a WebRC505 project archive.');
  const manifestLength = view.getUint32(8, true);
  const assetCount = view.getUint32(12, true);
  if (manifestLength <= 0 || manifestLength > MAX_MANIFEST_BYTES || assetCount > 5 || HEADER_BYTES + manifestLength > archive.size) {
    throw new RangeError('Project archive manifest header is invalid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBlobText(archive.slice(HEADER_BYTES, HEADER_BYTES + manifestLength)));
  } catch {
    throw new TypeError('Project archive manifest is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new TypeError('Project archive manifest is invalid.');
  const manifest = parsed as { archiveVersion?: unknown; document?: unknown; assets?: unknown };
  if (manifest.archiveVersion !== ARCHIVE_VERSION || !Array.isArray(manifest.assets) || manifest.assets.length !== assetCount) {
    throw new TypeError('Project archive version or asset count is invalid.');
  }
  assertProjectDocument(manifest.document);
  const document = manifest.document;
  assertAssetIds(document, manifest.assets.map((asset) => {
    if (!asset || typeof asset !== 'object' || typeof (asset as { id?: unknown }).id !== 'string') throw new TypeError('Project archive asset entry is malformed.');
    return (asset as { id: string }).id;
  }));

  const payloadStart = HEADER_BYTES + manifestLength;
  const assets = new Map<string, Blob>();
  let expectedOffset = 0;
  for (const [index, raw] of manifest.assets.entries()) {
    if (!raw || typeof raw !== 'object') throw new TypeError(`Project archive asset ${index} is malformed.`);
    const entry = raw as Partial<ProjectArchiveAsset>;
    if (typeof entry.id !== 'string' || !entry.id || typeof entry.fileName !== 'string' || !entry.fileName.endsWith('.wav')) throw new TypeError(`Project archive asset ${index} has invalid metadata.`);
    if (!Number.isSafeInteger(entry.offset) || entry.offset !== expectedOffset) throw new TypeError(`Project archive asset ${entry.id} has an invalid offset.`);
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength! < 44 || entry.byteLength! > policy.maxAssetBytes) throw new RangeError(`Project archive asset ${entry.id} has an invalid length.`);
    const start = payloadStart + entry.offset!;
    const end = start + entry.byteLength!;
    if (end > archive.size) throw new RangeError(`Project archive asset ${entry.id} is truncated.`);
    const assetBlob = archive.slice(start, end, 'audio/wav');
    await inspectWavHeader(assetBlob, policy.maxAssetBytes); // validate format, frame bounds and resource policy before applying it
    assets.set(entry.id, assetBlob);
    expectedOffset += entry.byteLength!;
  }
  if (payloadStart + expectedOffset !== archive.size) throw new RangeError('Project archive contains trailing or unreferenced data.');
  return { document, assets };
}
