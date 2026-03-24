import type { FXBase } from './FXBase';

export class PhaserFX implements FXBase {
    public name = 'PHASER';
    public input: GainNode;
    public output: GainNode;

    private context: AudioContext;
    private dryNode: GainNode;
    private wetNode: GainNode;

    // Phaser Chain
    private filters: BiquadFilterNode[] = [];
    private lfo: OscillatorNode;
    private lfoGain: GainNode;

    private rate: number = 0.5;
    private depth: number = 0.5;

    constructor(context: AudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();

        this.dryNode = context.createGain();
        this.wetNode = context.createGain();

        // Create 4 All-pass filters
        let prevNode: AudioNode = this.input;

        for (let i = 0; i < 4; i++) {
            const filter = context.createBiquadFilter();
            filter.type = 'allpass';
            filter.frequency.value = 1000; // Center frequency
            filter.Q.value = 1; // Resonance

            prevNode.connect(filter);
            prevNode = filter;
            this.filters.push(filter);
        }

        // LFO for frequency modulation
        this.lfo = context.createOscillator();
        this.lfo.type = 'sine';
        this.lfo.frequency.value = this.rate;

        this.lfoGain = context.createGain();
        this.lfoGain.gain.value = 500; // Modulation depth (Hz)

        this.lfo.connect(this.lfoGain);

        // Connect LFO to all filters
        this.filters.forEach(filter => {
            this.lfoGain.connect(filter.frequency);
        });

        this.lfo.start();

        // Routing
        // Dry path
        this.input.connect(this.dryNode);
        this.dryNode.connect(this.output);

        // Wet path (from last filter)
        prevNode.connect(this.wetNode);
        this.wetNode.connect(this.output);

        // Feedback (optional, simple implementation)
        // Last filter -> Input (careful with feedback loops)
        // For simplicity/safety, we skip feedback loop in this basic version 
        // or implement it with a GainNode if needed later.

        // Default Mix (50/50 for max phasing cancellation)
        this.dryNode.gain.value = 0.5;
        this.wetNode.gain.value = 0.5;

        // Start bypassed
        this.setBypass(true);
    }

    public setParam(key: string, value: number) {
        const normValue = value / 100;

        switch (key.toLowerCase()) {
            case 'rate':
                // 0.1Hz to 5Hz
                this.rate = 0.1 + (normValue * 4.9);
                this.lfo.frequency.setTargetAtTime(this.rate, this.context.currentTime, 0.05);
                break;

            case 'depth':
            case 'amount':
            case 'mix': // Fallback
                this.depth = normValue;
                // Depth controls LFO gain (frequency sweep range)
                // Range: 0 to 2000Hz sweep
                this.lfoGain.gain.setTargetAtTime(this.depth * 2000, this.context.currentTime, 0.05);
                break;

            case 'resonance':
                // Q value
                const q = 0.5 + (normValue * 5);
                this.filters.forEach(f => f.Q.setTargetAtTime(q, this.context.currentTime, 0.05));
                break;
        }
    }

    public setBypass(bypass: boolean) {
        if (bypass) {
            // Bypass: Only Dry signal, full volume
            this.dryNode.gain.setTargetAtTime(1, this.context.currentTime, 0.05);
            this.wetNode.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
        } else {
            // Active: 50/50 Mix for Phasing
            this.dryNode.gain.setTargetAtTime(0.5, this.context.currentTime, 0.05);
            this.wetNode.gain.setTargetAtTime(0.5, this.context.currentTime, 0.05);
        }
    }
}
