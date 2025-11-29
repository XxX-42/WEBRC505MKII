// src/composables/useTrack.ts
import { reactive, computed, watch } from 'vue'
import { useMetronome } from './useMetronome'

export function useTrack(initialBpm: number) {
    // 音轨的状态，包括是否在播放、是否录制、当前 BPM 等等
    const trackState = reactive({
        isPlaying: false,
        isRecording: false,
        volume: 0,        // 用于存储音量
        duration: 0,
        audioBuffer: null,
        startTime: 0,
        bpm: initialBpm,
        flash: false,     // 用于闪烁显示
    })

    /**
     * 每次拍点时调用：
     * 将 flash 设置为 true，然后 100ms 后复原为 false。
     */
    const onTick = () => {
        trackState.flash = true
        setTimeout(() => {
            trackState.flash = false
        }, 100)
    }

    // 调用 useMetronome 时传入初始 BPM 和 onTick 回调
    // useTrack.ts 中的修改部分
    const { start, stop, updateBpm } = useMetronome(initialBpm, onTick);


    // 将 duration 转换成 "分:秒" 格式的字符串
    const formattedTime = computed(() => {
        const mins = Math.floor(trackState.duration / 60)
        const secs = Math.floor(trackState.duration % 60)
        return `${mins}:${secs.toString().padStart(2, '0')}`
    })

    /**
     * 切换播放/暂停
     */
    const togglePlayback = () => {
        trackState.isPlaying = !trackState.isPlaying
        if (trackState.isPlaying) {
            trackState.startTime = Date.now()
            start()  // 修改为 start()
        } else {
            stop()   // 修改为 stop()
        }
    }

// watch监听器中BPM变化时的调用也修改为 updateBpm()
    watch(
        () => trackState.bpm,
        (newBpm) => {
            if (trackState.isPlaying) {
                updateBpm(newBpm)
            }
        }
    )


    return {
        trackState,
        togglePlayback,
        formattedTime,
        onTick,
    }
}
