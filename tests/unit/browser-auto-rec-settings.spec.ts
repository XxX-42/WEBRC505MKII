import { describe, expect, it } from 'vitest';
import { assertBrowserAutoRecSettings, browserAutoRecThreshold, DEFAULT_BROWSER_AUTO_REC } from '../../src/audio/BrowserAutoRecSettings';
describe('Browser AutoRec approximation settings', () => {
  it('defaults disabled at official SENS 50 and uses a monotonic engineering threshold', () => {
    expect(DEFAULT_BROWSER_AUTO_REC).toEqual({ enabled: false, sensitivity: 50 });
    expect(browserAutoRecThreshold(1)).toBeGreaterThan(browserAutoRecThreshold(50));
    expect(browserAutoRecThreshold(50)).toBeGreaterThan(browserAutoRecThreshold(100));
  });
  it('rejects malformed authored settings rather than silently clamping Memory', () => {
    for (const value of [{ enabled: true, sensitivity: 0 }, { enabled: true, sensitivity: 101 }, { enabled: true, sensitivity: 1.5 }, { enabled: 1, sensitivity: 50 }]) expect(() => assertBrowserAutoRecSettings(value)).toThrow();
  });
});
