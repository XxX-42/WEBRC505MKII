/**
 * Kit metadata comes from kits_16_algorithm_matrix.csv. The names and target-timbre
 * descriptions are retained verbatim; numeric DSP controls below are a clean-room
 * procedural mapping, not a representation of Roland's unpublished samples/circuitry.
 */
export interface KitSourceRow {
  readonly index: number;
  readonly official_kit_name: string;
  readonly target_timbre: string;
  readonly native_balanced_architecture: string;
  readonly browser_balanced_architecture: string;
  readonly formula_ids: string;
  readonly evidence_status: string;
}

export interface DrumKitProfile {
  readonly id: string;
  readonly index: number;
  readonly officialName: string;
  readonly targetTimbre: string;
  readonly nativeArchitecture: string;
  readonly browserArchitecture: string;
  readonly formulaIds: readonly string[];
  readonly evidenceStatus: string;
  readonly timbreProvenance: "clean-room-procedural";
  readonly timbre: {
    readonly kickHz: number;
    readonly kickPitchDropHz: number;
    readonly kickDecayMs: number;
    readonly snareHz: number;
    readonly snareNoiseMix: number;
    readonly snareDecayMs: number;
    readonly hatCutoffHz: number;
    readonly hatDecayMs: number;
    readonly tomHz: number;
    readonly tomDecayMs: number;
    readonly roomMix: number;
    readonly saturation: number;
    readonly velocityExponent: number;
    readonly roundRobinCount: number;
  };
}

// Source metadata is embedded so the app does not depend on a data-file loader.
export const SOURCE_KIT_ROWS: readonly KitSourceRow[] = Object.freeze([
  { index: 1, official_kit_name: "STUDIO", target_timbre: "Tight close-mic acoustic kit, controlled room", native_balanced_architecture: "4–8 velocity layers, 3–4 round robins, close/OH/room buses", browser_balanced_architecture: "2–4 layers, 2 round robins, pre-rendered room tail", formula_ids: "Sample playback + F20/F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 2, official_kit_name: "LIVE", target_timbre: "Larger room and stage bleed, broader stereo image", native_balanced_architecture: "Multi-mic sample set + early reflections/FDN room send", browser_balanced_architecture: "Dry samples + short pre-rendered room/FDN8 send", formula_ids: "F17,F18,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 3, official_kit_name: "LIGHT", target_timbre: "Small shells, short decay, low transient mass", native_balanced_architecture: "Short acoustic samples, light bus compression", browser_balanced_architecture: "Reduced layers and tail lengths", formula_ids: "F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 4, official_kit_name: "HEAVY", target_timbre: "Large shells, deep kick, parallel-compressed room", native_balanced_architecture: "Layered acoustic kit, parallel dynamics, room FDN", browser_balanced_architecture: "Layered samples, baked room and gentle bus compressor", formula_ids: "F08,F17,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 5, official_kit_name: "ROCK", target_timbre: "Strong attack, medium room, controlled gated ambience", native_balanced_architecture: "Attack/body sample layers, gated room return", browser_balanced_architecture: "2–4 layers, baked ambience, FDN8 gate", formula_ids: "F08,F17,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 6, official_kit_name: "METAL", target_timbre: "Click-forward kick, bright snare/cymbals, fast decay", native_balanced_architecture: "Multi-layer samples, transient shaper, narrow dynamic tails", browser_balanced_architecture: "Pre-shaped samples and light saturation", formula_ids: "F07,F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 7, official_kit_name: "JAZZ", target_timbre: "Ride-led, open dynamics, natural room", native_balanced_architecture: "High velocity resolution, cymbal round robins, minimal compression", browser_balanced_architecture: "Prioritize ride/cymbal variations; 2–4 layers", formula_ids: "F17,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 8, official_kit_name: "BRUSH", target_timbre: "Brush taps, sweeps and softer snare articulations", native_balanced_architecture: "Dedicated sweep/tap one-shots and loopable brush textures", browser_balanced_architecture: "Compressed brush sample set; sweep texture pool", formula_ids: "F15,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 9, official_kit_name: "CAJON", target_timbre: "Bass/body/slap articulations with wooden resonance", native_balanced_architecture: "Layered cajon samples + modal body resonator", browser_balanced_architecture: "Samples + 2–4 modal resonances", formula_ids: "F03,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 10, official_kit_name: "DRUM&BASS", target_timbre: "Tight breakbeat transients, electronic sub and edited hats", native_balanced_architecture: "Sample/procedural hybrid, transient slicing, parallel saturation", browser_balanced_architecture: "Pre-rendered break layers + procedural sub kick", formula_ids: "F07,F15,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 11, official_kit_name: "R&B", target_timbre: "Round kick, soft snare/clap, restrained hats", native_balanced_architecture: "Layered samples, gentle low-pass and bus compression", browser_balanced_architecture: "2–4 sample layers and low-cost bus compressor", formula_ids: "F02,F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 12, official_kit_name: "DANCE", target_timbre: "Club kick, bright clap and open electronic hats", native_balanced_architecture: "Procedural/sample hybrid with sidechain-ready envelopes", browser_balanced_architecture: "Procedural kick + one-shot clap/hats", formula_ids: "F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 13, official_kit_name: "TECHNO", target_timbre: "Hard electronic kick, resonant percussion, saturated hats", native_balanced_architecture: "Procedural kick/toms + oversampled saturation", browser_balanced_architecture: "Procedural oscillators + 2x ADAA", formula_ids: "F03,F07,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 14, official_kit_name: "DANCE BEATS", target_timbre: "Layered modern dance kit with broad macro range", native_balanced_architecture: "Sample/procedural layers, macro-driven transient/body balance", browser_balanced_architecture: "Pre-rendered layers, selective procedural kick", formula_ids: "F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 15, official_kit_name: "HIPHOP", target_timbre: "Low-passed drums, clap/snare layering, vinyl coloration", native_balanced_architecture: "Layered one-shots + saturation + optional wow/noise", browser_balanced_architecture: "Samples + ADAA + cheap filtered noise", formula_ids: "F02,F07,F26,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
  { index: 16, official_kit_name: "808+909", target_timbre: "Classic analog drum-machine hybrid", native_balanced_architecture: "Procedural bridged-T kick/toms, noise snare/clap/hats, nonlinear accent", browser_balanced_architecture: "Same procedural core in WASM; deterministic random source", formula_ids: "F07,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
]);

interface CleanRoomTimbreParameters {
  readonly kickHz: number;
  readonly kickPitchDropHz: number;
  readonly kickDecayMs: number;
  readonly snareHz: number;
  readonly snareNoiseMix: number;
  readonly snareDecayMs: number;
  readonly hatCutoffHz: number;
  readonly hatDecayMs: number;
  readonly tomHz: number;
  readonly tomDecayMs: number;
  readonly roomMix: number;
  readonly saturation: number;
  readonly velocityExponent: number;
  readonly roundRobinCount: number;
}

// Clean-room controls: kick Hz/drop/decay, snare Hz/noise/decay, hat cutoff/decay,
// tom Hz/decay, room mix, saturation, velocity exponent, deterministic RR cycle.
const CLEAN_ROOM_TIMBRES: readonly CleanRoomTimbreParameters[] = Object.freeze([
  { kickHz: 78, kickPitchDropHz: 74, kickDecayMs: 250, snareHz: 190, snareNoiseMix: 0.60, snareDecayMs: 160, hatCutoffHz: 9200, hatDecayMs: 62, tomHz: 142, tomDecayMs: 230, roomMix: 0.12, saturation: 0.06, velocityExponent: 0.88, roundRobinCount: 3 },
  { kickHz: 70, kickPitchDropHz: 64, kickDecayMs: 300, snareHz: 180, snareNoiseMix: 0.70, snareDecayMs: 205, hatCutoffHz: 8600, hatDecayMs: 95, tomHz: 132, tomDecayMs: 260, roomMix: 0.30, saturation: 0.08, velocityExponent: 0.84, roundRobinCount: 4 },
  { kickHz: 90, kickPitchDropHz: 60, kickDecayMs: 175, snareHz: 220, snareNoiseMix: 0.54, snareDecayMs: 125, hatCutoffHz: 7800, hatDecayMs: 44, tomHz: 165, tomDecayMs: 160, roomMix: 0.04, saturation: 0.02, velocityExponent: 0.96, roundRobinCount: 2 },
  { kickHz: 58, kickPitchDropHz: 52, kickDecayMs: 390, snareHz: 165, snareNoiseMix: 0.66, snareDecayMs: 220, hatCutoffHz: 7600, hatDecayMs: 78, tomHz: 105, tomDecayMs: 310, roomMix: 0.24, saturation: 0.19, velocityExponent: 0.80, roundRobinCount: 3 },
  { kickHz: 68, kickPitchDropHz: 82, kickDecayMs: 325, snareHz: 205, snareNoiseMix: 0.64, snareDecayMs: 185, hatCutoffHz: 10000, hatDecayMs: 70, tomHz: 150, tomDecayMs: 215, roomMix: 0.16, saturation: 0.13, velocityExponent: 0.82, roundRobinCount: 3 },
  { kickHz: 62, kickPitchDropHz: 105, kickDecayMs: 285, snareHz: 240, snareNoiseMix: 0.82, snareDecayMs: 130, hatCutoffHz: 11800, hatDecayMs: 42, tomHz: 178, tomDecayMs: 155, roomMix: 0.07, saturation: 0.24, velocityExponent: 0.72, roundRobinCount: 4 },
  { kickHz: 82, kickPitchDropHz: 42, kickDecayMs: 360, snareHz: 175, snareNoiseMix: 0.50, snareDecayMs: 240, hatCutoffHz: 10800, hatDecayMs: 170, tomHz: 125, tomDecayMs: 290, roomMix: 0.10, saturation: 0.01, velocityExponent: 0.72, roundRobinCount: 5 },
  { kickHz: 92, kickPitchDropHz: 35, kickDecayMs: 260, snareHz: 280, snareNoiseMix: 0.92, snareDecayMs: 290, hatCutoffHz: 7200, hatDecayMs: 110, tomHz: 210, tomDecayMs: 205, roomMix: 0.05, saturation: 0.03, velocityExponent: 1.12, roundRobinCount: 4 },
  { kickHz: 78, kickPitchDropHz: 32, kickDecayMs: 240, snareHz: 310, snareNoiseMix: 0.48, snareDecayMs: 170, hatCutoffHz: 6500, hatDecayMs: 68, tomHz: 195, tomDecayMs: 260, roomMix: 0.08, saturation: 0.07, velocityExponent: 0.92, roundRobinCount: 3 },
  { kickHz: 55, kickPitchDropHz: 110, kickDecayMs: 220, snareHz: 220, snareNoiseMix: 0.86, snareDecayMs: 115, hatCutoffHz: 11200, hatDecayMs: 38, tomHz: 120, tomDecayMs: 145, roomMix: 0.03, saturation: 0.22, velocityExponent: 0.76, roundRobinCount: 4 },
  { kickHz: 72, kickPitchDropHz: 50, kickDecayMs: 295, snareHz: 185, snareNoiseMix: 0.58, snareDecayMs: 205, hatCutoffHz: 8200, hatDecayMs: 60, tomHz: 135, tomDecayMs: 225, roomMix: 0.11, saturation: 0.09, velocityExponent: 0.88, roundRobinCount: 3 },
  { kickHz: 49, kickPitchDropHz: 100, kickDecayMs: 360, snareHz: 255, snareNoiseMix: 0.78, snareDecayMs: 150, hatCutoffHz: 12200, hatDecayMs: 48, tomHz: 165, tomDecayMs: 180, roomMix: 0.08, saturation: 0.16, velocityExponent: 0.74, roundRobinCount: 2 },
  { kickHz: 44, kickPitchDropHz: 120, kickDecayMs: 440, snareHz: 235, snareNoiseMix: 0.70, snareDecayMs: 140, hatCutoffHz: 12600, hatDecayMs: 43, tomHz: 185, tomDecayMs: 190, roomMix: 0.02, saturation: 0.30, velocityExponent: 0.70, roundRobinCount: 3 },
  { kickHz: 52, kickPitchDropHz: 108, kickDecayMs: 335, snareHz: 215, snareNoiseMix: 0.76, snareDecayMs: 145, hatCutoffHz: 11600, hatDecayMs: 50, tomHz: 155, tomDecayMs: 170, roomMix: 0.04, saturation: 0.20, velocityExponent: 0.76, roundRobinCount: 3 },
  { kickHz: 50, kickPitchDropHz: 88, kickDecayMs: 365, snareHz: 195, snareNoiseMix: 0.72, snareDecayMs: 175, hatCutoffHz: 9400, hatDecayMs: 68, tomHz: 140, tomDecayMs: 220, roomMix: 0.12, saturation: 0.18, velocityExponent: 0.80, roundRobinCount: 4 },
  { kickHz: 58, kickPitchDropHz: 102, kickDecayMs: 410, snareHz: 205, snareNoiseMix: 0.88, snareDecayMs: 200, hatCutoffHz: 6800, hatDecayMs: 55, tomHz: 130, tomDecayMs: 210, roomMix: 0.06, saturation: 0.26, velocityExponent: 0.78, roundRobinCount: 3 },
]);

if (SOURCE_KIT_ROWS.length !== 16 || CLEAN_ROOM_TIMBRES.length !== SOURCE_KIT_ROWS.length) {
  throw new Error("The clean-room kit catalog must stay aligned to the 16 source kit rows");
}

export const DRUM_KIT_CATALOG: readonly DrumKitProfile[] = Object.freeze(
  SOURCE_KIT_ROWS.map((row, index) => Object.freeze({
    id: `kit-${String(row.index).padStart(2, "0")}`,
    index: row.index,
    officialName: row.official_kit_name,
    targetTimbre: row.target_timbre,
    nativeArchitecture: row.native_balanced_architecture,
    browserArchitecture: row.browser_balanced_architecture,
    formulaIds: Object.freeze(row.formula_ids.split(",").map((formula) => formula.trim())),
    evidenceStatus: row.evidence_status,
    timbreProvenance: "clean-room-procedural" as const,
    timbre: Object.freeze({ ...CLEAN_ROOM_TIMBRES[index]! }),
  })),
);

export function getDrumKitByIndex(index: number): DrumKitProfile | undefined {
  return DRUM_KIT_CATALOG[index - 1];
}

export function getDrumKitByName(name: string): DrumKitProfile | undefined {
  const normalized = name.toUpperCase();
  return DRUM_KIT_CATALOG.find((kit) => kit.officialName === normalized);
}
