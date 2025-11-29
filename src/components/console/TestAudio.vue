<template>
  <div>
    <p>请打开你自定义的控制台查看 sampleRate 输出</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'

onMounted(() => {
  // ========== 1. 创建 AudioContext，用于音频处理 ==========
  const audioContext = new AudioContext()

  // ========== 2. 生成 1 秒的白噪声缓冲区 (AudioBuffer) ==========
  const buffer = audioContext.createBuffer(
      1,                          // 通道数（单声道）
      audioContext.sampleRate * 1,// 采样帧数（1 秒音频）
      audioContext.sampleRate     // 采样率，通常 44100Hz
  )
  const channelData = buffer.getChannelData(0)
  // 随机填充 [-1, 1] 值，形成白噪声
  for (let i = 0; i < buffer.length; i++) {
    channelData[i] = Math.random() * 2 - 1
  }

  // ========== 3. 主增益 (GainNode) ==========
  // 统一控制整体音量，避免音量过大
  const primaryGainControl = audioContext.createGain()
  primaryGainControl.gain.setValueAtTime(0.05, audioContext.currentTime)
  primaryGainControl.connect(audioContext.destination)

  // ========== 4. White Noise 按钮 ==========
  const noiseButton = document.createElement('button')
  noiseButton.innerText = "White Noise"

  noiseButton.addEventListener("click", () => {
    // 每次点击都创建一个新的白噪声源 (BufferSource)
    const whiteNoiseSource = audioContext.createBufferSource()
    whiteNoiseSource.buffer = buffer

    // 直接连接到主增益
    whiteNoiseSource.connect(primaryGainControl)
    whiteNoiseSource.start()
  })

  document.body.appendChild(noiseButton)

  // ========== 5. Snare 按钮 (白噪声 + 三角波 + 高通滤波 + 包络) ==========

  // 先创建高通滤波器，用于模拟 Snare 的高频特征
  const snareFilter = audioContext.createBiquadFilter()
  snareFilter.type = "highpass"
  // 1500Hz 左右可模拟 Snare 的“高频”
  snareFilter.frequency.setValueAtTime(1500, audioContext.currentTime)
  // 连接滤波器到主增益
  snareFilter.connect(primaryGainControl)

  const snareButton = document.createElement('button')
  snareButton.innerText = "Snare"

  snareButton.addEventListener("click", () => {
    // --- 5.1 白噪声部分 ---
    const whiteNoiseSource = audioContext.createBufferSource()
    whiteNoiseSource.buffer = buffer

    // 为白噪声添加一个独立的增益，用于做短包络
    const whiteNoiseGain = audioContext.createGain()
    // 初始音量 1
    whiteNoiseGain.gain.setValueAtTime(1, audioContext.currentTime)
    // 0.2 秒内衰减到 0.01
    whiteNoiseGain.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.2
    )

    // 连接顺序：白噪声 -> whiteNoiseGain -> snareFilter -> primaryGain
    whiteNoiseSource.connect(whiteNoiseGain)
    whiteNoiseGain.connect(snareFilter)

    // 0.2 秒后停止白噪声
    whiteNoiseSource.start()
    whiteNoiseSource.stop(audioContext.currentTime + 0.2)

    // --- 5.2 三角波部分 (模仿 Snare 的“哨声”/底音) ---
    const snareOscillator = audioContext.createOscillator()
    snareOscillator.type = "triangle"
    snareOscillator.frequency.setValueAtTime(250, audioContext.currentTime)

    // 给三角波也添加一个增益包络
    const oscillatorGain = audioContext.createGain()
    oscillatorGain.gain.setValueAtTime(1, audioContext.currentTime)
    oscillatorGain.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.2
    )

    // 连接顺序：三角波 -> oscillatorGain -> snareFilter -> primaryGain
    snareOscillator.connect(oscillatorGain)
    oscillatorGain.connect(snareFilter)

    // 启动并在 0.2 秒后停止三角波
    snareOscillator.start()
    snareOscillator.stop(audioContext.currentTime + 0.2)
  })

  document.body.appendChild(snareButton)

  // ========== 6. Kick 按钮 (正弦波 + 包络) ==========
  const kickButton = document.createElement('button')
  kickButton.innerText = "Kick"

  kickButton.addEventListener("click", () => {
    // 创建一个正弦波振荡器
    const kickOscillator = audioContext.createOscillator()
    kickOscillator.type = "sine"
    // 示例中你使用了 266.1 Hz，也可改为 60~100 Hz 更贴近 Kick
    kickOscillator.frequency.setValueAtTime(266.1, audioContext.currentTime)

    // 若想做频率包络(可选):
    // kickOscillator.frequency.exponentialRampToValueAtTime(
    //   60, // 终止频率
    //   audioContext.currentTime + 0.2
    // );

    // 创建增益包络
    const kickGain = audioContext.createGain()
    // 初始音量
    kickGain.gain.setValueAtTime(1, audioContext.currentTime)
    // 在 0.2 秒内衰减到 0.01
    kickGain.gain.exponentialRampToValueAtTime(
        0.01,
        audioContext.currentTime + 0.2
    )

    // 连接顺序：kickOscillator -> kickGain -> primaryGain
    kickOscillator.connect(kickGain)
    kickGain.connect(primaryGainControl)

    // 启动振荡器
    kickOscillator.start(audioContext.currentTime)
    // 0.2 秒后停止
    kickOscillator.stop(audioContext.currentTime + 0.2)
  })

  document.body.appendChild(kickButton)
})
</script>

<style scoped>
/* 这里可添加你的自定义样式 */
</style>
