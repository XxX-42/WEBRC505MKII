<!-- src/components/TrackBoard-FxButton.vue -->
<template>
  <div class="fx-container">
    <!-- 循环生成四列，每列包含：效果下拉选择、旋钮和 FX 按钮 -->
    <div v-for="index in 4" :key="index" class="fx-column">
      <!-- 旋钮组件（用于调节效果参数，例如 LPF 的 cutoff） -->
      <div class="fx-knob">
        <CircularKnob
            :min="0"
            :max="100"
            :initialValue="50"
            :size="200"
            @change="handleKnobChange(index, $event)"
        />
      </div>
      <!-- 效果选择下拉框 -->
      <select
          class="fx-select"
          v-model="selectedEffects[index - 1]"
          @change="onEffectChange(index - 1, selectedEffects[index - 1])"
      >
        <option
            v-for="(eff, idx) in availableEffects"
            :key="idx"
            :value="eff"
        >
          {{ eff }}
        </option>
      </select>


      <!-- FX 按钮：点击切换效果开关 -->
      <button
          :class="['fx-button', { active: activeButtons[index - 1] }]"
          @click="toggleButton(index - 1)"
      >

        FX {{ index }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, defineProps, onMounted, onBeforeUnmount } from 'vue';
import CircularKnob from '@/ui/common/CircularKnob.vue';
import { useAudioStore } from '@/stores/audio';

// 通过 props 区分 fx 类型（此处 'inputFX' 表示用于麦克风输入处理）
const props = defineProps<{
  fxName: string
}>();

// 获取全局音频状态存储，用于更新处理后音频流
const audioStore = useAudioStore();

// -------------------- 效果选择相关变量 --------------------
const ALL_EFFECTS = [
  "LPF", "BPF", "HPF", "PHASER", "FLANGER", "SYNTH", "LOFI", "RADIO",
  "RING_MODULATOR", "G2B", "SUSTAINER", "AUTO_RIFF", "SLOW_GEAR", "TRANSPOSE",
  "PITCH_BEND", "ROBOT", "ELECTRIC", "HARMONIST_MANUAL", "HARMONIST_AUTO",
  "VOCODER", "OSC_VOCODER", "OSC_BOT", "PREAMP", "DIST", "DYNAMICS", "EQ",
  "ISOLATOR", "OCTAVE", "AUTO_PAN", "MANUAL_PAN", "STEREO_ENHANCE",
  "TREMOLO", "VIBRATO", "PATTERN_SLICER", "STEP_SLICER", "DELAY", "PANNING_DELAY",
  "REVERSE_DELAY", "MOD_DELAY", "TAPE_ECHO", "TAPE_ECHO_V505V2", "GRANULAR_DELAY",
  "WARP", "TWIST", "ROLL", "ROLL_V505V2", "FREEZE", "CHORUS", "REVERB",
  "GATE_REVERB", "REVERSE_REVERB", "BEAT_SCATTER", "BEAT_REPEAT", "BEAT_SHIFT",
  "VINYL_FLICK"
];
const EXCLUDE_FOR_INPUT = ["BEAT_SCATTER", "BEAT_REPEAT", "BEAT_SHIFT", "VINYL_FLICK"];
const availableEffects = ref<string[]>([]);
const activeButtons = ref([false, false, false, false]);
const selectedEffects = ref(["LPF", "LPF", "LPF", "LPF"]);

// -------------------- 音频处理相关变量 --------------------
// AudioContext 用于处理麦克风输入及效果
let audioContext: AudioContext | null = null;
// 原始麦克风输入流
let micStream: MediaStream | null = null;
// AudioNode 对象，从麦克风创建的源节点
let micSource: MediaStreamAudioSourceNode | null = null;
// 目标节点，用于导出处理后音频流
let destination: MediaStreamAudioDestinationNode | null = null;
// 保存各列效果节点（例如 LPF 节点）的数组
let filterNodes: (BiquadFilterNode | null)[] = [null, null, null, null];

onMounted(async () => {
  if (props.fxName === 'inputFX') {
    // 创建音频上下文
    audioContext = new AudioContext();
    try {
      // 获取麦克风输入（请确保用户已授权）
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 创建麦克风输入的源节点
      micSource = audioContext.createMediaStreamSource(micStream);

      // 创建目标节点，用于输出经过效果处理后的音频流
      destination = audioContext.createMediaStreamDestination();

      // 初始状态下，直接将麦克风源连接到目标节点（无效果处理）
      micSource.connect(destination);

      // 将处理后的音频流保存到全局状态，供其它组件（如 track.vue）使用
      audioStore.setProcessedAudioStream(destination.stream);

      console.log("Microphone acquired and processed audio stream set in FX.");
    } catch (err) {
      console.error("Failed to get mic for inputFX:", err);
    }
  }
});

onBeforeUnmount(() => {
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
});

// -------------------- 工具函数 --------------------
// 将一个数值从一个区间映射到另一个区间
function mapRange(value: number, in_min: number, in_max: number, out_min: number, out_max: number) {
  return (value - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

// -------------------- 效果处理函数 --------------------

// 应用低通滤波效果（LPF）
// 1. 断开麦克风源与目标节点的直连
// 2. 创建 LPF 节点，将麦克风源连接至 LPF，再将 LPF 连接到目标节点
function applyLPF(idx: number) {
  if (!audioContext || !micSource || !destination) {
    console.warn("Missing audioContext, micSource, or destination; cannot apply LPF.");
    return;
  }
  // 移除当前列可能存在的效果
  removeLPF(idx);

  // 断开原先的直连（注意：实际应用中需确保断开的是对应连接）
  micSource.disconnect(destination);

  // 创建 LPF 节点，并设置参数
  const lpf = audioContext.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 10000;

  // 构建新的音频链：麦克风源 → LPF → 目标节点
  micSource.connect(lpf);
  lpf.connect(destination);

  // 保存当前效果节点
  filterNodes[idx] = lpf;

  console.log(`LPF (column ${idx+1}) applied.`);
}

// 移除低通滤波效果（LPF）
// 1. 断开效果节点，将麦克风源重新连接到目标节点
function removeLPF(idx: number) {
  if (filterNodes[idx]) {
    filterNodes[idx]!.disconnect();
    filterNodes[idx] = null;
    if (micSource && destination) {
      // 为确保重新连接前断开所有连接，先断开所有节点
      micSource.disconnect();
      micSource.connect(destination);
    }
    console.log(`LPF (column ${idx+1}) removed.`);
  }
}

// -------------------- 交互处理函数 --------------------

// 当点击 FX 按钮时，切换对应效果（例如 LPF）的开关状态
function toggleButton(idx: number) {
  activeButtons.value[idx] = !activeButtons.value[idx];
  const isOn = activeButtons.value[idx];
  const effectName = selectedEffects.value[idx];
  console.log(`[${props.fxName}] Button ${idx+1} toggled:`, isOn, ", effect=", effectName);

  if (props.fxName === 'inputFX' && effectName === "LPF") {
    if (isOn) {
      applyLPF(idx);
    } else {
      removeLPF(idx);
    }
  } else {
    if (isOn) {
      console.log(`Effect ${effectName} is not implemented yet.`);
    }
  }
}

// 当旋钮数值改变时，若当前激活的效果为 LPF，则更新其 cutoff 参数
function handleKnobChange(knobIndex: number, newValue: number) {
  console.log(`[${props.fxName}] Knob ${knobIndex} changed to: ${newValue}`);
  const idx = knobIndex - 1;
  const effectName = selectedEffects.value[idx];
  if (props.fxName === 'inputFX' && effectName === "LPF" && filterNodes[idx]) {
    const freq = mapRange(newValue, 0, 100, 20, 20000);
    filterNodes[idx]!.frequency.value = freq;
    console.log(`[LPF] Frequency set to ${freq} Hz.`);
  }
}

// 当下拉框选择变化时，若当前效果处于激活状态，则更新效果链
function onEffectChange(idx: number, newEffect: string) {
  console.log(`[${props.fxName}] Effect changed in column ${idx+1} => ${newEffect}`);
  if (props.fxName === 'inputFX' && activeButtons.value[idx]) {
    const oldEffect = selectedEffects.value[idx];
    if (oldEffect === "LPF") {
      removeLPF(idx);
    }
  }
  if (props.fxName === 'inputFX' && newEffect === "LPF" && activeButtons.value[idx]) {
    applyLPF(idx);
  }
}

// 初始化可用效果列表（排除不适用的效果）
onMounted(() => {
  const excludeList = props.fxName === 'inputFX' ? EXCLUDE_FOR_INPUT : [];
  availableEffects.value = ALL_EFFECTS.filter(eff => !excludeList.includes(eff));
});
</script>

<style src="@/assets/styles/masterControls.scss" scoped>
/* masterControls.scss 中的样式保持不变 */


</style>
