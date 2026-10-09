#!/usr/bin/env python3
"""Recompute and validate the chronological rhythm-capture metrics."""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def quantile(values: list[int], probability: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, math.ceil(probability * len(ordered)) - 1))
    return ordered[rank]


def distribution(values: list[int], p99_target: int, p999_target: int, budget: int) -> dict[str, int]:
    return {
        "count": len(values),
        "p99Ns": quantile(values, 0.99),
        "p999Ns": quantile(values, 0.999),
        "maxNs": max(values, default=0),
        "over60PercentBudget": sum(value > p99_target for value in values),
        "over80PercentBudget": sum(value > p999_target for value in values),
        "over100PercentBudget": sum(value > budget for value in values),
    }


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def summarize(raw_path: Path, coarse_cpu_path: Path | None) -> dict[str, Any]:
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    require(raw.get("schemaVersion") == "webrc-native-rhythm-bench-v2", "Unexpected rhythm benchmark schema")
    scenarios = raw.get("timingScenarios")
    require(isinstance(scenarios, list) and scenarios, "Timing scenario array is missing")
    summaries: list[dict[str, Any]] = []
    total_samples = 0
    for scenario in scenarios:
        samples = scenario.get("samplesChronological")
        require(isinstance(samples, list) and len(samples) == scenario.get("callbacks"),
                f"Missing chronological samples: {scenario.get('scenario')}/{scenario.get('blockFrames')}")
        block = int(scenario["blockFrames"])
        require(block in (64, 128, 256), "Unexpected callback block size")
        require(all(int(sample["frames"]) == block for sample in samples), "Mixed block sizes in one scenario")
        starts = [int(sample["frame"]) for sample in samples]
        require(all(right - left == block for left, right in zip(starts, starts[1:])),
                f"Non-contiguous timing frame sequence: {scenario.get('scenario')}")
        durations = [int(sample["durationNs"]) for sample in samples]
        p99_target = int(scenario["p99TargetNs"])
        p999_target = int(scenario["p999TargetNs"])
        budget = int(scenario["deadlineBudgetNs"])
        wall = distribution(durations, p99_target, p999_target, budget)
        for key in ("p99Ns", "p999Ns", "maxNs", "over60PercentBudget", "over80PercentBudget", "over100PercentBudget"):
            require(wall[key] == int(scenario[key]),
                    f"Recomputed wall {key} differs for {scenario.get('scenario')}/{block}")

        cpu_samples = [sample for sample in samples if sample.get("threadCpuTimingValid")]
        cpu_durations = [int(sample["threadCpuNs"]) for sample in cpu_samples]
        cpu = distribution(cpu_durations, p99_target, p999_target, budget)
        require(len(cpu_samples) == int(scenario["threadCpuValidSamples"]), "Valid thread CPU count mismatch")
        require(len(samples) - len(cpu_samples) == int(scenario["threadCpuTimingFailures"]),
                "Thread CPU failure count mismatch")
        for key, source_key in (("p99Ns", "threadCpuP99Ns"), ("p999Ns", "threadCpuP999Ns"),
                                ("maxNs", "threadCpuMaxNs")):
            require(cpu[key] == int(scenario[source_key]), f"Recomputed CPU {key} differs")

        calibration = raw.get("cycleCalibration", {})
        if calibration.get("valid"):
            scale = float(calibration["nsPerCycle"])
            for sample in cpu_samples:
                estimate = math.floor(int(sample["threadCpuCycles"]) * scale + 0.5)
                require(estimate == int(sample["threadCpuNs"]), "Per-callback cycle estimate mismatch")

        classes: dict[str, Any] = {}
        for flag in ("startup", "barBoundary", "eventCollision", "commandBoundary"):
            subset = [int(sample["durationNs"]) for sample in samples if sample.get(flag)]
            classes[flag] = distribution(subset, p99_target, p999_target, budget)
        summaries.append({
            "scenario": scenario["scenario"],
            "patternSource": scenario["patternSource"],
            "patternIndex": scenario["patternIndex"],
            "blockFrames": block,
            "callbackCount": len(samples),
            "wall": wall,
            "wallClasses": classes,
            "threadCpuOrCalibratedCycleEstimate": cpu,
            "threadCpuTimingFailures": int(scenario["threadCpuTimingFailures"]),
            "maxEventsTriggeredInOneCallback": int(scenario["maxEventsTriggeredInOneCallback"]),
            "maxActiveDrumVoices": int(scenario["maxActiveDrumVoices"]),
            "maxActiveBrushVoices": int(scenario["maxActiveBrushVoices"]),
            "maxRetiringBrushVoices": int(scenario["maxRetiringBrushVoices"]),
            "commandBoundaries": int(scenario["commandBoundaries"]),
            "fillCommands": int(scenario["fillCommands"]),
        })
        total_samples += len(samples)

    polyphony = raw.get("kitSustainedPolyphony", {})
    require(len(polyphony.get("kits", [])) == 16, "Sustained polyphony metrics must cover 16 kits")
    require(all(kit.get("finite") and kit.get("triggeredEvents") == 104 for kit in polyphony["kits"]),
            "Sustained polyphony event/finite checks failed")

    previous = None
    if coarse_cpu_path and coarse_cpu_path.is_file():
        previous = {
            "path": str(coarse_cpu_path),
            "sha256": sha256(coarse_cpu_path),
            "disposition": "Preserved only as evidence: per-callback GetThreadTimes deltas were quantized in 15.625 ms steps and are invalid for callback CPU quantiles.",
        }
    return {
        "schemaVersion": "webrc-native-rhythm-capture-summary-v1",
        "rawResultPath": str(raw_path),
        "rawResultSha256": sha256(raw_path),
        "totalChronologicalTimingSamples": total_samples,
        "timingSummaries": summaries,
        "cycleCalibration": raw.get("cycleCalibration"),
        "earlierWindowsCpuResolutionEvidence": previous,
        "kitSingleEventFeatureProxyMinima": [
            {"instrument": item["instrument"], "frames": item["frames"],
             "minNormalizedFeatureDistance": item["minNormalizedFeatureDistance"]}
            for item in raw.get("kitSingleEventFeatures", [])
        ],
        "kitSustainedPolyphony": polyphony,
        "brushOverlapQuality": raw.get("brushOverlap"),
        "realtimeInterpretation": "Wall-clock maxima and exceedances remain authoritative. Calibrated cycle-time CPU estimates are diagnostic only and subject to calibration error and DVFS/turbo/thermal/power-state variation. This isolated benchmark does not qualify hardware E2E or product Gate 1/7.",
        "audioMetricLimitation": "numeric spectral/envelope/transient proxies only; no perceptual or listening evaluation",
    }


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: summarize_native_rhythm_capture.py RAW.json SUMMARY.json [COARSE_CPU_EVIDENCE.json]")
    raw_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    coarse_path = Path(sys.argv[3]).resolve() if len(sys.argv) == 4 else None
    summary = summarize(raw_path, coarse_path)
    output_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"PASS: revalidated {summary['totalChronologicalTimingSamples']} callback samples across "
          f"{len(summary['timingSummaries'])} scenarios")
