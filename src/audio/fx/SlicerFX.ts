import type { FXBase } from './FXBase';

export class SlicerFX implements FXBase {
    public name = 'SLICER';
    public input: GainNode;
    public output: GainNode;

    private context: AudioContext;
    private vca: GainNode;
    private lfo: OscillatorNode;
    private lfoGain: GainNode;
    private isBypassed: boolean = false;

    // Parameters
    private rate: number = 4; // Hz
    private depth: number = 1;

    constructor(context: AudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();

        // VCA (Voltage Controlled Amplifier) - The "Gate"
        this.vca = context.createGain();
        this.vca.gain.value = 1; // Default open

        // LFO (Low Frequency Oscillator)
        this.lfo = context.createOscillator();
        this.lfo.type = 'square';
        this.lfo.frequency.value = this.rate;

        // LFO Depth Control
        this.lfoGain = context.createGain();
        this.lfoGain.gain.value = 0; // Start with 0 depth (no effect)

        // Routing: Input -> VCA -> Output
        this.input.connect(this.vca);
        this.vca.connect(this.output);

        // Modulation: LFO -> LFO Gain -> VCA Gain
        // We want 0 to 1 modulation.
        // Square wave is -1 to 1.
        // If we set VCA base gain to 0.5, and LFO amplitude to 0.5:
        // High: 0.5 + (1 * 0.5) = 1.0
        // Low:  0.5 + (-1 * 0.5) = 0.0
        this.lfo.connect(this.lfoGain);
        this.lfoGain.connect(this.vca.gain);

        this.lfo.start();
    }

    public setParam(key: string, value: number) {
        // Value is typically 0-100 from UI
        const normValue = value / 100;

        switch (key.toLowerCase()) {
            case 'rate':
            case 'frequency':
                // Map 0-100 to 1Hz - 20Hz
                this.rate = 1 + (normValue * 19);
                this.lfo.frequency.setTargetAtTime(this.rate, this.context.currentTime, 0.05);
                break;

            case 'depth':
            case 'amount':
            case 'mix': // Fallback for generic controls
                this.depth = normValue;
                this.updateDepth();
                break;
        }
    }

    private updateDepth() {
        if (this.isBypassed) return;

        // When depth is high, we want full on/off (0 to 1).
        // When depth is low, we want steady signal (1).

        // Logic:
        // VCA Base Gain = 1 - (Depth * 0.5)
        // LFO Gain = Depth * 0.5

        // Depth 0: Base=1, LFO=0 -> Constant 1
        // Depth 1: Base=0.5, LFO=0.5 -> Oscillates 0 to 1

        const lfoAmp = this.depth * 0.5;
        const baseGain = 1 - lfoAmp;

        this.vca.gain.setTargetAtTime(baseGain, this.context.currentTime, 0.05);
        this.lfoGain.gain.setTargetAtTime(lfoAmp, this.context.currentTime, 0.05);
    }

    public setBypass(bypass: boolean) {
        this.isBypassed = bypass;

        if (bypass) {
            // Bypass: Gain fixed at 1, LFO disconnected (effectively)
            this.vca.gain.setTargetAtTime(1, this.context.currentTime, 0.05);
            this.lfoGain.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
        } else {
            // Active: Restore depth settings
            this.updateDepth();
        }
    }

    public dispose() {
        this.lfo.stop();
        this.lfo.disconnect();
        this.lfoGain.disconnect();
        this.vca.disconnect();
        this.input.disconnect();
        this.output.disconnect();
    }
}
