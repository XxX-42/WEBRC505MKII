#!/usr/bin/env python3
"""Build a geometry-backed, non-normative candidate from Roland's FX tables.

The output is deliberately separate from official_fx_parameters.json. It keeps
the exact value-cell text and bold spans with PDF coordinates, while leaving
ambiguous glyphs and domains unparsed for review. It never copies Explanation
cell prose. Promotion into the runtime/catalog contract requires human review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

EXPECTED_GUIDE_SHA256 = "6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b"
GUIDE_URL = "https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf"
DEFAULT_CATALOG = Path(__file__).with_name("fx_catalog.json")
DEFAULT_OUTPUT = Path(__file__).with_name("official_fx_parameters_candidate.json")
PAGES = range(33, 43)  # Zero-based PDF pages 34–43.
VARIANTS = {
    "TAPE ECHO": ("TAPE ECHO1", "TAPE ECHO2"),
    "ROLL": ("ROLL1", "ROLL2"),
}
MUSICAL_GLYPHS = re.compile(r"[ˇ¸˜ª˚˛ˆˉ]")
# The PDF embeds a subset RolandOwnersManual font whose ToUnicode mapping is
# incomplete. These symbols were visually identified by the root reviewer from
# enlarged official-page crops; their meanings do not imply missing intermediate
# rhythmic choices and remain descriptive source metadata, not runtime logic.
MUSICAL_GLYPH_VISUAL_CANDIDATES = {
    "\u00aa": {
        "codePoint": "U+00AA",
        "symbolCandidate": "whole_note",
        "visibleShape": "open notehead without stem",
        "evidenceReferences": [{"printedPage": 43, "effect": "BEAT SCATTER", "parameter": "LENGTH"},
                               {"printedPage": 43, "effect": "BEAT SHIFT", "parameter": "SHIFT"}],
    },
    "\u02c7": {
        "codePoint": "U+02C7",
        "symbolCandidate": "half_note",
        "visibleShape": "open notehead with stem and no flag",
        "evidenceReferences": [{"printedPage": 34, "effect": "LPF", "parameter": "RATE"},
                               {"printedPage": 40, "effect": "DELAY", "parameter": "TIME"},
                               {"printedPage": 43, "effect": "BEAT REPEAT", "parameter": "LENGTH"}],
    },
    "\u00b8": {
        "codePoint": "U+00B8",
        "symbolCandidate": "quarter_note",
        "visibleShape": "filled notehead with stem and no flag",
        "evidenceReferences": [{"printedPage": 34, "effect": "LPF", "parameter": "RATE"},
                               {"printedPage": 43, "effect": "BEAT REPEAT", "parameter": "LENGTH"}],
    },
    "`": {
        "codePoint": "U+0060",
        "symbolCandidate": "thirty_second_note",
        "visibleShape": "filled notehead with stem and three flags",
        "evidenceReferences": [{"printedPage": 34, "effect": "LPF", "parameter": "RATE"},
                               {"printedPage": 43, "effect": "BEAT SCATTER", "parameter": "LENGTH"}],
    },
    "\u02dc": {
        "codePoint": "U+02DC",
        "symbolCandidate": "sixteenth_note",
        "visibleShape": "filled notehead with stem and two flags",
        "evidenceReferences": [{"printedPage": 43, "effect": "BEAT REPEAT", "parameter": "LENGTH"},
                               {"printedPage": 43, "effect": "BEAT SHIFT", "parameter": "SHIFT"}],
    },
}
INTRO_PROSE = re.compile(
    r"\b(?:sets|specifies|selects|adjusts|operates|these parameters|parameter guide)\b",
    re.IGNORECASE,
)
NUMBER_UNIT = re.compile(
    r"(?<![A-Za-z])([+-]?\d+(?:\.\d+)?)\s*(kHz|Hz|dB|ms|sec|s|OCTAVE|OCT)?",
    re.IGNORECASE,
)
UNIT_SCALE = {"khz": 1000.0, "hz": 1.0, "sec": 1000.0, "s": 1000.0, "ms": 1.0,
              "db": 1.0, "oct": 1.0, "octave": 1.0}
UNIT_FAMILY = {"khz": "Hz", "hz": "Hz", "sec": "ms", "s": "ms", "ms": "ms",
               "db": "dB", "oct": "OCT", "octave": "OCT"}
BASE_UNIT_FOR_FAMILY = {"Hz": "hz", "ms": "ms", "dB": "db", "OCT": "oct"}
PDF_BLUE_VALUE_COLOR = 0x00558F
ROOT_CONFIRMED_MUSICAL_GLYPH_DEFAULTS = {
    (34, "LPF", "RATE"), (34, "BPF", "RATE"), (34, "HPF", "RATE"),
    (34, "PHASER", "RATE"),
    (35, "FLANGER", "RATE"), (35, "FLANGER", "STEP RATE"),
    (36, "AUTO RIFF", "TEMPO"),
    (40, "PATTERN SLICER", "RATE"), (40, "STEP SLICER", "RATE"),
    (41, "ROLL1", "TIME"), (41, "ROLL2", "TIME"),
    (43, "BEAT SCATTER", "LENGTH"), (43, "BEAT REPEAT", "LENGTH"),
    (43, "BEAT SHIFT", "SHIFT"),
    (34, "FX SEQUENCE", "RATE"),
}


def clean_text(value: str | None) -> str:
    return " ".join((value or "").replace("\u00a0", " ").split())


def rect_json(rect: Any) -> list[float] | None:
    if rect is None:
        return None
    return [round(float(value), 3) for value in rect]


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def effect_heading_map(catalog: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item["officialDisplayName"]).upper(): item for item in catalog["effects"]}


def line_headings(page: Any, known: set[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if clean_text(span.get("text"))]
            if not spans:
                continue
            raw = clean_text("".join(span.get("text", "") for span in spans)).upper()
            # Printed effect headings are 12/13 pt MyriadPro-Cond; page titles
            # and section captions are excluded by exact catalog-name matching.
            if raw not in known and raw not in {name for pair in VARIANTS.values() for name in pair}:
                continue
            if not any("cond" in str(span.get("font", "")).lower() for span in spans):
                continue
            if max(float(span.get("size", 0.0)) for span in spans) < 10.5:
                continue
            x0 = min(float(span["bbox"][0]) for span in spans)
            y0 = min(float(span["bbox"][1]) for span in spans)
            x1 = max(float(span["bbox"][2]) for span in spans)
            y1 = max(float(span["bbox"][3]) for span in spans)
            if raw in {name for pair in VARIANTS.values() for name in pair}:
                parent = next(key for key, pair in VARIANTS.items() if raw in pair)
                result.append({"effect": parent, "variant": raw.removeprefix(parent).strip(),
                               "label": raw, "bbox": (x0, y0, x1, y1)})
            else:
                result.append({"effect": raw, "variant": None, "label": raw,
                               "bbox": (x0, y0, x1, y1)})
    return result


def cell_spans(page: Any, rect: Any) -> list[dict[str, Any]]:
    if rect is None:
        return []
    x0, y0, x1, y1 = map(float, rect)
    found: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                sx0, sy0, sx1, sy1 = map(float, span["bbox"])
                if sx0 >= x0 - 0.8 and sx1 <= x1 + 0.8 and sy0 >= y0 - 0.8 and sy1 <= y1 + 0.8:
                    text = str(span.get("text", ""))
                    if text.strip():
                        found.append({"text": text, "font": str(span.get("font", "")),
                                      "flags": int(span.get("flags", 0)),
                                      "color": int(span.get("color", 0)),
                                      "bbox": tuple(map(float, span["bbox"]))})
    found.sort(key=lambda span: (round(span["bbox"][1], 1), span["bbox"][0]))
    return found


def spans_text(spans: list[dict[str, Any]]) -> str:
    # Cell text from PyMuPDF's grid extraction is preferable for line joining;
    # this helper is used only for the exact character sequence in bold spans.
    return clean_text("".join(span["text"] for span in spans))


def span_evidence(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"text": span["text"], "font": span["font"], "flags": span["flags"],
             "color": span["color"], "bboxPoints": rect_json(span["bbox"])} for span in spans]


def visual_default_cues(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Preserve blue value spans and standalone music-glyph spans. The source
    # text layer sometimes reports a glyph's color differently from the
    # rendered page, so color/font/flags/bbox are evidence rather than a
    # promotion rule.
    cues: list[dict[str, Any]] = []
    for span in spans:
        text = span["text"]
        code_points = [f"U+{ord(char):04X}" for char in text]
        if int(span["color"]) == PDF_BLUE_VALUE_COLOR:
            cues.append({"text": text, "codePoints": code_points,
                         "color": span["color"], "font": span["font"], "flags": span["flags"],
                         "bboxPoints": rect_json(span["bbox"]),
                         "cueStatus": "blue_value_span_candidate_requires_root_confirmation"})
        elif len(text) == 1 and text in MUSICAL_GLYPH_VISUAL_CANDIDATES:
            cues.append({"text": text, "codePoints": code_points,
                         "color": span["color"], "font": span["font"], "flags": span["flags"],
                         "bboxPoints": rect_json(span["bbox"]),
                         "cueStatus": "custom_font_glyph_candidate_requires_root_confirmation"})
    return cues


def review_default_cue(cues: list[dict[str, Any]], printed_page: int, effect: str,
                       parameter: str, default_raw: str | None,
                       default_raw_extractor: str | None,
                       source_evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Promote only the blue quarter-note cues root visually reviewed."""
    result = {
        "defaultRaw": default_raw,
                "defaultRawExtractorOutput": default_raw_extractor,
                "defaultStatus": "bold_span_observed" if default_raw else "no_bold_span_observed",
        "defaultCandidateStatus": ("bold_span_observed" if default_raw else
                                    "blue_value_cue_requires_root_confirmation" if cues else
                                    "no_bold_or_blue_value_cue_observed"),
        "defaultReviewEvidence": None,
    }
    key = (printed_page, effect.upper(), parameter.upper())
    if default_raw is not None or key not in ROOT_CONFIRMED_MUSICAL_GLYPH_DEFAULTS:
        return result
    cue = next((item for item in cues if item["text"] == "¸" and
                 item["codePoints"] == ["U+00B8"]), None)
    if cue is None:
        return result
    cue["cueStatus"] = "root_visual_confirmed_musical_glyph_default"
    result.update({
        "defaultRaw": "¸",
        "defaultRawExtractorOutput": None,
        "defaultStatus": "root_visual_confirmed_musical_glyph_default",
        "defaultCandidateStatus": "root_visual_confirmation_complete",
        "defaultReviewEvidence": {
            "status": "root_visual_confirmed",
            "reviewerRole": "root",
            "reviewedAt": "2026-10-09",
            "printedPage": printed_page,
            "effect": effect,
            "parameter": parameter,
            "interpretation": "The rendered custom-font U+00B8 value-cell glyph is the selected quarter-note default.",
            "valueSpanEvidence": cue,
            "parameterValueCellEvidence": source_evidence,
        },
    })
    return result


def default_evidence_fields(default_raw: str | None, default_status: str,
                            default_review: dict[str, Any] | None,
                            source_evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Project default provenance into the shared parameter-schema vocabulary."""
    if default_status == "root_visual_confirmed_musical_glyph_default" and default_review:
        span = default_review["valueSpanEvidence"]
        return {
                "defaultEvidence": "visual_style_in_source",
            "defaultEvidenceDetails": {
                "method": "visual_style_in_source",
                "reviewStatus": "root_visual_confirmed",
                "reviewerRole": "root",
                "reviewedAt": "2026-10-09",
                "page": default_review["printedPage"],
                "glyph": span["text"],
                "font": span["font"],
                "colorRgbInteger": span["color"],
                "bboxPoints": span["bboxPoints"],
            },
        }
    if default_raw is None:
        return {"defaultEvidence": "unknown", "defaultEvidenceDetails": None}
    bold_span = next((span for evidence in source_evidence for span in evidence.get("boldSpans", [])), None)
    if bold_span is None:
        return {"defaultEvidence": "unknown", "defaultEvidenceDetails": None}
    root_confirmed = bool(default_review and default_review.get("reviewerRole") == "root")
    return {
        "defaultEvidence": "bold_in_source",
        "defaultEvidenceDetails": {
            "method": "bold_font_span",
            "reviewStatus": "root_visual_confirmed" if root_confirmed else "source_span_observed",
            "reviewerRole": "root" if root_confirmed else None,
            "reviewedAt": "2026-10-09" if root_confirmed else None,
            "page": source_evidence[0].get("printedPage") if source_evidence else None,
            "glyph": None,
            "font": bold_span.get("font"),
            "colorRgbInteger": bold_span.get("color"),
            "bboxPoints": bold_span.get("bboxPoints"),
        },
    }


def glyph_candidate_fields(raw: str | None, source_evidence: list[dict[str, Any]]) -> dict[str, Any]:
    if raw is None:
        return {"valueTextWithMappedGlyphCandidates": None, "visualGlyphInterpretations": []}
    visual: list[dict[str, Any]] = []
    seen: set[str] = set()
    for character in raw:
        if character in MUSICAL_GLYPH_VISUAL_CANDIDATES and character not in seen:
            visual.append({**MUSICAL_GLYPH_VISUAL_CANDIDATES[character],
                           "mappingStatus": "root_visual_confirmed",
                           "reviewerRole": "root",
                           "reviewedAt": "2026-10-09",
                           "parameterValueCellEvidence": source_evidence})
            seen.add(character)
    mapped_text = re.sub(
        r"[\u00aa\u02c7\u00b8`\u02dc]",
        lambda match: f"[{MUSICAL_GLYPH_VISUAL_CANDIDATES[match.group(0)]['symbolCandidate'].upper()}]",
        raw,
    )
    return {"valueTextWithMappedGlyphCandidates": mapped_text,
            "visualGlyphInterpretations": visual}


def extract_global_sequence_settings(page: Any) -> dict[str, Any]:
    """Capture the separate three-column FX sequencer contract table on p. 34."""
    for table in page.find_tables(strategy="lines").tables:
        extracted = table.extract()
        if not extracted or len(extracted[0]) != 3:
            continue
        header = [clean_text(str(value)).casefold() for value in extracted[0]]
        if header != ["parameter", "value (bold: default)", "explanation"]:
            continue
        parameters: list[dict[str, Any]] = []
        for index, cells in enumerate(extracted[1:], start=1):
            label = clean_text(str(cells[0] or "")).upper()
            if not label:
                continue
            row = table.rows[index]
            parameter_cell, value_cell = row.cells[0], row.cells[1]
            raw_value_extractor = str(cells[1] or "").strip() if value_cell is not None else ""
            raw_value = join_split_decimal(raw_value_extractor) or None
            value_spans = cell_spans(page, value_cell)
            bold_spans = [span for span in value_spans if "bold" in span["font"].lower()
                          and "cond" not in span["font"].lower()]
            default_raw_extractor = spans_text(bold_spans) or None
            default_raw = join_split_decimal(default_raw_extractor) if default_raw_extractor else None
            evidence = [{
                "printedPage": 34,
                "tableRow": index,
                "tableBBoxPoints": rect_json(table.bbox),
                "parameterCellBBoxPoints": rect_json(parameter_cell),
                "valueCellBBoxPoints": rect_json(value_cell),
                "valueTextSpans": span_evidence(value_spans),
                "boldSpans": span_evidence(bold_spans),
            }]
            default_cues = visual_default_cues(value_spans)
            reviewed_default = review_default_cue(
                default_cues, 34, "FX SEQUENCE", label,
                default_raw, default_raw_extractor, evidence,
            )
            if label in {"SW", "SYNC", "RETRIG", "MAX"} and default_raw is not None:
                reviewed_default["defaultStatus"] = "root_visual_confirmed_bold_default"
                reviewed_default["defaultCandidateStatus"] = "root_visual_confirmation_complete"
                reviewed_default["defaultReviewEvidence"] = {
                    "status": "root_visual_confirmed_bold_default",
                    "reviewerRole": "root", "reviewedAt": "2026-10-09",
                    "printedPage": 34, "effect": "FX SEQUENCE", "parameter": label,
                    "boldSpanEvidence": span_evidence(bold_spans),
                    "parameterValueCellEvidence": evidence,
                }
            domain = conservative_domain(raw_value or "", default_raw)
            parameters.append({
                "id": "rc505mkii.fx-sequence.param." + re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-"),
                "displayName": label,
                "rowStatus": "geometry_candidate" if value_cell is not None else "merged_explanatory_row_no_value_cell",
                "rawValueText": raw_value,
                "rawValueTextExtractorOutput": raw_value_extractor or None,
                **glyph_candidate_fields(raw_value, evidence),
                **reviewed_default,
                "defaultVisualCueCandidates": default_cues,
                "defaultReviewEvidence": reviewed_default["defaultReviewEvidence"],
                **default_evidence_fields(reviewed_default["defaultRaw"],
                                          reviewed_default["defaultStatus"],
                                          reviewed_default["defaultReviewEvidence"], evidence),
                "unit": domain["unit"],
                "minimum": domain["minimum"],
                "maximum": domain["maximum"],
                "defaultNumeric": domain["defaultNumeric"],
                "enumChoices": domain["enumChoices"],
                "parseStatus": domain["parseStatus"] if value_cell is not None else "no_value_cell",
                "sourceEvidence": evidence,
            })
        return {
            "printedPage": 34,
            "section": "About FX sequences",
            "tableBBoxPoints": rect_json(table.bbox),
            "tableColumnCount": 3,
            "parameterValueHeader": "Value (Bold: default)",
            "explanationCellPolicy": "Explanation prose excluded",
            "parameters": parameters,
        }
    raise ValueError("Could not find the three-column FX sequence settings table on printed page 34")


def join_split_decimal(value: str) -> str:
    """Join PDF text-layer spacing inside a visually contiguous decimal token."""
    return re.sub(r"(?<=\d)\.\s+(?=\d)", ".", value)


def conservative_domain(raw: str, default_raw: str | None) -> dict[str, Any]:
    if not raw:
        return {"parseStatus": "raw_only_glyph_or_empty", "unit": None, "minimum": None,
                "maximum": None, "defaultNumeric": None, "enumChoices": None}
    if MUSICAL_GLYPHS.search(raw):
        # Some cells pair a numeric control range with an unreadable musical
        # sync glyph choice. Preserve the full source string and expose only
        # the independently legible first numeric domain as a partial candidate.
        prefix = raw.split(",", 1)[0].strip()
        if prefix != raw:
            partial = conservative_domain(prefix, default_raw)
            if partial["parseStatus"] == "numeric_range_candidate":
                partial["parseStatus"] = "partial_numeric_range_with_unparsed_glyph_choice"
                return partial
        return {"parseStatus": "raw_only_glyph_or_empty", "unit": None, "minimum": None,
                "maximum": None, "defaultNumeric": None, "enumChoices": None}

    if "\n" in raw:
        lines = [clean_text(part) for part in raw.splitlines() if clean_text(part)]
        if len(lines) >= 2 and all(re.fullmatch(r"[+-]?\d+(?:\.\d+)?", part) for part in lines):
            return {"parseStatus": "numeric_enum_candidate", "unit": None, "minimum": None,
                    "maximum": None, "defaultNumeric": None, "enumChoices": lines}

    matches = list(NUMBER_UNIT.finditer(raw))
    if "," in clean_text(raw) and not MUSICAL_GLYPHS.search(raw):
        parts = [clean_text(part) for part in clean_text(raw).split(",") if clean_text(part)]
        simple_items = all(
            re.fullmatch(r"[+-]?\d+(?:\.\d+)?(?:\s*(?:kHz|Hz|dB|ms|sec|s|OCTAVE|OCT))?", part, re.I)
            or re.fullmatch(r"\d+/\d+", part)
            or re.fullmatch(r"[A-Za-z][A-Za-z0-9 .&()'’+#/-]*", part)
            for part in parts
        )
        if len(parts) >= 2 and simple_items:
            return {"parseStatus": "enum_candidate", "unit": None, "minimum": None,
                    "maximum": None, "defaultNumeric": None, "enumChoices": parts}
    if matches:
        residue = raw
        for match in reversed(matches):
            residue = residue[:match.start()] + "#" + residue[match.end():]
        residue = residue.replace("#", "").strip()
        # Numeric domains are extracted only when all remaining structure is a
        # simple sequence separated by range dashes; comma mixtures stay raw.
        separators_ok = bool(re.fullmatch(r"[\s–—−-]*", residue))
        between_ok = all(re.fullmatch(r"\s*[–—−-]\s*", raw[a.end():b.start()])
                         for a, b in zip(matches, matches[1:]))
        if separators_ok and between_ok and len(matches) in (2, 3):
            observed_units = [m.group(2).lower() for m in matches if m.group(2)]
            family_set = {UNIT_FAMILY[u] for u in observed_units}
            if len(family_set) <= 1:
                family = next(iter(family_set), None)
                inherited = (observed_units[0] if len(set(observed_units)) == 1 else
                             BASE_UNIT_FOR_FAMILY.get(family or ""))
                values: list[float] = []
                for match in matches:
                    suffix = (match.group(2) or inherited or "").lower()
                    values.append(float(match.group(1)) * UNIT_SCALE.get(suffix, 1.0))
                numeric_default = None
                if default_raw:
                    default_match = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)\s*([A-Za-z]+)?\s*", default_raw)
                    if default_match:
                        default_value = float(default_match.group(1))
                        value_span = next((match for match in matches
                                           if abs(float(match.group(1)) - default_value) < 1.0e-9), None)
                        suffix = ((default_match.group(2) or
                                   (value_span.group(2) if value_span is not None else None) or
                                   inherited or "").lower())
                        numeric_default = float(default_match.group(1)) * UNIT_SCALE.get(suffix, 1.0)
                return {"parseStatus": "numeric_range_candidate", "unit": family,
                        "minimum": min(values), "maximum": max(values),
                        "defaultNumeric": numeric_default, "enumChoices": None}
        return {"parseStatus": "raw_only_mixed_or_noncanonical", "unit": None,
                "minimum": None, "maximum": None, "defaultNumeric": None, "enumChoices": None}

    normalized_raw = clean_text(raw)
    has_numeric_domain = bool(re.search(r"\d", normalized_raw))
    is_safe_enum_text = not MUSICAL_GLYPHS.search(normalized_raw) and not re.search(
        r"[^A-Za-z0-9 ,.&()'’+\-–—/\"]", normalized_raw
    )
    if is_safe_enum_text and not has_numeric_domain and ("," in normalized_raw or "\n" in raw):
        # Commas are explicit choice delimiters. Newlines are only a fallback
        # for a vertically listed choice set with no commas; they often wrap
        # a multiword enum such as "LIVE\nCOMP" and must not split it.
        source_parts = normalized_raw.split(",") if "," in normalized_raw else raw.splitlines()
        choices = [clean_text(part) for part in source_parts if clean_text(part)]
        if len(choices) >= 2:
            return {"parseStatus": "enum_candidate", "unit": None, "minimum": None,
                    "maximum": None, "defaultNumeric": None, "enumChoices": choices}
    return {"parseStatus": "raw_only_unclassified", "unit": None, "minimum": None,
            "maximum": None, "defaultNumeric": None, "enumChoices": None}


def is_setting_intro(raw: str) -> bool:
    text = clean_text(raw)
    return bool(text and INTRO_PROSE.search(text) and len(text) > 18)


def span_line_groups(spans: list[dict[str, Any]], tolerance: float = 2.0) -> list[list[dict[str, Any]]]:
    """Cluster text spans by baseline without joining distinct printed rows."""
    ordered = sorted(spans, key=lambda span: ((span["bbox"][1] + span["bbox"][3]) * 0.5,
                                               span["bbox"][0]))
    groups: list[list[dict[str, Any]]] = []
    centers: list[float] = []
    for span in ordered:
        center = (float(span["bbox"][1]) + float(span["bbox"][3])) * 0.5
        if not groups or abs(center - centers[-1]) > tolerance:
            groups.append([span])
            centers.append(center)
        else:
            groups[-1].append(span)
            centers[-1] = sum((float(item["bbox"][1]) + float(item["bbox"][3])) * 0.5
                              for item in groups[-1]) / len(groups[-1])
    for group in groups:
        group.sort(key=lambda span: span["bbox"][0])
    return groups


def horizontal_grid_rules(page: Any, x0: float, x1: float) -> list[float]:
    """Return thin horizontal rules whose path segments span a cell pair."""
    y_groups: dict[float, list[tuple[float, float]]] = {}
    for drawing in page.get_drawings():
        width = drawing.get("width")
        if width is not None and float(width) > 1.0:
            continue
        for item in drawing.get("items", []):
            if item[0] != "l":
                continue
            first, second = item[1], item[2]
            if abs(float(first.y) - float(second.y)) > 0.35:
                continue
            left, right = sorted((float(first.x), float(second.x)))
            if right - left < 2.0 or right < x0 - 1.0 or left > x1 + 1.0:
                continue
            key = round((float(first.y) + float(second.y)) * 0.5, 1)
            y_groups.setdefault(key, []).append((left, right))

    rules: list[float] = []
    required_left, required_right = x0 + 1.0, x1 - 1.0
    for y, intervals in y_groups.items():
        end = required_left
        for left, right in sorted(intervals):
            if right < end:
                continue
            if left > end + 1.0:
                break
            end = max(end, right)
            if end >= required_right:
                rules.append(y)
                break
    return sorted(set(rules))


def split_geometry_merged_row(page: Any, table_bbox: Any, parameter_cell: Any,
                              marker_cell: Any, value_cell: Any, label_raw: str,
                              value_raw: str) -> list[dict[str, Any]]:
    """Split only when text rows and a full-width printed rule prove the merge.

    PyMuPDF merges the ELECTRIC FORMANT/SPEED label and Value cells on p. 36
    because it misses an internal rule. This geometry-driven repair also stays
    fail-closed: both cells must have matching multi-line text baselines and
    actual table rules between every pair of baselines.
    """
    if parameter_cell is None or marker_cell is None or value_cell is None:
        return []
    label_text_lines = [clean_text(line) for line in str(label_raw or "").splitlines() if clean_text(line)]
    value_text_lines = [line.strip() for line in str(value_raw or "").splitlines() if line.strip()]
    if len(label_text_lines) < 2 or len(label_text_lines) != len(value_text_lines):
        return []

    # The table parser may crop the merged cell at an incorrect bottom edge.
    # Search by the original columns over the whole table, then select exact
    # text lines from each cell's extraction; this avoids absorbing neighbors.
    table_top, table_bottom = float(table_bbox[1]), float(table_bbox[3])
    label_spans = cell_spans(page, (float(parameter_cell[0]), table_top,
                                    float(parameter_cell[2]), table_bottom))
    value_spans = cell_spans(page, (float(value_cell[0]), table_top,
                                    float(value_cell[2]), table_bottom))
    all_label_groups = span_line_groups(label_spans)
    all_value_groups = span_line_groups(value_spans)

    def matching_groups(groups: list[list[dict[str, Any]]], expected: list[str]) -> list[list[dict[str, Any]]]:
        selected: list[list[dict[str, Any]]] = []
        available = list(groups)
        for target in expected:
            match = next((group for group in available
                          if clean_text("".join(span["text"] for span in group)) == clean_text(target)), None)
            if match is None:
                return []
            selected.append(match)
            available.remove(match)
        return selected

    label_groups = matching_groups(all_label_groups, label_text_lines)
    value_groups = matching_groups(all_value_groups, value_text_lines)
    if len(label_groups) != len(label_text_lines) or len(value_groups) != len(value_text_lines):
        return []

    centers: list[float] = []
    for label_group, value_group in zip(label_groups, value_groups):
        label_center = sum((float(span["bbox"][1]) + float(span["bbox"][3])) * 0.5
                           for span in label_group) / len(label_group)
        value_center = sum((float(span["bbox"][1]) + float(span["bbox"][3])) * 0.5
                           for span in value_group) / len(value_group)
        if abs(label_center - value_center) > 3.0:
            return []
        centers.append((label_center + value_center) * 0.5)
    if any(later - earlier < 5.0 for earlier, later in zip(centers, centers[1:])):
        return []

    left = min(float(parameter_cell[0]), float(value_cell[0]))
    right = max(float(parameter_cell[2]), float(value_cell[2]))
    rules = [rule for rule in horizontal_grid_rules(page, left, right)
             if table_top - 1.0 <= rule <= table_bottom + 1.0]
    separators: list[float] = []
    for upper, lower in zip(centers, centers[1:]):
        between = [rule for rule in rules if upper + 1.0 < rule < lower - 1.0]
        if not between:
            return []
        separators.append(min(between, key=lambda rule: abs(rule - (upper + lower) * 0.5)))
    top_candidates = [rule for rule in rules if rule < centers[0] - 1.0]
    bottom_candidates = [rule for rule in rules if rule > centers[-1] + 1.0]
    if not top_candidates or not bottom_candidates:
        return []
    boundaries = [max(top_candidates), *separators, min(bottom_candidates)]
    if any(later <= earlier for earlier, later in zip(boundaries, boundaries[1:])):
        return []

    parameter_rect = tuple(float(value) for value in parameter_cell)
    value_rect = tuple(float(value) for value in value_cell)
    segments: list[dict[str, Any]] = []
    for index, (label_line, value_line) in enumerate(zip(label_text_lines, value_text_lines)):
        y0, y1 = boundaries[index], boundaries[index + 1]
        parameter_bbox = (parameter_rect[0], y0, parameter_rect[2], y1)
        marker_rect = tuple(float(value) for value in marker_cell)
        marker_bbox = (marker_rect[0], y0, marker_rect[2], y1)
        value_bbox = (value_rect[0], y0, value_rect[2], y1)
        segment_value_spans = cell_spans(page, value_bbox)
        segment_label_spans = cell_spans(page, parameter_bbox)
        if not segment_value_spans or not segment_label_spans:
            return []
        segments.append({
            "label": label_line,
            "value": value_line,
            "parameterCellBBox": parameter_bbox,
            "markerCellBBox": marker_bbox,
            "valueCellBBox": value_bbox,
            "segmentIndex": index + 1,
            "splitRuleYPoints": separators,
        })
    return segments


def marker_cell_evidence(page: Any, rect: Any,
                         page_drawings: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Keep the marker cell's text and vector geometry without conflating icons.

    The printed guide uses a gray knob icon and a custom-font star whose text
    layer can surface as the character `2`. They are distinct facts: the knob
    denotes control assignability; a black star denotes an FX-sequence target;
    a blue star also denotes that the value is an initial value.
    """
    if rect is None:
        return {
            "markerCellTextExtractorOutput": None,
            "markerTextSpans": [],
            "markerVectorDrawings": [],
            "controlAssignableMarkerObserved": None,
            "controlAssignableStatus": "unknown_marker_cell_geometry_unavailable",
            "fxSequenceTargetMarkerObserved": None,
            "fxSequenceTargetStatus": "unknown_marker_cell_geometry_unavailable",
            "initialValueMarkerObserved": None,
            "initialValueStatus": "unknown_marker_cell_geometry_unavailable",
        }

    rect_values = tuple(float(value) for value in rect)
    spans = cell_spans(page, rect_values)
    marker_text = clean_text("".join(span["text"] for span in spans))
    vector_items: list[dict[str, Any]] = []
    knob_rectangles: list[list[float]] = []
    for drawing in page_drawings if page_drawings is not None else page.get_drawings():
        drawing_rect = drawing.get("rect")
        if drawing_rect is None:
            continue
        x0, y0, x1, y1 = map(float, drawing_rect)
        if (x0 < rect_values[0] - 0.4 or y0 < rect_values[1] - 0.4 or
                x1 > rect_values[2] + 0.4 or y1 > rect_values[3] + 0.4):
            continue
        fill = drawing.get("fill")
        color = drawing.get("color")
        entry = {
            "type": drawing.get("type"),
            "bboxPoints": rect_json(drawing_rect),
            "fillRgb": [round(float(value), 6) for value in fill] if fill else None,
            "strokeRgb": [round(float(value), 6) for value in color] if color else None,
            "strokeWidthPoints": (round(float(drawing["width"]), 4)
                                   if drawing.get("width") is not None else None),
            "itemCount": len(drawing.get("items", [])),
        }
        width, height = x1 - x0, y1 - y0
        if (drawing.get("type") == "fs" and fill and color and
                8.0 <= width <= 10.5 and 8.0 <= height <= 10.5 and
                all(abs(float(a) - b) < 0.025 for a, b in zip(fill, (0.427, 0.433, 0.442)))):
            vector_items.append(entry)
            knob_rectangles.append(rect_json(drawing_rect) or [])

    star_spans = [span for span in spans if span["text"].strip() == "2"]
    black_target_spans = [span for span in star_spans if int(span["color"]) == 0x231F20]
    blue_initial_spans = [span for span in star_spans if int(span["color"]) == PDF_BLUE_VALUE_COLOR]
    unclassified_star_spans = [span for span in star_spans
                               if span not in black_target_spans and span not in blue_initial_spans]
    marker_visual_text = span_evidence(spans)
    if len(knob_rectangles) == 1:
        assignable_observed: bool | None = True
        assignable_status = "source_vector_knob_icon_observed"
    else:
        assignable_observed = None
        assignable_status = "unknown_no_knob_icon_recognized" if not knob_rectangles else "unknown_multiple_knob_icons"
    if len(black_target_spans) + len(blue_initial_spans) == 1 and not unclassified_star_spans:
        target_observed: bool | None = True
        target_status = ("source_black_fx_sequence_star_observed" if black_target_spans else
                         "source_blue_initial_value_star_observed")
        initial_observed: bool | None = bool(blue_initial_spans)
        initial_status = ("source_blue_initial_value_star_observed" if blue_initial_spans else
                          "source_black_target_star_not_initial_marker")
    elif not star_spans:
        target_observed = None
        target_status = "unknown_no_recognized_star_text"
        initial_observed = None
        initial_status = "unknown_no_recognized_star_text"
    else:
        target_observed = None
        target_status = "unknown_unclassified_or_multiple_star_text"
        initial_observed = None
        initial_status = "unknown_unclassified_or_multiple_star_text"

    return {
        "markerCellTextExtractorOutput": marker_text,
        "markerTextSpans": marker_visual_text,
        "markerVectorDrawings": vector_items,
        "controlAssignableMarkerObserved": assignable_observed,
        "controlAssignableStatus": assignable_status,
        "fxSequenceTargetMarkerObserved": target_observed,
        "fxSequenceTargetStatus": target_status,
        "initialValueMarkerObserved": initial_observed,
        "initialValueStatus": initial_status,
    }


def extract_marker_legend(page: Any) -> dict[str, Any]:
    """Retain the p.34 source legend that separates knobs from star markers."""
    lines: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if str(span.get("text", "")).strip()]
            if not spans:
                continue
            lines.append({"text": "".join(str(span.get("text", "")) for span in spans),
                          "spans": spans})

    def take_contiguous(anchor: str, continuation: str | None = None) -> list[dict[str, Any]]:
        for index, line in enumerate(lines):
            if anchor not in line["text"]:
                continue
            selected = [line]
            if continuation and index + 1 < len(lines) and continuation in lines[index + 1]["text"]:
                selected.append(lines[index + 1])
            return selected
        return []

    control_lines = take_contiguous("Parameters indicated by", "symbol can be controlled")
    target_lines = take_contiguous("Parameters that can be set as a TARGET")
    target_line_text = " ".join(line["text"] for line in target_lines)
    if "blue stars indicate" in target_line_text and "initial values" not in target_line_text:
        for index, line in enumerate(lines):
            if "Parameters that can be set as a TARGET" in line["text"]:
                target_lines = lines[index:index + 2]
                break

    def evidence(selected: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "textExtractorOutput": " ".join(line["text"] for line in selected),
            "lineSpanEvidence": [
                {"rawLineExtractorOutput": line["text"],
                 "spans": span_evidence([{
                     "text": str(span.get("text", "")),
                     "font": str(span.get("font", "")),
                     "flags": int(span.get("flags", 0)),
                     "color": int(span.get("color", 0)),
                     "bbox": tuple(map(float, span["bbox"])),
                 } for span in line["spans"]])}
                for line in selected
            ],
        }

    return {
        "printedPage": 34,
        "controlAssignable": {
            "meaning": "The printed dial/knob marker denotes a parameter controllable by the INPUT FX/TRACK FX knobs.",
            "textEvidence": evidence(control_lines),
            "markerGlyphTextStatus": "marker_glyph_not_returned_by_text_extractor",
            "visualReviewStatus": "root_visual_confirmed",
            "reviewerRole": "root",
            "reviewedAt": "2026-10-09",
        },
        "fxSequenceTarget": {
            "meaning": "A black star/printed marker identifies a parameter available as an FX sequence TARGET.",
            "textEvidence": evidence(target_lines),
            "rawCustomFontMarkerCharacter": "2",
            "rawMarkerColorRgbInteger": 0x231F20,
            "visualReviewStatus": "root_visual_confirmed",
            "reviewerRole": "root",
            "reviewedAt": "2026-10-09",
        },
        "initialValue": {
            "meaning": "A blue star identifies the initial value for an FX sequence TARGET parameter.",
            "textEvidence": evidence(target_lines),
            "rawCustomFontMarkerCharacter": "2",
            "rawMarkerColorRgbInteger": PDF_BLUE_VALUE_COLOR,
            "visualReviewStatus": "root_visual_confirmed",
            "reviewerRole": "root",
            "reviewedAt": "2026-10-09",
        },
    }


def table_rows_for_heading(page: Any, table: Any, heading: dict[str, Any]) -> list[dict[str, Any]]:
    extracted = table.extract()
    if not extracted or len(table.rows) != len(extracted):
        return []
    header = [clean_text(str(value)).casefold() for value in extracted[0]]
    try:
        parameter_col = header.index("parameter")
        value_col = header.index("value (bold: default)")
    except ValueError:
        return []
    marker_col = 1 if len(header) == 4 else None
    if len(header) != 4:
        return []

    marker_column_rect = next((row.cells[marker_col] for row in table.rows[1:]
                               if row.cells[marker_col] is not None), None)
    marker_column_x = ((float(marker_column_rect[0]), float(marker_column_rect[2]))
                       if marker_column_rect is not None else None)

    def split_marker_column_geometry(parameter_rect: Any, marker_rect: Any) -> tuple[Any, Any]:
        if parameter_rect is None or marker_rect is not None or marker_column_x is None:
            return parameter_rect, marker_rect
        x0, y0, x1, y1 = map(float, parameter_rect)
        marker_x0, marker_x1 = marker_column_x
        if x0 < marker_x0 < marker_x1 <= x1 + 0.8:
            return (x0, y0, marker_x0, y1), (marker_x0, y0, marker_x1, y1)
        return parameter_rect, marker_rect

    result: list[dict[str, Any]] = []
    active: dict[str, Any] | None = None
    expanded_rows: list[tuple[int, list[Any], dict[str, Any] | None]] = []
    table_bbox = table.bbox
    page_drawings = page.get_drawings()
    for index, cells in enumerate(extracted[1:], start=1):
        row = table.rows[index]
        parameter_cell = row.cells[parameter_col]
        marker_cell = row.cells[marker_col] if marker_col is not None else None
        parameter_cell, marker_cell = split_marker_column_geometry(parameter_cell, marker_cell)
        value_cell = row.cells[value_col]
        segments = split_geometry_merged_row(
            page, table_bbox, parameter_cell, marker_cell, value_cell,
            str(cells[parameter_col] or ""), str(cells[value_col] or ""),
        )
        if segments:
            for segment in segments:
                segmented_cells = list(cells)
                segmented_cells[parameter_col] = segment["label"]
                segmented_cells[value_col] = segment["value"]
                expanded_rows.append((index, segmented_cells, segment))
        else:
            expanded_rows.append((index, list(cells), None))

    for index, cells, segment in expanded_rows:
        row = table.rows[index]
        parameter_raw = clean_text(str(cells[parameter_col] or ""))
        value_raw_extractor = str(cells[value_col] or "").strip()
        value_raw = join_split_decimal(value_raw_extractor)
        value_cell = segment["valueCellBBox"] if segment else row.cells[value_col]
        parameter_cell = segment["parameterCellBBox"] if segment else row.cells[parameter_col]
        marker_cell = row.cells[marker_col] if marker_col is not None else None
        parameter_cell, marker_cell = split_marker_column_geometry(parameter_cell, marker_cell)
        if segment:
            marker_cell = segment["markerCellBBox"]

        canonical_geometry_correction = None
        if (heading.get("page") == 36 and heading.get("label") == "ELECTRIC" and
                parameter_raw == "STABILITY" and parameter_cell is not None and
                value_cell is not None):
            # The PDF grid extractor starts the STABILITY cells at y=548.097,
            # although the printed row divider shared with the segmented SPEED
            # cell is y=553.8. Rebase this row on that real rule; retain the raw
            # parser rectangles below for audit and require the label/value
            # glyphs to remain wholly inside the corrected cell.
            parameter_rect = tuple(float(value) for value in parameter_cell)
            value_rect = tuple(float(value) for value in value_cell)
            rule_candidates = [rule for rule in horizontal_grid_rules(
                page, float(table_bbox[0]), float(table_bbox[2]))
                               if parameter_rect[1] + 1.0 < rule < parameter_rect[3] - 1.0]
            if rule_candidates:
                corrected_top = min(rule_candidates)
                label_spans = cell_spans(page, parameter_cell)
                value_spans = cell_spans(page, value_cell)
                if (all(float(span["bbox"][1]) >= corrected_top - 0.8
                        for span in [*label_spans, *value_spans]) and
                        abs(corrected_top - 553.8) <= 0.2):
                    parameter_cell = (parameter_rect[0], corrected_top,
                                      parameter_rect[2], parameter_rect[3])
                    value_cell = (value_rect[0], corrected_top,
                                  value_rect[2], value_rect[3])
                    marker_rect = tuple(float(value) for value in marker_cell) if marker_cell else None
                    if marker_rect:
                        marker_cell = (marker_rect[0], corrected_top,
                                       marker_rect[2], marker_rect[3])
                    canonical_geometry_correction = {
                        "method": "source_horizontal_rule_rebases_following_row",
                        "ruleYPoints": round(corrected_top, 3),
                        "parserParameterCellBBoxPoints": rect_json(parameter_rect),
                        "parserValueCellBBoxPoints": rect_json(value_rect),
                    }
        if parameter_raw:
            label = clean_text(parameter_raw).upper()
            if not re.fullmatch(r"[A-Z0-9][A-Z0-9 .&+()/#’'-]*", label):
                active = None
                continue
            value_spans = cell_spans(page, value_cell)
            bold_spans = [span for span in value_spans if "bold" in span["font"].lower()
                          and "cond" not in span["font"].lower()]
            raw_default_extractor = spans_text(bold_spans) or None
            raw_default = join_split_decimal(raw_default_extractor) if raw_default_extractor else None
            marker_text = clean_text(str(cells[marker_col] or "")) if marker_col is not None else ""
            marker_evidence = marker_cell_evidence(page, marker_cell, page_drawings)
            group_intro = is_setting_intro(value_raw)
            default_cues = visual_default_cues(value_spans)
            row_evidence = [{
                "printedPage": heading["page"],
                "tableRow": index,
                **({"tableRowSegment": segment["segmentIndex"],
                   "splitRuleYPoints": segment["splitRuleYPoints"]} if segment else {}),
                "parameterCellBBoxPoints": rect_json(parameter_cell),
                "markerCellBBoxPoints": rect_json(marker_cell),
                "markerCellGeometryCorrection": canonical_geometry_correction,
                "markerCellTextExtractorOutput": marker_text,
                "markerTextSpans": marker_evidence["markerTextSpans"],
                "markerVectorDrawings": marker_evidence["markerVectorDrawings"],
                "valueCellBBoxPoints": rect_json(value_cell),
                "valueTextSpans": span_evidence(value_spans),
                "boldSpans": span_evidence(bold_spans),
            }]
            reviewed_default = review_default_cue(
                default_cues, heading["page"], heading["label"], label,
                raw_default, raw_default_extractor, row_evidence,
            )
            active = {
                "name": label,
                "rawValueText": None if group_intro else (value_raw or None),
                "rawValueTextExtractorOutput": None if group_intro else (value_raw_extractor or None),
                "rawValueRows": [],
                "rawValueRowsExtractorOutput": [],
                **reviewed_default,
                "defaultVisualCueCandidates": default_cues,
                "markerFacts": marker_evidence,
                "sourceEvidence": row_evidence,
                "_expectsContinuation": group_intro,
            }
            if value_raw and not group_intro:
                active["rawValueRows"].append(value_raw)
                active["rawValueRowsExtractorOutput"].append(value_raw_extractor)
            result.append(active)
            continue

        # Grid rows with blank labels encode selectable child choices for
        # grouped settings (MODE/VOICE/TYPE/RELEASE). Capture only the Value
        # cell; the neighboring Explanation cell is never emitted.
        if active is not None and value_raw:
            if active["_expectsContinuation"] or active["rawValueText"] is None:
                active["rawValueRows"].append(value_raw)
                active["rawValueRowsExtractorOutput"].append(value_raw_extractor)
                value_spans = cell_spans(page, value_cell)
                bold_spans = [span for span in value_spans if "bold" in span["font"].lower()
                              and "cond" not in span["font"].lower()]
                if bold_spans:
                    active["defaultRawExtractorOutput"] = spans_text(bold_spans)
                    active["defaultRaw"] = join_split_decimal(active["defaultRawExtractorOutput"])
                    active["defaultStatus"] = "bold_span_observed"
                    active["defaultReviewEvidence"] = None
                active["defaultVisualCueCandidates"].extend(visual_default_cues(value_spans))
                active["defaultCandidateStatus"] = (
                    "bold_span_observed" if active["defaultRaw"] else
                    "blue_value_cue_requires_root_confirmation" if active["defaultVisualCueCandidates"] else
                    "no_bold_or_blue_value_cue_observed"
                )
                active["sourceEvidence"].append({
                    "printedPage": heading["page"],
                    "tableRow": index,
                    "parameterCellBBoxPoints": rect_json(parameter_cell),
                    "markerCellBBoxPoints": rect_json(marker_cell),
                    "markerCellGeometryCorrection": canonical_geometry_correction,
                    "markerCellTextExtractorOutput": marker_text,
                    "markerTextSpans": marker_evidence["markerTextSpans"],
                    "markerVectorDrawings": marker_evidence["markerVectorDrawings"],
                    "valueCellBBoxPoints": rect_json(value_cell),
                    "valueTextSpans": span_evidence(value_spans),
                    "boldSpans": span_evidence(bold_spans),
                })
            else:
                # Unknown label-less table fragments are not attached by guess.
                active = None

    for row in result:
        row["rawValueRows"] = row["rawValueRows"] or []
        if row["rawValueText"] is None and row["rawValueRows"]:
            row["rawValueText"] = "\n".join(row["rawValueRows"])
            row["rawValueTextExtractorOutput"] = "\n".join(row["rawValueRowsExtractorOutput"])
        row.pop("_expectsContinuation", None)
    return result


def structured_printed_components(printed_page: int, section_label: str, parameter_name: str,
                                  raw: str | None, enum_choices: list[str] | None,
                                  source_evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Record selected mixed/listed source structures without expanding ranges."""
    if printed_page not in {35, 36, 37} or not raw:
        return {"structuredValueStatus": "not_required_for_current_review", "structuredValueComponents": None}

    def component(kind: str, **fields: Any) -> dict[str, Any]:
        return {"kind": kind, **fields, "sourceEvidence": source_evidence}

    def label_range(text: str) -> dict[str, Any] | None:
        track = re.fullmatch(r"(TRACK)(\d+)\s*[–—−-]\s*(\d+)", clean_text(text), re.I)
        if track:
            return component("printed_indexed_label_range", rawText=text, labelPrefix=track.group(1),
                             firstIndex=int(track.group(2)), lastIndex=int(track.group(3)),
                             expandedChoices=None, expansionPolicy="No intermediate choices are synthesized.")
        phrase = re.fullmatch(r"([A-Z])(\d+)\s*[–—−-]\s*(\d+)", clean_text(text), re.I)
        if phrase:
            return component("printed_indexed_label_range", rawText=text, labelPrefix=phrase.group(1),
                             firstIndex=int(phrase.group(2)), lastIndex=int(phrase.group(3)),
                             expandedChoices=None, expansionPolicy="No intermediate labels are synthesized.")
        parts = re.split(r"\s*[–—−]\s*", clean_text(text))
        if len(parts) == 2 and all(parts):
            return component("printed_label_range", rawText=text, firstLabel=parts[0], lastLabel=parts[1],
                             expandedChoices=None, expansionPolicy="No unprinted intermediate labels are inferred.")
        return None

    def tokens(text: str) -> list[str]:
        return [clean_text(token) for line in text.splitlines()
                for token in line.split(",") if clean_text(token)]

    components: list[dict[str, Any]] = []
    name = parameter_name.upper()
    section = section_label.upper()
    normalized = clean_text(raw)

    if name == "PHRASE":
        item = label_range(raw)
        if item:
            components.append(item)
    elif name in {"KEY", "NOTE"}:
        item = label_range(raw)
        if item:
            components.append(item)
    elif name in {"TEMPO", "RATE", "STEP RATE"} and MUSICAL_GLYPHS.search(raw):
        for token in tokens(raw):
            if MUSICAL_GLYPHS.search(token):
                symbols = [{"codePoint": f"U+{ord(char):04X}",
                            "symbol": MUSICAL_GLYPH_VISUAL_CANDIDATES.get(char, {}).get("symbolCandidate")}
                           for char in token if char in MUSICAL_GLYPH_VISUAL_CANDIDATES]
                components.append(component("printed_musical_glyph_sequence", rawText=token,
                                            symbols=symbols, expandedRhythmicChoices=None,
                                            expansionPolicy="Only glyphs printed in the cell are listed; no intermediate, dotted, or triplet values are inferred."))
            elif re.fullmatch(r"\d+\s*[–—−-]\s*\d+", token):
                endpoints = re.split(r"\s*[–—−-]\s*", token)
                components.append(component("printed_numeric_range", rawText=token,
                                            firstValue=int(endpoints[0]), lastValue=int(endpoints[1])))
            else:
                components.append(component("explicit_listed_choice", rawText=token))
    elif name == "PAN" and "CENTER" in normalized.upper():
        anchors = [part.strip() for part in re.split(r"\s*[–—−-]\s*", raw) if part.strip()]
        if len(anchors) >= 2:
            components.append(component("printed_ordered_anchor_sequence", rawText=raw, anchors=anchors,
                                        interpolatedValues=None,
                                        expansionPolicy="Only printed anchors are retained; no interpolation grid is inferred."))
    elif name in {"VOICE", "CARRIER", "SCALE"}:
        for token in tokens(raw):
            indexed = label_range(token) if name == "CARRIER" else None
            scale_range = label_range(token) if name == "SCALE" else None
            if indexed:
                components.append(indexed)
            elif scale_range:
                components.append(scale_range)
            elif name == "VOICE" and any(dash in token for dash in ("–", "—", "−")):
                components.append(component("printed_range_choice_token", rawText=token,
                                            expandedChoices=None,
                                            expansionPolicy="Printed notation is retained verbatim; intermediate values are not expanded."))
            else:
                components.append(component("explicit_listed_choice", rawText=token))
    elif enum_choices:
        components.append(component("explicit_listed_choices", choices=enum_choices))

    if not components:
        return {"structuredValueStatus": "not_required_for_current_review", "structuredValueComponents": None}
    return {"structuredValueStatus": "printed_components_preserved_without_range_expansion",
            "structuredValueComponents": components}


def extract_candidate(pdf_path: Path, catalog_path: Path) -> dict[str, Any]:
    try:
        import pymupdf
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("Install PyMuPDF 1.28+ for PDF table geometry parsing.") from error

    guide_hash = hash_file(pdf_path)
    if guide_hash != EXPECTED_GUIDE_SHA256:
        raise ValueError(f"Official guide SHA256 mismatch: expected {EXPECTED_GUIDE_SHA256}, got {guide_hash}")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    known = effect_heading_map(catalog)
    heading_names = set(known)
    pdf = pymupdf.open(pdf_path)
    extracted_by_id: dict[str, list[dict[str, Any]]] = {item["id"]: [] for item in catalog["effects"]}

    for page_index in PAGES:
        page = pdf[page_index]
        headings = line_headings(page, heading_names)
        for heading in headings:
            heading["page"] = page_index + 1
        tables = page.find_tables(strategy="lines").tables
        for table in tables:
            cells = table.extract()
            if not cells or len(cells[0]) != 4:
                continue
            header = [clean_text(str(value)).casefold() for value in cells[0]]
            if "parameter" not in header or "value (bold: default)" not in header:
                continue
            x0, y0, x1, y1 = map(float, table.bbox)
            midpoint_x = (x0 + x1) * 0.5
            col_headings = [h for h in headings if
                            ((float(h["bbox"][0]) < 300) == (midpoint_x < 300)) and
                            float(h["bbox"][1]) < y0]
            if not col_headings:
                continue
            heading = max(col_headings, key=lambda h: float(h["bbox"][1]))
            effect_name = heading["effect"]
            if effect_name not in known:
                continue
            effect = known[effect_name]
            rows = table_rows_for_heading(page, table, heading)
            if not rows:
                continue
            variant = heading["variant"]
            section = {
                "headingLabel": heading["label"],
                "variant": variant,
                "printedPage": page_index + 1,
                "headingBBoxPoints": rect_json(heading["bbox"]),
                "tableBBoxPoints": rect_json(table.bbox),
                "tableColumnCount": len(cells[0]),
                "parameters": [],
            }
            counts: dict[str, int] = {}
            for parameter in rows:
                base = re.sub(r"[^a-z0-9]+", "-", parameter["name"].lower()).strip("-") or "unnamed"
                counts[base] = counts.get(base, 0) + 1
                domain = conservative_domain(parameter["rawValueText"] or "", parameter["defaultRaw"])
                grouped_rows = parameter["rawValueRows"]
                if len(grouped_rows) > 1 and not re.search(r"\d", "\n".join(grouped_rows)) and not MUSICAL_GLYPHS.search("\n".join(grouped_rows)):
                    grouped_choices: list[str] = []
                    for grouped_row in grouped_rows:
                        if "," in grouped_row:
                            grouped_choices.extend(clean_text(part) for part in grouped_row.split(",") if clean_text(part))
                        else:
                            grouped_choices.append(clean_text(grouped_row))
                    if len(grouped_choices) >= 2:
                        domain = {"parseStatus": "enum_candidate_from_separate_value_rows", "unit": None,
                                  "minimum": None, "maximum": None, "defaultNumeric": None,
                                  "enumChoices": grouped_choices}
                printed_page = parameter["sourceEvidence"][0]["printedPage"]
                domain_review_evidence = None
                if (effect["officialDisplayName"] == "EQ" and printed_page == 38 and
                        parameter["name"] in {"LO-MID FREQ", "HI-MID FREQ"}):
                    domain_review_evidence = {
                        "status": "root_visual_confirmed_unit_normalization",
                        "reviewerRole": "root", "reviewedAt": "2026-10-09",
                        "printedPage": 38, "canonicalUnit": "Hz",
                        "reviewNote": "Mixed printed Hz/kHz endpoints and bold default normalize to the candidate Hz values while raw Value-cell text is retained.",
                        "parameterValueCellEvidence": parameter["sourceEvidence"],
                    }
                elif (printed_page == 42 and domain["unit"] == "ms" and
                      re.search(r"\d\s*(?:s|sec)\b", parameter["rawValueText"] or "", re.I)):
                    domain_review_evidence = {
                        "status": "root_visual_confirmed_unit_normalization",
                        "reviewerRole": "root", "reviewedAt": "2026-10-09",
                        "printedPage": 42, "canonicalUnit": "ms",
                        "reviewNote": "Printed seconds-scale range/default normalize to milliseconds; raw Value-cell text is retained.",
                        "parameterValueCellEvidence": parameter["sourceEvidence"],
                    }
                structured_fields = structured_printed_components(
                    printed_page, section["headingLabel"], parameter["name"],
                    parameter["rawValueText"], domain["enumChoices"], parameter["sourceEvidence"],
                )
                section["parameters"].append({
                    "id": f"{effect['id']}.param.{base}" + (f".{counts[base]}" if counts[base] > 1 else ""),
                    "displayName": parameter["name"],
                    "rawValueText": parameter["rawValueText"],
                    "rawValueTextExtractorOutput": parameter["rawValueTextExtractorOutput"],
                    **glyph_candidate_fields(parameter["rawValueText"], parameter["sourceEvidence"]),
                    "rawValueRows": parameter["rawValueRows"],
                    "rawValueRowsExtractorOutput": parameter["rawValueRowsExtractorOutput"],
                    "defaultRaw": parameter["defaultRaw"],
                    "defaultRawExtractorOutput": parameter["defaultRawExtractorOutput"],
                    "defaultStatus": parameter["defaultStatus"],
                    "defaultVisualCueCandidates": parameter["defaultVisualCueCandidates"],
                    "defaultCandidateStatus": parameter["defaultCandidateStatus"],
                    "defaultReviewEvidence": parameter["defaultReviewEvidence"],
                    **default_evidence_fields(parameter["defaultRaw"], parameter["defaultStatus"],
                                              parameter["defaultReviewEvidence"],
                                              parameter["sourceEvidence"]),
                    "domainReviewEvidence": domain_review_evidence,
                    **structured_fields,
                    "unit": domain["unit"],
                    "minimum": domain["minimum"],
                    "maximum": domain["maximum"],
                    "defaultNumeric": domain["defaultNumeric"],
                    "enumChoices": domain["enumChoices"],
                    "parseStatus": domain["parseStatus"],
                    "controlAssignableMarkerObserved": parameter["markerFacts"]["controlAssignableMarkerObserved"],
                    "controlAssignableStatus": parameter["markerFacts"]["controlAssignableStatus"],
                    "fxSequenceTargetMarkerObserved": parameter["markerFacts"]["fxSequenceTargetMarkerObserved"],
                    "fxSequenceTargetStatus": parameter["markerFacts"]["fxSequenceTargetStatus"],
                    "initialValueMarkerObserved": parameter["markerFacts"]["initialValueMarkerObserved"],
                    "initialValueStatus": parameter["markerFacts"]["initialValueStatus"],
                    "mappingCurve": None,
                    "mappingCurveStatus": "not specified in extracted table; requires separate evidence",
                    "sourceEvidence": parameter["sourceEvidence"],
                })
            extracted_by_id[effect["id"]].append(section)

    effects = []
    missing: list[str] = []
    for effect in catalog["effects"]:
        sections = sorted(extracted_by_id[effect["id"]], key=lambda item: (item["printedPage"], item["tableBBoxPoints"][1]))
        observed_variants = [section["variant"] for section in sections]
        expected_variants = list(VARIANTS.get(effect["officialDisplayName"], ()))
        expected_count = len(expected_variants) if expected_variants else 1
        status = "geometry_candidate" if len(sections) == expected_count and all(s["parameters"] for s in sections) else "incomplete_geometry_candidate"
        if status != "geometry_candidate":
            missing.append(effect["officialDisplayName"])
        effects.append({
            "id": effect["id"],
            "officialDisplayName": effect["officialDisplayName"],
            "availability": effect["availability"],
            "parameterExtractionStatus": status,
            "expectedSectionLabels": list(expected_variants) if expected_variants else [effect["officialDisplayName"]],
            "observedSectionLabels": [section["headingLabel"] for section in sections],
            "sections": sections,
        })

    candidate = {
        "schemaVersion": "1.0.0-candidate",
        "artifact": "official_fx_parameters_candidate",
        "promotionStatus": "root_review_required",
        "normative": False,
        "runtimeConsumptionAllowed": False,
        "candidateCompleteness": "incomplete_pending_raw_enum_domain_review",
        "source": {
            "title": "RC-505mkII Parameter Guide, Version 1.3 and later",
            "publisher": "Roland Corporation",
            "url": GUIDE_URL,
            "downloadedPdfSha256": guide_hash,
            "stableCatalogPath": str(catalog_path.name),
            "stableCatalogSha256": hash_file(catalog_path),
            "extractorScriptSha256": hash_file(Path(__file__)),
            "pdfPageIndicesZeroBased": [min(PAGES), max(PAGES)],
            "printedPageRange": [34, 43],
            "extractionEngine": "PyMuPDF table grid strategy=lines; parameter/value/marker cells bounded by table row cell rectangles, with proof-based virtual-row segmentation only when aligned parameter/value baselines and spanning printed rules establish the split",
            "defaultExtraction": "bold font spans intersecting only the geometric Value cell; absent bold span remains null",
            "visualDefaultCues": "Blue #00558F Value-cell spans remain candidates unless the exact printed-page/effect/parameter field is listed in root-confirmed review evidence; confirmed U+00B8 values preserve the glyph as defaultRaw without claiming a numeric default.",
            "textNormalization": "Whitespace inserted inside a printed decimal token by the PDF text layer is joined in rawValueText/defaultRaw; original PyMuPDF cell/span output is retained beside each normalized string.",
            "explanationCellPolicy": "Explanation cell content is not copied into this artifact",
            "musicalGlyphPolicy": "Raw extracted glyph text is preserved. The symbol meanings were visually reviewed against the SHA-pinned rendered source pages and per-cell geometry; the meanings are source metadata only and never synthesize runtime behavior.",
            "musicalChoicePolicy": "A mapped glyph labels only a symbol visibly present in the source cell. Dashes, endpoint notation and nearby numeric ranges do not establish the unprinted intermediate rhythmic choices; no eighth-note, dotted-note, triplet or other range contents are inferred.",
            "structuredValuePolicy": "Selected mixed values preserve separately printed list members, labeled range endpoints, musical-glyph runs and numeric ranges with cell evidence. No intermediate labels or rhythmic choices are synthesized, and these structures remain source metadata rather than DSP mappings.",
            "limitation": "Candidate parsing is conservative. Unresolved mixed domains, enum choices, and unreviewed defaults remain non-normative and must not be consumed by a runtime.",
        },
        "musicalGlyphMap": {
            "status": "root_visual_confirmed",
            "reviewerRole": "root",
            "reviewedAt": "2026-10-09",
            "renderedSourcePages": [34, 40, 41, 43],
            "renderMethod": "Official PDF pages rendered from the SHA-pinned source; notehead openness, stem and flag count inspected at enlarged scale; p.43 Scatter/Repeat and p.34 LPF enlarged glyph crops were retained as review evidence.",
            "entries": [
                {"rawCharacter": char.encode("unicode_escape").decode("ascii"),
                 "mappingStatus": "root_visual_confirmed", "reviewerRole": "root",
                 "reviewedAt": "2026-10-09", **entry}
                for char, entry in MUSICAL_GLYPH_VISUAL_CANDIDATES.items()
            ],
        },
        "markerLegend": extract_marker_legend(pdf[33]),
        "fxSequenceSettings": extract_global_sequence_settings(pdf[33]),
        "coverage": {
            "expectedFxCount": len(catalog["effects"]),
            "observedFxCount": sum(bool(item["sections"]) for item in effects),
            "missingOrIncompleteFx": missing,
            "variantExpectedCounts": {key: len(value) for key, value in VARIANTS.items()},
        },
        "effects": effects,
    }
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="Path to the exact official guide PDF")
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG, help="Stable FX catalog with IDs/availability")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="Candidate output only; official_fx_parameters.json remains fail-closed")
    args = parser.parse_args()
    document = extract_candidate(args.pdf, args.catalog)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    # Do not overwrite a prior candidate silently; evidence captures should be immutable.
    if args.output.exists():
        raise FileExistsError(f"Refusing to overwrite candidate evidence file: {args.output}")
    args.output.write_text(payload, encoding="utf-8")
    total = sum(len(section["parameters"]) for effect in document["effects"] for section in effect["sections"])
    print(f"Wrote non-normative candidate: {len(document['effects'])} effects / {total} parameter rows -> {args.output}")
    print(f"Coverage: {document['coverage']['observedFxCount']}/{document['coverage']['expectedFxCount']} FX with all expected sections")
    if document["coverage"]["missingOrIncompleteFx"]:
        print("Incomplete: " + ", ".join(document["coverage"]["missingOrIncompleteFx"]))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FX geometry extraction failed: {error}", file=sys.stderr)
        raise
