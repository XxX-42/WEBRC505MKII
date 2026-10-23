import { reactive, readonly } from 'vue';
import { defaultRc505FxSwitchSettings, type Rc505FxSwitchSettings } from '../ui/rc505/Rc505FxSwitchController';
import type { FxLocation } from './usePanelFocus';
import { registerRc505MemorySwitchUiPort, type Rc505MemorySwitchSnapshot } from './wrapRc505MemoryUiRuntime';

const settings = new Map<string, ReturnType<typeof create>>();
const activeBanks = reactive<Record<string, string>>({});
const editEpochs = { browser: 0n, native: 0n };
export function selectRc505FxSwitchBank(runtime: 'browser' | 'native', location: FxLocation, bank: string): void {
  if (!['A', 'B', 'C', 'D'].includes(bank)) return;
  if (activeBanks[`${runtime}_${location}`] !== bank) editEpochs[runtime] += 1n;
  activeBanks[`${runtime}_${location}`] = bank;
}
function create(key: string) {
  const state = reactive({ settings: defaultRc505FxSwitchSettings(), error: '', adoptionRevision: 0 });
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const saved = JSON.parse(raw) as { version?: number; settings?: Rc505FxSwitchSettings };
      const value = saved.settings;
      if (saved.version !== 1 || !value || !['SINGLE', 'MULTI'].includes(value.mode)
        || !['A', 'B', 'C', 'D'].every((id) => ['TOGGLE', 'MOMENT'].includes(value.switchModes?.[id as 'A']))) {
        throw new Error('Invalid FX switch settings');
      }
      state.settings = structuredClone(value);
    }
  } catch { state.error = 'FX switch settings cannot be read; restore storage before changing switch behavior.'; }
  const update = (next: Rc505FxSwitchSettings): boolean => {
    if (state.error) return false;
    if (!next || !['SINGLE', 'MULTI'].includes(next.mode) || Object.keys(next).sort().join(',') !== 'mode,switchModes'
      || !next.switchModes || Object.keys(next.switchModes).sort().join(',') !== 'A,B,C,D'
      || !['A', 'B', 'C', 'D'].every((id) => ['TOGGLE', 'MOMENT'].includes(next.switchModes[id as 'A']))) return false;
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, settings: next }));
      state.settings = structuredClone(next);
      editEpochs[key.includes('_native_') ? 'native' : 'browser'] += 1n;
      return true;
    } catch { state.error = 'FX switch settings could not be saved; the confirmed configuration was retained.'; return false; }
  };
  return { state: readonly(state), update, adopt: (next: Rc505FxSwitchSettings, error = '') => {
    state.settings = structuredClone(next); state.error = error; state.adoptionRevision += 1;
  } };
}

export function useRc505FxSwitchSettings(runtime: 'browser' | 'native', location: FxLocation, bank?: string) {
  const key = `webrc505_fx_switch_v1_${runtime}_${location}_${bank ?? activeBanks[`${runtime}_${location}`] ?? 'A'}`;
  let result = settings.get(key);
  if (!result) { result = create(key); settings.set(key, result); }
  return result;
}

for (const runtime of ['browser', 'native'] as const) registerRc505MemorySwitchUiPort(runtime, {
  revision: () => editEpochs[runtime].toString(),
  capture: () => {
    const snapshot = {} as Rc505MemorySwitchSnapshot;
    for (const location of ['input', 'track'] as const) {
      snapshot[location] = {} as Rc505MemorySwitchSnapshot['input'];
      for (const bank of ['A', 'B', 'C', 'D'] as const) {
        const value = useRc505FxSwitchSettings(runtime, location, bank);
        if (value.state.error) throw new Error(value.state.error);
        snapshot[location][bank] = JSON.parse(JSON.stringify(value.state.settings)) as Rc505FxSwitchSettings;
      }
    }
    return snapshot;
  },
  adopt: (snapshot, banks, storageError = '') => {
    for (const location of ['input', 'track'] as const) {
      for (const bank of ['A', 'B', 'C', 'D'] as const) useRc505FxSwitchSettings(runtime, location, bank).adopt(snapshot[location][bank], storageError);
      if (banks[location]) activeBanks[`${runtime}_${location}`] = banks[location]!;
      else delete activeBanks[`${runtime}_${location}`];
    }
    editEpochs[runtime] += 1n;
  },
});
