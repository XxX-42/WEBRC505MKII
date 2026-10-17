import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import HardwareButton from '../../src/components/ui/HardwareButton.vue';
import HardwareKnob from '../../src/components/ui/HardwareKnob.vue';

describe('HardwareButton interaction semantics', () => {
  it('emits one press and one release for a pointer activation despite the follow-up click', async () => {
    const wrapper = mount(HardwareButton, { props: { label: 'PLAY' } });

    await wrapper.trigger('pointerdown', { pointerId: 7, button: 0, isPrimary: true });
    await wrapper.trigger('pointerup', { pointerId: 7, button: 0 });
    // Compatibility clicks can arrive in a later task, after a zero-ms timer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));

    expect(wrapper.emitted('press')).toHaveLength(1);
    expect(wrapper.emitted('release')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toBeUndefined();
    wrapper.unmount();
  });

  it('uses the same press/release events for keyboard and ignores repeat keydown', async () => {
    const wrapper = mount(HardwareButton, { props: { label: 'PLAY' } });

    await wrapper.trigger('keydown', { key: ' ', repeat: false });
    await wrapper.trigger('keydown', { key: ' ', repeat: true });
    await wrapper.trigger('keyup', { key: ' ' });
    await wrapper.trigger('click');

    expect(wrapper.emitted('press')).toHaveLength(1);
    expect(wrapper.emitted('release')).toHaveLength(1);
    wrapper.unmount();
  });

  it('reports pointer cancellation without completing a normal release', async () => {
    const wrapper = mount(HardwareButton, { props: { label: 'STOP' } });

    await wrapper.trigger('pointerdown', { pointerId: 4, button: 0, isPrimary: true });
    await wrapper.trigger('pointercancel', { pointerId: 4 });

    expect(wrapper.emitted('press')).toHaveLength(1);
    expect(wrapper.emitted('release')).toBeUndefined();
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
  });

  it('keeps a disabled hardware button inert', async () => {
    const wrapper = mount(HardwareButton, { props: { disabled: true, disabledReason: 'Unavailable' } });

    await wrapper.trigger('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
    await wrapper.trigger('keydown', { key: 'Enter' });

    expect(wrapper.attributes('disabled')).toBeDefined();
    expect(wrapper.attributes('title')).toBe('Unavailable');
    expect(wrapper.emitted('press')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('HardwareKnob accessibility and keyboard input', () => {
  it('exposes a slider and changes its value with arrow keys', async () => {
    const wrapper = mount(HardwareKnob, { props: { modelValue: 5, min: 0, max: 100, label: 'FREQ' } });
    const knob = wrapper.get('[role="slider"]');

    await knob.trigger('keydown', { key: 'ArrowRight' });

    expect(knob.attributes('tabindex')).toBe('0');
    expect(knob.attributes('aria-valuemin')).toBe('0');
    expect(knob.attributes('aria-valuemax')).toBe('100');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([6]);
    wrapper.unmount();
  });

  it('removes a disabled knob from keyboard interaction and exposes its reason', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 5, label: 'FREQ', disabled: true, disabledReason: 'Filter unavailable' },
    });
    const knob = wrapper.get('[role="slider"]');

    await knob.trigger('keydown', { key: 'ArrowRight' });

    expect(knob.attributes('aria-disabled')).toBe('true');
    expect(knob.attributes('tabindex')).toBe('-1');
    expect(knob.attributes('title')).toBe('Filter unavailable');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.unmount();
  });
});
