import type { FXBase } from './FXBase';

export class FilterFX implements FXBase {
    name = 'FILTER';
    context: AudioContext;
    input: GainNode;
    output: GainNode;
    private filter: BiquadFilterNode;


    constructor(context: AudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();
        this.filter = context.createBiquadFilter();

        this.filter.type = 'lowpass';
        this.filter.frequency.value = 20000;
        this.filter.Q.value = 1;

        this.input.connect(this.filter);
        this.filter.connect(this.output);
    }

    setParam(key: string, value: number) {
        if (key === 'frequency') {
            // Safe logarithmic mapping 20Hz - 20kHz
            const minValue = 20;
            const maxValue = 20000;
            // Ensure value is in [0, 1]
            // The FX class contract is normalized 0..1. UI controls that are
            // expressed as 0..100 must be normalized at their call site.
            const clampedValue = Math.min(1, Math.max(0, value));

            // Recommended safe mapping (Quadratic approximation of log)
            const v = Math.pow(clampedValue, 2) * (maxValue - minValue) + minValue;

            if (isFinite(v) && !isNaN(v)) {
                this.filter.frequency.setTargetAtTime(v, this.context.currentTime, 0.003);
            }
        } else if (key === 'resonance') {
            this.filter.Q.setTargetAtTime(Math.max(0.1, Math.min(20, value * 20)), this.context.currentTime, 0.003);
        }
    }

    setBypass(bypass: boolean) {
        this.input.disconnect();
        if (bypass) {
            this.input.connect(this.output);
        } else {
            this.input.connect(this.filter);
        }
    }

    // Compatibility for AudioEngine
    setValue(value: number) {
        this.setParam('frequency', value);
    }

    setEnabled(enabled: boolean) {
        this.setBypass(!enabled);
    }

    dispose() {
        this.input.disconnect();
        this.filter.disconnect();
        this.output.disconnect();
    }
}
