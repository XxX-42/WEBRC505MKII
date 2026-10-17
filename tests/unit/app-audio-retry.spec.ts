import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

describe('App audio startup', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => {
    wrapper?.unmount(); wrapper = null;
    vi.resetModules(); vi.doUnmock('../../src/audio/AudioEngine'); vi.clearAllMocks();
  });

  async function setup(mode = 'browser') {
    const status = { mode, bridgeAvailable: mode === 'browser', engineRunning: false, ready: false,
      message: mode.toUpperCase() + ' AUDIO NOT INITIALIZED', lastError: '', inputReady: false, inputError: '' };
    let listener: ((value: typeof status) => void) | undefined;
    const engine = {
      getMode: () => mode, getUiStatus: () => ({ ...status }),
      getCapabilities: () => ({ modeSummary: 'TEST AUDIO CAPABILITIES' }),
      onStatusChange: (callback: typeof listener) => { listener = callback; return () => undefined; },
      init: vi.fn(async () => { status.ready = true; status.engineRunning = true; status.message = mode.toUpperCase() + ' AUDIO READY'; listener?.({ ...status }); }),
      prepareInputFromUserActivation: vi.fn(async () => { status.inputReady = true; listener?.({ ...status }); }),
      resumeFromUserActivation: vi.fn(async () => undefined), hasUnsavedLoops: vi.fn(() => false),
      restartNativeAudio: vi.fn(async () => undefined),
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine, setPreferredMode: vi.fn() } }));
    const App = (await import('../../src/App.vue')).default;
    wrapper = mount(App, { global: { stubs: { Teleport: true, WebToolLayer: true, ClassicShell: true, TechShell: true } } });
    await flushPromises();
    return { engine, status, emitStatus: () => listener?.({ ...status }) };
  }

  it('waits for a user gesture before Browser initialization and connects its input', async () => {
    const { engine } = await setup();
    expect(engine.init).not.toHaveBeenCalled();
    expect(wrapper!.get('[data-testid="start-audio"]').text()).toBe('START AUDIO');
    await wrapper!.get('[data-testid="start-audio"]').trigger('click');
    await flushPromises();
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(engine.prepareInputFromUserActivation).toHaveBeenCalledTimes(1);
    expect(wrapper!.get('[data-testid="start-audio"]').attributes('disabled')).toBeDefined();
    expect(wrapper!.get('[data-testid="input-status"]').text()).toContain('INPUT READY');
  }, 15000);

  it('resumes a pending initialization without starting a second initialization', async () => {
    const { engine } = await setup();
    let resolveInit!: () => void;
    engine.init.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveInit = resolve; }));
    const button = wrapper!.get('[data-testid="start-audio"]');
    await button.trigger('click'); await button.trigger('click');
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(engine.resumeFromUserActivation).toHaveBeenCalledTimes(1);
    resolveInit(); await flushPromises();
    expect(engine.prepareInputFromUserActivation).toHaveBeenCalledTimes(1);
  });

  it('keeps output ready after input failure and allows a separate input retry', async () => {
    const { engine } = await setup();
    engine.prepareInputFromUserActivation.mockRejectedValueOnce(new Error('Microphone permission denied'));
    await wrapper!.get('[data-testid="start-audio"]').trigger('click'); await flushPromises();
    expect(wrapper!.get('[role="alert"]').text()).toContain('Microphone permission denied');
    expect(wrapper!.get('[data-testid="input-status"]').text()).toContain('OUTPUT READY');
    expect(wrapper!.get('[data-testid="start-audio"]').text()).toBe('CONNECT INPUT');
    await wrapper!.get('[data-testid="start-audio"]').trigger('click'); await flushPromises();
    expect(engine.prepareInputFromUserActivation).toHaveBeenCalledTimes(2);
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
  });

  it('initializes Native without requesting browser microphone access', async () => {
    const { engine } = await setup('native');
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(engine.prepareInputFromUserActivation).not.toHaveBeenCalled();
  });

  it('cancels a Native restart without touching the current loops', async () => {
    const { engine } = await setup('native');
    engine.hasUnsavedLoops.mockReturnValue(true);
    window.dispatchEvent(new Event('rc505-restart-native-audio'));
    await flushPromises();
    expect(wrapper!.get('[role="alertdialog"]').text()).toContain('Loops are retained');
    await wrapper!.get('[role="alertdialog"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper!.find('[role="alertdialog"]').exists()).toBe(false);
    expect(engine.restartNativeAudio).not.toHaveBeenCalled();
  });

  it('restarts Native only after the visible confirmation is accepted', async () => {
    const { engine } = await setup('native');
    engine.hasUnsavedLoops.mockReturnValue(true);
    window.dispatchEvent(new Event('rc505-restart-native-audio'));
    await flushPromises();
    expect(engine.restartNativeAudio).not.toHaveBeenCalled();
    await wrapper!.get('[role="alertdialog"] button:last-child').trigger('click');
    await flushPromises();
    expect(engine.restartNativeAudio).toHaveBeenCalledTimes(1);
    expect(wrapper!.find('[role="alertdialog"]').exists()).toBe(false);
  });

  it('retains a failed Native restart alert across clean status polls until retry succeeds', async () => {
    const { engine, emitStatus } = await setup('native');
    engine.restartNativeAudio.mockRejectedValueOnce(new Error('Native stop deadline exceeded'));
    window.dispatchEvent(new Event('rc505-restart-native-audio'));
    await flushPromises();
    emitStatus(); await flushPromises();
    expect(wrapper!.get('[role="alert"]').text()).toContain('Native stop deadline exceeded');
    window.dispatchEvent(new Event('rc505-restart-native-audio'));
    await flushPromises();
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
    expect(engine.restartNativeAudio).toHaveBeenCalledTimes(2);
  });
});
