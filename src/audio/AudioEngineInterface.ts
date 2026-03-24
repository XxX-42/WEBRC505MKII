export interface IAudioEngine {
    context: AudioContext;
    trackMixNode: GainNode;
    roundTripLatency: number;
    getInputStream(): Promise<MediaStreamAudioSourceNode>;
    checkAndResetMaster(clearedTrackId: number): void;
}
