import { TransportState } from './types';

type TransportListener = (...args: unknown[]) => void;

export class Transport {
    private static instance: Transport;

    public bpm = 120;
    public timeSignature: [number, number] = [4, 4];
    public state: TransportState = TransportState.STOPPED;
    public masterTrackId: number | null = null;
    public masterLoopLengthSamples = 0;
    public measureLength = 0;
    public masterOriginFrame = 0;
    /** Independent beat/measure epoch; it does not move the master PCM phase. */
    public clockOriginFrame = 0;
    public hasClockEpoch = false;
    public sampleRate = 48_000;
    public masterPlaybackSpeed = 1;
    public masterPlaybackDirection: 1 | -1 = 1;

    private masterPlaybackAnchorFrame = 0;
    private masterPlaybackAnchorPosition = 0;
    private clockEpochSource: 'master' | 'external' | null = null;

    private listeners = new Map<string, TransportListener[]>();

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
    }

    public stop() {
        if (this.state === TransportState.STOPPED) return;
        this.state = TransportState.STOPPED;
        this.emit('stop');
    }

    public setBpm(bpm: number) {
        this.bpm = Math.max(40, Math.min(300, bpm));
        this.emit('bpm-change');
        console.log(`BPM updated to: ${this.bpm}`);
    }

    public on(event: string, callback: TransportListener) {
        const callbacks = this.listeners.get(event) ?? [];
        callbacks.push(callback);
        this.listeners.set(event, callbacks);
    }

    public off(event: string, callback: TransportListener) {
        const callbacks = this.listeners.get(event);
        if (!callbacks) return;
        const nextCallbacks = callbacks.filter((candidate) => candidate !== callback);
        if (nextCallbacks.length === 0) {
            this.listeners.delete(event);
        } else {
            this.listeners.set(event, nextCallbacks);
        }
    }

    public emitWorkletBeat(beatOrdinal: number, frame: number) {
        if (this.state !== TransportState.PLAYING) return;
        this.emit('beat', { beatOrdinal, frame });
        if (beatOrdinal % Math.max(1, this.timeSignature[0]) === 0) {
            this.emit('measure', { beatOrdinal, frame });
        }
    }

    public getMeasureDuration(): number {
        return this.timeSignature[0] * (60 / this.bpm);
    }

    public setMasterTrack(
        trackId: number,
        durationSeconds: number,
        sampleRate: number,
        lengthSamples: number,
        originFrame = 0,
    ) {
        if (this.masterTrackId !== null) {
            console.warn(`Master track already set to Track ${this.masterTrackId}`);
            return;
        }

        this.masterTrackId = trackId;
        this.masterLoopLengthSamples = Math.max(0, Math.floor(lengthSamples));
        this.masterOriginFrame = Math.max(0, Math.floor(originFrame));
        this.masterPlaybackSpeed = 1;
        this.masterPlaybackDirection = 1;
        this.masterPlaybackAnchorFrame = this.masterOriginFrame;
        this.masterPlaybackAnchorPosition = 0;
        this.sampleRate = Math.max(1, sampleRate);
        if (!this.hasClockEpoch || this.clockEpochSource !== 'external') {
            this.setClockEpoch(this.masterOriginFrame, undefined, undefined, 'master');
        }
        this.measureLength = durationSeconds;

        if (durationSeconds > 0 && this.clockEpochSource !== 'external') {
            const targetMinBpm = 60;
            const targetMaxBpm = 160;
            const idealBpm = 120;
            const beatsPerMeasure = this.timeSignature[0];
            let bestBpm = idealBpm;
            let minDiff = Infinity;

            for (const measureCount of [1, 2, 4, 8]) {
                const candidate = (measureCount * beatsPerMeasure * 60) / durationSeconds;
                if (candidate >= targetMinBpm && candidate <= targetMaxBpm) {
                    const difference = Math.abs(candidate - idealBpm);
                    if (difference < minDiff) {
                        minDiff = difference;
                        bestBpm = candidate;
                    }
                }
            }

            this.setBpm(Math.round(bestBpm));
            this.measureLength = this.getMeasureDuration();
        }

        this.emit('master-track-change', {
            trackId,
            loopFrames: this.masterLoopLengthSamples,
            originFrame: this.masterOriginFrame,
            sampleRate,
        });
    }

    public resetMasterTrack() {
        this.masterTrackId = null;
        this.masterLoopLengthSamples = 0;
        this.measureLength = 0;
        this.masterOriginFrame = 0;
        if (!this.hasClockEpoch) this.sampleRate = 48_000;
        this.masterPlaybackSpeed = 1;
        this.masterPlaybackDirection = 1;
        this.masterPlaybackAnchorFrame = 0;
        this.masterPlaybackAnchorPosition = 0;
        if (this.clockEpochSource === 'master') this.clearClockEpoch();
        this.emit('master-track-change', null);
        console.log('Master track reset');
    }

    public hasMasterTrack(): boolean {
        return this.masterTrackId !== null && this.masterLoopLengthSamples > 0;
    }

    /**
     * Set the beat/measure grid origin without altering the master PCM phase.
     * External clock callers can pass `ack.targetFrame - beatOrdinal *
     * beatPeriod`; the Worklet phase-locks to the scheduled target even when a
     * late command executes later. A fractional origin preserves MIDI phase.
     */
    public setClockEpoch(
        originFrame: number,
        bpm?: number,
        sampleRate?: number,
        source: 'master' | 'external' = 'external',
    ): void {
        if (!Number.isFinite(originFrame)) throw new RangeError('Clock epoch must be finite.');
        if (bpm !== undefined) this.bpm = Math.max(40, Math.min(300, bpm));
        if (sampleRate !== undefined) this.sampleRate = Math.max(1, sampleRate);
        this.clockOriginFrame = originFrame;
        this.hasClockEpoch = true;
        this.clockEpochSource = source;
    }

    public clearClockEpoch(): void {
        this.clockOriginFrame = 0;
        this.hasClockEpoch = false;
        this.clockEpochSource = null;
    }

    /** Re-anchor the real master playback cursor after an effective speed change. */
    public setMasterPlaybackSpeed(
        speed: number,
        anchorFrame: number,
        sourcePosition: number,
        direction: 1 | -1 = 1,
    ): void {
        if (!Number.isFinite(speed) || !Number.isFinite(anchorFrame) || !Number.isFinite(sourcePosition)) {
            throw new RangeError('Master playback speed and phase anchor must be finite.');
        }
        this.masterPlaybackSpeed = Math.max(0.25, Math.min(4, speed));
        this.masterPlaybackDirection = direction === -1 ? -1 : 1;
        this.masterPlaybackAnchorFrame = Math.max(0, Math.floor(anchorFrame));
        if (this.masterLoopLengthSamples > 0) {
            const position = sourcePosition % this.masterLoopLengthSamples;
            this.masterPlaybackAnchorPosition = position < 0 ? position + this.masterLoopLengthSamples : position;
        } else {
            this.masterPlaybackAnchorPosition = 0;
        }
    }

    /** Expected output-frame duration of one master source-loop traversal. */
    public getMasterPlaybackPeriodFrames(): number {
        if (!this.hasMasterTrack()) return 0;
        return Math.max(1, Math.ceil(this.masterLoopLengthSamples / this.masterPlaybackSpeed));
    }

    public getNextMeasureStartFrame(currentFrame: number, safetyFrames = 0): number {
        if (!this.hasClockEpoch) return Math.max(0, Math.floor(currentFrame + safetyFrames));
        // Keep the fractional beat period through the division. Rounding the
        // period once and repeatedly adding it can drift from Worklet's
        // epoch + ordinal * beatFrames grid at fractional BPM values.
        const measureFrames = Math.max(
            1,
            this.sampleRate * 60 * this.timeSignature[0] / Math.max(1, this.bpm),
        );
        return this.getNextBoundaryFrame(currentFrame, measureFrames, safetyFrames);
    }

    public getNextLoopBoundaryFrame(currentFrame: number, safetyFrames = 0): number {
        if (!this.hasMasterTrack()) return Math.max(0, Math.floor(currentFrame + safetyFrames));
        const earliest = Math.max(0, Math.floor(currentFrame + safetyFrames));
        if (earliest < this.masterPlaybackAnchorFrame) return this.masterPlaybackAnchorFrame;
        const sourcePosition = this.getMasterSourcePositionAtFrame(earliest);
        const remainingSourceFrames = this.masterPlaybackDirection > 0
            ? this.masterLoopLengthSamples - sourcePosition
            : sourcePosition + 1;
        if (remainingSourceFrames <= 1e-9) return earliest;
        return earliest + Math.max(1, Math.ceil(remainingSourceFrames / this.masterPlaybackSpeed));
    }

    /** Map an immediate target sample onto the master loop phase. */
    public getTrackFrameAtMasterPhase(targetFrame: number, trackLoopFrames: number, reverse = false): number {
        if (!this.hasMasterTrack() || trackLoopFrames <= 0) return 0;
        const masterPhase = this.getMasterSourcePositionAtFrame(targetFrame);
        const trackPhase = Math.min(trackLoopFrames - 1, Math.floor(
            masterPhase * trackLoopFrames / this.masterLoopLengthSamples,
        ));
        return reverse ? trackLoopFrames - 1 - trackPhase : trackPhase;
    }

    private getNextBoundaryFrame(currentFrame: number, periodFrames: number, safetyFrames: number): number {
        const earliest = Math.max(0, Math.floor(currentFrame + safetyFrames));
        const origin = this.clockOriginFrame;
        const period = Math.max(1, periodFrames);
        if (earliest <= origin) return origin;
        const elapsed = earliest - origin;
        const ordinal = Math.max(0, Math.ceil(elapsed / period - 1e-9));
        return Math.round(origin + ordinal * period);
    }

    public getNextMeasureStartTime(currentTime: number, sampleRate: number): number {
        if (!this.hasClockEpoch || sampleRate <= 0) return currentTime;
        const currentFrame = Math.floor(currentTime * sampleRate);
        return this.getNextMeasureStartFrame(currentFrame) / sampleRate;
    }

    public getNextMeasureStartSample(currentSample: number, _sampleRate: number): number {
        if (!this.hasClockEpoch) return 0;
        return this.getNextMeasureStartFrame(currentSample) - currentSample;
    }

    public quantizeLoopLength(recordedSamples: number): number {
        if (!this.hasMasterTrack()) return Math.max(0, recordedSamples);
        const periodFrames = this.getMasterPlaybackPeriodFrames();
        const loopCount = Math.max(1, Math.round(recordedSamples / periodFrames));
        return loopCount * periodFrames;
    }

    public getMasterLoopPosition(currentFrame: number, _sampleRate: number): number {
        if (!this.hasMasterTrack() || currentFrame < this.masterPlaybackAnchorFrame) return 0;
        return this.getMasterSourcePositionAtFrame(currentFrame) / this.masterLoopLengthSamples;
    }

    private getMasterSourcePositionAtFrame(frame: number): number {
        if (!this.hasMasterTrack()) return 0;
        const elapsed = Math.max(0, Math.floor(frame) - this.masterPlaybackAnchorFrame);
        const position = (
            this.masterPlaybackAnchorPosition + elapsed * this.masterPlaybackSpeed * this.masterPlaybackDirection
        ) % this.masterLoopLengthSamples;
        return position < 0 ? position + this.masterLoopLengthSamples : position;
    }

    private emit(event: string, ...args: unknown[]) {
        const callbacks = this.listeners.get(event);
        if (!callbacks) return;
        for (const callback of callbacks) callback(...args);
    }
}
