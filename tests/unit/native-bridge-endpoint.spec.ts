import { describe, expect, it } from 'vitest';
import { nativeBridgeEndpoint } from '../../src/audio/nativeBridgeEndpoint';

describe('Native bridge endpoint isolation', () => {
  it('isolates only the explicit E2E mode from the production bridge', () => {
    expect(nativeBridgeEndpoint('e2e')).toBe('http://127.0.0.1:18755');
    for (const mode of ['production', 'development', 'test', '']) {
      expect(nativeBridgeEndpoint(mode)).toBe('http://127.0.0.1:17755');
    }
  });
});
