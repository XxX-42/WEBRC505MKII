import type { FXBase } from './FXBase';

export class ReverbFX implements FXBase {
    name = 'REVERB';
    context: AudioContext;
    input: GainNode;
    output: GainNode;
    private convolver: ConvolverNode;
    private wet: GainNode;
    private dry: GainNode;
    private currentMix = 0.5;

    constructor(context: AudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();
        this.convolver = context.createConvolver();
        this.wet = context.createGain();
        this.dry = context.createGain();

        this.generateImpulseResponse(2.0); // Default 2s

        // Routing
        this.input.connect(this.dry);
        this.dry.connect(this.output);

        this.input.connect(this.convolver);
        this.convolver.connect(this.wet);
        this.wet.connect(this.output);

        this.applyMix(this.currentMix);
    }

    private applyMix(value: number) {
        this.wet.gain.setTargetAtTime(value, this.context.currentTime, 0.1);
        this.dry.gain.setTargetAtTime(1 - value, this.context.currentTime, 0.1);
    }

    private generateImpulseResponse(duration: number) {
        const rate = this.context.sampleRate;
        const length = rate * duration;
        const impulse = this.context.createBuffer(2, length, rate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            // Exponential decay
            const decay = Math.pow(1 - i / length, 2);
            // White noise
            left[i] = (Math.random() * 2 - 1) * decay;
            right[i] = (Math.random() * 2 - 1) * decay;
        }

        this.convolver.buffer = impulse;
    }

    setParam(key: string, value: number) {
        if (key === 'decay') {
            const duration = 0.1 + (value * 4.0); // 0.1s to 4.1s
            this.generateImpulseResponse(duration);
        } else if (key === 'mix') {
            this.currentMix = Math.max(0, Math.min(1, value));
            this.applyMix(this.currentMix);
        }
    }

    setBypass(bypass: boolean) {
        if (bypass) {
            this.wet.gain.setTargetAtTime(0, this.context.currentTime, 0.1);
            this.dry.gain.setTargetAtTime(1, this.context.currentTime, 0.1);
        } else {
            this.applyMix(this.currentMix);
        }
    }

    dispose() {
        this.input.disconnect();
        this.convolver.disconnect();
        this.wet.disconnect();
        this.dry.disconnect();
        this.output.disconnect();
    }
}
