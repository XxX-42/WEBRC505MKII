<template>
  <section class="track-bay" data-panel="track-bay">
    <TrackStrip v-for="trackId in 5" :key="trackId" :track-id="trackId" />
  </section>
</template>

<script setup lang="ts">
import TrackStrip from './TrackStrip.vue';
</script>

<style scoped>
.track-bay {
  display: grid;
  box-sizing: border-box;
  grid-template-columns: repeat(5, 275px);
  gap: 0;
  width: 1375px;
  min-width: 1375px;
  height: 524px;
  min-height: 524px;
  margin-inline: auto;
  padding: 0;
  border-top: 4px solid #afb4bb;
  background: linear-gradient(180deg, #c9cbd1 0%, #8e939d 6px, transparent 6px);
}
</style>
