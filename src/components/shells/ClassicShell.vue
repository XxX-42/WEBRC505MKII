<template>
  <section ref="hostRef" class="classic-shell">
    <div class="classic-fit" :style="fitStyle">
      <div ref="stageRef" class="classic-stage" :style="stageStyle">
        <div class="classic-console">
          <div class="classic-branding">
            <div class="brand-left">BOSS</div>
            <div class="brand-strip">RC-505mkII LOOP STATION</div>
            <div class="brand-right">LIVE LOOPING</div>
          </div>

          <div class="classic-upper">
            <InputFxPanel />
            <CenterMainPanel />
            <TrackFxPanel />
          </div>
        </div>

        <TrackBay />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import CenterMainPanel from '../panel/CenterMainPanel.vue';
import InputFxPanel from '../panel/InputFxPanel.vue';
import TrackBay from '../panel/TrackBay.vue';
import TrackFxPanel from '../panel/TrackFxPanel.vue';

const hostRef = ref<HTMLElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const scale = ref(1);
const scaledWidth = ref(0);
const scaledHeight = ref(0);
let resizeObserver: ResizeObserver | null = null;

const updateScale = async () => {
  await nextTick();
  const host = hostRef.value;
  const stage = stageRef.value;
  if (!host || !stage) {
    return;
  }

  const naturalWidth = stage.scrollWidth;
  const naturalHeight = stage.scrollHeight;
  if (!naturalWidth || !naturalHeight) {
    return;
  }

  const availableWidth = Math.max(host.clientWidth - 8, 320);
  const availableHeight = Math.max(host.clientHeight - 8, 320);
  const nextScale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);

  scale.value = nextScale;
  scaledWidth.value = naturalWidth * nextScale;
  scaledHeight.value = naturalHeight * nextScale;
};

const fitStyle = computed(() => ({
  width: scaledWidth.value > 0 ? `${scaledWidth.value}px` : '100%',
  height: scaledHeight.value > 0 ? `${scaledHeight.value}px` : '100%',
}));

const stageStyle = computed(() => ({
  transform: `scale(${scale.value})`,
}));

onMounted(() => {
  void updateScale();
  resizeObserver = new ResizeObserver(() => {
    void updateScale();
  });
  if (hostRef.value) {
    resizeObserver.observe(hostRef.value);
  }
  if (stageRef.value) {
    resizeObserver.observe(stageRef.value);
  }
  window.addEventListener('resize', updateScale);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', updateScale);
});
</script>

<style scoped>
.classic-shell {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: grid;
  place-items: start center;
  padding: 12px 16px 8px;
}

.classic-fit {
  position: relative;
  overflow: visible;
}

.classic-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
}

.classic-console {
  min-width: 1240px;
  padding: 6px 14px 12px;
  border-radius: 26px 26px 8px 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background:
    linear-gradient(180deg, rgba(43, 43, 48, 0.98) 0%, rgba(13, 13, 16, 0.99) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 -1px 0 rgba(0, 0, 0, 0.78),
    0 16px 30px rgba(0, 0, 0, 0.34);
}

.classic-branding {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 16px;
  padding: 2px 10px 8px;
  color: #f5f5f5;
  font-family: var(--font-hardware);
  text-transform: uppercase;
}

.brand-left,
.brand-right {
  font-size: 13px;
  letter-spacing: 1.8px;
  opacity: 0.88;
}

.brand-right {
  text-align: right;
}

.brand-strip {
  padding: 3px 28px;
  border-radius: 999px;
  background: linear-gradient(180deg, #ff2c38 0%, #8c111c 100%);
  letter-spacing: 2.4px;
  font-size: 16px;
  font-weight: 700;
  box-shadow: 0 8px 18px rgba(255, 0, 51, 0.18);
}

.classic-upper {
  display: grid;
  grid-template-columns: 280px minmax(520px, 1fr) 280px;
  gap: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 8px solid #babdc5;
  min-height: 302px;
}

@media (max-width: 1400px) {
  .classic-shell {
    place-items: start left;
  }
}
</style>
