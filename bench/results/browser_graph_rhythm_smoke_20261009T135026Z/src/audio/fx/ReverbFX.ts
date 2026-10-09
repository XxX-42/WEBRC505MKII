import type { FXBase, FXSnapshot } from './FXBase';

export class ReverbFX implements FXBase {
    name = 'REVERB';
    context: BaseAudioContext;
    input: GainNode;
    output: GainNode;
    private convolver: ConvolverNode;
    private wet: GainNode;
    private dry: GainNode;
    private currentMix = 0.5;
    private decay = 0.475;
    private seed = 0x505;
    private bypassed = false;

    constructor(context: BaseAudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();
        this.convolver = context.createConvolver();
        this.wet = context.createGain();
        this.dry = context.createGain();

        this.generateImpulseResponse(2.0, this.seed); // Default 2s

        // Routing
        this.input.connect(this.dry);
        this.dry.connect(this.output);

        this.input.connect(this.convolver);
        this.convolver.connect(this.wet);
        this.wet.connect(this.output);

        this.applyMix(this.currentMix);
    }

    private applyMix(value: number) {
        this.wet.gain.setTargetAtTime(value, this.context.currentTime, 0.003);
        this.dry.gain.setTargetAtTime(1 - value, this.context.currentTime, 0.003);
    }

    private generateImpulseResponse(duration: number, seed: number) {
        const rate = this.context.sampleRate;
        const length = rate * duration;
        const impulse = this.context.createBuffer(2, length, rate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        let randomState = seed >>> 0 || 1;
        const random = () => {
            randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
            return randomState / 0x1_0000_0000;
        };
        for (let i = 0; i < length; i++) {
            // Exponential decay
            const decay = Math.pow(1 - i / length, 2);
            // White noise
            left[i] = (random() * 2 - 1) * decay;
            right[i] = (random() * 2 - 1) * decay;
        }

        this.convolver.buffer = impulse;
    }

    setParam(key: string, value: number) {
        if (key === 'decay') {
            this.decay = Math.max(0, Math.min(1, value));
            const duration = 0.1 + (this.decay * 4.0); // 0.1s to 4.1s
            this.generateImpulseResponse(duration, this.seed);
        } else if (key === 'mix') {
            this.currentMix = Math.max(0, Math.min(1, value));
            this.applyMix(this.currentMix);
        }
    }

    setBypass(bypass: boolean) {
        this.bypassed = bypass;
        if (bypass) {
            this.wet.gain.setTargetAtTime(0, this.context.currentTime, 0.003);
            this.dry.gain.setTargetAtTime(1, this.context.currentTime, 0.003);
        } else {
            this.applyMix(this.currentMix);
        }
    }

    getSnapshot(): FXSnapshot {
        return { type: this.name, enabled: !this.bypassed, params: { decay: this.decay, mix: this.currentMix, seed: this.seed } };
    }

    applySnapshot(snapshot: FXSnapshot): void {
        if (snapshot.type !== this.name) throw new TypeError(`Cannot apply ${snapshot.type} state to REVERB.`);
        const seed = snapshot.params.seed;
        if (typeof seed === 'number') this.setSeed(seed);
        if (typeof snapshot.params.decay === 'number') this.setParam('decay', snapshot.params.decay);
        if (typeof snapshot.params.mix === 'number') this.setParam('mix', snapshot.params.mix);
        this.setBypass(!snapshot.enabled);
    }

    setSeed(seed: number): void {
        if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError('Reverb seed must be an unsigned 32-bit integer.');
        this.seed = seed >>> 0;
        this.generateImpulseResponse(0.1 + this.decay * 4.0, this.seed);
    }

    dispose() {
        this.input.disconnect();
        this.convolver.disconnect();
        this.wet.disconnect();
        this.dry.disconnect();
        this.output.disconnect();
    }
}
