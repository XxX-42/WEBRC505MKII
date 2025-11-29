<template>
  <el-form
      style="padding: 0 80px"
      ref="mainFormRef"
      :model="main_form"
      label-width="100px"
      :rules="rules"
  >
    <!-- 系统音频输出选择 -->
    <el-form-item label="系统输出：" prop="outputDevice">
      <el-select
          v-model="main_form.chooseAudioOutputDeviceId"
          placeholder="请选择系统输出"
          style="width: 200px; font-weight: bold; color: black;"
      >
        <el-option
            v-for="item in AudioOutput"
            :key="item.deviceId"
            :label="item.label"
            :value="item.deviceId"
        />
      </el-select>
    </el-form-item>
  </el-form>

  <!-- 隐藏的 audio 元素，用于设置输出设备 -->
  <audio ref="audioOutputEl" autoplay style="display: none"></audio>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount } from 'vue';

// ------------------------------
// 表单相关数据与验证规则
// ------------------------------
const main_form = ref({
  chooseAudioOutputDeviceId: ''
});
const rules = {};
const mainFormRef = ref(null);

// 系统音频输出设备列表
const AudioOutput = ref<Array<{ deviceId: string; label: string }>>([]);

// 获取隐藏的 audio 元素引用
const audioOutputEl = ref<HTMLAudioElement | null>(null);

// ------------------------------
// 获取系统音频输出设备，并设置默认输出
// ------------------------------
onMounted(async () => {
  try {
    // 请求一次音频权限以确保设备标签正常显示（部分浏览器需要此操作）
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => { /* 可忽略错误 */ });

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
    AudioOutput.value = audioOutputs.map(d => ({
      deviceId: d.deviceId,
      label: d.label || `输出设备 ${d.deviceId}`
    }));
    // 默认选择第一个输出设备（如果列表不为空）
    if (audioOutputs.length > 0) {
      main_form.value.chooseAudioOutputDeviceId = audioOutputs[0].deviceId;
    }
  } catch (error) {
    console.error('Error fetching audio devices:', error);
  }
});

// ------------------------------
// 监听系统音频输出选择变化，并调用 setSinkId
// ------------------------------
watch(
    () => main_form.value.chooseAudioOutputDeviceId,
    (newVal) => {
      if (newVal && audioOutputEl.value && typeof audioOutputEl.value.setSinkId === 'function') {
        audioOutputEl.value
            .setSinkId(newVal)
            .then(() => {
              console.log('Audio output device set to:', newVal);
            })
            .catch(err => console.error('Failed to set sink id:', err));
      }
    }
);

// ------------------------------
// 组件卸载时（此处无需特殊清理音频输出）
// ------------------------------
onBeforeUnmount(() => {
  // 根据需要执行卸载清理操作
});
</script>

<style scoped>
/* 可根据实际需求修改样式，本示例仅简单设置了表单的内边距与下拉框样式 */
</style>
