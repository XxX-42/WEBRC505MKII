#!/usr/bin/env python3
"""Validate metadata integrity and keep it separate from runtime qualification."""
from __future__ import annotations

import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "dsp" / "spec"
EXPECTED_SOURCE_HASHES = {
    "fx_algorithm_matrix.csv": "ee53f9034354fbdabbe8adedbceb482d131f3cec696fe295e6e12d498b1b0193",
    "rhythm_patterns_240.csv": "2b3fc5a271607b8b10046455bc11298ea0349ff8724eb489a9dc7e0257a75dae",
    "kits_16_algorithm_matrix.csv": "c684c32b1011b651a8221b94265be955282d48b461f9a9a8bfe98a5af89a62c5",
    "algorithm_class_selection.csv": "24fc091dc947f9f0e716a26a15972965bfdb69e485954bf933cb33a958a72ae1",
}
EXPECTED_TRACK_ONLY = {"BEAT SCATTER", "BEAT REPEAT", "BEAT SHIFT", "VINYL FLICK"}
EXPECTED_KITS = [
    "STUDIO", "LIVE", "LIGHT", "HEAVY", "ROCK", "METAL", "JAZZ", "BRUSH",
    "CAJON", "DRUM&BASS", "R&B", "DANCE", "TECHNO", "DANCE BEATS", "HIPHOP", "808+909",
]
EXPECTED_FORMULA_IDS = {f"F{index:02d}" for index in range(1, 30)}
FAILURES: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


def load_json(name: str):
    with (SPEC / name).open("r", encoding="utf-8") as stream:
        return json.load(stream)


def read_csv(path: Path):
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def find_forbidden_content(value, path="$", forbidden=None):
    forbidden = forbidden or {"notes", "midiEvents", "midiBytes", "velocityEvents", "audioData", "factoryMidi", "factorySamples"}
    if isinstance(value, dict):
        for key, child in value.items():
            if key in forbidden:
                FAILURES.append(f"Forbidden playable/asset payload field {path}.{key}")
            find_forbidden_content(child, f"{path}.{key}", forbidden)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            find_forbidden_content(child, f"{path}[{index}]", forbidden)


def main() -> int:
    # Source pinning: regeneration is reproducible only from the reviewed inputs.
    for name, expected in EXPECTED_SOURCE_HASHES.items():
        path = SPEC / "source" / name
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        require(actual == expected, f"Source SHA mismatch: {name}: {actual}")

    manifest = load_json("source_manifest.json")
    require(manifest["sourcePackage"]["inputFilesChecked"] == 36, "Expected 36 extracted source files checked")
    require(manifest["sourcePackage"]["inputFilesPassed"] == 36, "Expected all 36 extracted source files to pass SHA256SUMS")
    require(manifest["licenseReview"]["repositoryLicenseFound"] is False, "License status must remain unresolved in absence of root license")

    source_fx = read_csv(SPEC / "source" / "fx_algorithm_matrix.csv")
    fx = load_json("fx_catalog.json")
    effects = fx["effects"]
    fx_names = [row["effect"].strip() for row in source_fx]
    require(len(effects) == len(source_fx) == 53, "FX catalog must preserve all 53 source rows")
    require([entry["officialDisplayName"] for entry in effects] == fx_names, "FX order/names differ from source matrix")
    require(len({entry["id"] for entry in effects}) == 53, "FX stable IDs are not unique")
    input_effects = [entry for entry in effects if entry["availability"]["inputFx"]]
    track_effects = [entry for entry in effects if entry["availability"]["trackFx"]]
    track_only = {entry["officialDisplayName"] for entry in track_effects if not entry["availability"]["inputFx"]}
    require(len(input_effects) == 49, f"Expected 49 Input FX, found {len(input_effects)}")
    require(len(track_effects) == 53, f"Expected 53 Track FX, found {len(track_effects)}")
    require(track_only == EXPECTED_TRACK_ONLY, f"Unexpected Track-only FX: {sorted(track_only)}")
    target_states = {"not_implemented", "in_progress", "implemented_unqualified", "qualified"}
    qualification_states = {"not_qualified", "in_progress", "qualified"}
    for entry in effects:
        implementation = entry["implementation"]
        require(implementation["nativeTarget"] in target_states, f"Unknown Native target state for {entry['officialDisplayName']}")
        require(implementation["browserTarget"] in target_states, f"Unknown Browser target state for {entry['officialDisplayName']}")
        require(implementation["runtimeQualification"] in qualification_states, f"Unknown qualification state for {entry['officialDisplayName']}")
        if implementation["runtimeQualification"] == "qualified":
            require(bool(implementation.get("qualificationEvidence")), f"Qualified FX lacks evidence: {entry['officialDisplayName']}")
    require(all(entry["parameterContract"]["extractionStatus"] == "not_extracted" for entry in effects), "Parameter extraction status must remain not_extracted until reviewed")

    parameter_status = load_json("official_fx_parameters.json")
    require(parameter_status["extractionStatus"] == "not_extracted" and parameter_status["normative"] is False, "Official parameter data must remain explicitly incomplete")
    require(len(parameter_status["effects"]) == 53 and all(item["parameters"] == [] for item in parameter_status["effects"]), "Do not retain unverified PDF value extraction in the contract catalog")

    formulas = load_json("formula_index.json")
    formula_ids = {item["id"] for item in formulas["formulas"]}
    require(formula_ids == EXPECTED_FORMULA_IDS and formulas["count"] == 29, "Formula index must have exact F01-F29 set")
    for effect in effects:
        require(set(effect["formulaIds"]).issubset(formula_ids), f"Unknown formula reference in {effect['officialDisplayName']}")
    require(next(item for item in formulas["formulas"] if item["id"] == "F04")["implementationContract"]["recurrence"] == "y[n]=a*x[n]+x[n-1]-a*y[n-1]", "F04 corrected recurrence missing")

    source_rhythm = read_csv(SPEC / "source" / "rhythm_patterns_240.csv")
    rhythm = load_json("rhythm_index.json")
    patterns = rhythm["patterns"]
    require(len(patterns) == len(source_rhythm) == 240, "Rhythm index must preserve all 240 rows")
    require([item["ordinal"] for item in patterns] == list(range(1, 241)), "Rhythm ordinals must remain source global indexes 1..240")
    require(len({item["id"] for item in patterns}) == 240, "Rhythm stable IDs are not unique")
    names = [(item["genreDisplayName"], item["patternDisplayName"]) for item in patterns]
    duplicated = {key for key, count in Counter(names).items() if count > 1}
    require(duplicated == {("PUNK", "8BEAT6")}, f"Expected the documented PUNK 8BEAT6 duplicate to be preserved, found {duplicated}")
    counts = Counter(item["genreDisplayName"] for item in patterns)
    require(counts["GUIDE"] == 33 and counts["USER"] == 1 and sum(count for genre, count in counts.items() if genre not in {"GUIDE", "USER"}) == 206, "Rhythm categories must remain 206 preset + 33 GUIDE + 1 USER")
    require(all(item["playbackDataIncluded"] is False and item["midiIncluded"] is False and item["audioAssetsIncluded"] is False for item in patterns), "Rhythm catalog must remain metadata-only")
    require(all(item["playbackImplementation"] == "not_implemented" for item in patterns), "Rhythm playback cannot be catalog-qualified")
    find_forbidden_content(rhythm)

    source_kits = read_csv(SPEC / "source" / "kits_16_algorithm_matrix.csv")
    kits = load_json("kit_specs.json")
    kit_records = kits["kits"]
    require([item["officialDisplayName"] for item in kit_records] == EXPECTED_KITS, "Kit names/order do not match the 16-name source matrix")
    require(len(source_kits) == len(kit_records) == 16, "Kit catalog must preserve all 16 kit rows")
    require(len({item["id"] for item in kit_records}) == 16, "Kit stable IDs are not unique")
    require(all(item["audioAssets"] == [] and item["assetStatus"] == "not_implemented_no_assets" for item in kit_records), "Kit catalog must not claim assets/audio exist")
    require(all(item["legalAssetProvenance"] == "pending" and item["kitRuntimeStatus"] == "not_implemented" for item in kit_records), "Kit provenance/runtime must remain pending/unimplemented")
    find_forbidden_content(kits)

    gates = load_json("gates.json")["gates"]
    require([item["id"] for item in gates] == [f"Gate{index}" for index in range(8)], "Gate list must contain Gate0..Gate7 in order")
    require(gates[0]["status"] in {"ready_for_root_review", "passed_after_root_review"}, "Unknown Gate0 state")
    if gates[0]["status"] == "passed_after_root_review":
        require(bool(gates[0].get("rootReviewEvidence")), "Gate0 passed state must include root review evidence")
    for item in gates[1:]:
        require(item["status"] in {"not_passed", "in_progress", "passed"}, f"Unknown state for {item['id']}")
        if item["status"] == "passed":
            require(bool(item.get("evidence")), f"Passed gate lacks evidence: {item['id']}")

    status_rows = read_csv(ROOT / "docs" / "dsp" / "FX_IMPLEMENTATION_STATUS.csv")
    require(len(status_rows) == 53, "FX status table must contain 53 rows")
    for effect, row in zip(effects, status_rows):
        state = effect["implementation"]
        require(row["FX"] == effect["officialDisplayName"], "FX status rows must match catalog order")
        require(row["Native"] == state["nativeTarget"] and row["Browser"] == state["browserTarget"], f"FX status table disagrees with catalog for {row['FX']}")
        require(row["P99"] == state.get("p99", "not_measured") and row["Quality Tier"] == state.get("qualityTier", "unrated"), f"FX evidence table disagrees with catalog for {row['FX']}")

    if FAILURES:
        print("Catalog validation FAILED:")
        for failure in FAILURES:
            print(f" - {failure}")
        return 1
    print("Catalog validation PASS: 53 FX (49 Input, 53 Track, 4 Track-only), 240 metadata rows (206+33+1), 16 design-only kits, F01-F29, parameter extraction explicitly incomplete, evidence-gated runtime states.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
