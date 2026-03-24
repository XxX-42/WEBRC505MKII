export interface FXBase {
    name: string;
    input: AudioNode;
    output: AudioNode;
    setParam(key: string, value: number): void;
    setBypass(bypass: boolean): void;
    setBypass(bypass: boolean): void;
}

export const FX_TYPE = 'FX'; // Ensure module is not empty
