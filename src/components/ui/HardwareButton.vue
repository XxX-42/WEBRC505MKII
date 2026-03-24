<template>
  <button
    :class="[
      'hardware-button',
      'hardware-interactive',
      `size-${size}`,
      `color-${color}`,
      `shape-${shape}`,
      { 'active': isActive }
    ]"
    type="button"
    :aria-label="computedAriaLabel"
    @mousedown="handlePress"
    @mouseup="handleRelease"
    @mouseleave="handleRelease"
    @touchstart="handlePress"
    @touchend="handleRelease"
    @click="handleClick"
    @keydown.enter.prevent="handleKeyDown"
    @keydown.space.prevent="handleKeyDown"
    @keyup.enter.prevent="handleKeyUp"
    @keyup.space.prevent="handleKeyUp"
  >
    <!-- LED Indicator (Dot for Rect, Ring for Circle) -->
    <div v-if="shape === 'rect'" class="led-dot" :class="ledClass"></div>
    <div v-else class="led-ring" :class="ledClass">
      <div class="led-core"></div>
    </div>
    
    <!-- Button Label -->
    <span v-if="label" class="button-label">{{ label }}</span>
  </button>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  color?: 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'white' | 'neutral';
  active?: boolean;
  label?: string;
  shape?: 'circle' | 'rect';
  ariaLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  color: 'neutral',
  active: false,
  label: '',
  shape: 'circle',
  ariaLabel: ''
});

const emit = defineEmits<{
  (e: 'press'): void;
  (e: 'release'): void;
}>();

const isPressed = ref(false);
const pointerTriggered = ref(false);

const isActive = computed(() => props.active || isPressed.value);
const computedAriaLabel = computed(() => props.ariaLabel || props.label || 'Hardware control');

const ledClass = computed(() => {
  if (!isActive.value) return 'led-off';
  
  switch (props.color) {
    case 'red': return 'led-red';
    case 'green': return 'led-green';
    case 'yellow': return 'led-yellow';
    case 'blue': return 'led-blue';
    case 'purple': return 'led-purple';
    case 'white': return 'led-white';
    default: return 'led-white';
  }
});

const handlePress = () => {
  pointerTriggered.value = true;
  isPressed.value = true;
  emit('press');
};

const handleRelease = () => {
  isPressed.value = false;
  emit('release');
};

const handleClick = () => {
  if (pointerTriggered.value) {
    pointerTriggered.value = false;
    return;
  }
  emit('press');
  emit('release');
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.repeat) return;
  isPressed.value = true;
};

const handleKeyUp = () => {
  isPressed.value = false;
};
</script>

<style scoped>
.hardware-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
  cursor: pointer;
  
  /* === MATERIAL TEXTURE === */
  background: linear-gradient(180deg, #3a3a3a 0%, #1a1a1a 100%);
  
  /* === 3D BORDERS === */
  border: none; /* Reset default */
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  border-bottom: 1px solid rgba(0, 0, 0, 0.8);
  border-left: 1px solid rgba(255, 255, 255, 0.05);
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  
  /* === DEEP SHADOW (Floating) === */
  box-shadow: 
    0 4px 6px rgba(0, 0, 0, 0.5),
    0 1px 3px rgba(0, 0, 0, 0.8);
    
  border-radius: var(--border-radius-button);
  
  transition: all 0.05s ease-out;
  color: rgba(255, 255, 255, 0.7);
}

.hardware-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* === SHAPES === */

/* Circle */
.hardware-button.shape-circle {
  border-radius: 50%;
  aspect-ratio: 1 / 1;
}

/* Rect */
.hardware-button.shape-rect {
  border-radius: 4px;
  width: 100%;
  aspect-ratio: unset;
  padding: 0 8px;
  justify-content: center;
}

/* === SIZES === */
.hardware-button.shape-circle.size-sm { width: var(--button-size-sm); height: var(--button-size-sm); }
.hardware-button.shape-circle.size-md { width: var(--button-size-md); height: var(--button-size-md); }
.hardware-button.shape-circle.size-lg { width: var(--button-size-lg); height: var(--button-size-lg); }

.hardware-button.shape-rect.size-sm { height: 32px; font-size: 11px; }
.hardware-button.shape-rect.size-md { height: 44px; font-size: 12px; }
.hardware-button.shape-rect.size-lg { height: 60px; font-size: 14px; }

/* === ACTIVE STATE (Pressed In) === */
.hardware-button:active,
.hardware-button.active {
  background: linear-gradient(180deg, #151515 0%, #222 100%);
  
  /* Deep Inset Shadow */
  box-shadow: 
    inset 0 2px 4px rgba(0, 0, 0, 0.9),
    inset 0 1px 2px rgba(0, 0, 0, 0.8);
    
  border-top: 1px solid rgba(0, 0, 0, 0.8);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-left: 1px solid rgba(0, 0, 0, 0.5);
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  
  transform: translateY(1px);
  color: rgba(255, 255, 255, 0.9);
}

/* === LED INDICATORS (Enhanced Glow) === */

/* Ring (for Circle) */
.led-ring {
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: all 0.1s;
}

.led-ring.led-red { border-color: var(--led-red-recording); box-shadow: 0 0 8px var(--led-red-recording), inset 0 0 4px var(--led-red-recording); }
.led-ring.led-green { border-color: var(--led-green-playing); box-shadow: 0 0 8px var(--led-green-playing), inset 0 0 4px var(--led-green-playing); }
.led-ring.led-yellow { border-color: var(--led-yellow-overdub); box-shadow: 0 0 8px var(--led-yellow-overdub), inset 0 0 4px var(--led-yellow-overdub); }
.led-ring.led-blue { border-color: var(--led-blue-accent); box-shadow: 0 0 8px var(--led-blue-accent), inset 0 0 4px var(--led-blue-accent); }
.led-ring.led-purple { border-color: #a855f7; box-shadow: 0 0 8px #a855f7, inset 0 0 4px #a855f7; }
.led-ring.led-white { border-color: var(--led-white-neutral); box-shadow: 0 0 8px var(--led-white-neutral), inset 0 0 4px var(--led-white-neutral); }

/* Dot (for Rect) */
.led-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 8px;
  background: #333;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.8);
  transition: all 0.1s;
}

.led-dot.led-red { background: var(--led-red-recording); box-shadow: 0 0 6px var(--led-red-recording); }
.led-dot.led-green { background: var(--led-green-playing); box-shadow: 0 0 6px var(--led-green-playing); }
.led-dot.led-yellow { background: var(--led-yellow-overdub); box-shadow: 0 0 6px var(--led-yellow-overdub); }
.led-dot.led-blue { background: var(--led-blue-accent); box-shadow: 0 0 6px var(--led-blue-accent); }
.led-dot.led-purple { background: #a855f7; box-shadow: 0 0 6px #a855f7; }
.led-dot.led-white { background: var(--led-white-neutral); box-shadow: 0 0 6px var(--led-white-neutral); }

/* Label */
.button-label {
  font-family: var(--font-hardware);
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  pointer-events: none;
}
</style>
