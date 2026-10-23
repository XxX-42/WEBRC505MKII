"""Compare a short reference WAV and a captured WAV with explicit metric availability."""
from __future__ import annotations

import argparse
import json
import math
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
from scipy import signal
from scipy.io import wavfile

from parity_common import available, ensure_external_path, sha256_file, unavailable, write_json


def read_wav(path: Path) -> tuple[int, np.ndarray, str]:
    sample_rate, raw = wavfile.read(path)
    encoding = str(raw.dtype)
    if raw.ndim == 1:
        raw = raw[:, None]
    if raw.dtype == np.uint8:
        samples = (raw.astype(np.float64) - 128.0) / 128.0
    elif np.issubdtype(raw.dtype, np.signedinteger):
        samples = raw.astype(np.float64) / float(2 ** (raw.dtype.itemsize * 8 - 1))
    elif np.issubdtype(raw.dtype, np.floating):
        samples = raw.astype(np.float64)
    else:
        raise ValueError(f"unsupported WAV sample dtype {raw.dtype}: {path}")
    if not np.isfinite(samples).all():
        raise ValueError(f"WAV contains NaN or infinite samples: {path}")
    return int(sample_rate), samples, encoding


def _mono(samples: np.ndarray) -> np.ndarray:
    return samples[:, int(np.argmax(np.mean(np.square(samples), axis=0)))].astype(np.float64)


def _db(value: float, floor: float = 1e-15) -> float:
    return 20.0 * math.log10(max(float(value), floor))


def _rms(samples: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)))) if samples.size else 0.0


def _estimate_lag(reference: np.ndarray, capture: np.ndarray, max_lag_samples: int) -> tuple[int | None, float | None]:
    r = _mono(reference)
    c = _mono(capture)
    if r.size < 8 or c.size < 8 or _rms(r) < 1e-12 or _rms(c) < 1e-12:
        return None, None
    r = r - np.mean(r)
    c = c - np.mean(c)
    corr = signal.correlate(c, r, mode="full", method="fft")
    lags = signal.correlation_lags(c.size, r.size, mode="full")
    valid = np.abs(lags) <= max_lag_samples
    if not np.any(valid):
        return None, None
    local_indices = np.flatnonzero(valid)
    selected = local_indices[int(np.argmax(np.abs(corr[valid])))]
    lag = int(lags[selected])
    if lag >= 0:
        r0, c0 = 0, lag
    else:
        r0, c0 = -lag, 0
    n = min(r.size - r0, c.size - c0)
    if n <= 0:
        return None, None
    rr = r[r0:r0 + n]
    cc = c[c0:c0 + n]
    denom = float(np.linalg.norm(rr) * np.linalg.norm(cc))
    score = float(np.dot(rr, cc) / denom) if denom else None
    return lag, score


def _aligned(reference: np.ndarray, capture: np.ndarray, lag: int) -> tuple[np.ndarray, np.ndarray]:
    if lag >= 0:
        r0, c0 = 0, lag
    else:
        r0, c0 = -lag, 0
    n = min(reference.shape[0] - r0, capture.shape[0] - c0)
    if n <= 0:
        return reference[:0], capture[:0]
    return reference[r0:r0 + n], capture[c0:c0 + n]


def _spectral_bands(reference: np.ndarray, capture: np.ndarray, sample_rate: int) -> dict[str, Any]:
    if _rms(reference) < 1e-12:
        return unavailable("reference is silent")
    nperseg = min(8192, reference.shape[0])
    if nperseg < 256:
        return unavailable("fewer than 256 aligned samples")
    ref_mono, cap_mono = _mono(reference), _mono(capture)
    freqs, ref_psd = signal.welch(ref_mono, sample_rate, nperseg=nperseg, detrend="constant")
    _, cap_psd = signal.welch(cap_mono, sample_rate, nperseg=nperseg, detrend="constant")
    nyquist = sample_rate / 2
    edges = np.geomspace(31.5, min(16000.0, nyquist), 13)
    bands = []
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (freqs >= low) & (freqs < high)
        if not mask.any():
            continue
        ref_power = float(np.mean(ref_psd[mask]))
        cap_power = float(np.mean(cap_psd[mask]))
        bands.append({"low_hz": float(low), "high_hz": float(high), "relative_level_db": _db(math.sqrt(cap_power / max(ref_power, 1e-30)))})
    return available(bands, method="Welch PSD, 12 logarithmic bands") if bands else unavailable("no FFT bins fell inside requested bands")


def _stereo_metrics(reference: np.ndarray, capture: np.ndarray, stimulus_name: str) -> dict[str, Any]:
    if reference.shape[1] < 2 or capture.shape[1] < 2:
        return {"status": "unavailable", "reason": "both reference and capture must have at least two channels"}
    ref_lr = reference[:, :2]
    cap_lr = capture[:, :2]
    ref_left, ref_right = _rms(ref_lr[:, 0]), _rms(ref_lr[:, 1])
    cap_left, cap_right = _rms(cap_lr[:, 0]), _rms(cap_lr[:, 1])
    if min(ref_left, ref_right) > 1e-12:
        ref_balance = _db(ref_right / ref_left)
    else:
        ref_balance = None
    if min(cap_left, cap_right) > 1e-12:
        cap_balance = _db(cap_right / cap_left)
    else:
        cap_balance = None
    ref_corr = float(np.corrcoef(ref_lr.T)[0, 1]) if ref_left > 1e-12 and ref_right > 1e-12 else None
    cap_corr = float(np.corrcoef(cap_lr.T)[0, 1]) if cap_left > 1e-12 and cap_right > 1e-12 else None
    result: dict[str, Any] = {
        "reference_channel_balance_right_minus_left_db": available(ref_balance) if ref_balance is not None else unavailable("one reference channel is silent"),
        "capture_channel_balance_right_minus_left_db": available(cap_balance) if cap_balance is not None else unavailable("one capture channel is silent"),
        "reference_interchannel_correlation": available(ref_corr) if ref_corr is not None else unavailable("one reference channel is silent"),
        "capture_interchannel_correlation": available(cap_corr) if cap_corr is not None else unavailable("one capture channel is silent"),
        "channel_balance_change_db": available(cap_balance - ref_balance) if cap_balance is not None and ref_balance is not None else unavailable("channel balance requires non-silent left and right channels"),
        "cross_talk_db": unavailable("cross-talk ratio applies only to l_only or r_only fixtures"),
    }
    if stimulus_name == "l_only" and cap_left > 1e-12:
        result["cross_talk_db"] = available(_db(cap_right / cap_left), measured_channel="right relative to driven left")
    elif stimulus_name == "r_only" and cap_right > 1e-12:
        result["cross_talk_db"] = available(_db(cap_left / cap_right), measured_channel="left relative to driven right")
    return result


def _pitch_track(samples: np.ndarray, sample_rate: int, min_hz: float = 60, max_hz: float = 1400) -> tuple[np.ndarray, np.ndarray]:
    mono = _mono(samples)
    frame_len = min(max(8192, int(sample_rate * 0.25)), len(mono))
    if frame_len < 1024:
        return np.array([]), np.array([])
    hop = max(1, frame_len // 2)
    window = np.hanning(frame_len)
    times: list[float] = []
    pitches: list[float] = []
    tau_min = max(2, int(sample_rate / max_hz))
    tau_max = min(frame_len // 2, int(sample_rate / min_hz))
    for start in range(0, len(mono) - frame_len + 1, hop):
        frame = mono[start:start + frame_len]
        frame = (frame - np.mean(frame)) * window
        if _rms(frame) < 1e-8:
            continue
        autocorr = signal.fftconvolve(frame, frame[::-1], mode="full")[frame_len - 1:]
        region = autocorr[tau_min:tau_max + 1]
        if not region.size:
            continue
        # Select the strongest periodic peak in the validated f0 range.
        peaks, _ = signal.find_peaks(region)
        if not peaks.size:
            continue
        rel = int(peaks[np.argmax(region[peaks])])
        tau = tau_min + rel
        if 0 < rel < len(region) - 1:
            y0, y1, y2 = region[rel - 1:rel + 2]
            denom = y0 - 2 * y1 + y2
            if abs(denom) > 1e-20:
                tau += float(0.5 * (y0 - y2) / denom)
        if tau > 0:
            times.append((start + frame_len / 2) / sample_rate)
            pitches.append(sample_rate / tau)
    return np.asarray(times), np.asarray(pitches)


def _pitch_metrics(reference: np.ndarray, capture: np.ndarray, sample_rate: int, stimulus_name: str) -> dict[str, Any]:
    if stimulus_name not in {"pitch_sweep", "tone_997"}:
        return unavailable("validated pitch estimator is enabled for pitch_sweep and tone_997 fixtures only")
    ref_t, ref_hz = _pitch_track(reference, sample_rate)
    cap_t, cap_hz = _pitch_track(capture, sample_rate)
    if not ref_hz.size or not cap_hz.size:
        return unavailable("no voiced analysis windows")
    count = min(len(ref_hz), len(cap_hz))
    cents = 1200 * np.log2(np.maximum(cap_hz[:count], 1e-9) / np.maximum(ref_hz[:count], 1e-9))
    return available({
        "method": "windowed autocorrelation peak; pitch_sweep/tone_997 only",
        "reference_median_hz": float(np.median(ref_hz[:count])),
        "capture_median_hz": float(np.median(cap_hz[:count])),
        "median_error_cents": float(np.median(cents)),
        "p95_absolute_error_cents": float(np.percentile(np.abs(cents), 95)),
        "window_count": int(count),
    })


def _thd(samples: np.ndarray, sample_rate: int, fundamental_hz: float = 997.0) -> dict[str, Any]:
    mono = _mono(samples)
    if len(mono) < sample_rate // 2:
        return unavailable("fewer than 0.5 seconds of aligned audio")
    start = len(mono) // 4
    length = min(sample_rate, len(mono) - start)
    segment = mono[start:start + length]
    segment = (segment - np.mean(segment)) * np.hanning(length)
    spectrum = np.abs(np.fft.rfft(segment))
    freqs = np.fft.rfftfreq(length, 1 / sample_rate)
    fundamental_bin = int(np.argmin(np.abs(freqs - fundamental_hz)))
    if spectrum[fundamental_bin] <= 1e-12:
        return unavailable("fundamental bin is below the analysis floor")
    fund = float(spectrum[fundamental_bin])
    harmonic_sq = 0.0
    used = []
    for harmonic in range(2, 11):
        target = fundamental_hz * harmonic
        if target >= sample_rate / 2:
            break
        index = int(np.argmin(np.abs(freqs - target)))
        lo, hi = max(0, index - 1), min(len(spectrum), index + 2)
        magnitude = float(np.max(spectrum[lo:hi]))
        harmonic_sq += magnitude * magnitude
        used.append(harmonic)
    thd_ratio = math.sqrt(harmonic_sq) / fund
    return available({"ratio": thd_ratio, "percent": thd_ratio * 100.0, "db": _db(thd_ratio), "fundamental_hz": fundamental_hz, "harmonics_used": used}, method="Hann FFT, nearest fundamental bin and +/-1-bin harmonic search")


def _tail_metric(reference: np.ndarray, capture: np.ndarray, sample_rate: int, stimulus_name: str) -> dict[str, Any]:
    ref = _mono(reference)
    cap = _mono(capture)
    if stimulus_name == "silence" or _rms(ref) < 1e-12:
        return unavailable("silent reference has no active tail boundary")
    threshold = max(float(np.max(np.abs(ref))) * 0.001, 1e-8)
    ref_active = np.flatnonzero(np.abs(ref) >= threshold)
    cap_active = np.flatnonzero(np.abs(cap) >= threshold)
    if not ref_active.size:
        return unavailable("reference has no active samples above -60 dB of its peak")
    ref_end = int(ref_active[-1])
    trailing_quiet = len(ref) - 1 - ref_end
    if trailing_quiet < int(0.1 * sample_rate):
        return unavailable("reference has less than 100 ms of trailing quiet; tail extension is not identifiable")
    if not cap_active.size:
        return unavailable("capture has no active samples above the reference-relative -60 dB threshold")
    cap_end = int(cap_active[-1])
    return available({
        "reference_last_active_ms": ref_end * 1000.0 / sample_rate,
        "capture_last_active_ms": cap_end * 1000.0 / sample_rate,
        "extension_ms": (cap_end - ref_end) * 1000.0 / sample_rate,
        "threshold_dbfs_relative_to_reference_peak": -60.0,
        "capture_tail_rms_last_100ms_dbfs": _db(_rms(cap[-min(len(cap), round(0.1 * sample_rate)):])),
    }, method="sample envelope threshold at -60 dB of reference peak")


def analyze_pair(reference_path: Path, capture_path: Path, stimulus_name: str, max_lag_seconds: float = 2.0, capture_kind: str = "unspecified") -> dict[str, Any]:
    ref_rate, reference, ref_dtype = read_wav(reference_path)
    cap_rate, capture, cap_dtype = read_wav(capture_path)
    resampled = False
    if cap_rate != ref_rate:
        ratio = Fraction(ref_rate, cap_rate).limit_denominator(1000)
        capture = signal.resample_poly(capture, ratio.numerator, ratio.denominator, axis=0)
        resampled = True
    lag, correlation = _estimate_lag(reference, capture, int(round(max_lag_seconds * ref_rate)))
    if lag is None:
        aligned_ref, aligned_cap = reference[:0], capture[:0]
        alignment = unavailable("reference or capture has insufficient non-silent signal for correlation")
    else:
        aligned_ref, aligned_cap = _aligned(reference, capture, lag)
        alignment = available({
            "capture_delay_samples": lag,
            "capture_delay_ms": lag * 1000.0 / ref_rate,
            "normalized_correlation": correlation,
            "overlap_frames": int(len(aligned_ref)),
            "overlap_seconds": len(aligned_ref) / ref_rate,
            "sign_convention": "positive means capture begins later than reference",
        }, method="maximum absolute full cross-correlation within the configured lag window")
    metrics: dict[str, Any] = {
        "time_alignment": alignment,
        "reference_rms_dbfs": available(_db(_rms(reference))),
        "capture_rms_dbfs": available(_db(_rms(capture))),
        "reference_peak_dbfs": available(_db(float(np.max(np.abs(reference))))),
        "capture_peak_dbfs": available(_db(float(np.max(np.abs(capture))))),
        "capture_dc_offset_per_channel": available(np.mean(capture, axis=0).tolist()),
        "capture_clipped_sample_fraction": available(float(np.mean(np.abs(capture) >= 0.999))),
    }
    if aligned_ref.size:
        ref_common = aligned_ref[:, :min(aligned_ref.shape[1], aligned_cap.shape[1])]
        cap_common = aligned_cap[:, :min(aligned_ref.shape[1], aligned_cap.shape[1])]
        if ref_common.shape[1]:
            error = cap_common - ref_common
            ref_rms, cap_rms, error_rms = _rms(ref_common), _rms(cap_common), _rms(error)
            metrics["gain_difference_db"] = available(_db(cap_rms / ref_rms)) if ref_rms > 1e-12 else unavailable("reference is silent")
            metrics["error_to_reference_db"] = available(_db(error_rms / ref_rms)) if ref_rms > 1e-12 else unavailable("reference is silent")
            metrics["aligned_waveform_correlation"] = available(float(np.corrcoef(ref_common.ravel(), cap_common.ravel())[0, 1])) if ref_rms > 1e-12 and cap_rms > 1e-12 else unavailable("reference or capture is silent")
            metrics["spectral_band_level_difference"] = _spectral_bands(ref_common, cap_common, ref_rate)
            metrics["stereo"] = _stereo_metrics(ref_common, cap_common, stimulus_name)
            metrics["pitch"] = _pitch_metrics(ref_common, cap_common, ref_rate, stimulus_name)
            metrics["tail"] = _tail_metric(ref_common, cap_common, ref_rate, stimulus_name)
            metrics["thd_reference"] = _thd(ref_common, ref_rate) if stimulus_name == "tone_997" else unavailable("THD applies only to the stationary tone_997 fixture")
            metrics["thd_capture"] = _thd(cap_common, ref_rate) if stimulus_name == "tone_997" else unavailable("THD applies only to the stationary tone_997 fixture")
        else:
            for name in ("gain_difference_db", "error_to_reference_db", "aligned_waveform_correlation", "spectral_band_level_difference", "stereo", "pitch", "tail", "thd_reference", "thd_capture"):
                metrics[name] = unavailable("no common channels")
    else:
        for name in ("gain_difference_db", "error_to_reference_db", "aligned_waveform_correlation", "spectral_band_level_difference", "stereo", "pitch", "tail", "thd_reference", "thd_capture"):
            metrics[name] = unavailable("silent reference has no active tail boundary") if name == "tail" and _rms(reference) < 1e-12 else unavailable("no aligned overlap")
    return {
        "schema_version": 1,
        "analysis_kind": "AUDIO_CAPTURE_COMPARISON",
        "baseline_status": "SOFTWARE_BASELINE" if capture_kind == "software_baseline" else "CAPTURE_ANALYSIS",
        "capture_kind": capture_kind,
        "source_engine_output": None,
        "source_engine_note": "not asserted by this analyzer; synthetic identity fixtures are not sourceEngine outputs",
        "stimulus_name": stimulus_name,
        "files": {
            "reference_basename": reference_path.name,
            "reference_sha256": sha256_file(reference_path),
            "reference_sample_dtype": ref_dtype,
            "capture_basename": capture_path.name,
            "capture_sha256": sha256_file(capture_path),
            "capture_sample_dtype": cap_dtype,
        },
        "sample_rates": {"reference_hz": ref_rate, "capture_hz": cap_rate, "analysis_hz": ref_rate, "capture_resampled": resampled},
        "channels": {"reference": int(reference.shape[1]), "capture": int(capture.shape[1])},
        "metrics": metrics,
        "quality_thresholds": "none configured; metrics are descriptive and require route-specific acceptance criteria",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--capture", required=True, type=Path)
    parser.add_argument("--stimulus-name", required=True)
    parser.add_argument("--capture-kind", choices=("unspecified", "software_baseline", "hardware_capture"), default="unspecified")
    parser.add_argument("--max-lag-seconds", type=float, default=2.0)
    parser.add_argument("--out", type=Path, help="optional JSON result path, outside repository")
    args = parser.parse_args()
    if args.max_lag_seconds <= 0:
        parser.error("--max-lag-seconds must be positive")
    result = analyze_pair(args.reference, args.capture, args.stimulus_name, args.max_lag_seconds, args.capture_kind)
    rendered = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        out = ensure_external_path(args.out, "analysis output file")
        write_json(out, result)
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
