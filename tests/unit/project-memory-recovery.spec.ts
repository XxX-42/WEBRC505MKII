import { describe, expect, it, vi } from 'vitest';
import { ProjectMemory } from '../../src/audio/projectMemory';
import { encodeProjectArchive } from '../../src/audio/projectArchive';
import { NativeProjectImportIndeterminateError, NativeProjectImportOutcomeUnknownError } from '../../src/audio/NativeBridgeClient';
import type { ProjectMemoryStore, ProjectRecoveryMetadata } from '../../src/audio/projectMemoryStore';

async function archive(name: string, sample: number): Promise<Uint8Array> {
  return encodeProjectArchive({
    name, bpm: 120,
    tracks: [
      { sampleRate: 48_000, frameCount: 2, channels: 2, pcm: new Float32Array([sample, -sample, sample / 2, -sample / 2]) },
      null, null, null, null,
    ],
  });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function installWebLock(): void {
  let tail = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, operation: () => Promise<unknown>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await operation(); } finally { release(); }
      },
    },
  });
}

function makeEngine(initial: Uint8Array) {
  const hostIncarnationId = 'b'.repeat(32);
  let bytes = arrayBuffer(initial);
  let contentRevision = 10;
  let transportRevision = 4;
  let modeGeneration = 2;
  let generation = 0;
  const captureProjectRestoreOperationToken = vi.fn(async () => ({
    mode: 'native' as const, modeGeneration,
    native: {
      hostIncarnationId,
      projectContentRevision: contentRevision,
      projectTransportMutationRevision: transportRevision,
      sampleRate: 48_000,
      transport: {
        bpm: 120, state: 'STOPPED', masterTrackId: null, measureLengthSeconds: 0,
        masterLoopLengthSamples: 0, timeSignatureNumerator: 4, timeSignatureDenominator: 4,
      },
    },
  }));
  const engine = {
    getMode: () => 'native',
    getNativeProjectArchiveImportStatus: vi.fn(async (value: number) => ({ state: 'pending' as const, generation: value, hostIncarnationId })),
    getNativeProjectArchiveImportStatusByOperationId: vi.fn(async () => ({ state: 'unavailable' as const, generation: 1, hostIncarnationId })),
    captureProjectRestoreOperationToken,
    exportProjectArchive: vi.fn(async () => new Uint8Array(bytes.slice(0))),
    restoreProjectArchive: vi.fn(async (_project: unknown, incoming: ArrayBuffer | Uint8Array) => {
      bytes = arrayBuffer(incoming instanceof Uint8Array ? incoming : new Uint8Array(incoming));
      contentRevision += 1;
      transportRevision += 1;
      generation += 1;
      return { generation, hostIncarnationId, projectContentRevision: contentRevision, committedProjectContentRevision: contentRevision,
        projectTransportMutationRevision: transportRevision };
    }),
  };
  return { engine, captureProjectRestoreOperationToken, restoreProjectArchive: engine.restoreProjectArchive,
    setModeGeneration: (value: number) => { modeGeneration = value; },
    setRevisions: (content: number, transport: number) => { contentRevision = content; transportRevision = transport; } };
}

function makeStore() {
  const stages = new Map<string, { metadata: ProjectRecoveryMetadata; archive: ArrayBuffer }>();
  let activeId: string | null = null;
  const store = {
    readSlot: vi.fn(async () => null),
    getPendingNativeImportRecovery: vi.fn(async () => [...stages.values()].find((entry) => entry.metadata.state === 'pending')?.metadata ?? null),
    getUnresolvedNativeImportRecovery: vi.fn(async () => [...stages.values()].find((entry) => entry.metadata.state === 'pending' || entry.metadata.state === 'staged')?.metadata ?? null),
    stageNativeImportRecovery: vi.fn(async (input: any, archiveBytes: ArrayBuffer | Uint8Array) => {
      const buffer = arrayBuffer(archiveBytes instanceof Uint8Array ? archiveBytes : new Uint8Array(archiveBytes));
      const metadata: ProjectRecoveryMetadata = { ...input, state: 'staged', savedAt: 1, archiveBytes: buffer.byteLength };
      stages.set(input.operationId, { metadata, archive: buffer });
      return metadata;
    }),
    readNativeImportRecoveryCandidate: vi.fn(async (operationId: string) => {
      const entry = stages.get(operationId);
      return entry ? { metadata: entry.metadata, archive: entry.archive } : null;
    }),
    publishNativeImportRecovery: vi.fn(async (operationId: string, guard: any) => {
      const entry = stages.get(operationId);
      if (!entry) throw new Error('missing staged recovery');
      entry.metadata = { ...entry.metadata, state: 'active',
        availableAtProjectContentRevision: guard.projectContentRevision,
        availableAtProjectTransportMutationRevision: guard.projectTransportMutationRevision,
        availableAtModeGeneration: guard.modeGeneration,
        availableAtHostIncarnationId: guard.hostIncarnationId };
      activeId = operationId;
      if (entry.metadata.supersedesOperationId) stages.delete(entry.metadata.supersedesOperationId);
      return entry.metadata;
    }),
    markNativeImportRecoveryPending: vi.fn(async (operationId: string, generation?: number) => {
      const entry = stages.get(operationId)!;
      entry.metadata = { ...entry.metadata, state: 'pending', generation };
    }),
    bindNativeImportRequest: vi.fn(async (operationId: string, expectedProjectContentRevision: number, archiveSha256: string) => {
      const entry = stages.get(operationId)!;
      entry.metadata = { ...entry.metadata, requestExpectedProjectContentRevision: expectedProjectContentRevision, requestArchiveSha256: archiveSha256 };
    }),
    discardNativeImportRecoveryStage: vi.fn(async (operationId: string) => { stages.delete(operationId); }),
    readNativeImportRecovery: vi.fn(async () => activeId ? stages.get(activeId)! : null),
    changePendingOwner: (ownerSessionId: string) => {
      const entry = [...stages.values()].find((item) => item.metadata.state === 'pending');
      if (entry) entry.metadata = { ...entry.metadata, ownerSessionId };
    },
  };
  return { store: store as unknown as ProjectMemoryStore, api: store };
}

describe('Native project import recovery', () => {
  it('does not upload when snapshot persistence fails before import', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e60');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.stageNativeImportRecovery.mockRejectedValue(new Error('IndexedDB quota exceeded'));
    const memory = new ProjectMemory(engine as any, store);
    const bytes = arrayBuffer(incoming);

    await expect(memory.importFile({ size: bytes.byteLength, arrayBuffer: async () => bytes } as File)).rejects.toThrow('IndexedDB quota exceeded');
    expect(engine.restoreProjectArchive).not.toHaveBeenCalled();
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
  });

  it('publishes only after commit and repeated recovery toggles between the two projects', async () => {
    installWebLock();
    let id = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `c3759dbd-bf3d-46eb-aea9-${String(++id).padStart(12, '0')}`);
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({
      metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1, archiveBytes: incoming.byteLength, archiveVersion: 1 },
      archive: arrayBuffer(incoming),
    });
    const memory = new ProjectMemory(engine as any, store);
    await memory.load(1);
    expect(api.publishNativeImportRecovery).toHaveBeenCalledTimes(1);
    expect((await api.readNativeImportRecovery())!.archive).toEqual(arrayBuffer(incumbent));

    const activeBeforeUndo = (await api.readNativeImportRecovery())!.metadata;
    const currentBeforeUndo = await engine.captureProjectRestoreOperationToken();
    expect(activeBeforeUndo).toMatchObject({ ownerSessionId: expect.any(String), availableAtProjectContentRevision: currentBeforeUndo.native.projectContentRevision,
      availableAtProjectTransportMutationRevision: currentBeforeUndo.native.projectTransportMutationRevision, availableAtModeGeneration: currentBeforeUndo.modeGeneration });
    await memory.restoreNativeImportRecovery();
    expect(api.publishNativeImportRecovery).toHaveBeenCalledTimes(2);
    expect((await api.readNativeImportRecovery())!.archive).toEqual(arrayBuffer(incoming));
    await memory.restoreNativeImportRecovery();
    expect(api.publishNativeImportRecovery).toHaveBeenCalledTimes(3);
    expect((await api.readNativeImportRecovery())!.archive).toEqual(arrayBuffer(incumbent));
  });

  it('does not publish a cancelled or failed import candidate', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e61');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({
      metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1, archiveBytes: incoming.byteLength, archiveVersion: 1 },
      archive: arrayBuffer(incoming),
    });
    engine.restoreProjectArchive.mockRejectedValue(new Error('Native import cancelled'));
    const memory = new ProjectMemory(engine as any, store);

    await expect(memory.load(1)).rejects.toThrow('Native import cancelled');
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
    expect(api.discardNativeImportRecoveryStage).toHaveBeenCalledTimes(1);
  });

  it('publishes an indeterminate candidate only after exact committed-generation reconciliation', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e63');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine, setRevisions } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    engine.restoreProjectArchive.mockImplementation(async () => {
      throw new NativeProjectImportIndeterminateError(77);
    });
    const memory = new ProjectMemory(engine as any, store);
    await expect(memory.load(1)).rejects.toMatchObject({ generation: 77 });
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
    expect(await api.getPendingNativeImportRecovery()).toMatchObject({ state: 'pending', generation: 77 });

    setRevisions(11, 5);
    const bound77 = await api.getPendingNativeImportRecovery();
    engine.restoreProjectArchive.mockImplementation(async () => ({ generation: 77, projectContentRevision: 11, projectTransportMutationRevision: 5 }));
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 77,
      hostIncarnationId: 'b'.repeat(32), projectContentRevision: 11, committedProjectContentRevision: 11, projectTransportMutationRevision: 5,
      operationId: bound77!.operationId, expectedProjectContentRevision: bound77!.requestExpectedProjectContentRevision,
      archiveSha256: bound77!.requestArchiveSha256 } as any);
    await expect(memory.reconcileNativeImportRecovery('c3759dbdbf3d46ebaea98a37c3d64e63')).resolves.toMatchObject({ state: 'committed', recoveryAvailable: true });
    expect(api.publishNativeImportRecovery).toHaveBeenCalledTimes(1);
  });

  it('serializes imports from separate ProjectMemory instances with the origin-wide Web Lock', async () => {
    installWebLock();
    let id = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `d3759dbd-bf3d-46eb-aea9-${String(++id).padStart(12, '0')}`);
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({
      metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1, archiveBytes: incoming.byteLength, archiveVersion: 1 },
      archive: arrayBuffer(incoming),
    });
    let release!: () => void;
    const firstCommit = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    engine.restoreProjectArchive.mockImplementation(async (_project: unknown, bytes: ArrayBuffer | Uint8Array) => {
      calls += 1;
      if (calls === 1) { entered(); await firstCommit; }
      return { generation: calls, hostIncarnationId: 'b'.repeat(32), projectContentRevision: 11 + calls, projectTransportMutationRevision: 5 + calls };
    });
    // Make the mock engine reflect each committed receipt for the caller's post-commit check.
    let rev = 10;
    engine.captureProjectRestoreOperationToken.mockImplementation(async () => ({
      mode: 'native', modeGeneration: 2,
      native: { hostIncarnationId: 'b'.repeat(32), projectContentRevision: rev, projectTransportMutationRevision: rev - 6, sampleRate: 48_000,
        transport: { bpm: 120, state: 'STOPPED', masterTrackId: null, measureLengthSeconds: 0,
          masterLoopLengthSamples: 0, timeSignatureNumerator: 4, timeSignatureDenominator: 4 } },
    }));
    engine.restoreProjectArchive.mockImplementation(async (_project: unknown, _bytes: ArrayBuffer | Uint8Array) => {
      calls += 1;
      if (calls === 1) { entered(); await firstCommit; }
      rev += 1;
      return { generation: calls, hostIncarnationId: 'b'.repeat(32), projectContentRevision: rev, committedProjectContentRevision: rev,
        projectTransportMutationRevision: rev - 6 };
    });
    const first = new ProjectMemory(engine as any, store);
    const second = new ProjectMemory(engine as any, store);
    const input = { size: incoming.byteLength, arrayBuffer: async () => arrayBuffer(incoming) } as File;
    const p1 = first.importFile(input);
    await firstEntered;
    const p2 = second.importFile(input);
    await Promise.resolve();
    expect(engine.exportProjectArchive).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([p1, p2]);
    expect(engine.restoreProjectArchive).toHaveBeenCalledTimes(2);
  });

  it('rejects recovery after the project revision has moved', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e62');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine, captureProjectRestoreOperationToken } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    const memory = new ProjectMemory(engine as any, store);
    await memory.load(1);
    captureProjectRestoreOperationToken.mockImplementation(async () => ({ mode: 'native', modeGeneration: 2,
      native: { hostIncarnationId: 'b'.repeat(32), projectContentRevision: 99, projectTransportMutationRevision: 93, sampleRate: 48_000,
        transport: { bpm: 120, state: 'STOPPED', masterTrackId: null, measureLengthSeconds: 0,
          masterLoopLengthSamples: 0, timeSignatureNumerator: 4, timeSignatureDenominator: 4 } } }));
    await expect(memory.restoreNativeImportRecovery()).rejects.toThrow('stale or belongs to another engine session');
    expect(engine.restoreProjectArchive).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a staged operation is left behind by a crashed page', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e64');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    await api.stageNativeImportRecovery({ operationId: 'crashed-stage-0123456789', ownerSessionId: 'dead-session-01234567890',
      name: 'Incumbent', bpm: 120, archiveVersion: 1, sourceProjectContentRevision: 10,
      sourceProjectTransportMutationRevision: 4, sourceHostIncarnationId: 'b'.repeat(32), sourceModeGeneration: 2 }, arrayBuffer(incumbent));
    const memory = new ProjectMemory(engine as any, store);
    const bytes = arrayBuffer(incoming);
    await expect(memory.importFile({ size: bytes.byteLength, arrayBuffer: async () => bytes } as File))
      .rejects.toThrow('previous Native import outcome is unresolved');
    expect(engine.exportProjectArchive).not.toHaveBeenCalled();
    expect(engine.restoreProjectArchive).not.toHaveBeenCalled();
  });

  it('keeps no-generation outcomes blocked and does not guess that the host cancelled', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e65');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    engine.restoreProjectArchive.mockRejectedValue(new NativeProjectImportOutcomeUnknownError('generation response was lost'));
    const memory = new ProjectMemory(engine as any, store);

    await expect(memory.load(1)).rejects.toBeInstanceOf(NativeProjectImportOutcomeUnknownError);
    expect(await api.getUnresolvedNativeImportRecovery()).toMatchObject({ state: 'pending', generation: undefined });
    await expect(memory.load(1)).rejects.toThrow('previous Native import outcome is unresolved');
    expect(engine.restoreProjectArchive).toHaveBeenCalledTimes(1);
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
  });

  it('preserves the only pre-import archive when commit lacks a safe transport receipt', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e66');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    engine.restoreProjectArchive.mockRejectedValue(new NativeProjectImportIndeterminateError(78));
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 78, hostIncarnationId: 'b'.repeat(32),
      projectContentRevision: 11, recoveryUnavailable: true } as any);
    const memory = new ProjectMemory(engine as any, store);

    await expect(memory.load(1)).rejects.toMatchObject({ generation: 78, name: 'NativeProjectImportIndeterminateError' });
    expect(await api.getPendingNativeImportRecovery()).toMatchObject({ state: 'pending', generation: 78 });
    const bound78 = await api.getPendingNativeImportRecovery();
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 78, hostIncarnationId: 'b'.repeat(32),
      projectContentRevision: 11, recoveryUnavailable: true, operationId: bound78!.operationId,
      expectedProjectContentRevision: bound78!.requestExpectedProjectContentRevision, archiveSha256: bound78!.requestArchiveSha256 } as any);
    await expect(memory.reconcileNativeImportRecovery('c3759dbdbf3d46ebaea98a37c3d64e66')).resolves.toMatchObject({ state: 'committed', recoveryAvailable: false });
    expect(await api.getUnresolvedNativeImportRecovery()).toMatchObject({ state: 'pending', operationId: 'c3759dbdbf3d46ebaea98a37c3d64e66' });
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
    expect(api.discardNativeImportRecoveryStage).not.toHaveBeenCalled();
  });

  it('restores a pending generation after page reload and checks its exact host status', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e67');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    engine.restoreProjectArchive.mockRejectedValue(new NativeProjectImportIndeterminateError(79));
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 79, hostIncarnationId: 'b'.repeat(32),
      projectContentRevision: 11, recoveryUnavailable: true } as any);
    const firstPage = new ProjectMemory(engine as any, store);
    await expect(firstPage.load(1)).rejects.toMatchObject({ generation: 79 });
    api.changePendingOwner('previous-page-session-id');
    const bound79 = await api.getPendingNativeImportRecovery();
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 79, hostIncarnationId: 'b'.repeat(32),
      projectContentRevision: 11, recoveryUnavailable: true, operationId: bound79!.operationId,
      expectedProjectContentRevision: bound79!.requestExpectedProjectContentRevision, archiveSha256: bound79!.requestArchiveSha256 } as any);

    const reloadedPage = new ProjectMemory(engine as any, store);
    await expect(reloadedPage.getPendingNativeImportRecovery()).resolves.toMatchObject({ state: 'pending', generation: 79 });
    await expect(reloadedPage.reconcileNativeImportRecovery('c3759dbdbf3d46ebaea98a37c3d64e67')).resolves.toMatchObject({
      state: 'committed', recoveryAvailable: false,
    });
    expect(engine.getNativeProjectArchiveImportStatusByOperationId).toHaveBeenCalledExactlyOnceWith('c3759dbdbf3d46ebaea98a37c3d64e67', 'b'.repeat(32));
    expect(await api.getUnresolvedNativeImportRecovery()).toMatchObject({ state: 'pending', operationId: 'c3759dbdbf3d46ebaea98a37c3d64e67' });
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
  });

  it('keeps a durable candidate unresolved when a restarted host reuses its generation and revisions', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e68');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    engine.restoreProjectArchive.mockRejectedValue(new NativeProjectImportIndeterminateError(80));
    const memory = new ProjectMemory(engine as any, store);
    await expect(memory.load(1)).rejects.toMatchObject({ generation: 80 });
    const pending = await api.getPendingNativeImportRecovery();
    expect(pending).toMatchObject({ state: 'pending', generation: 80, sourceHostIncarnationId: 'b'.repeat(32) });

    // The restarted host reuses generation 80 and the same content/transport
    // revisions, but its cryptographic incarnation differs.
    const bound80 = await api.getPendingNativeImportRecovery();
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 80,
      hostIncarnationId: 'c'.repeat(32), projectContentRevision: 11, operationId: bound80!.operationId,
      expectedProjectContentRevision: bound80!.requestExpectedProjectContentRevision, archiveSha256: bound80!.requestArchiveSha256,
      committedProjectContentRevision: 11, projectTransportMutationRevision: 5 } as any);
    await expect(memory.reconcileNativeImportRecovery('c3759dbdbf3d46ebaea98a37c3d64e68')).resolves.toMatchObject({ state: 'unavailable', recoveryAvailable: false });
    expect(engine.getNativeProjectArchiveImportStatusByOperationId).toHaveBeenCalledWith('c3759dbdbf3d46ebaea98a37c3d64e68', 'b'.repeat(32));
    expect(api.getPendingNativeImportRecovery).toHaveBeenCalled();
    expect(api.publishNativeImportRecovery).not.toHaveBeenCalled();
    expect(api.discardNativeImportRecoveryStage).not.toHaveBeenCalled();
    expect(await api.getUnresolvedNativeImportRecovery()).toMatchObject({ state: 'pending', generation: 80,
      sourceHostIncarnationId: 'b'.repeat(32) });
  });

  it('exports and restores a pre-import snapshot only after exact operation fingerprint commit proof', async () => {
    installWebLock();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('c3759dbd-bf3d-46eb-aea9-8a37c3d64e69');
    const incumbent = await archive('Incumbent', 0.25);
    const incoming = await archive('Incoming', 0.5);
    const { engine, setRevisions } = makeEngine(incumbent);
    const { store, api } = makeStore();
    api.readSlot.mockResolvedValue({ metadata: { slot: 1, name: 'Incoming', bpm: 120, savedAt: 1,
      archiveBytes: incoming.byteLength, archiveVersion: 1 }, archive: arrayBuffer(incoming) });
    engine.restoreProjectArchive.mockRejectedValue(new NativeProjectImportIndeterminateError(81));
    const memory = new ProjectMemory(engine as any, store);
    await expect(memory.load(1)).rejects.toMatchObject({ generation: 81 });
    const pending = await api.getPendingNativeImportRecovery();
    const exported = await memory.exportPendingNativeImportRecovery();
    expect(exported.archive).toEqual(arrayBuffer(incumbent));
    engine.getNativeProjectArchiveImportStatusByOperationId.mockResolvedValue({ state: 'committed', generation: 81,
      hostIncarnationId: 'b'.repeat(32), projectContentRevision: 11, operationId: pending!.operationId,
      expectedProjectContentRevision: pending!.requestExpectedProjectContentRevision, archiveSha256: pending!.requestArchiveSha256 } as any);
    setRevisions(11, 5);
    engine.restoreProjectArchive.mockImplementation(async () => {
      setRevisions(12, 6);
      return { generation: 82, hostIncarnationId: 'b'.repeat(32),
        projectContentRevision: 12, committedProjectContentRevision: 12, projectTransportMutationRevision: 6 } as any;
    });
    await expect(memory.restoreNativeImportRecovery()).resolves.toMatchObject({ name: 'Incumbent' });
    await expect(api.getUnresolvedNativeImportRecovery()).resolves.toBeNull();
    expect(api.publishNativeImportRecovery).toHaveBeenCalledTimes(1);
  });
});
