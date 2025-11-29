<script setup lang="ts">
import { ref } from 'vue'

/**
 * isActive:
 * - 记录按钮是否处于点亮状态（true: 红色，false: 白色）
 */
const isActive = ref(false)

/**
 * handleFxClick:
 * - 切换 isActive 状态
 * - 在控制台打印当前状态
 */
function handleFxClick() {
  isActive.value = !isActive.value
  console.log(`FX Button is now: ${isActive.value ? 'ON' : 'OFF'}`)
}
</script>

<template>
  <!-- 按钮外层容器 -->
  <button
      class="track-fx-button"
      :class="{ active: isActive }"
      @click="handleFxClick"
  >
    FX
  </button>
</template>

<style scoped>
.track-fx-button {
  /* 大小与布局 */
  padding: 0.6rem 2rem;
  border: 2px solid #ccc;
  border-radius: 4px;

  /* 默认状态：白色 */
  background-color: white;
  color: black;
  cursor: pointer;
  font-weight: bold;
  text-transform: uppercase;

  /* 过渡动画 */
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

/* 点亮状态：红色背景、深红边框、白色文字 */
.track-fx-button.active {
  background-color: red;
  border-color: darkred;
  color: white;
}


</style>
