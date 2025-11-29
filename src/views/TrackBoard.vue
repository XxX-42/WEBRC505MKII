<!-- src/components/TrackControls.vue -->
<template>
  <div class="track-background">
    <div class="track-header">TRACK {{ trackIndex + 1 }}</div>
  <div class="track-container">

    <!-- 上侧按钮区域 -->
    <div class="track-controls" >
      <!-- 左侧按钮区域 -->
      <TrackControls :buttonsHeight="controlsHeight">

      </TrackControls>

      <!-- 右侧音量控制 -->
      <div class="volume-slider-container" :style="{height: controlsHeight}">
        <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            v-model="trackState.volume"
            class="volume-slider"
        />
      </div>
    </div>

    <!-- 底部 Record/Play Button -->
    <RecPlayButton
        :recordingMode="recordingMode"
        :waitingForDownbeat="waitingForDownbeat"
        @mousedown="handlewWaitingShining"
    />
  </div>
  </div>
</template>

<script setup lang="ts">
import RecPlayButton from "@/components/TrackBoard/RecPlayButton.vue";
import StopButton from "@/components/TrackBoard/StopButton.vue";
import TrackBoardTrackButton from "@/components/TrackBoard/TrackBoard-TrackButton.vue";
import TrackControls from "@/components/TrackBoard/TrackControls.vue";
import '@/assets/styles/track.scss';
import { ref, reactive, onBeforeUnmount, watch } from 'vue';
import { useTrack } from '@/composables/useTrack';
// 引入全局音频状态存储，获取 fx.vue 处理后的音频流
import { useAudioStore } from '@/stores/audio';


//css定义
// 1. 定义一个“统一的高度”变量，统一音量条和trackcontrols的高度
const controlsHeight = ref('13rem');
// -------------------- 全局录音状态 --------------------
// 使用 Pinia 全局音频存储获取处理后的音频流
const audioStore = useAudioStore();

// -------------------- State Initialization --------------------
const recordingMode = ref<'default' | 'recording' | 'overlay' | 'playback' | 'stop'>('default');
console.log("Initial recordingMode:", recordingMode.value);

const trackState = reactive({
  isRecording: false,
  isPlaying: false,
  isOverlayRecording: false,
  volume: 1,
});

// trackIndex 和 bpm 为必传属性；已删除 processedAudioStream prop
const props = defineProps({
  trackIndex: { type: Number, required: true },
  bpm: { type: Number, required: true }
});

// 假设 useTrack 提供节拍器状态，用于显示 metronome indicator
const { trackState: trackStateFromTrack } = useTrack(props.bpm);

// -------------------- 全局录音开关 --------------------
import { ref as vueRef } from 'vue';
const globalRecordingActive = vueRef(false);
watch(recordingMode, (newVal) => {
  globalRecordingActive.value = (newVal !== 'default' && newVal !== 'stop');
});

// -------------------- 录音与播放相关变量 --------------------
// 不再使用内部获取麦克风，而是使用全局 fx.vue 处理后的音频流
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: BlobPart[] = [];
let audioBlob: Blob | null = null;
let audioUrl: string | null = null;
let previousAudioBuffer: AudioBuffer | null = null;

// 初始化录音专用 AudioContext
let recordingCtx: AudioContext | null = null;
const initRecordingContext = () => {
  if (!recordingCtx) {
    recordingCtx = new AudioContext();
  }
};

// 开始录音函数：使用全局 processedAudioStream 作为录音源
const startRecording = async () => {
  if (audioStore.processedAudioStream) {
    initRecordingContext();
    // 使用全局处理后的音频流创建源节点
    const processedSource = recordingCtx!.createMediaStreamSource(audioStore.processedAudioStream);
    // 创建一个 MediaStreamDestination 节点，用于将音频流供 MediaRecorder 录制
    const destination = recordingCtx!.createMediaStreamDestination();
    processedSource.connect(destination);

    mediaRecorder = new MediaRecorder(destination.stream);
    mediaRecorder.start();
    trackState.isRecording = true;
    trackStateFromTrack.isRecording = true;
    audioChunks = [];  // 清空之前的录音数据

    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };
    mediaRecorder.onstop = async () => {
      audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
      audioUrl = URL.createObjectURL(audioBlob);
      const arrayBuffer = await audioBlob.arrayBuffer();
      previousAudioBuffer = await recordingCtx!.decodeAudioData(arrayBuffer);

      trackState.isRecording = false;
      trackStateFromTrack.isRecording = false;

      // 根据当前 BPM 和 4 拍一小节计算录音小节数
      const secondsPerBeat = 60 / props.bpm;
      const totalBeats = previousAudioBuffer.duration / secondsPerBeat;
      const measures = Math.round(totalBeats / 4);
      console.log(`Track ${props.trackIndex + 1} measures: ${measures}`);
      console.log("Recording finished, new audio URL:", audioUrl);
    };
  } else {
    console.warn("No processed audio stream available in global storess.");
  }
};

// 停止录音函数
const stopRecording = () => {
  if (mediaRecorder && (trackState.isRecording || trackState.isOverlayRecording)) {
    mediaRecorder.stop();
  }
};

// 播放录制的音频（循环播放）
const audioPlay = () => {
  if (audioUrl) {
    const audio = new Audio(audioUrl);
    audio.loop = true;
    audio.volume = trackState.volume;
    audio.play();
    trackState.isPlaying = true;
    trackStateFromTrack.isPlaying = true;
    audio.onended = () => {
      trackState.isPlaying = false;
      trackStateFromTrack.isPlaying = false;
    };
  }
};

// 停止播放函数
const stopPlaying = () => {
  trackState.isPlaying = false;
  trackStateFromTrack.isPlaying = false;
  console.log('Playback stopped.');
};

// -------------------- 状态切换逻辑 --------------------
let preMode = 'default';

/**
 * 核心录音/叠录切换函数
 * 根据当前状态，启动或停止录音、播放录音，实现 downbeat 等待逻辑
 */
const toggleTrackRecording = () => {
  let curMode = recordingMode.value;
  switch (preMode) {
    case 'default':
      if (curMode === 'default') {
        startRecording();
        preMode = 'default';
        curMode = 'recording';
      } else if (curMode === 'recording') {
        stopRecording();
        audioPlay();
        startRecording();
        preMode = 'recording';
        curMode = 'overlay';
      }
      break;
    case 'recording':
      if (curMode === 'recording') {
        stopRecording();
        audioPlay();
        curMode = 'overlay';
      } else if (curMode === 'overlay') {
        stopRecording();
        audioPlay();
        startRecording();
        preMode = 'overlay';
        curMode = 'playback';
      } else if (curMode === 'stop') {
        audioPlay();
        preMode = 'stop';
        curMode = 'playback';
      }
      break;
    case 'overlay':
      if (curMode === 'playback') {
        stopRecording();
        audioPlay();
        preMode = 'playback';
        curMode = 'overlay';
      } else if (curMode === 'stop') {
        audioPlay();
        preMode = 'stop';
        curMode = 'playback';
      }
      break;
    case 'playback':
      if (curMode === 'overlay') {
        stopRecording();
        audioPlay();
        startRecording();
        preMode = 'overlay';
        curMode = 'playback';
      } else if (curMode === 'stop') {
        stopPlaying();
        preMode = 'stop';
        curMode = 'playback';
      }
      break;
    case 'stop':
      if (curMode === 'playback'){
        audioPlay();
        preMode = 'playback';
        curMode = 'recording';
      }
      break;
  }
  recordingMode.value = curMode;
  console.log(`After toggle: preMode = ${preMode}, curMode = [${curMode}]`);
};

const handleStop = () => {
  let curMode = recordingMode.value;
  switch (preMode) {
    case 'default':
      if (curMode === 'default') {
        console.log('Stop pressed, but do nothing');
        return;
      }
      break;
    case 'recording':
      if (curMode === 'stop') {
        stopRecording();
        audioPlay();
        preMode = 'stop';
        curMode = 'playback';
      }
      break;
    case 'overlay':
      if (curMode === 'stop') {
        stopRecording();
        audioPlay();
        preMode = 'stop';
        curMode = 'playback';
      }
      break;
    case 'playback':
      if (curMode === 'stop') {
        stopPlaying();
        preMode = 'stop';
        curMode = 'playback';
      }
      break;
  }
  recordingMode.value = curMode;
  console.log(`After stop: preMode = ${preMode}, curMode = [${curMode}]`);
};

// -------------------- 等待音头 (downbeat) 开始录音 --------------------
const waitingForDownbeat = ref(false);

/**
 * 处理 Record/Play 按钮点击：
 * 如果当前状态需要等待音头（downbeat），则设置等待状态并监听全局 downbeat 事件，
 * 一旦检测到 downbeat，则调用核心切换函数；否则立即切换状态。
 */
function handlewWaitingShining() {
  console.log("Record/Play button clicked", recordingMode.value, trackStateFromTrack.isPlaying);
  if (
      recordingMode.value === 'default' ||
      recordingMode.value === 'recording' ||
      recordingMode.value === 'overlay' ||
      recordingMode.value === 'playback'
  ) {
    waitingForDownbeat.value = true;
    console.log("Waiting for downbeat, waitingForDownbeat:", waitingForDownbeat.value);
    const onDownbeat = () => {
      console.log("Downbeat detected");
      waitingForDownbeat.value = false;
      window.removeEventListener('downbeat', onDownbeat);
      toggleTrackRecording();
    };
    window.addEventListener('downbeat', onDownbeat);
  } else {
    console.log("Immediate toggle, condition not met.");
    toggleTrackRecording();
  }
}

// -------------------- 按钮交互事件 --------------------
const isActive = ref(false);
const handleMouseDown = () => { isActive.value = true; };
const handleMouseUp = () => { isActive.value = false; };
function emitLogs(name = "Hello from Vue!") { console.log(name); }

// 清理：组件卸载时停止录音/播放
onBeforeUnmount(() => {
  stopRecording();
});
</script>

<style scoped src="@/assets/styles/track.scss"></style>
