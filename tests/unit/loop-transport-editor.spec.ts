import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.doUnmock('../../src/audio/AudioEngine');
  localStorage.clear();
});

async function mountEditor(mode: 'browser' | 'native') {
  vi.resetModules();
  const engine = {
    getMode: () => mode,
    setBrowserLoopTransport: vi.fn(() => true),
    clearBrowserLoopTransportOverride: vi.fn(() => true),
    setNativeLoopTransport: vi.fn(async (_trackId: number, _config: unknown) => ({ ok: true, lastError: '' })),
  };
  vi.doMock('../../src/audio/AudioEngine', () => ({ AudioEngine: { getInstance: () => engine } }));
  const component = (await import('../../src/components/fx/LoopTransportEditor.vue')).default;
  wrapper = mount(component, { props: { trackId: 3, runtimeMode: mode } });
  await flushPromises();
  return { wrapper, engine };
}

describe('separate per-loop source transport editor', () => {
  it('applies BEAT SHIFT only to the selected Browser loop and keeps Vinyl controls separate', async () => {
    const { wrapper: editor, engine } = await mountEditor('browser');
    expect(editor.find('[data-loop-transport-editor]').exists()).toBe(true);
    expect(editor.text()).toContain('before its A–D inserts');
    expect(editor.text()).toContain('not an ordered A–D insert');
    expect(editor.text()).toContain('existing source routing is unchanged');
    expect(engine.setBrowserLoopTransport).not.toHaveBeenCalled();
    expect((editor.get('[aria-label="Track 3 source transport"]').element as HTMLSelectElement)
      .querySelector('option[value="vinylFlick"]')?.disabled).toBe(false);

    await editor.get('[aria-label="Track 3 source transport"]').setValue('beatShift');
    await flushPromises();
    expect(engine.setBrowserLoopTransport).toHaveBeenLastCalledWith(3, expect.objectContaining({ mode: 'beatShift', bpm: 120 }));
    await editor.get('[aria-label="Track 3 source beat offset"]').setValue('1.25');
    await flushPromises();
    expect(engine.setBrowserLoopTransport).toHaveBeenLastCalledWith(3, expect.objectContaining({
      mode: 'beatShift', beatOffsetBeats: 1.25, bpm: 120,
    }));
    expect(JSON.parse(localStorage.getItem('webrc505_loop_source_transport_v1') ?? 'null').browser['3'].beatOffsetBeats).toBe(1.25);

    await editor.get('[aria-label="Track 3 source transport"]').setValue('vinylFlick');
    await flushPromises();
    expect(engine.setBrowserLoopTransport).toHaveBeenLastCalledWith(3, expect.objectContaining({
      mode: 'vinylFlick', vinylSpeedPercent: 0, vinylMixPercent: 100,
    }));
    expect(editor.text()).toContain('Mix blends the original loop with the motor-driven read-head');
    await editor.get('[aria-label="Track 3 Vinyl speed target"]').setValue('50');
    await editor.get('[aria-label="Track 3 Vinyl mix"]').setValue('35');
    await flushPromises();
    expect(engine.setBrowserLoopTransport).toHaveBeenLastCalledWith(3, expect.objectContaining({
      mode: 'vinylFlick', vinylSpeedPercent: 50, vinylMixPercent: 35,
    }));
    expect(JSON.parse(localStorage.getItem('webrc505_loop_source_transport_v1') ?? 'null').browser['3']).toMatchObject({
      mode: 'vinylFlick', vinylSpeedPercent: 50, vinylMixPercent: 35,
    });
  });

  it('requires an explicit action before applying per-track Off when no setting was saved', async () => {
    const { wrapper: editor, engine } = await mountEditor('browser');
    expect(engine.setBrowserLoopTransport).not.toHaveBeenCalled();
    await editor.get('button').trigger('click');
    await flushPromises();
    expect(engine.setBrowserLoopTransport).toHaveBeenCalledWith(3, expect.objectContaining({ mode: 'off' }));
    expect(editor.get('[data-loop-transport-status]').text()).toContain('OFF');
  });

  it('restores the shared Browser source route and removes its saved private override', async () => {
    localStorage.setItem('webrc505_loop_source_transport_v1', JSON.stringify({
      version: 1,
      browser: { '3': { mode: 'beatShift', beatOffsetBeats: 1, bpm: 120, crossfadeMs: 5 } },
      native: {},
    }));
    const { wrapper: editor, engine } = await mountEditor('browser');
    await editor.get('button').trigger('click');
    await flushPromises();
    expect(engine.clearBrowserLoopTransportOverride).toHaveBeenCalledWith(3);
    expect(JSON.parse(localStorage.getItem('webrc505_loop_source_transport_v1') ?? 'null').browser).toEqual({});
    expect(editor.get('[data-loop-transport-status]').text()).toContain('SHARED ROUTE');
  });

  it('sends Native per-track settings with the current shared BPM and persists only after ACK', async () => {
    const { wrapper: editor, engine } = await mountEditor('native');
    const { Transport } = await import('../../src/core/Transport');
    Transport.getInstance().setBpm(132);
    vi.clearAllMocks();
    await editor.get('[aria-label="Track 3 source transport"]').setValue('beatShift');
    await flushPromises();
    expect(engine.setNativeLoopTransport).toHaveBeenLastCalledWith(3, expect.objectContaining({ mode: 'beatShift', bpm: 132 }));
    expect(editor.get('[data-loop-transport-status]').text()).toContain('APPLIED');
    expect(JSON.parse(localStorage.getItem('webrc505_loop_source_transport_v1') ?? 'null').native['3'].mode).toBe('beatShift');
    await editor.get('[aria-label="Track 3 source transport"]').setValue('vinylFlick');
    await flushPromises();
    expect(engine.setNativeLoopTransport).toHaveBeenLastCalledWith(3, expect.objectContaining({
      mode: 'vinylFlick', vinylSpeedPercent: 0, vinylMixPercent: 100, bpm: 132,
    }));
    expect(JSON.parse(localStorage.getItem('webrc505_loop_source_transport_v1') ?? 'null').native['3'].mode).toBe('vinylFlick');
    Transport.getInstance().setBpm(120);
  });
});
