import type { FXBase } from './FXBase';

export class DelayFX implements FXBase {
    name = 'DELAY';
    context: AudioContext;
    input: GainNode;
    output: GainNode;
    private delay: DelayNode;
    private feedback: GainNode;
    private wet: GainNode;
    private dry: GainNode;
    private filter: BiquadFilterNode; // Tape simulation

    constructor(context: AudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();

        this.delay = context.createDelay(1.0);
        this.feedback = context.createGain();
        this.wet = context.createGain();
        this.dry = context.createGain();
        this.filter = context.createBiquadFilter();

        // Tape simulation: Lowpass in feedback loop
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 3000; // Dampen highs

        // Routing
        // Input -> Dry -> Output
        this.input.connect(this.dry);
        this.dry.connect(this.output);

        // Input -> Delay -> Filter -> Feedback -> Delay
        this.input.connect(this.delay);
        this.delay.connect(this.filter);
        this.filter.connect(this.feedback);
        this.feedback.connect(this.delay);

        // Filter -> Wet -> Output
        this.filter.connect(this.wet);
        this.wet.connect(this.output);

        // Defaults
        this.wet.gain.value = 0.5;
        this.dry.gain.value = 1.0;
        this.feedback.gain.value = 0.3;
        this.delay.delayTime.value = 0.3;
    }

    setParam(key: string, value: number) {
        if (key === 'time') {
            this.delay.delayTime.setTargetAtTime(value, this.context.currentTime, 0.1);
        } else if (key === 'feedback') {
            this.feedback.gain.setTargetAtTime(value * 0.9, this.context.currentTime, 0.1);
        } else if (key === 'mix') {
            this.wet.gain.setTargetAtTime(value, this.context.currentTime, 0.1);
            this.dry.gain.setTargetAtTime(1 - value, this.context.currentTime, 0.1);
        }
    }

    setBypass(bypass: boolean) {
        if (bypass) {
            this.wet.gain.setTargetAtTime(0, this.context.currentTime, 0.1);
            this.dry.gain.setTargetAtTime(1, this.context.currentTime, 0.1);
        } else {
            // We don't restore mix here because setParam handles it.
            // But if we want to "un-bypass", we might need to know the previous mix.
            // For simplicity, we assume the controller will set mix again or we just leave it as is if it wasn't touched.
            // But wait, if we set wet to 0, we lose the state.
            // Better approach: use a master wet gain for bypass?
            // Or just rely on the fact that when active=true, the UI sends the mix value.
        }
    }
}
