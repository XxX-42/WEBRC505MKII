import type { FXBase, FXSnapshot } from './FXBase';

export class DelayFX implements FXBase {
    name = 'DELAY';
    context: BaseAudioContext;
    input: GainNode;
    output: GainNode;
    private delay: DelayNode;
    private feedback: GainNode;
    private wet: GainNode;
    private dry: GainNode;
    private filter: BiquadFilterNode; // Tape simulation
    private currentMix = 0.5;
    private currentTime = 0.3;
    private currentFeedback = 0.3;
    private bypassed = false;

    constructor(context: BaseAudioContext) {
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
        this.applyMix(this.currentMix);
        this.feedback.gain.value = this.currentFeedback * 0.9;
        this.delay.delayTime.value = this.currentTime;
    }

    private applyMix(value: number, instant = false) {
        const wetValue = this.bypassed ? 0 : value;
        const dryValue = this.bypassed ? 1 : 1 - value;
        if (instant) {
            this.setParamImmediately(this.wet.gain, wetValue);
            this.setParamImmediately(this.dry.gain, dryValue);
        } else {
            this.wet.gain.setTargetAtTime(wetValue, this.context.currentTime, 0.003);
            this.dry.gain.setTargetAtTime(dryValue, this.context.currentTime, 0.003);
        }
    }

    setParam(key: string, value: number, instant = false) {
        if (key === 'time') {
            this.currentTime = Math.max(0, Math.min(1, value));
            if (instant) this.setParamImmediately(this.delay.delayTime, this.currentTime);
            else this.delay.delayTime.setTargetAtTime(this.currentTime, this.context.currentTime, 0.003);
        } else if (key === 'feedback') {
            this.currentFeedback = Math.max(0, Math.min(1, value));
            const gain = this.currentFeedback * 0.9;
            if (instant) this.setParamImmediately(this.feedback.gain, gain);
            else this.feedback.gain.setTargetAtTime(gain, this.context.currentTime, 0.003);
        } else if (key === 'mix') {
            this.currentMix = Math.max(0, Math.min(1, value));
            this.applyMix(this.currentMix, instant);
        }
    }

    setBypass(bypass: boolean, instant = false) {
        this.bypassed = bypass;
        this.applyMix(this.currentMix, instant);
    }

    getSnapshot(): FXSnapshot {
        return { type: this.name, enabled: !this.bypassed, params: { time: this.currentTime, feedback: this.currentFeedback, mix: this.currentMix } };
    }

    applySnapshot(snapshot: FXSnapshot, options: { instant?: boolean } = {}): void {
        if (snapshot.type !== this.name) throw new TypeError(`Cannot apply ${snapshot.type} state to DELAY.`);
        for (const key of ['time', 'feedback', 'mix']) {
            const value = snapshot.params[key];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`Delay ${key} snapshot must be normalized to [0, 1].`);
        }
        this.setParam('time', snapshot.params.time!, options.instant);
        this.setParam('feedback', snapshot.params.feedback!, options.instant);
        this.setParam('mix', snapshot.params.mix!, options.instant);
        this.setBypass(!snapshot.enabled, options.instant);
    }

    private setParamImmediately(param: AudioParam, value: number): void {
        param.cancelScheduledValues(this.context.currentTime);
        param.setValueAtTime(value, this.context.currentTime);
    }

    dispose() {
        this.input.disconnect();
        this.delay.disconnect();
        this.feedback.disconnect();
        this.wet.disconnect();
        this.dry.disconnect();
        this.filter.disconnect();
        this.output.disconnect();
    }
}
