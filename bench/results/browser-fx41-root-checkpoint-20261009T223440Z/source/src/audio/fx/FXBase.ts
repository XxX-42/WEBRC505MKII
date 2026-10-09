export interface FXSnapshot {
    type: string;
    enabled: boolean;
    params: Record<string, number>;
}

export interface FXApplyOptions {
  /** Restore parameter state synchronously for offline rendering or project recall. */
  instant?: boolean;
}

export interface FXBase {
    name: string;
    input: AudioNode;
    output: AudioNode;
    setParam(key: string, value: number, instant?: boolean): void;
    setBypass(bypass: boolean, instant?: boolean): void;
    getSnapshot(): FXSnapshot;
    applySnapshot(snapshot: FXSnapshot, options?: FXApplyOptions): void;
    dispose(): void;
}
