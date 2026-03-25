<template>
  <section class="tech-shell">
    <div class="tech-top">
      <TopPanel />
    </div>

    <div class="tech-workspace">
      <div class="tech-track-list">
        <TrackUnit v-for="i in 5" :key="i" :track-id="i" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import TopPanel from '../TopPanel.vue';
import TrackUnit from '../TrackUnit.vue';
</script>

<style scoped>
.tech-shell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.tech-top {
  flex: 0 0 auto;
  z-index: 20;
}

.tech-workspace {
  flex: 1;
  overflow: auto;
  padding: 28px 24px 32px;
}

.tech-track-list {
  display: flex;
  gap: 16px;
  width: fit-content;
  margin: 0 auto;
  padding: 24px;
  border-radius: 16px;
  border: 1px solid var(--shell-divider);
  background: var(--shell-surface);
}
</style>
