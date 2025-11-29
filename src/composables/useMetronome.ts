// src/composables/useMetronome.ts
import { reactive, onUnmounted } from 'vue'
import onshotMetronomeSrc from '@/assets/audios/onshotMetronome.wav'

/**
 * useMetronome - 自定义节拍器 composable
 *
 * @param initialBpm 初始每分钟节拍数 (BPM)
 * @param onTick   每次播放节拍时调用的回调函数（例如用于更新视觉提示）
 */
export function useMetronome(initialBpm: number, onTick: () => void) {
    // 创建一个 AudioContext 用于管理音频处理
    const metronomeCtx = new AudioContext();

    // 使用 reactive 定义状态对象，保存音频缓冲区、定时器 ID、增益节点和当前 BPM
    const state = reactive({
        buffer: null as AudioBuffer | null,      // 音频采样数据
        intervalId: null as number | null,         // 定时器 ID
        gainNode: null as GainNode | null,         // 增益节点，用于调节音量
        bpm: initialBpm                            // 当前 BPM，初始为传入值
    });

    // 创建 GainNode（增益节点）并连接到音频输出（扬声器）
    state.gainNode = metronomeCtx.createGain();
    state.gainNode.gain.value = 0;                 // 设置音量为 100%
    state.gainNode.connect(metronomeCtx.destination);

    // 加载音频采样文件，并将其解码为 AudioBuffer
    fetch(onshotMetronomeSrc)
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => metronomeCtx.decodeAudioData(arrayBuffer))
        .then(audioBuffer => {
            // 将解码后的音频数据存储到状态中
            state.buffer = audioBuffer;
        })
        .catch(error => {
            console.error("Error loading metronome sound:", error);
        });

    // 定义播放单个节拍的函数
    const playBeat = () => {
        // 如果音频缓冲区尚未加载，则直接返回
        if (!state.buffer) return;
        // 创建一个 BufferSource 节点，用于播放加载的音频采样
        const source = metronomeCtx.createBufferSource();
        source.buffer = state.buffer;
        // 将 BufferSource 节点连接到增益节点以控制音量
        source.connect(state.gainNode!);
        // 播放音频
        source.start();
        // 播放时调用 onTick 回调函数（例如用于更新 UI）
        onTick && onTick();
    };

    // 启动节拍器，并设置定时器按照 BPM 播放节拍
    const start = (bpm: number = state.bpm) => {
        // 如果已有定时器，则先清除它
        if (state.intervalId) clearInterval(state.intervalId);
        // 更新状态中的 BPM 值
        state.bpm = bpm;
        // 根据 BPM 计算每次节拍的间隔（毫秒）
        const interval = 60000 / bpm;
        // 立即播放第一拍
        playBeat();
        // 设置定时器，根据间隔循环播放节拍
        state.intervalId = setInterval(playBeat, interval) as unknown as number;
    };

    // 停止节拍器，清除定时器
    const stop = () => {
        if (state.intervalId) {
            clearInterval(state.intervalId);
            state.intervalId = null;
        }
    };

    // 更新 BPM，并重启定时器以应用新的节奏
    const updateBpm = (newBpm: number) => {
        state.bpm = newBpm;
        if (state.intervalId) {
            stop();
            start(newBpm);
        }
    };

    // 当组件卸载时，清理定时器并关闭 AudioContext 以释放资源
    onUnmounted(() => {
        stop();
        metronomeCtx.close().catch(e => console.error("Error closing audio context:", e));
    });

    // 返回可供外部调用的方法和状态
    return { start, stop, updateBpm, state };
}
