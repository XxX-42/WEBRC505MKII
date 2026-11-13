import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import HardwareKnob from '../../src/components/ui/HardwareKnob.vue';

function dispatchPointer(type: string, values: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
  window.dispatchEvent(event);
}
function shown(wrapper: ReturnType<typeof mount>, value: number, angle: number) {
  expect(wrapper.attributes('aria-valuenow')).toBe(String(value));
  expect(wrapper.attributes('aria-valuetext')).toContain(String(value));
  expect(wrapper.get('.knob-cap').attributes('style')).toContain(`rotate(${angle}deg)`);
}

describe('relative encoder confirmed readback', () => {
  it('does not invent readback for unhandled or rejected keyboard intents', async () => {
    const wrapper = mount(HardwareKnob, { props: { modelValue: 50, min: 0, max: 100, step: 1, interactionMode: 'relative' } });
    await wrapper.trigger('keydown', { key: 'ArrowUp' });
    shown(wrapper, 50, 0);
    expect(wrapper.emitted('rotate')?.map(([delta]) => delta)).toEqual([1]);
    await wrapper.trigger('keydown', { key: 'PageUp' });
    shown(wrapper, 50, 0);
    expect(wrapper.emitted('rotate')?.map(([delta]) => delta)).toEqual([1, 10]);
    wrapper.unmount();
  });
  it('uses a capped parent readback and changes only upon a delayed acknowledgement', async () => {
    const wrapper = mount(HardwareKnob, { props: { modelValue: 90, min: 0, max: 100, step: 1, interactionMode: 'relative' } });
    await wrapper.trigger('keydown', { key: 'PageUp' }); shown(wrapper, 90, 108);
    await wrapper.setProps({ modelValue: 95 }); shown(wrapper, 95, 121.5);
    await wrapper.trigger('keydown', { key: 'ArrowUp' }); shown(wrapper, 95, 121.5);
    await wrapper.setProps({ modelValue: 100 }); shown(wrapper, 100, 135);
    expect(wrapper.emitted('rotate')?.map(([delta]) => delta)).toEqual([10, 1]);
    wrapper.unmount();
  });
  it('keeps pointer and press-rotate intents independent from acknowledged display and cancels a changed context', async () => {
    const wrapper = mount(HardwareKnob, { props: { modelValue: 50, interactionMode: 'relative', pushable: true, interactionContextKey: 'one' } });
    await wrapper.trigger('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0, shiftKey: true });
    dispatchPointer('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: -8, shiftKey: true });
    await nextTick(); shown(wrapper, 50, 0);
    expect(wrapper.emitted('pressRotate')?.map(([delta]) => delta)).toEqual([1]);
    await wrapper.setProps({ modelValue: 75, interactionContextKey: 'two' }); shown(wrapper, 75, 67.5);
    dispatchPointer('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: -20 });
    expect(wrapper.emitted('cancel')?.[0]?.[0]).toBe('context-change');
    expect(wrapper.emitted('pressRotate')).toHaveLength(1);
    wrapper.unmount();
  });
  it('preserves local drag preview in value mode', async () => {
    const wrapper = mount(HardwareKnob, { props: { modelValue: 50, interactionMode: 'value' } });
    await wrapper.trigger('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0 });
    dispatchPointer('pointermove', { pointerId: 2, pointerType: 'mouse', clientX: 0, clientY: -20 });
    await nextTick(); shown(wrapper, 60, 27);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([60]);
    dispatchPointer('pointerup', { pointerId: 2, pointerType: 'mouse' }); wrapper.unmount();
  });
});
