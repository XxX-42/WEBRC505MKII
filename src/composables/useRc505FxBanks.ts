import { computed, nextTick, onScopeDispose, reactive, readonly, ref, watch, type ComputedRef } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { sameNativeControlSnapshot } from '../audio/nativeFxParameterSnapshots';
import { nativeCatalogEffectId } from '../audio/nativeFxCatalog';
import { useFxPanelState, type FxSlotState } from './useFxPanelState';
import {
  cloneFxPresetSlots,
  createFxPresetBankDocument,
  fxPresetBankStorageKey,
  isFxPresetBankId,
  parseFxPresetBankDocument,
  serializeFxPresetBankDocument,
  type FxPresetBankDocument,
  type FxPresetBankId,
  type FxPresetBankProfile,
  type FxPresetLocation,
  type FxPresetParameter,
  type FxPresetRuntime,
} from '../ui/rc505/Rc505FxBankStore';

const APPLY_TIMEOUT_MS = 5_000;
const RECONCILE_INTERVAL_MS = 80;

export interface Rc505FxBankState {
  requestedBank: FxPresetBankId | null;
  appliedBank: FxPresetBankId | null;
  busy: boolean;
  error: string;
  unavailableReason: string;
}

export interface Rc505FxBanks {
  state: Readonly<Rc505FxBankState>;
  canSelect: ComputedRef<boolean>;
  selectBank(id: FxPresetBankId): Promise<boolean>;
}

interface PendingCandidate {
  bank: FxPresetBankId;
  slots: FxSlotState[];
}

interface BrowserSlotSnapshot {
  slot: FxPresetBankId;
  type: string | null;
  active: boolean;
  state: 'empty' | 'loading' | 'ready' | 'error';
  parameters: Readonly<Record<string, FxPresetParameter>>;
}

const EMPTY_REASON = 'FX bank state is unavailable.';

function normalizeType(type: string | null | undefined): string {
  return !type || type === 'NONE' ? '' : type;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function slotsSignature(slots: readonly FxSlotState[]): string {
  // Match the JSON shape used by persistence. Optional own-properties with
  // value `undefined` are omitted by JSON.stringify and must not look like a
  // live slot mutation during an acknowledged bank apply.
  return stableSerialize(cloneFxPresetSlots(slots));
}

function sameParameterRecord(
  actual: Readonly<Record<string, FxPresetParameter>> | Record<string, number> | null | undefined,
  expected: Readonly<Record<string, FxPresetParameter>> | Record<string, number>,
): boolean {
  if (!actual) return false;
  return stableSerialize(actual) === stableSerialize(expected);
}

function sameNativeParameterRecord(
  actual: Record<string, number> | null | undefined,
  expected: Record<string, number>,
  effectId: string,
): boolean {
  return sameNativeControlSnapshot(actual, expected, effectId, {});
}

function browserParametersMatch(
  actual: BrowserSlotSnapshot,
  expected: Record<string, FxPresetParameter> | null | undefined,
): boolean {
  return expected === undefined || expected === null || sameParameterRecord(actual.parameters, expected);
}

function validateBrowserSlot(
  row: FxSlotState,
  actual: BrowserSlotSnapshot,
  index: number,
  storedParameters: Record<string, FxPresetParameter> | null | undefined,
): boolean {
  const type = normalizeType(row.type);
  if (actual.slot !== (['A', 'B', 'C', 'D'][index] as FxPresetBankId) || normalizeType(actual.type) !== type ||
      actual.active !== (type ? row.active : false)) return false;
  if (!type) return actual.state === 'empty' && browserParametersMatch(actual, storedParameters);
  if (actual.state !== 'ready') return false;
  const named = row.namedParametersByType?.[row.type];
  if (named && Object.entries(named).some(([key, value]) => actual.parameters[key] !== value)) return false;
  return browserParametersMatch(actual, storedParameters);
}

function copyBrowserParameters(snapshot: readonly BrowserSlotSnapshot[]): Array<Record<string, FxPresetParameter> | null> {
  return snapshot.map((slot) => ({ ...slot.parameters }));
}

function runtimeName(engine: AudioEngine): FxPresetRuntime {
  return engine.getMode() === 'native' ? 'native' : 'browser';
}

function setStorageFailure(state: Rc505FxBankState, reason: string): void {
  state.unavailableReason = reason;
  state.error = reason;
}

export function useRc505FxBanks(location: FxPresetLocation): Rc505FxBanks {
  // Ensure legacy FX rows are loaded before creating/migrating the bank sidecar.
  const panel = useFxPanelState(location);
  const engine = AudioEngine.getInstance();
  const runtime = runtimeName(engine);
  const key = fxPresetBankStorageKey(runtime, location);
  const state = reactive<Rc505FxBankState>({
    requestedBank: null,
    appliedBank: null,
    busy: false,
    error: '',
    unavailableReason: '',
  });
  const documentRef = ref<FxPresetBankDocument | null>(null);
  const runtimeRevision = ref(0);
  const canSelect = computed(() => {
    runtimeRevision.value;
    return runtimeName(engine) === runtime && !!documentRef.value && !state.busy &&
      !state.unavailableReason && !panel.fxDisabled.value;
  });
  let lastSerialized = '';
  let storageUnavailable = false;
  let replacingRows = false;
  let changedDuringApply = false;
  let pendingCandidate: PendingCandidate | null = null;
  let isDisposed = false;
  let cancelPendingWait: (() => void) | null = null;

  const getLiveSlots = () => cloneFxPresetSlots(panel.slots.value);
  const currentSignature = () => slotsSignature(panel.slots.value);

  const refreshUnavailableReason = () => {
    runtimeRevision.value += 1;
    if (storageUnavailable) return;
    if (runtimeName(engine) !== runtime) {
      state.unavailableReason = 'The audio runtime changed; reload before using this runtime-specific FX bank.';
      return;
    }
    state.unavailableReason = panel.fxDisabled.value
      ? panel.fxUnavailableReason.value || EMPTY_REASON
      : '';
  };

  const markAppliedStateUnknown = (bank: FxPresetBankId) => {
    if (state.appliedBank !== bank) return;
    // Native named edits lose runtime ACK before their confirmed values enter
    // the panel rows. Keep their bank identity so that later row ACKs can
    // update the candidate, while the normal four-slot gate stays in force.
    if (!state.busy && state.requestedBank === bank && !pendingCandidate) {
      pendingCandidate = { bank, slots: getLiveSlots() };
    }
    state.appliedBank = null;
    state.error = 'The runtime no longer matches the selected FX bank; it is not marked as applied.';
  };

  const persist = (): boolean => {
    const document = documentRef.value;
    if (!document || storageUnavailable) return false;
    if (runtimeName(engine) !== runtime) {
      state.unavailableReason = 'The audio runtime changed; reload before writing this runtime-specific FX bank.';
      return false;
    }
    const serialized = serializeFxPresetBankDocument(document);
    if (serialized === lastSerialized) return true;
    try {
      globalThis.localStorage.setItem(key, serialized);
      lastSerialized = serialized;
      return true;
    } catch {
      storageUnavailable = true;
      setStorageFailure(state, 'FX bank storage is unavailable or read-only; bank selection is disabled and live FX rows were left intact.');
      return false;
    }
  };

  const readOrMigrate = (): boolean => {
    let serialized: string | null;
    try {
      serialized = globalThis.localStorage.getItem(key);
    } catch {
      storageUnavailable = true;
      setStorageFailure(state, 'FX bank storage cannot be read; bank selection is disabled and live FX rows were left intact.');
      return false;
    }
    if (serialized !== null) {
      const parsed = parseFxPresetBankDocument(serialized, runtime, location);
      if (!parsed) {
        storageUnavailable = true;
        setStorageFailure(state, 'FX bank data is corrupt or belongs to another runtime/version; bank selection is disabled and live FX rows were left intact.');
        return false;
      }
      documentRef.value = parsed;
      lastSerialized = serializeFxPresetBankDocument(parsed);
      state.requestedBank = parsed.activeBank;
      return true;
    }

    try {
      documentRef.value = createFxPresetBankDocument(runtime, location, panel.slots.value);
    } catch {
      storageUnavailable = true;
      setStorageFailure(state, 'The current FX rows could not be migrated to banks; bank selection is disabled and live FX rows were left intact.');
      return false;
    }
    state.requestedBank = 'A';
    if (!persist()) {
      // Migration only wrote the sidecar; the legacy rows remain the live source of truth.
      documentRef.value = null;
      state.requestedBank = null;
      return false;
    }
    return true;
  };

  readOrMigrate();
  refreshUnavailableReason();

  const browserSnapshot = (): readonly BrowserSlotSnapshot[] | null => {
    const snapshot = engine.getBrowserSharedFxSnapshot(location) as readonly BrowserSlotSnapshot[] | null;
    return snapshot?.length === 4 ? snapshot : null;
  };

  const slotsMatchRuntime = (
    rows: readonly FxSlotState[],
    profile?: FxPresetBankProfile,
    allowStoredBrowserParameters = true,
  ): boolean => {
    if (runtimeName(engine) !== runtime || rows.length !== 4) return false;
    if (runtime === 'browser') {
      const snapshot = browserSnapshot();
      if (!snapshot) return false;
      return rows.every((row, index) => validateBrowserSlot(
        row,
        snapshot[index]!,
        index,
        allowStoredBrowserParameters ? profile?.browserParameters?.[index] : undefined,
      ));
    }

    return rows.every((row, index) => {
      const status = engine.getNativeCatalogFxSlotStatus(location, index);
      if (!status || !status.acknowledged || status.pendingApply || status.pendingRestart || status.outcomeUnknown ||
          status.processingFaulted || status.controlFaulted || status.error) return false;
      const type = normalizeType(row.type);
      const effectId = type ? nativeCatalogEffectId(type) : null;
      if ((type && !effectId) || status.requestedEffectId !== effectId || status.acknowledgedEffectId !== effectId) return false;
      const bypassed = type ? !row.active : false;
      if (status.requestedBypassed !== bypassed || status.appliedBypassed !== bypassed) return false;
      const expected = type ? engine.getNativeCatalogFxParameterSnapshot(location, index, 0) : {};
      if (expected === null || expected === undefined) return false;
      // NativeAudioEngine already polls bridge status; these getters only read
      // its latest acknowledgement and deliberately never re-submit a slot.
      if (!type) {
        return sameParameterRecord(status.requestedParameters, expected) &&
          sameParameterRecord(status.acknowledgedParameters, expected);
      }
      return sameNativeParameterRecord(status.requestedParameters, expected, effectId!) &&
        sameNativeParameterRecord(status.acknowledgedParameters, expected, effectId!);
    });
  };

  const captureConfirmedProfile = (
    bank: FxPresetBankId,
    rows: readonly FxSlotState[],
    snapshot = runtime === 'browser' ? browserSnapshot() : null,
  ): boolean => {
    const document = documentRef.value;
    if (!document) return false;
    const profile = document.banks[bank];
    profile.slots = cloneFxPresetSlots(rows);
    if (runtime === 'browser' && snapshot) profile.browserParameters = copyBrowserParameters(snapshot);
    return persist();
  };

  const confirmCurrentRequest = (): boolean => {
    if (isDisposed) return false;
    if (runtimeName(engine) !== runtime) {
      state.appliedBank = null;
      return false;
    }
    if (state.busy || !documentRef.value || state.requestedBank === null) return false;
    const bank = state.requestedBank;
    if (pendingCandidate?.bank === bank) {
      const candidate = pendingCandidate;
      if (slotsSignature(getLiveSlots()) !== slotsSignature(candidate.slots) ||
          !slotsMatchRuntime(candidate.slots, undefined, false)) {
        markAppliedStateUnknown(bank);
        return false;
      }
      if (!captureConfirmedProfile(bank, candidate.slots)) return false;
      pendingCandidate = null;
      state.appliedBank = bank;
      state.error = '';
      return true;
    }
    const document = documentRef.value;
    const profile = document.banks[bank];
    const live = getLiveSlots();
    if (slotsSignature(live) !== slotsSignature(profile.slots) || !slotsMatchRuntime(live, profile)) {
      markAppliedStateUnknown(bank);
      return false;
    }
    state.appliedBank = bank;
    state.error = '';
    if (runtime === 'browser' && !profile.browserParameters) {
      const snapshot = browserSnapshot();
      if (snapshot) {
        profile.browserParameters = copyBrowserParameters(snapshot);
        persist();
      }
    }
    return true;
  };

  const refreshTimer = window.setInterval(() => {
    if (isDisposed) return;
    refreshUnavailableReason();
    confirmCurrentRequest();
  }, RECONCILE_INTERVAL_MS);
  const unsubscribe = engine.onStatusChange(() => {
    if (!isDisposed) confirmCurrentRequest();
  });

  const waitForReconcile = () => new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelPendingWait = null;
      resolve();
    };
    const timer = window.setTimeout(finish, RECONCILE_INTERVAL_MS);
    cancelPendingWait = () => {
      window.clearTimeout(timer);
      finish();
    };
  });

  watch(
    () => slotsSignature(panel.slots.value),
    () => {
      if (replacingRows || !documentRef.value || state.requestedBank === null) return;
      const rows = getLiveSlots();
      if (state.busy) {
        changedDuringApply = true;
        state.appliedBank = null;
        return;
      }
      const bank = state.appliedBank ?? (pendingCandidate?.bank === state.requestedBank ? pendingCandidate.bank : null);
      if (bank !== null && bank === state.requestedBank) {
        pendingCandidate = { bank, slots: rows };
        state.appliedBank = null;
      }
    },
    { flush: 'sync' },
  );

  const selectBank = async (id: FxPresetBankId): Promise<boolean> => {
    if (runtimeName(engine) !== runtime) {
      refreshUnavailableReason();
      return false;
    }
    if (!isFxPresetBankId(id) || !canSelect.value || !documentRef.value) return false;
    if (state.appliedBank === id && state.requestedBank === id) return true;

    const document = documentRef.value;
    if (state.appliedBank !== null && state.appliedBank === state.requestedBank && !pendingCandidate && !state.busy) {
      if (!captureConfirmedProfile(state.appliedBank, getLiveSlots())) return false;
    }

    const targetProfile = document.banks[id];
    document.activeBank = id;
    state.requestedBank = id;
    state.appliedBank = null;
    state.error = '';
    pendingCandidate = null;
    changedDuringApply = false;
    if (!persist()) return false;

    state.busy = true;
    replacingRows = true;
    for (let index = 0; index < 4; index += 1) {
      const current = panel.slots.value[index];
      const next = targetProfile.slots[index];
      if (current && next) panel.slots.value[index] = { ...cloneFxPresetSlots([next])[0]!, id: current.id };
    }
    try {
      await nextTick();
    } finally {
      replacingRows = false;
    }
    if (isDisposed) return false;
    // useFxPanelState normalizes some effect transitions during its own next-tick
    // watcher. Those normalized values are part of this apply, not user edits.
    const expectedRows = getLiveSlots();
    const profileIsUnchanged = slotsSignature(expectedRows) === slotsSignature(targetProfile.slots);
    const expectedProfile = profileIsUnchanged ? targetProfile : { slots: cloneFxPresetSlots(expectedRows) };
    const expectedSignature = slotsSignature(expectedRows);
    const deadline = Date.now() + APPLY_TIMEOUT_MS;
    let confirmed = false;
    do {
      if (isDisposed) return false;
      if (runtimeName(engine) !== runtime) break;
      if (changedDuringApply || currentSignature() !== expectedSignature) break;
      if (slotsMatchRuntime(expectedRows, expectedProfile)) {
        confirmed = true;
        break;
      }
      await waitForReconcile();
    } while (Date.now() < deadline);

    if (isDisposed) return false;

    if (changedDuringApply || currentSignature() !== expectedSignature) {
      state.error = 'FX rows changed during bank application; no bank was marked applied. Select the desired bank again to retry.';
      confirmed = false;
    }
    if (confirmed) {
      const saved = captureConfirmedProfile(id, expectedRows);
      state.appliedBank = id;
      state.busy = false;
      if (!saved) return false;
      state.error = '';
      return true;
    }

    state.appliedBank = null;
    state.busy = false;
    if (!state.error) state.error = 'The runtime did not confirm all four FX slots within 5 seconds; the live state was left as-is.';
    return false;
  };

  onScopeDispose(() => {
    isDisposed = true;
    cancelPendingWait?.();
    window.clearInterval(refreshTimer);
    unsubscribe();
  });

  return {
    state: readonly(state),
    canSelect,
    selectBank,
  };
}
