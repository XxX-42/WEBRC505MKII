import { describe, expect, it } from 'vitest';
import { browserBounceSourceMask, normalizeBrowserBounceSettings } from '../../src/audio/BrowserBounceSettings';

describe('Browser Bounce settings', () => {
  it('requires the master and destination switch and independently selects source tracks', () => {
    const settings = normalizeBrowserBounceSettings({ bounceSw: true,
      bounceIn: [true, false, true, true, true], bounceTrack: [true, true, false, true, false] });
    expect(browserBounceSourceMask(settings, 0)).toBe(10);
    expect(browserBounceSourceMask(settings, 1)).toBe(0);
    expect(browserBounceSourceMask(settings, 2)).toBe(11);
    expect(browserBounceSourceMask({ ...settings, bounceSw: false }, 0)).toBe(0);
    expect(browserBounceSourceMask({ ...settings, bounceIn: [false, false, false, false, false] }, 0)).toBe(0);
  });

  it('defaults legacy settings off and rejects malformed five-track controls', () => {
    expect(normalizeBrowserBounceSettings()).toEqual({ bounceSw: false,
      bounceIn: [false, false, false, false, false], bounceTrack: [false, false, false, false, false] });
    expect(() => normalizeBrowserBounceSettings({ bounceSw: true, bounceIn: [true], bounceTrack: [] })).toThrow(/five/);
    expect(() => browserBounceSourceMask(normalizeBrowserBounceSettings(), 5)).toThrow(/five Browser tracks/);
  });
});
