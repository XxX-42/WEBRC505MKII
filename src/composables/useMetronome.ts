// src/composables/useMetronome.ts
import { reactive, onUnmounted } from 'vue'
import onshotMetronomeSrc from '@/assets/audios/onshotMetronome.wav'

export enum MetronomeState {
    OFF = 'OFF',
    READY = 'READY',
    PLAYING = 'PLAYING'
}

/**
 * useMetronome - 自定义节拍器 composable
 *
 * @param initialBpm 初始每分钟节拍数 (BPM)
 * @param onTick   每次播放节拍时调用的回调函数（例如用于更新视觉提示）
 */
export function useMetronome(initialBpm: number, onTick: () => void) {
    // 创建一个 AudioContext 用于管理音频处理
    const metronomeCtx = new AudioContext();

    // 使用 reactive 定义状态对象
    const state = reactive({
        buffer: null as AudioBuffer | null,
        intervalId: null as number | null,
        gainNode: null as GainNode | null,
        bpm: initialBpm,
        status: MetronomeState.OFF // 当前状态
    });

    // 创建 GainNode（增益节点）并连接到音频输出（扬声器）
    state.gainNode = metronomeCtx.createGain();
    state.gainNode.gain.value = 0; // 初始静音，playBeat 时会控制
    state.gainNode.connect(metronomeCtx.destination);

    // 加载音频采样文件，并将其解码为 AudioBuffer
    fetch(onshotMetronomeSrc)
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => metronomeCtx.decodeAudioData(arrayBuffer))
        .then(audioBuffer => {
            state.buffer = audioBuffer;
        })
        .catch(error => {
            console.error("Error loading metronome sound:", error);
        });

    // 定义播放单个节拍的函数
    const playBeat = () => {
        if (!state.buffer || state.status !== MetronomeState.PLAYING) return;

        const source = metronomeCtx.createBufferSource();
        source.buffer = state.buffer;
        source.connect(state.gainNode!);
        source.start();
        onTick && onTick();
    };

    // 准备状态：AudioContext 准备好，但等待触发
    const prepare = () => {
        if (state.intervalId) clearInterval(state.intervalId);
        state.status = MetronomeState.READY;
        // Resume context just in case
        if (metronomeCtx.state === 'suspended') {
            metronomeCtx.resume();
        }
    };

    // 启动节拍器
    const start = (bpm: number = state.bpm, startTime?: number) => {
        if (state.intervalId) clearInterval(state.intervalId);

        state.bpm = bpm;
        state.status = MetronomeState.PLAYING;

        if (metronomeCtx.state === 'suspended') {
            metronomeCtx.resume();
        }

        const interval = 60000 / bpm;

        // If startTime is provided, we need to handle the initial delay or scheduling
        // For simplicity in this JS-timer based implementation, we'll just start now if startTime is close
        // In a robust implementation, we would use AudioContext scheduling for the beats.
        // Here we just ensure we call playBeat immediately.

        if (startTime) {
            // Calculate delay until startTime? 
            // If startTime is 'now' (which it usually is for hard sync), we play immediately.
            // If startTime is in future, we should wait.
            const now = metronomeCtx.currentTime;
            if (startTime > now) {
                const delay = (startTime - now) * 1000;
                setTimeout(() => {
                    playBeat();
                    state.intervalId = setInterval(playBeat, interval) as unknown as number;
                }, delay);
                return;
            }
        }

        playBeat(); // 立即播放第一拍
        state.intervalId = setInterval(playBeat, interval) as unknown as number;
    };

    // 停止节拍器
    const stop = () => {
        if (state.intervalId) {
            clearInterval(state.intervalId);
            state.intervalId = null;
        }
        state.status = MetronomeState.OFF;
    };

    // 更新 BPM
    const updateBpm = (newBpm: number) => {
        state.bpm = newBpm;
        if (state.status === MetronomeState.PLAYING) {
            start(newBpm);
        }
    };

    onUnmounted(() => {
        stop();
        metronomeCtx.close().catch(e => console.error("Error closing audio context:", e));
    });

    return { start, stop, prepare, updateBpm, state };
}
