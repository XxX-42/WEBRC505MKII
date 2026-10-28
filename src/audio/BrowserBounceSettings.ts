/** Browser implementation of the RC-505mkII Memory Bounce controls. */
export interface BrowserBounceSettings {
  /** REC page BOUNCE SW. */
  bounceSw: boolean;
  /** Per-destination LOOP/TRACK BOUNCE IN. */
  bounceIn: boolean[];
  /** Per-source REC/BOUNCE TRACK enable. */
  bounceTrack: boolean[];
}

export const DEFAULT_BROWSER_BOUNCE: Readonly<BrowserBounceSettings> = Object.freeze({
  bounceSw: false,
  bounceIn: Object.freeze([false, false, false, false, false]) as unknown as boolean[],
  bounceTrack: Object.freeze([false, false, false, false, false]) as unknown as boolean[],
});

export function normalizeBrowserBounceSettings(value?: Partial<BrowserBounceSettings> | null): BrowserBounceSettings {
  const normalized: BrowserBounceSettings = {
    bounceSw: value?.bounceSw ?? false,
    bounceIn: value?.bounceIn ? [...value.bounceIn] : [false, false, false, false, false],
    bounceTrack: value?.bounceTrack ? [...value.bounceTrack] : [false, false, false, false, false],
  };
  assertBrowserBounceSettings(normalized);
  return normalized;
}

export function assertBrowserBounceSettings(value: unknown): asserts value is BrowserBounceSettings {
  const item = value as BrowserBounceSettings | null;
  if (!item || typeof item.bounceSw !== 'boolean'
    || !Array.isArray(item.bounceIn) || item.bounceIn.length !== 5 || item.bounceIn.some((v) => typeof v !== 'boolean')
    || !Array.isArray(item.bounceTrack) || item.bounceTrack.length !== 5 || item.bounceTrack.some((v) => typeof v !== 'boolean')) {
    throw new Error('Browser Bounce requires BOUNCE SW and five BOUNCE IN / BOUNCE TRACK booleans.');
  }
}

/** A per-session snapshot. The destination bit is always removed defensively. */
export function browserBounceSourceMask(settings: BrowserBounceSettings, destinationTrackIndex: number): number {
  assertBrowserBounceSettings(settings);
  if (!Number.isInteger(destinationTrackIndex) || destinationTrackIndex < 0 || destinationTrackIndex >= 5) {
    throw new RangeError('Bounce destination must be one of the five Browser tracks.');
  }
  if (!settings.bounceSw || !settings.bounceIn[destinationTrackIndex]) return 0;
  let mask = 0;
  for (let source = 0; source < 5; source += 1) {
    if (source !== destinationTrackIndex && settings.bounceTrack[source]) mask |= 1 << source;
  }
  return mask;
}
