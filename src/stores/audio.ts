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
        bpm: 120,
        metronomeStatus: 'OFF' as 'OFF' | 'READY' | 'PLAYING',
    }),
    actions: {
        // 设置全局处理后音频流
        setProcessedAudioStream(stream: MediaStream) {
            this.processedAudioStream = stream;
        },
        setBpm(bpm: number) {
            this.bpm = bpm;
            // Update playback rate for all tracks
            // We need to import AudioEngine dynamically or assume it's available globally or imported
            // Since this is a store, importing the singleton is fine.
            // But we need to be careful about circular dependencies if AudioEngine uses the store.
            // AudioEngine does NOT use the store directly in its core logic usually.
            // Let's try dynamic import or just import at top if safe.
            // For now, let's assume we can access the singleton.
            import('@/audio/core/AudioEngine').then(({ AudioEngine }) => {
                AudioEngine.getInstance().updateAllTracksPlaybackRate(bpm);
            });
        },
        setMetronomeStatus(status: 'OFF' | 'READY' | 'PLAYING') {
            this.metronomeStatus = status;
        }
    },
});
