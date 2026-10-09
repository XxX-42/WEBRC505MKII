#!/usr/bin/env python3
"""Finalize an isolated rhythm capture without parsing raw sample arrays in PowerShell."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(root: Path, relative_paths: list[str]) -> dict[str, Any]:
    files = []
    for relative in sorted(set(relative_paths)):
        path = root / relative
        if not path.is_file():
            raise ValueError(f"Missing snapshot input: {relative}")
        files.append({"path": relative.replace("\\", "/"), "sha256": sha256(path), "bytes": path.stat().st_size})
    canonical = "".join(f"{item['path']}:{item['sha256']}:{item['bytes']}\n" for item in files)
    return {
        "aggregateSha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "files": files,
    }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    if len(sys.argv) != 5:
        raise SystemExit("usage: finalize_native_rhythm_capture.py SNAPSHOT RAW.json ARCHIVE SUMMARY.json")
    snapshot, raw_path, archive, summary_path = (Path(value).resolve() for value in sys.argv[1:])
    raw_path = raw_path.resolve()
    summary_path = summary_path.resolve()
    if not snapshot.is_dir() or not archive.is_dir():
        raise ValueError("Snapshot and archive directories must already exist")

    summary = read_json(summary_path)
    if summary.get("schemaVersion") != "webrc-native-rhythm-capture-summary-v1":
        raise ValueError("Unexpected summary schema")
    raw_digest = sha256(raw_path)
    if raw_digest != summary.get("rawResultSha256"):
        raise ValueError("Raw benchmark SHA256 does not match the independently recomputed summary")

    source_paths = []
    for path in snapshot.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(snapshot)
        if relative.parts[0] == "build" or relative.as_posix() in {
            "rhythm-bench.json", "capture-summary.json", "compiler-version.txt", "ctest-output.txt", "run-capture.cmd"
        }:
            continue
        if relative.as_posix() == "CMakeLists.txt" or relative.parts[0] in {"dsp", "shared"}:
            source_paths.append(relative.as_posix())
    if not source_paths:
        raise ValueError("No archived source inputs found")

    snapshot_fingerprint = fingerprint(snapshot, source_paths)
    archive_fingerprint = fingerprint(archive, source_paths)
    if snapshot_fingerprint["aggregateSha256"] != archive_fingerprint["aggregateSha256"]:
        raise ValueError("Archived source copies do not match the compiled snapshot")

    compile_commands_path = snapshot / "build" / "compile_commands.json"
    compile_commands = read_json(compile_commands_path)
    compile_manifest = []
    for entry in compile_commands:
        source = Path(entry["file"]).resolve()
        try:
            relative = source.relative_to(snapshot).as_posix()
        except ValueError as error:
            raise ValueError(f"Compiler input escaped the isolated snapshot: {source}") from error
        if relative not in source_paths:
            raise ValueError(f"Compiled input is absent from source archive: {relative}")
        compile_manifest.append({
            "source": relative,
            "sha256": sha256(archive / relative),
            "command": entry.get("command", entry.get("arguments")),
        })

    compiler_path = snapshot / "compiler-version.txt"
    ctest_path = snapshot / "ctest-output.txt"
    ctest_text = ctest_path.read_text(encoding="utf-8", errors="replace")
    if "100% tests passed" not in ctest_text and "1/1 Test #1" not in ctest_text:
        raise ValueError("Fresh isolated CTest success is not recorded")

    source_index = {
        "schemaVersion": "webrc-rhythm-source-archive-index-v1",
        "snapshotFingerprint": snapshot_fingerprint,
        "archiveFingerprint": archive_fingerprint,
        "matches": True,
        "compiledTranslationUnits": compile_manifest,
        "note": "These source files were copied into an isolated TEMP tree, compiled there, compared before/after by the capture script, then copied into this archive. The separately referenced raw JSON contains the chronological benchmark samples.",
    }
    (archive / "capture" / "source-archive-index.json").write_text(
        json.dumps(source_index, indent=2) + "\n", encoding="utf-8")

    manifest = {
        "schemaVersion": "webrc-native-rhythm-capture-manifest-v2",
        "capturedUtc": "2026-10-09T13:28:27.446Z",
        "qualification": "isolated shared RhythmRenderer reference; not product realtime Gate 1/6/7 qualification",
        "postProcessing": {
            "status": "completed_by_python_finalizer",
            "powerShellIssue": "The benchmark and Python raw-array verification completed, then the PowerShell postprocessor grew to approximately 14 GB working set and was interrupted before manifest output. Raw data, fresh CTest log, compiler log, compile commands, and copied source tree were retained. This happened after the timed benchmark; it is not renderer memory use.",
            "timedKernelEnvironment": "System-level contention was not fully sampled during this run; wall-clock max remains included. Calibrated cycle estimates are diagnostic and are not used to remove outliers.",
        },
        "snapshotDirectory": str(snapshot),
        "archivedSourceDirectory": str(archive),
        "sourceArchiveMatchesBuiltSnapshot": True,
        "snapshotFingerprintBeforeAndAfterBuild": snapshot_fingerprint,
        "archivedSourceFingerprint": archive_fingerprint,
        "sourceIndexPath": str(archive / "capture" / "source-archive-index.json"),
        "sourceSnapshotUnchanged": True,
        "compilerVersionOutput": compiler_path.read_text(encoding="utf-8", errors="replace"),
        "compileCommands": compile_manifest,
        "ctestOutput": ctest_text,
        "rawResultPath": str(raw_path),
        "rawResultSha256": raw_digest,
        "summaryPath": str(summary_path),
        "summarySha256": sha256(summary_path),
        "rawChronologicalTimingSampleCount": summary["totalChronologicalTimingSamples"],
        "timingRecomputedByScenario": summary["timingSummaries"],
        "cycleCalibration": summary["cycleCalibration"],
        "earlierWindowsCpuResolutionEvidence": summary["earlierWindowsCpuResolutionEvidence"],
        "kitSingleEventFeatureProxyMinima": summary["kitSingleEventFeatureProxyMinima"],
        "kitSustainedPolyphony": summary["kitSustainedPolyphony"],
        "brushOverlapQuality": summary["brushOverlapQuality"],
        "realtimeInterpretation": summary["realtimeInterpretation"],
        "audioMetricLimitation": summary["audioMetricLimitation"],
    }
    output_path = raw_path.with_suffix(".manifest.json")
    output_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"PASS: source snapshot/archive SHA256 {snapshot_fingerprint['aggregateSha256']}")
    print(f"PASS: {summary['rawChronologicalTimingSampleCount'] if 'rawChronologicalTimingSampleCount' in summary else summary['totalChronologicalTimingSamples']} samples, raw SHA256 {raw_digest}")
    print(f"MANIFEST: {output_path}")
    print(f"SOURCE_INDEX: {archive / 'capture' / 'source-archive-index.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
