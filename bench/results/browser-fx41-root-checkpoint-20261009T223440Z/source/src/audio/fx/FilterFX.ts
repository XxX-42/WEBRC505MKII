import type { FXBase, FXSnapshot } from './FXBase';

export class FilterFX implements FXBase {
    name = 'FILTER';
    context: BaseAudioContext;
    input: GainNode;
    output: GainNode;
    private filter: BiquadFilterNode;
    private frequency = 1;
    private resonance = 0.05;
    private bypassed = false;


    constructor(context: BaseAudioContext) {
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

    setParam(key: string, value: number, instant = false) {
        if (key === 'frequency') {
            // Safe logarithmic mapping 20Hz - 20kHz
            const minValue = 20;
            const maxValue = 20000;
            // Ensure value is in [0, 1]
            // The FX class contract is normalized 0..1. UI controls that are
            // expressed as 0..100 must be normalized at their call site.
            const clampedValue = Math.min(1, Math.max(0, value));
            this.frequency = clampedValue;

            // Recommended safe mapping (Quadratic approximation of log)
            const v = Math.pow(clampedValue, 2) * (maxValue - minValue) + minValue;

            if (isFinite(v) && !isNaN(v)) {
                if (instant) this.setParamImmediately(this.filter.frequency, v);
                else this.filter.frequency.setTargetAtTime(v, this.context.currentTime, 0.003);
            }
        } else if (key === 'resonance') {
            this.resonance = Math.min(1, Math.max(0, value));
            const q = Math.max(0.1, Math.min(20, this.resonance * 20));
            if (instant) this.setParamImmediately(this.filter.Q, q);
            else this.filter.Q.setTargetAtTime(q, this.context.currentTime, 0.003);
        }
    }

    setBypass(bypass: boolean, _instant = false) {
        this.bypassed = bypass;
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

    getSnapshot(): FXSnapshot { return { type: this.name, enabled: !this.bypassed, params: { frequency: this.frequency, resonance: this.resonance } }; }

    applySnapshot(snapshot: FXSnapshot, options: { instant?: boolean } = {}): void {
        if (snapshot.type !== this.name) throw new TypeError(`Cannot apply ${snapshot.type} state to FILTER.`);
        const frequency = snapshot.params.frequency;
        const resonance = snapshot.params.resonance;
        if (typeof frequency !== 'number' || !Number.isFinite(frequency) || frequency < 0 || frequency > 1) throw new RangeError('Filter frequency snapshot must be normalized to [0, 1].');
        if (typeof resonance !== 'number' || !Number.isFinite(resonance) || resonance < 0 || resonance > 1) throw new RangeError('Filter resonance snapshot must be normalized to [0, 1].');
        this.setParam('frequency', frequency, options.instant);
        this.setParam('resonance', resonance, options.instant);
        this.setBypass(!snapshot.enabled, options.instant);
    }

    private setParamImmediately(param: AudioParam, value: number): void {
        param.cancelScheduledValues(this.context.currentTime);
        param.setValueAtTime(value, this.context.currentTime);
    }

    dispose() {
        this.input.disconnect();
        this.filter.disconnect();
        this.output.disconnect();
    }
}
