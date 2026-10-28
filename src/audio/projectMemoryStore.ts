import { PROJECT_ARCHIVE_LIMITS } from './projectArchive';

export const PROJECT_MEMORY_SLOT_COUNT = 99;
const DATABASE_NAME = 'webrc505-project-memory';
const DATABASE_VERSION = 4;
const METADATA_STORE = 'slot-metadata';
const PAYLOAD_STORE = 'slot-payloads';
const RECOVERY_STORE = 'native-import-recovery';
const RECOVERY_METADATA_STORE = 'native-import-recovery-metadata';
const OPERATION_INTENT_STORE = 'native-import-operation-intents';
const RECOVERY_ACTIVE_KEY = 'active-native-import-recovery';
const RECOVERY_SEQUENCE_KEY = 'native-import-recovery-sequence';

export interface ProjectMemoryMetadata {
  readonly slot: number;
  readonly name: string;
  readonly bpm: number;
  readonly savedAt: number;
  readonly archiveBytes: number;
  /** Absent only on legacy slot-index records created before archive-version labels. */
  readonly archiveVersion?: 1 | 2;
}

export interface ProjectRecoveryMetadata {
  readonly operationId: string;
  readonly name: string;
  readonly bpm: number;
  readonly savedAt: number;
  readonly archiveBytes: number;
  readonly archiveVersion: 1 | 2;
  readonly state: 'staged' | 'pending' | 'active';
  readonly sourceProjectContentRevision: number;
  readonly sourceProjectTransportMutationRevision: number;
  readonly sourceModeGeneration: number;
  readonly ownerSessionId: string;
  /** Missing only on pre-incarnation records; such candidates cannot be reconciled safely. */
  readonly sourceHostIncarnationId?: string;
  readonly requestExpectedProjectContentRevision?: number;
  readonly requestArchiveSha256?: string;
  readonly supersedesOperationId?: string;
  readonly generation?: number;
  readonly availableAtProjectContentRevision?: number;
  readonly committedProjectContentRevision?: number;
  readonly availableAtProjectTransportMutationRevision?: number;
  readonly availableAtModeGeneration?: number;
  readonly availableAtHostIncarnationId?: string;
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
        if (!database.objectStoreNames.contains(RECOVERY_STORE)) database.createObjectStore(RECOVERY_STORE);
        if (!database.objectStoreNames.contains(RECOVERY_METADATA_STORE)) database.createObjectStore(RECOVERY_METADATA_STORE);
        if (!database.objectStoreNames.contains(OPERATION_INTENT_STORE)) database.createObjectStore(OPERATION_INTENT_STORE);
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

  /** Persist a Native operation identity before the archive request can leave the page. */
  public async persistNativeImportOperationIntent(operationId: string, hostIncarnationId: string,
      expectedProjectContentRevision: number, archiveSha256: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/i.test(operationId) || !/^[0-9a-f]{32}$/i.test(hostIncarnationId)) {
      throw new RangeError('Native import operation intent identity is invalid.');
    }
    if (!Number.isSafeInteger(expectedProjectContentRevision) || expectedProjectContentRevision < 0 || !/^[0-9a-f]{64}$/i.test(archiveSha256)) {
      throw new RangeError('Native import operation request fingerprint is invalid.');
    }
    const database = await this.openDatabase();
    const transaction = database.transaction(OPERATION_INTENT_STORE, 'readwrite');
    transaction.objectStore(OPERATION_INTENT_STORE).put({ operationId, hostIncarnationId, expectedProjectContentRevision, archiveSha256, createdAt: Date.now() }, operationId);
    await transactionCompletion(transaction);
  }

  public async clearNativeImportOperationIntent(operationId: string): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction(OPERATION_INTENT_STORE, 'readwrite');
    transaction.objectStore(OPERATION_INTENT_STORE).delete(operationId);
    await transactionCompletion(transaction);
  }

  public async readNativeImportOperationIntent(operationId: string): Promise<{ operationId: string; hostIncarnationId: string;
    expectedProjectContentRevision: number; archiveSha256: string; createdAt: number } | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(OPERATION_INTENT_STORE, 'readonly');
    const request = transaction.objectStore(OPERATION_INTENT_STORE).get(operationId) as IDBRequest<{ operationId: string; hostIncarnationId: string;
      expectedProjectContentRevision: number; archiveSha256: string; createdAt: number } | undefined>;
    const [record] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    if (!record || record.operationId !== operationId || !/^[0-9a-f]{32}$/i.test(record.hostIncarnationId) ||
        !Number.isSafeInteger(record.expectedProjectContentRevision) || record.expectedProjectContentRevision < 0 ||
        !/^[0-9a-f]{64}$/i.test(record.archiveSha256) || !Number.isFinite(record.createdAt)) return null;
    return record;
  }

  public async listNativeImportOperationIntents(): Promise<readonly { operationId: string; hostIncarnationId: string;
    expectedProjectContentRevision: number; archiveSha256: string; createdAt: number }[]> {
    const database = await this.openDatabase();
    const transaction = database.transaction(OPERATION_INTENT_STORE, 'readonly');
    const request = transaction.objectStore(OPERATION_INTENT_STORE).getAll() as IDBRequest<Array<{
      operationId: string; hostIncarnationId: string; expectedProjectContentRevision: number; archiveSha256: string; createdAt: number
    }>>;
    const [records] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    return records.filter((record) => /^[0-9a-f]{32}$/i.test(record.operationId) && /^[0-9a-f]{32}$/i.test(record.hostIncarnationId) &&
      Number.isSafeInteger(record.expectedProjectContentRevision) && record.expectedProjectContentRevision >= 0 &&
      /^[0-9a-f]{64}$/i.test(record.archiveSha256) && Number.isFinite(record.createdAt));
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

  /** Persist a full but invisible candidate until the host confirms the import commit. */
  public async stageNativeImportRecovery(input: Omit<ProjectRecoveryMetadata,
    'archiveBytes' | 'savedAt' | 'state' | 'availableAtProjectContentRevision' |
    'availableAtProjectTransportMutationRevision' | 'availableAtModeGeneration' | 'availableAtHostIncarnationId'>,
    archive: ArrayBuffer | Uint8Array): Promise<ProjectRecoveryMetadata> {
    const { operationId, name, bpm, archiveVersion, sourceProjectContentRevision,
      sourceProjectTransportMutationRevision, sourceModeGeneration, ownerSessionId, generation, supersedesOperationId } = input;
    const view = archive instanceof Uint8Array ? archive : new Uint8Array(archive);
    if (typeof operationId !== 'string' || operationId.length < 16 || typeof ownerSessionId !== 'string' || ownerSessionId.length < 16 ||
        typeof name !== 'string' || name.trim().length === 0 || !Number.isFinite(bpm) || bpm < 40 || bpm > 300 ||
        (archiveVersion !== 1 && archiveVersion !== 2) || !Number.isSafeInteger(sourceProjectContentRevision) || sourceProjectContentRevision < 0 ||
        !Number.isSafeInteger(sourceProjectTransportMutationRevision) || sourceProjectTransportMutationRevision < 0 ||
        !Number.isSafeInteger(sourceModeGeneration) || sourceModeGeneration < 0 ||
        !isHostIncarnationId(input.sourceHostIncarnationId) ||
        (generation !== undefined && (!Number.isSafeInteger(generation) || generation <= 0)) || view.byteLength === 0 ||
        !Number.isSafeInteger(view.byteLength) || view.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new RangeError('Native import recovery archive metadata or size is invalid.');
    }
    const exactBuffer = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
      ? view.buffer as ArrayBuffer
      : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    const baseMetadata: Omit<ProjectRecoveryMetadata, 'savedAt'> = {
      operationId, name: name.trim(), archiveBytes: exactBuffer.byteLength, archiveVersion, bpm,
      state: 'staged', sourceProjectContentRevision, sourceProjectTransportMutationRevision, ownerSessionId,
      sourceHostIncarnationId: input.sourceHostIncarnationId,
      sourceModeGeneration,
      ...(supersedesOperationId === undefined ? {} : { supersedesOperationId }),
      ...(generation === undefined ? {} : { generation }),
    };
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readwrite');
    const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
    const sequenceRequest = metadataStore.get(RECOVERY_SEQUENCE_KEY) as IDBRequest<number | undefined>;
    let metadata!: ProjectRecoveryMetadata;
    sequenceRequest.onsuccess = () => {
      const savedAt = Math.max(Date.now(), (Number.isSafeInteger(sequenceRequest.result) ? sequenceRequest.result! : 0) + 1);
      metadata = { ...baseMetadata, savedAt };
      transaction.objectStore(RECOVERY_STORE).put(exactBuffer, operationId);
      metadataStore.put(metadata, operationId);
      metadataStore.put(savedAt, RECOVERY_SEQUENCE_KEY);
    };
    await transactionCompletion(transaction);
    return metadata;
  }

  public async markNativeImportRecoveryPending(operationId: string, generation?: number): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readwrite');
    const store = transaction.objectStore(RECOVERY_METADATA_STORE);
    const request = store.get(operationId) as IDBRequest<ProjectRecoveryMetadata | undefined>;
    request.onsuccess = () => {
      const metadata = request.result;
      if (!metadata || metadata.state === 'active') { transaction.abort(); return; }
      store.put({ ...metadata, state: 'pending', ...(generation === undefined ? {} : { generation }) }, operationId);
    };
    await transactionCompletion(transaction);
  }

  public async bindNativeImportRequest(operationId: string, expectedProjectContentRevision: number, archiveSha256: string): Promise<void> {
    if (typeof operationId !== 'string' || operationId.length < 16 || !Number.isSafeInteger(expectedProjectContentRevision) ||
        expectedProjectContentRevision < 0 || !/^[0-9a-f]{64}$/i.test(archiveSha256)) {
      throw new RangeError('Native import request fingerprint is invalid.');
    }
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readwrite');
    const store = transaction.objectStore(RECOVERY_METADATA_STORE);
    const request = store.get(operationId) as IDBRequest<ProjectRecoveryMetadata | undefined>;
    request.onsuccess = () => {
      const metadata = request.result;
      if (!metadata || metadata.state !== 'staged' ||
          (metadata.requestExpectedProjectContentRevision !== undefined && metadata.requestExpectedProjectContentRevision !== expectedProjectContentRevision) ||
          (metadata.requestArchiveSha256 !== undefined && metadata.requestArchiveSha256 !== archiveSha256)) {
        transaction.abort();
        return;
      }
      store.put({ ...metadata, requestExpectedProjectContentRevision: expectedProjectContentRevision,
        requestArchiveSha256: archiveSha256 }, operationId);
    };
    await transactionCompletion(transaction);
  }

  public async discardNativeImportRecoveryStage(operationId: string): Promise<void> {
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readwrite');
    transaction.objectStore(RECOVERY_STORE).delete(operationId);
    transaction.objectStore(RECOVERY_METADATA_STORE).delete(operationId);
    await transactionCompletion(transaction);
  }

  /** Atomically publish a committed snapshot by changing its small metadata pointer. */
  public async publishNativeImportRecovery(operationId: string, guard: {
    generation: number;
    projectContentRevision: number;
    committedProjectContentRevision: number;
    projectTransportMutationRevision: number;
    modeGeneration: number;
    hostIncarnationId: string;
  }): Promise<ProjectRecoveryMetadata> {
    if (!Number.isSafeInteger(guard.generation) || guard.generation <= 0 ||
        !Number.isSafeInteger(guard.projectContentRevision) || guard.projectContentRevision < 0 ||
        !Number.isSafeInteger(guard.committedProjectContentRevision) || guard.committedProjectContentRevision < 0 ||
        guard.committedProjectContentRevision > guard.projectContentRevision ||
        !Number.isSafeInteger(guard.projectTransportMutationRevision) || guard.projectTransportMutationRevision < 0 ||
        !Number.isSafeInteger(guard.modeGeneration) || guard.modeGeneration < 0 ||
        !isHostIncarnationId(guard.hostIncarnationId)) {
      throw new RangeError('Native recovery commit guard is invalid.');
    }
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readwrite');
    const store = transaction.objectStore(RECOVERY_METADATA_STORE);
    const candidateRequest = store.get(operationId) as IDBRequest<ProjectRecoveryMetadata | undefined>;
    let published: ProjectRecoveryMetadata | null = null;
    candidateRequest.onsuccess = () => {
      const candidate = candidateRequest.result;
      if (!candidate || (candidate.state !== 'staged' && candidate.state !== 'pending') ||
          (candidate.generation !== undefined && candidate.generation !== guard.generation) ||
          !isHostIncarnationId(candidate.sourceHostIncarnationId) || candidate.sourceHostIncarnationId !== guard.hostIncarnationId) { transaction.abort(); return; }
      published = {
        ...candidate,
        state: 'active',
        generation: guard.generation,
        availableAtProjectContentRevision: guard.projectContentRevision,
        committedProjectContentRevision: guard.committedProjectContentRevision,
        availableAtProjectTransportMutationRevision: guard.projectTransportMutationRevision,
        availableAtModeGeneration: guard.modeGeneration,
        availableAtHostIncarnationId: guard.hostIncarnationId,
      };
      const activeRequest = store.get(RECOVERY_ACTIVE_KEY) as IDBRequest<string | undefined>;
      activeRequest.onsuccess = () => {
        const previousId = activeRequest.result;
        store.put(published!, operationId);
        store.put(operationId, RECOVERY_ACTIVE_KEY);
        if (typeof previousId === 'string' && previousId !== operationId) store.delete(previousId);
        if (typeof candidate.supersedesOperationId === 'string' && candidate.supersedesOperationId !== operationId) {
          transaction.objectStore(RECOVERY_STORE).delete(candidate.supersedesOperationId);
          store.delete(candidate.supersedesOperationId);
        }
      };
    };
    await transactionCompletion(transaction);
    if (!published) throw new Error('Native recovery candidate could not be published.');
    return published;
  }

  public async getPendingNativeImportRecovery(): Promise<ProjectRecoveryMetadata | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(RECOVERY_METADATA_STORE, 'readonly');
    const request = transaction.objectStore(RECOVERY_METADATA_STORE).getAll() as IDBRequest<ProjectRecoveryMetadata[]>;
    const [records] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    return records.filter((entry) => entry.state === 'pending' || entry.state === 'staged')
      .sort((left, right) => right.savedAt - left.savedAt)[0] ?? null;
  }

  public async readNativeImportRecoveryCandidate(operationId: string): Promise<{ metadata: ProjectRecoveryMetadata; archive: ArrayBuffer } | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readonly');
    const metadataRequest = transaction.objectStore(RECOVERY_METADATA_STORE).get(operationId) as IDBRequest<ProjectRecoveryMetadata | undefined>;
    const archiveRequest = transaction.objectStore(RECOVERY_STORE).get(operationId) as IDBRequest<ArrayBuffer | undefined>;
    const [metadata, archive] = await Promise.all([requestResult(metadataRequest), requestResult(archiveRequest), transactionCompletion(transaction)]);
    if (!metadata || !(archive instanceof ArrayBuffer) || metadata.operationId !== operationId || metadata.archiveBytes !== archive.byteLength ||
        (metadata.state !== 'pending' && metadata.state !== 'staged') || !Number.isSafeInteger(metadata.archiveBytes) ||
        (metadata.archiveVersion !== 1 && metadata.archiveVersion !== 2)) return null;
    return { metadata: { ...metadata }, archive };
  }

  /** Any leftover staged candidate may represent a crash after upload began; never overwrite it blindly. */
  public async getUnresolvedNativeImportRecovery(): Promise<ProjectRecoveryMetadata | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(RECOVERY_METADATA_STORE, 'readonly');
    const request = transaction.objectStore(RECOVERY_METADATA_STORE).getAll() as IDBRequest<ProjectRecoveryMetadata[]>;
    const [records] = await Promise.all([requestResult(request), transactionCompletion(transaction)]);
    return records.find((entry) => entry.state === 'pending' || entry.state === 'staged') ?? null;
  }

  /** Read the active recovery archive and its guard from one IndexedDB snapshot. */
  public async readNativeImportRecovery(): Promise<{ metadata: ProjectRecoveryMetadata; archive: ArrayBuffer } | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], 'readonly');
    const store = transaction.objectStore(RECOVERY_METADATA_STORE);
    const pointerRequest = store.get(RECOVERY_ACTIVE_KEY) as IDBRequest<string | undefined>;
    const completed = transactionCompletion(transaction);
    const reads: { id: string | null; value: Promise<[ProjectRecoveryMetadata | undefined, ArrayBuffer | undefined]> | null } = { id: null, value: null };
    pointerRequest.addEventListener('success', () => {
      const pointer = pointerRequest.result;
      if (typeof pointer !== 'string') return;
      reads.id = pointer;
      const metadataRequest = store.get(pointer) as IDBRequest<ProjectRecoveryMetadata | undefined>;
      const archiveRequest = transaction.objectStore(RECOVERY_STORE).get(pointer) as IDBRequest<ArrayBuffer | undefined>;
      reads.value = Promise.all([requestResult(metadataRequest), requestResult(archiveRequest)]);
    });
    await requestResult(pointerRequest);
    if (!reads.value) { await completed; return null; }
    const [[metadata, archive]] = await Promise.all([reads.value, completed]);
    if (!(archive instanceof ArrayBuffer) || !metadata || metadata.operationId !== reads.id || metadata.state !== 'active' || !Number.isFinite(metadata.bpm) || metadata.bpm < 40 || metadata.bpm > 300 ||
        typeof metadata.name !== 'string' || metadata.name.trim().length === 0 || !Number.isFinite(metadata.savedAt) ||
        !Number.isSafeInteger(metadata.archiveBytes) || metadata.archiveBytes !== archive.byteLength ||
        metadata.archiveBytes > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes || (metadata.archiveVersion !== 1 && metadata.archiveVersion !== 2) ||
        !Number.isSafeInteger(metadata.sourceProjectContentRevision) || !Number.isSafeInteger(metadata.sourceProjectTransportMutationRevision) ||
        !Number.isSafeInteger(metadata.availableAtProjectContentRevision) || !Number.isSafeInteger(metadata.availableAtProjectTransportMutationRevision) ||
        !Number.isSafeInteger(metadata.committedProjectContentRevision) ||
        !Number.isSafeInteger(metadata.availableAtModeGeneration) || !Number.isSafeInteger(metadata.sourceModeGeneration) ||
        typeof metadata.ownerSessionId !== 'string' || metadata.ownerSessionId.length < 16 ||
        !Number.isSafeInteger(metadata.generation) || metadata.generation! <= 0) {
      throw new Error('Native import recovery record is incomplete or invalid.');
    }
    return { metadata, archive };
  }

  /** Read only small recovery metadata so opening the memory screen never clones the PCM payload. */
  public async readNativeImportRecoveryMetadata(): Promise<ProjectRecoveryMetadata | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(RECOVERY_METADATA_STORE, 'readonly');
    const store = transaction.objectStore(RECOVERY_METADATA_STORE);
    const pointerRequest = store.get(RECOVERY_ACTIVE_KEY) as IDBRequest<string | undefined>;
    const completed = transactionCompletion(transaction);
    const metadataRead: { id: string | null; value: Promise<ProjectRecoveryMetadata | undefined> | null } = { id: null, value: null };
    pointerRequest.addEventListener('success', () => {
      const id = pointerRequest.result;
      if (typeof id === 'string') {
        metadataRead.id = id;
        metadataRead.value = requestResult(store.get(id) as IDBRequest<ProjectRecoveryMetadata | undefined>);
      }
    });
    await requestResult(pointerRequest);
    if (!metadataRead.value) { await completed; return null; }
    const [metadata] = await Promise.all([metadataRead.value, completed]);
    if (metadata === undefined || metadata.state !== 'active') return null;
    if (metadata.operationId !== metadataRead.id || !Number.isFinite(metadata.bpm) || metadata.bpm < 40 || metadata.bpm > 300 ||
        typeof metadata.name !== 'string' || metadata.name.trim().length === 0 || !Number.isFinite(metadata.savedAt) ||
        !Number.isSafeInteger(metadata.archiveBytes) || metadata.archiveBytes <= 0 ||
        metadata.archiveBytes > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes || (metadata.archiveVersion !== 1 && metadata.archiveVersion !== 2) ||
        !Number.isSafeInteger(metadata.availableAtProjectContentRevision) ||
        !Number.isSafeInteger(metadata.committedProjectContentRevision) ||
        !Number.isSafeInteger(metadata.availableAtProjectTransportMutationRevision) ||
        !Number.isSafeInteger(metadata.availableAtModeGeneration) || !Number.isSafeInteger(metadata.sourceModeGeneration) ||
        typeof metadata.ownerSessionId !== 'string' || metadata.ownerSessionId.length < 16 ||
        !Number.isSafeInteger(metadata.generation) || metadata.generation! <= 0) {
      throw new Error('Native import recovery metadata is invalid.');
    }
    return { ...metadata };
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

function isHostIncarnationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}
