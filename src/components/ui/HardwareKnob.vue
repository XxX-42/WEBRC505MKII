<template>
  <div class="hardware-knob-wrapper hardware-interactive" @mousedown="startDrag" @touchstart.prevent="startDrag">
    <div class="knob-stage">
      <!-- LED Ring (SVG) -->
      <svg class="led-ring" viewBox="0 0 100 100">
        <!-- Background Track -->
        <path
          d="M 20,80 A 40,40 0 1 1 80,80"
          fill="none"
          stroke="#1a1a1a"
          stroke-width="8"
          stroke-linecap="round"
        />
        <!-- Active Value Arc -->
        <path
          d="M 20,80 A 40,40 0 1 1 80,80"
          fill="none"
          :stroke="activeColor"
          stroke-width="8"
          stroke-linecap="round"
          :stroke-dasharray="dashArray"
          class="value-arc"
        />
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
import { computed, ref } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: number;
  min?: number;
  max?: number;
  label?: string;
  color?: 'red' | 'green' | 'blue' | 'yellow' | 'white';
  size?: number; // size in px
}>(), {
  min: 0,
  max: 100,
  label: '',
  color: 'blue',
  size: 48
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

// ========================================
// VISUALS
// ========================================

const rotationRange = 270; // Degrees (Start at -135, End at +135)
const startAngle = -135;

const normalizedValue = computed(() => {
  return (props.modelValue - props.min) / (props.max - props.min);
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
const ringCircumference = 2 * Math.PI * 40; // r=40
const arcLength = ringCircumference * (270 / 360); // Total arc length (approx 188.5)

const dashArray = computed(() => {
  const currentLen = arcLength * normalizedValue.value;
  // Format: [filled, empty]
  // Note: The path itself is limited to the arc shape, so we can just fill 'currentLen' then gap the rest
  // But since the path is ALREADY an arc, stroke-dasharray works along that path.
  // Wait, the path is hardcoded as the full 270 deg arc.
  // So we just need: [currentLength, totalLength]
  return `${currentLen} 1000`; // 1000 is just a large enough gap
});

// ========================================
// INTERACTION (Vertical Drag)
// ========================================

const isDragging = ref(false);
const startY = ref(0);
const startValue = ref(0);

const startDrag = (e: MouseEvent | TouchEvent) => {
  const y = getPointerY(e);
  if (y === null) return;
  isDragging.value = true;
  startY.value = y;
  startValue.value = props.modelValue;

  window.addEventListener('mousemove', onDrag);
  window.addEventListener('touchmove', onDrag, { passive: false });
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('touchend', stopDrag);
};

const onDrag = (e: MouseEvent | TouchEvent) => {
  if (!isDragging.value) return;
  if (e instanceof TouchEvent) e.preventDefault(); 

  const currentY = getPointerY(e);
  if (currentY === null) return;
  const dy = startY.value - currentY; // Up is positive
  const sensitivity = 0.5; // Pixels to Value ratio

  const rawDelta = dy * sensitivity;
  
  // Calculate new value
  let newValue = startValue.value + rawDelta;
  
  // Clamp
  if (newValue < props.min) newValue = props.min;
  if (newValue > props.max) newValue = props.max;

  emit('update:modelValue', newValue);
};

const getPointerY = (e: MouseEvent | TouchEvent): number | null => {
  if (e instanceof MouseEvent) return e.clientY;
  const touch = e.touches[0] ?? e.changedTouches[0];
  return touch ? touch.clientY : null;
};

const stopDrag = () => {
  isDragging.value = false;
  window.removeEventListener('mousemove', onDrag);
  window.removeEventListener('touchmove', onDrag);
  window.removeEventListener('mouseup', stopDrag);
  window.removeEventListener('touchend', stopDrag);
};

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

.value-arc {
  transition: stroke-dasharray 0.05s linear;
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
  /* Size set by dynamic style */
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
</style>
