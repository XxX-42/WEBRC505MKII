import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import HardwareButton from '../../src/components/ui/HardwareButton.vue';
import HardwareKnob from '../../src/components/ui/HardwareKnob.vue';
import LoopHalo from '../../src/components/LoopHalo.vue';

const pointerEvent = (type: string, init: Record<string, unknown> = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
};

const dispatchPointer = (target: EventTarget, type: string, init: Record<string, unknown> = {}) => {
  target.dispatchEvent(pointerEvent(type, init));
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it('keeps the Classic LED independent from held and logical active state', async () => {
    const wrapper = mount(HardwareButton, {
      props: { appearance: 'classic', active: true, color: 'red', label: 'TRACK' },
    });

    await wrapper.trigger('pointerdown', { pointerId: 12, button: 0, isPrimary: true, pointerType: 'mouse' });

    expect(wrapper.classes()).toContain('is-active');
    expect(wrapper.classes()).toContain('is-pressed');
    expect(wrapper.classes()).not.toContain('active');
    expect(wrapper.get('.led-ring').classes()).toContain('led-off');
    expect(wrapper.get('.led-ring').classes()).not.toContain('led-red');
    wrapper.unmount();
  });

  it('uses the explicit localized LED color while Classic remains mechanically pressed', async () => {
    const wrapper = mount(HardwareButton, {
      props: {
        appearance: 'classic',
        color: 'red',
        ledOn: true,
        ledColor: 'green',
        ledBlinkPeriodMs: 600,
        selected: true,
      },
    });

    await wrapper.trigger('pointerdown', { pointerId: 13, button: 0, isPrimary: true, pointerType: 'mouse' });

    expect(wrapper.classes()).toContain('is-selected');
    expect(wrapper.classes()).toContain('is-pressed');
    expect(wrapper.classes()).toContain('led-blinking');
    expect(wrapper.get('.led-ring').classes()).toContain('led-green');
    expect(wrapper.get('.led-ring').classes()).not.toContain('led-red');
    expect(wrapper.attributes('data-led-on')).toBe('true');
    expect(wrapper.attributes('data-led-color')).toBe('green');
    wrapper.unmount();
  });

  it('accepts resolver-only LED colors and treats off as no emission', async () => {
    const wrapper = mount(HardwareButton, {
      props: { appearance: 'classic', ledOn: true, ledColor: 'pink' },
    });
    expect(wrapper.attributes('data-led-color')).toBe('pink');
    expect(wrapper.get('.led-ring').classes()).toContain('led-pink');

    await wrapper.setProps({ ledColor: 'cyan' });
    expect(wrapper.attributes('data-led-color')).toBe('cyan');
    expect(wrapper.get('.led-ring').classes()).toContain('led-cyan');

    await wrapper.setProps({ ledColor: 'off' });
    expect(wrapper.attributes('data-led-on')).toBe('false');
    expect(wrapper.attributes('data-led-color')).toBe('off');
    expect(wrapper.get('.led-ring').classes()).toContain('led-off');
    expect(wrapper.classes()).not.toContain('led-blinking');
    wrapper.unmount();
  });

  it('preserves Standard legacy active LED behavior when no explicit LED state is supplied', async () => {
    const wrapper = mount(HardwareButton, { props: { active: true, color: 'yellow' } });
    expect(wrapper.get('.led-ring').classes()).toContain('led-yellow');
    wrapper.unmount();
  });

  it('provides pointer hold hooks and emits an opt-in longpress once', async () => {
    vi.useFakeTimers();
    const wrapper = mount(HardwareButton, { props: { longPressMs: 300 } });

    await wrapper.trigger('pointerdown', { pointerId: 14, button: 0, isPrimary: true, pointerType: 'pen' });
    expect(wrapper.emitted('pointer-press')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(wrapper.emitted('longpress')).toHaveLength(1);
    await wrapper.trigger('pointerup', { pointerId: 14, button: 0 });

    expect(wrapper.emitted('pointer-release')).toHaveLength(1);
    expect(wrapper.emitted('pointer-cancel')).toBeUndefined();
    wrapper.unmount();
  });

  it('cancels a held pointer interaction when the window loses focus', async () => {
    const wrapper = mount(HardwareButton);
    await wrapper.trigger('pointerdown', { pointerId: 15, button: 0, isPrimary: true, pointerType: 'mouse' });

    window.dispatchEvent(new Event('blur'));

    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('release')).toBeUndefined();
    expect(wrapper.emitted('pointer-cancel')).toHaveLength(1);
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

  it('keeps relative input opt-in and quantizes a normal drag after its dead zone', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 50, min: 0, max: 100, interactionMode: 'relative', pushable: true },
    });
    const knob = wrapper.get('[role="slider"]');
    await knob.trigger('pointerdown', {
      pointerId: 21, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 20, clientY: 20,
    });

    dispatchPointer(window, 'pointermove', { pointerId: 21, pointerType: 'mouse', clientX: 20, clientY: 16 });
    expect(wrapper.emitted('rotate')).toBeUndefined();
    dispatchPointer(window, 'pointermove', { pointerId: 21, pointerType: 'mouse', clientX: 20, clientY: 12 });
    dispatchPointer(window, 'pointerup', { pointerId: 21, pointerType: 'mouse' });

    expect(wrapper.emitted('rotate')?.map(([delta]) => delta)).toEqual([1]);
    expect(wrapper.emitted('pressRotate')).toBeUndefined();
    expect(wrapper.emitted('press')).toBeUndefined();
    expect(wrapper.emitted('release')).toHaveLength(1);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.unmount();
  });

  it('resolves a relative click as press on release and suppresses click after a drag', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 20, interactionMode: 'relative', pushable: true },
    });
    const knob = wrapper.get('[role="slider"]');
    await knob.trigger('pointerdown', {
      pointerId: 22, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });
    expect(wrapper.emitted('press')).toBeUndefined();
    dispatchPointer(window, 'pointerup', { pointerId: 22, pointerType: 'mouse' });
    expect(wrapper.emitted('press')).toHaveLength(1);

    await knob.trigger('pointerdown', {
      pointerId: 23, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });
    dispatchPointer(window, 'pointermove', { pointerId: 23, pointerType: 'mouse', clientX: 0, clientY: -8 });
    dispatchPointer(window, 'pointerup', { pointerId: 23, pointerType: 'mouse' });
    expect(wrapper.emitted('press')).toHaveLength(1);
    expect(wrapper.emitted('rotate')).toHaveLength(1);
    wrapper.unmount();
  });

  it('maps Shift+drag and touch longhold drag to pressRotate', async () => {
    vi.useFakeTimers();
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 10, interactionMode: 'relative', pushable: true },
    });
    const knob = wrapper.get('[role="slider"]');

    await knob.trigger('pointerdown', {
      pointerId: 24, pointerType: 'mouse', button: 0, isPrimary: true,
      clientX: 0, clientY: 0, shiftKey: true,
    });
    dispatchPointer(window, 'pointermove', {
      pointerId: 24, pointerType: 'mouse', clientX: 0, clientY: -8, shiftKey: true,
    });
    dispatchPointer(window, 'pointerup', { pointerId: 24, pointerType: 'mouse' });

    await knob.trigger('pointerdown', {
      pointerId: 25, pointerType: 'touch', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });
    await vi.advanceTimersByTimeAsync(350);
    dispatchPointer(window, 'pointermove', { pointerId: 25, pointerType: 'touch', clientX: 0, clientY: -8 });
    dispatchPointer(window, 'pointerup', { pointerId: 25, pointerType: 'touch' });

    expect(wrapper.emitted('pressRotate')?.map(([delta]) => delta)).toEqual([1, 1]);
    expect(wrapper.emitted('rotate')).toBeUndefined();
    expect(wrapper.emitted('press')).toBeUndefined();
    wrapper.unmount();
  });

  it('maps normal arrows to rotate and Space+arrow to pressRotate', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 50, interactionMode: 'relative', pushable: true },
    });
    const knob = wrapper.get('[role="slider"]');

    await knob.trigger('keydown', { key: 'ArrowRight', repeat: false });
    await knob.trigger('keydown', { key: ' ', repeat: false });
    await knob.trigger('keydown', { key: 'ArrowUp', repeat: false });
    expect(wrapper.emitted('press')).toBeUndefined();
    await knob.trigger('keyup', { key: ' ' });

    expect(wrapper.emitted('rotate')?.map(([delta]) => delta)).toEqual([1]);
    expect(wrapper.emitted('pressRotate')?.map(([delta]) => delta)).toEqual([1]);
    expect(wrapper.emitted('press')).toBeUndefined();
    expect(wrapper.emitted('release')).toHaveLength(1);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.unmount();
  });

  it('maps a non-repeating Enter hold to one press/release and Enter+arrow to pressRotate', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 50, interactionMode: 'relative', pushable: true, interactionContextKey: 'menu' },
    });
    const knob = wrapper.get('[role="slider"]');

    await knob.trigger('keydown', { key: 'Enter', repeat: false });
    await knob.trigger('keydown', { key: 'Enter', repeat: true });
    expect(wrapper.emitted('press')).toBeUndefined();
    await knob.trigger('keyup', { key: 'Enter' });
    await knob.trigger('keyup', { key: 'Enter' });
    expect(wrapper.emitted('press')).toHaveLength(1);
    expect(wrapper.emitted('release')).toHaveLength(1);
    expect(wrapper.emitted('press')?.[0]?.[0]).toMatchObject({ source: 'keyboard', gesture: 'press', contextKey: 'menu' });

    await knob.trigger('keydown', { key: 'Enter', repeat: false });
    await knob.trigger('keydown', { key: 'ArrowRight', repeat: false });
    await knob.trigger('keyup', { key: 'Enter' });
    expect(wrapper.emitted('press')).toHaveLength(1);
    expect(wrapper.emitted('release')).toHaveLength(2);
    expect(wrapper.emitted('pressRotate')?.map(([delta]) => delta)).toEqual([1]);
    wrapper.unmount();
  });

  it('emits a push only on Space release and cancels the keyboard hold on blur', async () => {
    const clickWrapper = mount(HardwareKnob, {
      props: { modelValue: 50, interactionMode: 'relative', pushable: true },
    });
    const knob = clickWrapper.get('[role="slider"]');
    await knob.trigger('keydown', { key: ' ', repeat: false });
    expect(clickWrapper.emitted('press')).toBeUndefined();
    await knob.trigger('keyup', { key: ' ' });
    expect(clickWrapper.emitted('press')).toHaveLength(1);
    expect(clickWrapper.emitted('release')).toHaveLength(1);
    clickWrapper.unmount();

    const blurWrapper = mount(HardwareKnob, {
      props: { modelValue: 50, interactionMode: 'relative', pushable: true },
    });
    await blurWrapper.get('[role="slider"]').trigger('keydown', { key: ' ', repeat: false });
    window.dispatchEvent(new Event('blur'));
    expect(blurWrapper.emitted('cancel')?.[0]?.[0]).toBe('blur');
    expect(blurWrapper.emitted('press')).toBeUndefined();
    expect(blurWrapper.emitted('release')).toBeUndefined();
    blurWrapper.unmount();
  });

  it('cancels a relative pointer hold when disabled or unmounted', async () => {
    const disabledWrapper = mount(HardwareKnob, {
      props: { modelValue: 30, interactionMode: 'relative', pushable: true },
    });
    await disabledWrapper.get('[role="slider"]').trigger('pointerdown', {
      pointerId: 28, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });
    await disabledWrapper.setProps({ disabled: true });
    expect(disabledWrapper.emitted('cancel')?.[0]?.[0]).toBe('disabled');
    expect(disabledWrapper.emitted('press')).toBeUndefined();
    disabledWrapper.unmount();

    const unmountWrapper = mount(HardwareKnob, {
      props: { modelValue: 30, interactionMode: 'relative', pushable: true },
    });
    await unmountWrapper.get('[role="slider"]').trigger('pointerdown', {
      pointerId: 29, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });
    unmountWrapper.unmount();
    expect(unmountWrapper.emitted('cancel')?.[0]?.[0]).toBe('unmount');
    expect(unmountWrapper.emitted('press')).toBeUndefined();
  });

  it('cancels a pending press after context change and ignores later pointer events', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 50, interactionMode: 'relative', pushable: true, interactionContextKey: 'track-1' },
    });
    const knob = wrapper.get('[role="slider"]');
    await knob.trigger('pointerdown', {
      pointerId: 26, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });

    await wrapper.setProps({ interactionContextKey: 'track-2' });
    dispatchPointer(window, 'pointerup', { pointerId: 26, pointerType: 'mouse' });

    expect(wrapper.emitted('cancel')?.[0]?.[0]).toBe('context-change');
    expect(wrapper.emitted('press')).toBeUndefined();
    expect(wrapper.emitted('release')).toBeUndefined();
    wrapper.unmount();
  });

  it('cancels relative input on pointercancel without converting it into a click', async () => {
    const wrapper = mount(HardwareKnob, {
      props: { modelValue: 25, interactionMode: 'relative', pushable: true },
    });
    const knob = wrapper.get('[role="slider"]');
    await knob.trigger('pointerdown', {
      pointerId: 27, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 0, clientY: 0,
    });
    dispatchPointer(window, 'pointercancel', { pointerId: 27, pointerType: 'mouse' });

    expect(wrapper.emitted('cancel')?.[0]?.[0]).toBe('pointercancel');
    expect(wrapper.emitted('press')).toBeUndefined();
    expect(wrapper.emitted('release')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('LoopHalo indicator modes', () => {
  const makeContext = () => ({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    lineCap: 'butt',
    lineWidth: 0,
    strokeStyle: '',
    shadowBlur: 0,
    shadowColor: '',
  }) as unknown as CanvasRenderingContext2D;

  const mountHalo = (props: Record<string, unknown>) => {
    const context = makeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const wrapper = mount(LoopHalo, { props: { trackId: 1, ...props } });
    return { wrapper, context };
  };

  it('renders Classic status as a static data-backed indicator', () => {
    const { wrapper, context } = mountHalo({
      appearance: 'classic', indicatorMode: 'STATUS', status: 'PLAYING', statusColor: 'green',
    });

    expect(wrapper.attributes('data-indicator-mode')).toBe('STATUS');
    expect(wrapper.attributes('data-state')).toBe('PLAYING');
    expect(wrapper.attributes('aria-label')).toBe('Track 1 status PLAYING');
    expect(context.stroke).toHaveBeenCalled();
    expect(context.strokeStyle).toBe('#00ff66');
    expect(wrapper.get('canvas').classes()).not.toContain('state-playing');
    wrapper.unmount();
  });

  it('does not derive a Classic status color from local track state', () => {
    const { wrapper, context } = mountHalo({
      appearance: 'classic', indicatorMode: 'STATUS', status: 'PLAYING',
    });

    expect(wrapper.attributes('data-state')).toBe('PLAYING');
    expect(context.strokeStyle).toBe('#1a1a1a');
    wrapper.unmount();
  });

  it('clamps normalized loop position and exposes an accessible percentage', () => {
    const { wrapper, context } = mountHalo({
      appearance: 'classic', indicatorMode: 'LOOP_POSITION', position: 1.4,
    });

    expect(wrapper.attributes('data-availability')).toBe('available');
    expect(wrapper.attributes('aria-label')).toBe('Track 1 loop position 100 percent');
    expect(context.arc).toHaveBeenCalledTimes(2);
    const arcCalls = (context.arc as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const arcArgs = arcCalls[1];
    expect(arcArgs[4]).toBeCloseTo(Math.PI * 1.5);
    wrapper.unmount();
  });

  it('does not fabricate a level when no meter data is provided', () => {
    const { wrapper, context } = mountHalo({
      appearance: 'classic', indicatorMode: 'LEVEL', level: null,
    });

    expect(wrapper.attributes('data-indicator-mode')).toBe('LEVEL');
    expect(wrapper.attributes('data-availability')).toBe('unavailable');
    expect(wrapper.attributes('aria-label')).toBe('Track 1 level unavailable');
    expect(context.arc).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
