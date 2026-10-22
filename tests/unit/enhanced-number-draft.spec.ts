import { DOMWrapper, mount } from '@vue/test-utils';
import { computed, nextTick, reactive, ref } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceScreenField } from '../../src/composables/useDeviceScreenEditor';

const confirmed = ref(0);
const status = ref('READY');
const pageIndex = ref(0);
const disabled = ref(false);
const acceptValue = ref(true);
const panelState = reactive({ page: 'track' });
const focusState = reactive({ currentTrackId: 1 });
let refreshCount = 0;
const setValue = vi.fn((value: number) => {
  if (!acceptValue.value) return false;
  confirmed.value = value;
  return true;
});
let EnhancedTools: typeof import('../../src/components/EnhancedTools.vue')['default'];

beforeAll(async () => {
  vi.doMock('../../src/composables/createEnhancedDevicePanel', () => ({
    createEnhancedDevicePanel: () => ({ state: panelState, openPage: vi.fn((page: string) => { panelState.page = page; }) }),
  }));
  vi.doMock('../../src/composables/useDeviceScreenEditor', () => ({
    useDeviceScreenEditor: () => ({
      fields: computed(() => {
        void status.value;
        if (pageIndex.value > 0) return [{ key: 'other-field', kind: 'number', label: 'OTHER', value: confirmed.value, setValue } satisfies DeviceScreenField];
        return [{ key: 'wav-pitch', kind: 'number', label: 'WAV PITCH', value: confirmed.value,
          min: -24, max: 24, step: 1, disabled: disabled.value, setValue } satisfies DeviceScreenField];
      }),
      status, pageIndex, pageCount: computed(() => 2), stepPage: vi.fn((delta: number) => { pageIndex.value += delta; }),
    }),
  }));
  vi.doMock('../../src/composables/usePanelFocus', () => ({ usePanelFocus: () => ({ state: focusState }) }));
  vi.doMock('../../src/composables/useRc505Controls', () => ({
    useRc505Controls: () => ({ state: { fxBusy: { input: false, track: false }, errorDetail: '' } }),
  }));
  vi.doMock('../../src/components/panel/InputFxPanel.vue', () => ({ default: { template: '<div />' } }));
  vi.doMock('../../src/components/panel/TrackFxPanel.vue', () => ({ default: { template: '<div />' } }));
  EnhancedTools = (await import('../../src/components/EnhancedTools.vue')).default;
});

function mountTools() {
  const wrapper = mount(EnhancedTools, { attachTo: document.body });
  mountedWrappers.push(wrapper);
  return new DOMWrapper(document.body);
}

const mountedWrappers: Array<{ unmount: () => void }> = [];

function typeInto(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

describe('Enhanced numeric input drafts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    confirmed.value = 0;
    status.value = 'READY';
    pageIndex.value = 0;
    disabled.value = false;
    acceptValue.value = true;
    panelState.page = 'track';
    focusState.currentTrackId = 1;
    refreshCount = 0;
    setValue.mockClear();
  });

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
    document.body.innerHTML = '';
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps a focused draft through repeated runtime polls and commits once on change plus blur', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    typeInto(input, '7');
    expect(document.activeElement).toBe(input);
    await nextTick();
    expect(wrapper.get('[data-testid="enhanced-field-wav-pitch"]').element.value).toBe('7');

    const poll = window.setInterval(() => {
      status.value = `ACK ${++refreshCount}`;
    }, 50);
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    let liveInput = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    expect(liveInput).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(liveInput.value).toBe('7');
    expect(setValue).not.toHaveBeenCalled();

    liveInput.dispatchEvent(new Event('change', { bubbles: true }));
    liveInput.blur();
    expect(document.activeElement).not.toBe(liveInput);
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    window.clearInterval(poll);
    expect(setValue).toHaveBeenCalledExactlyOnceWith(7);
    expect(confirmed.value).toBe(7);
    liveInput = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    expect(liveInput.value).toBe('7');
  });

  it('does not submit an unchanged focused field', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('input[type="number"]').element;
    input.focus();
    input.blur();
    await vi.advanceTimersByTimeAsync(1);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('discards a pending draft when the focused track changes', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    typeInto(input, '7');
    await nextTick();

    focusState.currentTrackId = 2;
    await nextTick();
    expect(wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element).not.toBe(input);
    input.value = '9';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '9' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    await nextTick();
    expect(wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element.value).toBe('0');
    expect(setValue).not.toHaveBeenCalled();
  });

  it('does not submit a field that becomes disabled while its draft is open', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    typeInto(input, '7');
    await nextTick();

    disabled.value = true;
    status.value = 'CAPABILITY CHANGED';
    await nextTick();
    const disabledInput = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    expect(disabledInput.disabled).toBe(true);
    disabledInput.dispatchEvent(new Event('change', { bubbles: true }));
    disabledInput.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();

    expect(setValue).not.toHaveBeenCalled();
    expect(confirmed.value).toBe(0);
    expect(wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element.value).toBe('0');
  });

  it('restores the confirmed value after a failed blur commit', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    acceptValue.value = false;
    typeInto(input, '7');
    await nextTick();
    wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();

    expect(setValue).toHaveBeenCalledExactlyOnceWith(7);
    expect(confirmed.value).toBe(0);
    expect(wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element.value).toBe('0');
  });

  it.each(['index', 'page', 'track'])('rejects late events from the previous %s even after a new input gains focus', async (context) => {
    const wrapper = mountTools();
    const oldInput = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    typeInto(oldInput, '7');
    await nextTick();
    if (context === 'index') pageIndex.value = 1;
    if (context === 'page') panelState.page = 'memory';
    if (context === 'track') focusState.currentTrackId = 2;
    await nextTick();
    const newInput = wrapper.get<HTMLInputElement>('input[type="number"]').element;
    expect(newInput).not.toBe(oldInput);
    typeInto(newInput, '3');
    oldInput.value = '9';
    oldInput.dispatchEvent(new Event('input', { bubbles: true }));
    oldInput.dispatchEvent(new Event('change', { bubbles: true }));
    oldInput.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(newInput.value).toBe('3');
    expect(setValue).not.toHaveBeenCalled();
    newInput.blur();
    await vi.advanceTimersByTimeAsync(1);
    expect(setValue).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('cancels immediately on disable and cannot revive a draft with late events', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('input[type="number"]').element;
    typeInto(input, '7');
    disabled.value = true;
    await nextTick();
    expect(input.value).toBe('0');
    disabled.value = false;
    await nextTick();
    input.value = '9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(1);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('discards a pending draft when the editor page changes', async () => {
    const wrapper = mountTools();
    const input = wrapper.get<HTMLInputElement>('[data-testid="enhanced-field-wav-pitch"]').element;
    typeInto(input, '7');
    await nextTick();

    pageIndex.value = 1;
    await nextTick();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    expect(wrapper.find('[data-testid="enhanced-field-wav-pitch"]').exists()).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });
});
