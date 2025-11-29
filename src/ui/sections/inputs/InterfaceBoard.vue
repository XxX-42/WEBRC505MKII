<template>
  <div class="interface-board">
    <InterfaceInput />
    <InterfaceOutput />
  </div>
</template>

<script setup lang="ts">
import InterfaceInput from './InterfaceInput.vue'
import InterfaceOutput from './InterfaceOutput.vue'
</script>

<style scoped>
.interface-board {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
