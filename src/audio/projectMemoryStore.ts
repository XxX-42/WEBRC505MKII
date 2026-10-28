import { PROJECT_ARCHIVE_LIMITS } from './projectArchive';

export const PROJECT_MEMORY_SLOT_COUNT = 99;
const DATABASE_NAME = 'webrc505-project-memory';
const DATABASE_VERSION = 1;
const METADATA_STORE = 'slot-metadata';
const PAYLOAD_STORE = 'slot-payloads';

export interface ProjectMemoryMetadata {
  readonly slot: number;
  readonly name: string;
  readonly bpm: number;
  readonly savedAt: number;
  readonly archiveBytes: number;
  /** Absent only on legacy slot-index records created before archive-version labels. */
  readonly archiveVersion?: 1 | 2;
}

interface StoredMetadata extends ProjectMemoryMetadata {}
interface StoredPayload { readonly slot: number; readonly archive: ArrayBuffer }

function isValidMetadata(record: StoredMetadata | undefined, slot?: number): record is StoredMetadata {
  return Boolean(record && Number.isInteger(record.slot) && record.slot >= 1 && record.slot <= PROJECT_MEMORY_SLOT_COUNT
    && (slot === undefined || record.slot === slot)
    && typeof record.name === 'string' && record.name.trim().length > 0
    && new TextEncoder().encode(record.name).byteLength <= PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes
    && Number.isFinite(record.bpm) && record.bpm >= 40 && record.bpm <= 300
    && Number.isFinite(record.savedAt) && record.savedAt > 0
    && Number.isSafeInteger(record.archiveBytes) && record.archiveBytes > 0
    && record.archiveBytes <= PROJECT_ARCHIVE_LIMITS.maxArchiveBytes
    && (record.archiveVersion === undefined || record.archiveVersion === 1 || record.archiveVersion === 2));
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > PROJECT_MEMORY_SLOT_COUNT) {
    throw new RangeError(`Memory slot must be between 1 and ${PROJECT_MEMORY_SLOT_COUNT}`);
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class ProjectMemoryStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable in this browser context'));
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(METADATA_STORE)) database.createObjectStore(METADATA_STORE, { keyPath: 'slot' });
        if (!database.objectStoreNames.contains(PAYLOAD_STORE)) database.createObjectStore(PAYLOAD_STORE, { keyPath: 'slot' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the project-memory database'));
      request.onblocked = () => reject(new Error('Project-memory database upgrade is blocked by another open page'));
    }).catch((error: unknown) => {
      this.databasePromise = null;
      throw error;
    });
    return this.databasePromise;
  }

  public async listMetadata(): Promise<readonly ProjectMemoryMetadata[]> {
    const database = await this.openDatabase();
    const transaction = database.transaction(METADATA_STORE, 'readonly');
    const request = transaction.objectStore(METADATA_STORE).getAll() as IDBRequest<StoredMetadata[]>;
    const [records] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    return records
      .filter((record) => isValidMetadata(record))
      .map((record) => ({ ...record }))
      .sort((left, right) => left.slot - right.slot);
  }

  public async getMetadata(slot: number): Promise<ProjectMemoryMetadata | null> {
    assertSlot(slot);
    const database = await this.openDatabase();
    const transaction = database.transaction(METADATA_STORE, 'readonly');
    const request = transaction.objectStore(METADATA_STORE).get(slot) as IDBRequest<StoredMetadata | undefined>;
    const [record] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    if (!isValidMetadata(record, slot)) return null;
    return { ...record };
  }

  /** Read slot metadata and payload under the same IndexedDB snapshot. */
  public async readSlot(slot: number): Promise<{ metadata: ProjectMemoryMetadata; archive: ArrayBuffer } | null> {
    assertSlot(slot);
    const database = await this.openDatabase();
    const transaction = database.transaction([METADATA_STORE, PAYLOAD_STORE], 'readonly');
    const metadataRequest = transaction.objectStore(METADATA_STORE).get(slot) as IDBRequest<StoredMetadata | undefined>;
    const payloadRequest = transaction.objectStore(PAYLOAD_STORE).get(slot) as IDBRequest<StoredPayload | undefined>;
    const [metadata, payload] = await Promise.all([
      requestResult(metadataRequest),
      requestResult(payloadRequest),
      transactionCompletion(transaction),
    ]);
    if (!metadata && !payload) return null;
    if (!metadata || !payload || !(payload.archive instanceof ArrayBuffer)
      || !isValidMetadata(metadata, slot)) {
      throw new Error(`Memory slot ${slot} has incomplete or invalid metadata/payload records`);
    }
    return { metadata: { ...metadata }, archive: payload.archive };
  }

  /** Save metadata and the binary archive in one IndexedDB read/write transaction. */
  public async save(slot: number, name: string, bpm: number, archive: ArrayBuffer | Uint8Array,
    archiveVersion?: 1 | 2): Promise<ProjectMemoryMetadata> {
    assertSlot(slot);
    if (typeof name !== 'string' || name.trim().length === 0
      || new TextEncoder().encode(name.trim()).byteLength > PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes) {
      throw new RangeError(`Project name must contain 1–${PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes} UTF-8 bytes`);
    }
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 300) throw new RangeError('Project BPM must be between 40 and 300');
    if (archiveVersion !== undefined && archiveVersion !== 1 && archiveVersion !== 2) {
      throw new RangeError('Project archive version must be 1 or 2');
    }
    const view = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
    if (view.byteLength === 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new RangeError('Project archive is empty or exceeds the supported archive-size limit');
    }
    const exactBuffer = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
      ? view.buffer as ArrayBuffer
      : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    const metadata: ProjectMemoryMetadata = {
      slot,
      name: name.trim(),
      bpm,
      savedAt: Date.now(),
      archiveBytes: exactBuffer.byteLength,
      ...(archiveVersion === undefined ? {} : { archiveVersion }),
    };
    const database = await this.openDatabase();
    const transaction = database.transaction([METADATA_STORE, PAYLOAD_STORE], 'readwrite');
    transaction.objectStore(METADATA_STORE).put(metadata);
    transaction.objectStore(PAYLOAD_STORE).put({ slot, archive: exactBuffer } satisfies StoredPayload);
    await transactionCompletion(transaction);
    return metadata;
  }

  public async readArchive(slot: number): Promise<ArrayBuffer | null> {
    assertSlot(slot);
    const database = await this.openDatabase();
    const transaction = database.transaction(PAYLOAD_STORE, 'readonly');
    const request = transaction.objectStore(PAYLOAD_STORE).get(slot) as IDBRequest<StoredPayload | undefined>;
    const [record] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    if (!record || !(record.archive instanceof ArrayBuffer)) return null;
    return record.archive;
  }

  public async delete(slot: number): Promise<void> {
    assertSlot(slot);
    const database = await this.openDatabase();
    const transaction = database.transaction([METADATA_STORE, PAYLOAD_STORE], 'readwrite');
    transaction.objectStore(METADATA_STORE).delete(slot);
    transaction.objectStore(PAYLOAD_STORE).delete(slot);
    await transactionCompletion(transaction);
  }
}
