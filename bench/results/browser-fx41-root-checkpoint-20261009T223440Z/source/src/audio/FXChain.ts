import { CompressorFX } from './fx/CompressorFX';
import { FilterFX } from './fx/FilterFX';
import { DelayFX } from './fx/DelayFX';
import { ReverbFX } from './fx/ReverbFX';
import { defaultFXRegistry, type FxNodeGraph } from './fx/FXRegistry';
import type { FXSnapshot } from './fx/FXBase';

export class FXChain {
    public input: GainNode;
    public output: GainNode;
    public onProcessorError: ((error: Error) => void) | null = null;

    // Modules
    public compressor: CompressorFX;
    public filter: FilterFX;
    public delay: DelayFX;
    public reverb: ReverbFX;

    constructor(context: BaseAudioContext) {
        this.input = context.createGain();
        this.output = context.createGain();

        // Instantiate Modules
        this.compressor = new CompressorFX(context);
        this.compressor.onFailure = (error) => this.onProcessorError?.(error);
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

    /** Resolve after the asynchronous compressor processor is ready. */
    public initialize(): Promise<void> {
        return this.compressor.initialize();
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

    public getSnapshot(): Record<string, FXSnapshot> {
        return {
            compressor: this.compressor.getSnapshot(),
            filter: this.filter.getSnapshot(),
            delay: this.delay.getSnapshot(),
            reverb: this.reverb.getSnapshot(),
        };
    }

    public applySnapshot(snapshot: Record<string, FXSnapshot>): void {
        const entries: Array<[string, CompressorFX | FilterFX | DelayFX | ReverbFX]> = [
            ['compressor', this.compressor],
            ['filter', this.filter],
            ['delay', this.delay],
            ['reverb', this.reverb],
        ];
        for (const [name, effect] of entries) {
            const state = snapshot[name];
            if (state) effect.applySnapshot(state);
        }
    }

    public async createOfflineClone(context: OfflineAudioContext, snapshot = this.getSnapshot()): Promise<FxNodeGraph> {
        const graph = await defaultFXRegistry.createGraph(context, Object.values(snapshot));
        try {
            await graph.initialize();
            return graph;
        } catch (error) {
            graph.dispose();
            throw error;
        }
    }
}
