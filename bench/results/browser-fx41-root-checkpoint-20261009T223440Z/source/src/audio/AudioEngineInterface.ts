import type { BrowserRealtimeRuntime } from './BrowserRealtimeRuntime';

export interface IAudioEngine {
    context: AudioContext;
    trackMixNode: GainNode;
    roundTripLatency: number;
    selectedInputDeviceId?: string | null;
    selectedOutputDeviceId?: string | null;
  selectedBufferFrames?: number | null;
  isReady?: boolean;
  realtimeRuntime?: BrowserRealtimeRuntime | null;
    getInputStream(): Promise<MediaStreamAudioSourceNode>;
    getProcessedInputNode(): Promise<AudioNode>;
    checkAndResetMaster(clearedTrackId: number): void;
}
