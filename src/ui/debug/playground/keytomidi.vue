<template>
  <div @click="resetColor" class="container">
    <!-- 按钮，点击时阻止事件冒泡，避免影响外层 -->
    <input
        type="button"
        :class="{ active: isActive }"
        @click.stop="handleClick"
        @keydown="handleKeydown"
        @keyup="handleKeyup"
        value="按下任意键fff"
    >
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, defineEmits } from 'vue';

// 状态变量：按钮是否被点击（激活状态）
const isActive = ref(false);

// 向父组件发送事件定义
const emit = defineEmits<{
  (event: 'key-to-midi', midi: number): void;
  (event: 'key-to-midi-stop', midi: number): void;  // 新增事件，表示键松开时停止
}>();

// 点击按钮事件处理函数
function handleClick() {
  isActive.value = true;
}

// 点击按钮以外区域时恢复按钮颜色
function resetColor() {
  isActive.value = false;
}

// 键盘按键到 MIDI 值的映射表
const keyMap: Record<string, number> = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65,
  t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72
};

// 键盘事件处理函数
function handleKeydown(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (keyMap[key] !== undefined) {
    const midi = keyMap[key];
    console.log(`按下的键是：${key}, MIDI为：${midi}`);
    emit('key-to-midi', midi); // 向父组件发送MIDI信号
  }
}

// 按键抬起事件处理函数
function handleKeyup(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (keyMap[key] !== undefined) {
    const midi = keyMap[key];
    console.log(`松开的键是：${key}, MIDI为：${midi}`);
    emit('key-to-midi-stop', midi); // 向父组件发送停止 MIDI 信号
  }
}



// 全局键盘事件监听，确保键盘输入有效
onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<style scoped>
.container {
  padding: 20px;
}

input[type="button"] {
  padding: 10px 20px;
  font-size: 16px;
  cursor: pointer;
  background-color: #dddddd;
  border: none;
  border-radius: 5px;
  transition: background-color 0.2s;
}

input[type="button"].active {
  background-color: #888888;
  color: white;
}
</style>
