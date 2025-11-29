<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const bpm = ref(window.myGlobalState.bpm)

const handleBpmUpdate = (event) => {
  bpm.value = event.detail
}

onMounted(() => {
  window.globalEventBus.addEventListener('bpmUpdate', handleBpmUpdate)
})

onUnmounted(() => {
  window.globalEventBus.removeEventListener('bpmUpdate', handleBpmUpdate)
})
</script>

<template>
  <div>
    <p>当前 BPM: {{ bpm }}</p>
  </div>
</template>
