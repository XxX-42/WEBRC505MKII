<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Keytomidi from "@/FX/keytomidi.vue";

// 创建音频上下文
const audioContext = new AudioContext()

// MIDI 音符数组（从 C4 到 B5）
const midiNotes = Array.from({ length: 24 }, (_, i) => 60 + i)

// 当前激活音符 Map：键为 midi 编号，值为对应的 AudioBufferSourceNode
const activeNotes = ref<Map<number, AudioBufferSourceNode>>(new Map())

// 鼠标拖动状态
const isDragging = ref(false)

// 当前显示信息（频率、音名、MIDI）
const currentInfo = ref<{ freq: number; midi: number; name: string } | null>(null)

/**
 * MIDI 转频率
 */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * MIDI 转音名（如 C4, F#5）
 */
function midiToNoteName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const name = names[midi % 12]
  const octave = Math.floor(midi / 12) - 1
  return name + octave
}

/**
 * 创建一个 buffer 播放指定频率的正弦波
 */
function createBuffer(freq: number, duration = 2): AudioBuffer {
  const sampleRate = audioContext.sampleRate
  const frameCount = sampleRate * duration
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frameCount; i++) {
    data[i] = Math.sin(2 * Math.PI * freq * i / sampleRate)
  }
  return buffer
}

/**
 * 播放一个音符（支持 polyphony）
 */
function playNote(midi: number) {
  if (activeNotes.value.has(midi)) return // 避免重复播放同一个音
  const freq = midiToFreq(midi)
  const buffer = createBuffer(freq)
  const source = audioContext.createBufferSource()
  source.buffer = buffer
  source.connect(audioContext.destination)
  source.start()
  activeNotes.value.set(midi, source)

  // 更新当前显示信息
  currentInfo.value = {
    freq: Math.round(freq),
    midi,
    name: midiToNoteName(midi)
  }
}

/**
 * 停止播放某个音符
 */
function stopNote(midi: number) {
  const source = activeNotes.value.get(midi)
  if (source) {
    source.stop()
    activeNotes.value.delete(midi)
  }
}

/**
 * 鼠标相关事件
 */
function onMouseDown(midi: number) {
  isDragging.value = true
  playNote(midi)
}
function onMouseUp(midi: number) {
  stopNote(midi)
  isDragging.value = false
}
function onMouseEnter(midi: number) {
  if (isDragging.value) playNote(midi)
}
function onMouseLeave(midi: number) {
  if (isDragging.value) stopNote(midi)
}


// 存储当前收到的 MIDI 信号
const currentMidi = ref<number | null>(null);

// 处理子组件传来的MIDI信号
function handleMidiReceived(midi: number) {
  currentMidi.value = midi;
  playNote(midi);
  console.log(`父组件接收到MIDI信号：${midi}`);
}
// 处理子组件传来的松开 MIDI 信号
function handleMidiStop(midi: number) {
  stopNote(midi);
  console.log(`父组件接收到 MIDI 信号（松开）：${midi}`);
}

</script>

<template>
  <div class="keyboard-container">
    <keytomidi @key-to-midi="handleMidiReceived"
               @key-to-midi-stop="handleMidiStop" />
    <p v-if="currentMidi !== null">
      当前收到的MIDI信号: {{ currentMidi }}
    </p>
    <h2>🎹 虚拟键盘</h2>

    <!-- 显示当前信息 -->
    <div v-if="currentInfo" class="info">
      {{ currentInfo.name }} (MIDI {{ currentInfo.midi }}) - {{ currentInfo.freq }}Hz
    </div>

    <!-- 音符按钮 -->
    <div class="keyboard">
      <button
          v-for="midi in midiNotes"
          :key="midi"
          @mousedown.prevent="onMouseDown(midi)"
          @mouseup.prevent="onMouseUp(midi)"
          @mouseenter="onMouseEnter(midi)"
          @mouseleave="onMouseLeave(midi)"
      >
        {{ midiToNoteName(midi) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.keyboard-container {
  padding: 2rem;
  background: #1a1a1a;
  color: white;
  font-family: sans-serif;
  min-height: 100vh;
}

.keyboard {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
}

button {
  background: #444;
  border: 1px solid #666;
  padding: 1rem;
  color: white;
  font-size: 1rem;
  border-radius: 4px;
  cursor: pointer;
  min-width: 3.5rem;
}
button:hover {
  background: #666;
}

.info {
  margin-bottom: 1rem;
  font-size: 1.2rem;
  color: #00e0ff;
}
</style>
