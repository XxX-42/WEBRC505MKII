import { afterEach, vi } from 'vitest';
import { createMockAudioContext, MockAudioWorkletNode } from '../helpers/audioTestUtils';

Object.defineProperty(globalThis, 'crossOriginIsolated', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'AudioWorkletNode', {
  configurable: true,
  writable: true,
  value: MockAudioWorkletNode,
});
Object.defineProperty(window, 'crossOriginIsolated', {
  configurable: true,
  value: true,
});
Object.defineProperty(window, 'AudioWorkletNode', {
  configurable: true,
  writable: true,
  value: MockAudioWorkletNode,
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

Object.defineProperty(window, 'confirm', {
  writable: true,
  value: vi.fn(() => true),
});

Object.defineProperty(window, 'requestAnimationFrame', {
  writable: true,
  value: vi.fn(() => 1),
});

Object.defineProperty(window, 'cancelAnimationFrame', {
  writable: true,
  value: vi.fn(),
});

class MockAudioContext {
  constructor(options: AudioContextOptions = {}) {
    return createMockAudioContext(options);
  }
}

Object.defineProperty(globalThis, 'AudioContext', {
  writable: true,
  value: MockAudioContext,
});

Object.defineProperty(window, 'AudioContext', {
  writable: true,
  value: MockAudioContext,
});

Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  writable: true,
  value: {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [],
      getAudioTracks: () => [],
    })),
    getSupportedConstraints: vi.fn(() => ({ latency: true, sampleRate: true, channelCount: true })),
    enumerateDevices: vi.fn(async () => []),
  },
});

afterEach(() => {
  vi.clearAllMocks();
});
