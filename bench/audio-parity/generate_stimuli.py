"""Generate deterministic stereo WAV inputs for offline and physical-route capture."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import chirp

from parity_common import ensure_external_path, sha256_file, write_json

GENERATOR_VERSION = "1.0.0"
DEFAULT_OUT = Path(tempfile.gettempdir()) / "webrc505-audio-parity" / "stimuli"


def _stereo(left: np.ndarray, right: np.ndarray | None = None) -> np.ndarray:
    if right is None:
        right = left.copy()
    return np.column_stack((left, right))


def _sine(t: np.ndarray, hz: float, phase: float = 0.0) -> np.ndarray:
    return np.sin(2.0 * np.pi * hz * t + phase)


def _noise(rng: np.random.Generator, count: int) -> np.ndarray:
    return rng.standard_normal(count).astype(np.float64)


def make_stimuli(sample_rate: int) -> dict[str, np.ndarray]:
    sr = sample_rate
    t1 = np.arange(sr, dtype=np.float64) / sr
    t2 = np.arange(2 * sr, dtype=np.float64) / sr
    t3 = np.arange(3 * sr, dtype=np.float64) / sr
    t4 = np.arange(4 * sr, dtype=np.float64) / sr
    result: dict[str, np.ndarray] = {}

    result["silence"] = np.zeros((sr, 2), dtype=np.float64)

    impulse = np.zeros((2 * sr, 2), dtype=np.float64)
    impulse[round(0.5 * sr), 0] = 0.8
    impulse[round(0.75 * sr), 1] = 0.65
    impulse[round(1.25 * sr), :] = 0.45
    result["impulse"] = impulse

    result["logsweep"] = _stereo(
        0.6 * chirp(t3, f0=30, f1=min(18000, sr * 0.42), t1=t3[-1], method="logarithmic"),
        0.48 * chirp(t3, f0=40, f1=min(16000, sr * 0.40), t1=t3[-1], method="logarithmic", phi=45),
    )

    multi = sum(0.105 * _sine(t3, hz, phase) for hz, phase in ((73, 0), (110, 0.2), (220, 0.6), (440, 1.1), (997, 0.4), (2000, 0.8), (5000, 1.7), (9000, 2.2)))
    result["multitone"] = _stereo(multi, 0.94 * multi + 0.035 * _sine(t3, 1370, 0.1))

    # One stationary tone is included to make THD analysis well-defined.
    result["tone_997"] = _stereo(0.55 * _sine(t3, 997), 0.50 * _sine(t3, 997, 0.17))

    levels = np.array([0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.7, 0.9])
    staircase = np.zeros((len(levels) * (sr // 2), 2), dtype=np.float64)
    for index, level in enumerate(levels):
        start = index * (sr // 2)
        end = start + (sr // 2)
        segment_t = np.arange(end - start, dtype=np.float64) / sr
        envelope = float(level) * _sine(segment_t, 997)
        staircase[start:end, 0] = envelope
        staircase[start:end, 1] = envelope * 0.8
    result["amplitude_staircase"] = staircase

    transient = np.zeros((4 * sr, 2), dtype=np.float64)
    rng = np.random.default_rng(506)
    for when, gain in ((0.15, 0.75), (0.7, 0.5), (1.5, 0.65), (2.6, 0.8)):
        start = round(when * sr)
        length = max(1, round(0.008 * sr))
        burst = _noise(rng, length) * np.exp(-np.arange(length) / (0.0012 * sr)) * gain
        transient[start:start + length, 0] += burst
        transient[start + 7:start + 7 + length, 1] += 0.8 * burst
    result["transient"] = transient

    result["l_only"] = _stereo(0.65 * _sine(t2, 440), np.zeros_like(t2))
    result["r_only"] = _stereo(np.zeros_like(t2), 0.65 * _sine(t2, 660))
    anti = 0.6 * _sine(t2, 330)
    result["antiphase"] = _stereo(anti, -anti)
    result["asymmetric"] = _stereo(0.56 * _sine(t2, 220), 0.18 * _sine(t2, 880, 0.37))

    # Harmonic source with a slowly moving fundamental and broad formant weighting.
    f0 = 145.0 + 3.0 * np.sin(2 * np.pi * 4.5 * t3)
    phase = 2 * np.pi * np.cumsum(f0) / sr
    vocal = np.zeros_like(t3)
    for harmonic in range(1, 24):
        frequency = harmonic * 145.0
        formant = 0.8 * math.exp(-0.5 * ((frequency - 750) / 250) ** 2) + 0.55 * math.exp(-0.5 * ((frequency - 1250) / 350) ** 2) + 0.4 * math.exp(-0.5 * ((frequency - 2500) / 600) ** 2)
        vocal += (formant / harmonic) * np.sin(harmonic * phase)
    vocal *= 0.33 * (0.75 + 0.25 * np.sin(2 * np.pi * 3.2 * t3))
    result["vocal_like"] = _stereo(vocal, 0.97 * vocal)

    # Three deterministic decaying plucks; each includes the requested stereo field.
    guitar = np.zeros_like(t3)
    for start_s, hz, strength in ((0.2, 82.41, 0.9), (1.15, 110.0, 0.65), (2.05, 164.81, 0.72)):
        start = round(start_s * sr)
        local_t = np.arange(len(t3) - start, dtype=np.float64) / sr
        pluck = np.zeros_like(local_t)
        for harmonic in range(1, 13):
            pluck += (1.0 / harmonic**1.15) * np.sin(2 * np.pi * hz * harmonic * local_t + harmonic * 0.17)
        guitar[start:] += strength * pluck * np.exp(-local_t * (1.1 + hz / 300))
    result["guitar_like"] = _stereo(0.28 * guitar, 0.25 * np.roll(guitar, 31))

    bass = np.zeros_like(t3)
    for start_s, hz in ((0.1, 55.0), (1.1, 73.42), (2.1, 82.41)):
        start = round(start_s * sr)
        local_t = np.arange(len(t3) - start, dtype=np.float64) / sr
        note = sum((1 / harmonic**1.4) * np.sin(2 * np.pi * hz * harmonic * local_t) for harmonic in range(1, 9))
        bass[start:] += 0.45 * note * np.exp(-local_t * 1.8)
    result["bass"] = _stereo(bass, 0.92 * bass)

    drum = np.zeros((4 * sr, 2), dtype=np.float64)
    rng = np.random.default_rng(505)
    for beat, when in enumerate((0.15, 0.65, 1.15, 1.65, 2.15, 2.65, 3.15)):
        start = round(when * sr)
        length = min(round(0.32 * sr), len(drum) - start)
        local = np.arange(length, dtype=np.float64) / sr
        if beat % 2 == 0:
            kick = np.sin(2 * np.pi * (55 - 18 * local) * local) * np.exp(-local * 18)
            drum[start:start + length, :] += (0.75 * kick)[:, None]
        else:
            snare_noise = _noise(rng, length) * np.exp(-local * 22)
            drum[start:start + length, 0] += 0.35 * snare_noise
            drum[start + 13:start + 13 + length, 1] += 0.32 * snare_noise
        hat_length = min(round(0.05 * sr), len(drum) - start)
        hat = _noise(rng, hat_length) * np.exp(-np.arange(hat_length) / (0.006 * sr)) * 0.12
        drum[start:start + hat_length, 0] += hat
        drum[start:start + hat_length, 1] += 0.9 * hat
    result["drum"] = drum

    result["pitch_sweep"] = _stereo(
        0.62 * chirp(t4, f0=80, f1=1000, t1=t4[-1], method="logarithmic"),
        0.59 * chirp(t4, f0=90, f1=900, t1=t4[-1], method="logarithmic"),
    )

    tempo = np.zeros((8 * sr, 2), dtype=np.float64)
    click_len = max(1, round(0.035 * sr))
    click_t = np.arange(click_len, dtype=np.float64) / sr
    click = np.exp(-click_t * 100) * (0.72 * _sine(click_t, 1400) + 0.28 * _sine(click_t, 2800))
    for beat in range(16):
        start = round(beat * 0.5 * sr)
        if start + click_len <= len(tempo):
            tempo[start:start + click_len, beat % 2] = click
    result["tempo_pulse"] = tempo

    return {name: np.clip(np.asarray(data, dtype=np.float64), -0.999, 0.999).astype(np.float32) for name, data in result.items()}


def generate(outdir: Path, sample_rate: int) -> dict:
    outdir = ensure_external_path(outdir, "stimulus output directory")
    outdir.mkdir(parents=True, exist_ok=True)
    stimuli = make_stimuli(sample_rate)
    entries = []
    hints = {
        "tone_997": {"thd": "stationary_sine", "pitch": "stationary_sine", "tail": "not_applicable"},
        "pitch_sweep": {"pitch": "logarithmic_sweep", "tail": "not_applicable"},
        "transient": {"tail": "trailing_silence_expected"},
        "silence": {"thd": "silent_reference", "pitch": "silent_reference", "tail": "silent_reference"},
    }
    for name, samples in stimuli.items():
        filename = f"{name}.wav"
        path = outdir / filename
        pcm = np.rint(np.clip(samples, -1, 1) * 32767).astype(np.int16)
        wavfile.write(path, sample_rate, pcm)
        entries.append({
            "name": name,
            "file": filename,
            "sha256": sha256_file(path),
            "sample_rate_hz": sample_rate,
            "channels": 2,
            "frames": int(len(pcm)),
            "duration_seconds": len(pcm) / sample_rate,
            "encoding": "PCM_S16LE",
            "content_kind": "DETERMINISTIC_SYNTHETIC_STIMULUS",
            "analysis_hints": hints.get(name, {}),
        })
    manifest = {
        "schema_version": 1,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "generator": "WebRC505 deterministic stereo stimulus harness",
        "generator_version": GENERATOR_VERSION,
        "dataset_kind": "SYNTHETIC_STIMULUS_SET",
        "baseline_status": "SOFTWARE_BASELINE",
        "source_engine_output": False,
        "hardware_capture": False,
        "seed_policy": "fixed per-stimulus seeds; no ambient randomness",
        "sample_rate_hz": sample_rate,
        "entries": entries,
    }
    write_json(outdir / "manifest.json", manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", type=Path, default=DEFAULT_OUT, help=f"outside-repository output (default: {DEFAULT_OUT})")
    parser.add_argument("--sample-rate", type=int, default=48000)
    args = parser.parse_args()
    if args.sample_rate < 8000 or args.sample_rate > 192000:
        parser.error("--sample-rate must be between 8000 and 192000 Hz")
    try:
        manifest = generate(args.outdir, args.sample_rate)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps({"output_directory": str(args.outdir.resolve()), "dataset_kind": manifest["dataset_kind"], "count": len(manifest["entries"]), "manifest_sha256": sha256_file(args.outdir.resolve() / "manifest.json")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())