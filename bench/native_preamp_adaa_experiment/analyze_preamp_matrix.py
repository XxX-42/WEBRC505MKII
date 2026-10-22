#!/usr/bin/env python3
"""Compare paired PREAMP evaluation fixtures. Requires NumPy."""
import argparse
import csv
import json
from pathlib import Path

import numpy as np


def load_cases(raw_path: Path, metadata_path: Path) -> tuple[np.ndarray, list[list[str]]]:
    samples = np.fromfile(raw_path, dtype="<f4")
    with metadata_path.open(newline="") as f:
        rows = list(csv.reader(f, delimiter="\t"))
    expected = sum(int(row[7]) for row in rows)
    if expected != samples.size:
        raise ValueError(f"{raw_path}: metadata expects {expected} floats, found {samples.size}")
    return samples, rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-raw", type=Path, required=True)
    parser.add_argument("--baseline-tsv", type=Path, required=True)
    parser.add_argument("--candidate-raw", type=Path, required=True)
    parser.add_argument("--candidate-tsv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    base, base_rows = load_cases(args.baseline_raw, args.baseline_tsv)
    cand, cand_rows = load_cases(args.candidate_raw, args.candidate_tsv)
    if base_rows != cand_rows or base.size != cand.size:
        raise ValueError("baseline/candidate case layout mismatch")

    position = 0
    metrics = []
    for row in base_rows:
        kind, sample_rate, model, gain, bin_index, amplitude, dc, frame_count = row
        sr, n = int(sample_rate), int(frame_count)
        a = base[position : position + n].astype(np.float64)
        b = cand[position : position + n].astype(np.float64)
        position += n
        diff = b - a
        item = {
            "type": kind,
            "sample_rate": sr,
            "model": model,
            "gain": gain,
            "bin": int(bin_index),
            "amplitude": float(amplitude),
            "dc_offset": float(dc),
            "frames": n,
            "baseline_rms": float(np.sqrt(np.mean(a * a))),
            "candidate_rms": float(np.sqrt(np.mean(b * b))),
            "difference_rms": float(np.sqrt(np.mean(diff * diff))),
            "difference_peak": float(np.max(np.abs(diff))),
            "baseline_dc": float(np.mean(a)),
            "candidate_dc": float(np.mean(b)),
            "baseline_peak": float(np.max(np.abs(a))),
            "candidate_peak": float(np.max(np.abs(b))),
            "finite": bool(np.isfinite(a).all() and np.isfinite(b).all()),
        }
        if kind == "tone":
            baseline_spectrum = np.abs(np.fft.rfft(a)) * (2.0 / n)
            candidate_spectrum = np.abs(np.fft.rfft(b)) * (2.0 / n)
            k = int(bin_index)

            def folded_bin(harmonic: int) -> int:
                q = (harmonic * k) % n
                return min(q, n - q)

            direct_bins = {folded_bin(h) for h in range(1, 5) if h * k <= n // 2}
            alias_bins = {folded_bin(h) for h in range(5, 64) if folded_bin(h) > 0} - direct_bins
            item["baseline_f0"] = float(baseline_spectrum[k])
            item["candidate_f0"] = float(candidate_spectrum[k])
            item["baseline_harmonic_energy_2_to_4"] = float(
                sum(baseline_spectrum[folded_bin(h)] ** 2 for h in range(2, 5) if h * k <= n // 2)
            )
            item["candidate_harmonic_energy_2_to_4"] = float(
                sum(candidate_spectrum[folded_bin(h)] ** 2 for h in range(2, 5) if h * k <= n // 2)
            )
            item["baseline_folded_alias_energy_5_to_63"] = float(
                sum(baseline_spectrum[index] ** 2 for index in alias_bins)
            )
            item["candidate_folded_alias_energy_5_to_63"] = float(
                sum(candidate_spectrum[index] ** 2 for index in alias_bins)
            )
        metrics.append(item)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(metrics, indent=2) + "\n")
    total_difference = cand.astype(np.float64) - base.astype(np.float64)
    print(f"cases={len(metrics)} floats_per_version={base.size} finite={all(m['finite'] for m in metrics)}")
    print(
        "overall_difference_rms="
        f"{np.sqrt(np.mean(total_difference * total_difference)):.9g} "
        f"peak={np.max(np.abs(total_difference)):.9g}"
    )
    for kind in sorted({m["type"] for m in metrics}):
        rows = [m for m in metrics if m["type"] == kind]
        print(
            f"{kind}: cases={len(rows)} "
            f"max_per_case_difference_rms={max(m['difference_rms'] for m in rows):.9g} "
            f"max_difference_peak={max(m['difference_peak'] for m in rows):.9g}"
        )
    print(f"summary={args.output}")


if __name__ == "__main__":
    main()
