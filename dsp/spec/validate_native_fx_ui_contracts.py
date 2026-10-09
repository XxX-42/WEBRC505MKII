#!/usr/bin/env python3
"""Validate all 53 source-fact families without granting runtime qualification."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
CONTRACT_PATH = HERE / "official_fx_ui_contracts.json"
CANDIDATE_PATH = HERE / "official_fx_parameters_candidate_visual_glyphs.json"
EXPECTED_PDF_SHA = "6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b"
REVIEWED_AT = "2026-10-10"
EXPECTED_EFFECT_COUNT = 53
EXPECTED_SECTION_COUNT = 55
EXPECTED_PARAMETER_COUNT = 267


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate() -> dict[str, Any]:
    data = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    candidate = json.loads(CANDIDATE_PATH.read_text(encoding="utf-8"))
    require(data["schemaVersion"] == "webrc-official-fx-ui-contracts-v1", "Wrong UI contract schema")
    require(data["normativeForPublishedUiFacts"] is True and data["dspImplementationContract"] is False and
            data["runtimeConsumptionAllowed"] is False,
            "Published UI facts must stay separate from DSP ranges and runtime consumption")
    require(data["source"]["pdfSha256"] == EXPECTED_PDF_SHA, "PDF source fingerprint mismatch")
    require(data["source"]["candidateSha256"] == sha256(CANDIDATE_PATH), "Candidate fingerprint mismatch")
    require(data["review"]["status"] == "root_visual_review_cited" and
            data["review"]["reviewerRole"] == "root" and data["review"]["reviewedAt"] == REVIEWED_AT,
            "UI fact slice must cite the root's visual review")

    source_effects = {effect["id"]: effect for effect in candidate["effects"]}
    effects = data["effects"]
    require(len(effects) == EXPECTED_EFFECT_COUNT and
            [effect["id"] for effect in effects] == list(source_effects),
            "All 53 contract families must retain stable catalog order and IDs")
    require(sum(len(effect["sections"]) for effect in effects) == EXPECTED_SECTION_COUNT,
            "The 55 printed sections, including Tape Echo/Roll variants, must be retained")
    row_count = 0
    for effect in effects:
        source_effect = source_effects[effect["id"]]
        source_parameters = {
            (parameter["id"], section.get("variant")): (section, parameter)
            for section in source_effect["sections"] for parameter in section["parameters"]
        }
        require(effect["officialDisplayName"] == source_effect["officialDisplayName"], "FX display name mismatch")
        require(effect["availability"] == source_effect["availability"], "Input/track route metadata mismatch")
        require(len(effect["parameters"]) == sum(len(section["parameters"]) for section in source_effect["sections"]),
                "Parameter row count mismatch")
        expected_placement = ({"trackFxMode": "MULTI", "slot": "A", "printedPage": 43}
                              if not effect["availability"]["inputFx"] else None)
        require(effect["publishedPlacementConstraint"] == expected_placement,
                "The published Track-only MULTI/slot-A limitation was lost")
        ids = [parameter["id"] for parameter in effect["parameters"]]
        require(len(ids) == len(set(ids)), "Duplicate parameter IDs within an FX")
        for parameter in effect["parameters"]:
            source_section, source_parameter = source_parameters[(parameter["sourceParameterId"], parameter["sectionVariant"])]
            row_count += 1
            expected_id = source_parameter["id"] + (f".variant-{source_section['variant']}"
                                                    if source_section.get("variant") else "")
            require(parameter["id"] == expected_id and
                    parameter["sectionHeading"] == source_section["headingLabel"],
                    "Section identity or variant-qualified parameter ID changed")
            require(parameter["displayName"] == source_parameter["displayName"] and
                    parameter["printedPage"] == source_section["printedPage"], "Source row identity mismatch")
            require(parameter["rawValueText"] == source_parameter["rawValueText"] and
                    parameter["rawValueTextExtractorOutput"] == source_parameter["rawValueTextExtractorOutput"],
                    "Raw value-cell text must remain byte-for-byte equivalent to the reviewed candidate")
            require(parameter["default"]["raw"] == source_parameter["defaultRaw"] and
                    parameter["default"]["numericCanonical"] == source_parameter["defaultNumeric"] and
                    parameter["default"]["evidence"] == source_parameter["defaultEvidence"] and
                    parameter["default"]["reviewEvidence"] == source_parameter["defaultReviewEvidence"],
                    "Default value/evidence mismatch")
            require(parameter["controlAssignableMarkerObserved"] == source_parameter["controlAssignableMarkerObserved"] and
                    parameter["controlAssignableStatus"] == source_parameter["controlAssignableStatus"] and
                    parameter["fxSequenceTargetMarkerObserved"] == source_parameter["fxSequenceTargetMarkerObserved"] and
                    parameter["initialValueMarkerObserved"] == source_parameter["initialValueMarkerObserved"],
                    "Knob assignability and star/initial-value markers must stay separate")
            require(parameter["sourceEvidence"] == source_parameter["sourceEvidence"],
                    "Source value/parameter cell geometry was changed")
            require(parameter["reviewEvidence"]["status"] == "root_visual_reviewed" and
                    parameter["reviewEvidence"]["reviewerRole"] == "root" and
                    parameter["reviewEvidence"]["printedPage"] == source_section["printedPage"],
                    "Field-level page review evidence missing")
            require(parameter["localDspControlMapping"]["status"] == "not_derived_from_published_values",
                    "Manual value domains must not masquerade as local DSP mappings")

            domain = parameter["valueDomain"]
            if source_parameter.get("enumChoices") and not any("–" in choice for choice in source_parameter["enumChoices"]):
                require(domain["kind"] == "explicit_enum" and
                        domain["choices"] == source_parameter["enumChoices"],
                        "An enumerated UI choice list differs from explicit printed source values")
                default = parameter["default"]["raw"]
                require(default is None or default in domain["choices"], "Enum default is not a printed choice")
            if source_parameter.get("minimum") is not None and source_parameter.get("maximum") is not None:
                # The candidate stores normalized source ranges in a few different
                # places: top-level numeric domains, compound printed ranges, and
                # explicit canonical-unit conversions (e.g. REVERB TIME s -> ms).
                # Compare only against published range facts, never against DSP
                # control mappings or range landmarks/defaults.
                ranges = list(iter_range_facts(domain))
                source_range = (source_parameter["minimum"], source_parameter["maximum"])
                require(any((item.get("minimum"), item.get("maximum")) == source_range
                            for item in ranges),
                        f"Numeric UI range differs from candidate: {effect['officialDisplayName']}.{parameter['displayName']}")
            if parameter["displayName"] in {"RATE", "STEP RATE"} and effect["officialDisplayName"] in {
                "LPF", "BPF", "HPF", "PHASER"
            }:
                codes = [glyph["codePoint"] for component in domain["components"]
                         if component["kind"] == "printed_musical_glyph_run" for glyph in component["glyphs"]]
                source_codes = [item["codePoint"] for item in source_parameter["visualGlyphInterpretations"]]
                require(codes == source_codes and domain["fullyExpanded"] is False,
                        "Musical glyphs or unexpanded value choices changed")

    require(row_count == EXPECTED_PARAMETER_COUNT,
            f"Expected 267 reviewed parameter rows, got {row_count}")
    require(sum(bool(effect["availability"]["inputFx"]) for effect in effects) == 49 and
            sum(bool(effect["availability"]["trackFx"]) for effect in effects) == 53,
            "Contract family route counts changed")
    for name in ("TAPE ECHO", "ROLL"):
        variants = next(effect for effect in effects if effect["officialDisplayName"] == name)
        require([section["variant"] for section in variants["sections"]] == ["1", "2"],
                "Distinct printed algorithm variants must not collapse into one parameter map")

    by_effect = {effect["officialDisplayName"]: {parameter["displayName"]: parameter
                                                  for parameter in effect["parameters"]}
                 for effect in effects}
    def field(effect: str, name: str) -> dict[str, Any]:
        return by_effect[effect][name]

    require(field("OCTAVE", "OCTAVE")["valueDomain"]["choices"] ==
            ["-1OCT", "-2OCT", "-1OCT&-2OCT"],
            "Octave must retain both lower-octave choices and the dual-voice choice")
    for effect_name in ("DELAY", "REVERSE DELAY", "MOD DELAY"):
        feedback = field(effect_name, "FEEDBACK")
        require((feedback["valueDomain"]["minimum"], feedback["valueDomain"]["maximum"],
                 feedback["default"]["numericCanonical"]) == (1, 16, 16),
                "Published finite-repeat UI values must not become a feedback-gain range")
    for effect_name in ("DYNAMICS", "DIST"):
        require(field(effect_name, "TYPE")["default"]["raw"] is None and
                field(effect_name, "TYPE")["default"]["evidence"] == "unknown",
                "An unmarked TYPE default must stay unknown")
    roll_repeat = field("ROLL", "REPEAT")["valueDomain"]["components"]
    require(roll_repeat[0]["minimum"] == 1 and roll_repeat[0]["maximum"] == 100 and
            roll_repeat[1] == {"kind": "explicit_choice", "value": "INF"},
            "Roll2's finite repeats and INF choice must remain distinct")

    for effect_name in ("LPF", "BPF", "HPF"):
        for name in ("DEPTH", "RESONANCE", "CUTOFF"):
            row = field(effect_name, name)
            require((row["valueDomain"]["minimum"], row["valueDomain"]["maximum"],
                     row["default"]["numericCanonical"]) == (0.0, 100.0, 50.0),
                    f"{effect_name}.{name} UI range/default must remain 0-50-100")
    require(field("PHASER", "STAGE")["valueDomain"]["choices"] == ["4", "8", "12", "BI-PHASE"] and
            field("PHASER", "STAGE")["default"]["raw"] == "8", "Phaser stage choices/default changed")
    require(field("DYNAMICS", "TYPE")["valueDomain"]["choices"] == source_parameters_for(
        source_effects, "rc505mkii.fx.dynamics", "TYPE")["enumChoices"],
        "Dynamics TYPE enum must preserve all 19 source choices")
    require(len(field("DYNAMICS", "TYPE")["valueDomain"]["choices"]) == 19,
            "Dynamics TYPE must include all 19 explicit printed choices")
    require(field("EQ", "LO-MID FREQ")["valueDomain"]["minimum"] == 20 and
            field("EQ", "LO-MID FREQ")["valueDomain"]["maximum"] == 10000 and
            field("EQ", "LO-MID FREQ")["default"]["numericCanonical"] == 800 and
            field("EQ", "HI-MID FREQ")["default"]["numericCanonical"] == 3150,
            "Reviewed mixed Hz/kHz EQ facts must normalize to canonical Hz")
    require(field("EQ", "LO-MID Q")["valueDomain"]["choices"] == ["0.5", "1", "2", "4", "8", "16"] and
            field("EQ", "HI-MID Q")["default"]["raw"] == "1", "EQ Q enum/default changed")
    for effect_name in ("DELAY", "REVERB"):
        for name in ("LOW CUT", "HIGH CUT"):
            domain = field(effect_name, name)["valueDomain"]
            ranges = [component for component in domain["components"] if component["kind"] == "printed_numeric_range"]
            require(any(item["minimum"] == 20 and item["maximum"] == 12500 and item["unit"] == "Hz"
                        for item in ranges), f"{effect_name}.{name} mixed cut domain lost Hz range")
            require(field(effect_name, name)["default"]["raw"] == "FLAT",
                    f"{effect_name}.{name} FLAT default changed")
    reverb_time = field("REVERB", "TIME")
    require(reverb_time["valueDomain"]["minimum"] == 0.1 and
            reverb_time["valueDomain"]["maximum"] == 10 and
            reverb_time["valueDomain"]["unit"] == "s" and
            reverb_time["valueDomain"]["canonicalUnitValue"] == {
                "minimum": 100, "maximum": 10000, "default": 3000, "unit": "ms"},
            "Reverb time source and canonical units disagree")
    require(field("DELAY", "TIME")["valueDomain"]["fullyExpanded"] is False and
            field("DELAY", "TIME")["default"]["numericCanonical"] == 200,
            "Delay musical/numeric time domain must stay unexpanded with the bold 200ms default")
    return {"effectCount": len(effects), "parameterCount": row_count,
            "inputEffectCount": sum(bool(effect["availability"]["inputFx"]) for effect in effects),
            "trackEffectCount": sum(bool(effect["availability"]["trackFx"]) for effect in effects)}


def iter_range_facts(value: Any):
    """Yield dictionaries that encode an explicit min/max source range."""
    if isinstance(value, dict):
        if "minimum" in value and "maximum" in value:
            yield value
        for child in value.values():
            yield from iter_range_facts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_range_facts(child)


def source_parameters_for(effects: dict[str, Any], effect_id: str, parameter_name: str) -> dict[str, Any]:
    for section in effects[effect_id]["sections"]:
        for parameter in section["parameters"]:
            if parameter["displayName"] == parameter_name:
                return parameter
    raise KeyError((effect_id, parameter_name))


if __name__ == "__main__":
    result = validate()
    print(f"PASS: {result['effectCount']} reviewed source-fact FX families, {result['parameterCount']} source rows, "
          f"input={result['inputEffectCount']}, track={result['trackEffectCount']}; DSP runtime mapping remains separate")
