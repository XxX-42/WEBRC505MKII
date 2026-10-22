<template>
  <div
    class="hardware-knob-wrapper hardware-interactive"
    :class="[
      `appearance-${appearance}`,
      { 'is-disabled': disabled },
      { 'is-interacting': isDragging },
      { 'is-pressing': isPushHeld }
    ]"
    role="slider"
    :tabindex="disabled ? -1 : 0"
    :aria-label="ariaLabel || label || 'Hardware knob'"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="liveValue"
    :aria-valuetext="`${ariaLabel || label || 'Value'}: ${displayValue}`"
    :aria-disabled="disabled"
    :aria-description="disabled && disabledReason ? disabledReason : undefined"
    :title="disabled && disabledReason ? disabledReason : undefined"
    @pointerdown="startDrag"
    @lostpointercapture="handleLostPointerCapture"
    @keydown="handleKeyDown"
    @keyup="handleKeyUp"
    @blur="handleBlur"
  >
    <div class="knob-stage">
      <!-- LED Ring (SVG) -->
      <svg class="led-ring" viewBox="0 0 100 100">
        <g class="ring-group">
          <circle
            cx="50"
            cy="50"
            :r="ringRadius"
            fill="none"
            stroke="#1a1a1a"
            :stroke-width="ringStrokeWidth"
            stroke-linecap="round"
            class="ring-track"
            :stroke-dasharray="ringTrackDashArray"
          />
          <circle
            cx="50"
            cy="50"
            :r="ringRadius"
            fill="none"
            :stroke="activeColor"
            :stroke-width="ringStrokeWidth"
            stroke-linecap="round"
            :stroke-dasharray="dashArray"
            class="value-arc"
          />
        </g>
      </svg>

      <!-- Knob Cap (css 3D) -->
      <div class="knob-cap" :style="knobStyle">
        <div class="knob-indicator"></div>
        <div class="knob-texture"></div>
      </div>
    </div>

    <!-- Label -->
    <div class="knob-label" v-if="label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

type InteractionMode = 'value' | 'relative';
type EncoderGesture = 'press' | 'rotate' | 'pressRotate';
type EncoderSource = 'pointer' | 'keyboard';
type EncoderCancelReason = 'pointercancel' | 'lostpointercapture' | 'blur' | 'disabled' | 'unmount' | 'context-change';

interface EncoderInteractionDetail {
  source: EncoderSource;
  pointerType?: string;
  gesture?: EncoderGesture;
  contextKey?: string | number;
}

const props = withDefaults(defineProps<{
  modelValue: number;
  min?: number;
  max?: number;
  label?: string;
  color?: 'red' | 'green' | 'blue' | 'yellow' | 'white';
  size?: number; // size in px
  step?: number;
  disabled?: boolean;
  disabledReason?: string;
  ariaLabel?: string;
  appearance?: 'standard' | 'classic';
  interactionMode?: InteractionMode;
  pushable?: boolean;
  interactionContextKey?: string | number;
}>(), {
  min: 0,
  max: 100,
  label: '',
  color: 'blue',
  size: 48,
  step: 0,
  disabled: false,
  disabledReason: '',
  ariaLabel: '',
  appearance: 'standard',
  interactionMode: 'value',
  pushable: false,
  interactionContextKey: undefined,
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
  rotate: [delta: number, detail: EncoderInteractionDetail];
  pressRotate: [delta: number, detail: EncoderInteractionDetail];
  press: [detail: EncoderInteractionDetail];
  release: [detail: EncoderInteractionDetail];
  cancel: [reason: EncoderCancelReason, detail: EncoderInteractionDetail];
}>();

// ========================================
// VISUALS
// ========================================

const rotationRange = 270; // Degrees (Start at -135, End at +135)
const startAngle = -135;
const isDragging = ref(false);
const isPushHeld = ref(false);
const activePointerId = ref<number | null>(null);
const activePointerType = ref<string>('mouse');
const pointerTarget = ref<HTMLElement | null>(null);
const interactionStartKey = ref<string | number | undefined>();
let keyboardPushHeld = false;
let keyboardPushRotated = false;
let pointerGesture: 'pending' | 'value' | 'rotate' | 'pressRotate' | null = null;
let pointerStartX = 0;
let pointerStartY = 0;
let pointerLastAxis = 0;
let pointerAxis: 'x' | 'y' | null = null;
let pointerRemainder = 0;
let pointerShiftHeld = false;
let pointerTouchPushArmed = false;
let pointerTouchTimer: number | null = null;
let pointerInteractionMode: InteractionMode = 'value';
let pointerPushable = false;
let keyboardGestureStartedKey: string | number | undefined;
let keyboardInteractionMode: InteractionMode = 'relative';
let keyboardGesturePushable = false;
const dragThresholdPx = 4;
const pixelsPerRelativeStep = 4;
const touchPushHoldMs = 350;

const displayValue = computed(() => Number.isInteger(liveValue.value)
  ? String(liveValue.value)
  : liveValue.value.toFixed(2).replace(/\.?0+$/, ''));

const liveValue = ref(props.modelValue);
const normalizedValue = computed(() => {
  const range = props.max - props.min;
  if (!(range > 0)) return 0;
  return Math.max(0, Math.min(1, (liveValue.value - props.min) / range));
});

watch(() => props.modelValue, (value) => {
  if (props.interactionMode === 'relative' || !isDragging.value) {
    liveValue.value = value;
  }
});

const rotation = computed(() => {
  return startAngle + (normalizedValue.value * rotationRange);
});

const knobStyle = computed(() => ({
  transform: `rotate(${rotation.value}deg)`,
  width: `${props.size}px`,
  height: `${props.size}px`
}));

const activeColor = computed(() => {
  switch (props.color) {
    case 'red': return '#ff3333';
    case 'green': return '#33ff33';
    case 'blue': return '#3399ff';
    case 'yellow': return '#ffff33';
    case 'white': return '#ffffff';
    default: return '#3399ff';
  }
});

// SVG Dash Array for Arc fill
const ringRadius = 38;
const ringStrokeWidth = 8;
const ringCircumference = 2 * Math.PI * ringRadius;
const arcLength = ringCircumference * (rotationRange / 360);
const ringTrackDashArray = `${arcLength} ${ringCircumference}`;

const dashArray = computed(() => {
  const currentLen = arcLength * normalizedValue.value;
  return `${currentLen} ${ringCircumference}`;
});

// ========================================
// INTERACTION (Vertical Drag)
// ========================================

const startY = ref(0);
const startValue = ref(0);

const interactionDetail = (
  source: EncoderSource,
  gesture?: EncoderGesture,
  pointerType?: string,
  contextKey = interactionStartKey.value,
): EncoderInteractionDetail => ({ source, pointerType, gesture, contextKey });

const clearPointerTimer = () => {
  if (pointerTouchTimer !== null) {
    window.clearTimeout(pointerTouchTimer);
    pointerTouchTimer = null;
  }
};

const attachPointerListeners = () => {
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
};

const removePointerListeners = () => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
};

const startDrag = (e: PointerEvent) => {
  if (props.disabled || keyboardPushHeld || (e.button !== 0 && e.pointerType !== 'touch') || e.isPrimary === false || isDragging.value) return;
  isDragging.value = true;
  activePointerId.value = e.pointerId;
  activePointerType.value = e.pointerType || 'mouse';
  pointerTarget.value = e.currentTarget as HTMLElement | null;
  interactionStartKey.value = props.interactionContextKey;
  pointerInteractionMode = props.interactionMode;
  pointerPushable = props.pushable;
  pointerGesture = props.interactionMode === 'value' ? 'value' : 'pending';
  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
  startY.value = e.clientY;
  pointerLastAxis = 0;
  pointerAxis = null;
  pointerRemainder = 0;
  pointerShiftHeld = Boolean(e.shiftKey);
  pointerTouchPushArmed = false;
  startValue.value = liveValue.value;

  try {
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  } catch {
    // Pointer capture is unavailable in some browser and test environments.
  }
  attachPointerListeners();

  if (props.interactionMode === 'relative' && props.pushable && activePointerType.value === 'touch') {
    const pointerId = e.pointerId;
    pointerTouchTimer = window.setTimeout(() => {
      pointerTouchTimer = null;
      if (activePointerId.value === pointerId && pointerGesture === 'pending') {
        pointerTouchPushArmed = true;
        isPushHeld.value = true;
      }
    }, touchPushHoldMs);
  }
};

const updateLegacyValueFromPointer = (e: PointerEvent) => {
  const currentY = e.clientY;
  const dy = startY.value - currentY; // Up is positive
  const sensitivity = 0.5; // Pixels to Value ratio

  const rawDelta = dy * sensitivity;
  let newValue = startValue.value + rawDelta;

  if (newValue < props.min) newValue = props.min;
  if (newValue > props.max) newValue = props.max;

  liveValue.value = newValue;
  emit('update:modelValue', newValue);
};

const emitRelativeSteps = (delta: number, gesture: 'rotate' | 'pressRotate') => {
  if (delta === 0) return;
  const source = interactionDetail('pointer', gesture, activePointerType.value);
  const step = props.step > 0 ? props.step : (Math.max(0, props.max - props.min) / 100 || 1);
  liveValue.value = Math.max(props.min, Math.min(props.max, liveValue.value + delta * step));
  if (gesture === 'pressRotate') emit('pressRotate', delta, source);
  else emit('rotate', delta, source);
};

const onPointerMove = (e: PointerEvent) => {
  if (props.disabled || !isDragging.value) return;
  if (activePointerId.value !== null && e.pointerId !== activePointerId.value) return;
  if (interactionStartKey.value !== props.interactionContextKey) {
    cancelPointerGesture('context-change');
    return;
  }

  pointerShiftHeld = pointerShiftHeld || Boolean(e.shiftKey);

  if (pointerGesture === 'value') {
    updateLegacyValueFromPointer(e);
    return;
  }

  const dx = e.clientX - pointerStartX;
  const dy = pointerStartY - e.clientY;
  const dominantDistance = Math.max(Math.abs(dx), Math.abs(dy));

  if (pointerGesture === 'pending') {
    if (dominantDistance <= dragThresholdPx) return;
    pointerAxis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    const axisDelta = pointerAxis === 'x' ? dx : dy;
    pointerGesture = (pointerShiftHeld || pointerTouchPushArmed) && props.pushable
      ? 'pressRotate'
      : 'rotate';
    isPushHeld.value = pointerGesture === 'pressRotate';
    const excess = Math.sign(axisDelta) * Math.max(0, Math.abs(axisDelta) - dragThresholdPx);
    pointerRemainder = excess;
    pointerLastAxis = pointerAxis === 'x' ? e.clientX : e.clientY;
  } else if (pointerAxis) {
    const axisPosition = pointerAxis === 'x' ? e.clientX : e.clientY;
    const axisDelta = pointerAxis === 'x'
      ? axisPosition - pointerLastAxis
      : pointerLastAxis - axisPosition;
    pointerRemainder += axisDelta;
    pointerLastAxis = axisPosition;
  }

  const steps = Math.trunc(pointerRemainder / pixelsPerRelativeStep);
  if (steps !== 0) {
    pointerRemainder -= steps * pixelsPerRelativeStep;
    emitRelativeSteps(steps, pointerGesture === 'pressRotate' ? 'pressRotate' : 'rotate');
  }
};

const finishPointerGesture = (cancelReason?: EncoderCancelReason) => {
  if (activePointerId.value === null) return;
  const pointerId = activePointerId.value;
  const target = pointerTarget.value;
  const pointerType = activePointerType.value;
  const gesture: EncoderGesture = pointerGesture === 'rotate'
    ? 'rotate'
    : pointerGesture === 'pressRotate'
      ? 'pressRotate'
      : 'press';
  const detail = interactionDetail('pointer', gesture, pointerType);
  clearPointerTimer();
  removePointerListeners();
  isDragging.value = false;
  isPushHeld.value = false;
  activePointerId.value = null;
  pointerGesture = null;
  pointerAxis = null;
  pointerTouchPushArmed = false;
  try {
    if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
  pointerTarget.value = null;

  if (pointerInteractionMode !== 'relative') return;
  if (cancelReason) {
    emit('cancel', cancelReason, detail);
    return;
  }
  if (gesture === 'press' && pointerPushable) emit('press', detail);
  emit('release', detail);
};

const cancelPointerGesture = (reason: EncoderCancelReason) => finishPointerGesture(reason);

const onPointerUp = (e: PointerEvent) => {
  if (activePointerId.value === null || e.pointerId !== activePointerId.value) return;
  finishPointerGesture();
};

const onPointerCancel = (e: PointerEvent) => {
  if (activePointerId.value === null || e.pointerId !== activePointerId.value) return;
  cancelPointerGesture('pointercancel');
};

const handleLostPointerCapture = (e: PointerEvent) => {
  if (activePointerId.value === null || e.pointerId !== activePointerId.value) return;
  cancelPointerGesture('lostpointercapture');
};

const setKeyboardValue = (value: number) => {
  const nextValue = Math.max(props.min, Math.min(props.max, value));
  if (nextValue === liveValue.value) return;
  liveValue.value = nextValue;
  emit('update:modelValue', nextValue);
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (props.disabled) return;
  if (props.interactionMode === 'relative') {
    if (activePointerId.value !== null) return;
    if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
      if (!props.pushable) return;
      event.preventDefault();
      if (event.repeat || keyboardPushHeld) return;
      keyboardPushHeld = true;
      keyboardPushRotated = false;
      keyboardInteractionMode = props.interactionMode;
      keyboardGesturePushable = props.pushable;
      keyboardGestureStartedKey = props.interactionContextKey;
      interactionStartKey.value = keyboardGestureStartedKey;
      isPushHeld.value = true;
      return;
    }

    const arrowDelta: Record<string, number> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
    };
    if (event.key in arrowDelta) {
      const delta = arrowDelta[event.key];
      if (delta === undefined) return;
      event.preventDefault();
      if (keyboardPushHeld && keyboardGestureStartedKey !== props.interactionContextKey) {
        cancelKeyboardGesture('context-change');
        return;
      }
      emitKeyboardSteps(delta, keyboardPushHeld ? 'pressRotate' : 'rotate');
      if (keyboardPushHeld) keyboardPushRotated = true;
      return;
    }

    const step = props.step > 0 ? props.step : (Math.max(0, props.max - props.min) / 100 || 1);
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      const delta = event.key === 'PageUp' ? 10 : -10;
      emitKeyboardSteps(delta, keyboardPushHeld ? 'pressRotate' : 'rotate');
      if (keyboardPushHeld) keyboardPushRotated = true;
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? props.min : props.max;
      const delta = Math.round((target - liveValue.value) / step);
      emitKeyboardSteps(delta, keyboardPushHeld ? 'pressRotate' : 'rotate');
      if (keyboardPushHeld && delta !== 0) keyboardPushRotated = true;
      return;
    }
    return;
  }

  const range = Math.max(0, props.max - props.min);
  const step = props.step > 0 ? props.step : range / 100 || 1;
  const largeStep = step * 10;
  let nextValue: number | null = null;
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowRight':
      nextValue = liveValue.value + step * (event.shiftKey ? 10 : 1);
      break;
    case 'ArrowDown':
    case 'ArrowLeft':
      nextValue = liveValue.value - step * (event.shiftKey ? 10 : 1);
      break;
    case 'PageUp':
      nextValue = liveValue.value + largeStep;
      break;
    case 'PageDown':
      nextValue = liveValue.value - largeStep;
      break;
    case 'Home':
      nextValue = props.min;
      break;
    case 'End':
      nextValue = props.max;
      break;
    default:
      return;
  }
  event.preventDefault();
  setKeyboardValue(nextValue);
};

const emitKeyboardSteps = (delta: number, gesture: 'rotate' | 'pressRotate') => {
  if (delta === 0) return;
  const detail = interactionDetail('keyboard', gesture, undefined, keyboardPushHeld ? keyboardGestureStartedKey : props.interactionContextKey);
  const step = props.step > 0 ? props.step : (Math.max(0, props.max - props.min) / 100 || 1);
  liveValue.value = Math.max(props.min, Math.min(props.max, liveValue.value + delta * step));
  if (gesture === 'pressRotate') emit('pressRotate', delta, detail);
  else emit('rotate', delta, detail);
};

const finishKeyboardGesture = (cancelReason?: EncoderCancelReason) => {
  if (!keyboardPushHeld) return;
  const detail = interactionDetail(
    'keyboard',
    keyboardPushRotated ? 'pressRotate' : 'press',
    undefined,
    keyboardGestureStartedKey,
  );
  keyboardPushHeld = false;
  keyboardPushRotated = false;
  keyboardGestureStartedKey = undefined;
  isPushHeld.value = false;
  if (keyboardInteractionMode !== 'relative') return;
  if (cancelReason) {
    emit('cancel', cancelReason, detail);
    return;
  }
  if (detail.gesture === 'press' && keyboardGesturePushable) emit('press', detail);
  emit('release', detail);
};

const cancelKeyboardGesture = (reason: EncoderCancelReason) => finishKeyboardGesture(reason);

const handleKeyUp = (event: KeyboardEvent) => {
  if ((event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') && keyboardPushHeld) {
    event.preventDefault();
    finishKeyboardGesture();
  }
};

const handleBlur = () => {
  if (activePointerId.value !== null) cancelPointerGesture('blur');
  if (keyboardPushHeld) cancelKeyboardGesture('blur');
};

const handleWindowBlur = () => handleBlur();

watch(() => props.disabled, (disabled) => {
  if (disabled) {
    if (activePointerId.value !== null) cancelPointerGesture('disabled');
    if (keyboardPushHeld) cancelKeyboardGesture('disabled');
  }
});

watch(() => props.interactionContextKey, (next, previous) => {
  if (next === previous) return;
  if (activePointerId.value !== null) cancelPointerGesture('context-change');
  if (keyboardPushHeld) cancelKeyboardGesture('context-change');
});

watch(() => [props.interactionMode, props.pushable] as const, () => {
  if (activePointerId.value !== null) cancelPointerGesture('context-change');
  if (keyboardPushHeld) cancelKeyboardGesture('context-change');
});

onMounted(() => window.addEventListener('blur', handleWindowBlur));

onUnmounted(() => {
  if (activePointerId.value !== null) cancelPointerGesture('unmount');
  if (keyboardPushHeld) cancelKeyboardGesture('unmount');
  window.removeEventListener('blur', handleWindowBlur);
  clearPointerTimer();
  removePointerListeners();
});

</script>

<style scoped>
.hardware-knob-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: grab;
  user-select: none;
  width: 64px;
  min-height: 78px;
  touch-action: none;
}

.hardware-knob-wrapper:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
  border-radius: 4px;
}

.hardware-knob-wrapper.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
  filter: grayscale(0.65);
}
.hardware-knob-wrapper.appearance-classic.is-disabled {
  opacity: 0.64;
  filter: grayscale(0.55);
}

.hardware-knob-wrapper:active {
  cursor: grabbing;
}

.knob-stage {
  position: relative;
  width: 60px;
  height: 60px;
  display: grid;
  place-items: center;
}

/* === LED RING === */
.led-ring {
  position: absolute;
  inset: 0;
  width: 60px;
  height: 60px;
  pointer-events: none;
  filter: drop-shadow(0 0 2px rgba(255, 255, 255, 0.2));
}

.ring-group {
  transform-origin: 50px 50px;
  transform: rotate(135deg);
}

.ring-track,
.value-arc {
  transition: none;
  will-change: stroke-dasharray;
}

/* === KNOB CAP === */
.knob-cap {
  position: relative;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #444, #1a1a1a);
  box-shadow: 
    0 4px 6px rgba(0,0,0,0.8),
    inset 0 1px 0 rgba(255,255,255,0.1);
  z-index: 10;
  will-change: transform;
}

/* Indicator Line */
.knob-indicator {
  position: absolute;
  top: 10%;
  left: 50%;
  width: 2px;
  height: 30%;
  background: white;
  transform: translateX(-50%);
  border-radius: 1px;
  box-shadow: 0 0 2px white;
}

/* Grip Texture (Subtle concentric rings or gradient) */
.knob-texture {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: repeating-radial-gradient(
    transparent 0,
    transparent 2px,
    rgba(0,0,0,0.2) 3px
  );
  pointer-events: none;
}

/* === LABEL === */
.knob-label {
  font-family: var(--font-hardware, monospace);
  font-size: 9px;
  color: #888;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  pointer-events: none;
}

.hardware-knob-wrapper.appearance-classic {
  gap: 3px;
  color: #d4d2d8;
}
.hardware-knob-wrapper.appearance-classic .led-ring { display: none; }
.hardware-knob-wrapper.appearance-classic .knob-stage::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: repeating-conic-gradient(from 0deg, #aaa5ae 0deg .55deg, transparent .65deg 9deg);
  -webkit-mask: radial-gradient(farthest-side, transparent 75%, #000 77% 83%, transparent 85%);
  mask: radial-gradient(farthest-side, transparent 75%, #000 77% 83%, transparent 85%);
  opacity: .72;
  pointer-events: none;
}
.hardware-knob-wrapper.appearance-classic .knob-cap {
  border: 1px solid #07080b;
  background: radial-gradient(circle at 34% 27%, #44434a 0%, #25252b 45%, #101115 100%);
  box-shadow: inset 0 1px rgba(255,255,255,.18), inset 0 -4px 6px rgba(0,0,0,.72), 0 3px 5px rgba(0,0,0,.78);
}
.hardware-knob-wrapper.appearance-classic .knob-indicator {
  background: #d7d2dc;
  box-shadow: 0 0 2px rgba(255,255,255,.45);
}
.hardware-knob-wrapper.appearance-classic .knob-texture {
  background: repeating-conic-gradient(from 0deg, transparent 0deg 4deg, rgba(0,0,0,.2) 4deg 5deg);
  opacity: .42;
}
.hardware-knob-wrapper.appearance-classic .knob-label {
  color: #d4d2d8;
  font-size: 11px;
  letter-spacing: .06em;
  text-shadow: 0 1px #08090b;
}
</style>
