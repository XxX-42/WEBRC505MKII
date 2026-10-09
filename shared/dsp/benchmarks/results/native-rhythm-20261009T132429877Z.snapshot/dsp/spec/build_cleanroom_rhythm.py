#!/usr/bin/env python3
"""Build deterministic, original one-bar rhythm material from public labels only.

No factory MIDI, rhythm audio, or extracted event sequence is read by this tool.
The source CSV contributes only the displayed genre/name/meter and slot index.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "dsp" / "spec"
PPQ = 960
GENERATOR_ID = "webrc-cleanroom-rhythm-v1"
SOURCE_CSV = SPEC / "source" / "rhythm_patterns_240.csv"
KIT_CSV = SPEC / "source" / "kits_16_algorithm_matrix.csv"
RHYTHM_OUT = SPEC / "cleanroom_rhythm_patterns.json"
KIT_OUT = SPEC / "cleanroom_kit_profiles.json"
RHYTHM_HEADER_OUT = ROOT / "shared" / "dsp" / "include" / "webrc" / "dsp" / "cleanroom_rhythm_data.hpp"
RHYTHM_CPP_OUT = ROOT / "shared" / "dsp" / "src" / "cleanroom_rhythm_data.cpp"
INSTRUMENT_ENUM = {
    "kick": "Kick", "snare": "Snare", "closed_hat": "ClosedHat", "open_hat": "OpenHat",
    "ride": "Ride", "tom_low": "TomLow", "tom_high": "TomHigh", "clap": "Clap",
    "rim": "Rim", "conga_low": "CongaLow", "conga_high": "CongaHigh", "shaker": "Shaker",
    "brush_sweep": "BrushSweep",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Dice:
    """Small deterministic hash stream, independent of Python's random module."""

    def __init__(self, seed: str) -> None:
        self.seed = seed.encode("utf-8")
        self.counter = 0

    def word(self) -> int:
        digest = hashlib.sha256(self.seed + self.counter.to_bytes(8, "little")).digest()
        self.counter += 1
        return int.from_bytes(digest[:8], "little")

    def choose(self, values: list[Any]) -> Any:
        return values[self.word() % len(values)]

    def chance(self, numerator: int, denominator: int) -> bool:
        return self.word() % denominator < numerator


def family(genre: str, label: str) -> str:
    text = f"{genre} {label}".upper()
    if any(term in text for term in ("BRUSH", "SWEEP")):
        return "brush"
    if any(term in text for term in ("BOSSA", "CONGA", "SAMBA", "LATIN", "WORLD", "TRAD")):
        return "latin"
    if any(term in text for term in ("SWING", "JAZZ", "SHUFFLE", "BLUES")):
        return "jazz"
    if any(term in text for term in ("DRUM&BASS", "DNB", "ELCTRO", "TECHNO", "DANCE", "808", "909")):
        return "electronic"
    if genre.upper() in {"BALLAD", "SOFT ROCK", "BALLAM"}:
        return "soft"
    if genre.upper() in {"FUNK", "R&B", "SOUL", "FUSION"}:
        return "groove"
    if genre.upper() in {"METAL", "HEAVY ROCK", "PUNK", "ALT ROCK", "ROCK"}:
        return "rock"
    return "acoustic"


def canonical_events(events: dict[tuple[int, str], tuple[int, bool]]) -> list[dict[str, Any]]:
    return [
        {"tick": tick, "instrument": instrument, "velocity": velocity, "swingable": swingable,
         "durationTicks": 480 if instrument == "brush_sweep" else 0}
        for (tick, instrument), (velocity, swingable) in sorted(
            events.items(), key=lambda item: (item[0][0], item[0][1])
        )
    ]


def make_pattern(row: dict[str, str]) -> dict[str, Any]:
    index = int(row["global_index"])
    genre = row["genre"].strip()
    label = row["pattern"].strip()
    meter_text = row["beat"].strip()
    numerator_text, denominator_text = meter_text.split("/", 1)
    numerator, denominator = int(numerator_text), int(denominator_text)
    pulse_ticks = 4 * PPQ // denominator
    bar_ticks = numerator * pulse_ticks
    sixteenth_ticks = PPQ // 4
    rng = Dice(f"{GENERATOR_ID}|{index}|{genre}|{label}|{meter_text}")
    style = family(genre, label)
    compound = denominator == 8 and numerator % 3 == 0 and numerator >= 6
    group_size = 3 if compound else 1
    group_starts = list(range(0, numerator, group_size))
    base: dict[tuple[int, str], tuple[int, bool]] = {}

    def put(target: dict[tuple[int, str], tuple[int, bool]], pulse: int, instrument: str,
            velocity: int, *, offset: int = 0, swingable: bool | None = None) -> None:
        tick = (pulse * pulse_ticks + offset) % bar_ticks
        tick = max(0, min(bar_ticks - 1, tick))
        if swingable is None:
            swingable = (tick % PPQ == PPQ // 2) and tick != 0
        key = (tick, instrument)
        old = target.get(key)
        if old is None or velocity > old[0]:
            target[key] = (max(1, min(127, velocity)), bool(swingable))

    # Bass drum roots follow style and meter. Four-on-the-floor is restricted
    # to dance/electronic labels; rock/soft/jazz do not inherit it by default.
    if compound:
        kick_pulses = list(group_starts)
    elif style == "electronic" and "DRUM&BASS" not in label.upper():
        kick_pulses = list(range(numerator)) if numerator >= 4 and rng.chance(2, 3) else [0, numerator // 2]
    elif style in {"jazz", "brush"}:
        kick_pulses = [0]
        if numerator >= 4 and rng.chance(1, 3):
            kick_pulses.append(numerator // 2)
    else:
        kick_pulses = [0]
        if numerator >= 4:
            kick_pulses.append(numerator // 2)
        elif numerator == 3 and style in {"latin", "groove"}:
            kick_pulses.append(2)
    for pulse in sorted(set(kick_pulses)):
        put(base, pulse, "kick", rng.choose([94, 100, 106, 112, 118]))
    if numerator >= 4 and rng.chance(3, 5):
        pulse = rng.choose([p for p in range(numerator) if p not in kick_pulses] or [0])
        put(base, pulse, "kick", rng.choose([62, 69, 76]), offset=pulse_ticks // 2)

    # Backbeat positions adapt to compound and odd meters instead of truncating 4/4 rules.
    if compound:
        backbeats = group_starts[1:] or [numerator - 1]
    elif numerator == 3:
        backbeats = [2]
    elif numerator == 2:
        backbeats = [1]
    elif numerator >= 4:
        backbeats = [1, numerator - 1] if numerator % 2 == 0 else [numerator // 2, numerator - 1]
    else:
        backbeats = [numerator - 1]
    for pulse in sorted(set(backbeats)):
        instrument = "rim" if style == "brush" else ("clap" if style == "electronic" and rng.chance(1, 3) else "snare")
        velocity = rng.choose([76, 82, 88, 94]) if style in {"soft", "brush", "jazz"} else rng.choose([88, 96, 104, 112])
        put(base, pulse, instrument, velocity)
        if style == "jazz" and rng.chance(2, 3):
            put(base, pulse, "snare", rng.choose([24, 30, 36]), offset=pulse_ticks // 2)

    # Timekeeping lane density is a style decision and remains deterministic.
    step_ticks = PPQ // 2 if style in {"rock", "electronic", "groove", "jazz", "brush"} else PPQ
    if denominator == 8:
        step_ticks = pulse_ticks if style not in {"electronic", "groove"} else pulse_ticks // 2
    timekeeper = "ride" if style == "jazz" and rng.chance(3, 4) else (
        "shaker" if style == "latin" else "closed_hat"
    )
    for tick in range(0, bar_ticks, step_ticks):
        velocity = rng.choose([42, 48, 54, 60, 66])
        if tick % pulse_ticks == 0:
            velocity += 8
        if timekeeper == "ride":
            velocity += 5
        put(base, tick // pulse_ticks, timekeeper, velocity, offset=tick % pulse_ticks,
            swingable=(tick % PPQ == PPQ // 2) and tick != 0)
    if style == "brush":
        # Original procedural sweep gestures: short overlapping noise bands,
        # not copied brush audio or a factory MIDI event sequence.
        for pulse in range(0, numerator, 2):
            put(base, pulse, "brush_sweep", rng.choose([26, 31, 36]), offset=pulse_ticks // 2)
    if style == "latin":
        for pulse in range(1, numerator, 2):
            put(base, pulse, "conga_low" if pulse % 4 else "conga_high", rng.choose([58, 66, 74]))
    if style == "electronic" and rng.chance(1, 2):
        for pulse in range(0, numerator, 2):
            put(base, pulse, "closed_hat", rng.choose([30, 38, 46]), offset=pulse_ticks // 2)

    variations: dict[str, list[dict[str, Any]]] = {}
    variation_names = ["A", "B", "C", "D"]
    prior_variation_signatures: set[str] = set()
    instrument_choices = [
        "kick", "snare", "closed_hat", "open_hat", "ride", "tom_low", "tom_high",
        "clap", "rim", "conga_low", "conga_high", "shaker",
    ]
    for variation_index, name in enumerate(variation_names):
        events = dict(base)
        # Each variation has an independent, explicit phrase edit, then style-aware fills.
        offset = ((index * 7 + variation_index * 3 + 1) % numerator) * pulse_ticks
        if variation_index == 1:
            put(events, offset // pulse_ticks, "kick", rng.choose([64, 70, 78]), offset=pulse_ticks // 2)
            if style != "jazz":
                put(events, (offset // pulse_ticks + 1) % numerator, "open_hat", rng.choose([48, 56, 64]))
        elif variation_index == 2:
            put(events, offset // pulse_ticks, "tom_high", rng.choose([58, 68, 78]))
            put(events, (offset // pulse_ticks + numerator // 2) % numerator, "snare", rng.choose([34, 42, 50]), offset=pulse_ticks // 2)
        elif variation_index == 3:
            put(events, offset // pulse_ticks, "open_hat", rng.choose([62, 72, 82]))
            put(events, (offset // pulse_ticks + 2) % numerator, "kick", rng.choose([66, 74, 82]), offset=pulse_ticks // 2)
            if style in {"latin", "jazz", "brush"}:
                put(events, (offset // pulse_ticks + 1) % numerator, "conga_high" if style == "latin" else "rim", rng.choose([46, 54, 62]))
        signature = json.dumps(canonical_events(events), sort_keys=True, separators=(",", ":"))
        if variation_index > 0 and signature in prior_variation_signatures:
            # A guaranteed, musically quiet one-sixteenth embellishment keeps all
            # four authored choices independently addressable in sparse meters.
            steps = bar_ticks // sixteenth_ticks
            start = (index * 29 + variation_index * 41) % (steps * len(instrument_choices))
            for probe in range(steps * len(instrument_choices)):
                position = (start + probe) % (steps * len(instrument_choices))
                tick = (position // len(instrument_choices)) * sixteenth_ticks
                instrument = instrument_choices[position % len(instrument_choices)]
                if (tick, instrument) not in events:
                    events[(tick, instrument)] = (34 + (index * 13 + variation_index * 17) % 49,
                                                  tick % PPQ == PPQ // 2)
                    break
            signature = json.dumps(canonical_events(events), sort_keys=True, separators=(",", ":"))
        prior_variation_signatures.add(signature)
        variations[name] = canonical_events(events)

    # A one-bar intro, fill, and ending are distinct authored arrangements.
    intro: dict[tuple[int, str], tuple[int, bool]] = {}
    put(intro, 0, "kick", 68)
    for pulse in range(0, numerator, max(1, group_size)):
        put(intro, pulse, "closed_hat", 32 + ((index + pulse) % 13))
    put(intro, numerator - 1, "snare", 42, offset=pulse_ticks // 2)

    fill: dict[tuple[int, str], tuple[int, bool]] = {}
    sixteenths_per_bar = bar_ticks // sixteenth_ticks
    for step in range(max(0, sixteenths_per_bar - 8), sixteenths_per_bar):
        tick = (step * sixteenth_ticks) % bar_ticks
        if style == "brush":
            instrument = "brush_sweep" if step % 2 == 0 else "rim"
        else:
            instrument = "snare" if step % 4 in (0, 2) else ("tom_high" if step % 4 == 1 else "tom_low")
        fill[(tick, instrument)] = (rng.choose([62, 70, 78, 86, 94, 102]), tick % PPQ == PPQ // 2)
    put(fill, numerator - 1, "kick", 82)

    ending: dict[tuple[int, str], tuple[int, bool]] = {}
    put(ending, 0, "kick", 108)
    put(ending, max(0, numerator - 1), "snare", 104)
    put(ending, max(0, numerator - 1), "ride", 92, offset=max(0, pulse_ticks // 2))
    for pulse in range(1, numerator):
        if pulse % max(1, group_size) == 0:
            put(ending, pulse, "kick", 64)

    swing = 0.0
    if style in {"jazz", "brush", "groove"} and denominator == 4:
        swing = rng.choose([0.22, 0.28, 0.34, 0.40])
    elif style == "jazz" and denominator == 8:
        swing = rng.choose([0.12, 0.18, 0.24])

    return {
        "id": f"CR-RHY-{index:03d}",
        "sourceSlot": index,
        "sourceGenreLabel": genre,
        "sourcePatternLabel": label,
        "classification": "preset" if index <= 206 else ("guide" if index <= 239 else "user_slot_metadata"),
        "meter": {"numerator": numerator, "denominator": denominator},
        "ticksPerQuarter": PPQ,
        "barTicks": bar_ticks,
        "barsPerSection": 1,
        "styleFamily": style,
        "swing": {"amount": swing, "subdivision": "eighth_note", "appliesOnlyToMarkedOffbeats": True},
        "variations": variations,
        "intro": canonical_events(intro),
        "fill": canonical_events(fill),
        "ending": canonical_events(ending),
        "provenance": {
            "kind": "clean_room_rules",
            "generator": GENERATOR_ID,
            "factoryMidiImported": False,
            "factoryAudioImported": False,
            "sourceUse": "slot index and printed genre/name/meter labels only; event sequence authored by this rule set",
        },
    }


KIT_VALUES = [
    # kick start/end/sweep/decay; snare body/body decay/noise decay/noise; hat Hz/decay/noise; modal base/decay/tone/noise
    (142, 47, .075, .56, 190, .28, .20, .62, 6100, .16, .42, 82, .62, .40, .02),
    (154, 45, .085, .72, 176, .34, .25, .70, 5600, .23, .46, 74, .85, .46, .03),
    (126, 54, .060, .40, 220, .22, .16, .50, 7200, .12, .36, 96, .44, .35, .01),
    (168, 42, .090, .82, 160, .39, .29, .78, 6600, .25, .48, 66, 1.05, .52, .04),
    (150, 44, .080, .68, 184, .32, .23, .69, 6400, .19, .43, 78, .78, .44, .025),
    (188, 38, .045, .52, 235, .20, .13, .86, 8100, .13, .56, 58, .58, .58, .02),
    (118, 52, .070, .48, 205, .36, .26, .48, 5400, .40, .38, 110, 1.20, .33, .01),
    (112, 56, .095, .42, 248, .42, .33, .38, 4700, .48, .31, 126, 1.35, .26, .015),
    (132, 63, .055, .36, 310, .24, .17, .38, 5700, .20, .34, 148, .72, .30, .02),
    (170, 46, .050, .48, 198, .18, .14, .82, 9200, .11, .52, 64, .54, .58, .01),
    (136, 50, .080, .62, 174, .31, .25, .54, 5900, .22, .40, 70, .76, .36, .02),
    (184, 43, .042, .58, 212, .16, .14, .90, 7600, .15, .50, 60, .62, .57, .03),
    (196, 40, .038, .63, 228, .17, .12, .88, 8800, .12, .54, 54, .56, .61, .02),
    (162, 44, .062, .55, 188, .24, .20, .74, 7000, .18, .44, 72, .74, .48, .025),
    (128, 49, .090, .78, 152, .27, .30, .58, 5200, .26, .37, 68, .92, .31, .045),
    (205, 36, .030, .50, 260, .15, .12, .94, 9400, .10, .58, 48, .48, .65, .015),
]


def build_kits() -> dict[str, Any]:
    with KIT_CSV.open(newline="", encoding="utf-8-sig") as stream:
        rows = list(csv.DictReader(stream))
    profiles = []
    for row, values in zip(rows, KIT_VALUES, strict=True):
        (kick_start, kick_end, kick_sweep, kick_decay, snare_body, snare_body_decay,
         snare_noise_decay, snare_noise, hat_hz, hat_decay, hat_noise, modal_hz,
         modal_decay, modal_tone, modal_noise) = values
        profiles.append({
            "id": f"CR-KIT-{int(row['index']):02d}",
            "index": int(row["index"]),
            "displayName": row["official_kit_name"],
            "designIntentLabel": row["target_timbre"],
            "voiceParameters": {
                "kick": {"startFrequencyHz": kick_start, "endFrequencyHz": kick_end, "sweepSeconds": kick_sweep, "decaySeconds": kick_decay, "amplitude": 0.82},
                "snare": {"bodyFrequencyHz": snare_body, "bodyDecaySeconds": snare_body_decay, "noiseDecaySeconds": snare_noise_decay, "noiseLevel": snare_noise, "amplitude": 0.70, "stereoWidth": 0.0},
                "closedHat": {"baseFrequencyHz": hat_hz, "decaySeconds": hat_decay, "noiseLevel": hat_noise, "amplitude": 0.42, "stereoWidth": 0.0},
                "openHat": {"baseFrequencyHz": int(hat_hz * 0.92), "decaySeconds": min(0.7, hat_decay * 2.8), "noiseLevel": min(0.9, hat_noise * 1.08), "amplitude": 0.50, "stereoWidth": 0.08},
                "modal": {"fundamentalHz": modal_hz, "decaySeconds": modal_decay, "tone": modal_tone, "noise": modal_noise, "amplitude": 0.58, "stereoWidth": 0.0},
                "brushSweep": {
                    "amplitude": 0.34 if row["official_kit_name"] == "BRUSH" else 0.13 + (int(row["index"]) % 4) * 0.015,
                    "durationSeconds": 0.42 if row["official_kit_name"] == "BRUSH" else 0.14 + (int(row["index"]) % 3) * 0.025,
                    "highpassHz": 2400 if row["official_kit_name"] == "BRUSH" else 4200 + (int(row["index"]) % 5) * 300,
                },
            },
            "factorySamplesPresent": False,
            "factoryMidiPresent": False,
            "nativeReferencePlaybackImplemented": True,
            "browserPlaybackImplemented": False,
            "audioQualityGatePassed": False,
            "provenance": {
                "kind": "clean_room_procedural_profile",
                "sourceUse": "official kit name and design-intent label only; numeric voice parameters authored as original procedural settings",
                "voiceEngine": "webrc::dsp::DrumVoicePool",
            },
        })
    return {
        "schemaVersion": "1.0.0",
        "generator": GENERATOR_ID,
        "generatorSha256": sha256(Path(__file__)),
        "sourceCsv": KIT_CSV.relative_to(ROOT).as_posix(),
        "sourceCsvSha256": sha256(KIT_CSV),
        "count": len(profiles),
        "implementationStatus": "native_procedural_reference_implemented_browser_integration_pending",
        "factoryAudioImported": False,
        "factoryMidiImported": False,
        "profiles": profiles,
    }


def main_fingerprints(pattern: dict[str, Any]) -> dict[str, str]:
    events = pattern["variations"]["A"]
    meter = pattern["meter"]
    sequence = {
        "meter": meter,
        "events": [[event["tick"], event["instrument"]] for event in events],
    }
    velocity = {
        "meter": meter,
        "events": [[event["tick"], event["instrument"], event["velocity"]] for event in events],
    }
    timing = {
        "meter": meter,
        "swing": pattern["swing"]["amount"],
        "events": [[event["tick"], event["swingable"]] for event in events],
    }
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "rawSequenceSha256": hashlib.sha256(canonical(sequence)).hexdigest(),
        "velocitySha256": hashlib.sha256(canonical(velocity)).hexdigest(),
        "timingSha256": hashlib.sha256(canonical(timing)).hexdigest(),
    }


def generate_cpp_table(patterns: list[dict[str, Any]], kits: list[dict[str, Any]],
                       json_sha256: str, kit_sha256: str) -> None:
    def cfloat(value: int | float) -> str:
        text = f"{float(value):.9g}"
        if not any(character in text for character in ".eE"):
            text += ".0"
        return text + "f"

    event_records: list[dict[str, Any]] = []
    pattern_ranges: list[dict[str, Any]] = []
    for pattern in patterns:
        ranges: dict[str, tuple[int, int]] = {}
        for variation in "ABCD":
            start = len(event_records)
            event_records.extend(pattern["variations"][variation])
            ranges[f"variation{variation}"] = (start, len(pattern["variations"][variation]))
        for section in ("intro", "fill", "ending"):
            start = len(event_records)
            event_records.extend(pattern[section])
            ranges[section] = (start, len(pattern[section]))
        pattern_ranges.append({"pattern": pattern, "ranges": ranges})

    header = '''#pragma once

#include "webrc/dsp/rhythm.hpp"

namespace webrc::dsp {

[[nodiscard]] std::uint32_t cleanRoomRhythmPatternCount() noexcept;
[[nodiscard]] const RhythmPatternView* cleanRoomRhythmPattern(std::uint32_t index) noexcept;
[[nodiscard]] const char* cleanRoomRhythmPatternsSha256() noexcept;
[[nodiscard]] const char* cleanRoomKitProfilesSha256() noexcept;

} // namespace webrc::dsp
'''
    lines = [
        '#include "webrc/dsp/cleanroom_rhythm_data.hpp"',
        "",
        f"// Generated from cleanroom_rhythm_patterns.json SHA256 {json_sha256}; do not edit by hand.",
        f"// Generated from cleanroom_kit_profiles.json SHA256 {kit_sha256}.",
        "namespace webrc::dsp {",
        "namespace {",
        "constexpr RhythmEvent kCleanRoomEvents[] = {",
    ]
    for event in event_records:
        enum_name = INSTRUMENT_ENUM[event["instrument"]]
        lines.append(
            f"    {{{event['tick']}U, RhythmInstrument::{enum_name}, {event['velocity']}U, "
            f"{'true' if event['swingable'] else 'false'}, {event['durationTicks']}U}},"
        )
    lines.extend(["};", "constexpr RhythmPatternView kCleanRoomPatterns[] = {"])
    for record in pattern_ranges:
        pattern = record["pattern"]
        ranges = record["ranges"]
        n, d = pattern["meter"]["numerator"], pattern["meter"]["denominator"]
        swing = cfloat(pattern["swing"]["amount"])
        variation_views = []
        for variation in "ABCD":
            offset, count = ranges[f"variation{variation}"]
            variation_views.append(f"{{kCleanRoomEvents + {offset}U, {count}U}}")
        other_views = []
        for section in ("intro", "fill", "ending"):
            offset, count = ranges[section]
            other_views.append(f"{{kCleanRoomEvents + {offset}U, {count}U}}")
        lines.extend([
            "    {",
            f"        {n}U, {d}U, {swing},",
            f"        {{{{{', '.join(variation_views)}}}}},",
            f"        {other_views[0]}, {other_views[1]}, {other_views[2]}",
            "    },",
        ])

    def fields(section: dict[str, Any], names: tuple[str, ...]) -> str:
        return ", ".join(cfloat(section[name]) for name in names)

    lines.extend(["};", "constexpr CleanRoomKitProfile kCleanRoomKits[] = {"])
    for kit in kits:
        voice = kit["voiceParameters"]
        lines.extend([
            "    {",
            f'        "{kit["displayName"]}",',
            "        {" + fields(voice["kick"], (
                "startFrequencyHz", "endFrequencyHz", "sweepSeconds", "decaySeconds", "amplitude")) + "},",
            "        {" + fields(voice["snare"], (
                "bodyFrequencyHz", "bodyDecaySeconds", "noiseDecaySeconds", "noiseLevel", "amplitude", "stereoWidth")) + ", 1ULL},",
            "        {" + fields(voice["closedHat"], (
                "baseFrequencyHz", "decaySeconds", "noiseLevel", "amplitude", "stereoWidth")) + ", 1ULL},",
            "        {" + fields(voice["openHat"], (
                "baseFrequencyHz", "decaySeconds", "noiseLevel", "amplitude", "stereoWidth")) + ", 1ULL},",
            "        {" + fields(voice["modal"], (
                "fundamentalHz", "decaySeconds", "tone", "noise", "amplitude", "stereoWidth")) + ", 1ULL},",
            "        " + fields(voice["brushSweep"], ("amplitude", "durationSeconds", "highpassHz")),
            "    },",
        ])
    lines.extend([
        "};",
        "} // namespace",
        "",
        "std::uint32_t cleanRoomRhythmPatternCount() noexcept {",
        "    return static_cast<std::uint32_t>(sizeof(kCleanRoomPatterns) / sizeof(kCleanRoomPatterns[0]));",
        "}",
        "",
        "const RhythmPatternView* cleanRoomRhythmPattern(std::uint32_t index) noexcept {",
        "    return index < cleanRoomRhythmPatternCount() ? &kCleanRoomPatterns[index] : nullptr;",
        "}",
        "",
        "const char* cleanRoomRhythmPatternsSha256() noexcept {",
        f'    return "{json_sha256}";',
        "}",
        "",
        "std::uint32_t cleanRoomKitCount() noexcept {",
        "    return static_cast<std::uint32_t>(sizeof(kCleanRoomKits) / sizeof(kCleanRoomKits[0]));",
        "}",
        "",
        "const CleanRoomKitProfile* cleanRoomKitProfile(std::uint32_t index) noexcept {",
        "    return index < cleanRoomKitCount() ? &kCleanRoomKits[index] : nullptr;",
        "}",
        "",
        "const char* cleanRoomKitProfilesSha256() noexcept {",
        f'    return "{kit_sha256}";',
        "}",
        "",
        "} // namespace webrc::dsp",
        "",
    ])
    RHYTHM_HEADER_OUT.write_text(header, encoding="utf-8", newline="\n")
    RHYTHM_CPP_OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def main() -> None:
    with SOURCE_CSV.open(newline="", encoding="utf-8-sig") as stream:
        rows = list(csv.DictReader(stream))
    patterns = []
    seen_main = {"rawSequence": set(), "velocity": set(), "timing": set()}
    for row in rows:
        pattern = make_pattern(row)
        pattern["mainFingerprints"] = main_fingerprints(pattern)
        for name, field in (("rawSequence", "rawSequenceSha256"),
                            ("velocity", "velocitySha256"), ("timing", "timingSha256")):
            seen_main[name].add(pattern["mainFingerprints"][field])
        patterns.append(pattern)
    document = {
        "schemaVersion": "1.0.0",
        "generator": GENERATOR_ID,
        "generatorSha256": sha256(Path(__file__)),
        "sourceCsv": SOURCE_CSV.relative_to(ROOT).as_posix(),
        "sourceCsvSha256": sha256(SOURCE_CSV),
        "count": len(patterns),
        "mainFingerprintUniqueCounts": {
            name: len(values) for name, values in seen_main.items()
        },
        "ticksPerQuarter": PPQ,
        "implementationStatus": "native_reference_renderer_implemented_browser_integration_pending",
        "audioAssetsPresent": False,
        "factoryMidiImported": False,
        "factoryAudioImported": False,
        "patterns": patterns,
    }
    RHYTHM_OUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    kit_document = build_kits()
    KIT_OUT.write_text(json.dumps(kit_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    generate_cpp_table(patterns, kit_document["profiles"], sha256(RHYTHM_OUT), sha256(KIT_OUT))
    print(f"wrote {RHYTHM_OUT.relative_to(ROOT)} ({len(patterns)} patterns)")
    print(f"wrote {KIT_OUT.relative_to(ROOT)} (16 profiles)")
    print(f"wrote {RHYTHM_CPP_OUT.relative_to(ROOT)} (generated C++ event table)")


if __name__ == "__main__":
    main()
