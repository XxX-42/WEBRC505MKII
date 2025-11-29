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
    <!-- 底部 Record/Play Button -->
    <LoopIndicator
        :size="180"
        :progress="progress"
        :status="indicatorStatus"
        :waiting="waitingForDownbeat"
        :bpm="bpm"
        :hasData="hasData"
    >
      <RecPlayButton
          :recordingMode="recordingMode"
          :waitingForDownbeat="waitingForDownbeat"
          @mousedown="handlewWaitingShining"
      />
    </LoopIndicator>
  </div>
  </div>
</template>

<script setup lang="ts">
import RecPlayButton from "@/ui/sections/tracks/components/RecPlayButton.vue";
import StopButton from "@/ui/sections/tracks/components/StopButton.vue";
import TrackBoardTrackButton from "@/ui/sections/tracks/components/TrackBoard-TrackButton.vue";
import TrackControls from "@/ui/sections/tracks/components/TrackControls.vue";
import '@/assets/styles/track.scss';
import { ref, reactive, onBeforeUnmount, watch, onMounted } from 'vue';
import { useTrack } from '@/composables/useTrack';
// 引入全局音频状态存储，获取 fx.vue 处理后的音频流
import { useAudioStore } from '@/stores/audio';
import { useTrackStore } from '@/stores/trackStore';


//css定义
// 1. 定义一个“统一的高度”变量，统一音量条和trackcontrols的高度
const controlsHeight = ref('13rem');
// -------------------- 全局录音状态 --------------------
// 使用 Pinia 全局音频存储获取处理后的音频流
const audioStore = useAudioStore();
const trackStore = useTrackStore();

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
// 使用 AudioEngine 替代本地 MediaRecorder
import { useAudioEngine } from '@/composables/useAudioEngine';
const { engine } = useAudioEngine();

// 初始化录音专用 AudioContext (不再需要，由 AudioEngine 管理)
// let recordingCtx: AudioContext | null = null;
// const initRecordingContext = () => { ... };


// 开始录音函数：使用全局 processedAudioStream 作为录音源
const startRecording = async () => {
  if (audioStore.processedAudioStream) {
    // Ensure AudioContext is running
    if (engine.audioContext.state === 'suspended') {
      await engine.audioContext.resume();
    }
    
    const stream = audioStore.processedAudioStream;
    // Create source from stream (using engine context)
    const source = engine.audioContext.createMediaStreamSource(stream);
    
    // Start Recording on Track
    await engine.getTrack(props.trackIndex).startRecording(source);
    
    trackState.isRecording = true;
    trackStateFromTrack.isRecording = true;
    
    // Quantize Mode logic is now handled in stopRecording via trackStore
  } else {
    console.warn("No processed audio stream available in global store.");
  }
};

// 停止录音函数
const stopRecording = (nextState: 'PLAY' | 'OVERDUB' = 'PLAY') => {
  const track = engine.getTrack(props.trackIndex);
  if (trackState.isRecording || trackState.isOverlayRecording) {
      // Stop recording in engine (this promotes buffer and starts playback if nextState is PLAY/OVERDUB)
      track.stopRecording(nextState);
      
      // Handle First Track Logic / Store Updates
      const duration = track.getDuration();
      trackStore.stopRecording(props.trackIndex, duration);
      
      trackState.isRecording = false;
      trackStateFromTrack.isRecording = false;
  }
};

// 播放录制的音频（循环播放）
const audioPlay = () => {
  engine.getTrack(props.trackIndex).play();
  trackState.isPlaying = true;
  trackStateFromTrack.isPlaying = true;
};

// 停止播放函数
const stopPlaying = () => {
  engine.getTrack(props.trackIndex).stop();
  trackState.isPlaying = false;
  trackStateFromTrack.isPlaying = false;
  console.log('Playback stopped.');
};

// -------------------- 状态切换逻辑 --------------------

const canEnterRecordingState = () => {
  const tracks = trackStore.getTracks();
  // Check if any OTHER track is recording
  const isAnyOtherRecording = tracks.some((track, index) => {
    return index !== props.trackIndex && track.isRecording;
  });
  
  if (isAnyOtherRecording) {
    console.warn("Another track is already recording. Exclusive recording enforced.");
    return false;
  }
  return true;
};

/**
 * 核心录音/叠录切换函数
 * Refactored for quantized track switching using Scheduler
 */
const toggleTrackRecording = () => {
  const tracks = trackStore.getTracks();
  // Find if any OTHER track is currently recording
  const recordingTrackIndex = tracks.findIndex((track, index) => index !== props.trackIndex && track.isRecording);
  
  if (recordingTrackIndex !== -1) {
    // CASE: Switching tracks during recording (Quantized Switch)
    console.log(`Switching from Track ${recordingTrackIndex + 1} to Track ${props.trackIndex + 1}`);
    
    // 1. Calculate time until next measure
    const nextDownbeat = engine.scheduler.getNextDownbeatTime();
    
    // Set pending action for THIS track (to start recording)
    trackStore.updateTrack(props.trackIndex, { pendingAction: 'record' });
    waitingForDownbeat.value = true; // Visual feedback

    // Schedule execution
    engine.scheduler.schedule(nextDownbeat, () => {
      // This callback runs at the next downbeat
      
      // 1. Stop the OTHER track (Global coordination needed)
      window.dispatchEvent(new CustomEvent('quantized-track-switch', { 
        detail: { 
          stopTrackIndex: recordingTrackIndex, 
          startTrackIndex: props.trackIndex 
        } 
      }));
      
      // 2. Start THIS track
      startRecording();
      recordingMode.value = 'recording';
      trackStore.updateTrack(props.trackIndex, { isRecording: true, pendingAction: null });
      waitingForDownbeat.value = false;
    });

    return; // Exit immediate execution
  }

  // Standard Logic (Immediate or existing downbeat wait)
  switch (recordingMode.value) {
    case 'default':
      if (canEnterRecordingState()) {
        // Check Metronome State via Store
        const metronomeStatus = audioStore.metronomeStatus;
        
        if (metronomeStatus === 'READY') {
            // SCENARIO 1: Rhythm is READY (Wait for Trigger)
            // 1. HARD SYNC: Start Metronome & Reset Grid at 'now'
            const now = engine.audioContext.currentTime;
            engine.scheduler.resetGrid(now);
            
            // Trigger Metronome via Store
            audioStore.setMetronomeStatus('PLAYING');
            
            // 2. Start Recording Immediately
            startRecording();
            recordingMode.value = 'recording';
            trackStore.updateTrack(props.trackIndex, { isRecording: true, quantizeMode: 'SNAP_TO_MEASURE' });
            
        } else if (metronomeStatus === 'PLAYING') {
            // SCENARIO 2: Rhythm is PLAYING (Quantized Start)
            // Wait for next downbeat to start
            waitingForDownbeat.value = true;
            const nextDownbeat = engine.scheduler.getNextDownbeatTime();
            
            // Schedule Start
            engine.scheduler.schedule(nextDownbeat, () => {
                waitingForDownbeat.value = false;
                startRecording();
                recordingMode.value = 'recording';
                trackStore.updateTrack(props.trackIndex, { isRecording: true, quantizeMode: 'SNAP_TO_MEASURE' });
            });
            
        } else {
            // SCENARIO 3: Rhythm OFF (Free Mode)
            // Start Immediately, Free Mode (will detect BPM on stop)
            startRecording();
            recordingMode.value = 'recording';
            trackStore.updateTrack(props.trackIndex, { isRecording: true, quantizeMode: 'FREE' });
        }
      }
      break;
    case 'recording':
      // REC -> OVERDUB (Immediate Transition)
      // 1. Stop current recording (Finishes loop, starts playing, State=PLAY)
      stopRecording('PLAY'); 
      
      // 2. Start new recording layer (State -> OVERDUB)
      startRecording();
      
      recordingMode.value = 'overlay';
      trackStore.updateTrack(props.trackIndex, { isRecording: true });
      break;
      
    case 'overlay':
      // OVERDUB -> PLAY
      stopRecording('PLAY'); // Stop recording layer, keep playing
      // audioPlay(); // Already playing
      recordingMode.value = 'playback';
      trackStore.updateTrack(props.trackIndex, { isRecording: false });
      break;
      
    case 'playback':
      if (canEnterRecordingState()) {
        // PLAY -> OVERDUB
        // stopRecording(); // Not recording, so this does nothing or stops playback?
        // We are playing. We want to start recording.
        // startRecording() handles transition from PLAY to OVERDUB.
        startRecording();
        recordingMode.value = 'overlay';
        trackStore.updateTrack(props.trackIndex, { isRecording: true });
      }
      break;
      
    case 'stop':
      audioPlay();
      recordingMode.value = 'playback';
      trackStore.updateTrack(props.trackIndex, { isRecording: false });
      break;
  }
  console.log(`Mode changed to: ${recordingMode.value}`);
};

// Listen for quantized switch events
window.addEventListener('quantized-track-switch', (e: any) => {
  const { stopTrackIndex, startTrackIndex } = e.detail;
  
  // If I am the track that needs to stop
  if (props.trackIndex === stopTrackIndex) {
    if (trackState.isRecording) {
      stopRecording();
      audioPlay(); // Auto-play after record
      recordingMode.value = 'playback';
      trackStore.updateTrack(props.trackIndex, { isRecording: false });
    }
  }
});

const handleStop = () => {
  if (recordingMode.value === 'recording' || recordingMode.value === 'overlay') {
    stopRecording();
  }
  stopPlaying();
  recordingMode.value = 'stop';
  trackStore.updateTrack(props.trackIndex, { isRecording: false });
  console.log('Track stopped');
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
  
  // Check if we should start immediately (First Track Priority)
  // Condition: Rhythm OFF (or READY, handled in toggle) and First Track (or Free Mode)
  // Actually, toggleTrackRecording handles the logic of "When to start" (Immediate vs Scheduled)
  // BUT, this function 'handlewWaitingShining' decides whether to wait for a 'downbeat' event BEFORE calling toggle.
  // The 'downbeat' event comes from the Metronome.
  // If Metronome is OFF, we will never get a downbeat event!
  // So we MUST NOT wait for downbeat if Metronome is OFF.
  
  const metronomeStatus = audioStore.metronomeStatus;
  const isFirstTrack = trackStore.isFirstTrackRecording(); // Or check if tracks are empty
  
  // If Metronome is OFF, we start immediately (Free Mode)
  if (metronomeStatus === 'OFF') {
      console.log("Metronome OFF -> Immediate Start (Free Mode)");
      toggleTrackRecording();
      return;
  }
  
  // If Metronome is READY, we also start immediately (Hard Sync Trigger)
  // The toggle function will handle starting the metronome.
  if (metronomeStatus === 'READY') {
      console.log("Metronome READY -> Immediate Start (Trigger)");
      toggleTrackRecording();
      return;
  }

  // If Metronome is PLAYING, we generally wait for downbeat (Quantized Start)
  // UNLESS we are in a state that doesn't require it? 
  // Standard behavior: Wait for downbeat.
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

// -------------------- 动画循环 (Progress Loop) --------------------
import LoopIndicator from "@/ui/sections/tracks/components/LoopIndicator.vue";
import { computed } from 'vue';

const progress = ref(0);
const hasData = ref(false);
let progressFrameId: number;

const updateProgress = () => {
  const track = engine.getTrack(props.trackIndex);
  
  // Update Progress
  if (trackState.isPlaying || trackState.isOverlayRecording || trackState.isRecording) {
    progress.value = track.getProgress();
  } else {
    progress.value = 0;
  }
  
  // Update Data Status
  hasData.value = track.getDuration() > 0;
  
  progressFrameId = requestAnimationFrame(updateProgress);
};

const indicatorStatus = computed(() => {
  if (recordingMode.value === 'default') {
    return hasData.value ? 'STOP' : 'EMPTY';
  }
  if (recordingMode.value === 'recording') return 'RECORDING';
  if (recordingMode.value === 'overlay') return 'OVERDUB';
  if (recordingMode.value === 'playback') return 'PLAYING';
  if (recordingMode.value === 'stop') return 'STOP';
  return 'EMPTY';
});

onMounted(() => {
  progressFrameId = requestAnimationFrame(updateProgress);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(progressFrameId);
  stopRecording();
});
</script>

<style scoped src="@/assets/styles/track.scss"></style>
