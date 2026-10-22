import { describe, expect, it } from "vitest";
import {
  DRUM_KIT_CATALOG,
  RHYTHM_PATTERN_CATALOG,
  RHYTHM_VARIATIONS,
  DrumVoicePool,
  createCleanRoomPatternEvents,
  createRhythmRuntimeEventTemplate,
  getDrumKitByIndex,
} from "../../src/audio/rhythm";

describe("rhythm clean-room catalog and renderer", () => {
  it("preserves all 240 source metadata rows, spelling, duplicates, A-D, and section references", () => {
    expect(RHYTHM_PATTERN_CATALOG).toHaveLength(240);
    expect(RHYTHM_PATTERN_CATALOG.map((row) => row.globalIndex)).toEqual(Array.from({ length: 240 }, (_, index) => index + 1));
    expect(RHYTHM_VARIATIONS).toEqual(["A", "B", "C", "D"]);
    expect(RHYTHM_PATTERN_CATALOG.every((row) => row.variations.join("") === "ABCD")).toBe(true);
    expect(RHYTHM_PATTERN_CATALOG.every((row) => row.sectionReferences.intro === "clean-room:intro"
      && row.sectionReferences.ending === "clean-room:ending"
      && row.sectionReferences.fill === "clean-room:fill")).toBe(true);

    // Source anomalies are intentionally retained; duplicate rows are not deduplicated.
    expect(RHYTHM_PATTERN_CATALOG.some((row) => row.genre === "BALLAM")).toBe(true);
    expect(RHYTHM_PATTERN_CATALOG.some((row) => row.genre === "ELCTRO")).toBe(true);
    const punk8beat6 = RHYTHM_PATTERN_CATALOG.filter((row) => row.genre === "PUNK" && row.pattern === "8BEAT6");
    expect(punk8beat6).toHaveLength(2);
    expect(new Set(punk8beat6.map((row) => row.id)).size).toBe(2);
  });

  it("labels the metadata and generated events as non-factory-MIDI clean-room content", () => {
    expect(RHYTHM_PATTERN_CATALOG.every((row) => row.factoryMidiIncluded === false
      && row.catalogProvenance === "metadata-transcription")).toBe(true);
    const events = createCleanRoomPatternEvents(1, { sampleRate: 48_000, bpm: 120, bars: 1 });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.provenance === "clean-room-generated")).toBe(true);
    expect(events.every((event) => event.patternId === "rhythm-001")).toBe(true);
    expect(events.every((event) => event.velocity >= 1 && event.velocity <= 127)).toBe(true);
  });

  it("uses METAL's electronic clean-room rhythm rules and normalizes GUIDE 210", () => {
    const metal = createRhythmRuntimeEventTemplate(155, {
      sampleRate: 8000, bpm: 300, bars: 1, variation: "A", section: "main",
    });
    expect(metal.some((event) => event.instrument === "ride" && event.step === 0)).toBe(true);

    const guide = createRhythmRuntimeEventTemplate(210, {
      sampleRate: 48_000, bpm: 120, bars: 1, variation: "D", section: "fill",
    });
    expect(guide.map((event) => event.step)).toEqual([0, 4, 8, 12]);
    expect(guide.map((event) => event.instrument)).toEqual(["kick", "snare", "snare", "snare"]);
    expect(guide.every((event) => event.variation === "A" && event.section === "main")).toBe(true);
  });

  it("provides 16 differentiated named kit profiles with clean-room timbre controls", () => {
    expect(DRUM_KIT_CATALOG).toHaveLength(16);
    expect(DRUM_KIT_CATALOG.map((kit) => kit.officialName)).toEqual([
      "STUDIO", "LIVE", "LIGHT", "HEAVY", "ROCK", "METAL", "JAZZ", "BRUSH",
      "CAJON", "DRUM&BASS", "R&B", "DANCE", "TECHNO", "DANCE BEATS", "HIPHOP", "808+909",
    ]);
    expect(DRUM_KIT_CATALOG.every((kit) => kit.timbreProvenance === "clean-room-procedural")).toBe(true);
    expect(new Set(DRUM_KIT_CATALOG.map((kit) => JSON.stringify(kit.timbre))).size).toBe(16);
    expect(getDrumKitByIndex(16)?.officialName).toBe("808+909");
  });

  it("uses absolute-frame calculations across odd meters and long loops without accumulated drift", () => {
    const pattern = RHYTHM_PATTERN_CATALOG.find((row) => row.beat === "7/8")!;
    const sampleRate = 44_100;
    const bpm = 137;
    const startFrame = 123_456;
    const bars = 333;
    const options = { sampleRate, bpm, startFrame, bars, variation: "B" as const, section: "fill" as const };
    const first = createCleanRoomPatternEvents(pattern, options);
    const second = createCleanRoomPatternEvents(pattern.id, options);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(333);

    const stepsPerBar = pattern.meter.numerator * (16 / pattern.meter.denominator);
    for (const event of first) {
      const absoluteStep = event.bar * stepsPerBar + event.step;
      const expected = startFrame + Math.round((absoluteStep * sampleRate * 15) / bpm);
      expect(event.frame).toBe(expected);
    }
    expect(Math.max(...first.map((event) => event.frame))).toBeGreaterThan(startFrame + 20_000_000);
  });

  it("keeps procedural output invariant when the absolute timeline is rendered in different block sizes", () => {
    const pattern = RHYTHM_PATTERN_CATALOG.find((row) => row.beat === "5/4")!;
    const sampleRate = 16_000;
    const events = createCleanRoomPatternEvents(pattern, { sampleRate, bpm: 120, bars: 1, variation: "D" });
    const whole = new DrumVoicePool({ sampleRate, kit: "808+909", maxVoices: 12 });
    whole.scheduleMany(events);
    const wholeOutput = whole.renderBlock(0, sampleRate * 5 / 2);

    const chunked = new DrumVoicePool({ sampleRate, kit: "808+909", maxVoices: 12 });
    chunked.scheduleMany(events);
    const chunkOutputs: Float32Array[] = [];
    let frame = 0;
    const chunkSizes = [127, 1024, 4093, 512, 8096];
    let chunkIndex = 0;
    while (frame < wholeOutput.length) {
      const size = Math.min(chunkSizes[chunkIndex % chunkSizes.length]!, wholeOutput.length - frame);
      chunkOutputs.push(chunked.renderBlock(frame, size));
      frame += size;
      chunkIndex += 1;
    }
    const joined = new Float32Array(wholeOutput.length);
    let cursor = 0;
    for (const output of chunkOutputs) {
      joined.set(output, cursor);
      cursor += output.length;
    }
    expect(joined).toEqual(wholeOutput);
  });

  it("enforces the fixed voice cap with deterministic oldest-voice stealing and round-robin cycling", () => {
    const sampleRate = 48_000;
    const base = createCleanRoomPatternEvents(1, { sampleRate, bpm: 120, bars: 1 }).find((event) => event.instrument === "kick")!;
    const simultaneous = Array.from({ length: 10 }, (_, index) => ({ ...base, frame: 0, seed: base.seed + index }));
    const first = new DrumVoicePool({ sampleRate, kit: "STUDIO", maxVoices: 4 });
    first.scheduleMany(simultaneous);
    const firstOutput = first.renderBlock(0, 128);
    expect(first.startedVoiceCount).toBe(10);
    expect(first.stolenVoiceCount).toBe(6);
    expect(first.peakVoiceCount).toBe(4);
    expect(first.activeVoiceCount).toBeLessThanOrEqual(4);
    expect(first.peekRoundRobin("kick")).toBe(10 % DRUM_KIT_CATALOG[0]!.timbre.roundRobinCount);

    const second = new DrumVoicePool({ sampleRate, kit: "STUDIO", maxVoices: 4 });
    second.scheduleMany(simultaneous);
    expect(second.renderBlock(0, 128)).toEqual(firstOutput);
    expect(second.stolenVoiceCount).toBe(first.stolenVoiceCount);
    expect(second.peakVoiceCount).toBe(first.peakVoiceCount);

    const solo = new DrumVoicePool({ sampleRate, kit: "STUDIO", maxVoices: 1 });
    solo.schedule(base);
    const kickFrames = Math.round((sampleRate * getDrumKitByIndex(1)!.timbre.kickDecayMs) / 1000);
    solo.renderBlock(0, kickFrames);
    expect(solo.activeVoiceCount).toBe(0);
  });
});
