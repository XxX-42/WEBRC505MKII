/** Official SENS range; threshold mapping is an engineering approximation, not hardware calibration. */
export interface BrowserAutoRecSettings { enabled: boolean; sensitivity: number }
export const DEFAULT_BROWSER_AUTO_REC: Readonly<BrowserAutoRecSettings> = Object.freeze({ enabled: false, sensitivity: 50 });
export const BROWSER_AUTO_REC_APPROXIMATION = 'Raw-input sample peak threshold, -12 to -60 dBFS across SENS 1..100; no added pre-roll. Engineering approximation; official mapping/window is unpublished.';
export function assertBrowserAutoRecSettings(value: unknown): asserts value is BrowserAutoRecSettings {
  const item = value as BrowserAutoRecSettings | null;
  if (!item || typeof item.enabled !== 'boolean' || !Number.isInteger(item.sensitivity) || item.sensitivity < 1 || item.sensitivity > 100) throw new Error('AutoRec requires enabled:boolean and integer sensitivity 1..100.');
}
export function browserAutoRecThreshold(sensitivity: number): number {
  assertBrowserAutoRecSettings({ enabled: true, sensitivity });
  return 10 ** ((-12 - (sensitivity - 1) * 48 / 99) / 20);
}
