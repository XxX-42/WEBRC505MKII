export type RhythmPattern = 'ROCK' | 'TECHNO' | 'METRONOME';
export type RhythmRealtimeControl = (running: boolean, patternIndex: number) => void;

const PATTERN_INDEX: Record<RhythmPattern, number> = {
  ROCK: 0,
  TECHNO: 1,
  METRONOME: 2,
};

/** Rhythm UI controller. Synthesis and step timing run in the persistent looper worklet. */
export class RhythmEngine {
  public readonly outputNode: GainNode;
  private readonly context: AudioContext;
  private isPlaying = false;
  private currentPattern: RhythmPattern = 'ROCK';
  private realtimeControl: RhythmRealtimeControl | null = null;

  constructor(context: AudioContext) {
    this.context = context;
    this.outputNode = context.createGain();
    this.outputNode.gain.value = 0.5;
  }

  public get isRunning(): boolean {
    return this.isPlaying;
  }

  public get patternIndex(): number {
    return PATTERN_INDEX[this.currentPattern];
  }

  public connect(destination: AudioNode) {
    this.outputNode.connect(destination);
  }

  public setRealtimeControl(control: RhythmRealtimeControl | null) {
    this.realtimeControl = control;
    this.notifyWorklet();
  }

  public setPattern(pattern: RhythmPattern) {
    this.currentPattern = pattern;
    this.notifyWorklet();
  }

  public setVolume(value: number) {
    this.outputNode.gain.value = Math.max(0, Math.min(100, value)) / 100;
  }

  public start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    if (this.context.state === 'suspended') {
      void this.context.resume().catch((error) => console.error('Could not resume audio for rhythm playback:', error));
    }
    this.notifyWorklet();
  }

  public stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.notifyWorklet();
  }

  private notifyWorklet() {
    this.realtimeControl?.(this.isPlaying, this.patternIndex);
  }
}
