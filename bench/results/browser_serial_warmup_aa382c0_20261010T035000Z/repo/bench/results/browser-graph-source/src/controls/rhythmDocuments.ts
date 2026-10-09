import type { RhythmKitDocument, RhythmPatternDocument, RhythmRuntimeSnapshot, RhythmVoice } from '../audio/rhythmTypes';

const VOICES: readonly RhythmVoice[] = ['kick', 'snare', 'hat'];

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${name} must be a non-empty string up to 128 characters.`);
  }
  return value;
}

function finite(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function parseRhythmPatternDocument(value: unknown): RhythmPatternDocument {
  const source = object(value, 'Pattern');
  if (source.version !== 1) throw new TypeError('Pattern version must be 1.');
  const steps = finite(source.steps, 'Pattern steps', 1, 64);
  const stepsPerBeat = finite(source.stepsPerBeat, 'Pattern stepsPerBeat', 1, 8);
  if (!Number.isInteger(steps) || !Number.isInteger(stepsPerBeat)) throw new TypeError('Pattern step counts must be integers.');
  if (!Array.isArray(source.lanes) || source.lanes.length !== VOICES.length) {
    throw new TypeError('Pattern must contain exactly kick, snare, and hat lanes.');
  }
  const seenVoices = new Set<RhythmVoice>();
  const lanes = source.lanes.map((rawLane, laneIndex) => {
    const lane = object(rawLane, `Pattern lane ${laneIndex + 1}`);
    if (!VOICES.includes(lane.voice as RhythmVoice) || seenVoices.has(lane.voice as RhythmVoice)) {
      throw new TypeError(`Pattern lane ${laneIndex + 1} must use one unique supported voice.`);
    }
    const voice = lane.voice as RhythmVoice;
    seenVoices.add(voice);
    if (!Array.isArray(lane.velocities) || lane.velocities.length !== steps) {
      throw new TypeError(`${voice} velocities must contain exactly ${steps} steps.`);
    }
    return {
      voice,
      velocities: lane.velocities.map((velocity, stepIndex) => finite(velocity, `${voice} step ${stepIndex + 1}`, 0, 1)),
    };
  });
  return {
    version: 1,
    id: text(source.id, 'Pattern id'),
    name: text(source.name, 'Pattern name'),
    steps,
    stepsPerBeat,
    lanes,
  };
}

export function parseRhythmKitDocument(value: unknown): RhythmKitDocument {
  const source = object(value, 'Kit');
  if (source.version !== 1) throw new TypeError('Kit version must be 1.');
  const rawVoices = object(source.voices, 'Kit voices');
  const voices = Object.fromEntries(VOICES.map((voice) => {
    const settings = object(rawVoices[voice], `Kit ${voice}`);
    return [voice, {
      pitchHz: finite(settings.pitchHz, `${voice} pitch`, 20, 12_000),
      decayMs: finite(settings.decayMs, `${voice} decay`, 1, 10_000),
      noiseAmount: finite(settings.noiseAmount, `${voice} noise amount`, 0, 1),
      toneGain: finite(settings.toneGain, `${voice} tone gain`, 0, 2),
    }];
  })) as RhythmKitDocument['voices'];
  return {
    version: 1,
    id: text(source.id, 'Kit id'),
    name: text(source.name, 'Kit name'),
    voices,
  };
}

export function parseRhythmRuntimeSnapshot(value: unknown): RhythmRuntimeSnapshot {
  const source = object(value, 'Rhythm snapshot');
  if (source.version !== 1) throw new TypeError('Rhythm snapshot version must be 1.');
  if (typeof source.enabled !== 'boolean') throw new TypeError('Rhythm enabled must be a boolean.');
  let cleanRoomPreset: RhythmRuntimeSnapshot['cleanRoomPreset'];
  if (source.cleanRoomPreset !== undefined && source.cleanRoomPreset !== null) {
    const preset = object(source.cleanRoomPreset, 'Clean-room rhythm selection');
    if (!Number.isInteger(preset.patternIndex) || (preset.patternIndex as number) < 0 ||
        (preset.patternIndex as number) >= 240 || !Number.isInteger(preset.kitIndex) ||
        (preset.kitIndex as number) < 0 || (preset.kitIndex as number) >= 16) {
      throw new RangeError('Clean-room rhythm selection must reference one of 240 patterns and 16 kits.');
    }
    cleanRoomPreset = { patternIndex: preset.patternIndex as number, kitIndex: preset.kitIndex as number };
  }
  return {
    version: 1,
    enabled: source.enabled,
    volume: finite(source.volume, 'Rhythm volume', 0, 1),
    pattern: parseRhythmPatternDocument(source.pattern),
    kit: parseRhythmKitDocument(source.kit),
    ...(source.cleanRoomPreset !== undefined ? { cleanRoomPreset: cleanRoomPreset ?? null } : {}),
  };
}
