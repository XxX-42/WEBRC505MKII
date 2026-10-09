#!/usr/bin/env python3
"""Fail-closed structural checks for the non-normative official FX PDF candidate."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_CANDIDATE = HERE / "official_fx_parameters_candidate_visual_glyphs.json"
EXPECTED_GUIDE_SHA = "6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b"
EXPLANATION_VERBS = re.compile(r"\b(?:sets|specifies|adjusts|selects|operates|adds|produces|creates)\b", re.I)
EXPECTED_MUSIC_GLYPHS = {
    "U+00AA": "whole_note",
    "U+02C7": "half_note",
    "U+00B8": "quarter_note",
    "U+0060": "thirty_second_note",
    "U+02DC": "sixteenth_note",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def inside(inner: list[float], outer: list[float], epsilon: float = 1.0) -> bool:
    return (len(inner) == len(outer) == 4 and inner[0] >= outer[0] - epsilon and
            inner[1] >= outer[1] - epsilon and inner[2] <= outer[2] + epsilon and
            inner[3] <= outer[3] + epsilon)


def validate(path: Path) -> dict[str, Any]:
    candidate = json.loads(path.read_text(encoding="utf-8"))
    require(candidate["artifact"] == "official_fx_parameters_candidate", "Wrong artifact identity")
    require(candidate["normative"] is False and candidate["runtimeConsumptionAllowed"] is False,
            "Candidate must remain non-normative and unavailable to runtime consumers")
    require(candidate["promotionStatus"] == "root_review_required", "Candidate must require root review")
    require(candidate["source"]["downloadedPdfSha256"] == EXPECTED_GUIDE_SHA, "Official PDF fingerprint mismatch")
    glyph_map = candidate.get("musicalGlyphMap", {})
    require(glyph_map.get("status") == "root_visual_confirmed" and
            glyph_map.get("reviewerRole") == "root" and glyph_map.get("reviewedAt") == "2026-10-09",
            "Candidate musical glyph map must cite the root's visual review")
    observed_glyph_map = {entry["codePoint"]: entry["symbolCandidate"]
                          for entry in glyph_map.get("entries", [])}
    require(observed_glyph_map == EXPECTED_MUSIC_GLYPHS,
            "Candidate musical glyph map differs from the visually reviewed shape inventory")
    require(all(entry.get("mappingStatus") == "root_visual_confirmed" and
                entry.get("reviewerRole") == "root" and entry.get("reviewedAt") == "2026-10-09"
                for entry in glyph_map["entries"]),
            "Each global musical glyph mapping must carry root review attribution")
    require("do not establish" in candidate["source"]["musicalChoicePolicy"],
            "Musical symbols must not be expanded into unsupported intermediate choices")
    marker_legend = candidate.get("markerLegend", {})
    require(marker_legend.get("printedPage") == 34 and
            marker_legend.get("controlAssignable", {}).get("visualReviewStatus") == "root_visual_confirmed" and
            marker_legend.get("fxSequenceTarget", {}).get("rawMarkerColorRgbInteger") == 0x231F20 and
            marker_legend.get("initialValue", {}).get("rawMarkerColorRgbInteger") == 0x00558F,
            "Knob assignability, black FX-target stars and blue initial-value stars need separate p.34 evidence")
    require("can be controlled" in marker_legend["controlAssignable"]["textEvidence"]["textExtractorOutput"] and
            "TARGET" in marker_legend["fxSequenceTarget"]["textEvidence"]["textExtractorOutput"] and
            "blue stars indicate" in marker_legend["initialValue"]["textEvidence"]["textExtractorOutput"],
            "p.34 marker legend text must retain all three distinct source meanings")
    effects = candidate["effects"]
    parameter_schema = json.loads((HERE / "parameter_schema.json").read_text(encoding="utf-8"))
    allowed_default_evidence = set(parameter_schema["properties"]["defaultEvidence"]["enum"])
    require(len(effects) == 53, f"Expected 53 effects, got {len(effects)}")
    ids = [effect["id"] for effect in effects]
    require(len(set(ids)) == 53, "FX stable IDs must be unique")
    require(sum(bool(effect["availability"]["inputFx"]) for effect in effects) == 49,
            "Input FX scope must contain exactly 49 effects")
    require(sum(bool(effect["availability"]["trackFx"]) for effect in effects) == 53,
            "Track FX scope must contain exactly 53 effects")

    all_text_values: list[str] = []
    parameter_count = 0
    for effect in effects:
        require(effect["parameterExtractionStatus"] == "geometry_candidate", effect["officialDisplayName"] + " has incomplete geometry mapping")
        require(bool(effect["sections"]), effect["officialDisplayName"] + " has no extracted parameter sections")
        for section in effect["sections"]:
            require(34 <= section["printedPage"] <= 43, "Parameter evidence falls outside official FX pages")
            table_box = section["tableBBoxPoints"]
            require(section["tableColumnCount"] == 4, "Only four-column effect parameter tables are allowed")
            require(bool(section["parameters"]), effect["officialDisplayName"] + " has an empty parameter table")
            for parameter in section["parameters"]:
                parameter_count += 1
                require(parameter.get("defaultEvidence") in allowed_default_evidence,
                        "Parameter defaultEvidence is outside the shared schema enum")
                if parameter.get("defaultEvidence") == "visual_style_in_source":
                    details = parameter.get("defaultEvidenceDetails") or {}
                    require(details.get("method") == "visual_style_in_source" and
                            details.get("reviewStatus") == "root_visual_confirmed" and
                            details.get("reviewerRole") == "root" and
                            details.get("glyph") == "¸" and details.get("bboxPoints"),
                            "Visual-style default evidence must retain its reviewed glyph span and geometry")
                require(parameter["id"].startswith(effect["id"] + ".param."), "Parameter ID is not scoped to its FX ID")
                require(parameter["sourceEvidence"], "Every parameter must have cell geometry evidence")
                require(parameter.get("controlAssignableMarkerObserved") in {True, None},
                        "Missing or unrecognized marker text must never become a negative knob claim")
                marker_text_spans = [span for evidence in parameter["sourceEvidence"]
                                     for span in evidence.get("markerTextSpans", [])]
                if parameter["controlAssignableMarkerObserved"] is True:
                    require(parameter.get("controlAssignableStatus") == "source_vector_knob_icon_observed" and
                            any(drawing.get("type") == "fs" and drawing.get("fillRgb") and
                                drawing["bboxPoints"][2] - drawing["bboxPoints"][0] >= 8.0 and
                                drawing["bboxPoints"][3] - drawing["bboxPoints"][1] >= 8.0
                                for evidence in parameter["sourceEvidence"]
                                for drawing in evidence.get("markerVectorDrawings", [])),
                            "Control assignability requires the source knob vector, not the star glyph")
                else:
                    require(str(parameter.get("controlAssignableStatus", "")).startswith("unknown_"),
                            "Unobserved knob icon must remain explicitly unknown")
                target_observed = parameter.get("fxSequenceTargetMarkerObserved")
                initial_observed = parameter.get("initialValueMarkerObserved")
                if target_observed is True:
                    require(initial_observed in {True, False},
                            "A recognized target star must separately classify initial-value status")
                    expected_color = 0x00558F if initial_observed else 0x231F20
                    require(any(span.get("text") == "2" and span.get("color") == expected_color
                                for span in marker_text_spans),
                            "Star classification must retain its custom-font raw marker and source color")
                    require(parameter.get("fxSequenceTargetStatus") in {
                                "source_black_fx_sequence_star_observed",
                                "source_blue_initial_value_star_observed"},
                            "Recognized FX-sequence star has an unsupported status")
                else:
                    require(target_observed is None and initial_observed is None and
                            str(parameter.get("fxSequenceTargetStatus", "")).startswith("unknown_"),
                            "Unrecognized star glyph must remain unknown for target and initial value")
                for evidence_index, evidence in enumerate(parameter["sourceEvidence"]):
                    require(evidence["printedPage"] == section["printedPage"], "Parameter source page mismatch")
                    require(inside(evidence["valueCellBBoxPoints"], table_box),
                            "Value cell escaped its table rectangle")
                    if evidence_index == 0:
                        require(inside(evidence["parameterCellBBoxPoints"], table_box),
                                "Parameter label cell escaped its table rectangle")
                    for span in evidence["valueTextSpans"]:
                        require(inside(span["bboxPoints"], evidence["valueCellBBoxPoints"]),
                                "Value text span escaped its value-cell rectangle")
                raw = parameter["rawValueText"] or ""
                present_codepoints = {f"U+{ord(char):04X}" for char in raw
                                      if f"U+{ord(char):04X}" in EXPECTED_MUSIC_GLYPHS}
                visual_by_codepoint = {item["codePoint"]: item
                                       for item in parameter["visualGlyphInterpretations"]}
                require(set(visual_by_codepoint) == present_codepoints,
                        "Per-parameter visual glyph candidate coverage differs from raw value text")
                require(parameter["valueTextWithMappedGlyphCandidates"] is not None,
                        "Mapped display candidate must be present alongside the untouched raw text")
                for codepoint, interpretation in visual_by_codepoint.items():
                    require(interpretation["symbolCandidate"] == EXPECTED_MUSIC_GLYPHS[codepoint],
                            "Per-row visual glyph interpretation disagrees with the global map")
                    require(interpretation["mappingStatus"] == "root_visual_confirmed" and
                            interpretation["reviewerRole"] == "root" and
                            interpretation["reviewedAt"] == "2026-10-09",
                            "Per-row glyph mapping is missing root review evidence")
                all_text_values.extend([parameter["rawValueText"] or "", *parameter["rawValueRows"]])
    require(not any(EXPLANATION_VERBS.search(value) for value in all_text_values),
            "Explanation prose appears in a parameter value cell")

    electric = next(effect for effect in effects if effect["officialDisplayName"] == "ELECTRIC")
    electric_rows = [parameter for section in electric["sections"] for parameter in section["parameters"]
                     if section["printedPage"] == 36 and
                     parameter["displayName"] in {"FORMANT", "SPEED", "FORMANT SPEED"}]
    electric_by_name = {parameter["displayName"]: parameter for parameter in electric_rows}
    require(set(electric_by_name) == {"FORMANT", "SPEED"},
            "ELECTRIC p.36 FORMANT and SPEED must be reconstructed as two physical rows")
    require(electric_by_name["FORMANT"]["rawValueText"] == "-50–0–+50" and
            electric_by_name["FORMANT"]["defaultRaw"] == "0" and
            electric_by_name["FORMANT"]["minimum"] == -50.0 and
            electric_by_name["FORMANT"]["maximum"] == 50.0 and
            electric_by_name["FORMANT"]["defaultNumeric"] == 0.0,
            "ELECTRIC FORMANT must retain its own printed range/default and table-cell geometry")
    require(electric_by_name["SPEED"]["rawValueText"] == "0–5–10" and
            electric_by_name["SPEED"]["defaultRaw"] == "5" and
            electric_by_name["SPEED"]["minimum"] == 0.0 and
            electric_by_name["SPEED"]["maximum"] == 10.0 and
            electric_by_name["SPEED"]["defaultNumeric"] == 5.0,
            "ELECTRIC SPEED must retain its own printed range/default and table-cell geometry")
    for name in ("FORMANT", "SPEED"):
        evidence = electric_by_name[name]["sourceEvidence"][0]
        require(evidence.get("tableRowSegment") in {1, 2} and
                len(evidence.get("splitRuleYPoints", [])) == 1,
                f"ELECTRIC {name} must cite the printed horizontal-rule segmentation")
        require(evidence.get("markerCellBBoxPoints") is not None and
                abs(evidence["markerCellBBoxPoints"][1] - evidence["parameterCellBBoxPoints"][1]) < 0.002 and
                abs(evidence["markerCellBBoxPoints"][3] - evidence["parameterCellBBoxPoints"][3]) < 0.002,
                f"ELECTRIC {name} must segment the marker column with its parameter cell")
    stability = next(parameter for section in electric["sections"] for parameter in section["parameters"]
                     if section["printedPage"] == 36 and parameter["displayName"] == "STABILITY")
    speed_box = electric_by_name["SPEED"]["sourceEvidence"][0]["valueCellBBoxPoints"]
    stability_evidence = stability["sourceEvidence"][0]
    stability_box = stability_evidence["valueCellBBoxPoints"]
    require(abs(speed_box[3] - 553.8) < 0.002 and
            abs(stability_box[1] - speed_box[3]) < 0.002 and
            stability_evidence["markerCellGeometryCorrection"]["method"] ==
            "source_horizontal_rule_rebases_following_row" and
            abs(stability_evidence["markerCellGeometryCorrection"]["ruleYPoints"] - speed_box[3]) < 0.002 and
            stability_box[1] >= speed_box[3],
            "ELECTRIC SPEED/STABILITY cell boxes must meet on the actual y=553.8 rule without overlap")

    def fx_parameter(effect_name: str, heading_label: str, parameter_name: str) -> dict[str, Any]:
        effect = next(item for item in effects if item["officialDisplayName"] == effect_name)
        section = next(item for item in effect["sections"] if item["headingLabel"] == heading_label)
        return next(item for item in section["parameters"] if item["displayName"] == parameter_name)

    electric_shift = fx_parameter("ELECTRIC", "ELECTRIC", "SHIFT")
    bend_target = fx_parameter("PITCH BEND", "PITCH BEND", "BEND")
    transpose_target = fx_parameter("TRANSPOSE", "TRANSPOSE", "TRANS")
    require(electric_shift["controlAssignableMarkerObserved"] is True and
            electric_shift["fxSequenceTargetMarkerObserved"] is None,
            "ELECTRIC.SHIFT has a knob icon with no star: knob assignability and target must stay distinct")
    require(bend_target["controlAssignableMarkerObserved"] is True and
            bend_target["fxSequenceTargetMarkerObserved"] is True and
            bend_target["fxSequenceTargetStatus"] == "source_black_fx_sequence_star_observed" and
            bend_target["initialValueMarkerObserved"] is False,
            "PITCH BEND.BEND must preserve the knob plus black sequence-target star, not an initial-value star")
    require(transpose_target["controlAssignableMarkerObserved"] is True and
            transpose_target["fxSequenceTargetMarkerObserved"] is True and
            transpose_target["fxSequenceTargetStatus"] == "source_blue_initial_value_star_observed" and
            transpose_target["initialValueMarkerObserved"] is True,
            "TRANSPOSE.TRANS must preserve the knob plus blue initial-value target star")

    tempo = fx_parameter("AUTO RIFF", "AUTO RIFF", "TEMPO")
    tempo_components = tempo["structuredValueComponents"]
    require(tempo["structuredValueStatus"] == "printed_components_preserved_without_range_expansion" and
            [item["kind"] for item in tempo_components] == [
                "explicit_listed_choice", "explicit_listed_choice", "explicit_listed_choice",
                "printed_musical_glyph_sequence", "printed_numeric_range"],
            "AUTO RIFF TEMPO must separate printed measure choices, glyph run and numeric range")
    glyph_sequence = tempo_components[3]
    require([item["codePoint"] for item in glyph_sequence["symbols"]] ==
            ["U+02C7", "U+00B8", "U+0060"] and
            glyph_sequence["expandedRhythmicChoices"] is None,
            "Tempo glyph notation must preserve only shown glyphs and never infer intermediate values")
    require(tempo_components[4]["firstValue"] == 0 and tempo_components[4]["lastValue"] == 100,
            "AUTO RIFF TEMPO's separate 0–100 component must retain its printed endpoints")
    for effect_name, heading_label, parameter_name, first, last in (
        ("AUTO RIFF", "AUTO RIFF", "KEY", "C (Am)", "B (G#m)"),
        ("ROBOT", "ROBOT", "NOTE", "C", "B"),
        ("HRM MANUAL", "HRM MANUAL", "KEY", "C (Am)", "B (G#m)"),
        ("HRM AUTO (M)", "HRM AUTO (M)", "KEY", "C (Am)", "B (G#m)"),
    ):
        parameter = fx_parameter(effect_name, heading_label, parameter_name)
        component = parameter["structuredValueComponents"][0]
        require(component["kind"] == "printed_label_range" and
                component["firstLabel"] == first and component["lastLabel"] == last and
                component["expandedChoices"] is None,
                f"{effect_name}.{parameter_name} must preserve label endpoints without expanding unprinted values")
    manual_voice = fx_parameter("HRM MANUAL", "HRM MANUAL", "VOICE")
    require([item.get("rawText") for item in manual_voice["structuredValueComponents"]] == [
                "OCT-", "OCT+", "-6–4TH", "-3RD", "+3RD", "+4–6TH", "UNISON"] and
            all(item.get("expandedChoices") is None for item in manual_voice["structuredValueComponents"]
                if "expandedChoices" in item),
            "HRM MANUAL VOICE must preserve printed choices/range tokens verbatim")
    vocoder_carrier = fx_parameter("VOCODER", "VOCODER", "CARRIER")
    carrier_components = vocoder_carrier["structuredValueComponents"]
    track_range = next((item for item in carrier_components
                        if item["kind"] == "printed_indexed_label_range"), None)
    require(track_range is not None and track_range["rawText"] == "TRACK1–5" and
            track_range["firstIndex"] == 1 and track_range["lastIndex"] == 5 and
            track_range["expandedChoices"] is None and
            [item["rawText"] for item in carrier_components if item["kind"] == "explicit_listed_choice"] ==
            ["MIC1", "MIC2", "INST1-L", "INST1-R", "INST2-L", "INST2-R"],
            "VOCODER CARRIER must keep explicit choices distinct from its printed TRACK1–5 range")
    for effect in effects:
        for section in effect["sections"]:
            for parameter in section["parameters"]:
                for structured in parameter.get("structuredValueComponents") or []:
                    require(structured.get("sourceEvidence") and
                            all(evidence.get("valueCellBBoxPoints") is not None
                                for evidence in structured["sourceEvidence"]),
                            "Structured mixed value components must preserve their source Value-cell geometry")

    sequence = candidate.get("fxSequenceSettings", {})
    require(sequence.get("printedPage") == 34 and sequence.get("tableColumnCount") == 3,
            "Separate global FX sequence parameter table must be present with its page/column geometry")
    sequence_parameters = sequence.get("parameters", [])
    sequence_by_name = {parameter["displayName"]: parameter for parameter in sequence_parameters}
    require(list(sequence_by_name) == ["SW", "SYNC", "RETRIG", "TARGET", "RATE", "MAX", "VAL1–16"],
            "Global FX sequence setting rows changed or are incomplete")
    for name in ("SW", "SYNC", "RETRIG"):
        parameter = sequence_by_name[name]
        require(parameter["rawValueText"] == "OFF, ON" and parameter["defaultRaw"] == "OFF",
                f"FX sequence {name} must retain the Value-cell OFF/ON enum and bold OFF default")
    require(sequence_by_name["TARGET"]["rawValueText"] is None and
            sequence_by_name["TARGET"]["rowStatus"] == "merged_explanatory_row_no_value_cell",
            "FX sequence TARGET has no discrete value cell and must remain unparsed")
    maximum_steps = sequence_by_name["MAX"]
    require(maximum_steps["rawValueText"] == "1–16" and maximum_steps["defaultRaw"] == "16" and
            maximum_steps["minimum"] == 1.0 and maximum_steps["maximum"] == 16.0 and
            maximum_steps["defaultNumeric"] == 16.0,
            "FX sequence MAX must retain range 1–16 and the bold 16 default only")
    rate = sequence_by_name["RATE"]
    require(rate["rawValueText"] == "0–100, 4MEAS, 2MEAS, 1MEAS,\nˇ–¸–`" and
            {item["codePoint"] for item in rate["visualGlyphInterpretations"]} ==
            {"U+02C7", "U+00B8", "U+0060"},
            "FX sequence RATE must preserve raw musical glyphs and their non-normative visual candidates")
    blue_note_default = [cue for cue in rate["defaultVisualCueCandidates"]
                         if "U+00B8" in cue["codePoints"]]
    require(rate["defaultRaw"] == "¸" and len(blue_note_default) == 1 and
            blue_note_default[0]["color"] == 0x00558F and
            blue_note_default[0]["cueStatus"] == "root_visual_confirmed_musical_glyph_default" and
            rate["defaultStatus"] == "root_visual_confirmed_musical_glyph_default" and
            rate["defaultReviewEvidence"]["reviewerRole"] == "root" and
            rate["defaultEvidence"] == "visual_style_in_source" and
            rate["defaultEvidenceDetails"]["method"] == "visual_style_in_source",
            "FX sequence RATE quarter-note cue must cite the root visual confirmation")
    approved_fx_defaults = [parameter for effect in effects for section in effect["sections"]
                            for parameter in section["parameters"]
                            if parameter["defaultStatus"] == "root_visual_confirmed_musical_glyph_default"]
    require(len(approved_fx_defaults) == 14,
            f"Expected 14 root-confirmed FX musical-glyph default fields, got {len(approved_fx_defaults)}")
    for parameter in approved_fx_defaults:
        require(parameter["defaultRaw"] == "¸" and parameter["defaultReviewEvidence"]["reviewerRole"] == "root",
                "A promoted blue-note default lacks its per-field root review evidence")
        require(parameter["defaultEvidence"] == "visual_style_in_source" and
                parameter["defaultEvidenceDetails"]["reviewStatus"] == "root_visual_confirmed",
                "A root-reviewed blue-note default must use the visual-style evidence form")
    reviewed_default_keys = {
        (section["printedPage"], section["headingLabel"], parameter["displayName"])
        for effect in effects for section in effect["sections"] for parameter in section["parameters"]
        if parameter["defaultStatus"] == "root_visual_confirmed_musical_glyph_default"
    }
    require(reviewed_default_keys == {
        (34, "LPF", "RATE"), (34, "BPF", "RATE"), (34, "HPF", "RATE"), (34, "PHASER", "RATE"),
        (35, "FLANGER", "RATE"), (35, "FLANGER", "STEP RATE"),
        (36, "AUTO RIFF", "TEMPO"),
        (40, "PATTERN SLICER", "RATE"), (40, "STEP SLICER", "RATE"),
        (41, "ROLL1", "TIME"), (41, "ROLL2", "TIME"),
        (43, "BEAT SCATTER", "LENGTH"), (43, "BEAT REPEAT", "LENGTH"),
        (43, "BEAT SHIFT", "SHIFT"),
    }, "Root-confirmed musical-glyph defaults differ from the field-level review evidence")
    for section in (section for effect in effects for section in effect["sections"] if section["printedPage"] == 39):
        for parameter in section["parameters"]:
            if parameter["displayName"] == "RATE" and parameter["defaultRaw"] is None:
                require(parameter["defaultCandidateStatus"] == "blue_value_cue_requires_root_confirmation",
                        "Unreviewed p.39 blue RATE cue must remain pending, not promoted")
    for name in ("SW", "SYNC", "RETRIG", "MAX"):
        require(sequence_by_name[name]["defaultStatus"] == "root_visual_confirmed_bold_default" and
                sequence_by_name[name]["defaultReviewEvidence"]["reviewerRole"] == "root" and
                sequence_by_name[name]["defaultEvidence"] == "bold_in_source",
                f"FX sequence {name} bold default needs root visual review evidence")
    for parameter in sequence_parameters:
        require(parameter.get("defaultEvidence") in allowed_default_evidence,
                "Global sequence defaultEvidence is outside the shared schema enum")
        for evidence in parameter["sourceEvidence"]:
            value_box = evidence["valueCellBBoxPoints"]
            if value_box is None:
                continue
            require(inside(value_box, sequence["tableBBoxPoints"]),
                    "Global sequence value cell escaped the table rectangle")
            for span in evidence["valueTextSpans"]:
                require(inside(span["bboxPoints"], value_box),
                        "Global sequence value text span escaped its value-cell rectangle")

    dynamics = next(effect for effect in effects if effect["officialDisplayName"] == "DYNAMICS")
    dynamics_type = next(parameter for section in dynamics["sections"] for parameter in section["parameters"]
                         if parameter["displayName"] == "TYPE")
    dynamics_raw = " ".join((dynamics_type["rawValueText"] or "").split())
    require("BRIGHTEN" in dynamics_raw and "DJs VOICE" in dynamics_raw and "PHONE VOX" in dynamics_raw,
            "DYNAMICS.TYPE must retain the full value cell through PHONE VOX")
    eq = next(effect for effect in effects if effect["officialDisplayName"] == "EQ")
    eq_frequency = next(parameter for section in eq["sections"] for parameter in section["parameters"]
                        if parameter["displayName"] == "LO-MID FREQ")
    require(eq_frequency["rawValueText"] == "20.0–800 Hz–10.0 kHz" and eq_frequency["unit"] == "Hz" and
            eq_frequency["minimum"] == 20.0 and eq_frequency["maximum"] == 10000.0 and
            eq_frequency["defaultNumeric"] == 800.0,
            "EQ LO-MID FREQ must normalize the mixed Hz/kHz domain while preserving source text/default")
    hi_mid_frequency = next(parameter for section in eq["sections"] for parameter in section["parameters"]
                            if parameter["displayName"] == "HI-MID FREQ")
    require(hi_mid_frequency["unit"] == "Hz" and hi_mid_frequency["minimum"] == 20.0 and
            hi_mid_frequency["maximum"] == 10000.0 and hi_mid_frequency["defaultNumeric"] == 3150.0,
            "EQ HI-MID FREQ must apply the printed kHz suffix to the bold 3.15 default")
    for parameter in (eq_frequency, hi_mid_frequency):
        require(parameter["domainReviewEvidence"]["status"] == "root_visual_confirmed_unit_normalization" and
                parameter["domainReviewEvidence"]["reviewerRole"] == "root",
                "EQ mixed Hz/kHz normalization must cite root review")
    seconds_normalized = [parameter for effect in effects for section in effect["sections"]
                          if section["printedPage"] == 42 for parameter in section["parameters"]
                          if parameter["domainReviewEvidence"] and
                          parameter["domainReviewEvidence"]["canonicalUnit"] == "ms"]
    require(len(seconds_normalized) == 4 and all(
        parameter["domainReviewEvidence"]["reviewerRole"] == "root" for parameter in seconds_normalized
    ), "The four p.42 printed-seconds ranges must carry root-reviewed millisecond normalization evidence")

    return {"effects": len(effects), "inputFx": 49, "trackFx": 53,
            "sections": sum(len(effect["sections"]) for effect in effects),
            "parameterRows": parameter_count,
            "fxSequenceSettings": len(sequence_parameters),
            "musicalGlyphs": len(glyph_map["entries"]),
            "rootConfirmedFxMusicalGlyphDefaults": len(approved_fx_defaults)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", nargs="?", type=Path, default=DEFAULT_CANDIDATE)
    args = parser.parse_args()
    report = validate(args.candidate)
    print("Official FX parameter candidate structure PASS (non-normative; unresolved raw enum/domain review remains): " +
          json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
