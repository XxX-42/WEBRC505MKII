<script setup lang="ts">
import { defineProps, computed } from 'vue'

/**
 * 定义组件的 props
 * - volume: 传入的音量值，范围建议 0 ~ 1
 */
const props = defineProps<{
  volume: number
}>()

/**
 * barWidth:
 * 通过计算属性将 volume 转换为百分比字符串
 * 如 volume = 0.3 => '30%'
 */
const barWidth = computed(() => {
  // 确保 volume 在 0~1 之间
  const clampedVolume = Math.max(0, Math.min(props.volume, 1))
  return clampedVolume * 100 + '%'
})
</script>

<template>
  <div class="volume-meter-container">
    <!-- 灰色背景条 -->
    <div class="volume-meter-bg">
      <!-- 绿色填充条 -->
      <div class="volume-meter-fill" :style="{ width: barWidth }"></div>
    </div>
  </div>
</template>

<style scoped>
/* 容器可根据需求自定义宽高 */
.volume-meter-container {
  width: 150px;
  height: 20px;
}

/* 背景条样式 */
.volume-meter-bg {
  background-color: #ccc;     /* 灰色背景 */
  border-radius: 4px;         /* 圆角 */
  width: 100%;
  height: 100%;
  position: relative;
}

/* 填充条样式 */
.volume-meter-fill {
  background-color: green;    /* 绿色填充 */
  height: 100%;
  border-radius: 4px;
  transition: width 0.1s ease-out; /* 过渡动画 */
}
</style>
