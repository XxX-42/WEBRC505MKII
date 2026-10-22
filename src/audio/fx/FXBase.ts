export interface FXBase {
    name: string;
    input: AudioNode;
    output: AudioNode;
    setParam(key: string, value: number): void;
    setBypass(bypass: boolean): void;
    /** Authored scalar state for a closed-context recovery snapshot; excludes DSP history. */
    getParameterSnapshot?(): Readonly<object>;
    dispose(): void;
}
