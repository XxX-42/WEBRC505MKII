import { AudioEngine } from './AudioEngine';
import {
  decodeProjectArchive,
  readProjectArchiveVersion,
  PROJECT_ARCHIVE_LIMITS,
  type ProjectArchive,
} from './projectArchive';
import { ProjectMemoryStore, type ProjectMemoryMetadata, type ProjectRecoveryMetadata } from './projectMemoryStore';
import { Transport } from '../core/Transport';
import { withProjectArchiveMutationLock } from './projectArchiveMutationLock';
import type { ProjectRestoreOperationToken, NativeProjectRestoreToken, NativeProjectImportCommitReceipt } from './projectArchive';
import { NativeProjectImportIndeterminateError, NativeProjectImportOutcomeUnknownError,
  isNativeHostIncarnationId, nativeProjectArchiveSha256, type NativeProjectImportState } from './NativeBridgeClient';

export interface ProjectMemoryLoadResult {
  readonly name: string;
  readonly bpm: number;
  readonly tracksWithAudio: number;
  readonly archiveVersion: 1 | 2;
}

export interface ProjectMemorySaveResult extends ProjectMemoryMetadata {
  readonly archiveVersion: 1 | 2;
}

export interface NativeProjectImportReconciliationResult {
  readonly state: NativeProjectImportState;
  readonly recoveryAvailable: boolean;
  readonly generation?: number;
}

export interface NativeProjectImportOperationIdentity {
  readonly operationId: string;
  readonly hostIncarnationId: string;
  readonly generation?: number;
}

export interface NativeProjectImportRecoveryOption {
  readonly operationId: string;
  readonly hostIncarnationId?: string;
  readonly generation?: number;
  readonly createdAt: number;
  readonly recovery: ProjectRecoveryMetadata | null;
}

export class ProjectMemory {
  private readonly engine: AudioEngine;
  private readonly store: ProjectMemoryStore;
  private get sessionId(): string { return projectMemorySessionId(); }

  public constructor(engine?: AudioEngine, store?: ProjectMemoryStore) {
    this.engine = engine ?? AudioEngine.getInstance();
    this.store = store ?? new ProjectMemoryStore();
  }

  public list(): Promise<readonly ProjectMemoryMetadata[]> {
    return this.store.listMetadata();
  }

  public getMetadata(slot: number): Promise<ProjectMemoryMetadata | null> {
    return this.store.getMetadata(slot);
  }

  public async getPendingNativeImportRecovery(): Promise<ProjectRecoveryMetadata | null> {
    return this.store.getPendingNativeImportRecovery();
  }

  public listUnresolvedNativeImportRecoveries(): Promise<readonly ProjectRecoveryMetadata[]> {
    return this.store.listUnresolvedNativeImportRecoveryCandidates();
  }

  /** Lists every unresolved recovery snapshot and operation intent without choosing one implicitly. */
  public async listUnresolvedNativeImportRecoveryOptions(): Promise<readonly NativeProjectImportRecoveryOption[]> {
    const [recoveries, intents] = await Promise.all([
      this.store.listUnresolvedNativeImportRecoveryCandidates(),
      this.store.listNativeImportOperationIntents(),
    ]);
    const options = new Map<string, NativeProjectImportRecoveryOption>();
    for (const recovery of recoveries) {
      options.set(recovery.operationId, {
        operationId: recovery.operationId,
        ...(recovery.sourceHostIncarnationId ? { hostIncarnationId: recovery.sourceHostIncarnationId } : {}),
        ...(recovery.generation === undefined ? {} : { generation: recovery.generation }),
        createdAt: recovery.savedAt,
        recovery,
      });
    }
    for (const intent of intents) {
      if (options.has(intent.operationId)) continue;
      options.set(intent.operationId, {
        operationId: intent.operationId,
        hostIncarnationId: intent.hostIncarnationId,
        createdAt: intent.createdAt,
        recovery: null,
      });
    }
    return [...options.values()].sort((left, right) => right.createdAt - left.createdAt || left.operationId.localeCompare(right.operationId));
  }

  public async getPendingNativeImportOperation(): Promise<NativeProjectImportOperationIdentity | null> {
    const recovery = await this.store.getPendingNativeImportRecovery();
    if (recovery && isNativeHostIncarnationId(recovery.sourceHostIncarnationId)) {
      return { operationId: recovery.operationId, hostIncarnationId: recovery.sourceHostIncarnationId,
        ...(recovery.generation === undefined ? {} : { generation: recovery.generation }) };
    }
    const intents = await this.store.listNativeImportOperationIntents();
    const intent = intents[0];
    return intent ? { operationId: intent.operationId, hostIncarnationId: intent.hostIncarnationId } : null;
  }

  public async getNativeImportRecoveryMetadata(): Promise<ProjectRecoveryMetadata | null> {
    const metadata = await this.store.readNativeImportRecoveryMetadata();
    if (!metadata) return null;
    try {
      this.assertRecoveryGuard(metadata, await this.engine.captureProjectRestoreOperationToken());
      return metadata;
    } catch {
      // Hide stale/cross-session recovery from the UI. The stored bytes remain
      // untouched until a later import publishes a new safe recovery point.
      return null;
    }
  }

  public async exportPendingNativeImportRecovery(operationId?: string): Promise<{ metadata: ProjectRecoveryMetadata; archive: ArrayBuffer }> {
    const candidates = await this.store.listUnresolvedNativeImportRecoveryCandidates();
    const pending = operationId === undefined
      ? candidates.find((entry) => entry.state === 'pending') ?? candidates[0]
      : candidates.find((entry) => entry.operationId === operationId);
    if (!pending) throw new Error('No unresolved pre-import snapshot is available to export.');
    const candidate = await this.store.readNativeImportRecoveryCandidate(pending.operationId);
    if (!candidate) throw new Error('The unresolved pre-import snapshot is incomplete and cannot be exported.');
    return candidate;
  }

  /** Resolve a staged recovery only from the host's authoritative generation status. */
  public async reconcileNativeImportRecovery(operationId: string): Promise<NativeProjectImportReconciliationResult> {
    return withProjectArchiveMutationLock(async () => {
      const candidates = await this.store.listUnresolvedNativeImportRecoveryCandidates();
      const pending = candidates.find((entry) => entry.operationId === operationId);
      if (!pending) {
        const intent = await this.store.readNativeImportOperationIntent(operationId);
        if (!intent) throw new Error('No matching Native import operation is pending for this operation ID.');
        const status = await this.engine.getNativeProjectArchiveImportStatusByOperationId(operationId, intent.hostIncarnationId);
        if (status.operationId !== operationId || status.hostIncarnationId !== intent.hostIncarnationId ||
            status.expectedProjectContentRevision !== intent.expectedProjectContentRevision || status.archiveSha256 !== intent.archiveSha256) {
          return { state: 'unavailable', recoveryAvailable: false };
        }
        if (status.state === 'cancelled') await this.store.clearNativeImportOperationIntent(operationId);
        // The semantic Memory runtime's intent has no pre-import recovery
        // archive. A committed status is exact, but local sync recovery is not;
        // retain the intent and keep further imports blocked.
        return { state: status.state, recoveryAvailable: false, generation: status.generation };
      }
      if (!isNativeHostIncarnationId(pending.sourceHostIncarnationId)) {
        return { state: 'unavailable', recoveryAvailable: false, ...(pending.generation === undefined ? {} : { generation: pending.generation }) };
      }
      if (!Number.isSafeInteger(pending.requestExpectedProjectContentRevision) ||
          typeof pending.requestArchiveSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pending.requestArchiveSha256)) {
        throw new Error('Persisted Native request fingerprint is missing; the unresolved import remains locked.');
      }
      const status = await this.engine.getNativeProjectArchiveImportStatusByOperationId(operationId, pending.sourceHostIncarnationId);
      if (status.state === 'unavailable' || !isNativeHostIncarnationId(status.hostIncarnationId) ||
          status.hostIncarnationId !== pending.sourceHostIncarnationId || status.operationId !== operationId ||
          status.expectedProjectContentRevision !== pending.requestExpectedProjectContentRevision ||
          status.archiveSha256 !== pending.requestArchiveSha256) {
        return { state: 'unavailable', recoveryAvailable: false, generation: status.generation };
      }
      if (status.state === 'cancelled') {
        await this.store.discardNativeImportRecoveryStage(pending.operationId);
        return { state: status.state, recoveryAvailable: false, generation: status.generation };
      }
      if (status.state !== 'committed') {
        await this.store.markNativeImportRecoveryPending(operationId, status.generation);
        return { state: status.state, recoveryAvailable: false, generation: status.generation };
      }
      if (status.recoveryUnavailable === true) {
        // Keep the only pre-import archive. Without this page's exact transport
        // receipt it cannot be safely published or restored, but deletion would
        // destroy the user's rollback bytes after a confirmed host commit.
        await this.store.markNativeImportRecoveryPending(operationId, status.generation);
        return { state: status.state, recoveryAvailable: false, generation: status.generation };
      }
      if (status.projectContentRevision === undefined || status.projectTransportMutationRevision === undefined) {
        throw new Error('Committed generation lacks an exact host and transport receipt; recovery remains unavailable.');
      }
      await this.publishCommittedCandidate(pending, {
        generation: status.generation,
        hostIncarnationId: status.hostIncarnationId!,
        projectContentRevision: status.projectContentRevision,
        committedProjectContentRevision: status.committedProjectContentRevision ?? status.projectContentRevision,
        projectTransportMutationRevision: status.projectTransportMutationRevision,
      });
      return { state: status.state, recoveryAvailable: true, generation: status.generation };
    });
  }

  public async save(slot: number, name: string): Promise<ProjectMemorySaveResult> {
    // The name appears in both the archive manifest and the IndexedDB index.
    // Canonicalize it once before the asynchronous export so these records can
    // never disagree (and reject invalid names before doing expensive work).
    const canonicalName = canonicalProjectName(name);
    const archive = await this.engine.exportProjectArchive(canonicalName);
    const archiveVersion = readProjectArchiveVersion(archive);
    const saved = await this.store.save(slot, canonicalName, Transport.getInstance().bpm, archive, archiveVersion);
    return { ...saved, archiveVersion };
  }

  public async load(slot: number): Promise<ProjectMemoryLoadResult> {
    return withProjectArchiveMutationLock(() => this.loadLocked(slot));
  }

  private async loadLocked(slot: number): Promise<ProjectMemoryLoadResult> {
    const operationToken = await this.engine.captureProjectRestoreOperationToken();
    const saved = await this.store.readSlot(slot);
    if (!saved) throw new Error(`Memory slot ${slot} is empty`);
    const { metadata, archive } = saved;
    if (archive.byteLength !== metadata.archiveBytes) throw new Error('Saved project length does not match its slot metadata');
    const project = await decodeProjectArchive(archive);
    this.assertMetadataMatchesArchive(metadata, project);
    await this.assertNoUnresolvedImport();
    const staged = await this.stageNativeRecoveryCandidate(operationToken);
    await this.commitImport(project, archive, operationToken, staged);
    return { name: metadata.name, bpm: project.bpm, tracksWithAudio: project.tracks.filter(Boolean).length, archiveVersion: project.version };
  }

  public async importFile(file: File): Promise<ProjectMemoryLoadResult> {
    return withProjectArchiveMutationLock(() => this.importFileLocked(file));
  }

  private async importFileLocked(file: File): Promise<ProjectMemoryLoadResult> {
    const operationToken = await this.engine.captureProjectRestoreOperationToken();
    if (file.size < 1 || file.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new Error(`Project file must be between 1 byte and ${Math.floor(PROJECT_ARCHIVE_LIMITS.maxArchiveBytes / (1024 * 1024))} MiB`);
    }
    const archive = await file.arrayBuffer();
    if (archive.byteLength !== file.size) throw new Error('Project file changed while it was being read');
    const project = await decodeProjectArchive(archive);
    await this.assertNoUnresolvedImport();
    const staged = await this.stageNativeRecoveryCandidate(operationToken);
    await this.commitImport(project, archive, operationToken, staged);
    return { name: project.name, bpm: project.bpm, tracksWithAudio: project.tracks.filter(Boolean).length, archiveVersion: project.version };
  }

  public async exportFile(name: string): Promise<Uint8Array> {
    const archive = await this.engine.exportProjectArchive(name);
    if (archive.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) throw new Error('Project export exceeds the supported archive-size limit');
    return archive;
  }

  /** Restore the durable pre-import Native project snapshot. This runs as an ordinary
   * project transaction; it does not claim to be Native real-time track undo. */
  public async restoreNativeImportRecovery(operationId?: string): Promise<ProjectMemoryLoadResult> {
    return withProjectArchiveMutationLock(() => this.restoreNativeImportRecoveryLocked(operationId));
  }

  private async restoreNativeImportRecoveryLocked(operationId?: string): Promise<ProjectMemoryLoadResult> {
    if (this.engine.getMode() !== 'native') throw new Error('Native import recovery is available only in Native mode.');
    const candidates = await this.store.listUnresolvedNativeImportRecoveryCandidates();
    const unresolved = operationId === undefined
      ? candidates.find((entry) => entry.state === 'pending') ?? candidates[0] ?? null
      : candidates.find((entry) => entry.operationId === operationId) ?? null;
    if (unresolved) return this.restorePendingNativeImportRecoveryLocked(unresolved);
    const operationToken = await this.engine.captureProjectRestoreOperationToken();
    await this.assertNoUnresolvedImport();
    const saved = await this.store.readNativeImportRecovery();
    if (!saved) throw new Error('There is no saved pre-import Native project recovery archive.');
    if (operationId !== undefined && saved.metadata.operationId !== operationId) {
      throw new Error('The selected operation does not match the active Native recovery snapshot.');
    }
    this.assertRecoveryGuard(saved.metadata, operationToken);
    if (saved.archive.byteLength !== saved.metadata.archiveBytes) throw new Error('Native recovery archive length does not match its metadata.');
    const project = await decodeProjectArchive(saved.archive);
    if (project.bpm !== saved.metadata.bpm || project.version !== saved.metadata.archiveVersion) {
      throw new Error('Native recovery metadata does not match its validated archive.');
    }
    // Capture the current project before applying the recovery archive. On a
    // successful commit this becomes the next recovery point (undo/redo toggle).
    const staged = await this.stageNativeRecoveryCandidate(operationToken);
    if (!staged) throw new Error('Native recovery candidate was not staged; the project was not restored.');
    try {
      if (!operationToken.native) throw new Error('Native recovery restore lost its operation-start host token.');
      await this.store.bindNativeImportRequest(staged.operationId, operationToken.native.projectContentRevision,
        await nativeProjectArchiveSha256(saved.archive));
      const receipt = await this.engine.restoreProjectArchive(project, saved.archive, operationToken, staged.operationId);
      if (!receipt) throw new Error('Native recovery did not return a committed host receipt.');
      await this.publishCommittedCandidate(staged, receipt);
    } catch (error) {
      await this.handleUncommittedStage(staged, error);
      throw error;
    }
    return { name: project.name, bpm: project.bpm, tracksWithAudio: project.tracks.filter(Boolean).length, archiveVersion: project.version };
  }

  private async restorePendingNativeImportRecoveryLocked(pending: ProjectRecoveryMetadata): Promise<ProjectMemoryLoadResult> {
    if (pending.state !== 'pending' || !isNativeHostIncarnationId(pending.sourceHostIncarnationId) ||
        !Number.isSafeInteger(pending.requestExpectedProjectContentRevision) ||
        typeof pending.requestArchiveSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pending.requestArchiveSha256)) {
      throw new Error('The pre-import snapshot remains preserved, but its pending operation is not proven committed; check status before restore.');
    }
    const status = await this.engine.getNativeProjectArchiveImportStatusByOperationId(pending.operationId, pending.sourceHostIncarnationId);
    if (status.state !== 'committed' || status.operationId !== pending.operationId ||
        status.hostIncarnationId !== pending.sourceHostIncarnationId ||
        status.expectedProjectContentRevision !== pending.requestExpectedProjectContentRevision ||
        status.archiveSha256 !== pending.requestArchiveSha256) {
      throw new Error('The pre-import snapshot remains preserved; restore requires an exact committed host operation and request fingerprint.');
    }
    const saved = await this.store.readNativeImportRecoveryCandidate(pending.operationId);
    if (!saved) throw new Error('The unresolved pre-import archive is missing or invalid; it was not replaced.');
    if (saved.archive.byteLength !== saved.metadata.archiveBytes) throw new Error('Native pre-import archive length does not match its metadata.');
    const project = await decodeProjectArchive(saved.archive);
    const operationToken = await this.engine.captureProjectRestoreOperationToken();
    if (operationToken.mode !== 'native' || !operationToken.native ||
        operationToken.native.hostIncarnationId !== pending.sourceHostIncarnationId) {
      throw new Error('Native host incarnation changed; pre-import recovery remains preserved and was not uploaded.');
    }
    const staged = await this.stageNativeRecoveryCandidate(operationToken, pending.operationId);
    try {
      await this.commitImport(project, saved.archive, operationToken, staged);
    } catch (error) {
      throw error;
    }
    return { name: project.name, bpm: project.bpm, tracksWithAudio: project.tracks.filter(Boolean).length, archiveVersion: project.version };
  }

  public delete(slot: number): Promise<void> {
    return this.store.delete(slot);
  }

  private async commitImport(project: ProjectArchive, archive: ArrayBuffer | Uint8Array,
    operationToken: ProjectRestoreOperationToken, staged: ProjectRecoveryMetadata | null): Promise<void> {
    if (!staged) {
      if (operationToken.mode === 'native') throw new Error('Native import requires a durable pre-import recovery candidate.');
      await this.engine.restoreProjectArchive(project, archive, operationToken);
      return;
    }
    try {
      if (operationToken.mode !== 'native' || !operationToken.native) throw new Error('Native recovery candidate lost its operation-start host token.');
      await this.store.bindNativeImportRequest(staged.operationId, operationToken.native.projectContentRevision,
        await nativeProjectArchiveSha256(archive));
      const receipt = await this.engine.restoreProjectArchive(project, archive, operationToken, staged.operationId);
      if (!receipt) throw new Error('Native archive import did not return a committed host receipt.');
      await this.publishCommittedCandidate(staged, receipt);
    } catch (error) {
      await this.handleUncommittedStage(staged, error);
      throw error;
    }
  }

  private async stageNativeRecoveryCandidate(operationToken: ProjectRestoreOperationToken,
      supersedesOperationId?: string): Promise<ProjectRecoveryMetadata | null> {
    if (operationToken.mode !== 'native') return null;
    const initial = operationToken.native;
    if (!initial) throw new Error('Native recovery requires an authoritative project revision token.');
    const before = await this.engine.captureProjectRestoreOperationToken();
    assertSameNativeOperationToken(operationToken, before);
    const archive = await this.engine.exportProjectArchive('Before Native import');
    const afterExport = await this.engine.captureProjectRestoreOperationToken();
    assertSameNativeOperationToken(operationToken, afterExport);
    const version = readProjectArchiveVersion(archive);
    const project = await decodeProjectArchive(archive);
    if (project.version !== version || project.bpm !== initial.transport.bpm ||
        project.transport.masterTrackId !== initial.transport.masterTrackId ||
        project.transport.masterLoopLengthSamples !== initial.transport.masterLoopLengthSamples ||
        project.transport.timeSignatureNumerator !== initial.transport.timeSignatureNumerator ||
        project.transport.timeSignatureDenominator !== initial.transport.timeSignatureDenominator ||
        project.transport.measureLengthSeconds !== initial.transport.measureLengthSeconds) {
      throw new Error('Native recovery snapshot does not match the captured host and transport state; import was not submitted.');
    }
    const operationId = createSecureId();
    const candidate = await this.store.stageNativeImportRecovery({
      operationId, name: project.name, bpm: project.bpm, archiveVersion: version,
      sourceProjectContentRevision: initial.projectContentRevision,
      sourceProjectTransportMutationRevision: initial.projectTransportMutationRevision,
      sourceHostIncarnationId: initial.hostIncarnationId,
      sourceModeGeneration: operationToken.modeGeneration,
      ownerSessionId: this.sessionId,
      ...(supersedesOperationId === undefined ? {} : { supersedesOperationId }),
    }, archive);
    try {
      const afterStage = await this.engine.captureProjectRestoreOperationToken();
      assertSameNativeOperationToken(operationToken, afterStage);
      return candidate;
    } catch (error) {
      await this.store.discardNativeImportRecoveryStage(operationId);
      throw error;
    }
  }

  private async publishCommittedCandidate(staged: ProjectRecoveryMetadata, receipt: NativeProjectImportCommitReceipt): Promise<void> {
    if (staged.generation !== undefined && staged.generation !== receipt.generation) {
      throw new Error('Native recovery candidate generation does not match the committed host receipt.');
    }
    if (!isNativeHostIncarnationId(staged.sourceHostIncarnationId) ||
        staged.sourceHostIncarnationId !== receipt.hostIncarnationId) {
      throw new Error('Native host incarnation does not match the persisted recovery candidate; recovery was not published.');
    }
    if (!Number.isSafeInteger(receipt.committedProjectContentRevision) || receipt.committedProjectContentRevision < 0 ||
        receipt.committedProjectContentRevision > receipt.projectContentRevision) {
      throw new Error('Native commit receipt does not contain a valid callback and post-sync revision pair.');
    }
    const current = await this.engine.captureProjectRestoreOperationToken();
    if (current.mode !== 'native' || current.modeGeneration !== staged.sourceModeGeneration ||
        !current.native || current.native.projectContentRevision !== receipt.projectContentRevision ||
        current.native.projectTransportMutationRevision !== receipt.projectTransportMutationRevision ||
        current.native.hostIncarnationId !== receipt.hostIncarnationId) {
      throw new Error('Native commit receipt no longer matches the current project revision; recovery was not published.');
    }
    await this.store.publishNativeImportRecovery(staged.operationId, {
      generation: receipt.generation,
      projectContentRevision: receipt.projectContentRevision,
      committedProjectContentRevision: receipt.committedProjectContentRevision,
      projectTransportMutationRevision: receipt.projectTransportMutationRevision,
      modeGeneration: current.modeGeneration,
      hostIncarnationId: receipt.hostIncarnationId,
    });
  }

  private async handleUncommittedStage(staged: ProjectRecoveryMetadata, error: unknown): Promise<void> {
    if (error instanceof NativeProjectImportIndeterminateError) {
      await this.store.markNativeImportRecoveryPending(staged.operationId, error.generation);
      return;
    }
    if (error instanceof NativeProjectImportOutcomeUnknownError) {
      await this.store.markNativeImportRecoveryPending(staged.operationId);
      return;
    }
    if (typeof error === 'object' && error !== null && 'recoveryUnavailable' in error && error.recoveryUnavailable === true &&
        'archiveCommitted' in error && error.archiveCommitted === true) {
      await this.store.discardNativeImportRecoveryStage(staged.operationId);
      return;
    }
    if (typeof error === 'object' && error !== null && 'archiveCommitted' in error && error.archiveCommitted === true &&
        'generation' in error && Number.isSafeInteger(error.generation) && Number(error.generation) > 0) {
      await this.store.markNativeImportRecoveryPending(staged.operationId, Number(error.generation));
      return;
    }
    // A committed-but-unsynchronized import is intentionally not published:
    // only a full receipt can authorize an active recovery point.
    await this.store.discardNativeImportRecoveryStage(staged.operationId);
  }

  private async assertNoUnresolvedImport(): Promise<void> {
    if (await this.store.getUnresolvedNativeImportRecovery()) {
      throw new Error('A previous Native import outcome is unresolved; check its generation before another project mutation.');
    }
  }

  private assertRecoveryGuard(metadata: ProjectRecoveryMetadata, token: ProjectRestoreOperationToken): void {
    if (metadata.ownerSessionId !== this.sessionId || token.mode !== 'native' || !token.native ||
        !isNativeHostIncarnationId(metadata.availableAtHostIncarnationId) ||
        metadata.availableAtHostIncarnationId !== token.native.hostIncarnationId ||
        metadata.sourceHostIncarnationId !== token.native.hostIncarnationId ||
        token.modeGeneration !== metadata.availableAtModeGeneration ||
        token.native.projectContentRevision !== metadata.availableAtProjectContentRevision ||
        token.native.projectTransportMutationRevision !== metadata.availableAtProjectTransportMutationRevision) {
      throw new Error('Native recovery is stale or belongs to another engine session; it cannot safely replace the current project.');
    }
  }

  private assertMetadataMatchesArchive(metadata: ProjectMemoryMetadata, project: ProjectArchive): void {
    // Earlier releases could save the manifest's untrimmed name while storing
    // trimmed slot metadata. Accept only that whitespace-only legacy mismatch;
    // all archive schema, payload hashes and BPM checks remain unchanged.
    if (metadata.name !== project.name.trim() || metadata.bpm !== project.bpm) {
      throw new Error('Saved project metadata does not match the validated archive; current loops were left unchanged');
    }
  }
}

let currentProjectMemorySessionId: string | null = null;

function projectMemorySessionId(): string {
  currentProjectMemorySessionId ??= createSecureId();
  return currentProjectMemorySessionId;
}

function createSecureId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Secure project recovery identifiers are unavailable; Native recovery is disabled.');
  }
  return crypto.randomUUID().replace(/-/g, '').toLowerCase();
}

function assertSameNativeOperationToken(expected: ProjectRestoreOperationToken, actual: ProjectRestoreOperationToken): void {
  if (expected.mode !== 'native' || actual.mode !== 'native' || expected.modeGeneration !== actual.modeGeneration ||
      !expected.native || !actual.native || !sameNativeToken(expected.native, actual.native)) {
    throw new Error('Native project changed while the recovery archive was being captured; import was not submitted.');
  }
}

function sameNativeToken(left: NativeProjectRestoreToken, right: NativeProjectRestoreToken): boolean {
  return left.hostIncarnationId === right.hostIncarnationId &&
    left.projectContentRevision === right.projectContentRevision &&
    left.projectTransportMutationRevision === right.projectTransportMutationRevision &&
    left.sampleRate === right.sampleRate &&
    left.transport.bpm === right.transport.bpm && left.transport.state === right.transport.state &&
    left.transport.masterTrackId === right.transport.masterTrackId &&
    left.transport.measureLengthSeconds === right.transport.measureLengthSeconds &&
    left.transport.masterLoopLengthSamples === right.transport.masterLoopLengthSamples &&
    left.transport.timeSignatureNumerator === right.transport.timeSignatureNumerator &&
    left.transport.timeSignatureDenominator === right.transport.timeSignatureDenominator;
}

function canonicalProjectName(name: string): string {
  if (typeof name !== 'string') throw new TypeError('Project name must be a string');
  const canonical = name.trim();
  const byteLength = new TextEncoder().encode(canonical).byteLength;
  if (byteLength === 0 || byteLength > PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes) {
    throw new RangeError(`Project name must contain 1–${PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes} UTF-8 bytes`);
  }
  return canonical;
}
