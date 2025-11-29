<template>
  <div class="rc505-container">
    <InterfaceBoard></InterfaceBoard>
    <MasterBoard
        v-model:bpm="bpm"
        :metronome-active="metronomeActive"
        @toggle-metronome="toggleMetronome"
    />

    <div class="tracks-grid">
      <TrackBoard
          v-for="(track, index) in trackStore.tracks"
          :key="index"
          :track-index="index"
          :bpm="bpm"
          @update:track="updateTrack(index, $event)"
      />
    </div>


    <!-- 自定义控制台容器 -->


    <!-- 触发日志的按钮 -->
    <button @click="emitLogs">Emit Logs</button>
    <test></test>
    <TestAudio></TestAudio>
    <TestAudio2></TestAudio2>
  </div>

</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
// 导入 组件
import MasterBoard from '@/ui/sections/master/MasterBoard.vue'
import TrackBoard from '@/ui/sections/tracks/TrackBoard.vue'
import { useTrackStore } from '@/stores/trackStore'
import { useAudioRecorder } from '@/composables/useAudioRecorder'
import InterfaceBoard from '@/ui/sections/inputs/InterfaceBoard.vue'

const bpm = ref(120)
const metronomeActive = ref(false)
const trackStore = useTrackStore()

const trackState = reactive({
  isRecording: false,
  volume: 0, // 音量显示
})

const { toggleRecording } = useAudioRecorder(trackState)

const toggleMetronome = (state: boolean) => {
  metronomeActive.value = state
}

const updateTrack = (index: number, updatedTrack: any) => {
  trackStore.updateTrack(index, updatedTrack)
}


import Test from "@/ui/debug/console/test.vue";
import TestAudio from "@/ui/debug/console/TestAudio.vue";
import TestAudio2 from "@/ui/debug/console/TestAudio2.vue";

console.log("成功打开rc505!");
function emitLogs() {
  console.log("成功打开rc505!");
}
</script>

<style scoped>

.tracks-grid {
  display: flex;
  grid-template-columns: repeat(5, 1fr);
  gap: min(5rem) ;
  justify-content: space-between; /* 左右分散对齐 */
  margin-top: 4rem;

}
.rc505-container {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background-color: #2a2a2a;
}

</style>
