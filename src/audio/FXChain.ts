import { CompressorFX } from './fx/CompressorFX';
import { FilterFX } from './fx/FilterFX';
import { DelayFX } from './fx/DelayFX';
import { ReverbFX } from './fx/ReverbFX';

export class FXChain {
    public input: GainNode;
    public output: GainNode;

    // Modules
    public compressor: CompressorFX;
    public filter: FilterFX;
    public delay: DelayFX;
    public reverb: ReverbFX;

    constructor(context: AudioContext) {
        this.input = context.createGain();
        this.output = context.createGain();

        // Instantiate Modules
        this.compressor = new CompressorFX(context);
        this.filter = new FilterFX(context);
        this.delay = new DelayFX(context);
        this.reverb = new ReverbFX(context);

        // Chain: Input -> Compressor -> Filter -> Delay -> Reverb -> Output
        this.input.connect(this.compressor.input);
        this.compressor.output.connect(this.filter.input);
        this.filter.output.connect(this.delay.input);
        this.delay.output.connect(this.reverb.input);
        this.reverb.output.connect(this.output);

        // Initialize Defaults
        this.compressor.setBypass(true);
        this.filter.setBypass(true);
        this.delay.setBypass(true);
        this.reverb.setBypass(true);
    }

    // Unified Control Method
    public setFxParam(fxName: string, paramName: string, value: number) {
        switch (fxName.toUpperCase()) {
            case 'COMPRESSOR':
                this.compressor.setParam(paramName, value);
                break;
            case 'FILTER':
                this.filter.setParam(paramName, value);
                break;
            case 'DELAY':
                this.delay.setParam(paramName, value);
                break;
            case 'REVERB':
                this.reverb.setParam(paramName, value);
                break;
        }
    }

    // Compatibility Methods for AudioEngine
    public setDelay(time: number, feedback: number, mix: number) {
        this.delay.setParam('time', time);
        this.delay.setParam('feedback', feedback);
        this.delay.setParam('mix', mix);

        if (mix > 0) this.delay.setBypass(false);
        else this.delay.setBypass(true);
    }

    public setReverb(mix: number) {
        this.reverb.setParam('mix', mix);

        if (mix > 0) this.reverb.setBypass(false);
        else this.reverb.setBypass(true);
    }

    public setFilterEnabled(enabled: boolean) {
        this.filter.setEnabled(enabled);
    }

    public setFilterValue(value: number) {
        this.filter.setValue(value);
    }

    public setFilterParam(paramName: string, value: number) {
        this.filter.setParam(paramName, value);
    }
}
