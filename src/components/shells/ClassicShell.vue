<template>
  <section class="classic-shell" aria-label="RC-505mkII replica view">
    <div class="viewport-toolbar" role="toolbar" aria-label="Faceplate zoom and pan">
      <span class="viewport-label">FACEPLATE VIEW</span>
      <p v-if="tooNarrow" class="viewport-warning" role="status" aria-live="polite">
        当前窗口过窄／过矮，请放大窗口或收起侧栏（面板按 80% 以上比例显示）。
      </p>
      <div class="viewport-actions">
        <button type="button" aria-label="Zoom out" title="Zoom out" @click="adjustZoom(-0.1)">−</button>
        <label class="zoom-slider-label">
          <span>ZOOM</span>
          <input v-model.number="zoom" type="range" min="0.8" max="1.2" step="0.05" aria-label="Faceplate zoom" @input="markUserZoomed">
          <output>{{ Math.round(zoom * 100) }}%</output>
        </label>
        <button type="button" aria-label="Zoom in" title="Zoom in" @click="adjustZoom(0.1)">+</button>
        <button type="button" class="fit-button" @click="fitFace">FIT</button>
        <span class="pan-separator" aria-hidden="true"></span>
        <button type="button" aria-label="Pan left" title="Pan left" @click="pan(-260, 0)">←</button>
        <button type="button" aria-label="Pan right" title="Pan right" @click="pan(260, 0)">→</button>
        <button type="button" aria-label="Pan up" title="Pan up" @click="pan(0, -180)">↑</button>
        <button type="button" aria-label="Pan down" title="Pan down" @click="pan(0, 180)">↓</button>
      </div>
    </div>

    <div ref="viewportRef" class="classic-viewport" tabindex="0" aria-label="Scrollable RC-505mkII faceplate">
      <div class="classic-fit" :style="fitStyle">
        <div ref="stageRef" class="classic-stage" :style="stageStyle">
          <Rc505Face />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Rc505Face from '../panel/Rc505Face.vue';

const viewportRef = ref<HTMLElement | null>(null);
const stageRef = ref<HTMLElement | null>(null);
const zoom = ref(0.8);
const availableSize = ref({ width: 0, height: 0 });
let resizeObserver: ResizeObserver | null = null;
let userZoomed = false;
const tooNarrow = computed(() => {
  const { width, height } = availableSize.value;
  return width < 1520 * 0.8 + 24 || height < 846 * 0.8 + 24;
});

function markUserZoomed(): void {
  userZoomed = true;
}

function fitFace(): void {
  const viewport = viewportRef.value;
  const stage = stageRef.value;
  if (!viewport || !stage) return;
  const widthRatio = (viewport.clientWidth - 24) / stage.scrollWidth;
  const heightRatio = (viewport.clientHeight - 24) / stage.scrollHeight;
  zoom.value = Math.min(1.2, Math.max(0.8, Math.min(widthRatio, heightRatio, 1)));
  availableSize.value = { width: viewport.clientWidth, height: viewport.clientHeight };
  userZoomed = true;
  viewport.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
}

function adjustZoom(delta: number): void {
  userZoomed = true;
  zoom.value = Math.max(0.8, Math.min(1.2, Math.round((zoom.value + delta) * 100) / 100));
}

function pan(left: number, top: number): void {
  viewportRef.value?.scrollBy({ left, top, behavior: 'smooth' });
}

const fitStyle = computed(() => ({
  width: `${1520 * zoom.value}px`,
  height: `${(stageRef.value?.scrollHeight ?? 720) * zoom.value}px`,
}));

const stageStyle = computed(() => ({ transform: `scale(${zoom.value})` }));

async function measureInitialScale(): Promise<void> {
  await nextTick();
  if (userZoomed) return;
  const viewport = viewportRef.value;
  const stage = stageRef.value;
  if (!viewport || !stage) return;
  const widthRatio = (viewport.clientWidth - 24) / stage.scrollWidth;
  const heightRatio = (viewport.clientHeight - 24) / stage.scrollHeight;
  availableSize.value = { width: viewport.clientWidth, height: viewport.clientHeight };
  zoom.value = Math.min(1, Math.max(0.8, Math.min(widthRatio, heightRatio, 1)));
}

onMounted(() => {
  void measureInitialScale();
  resizeObserver = new ResizeObserver(() => { void measureInitialScale(); });
  if (viewportRef.value) resizeObserver.observe(viewportRef.value);
  if (stageRef.value) resizeObserver.observe(stageRef.value);
  window.addEventListener('resize', measureInitialScale);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('resize', measureInitialScale);
});
</script>

<style scoped>
.classic-shell {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 8px 12px 10px;
  background:
    radial-gradient(ellipse at 50% -20%, rgba(83, 88, 98, 0.35), transparent 70%),
    #101115;
}

.viewport-toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
  padding: 0 4px 7px;
  color: #afb5bf;
  font: 700 12px/1.2 var(--font-hardware);
  letter-spacing: 0.15em;
}
.viewport-warning {
  flex: 1 1 280px;
  margin: 0;
  color: #ffd487;
  font-size: 12px;
  line-height: 1.35;
  letter-spacing: .02em;
}

.viewport-actions { display: flex; align-items: center; gap: 5px; }
.viewport-actions button {
  min-width: 30px;
  height: 27px;
  padding: 0 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  color: #e7eaf0;
  background: linear-gradient(180deg, #30343c, #202329);
  font: 700 13px/1 var(--font-hardware);
  cursor: pointer;
}
.viewport-actions button:hover { border-color: #79caff; background: #353b44; }
.viewport-actions button:focus-visible { outline: 2px solid #79caff; outline-offset: 2px; }
.viewport-actions .fit-button { min-width: 48px; font-size: 12px; letter-spacing: 0.08em; }
.zoom-slider-label { display: flex; align-items: center; gap: 7px; padding: 0 6px; letter-spacing: 0.07em; }
.zoom-slider-label input { width: clamp(70px, 12vw, 150px); accent-color: #6ec7ff; }
.zoom-slider-label output { width: 38px; color: #d7dce4; text-align: right; }
.pan-separator { width: 1px; height: 18px; margin-inline: 3px; background: rgba(255, 255, 255, 0.14); }

.classic-viewport {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: radial-gradient(ellipse at 50% 15%, #282a2e 0%, #151619 80%);
  scrollbar-color: #515761 #1b1d22;
  scrollbar-width: thin;
  touch-action: pan-x pan-y;
}

.classic-viewport:focus-visible { outline: 2px solid #6ec7ff; outline-offset: -3px; }
.classic-fit { position: relative; overflow: visible; margin: 12px auto; }
.classic-stage { position: absolute; top: 0; left: 0; transform-origin: top left; }

@media (max-width: 640px) {
  .classic-shell { padding: 6px; }
  .viewport-toolbar { align-items: flex-start; flex-direction: column; gap: 4px; padding-bottom: 6px; }
  .viewport-actions { width: 100%; justify-content: space-between; gap: 3px; }
  .viewport-actions button { min-width: 27px; height: 25px; padding-inline: 5px; }
  .zoom-slider-label { gap: 4px; }
  .zoom-slider-label input { width: 72px; }
  .classic-fit { margin: 8px; }
  .viewport-warning { font-size: 11px; }
}
</style>
