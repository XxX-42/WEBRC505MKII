<template>
  <div
    class="hardware-knob-wrapper hardware-interactive"
    :class="[`appearance-${appearance}`, { 'is-disabled': disabled }]"
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
    @keydown="handleKeyDown"
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
import { computed, onUnmounted, ref, watch } from 'vue';

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
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

// ========================================
// VISUALS
// ========================================

const rotationRange = 270; // Degrees (Start at -135, End at +135)
const startAngle = -135;
const displayValue = computed(() => Number.isInteger(liveValue.value)
  ? String(liveValue.value)
  : liveValue.value.toFixed(2).replace(/\.?0+$/, ''));

const liveValue = ref(props.modelValue);

watch(() => props.modelValue, (value) => {
  if (!isDragging.value) {
    liveValue.value = value;
  }
});

const normalizedValue = computed(() => {
  return (liveValue.value - props.min) / (props.max - props.min);
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

const isDragging = ref(false);
const activePointerId = ref<number | null>(null);
const startY = ref(0);
const startValue = ref(0);

const startDrag = (e: PointerEvent) => {
  if (props.disabled || (e.button !== 0 && e.pointerType !== 'touch') || e.isPrimary === false || isDragging.value) return;
  const y = e.clientY;
  isDragging.value = true;
  activePointerId.value = e.pointerId;
  startY.value = y;
  startValue.value = liveValue.value;

  try {
    (e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
  } catch {
    // Pointer capture is unavailable in some browser and test environments.
  }
  window.addEventListener('pointermove', onDrag, { passive: true });
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
};

const onDrag = (e: PointerEvent) => {
  if (props.disabled || !isDragging.value) return;
  if (activePointerId.value !== null && e.pointerId !== activePointerId.value) return;

  const currentY = e.clientY;
  const dy = startY.value - currentY; // Up is positive
  const sensitivity = 0.5; // Pixels to Value ratio

  const rawDelta = dy * sensitivity;
  
  // Calculate new value
  let newValue = startValue.value + rawDelta;
  
  // Clamp
  if (newValue < props.min) newValue = props.min;
  if (newValue > props.max) newValue = props.max;

  liveValue.value = newValue;
  emit('update:modelValue', newValue);
};

const stopDrag = (e?: PointerEvent) => {
  if (activePointerId.value !== null && e && e.pointerId !== activePointerId.value) return;
  isDragging.value = false;
  activePointerId.value = null;
  window.removeEventListener('pointermove', onDrag);
  window.removeEventListener('pointerup', stopDrag);
  window.removeEventListener('pointercancel', stopDrag);
};

const setKeyboardValue = (value: number) => {
  const nextValue = Math.max(props.min, Math.min(props.max, value));
  if (nextValue === liveValue.value) return;
  liveValue.value = nextValue;
  emit('update:modelValue', nextValue);
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (props.disabled) return;
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

watch(() => props.disabled, (disabled) => {
  if (disabled) stopDrag();
});

onUnmounted(() => stopDrag());

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
