<template>
  <div>
    <!-- 一个简单按钮，用来触发播放音频做测试 -->
    <button @click="playSound">Play Sound</button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

/**
 * 在组件挂载时创建 AudioContext，并初始化
 * 三个节点：GainNode、ConvolverNode（混响）和 DelayNode（延迟）
 */
const audioContext = ref<AudioContext | null>(null)
let gainNode: GainNode
let convolver: ConvolverNode
let delayNode: DelayNode

// 用于测试播放的振荡器
let testOscillator: OscillatorNode | null = null

onMounted(async () => {
  // 1. 创建 AudioContext
  audioContext.value = new AudioContext()

  // 2. 创建增益节点 (GainNode)，用于控制音量
  gainNode = audioContext.value.createGain()
  gainNode.gain.setValueAtTime(0.3, audioContext.value.currentTime) // 默认音量

  // 3. 创建混响节点 (ConvolverNode)，用于添加混响效果
  convolver = audioContext.value.createConvolver()
  // 这里的 convolver.buffer 通常需要加载脉冲响应 (Impulse Response)
  // 示例中不设置，表示没有实际混响数据
  // convolver.buffer = ... (通过 fetch/arrayBuffer/decodeAudioData 加载 IR)

  // 4. 创建延迟节点 (DelayNode)，用于延迟音频
  delayNode = audioContext.value.createDelay()
  delayNode.delayTime.setValueAtTime(0.2, audioContext.value.currentTime) // 0.2s 延迟

  // 5. 将节点连接到 AudioContext 的输出
  // 连接顺序示例：Oscillator -> Gain -> Convolver -> Delay -> Destination
  // (振荡器在 playSound() 中创建)
  gainNode.connect(convolver)
  convolver.connect(delayNode)
  delayNode.connect(audioContext.value.destination)
})

/**
 * 点击按钮后创建一个振荡器做测试
 * 并连接到第一个节点 (GainNode)
 */
function playSound() {
  if (!audioContext.value) return

  // 创建一个正弦波振荡器，用于测试
  testOscillator = audioContext.value.createOscillator()
  testOscillator.type = 'sine'
  testOscillator.frequency.setValueAtTime(220, audioContext.value.currentTime) // 220Hz (A3)

  // 振荡器连接到增益节点 (GainNode)，再由后续节点串联
  testOscillator.connect(gainNode)

  // 启动振荡器，2 秒后停止
  testOscillator.start()
  testOscillator.stop(audioContext.value.currentTime + 2)
}
</script>

<style scoped>
/* 可以在此处写一些按钮的样式 */
</style>
