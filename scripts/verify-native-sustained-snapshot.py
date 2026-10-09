"""Independently verify archived inputs and chronological Native kernel timings."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()


def read(relative):
    path = (root / relative).resolve()
    path.relative_to(root)
    # Nested historical source copies can reach Windows' legacy MAX_PATH.
    if os.name == "nt":
        path = Path("\\\\?\\" + str(path))
    return path.read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


index = json.loads(read("archive-index.json"))
rows = index["sourceFiles"]
assert len(rows) == index["sourceArchiveFileCount"]
assert len({row["path"] for row in rows}) == len(rows)
for row in rows:
    data = read("source-snapshot/" + row["path"])
    assert len(data) == row["bytes"] and digest(data) == row["sha256"], row["path"]
for row in index["archiveFiles"]:
    data = read(row["path"])
    assert len(data) == row["bytes"] and digest(data) == row["sha256"], row["path"]


def source_set(entries):
    canonical = "\n".join(row["path"] + "=" + row["sha256"] for row in entries)
    return digest(canonical.encode("utf-8"))


assert source_set(rows) == index["sourceSnapshotFingerprintSha256"]
extensions = {".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ipp", ".inl", ".cmake"}
scripts = {"scripts/native-dsp-sustained-bench.ps1", "scripts/native-build-common.ps1"}
source_superset = [row for row in rows if Path(row["path"]).suffix in extensions
                   or Path(row["path"]).name == "CMakeLists.txt" or row["path"] in scripts]
assert source_set(source_superset) == index["benchmarkCppFingerprintSha256"]
reports = [row for row in index["archiveFiles"] if row["sha256"] == index["reportSha256"]]
assert len(reports) == 1
report = json.loads(read(reports[0]["path"]))
assert report["sourceFingerprintSha256"] == index["benchmarkCppFingerprintSha256"]
assert report["hostCallbackFrames"] == 64 and report["sampleRateHz"] == 48000
assert len(report["cases"]) == index["caseCount"] == 49
assert len({case["id"] for case in report["cases"]}) == 49
budget = report["hostCallbackBudgetNs"]
total = 0
overruns = 0
tails = []
for case in report["cases"]:
    assert case["processSucceeded"] and case["processOperatorNewCalls"] == 0
    cursor = 0
    assert [stage["name"] for stage in case["stages"]] == ["startup", "warmup", "steady", "flush"]
    for stage in case["stages"]:
        samples = stage["samplesNs"]
        assert stage["firstCallback"] == cursor
        assert stage["callbackCount"] == len(samples) == report["calls"][stage["name"]]
        assert all(type(value) is int and value >= 0 for value in samples)
        ordered = sorted(samples)
        summary = stage["summary"]
        for field, percentile in [("p50Ns", .5), ("p95Ns", .95), ("p99Ns", .99), ("p999Ns", .999)]:
            assert summary[field] == ordered[math.ceil(percentile * len(ordered)) - 1]
        assert summary["maxNs"] == max(samples)
        misses = sum(value > budget for value in samples)
        assert summary["overBudgetCallbacks"] == misses
        cursor += len(samples)
        total += len(samples)
        overruns += misses
        if stage["name"] == "steady" and misses:
            tails.append({"case": case["id"], "p99Ns": summary["p99Ns"],
                          "p999Ns": summary["p999Ns"], "maxNs": summary["maxNs"],
                          "overBudgetCallbacks": misses})
    assert cursor == case["callbacks"] == index["callbacksPerCase"]
assert index["processOperatorNewCalls"] == 0
print(json.dumps({"verification": "PASS", "sourceFiles": len(rows),
                  "sourceSupersetFiles": len(source_superset),
                  "archiveFiles": len(index["archiveFiles"]), "cases": 49,
                  "timingSamples": total, "allStageOverBudgetCalls": overruns,
                  "steadyOverBudgetCases": tails,
                  "scope": "archived standalone software kernels; no full-graph or hardware acceptance",
                  "runtimeGatesQualified": False}, indent=2))
