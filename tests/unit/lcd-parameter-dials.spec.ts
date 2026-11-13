import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import LcdFieldGrid, { type LcdField } from '../../src/components/panel/LcdFieldGrid.vue';

const numberField = (value = 50, extra: Partial<LcdField> = {}): LcdField => ({
  key: 'input-rate', label: 'RATE', value, min: 0, max: 100, step: 1, disabled: false, reason: '', kind: 'number', ...extra,
});
const props = (fields: LcdField[]) => ({ fields, layout: 'parameter-dials' as const });

describe('Classic LCD parameter dial contract', () => {
  it('keeps the legacy card layout unless the Classic parameter mode is explicitly requested', () => {
    const wrapper = mount(LcdFieldGrid, { props: { fields: [numberField()] } });
    expect(wrapper.find('[data-classic-parameter-dials]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lcd-dial-input-rate"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="lcd-field-input-rate"]').attributes('type')).toBe('range');
    wrapper.unmount();
  });

  it.each([[0, 0, -135], [50, 0.5, 0], [100, 1, 135]])('derives the numeric dial from current value %s', (value, normalized, angle) => {
    const wrapper = mount(LcdFieldGrid, { props: props([numberField(value)]) });
    expect(wrapper.findAll('[data-classic-parameter-dials] .lcd-field-card')).toHaveLength(4);
    const dial = wrapper.get('[data-testid="lcd-dial-input-rate"]');
    expect(dial.attributes('viewBox')).toBe('0 0 32 32');
    expect(dial.attributes('aria-hidden')).toBe('true');
    expect(Number(dial.attributes('data-normalized'))).toBe(normalized);
    expect(Number(dial.attributes('data-angle'))).toBe(angle);
    expect(wrapper.get<HTMLInputElement>('[data-testid="lcd-field-input-rate"]').element.value).toBe(String(value));
    wrapper.unmount();
  });

  it('positions discrete enum choices by their option index, not their sparse wire value', () => {
    const field = numberField(7, { kind: 'enum', min: 1, max: 90,
      options: [{ label: 'LOW', value: 1 }, { label: 'MID', value: 7 }, { label: 'HIGH', value: 90 }] });
    const wrapper = mount(LcdFieldGrid, { props: props([field]) });
    expect(Number(wrapper.get('[data-testid="lcd-dial-input-rate"]').attributes('data-normalized'))).toBe(0.5);
    expect(wrapper.get<HTMLInputElement>('[data-testid="lcd-field-input-rate"]').element.value).toBe('1');
    expect(wrapper.text()).toContain('MID');
    wrapper.unmount();
  });

  it('keeps the existing per-index update event and waits for parent value readback before changing the dial', async () => {
    const field = numberField(20);
    const wrapper = mount(LcdFieldGrid, { props: props([field]) });
    const input = wrapper.get<HTMLInputElement>('[data-testid="lcd-field-input-rate"]');
    input.element.value = '70'; await input.trigger('input');
    expect(wrapper.emitted('update')).toEqual([[0, 70]]);
    expect(Number(wrapper.get('[data-testid="lcd-dial-input-rate"]').attributes('data-normalized'))).toBe(0.2);
    await wrapper.setProps({ fields: [{ ...field, value: 70 }] });
    expect(Number(wrapper.get('[data-testid="lcd-dial-input-rate"]').attributes('data-normalized'))).toBe(0.7);
    expect(wrapper.get<HTMLInputElement>('[data-testid="lcd-field-input-rate"]').element.value).toBe('70');
    wrapper.unmount();
  });

  it('does not invent a rotary value for disabled, action, unknown or empty fields', () => {
    const wrapper = mount(LcdFieldGrid, { props: props([
      numberField(30, { disabled: true, reason: 'No confirmed parameter range.' }),
      numberField(0, { key: 'reset', kind: 'action', activate: () => {} }),
      numberField(Number.NaN, { key: 'unknown' }),
    ]) });
    expect(wrapper.findAll('.lcd-parameter-dial')).toHaveLength(0);
    expect(wrapper.get<HTMLInputElement>('[data-testid="lcd-field-input-rate"]').element.disabled).toBe(true);
    expect(wrapper.get('[data-testid="lcd-field-input-rate"]').attributes('title')).toBe('No confirmed parameter range.');
    expect(wrapper.get('[data-testid="lcd-field-reset"]').element.tagName).toBe('BUTTON');
    wrapper.unmount();
  });

  it('continues enum edits and action activation through the original accessible controls', async () => {
    const wrapper = mount(LcdFieldGrid, { props: props([
      numberField(1, { kind: 'enum', options: [{ label: 'A', value: 1 }, { label: 'B', value: 7 }] }),
      numberField(0, { key: 'reset', kind: 'action', activate: () => {} }),
    ]) });
    const input = wrapper.get<HTMLInputElement>('[data-testid="lcd-field-input-rate"]');
    expect(input.attributes('aria-label')).toBe('RATE');
    input.element.value = '1'; await input.trigger('input');
    await wrapper.get('[data-testid="lcd-field-reset"]').trigger('click');
    expect(wrapper.emitted('update')).toEqual([[0, 7]]);
    expect(wrapper.emitted('activate')).toEqual([[1]]);
    wrapper.unmount();
  });
  it('offers full in-LCD details without changing the existing editable control or semantic ARIA', async () => {
    const wrapper = mount(LcdFieldGrid, { props: props([numberField(7, { label: 'PATTERN', kind: 'enum',
      shortValue: 'TRESILLO', fullText: 'PATTERN: 198 · DANCE / TRESILLO', options: [{ value: 7, label: '198 · DANCE / TRESILLO' }] })]) });
    expect(wrapper.get('.lcd-dial-value').text()).toBe('TRESILLO');
    expect(wrapper.get('[data-testid="lcd-field-input-rate"]').attributes('aria-valuetext')).toBe('198 · DANCE / TRESILLO');
    await wrapper.get('[data-testid="lcd-details-input-rate"]').trigger('click');
    expect(wrapper.emitted('details')).toEqual([[0]]);
    expect(wrapper.emitted('update')).toBeUndefined();
    wrapper.unmount();
  });
  it('offers details when a full label actually overflows even without predefined short text', async () => {
    const field = numberField(7, { label: 'AN EXTRAORDINARILY LONG PARAMETER NAME' });
    const wrapper = mount(LcdFieldGrid, { props: props([field]) });
    const label = wrapper.get('.lcd-dial-label').element;
    Object.defineProperties(label, { scrollHeight: { value: 44, configurable: true }, clientHeight: { value: 22, configurable: true } });
    await wrapper.setProps({ fields: [{ ...field, value: 8 }] }); await nextTick();
    const details = wrapper.get('[data-testid="lcd-details-input-rate"]');
    expect(details.attributes('title')).toBe('AN EXTRAORDINARILY LONG PARAMETER NAME: 8%');
    await details.trigger('click');
    expect(wrapper.emitted('details')).toEqual([[0]]);
    wrapper.unmount();
  });
});
