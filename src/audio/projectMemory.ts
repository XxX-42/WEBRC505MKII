import { AudioEngine } from './AudioEngine';
import {
  decodeProjectArchive,
  PROJECT_ARCHIVE_LIMITS,
  type ProjectArchive,
} from './projectArchive';
import { ProjectMemoryStore, type ProjectMemoryMetadata } from './projectMemoryStore';
import { Transport } from '../core/Transport';

export interface ProjectMemoryLoadResult {
  readonly name: string;
  readonly bpm: number;
  readonly tracksWithAudio: number;
}

export class ProjectMemory {
  private readonly engine: AudioEngine;
  private readonly store: ProjectMemoryStore;

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

  public async save(slot: number, name: string): Promise<ProjectMemoryMetadata> {
    // The name appears in both the archive manifest and the IndexedDB index.
    // Canonicalize it once before the asynchronous export so these records can
    // never disagree (and reject invalid names before doing expensive work).
    const canonicalName = canonicalProjectName(name);
    const archive = await this.engine.exportProjectArchive(canonicalName);
    return this.store.save(slot, canonicalName, Transport.getInstance().bpm, archive);
  }

  public async load(slot: number): Promise<ProjectMemoryLoadResult> {
    const operationToken = await this.engine.captureProjectRestoreOperationToken();
    const saved = await this.store.readSlot(slot);
    if (!saved) throw new Error(`Memory slot ${slot} is empty`);
    const { metadata, archive } = saved;
    if (archive.byteLength !== metadata.archiveBytes) throw new Error('Saved project length does not match its slot metadata');
    const project = await decodeProjectArchive(archive);
    this.assertMetadataMatchesArchive(metadata, project);
    await this.engine.restoreProjectArchive(project, archive, operationToken);
    return { name: metadata.name, bpm: project.bpm, tracksWithAudio: project.tracks.filter(Boolean).length };
  }

  public async importFile(file: File): Promise<ProjectMemoryLoadResult> {
    const operationToken = await this.engine.captureProjectRestoreOperationToken();
    if (file.size < 1 || file.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new Error(`Project file must be between 1 byte and ${Math.floor(PROJECT_ARCHIVE_LIMITS.maxArchiveBytes / (1024 * 1024))} MiB`);
    }
    const archive = await file.arrayBuffer();
    if (archive.byteLength !== file.size) throw new Error('Project file changed while it was being read');
    const project = await decodeProjectArchive(archive);
    await this.engine.restoreProjectArchive(project, archive, operationToken);
    return { name: project.name, bpm: project.bpm, tracksWithAudio: project.tracks.filter(Boolean).length };
  }

  public async exportFile(name: string): Promise<Uint8Array> {
    const archive = await this.engine.exportProjectArchive(name);
    if (archive.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) throw new Error('Project export exceeds the supported archive-size limit');
    return archive;
  }

  public delete(slot: number): Promise<void> {
    return this.store.delete(slot);
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

function canonicalProjectName(name: string): string {
  if (typeof name !== 'string') throw new TypeError('Project name must be a string');
  const canonical = name.trim();
  const byteLength = new TextEncoder().encode(canonical).byteLength;
  if (byteLength === 0 || byteLength > PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes) {
    throw new RangeError(`Project name must contain 1–${PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes} UTF-8 bytes`);
  }
  return canonical;
}
