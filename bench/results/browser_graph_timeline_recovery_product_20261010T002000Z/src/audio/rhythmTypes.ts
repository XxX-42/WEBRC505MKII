/** Bounded serializable rhythm documents shared by the editor, projects, and Worklet runtime. */
export type RhythmVoice = 'kick' | 'snare' | 'hat';

export interface RhythmPatternLaneDocument {
  voice: RhythmVoice;
  /** Per-step velocity, normalized to [0, 1], with exactly `pattern.steps` values. */
  velocities: number[];
}

export interface RhythmPatternDocument {
  version: 1;
  id: string;
  name: string;
  steps: number;
  stepsPerBeat: number;
  lanes: RhythmPatternLaneDocument[];
}

export interface RhythmVoiceSettings {
  pitchHz: number;
  decayMs: number;
  noiseAmount: number;
  toneGain: number;
}

export interface RhythmKitDocument {
  version: 1;
  id: string;
  name: string;
  voices: Record<RhythmVoice, RhythmVoiceSettings>;
}

export interface RhythmRuntimeSnapshot {
  version: 1;
  enabled: boolean;
  volume: number;
  pattern: RhythmPatternDocument;
  kit: RhythmKitDocument;
  /** Optional clean-room renderer selection; absent in legacy project documents. */
  cleanRoomPreset?: { patternIndex: number; kitIndex: number } | null;
}
