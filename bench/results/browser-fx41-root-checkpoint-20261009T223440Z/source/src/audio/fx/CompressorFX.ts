import type { FXBase, FXSnapshot } from './FXBase';

const COMPRESSOR_PROCESSOR_NAME = 'webrc505-linked-compressor';
const COMPRESSOR_WORKLET_URL = '/worklets/compressor-processor.js';
const PARAMETER_SMOOTHING_SECONDS = 0.003; // Compressor control changes, separate from detector attack.
const BYPASS_SMOOTHING_SECONDS = 0.001; // Exponential time constant; the crossfade reaches ~95% in 3 ms.
const BYPASS_DISCONNECT_DELAY_MS = 12;

const workletLoadPromises = new WeakMap<BaseAudioContext, Promise<void>>();

export type CompressorBackend = 'audio-worklet' | 'dry-bypass' | 'failed' | 'disposed';

/**
 * Zero-lookahead compressor backed by a persistent AudioWorkletProcessor.
 *
 * Construction is synchronous so existing FXChain wiring remains stable. The
 * chain stays on the unprocessed dry path until initialize() has loaded the
 * worklet and created its node. BrowserAudioEngine awaits every chain before
 * advertising the audio engine as ready.
 */
export class CompressorFX implements FXBase {
    public name = 'COMPRESSOR';
    public context: BaseAudioContext;
    public input: GainNode;
    public output: GainNode;
    public onFailure: ((error: Error) => void) | null = null;

    private readonly dryGain: GainNode;
    private readonly wetGain: GainNode;
    private workletNode: AudioWorkletNode | null = null;
    private initializationPromise: Promise<void> | null = null;
    private initializationError: Error | null = null;
    private disposed = false;
    private requestedBypass = true;
    private connectedToWorklet = false;
    private connectedFromWorklet = false;
    private bypassTransition = 0;

    private thresholdDb = -24;
    private ratio = 12;
    private kneeDb = 30;
    private attackSeconds = 0.003;
    private releaseSeconds = 0.25;
    private amount: number | null = null;

    public constructor(context: BaseAudioContext) {
        this.context = context;
        this.input = context.createGain();
        this.output = context.createGain();
        this.dryGain = context.createGain();
        this.wetGain = context.createGain();

        // Exact dry bypass is available synchronously, including while the
        // worklet module is still loading or if initialization fails.
        this.dryGain.gain.value = 1;
        this.wetGain.gain.value = 0;
        this.input.connect(this.dryGain);
        this.dryGain.connect(this.output);
        this.wetGain.connect(this.output);
    }

    public get isReady(): boolean {
        return !this.disposed && !this.initializationError && this.workletNode !== null;
    }

    public get active(): boolean {
        return this.isReady && !this.requestedBypass;
    }

    public get backend(): CompressorBackend {
        if (this.disposed) return 'disposed';
        if (this.initializationError) return 'failed';
        return this.isReady ? 'audio-worklet' : 'dry-bypass';
    }

    public get error(): Error | null {
        return this.initializationError;
    }

    /** Resolve only after this FX has a live processor node and parameters. */
    public initialize(): Promise<void> {
        if (this.disposed) return Promise.reject(new Error('Cannot initialize a disposed compressor.'));
        if (this.initializationError) return Promise.reject(this.initializationError);
        if (this.workletNode) return Promise.resolve();
        if (this.initializationPromise) return this.initializationPromise;

        this.initializationPromise = this.loadWorkletModule(this.context)
            .then(() => {
                if (this.disposed) throw new Error('Compressor was disposed before its worklet finished loading.');

                const node = new AudioWorkletNode(this.context, COMPRESSOR_PROCESSOR_NAME, {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                    channelCount: 2,
                    channelCountMode: 'explicit',
                    channelInterpretation: 'speakers',
                });
                if (this.disposed) {
                    node.disconnect();
                    throw new Error('Compressor was disposed while its worklet node was being created.');
                }

                this.workletNode = node;
                this.setInitialParameter(node, 'thresholdDb', this.thresholdDb);
                this.setInitialParameter(node, 'ratio', this.ratio);
                this.setInitialParameter(node, 'kneeDb', this.kneeDb);
                this.setInitialParameter(node, 'attackSeconds', this.attackSeconds);
                this.setInitialParameter(node, 'releaseSeconds', this.releaseSeconds);
                node.addEventListener('processorerror', this.handleProcessorError);

                if (!this.requestedBypass) this.connectWetPath();
                this.applyBypassState(this.requestedBypass, true);
            })
            .catch((cause: unknown) => {
                if (!this.disposed) {
                    this.initializationError = cause instanceof Error
                        ? cause
                        : new Error(`Compressor AudioWorklet initialization failed: ${String(cause)}`);
                    this.forceDryBypass();
                    const failedNode = this.workletNode;
                    if (failedNode) {
                        failedNode.removeEventListener('processorerror', this.handleProcessorError);
                        try { failedNode.disconnect(); } catch { /* already disconnected */ }
                        this.workletNode = null;
                    }
                }
                throw cause;
            });

        return this.initializationPromise;
    }

    public setParam(key: string, value: number) {
        if (this.disposed || !Number.isFinite(value)) return;

        switch (key) {
            case 'amount': {
                const amount = this.clamp(value, 0, 1);
                this.amount = amount;
                this.thresholdDb = -60 * amount;
                this.ratio = 1 + (19 * amount);
                this.setWorkletParameter('thresholdDb', this.thresholdDb);
                this.setWorkletParameter('ratio', this.ratio);
                break;
            }
            case 'threshold':
            case 'thresholdDb':
                this.amount = null;
                this.thresholdDb = this.clamp(value, -120, 0);
                this.setWorkletParameter('thresholdDb', this.thresholdDb);
                break;
            case 'ratio':
                this.amount = null;
                this.ratio = this.clamp(value, 1, 40);
                this.setWorkletParameter('ratio', this.ratio);
                break;
            case 'knee':
            case 'kneeDb':
                this.kneeDb = this.clamp(value, 0, 40);
                this.setWorkletParameter('kneeDb', this.kneeDb);
                break;
            case 'attack':
            case 'attackSeconds':
                this.attackSeconds = this.clamp(value, 0.0001, 1);
                this.setWorkletParameter('attackSeconds', this.attackSeconds);
                break;
            case 'release':
            case 'releaseSeconds':
                this.releaseSeconds = this.clamp(value, 0.001, 3);
                this.setWorkletParameter('releaseSeconds', this.releaseSeconds);
                break;
        }
    }

    public setBypass(bypass: boolean) {
        this.requestedBypass = bypass;
        if (this.disposed || this.initializationError || !this.workletNode) {
            this.forceDryBypass();
            return;
        }

        if (bypass) {
            this.applyBypassState(true, false);
            const transition = ++this.bypassTransition;
            setTimeout(() => {
                if (transition !== this.bypassTransition || !this.requestedBypass || this.disposed) return;
                this.disconnectWetPath();
            }, BYPASS_DISCONNECT_DELAY_MS);
            return;
        }

        ++this.bypassTransition;
        this.connectWetPath();
        this.applyBypassState(false, false);
    }

    public getSnapshot(): FXSnapshot {
        const params: Record<string, number> = {
            thresholdDb: this.thresholdDb,
            ratio: this.ratio,
            kneeDb: this.kneeDb,
            attackSeconds: this.attackSeconds,
            releaseSeconds: this.releaseSeconds,
        };
        if (this.amount !== null) params.amount = this.amount;
        return { type: this.name, enabled: !this.requestedBypass, params };
    }

    public applySnapshot(snapshot: FXSnapshot): void {
        if (snapshot.type !== this.name) throw new TypeError(`Cannot apply ${snapshot.type} state to COMPRESSOR.`);
        if (typeof snapshot.params.amount === 'number') this.setParam('amount', snapshot.params.amount);
        for (const key of ['thresholdDb', 'ratio', 'kneeDb', 'attackSeconds', 'releaseSeconds']) {
            const value = snapshot.params[key];
            if (typeof value === 'number') this.setParam(key, value);
        }
        this.setBypass(!snapshot.enabled);
    }

    public dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.requestedBypass = true;
        ++this.bypassTransition;

        const node = this.workletNode;
        if (node) {
            node.removeEventListener('processorerror', this.handleProcessorError);
            try { this.input.disconnect(node); } catch { /* already disconnected */ }
            try { node.disconnect(); } catch { /* already disconnected */ }
        }
        try { this.input.disconnect(); } catch { /* already disconnected */ }
        try { this.dryGain.disconnect(); } catch { /* already disconnected */ }
        try { this.wetGain.disconnect(); } catch { /* already disconnected */ }
        try { this.output.disconnect(); } catch { /* already disconnected */ }

        this.workletNode = null;
        this.connectedToWorklet = false;
        this.connectedFromWorklet = false;
    }

    private loadWorkletModule(context: BaseAudioContext): Promise<void> {
        const loaded = workletLoadPromises.get(context);
        if (loaded) return loaded;

        const worklet = context.audioWorklet;
        if (!worklet || typeof AudioWorkletNode === 'undefined') {
            return Promise.reject(new Error('This audio context does not support AudioWorklet compressors.'));
        }

        const pending = worklet.addModule(COMPRESSOR_WORKLET_URL);
        workletLoadPromises.set(context, pending);
        return pending;
    }

    private setInitialParameter(node: AudioWorkletNode, name: string, value: number) {
        const parameter = node.parameters.get(name);
        if (!parameter) throw new Error(`Compressor worklet is missing the ${name} parameter.`);
        parameter.setValueAtTime(value, this.context.currentTime);
    }

    private setWorkletParameter(name: string, value: number) {
        const parameter = this.workletNode?.parameters.get(name);
        if (!parameter) return;
        const now = this.context.currentTime;
        parameter.cancelScheduledValues(now);
        parameter.setTargetAtTime(value, now, PARAMETER_SMOOTHING_SECONDS);
    }

    private connectWetPath() {
        const node = this.workletNode;
        if (!node || this.disposed || this.initializationError) return;
        if (!this.connectedFromWorklet) {
            node.connect(this.wetGain);
            this.connectedFromWorklet = true;
        }
        if (!this.connectedToWorklet) {
            this.input.connect(node);
            this.connectedToWorklet = true;
        }
    }

    private disconnectWetPath() {
        const node = this.workletNode;
        if (!node) return;
        if (this.connectedToWorklet) {
            try { this.input.disconnect(node); } catch { /* already disconnected */ }
            this.connectedToWorklet = false;
        }
        if (this.connectedFromWorklet) {
            try { node.disconnect(this.wetGain); } catch { /* already disconnected */ }
            this.connectedFromWorklet = false;
        }
    }

    private applyBypassState(bypass: boolean, immediate: boolean) {
        const now = this.context.currentTime;
        this.setGain(this.dryGain.gain, bypass ? 1 : 0, now, immediate);
        this.setGain(this.wetGain.gain, bypass ? 0 : 1, now, immediate);
    }

    private setGain(parameter: AudioParam, value: number, now: number, immediate: boolean) {
        parameter.cancelScheduledValues(now);
        if (immediate) {
            parameter.setValueAtTime(value, now);
        } else {
            parameter.setTargetAtTime(value, now, BYPASS_SMOOTHING_SECONDS);
        }
    }

    private forceDryBypass() {
        const now = this.context.currentTime;
        this.dryGain.gain.cancelScheduledValues(now);
        this.wetGain.gain.cancelScheduledValues(now);
        this.dryGain.gain.setValueAtTime(1, now);
        this.wetGain.gain.setValueAtTime(0, now);
        this.disconnectWetPath();
    }

    private readonly handleProcessorError = (event: Event) => {
        if (this.disposed || this.initializationError) return;
        const eventMessage = 'message' in event && typeof event.message === 'string' ? event.message : '';
        const error = new Error(eventMessage || 'Compressor AudioWorklet processor failed; the effect was switched to dry bypass.');
        this.initializationError = error;
        this.requestedBypass = true;
        ++this.bypassTransition;
        this.forceDryBypass();
        this.onFailure?.(error);
    };

    private clamp(value: number, minimum: number, maximum: number): number {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
