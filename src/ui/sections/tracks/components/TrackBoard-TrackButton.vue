<script setup lang="ts">
import { ref } from 'vue'

/**
 * isActive:
 * - 记录按钮是否被点亮（true: 红色，false: 白色）
 */
const isActive = ref(false)

/**
 * handleTrackClick:
 * - 切换 isActive 状态
 * - 在控制台打印当前状态
 */
function handleTrackClick() {
  isActive.value = !isActive.value
  console.log(`Track Button is now: ${isActive.value ? 'ON' : 'OFF'}`)
}
</script>

<template>
  <!-- 按钮外层容器 -->
  <button
      class="track-button"
      :class="{ active: isActive }"
      @click="handleTrackClick"
  >
    TRACK
  </button>
</template>

<style scoped>
/* 默认状态（深色橡胶按钮） */
.track-button {
  padding: 0.6rem 1.1rem;
  border: 1px solid #222;
  border-radius: 4px;

  background-color: #333; /* 深灰色 */
  color: #ddd; /* 浅灰文字 */
  
  cursor: pointer;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1px;
  
  box-shadow: 0 3px 0 #111; /* 3D 阴影 */
  transition: all 0.1s ease;
  
  /* 禁止选中文字 */
  user-select: none;
}

/* 按下效果 */
.track-button:active {
  transform: translateY(2px);
  box-shadow: 0 1px 0 #111;
}

/* 点亮状态（高亮） */
.track-button.active {
  background-color: #e0e0e0; /* 亮白色/浅灰 */
  color: #111; /* 深色文字 */
  border-color: #fff;
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.5), 0 2px 0 #888;
}

/* 悬停时的轻微变化 */
.track-button:hover:not(.active) {
  background-color: #444;
  color: #fff;
}
</style>
