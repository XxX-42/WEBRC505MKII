import {
  assertProjectMemoryRecord,
  assertMemorySlot,
} from './projectValidation';
import type {
  ProjectMemoryInfo,
  ProjectMemoryRecord,
  ProjectMemoryStore,
} from './projectTypes';

const DATABASE_NAME = 'webrc505-project-memories';
const DATABASE_VERSION = 1;
const OBJECT_STORE = 'memories';

function memoryInfo(record: ProjectMemoryRecord): ProjectMemoryInfo {
  return {
    slot: record.slot,
    name: record.name,
    updatedAt: record.updatedAt,
    trackCount: record.document.tracks.length,
    assetCount: Object.keys(record.audioAssets).length,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException('IndexedDB transaction aborted.', 'AbortError'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

function observeTransaction(transaction: IDBTransaction): Promise<void> {
  const result = transactionResult(transaction);
  // Requests can reject before transaction completion fires. Attach a handler
  // immediately so the completion rejection is never left unobserved.
  void result.catch(() => undefined);
  return result;
}

/**
 * IndexedDB-backed slots 1..99. Each slot is a single structured-clone record,
 * so replacing a memory is atomic. A quota/abort failure leaves the previous
 * record intact because the old value is never deleted first.
 */
export class IndexedDbProjectMemoryStore implements ProjectMemoryStore {
  private readonly factory: IDBFactory;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB) {
    if (!factory) throw new Error('IndexedDB is unavailable in this environment.');
    this.factory = factory;
  }

  async list(): Promise<ProjectMemoryInfo[]> {
    const db = await this.database();
    const transaction = db.transaction(OBJECT_STORE, 'readonly');
    const done = observeTransaction(transaction);
    const records = await requestResult(transaction.objectStore(OBJECT_STORE).getAll()) as ProjectMemoryRecord[];
    await done;
    return records.sort((a, b) => a.slot - b.slot).map(memoryInfo);
  }

  async get(slot: number): Promise<ProjectMemoryRecord | null> {
    assertMemorySlot(slot);
    const db = await this.database();
    const transaction = db.transaction(OBJECT_STORE, 'readonly');
    const done = observeTransaction(transaction);
    const result = await requestResult(transaction.objectStore(OBJECT_STORE).get(slot)) as ProjectMemoryRecord | undefined;
    await done;
    return result ?? null;
  }

  async put(record: ProjectMemoryRecord): Promise<ProjectMemoryInfo> {
    assertProjectMemoryRecord(record);
    const db = await this.database();
    const transaction = db.transaction(OBJECT_STORE, 'readwrite');
    const done = observeTransaction(transaction);
    const request = transaction.objectStore(OBJECT_STORE).put(record);
    try {
      await requestResult(request);
      await done;
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction already completed or aborted */ }
      throw error;
    }
    return memoryInfo(record);
  }

  async delete(slot: number): Promise<void> {
    assertMemorySlot(slot);
    const db = await this.database();
    const transaction = db.transaction(OBJECT_STORE, 'readwrite');
    const done = observeTransaction(transaction);
    await requestResult(transaction.objectStore(OBJECT_STORE).delete(slot));
    await done;
  }

  close(): void {
    if (!this.databasePromise) return;
    void this.databasePromise.then((db) => db.close()).catch(() => undefined);
    this.databasePromise = null;
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OBJECT_STORE)) db.createObjectStore(OBJECT_STORE, { keyPath: 'slot' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        this.databasePromise = null;
        reject(request.error ?? new Error('Could not open project memory storage.'));
      };
      request.onblocked = () => {
        this.databasePromise = null;
        reject(new Error('Project memory storage upgrade is blocked by another open tab.'));
      };
    });
    return this.databasePromise;
  }
}

/** Deterministic in-memory store used by tests and server-side tooling. */
export class VolatileProjectMemoryStore implements ProjectMemoryStore {
  private readonly records = new Map<number, ProjectMemoryRecord>();
  private failure: Error | null = null;

  setNextWriteFailure(error: Error | null): void { this.failure = error; }

  async list(): Promise<ProjectMemoryInfo[]> {
    return [...this.records.values()].sort((a, b) => a.slot - b.slot).map(memoryInfo);
  }

  async get(slot: number): Promise<ProjectMemoryRecord | null> {
    assertMemorySlot(slot);
    const found = this.records.get(slot);
    // Blob is immutable. Keeping its references intact avoids test/runtime
    // polyfills that do not implement Blob structured cloning correctly.
    return found ? { ...found, document: structuredClone(found.document), audioAssets: { ...found.audioAssets } } : null;
  }

  async put(record: ProjectMemoryRecord): Promise<ProjectMemoryInfo> {
    assertProjectMemoryRecord(record);
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    this.records.set(record.slot, {
      ...record,
      document: structuredClone(record.document),
      audioAssets: { ...record.audioAssets },
    });
    return memoryInfo(record);
  }

  async delete(slot: number): Promise<void> {
    assertMemorySlot(slot);
    this.records.delete(slot);
  }
}
