/** Supported clean-room event quantization grids, expressed as note values. */
export const RHYTHM_QUANTIZE_GRIDS = ["1/16", "1/8", "1/4"] as const;
export type RhythmQuantizeGrid = (typeof RHYTHM_QUANTIZE_GRIDS)[number];

const GRID_STEPS: Readonly<Record<RhythmQuantizeGrid, number>> = {
  "1/16": 1,
  "1/8": 2,
  "1/4": 4,
};

/** Snap a sixteenth-note ordinal to the nearest selected clean-room grid. */
export function quantizeRhythmStep(step: number, grid: RhythmQuantizeGrid): number {
  if (!Number.isSafeInteger(step) || step < 0) throw new RangeError("Rhythm step must be a non-negative safe integer");
  const gridSteps = GRID_STEPS[grid];
  if (gridSteps === undefined) throw new RangeError(`Unsupported rhythm quantize grid: ${String(grid)}`);
  return Math.round(step / gridSteps) * gridSteps;
}

/**
 * Return one generated event's absolute sample frame. Quantization is applied first,
 * then 8th-note swing delays the offbeat sixteenth-pair subdivision. A ratio of 50%
 * is straight; 66–67% approximates triplet swing; 75% is the dotted-eighth extreme.
 *
 * Frames are calculated from the global sixteenth ordinal and a single rational
 * beat-position expression. Repeated bars therefore never accumulate rounded deltas.
 */
export function getRhythmEventFrame(
  startFrame: number,
  barIndex: number,
  eventStep: number,
  stepsPerBar: number,
  sampleRate: number,
  bpm: number,
  swingPercent: number,
  quantizeGrid: RhythmQuantizeGrid,
): number {
  const quantizedStep = quantizeRhythmStep(eventStep, quantizeGrid);
  if (!Number.isSafeInteger(barIndex) || barIndex < 0) throw new RangeError("Rhythm bar index must be non-negative");
  if (!Number.isSafeInteger(stepsPerBar) || stepsPerBar < 1) throw new RangeError("stepsPerBar must be positive");
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) throw new RangeError("startFrame must be non-negative");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError("sampleRate and BPM must be positive and finite");
  }
  if (!Number.isInteger(swingPercent) || swingPercent < 50 || swingPercent > 75) {
    throw new RangeError("swingPercent must be an integer from 50 to 75");
  }

  const absoluteStep = barIndex * stepsPerBar + quantizedStep;
  if (!Number.isSafeInteger(absoluteStep)) throw new RangeError("Rhythm step exceeds safe sample-frame precision");
  const sampleFramesPerBeat = sampleRate * 60 / bpm;
  if (absoluteStep % 4 === 2 && swingPercent > 50) {
    const beatPosition = absoluteStep / 4 + (swingPercent - 50) / 100;
    return startFrame + Math.round(beatPosition * sampleFramesPerBeat);
  }
  return startFrame + Math.round((absoluteStep * sampleRate * 15) / bpm);
}
