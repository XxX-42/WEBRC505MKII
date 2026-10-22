import {
  RHYTHM_PATTERN_CATALOG,
  type RhythmPatternMetadata,
  type RhythmSection,
  type RhythmVariation,
} from "./catalog";

/** Drum articulation names are implementation-defined and contain no factory MIDI mapping. */
export const DRUM_INSTRUMENTS = ["kick", "snare", "closedHat", "openHat", "tom", "ride", "clap", "brush"] as const;
export type DrumInstrument = (typeof DRUM_INSTRUMENTS)[number];

export interface CleanRoomDrumEvent {
  /** Integer sample frame on the absolute audio timeline. */
  readonly frame: number;
  readonly instrument: DrumInstrument;
  /** MIDI-like 1–127 amplitude control; not a factory MIDI velocity. */
  readonly velocity: number;
  readonly seed: number;
  readonly patternId: string;
  readonly bar: number;
  readonly step: number;
  readonly variation: RhythmVariation;
  readonly section: RhythmSection;
  readonly provenance: "clean-room-generated";
}

export interface CleanRoomPatternOptions {
  readonly sampleRate: number;
  readonly bpm: number;
  readonly startFrame?: number;
  readonly bars?: number;
  readonly variation?: RhythmVariation;
  readonly section?: RhythmSection;
}

const DEFAULT_START_FRAME = 0;
const DEFAULT_BARS = 1;
const DEFAULT_VARIATION: RhythmVariation = "A";
const DEFAULT_SECTION: RhythmSection = "main";

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function unitHash(seed: number, salt: number): number {
  return mix32(seed ^ Math.imul(salt + 1, 0x9e3779b1)) / 0x1_0000_0000;
}

function clampVelocity(value: number): number {
  return Math.max(1, Math.min(127, Math.round(value)));
}

/**
 * Build deterministic, clean-room A-D and Intro/Ending/Fill events from metadata.
 * Source rhythm metadata carries names/meters/availability only. This heuristic is
 * deliberately not described as the RC-505mkII's factory pattern or MIDI content.
 *
 * Frame positions are calculated from the global sixteenth-note ordinal, rather than
 * incremented by a rounded frame delta, so fractional samples-per-step never accumulate
 * a per-step rounding error across bars.
 */
export function createCleanRoomPatternEvents(
  pattern: RhythmPatternMetadata | number | string,
  options: CleanRoomPatternOptions,
): CleanRoomDrumEvent[] {
  const metadata = resolvePattern(pattern);
  if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
  if (!Number.isFinite(options.bpm) || options.bpm <= 0) {
    throw new RangeError("bpm must be a positive finite number");
  }
  const startFrame = options.startFrame ?? DEFAULT_START_FRAME;
  const bars = options.bars ?? DEFAULT_BARS;
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
    throw new RangeError("startFrame must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(bars) || bars < 1 || bars > 1024) {
    throw new RangeError("bars must be a whole number between 1 and 1024");
  }
  const variation = options.variation ?? DEFAULT_VARIATION;
  const section = options.section ?? DEFAULT_SECTION;
  if (!metadata.variations.includes(variation)) {
    throw new RangeError(`Variation ${variation} is not available for ${metadata.id}`);
  }
  if (!isRhythmSection(section)) throw new RangeError(`Unknown rhythm section: ${String(section)}`);

  const denominator = metadata.meter.denominator;
  const stepsPerBeat = 16 / denominator;
  if (!Number.isInteger(stepsPerBeat)) {
    throw new RangeError(`Unsupported denominator in ${metadata.beat}`);
  }
  const stepsPerBar = metadata.meter.numerator * stepsPerBeat;
  const seed = hash32(`${metadata.id}|${metadata.genre}|${metadata.pattern}|${variation}|${section}`);
  const events: CleanRoomDrumEvent[] = [];
  let eventOrdinal = 0;

  const add = (bar: number, step: number, instrument: DrumInstrument, accent: number): void => {
    const absoluteSixteenth = bar * stepsPerBar + step;
    const frame = startFrame + Math.round((absoluteSixteenth * options.sampleRate * 15) / options.bpm);
    const eventSeed = mix32(seed ^ Math.imul(absoluteSixteenth + 1, 0x45d9f3b) ^ hash32(instrument));
    const humanization = 0.82 + unitHash(seed, absoluteSixteenth * 13 + eventOrdinal) * 0.18;
    const velocity = clampVelocity(80 * accent * humanization);
    events.push({
      frame,
      instrument,
      velocity,
      seed: eventSeed,
      patternId: metadata.id,
      bar,
      step,
      variation,
      section,
      provenance: "clean-room-generated",
    });
    eventOrdinal += 1;
  };

  const style = `${metadata.genre} ${metadata.pattern}`.toUpperCase();
  const electronic = /TECHNO|DANCE|ELCTRO|DRUM&BASS|808|HIPHOP|ELECTRO|METAL/.test(style);
  const world = /CONGA|BOSSA|CAJON|WORLD|TRAD/.test(style);
  const hatsPerBeat = variation === "C" ? 1 : variation === "D" ? 4 : 2;

  for (let bar = 0; bar < bars; bar += 1) {
    const finalBar = bar === bars - 1;
    const fillBar = section === "fill" && finalBar;
    const endingBar = section === "ending" && finalBar;
    const introBar = section === "intro" && bar === 0;

    for (let step = 0; step < stepsPerBar; step += 1) {
      const beat = Math.floor(step / stepsPerBeat);
      const withinBeat = step % stepsPerBeat;
      const onBeat = withinBeat === 0;
      const downbeat = step === 0;
      const backbeat = onBeat && beat % 2 === 1;
      const random = unitHash(seed, bar * stepsPerBar + step);

      const kickEveryBeat = electronic ? 1 : world ? 2 : 2;
      if ((downbeat || (onBeat && beat % kickEveryBeat === 0 && random > 0.43)) && (!introBar || downbeat)) {
        add(bar, step, "kick", downbeat ? 1.18 : 0.94);
      } else if (variation === "B" && !onBeat && random > 0.90) {
        add(bar, step, "kick", 0.70);
      }

      const snarePulse = backbeat || (fillBar && !onBeat && random > 0.58);
      if (snarePulse && (!introBar || random > 0.35)) {
        add(bar, step, world ? "clap" : "snare", backbeat ? 1.0 : 0.83);
      }

      const hatSubdivision = Math.max(1, Math.floor(stepsPerBeat / hatsPerBeat));
      const hatStep = step % hatSubdivision === 0;
      if (hatStep && (random > (variation === "C" ? 0.25 : 0.10) || onBeat)) {
        const openHat = !fillBar && !introBar && !onBeat && electronic && variation !== "C" && random > 0.94;
        add(bar, step, openHat ? "openHat" : electronic && onBeat && beat % 2 === 0 ? "ride" : "closedHat", onBeat ? 0.72 : 0.49);
      }

      if (fillBar && step >= Math.floor(stepsPerBar * 0.70) && random > 0.57 && !onBeat) {
        add(bar, step, "tom", 0.78);
      }
      if (endingBar && step === stepsPerBar - 1) {
        add(bar, step, "openHat", 0.78);
      }
      if (variation === "D" && !onBeat && random > 0.92 && !fillBar) {
        add(bar, step, "tom", 0.57);
      }
    }
  }

  return events.sort((left, right) => left.frame - right.frame || left.bar - right.bar || left.step - right.step || left.instrument.localeCompare(right.instrument));
}

/**
 * Build the one-bar event template shared by Browser playback and parity tools.
 * The legacy GUIDE row 210 is intentionally rendered as the existing clean-room
 * kick/snare click, regardless of the selected variation/section.
 */
export function createRhythmRuntimeEventTemplate(
  pattern: RhythmPatternMetadata | number | string,
  options: CleanRoomPatternOptions,
): CleanRoomDrumEvent[] {
  const metadata = resolvePattern(pattern);
  const isGuideClick = metadata.globalIndex === 210;
  const events = createCleanRoomPatternEvents(metadata, {
    ...options,
    variation: isGuideClick ? "A" : options.variation,
    section: isGuideClick ? "main" : options.section,
  });
  if (!isGuideClick) return events;

  const beatTicks = events.filter((event) => event.instrument === "closedHat" && event.step % 4 === 0);
  return beatTicks.map((event, index) => ({
    ...event,
    instrument: index === 0 ? "kick" : "snare",
    velocity: index === 0 ? 112 : 86,
  }));
}

function resolvePattern(pattern: RhythmPatternMetadata | number | string): RhythmPatternMetadata {
  if (typeof pattern === "number") {
    const match = RHYTHM_PATTERN_CATALOG[pattern - 1];
    if (match) return match;
  } else if (typeof pattern === "string") {
    const match = RHYTHM_PATTERN_CATALOG.find((item) => item.id === pattern);
    if (match) return match;
  } else if (pattern && typeof pattern.globalIndex === "number") {
    return pattern;
  }
  throw new RangeError(`Unknown rhythm pattern: ${String(pattern)}`);
}

function isRhythmSection(section: string): section is RhythmSection {
  return section === "main" || section === "intro" || section === "ending" || section === "fill";
}
