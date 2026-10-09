#!/usr/bin/env python3
"""Extract parameter labels/defaults/ranges from Roland's public parameter guide.

This tool emits only a compact parameter schema. It does not copy the PDF's
effect descriptions or assets. PyMuPDF is an optional tooling dependency.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

EXPECTED_GUIDE_SHA256 = "6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b"
GUIDE_URL = "https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf"
PARAMETER_PAGES = range(33, 43)  # PDF pages 34–43; printed guide pages 34–43.
VARIANT_SECTIONS = {"TAPE ECHO": ["TAPE ECHO1", "TAPE ECHO2"], "ROLL": ["ROLL1", "ROLL2"]}


def normalized(value: str) -> str:
    return " ".join(value.replace("\t", " ").split()).upper()


def read_effect_names(matrix_path: Path) -> list[str]:
    with matrix_path.open(encoding="utf-8-sig", newline="") as handle:
        return [row["effect"] for row in csv.DictReader(handle)]


def span_text(span: dict[str, Any]) -> str:
    return str(span.get("text", "")).replace("\u00a0", " ").strip()


def page_lines(page: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if span_text(span)]
            if not spans:
                continue
            result.append(
                {
                    "x": min(float(span["bbox"][0]) for span in spans),
                    "y": min(float(span["bbox"][1]) for span in spans),
                    "text": "".join(str(span.get("text", "")) for span in spans).strip(),
                    "spans": spans,
                }
            )
    return result


def belongs_to_column(x: float, column: int) -> bool:
    return x < 260 if column == 0 else x >= 260


def in_label_band(x: float, column: int) -> bool:
    return x < 105 if column == 0 else 270 <= x < 370


def value_cell_bounds(lines: list[dict[str, Any]], column: int) -> tuple[float, float]:
    value_headers: list[float] = []
    explanation_headers: list[float] = []
    for line in lines:
        if not belongs_to_column(line["x"], column):
            continue
        for span in line["spans"]:
            text = span_text(span).strip().lower()
            x = float(span["bbox"][0])
            if text == "value" and "semibold" in str(span.get("font", "")).lower():
                value_headers.append(x)
            elif text == "explanation" and "semibold" in str(span.get("font", "")).lower():
                explanation_headers.append(x)
    if not value_headers or not explanation_headers:
        raise ValueError(f"Could not locate Value/Explanation column headers for PDF column {column}")
    # Column starts are taken from the guide's actual header span boxes, so a
    # value cell cannot absorb prose from the neighboring Explanation cell.
    return min(value_headers) - 2, min(explanation_headers) - 2


def in_marker_band(x: float, column: int) -> bool:
    return 85 <= x < 110 if column == 0 else 350 <= x < 375


def extract_parameter_sections(pdf_path: Path, matrix_path: Path) -> dict[str, Any]:
    try:
        import pymupdf
    except ImportError as error:  # pragma: no cover - exercised only without optional tool.
        raise RuntimeError("Install PyMuPDF to extract the optional official-guide schema.") from error

    digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    if digest != EXPECTED_GUIDE_SHA256:
        raise ValueError(
            "Parameter-guide SHA256 does not match the verified v1.3+ English PDF: "
            f"expected {EXPECTED_GUIDE_SHA256}, got {digest}"
        )

    effect_names = read_effect_names(matrix_path)
    section_to_effect: dict[str, tuple[str, str | None]] = {}
    for effect in effect_names:
        if effect in VARIANT_SECTIONS:
            for variant in VARIANT_SECTIONS[effect]:
                suffix = variant.removeprefix(effect).strip() or variant
                section_to_effect[variant] = (effect, suffix)
        else:
            section_to_effect[normalized(effect)] = (effect, None)

    pdf = pymupdf.open(pdf_path)
    found: dict[str, list[dict[str, Any]]] = {name: [] for name in effect_names}
    for page_index in PARAMETER_PAGES:
        if page_index >= len(pdf):
            continue
        lines = page_lines(pdf[page_index])
        for column in (0, 1):
            value_x_start, value_x_end = value_cell_bounds(lines, column)
            col_lines = [line for line in lines if belongs_to_column(line["x"], column)]
            col_lines.sort(key=lambda line: (line["y"], line["x"]))
            sections: list[tuple[int, str, str, str | None]] = []
            for index, line in enumerate(col_lines):
                key = normalized(line["text"])
                is_effect_heading = any(
                    "cond" in str(span.get("font", "")).lower()
                    for span in line["spans"]
                )
                if key in section_to_effect and is_effect_heading:
                    effect, variant = section_to_effect[key]
                    sections.append((index, key, effect, variant))

            for section_index, (start, key, effect, variant) in enumerate(sections):
                end = sections[section_index + 1][0] if section_index + 1 < len(sections) else len(col_lines)
                content = col_lines[start:end]
                labels: list[dict[str, Any]] = []
                for line in content[1:]:
                    if not in_label_band(line["x"], column):
                        continue
                    label = normalized(line["text"])
                    if not label or label in {"PARAMETER", "VALUE (BOLD: DEFAULT)", "EXPLANATION"}:
                        continue
                    # Parameter labels use the guide's semibold face. Ignore
                    # other headings and wrapped prose based on both font and shape.
                    spans = line["spans"]
                    has_label_font = any(
                        "semibold" in str(span.get("font", "")).lower()
                        or "bold" in str(span.get("font", "")).lower()
                        for span in spans
                    )
                    if (
                        not has_label_font
                        or not re.fullmatch(r"[A-Z][A-Z0-9 .&+()/#-]*", label)
                    ):
                        continue
                    labels.append({"name": label, "y": line["y"], "line": line})

                for label_index, label in enumerate(labels):
                    next_y = labels[label_index + 1]["y"] if label_index + 1 < len(labels) else label["y"] + 30
                    # A cell may wrap to multiple lines. Its vertical extent is
                    # the region beginning just above its parameter label and
                    # ending just above the next label, rather than a midpoint
                    # slice that would truncate long TYPE/value lists.
                    lower = label["y"] - 8
                    upper = next_y - 4
                    row_spans: list[dict[str, Any]] = []
                    marker_found = False
                    for line in content:
                        for span in line["spans"]:
                            x, y = float(span["bbox"][0]), float(span["bbox"][1])
                            text = span_text(span)
                            if value_x_start <= x < value_x_end and lower <= y < upper:
                                # This glyph in the margin is the manual's
                                # control-assignment mark, never parameter data.
                                if text == "2" and "RolandOwnersManual" in str(span.get("font", "")):
                                    continue
                                row_spans.append(span)
                            if in_marker_band(x, column) and abs(y - label["y"]) <= 8:
                                if text == "2" and "RolandOwnersManual" in str(span.get("font", "")):
                                    marker_found = True
                    # PDF uses slightly different baselines for bold and
                    # regular runs on one row. Cluster nearby baselines, then
                    # sort each text row left-to-right to retain range order.
                    row_spans.sort(key=lambda span: (float(span["bbox"][1]), float(span["bbox"][0])))
                    visual_rows: list[list[dict[str, Any]]] = []
                    for span in row_spans:
                        y = float(span["bbox"][1])
                        if visual_rows and abs(y - float(visual_rows[-1][0]["bbox"][1])) <= 0.8:
                            visual_rows[-1].append(span)
                        else:
                            visual_rows.append([span])
                    row_spans = [
                        span
                        for visual_row in visual_rows
                        for span in sorted(visual_row, key=lambda item: float(item["bbox"][0]))
                    ]
                    raw_value = " ".join(span_text(span) for span in row_spans)
                    raw_value = " ".join(raw_value.split())
                    if re.search(r"\b(Sets|Specifies|Adjusts|Selects|Produces|Creates|Gives|Transforms|Adds)\b", raw_value):
                        raise ValueError(
                            f"Value cell contains explanatory prose for {effect}.{label['name']} "
                            f"on guide page {page_index + 1}: {raw_value}"
                        )
                    bold_parts = [
                        span_text(span)
                        for span in row_spans
                        if "bold" in str(span.get("font", "")).lower()
                        and "semibold" not in str(span.get("font", "")).lower()
                    ]
                    default_raw = " ".join(" ".join(bold_parts).split()) or None
                    units = list(dict.fromkeys(re.findall(r"\b(kHz|Hz|dB|ms|sec|s|cm|OCT|OCTAVE)\b", raw_value, re.IGNORECASE)))
                    unit_families = {"kHz": "Hz", "Hz": "Hz", "sec": "ms", "s": "ms", "ms": "ms", "dB": "dB", "cm": "cm", "OCT": "OCT", "OCTAVE": "OCT"}
                    canonical_families = {unit_families[item] for item in units}
                    unit = next(iter(canonical_families)) if len(canonical_families) == 1 else ("mixed" if canonical_families else None)
                    numeric_tokens = re.findall(
                        r"(?<![A-Za-z])[-+]?\d+(?:\.\d+)?(?=\s*(?:(?:kHz|Hz|dB|ms|sec|s|cm|OCT|OCTAVE)\b)?\s*(?:[–—-]|,|$))",
                        raw_value,
                        re.IGNORECASE,
                    )
                    simple_numeric = len(numeric_tokens) >= 2
                    minimum = maximum = None
                    if simple_numeric and len(numeric_tokens) >= 2:
                        numeric_values = [float(token) for token in numeric_tokens]
                        scale_by_unit = {"kHz": 1000.0, "Hz": 1.0, "sec": 1000.0, "s": 1000.0, "ms": 1.0}
                        explicit_pairs = re.findall(r"([-+]?\d+(?:\.\d+)?)\s*(kHz|Hz|dB|ms|sec|s|cm|OCT|OCTAVE)\b", raw_value, re.IGNORECASE)
                        if explicit_pairs:
                            explicit_units = list(dict.fromkeys(unit_families[item] for _, item in explicit_pairs))
                            if len(explicit_units) == 1 and len({item for _, item in explicit_pairs}) > 1:
                                # Mixed source scales that share a base unit,
                                # e.g. 20 Hz–12.5 kHz, normalize each bound.
                                numeric_values = [float(value) * scale_by_unit.get(source_unit, 1.0) for value, source_unit in explicit_pairs]
                            elif len(explicit_pairs) == 1 and unit:
                                suffix = explicit_pairs[0][1]
                                scale = scale_by_unit.get(suffix, 1.0)
                                numeric_values = [value * scale for value in numeric_values]
                            elif len({item for _, item in explicit_pairs}) == 1 and len(explicit_pairs) == 1 and len(numeric_values) > 1:
                                suffix = explicit_pairs[0][1]
                                scale = scale_by_unit.get(suffix, 1.0)
                                numeric_values = [value * scale for value in numeric_values]
                        elif units:
                            suffix = units[-1]
                            scale = scale_by_unit.get(suffix, 1.0)
                            numeric_values = [value * scale for value in numeric_values]
                        minimum, maximum = min(numeric_values), max(numeric_values)
                    default_numeric: float | None = None
                    if default_raw and re.fullmatch(r"[-+]?\d+(?:\.\d+)?", default_raw):
                        default_numeric = float(default_raw)
                    if not raw_value:
                        value_kind = "not_extracted"
                    elif simple_numeric and (
                        "," in raw_value
                        or re.search(r"[A-Za-z]", re.sub(r"\b(?:kHz|Hz|dB|ms|sec|s|cm|OCT|OCTAVE)\b", "", raw_value, flags=re.IGNORECASE))
                    ):
                        value_kind = "choices_and_numeric_range"
                    elif minimum is not None:
                        value_kind = "numeric_range"
                    elif "," in raw_value:
                        value_kind = "choices"
                    else:
                        value_kind = "documented_value_unclassified"

                    found[effect].append(
                        {
                            "name": label["name"],
                            "variant": variant,
                            "rawValueDefinition": raw_value or None,
                            "valueKind": value_kind,
                            "minimum": minimum,
                            "maximum": maximum,
                            "unit": unit,
                            "units": units,
                            "defaultRaw": default_raw,
                            "defaultNumeric": default_numeric,
                            "defaultStatus": "extracted_from_bold_value" if default_raw else "null_not_recovered_from_bold_value",
                            "controlAssignable": marker_found,
                            "mappingCurve": None,
                            "mappingCurveStatus": "not specified in the official parameter guide; characterize before normalizing",
                            "guidePrintedPage": page_index + 1,
                        }
                    )

    missing = [name for name, parameters in found.items() if not parameters]
    if missing:
        raise ValueError(f"No official parameter rows extracted for effects: {', '.join(missing)}")

    # The printed parameter guide contains two Tape Echo modes and two Roll
    # modes; retain their distinct controls under one stable catalog entry.
    result = {
        "schemaVersion": "1.0.0",
        "source": {
            "title": "RC-505mkII Parameter Guide, Version 1.3 and later",
            "url": GUIDE_URL,
            "publisher": "Roland Corporation",
            "copyrightYear": 2021,
            "downloadedPdfSha256": digest,
            "extractedPdfPages": [34, 43],
            "extractionMethod": "PyMuPDF span/bbox parsing of the Parameter, Value, and Explanation cell bands; each parameter row extends from its label to the next label and preserves bold default spans.",
            "outputCellBoundsPoints": "Per page/column, value span x starts are read from the printed Value header and clipped before the Explanation header; row y bounds use the parameter label through the next label.",
            "extractionNote": "Parameter labels, setting text, bold defaults and control markers only; descriptive manual prose and audio assets are excluded.",
        },
        "effects": [
            {
                "effect": effect,
                "sections": [
                    {
                        "variant": params[0]["variant"],
                        "guidePrintedPage": params[0]["guidePrintedPage"],
                        "parameters": [
                            {key: value for key, value in row.items() if key not in {"variant", "guidePrintedPage"}}
                            for row in params
                            if row["variant"] == params[0]["variant"]
                        ],
                    }
                    for params in [[item for item in found[effect] if item["variant"] == variant]
                                   for variant in dict.fromkeys(item["variant"] for item in found[effect])]
                ],
            }
            for effect in effect_names
        ],
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="Path to the exact official guide PDF")
    parser.add_argument("--matrix", type=Path, default=Path(__file__).with_name("source") / "fx_algorithm_matrix.csv")
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("official_fx_parameters.json"))
    args = parser.parse_args()
    document = extract_parameter_sections(args.pdf, args.matrix)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    parameter_count = sum(len(section["parameters"]) for effect in document["effects"] for section in effect["sections"])
    print(f"Extracted {len(document['effects'])} FX schemas / {parameter_count} parameters to {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Parameter extraction failed: {exc}", file=sys.stderr)
        raise
