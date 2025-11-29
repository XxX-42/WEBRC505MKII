
// Actually, I should redefine the enum or import it if it was in a separate file. 
// The previous file had the enum inside it. I will keep it there.

export enum TrackState {
    EMPTY = 'EMPTY',
    REC_STANDBY = 'REC_STANDBY',
    RECORDING = 'RECORDING',
    PLAY = 'PLAY',
    OVERDUB = 'OVERDUB',
    STOP = 'STOP'
}

export class AudioTrack {
    public readonly id: number;
    public state: TrackState;

    // Audio Nodes
    private readonly context: AudioContext;
    private readonly gainNode: GainNode;
    private readonly pannerNode: StereoPannerNode;

    // Recording
    private recorderNode: AudioWorkletNode | null = null;
    private recordingBuffer: Float32Array[] = []; // Stores raw chunks
    private recordingStartTime: number = 0;
    public baseBpm: number = 120; // BPM at the time of recording

    // Playback
    private loopBuffer: AudioBuffer | null = null;
    private playSource: AudioBufferSourceNode | null = null;
    private loopLength: number = 0; // In seconds
    public currentPlaybackRate: number = 1.0;
    private lastPlayTime: number = 0;
    private lastPlayOffset: number = 0;

    constructor(id: number, context: AudioContext, destination: AudioNode) {
        this.id = id;
        this.context = context;
        this.state = TrackState.EMPTY;

        // Initialize Nodes
        this.gainNode = this.context.createGain();
        this.pannerNode = this.context.createStereoPanner();

        // Default values
        this.gainNode.gain.value = 1.0;
        this.pannerNode.pan.value = 0;

        // Connect Graph: [Source] -> Panner -> Gain -> Destination
        this.pannerNode.connect(this.gainNode);
        this.gainNode.connect(destination);
    }

    /**
     * Start Recording from a source (e.g., Microphone)
     */
    public async startRecording(source: AudioNode): Promise<void> {
        if (this.state === TrackState.RECORDING || this.state === TrackState.OVERDUB) return;

        // Clear buffer if starting fresh recording (not overdubbing onto existing)
        // For simple Rec -> Overdub, we are creating the FIRST layer.
        this.recordingBuffer = [];

        // Check if Worklet is loaded
        // We need to access AudioEngine singleton or pass it in. 
        // Since AudioTrack is created by AudioEngine, we can assume AudioEngine is initialized if we are here?
        // BUT startRecording is async and user triggered.
        // Let's import AudioEngine to check the flag.
        const { AudioEngine } = await import('./AudioEngine');
        if (!AudioEngine.getInstance().isWorkletLoaded) {
            console.warn('AudioTrack: Worklet not loaded yet. Waiting...');
            await AudioEngine.getInstance().init();
        }

        try {
            this.recorderNode = new AudioWorkletNode(this.context, 'recorder-processor');
        } catch (e) {
            console.error('Failed to create AudioWorkletNode. Did you call AudioEngine.init()?', e);
            return;
        }

        this.recorderNode.port.onmessage = (event) => {
            if (event.data.eventType === 'data') {
                const input = event.data.audioBuffer;
                if (input && input.length > 0) {
                    // input is Float32Array[] (channels)
                    // We assume Mono for now or just take channel 0
                    // If stereo, we might need to interleave or store both.
                    // For simplicity, let's take channel 0.
                    this.recordingBuffer.push(new Float32Array(input[0]));
                }
            }
        };

        source.connect(this.recorderNode);

        // Dummy output to keep processor alive
        const dummyGain = this.context.createGain();
        dummyGain.gain.value = 0;
        this.recorderNode.connect(dummyGain);
        dummyGain.connect(this.context.destination);

        this.recorderNode.port.postMessage({ command: 'start' });

        if (this.state === TrackState.PLAY) {
            this.state = TrackState.OVERDUB;
        } else {
            this.state = TrackState.RECORDING;
        }

        this.recordingStartTime = this.context.currentTime;
        console.log(`Track ${this.id}: Recording started (State: ${this.state})`);
    }

    /**
     * Stop Recording and process buffer immediately.
     * @param nextState The state to transition to ('PLAY' or 'OVERDUB').
     */
    public stopRecording(nextState: 'PLAY' | 'OVERDUB' = 'PLAY'): void {
        if ((this.state !== TrackState.RECORDING && this.state !== TrackState.OVERDUB) || !this.recorderNode) return;

        // 1. Stop Recorder
        this.recorderNode.port.postMessage({ command: 'stop' });
        this.recorderNode.disconnect();
        this.recorderNode = null;

        // 2. Promote Buffer (Synchronous & Immediate)
        this.promoteToLoop();

        console.log(`Track ${this.id}: Recording stopped. Buffer length: ${this.loopLength.toFixed(2)}s`);

        // 3. Immediate Playback (Already started in promoteToLoop if successful)

        if (this.loopBuffer) {
            if (nextState === 'OVERDUB') {
                this.state = TrackState.OVERDUB;
                // Keep Input Gain OPEN (handled by caller or default)
                // TODO: Initialize a new recording buffer for the overdub layer if we support it immediately
            } else {
                this.state = TrackState.PLAY;
                // Mute Input Gain (handled by caller or default)
            }
        } else {
            this.state = TrackState.STOP;
        }
    }

    /**
     * Synchronously creates an AudioBuffer from recorded chunks and starts playing IMMEDIATELY.
     */
    private promoteToLoop(): void {
        const length = this.recordingBuffer.reduce((acc, chunk) => acc + chunk.length, 0);
        if (length === 0) return;

        // Create AudioBuffer
        this.loopBuffer = this.context.createBuffer(1, length, this.context.sampleRate);
        const channelData = this.loopBuffer.getChannelData(0);

        // Flatten chunks (Optimized)
        let offset = 0;
        for (const chunk of this.recordingBuffer) {
            channelData.set(chunk, offset);
            offset += chunk.length;
        }

        this.loopLength = this.loopBuffer.duration;

        // Clear chunks to free memory and prepare for next layer
        this.recordingBuffer = [];

        // START PLAYBACK IMMEDIATELY
        this.play(0);
    }

    /**
     * Update playback rate based on global BPM.
     * Formula: Rate = GlobalBPM / BaseBPM
     */
    public updatePlaybackRate(globalBpm: number): void {
        if (this.playSource && this.baseBpm > 0) {
            const rate = globalBpm / this.baseBpm;
            // Smooth transition
            this.playSource.playbackRate.setTargetAtTime(rate, this.context.currentTime, 0.01);
            this.currentPlaybackRate = rate;
        }
    }

    /**
     * Play the loop
     */
    private loopStartRefTime: number = 0;

    /**
     * Play the loop
     * @param startTime Absolute AudioContext time to start playing. Defaults to now.
     */
    public play(startTime: number = 0): void {
        if (this.state === TrackState.PLAY || this.state === TrackState.OVERDUB) return;
        if (!this.loopBuffer) {
            console.error('[AudioTrack] No buffer to play!');
            return;
        }

        this.stop(); // Stop existing if any

        this.playSource = this.context.createBufferSource();
        this.playSource.buffer = this.loopBuffer;
        this.playSource.loop = true;
        this.playSource.playbackRate.value = this.currentPlaybackRate;
        this.playSource.connect(this.pannerNode);

        // Calculate alignment time
        // If startTime is 0 or in the past, start NOW.
        // If startTime is in the future, schedule it.
        const now = this.context.currentTime;
        const playTime = startTime > now ? startTime : now;

        this.loopStartRefTime = playTime;

        this.playSource.start(playTime);

        this.state = TrackState.PLAY;
        console.log(`[AudioTrack ${this.id}] Playing started at ${playTime.toFixed(3)}, Duration: ${this.loopBuffer.duration.toFixed(3)}`);
    }

    /**
     * Get current playback progress (0.0 to 1.0)
     */
    public getProgress(): number {
        if (this.state !== TrackState.PLAY && this.state !== TrackState.OVERDUB) return 0;
        if (!this.loopBuffer || !this.loopStartRefTime) return 0;

        const duration = this.loopBuffer.duration;
        if (duration === 0) return 0;

        // Elapsed time since "start" (virtual or real)
        const elapsedTime = (this.context.currentTime - this.loopStartRefTime) * this.currentPlaybackRate;

        // Modulo to get position within loop
        const currentLoopTime = elapsedTime % duration;

        const progress = currentLoopTime / duration;

        // Throttle logging (approx every 60 calls if called at 60fps)
        // Using a simple random check or counter would be better, but random is easiest for stateless
        if (Math.random() < 0.01) {
            console.log(`[AudioTrack ${this.id}] Progress: ${progress.toFixed(3)} (Time: ${this.context.currentTime.toFixed(2)})`);
        }

        return progress;
    }

    /**
     * Stop playback
     */
    public stop(): void {
        if (this.playSource) {
            try {
                this.playSource.stop();
            } catch (e) {
                // Ignore if already stopped
            }
            this.playSource.disconnect();
            this.playSource = null;
        }
        this.state = TrackState.STOP;
    }

    public setVolume(value: number): void {
        this.gainNode.gain.setTargetAtTime(value, this.context.currentTime, 0.01);
    }

    public setPan(value: number): void {
        const clampedValue = Math.max(-1, Math.min(1, value));
        this.pannerNode.pan.setTargetAtTime(clampedValue, this.context.currentTime, 0.01);
    }

    public getInputNode(): AudioNode {
        return this.pannerNode;
    }

    public getState(): TrackState {
        return this.state;
    }

    public getDuration(): number {
        return this.loopLength;
    }
}
