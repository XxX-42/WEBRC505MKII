<template>
  <div class="loop-halo-container">
    <canvas 
      ref="canvas" 
      width="128" 
      height="128" 
      class="halo-canvas"
      :class="animationClass"
    ></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { TrackState } from '../core/types';
import { AudioEngine } from '../audio/AudioEngine';

const props = defineProps<{
  trackId: number;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let animationFrame: number;

// Local state for rendering
const currentState = ref<TrackState>(TrackState.EMPTY);
const currentProgress = ref(0);

// Dynamic animation class based on state
const animationClass = computed(() => {
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

  // Read from Shared Buffer
  const engine = AudioEngine.getInstance();
  const trackIndex = props.trackId - 1;
  
  if (engine.trackStates && engine.trackPositions) {
      const stateIdx = Atomics.load(engine.trackStates, trackIndex);
      const stateValues = Object.values(TrackState);
      currentState.value = stateValues[stateIdx] as TrackState;
      
      currentProgress.value = engine.trackPositions[trackIndex] ?? 0;
  }
  
  const w = canvas.value.width;
  const h = canvas.value.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = (w / 2) - 6; // Radius
  
  ctx.clearRect(0, 0, w, h);
  
  // Background Ring (darker, thinner)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 3;
  ctx.stroke();
  
  // Active Ring
  if (currentState.value !== TrackState.EMPTY && currentState.value !== TrackState.STOPPED) {
    let color = '#4b5563';
    let glowIntensity = 15;
    
    if (currentState.value === TrackState.RECORDING) {
      color = '#ff0033'; // var(--led-red-recording)
      glowIntensity = 20;
    } else if (currentState.value === TrackState.REC_STANDBY) {
      // REC_STANDBY: Blinking red (waiting for measure boundary to start)
      const blinkSpeed = 500; // ms per blink cycle
      const blinkPhase = (Date.now() % blinkSpeed) / blinkSpeed;
      const blinkOpacity = 0.3 + (Math.sin(blinkPhase * Math.PI * 2) * 0.7 + 0.7) / 2;
      
      color = `rgba(255, 0, 51, ${blinkOpacity})`;
      glowIntensity = 15 * blinkOpacity;
    } else if (currentState.value === TrackState.REC_FINISHING) {
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
    } else if (currentState.value === TrackState.PLAYING) {
      color = '#00ff66'; // var(--led-green-playing)
      glowIntensity = 18;
    } else if (currentState.value === TrackState.OVERDUBBING) {
      color = '#ffcc00'; // var(--led-yellow-overdub)
      glowIntensity = 18;
    }
    
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + (Math.PI * 2 * currentProgress.value);
    
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
  } else if (currentState.value === TrackState.STOPPED) {
    // Stopped state: dim white ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(240, 240, 240, 0.3)';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  
  animationFrame = requestAnimationFrame(draw);
};

onMounted(() => {
  if (canvas.value) {
    ctx = canvas.value.getContext('2d');
    draw();
  }
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrame);
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
