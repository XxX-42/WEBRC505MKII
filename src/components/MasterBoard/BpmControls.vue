<template>
  <div class="track-background">
    <!-- 效果器标题 -->
    <div class="Bpm-title">TEMPO</div>

    <div class="Bpm-container">
      <!-- 节拍器启停按钮 -->
      <button
          class="metronome-toggle"
          :class="{ active: metronomeActive }"
          @mousedown="toggleMetronome"
      >
        {{ metronomeActive ? '■ 停止 METRO' : '▶ 开始 METRO' }}
      </button>

      <!-- BPM 输入 -->
      <div class="bpm-control">
        <label>BPM</label>
        <input
            type="number"
            v-model.number="bpm"
            min="40"
            max="300"
        />
      </div>

      <!-- 选择输出设备 -->
      <div class="output-select">
        <el-select
            v-model="selectedOutputId"
            placeholder="请选择节拍器输出设备"
            style="width: 200px;"
        >
          <el-option
              v-for="item in outputDevices"
              :key="item.deviceId"
              :label="item.label"
              :value="item.deviceId"
          />
        </el-select>
      </div>

      <!-- 指示器与音量控制 -->
      <div class="metronome-indicator">
        <!-- 闪烁灯 -->
        <div
            class="light"
            :class="isFlashing ? (currentBeat === 1 ? 'flashstart' : 'flashnormal') : ''"
        ></div>

        <!-- 音量推子 -->
        <div class="volume-control">
          <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              v-model.number="volume"
              @input="updateVolume"
          />
          <span>{{ Math.round(volume * 100) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import normalAudioSrc from '@/assets/audios/onshotMetronome.wav?url'
import startAudioSrc  from '@/assets/audios/onshotMetronomestart.wav?url'


// ---------------------------
// 1. 节拍器内部状态
// ---------------------------
const metronomeActive = ref(false)      // 本组件维护启停
const bpm = ref(window.myGlobalState.bpm) // 本地 BPM，初始值来自全局
const volume = ref(0.3)                // 默认音量

/**
 * 监听 bpm 值：自动校正范围并更新全局 BPM。
 * 若节拍器正在运行，则将新的 BPM 存到 pendingBpm，下一个拍点应用。
 */
watch(
    bpm,
    (newVal) => {
      const clamped = Math.max(40, Math.min(300, newVal))
      if (clamped !== newVal) {
        bpm.value = clamped
      }
      // 更新全局 BPM
      window.myGlobalState.updateBpm(clamped)

      // 如果节拍器正在运行，更新 pendingBpm
      if (metronomeActive.value) {
        pendingBpm.value = clamped
      }
    },
    { immediate: true }
)

// ---------------------------
// 2. Audio 对象 & 音量控制
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
// 3. 选择输出设备
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
          label: d.label || `输出设备 ${d.deviceId}`
        }))
  } catch (error) {
    console.error('Error fetching audio output devices:', error)
  }
})

watch(selectedOutputId, (newId) => {
  if (!newId) return
  if (typeof normalAudio.setSinkId === 'function') {
    normalAudio.setSinkId(newId).catch(err => console.error('normalAudio sink:', err))
  }
  if (typeof startAudio.setSinkId === 'function') {
    startAudio.setSinkId(newId).catch(err => console.error('startAudio sink:', err))
  }
})

// ---------------------------
// 4. 节拍器逻辑
// ---------------------------
let beatTimer: number | null = null
const isFlashing = ref(false)
const currentBeat = ref(0)
let measureCount = 1 // 一小节内的拍号（1~4）

const currentBpm = ref(bpm.value)         // 当前生效的 BPM
const pendingBpm = ref<number | null>(null) // 下次拍点要更新的 BPM

/**
 * 播放一次节拍 & 闪烁
 * 若 measureCount === 1，则播放音头并派发 downbeat 事件
 * 否则播放普通音频
 */
function playBeat() {
  currentBeat.value = measureCount

  const intervalMs = 60000 / currentBpm.value
  const flashDuration = intervalMs * 0.2

  if (measureCount === 1) {
    // 播放音头
    startAudio.currentTime = 0
    startAudio.play().catch(err => console.error(err))
    // 派发 downbeat 事件
    window.dispatchEvent(new CustomEvent('downbeat'))

    // 红色闪烁
    isFlashing.value = true
    setTimeout(() => {
      isFlashing.value = false
    }, flashDuration)
  } else {
    // 播放普通音
    normalAudio.currentTime = 0
    normalAudio.play().catch(err => console.error(err))

    // 绿色闪烁
    isFlashing.value = true
    setTimeout(() => {
      isFlashing.value = false
    }, flashDuration)
  }

  measureCount++
  if (measureCount > 4) measureCount = 1
}

/** 启动节拍器 */
function startMetronome() {
  stopMetronome() // 先清理旧定时器

  currentBpm.value = bpm.value
  pendingBpm.value = null
  measureCount = 1

  // 立即播放第一拍
  playBeat()

  // 启动定时器
  const intervalMs = 60000 / currentBpm.value
  beatTimer = window.setInterval(() => {
    playBeat()

    // 如果 pendingBpm 有新值，下一拍重启定时器
    if (pendingBpm.value !== null && pendingBpm.value !== currentBpm.value) {
      currentBpm.value = pendingBpm.value
      pendingBpm.value = null
      restartTimer()
    }
  }, intervalMs)
}

/** 重启定时器 */
function restartTimer() {
  if (beatTimer) {
    clearInterval(beatTimer)
    beatTimer = null
  }
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

/** 停止节拍器 */
function stopMetronome() {
  if (beatTimer) {
    clearInterval(beatTimer)
    beatTimer = null
  }
  isFlashing.value = false
  currentBeat.value = 0
  measureCount = 1
}

/** 切换节拍器状态 */
function toggleMetronome(e: Event) {
  e.stopPropagation()
  metronomeActive.value = !metronomeActive.value
  if (metronomeActive.value) {
    startMetronome()
  } else {
    stopMetronome()
  }
}

// 组件卸载时停止节拍器
onBeforeUnmount(() => {
  stopMetronome()
})
</script>

<style scoped>
.Bpm-title {
  color: #bbb;
  font-weight: bold;
  font-size: 1.1rem;
  text-transform: uppercase;
  margin-bottom: 0.6rem;
}

.Bpm-container {
  background: #333;
  padding: 1rem;
  border-radius: 12px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);

  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;

  gap: 1rem;
  width: 190px;
}

.output-select {
  margin-bottom: 1rem;
  display: flex;
  justify-content: center;
}

.metronome-indicator {
  display: inline-block;
  margin-left: 1rem;
}

.light {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #888;
  transition: background 0.1s;
}

.flashstart {
  background: red;
}

.flashnormal {
  background: #55ff55;
}

.volume-control {
  margin-top: 1rem;
  display: flex;
  align-items: center;
}
.volume-control input[type="range"] {
  margin-right: 0.5rem;
}

/* 节拍器按钮样式 */
.metronome-toggle {
  padding: 0.5rem 1rem;
  cursor: pointer;
  border: none;
  border-radius: 6px;
  color: #fff;
  background-color: #444;
  transition: background-color 0.2s;
}
.metronome-toggle.active {
  background-color: #888;
}
</style>
