<template>
  <div class="controls-panel">
    <label>
      LFO频率:
      <input type="range" min="0.1" max="5" step="0.1"
             v-model.number="params.lfoFrequency"
             @input="handleUpdate" @mousedown.stop />
      {{ params.lfoFrequency }} Hz
    </label>
    <label>
      调制深度:
      <input type="range" min="50" max="1000" step="10"
             v-model.number="params.modDepth"
             @input="handleUpdate" @mousedown.stop />
      {{ params.modDepth }}
    </label>
  </div>
</template>

<script>
export default {
  name: 'PhaserEffect',
  props: {
    params: {
      type: Object,
      required: true
    }
  },
  methods: {
    handleUpdate() {
      this.$emit('update');
    }
  }
};
</script>

<style scoped>
.controls-panel {
  margin-top: 0.3125rem;
}
.controls-panel label {
  display: block;
  margin-bottom: 0.1875rem;
}
</style>
