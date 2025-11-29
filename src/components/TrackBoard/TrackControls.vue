<script setup lang="ts">
import { ref } from 'vue'
import TrackBoardFxButton from '@/components/TrackBoard/TrackBoard-FxButton.vue'
import TrackBoardTrackButton from '@/components/TrackBoard/TrackBoard-TrackButton.vue'
import StopButton from '@/components/TrackBoard/StopButton.vue'

/**
 * 接收父组件传来的 props.buttonsHeight
 * 用于给 .trackcontrol-buttons 设置同样的高度
 */
const props = defineProps<{
  buttonsHeight: string
}>()

const isActive = ref(false)

function handleMouseDown() { console.log('Mouse down!') }
function handleMouseUp() { console.log('Mouse up!') }
function emitLogs(msg: string) { console.log(msg) }
function handleStop() { console.log('Stop button clicked!') }
</script>

<template>
  <div class="trackcontrol-buttons" :style="{ height: props.buttonsHeight }">
    <!-- 1. FX Button -->
    <TrackBoardFxButton
        :isActive="isActive"
        @onMouseDown="handleMouseDown"
        @onMouseUp="handleMouseUp"
        @click="emitLogs('FX Clicked')"
    >
      FX
    </TrackBoardFxButton>

    <!-- 2. TRACK Button -->
    <TrackBoardTrackButton
        @onMouseDown="handleMouseDown"
        @onMouseUp="handleMouseUp"
        @click="emitLogs('TRACK Clicked')"
    >
      TRACK
    </TrackBoardTrackButton>

    <!-- 3. 自定义 StopButton，插入了图标的按钮 -->
    <StopButton></StopButton>
  </div>
</template>

<style scoped>
.trackcontrol-buttons {
  /* 布局相关 */
  display: flex;
  flex-direction: column;  /* 垂直排列内部按钮 */
  gap: 0.8rem;             /* 按钮之间的间距 */
  padding: 0.5rem 0.8rem;  /* 内边距，让内容与边框保持距离 */

  /* 让内部项目在水平方向居中 */
  align-items: center;

  /* 外观相关 */
  background: linear-gradient(135deg, #666, #777); /* 简单的渐变背景 */
  border-radius: 0.4rem;
}
</style>
