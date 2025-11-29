import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { calculateBpmFromDuration } from '@/audio/core/GridMath';
import { useAudioStore } from './audio';
import { AudioEngine } from '@/audio/core/AudioEngine';

interface TrackState {
    isPlaying: boolean;
    isRecording: boolean;
    volume: number;
    audioBuffer: Blob | null;
    startTime: number;
    pendingAction: 'record' | 'play' | 'stop' | null;
    quantizeMode: 'FREE' | 'SNAP_TO_MEASURE';
    measureCount?: number;
}

export const useTrackStore = defineStore('trackStore', () => {
    //在这里进行track的数量设置
    const tracks = reactive<TrackState[]>(Array.from({ length: 5 }, () => ({
        isPlaying: false,
        isRecording: false,
        volume: 0.8,
        audioBuffer: null,
        startTime: 0,
        pendingAction: null,
        quantizeMode: 'FREE',
        measureCount: 0
    })))

    const updateTrack = (index: number, updatedTrack: Partial<TrackState>) => {
        Object.assign(tracks[index], updatedTrack)
    }

    const getTracks = () => tracks

    const setPendingAction = (index: number, action: 'record' | 'play' | 'stop') => {
        tracks[index].pendingAction = action;
    }

    const clearPendingAction = (index: number) => {
        tracks[index].pendingAction = null;
    }

    const getTrack = (index: number) => tracks[index];

    const isFirstTrackRecording = () => {
        // Check if all tracks are empty (no audioBuffer)
        return tracks.every(t => !t.audioBuffer);
    }

    /**
     * Stop Recording Action with First Track Logic
     * @param trackIndex Index of the track
     * @param durationSeconds Duration of the recording in seconds
     */
    const stopRecording = async (trackIndex: number, durationSeconds: number) => {
        const track = tracks[trackIndex];
        const audioStore = useAudioStore();
        const engine = AudioEngine.getInstance();

        // CASE 1: First Track & Free Mode (Rhythm was OFF)
        // We check if this track was set to FREE mode, which implies it started without rhythm.
        if (track.quantizeMode === 'FREE') {
            console.log(`[TrackStore] First Track Stop: Duration=${durationSeconds.toFixed(3)}s`);

            // 1. Calculate BPM
            const { bpm, measures } = calculateBpmFromDuration(durationSeconds);

            // 2. Commit to Global State
            audioStore.setBpm(bpm);

            // 3. Snap the Track Metadata
            track.measureCount = measures;
            track.quantizeMode = 'SNAP_TO_MEASURE'; // Now it is quantized to the new grid

            // 4. Reset Grid (Critical for alignment)
            // We assume the track started at 'startTime' (AudioContext time)
            // If we didn't capture startTime in the store, we might have an issue.
            // But usually we align to the END of the first track as the loop point?
            // No, the start of the first track is the start of the grid.
            // Let's assume we want to reset the grid to NOW (end of track) - duration?
            // Or just reset it to 0 relative to the loop?
            // The Scheduler needs a reference point.
            // engine.scheduler.resetGrid(track.startTime); // If we had it.
            // For now, let's just set the BPM. The Scheduler might need a "reset" call.
            // engine.scheduler.resetGrid(engine.currentTime - durationSeconds); 

            console.log(`[System] First Track Logic: Detected ${bpm.toFixed(2)} BPM (${measures} bars).`);
        }

        // CASE 2: Sync Mode (BPM already exists)
        else {
            // Logic to snap to existing grid is handled by the recording process (waiting for downbeat).
            // Here we just update state.
        }

        track.isRecording = false;
        // track.hasPhrase = true; // We use audioBuffer presence check usually
    }

    return {
        tracks,
        updateTrack,
        getTracks,
        setPendingAction,
        clearPendingAction,
        getTrack,
        isFirstTrackRecording,
        stopRecording
    }
})
