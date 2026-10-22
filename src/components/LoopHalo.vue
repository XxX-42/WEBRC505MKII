<template>
  <div
    class="loop-halo-container"
    :class="[`appearance-${appearance}`, `mode-${effectiveMode.toLowerCase().replace('_', '-')}`]"
    :data-appearance="appearance"
    :data-indicator-mode="effectiveMode"
    :data-state="currentState ?? 'unavailable'"
    :data-availability="isAvailable ? 'available' : 'unavailable'"
    role="img"
    :aria-label="computedAriaLabel"
  >
    <canvas 
      ref="canvas" 
      width="128" 
      height="128" 
      class="halo-canvas"
      :class="animationClass"
      aria-hidden="true"
    ></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { TrackState } from '../core/types';
import { AudioEngine } from '../audio/AudioEngine';

type Appearance = 'enhanced' | 'classic';
type IndicatorMode = 'STATUS' | 'LOOP_POSITION' | 'LEVEL' | 'LEGACY';
type LedColor = 'off' | 'red' | 'green' | 'yellow' | 'pink' | 'blue' | 'white' | 'purple' | 'cyan';

const props = withDefaults(defineProps<{
  trackId?: number;
  appearance?: Appearance;
  indicatorMode?: Exclude<IndicatorMode, 'LEGACY'>;
  status?: TrackState | null;
  /** Explicit status LED color from the shared control resolver. */
  statusColor?: LedColor | null;
  position?: number | null;
  /** Normalized level from 0 to 1; no engine level meter is inferred. */
  level?: number | null;
  ariaLabel?: string;
}>(), {
  appearance: 'enhanced',
  indicatorMode: undefined,
  status: undefined,
  statusColor: undefined,
  position: undefined,
  level: undefined,
  ariaLabel: '',
});

const canvas = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let animationFrame: number | null = null;

const currentState = ref<TrackState | null>(props.status ?? null);
const currentProgress = ref<number | null>(normalize(props.position));
const currentLevel = computed(() => normalize(props.level));
const effectiveMode = computed<IndicatorMode>(() => props.indicatorMode
  ?? (props.appearance === 'classic' ? 'STATUS' : 'LEGACY'));
const isAvailable = computed(() => {
  if (effectiveMode.value === 'LEVEL') return currentLevel.value !== null;
  if (effectiveMode.value === 'LOOP_POSITION') return currentProgress.value !== null;
  return currentState.value !== null;
});

function normalize(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

const computedAriaLabel = computed(() => {
  if (props.ariaLabel) return props.ariaLabel;
  const trackLabel = props.trackId ? `Track ${props.trackId}` : 'Track';
  if (effectiveMode.value === 'LEVEL') {
    return currentLevel.value === null
      ? `${trackLabel} level unavailable`
      : `${trackLabel} level ${Math.round(currentLevel.value * 100)} percent`;
  }
  if (effectiveMode.value === 'LOOP_POSITION') {
    return currentProgress.value === null
      ? `${trackLabel} loop position unavailable`
      : `${trackLabel} loop position ${Math.round(currentProgress.value * 100)} percent`;
  }
  return `${trackLabel} status ${currentState.value ?? 'unavailable'}`;
});

const animationClass = computed(() => {
  if (props.appearance === 'classic') return '';
  if (effectiveMode.value === 'LEVEL' || effectiveMode.value === 'LOOP_POSITION') return '';
  switch (currentState.value) {
    case TrackState.RECORDING: return 'state-recording';
    case TrackState.REC_STANDBY: return 'state-rec-standby';
    case TrackState.REC_FINISHING: return 'state-rec-finishing';
    case TrackState.PLAYING: return 'state-playing';
    case TrackState.OVERDUBBING: return 'state-overdub';
    case TrackState.STOPPED: return 'state-stopped';
    default: return 'state-empty';
  }
});

const draw = () => {
  if (!ctx || !canvas.value) return;

  readTrackSignals();
  
  const w = canvas.value.width;
  const h = canvas.value.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = (w / 2) - 6; // Radius
  
  ctx.clearRect(0, 0, w, h);
  
  if (props.appearance === 'classic' || effectiveMode.value !== 'LEGACY') {
    drawExplicitIndicator(cx, cy, r);
    animationFrame = requestAnimationFrame(draw);
    return;
  }

  // Enhanced legacy mode intentionally preserves the existing combined ring and animations.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 3;
  ctx.stroke();
  
  // Active Ring
  const state = currentState.value ?? TrackState.EMPTY;
  const progress = currentProgress.value ?? 0;
  if (state !== TrackState.EMPTY && state !== TrackState.STOPPED) {
    let color = '#4b5563';
    let glowIntensity = 15;
    
    if (state === TrackState.RECORDING) {
      color = '#ff0033'; // var(--led-red-recording)
      glowIntensity = 20;
    } else if (state === TrackState.REC_STANDBY) {
      // REC_STANDBY: Blinking red (waiting for measure boundary to start)
      const blinkSpeed = 500; // ms per blink cycle
      const blinkPhase = (Date.now() % blinkSpeed) / blinkSpeed;
      const blinkOpacity = 0.3 + (Math.sin(blinkPhase * Math.PI * 2) * 0.7 + 0.7) / 2;
      
      color = `rgba(255, 0, 51, ${blinkOpacity})`;
      glowIntensity = 15 * blinkOpacity;
    } else if (state === TrackState.REC_FINISHING) {
      // REC_FINISHING: Red/Green alternating blink (finishing recording at measure boundary)
      const blinkSpeed = 300; // ms per blink cycle (faster than standby)
      const blinkPhase = (Date.now() % blinkSpeed) / blinkSpeed;
      
      // Alternate between red and green
      if (blinkPhase < 0.5) {
        color = '#ff0033'; // Red
        glowIntensity = 18;
      } else {
        color = '#00ff66'; // Green
        glowIntensity = 16;
      }
    } else if (state === TrackState.PLAYING) {
      color = '#00ff66'; // var(--led-green-playing)
      glowIntensity = 18;
    } else if (state === TrackState.OVERDUBBING) {
      color = '#ffcc00'; // var(--led-yellow-overdub)
      glowIntensity = 18;
    }
    
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + (Math.PI * 2 * progress);
    
    // Draw progress arc with glow
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    
    // Multiple glow layers for intensity
    ctx.shadowBlur = glowIntensity;
    ctx.shadowColor = color;
    ctx.stroke();
    
    // Second glow layer
    ctx.shadowBlur = glowIntensity * 1.5;
    ctx.stroke();
    
    ctx.shadowBlur = 0;
  } else if (state === TrackState.STOPPED) {
    // Stopped state: dim white ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(240, 240, 240, 0.3)';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  
  animationFrame = requestAnimationFrame(draw);
};

const readTrackSignals = () => {
  const trackIndex = props.trackId === undefined ? -1 : props.trackId - 1;
  const validIndex = Number.isInteger(trackIndex) && trackIndex >= 0;
  const needsStatus = effectiveMode.value === 'LEGACY' || effectiveMode.value === 'STATUS';
  const needsPosition = effectiveMode.value === 'LEGACY' || effectiveMode.value === 'LOOP_POSITION';

  if (props.status !== undefined) {
    currentState.value = props.status;
  } else if (needsStatus && validIndex) {
    const states = AudioEngine.getInstance().trackStates;
    if (!states || trackIndex >= states.length) {
      currentState.value = null;
    } else {
    const stateValues = Object.values(TrackState) as TrackState[];
      const stateIndex = Atomics.load(states, trackIndex);
    currentState.value = stateValues[stateIndex] ?? null;
    }
  } else {
    currentState.value = null;
  }

  if (props.position !== undefined) {
    currentProgress.value = normalize(props.position);
  } else if (needsPosition && validIndex) {
    const positions = AudioEngine.getInstance().trackPositions;
    currentProgress.value = positions && trackIndex < positions.length
      ? normalize(positions[trackIndex])
      : null;
  } else {
    currentProgress.value = null;
  }
};

const drawRing = (cx: number, cy: number, radius: number, color: string, width: number) => {
  if (!ctx) return;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
};

const drawArc = (cx: number, cy: number, radius: number, fraction: number, color: string, width: number) => {
  if (!ctx || fraction <= 0) return;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
};

const LED_PALETTE: Record<Exclude<LedColor, 'off'>, string> = {
  red: '#ff0033',
  green: '#00ff66',
  yellow: '#ffcc00',
  pink: '#ec4899',
  blue: '#3b82f6',
  white: '#f0f0f0',
  purple: '#a855f7',
  cyan: '#22d3ee',
};

const drawExplicitIndicator = (cx: number, cy: number, radius: number) => {
  if (!ctx) return;
  drawRing(cx, cy, radius, '#1a1a1a', 3);

  if (effectiveMode.value === 'STATUS') {
    // Status meaning is resolved by the shared control resolver. Unknown/off
    // remains dark; this component only maps the resolved color to app RGB.
    const statusColor = props.statusColor && props.statusColor !== 'off'
      ? LED_PALETTE[props.statusColor]
      : null;
    if (statusColor) drawRing(cx, cy, radius, statusColor, 4);
    return;
  }

  if (effectiveMode.value === 'LOOP_POSITION') {
    if (currentProgress.value !== null) {
      drawArc(cx, cy, radius, currentProgress.value, '#aeb6c2', 5);
    }
    return;
  }

  if (effectiveMode.value === 'LEVEL' && currentLevel.value !== null) {
    drawArc(cx, cy, radius, currentLevel.value, '#aeb6c2', 5);
  }
};

onMounted(() => {
  if (canvas.value) {
    ctx = canvas.value.getContext('2d');
    draw();
  }
});

onUnmounted(() => {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
});
</script>

<style scoped>
.loop-halo-container {
  position: relative;
  width: 128px;
  height: 128px;
  display: flex;
  align-items: center;
  justify-content: center;
  
  /* CRITICAL: Circular clipping to prevent rotating square from showing */
  border-radius: 50%;
  overflow: hidden;
}

.halo-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  
  /* CRITICAL: Ensure circular canvas and transparent background */
  border-radius: 50%;
  background: transparent;
}

/* ========================================
   ADVANCED LED ANIMATIONS
   ======================================== */

/* RECORDING: Fast Pulse (Heartbeat) */
@keyframes recording-pulse {
  0%, 100% {
    filter: brightness(1) drop-shadow(0 0 8px rgba(255, 0, 51, 0.8));
  }
  50% {
    filter: brightness(1.4) drop-shadow(0 0 20px rgba(255, 0, 51, 1));
  }
}

.state-recording {
  animation: recording-pulse 0.8s ease-in-out infinite;
}

/* REC_STANDBY: Fast Blink (Waiting for Measure) */
@keyframes rec-standby-blink {
  0%, 100% {
    opacity: 0.3;
    filter: brightness(0.6) drop-shadow(0 0 4px rgba(255, 0, 51, 0.4));
  }
  50% {
    opacity: 1;
    filter: brightness(1.2) drop-shadow(0 0 16px rgba(255, 0, 51, 0.9));
  }
}

.state-rec-standby {
  animation: rec-standby-blink 0.5s ease-in-out infinite;
}

/* REC_FINISHING: Red/Green Alternating (Finishing at Measure) */
@keyframes rec-finishing-alternate {
  0%, 49% {
    filter: brightness(1.2) drop-shadow(0 0 12px rgba(255, 0, 51, 0.9));
  }
  50%, 100% {
    filter: brightness(1.2) drop-shadow(0 0 12px rgba(0, 255, 102, 0.9));
  }
}

.state-rec-finishing {
  animation: rec-finishing-alternate 0.3s step-end infinite;
}

/* PLAYING: Smooth Rotation */
@keyframes playing-rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.state-playing {
  /* Removed rotation to keep start angle fixed at 12 o'clock */
  filter: drop-shadow(0 0 8px rgba(0, 255, 102, 0.6));
}

/* OVERDUBBING: Slow Blink */
@keyframes overdub-blink {
  0%, 100% {
    opacity: 1;
    filter: brightness(1) drop-shadow(0 0 10px rgba(255, 204, 0, 0.8));
  }
  50% {
    opacity: 0.5;
    filter: brightness(0.7) drop-shadow(0 0 4px rgba(255, 204, 0, 0.4));
  }
}

.state-overdub {
  animation: overdub-blink 1.5s ease-in-out infinite;
}

/* STOPPED: Gentle Breathing */
@keyframes stopped-breathe {
  0%, 100% {
    opacity: 0.6;
  }
  50% {
    opacity: 0.3;
  }
}

.state-stopped {
  animation: stopped-breathe 3s ease-in-out infinite;
}

/* EMPTY: No animation, very dim */
.state-empty {
  opacity: 0.3;
}
</style>
