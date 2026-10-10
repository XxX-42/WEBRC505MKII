import {
  NativeBridgeClient,
  type NativeRhythmMutationResponse,
  type NativeRhythmStatus,
} from './NativeBridgeClient';

export type NativeRhythmListener = (status: NativeRhythmStatus | null, error: string) => void;

/** HTTP facade for the Native host's sample-clocked, clean-room rhythm renderer. */
export class NativeRhythmFacade {
  private currentStatus: NativeRhythmStatus | null = null;
  private statusError = 'Native rhythm status has not been received.';
  private readonly listeners = new Set<NativeRhythmListener>();
  private readonly bridge: NativeBridgeClient;

  constructor(bridge: NativeBridgeClient) {
    this.bridge = bridge;
  }

  public get status(): NativeRhythmStatus | null {
    return this.currentStatus ? { ...this.currentStatus } : null;
  }

  public get error(): string {
    return this.statusError;
  }

  public get isAvailable(): boolean {
    return this.currentStatus?.prepared === true;
  }

  public get unavailableReason(): string {
    if (this.currentStatus && !this.currentStatus.prepared) return 'NATIVE RHYTHM IS NOT PREPARED';
    return this.statusError || 'NATIVE RHYTHM STATUS IS UNAVAILABLE';
  }

  public subscribe(listener: NativeRhythmListener): () => void {
    this.listeners.add(listener);
    listener(this.status, this.statusError);
    return () => this.listeners.delete(listener);
  }

  public async refresh(): Promise<NativeRhythmStatus | null> {
    try {
      const status = await this.bridge.getRhythmStatus();
      this.setStatus(status);
      return this.status;
    } catch (error) {
      this.currentStatus = null;
      this.statusError = error instanceof Error ? error.message : String(error);
      this.emit();
      return null;
    }
  }

  public clear(error = 'Native bridge is unavailable.'): void {
    this.currentStatus = null;
    this.statusError = error;
    this.emit();
  }

  public selectPatternKit(patternIndex: number, kitIndex: number): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.selectRhythmPatternKit(patternIndex, kitIndex));
  }

  public start(playIntro = true): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.startRhythm(playIntro));
  }

  public stop(): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.stopRhythm());
  }

  public queueVariation(variation: number): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.queueRhythmVariation(variation));
  }

  public queueFill(): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.queueRhythmFill());
  }

  public queueEnding(): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.queueRhythmEnding());
  }

  public setTempo(bpm: number): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.setRhythmTempo(bpm));
  }

  public setVolume(volume: number): Promise<NativeRhythmMutationResponse> {
    return this.accept(() => this.bridge.setRhythmVolume(volume));
  }

  private async accept(request: () => Promise<NativeRhythmMutationResponse>): Promise<NativeRhythmMutationResponse> {
    if (!this.isAvailable) throw new Error(this.unavailableReason);
    const response = await request();
    this.setStatus(response.rhythm);
    return response;
  }

  private setStatus(status: NativeRhythmStatus): void {
    this.currentStatus = { ...status };
    this.statusError = status.prepared ? '' : 'NATIVE RHYTHM IS NOT PREPARED';
    this.emit();
  }

  private emit(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status, this.statusError);
  }
}
