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

export interface IAudioEngine {
    getRecordPlaySettings?(): RecordPlaySettings;
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
    beginInputCaptureSession?(
        trackIndex: number,
        startFrame: number,
        listener: (message: unknown) => void,
        maxRecordingFrames?: number,
    ): InputCaptureSession | null;
    stopInputCaptureSession?(session: InputCaptureSession, stopFrame: number): boolean;
    abortInputCaptureSession?(session: InputCaptureSession): void;
    recycleInputCaptureChunk?(session: InputCaptureSession, chunkIndex: number, channels: Float32Array[]): boolean;
    releaseInputCaptureSession?(session: InputCaptureSession): void;
    checkAndResetMaster(clearedTrackId: number): void;
}
