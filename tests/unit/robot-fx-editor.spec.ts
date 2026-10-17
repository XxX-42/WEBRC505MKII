import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import RobotFxEditor from '../../src/components/fx/RobotFxEditor.vue';
import { createDefaultRobotFxParameters } from '../../src/audio/robotFxParameters';

describe('ROBOT FX editor', () => {
  it('exposes experimental formant control and emits bounded pitch/formant/mix model updates', async () => {
    const wrapper = mount(defineComponent({
      setup() {
        const model = ref(createDefaultRobotFxParameters());
        return () => h(RobotFxEditor, {
          modelValue: model.value,
          'onUpdate:modelValue': (value) => { model.value = value; },
        });
      },
    }));
    const editor = wrapper.getComponent(RobotFxEditor);

    const formant = editor.get<HTMLInputElement>('[aria-label="ROBOT formant shift semitones"]');
    expect(formant.element.disabled).toBe(false);
    expect(editor.get('[data-formant-status]').text()).toContain('Experimental monophonic formant compensation');
    expect(editor.get('[data-formant-status]').text()).toContain('sound quality, and Roland fidelity are not verified');

    await editor.get('[aria-label="ROBOT target pitch semitones"]').setValue('-8.5');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ targetPitchSemitones: -8.5 });
    await formant.setValue('5.5');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ formantShiftSemitones: 5.5 });
    await editor.get('[aria-label="ROBOT effect mix percent"]').setValue('42');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      targetPitchSemitones: -8.5,
      formantShiftSemitones: 5.5,
      mixPercent: 42,
    });

    wrapper.unmount();
  });
});
