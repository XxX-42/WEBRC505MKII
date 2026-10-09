#!/usr/bin/env python3
"""Offline metrics over the immutable Rubber Band capture; does not touch PCM inputs/outputs."""
import array
import csv
import hashlib
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RATE = 48000


def load_f32(path):
    data = array.array("f")
    with path.open("rb") as f:
        data.frombytes(f.read())
    if os.sys.byteorder != "little":
        data.byteswap()
    if len(data) % 2:
        raise ValueError(f"not stereo PCM: {path}")
    return data


def channel(data, which):
    return data[which::2]


def window_rms(x, begin, end):
    begin = max(0, begin)
    end = min(len(x), end)
    if end <= begin:
        return 0.0
    return math.sqrt(sum(float(v) * float(v) for v in x[begin:end]) / (end - begin))


def activity_bounds(left, right, first, end, threshold):
    hop = 120  # 2.5 ms envelope steps
    active = []
    for p in range(first, min(end, max(len(left), len(right))), hop):
        n = min(hop, len(left) - p, len(right) - p)
        if n <= 0:
            break
        rms = math.sqrt(
            (sum(float(v) * float(v) for v in left[p:p+n]) +
             sum(float(v) * float(v) for v in right[p:p+n])) / (2*n)
        )
        if rms >= threshold:
            active.append((p, rms))
    if not active:
        return {"firstFrame": None, "lastFrameExclusive": None, "activeSteps": 0}
    return {
        "firstFrame": active[0][0],
        "lastFrameExclusive": min(end, active[-1][0] + hop),
        "activeSteps": len(active),
    }


def transient_peak(left, right, frame, radius):
    lo, hi = max(0, frame-radius), min(max(len(left), len(right)), frame+radius)
    peak = 0.0
    peak_frame = lo
    for p in range(lo, hi):
        a = abs(float(left[p])) if p < len(left) else 0.0
        b = abs(float(right[p])) if p < len(right) else 0.0
        v = max(a, b)
        if v > peak:
            peak, peak_frame = v, p
    return {"peakFrame": peak_frame, "peakAbs": peak, "offsetFrames": peak_frame-frame}


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024*1024), b""):
            h.update(part)
    return h.hexdigest()


def verify_existing_sums():
    sums = ROOT / "SHA256SUMS.txt"
    if not sums.exists():
        return 0
    checked = 0
    for line in sums.read_text(encoding="ascii").splitlines():
        expected, rel = line.split("  ", 1)
        if sha(ROOT / Path(rel.replace("/", os.sep))) != expected:
            raise ValueError(f"pre-analysis checksum mismatch: {rel}")
        checked += 1
    return checked


def main():
    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    old_sums_checked = verify_existing_sums()
    results = [json.loads(line) for line in (ROOT/"results"/"results.jsonl").read_text(encoding="utf-8").splitlines() if line]
    reference = [json.loads(line) for line in (ROOT/"results"/"signalsmith-reference-metrics.jsonl").read_text(encoding="utf-8").splitlines() if line]
    by_id = {r["id"]: r for r in results}

    # Same exact input and archived 0.5x output, measured by the evaluator's own fitter.
    pairs = []
    refs = {r["scene"]: r for r in reference}
    for hz in (55, 110, 220, 880):
        ref = refs[f"tone{hz}"]
        for engine in ("R2", "R3"):
            for block in (64, 128, 256):
                r = by_id[f"{engine}-b{block}-tone{hz}-p0.50"]
                pairs.append({
                    "scene": f"tone{hz}",
                    "engine": engine,
                    "blockFrames": block,
                    "signalSmithReference": {
                        "leftMeasuredHz": ref["leftMeasuredHz"],
                        "rightMeasuredHz": ref["rightMeasuredHz"],
                        "leftTargetAmplitude": ref["leftTargetAmplitude"],
                        "rightTargetAmplitude": ref["rightTargetAmplitude"],
                    },
                    "rubberBand": {
                        "leftMeasuredHz": r["leftMeasuredHz"],
                        "rightMeasuredHz": r["rightMeasuredHz"],
                        "leftTargetAmplitude": r["leftTargetAmplitude"],
                        "rightTargetAmplitude": r["rightTargetAmplitude"],
                        "alignedDurationErrorFrames": r["alignedDurationErrorFrames"],
                    },
                    "measuredFrequencyDifferenceHz": {
                        "leftRubberBandMinusSignalSmith": r["leftMeasuredHz"]-ref["leftMeasuredHz"],
                        "rightRubberBandMinusSignalSmith": r["rightMeasuredHz"]-ref["rightMeasuredHz"],
                    },
                })
    comparison = {
        "schemaVersion": 1,
        "method": "paired 48 kHz stereo PCM; same archived input file; same Hann-windowed least-squares sinusoid projection fitter; 1.0–2.5 s from delay-aligned output; only stored Signalsmith 0.5x PCM is comparable",
        "limitations": ["No archived Signalsmith 0.25x PCM is present.", "Signalsmith archive did not capture callback timing distributions.", "No listening panel or hardware callback test was run."],
        "pairs": pairs,
    }
    comparison_path = ROOT/"results"/"signalsmith-rubberband-tone-comparison.json"
    comparison_path.write_text(json.dumps(comparison, indent=2)+"\n", encoding="utf-8")

    # Input and shifted output activity envelopes and transients; keep the chosen threshold explicit.
    gate_input = load_f32(ROOT/"data"/"input-gated-transient-3s.f32le")
    in_l, in_r = channel(gate_input, 0), channel(gate_input, 1)
    # Output files are preserved before trimming. For activity comparisons, use the API's
    # documented start-delay removal; preferred pad remains a separate reported fact.
    gate_records = []
    for r in results:
        if r["sceneKind"] != "gated_tones_and_transients":
            continue
        output = load_f32(ROOT/"results"/(r["id"]+"-raw.f32le"))
        out_l, out_r = channel(output, 0), channel(output, 1)
        delay = r["reportedStartDelay"]
        aligned_l, aligned_r = out_l[delay:], out_r[delay:]
        windows = []
        for begin, end in ((12000, 40800), (60000, 91200)):
            in_peak = max(window_rms(in_l, begin, min(begin+480, end)), window_rms(in_r, begin, min(begin+480, end)))
            local_start = max(0, begin-4800)
            local_end = min(len(aligned_l), end+9600)
            local_peak = max((window_rms(aligned_l, p, min(p+480, local_end)) for p in range(local_start, local_end, 480)), default=0.0)
            threshold = max(0.025, local_peak*0.10)
            bounds = activity_bounds(aligned_l, aligned_r, local_start, local_end, threshold)
            windows.append({
                "expectedInputStartFrame": begin,
                "expectedInputEndFrameExclusive": end,
                "inputLocalRmsAtStart": in_peak,
                "outputThresholdRms": threshold,
                "outputActivity": bounds,
                "outputStartErrorFrames": None if bounds["firstFrame"] is None else bounds["firstFrame"]-begin,
                "outputEndErrorFrames": None if bounds["lastFrameExclusive"] is None else bounds["lastFrameExclusive"]-end,
            })
        clicks = [transient_peak(aligned_l, aligned_r, event, 2400) for event in (12000, 60000, 105600)]
        gate_records.append({
            "runId": r["id"],
            "engine": r["engine"],
            "blockFrames": r["blockFrames"],
            "pitchScale": r["pitchScale"],
            "startPadFrames": r["preferredStartPad"],
            "startDelayFramesRemoved": delay,
            "inputFrames": r["inputFrames"],
            "alignedOutputFrames": r["alignedOutputFrames"],
            "alignedDurationErrorFrames": r["alignedDurationErrorFrames"],
            "noteActivityWindows": windows,
            "clickEventFrames": [12000,60000,105600],
            "clickPeaksAfterStartDelayTrim": clicks,
            "alignedStereoRms": r["alignedRms"],
            "alignedPeak": r["alignedPeak"],
        })
    gate_path = ROOT/"results"/"gated-transient-envelope-metrics.json"
    gate_path.write_text(json.dumps({
        "schemaVersion": 1,
        "sampleRate": RATE,
        "fixture": "deterministic-gated-two-note-plus-three-decaying-noise-clicks",
        "envelope": {"hopFrames": 120, "windowFrames": 120, "thresholdRule": "per-note 10% of local output peak RMS, minimum 0.025"},
        "alignment": "remove Rubber Band getStartDelay as documented; preferred start pad recorded separately",
        "records": gate_records,
    }, indent=2)+"\n", encoding="utf-8")

    # Retain a corrected scope description: archived tone inputs are six seconds; synthetic
    # gated/impulse fixtures are three seconds.
    scope = manifest["scope"]
    scope.pop("inputFrames", None)
    scope["inputFramesByScene"] = {"archivedStereoTones": 288000, "generatedGatedTransient": 144000, "generatedImpulse": 144000}
    scope["postCaptureAnalysis"] = {
        "script": "eval-src/postprocess.py",
        "scriptSha256": sha(Path(__file__)),
        "preAnalysisChecksumsVerified": old_sums_checked,
        "pairedToneComparison": "results/signalsmith-rubberband-tone-comparison.json",
        "gatedTransientEnvelopeMetrics": "results/gated-transient-envelope-metrics.json",
    }
    manifest["scope"] = scope
    manifest["analysisArtifacts"] = [
        {"path": comparison_path.relative_to(ROOT).as_posix(), "bytes": comparison_path.stat().st_size, "sha256": sha(comparison_path)},
        {"path": gate_path.relative_to(ROOT).as_posix(), "bytes": gate_path.stat().st_size, "sha256": sha(gate_path)},
    ]
    # Re-index the final immutable tree after adding derived analysis, excluding self-indexing files.
    artifacts = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.name in {"SHA256SUMS.txt", "manifest.json"}:
            continue
        artifacts.append({"path": path.relative_to(ROOT).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)})
    manifest["artifacts"] = artifacts
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+"\n", encoding="utf-8")
    sums = []
    for path in sorted(ROOT.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS.txt":
            sums.append(f"{sha(path)}  {path.relative_to(ROOT).as_posix()}")
    (ROOT/"SHA256SUMS.txt").write_text("\n".join(sums)+"\n", encoding="ascii")
    print(f"PAIRED_TONE_COMPARISONS={len(pairs)} GATED_RUNS={len(gate_records)}")
    print(f"PRE_ANALYSIS_SHA256_ENTRIES_VERIFIED={old_sums_checked} FINAL_ARTIFACTS={len(artifacts)}")


if __name__ == "__main__":
    main()
