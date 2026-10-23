import { decodeProjectArchive, PROJECT_ARCHIVE_LIMITS } from './projectArchive';

export type Rc505Json = null | boolean | number | string | Rc505Json[] | { [key: string]: Rc505Json };
export interface Rc505MemoryField {
  value: Rc505Json;
  availability: 'supported' | 'unsupported' | 'unknown';
  reason?: string;
}
export interface Rc505MemorySemantics {
  tempo: number;
  meter: [number, number];
  /** Official setting addresses; unavailable values are never applied. */
  fields: Record<string, Rc505MemoryField>;
}
export interface Rc505MemoryDocument {
  version: 1;
  memoryNumber: number | null;
  name: string;
  semantics: Rc505MemorySemantics;
  extensions: { WEBRC: Record<string, Rc505Json> };
  /** Exact legacy ProjectArchive v1 bytes, not a new Roland binary format. */
  archive: Uint8Array;
}
const MAGIC = new TextEncoder().encode('RC505ME1');
const META_LIMIT = 256 * 1024;
const HEADER_BYTES = 12;
const allowedRoots = /^(track\.[1-5]|record|play|inputFx|trackFx|rhythm|routing|assign|mixer)\.[A-Za-z0-9_.-]+$/;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function jsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 8192;
  if (Array.isArray(value)) return value.length <= 4096 && value.every((v) => jsonSafe(v, depth + 1));
  return record(value) && Object.entries(value).every(([key, v]) => key !== '__proto__'
    && key !== 'constructor' && key !== 'prototype' && jsonSafe(v, depth + 1));
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
export function validateRc505MemoryMetadata(value: unknown): asserts value is Omit<Rc505MemoryDocument, 'archive'> {
  if (!record(value) || !exactKeys(value, ['version', 'memoryNumber', 'name', 'semantics', 'extensions']) || value.version !== 1
    || !(value.memoryNumber === null || (Number.isInteger(value.memoryNumber) && Number(value.memoryNumber) >= 1 && Number(value.memoryNumber) <= 99))
    || typeof value.name !== 'string' || [...value.name].length > 12 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !record(value.semantics) || !exactKeys(value.semantics, ['tempo', 'meter', 'fields'])
    || typeof value.semantics.tempo !== 'number' || !Number.isFinite(value.semantics.tempo)
    || value.semantics.tempo < 40 || value.semantics.tempo > 300
    || !Array.isArray(value.semantics.meter) || value.semantics.meter.length !== 2
    || !Number.isInteger(value.semantics.meter[0]) || value.semantics.meter[0] < 1 || value.semantics.meter[0] > 32
    || ![1, 2, 4, 8, 16, 32].includes(value.semantics.meter[1]) || !record(value.semantics.fields)
    || !record(value.extensions) || !exactKeys(value.extensions, ['WEBRC']) || !record(value.extensions.WEBRC) || !jsonSafe(value.extensions)) {
    throw new Error('Invalid RC505 semantic Memory metadata.');
  }
  for (const [address, field] of Object.entries(value.semantics.fields)) {
    if (!allowedRoots.test(address) || !record(field) || !['supported', 'unsupported', 'unknown'].includes(String(field.availability))
      || !Object.prototype.hasOwnProperty.call(field, 'value') || !jsonSafe(field.value)
      || Object.keys(field).some((key) => !['value', 'availability', 'reason'].includes(key))
      || (field.reason !== undefined && typeof field.reason !== 'string')
      || (field.availability !== 'supported' && (field.value !== null || typeof field.reason !== 'string' || !field.reason))) {
      throw new Error(`Invalid RC505 Memory field: ${address}`);
    }
  }
}
async function validateArchive(document: Rc505MemoryDocument): Promise<void> {
  const archive = await decodeProjectArchive(document.archive);
  if (archive.bpm !== document.semantics.tempo || archive.transport.timeSignatureNumerator !== document.semantics.meter[0]
    || archive.transport.timeSignatureDenominator !== document.semantics.meter[1]) {
    throw new Error('Memory semantic tempo/meter does not match its PCM archive.');
  }
}
export async function encodeRc505Memory(document: Rc505MemoryDocument): Promise<Uint8Array> {
  const { archive, ...metadata } = document;
  validateRc505MemoryMetadata(metadata);
  await validateArchive(document);
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (bytes.length > META_LIMIT) throw new Error('Memory semantic metadata exceeds its bounded size.');
  const result = new Uint8Array(HEADER_BYTES + bytes.length + archive.byteLength);
  result.set(MAGIC);
  new DataView(result.buffer).setUint32(8, bytes.length, true);
  result.set(bytes, HEADER_BYTES); result.set(archive, HEADER_BYTES + bytes.length);
  return result;
}
export async function decodeRc505Memory(bytes: Uint8Array): Promise<Rc505MemoryDocument> {
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes + META_LIMIT + HEADER_BYTES
    || !MAGIC.every((v, i) => bytes[i] === v)) throw new Error('Not a supported RC505 semantic Memory envelope.');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (length < 1 || length > META_LIMIT || HEADER_BYTES + length >= bytes.byteLength) throw new Error('Invalid Memory envelope length.');
  const metadata: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length)));
  validateRc505MemoryMetadata(metadata);
  const document = { ...metadata, archive: bytes.slice(HEADER_BYTES + length) };
  await validateArchive(document);
  return document;
}

export interface Rc505MemoryRuntime {
  /** Changes on every PCM, transport or semantic edit, including edit-and-revert. */
  revision(): string;
  canSwitch(): { allowed: boolean; reason: string };
  capture(): Promise<Rc505MemoryDocument>;
  prepare(document: Rc505MemoryDocument, expectedRevision: string): Promise<{
    commit(): Promise<void>;
    dispose(): Promise<void>;
  }>;
}
export interface Rc505MemoryPersistence {
  read(slot: number): Promise<Uint8Array | null>;
  write(slot: number, bytes: Uint8Array): Promise<void>;
  recovery(bytes: Uint8Array): Promise<void>;
  clear(slot: number): Promise<void>;
}
export class Rc505Memory {
  public currentNumber: number | null = null;
  public currentName = '';
  public busy = false;
  private savedRevision: string | null = null;
  private savedName = '';
  private readonly runtime: Rc505MemoryRuntime;
  private readonly store: Rc505MemoryPersistence;
  public constructor(runtime: Rc505MemoryRuntime, store: Rc505MemoryPersistence) { this.runtime = runtime; this.store = store; }
  public get dirty(): boolean { return this.savedRevision !== this.runtime.revision() || this.savedName !== this.currentName; }
  public setName(name: string): void {
    if (this.busy) throw new Error('A Memory transaction is already pending.');
    if ([...name].length > 12 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Memory names allow at most 12 visible characters.');
    this.currentName = name;
  }
  private assertStopped(): void {
    const state = this.runtime.canSwitch();
    if (!state.allowed) throw new Error(state.reason);
  }
  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw new RangeError('Memory number must be 01–99.');
  }
  private async operation<T>(body: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('A Memory transaction is already pending.');
    this.busy = true;
    try { return await body(); } finally { this.busy = false; }
  }
  public save(slot: number, name: string): Promise<void> {
    return this.operation(async () => {
      this.assertSlot(slot);
      this.assertStopped();
      const revision = this.runtime.revision();
      const document = await this.runtime.capture();
      if (revision !== this.runtime.revision()) throw new Error('Memory changed during capture; WRITE canceled.');
      const bytes = await encodeRc505Memory({ ...document, memoryNumber: slot, name });
      await this.store.write(slot, bytes);
      // The saved snapshot is valid; a later edit remains dirty.
      if (revision === this.runtime.revision()) {
        this.currentNumber = slot; this.currentName = name; this.savedName = name; this.savedRevision = revision;
      }
    });
  }
  public load(slot: number): Promise<void> {
    return this.operation(async () => {
      this.assertSlot(slot);
      this.assertStopped();
      const revision = this.runtime.revision();
      const bytes = await this.store.read(slot);
      if (!bytes) throw new Error(`Memory ${slot} is empty.`);
      const document = await decodeRc505Memory(bytes);
      if (document.memoryNumber !== slot) throw new Error('Memory slot and envelope number disagree.');
      const recovery = await this.runtime.capture();
      if (revision !== this.runtime.revision()) throw new Error('Memory changed while preparing the switch.');
      await this.store.recovery(await encodeRc505Memory({ ...recovery, memoryNumber: this.currentNumber, name: this.currentName }));
      this.assertStopped();
      if (revision !== this.runtime.revision()) throw new Error('Memory changed before recovery was secured.');
      const prepared = await this.runtime.prepare(document, revision);
      try {
        this.assertStopped();
        if (revision !== this.runtime.revision()) throw new Error('Memory changed before commit.');
        await prepared.commit();
        this.currentNumber = slot; this.currentName = document.name; this.savedName = document.name; this.savedRevision = this.runtime.revision();
      } finally { await prepared.dispose(); }
    });
  }
  public clear(slot: number): Promise<void> { return this.operation(async () => {
    this.assertSlot(slot); this.assertStopped(); await this.store.clear(slot);
    if (this.currentNumber === slot) this.savedRevision = null;
  }); }
}
