export type OscVocWaveform = 0 | 1 | 2;

export interface OscVocParameters {
  waveform: OscVocWaveform;
  midiChannel: number;
  octaveSemitones: number;
  mixPercent: number;
}

export type OscVocParameterKey = 'waveform' | 'midi-channel' | 'octave' | 'mix';

export function createDefaultOscVocParameters(): OscVocParameters {
  return { waveform: 0, midiChannel: 1, octaveSemitones: 0, mixPercent: 70 };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function sanitizeOscVocParameters(raw?: Partial<OscVocParameters> | null): OscVocParameters {
  const defaults = createDefaultOscVocParameters();
  return {
    waveform: Math.round(Math.max(0, Math.min(2, finiteNumber(raw?.waveform, defaults.waveform)))) as OscVocWaveform,
    midiChannel: Math.round(Math.max(1, Math.min(16, finiteNumber(raw?.midiChannel, defaults.midiChannel)))),
    octaveSemitones: Math.max(-24, Math.min(24, finiteNumber(raw?.octaveSemitones, defaults.octaveSemitones))),
    mixPercent: Math.max(0, Math.min(100, finiteNumber(raw?.mixPercent, defaults.mixPercent))),
  };
}

/** The canonical catalog keys are shared by the Browser adapter and Native bridge. */
export function toCatalogOscVocParameters(parameters: OscVocParameters): Record<OscVocParameterKey, number> {
  const safe = sanitizeOscVocParameters(parameters);
  return {
    waveform: safe.waveform,
    'midi-channel': safe.midiChannel,
    octave: safe.octaveSemitones,
    mix: safe.mixPercent,
  };
}
