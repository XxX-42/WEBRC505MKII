<template>
  <div class="hardware-fader hardware-interactive">
    <!-- Fader Track Container -->
    <div class="fader-track-container">
      <!-- LED Strip (Left Side) -->
      <div class="led-strip">
        <div 
          class="led-fill" 
          :style="{ height: `${valuePercent}%` }"
          :class="ledColorClass"
        ></div>
      </div>
      
      <!-- Fader Groove (Center) -->
      <div class="fader-groove">
        <input
          type="range"
          :min="min"
          :max="max"
          :value="liveValue"
          @input="handleInput"
          class="fader-input"
          orient="vertical"
        />
        
        <!-- Fader Cap -->
        <div 
          class="fader-cap" 
          :style="{ bottom: `${valuePercent}%` }"
        >
          <div class="cap-ridge"></div>
          <div class="cap-ridge"></div>
          <div class="cap-ridge"></div>
        </div>
      </div>
    </div>
    
    <!-- Value Display -->
    <div class="fader-value">{{ displayValue }}</div>
    
    <!-- Label -->
    <div v-if="label" class="fader-label">{{ label }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

interface Props {
  modelValue: number;
  min?: number;
  max?: number;
  label?: string;
  ledColor?: 'red' | 'green' | 'yellow' | 'blue' | 'white';
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 100,
  label: '',
  ledColor: 'green'
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

const liveValue = ref(props.modelValue);

watch(() => props.modelValue, (value) => {
  liveValue.value = value;
});

const valuePercent = computed(() => {
  return ((liveValue.value - props.min) / (props.max - props.min)) * 100;
});

const displayValue = computed(() => {
  return Math.round(liveValue.value);
});

const ledColorClass = computed(() => {
  switch (props.ledColor) {
    case 'red': return 'led-strip-red';
    case 'green': return 'led-strip-green';
    case 'yellow': return 'led-strip-yellow';
    case 'blue': return 'led-strip-blue';
    case 'white': return 'led-strip-white';
    default: return 'led-strip-green';
  }
});

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const rawValue = parseFloat(target.value);
  liveValue.value = rawValue;
  emit('update:modelValue', rawValue);
};
</script>

<style scoped>
.hardware-fader {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  gap: 8px;
}

.fader-track-container {
  position: relative;
  display: flex;
  justify-content: center;
  gap: 8px;
  flex: 1; /* Fill available height */
  width: 100%;
  min-height: 120px;
}

/* === LED STRIP === */
.led-strip {
  position: relative;
  width: 4px;
  height: 100%;
  background: var(--bg-groove-dark);
  border-radius: 2px;
  overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.8);
}

.led-fill {
  position: absolute;
  bottom: 0;
  width: 100%;
  border-radius: 2px;
  will-change: height;
}

.led-strip-red { background: var(--led-red-recording); box-shadow: var(--glow-red-soft); }
.led-strip-green { background: var(--led-green-playing); box-shadow: var(--glow-green-soft); }
.led-strip-yellow { background: var(--led-yellow-overdub); box-shadow: var(--glow-yellow-soft); }
.led-strip-blue { background: var(--led-blue-accent); box-shadow: var(--glow-blue-soft); }
.led-strip-white { background: var(--led-white-neutral); box-shadow: var(--glow-white-soft); }

/* === GROOVE & CAP === */
.fader-groove {
  position: relative;
  width: 12px; /* Narrower groove */
  height: 100%;
  background: #050505;
  border-radius: 6px;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.9), 0 1px 0 rgba(255,255,255,0.05);
}

.fader-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 10;
  writing-mode: vertical-lr;
  direction: rtl;
  appearance: none;
}

.fader-cap {
  position: absolute;
  left: 50%;
  transform: translate(-50%, 50%);
  width: 24px;
  height: 36px;
  background: linear-gradient(180deg, #333 0%, #1a1a1a 100%);
  border-radius: 2px;
  box-shadow: 
    0 4px 8px rgba(0,0,0,0.8),
    inset 0 1px 0 rgba(255,255,255,0.1);
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 3px;
  will-change: bottom;
}

.cap-ridge {
  width: 16px;
  height: 1px;
  background: rgba(0,0,0,0.5);
  border-bottom: 1px solid rgba(255,255,255,0.1);
}

/* === LABELS === */
.fader-value {
  font-family: var(--font-mono);
  font-size: 11px;
  color: #888;
  background: #080808;
  padding: 2px 6px;
  border-radius: 3px;
  min-width: 32px;
  text-align: center;
}

.fader-label {
  font-family: var(--font-hardware);
  font-size: 10px;
  color: #555;
  font-weight: 700;
  letter-spacing: 1px;
}
</style>
