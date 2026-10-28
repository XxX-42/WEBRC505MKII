import type { BrowserAutoRecSettings } from './BrowserAutoRecSettings';
import type { BrowserBounceSettings } from './BrowserBounceSettings';
import type { RecordPlaySettings } from './RecordPlaySettings';
export interface InputCaptureSession {
    readonly node: AudioWorkletNode;
    readonly trackIndex: number;
    readonly sessionId: number;
    readonly inputGeneration: number;
    readonly startFrame: number;
    /** Optional strict per-session frame cap used for startup backfill windows. */
    readonly maxRecordingFrames?: number;
}
export interface BrowserBounceSourceMix {
    readonly node: GainNode;
    dispose(): void;
}

export interface IAudioEngine {
    getRecordPlaySettings?(): RecordPlaySettings;
    /** True only when the Browser's internal rhythm source is currently running. */
    isBrowserRhythmRunning?(): boolean;
    /** True only when the requested Browser track exists and LOOP SYNC SW is ON. */
    isBrowserTrackLoopSyncEnabled?(trackId: number): boolean | null;
    context: AudioContext;
    trackMixNode: GainNode;
    roundTripLatency: number;
    selectedInputDeviceId?: string | null;
    selectedOutputDeviceId?: string | null;
    selectedBufferFrames?: number | null;
    getInputStream(): Promise<MediaStreamAudioSourceNode>;
    getProcessedInputNode(): Promise<AudioNode>;
    /** Optional shared Browser input-capture path; Native keeps its own callback recorder. */
    getInputCaptureRequestFrame?(): number | null;
    /** Wait for the shared Browser capture ring to finish warming after a timeline gap. */
    waitForInputCaptureReady?(): Promise<void>;
    /** Wait for an aborted shared-capture slot to return its exact worklet pool before reuse. */
    waitForInputCaptureSlot?(trackIndex: number): Promise<void>;
    getBrowserAutoRecSettings?(): Readonly<BrowserAutoRecSettings>;
    getBrowserBounceSettings?(): Readonly<BrowserBounceSettings>;
    getBrowserBounceSourceMask?(destinationTrackIndex: number): number;
    /** Connect selected pre-Track-FX playback outputs to one summed overdub source bus. */
    createBrowserBounceSourceMix?(destinationTrackIndex: number, sourceMask: number): BrowserBounceSourceMix | null;
    beginInputCaptureSession?(
        trackIndex: number,
        startFrame: number,
        listener: (message: unknown) => void,
        maxRecordingFrames?: number,
        /** Raw stereo peak trigger, evaluated only by the Browser capture renderer. */
        autoRecThreshold?: number,
        /** Five-bit per-source Bounce mask, with the destination track excluded. */
        bounceSourceMask?: number,
    ): InputCaptureSession | null;
    stopInputCaptureSession?(session: InputCaptureSession, stopFrame: number): boolean;
    abortInputCaptureSession?(session: InputCaptureSession): void;
    recycleInputCaptureChunk?(session: InputCaptureSession, chunkIndex: number, channels: Float32Array[]): boolean;
    releaseInputCaptureSession?(session: InputCaptureSession): void;
    checkAndResetMaster(clearedTrackId: number): void;
}
