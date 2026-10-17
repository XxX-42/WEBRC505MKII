import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

const HardwareButtonStub = defineComponent({
  props: { label: { type: String, default: '' } },
  emits: ['press'],
  template: '<button type="button" @click="$emit(\'press\')">{{ label }}</button>',
});

describe('rhythm selection UI', () => {
  let wrapper: VueWrapper | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('exposes 240 metadata rows, 16 kits, A-D, sections and shared timing controls', async () => {
    const rhythmEngine = {
      start: vi.fn(),
      stop: vi.fn(),
      setVolume: vi.fn(),
      setSettings: vi.fn(() => true),
    };
    const mockAudioEngine = {
      rhythmEngine,
      getCapabilities: () => ({ supportsRhythm: true, rhythmReason: '' }),
    };
    vi.doMock('../../src/audio/AudioEngine', () => ({
      AudioEngine: { getInstance: () => mockAudioEngine },
    }));

    const component = (await import('../../src/components/RhythmControls.vue')).default;
    wrapper = mount(component, { global: { stubs: { HardwareButton: HardwareButtonStub } } });
    const pattern = wrapper.get('[data-testid="rhythm-pattern-select"]');
    expect(pattern.findAll('option')).toHaveLength(240);
    expect(pattern.element.value).toBe('106');

    await pattern.setValue('240');
    expect(rhythmEngine.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ patternIndex: 240 }));

    const kit = wrapper.get('[data-testid="rhythm-kit-select"]');
    const variation = wrapper.get('[data-testid="rhythm-variation-select"]');
    const section = wrapper.get('[data-testid="rhythm-section-select"]');
    const quantize = wrapper.get('[data-testid="rhythm-quantize-select"]');
    expect(kit.findAll('option')).toHaveLength(16);
    expect(variation.findAll('option')).toHaveLength(4);
    expect(section.findAll('option')).toHaveLength(4);
    await kit.setValue('16');
    await variation.setValue('D');
    await section.setValue('fill');
    await quantize.setValue('1/8');
    await wrapper.get('[data-testid="rhythm-swing"]').setValue('67');
    expect(rhythmEngine.setSettings).toHaveBeenLastCalledWith({
      patternIndex: 240,
      kitIndex: 16,
      variation: 'D',
      section: 'fill',
      swingPercent: 67,
      quantizeGrid: '1/8',
    });
    expect(wrapper.get('[data-testid="rhythm-provenance"]').text()).toContain('not factory MIDI or samples');
  });
});
