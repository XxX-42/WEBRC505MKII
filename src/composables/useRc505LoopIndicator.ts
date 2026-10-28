import { readonly, ref } from 'vue';

export type Rc505LoopIndicatorMode = 'STATUS' | 'LOOP_POSITION' | 'LEVEL';

const STORAGE_KEY = 'webrc505_classic_loop_indicator_mode';
const MODES: readonly Rc505LoopIndicatorMode[] = ['STATUS', 'LOOP_POSITION', 'LEVEL'];

function readStoredMode(): Rc505LoopIndicatorMode {
  try {
    const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    return MODES.includes(saved as Rc505LoopIndicatorMode) ? saved as Rc505LoopIndicatorMode : 'STATUS';
  } catch {
    return 'STATUS';
  }
}

const mode = ref<Rc505LoopIndicatorMode>(readStoredMode());

function setMode(next: Rc505LoopIndicatorMode): void {
  if (!MODES.includes(next)) throw new TypeError('Unsupported RC-505 Loop Indicator mode.');
  mode.value = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Keep this display preference usable in private or storage-restricted contexts.
  }
}

export function useRc505LoopIndicator() {
  return { mode: readonly(mode), setMode };
}
