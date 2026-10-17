import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../src/audio/AudioEngine';
import { useMonitoringControls } from '../../src/composables/useMonitoringControls';

function createEngine(options: { ready?: boolean; fail?: boolean } = {}) {
  let monitoringEnabled = false;
  let monitoringListener: ((enabled: boolean) => void) | null = null;
  let statusListener: ((status: { ready: boolean; mode: 'browser'; message: string }) => void) | null = null;
  const status = { ready: options.ready ?? true, mode: 'browser' as const, message: options.ready === false ? 'AUDIO ENGINE STARTING' : 'AUDIO ENGINE READY' };
  const engine = {
    get monitoringEnabled() { return monitoringEnabled; },
    getUiStatus: vi.fn(() => status),
    onMonitoringChange: vi.fn((listener: (enabled: boolean) => void) => {
      monitoringListener = listener;
      listener(monitoringEnabled);
      return vi.fn();
    }),
    onStatusChange: vi.fn((listener: (next: typeof status) => void) => {
      statusListener = listener;
      listener(status);
      return vi.fn();
    }),
    setMonitoring: vi.fn(async (enabled: boolean) => {
      if (options.fail) throw new Error('Native monitoring request failed');
      monitoringEnabled = enabled;
      monitoringListener?.(enabled);
    }),
    setReady(ready: boolean) {
      status.ready = ready;
      statusListener?.(status);
    },
  };
  return engine;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMonitoringControls', () => {
  it('shares one state and awaits the engine before showing THRU enabled', async () => {
    const engine = createEngine();
    const controls = useMonitoringControls(engine as unknown as AudioEngine);
    const controlsFromSecondView = useMonitoringControls(engine as unknown as AudioEngine);

    expect(controlsFromSecondView).toBe(controls);
    expect(await controls.toggle()).toBe(true);
    expect(engine.setMonitoring).toHaveBeenCalledWith(true);
    expect(controls.active.value).toBe(true);
    expect(controls.pending.value).toBe(false);
  });

  it('keeps the acknowledged state and exposes Native failures', async () => {
    const engine = createEngine({ fail: true });
    const controls = useMonitoringControls(engine as unknown as AudioEngine);

    expect(await controls.toggle()).toBe(false);
    expect(controls.active.value).toBe(false);
    expect(controls.error.value).toBe('Native monitoring request failed');
  });

  it('does not send a request until the selected audio engine is ready', async () => {
    const engine = createEngine({ ready: false });
    const controls = useMonitoringControls(engine as unknown as AudioEngine);

    expect(controls.disabled.value).toBe(true);
    expect(controls.unavailableReason.value).toBe('AUDIO ENGINE STARTING');
    expect(await controls.toggle()).toBe(false);
    expect(engine.setMonitoring).not.toHaveBeenCalled();

    engine.setReady(true);
    expect(controls.disabled.value).toBe(false);
  });
});
