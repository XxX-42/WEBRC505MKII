<template>
  <div class="loop-indicator-container" :style="{ width: size + 'px', height: size + 'px' }">
    <canvas ref="canvas" :width="size * 2" :height="size * 2"></canvas>
    <div class="content-slot">
      <slot></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, toRefs } from 'vue';

const props = defineProps({
  size: { type: Number, default: 100 },
  progress: { type: Number, default: 0 }, // 0.0 - 1.0
  status: { type: String, default: 'EMPTY' }, // 'EMPTY', 'RECORDING', 'PLAYING', 'OVERDUB', 'STOP'
  waiting: { type: Boolean, default: false },
  bpm: { type: Number, default: 120 },
  hasData: { type: Boolean, default: false } // To distinguish STOP (Empty) vs STOP (Loaded)
});

const { progress, status, waiting, bpm, hasData } = toRefs(props);
const canvas = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let animationFrameId: number;

const draw = () => {
  if (!canvas.value || !ctx) return;
  
  // Canvas actual size (Retina)
  const width = canvas.value.width;
  const height = canvas.value.height;
  
  const centerX = width / 2;
  const centerY = height / 2;
  // Radius based on actual canvas size (which is size * 2)
  // We want the ring to be slightly inside the edge.
  const radius = (width / 2) - 10; 
  const lineWidth = 16; // Thicker line for Retina (8 * 2)

  ctx.clearRect(0, 0, width, height);

  // --- 1. Draw Base Track ---
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = '#222'; // Dark grey base
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  // --- 2. Determine State Visuals ---
  let color = '#555';
  let startAngle = -Math.PI / 2; // Top (12 o'clock)
  let endAngle = startAngle;
  let alpha = 1.0;
  let isRotating = false;

  // Handle Waiting Flashing (BPM synced)
  if (waiting.value) {
    const time = Date.now() / 1000;
    const beatDuration = 60 / bpm.value;
    const flashSpeed = Math.PI * 2 / (beatDuration / 2); // Flash twice per beat
    const flash = Math.sin(time * flashSpeed) * 0.5 + 0.5; // 0 to 1
    alpha = 0.3 + flash * 0.7; // 0.3 to 1.0
  }

  // Normalize status to uppercase for safety
  const currentStatus = status.value.toUpperCase();

  if (currentStatus === 'RECORDING') {
    color = '#ff3333'; // Bright Red
    
    if (progress.value <= 0.001) {
        // Rotating breathing ring
        isRotating = true;
        const time = Date.now() / 1000;
        const rotation = time * Math.PI; // Spin speed
        startAngle = rotation;
        endAngle = rotation + Math.PI * 1.5; // 75% Arc
        
        // Breathing effect on width or alpha
        const breath = Math.sin(time * 4) * 0.2 + 0.8;
        ctx.lineWidth = lineWidth * breath;
    } else {
        endAngle = startAngle + (progress.value * 2 * Math.PI);
    }
  } 
  else if (currentStatus === 'PLAYING') {
    color = '#33ff33'; // Bright Green
    
    // Dim background
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#004400';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Active Arc
    endAngle = startAngle + (progress.value * 2 * Math.PI);
  } 
  else if (currentStatus === 'OVERDUB' || currentStatus === 'OVERLAY') {
    // Green Base + Yellow Overlay
    // Draw Green Playback first
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = '#004400';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Playback Position (Green)
    const playEndAngle = startAngle + (progress.value * 2 * Math.PI);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, playEndAngle);
    ctx.strokeStyle = '#33ff33';
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Yellow Overlay (Translucent)
    color = '#ffff33'; // Yellow
    alpha *= 0.7; // Semi-transparent
    endAngle = playEndAngle; // Follows playback
  } 
  else if (currentStatus === 'STOP') {
    if (hasData.value) {
        color = '#006600'; // Dim Green
        endAngle = startAngle + 2 * Math.PI; // Full circle
    } else {
        // Empty
        color = '#222'; // Base color
        endAngle = startAngle; // No arc
    }
  }
  else if (currentStatus === 'EMPTY') {
      // Just base
      color = '#222';
  }

  // --- 3. Draw Main Arc ---
  if (endAngle !== startAngle) {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, startAngle, endAngle);
      ctx.strokeStyle = color;
      ctx.lineWidth = isRotating ? ctx.lineWidth : lineWidth; // Use modified width if rotating
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1.0;
  }

  animationFrameId = requestAnimationFrame(draw);
};

onMounted(() => {
  if (canvas.value) {
    ctx = canvas.value.getContext('2d');
    draw();
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrameId);
});
</script>

<style scoped>
.loop-indicator-container {
  position: relative;
  /* Width and Height are set via inline style for dynamic sizing */
  display: inline-block; /* Ensure it takes dimensions */
}

canvas {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}

.content-slot {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
