import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NativeCatalogParametersEditor from '../../src/components/fx/NativeCatalogParametersEditor.vue';

const schema = {
  version: 1 as const,
  parameters: [{
    id: 'rate_hz', label: 'Rate', minimum: 0.05, maximum: 10,
    defaultValue: 0.5, smoothingMs: 20, discrete: false,
  }],
  legacyAliases: [],
};

describe('NativeCatalogParametersEditor draft', () => {
  it('keeps an unsubmitted edit across status polls that pass fresh equal override objects', async () => {
    const runtime = {
      path: 'input' as const, slot: 'A' as const, trackId: 0,
      requestedEffectId: 'phaser', acknowledgedEffectId: 'phaser',
      requestedParameters: {}, acknowledgedParameters: {},
      requestedBypassed: false, appliedBypassed: false, prepared: true, processingFaulted: false,
      controlFaulted: false, pendingApply: false, outcomeUnknown: false, requestedRevision: 7,
      appliedRevision: 7, acknowledged: true, pendingRestart: false, error: '',
    };
    const wrapper = mount(NativeCatalogParametersEditor, {
      props: {
        title: 'INPUT A · PHASER', schema, modelValue: {}, macroParameters: {}, runtime,
      },
    });

    await wrapper.get('[aria-label="INPUT A · PHASER rate_hz"]').setValue('2.5');
    // Status polls replace both the runtime snapshot and the parent's empty
    // override object. Neither refresh is an ACK for this draft, so it must
    // remain untouched and unpersisted until the user submits it.
    await wrapper.setProps({
      modelValue: {},
      runtime: { ...runtime, requestedRevision: 8, pendingApply: true, acknowledged: false },
    });
    await wrapper.setProps({ modelValue: {}, runtime: { ...runtime, appliedRevision: 8 } });
    expect((wrapper.get('[aria-label="INPUT A · PHASER rate_hz"]').element as HTMLInputElement).value).toBe('2.5');
    expect(wrapper.emitted('apply')).toBeUndefined();
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('apply')).toEqual([[{ rate_hz: 2.5 }]]);

    // Once a new ACK-backed map arrives, the editor adopts the confirmed value.
    await wrapper.setProps({ modelValue: { rate_hz: 3 } });
    expect((wrapper.get('[aria-label="INPUT A · PHASER rate_hz"]').element as HTMLInputElement).value).toBe('3');
    wrapper.unmount();
  });
});
