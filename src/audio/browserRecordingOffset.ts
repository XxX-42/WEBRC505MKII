const STORAGE_KEY = 'webrc505_browser_recording_offset_v1';
const MAX_OFFSET_MS = 250;

export interface BrowserRecordingOffsetScope {
  inputDeviceId?: string | null;
  outputDeviceId?: string | null;
  sampleRate?: number | null;
  bufferFrames?: number | null;
}

interface StoredRecordingOffsetEntry {
  key: string;
  recordingOffsetMs: number;
}

interface StoredRecordingOffsetState {
  entries: StoredRecordingOffsetEntry[];
}

export interface BrowserRecordingOffsetConfig {
  key: string;
  recordingOffsetMs: number;
  recordingOffsetSamples: number;
}

export function msToSamples(ms: number, sampleRate: number): number {
  if (!Number.isFinite(ms) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }
  return Math.round((ms / 1000) * sampleRate);
}

export function samplesToMs(samples: number, sampleRate: number): number {
  if (!Number.isFinite(samples) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }
  return (samples / sampleRate) * 1000;
}

export function applyRecordingOffset(writeIndex: number, offsetSamples: number, loopLengthSamples: number): number {
  if (!Number.isFinite(writeIndex) || !Number.isFinite(offsetSamples) || loopLengthSamples <= 0) {
    return 0;
  }

  let wrapped = (writeIndex - offsetSamples) % loopLengthSamples;
  if (wrapped < 0) {
    wrapped += loopLengthSamples;
  }
  return wrapped;
}

export function shiftBufferWithRecordingOffset(source: Float32Array, offsetSamples: number): Float32Array {
  const length = source.length;
  if (length === 0 || offsetSamples === 0) {
    return source.slice();
  }

  const shifted = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const destinationIndex = applyRecordingOffset(index, offsetSamples, length);
    shifted[destinationIndex] = source[index] ?? 0;
  }
  return shifted;
}

export function getBrowserRecordingOffsetConfig(
  sampleRate: number,
  scope: BrowserRecordingOffsetScope = {},
): BrowserRecordingOffsetConfig {
  const key = buildScopeKey(scope);
  const state = readStoredState();
  const match = state.entries.find((entry) => entry.key === key);
  const recordingOffsetMs = clampOffsetMs(match?.recordingOffsetMs ?? 0);

  return {
    key,
    recordingOffsetMs,
    recordingOffsetSamples: msToSamples(recordingOffsetMs, sampleRate),
  };
}

export function setBrowserRecordingOffsetConfig(
  recordingOffsetMs: number,
  scope: BrowserRecordingOffsetScope = {},
): BrowserRecordingOffsetConfig {
  const key = buildScopeKey(scope);
  const nextMs = clampOffsetMs(recordingOffsetMs);
  const state = readStoredState();
  const withoutCurrent = state.entries.filter((entry) => entry.key !== key);
  withoutCurrent.push({ key, recordingOffsetMs: nextMs });
  writeStoredState({ entries: withoutCurrent });

  return {
    key,
    recordingOffsetMs: nextMs,
    recordingOffsetSamples: msToSamples(nextMs, scope.sampleRate ?? 0),
  };
}

export function resetBrowserRecordingOffsetConfig(scope: BrowserRecordingOffsetScope = {}): void {
  const key = buildScopeKey(scope);
  const state = readStoredState();
  writeStoredState({
    entries: state.entries.filter((entry) => entry.key !== key),
  });
}

function buildScopeKey(scope: BrowserRecordingOffsetScope): string {
  const parts = [
    scope.inputDeviceId || 'global-input',
    scope.outputDeviceId || 'global-output',
    Number.isFinite(scope.sampleRate ?? NaN) ? String(scope.sampleRate) : 'global-rate',
    Number.isFinite(scope.bufferFrames ?? NaN) ? String(scope.bufferFrames) : 'global-buffer',
  ];
  return parts.join('::');
}

function clampOffsetMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(value * 1000) / 1000));
}

function readStoredState(): StoredRecordingOffsetState {
  if (typeof window === 'undefined') {
    return { entries: [] };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { entries: [] };
    }

    const parsed = JSON.parse(raw) as StoredRecordingOffsetState;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { entries: [] };
    }

    return {
      entries: parsed.entries
        .filter((entry) => entry && typeof entry.key === 'string')
        .map((entry) => ({
          key: entry.key,
          recordingOffsetMs: clampOffsetMs(entry.recordingOffsetMs),
        })),
    };
  } catch {
    return { entries: [] };
  }
}

function writeStoredState(state: StoredRecordingOffsetState): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}
