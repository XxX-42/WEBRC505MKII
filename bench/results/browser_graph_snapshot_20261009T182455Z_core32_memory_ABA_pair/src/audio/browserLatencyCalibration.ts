const STORAGE_KEY = 'webrc505_browser_rtl_calibration_v1';

export interface BrowserLatencyCalibrationScope {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  contextSampleRate: number;
  inputSampleRate: number | null;
  inputChannelCount: number | null;
}

export interface BrowserLatencyCalibration extends BrowserLatencyCalibrationScope {
  roundTripLatencyMs: number;
  calibratedAt: string;
}

interface StoredCalibrationSet {
  calibrations: BrowserLatencyCalibration[];
}

export function getBrowserLatencyCalibration(scope: BrowserLatencyCalibrationScope): BrowserLatencyCalibration | null {
  const key = buildKey(scope);
  const match = readCalibrations().find((calibration) => buildKey(calibration) === key);
  return match ? { ...match } : null;
}

export function setBrowserLatencyCalibration(
  scope: BrowserLatencyCalibrationScope,
  roundTripLatencyMs: number,
  calibratedAt = new Date().toISOString(),
): BrowserLatencyCalibration | null {
  if (!Number.isFinite(roundTripLatencyMs) || roundTripLatencyMs < 0) {
    return null;
  }

  const calibration: BrowserLatencyCalibration = {
    ...scope,
    roundTripLatencyMs,
    calibratedAt,
  };
  const key = buildKey(scope);
  const calibrations = readCalibrations().filter((candidate) => buildKey(candidate) !== key);
  calibrations.push(calibration);
  writeCalibrations({ calibrations });
  return { ...calibration };
}

export function clearBrowserLatencyCalibration(scope: BrowserLatencyCalibrationScope): void {
  const key = buildKey(scope);
  writeCalibrations({
    calibrations: readCalibrations().filter((candidate) => buildKey(candidate) !== key),
  });
}

function buildKey(scope: BrowserLatencyCalibrationScope): string {
  return [
    scope.inputDeviceId || 'default-input',
    scope.outputDeviceId || 'default-output',
    scope.contextSampleRate,
    scope.inputSampleRate ?? 'unknown-input-rate',
    scope.inputChannelCount ?? 'unknown-input-channels',
  ].join('::');
}

function readCalibrations(): BrowserLatencyCalibration[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as StoredCalibrationSet;
    if (!parsed || !Array.isArray(parsed.calibrations)) {
      return [];
    }
    return parsed.calibrations.filter((candidate) =>
      candidate &&
      typeof candidate.calibratedAt === 'string' &&
      Number.isFinite(candidate.roundTripLatencyMs) &&
      candidate.roundTripLatencyMs >= 0 &&
      Number.isFinite(candidate.contextSampleRate),
    );
  } catch {
    return [];
  }
}

function writeCalibrations(state: StoredCalibrationSet): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}
