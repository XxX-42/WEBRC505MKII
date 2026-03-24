export interface IAudioEngine {
    context: AudioContext;
    trackMixNode: GainNode;
    roundTripLatency: number;
    getInputStream(): Promise<MediaStreamAudioSourceNode>;
    getProcessedInputNode(): Promise<AudioNode>;
    checkAndResetMaster(clearedTrackId: number): void;
}
