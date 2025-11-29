<template>
  <button
      :class="{
      'white-background': recordingMode === 'default',
      'red-background': recordingMode === 'recording',
      'yellow-background': recordingMode === 'overlay',
      'green-background': recordingMode === 'playback',
      'waiting-red-flash': waitingForDownbeat && (recordingMode === 'default' || recordingMode === 'recording'),
      'waiting-yellow-flash': waitingForDownbeat && (recordingMode === 'overlay' || recordingMode === 'playback')
    }"
      @click="handleClick"
  >
    <img
        id="recordPlayImg"
        src="../../assets/images/Stop.png"
        alt="Record/Play Icon"
    />
  </button>
</template>

<script setup lang="ts">
const props = defineProps({
  recordingMode: { type: String, required: true },
  waitingForDownbeat: { type: Boolean, required: true }
});

const emit = defineEmits(['click']);

const handleClick = () => {
  emit('click');
};
</script>

<style scoped>
/* 覆盖默认激活状态，保持原有颜色逻辑不变 */
button:active {
  background-color: inherit;
  color: inherit;
  box-shadow: none;
}

button {
  /* 自定义按钮样式 */
  position: relative;
  width: 6rem;
  height: 6rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;/* 取消浏览器默认样式 */
  border: none;
}


/* 利用伪元素实现背景层 */
button::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  z-index: 0;
}

/* 定义各状态对应的基础背景颜色 */
.white-background::before {
  background-color: white;
}
.red-background::before {
  background-color: red;
}
.yellow-background::before {
  background-color: yellow;
}
.green-background::before {
  background-color: green;
}

/* 闪烁状态：利用 CSS 变量 --base-color 设置基础颜色，
   并在动画中与 #333 深灰色交替 */
.waiting-yellow-flash::before {
  --base-color: yellow;
  animation: waitingFlash 0.5s infinite;
}
.waiting-red-flash::before {
  --base-color: red;
  animation: waitingFlash 0.5s infinite;
}

/* 图标样式：图标置于背景之上，且保持居中不闪烁 */
#recordPlayImg {
  position: relative;
  z-index: 1;
  width: 5.5rem;
  height: 5.5rem;
  display: block;
}

/* 闪烁动画：在基础颜色与 #333 之间切换 */
@keyframes waitingFlash {
  0%, 100% {
    background-color: var(--base-color);
  }
  50% {
    background-color: #333;
  }
}
button:active {
  background-color: inherit;
  color: inherit;
  /* 如果有边框、阴影等，也需要一并重置 */
  box-shadow: none;
}

</style>
