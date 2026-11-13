<script setup lang="ts">
import { computed, useId } from 'vue';

const props = defineProps<{ normalized: number }>();
const maskId = `lcd-dial-${useId()}`;
const bounded = computed(() => Math.max(0, Math.min(1, props.normalized)));
// Rendering angle only; the value is supplied by the current real field.
const angle = computed(() => -135 + bounded.value * 270);
// Stepped silhouette adapted from WEBRC505MKII 3115b3b4d7e15927cea93724665a2c339888f725,
// web/style.css:474-542. Its old fake/hash normalization is intentionally absent.
const silhouette = 'M10 0 h12 v2 h4 v2 h2 v4 h2 v16 h-2 v4 h-2 v2 h-4 v2 H10 v-2 h-4 v-2 h-2 v-4 h-2 V8 h2 V4 h2 V2 h4 z';
</script>

<template>
  <svg class="lcd-parameter-dial" viewBox="0 0 32 32" aria-hidden="true" shape-rendering="crispEdges"
    :data-normalized="bounded" :data-angle="angle">
    <defs><mask :id="maskId"><path :d="silhouette" fill="white" /><path d="M15 5h2v12h-2z" fill="black" :transform="`rotate(${angle} 16 16)`" /></mask></defs>
    <path :d="silhouette" fill="currentColor" :mask="`url(#${maskId})`" />
    <path d="M0 28h2v2H0z M30 28h2v2h-2z" fill="currentColor" />
  </svg>
</template>

<style scoped>
.lcd-parameter-dial { display: block; width: 32px; height: 32px; flex: none; }
</style>
