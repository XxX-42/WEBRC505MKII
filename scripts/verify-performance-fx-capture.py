"""Verify an archived BeatRepeat event-burst capture; no whole-graph qualification."""
import hashlib
import json
import math
import sys
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def verify(raw_path):
    raw_path = Path(raw_path).resolve()
    manifest = load(raw_path.with_suffix(".manifest.json"))
    raw = load(raw_path)
    assert manifest["schemaVersion"] == "webrc-performance-fx-eventburst-manifest-v1"
    assert raw["schemaVersion"] == "webrc-performance-fx-eventburst-v1"
    assert digest(raw_path.read_bytes()) == manifest["rawResultSha256"]
    snapshot = raw_path.with_suffix(".snapshot")
    reference = manifest["copiedInputFingerprintBefore"]
    for name in ("copiedInputFingerprintAfter", "originalInputFingerprintBefore",
                 "originalInputFingerprintAfter", "archivedInputFingerprint"):
        assert manifest[name] == reference, name
    canonical = []
    seen = set()
    for row in reference["files"]:
        relative = Path(row["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        assert row["path"] not in seen
        seen.add(row["path"])
        data = (snapshot / relative).read_bytes()
        assert len(data) == row["bytes"] and digest(data) == row["sha256"], row["path"]
        canonical.append(f'{row["path"]}:{row["sha256"]}:{row["bytes"]}\n')
    assert len(seen) == 6
    assert digest("".join(canonical).encode("utf-8")) == reference["aggregateSha256"]
    callbacks = raw["rawChronologicalCallbackWallNs"]
    count = raw["callbackCount"]
    assert count == 20000 and len(callbacks) == count
    assert all(type(value) is int and value >= 0 for value in callbacks)
    assert raw["sampleRate"] == 48000 and raw["blockFrames"] == 64
    assert raw["deadlineBudgetNs"] == 64 * 1_000_000_000 // 48000
    assert raw["over60TargetNs"] == 800000 and raw["over80TargetNs"] == 1066666
    summary = raw["wallTimingSummary"]
    for key, fraction in (("p50Ns", .5), ("p99Ns", .99), ("p999Ns", .999)):
        assert summary[key] == percentile(callbacks, fraction), key
    assert summary["maxNs"] == max(callbacks)
    for percent, threshold in ((60, raw["over60TargetNs"]),
                               (80, raw["over80TargetNs"]),
                               (100, raw["deadlineBudgetNs"])):
        key = f"over{percent}PercentBudget"
        assert summary[key] == sum(value > threshold for value in callbacks)
        assert manifest[key] == summary[key]
    for key, raw_key in (("callbackP99Ns", "p99Ns"),
                         ("callbackP999Ns", "p999Ns"), ("callbackMaxNs", "maxNs")):
        assert manifest[key] == summary[raw_key]
    timer = raw["steadyClockPairOnlyNs"]
    timer_values = timer["rawChronologicalNs"]
    assert len(timer_values) == count
    assert all(type(value) is int and value >= 0 for value in timer_values)
    assert timer["p50Ns"] == percentile(timer_values, .5)
    assert timer["p99Ns"] == percentile(timer_values, .99)
    assert timer["maxNs"] == max(timer_values)
    assert raw["eventCountPerCallback"] == 64 and raw["eventsPerSample"] == 1
    assert raw["processorFailures"] == 0
    assert raw["maximumRepeatFramesCopiedPerCallback"] <= 64
    assert raw["maximumRepeatFramesCopiedPerCallback"] == manifest["repeatFramesCopiedPerCallbackMax"]
    assert 0 <= raw["totalRepeatFramesCopied"] <= count * 64
    return {"verified": True, "sourceFiles": len(seen), "callbacks": count,
            "sourceFingerprint": reference["aggregateSha256"],
            "wallTimingSummary": summary, "wholeGraphQualified": False,
            "scope": "Isolated BeatRepeat control burst; reported copy high-water is aggregate only."}


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1]), indent=2))
