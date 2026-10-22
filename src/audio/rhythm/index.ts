/**
 * Clean-room rhythm subsystem. Catalog strings/indices/meters reflect source metadata;
 * generated events and sound synthesis are approximations, not factory MIDI or samples.
 */
export {
  RHYTHM_PATTERN_CATALOG,
  RHYTHM_SECTIONS,
  RHYTHM_VARIATIONS,
  getRhythmPatternById,
  getRhythmPatternByIndex,
} from "./catalog";
export type {
  RhythmMeter,
  RhythmPatternMetadata,
  RhythmSection,
  RhythmSectionReferences,
  RhythmVariation,
} from "./catalog";
export { DRUM_KIT_CATALOG, SOURCE_KIT_ROWS, getDrumKitByIndex, getDrumKitByName } from "./kits";
export type { DrumKitProfile, KitSourceRow } from "./kits";
export { DRUM_INSTRUMENTS, createCleanRoomPatternEvents, createRhythmRuntimeEventTemplate } from "./events";
export type { CleanRoomDrumEvent, CleanRoomPatternOptions, DrumInstrument } from "./events";
export { DrumVoicePool } from "./voicePool";
export type { DrumVoicePoolOptions } from "./voicePool";
export { RHYTHM_QUANTIZE_GRIDS, getRhythmEventFrame, quantizeRhythmStep } from "./timing";
export type { RhythmQuantizeGrid } from "./timing";
