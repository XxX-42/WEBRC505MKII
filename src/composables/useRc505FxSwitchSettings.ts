import { reactive, readonly } from 'vue';
import { defaultRc505FxSwitchSettings, type Rc505FxSwitchSettings } from '../ui/rc505/Rc505FxSwitchController';
import type { FxLocation } from './usePanelFocus';

const settings = new Map<string, ReturnType<typeof create>>();
const activeBanks = reactive<Record<string, string>>({});
export function selectRc505FxSwitchBank(runtime: 'browser' | 'native', location: FxLocation, bank: string): void {
  activeBanks[`${runtime}_${location}`] = bank;
}
function create(key: string) {
  const state = reactive({ settings: defaultRc505FxSwitchSettings(), error: '' });
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
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, settings: next }));
      state.settings = structuredClone(next);
      return true;
    } catch { state.error = 'FX switch settings could not be saved; the confirmed configuration was retained.'; return false; }
  };
  return { state: readonly(state), update };
}

export function useRc505FxSwitchSettings(runtime: 'browser' | 'native', location: FxLocation, bank?: string) {
  const key = `webrc505_fx_switch_v1_${runtime}_${location}_${bank ?? activeBanks[`${runtime}_${location}`] ?? 'A'}`;
  let result = settings.get(key);
  if (!result) { result = create(key); settings.set(key, result); }
  return result;
}
