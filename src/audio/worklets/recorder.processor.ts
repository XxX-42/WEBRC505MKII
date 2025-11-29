
// Declare AudioWorkletProcessor and registerProcessor for TypeScript
declare class AudioWorkletProcessor {
    port: MessagePort;
    constructor();
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

class RecorderProcessor extends AudioWorkletProcessor {
    private isRecording: boolean = false;

    constructor() {
        super();
        this.port.onmessage = (event) => {
            if (event.data.command === 'start') {
                this.isRecording = true;
            } else if (event.data.command === 'stop') {
                this.isRecording = false;
            }
        };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
        const input = inputs[0];
        if (this.isRecording && input && input.length > 0) {
            // Post the raw buffer to the main thread
            // We clone it because the buffer is reused by the audio engine
            const channels: Float32Array[] = [];
            for (let i = 0; i < input.length; i++) {
                channels.push(new Float32Array(input[i]));
            }

            this.port.postMessage({
                eventType: 'data',
                audioBuffer: channels
            });
        }
        return true;
    }
}

registerProcessor('recorder-processor', RecorderProcessor);
