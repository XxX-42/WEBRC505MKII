<template>
  <section class="classic-shell">
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
  </section>
</template>

<script setup lang="ts">
import CenterMainPanel from '../panel/CenterMainPanel.vue';
import InputFxPanel from '../panel/InputFxPanel.vue';
import TrackBay from '../panel/TrackBay.vue';
import TrackFxPanel from '../panel/TrackFxPanel.vue';
</script>

<style scoped>
.classic-shell {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 0;
  flex: 1;
  padding: 18px 18px 0;
  overflow: auto;
}

.classic-console {
  min-width: 1240px;
  padding: 10px 14px 16px;
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
  padding: 4px 10px 12px;
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
  padding: 4px 22px;
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
}

@media (max-width: 1400px) {
  .classic-shell {
    overflow-x: auto;
  }
}
</style>
