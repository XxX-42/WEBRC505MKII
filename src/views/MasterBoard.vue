<template>
  <!-- 主控制容器：包含输入FX、BPM控制、输出FX -->
  <div class="master-controls">
    <!-- 左侧输入效果器区域 -->
    <div class="fx-side fx-left">
      <!-- 输入效果器标题 -->
      <div class="fx-title">Input FX</div>
      <!-- 效果器组件，传递效果器名称 -->
      <FxControls fxName="inputFX" />
    </div>
    <!-- 中央控制区域：包含BPM设置和节拍器控制 -->
      <!-- 节拍器切换按钮：根据状态改变样式和文字 -->

      <!-- 节拍器指示器组件：传递当前BPM和激活状态 -->
      <BpmControls :bpm="bpm" :active="metronomeActive" />

    <!-- 右侧输出效果器区域 -->
    <div class="fx-side fx-right">
      <!-- 输出效果器标题 -->
      <div class="fx-title">Output FX</div>
      <!-- 效果器组件，传递效果器名称 -->
      <FxControls fxName="outputFX" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import FxControls from '@/components/MasterBoard/FxControls.vue'
import BpmControls from '@/components/MasterBoard/BpmControls.vue'

// BPM相关逻辑 -------------------------------------------------
// 从全局状态初始化BPM值
const bpm = ref(window.myGlobalState.bpm)


// 节拍器控制逻辑 -----------------------------------------------
const metronomeActive = ref(false)

/**
 * 切换节拍器状态
 * 使用stop修饰符阻止事件冒泡
 */

</script>

<style scoped>
/* 主容器样式：弹性布局，深色背景 */
.master-controls {
  width: 1500px;
  display: flex;
  align-items: center;        /* 垂直居中 */
  justify-content: space-between; /* 左右分散对齐 */
  background: #2a2a2a;       /* 深灰色背景 */
  padding: 1rem;             /* 内边距 */
  border-radius: 8px;        /* 圆角边框 */
  gap: 0.1rem;                 /* 子元素间距 */
}

/* 侧边FX容器样式 */
.fx-side {
  display: flex;
  flex-direction: column;    /* 垂直排列 */
  gap: 0.5rem;               /* 子元素间距 */
  align-items: center;       /* 水平居中 */
}

/* FX标题样式 */
.fx-title {
  color: #bbb;               /* 浅灰色文字 */
  font-weight: bold;         /* 粗体 */
  font-size: 1.1rem;         /* 字体大小 */
  text-transform: uppercase; /* 大写字母 */
  margin-bottom: 0.6rem;
}

/* 中央控制区域样式 */
.center-controls {
  display: flex;
  flex-direction: column;    /* 垂直排列 */
  align-items: center;       /* 水平居中 */
  gap: 10px;                 /* 子元素间距 */
}

/* BPM控制组样式 */
.bpm-control {
  display: flex;
  align-items: center;       /* 垂直居中 */
  gap: 0.5rem;              /* 元素间距 */
}

/* BPM输入框样式 */
.bpm-control input[type="number"] {
  width: 60px;              /* 固定宽度 */
  background: #444;         /* 深灰色背景 */
  border: 1px solid #555;   /* 边框样式 */
  color: white;             /* 白色文字 */
  padding: 0.3rem;          /* 内边距 */
  border-radius: 4px;       /* 圆角 */
  text-align: center;       /* 文字居中 */
}

/* 节拍器按钮样式 */
.metronome-toggle {
  background: #444;         /* 默认背景色 */
  padding: 0.8rem 1.5rem;  /* 按钮尺寸 */
  border-radius: 4px;       /* 圆角 */
  color: white;             /* 白色文字 */
  transition: all 0.3s;     /* 过渡动画 */
  cursor: pointer;          /* 手型光标 */
}

/* 激活状态的节拍器按钮 */
.metronome-toggle.active {
  background: #ff4444;      /* 红色背景 */
  color: white;
}
</style>