// src/stores/audio.ts
import { defineStore } from 'pinia';

/**
 * useAudioStore - 全局音频状态存储
 * 用于保存 fx.vue 经过音频效果处理后生成的 processedAudioStream，
 * 这样项目内的其它组件（例如 track.vue）都可以直接访问或修改该流。
 */
export const useAudioStore = defineStore('audio', {
    state: () => ({
        // 处理后的音频流（经过 fx.vue 处理后输出），初始为空
        processedAudioStream: null as MediaStream | null,
    }),
    actions: {
        // 设置全局处理后音频流
        setProcessedAudioStream(stream: MediaStream) {
            this.processedAudioStream = stream;
        },
    },
});
