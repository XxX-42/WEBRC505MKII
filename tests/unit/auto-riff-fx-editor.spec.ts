import { defineComponent, h, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AutoRiffFxEditor from '../../src/components/fx/AutoRiffFxEditor.vue';
import { createDefaultAutoRiffParameters } from '../../src/audio/autoRiffParameters';

describe('AUTO RIFF FX editor', () => {
  it('shows the four named experimental controls and emits sanitized model updates', async () => {
    const wrapper = mount(defineComponent({
      setup() {
        const model = ref(createDefaultAutoRiffParameters());
        return () => h(AutoRiffFxEditor, {
          modelValue: model.value,
          'onUpdate:modelValue': (value) => { model.value = value; },
        });
      },
    }));
    const editor = wrapper.getComponent(AutoRiffFxEditor);

    expect(editor.get('[data-auto-riff-editor]').attributes('aria-label')).toContain('experimental');
    expect(editor.get('header').text()).toContain('AUTO RIFF (EXPERIMENTAL)');
    expect(editor.findAll('select')).toHaveLength(2);
    expect(editor.findAll('input[type="range"]')).toHaveLength(2);

    await editor.get('[aria-label="AUTO RIFF scale"]').setValue('4');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ scale: 4 });
    await editor.get('[aria-label="AUTO RIFF step rate in beats"]').setValue('2');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ rateBeats: 2 });
    await editor.get('[aria-label="AUTO RIFF onset sensitivity percent"]').setValue('37');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({ sensitivityPercent: 37 });
    await editor.get('[aria-label="AUTO RIFF effect mix percent"]').setValue('82');
    expect(editor.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({
      scale: 4, rateBeats: 2, sensitivityPercent: 37, mixPercent: 82,
    });

    wrapper.unmount();
  });
});
