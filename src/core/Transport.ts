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
        this.measureLength = durationSeconds;

        if (durationSeconds > 0) {
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
        this.emit('master-track-change', null);
        console.log('Master track reset');
    }

    public hasMasterTrack(): boolean {
        return this.masterTrackId !== null && this.masterLoopLengthSamples > 0;
    }

    public getNextMeasureStartFrame(currentFrame: number, safetyFrames = 0): number {
        if (!this.hasMasterTrack()) {
            return Math.max(0, Math.floor(currentFrame + safetyFrames));
        }

        const earliest = Math.max(0, Math.floor(currentFrame + safetyFrames));
        const loopFrames = this.masterLoopLengthSamples;
        if (earliest <= this.masterOriginFrame) {
            return this.masterOriginFrame;
        }

        const elapsed = earliest - this.masterOriginFrame;
        const completedLoops = Math.floor(elapsed / loopFrames);
        const boundary = this.masterOriginFrame + completedLoops * loopFrames;
        return boundary >= earliest ? boundary : boundary + loopFrames;
    }

    public getNextMeasureStartTime(currentTime: number, sampleRate: number): number {
        if (!this.hasMasterTrack() || sampleRate <= 0) return currentTime;
        const currentFrame = Math.floor(currentTime * sampleRate);
        return this.getNextMeasureStartFrame(currentFrame) / sampleRate;
    }

    public getNextMeasureStartSample(currentSample: number, _sampleRate: number): number {
        if (!this.hasMasterTrack()) return 0;
        return this.getNextMeasureStartFrame(currentSample) - currentSample;
    }

    public quantizeLoopLength(recordedSamples: number): number {
        if (!this.hasMasterTrack()) return Math.max(0, recordedSamples);
        const loopCount = Math.max(1, Math.round(recordedSamples / this.masterLoopLengthSamples));
        return loopCount * this.masterLoopLengthSamples;
    }

    public getMasterLoopPosition(currentFrame: number, _sampleRate: number): number {
        if (!this.hasMasterTrack() || currentFrame < this.masterOriginFrame) return 0;
        const elapsed = currentFrame - this.masterOriginFrame;
        return (elapsed % this.masterLoopLengthSamples) / this.masterLoopLengthSamples;
    }

    private emit(event: string, ...args: unknown[]) {
        const callbacks = this.listeners.get(event);
        if (!callbacks) return;
        for (const callback of callbacks) callback(...args);
    }
}
