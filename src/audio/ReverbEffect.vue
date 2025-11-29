<template>
  <div class="controls-panel">
    <label>
      混响比例:
      <input type="range" min="0" max="1" step="0.05"
             v-model.number="params.mix"
             @input="handleUpdate" @mousedown.stop />
      {{ params.mix }}
    </label>
  </div>
</template>

<script>
export default {
  name: 'ReverbEffect',
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
