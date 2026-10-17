import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

describe('App audio retry', () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.resetModules();
    vi.doUnmock('../../src/audio/AudioEngine');
    vi.clearAllMocks();
  });

  it('resumes an in-flight Browser initialization from retry without starting another init', async () => {
    let resolveInit!: () => void;
    const status = {
      mode: 'browser',
      bridgeAvailable: true,
      engineRunning: false,
      ready: false,
      message: 'BROWSER AUDIO NOT INITIALIZED',
      lastError: '',
    };
    const engine = {
      getMode: () => 'browser',
      getUiStatus: () => status,
      getCapabilities: () => ({ modeSummary: 'BROWSER TEST STATUS' }),
      onStatusChange: () => () => undefined,
      init: vi.fn(() => new Promise<void>((resolve) => { resolveInit = resolve; })),
      resumeFromUserActivation: vi.fn(async () => undefined),
    };

    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: {
        getInstance: () => engine,
        setPreferredMode: vi.fn(),
      },
    }));

    const App = (await import('../../src/App.vue')).default;
    wrapper = mount(App, {
      global: {
        stubs: {
          WebToolLayer: true,
          ClassicShell: true,
          TechShell: true,
        },
      },
    });
    await flushPromises();

    expect(engine.init).toHaveBeenCalledTimes(1);
    await wrapper.get('button.status-action').trigger('click');
    expect(engine.resumeFromUserActivation).toHaveBeenCalledTimes(1);
    expect(engine.init).toHaveBeenCalledTimes(1);

    await wrapper.get('button.status-action').trigger('click');
    expect(engine.resumeFromUserActivation).toHaveBeenCalledTimes(2);
    expect(engine.init).toHaveBeenCalledTimes(1);

    status.engineRunning = true;
    status.ready = true;
    status.message = 'BROWSER AUDIO READY';
    resolveInit();
    await flushPromises();
    expect(wrapper.get('.status-label').text()).toBe('BROWSER AUDIO READY');
  });
});
