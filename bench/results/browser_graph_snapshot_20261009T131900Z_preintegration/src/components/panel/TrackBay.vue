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
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  min-width: 1240px;
  padding: 0 0 18px;
  background: linear-gradient(180deg, #c9cbd1 0%, #8e939d 12px, transparent 12px);
}
</style>
