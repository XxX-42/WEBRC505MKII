<template>
  <div class="controls-panel">
    <label>
      截止频率:
      <input type="range" min="500" max="10000" step="100"
             v-model.number="params.cutoff"
             @input="handleUpdate" @mousedown.stop />
      {{ params.cutoff }} Hz
    </label>
    <label>
      Q值:
      <input type="range" min="0.1" max="20" step="0.1"
             v-model.number="params.Q"
             @input="handleUpdate" @mousedown.stop />
      {{ params.Q }}
    </label>
  </div>
</template>

<script>
export default {
  name: 'LpfEffect',
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
