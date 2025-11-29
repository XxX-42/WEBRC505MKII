import { defineStore } from 'pinia'
import { reactive } from 'vue'

interface TrackState {
    isPlaying: boolean;
    isRecording: boolean;
    volume: number;
    audioBuffer: Blob | null;
    startTime: number;
}

export const useTrackStore = defineStore('trackStore', () => {
    //在这里进行track的数量设置
    const tracks = reactive<TrackState[]>(Array(5).fill({
        isPlaying: false,
        isRecording: false,
        volume: 0.8,
        audioBuffer: null,
        startTime: 0
    }))

    const updateTrack = (index: number, updatedTrack: Partial<TrackState>) => {
        Object.assign(tracks[index], updatedTrack)
    }

    const getTracks = () => tracks

    return {
        tracks,
        updateTrack,
        getTracks
    }
})
