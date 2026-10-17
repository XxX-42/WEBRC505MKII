export const STEP_SLICER_COUNT_OPTIONS = [4, 8, 16] as const;
export const STEP_SLICER_RATE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

export interface NativeStepSlicerParameters {
  step_count: number;
  rate_beats: number;
  depth_percent: number;
  pan_depth_percent: number;
  filter_hz: number;
  step_01: number;
  step_02: number;
  step_03: number;
  step_04: number;
  step_05: number;
  step_06: number;
  step_07: number;
  step_08: number;
  step_09: number;
  step_10: number;
  step_11: number;
  step_12: number;
  step_13: number;
  step_14: number;
  step_15: number;
  step_16: number;
}

const STEP_KEYS = [
  'step_01', 'step_02', 'step_03', 'step_04', 'step_05', 'step_06', 'step_07', 'step_08',
  'step_09', 'step_10', 'step_11', 'step_12', 'step_13', 'step_14', 'step_15', 'step_16',
] as const satisfies readonly (keyof NativeStepSlicerParameters)[];

export function createDefaultNativeStepSlicerParameters(): NativeStepSlicerParameters {
  return {
    step_count: 16,
    rate_beats: 0.25,
    depth_percent: 100,
    pan_depth_percent: 0,
    filter_hz: 20000,
    step_01: 100, step_02: 100, step_03: 100, step_04: 100,
    step_05: 100, step_06: 100, step_07: 100, step_08: 100,
    step_09: 100, step_10: 100, step_11: 100, step_12: 100,
    step_13: 100, step_14: 100, step_15: 100, step_16: 100,
  };
}

function finiteNumber(source: Record<string, unknown>, key: string, fallback: number) {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Sanitize both saved browser data and bridge-facing Native parameter updates. */
export function sanitizeNativeStepSlicerParameters(raw: unknown): NativeStepSlicerParameters {
  const defaults = createDefaultNativeStepSlicerParameters();
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const stepCount = finiteNumber(source, 'step_count', defaults.step_count);
  const rateBeats = finiteNumber(source, 'rate_beats', defaults.rate_beats);
  const result: NativeStepSlicerParameters = {
    ...defaults,
    step_count: STEP_SLICER_COUNT_OPTIONS.includes(stepCount as 4 | 8 | 16) ? stepCount : defaults.step_count,
    rate_beats: STEP_SLICER_RATE_OPTIONS.includes(rateBeats as 0.25 | 0.5 | 1 | 2 | 4) ? rateBeats : defaults.rate_beats,
    depth_percent: Math.max(0, Math.min(100, finiteNumber(source, 'depth_percent', defaults.depth_percent))),
    pan_depth_percent: Math.max(0, Math.min(100, finiteNumber(source, 'pan_depth_percent', defaults.pan_depth_percent))),
    filter_hz: Math.max(20, Math.min(20000, finiteNumber(source, 'filter_hz', defaults.filter_hz))),
    step_01: defaults.step_01, step_02: defaults.step_02, step_03: defaults.step_03, step_04: defaults.step_04,
    step_05: defaults.step_05, step_06: defaults.step_06, step_07: defaults.step_07, step_08: defaults.step_08,
    step_09: defaults.step_09, step_10: defaults.step_10, step_11: defaults.step_11, step_12: defaults.step_12,
    step_13: defaults.step_13, step_14: defaults.step_14, step_15: defaults.step_15, step_16: defaults.step_16,
  };
  for (let index = 0; index < 16; index += 1) {
    const key = STEP_KEYS[index]!;
    const bounded = Math.max(0, Math.min(100, finiteNumber(source, key, defaults[key] as number)));
    (result as unknown as Record<string, number>)[key] = bounded;
  }
  return result;
}
