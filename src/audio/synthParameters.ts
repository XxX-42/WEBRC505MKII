/**
 * Shared clean-room SYNTH control contract for Browser and Native A–D slots.
 * The ranges are implementation controls, not claims about Roland parameters.
 */
export interface SynthParameters {
  sensitivity: number;
  waveform: number;
  octave: number;
  tone: number;
  mix: number;
}

export const SYNTH_WAVEFORMS = ['Saw', 'Square', 'Triangle'] as const;

export function createDefaultSynthParameters(): SynthParameters {
  return { sensitivity: 60, waveform: 0, octave: 0, tone: 4000, mix: 50 };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Bound persisted or UI input before it reaches either audio runtime. */
export function sanitizeSynthParameters(value: unknown): SynthParameters {
  const defaults = createDefaultSynthParameters();
  const source = value && typeof value === 'object' ? value as Partial<SynthParameters> : {};
  return {
    sensitivity: clamp(finiteOr(source.sensitivity, defaults.sensitivity), 0, 100),
    waveform: clamp(Math.round(finiteOr(source.waveform, defaults.waveform)), 0, SYNTH_WAVEFORMS.length - 1),
    octave: clamp(Math.round(finiteOr(source.octave, defaults.octave)), -24, 24),
    tone: clamp(finiteOr(source.tone, defaults.tone), 100, 16000),
    mix: clamp(finiteOr(source.mix, defaults.mix), 0, 100),
  };
}
