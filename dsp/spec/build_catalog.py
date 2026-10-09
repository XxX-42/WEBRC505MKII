#!/usr/bin/env python3
"""Build clean-room metadata catalogs from the pinned research CSV matrices.

This script copies factual metadata and explicit research recommendations only.
It does not synthesize audio, invent MIDI notes, or mark implementation gates as
passed. Run from the repository root with: python dsp/spec/build_catalog.py
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
import re
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "dsp" / "spec"
SOURCE = SPEC / "source"

PACKAGE_ZIP_SHA256 = "c06b23502c7d49db5e69a15e00e3155107207e451f9f612bcf65ee8c29df9382"
PACKAGE_SHA256SUMS_SHA256 = "190E093C637AAB6036694FEE33821C38792153112D2A7BC1D9D129D2E5601E4B"
SOURCE_HASHES = {
    "fx_algorithm_matrix.csv": "ee53f9034354fbdabbe8adedbceb482d131f3cec696fe295e6e12d498b1b0193",
    "rhythm_patterns_240.csv": "2b3fc5a271607b8b10046455bc11298ea0349ff8724eb489a9dc7e0257a75dae",
    "kits_16_algorithm_matrix.csv": "c684c32b1011b651a8221b94265be955282d48b461f9a9a8bfe98a5af89a62c5",
    "algorithm_class_selection.csv": "24fc091dc947f9f0e716a26a15972965bfdb69e485954bf933cb33a958a72ae1",
}
OFFICIAL_GUIDE = {
    "title": "RC-505mkII Parameter Guide, Version 1.3 and later",
    "publisher": "Roland Corporation",
    "url": "https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf",
    "sha256": "6473e5d990849d3c083cd532764d2a17326c9db6d7068bbe54b1fee6397c289b",
    "scope": "Names and published control facts only; does not establish the internal DSP topology.",
}

FORMULAS = [
    ("F01", "Parameter smoothing and click-free switching"),
    ("F02", "RBJ biquad / static EQ"),
    ("F03", "TPT state-variable filter / fast modulation filter"),
    ("F04", "Phaser all-pass"),
    ("F05", "Fractional delay"),
    ("F06", "LFO and modulation"),
    ("F07", "Nonlinearity, ADAA and oversampling"),
    ("F08", "Compressor / limiter"),
    ("F09", "Pitch ratio and variable-speed read head"),
    ("F10", "YIN fundamental frequency detection"),
    ("F11", "TD-PSOLA / WSOLA"),
    ("F12", "Phase vocoder / STFT"),
    ("F13", "Vocoder"),
    ("F14", "Delay and stereo feedback matrix"),
    ("F15", "Granular / Roll / Scatter"),
    ("F16", "Slicer"),
    ("F17", "Feedback delay network"),
    ("F18", "Partitioned convolution"),
    ("F19", "Spectral freeze"),
    ("F20", "Sample-accurate rhythmic scheduling"),
    ("F21", "Equal-power panning"),
    ("F22", "Mid/Side"),
    ("F23", "WDF / virtual analog"),
    ("F24", "Drum synthesis / sample hybrid"),
    ("F25", "Reverse / segment crossfade"),
    ("F26", "Vinyl Flick inertia model"),
    ("F27", "Onset / Slow Gear"),
    ("F28", "Bit-depth / sample-rate reduction"),
    ("F29", "Ring modulation"),
]

TRACK_ONLY_IDS = {"BEAT SCATTER", "BEAT REPEAT", "BEAT SHIFT", "VINYL FLICK"}


def read_csv(name: str) -> list[dict[str, str]]:
    with (SOURCE / name).open("r", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def formula_index() -> dict[str, Any]:
    items = []
    for ident, title in FORMULAS:
        item: dict[str, Any] = {
            "id": ident,
            "title": title,
            "source": "research-input/CODEX_RC505_IMPLEMENTATION_PACKAGE/01_PRIMARY_RESEARCH_REPORT.md",
            "sourceAuthority": "research recommendation; not manufacturer implementation disclosure",
            "implementationStatus": "not_qualified_in_target_paths",
        }
        if ident == "F04":
            item["implementationContract"] = {
                "status": "corrected_against_source_report",
                "coefficient": "a=(tan(pi*fc/fs)-1)/(tan(pi*fc/fs)+1)",
                "recurrence": "y[n]=a*x[n]+x[n-1]-a*y[n-1]",
                "note": "The report's opposite-sign recurrence pairs with center Nyquist-fc for this coefficient; it is not the requested fc-centered all-pass. See RESEARCH_ERRATA.md.",
            }
        if ident == "F07":
            item["implementationContract"] = {
                "status": "corrected_against_benchmark_erratum",
                "adaaAntiderivative": "F(x)=0.75*x^2-0.125*x^4 for |x|<1; F(x)=|x|-0.375 for |x|>=1",
                "note": "The input is not clamped before integrating. The first-order divided difference has frequency-dependent small-signal group delay; zero whole-sample buffering does not mean literal zero delay.",
            }
        items.append(item)
    return {
        "schemaVersion": "1.0.0",
        "sourceReportSha256": "a5f7405ba231d9ecf3076d6f0175c5d6bb5a15f51ad8fad47939328e86b4841d",
        "count": len(items),
        "formulas": items,
        "qualification": "An index of candidate techniques; a formula being cataloged is not evidence of code, runtime support, quality, or a passed gate.",
    }


def build_fx(rows: list[dict[str, str]]) -> dict[str, Any]:
    previous: dict[str, dict[str, Any]] = {}
    previous_path = SPEC / "fx_catalog.json"
    if previous_path.exists():
        try:
            previous_doc = json.loads(previous_path.read_text(encoding="utf-8"))
            previous = {entry["id"]: entry for entry in previous_doc.get("effects", []) if "id" in entry}
        except (json.JSONDecodeError, KeyError, TypeError):
            previous = {}
    entries = []
    for row in rows:
        name = row["effect"].strip()
        effect_id = f"rc505mkii.fx.{slug(name)}"
        prior_implementation = previous.get(effect_id, {}).get("implementation", {})
        implementation = {
            "nativeTarget": "not_implemented",
            "browserTarget": "not_implemented",
            "runtimeQualification": "not_qualified",
            "qualificationEvidence": [],
            "p99": "not_measured",
            "latency": "not_measured",
            "qualityTier": "unrated",
        }
        implementation.update(prior_implementation)
        entries.append({
            "id": effect_id,
            "ordinal": int(row["index"]),
            "officialDisplayName": name,
            "availability": {
                "inputFx": row["available_as_input_fx"].lower() == "yes",
                "trackFx": row["available_as_track_fx"].lower() == "yes",
            },
            "family": row["family"],
            "researchFunctionalModel": row["functional_algorithm"],
            "recommendedNativeArchitecture": row["native_balanced_choice"],
            "recommendedBrowserArchitecture": row["browser_balanced_choice"],
            "formulaIds": [value.strip() for value in row["formula_ids"].split(",") if value.strip()],
            "researchLatencyEstimate": row["algorithmic_latency"],
            "evidenceStatusFromSource": row["evidence_status"],
            "parameterContract": {
                "officialGuide": OFFICIAL_GUIDE["url"],
                "guidePdfSha256": OFFICIAL_GUIDE["sha256"],
                "extractionArtifact": "official_fx_parameters.json",
                "extractionStatus": "not_extracted",
                "reason": "The current PDF text extractor has known column-boundary, wrapped-row, glyph, and default-detection errors. Values require geometry-aware review before use as an implementation contract.",
            },
            "implementation": implementation,
            "legacyPrototype": legacy_prototype(name),
        })
    return {
        "schemaVersion": "1.0.0",
        "sourceCsv": "dsp/spec/source/fx_algorithm_matrix.csv",
        "sourceCsvSha256": SOURCE_HASHES["fx_algorithm_matrix.csv"],
        "officialScope": "53 Track FX, of which 49 are also available as Input FX; four are Track-only.",
        "effects": entries,
    }


def legacy_prototype(name: str) -> dict[str, Any]:
    mapping = {
        "LPF": ["filter"], "BPF": ["filter"], "HPF": ["filter"], "EQ": ["filter"],
        "PHASER": ["phaser"], "DELAY": ["delay"], "REVERB": ["reverb"],
        "PATTERN SLICER": ["slicer"], "STEP SLICER": ["slicer"], "DYNAMICS": ["compressor"],
    }
    aliases = mapping.get(name, [])
    return {
        "prototypeAliases": aliases,
        "state": "partial_prototype_exists_not_product_implementation" if aliases else "no_matching_prototype_identified",
        "qualification": "Legacy WebAudio prototypes do not satisfy this effect's full official parameter, quality, realtime, or Native/Web parity requirements.",
    }


def build_rhythm(rows: list[dict[str, str]]) -> dict[str, Any]:
    patterns = []
    for row in rows:
        ordinal = int(row["global_index"])
        patterns.append({
            "id": f"rc505mkii.rhythm.{ordinal:03d}",
            "ordinal": ordinal,
            "genreDisplayName": row["genre"],
            "patternDisplayName": row["pattern"],
            "meterDisplay": row["beat"],
            "variationCount": int(row["variations"]),
            "introEndingFillAvailability": row["intro_ending_fill_engine"],
            "sourceNote": row["source_note"],
            "provenance": "metadata_only_from_research_csv",
            "playbackDataIncluded": False,
            "midiIncluded": False,
            "audioAssetsIncluded": False,
            "playbackImplementation": "not_implemented",
        })
    genre_counts: dict[str, int] = {}
    for pattern in patterns:
        genre = pattern["genreDisplayName"]
        genre_counts[genre] = genre_counts.get(genre, 0) + 1
    return {
        "schemaVersion": "1.0.0",
        "sourceCsv": "dsp/spec/source/rhythm_patterns_240.csv",
        "sourceCsvSha256": SOURCE_HASHES["rhythm_patterns_240.csv"],
        "count": len(patterns),
        "classificationCounts": {
            "presetPatterns": sum(count for genre, count in genre_counts.items() if genre not in {"GUIDE", "USER"}),
            "guidePatterns": genre_counts.get("GUIDE", 0),
            "userSlotMetadata": genre_counts.get("USER", 0),
        },
        "genreCounts": genre_counts,
        "duplicateDisplayNamesArePreserved": True,
        "patterns": patterns,
        "qualification": "This index records names, meter, variation count, and source metadata only. It contains no note events, factory MIDI, or factory drum audio; none of the patterns is playable yet.",
    }


def build_kits(rows: list[dict[str, str]]) -> dict[str, Any]:
    kits = []
    for row in rows:
        name = row["official_kit_name"].strip()
        kits.append({
            "id": f"rc505mkii.kit.{slug(name)}",
            "ordinal": int(row["index"]),
            "officialDisplayName": name,
            "researchTimbreTarget": row["target_timbre"],
            "researchNativeArchitecture": row["native_balanced_architecture"],
            "researchBrowserArchitecture": row["browser_balanced_architecture"],
            "formulaIds": [value.strip() for value in row["formula_ids"].split(",") if value.strip()],
            "sourceEvidenceStatus": row["evidence_status"],
            "legalAssetProvenance": "pending",
            "assetStatus": "not_implemented_no_assets",
            "audioAssets": [],
            "proceduralVoiceGenerator": "not_implemented",
            "kitRuntimeStatus": "not_implemented",
            "qualification": "Kit name is metadata. Timbre/architecture fields are research proposals; no samples, drum synthesis voices, or factory sounds are provided.",
        })
    return {
        "schemaVersion": "1.0.0",
        "sourceCsv": "dsp/spec/source/kits_16_algorithm_matrix.csv",
        "sourceCsvSha256": SOURCE_HASHES["kits_16_algorithm_matrix.csv"],
        "count": len(kits),
        "kits": kits,
        "assetPolicy": "Use only original procedural synthesis or samples with documented, redistributable licenses and per-asset provenance. Do not import factory RC-505mkII samples.",
    }


def build_official_parameter_status(fx_rows: list[dict[str, str]]) -> dict[str, Any]:
    effects = []
    for row in fx_rows:
        name = row["effect"].strip()
        variants = {"TAPE ECHO": ["TAPE ECHO1", "TAPE ECHO2"], "ROLL": ["ROLL1", "ROLL2"]}.get(name, [])
        effects.append({
            "effect": name,
            "sourcePageRange": [34, 43],
            "guideSectionLabels": variants or [name],
            "parameterExtractionStatus": "not_extracted",
            "parameters": [],
        })
    return {
        "schemaVersion": "1.0.0",
        "extractionStatus": "not_extracted",
        "normative": False,
        "source": OFFICIAL_GUIDE,
        "warning": "No setting values are included. The in-progress PDF extractor has known geometry/font failures and is fail-closed; do not infer ranges, choices, defaults, units, or parameter mappings from this file.",
        "effects": effects,
    }


def main() -> None:
    for filename, expected in SOURCE_HASHES.items():
        actual = sha256(SOURCE / filename)
        if actual != expected:
            raise SystemExit(f"Pinned input hash mismatch for {filename}: {actual}")

    fx = build_fx(read_csv("fx_algorithm_matrix.csv"))
    rhythm = build_rhythm(read_csv("rhythm_patterns_240.csv"))
    kits = build_kits(read_csv("kits_16_algorithm_matrix.csv"))
    formulas = formula_index()
    algorithm_rows = read_csv("algorithm_class_selection.csv")

    write_json(SPEC / "fx_catalog.json", fx)
    write_json(SPEC / "rhythm_index.json", rhythm)
    write_json(SPEC / "kit_specs.json", kits)
    write_json(SPEC / "official_fx_parameters.json", build_official_parameter_status(read_csv("fx_algorithm_matrix.csv")))
    write_json(SPEC / "formula_index.json", formulas)
    write_json(SPEC / "algorithm_selection.json", {
        "schemaVersion": "1.0.0",
        "sourceCsv": "dsp/spec/source/algorithm_class_selection.csv",
        "sourceCsvSha256": SOURCE_HASHES["algorithm_class_selection.csv"],
        "entries": algorithm_rows,
        "qualification": "Research recommendations only. Bench results cited by the input package are not accepted as product gates; see docs/dsp/RESEARCH_ERRATA.md.",
    })
    write_json(SPEC / "source_manifest.json", {
        "schemaVersion": "1.0.0",
        "sourcePackage": {
            "filename": "CODEX_RC505_IMPLEMENTATION_PACKAGE.zip",
            "sha256": PACKAGE_ZIP_SHA256,
            "sha256SumsFileSha256": PACKAGE_SHA256SUMS_SHA256,
            "inputFilesChecked": 36,
            "inputFilesPassed": 36,
            "verificationMethod": "SHA256SUMS.txt entries recomputed against each extracted file; ZIP CRC test also passed.",
        },
        "copiedCsvFiles": {name: {"path": f"dsp/spec/source/{name}", "sha256": digest} for name, digest in SOURCE_HASHES.items()},
        "officialGuide": OFFICIAL_GUIDE,
        "licenseReview": {
            "repositoryLicenseFound": False,
            "status": "unresolved",
            "note": "No root LICENSE/COPYING/NOTICE was found during Gate 0. Do not import or redistribute third-party DSP code, sample assets, factory MIDI, or audio without an explicit compatible license review.",
        },
    })
    with (ROOT / "docs" / "dsp" / "FX_IMPLEMENTATION_STATUS.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["FX", "Native", "Browser", "Algorithm", "Formula", "Tests", "P99", "Latency", "Quality Tier", "Remaining Risk"])
        for effect in fx["effects"]:
            implementation = effect["implementation"]
            writer.writerow([
                effect["officialDisplayName"],
                implementation["nativeTarget"],
                implementation["browserTarget"],
                effect["researchFunctionalModel"],
                ",".join(effect["formulaIds"]),
                ";".join(implementation.get("qualificationEvidence", [])) or "not_measured",
                implementation.get("p99", "not_measured"),
                implementation.get("latency", "not_measured"),
                implementation.get("qualityTier", "unrated"),
                "No qualified complete effect runtime; official parameter extraction unverified; Native/Web parity and deadline evidence absent",
            ])
    print(f"Built FX={len(fx['effects'])}, rhythm={len(rhythm['patterns'])}, kits={len(kits['kits'])}, formulas={formulas['count']} catalogs.")


if __name__ == "__main__":
    main()
