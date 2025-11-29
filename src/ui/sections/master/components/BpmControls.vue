<template>
  <div class="bpm-panel">
    <!-- 效果器标题 -->
    <div class="panel-label">RHYTHM</div>

    <div class="bpm-container">
      <!-- 1. 节拍器启停按钮 (Glowing Button) -->
      <button
          class="metronome-btn"
          :class="{ 
            active: metronomeState === 'PLAYING',
            ready: metronomeState === 'READY'
          }"
          @mousedown="toggleMetronome"
      >
        <div class="btn-led"></div>
        <span class="btn-text">{{ buttonTextShort }}</span>
      </button>

      <!-- 2. BPM Display (LCD Style) -->
      <div class="lcd-display">
        <label>BPM</label>
        <input
            type="number"
            v-model.number="bpm"
            min="40"
            max="300"
            class="bpm-input"
        />
      </div>

      <!-- 3. Output Select (Dark Dropdown) -->
      <div class="device-select-container">
        <select v-model="selectedOutputId" class="device-select">
          <option value="" disabled selected>Output Device</option>
          <option
              v-for="item in outputDevices"
              :key="item.deviceId"
              :value="item.deviceId"
          >
            {{ item.label }}
          </option>
        </select>
      </div>

      <!-- 4. Volume Slider (Fader Style) -->
      <div class="volume-control">
        <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            v-model.number="volume"
            @input="updateVolume"
            class="volume-slider"
        />
        <!-- Visual Indicator -->
        <div class="beat-led" :class="{ flash: isFlashing, downbeat: currentBeat === 1 && isFlashing }"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import normalAudioSrc from '@/assets/audios/onshotMetronome.wav?url'
import startAudioSrc  from '@/assets/audios/onshotMetronomestart.wav?url'
import { useAudioStore } from '@/stores/audio';

// ---------------------------
// 1. 节拍器内部状态
// ---------------------------
const audioStore = useAudioStore();
const bpm = ref(audioStore.bpm)
const volume = ref(0.3)

const metronomeState = computed({
    get: () => audioStore.metronomeStatus,
    set: (val) => audioStore.setMetronomeStatus(val)
});

const currentBpm = ref(bpm.value)
const pendingBpm = ref<number | null>(null)

watch(bpm, (newVal) => {
    const clamped = Math.max(40, Math.min(300, newVal))
    if (clamped !== newVal) bpm.value = clamped
    audioStore.setBpm(clamped);
    if (window.myGlobalState) window.myGlobalState.updateBpm(clamped);
    if (metronomeState.value === 'PLAYING') pendingBpm.value = clamped
}, { immediate: true })

watch(() => audioStore.bpm, (newBpm) => {
    if (bpm.value !== newBpm) bpm.value = newBpm;
});

// ---------------------------
// 2. Audio & Volume
// ---------------------------
const normalAudio = new Audio(normalAudioSrc)
normalAudio.preload = 'auto'
const startAudio = new Audio(startAudioSrc)
startAudio.preload = 'auto'

function updateVolume() {
  normalAudio.volume = volume.value
  startAudio.volume = volume.value
}

onMounted(() => {
  normalAudio.load()
  startAudio.load()
  updateVolume()
})

// ---------------------------
// 3. Output Devices
// ---------------------------
const outputDevices = ref<Array<{ deviceId: string; label: string }>>([])
const selectedOutputId = ref('')

onMounted(async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    outputDevices.value = devices
        .filter(d => d.kind === 'audiooutput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Device ${d.deviceId.slice(0, 5)}...`
        }))
  } catch (error) {
    console.error('Error fetching audio output devices:', error)
  }
})

watch(selectedOutputId, (newId) => {
  if (!newId) return
  if (typeof normalAudio.setSinkId === 'function') normalAudio.setSinkId(newId).catch(console.error)
  if (typeof startAudio.setSinkId === 'function') startAudio.setSinkId(newId).catch(console.error)
})

// ---------------------------
// 4. Metronome Logic
// ---------------------------
let beatTimer: number | null = null
const isFlashing = ref(false)
const currentBeat = ref(0)
let measureCount = 1

function playBeat() {
  currentBeat.value = measureCount
  const intervalMs = 60000 / currentBpm.value
  const flashDuration = intervalMs * 0.2

  if (measureCount === 1) {
    startAudio.currentTime = 0
    startAudio.play().catch(console.error)
    window.dispatchEvent(new CustomEvent('downbeat'))
  } else {
    normalAudio.currentTime = 0
    normalAudio.play().catch(console.error)
  }

  isFlashing.value = true
  setTimeout(() => { isFlashing.value = false }, flashDuration)

  measureCount++
  if (measureCount > 4) measureCount = 1
}

function startMetronome() {
  stopMetronome()
  currentBpm.value = bpm.value
  pendingBpm.value = null
  measureCount = 1
  playBeat()
  const intervalMs = 60000 / currentBpm.value
  beatTimer = window.setInterval(() => {
    playBeat()
    if (pendingBpm.value !== null && pendingBpm.value !== currentBpm.value) {
      currentBpm.value = pendingBpm.value
      pendingBpm.value = null
      restartTimer()
    }
  }, intervalMs)
}

function restartTimer() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null }
  const intervalMs = 60000 / currentBpm.value
  beatTimer = window.setInterval(() => {
    playBeat()
    if (pendingBpm.value !== null && pendingBpm.value !== currentBpm.value) {
      currentBpm.value = pendingBpm.value
      pendingBpm.value = null
      restartTimer()
    }
  }, intervalMs)
}

function stopMetronome() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null }
  isFlashing.value = false
  currentBeat.value = 0
  measureCount = 1
}

function toggleMetronome(e: Event) {
  e.stopPropagation()
  if (metronomeState.value === 'OFF') {
    metronomeState.value = 'READY';
    stopMetronome();
    startBlinkingReady();
  } else if (metronomeState.value === 'READY') {
    metronomeState.value = 'PLAYING';
    stopBlinkingReady();
    startMetronome();
  } else {
    metronomeState.value = 'OFF';
    stopMetronome();
    stopBlinkingReady();
  }
}

watch(() => audioStore.metronomeStatus, (newStatus) => {
    if (newStatus === 'PLAYING') {
        if (!beatTimer) { stopBlinkingReady(); startMetronome(); }
    } else if (newStatus === 'OFF') {
        stopMetronome(); stopBlinkingReady();
    } else if (newStatus === 'READY') {
        stopMetronome(); startBlinkingReady();
    }
});

let readyBlinkTimer: number | null = null;
function startBlinkingReady() {
  if (readyBlinkTimer) clearInterval(readyBlinkTimer);
  readyBlinkTimer = window.setInterval(() => { isFlashing.value = !isFlashing.value }, 500);
}
function stopBlinkingReady() {
  if (readyBlinkTimer) { clearInterval(readyBlinkTimer); readyBlinkTimer = null }
  isFlashing.value = false;
}

const buttonTextShort = computed(() => {
  switch (metronomeState.value) {
    case 'OFF': return 'START';
    case 'READY': return 'READY';
    case 'PLAYING': return 'STOP';
  }
});

onBeforeUnmount(() => {
  stopMetronome();
  stopBlinkingReady();
})
</script>

<style scoped>
.bpm-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.panel-label {
  color: #888;
  font-size: 0.8rem;
  font-weight: bold;
  letter-spacing: 1px;
}

.bpm-container {
  background: #1a1a1a;
  padding: 1rem;
  border-radius: 8px;
  border: 1px solid #333;
  box-shadow: inset 0 0 10px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  width: 140px;
}

/* 1. Metronome Button */
.metronome-btn {
  background: #333;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 0.5rem;
  color: #aaa;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  transition: all 0.2s;
  box-shadow: 0 2px 0 #000;
}
.metronome-btn:active {
  transform: translateY(2px);
  box-shadow: none;
}
.metronome-btn.active {
  background: #3a3;
  color: #000;
  border-color: #5f5;
  box-shadow: 0 0 10px #3f3;
}
.metronome-btn.ready {
  background: #aa3;
  color: #000;
  animation: pulse-ready 1s infinite;
}
.btn-led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #555;
}
.metronome-btn.active .btn-led { background: #fff; box-shadow: 0 0 5px #fff; }
.metronome-btn.ready .btn-led { background: #ff0; }

@keyframes pulse-ready {
  0% { opacity: 1; }
  50% { opacity: 0.6; }
  100% { opacity: 1; }
}

/* 2. LCD Display */
.lcd-display {
  background: #000;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.lcd-display label {
  font-size: 0.6rem;
  color: #555;
  margin-bottom: -2px;
}
.bpm-input {
  background: transparent;
  border: none;
  color: #f00; /* Red LED style */
  font-family: 'Courier New', monospace;
  font-size: 1.5rem;
  font-weight: bold;
  text-align: center;
  width: 100%;
  outline: none;
  text-shadow: 0 0 5px #f00;
}

/* 3. Device Select */
.device-select {
  width: 100%;
  background: #222;
  color: #ccc;
  border: 1px solid #444;
  padding: 0.3rem;
  border-radius: 4px;
  font-size: 0.7rem;
  outline: none;
}

/* 4. Volume Slider & LED */
.volume-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.volume-slider {
  flex: 1;
  -webkit-appearance: none;
  height: 4px;
  background: #333;
  border-radius: 2px;
  outline: none;
}
.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #888;
  cursor: pointer;
  box-shadow: 0 0 2px #000;
}
.beat-led {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #330000;
  border: 1px solid #222;
}
.beat-led.flash {
  background: #00ff00;
  box-shadow: 0 0 5px #00ff00;
}
.beat-led.downbeat {
  background: #ff0000;
  box-shadow: 0 0 8px #ff0000;
}
</style>
