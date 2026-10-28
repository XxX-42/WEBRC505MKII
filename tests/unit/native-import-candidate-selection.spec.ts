import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { useDevicePanel } from '../../src/composables/useDevicePanel';
import { useDeviceScreenEditor } from '../../src/composables/useDeviceScreenEditor';
import type { ProjectRecoveryMetadata } from '../../src/audio/projectMemoryStore';

const fixture = vi.hoisted(() => ({ engine: null as any, memory: null as any }));
vi.mock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => fixture.engine } }));
vi.mock('../../src/audio/projectMemory', () => ({ ProjectMemory: class { constructor() { return fixture.memory; } } }));
vi.mock('../../src/composables/useFxPanelState', () => ({ useFxPanelState: () => ({}) }));
vi.mock('../../src/composables/useTrackFxTargetState', () => ({ useTrackFxTargetState: () => ({}) }));
vi.mock('../../src/composables/useBrowserTrackFxState', () => ({ useBrowserTrackFxState: () => ({}) }));
vi.mock('../../src/composables/useNativeTrackFxState', () => ({ useNativeTrackFxState: () => ({}) }));
vi.mock('../../src/composables/rhythmUiState', () => ({ useRhythmUiControls: () => ({}), rhythmUiState: {} }));
vi.mock('../../src/composables/deviceTrackControllers', () => ({ getDeviceTrackController: () => ({}) }));

const panel = useDevicePanel();
const scopes: ReturnType<typeof effectScope>[] = [];
const ids = { snapshot: '11111111111111111111111111111111', intent: '22222222222222222222222222222222', active: '33333333333333333333333333333333' };
let unresolvedOptions: any[] = [];
let runtimeMode = 'native';

function recovery(operationId: string, state: ProjectRecoveryMetadata['state']): ProjectRecoveryMetadata {
  return { operationId, name: `${state} project`, bpm: 120, savedAt: 1, archiveBytes: 32, archiveVersion: 1, state,
    sourceProjectContentRevision: 1, sourceProjectTransportMutationRevision: 1, sourceModeGeneration: 1, ownerSessionId: 'session-0123456789012345' };
}

async function settle() { await nextTick(); await Promise.resolve(); await nextTick(); }

function field(editor: ReturnType<typeof useDeviceScreenEditor>, key: string) {
  for (let page = 0; page < editor.pageCount.value; page += 1) {
    const found = editor.fields.value.find((item) => item.key === key);
    if (found) return found;
    editor.stepPage(1);
  }
  throw new Error(`Field ${key} was not found.`);
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {} });
  panel.openPage('memory');
  runtimeMode = 'native';
  fixture.engine = { getMode: () => runtimeMode, getUiStatus: () => ({ ready: true, message: '' }),
    onStatusChange: () => () => {}, tracks: [], hasUnsavedLoops: () => false };
  const pending = recovery(ids.snapshot, 'pending');
  const active = recovery(ids.active, 'active');
  unresolvedOptions = [
    { operationId: ids.snapshot, hostIncarnationId: 'a'.repeat(32), generation: 17, createdAt: 3, recovery: pending },
    { operationId: ids.intent, hostIncarnationId: 'b'.repeat(32), createdAt: 2, recovery: null },
  ];
  fixture.memory = {
    list: vi.fn(async () => []),
    getNativeImportRecoveryMetadata: vi.fn(async () => active),
    listUnresolvedNativeImportRecoveryOptions: vi.fn(async () => [...unresolvedOptions]),
    reconcileNativeImportRecovery: vi.fn(async () => ({ state: 'pending', recoveryAvailable: false, generation: 17 })),
    exportPendingNativeImportRecovery: vi.fn(async (operationId: string) => ({ metadata: recovery(operationId, 'pending'), archive: new ArrayBuffer(32) })),
    restoreNativeImportRecovery: vi.fn(async (operationId: string) => ({ name: operationId, bpm: 120, tracksWithAudio: 1, archiveVersion: 1 })),
  };
});

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  panel.goHome();
});

describe('Native import recovery candidate selection', () => {
  it('requires a choice among multiple candidates and passes the selected ID to supported actions', async () => {
    const scope = effectScope(); scopes.push(scope);
    const editor = scope.run(() => useDeviceScreenEditor({ confirm: async () => true }))!;
    await settle();

    const selector = field(editor, 'memory-recovery-candidate');
    expect(selector.options?.map((option) => option.label)).toEqual([
      expect.stringContaining('SELECT CANDIDATE'),
      expect.stringContaining(ids.snapshot),
      expect.stringContaining(ids.intent),
      expect.stringContaining(ids.active),
    ]);
    expect(selector.value).toBe(0);
    expect(field(editor, 'memory-check-import-status').disabled).toBe(true);
    expect(field(editor, 'memory-export-preimport-recovery').disabled).toBe(true);
    expect(field(editor, 'memory-restore-native-recovery').disabled).toBe(true);

    await selector.setValue!(2); // intent only: status can be checked, but no snapshot can be exported/restored
    await settle();
    expect(field(editor, 'memory-check-import-status').disabled).toBe(false);
    expect(field(editor, 'memory-export-preimport-recovery').disabled).toBe(true);
    expect(field(editor, 'memory-restore-native-recovery').disabled).toBe(true);
    await field(editor, 'memory-check-import-status').activate!();
    await settle();
    expect(fixture.memory.reconcileNativeImportRecovery).toHaveBeenCalledWith(ids.intent);

    await field(editor, 'memory-recovery-candidate').setValue!(1);
    await settle();
    await field(editor, 'memory-export-preimport-recovery').activate!();
    await settle();
    expect(fixture.memory.exportPendingNativeImportRecovery).toHaveBeenCalledWith(ids.snapshot);
    await field(editor, 'memory-restore-native-recovery').activate!();
    await settle();
    expect(fixture.memory.restoreNativeImportRecovery).toHaveBeenCalledWith(ids.snapshot);

    await field(editor, 'memory-recovery-candidate').setValue!(3);
    await settle();
    expect(field(editor, 'memory-check-import-status').disabled).toBe(true);
    expect(field(editor, 'memory-export-preimport-recovery').disabled).toBe(true);
    expect(field(editor, 'memory-restore-native-recovery').disabled).toBe(true); // unresolved operations still block active restore
  });

  it('cancels a confirmed restore if same-name candidates changed while confirmation was open', async () => {
    const firstId = '44444444444444444444444444444444';
    const selectedId = '55555555555555555555555555555555';
    const makeOption = (operationId: string) => ({ operationId, createdAt: 1, recovery: recovery(operationId, 'pending') });
    unresolvedOptions = [makeOption(firstId), makeOption(selectedId)];
    fixture.memory.getNativeImportRecoveryMetadata.mockResolvedValue(null);
    let resolveConfirmation!: (confirmed: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }));
    const scope = effectScope(); scopes.push(scope);
    const editor = scope.run(() => useDeviceScreenEditor({ confirm }))!;
    await settle();

    const selector = field(editor, 'memory-recovery-candidate');
    expect(selector.options?.[1]?.label).toContain(firstId);
    expect(selector.options?.[2]?.label).toContain(selectedId);
    expect(selector.options?.[1]?.label.split(' · ')[1]).toBe(selector.options?.[2]?.label.split(' · ')[1]);
    await selector.setValue!(2);
    await settle();
    await field(editor, 'memory-restore-native-recovery').activate!();
    await settle();
    expect(confirm).toHaveBeenCalledOnce();

    unresolvedOptions = [makeOption(firstId)]; // selected operation disappeared in another page/context
    resolveConfirmation(true);
    await settle(); await settle();
    expect(fixture.memory.restoreNativeImportRecovery).not.toHaveBeenCalled();
  });

  it('routes same-name recovery candidates by their full selected operation ID', async () => {
    const firstId = '66666666666666666666666666666666';
    const selectedId = '77777777777777777777777777777777';
    const sameNameRecovery = (operationId: string): ProjectRecoveryMetadata => ({
      ...recovery(operationId, 'pending'), name: 'Identical label',
    });
    unresolvedOptions = [
      { operationId: firstId, createdAt: 2, recovery: sameNameRecovery(firstId) },
      { operationId: selectedId, createdAt: 1, recovery: sameNameRecovery(selectedId) },
    ];
    fixture.memory.getNativeImportRecoveryMetadata.mockResolvedValue(null);
    const scope = effectScope(); scopes.push(scope);
    const editor = scope.run(() => useDeviceScreenEditor({ confirm: async () => true }))!;
    await settle();

    const selector = field(editor, 'memory-recovery-candidate');
    expect(selector.options?.[1]?.label).toContain(firstId);
    expect(selector.options?.[2]?.label).toContain(selectedId);
    await selector.setValue!(2);
    await settle();
    await field(editor, 'memory-restore-native-recovery').activate!();
    await settle(); await settle();
    expect(fixture.memory.restoreNativeImportRecovery).toHaveBeenCalledExactlyOnceWith(selectedId);
  });

  it('does not restore after Native runtime changes during confirmation', async () => {
    unresolvedOptions = [{ operationId: ids.snapshot, createdAt: 3, recovery: recovery(ids.snapshot, 'pending') }];
    fixture.memory.getNativeImportRecoveryMetadata.mockResolvedValue(null);
    let resolveConfirmation!: (confirmed: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }));
    const scope = effectScope(); scopes.push(scope);
    const editor = scope.run(() => useDeviceScreenEditor({ confirm }))!;
    await settle();

    await field(editor, 'memory-restore-native-recovery').activate!();
    await settle();
    runtimeMode = 'browser';
    resolveConfirmation(true);
    await settle(); await settle();
    expect(fixture.memory.restoreNativeImportRecovery).not.toHaveBeenCalled();
  });
});
