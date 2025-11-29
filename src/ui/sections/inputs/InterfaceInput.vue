<template>
  <el-form
      style="padding: 0 80px"
      ref="mainFormRef"
      :model="main_form"
      label-width="100px"
      :rules="rules"
  >
    <el-form-item label="声纹采集：" prop="file">
      <div class="audio-controls">
        <!-- 音量电平表 -->
        <div class="volume-meter">
          <div
              class="volume-level"
              :style="{ width: Math.round(volumeValue) + '%' }">
          </div>
        </div>
      </div>
      <!-- 将选择框与音量显示区域放在一行，通过 flex 布局实现 -->
      <div style="display: flex; align-items: center;">
        <!-- 麦克风下拉选择框 -->
        <el-select
            :disabled="voiceStatus"
            v-model="main_form.chooseMicDeviceId"
            placeholder="请选择麦克风"
            style="width: 200px; font-weight: bold; color: black;"
        >
          <!-- 在这里可以写注释，不会破坏属性语法 -->
          <el-option
              v-for="item in Mic"
              :key="item.deviceId"
              :label="item.label"
              :value="item.deviceId"
          />
        </el-select>

        <!-- 右侧音量显示区域 -->
        <div style="margin-left: 20px;">
          <span>当前音量: {{ volumeValue.toFixed(0) }}</span>
        </div>
      </div>

      <!-- 当已选择麦克风时，显示录音按钮 -->
      <div class="voiceGather" v-if="main_form.chooseMicDeviceId != ''">
        <el-button class="record-button" @click="voiceInput">
          {{ voiceStatus ? '取消录音' : '开始录音' }}
        </el-button>
      </div>
    </el-form-item>
  </el-form>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount } from 'vue'
import { useMetronome } from '@/composables/useMetronome' // 你的节拍器逻辑

// ------------------------------
// 表单相关数据与验证规则
// ------------------------------
const main_form = ref({
  chooseMicDeviceId: ''
})
const rules = {}
const mainFormRef = ref(null)

// 麦克风设备列表
const Mic = ref<Array<{ deviceId: string; label: string }>>([])

// 录音状态
const voiceStatus = ref(false)

// ------------------------------
// 音量监测相关
// ------------------------------
let audioContext: AudioContext | null = null
let analyserNode: AnalyserNode | null = null
let dataArray: Uint8Array | null = null
let mediaStream: MediaStream | null = null

// 实时音量
const volumeValue = ref(0)

// 启动音量监测
async function startVolumeMonitoring(deviceId: string) {
  // 若已存在旧流，先停止
  stopVolumeMonitoring()

  // 创建新的 AudioContext
  audioContext = new AudioContext()
  // 请求带有特定 deviceId 的音频流
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined }
  })

  // 创建 MediaStreamSource -> AnalyserNode
  const source = audioContext.createMediaStreamSource(mediaStream)
  analyserNode = audioContext.createAnalyser()
  analyserNode.fftSize = 256
  source.connect(analyserNode)

  dataArray = new Uint8Array(analyserNode.frequencyBinCount)

  // 递归更新音量
  updateVolume()
}

// 停止音量监测
function stopVolumeMonitoring() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close().catch(err => console.error(err))
    audioContext = null
  }
  analyserNode = null
  dataArray = null
  volumeValue.value = 0
}

// 计算当前音量（简化示例：取频域数据平均值）
function updateVolume() {
  if (!analyserNode || !dataArray) return

  analyserNode.getByteFrequencyData(dataArray)
  let sum = 0
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i]
  }
  const avg = sum / dataArray.length
  volumeValue.value = avg

  // 若 AnalyserNode 存在，则继续更新
  if (analyserNode) {
    requestAnimationFrame(updateVolume)
  }
}

// 当切换麦克风设备时，重启音量监测
watch(
    () => main_form.value.chooseMicDeviceId,
    (newVal) => {
      if (newVal) {
        startVolumeMonitoring(newVal).catch(err => console.error(err))
      } else {
        stopVolumeMonitoring()
      }
    }
)

// ------------------------------
// 节拍器逻辑
// ------------------------------
const onTick = () => {
  console.log('Metronome tick')
}
const { start: startMetronome, stop: stopMetronome } = useMetronome(120, onTick)

// ------------------------------
// 切换录音状态
// ------------------------------
function voiceInput() {
  if (!voiceStatus.value) {
    voiceStatus.value = true
    startMetronome()
    console.log('开始录音')
    // 在此处加入真正的录音逻辑
  } else {
    voiceStatus.value = false
    stopMetronome()
    console.log('取消录音')
    // 停止录音逻辑
  }
}

// ------------------------------
// 获取麦克风设备，并默认选择系统输入
// ------------------------------
onMounted(async () => {
  try {
    // 先请求一次权限，否则 label 可能为空
    await navigator.mediaDevices.getUserMedia({ audio: true })
    const devices = await navigator.mediaDevices.enumerateDevices()
    const audioInputs = devices.filter(d => d.kind === 'audioinput')
    Mic.value = audioInputs.map(d => ({
      deviceId: d.deviceId,
      label: d.label || `麦克风 ${d.deviceId}`
    }))
    // 默认选择第一个麦克风设备（如果有设备）
    if (audioInputs.length > 0) {
      main_form.value.chooseMicDeviceId = audioInputs[0].deviceId
    }
  } catch (error) {
    console.error('Error fetching microphone devices:', error)
  }
})

// 组件卸载时停止监测
onBeforeUnmount(() => {
  stopVolumeMonitoring()
})
</script>

<style scoped>
/* 整体音频控制区域，居中显示 */
.audio-controls {
  margin-top: 2rem;
  display: flex;
  justify-content: center;
}

/* 音量电平表外框 */
.volume-meter {
  width: 400px;
  height: 25px;
  background-color: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
}

/* 音量电平条，根据 volumeValue 动态调整宽度 */
.volume-level {
  height: 100%;
  background-color: #4caf50;
  transition: width 0.3s ease;
}

/* 录音按钮区域，居中 */
.voiceGather {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}

/* 录音按钮样式美化 */
.record-button {
  font-size: 16px;
  padding: 10px 20px;
}
</style>
