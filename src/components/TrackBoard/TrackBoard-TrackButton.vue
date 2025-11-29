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
/* 默认状态（白色） */
.track-button {
  padding: 0.6rem 1.1rem;
  border: 2px solid #ccc;
  border-radius: 4px;

  background-color: white; /* 默认白色 */
  color: black; /* 文字颜色 */

  cursor: pointer;
  font-weight: bold;
  text-transform: uppercase;

  /* 过渡动画 */
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

/* 点亮状态（红色） */
.track-button.active {
  background-color: green; /* 变为红色 */
  border-color: darkgreen;
  color: white;
}

/* 悬停时的轻微变化 */
.track-button:hover {
  opacity: 0.8;
}
</style>
