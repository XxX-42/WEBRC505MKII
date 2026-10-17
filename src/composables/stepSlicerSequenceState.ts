export type StepSlicerBank = 'input' | 'track';

export const STEP_SLICER_SEQUENCE_STORAGE_KEY = 'webrc505_step_slicer_sequences';
export const DEFAULT_STEP_SLICER_SEQUENCE = Object.freeze(Array.from({ length: 16 }, () => 100));
export const STEP_SLICER_STEP_COUNTS = [4, 8, 16] as const;
export const STEP_SLICER_RATE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

export interface StepSlicerSettings {
  steps: number[];
  stepCount: (typeof STEP_SLICER_STEP_COUNTS)[number];
  rateBeats: (typeof STEP_SLICER_RATE_OPTIONS)[number];
  panDepthPercent: number;
  filterHz: number;
}

export const DEFAULT_STEP_SLICER_SETTINGS: Readonly<StepSlicerSettings> = Object.freeze({
  steps: [...DEFAULT_STEP_SLICER_SEQUENCE],
  stepCount: 16,
  rateBeats: 0.25,
  panDepthPercent: 0,
  filterHz: 20000,
});

type SequenceMap = Record<string, unknown>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function parseStoredSequences(storage: StorageLike): SequenceMap {
  try {
    const value = storage.getItem(STEP_SLICER_SEQUENCE_STORAGE_KEY);
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SequenceMap : {};
  } catch {
    return {};
  }
}

function sanitizeSequence(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 16) return null;
  return value.map((item) => Number.isFinite(item) ? Math.max(0, Math.min(100, Math.round(item as number))) : 100);
}

function nearestOption<T extends number>(value: number, options: readonly T[]): T {
  return options.reduce((best, candidate) => Math.abs(value - candidate) < Math.abs(value - best) ? candidate : best, options[0]!);
}

function normalizeSettings(value: unknown): StepSlicerSettings {
  const stored = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<StepSlicerSettings>
    : null;
  // Older revisions stored the amplitude sequence directly as an array.
  const legacySteps = Array.isArray(value) ? value : stored?.steps;
  const stepCount = Number.isFinite(stored?.stepCount)
    ? nearestOption(stored!.stepCount as number, STEP_SLICER_STEP_COUNTS)
    : DEFAULT_STEP_SLICER_SETTINGS.stepCount;
  const rateBeats = Number.isFinite(stored?.rateBeats)
    ? nearestOption(stored!.rateBeats as number, STEP_SLICER_RATE_OPTIONS)
    : DEFAULT_STEP_SLICER_SETTINGS.rateBeats;

  return {
    steps: sanitizeSequence(legacySteps) ?? [...DEFAULT_STEP_SLICER_SEQUENCE],
    stepCount,
    rateBeats,
    panDepthPercent: Number.isFinite(stored?.panDepthPercent)
      ? Math.max(0, Math.min(100, Math.round(stored!.panDepthPercent as number)))
      : DEFAULT_STEP_SLICER_SETTINGS.panDepthPercent,
    filterHz: Number.isFinite(stored?.filterHz)
      ? Math.max(20, Math.min(20000, Math.round(stored!.filterHz as number)))
      : DEFAULT_STEP_SLICER_SETTINGS.filterHz,
  };
}

export function loadStepSlicerSettings(
  bank: StepSlicerBank,
  slotId: string,
  storage: StorageLike = window.localStorage,
): StepSlicerSettings {
  return normalizeSettings(parseStoredSequences(storage)[`${bank}:${slotId}`]);
}

export function saveStepSlicerSettings(
  bank: StepSlicerBank,
  slotId: string,
  settings: StepSlicerSettings,
  storage: StorageLike = window.localStorage,
): StepSlicerSettings {
  const normalized = normalizeSettings(settings);
  const store = parseStoredSequences(storage);
  store[`${bank}:${slotId}`] = normalized;
  try {
    storage.setItem(STEP_SLICER_SEQUENCE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Settings remain usable for the current session if storage is full or unavailable.
  }
  return normalized;
}

export function loadStepSlicerSequence(
  bank: StepSlicerBank,
  slotId: string,
  storage: StorageLike = window.localStorage,
): number[] {
  return loadStepSlicerSettings(bank, slotId, storage).steps;
}

export function saveStepSlicerSequence(
  bank: StepSlicerBank,
  slotId: string,
  values: readonly number[],
  storage: StorageLike = window.localStorage,
): number[] {
  const current = loadStepSlicerSettings(bank, slotId, storage);
  return saveStepSlicerSettings(bank, slotId, { ...current, steps: [...values] }, storage).steps;
}
