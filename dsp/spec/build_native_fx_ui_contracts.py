#!/usr/bin/env python3
"""Build reviewed source-only UI facts for all 53 contract FX families."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "official_fx_parameters_candidate_visual_glyphs.json"
OUTPUT = HERE / "official_fx_ui_contracts.json"
EXPECTED_PDF_SHA = "6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b"
REVIEWED_AT = "2026-10-10"

GLYPH_MEANINGS = {
    "U+00AA": "whole_note",
    "U+02C7": "half_note",
    "U+00B8": "quarter_note",
    "U+0060": "thirty_second_note",
    "U+02DC": "sixteenth_note",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def effect_key(name: str) -> str:
    return name.upper()


def build_domain(effect_name: str, parameter: dict[str, Any]) -> dict[str, Any]:
    name = parameter["displayName"]
    raw = parameter["rawValueText"] or ""

    if effect_name == "OCTAVE" and name == "OCTAVE":
        return {"kind": "explicit_enum", "choices": ["-1OCT", "-2OCT", "-1OCT&-2OCT"],
                "normalizationEvidence": "Root visually reviewed the three explicit comma-separated choices on page 39."}

    if effect_name == "ROLL" and name == "REPEAT":
        return {
            "kind": "choice_or_numeric_range",
            "components": [
                {"kind": "printed_numeric_range", "minimum": 1, "maximum": 100,
                 "unit": None, "printedLandmarks": [1, 50, 100]},
                {"kind": "explicit_choice", "value": "INF"},
            ],
            "normalizationEvidence": "Root visually reviewed ROLL2's finite repeat range and separate INF choice on page 41.",
        }

    if "4MEAS" in raw and parameter.get("visualGlyphInterpretations"):
        codes = [entry["codePoint"] for entry in parameter["visualGlyphInterpretations"]]
        glyphs = [
            {"character": chr(int(code[2:], 16)), "codePoint": code,
             "sourceVisualMeaning": GLYPH_MEANINGS[code]}
            for code in codes
        ]
        components: list[dict[str, Any]] = []
        if name == "STEP RATE":
            components.append({"kind": "explicit_choice", "value": "OFF"})
        components.append({"kind": "explicit_choices", "values": ["4MEAS", "2MEAS", "1MEAS"]})
        components.append({
            "kind": "printed_musical_glyph_run",
            "glyphs": glyphs,
            "expandedRhythmicChoices": None,
        })
        components.append({"kind": "printed_numeric_range", "minimum": 0, "maximum": 100, "unit": None})
        return {
            "kind": "compound_domain",
            "components": components,
            "fullyExpanded": False,
            "unresolvedChoiceExpansion": "No unprinted note divisions, dotted values, triplets or intermediate tempo values are inferred.",
        }

    if "ms" in raw and parameter.get("visualGlyphInterpretations"):
        codes = [entry["codePoint"] for entry in parameter["visualGlyphInterpretations"]]
        return {
            "kind": "compound_domain",
            "components": [
                {"kind": "printed_numeric_range", "minimum": parameter["minimum"], "maximum": parameter["maximum"],
                 "unit": "ms", "printedLandmarks": [parameter["minimum"], parameter["defaultNumeric"], parameter["maximum"]]},
                {"kind": "printed_musical_glyph_run", "glyphs": [
                    {"character": chr(int(code[2:], 16)), "codePoint": code,
                     "sourceVisualMeaning": GLYPH_MEANINGS[code]}
                    for code in codes
                ], "expandedRhythmicChoices": None},
            ],
            "fullyExpanded": False,
        }

    if name in {"LOW CUT", "HIGH CUT"} and "FLAT" in raw and "12.5" in raw:
        return {
            "kind": "choice_or_numeric_range",
            "components": [
                {"kind": "explicit_choice", "value": "FLAT"},
                {"kind": "printed_numeric_range", "minimum": 20, "maximum": 12500,
                 "unit": "Hz", "printedMinimum": "20.0 Hz", "printedMaximum": "12.5 kHz"},
            ],
            "unitNormalization": {"status": "root_reviewed", "canonicalUnit": "Hz",
                                   "conversion": "12.5 kHz -> 12500 Hz"},
        }

    if name in {"TIME", "GATE TIME"} and raw.endswith("s") and "ms" not in raw and parameter.get("unit") == "ms":
        return {
            "kind": "printed_numeric_range",
            "minimum": parameter["minimum"] / 1000,
            "maximum": parameter["maximum"] / 1000,
            "unit": "s",
            "printedLandmarks": [parameter["minimum"] / 1000, parameter["defaultNumeric"] / 1000, parameter["maximum"] / 1000],
            "canonicalUnitValue": {"minimum": parameter["minimum"], "maximum": parameter["maximum"], "default": parameter["defaultNumeric"], "unit": "ms"},
            "unitNormalization": {"status": "root_reviewed", "conversion": "seconds to milliseconds"},
        }

    if effect_name == "EQ" and name in {"LO-MID FREQ", "HI-MID FREQ"}:
        return {
            "kind": "printed_numeric_range",
            "minimum": 20,
            "maximum": 10000,
            "unit": "Hz",
            "printedRange": raw,
            "canonicalUnitValue": {"minimum": 20, "maximum": 10000,
                                    "default": parameter["defaultNumeric"], "unit": "Hz"},
            "unitNormalization": {"status": "root_reviewed", "conversion": "mixed Hz/kHz to Hz"},
        }

    if parameter.get("visualGlyphInterpretations"):
        return {
            "kind": "printed_components_unexpanded",
            "printedValueText": raw,
            "components": strip_component_evidence(parameter.get("structuredValueComponents") or []),
            "printedNumericRange": ({"minimum": parameter["minimum"], "maximum": parameter["maximum"],
                                     "unit": parameter.get("unit")}
                                    if parameter.get("minimum") is not None and parameter.get("maximum") is not None else None),
            "visualGlyphFacts": [{"codePoint": item["codePoint"],
                                  "sourceVisualMeaning": GLYPH_MEANINGS[item["codePoint"]]}
                                 for item in parameter["visualGlyphInterpretations"]],
            "fullyExpanded": False,
            "expansionPolicy": "Printed tempo symbols are source facts, not a complete enumeration of device tempo divisions.",
        }

    if parameter.get("enumChoices") and not any("–" in choice for choice in parameter["enumChoices"]):
        return {"kind": "explicit_enum", "choices": parameter["enumChoices"]}

    if parameter.get("minimum") is not None and parameter.get("maximum") is not None:
        return {
            "kind": "printed_numeric_range",
            "minimum": parameter["minimum"],
            "maximum": parameter["maximum"],
            "unit": parameter.get("unit"),
            "printedRange": raw,
            "printedLandmarks": ([parameter["minimum"], parameter["defaultNumeric"], parameter["maximum"]]
                                 if parameter.get("defaultNumeric") is not None else None),
        }

    if parameter.get("structuredValueComponents"):
        return {
            "kind": "printed_components_unexpanded",
            "printedValueText": raw,
            "components": strip_component_evidence(parameter["structuredValueComponents"]),
            "fullyExpanded": False,
            "expansionPolicy": "Only printed labels, anchors and fractions are retained; no intermediate choices or DSP curves are inferred.",
        }
    return {"kind": "raw_only_unexpanded", "printedValueText": raw, "parsedRange": None, "choices": None}


def strip_component_evidence(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: strip_component_evidence(child) for key, child in value.items() if key != "sourceEvidence"}
    if isinstance(value, list):
        return [strip_component_evidence(child) for child in value]
    return value


def build() -> dict[str, Any]:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    if source["source"]["downloadedPdfSha256"] != EXPECTED_PDF_SHA:
        raise ValueError("Official guide SHA does not match the reviewed source")
    source_effects = {effect["id"]: effect for effect in source["effects"]}
    effects = []
    for stable_id in source_effects:
        effect = source_effects[stable_id]
        parameters = []
        for section in effect["sections"]:
            for parameter in section["parameters"]:
                parameters.append({
                    "id": parameter["id"] + (f".variant-{section['variant']}" if section.get("variant") else ""),
                    "sourceParameterId": parameter["id"],
                    "sectionHeading": section["headingLabel"],
                    "sectionVariant": section.get("variant"),
                    "displayName": parameter["displayName"],
                    "printedPage": section["printedPage"],
                    "rawValueText": parameter["rawValueText"],
                    "rawValueTextExtractorOutput": parameter["rawValueTextExtractorOutput"],
                    "valueDomain": build_domain(effect["officialDisplayName"], parameter),
                    "default": {
                        "raw": parameter["defaultRaw"],
                        "numericCanonical": parameter["defaultNumeric"],
                        "evidence": parameter["defaultEvidence"],
                        "sourceStatus": parameter["defaultStatus"],
                        "reviewEvidence": parameter["defaultReviewEvidence"],
                    },
                    "unitCanonical": parameter.get("unit"),
                    "controlAssignableMarkerObserved": parameter["controlAssignableMarkerObserved"],
                    "controlAssignableStatus": parameter["controlAssignableStatus"],
                    "fxSequenceTargetMarkerObserved": parameter["fxSequenceTargetMarkerObserved"],
                    "fxSequenceTargetStatus": parameter["fxSequenceTargetStatus"],
                    "initialValueMarkerObserved": parameter["initialValueMarkerObserved"],
                    "initialValueStatus": parameter["initialValueStatus"],
                    "localDspControlMapping": {
                        "status": "not_derived_from_published_values",
                        "note": "Published UI facts do not establish a DSP curve, transfer function, or local processor bounds.",
                    },
                    "sourceEvidence": parameter["sourceEvidence"],
                    "reviewEvidence": {
                        "status": "root_visual_reviewed",
                        "reviewerRole": "root",
                        "reviewedAt": REVIEWED_AT,
                        "printedPage": section["printedPage"],
                        "method": "Rendered English 04 parameter-guide page with cell geometry and bold/color spans retained.",
                    },
                })
        effects.append({
            "id": effect["id"],
            "officialDisplayName": effect["officialDisplayName"],
            "availability": effect["availability"],
            "publishedPlacementConstraint": (
                {"trackFxMode": "MULTI", "slot": "A", "printedPage": 43}
                if not effect["availability"]["inputFx"] else None
            ),
            "sections": [{"headingLabel": section["headingLabel"], "variant": section.get("variant"),
                          "printedPage": section["printedPage"], "parameterCount": len(section["parameters"])}
                         for section in effect["sections"]],
            "publishedParametersStatus": "reviewed_ui_facts_with_unexpanded_mixed_domains",
            "parameters": parameters,
        })

    return {
        "schemaVersion": "webrc-official-fx-ui-contracts-v1",
        "artifact": "reviewed_official_fx_ui_facts_all_53_families",
        "authority": "source_facts_from_official_published_guide",
        "normativeForPublishedUiFacts": True,
        "runtimeConsumptionAllowed": False,
        "dspImplementationContract": False,
        "promotionStatus": "ready_for_root_and_native_registry_review",
        "source": {
            "title": source["source"]["title"],
            "url": source["source"]["url"],
            "pdfSha256": EXPECTED_PDF_SHA,
            "candidatePath": SOURCE.name,
            "candidateSha256": sha256(SOURCE),
            "extractorSha256": source["source"]["extractorScriptSha256"],
            "printedPages": list(range(34, 44)),
            "sourceEvidencePolicy": "Value-cell facts and geometry only; Explanation prose is excluded.",
        },
        "review": {
            "status": "root_visual_review_cited",
            "reviewerRole": "root",
            "reviewedAt": REVIEWED_AT,
            "scope": "Root reviewed printed pages 34-43 against the value/default cells. All 53 contract families and 55 printed variant sections are retained; this is source-fact coverage, not implemented-control coverage.",
        },
        "controlMappingPolicy": "Official UI domains/defaults remain separate from reconstructed processor ranges and DSP curves.",
        "effects": effects,
    }


if __name__ == "__main__":
    document = build()
    OUTPUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(HERE.parent.parent)} ({len(document['effects'])} FX, "
          f"{sum(len(effect['parameters']) for effect in document['effects'])} reviewed parameter rows)")
