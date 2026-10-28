import { TransportState } from './types';

export class Transport {
    private static instance: Transport;

    private projectMutationRevisionValue = 0;
    private bpmValue = 120;
    private timeSignatureValue: readonly [number, number] = Object.freeze([4, 4]);
    private stateValue: TransportState = TransportState.STOPPED;
    private masterTrackIdValue: number | null = null;
    private masterLoopLengthSamplesValue = 0;
    private measureLengthValue = 0;
    /** Audio-clock frame at which the current Browser master loop began. */
    private masterPhaseOriginFrameValue: number | null = null;
    private masterMeasureFramesValue: number | null = null;

    /** Monotonic epoch for values captured by project-load transactions. */
    public get projectMutationRevision(): number { return this.projectMutationRevisionValue; }

    private noteProjectMutation(): void {
        // Once exhausted, callers can reject a new snapshot instead of risking
        // an ABA match after the epoch stops being able to advance.
        if (this.projectMutationRevisionValue < Number.MAX_SAFE_INTEGER) {
            this.projectMutationRevisionValue += 1;
        }
    }

    public get bpm(): number { return this.bpmValue; }
    public set bpm(value: number) {
        if (this.bpmValue === value) return;
        this.clearMasterPhaseOrigin();
        this.bpmValue = value;
        this.noteProjectMutation();
    }

    public get timeSignature(): readonly [number, number] { return this.timeSignatureValue; }
    public set timeSignature(value: [number, number]) {
        if (this.timeSignatureValue[0] === value[0] && this.timeSignatureValue[1] === value[1]) return;
        this.clearMasterPhaseOrigin();
        this.timeSignatureValue = Object.freeze([value[0], value[1]]);
        this.noteProjectMutation();
        this.emit('time-signature-change');
    }

    public get quarterNotesPerMeasure(): number {
        const value = this.timeSignatureValue[0] * 4 / this.timeSignatureValue[1];
        return Number.isFinite(value) && value > 0 ? Math.max(0.125, Math.min(128, value)) : 4;
    }

    public get state(): TransportState { return this.stateValue; }
    public set state(value: TransportState) {
        if (this.stateValue === value) return;
        this.stateValue = value;
        this.noteProjectMutation();
    }

    private listeners: Map<string, Function[]> = new Map();
    private clockInterval: number | null = null;

    public get masterTrackId(): number | null { return this.masterTrackIdValue; }
    public set masterTrackId(value: number | null) {
        if (this.masterTrackIdValue === value) return;
        this.clearMasterPhaseOrigin();
        this.masterTrackIdValue = value;
        this.noteProjectMutation();
    }

    public get masterLoopLengthSamples(): number { return this.masterLoopLengthSamplesValue; }
    public set masterLoopLengthSamples(value: number) {
        if (this.masterLoopLengthSamplesValue === value) return;
        this.clearMasterPhaseOrigin();
        this.masterLoopLengthSamplesValue = value;
        this.noteProjectMutation();
    }

    public get measureLength(): number { return this.measureLengthValue; }
    public set measureLength(value: number) {
        if (this.measureLengthValue === value) return;
        this.clearMasterPhaseOrigin();
        this.measureLengthValue = value;
        this.noteProjectMutation();
    }

    /**
     * Publish a phase only when a caller can tie it to an actual audio source
     * start. Wall-clock Transport events are deliberately not phase evidence.
     */
    public establishMasterPhaseOrigin(trackId: number, frame: number, measureFrames: number): boolean {
        if (trackId !== this.masterTrackId || !Number.isSafeInteger(frame) || frame < 0
            || !Number.isSafeInteger(measureFrames) || measureFrames <= 0 || this.masterLoopLengthSamples <= 0) return false;
        this.masterPhaseOriginFrameValue = frame;
        this.masterMeasureFramesValue = measureFrames;
        return true;
    }

    public clearMasterPhaseOrigin(): void {
        this.masterPhaseOriginFrameValue = null;
        this.masterMeasureFramesValue = null;
    }

    /** Return the next measure boundary on the established audio-frame timeline. */
    public getNextMeasureStartFrame(currentFrame: number): number | null {
        const origin = this.masterPhaseOriginFrameValue;
        const measureFrames = this.masterMeasureFramesValue;
        if (origin === null || measureFrames === null || !Number.isSafeInteger(currentFrame) || currentFrame < 0
            || !Number.isSafeInteger(origin) || !Number.isSafeInteger(measureFrames) || measureFrames <= 0) return null;
        if (currentFrame <= origin) return origin;
        const elapsed = currentFrame - origin;
        const measures = Math.ceil(elapsed / measureFrames);
        const boundary = origin + measures * measureFrames;
        return Number.isSafeInteger(boundary) ? boundary : null;
    }

    private constructor() { }

    public static getInstance(): Transport {
        if (!Transport.instance) {
            Transport.instance = new Transport();
        }
        return Transport.instance;
    }

    public start() {
        if (this.state === TransportState.PLAYING) return;
        this.state = TransportState.PLAYING;
        this.emit('start');

        // Start Clock
        const interval = 25; // ms
        const beatDurationMs = (60 / this.bpm) * 1000;
        let nextBeatTime = performance.now();
        let nextMeasureTime = performance.now();

        // If we have a measure length, align to it
        if (this.measureLength > 0) {
            nextMeasureTime = performance.now() + (this.measureLength * 1000);
        }

        this.clockInterval = window.setInterval(() => {
            const now = performance.now();

            if (now >= nextBeatTime - interval) {
                this.emit('beat');
                nextBeatTime += beatDurationMs;
            }

            if (this.measureLength > 0) {
                // Check if we are close to next measure (within interval)
                if (now >= nextMeasureTime - interval) {
                    this.emit('measure');
                    // Advance next measure time
                    nextMeasureTime += (this.measureLength * 1000);
                }
            }

        }, interval);
    }

    public stop() {
        if (this.state === TransportState.STOPPED) return;
        this.state = TransportState.STOPPED;
        this.clearMasterPhaseOrigin();
        if (this.clockInterval) {
            clearInterval(this.clockInterval);
            this.clockInterval = null;
        }
        this.emit('stop');
    }

    public setBpm(bpm: number) {
        this.bpm = Math.max(40, Math.min(300, bpm));
        this.emit('bpm-change');
        console.log(`BPM updated to: ${this.bpm}`);
    }

    public on(event: string, callback: Function) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(callback);
    }

    public off(event: string, callback: Function) {
        const callbacks = this.listeners.get(event);
        if (!callbacks) return;

        const nextCallbacks = callbacks.filter(cb => cb !== callback);
        if (nextCallbacks.length === 0) {
            this.listeners.delete(event);
            return;
        }

        this.listeners.set(event, nextCallbacks);
    }

    private emit(event: string) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.forEach(cb => cb(event));
        }
    }

    public getMeasureDuration(): number {
        // BPM is quarter notes per minute, so e.g. 6/8 contains 3 quarter-note
        // beats and 5/8 contains 2.5. This also keeps non-4/4 loop timing coherent.
        const quarterNotesPerMeasure = this.timeSignature[0] * 4 / this.timeSignature[1];
        const secondsPerBeat = 60 / this.bpm;
        return quarterNotesPerMeasure * secondsPerBeat;
    }

    /**
     * Set the master track and calculate BPM based on recording duration
     * 
     * Algorithm:
     * - Assumes the recording represents 1, 2, 4, or 8 measures
     * - Calculates BPM for each possibility
     * - Selects the BPM that falls within 60-160 range and is closest to 120
     * - Formula: BPM = (Beats × 60) / Duration
     * 
     * @param trackId - ID of the track becoming master
     * @param durationSeconds - Duration of the recorded loop in seconds
     * @param sampleRate - Sample rate of the audio context
     * @param lengthSamples - Length of the loop in samples
     */
    public setMasterTrack(trackId: number, durationSeconds: number, sampleRate: number, lengthSamples: number) {
        // Only allow first track to become master
        if (this.masterTrackId !== null) {
            console.warn(`Master track already set to Track ${this.masterTrackId}`);
            return;
        }

        this.masterTrackId = trackId;
        this.measureLength = durationSeconds;
        this.masterLoopLengthSamples = lengthSamples;

        // ========================================
        // DYNAMIC BPM CALCULATION
        // ========================================

        const TARGET_MIN_BPM = 60;
        const TARGET_MAX_BPM = 160;
        const IDEAL_BPM = 120; // Prefer BPM closest to this value

        const quarterNotesPerMeasure = this.timeSignature[0] * 4 / this.timeSignature[1];
        let bestBpm = IDEAL_BPM;
        let bestMeasureCount = 4;
        let minDiff = Infinity;

        // Try different measure counts: 1, 2, 4, 8 measures
        const possibleMeasureCounts = [1, 2, 4, 8];

        console.log(`\n=== Master Track BPM Calculation ===`);
        console.log(`Track ${trackId} duration: ${durationSeconds.toFixed(3)}s`);
        console.log(`Time signature: ${this.timeSignature[0]}/${this.timeSignature[1]}`);

        possibleMeasureCounts.forEach(measureCount => {
            const totalBeats = measureCount * quarterNotesPerMeasure;

            // BPM = (Beats × 60) / Duration
            const calculatedBpm = (totalBeats * 60) / durationSeconds;

            console.log(`  ${measureCount} measure(s): ${totalBeats} beats → ${calculatedBpm.toFixed(2)} BPM`);

            // Check if BPM is within acceptable range
            if (calculatedBpm >= TARGET_MIN_BPM && calculatedBpm <= TARGET_MAX_BPM) {
                // Prefer BPM closest to IDEAL_BPM (120)
                const diff = Math.abs(calculatedBpm - IDEAL_BPM);

                if (diff < minDiff) {
                    minDiff = diff;
                    bestBpm = calculatedBpm;
                    bestMeasureCount = measureCount;
                }
            }
        });

        // Round to nearest integer for cleaner BPM values
        const finalBpm = Math.round(bestBpm);

        console.log(`\n✓ Selected: ${bestMeasureCount} measure(s) → ${finalBpm} BPM`);
        console.log(`  Loop length: ${lengthSamples} samples @ ${sampleRate}Hz`);
        console.log(`=====================================\n`);

        // Update global BPM (this will trigger UI update via 'bpm-change' event)
        this.setBpm(finalBpm);

        // Recalculate measure length based on new BPM
        // This ensures slave tracks align to the calculated tempo
        this.measureLength = this.getMeasureDuration();
    }

    /**
     * Reset master track (for clearing all tracks)
     */
    public resetMasterTrack() {
        this.masterTrackId = null;
        this.masterLoopLengthSamples = 0;
        this.measureLength = 0;
        this.clearMasterPhaseOrigin();
        console.log('Master track reset');
    }

    /**
     * Check if there's a master track
     */
    public hasMasterTrack(): boolean {
        return this.masterTrackId !== null;
    }

    // ========================================
    // QUANTIZATION SCHEDULER
    // ========================================

    /**
     * Get the next measure start time in AudioContext time
     * Used for quantizing slave track recording start
     * 
     * @param currentTime - Current AudioContext time
     * @param sampleRate - Audio context sample rate
     * @returns Next measure boundary time in AudioContext time
     */
    public getNextMeasureStartTime(currentTime: number, sampleRate: number): number {
        if (!this.hasMasterTrack() || this.masterLoopLengthSamples === 0) {
            // No master track - start immediately
            return currentTime;
        }

        // Calculate master loop duration in seconds
        const loopDuration = this.masterLoopLengthSamples / sampleRate;

        // Find current position within the master loop
        // Assuming master loop started at time 0 (simplified for now)
        const positionInLoop = currentTime % loopDuration;

        // Calculate time until next loop start (which is also a measure boundary)
        const timeUntilNextMeasure = loopDuration - positionInLoop;

        // Return the absolute time of the next measure
        return currentTime + timeUntilNextMeasure;
    }

    /**
     * Get the number of samples until the next measure boundary
     * Used for precise sample-accurate quantization
     * 
     * @param currentSample - Current sample position in the audio stream
     * @param sampleRate - Audio context sample rate
     * @returns Number of samples until next measure boundary
     */
    public getNextMeasureStartSample(currentSample: number, _sampleRate: number): number {
        if (!this.hasMasterTrack() || this.masterLoopLengthSamples === 0) {
            // No master track - start immediately (0 samples to wait)
            return 0;
        }

        // Find current position within the master loop (in samples)
        const positionInLoop = currentSample % this.masterLoopLengthSamples;

        // Calculate samples until next loop start
        const samplesUntilNextMeasure = this.masterLoopLengthSamples - positionInLoop;

        return samplesUntilNextMeasure;
    }

    /**
     * Calculate the quantized loop length for a slave track
     * Ensures the recorded length is a multiple of the master loop length
     * 
     * @param recordedSamples - Number of samples recorded
     * @returns Quantized length (trimmed or extended to nearest master loop multiple)
     */
    public quantizeLoopLength(recordedSamples: number): number {
        if (!this.hasMasterTrack() || this.masterLoopLengthSamples === 0) {
            // No master track - return as-is
            return recordedSamples;
        }

        // Calculate how many master loops fit into the recording
        const loopCount = Math.round(recordedSamples / this.masterLoopLengthSamples);

        // Ensure at least 1 loop
        const finalLoopCount = Math.max(1, loopCount);

        // Return quantized length
        return finalLoopCount * this.masterLoopLengthSamples;
    }

    /**
     * Get current playback position within the master loop (0.0 to 1.0)
     * Used for visual synchronization
     * 
     * @param currentTime - Current AudioContext time
     * @param sampleRate - Audio context sample rate
     * @returns Position within loop (0.0 = start, 1.0 = end/loop point)
     */
    public getMasterLoopPosition(currentTime: number, sampleRate: number): number {
        if (!this.hasMasterTrack() || this.masterLoopLengthSamples === 0) {
            return 0;
        }

        const loopDuration = this.masterLoopLengthSamples / sampleRate;
        const positionInLoop = currentTime % loopDuration;

        return positionInLoop / loopDuration;
    }
}
