import type { FXBase } from './FXBase';

export class CompressorFX implements FXBase {
    name = 'COMPRESSOR';
    context: AudioContext;
    input: GainNode;
    output: GainNode;
    private compressor: DynamicsCompressorNode;


    constructor(context: AudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();
        this.compressor = context.createDynamicsCompressor();

        // Default settings
        this.compressor.threshold.value = -24;
        this.compressor.knee.value = 30;
        this.compressor.ratio.value = 12;
        this.compressor.attack.value = 0.003;
        this.compressor.release.value = 0.25;

        // Routing
        this.input.connect(this.compressor);
        this.compressor.connect(this.output);
    }

    setParam(key: string, value: number) {
        if (key === 'amount') {
            // Map 0-1 to Threshold (-60 to 0) and Ratio (1 to 20)
            const threshold = -60 * value;
            const ratio = 1 + (19 * value);
            this.compressor.threshold.setTargetAtTime(threshold, this.context.currentTime, 0.1);
            this.compressor.ratio.setTargetAtTime(ratio, this.context.currentTime, 0.1);
        }
    }

    setBypass(bypass: boolean) {
        // Simple bypass: disconnect input from compressor and connect to output directly?
        // Or use wet/dry gains?
        // Let's re-route.
        this.input.disconnect();
        if (bypass) {
            this.input.connect(this.output);
        } else {
            this.input.connect(this.compressor);
        }
    }

    dispose() {
        this.input.disconnect();
        this.compressor.disconnect();
        this.output.disconnect();
    }
}
