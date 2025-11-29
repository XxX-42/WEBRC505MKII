import { AudioTrack } from './AudioTrack';
import { Scheduler } from './Scheduler';

export class AudioEngine {
    private static instance: AudioEngine;

    public readonly audioContext: AudioContext;
    public readonly masterGain: GainNode;
    public readonly scheduler: Scheduler;

    // Track Management
    private tracks: Map<number, AudioTrack> = new Map();

    private constructor() {
        // Initialize AudioContext with low latency settings
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.audioContext = new AudioContextClass({
            latencyHint: 'interactive',
            sampleRate: 44100
        });

        // Create Master Gain Node
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = 1.0;
        this.masterGain.connect(this.audioContext.destination);

        // Initialize Scheduler
        this.scheduler = new Scheduler(this.audioContext);
    }

    /**
     * Get the Singleton instance of the AudioEngine
     */
    public static getInstance(): AudioEngine {
        if (!AudioEngine.instance) {
            AudioEngine.instance = new AudioEngine();
        }
        return AudioEngine.instance;
    }

    /**
     * Initialize the Audio Engine.
     * Must be called after a user gesture to unlock the AudioContext.
     */
    public isWorkletLoaded: boolean = false;

    /**
     * Initialize the Audio Engine.
     * Must be called after a user gesture to unlock the AudioContext.
     */
    public async init(): Promise<void> {
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
            console.log('AudioEngine: AudioContext resumed');
        }

        if (this.isWorkletLoaded) return;

        try {
            // Import worklet as a worker URL using Vite's ?url suffix
            // @ts-ignore
            const workletUrl = (await import('../../audio/worklets/recorder.processor.ts?url')).default;
            await this.audioContext.audioWorklet.addModule(workletUrl);
            this.isWorkletLoaded = true;
            console.log('AudioEngine: Recorder module loaded successfully');
        } catch (e) {
            console.error('AudioEngine: Failed to load recorder module', e);
            throw e;
        }
    }

    private microphoneSource: MediaStreamAudioSourceNode | null = null;

    /**
     * Initialize Microphone Input
     */
    public async initMicrophone(): Promise<void> {
        if (this.microphoneSource) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            this.microphoneSource = this.audioContext.createMediaStreamSource(stream);
            console.log('AudioEngine: Microphone initialized');
        } catch (error) {
            console.error('AudioEngine: Failed to access microphone', error);
            throw error;
        }
    }

    /**
     * Get the global microphone source node.
     * Ensure initMicrophone() is called first.
     */
    public getMicrophoneSource(): MediaStreamAudioSourceNode | null {
        return this.microphoneSource;
    }

    /**
     * Create or retrieve a track by ID.
     * @param id Track ID
     */
    public getTrack(id: number): AudioTrack {
        if (!this.tracks.has(id)) {
            const newTrack = new AudioTrack(id, this.audioContext, this.masterGain);
            this.tracks.set(id, newTrack);
        }
        return this.tracks.get(id)!;
    }

    /**
     * Set Master Volume
     * @param value Volume (0.0 to 1.0)
     */
    public setMasterVolume(value: number): void {
        this.masterGain.gain.setTargetAtTime(value, this.audioContext.currentTime, 0.01);
    }

    /**
     * Get current time from AudioContext
     */
    public get currentTime(): number {
        return this.audioContext.currentTime;
    }

    /**
     * Calculate BPM and Measures from a recording duration.
     * Alias for calculateMusicalGrid to satisfy interface requirements.
     */
    public calculateBpmFromDuration(durationSeconds: number): { bpm: number, measures: number } {
        const result = this.calculateMusicalGrid(durationSeconds);
        return { bpm: result.bpm, measures: result.measures };
    }

    /**
     * Calculate the best fitting BPM and Measure count for a given duration.
     * Assumes 4/4 Time Signature.
     * Prioritizes BPM range 80-160.
     */
    public calculateMusicalGrid(durationSeconds: number): { bpm: number, measures: number, error: number } {
        if (durationSeconds < 1.0) {
            console.warn("Duration too short for grid calculation, defaulting to 120 BPM");
            return { bpm: 120, measures: 1, error: 0 };
        }

        const minBpm = 80;
        const maxBpm = 160;
        const candidateMeasures = [1, 2, 4, 8, 16, 32];

        let bestFit = { bpm: 120, measures: 4, error: Infinity };

        for (const measures of candidateMeasures) {
            // BPM = (Measures * 4 beats * 60s) / Duration
            const rawBpm = (measures * 240) / durationSeconds;

            // Calculate error score
            // 1. Distance from integer BPM (we prefer integer BPMs)
            const integerError = Math.abs(rawBpm - Math.round(rawBpm));

            // 2. Range Penalty
            let rangePenalty = 0;
            if (rawBpm < minBpm || rawBpm > maxBpm) {
                // Heavy penalty for being out of range
                rangePenalty = 1000 + Math.min(Math.abs(rawBpm - minBpm), Math.abs(rawBpm - maxBpm));
            } else {
                // Slight preference for 100-130 range?
                // Let's just use distance from 120 as a tie breaker if needed, but integer error is more important.
                rangePenalty = Math.abs(rawBpm - 120) * 0.01;
            }

            const totalError = integerError * 10 + rangePenalty;

            if (totalError < bestFit.error) {
                bestFit = {
                    bpm: Math.round(rawBpm), // Snap to nearest integer for the result
                    measures: measures,
                    error: totalError
                };
            }
        }

        // Recalculate exact BPM based on the rounded BPM if we want to snap the grid to the audio?
        // OR should we adjust the BPM to match the audio exactly?
        // The requirement says "Score the RawBPM: Is it an integer?".
        // Usually, we want to set the system BPM to the exact value derived from the audio loop 
        // if we want the audio to loop perfectly without time-stretching.
        // BUT, if we want "Snap to Grid", we usually mean snapping the audio to a fixed BPM.
        // "First Track BPM Detection" usually means "Set System BPM to match this track".
        // So we should return the exact BPM that makes this duration fit the measures.
        // Re-calculating exact BPM from the chosen measures:
        const exactBpm = (bestFit.measures * 240) / durationSeconds;

        console.log(`Grid Calculation: Duration=${durationSeconds.toFixed(3)}s -> Measures=${bestFit.measures}, BPM=${exactBpm.toFixed(2)} (Target Integer: ${bestFit.bpm})`);

        return {
            bpm: exactBpm,
            measures: bestFit.measures,
            error: bestFit.error
        };
    }

    /**
     * Quantize a duration to the nearest exact measure length at the given BPM.
     */
    public quantizeDuration(rawDuration: number, bpm: number): number {
        const secondsPerBeat = 60.0 / bpm;
        const measureDuration = secondsPerBeat * 4; // 4/4 signature

        const measureCount = Math.round(rawDuration / measureDuration);
        const clampedMeasures = Math.max(1, measureCount);

        return clampedMeasures * measureDuration;
    }
    /**
     * Update playback rate for all tracks based on new global BPM.
     */
    public updateAllTracksPlaybackRate(newBpm: number): void {
        this.tracks.forEach(track => {
            track.updatePlaybackRate(newBpm);
        });
    }
}
