<template>
  <div id="app">
    <main class="main">
      <!-- 引用 RC505 组件 -->
      <RC505 />
      <!-- 自定义日志输出控制台 -->
      <CustomConsole />


      <new></new>
    </main>
  </div>
</template>

<script setup lang="ts">
import RC505 from './views/RC505.vue'
import CustomConsole from "@/components/console/CustomConsole.vue";
import AudioContainer from "@/views/AudioContainer.vue";
import AudioLinker from "@/views/AudioLinker.vue";
import New from "@/FX/new.vue";


</script>

<style scoped>
#app {
  font-family: 'Arial', sans-serif;
  background-color: #121212;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80vh;
  margin: 0;
}

header {
  margin-bottom: 2rem;
}

h1 {
  font-size: 2rem;
  color: #ff4444;
  text-align: center;
}

/* 将 main 布局调整为垂直排列，确保 RC505 与 CustomConsole 分开展示 */
main {
  width: 100%;
  max-width: 1200px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 2rem;
}
</style>
