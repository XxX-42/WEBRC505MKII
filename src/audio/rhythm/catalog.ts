/**
 * Rhythm metadata transcribed from rhythm_patterns_240.csv.
 * It preserves the source labels verbatim, including repeated rows and apparent typos.
 * This is catalog metadata only: it does not contain factory MIDI or factory note events.
 * Events produced by this module are explicitly clean-room approximations.
 */

export const RHYTHM_VARIATIONS = ["A", "B", "C", "D"] as const;
export type RhythmVariation = (typeof RHYTHM_VARIATIONS)[number];
export const RHYTHM_SECTIONS = ["main", "intro", "ending", "fill"] as const;
export type RhythmSection = (typeof RHYTHM_SECTIONS)[number];

export interface RhythmMeter {
  readonly numerator: number;
  readonly denominator: number;
}

export interface RhythmSectionReferences {
  /** CSV says intro/ending/fill support exists globally; the renderer remains clean-room. */
  readonly intro: "clean-room:intro";
  readonly ending: "clean-room:ending";
  readonly fill: "clean-room:fill";
  readonly sourceCapabilityNote: string;
}

export interface RhythmPatternMetadata {
  readonly id: string;
  readonly globalIndex: number;
  readonly genre: string;
  readonly pattern: string;
  readonly beat: string;
  readonly meter: RhythmMeter;
  /** A-D are the four clean-room variation slots exposed by this implementation. */
  readonly variations: readonly RhythmVariation[];
  readonly sourceVariationCount: number;
  readonly sourceSectionSupport: string;
  readonly sourceNote: string;
  readonly sectionReferences: RhythmSectionReferences;
  readonly catalogProvenance: "metadata-transcription";
  readonly factoryMidiIncluded: false;
}

interface SourceRhythmRow {
  readonly globalIndex: number;
  readonly genre: string;
  readonly pattern: string;
  readonly beat: string;
  readonly meter: RhythmMeter;
  readonly variationCount: number;
  readonly introEndingFillEngine: string;
  readonly sourceNote: string;
}

export const SOURCE_RHYTHM_ROWS: readonly SourceRhythmRow[] = Object.freeze(
  [
  {
    "globalIndex": 1,
    "genre": "ACOUSTIC",
    "pattern": "SIDE STICK",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 2,
    "genre": "ACOUSTIC",
    "pattern": "BOSSA",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 3,
    "genre": "ACOUSTIC",
    "pattern": "BRUSH1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 4,
    "genre": "ACOUSTIC",
    "pattern": "BRUSH2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 5,
    "genre": "ACOUSTIC",
    "pattern": "CONGA 8BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 6,
    "genre": "ACOUSTIC",
    "pattern": "CONGA 16BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 7,
    "genre": "ACOUSTIC",
    "pattern": "CONGA 4BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 8,
    "genre": "ACOUSTIC",
    "pattern": "CONGA SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 9,
    "genre": "ACOUSTIC",
    "pattern": "CONGA BOSSA",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 10,
    "genre": "ACOUSTIC",
    "pattern": "CAJON1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 11,
    "genre": "ACOUSTIC",
    "pattern": "CAJON2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 12,
    "genre": "BALLAD",
    "pattern": "SHUFFLE2",
    "beat": "3/4",
    "meter": {
      "numerator": 3,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 13,
    "genre": "BALLAD",
    "pattern": "SIDE STICK1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 14,
    "genre": "BALLAD",
    "pattern": "SIDE STICK2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 15,
    "genre": "BALLAD",
    "pattern": "SIDE STICK3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 16,
    "genre": "BALLAD",
    "pattern": "SIDE STICK4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 17,
    "genre": "BALLAD",
    "pattern": "SHUFFLE1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 18,
    "genre": "BALLAD",
    "pattern": "8BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 19,
    "genre": "BALLAD",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 20,
    "genre": "BALLAD",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 21,
    "genre": "BALLAD",
    "pattern": "SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 22,
    "genre": "BALLAD",
    "pattern": "6/8 BEAT",
    "beat": "6/8",
    "meter": {
      "numerator": 6,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 23,
    "genre": "BLUES",
    "pattern": "3BEAT",
    "beat": "3/4",
    "meter": {
      "numerator": 3,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 24,
    "genre": "BLUES",
    "pattern": "12BARS",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 25,
    "genre": "BLUES",
    "pattern": "SHUFFLE1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 26,
    "genre": "BLUES",
    "pattern": "SHUFFLE2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 27,
    "genre": "BLUES",
    "pattern": "SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 28,
    "genre": "BLUES",
    "pattern": "6/8 BEAT",
    "beat": "6/8",
    "meter": {
      "numerator": 6,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 29,
    "genre": "JAZZ",
    "pattern": "JAZZ BLUES",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 30,
    "genre": "JAZZ",
    "pattern": "FAST 4BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 31,
    "genre": "JAZZ",
    "pattern": "HARD BOP",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 32,
    "genre": "JAZZ",
    "pattern": "BRUSH BOP",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 33,
    "genre": "JAZZ",
    "pattern": "BRUSH SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 34,
    "genre": "JAZZ",
    "pattern": "FAST SWNG",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 35,
    "genre": "JAZZ",
    "pattern": "MED SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 36,
    "genre": "JAZZ",
    "pattern": "SLOW LEGATO",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 37,
    "genre": "JAZZ",
    "pattern": "JAZZ SAMBA",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 38,
    "genre": "JAZZ",
    "pattern": "6/8 BEAT",
    "beat": "6/8",
    "meter": {
      "numerator": 6,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 39,
    "genre": "FUSION",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 40,
    "genre": "FUSION",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 41,
    "genre": "FUSION",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 42,
    "genre": "FUSION",
    "pattern": "16BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 43,
    "genre": "FUSION",
    "pattern": "16BEAT5",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 44,
    "genre": "FUSION",
    "pattern": "16BEAT6",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 45,
    "genre": "FUSION",
    "pattern": "16BEAT7",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 46,
    "genre": "FUSION",
    "pattern": "SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 47,
    "genre": "FUSION",
    "pattern": "7/8 BEAT",
    "beat": "7/8",
    "meter": {
      "numerator": 7,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 48,
    "genre": "R&B",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 49,
    "genre": "R&B",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 50,
    "genre": "R&B",
    "pattern": "SWING3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 51,
    "genre": "R&B",
    "pattern": "SIDE STICK1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 52,
    "genre": "R&B",
    "pattern": "SIDE STICK2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 53,
    "genre": "R&B",
    "pattern": "SIDE STICK3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 54,
    "genre": "R&B",
    "pattern": "SHUFFLE1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 55,
    "genre": "R&B",
    "pattern": "SHUFFLE2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 56,
    "genre": "R&B",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 57,
    "genre": "R&B",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 58,
    "genre": "R&B",
    "pattern": "7/8 BEAT",
    "beat": "7/8",
    "meter": {
      "numerator": 7,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 59,
    "genre": "SOUL",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 60,
    "genre": "SOUL",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 61,
    "genre": "SOUL",
    "pattern": "SWING3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 62,
    "genre": "SOUL",
    "pattern": "SWING4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 63,
    "genre": "SOUL",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 64,
    "genre": "SOUL",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 65,
    "genre": "SOUL",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 66,
    "genre": "SOUL",
    "pattern": "SIDESTK1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 67,
    "genre": "SOUL",
    "pattern": "SIDESTK2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 68,
    "genre": "SOUL",
    "pattern": "MOTOWN",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 69,
    "genre": "SOUL",
    "pattern": "PERCUS",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 70,
    "genre": "FUNK",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 71,
    "genre": "FUNK",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 72,
    "genre": "FUNK",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 73,
    "genre": "FUNK",
    "pattern": "8BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 74,
    "genre": "FUNK",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 75,
    "genre": "FUNK",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 76,
    "genre": "FUNK",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 77,
    "genre": "FUNK",
    "pattern": "16BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 78,
    "genre": "FUNK",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 79,
    "genre": "FUNK",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 80,
    "genre": "FUNK",
    "pattern": "SWING3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 81,
    "genre": "POP",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 82,
    "genre": "POP",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 83,
    "genre": "POP",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 84,
    "genre": "POP",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 85,
    "genre": "POP",
    "pattern": "PERCUS1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 86,
    "genre": "POP",
    "pattern": "SHUFFLE1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 87,
    "genre": "POP",
    "pattern": "SHUFFLE2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 88,
    "genre": "POP",
    "pattern": "SIDE STICK1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 89,
    "genre": "POP",
    "pattern": "SIDE STICK2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 90,
    "genre": "POP",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 91,
    "genre": "POP",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 92,
    "genre": "POP",
    "pattern": "PERCUS2",
    "beat": "6/8",
    "meter": {
      "numerator": 6,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 93,
    "genre": "SOFT ROCK",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 94,
    "genre": "SOFT ROCK",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 95,
    "genre": "SOFT ROCK",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 96,
    "genre": "SOFT ROCK",
    "pattern": "16BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 97,
    "genre": "SOFT ROCK",
    "pattern": "8BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 98,
    "genre": "SOFT ROCK",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 99,
    "genre": "SOFT ROCK",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 100,
    "genre": "SOFT ROCK",
    "pattern": "SWING3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 101,
    "genre": "SOFT ROCK",
    "pattern": "SWING4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 102,
    "genre": "SOFT ROCK",
    "pattern": "SIDE STICK1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 103,
    "genre": "SOFT ROCK",
    "pattern": "SIDE STICK2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 104,
    "genre": "SOFT ROCK",
    "pattern": "PERCUS1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 105,
    "genre": "SOFT ROCK",
    "pattern": "PERCUS2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 106,
    "genre": "ROCK",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 107,
    "genre": "ROCK",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 108,
    "genre": "ROCK",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 109,
    "genre": "ROCK",
    "pattern": "8BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 110,
    "genre": "ROCK",
    "pattern": "8BEAT5",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 111,
    "genre": "ROCK",
    "pattern": "8BEAT6",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 112,
    "genre": "ROCK",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 113,
    "genre": "ROCK",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 114,
    "genre": "ROCK",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 115,
    "genre": "ROCK",
    "pattern": "16BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 116,
    "genre": "ROCK",
    "pattern": "SHUFFLE1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 117,
    "genre": "ROCK",
    "pattern": "SHUFFLE2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 118,
    "genre": "ROCK",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 119,
    "genre": "ROCK",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 120,
    "genre": "ROCK",
    "pattern": "SWING3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 121,
    "genre": "ROCK",
    "pattern": "SWING4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 122,
    "genre": "ALT ROCK",
    "pattern": "RIDEBEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 123,
    "genre": "ALT ROCK",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 124,
    "genre": "ALT ROCK",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 125,
    "genre": "ALT ROCK",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 126,
    "genre": "ALT ROCK",
    "pattern": "8BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 127,
    "genre": "ALT ROCK",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 128,
    "genre": "ALT ROCK",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 129,
    "genre": "ALT ROCK",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 130,
    "genre": "ALT ROCK",
    "pattern": "16BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 131,
    "genre": "ALT ROCK",
    "pattern": "SWING",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 132,
    "genre": "ALT ROCK",
    "pattern": "5/4 BEAT",
    "beat": "5/4",
    "meter": {
      "numerator": 5,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 133,
    "genre": "PUNK",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 134,
    "genre": "PUNK",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 135,
    "genre": "PUNK",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 136,
    "genre": "PUNK",
    "pattern": "8BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 137,
    "genre": "PUNK",
    "pattern": "8BEAT5",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 138,
    "genre": "PUNK",
    "pattern": "8BEAT6",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 139,
    "genre": "PUNK",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 140,
    "genre": "PUNK",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 141,
    "genre": "PUNK",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 142,
    "genre": "PUNK",
    "pattern": "SIDE STICK",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 143,
    "genre": "PUNK",
    "pattern": "8BEAT6",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "The official table prints 8BEAT6 twice; preserved verbatim."
  },
  {
    "globalIndex": 144,
    "genre": "HEAVY ROCK",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 145,
    "genre": "HEAVY ROCK",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 146,
    "genre": "HEAVY ROCK",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 147,
    "genre": "HEAVY ROCK",
    "pattern": "16BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 148,
    "genre": "HEAVY ROCK",
    "pattern": "16BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 149,
    "genre": "HEAVY ROCK",
    "pattern": "16BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 150,
    "genre": "HEAVY ROCK",
    "pattern": "SHUFFLE1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 151,
    "genre": "HEAVY ROCK",
    "pattern": "SHUFFLE2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 152,
    "genre": "HEAVY ROCK",
    "pattern": "SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 153,
    "genre": "HEAVY ROCK",
    "pattern": "SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 154,
    "genre": "HEAVY ROCK",
    "pattern": "SWING3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 155,
    "genre": "METAL",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 156,
    "genre": "METAL",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 157,
    "genre": "METAL",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 158,
    "genre": "METAL",
    "pattern": "8BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 159,
    "genre": "METAL",
    "pattern": "8BEAT5",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 160,
    "genre": "METAL",
    "pattern": "8BEAT6",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 161,
    "genre": "METAL",
    "pattern": "2XBD1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 162,
    "genre": "METAL",
    "pattern": "2XBD2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 163,
    "genre": "METAL",
    "pattern": "2XBD3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 164,
    "genre": "METAL",
    "pattern": "2XBD4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 165,
    "genre": "METAL",
    "pattern": "2XBD5",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 166,
    "genre": "TRAD",
    "pattern": "TRAIN2",
    "beat": "2/4",
    "meter": {
      "numerator": 2,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 167,
    "genre": "TRAD",
    "pattern": "ROCKN ROLL",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 168,
    "genre": "TRAD",
    "pattern": "TRAIN1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 169,
    "genre": "TRAD",
    "pattern": "COUNTRY1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 170,
    "genre": "TRAD",
    "pattern": "COUNTRY2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 171,
    "genre": "TRAD",
    "pattern": "COUNTRY3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 172,
    "genre": "TRAD",
    "pattern": "FOXTROT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 173,
    "genre": "TRAD",
    "pattern": "TRAD1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 174,
    "genre": "TRAD",
    "pattern": "TRAD2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 175,
    "genre": "WORLD",
    "pattern": "BOSSA1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 176,
    "genre": "WORLD",
    "pattern": "BOSSA2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 177,
    "genre": "WORLD",
    "pattern": "SAMBA1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 178,
    "genre": "WORLD",
    "pattern": "SAMBA2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 179,
    "genre": "WORLD",
    "pattern": "BOOGALOO",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 180,
    "genre": "WORLD",
    "pattern": "MERENGUE",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 181,
    "genre": "WORLD",
    "pattern": "REGGAE",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 182,
    "genre": "WORLD",
    "pattern": "LATIN ROCK1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 183,
    "genre": "WORLD",
    "pattern": "LATIN ROCK2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 184,
    "genre": "WORLD",
    "pattern": "LATIN PERC",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 185,
    "genre": "WORLD",
    "pattern": "SURDO",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 186,
    "genre": "WORLD",
    "pattern": "LATIN1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 187,
    "genre": "WORLD",
    "pattern": "LATIN2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 188,
    "genre": "BALLAM",
    "pattern": "CUMBIA",
    "beat": "2/4",
    "meter": {
      "numerator": 2,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 189,
    "genre": "BALLAM",
    "pattern": "WALTZ1",
    "beat": "3/4",
    "meter": {
      "numerator": 3,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 190,
    "genre": "BALLAM",
    "pattern": "WALTZ2",
    "beat": "3/4",
    "meter": {
      "numerator": 3,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 191,
    "genre": "BALLAM",
    "pattern": "CHACHA",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 192,
    "genre": "BALLAM",
    "pattern": "BEGUINE",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 193,
    "genre": "BALLAM",
    "pattern": "RHUMBA",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 194,
    "genre": "BALLAM",
    "pattern": "TANGO1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 195,
    "genre": "BALLAM",
    "pattern": "TANGO2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 196,
    "genre": "BALLAM",
    "pattern": "JIVE",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 197,
    "genre": "BALLAM",
    "pattern": "CHARLSTON",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official pattern table spells this genre BALLAM; the settings page spells BALLRM."
  },
  {
    "globalIndex": 198,
    "genre": "ELCTRO",
    "pattern": "ELCTRO01",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 199,
    "genre": "ELCTRO",
    "pattern": "ELCTRO02",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 200,
    "genre": "ELCTRO",
    "pattern": "ELCTRO03",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 201,
    "genre": "ELCTRO",
    "pattern": "ELCTRO04",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 202,
    "genre": "ELCTRO",
    "pattern": "ELCTRO05",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 203,
    "genre": "ELCTRO",
    "pattern": "ELCTRO06",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 204,
    "genre": "ELCTRO",
    "pattern": "ELCTRO07",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 205,
    "genre": "ELCTRO",
    "pattern": "ELCTRO08",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 206,
    "genre": "ELCTRO",
    "pattern": "5/4 BEAT",
    "beat": "5/4",
    "meter": {
      "numerator": 5,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "Official spelling is ELCTRO."
  },
  {
    "globalIndex": 207,
    "genre": "GUIDE",
    "pattern": "2/4 TRIPLE",
    "beat": "2/4",
    "meter": {
      "numerator": 2,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 208,
    "genre": "GUIDE",
    "pattern": "3/4",
    "beat": "3/4",
    "meter": {
      "numerator": 3,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 209,
    "genre": "GUIDE",
    "pattern": "3/4 TRIPLE",
    "beat": "3/4",
    "meter": {
      "numerator": 3,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 210,
    "genre": "GUIDE",
    "pattern": "4/4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 211,
    "genre": "GUIDE",
    "pattern": "4/4 TRIPLE",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 212,
    "genre": "GUIDE",
    "pattern": "BD 8BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 213,
    "genre": "GUIDE",
    "pattern": "BD 16BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 214,
    "genre": "GUIDE",
    "pattern": "BD SHUFFLE",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 215,
    "genre": "GUIDE",
    "pattern": "HH 8BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 216,
    "genre": "GUIDE",
    "pattern": "HH 16BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 217,
    "genre": "GUIDE",
    "pattern": "HH SWING1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 218,
    "genre": "GUIDE",
    "pattern": "HH SWING2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 219,
    "genre": "GUIDE",
    "pattern": "8BEAT1",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 220,
    "genre": "GUIDE",
    "pattern": "8BEAT2",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 221,
    "genre": "GUIDE",
    "pattern": "8BEAT3",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 222,
    "genre": "GUIDE",
    "pattern": "8BEAT4",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 223,
    "genre": "GUIDE",
    "pattern": "5/4",
    "beat": "5/4",
    "meter": {
      "numerator": 5,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 224,
    "genre": "GUIDE",
    "pattern": "5/4 TRIPLE",
    "beat": "5/4",
    "meter": {
      "numerator": 5,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 225,
    "genre": "GUIDE",
    "pattern": "6/4",
    "beat": "6/4",
    "meter": {
      "numerator": 6,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 226,
    "genre": "GUIDE",
    "pattern": "6/4 TRIPLE",
    "beat": "6/4",
    "meter": {
      "numerator": 6,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 227,
    "genre": "GUIDE",
    "pattern": "7/4",
    "beat": "7/4",
    "meter": {
      "numerator": 7,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 228,
    "genre": "GUIDE",
    "pattern": "7/4 TRIPLE",
    "beat": "7/4",
    "meter": {
      "numerator": 7,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 229,
    "genre": "GUIDE",
    "pattern": "5/8",
    "beat": "5/8",
    "meter": {
      "numerator": 5,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 230,
    "genre": "GUIDE",
    "pattern": "6/8",
    "beat": "6/8",
    "meter": {
      "numerator": 6,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 231,
    "genre": "GUIDE",
    "pattern": "7/8",
    "beat": "7/8",
    "meter": {
      "numerator": 7,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 232,
    "genre": "GUIDE",
    "pattern": "8/8",
    "beat": "8/8",
    "meter": {
      "numerator": 8,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 233,
    "genre": "GUIDE",
    "pattern": "9/8",
    "beat": "9/8",
    "meter": {
      "numerator": 9,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 234,
    "genre": "GUIDE",
    "pattern": "10/8",
    "beat": "10/8",
    "meter": {
      "numerator": 10,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 235,
    "genre": "GUIDE",
    "pattern": "11/8",
    "beat": "11/8",
    "meter": {
      "numerator": 11,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 236,
    "genre": "GUIDE",
    "pattern": "12/8",
    "beat": "12/8",
    "meter": {
      "numerator": 12,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 237,
    "genre": "GUIDE",
    "pattern": "13/8",
    "beat": "13/8",
    "meter": {
      "numerator": 13,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 238,
    "genre": "GUIDE",
    "pattern": "14/8",
    "beat": "14/8",
    "meter": {
      "numerator": 14,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 239,
    "genre": "GUIDE",
    "pattern": "15/8",
    "beat": "15/8",
    "meter": {
      "numerator": 15,
      "denominator": 8
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": ""
  },
  {
    "globalIndex": 240,
    "genre": "USER",
    "pattern": "SIMPLE BEAT",
    "beat": "4/4",
    "meter": {
      "numerator": 4,
      "denominator": 4
    },
    "variationCount": 4,
    "introEndingFillEngine": "supported globally",
    "sourceNote": "User rhythm slot; official footnote says SMF patterns can be imported with RC-505mkII Rhythm Converter."
  }
] as const,
);


export const RHYTHM_PATTERN_CATALOG: readonly RhythmPatternMetadata[] = Object.freeze(
  SOURCE_RHYTHM_ROWS.map((row) => Object.freeze({
    id: `rhythm-${String(row.globalIndex).padStart(3, "0")}`,
    globalIndex: row.globalIndex,
    genre: row.genre,
    pattern: row.pattern,
    beat: row.beat,
    meter: Object.freeze({ ...row.meter }),
    variations: Object.freeze(RHYTHM_VARIATIONS.slice(0, row.variationCount)),
    sourceVariationCount: row.variationCount,
    sourceSectionSupport: row.introEndingFillEngine,
    sourceNote: row.sourceNote,
    sectionReferences: Object.freeze({
      intro: "clean-room:intro" as const,
      ending: "clean-room:ending" as const,
      fill: "clean-room:fill" as const,
      sourceCapabilityNote: row.introEndingFillEngine,
    }),
    catalogProvenance: "metadata-transcription" as const,
    factoryMidiIncluded: false as const,
  })),
);

export function getRhythmPatternByIndex(globalIndex: number): RhythmPatternMetadata | undefined {
  return RHYTHM_PATTERN_CATALOG[globalIndex - 1];
}

export function getRhythmPatternById(id: string): RhythmPatternMetadata | undefined {
  const match = /^rhythm-(\d{3})$/.exec(id);
  return match ? getRhythmPatternByIndex(Number(match[1])) : undefined;
}
