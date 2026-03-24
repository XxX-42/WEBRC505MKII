export interface FXBase {
    name: string;
    input: AudioNode;
    output: AudioNode;
    setParam(key: string, value: number): void;
    setBypass(bypass: boolean): void;
    dispose(): void;
}
