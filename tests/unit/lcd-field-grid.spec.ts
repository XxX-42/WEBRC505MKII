import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import LcdFieldGrid, { type LcdField } from '../../src/components/panel/LcdFieldGrid.vue';

describe('LcdFieldGrid interactions', () => {
  it('emits one update for a range input and one update for an enum selection', async () => {
    const setLevel = vi.fn();
    const setMode = vi.fn();
    const fields: LcdField[] = [
      {
        key: 'level', label: 'LEVEL', value: 40, min: 0, max: 100, step: 1,
        disabled: false, reason: '', setValue: setLevel,
      },
      {
        key: 'mode', label: 'MODE', value: 1, min: 1, max: 2, step: 1,
        disabled: false, reason: '', kind: 'enum',
        options: [{ label: 'R2', value: 1 }, { label: 'R3', value: 2 }],
        setValue: setMode,
      },
    ];
    const wrapper = mount(LcdFieldGrid, { props: { fields } });

    const level = wrapper.get<HTMLInputElement>('[data-testid="lcd-field-level"]');
    level.element.value = '73';
    await level.trigger('input');

    const mode = wrapper.get<HTMLSelectElement>('[data-testid="lcd-field-mode"]');
    await mode.setValue('2');

    expect(wrapper.emitted('update')).toEqual([[0, 73], [1, 2]]);
    expect(setLevel).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('emits one toggle update and one action activation without invoking field callbacks', async () => {
    const setEnabled = vi.fn();
    const runAction = vi.fn();
    const fields: LcdField[] = [
      {
        key: 'enabled', label: 'ENABLED', value: 0, min: 0, max: 100, step: 100,
        disabled: false, reason: '', kind: 'boolean', setValue: setEnabled,
      },
      {
        key: 'open', label: 'OPEN EDITOR', value: 0, min: 0, max: 0, step: 1,
        disabled: false, reason: '', kind: 'action', activate: runAction,
      },
    ];
    const wrapper = mount(LcdFieldGrid, { props: { fields } });

    await wrapper.get('[data-testid="lcd-field-enabled"]').trigger('click');
    await wrapper.get('[data-testid="lcd-field-open"]').trigger('click');

    expect(wrapper.emitted('update')).toEqual([[0, 100]]);
    expect(wrapper.emitted('activate')).toEqual([[1]]);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('renders each field control disabled with its reason available as a title', () => {
    const reason = 'Unavailable in this audio mode';
    const fields: LcdField[] = [
      { key: 'number', label: 'NUMBER', value: 5, min: 0, max: 10, step: 1, disabled: true, reason },
      { key: 'enum', label: 'ENUM', value: 1, min: 1, max: 2, step: 1, disabled: true, reason, kind: 'enum', options: [{ label: 'A', value: 1 }] },
      { key: 'boolean', label: 'BOOLEAN', value: 0, min: 0, max: 100, step: 100, disabled: true, reason, kind: 'boolean' },
      { key: 'action', label: 'ACTION', value: 0, min: 0, max: 0, step: 1, disabled: true, reason, kind: 'action' },
    ];
    const wrapper = mount(LcdFieldGrid, { props: { fields } });

    for (const key of ['number', 'enum', 'boolean', 'action']) {
      const control = wrapper.get<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(`[data-testid="lcd-field-${key}"]`);
      expect(control.element.disabled).toBe(true);
      expect(control.attributes('title')).toBe(reason);
    }

    wrapper.unmount();
  });
});
