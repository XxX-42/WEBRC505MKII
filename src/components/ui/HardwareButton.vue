<template>
  <button
    :class="[
      'hardware-button',
      'hardware-interactive',
      `size-${size}`,
      `color-${color}`,
      `shape-${shape}`,
      `appearance-${appearance}`,
      { 'is-disabled': disabled },
      { 'active': isActive }
    ]"
    type="button"
    :disabled="disabled"
    :aria-label="computedAriaLabel"
    :aria-description="disabled && disabledReason ? disabledReason : undefined"
    :title="disabled ? (disabledReason || computedAriaLabel) : undefined"
    @pointerdown="handlePointerDown"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerCancel"
    @lostpointercapture="handleLostPointerCapture"
    @click="handleClick"
    @keydown="handleKeyDown"
    @keyup="handleKeyUp"
    @blur="cancelKeyboardPress"
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
import { computed, onUnmounted, ref, watch } from 'vue';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  color?: 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'white' | 'neutral';
  active?: boolean;
  disabled?: boolean;
  label?: string;
  shape?: 'circle' | 'rect';
  ariaLabel?: string;
  appearance?: 'standard' | 'classic';
  disabledReason?: string;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  color: 'neutral',
  active: false,
  disabled: false,
  label: '',
  shape: 'circle',
  ariaLabel: '',
  appearance: 'standard',
  disabledReason: '',
});

const emit = defineEmits<{
  (e: 'press'): void;
  (e: 'release'): void;
  (e: 'cancel'): void;
}>();

const isPressed = ref(false);
const activeInteraction = ref<'pointer' | 'keyboard' | null>(null);
const activePointerId = ref<number | null>(null);
const activeKey = ref<string | null>(null);
const suppressNextClick = ref(false);
let suppressClickTimer: number | null = null;

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

const clearClickSuppression = () => {
  suppressNextClick.value = false;
  if (suppressClickTimer !== null) {
    window.clearTimeout(suppressClickTimer);
    suppressClickTimer = null;
  }
};

const suppressGeneratedClick = () => {
  clearClickSuppression();
  suppressNextClick.value = true;
  suppressClickTimer = window.setTimeout(() => {
    suppressNextClick.value = false;
    suppressClickTimer = null;
  }, 0);
};

const finishInteraction = (cancelled: boolean) => {
  if (!activeInteraction.value) return;
  activeInteraction.value = null;
  activePointerId.value = null;
  activeKey.value = null;
  isPressed.value = false;
  if (cancelled) {
    emit('cancel');
  } else {
    emit('release');
    suppressGeneratedClick();
  }
};

const handlePointerDown = (event: PointerEvent) => {
  if (props.disabled || event.button !== 0 || event.isPrimary === false || activeInteraction.value) return;
  // Focus is explicit below; the browser's later default focus must not pull
  // focus back out of a screen editor opened by this press.
  if (event.cancelable) event.preventDefault();
  activeInteraction.value = 'pointer';
  activePointerId.value = event.pointerId;
  isPressed.value = true;
  const target = event.currentTarget as HTMLButtonElement | null;
  // Editors can open synchronously from press, before the browser's default
  // pointer focus. Establish the opener first so closing returns focus here.
  target?.focus({ preventScroll: true });
  try {
    target?.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture is unavailable in some browser and test environments.
  }
  emit('press');
};

const handlePointerUp = (event: PointerEvent) => {
  if (activeInteraction.value !== 'pointer' || activePointerId.value !== event.pointerId) return;
  const target = event.currentTarget as HTMLButtonElement | null;
  const pointerId = activePointerId.value;
  finishInteraction(false);
  try {
    if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
  } catch {
    // A browser may already have released capture before dispatching pointerup.
  }
};

const handlePointerCancel = (event: PointerEvent) => {
  if (activeInteraction.value === 'pointer' && activePointerId.value === event.pointerId) {
    finishInteraction(true);
  }
};

const handleLostPointerCapture = (event: PointerEvent) => {
  if (activeInteraction.value === 'pointer' && activePointerId.value === event.pointerId) {
    finishInteraction(true);
  }
};

const isActivationKey = (key: string) => key === 'Enter' || key === ' ' || key === 'Spacebar';

const handleKeyDown = (event: KeyboardEvent) => {
  if (!isActivationKey(event.key)) return;
  event.preventDefault();
  if (props.disabled || event.repeat || activeInteraction.value) return;
  activeInteraction.value = 'keyboard';
  activeKey.value = event.key;
  isPressed.value = true;
  emit('press');
};

const handleKeyUp = (event: KeyboardEvent) => {
  if (!isActivationKey(event.key)) return;
  event.preventDefault();
  if (activeInteraction.value !== 'keyboard' || activeKey.value !== event.key) return;
  finishInteraction(false);
};

const cancelKeyboardPress = () => {
  if (activeInteraction.value === 'keyboard') finishInteraction(true);
};

const handleClick = (event: MouseEvent) => {
  if (props.disabled) return;
  // Pointer activation was handled on pointerdown/up. Its compatibility click
  // may arrive after timers have run, so a zero-ms suppression flag is not
  // enough. Keep detail=0 activation for assistive/programmatic click input.
  if (event.detail > 0) {
    clearClickSuppression();
    return;
  }
  if (suppressNextClick.value) {
    clearClickSuppression();
    return;
  }
  emit('press');
  emit('release');
};

watch(() => props.disabled, (disabled) => {
  if (disabled && activeInteraction.value) finishInteraction(true);
});

onUnmounted(() => {
  if (activeInteraction.value) finishInteraction(true);
  clearClickSuppression();
});
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
  background: var(--bg-button-gradient);
  
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
  color: var(--text-primary);
}

.hardware-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.hardware-button.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
  filter: grayscale(0.65);
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
  background: var(--bg-button-active);
  
  /* Deep Inset Shadow */
  box-shadow: 
    inset 0 2px 4px rgba(0, 0, 0, 0.9),
    inset 0 1px 2px rgba(0, 0, 0, 0.8);
    
  border-top: 1px solid rgba(0, 0, 0, 0.8);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-left: 1px solid rgba(0, 0, 0, 0.5);
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  
  transform: translateY(1px);
  color: var(--text-primary);
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

/* Lit hardware keys fill with their LED color; keep the legend above the glow. */
.hardware-button.active:not(.is-disabled),
.hardware-button:active:not(.is-disabled) {
  transform: translateY(1px);
}
.hardware-button.active:not(.is-disabled) .button-label,
.hardware-button:active:not(.is-disabled) .button-label {
  position: relative;
  z-index: 2;
  color: #111318;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.28);
}
.hardware-button.active.color-red:not(.is-disabled),
.hardware-button:active.color-red:not(.is-disabled) {
  background: linear-gradient(145deg, #ff9aa5 0%, #ff4259 42%, #a90c2b 100%) !important;
  border: 1px solid rgba(255, 221, 225, 0.9);
  box-shadow: 0 0 8px rgba(255, 42, 72, 0.9), 0 0 20px rgba(255, 31, 64, 0.68), inset 0 0 12px rgba(255, 248, 248, 0.42), inset 0 -5px 12px rgba(86, 0, 16, 0.58);
}
.hardware-button.active.color-green:not(.is-disabled),
.hardware-button:active.color-green:not(.is-disabled) {
  background: linear-gradient(145deg, #a4ffc5 0%, #48f28a 42%, #0e8b49 100%) !important;
  border: 1px solid rgba(224, 255, 235, 0.92);
  box-shadow: 0 0 8px rgba(48, 255, 132, 0.92), 0 0 20px rgba(22, 236, 111, 0.68), inset 0 0 12px rgba(246, 255, 249, 0.42), inset 0 -5px 12px rgba(0, 66, 31, 0.54);
}
.hardware-button.active.color-yellow:not(.is-disabled),
.hardware-button:active.color-yellow:not(.is-disabled) {
  background: linear-gradient(145deg, #ffe9a0 0%, #ffc43e 42%, #b67507 100%) !important;
  border: 1px solid rgba(255, 248, 213, 0.94);
  box-shadow: 0 0 8px rgba(255, 197, 45, 0.94), 0 0 20px rgba(255, 172, 18, 0.68), inset 0 0 12px rgba(255, 255, 244, 0.4), inset 0 -5px 12px rgba(93, 49, 0, 0.54);
}
.hardware-button.active.color-blue:not(.is-disabled),
.hardware-button:active.color-blue:not(.is-disabled) {
  background: linear-gradient(145deg, #c2efff 0%, #56cfff 42%, #1473af 100%) !important;
  border: 1px solid rgba(227, 249, 255, 0.94);
  box-shadow: 0 0 8px rgba(69, 190, 255, 0.94), 0 0 20px rgba(42, 169, 255, 0.68), inset 0 0 12px rgba(247, 253, 255, 0.44), inset 0 -5px 12px rgba(0, 51, 85, 0.54);
}
.hardware-button.active.color-purple:not(.is-disabled),
.hardware-button:active.color-purple:not(.is-disabled) {
  background: linear-gradient(145deg, #e1bdff 0%, #b979ff 42%, #6835ad 100%) !important;
  border: 1px solid rgba(244, 230, 255, 0.94);
  box-shadow: 0 0 8px rgba(181, 112, 255, 0.92), 0 0 20px rgba(162, 78, 255, 0.66), inset 0 0 12px rgba(250, 244, 255, 0.42), inset 0 -5px 12px rgba(43, 7, 84, 0.56);
}
.hardware-button.active.color-white:not(.is-disabled),
.hardware-button:active.color-white:not(.is-disabled),
.hardware-button.active.color-neutral:not(.is-disabled),
.hardware-button:active.color-neutral:not(.is-disabled) {
  background: linear-gradient(145deg, #ffffff 0%, #dbe5f2 48%, #8794a7 100%) !important;
  border: 1px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 8px rgba(225, 240, 255, 0.9), 0 0 18px rgba(190, 220, 255, 0.6), inset 0 0 12px rgba(255, 255, 255, 0.55), inset 0 -5px 12px rgba(34, 47, 68, 0.35);
}

/* Classic faceplate caps transmit the selected LED color through the whole key. */
.hardware-button.appearance-classic {
  border: 1px solid #090a0d;
  color: #dedde2;
  background: linear-gradient(180deg, #383840, #17181d 66%, #101115);
  box-shadow: inset 0 1px rgba(255,255,255,.16), inset 0 -2px rgba(0,0,0,.7), 0 2px 3px rgba(0,0,0,.76);
  transition: transform .08s ease, box-shadow .1s ease, background .1s ease;
}
.hardware-button.appearance-classic.shape-rect { border-radius: 5px; }
.hardware-button.appearance-classic .led-dot { display: none; }
.hardware-button.appearance-classic .led-ring { border-width: 1px; inset: 5px; }
.hardware-button.appearance-classic .button-label { letter-spacing: .08em; }
.hardware-button.appearance-classic.active.color-red:not(.is-disabled),
.hardware-button.appearance-classic:active.color-red:not(.is-disabled) {
  color: #291015;
  background: linear-gradient(155deg, #ffb5ba 0%, #ff4d5d 45%, #9e162b 100%) !important;
  border-color: #ffced1;
  box-shadow: 0 0 7px rgba(255,57,77,.95), 0 0 18px rgba(255,35,61,.62), inset 0 1px rgba(255,255,255,.66), inset 0 -4px 9px rgba(75,0,8,.55);
}
.hardware-button.appearance-classic.active.color-green:not(.is-disabled),
.hardware-button.appearance-classic:active.color-green:not(.is-disabled) {
  color: #082512;
  background: linear-gradient(155deg, #c1ffd4 0%, #41ee84 46%, #08763c 100%) !important;
  border-color: #d3ffe1;
  box-shadow: 0 0 7px rgba(56,255,131,.92), 0 0 18px rgba(25,236,111,.62), inset 0 1px rgba(255,255,255,.68), inset 0 -4px 9px rgba(0,67,29,.56);
}
.hardware-button.appearance-classic.active.color-yellow:not(.is-disabled),
.hardware-button.appearance-classic:active.color-yellow:not(.is-disabled) {
  color: #2a1b04;
  background: linear-gradient(155deg, #fff0bd 0%, #ffd24f 46%, #9d6706 100%) !important;
  border-color: #fff7d8;
  box-shadow: 0 0 7px rgba(255,207,68,.9), 0 0 18px rgba(255,183,35,.6), inset 0 1px rgba(255,255,255,.65), inset 0 -4px 9px rgba(74,44,0,.54);
}
.hardware-button.appearance-classic.active.color-blue:not(.is-disabled),
.hardware-button.appearance-classic:active.color-blue:not(.is-disabled) {
  color: #071d31;
  background: linear-gradient(155deg, #c1ecff 0%, #54c8ff 46%, #12558a 100%) !important;
  border-color: #e1f6ff;
  box-shadow: 0 0 7px rgba(79,195,255,.88), 0 0 18px rgba(42,169,255,.56), inset 0 1px rgba(255,255,255,.65), inset 0 -4px 9px rgba(0,44,74,.54);
}
.hardware-button.appearance-classic.is-disabled { filter: grayscale(.55); opacity: .64; }
.hardware-button.appearance-classic.is-disabled .button-label {
  color: #f1f2f5;
  text-shadow: 0 1px 1px #090a0d;
}
</style>
