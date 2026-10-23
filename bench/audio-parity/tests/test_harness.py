from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np
from scipy.io import wavfile

REPO = Path(__file__).resolve().parents[3]
AUDIO = REPO / "bench" / "audio-parity"
HARDWARE = REPO / "bench" / "hardware"
sys.path.insert(0, str(AUDIO))
sys.path.insert(0, str(HARDWARE))

import analyze
import blind_package
import capture_soak
import generate_stimuli


class AudioParityTests(unittest.TestCase):
    def test_antiphase_alignment_does_not_cancel_stereo_reference(self) -> None:
        rate = 48000
        samples = generate_stimuli.make_stimuli(rate)['antiphase']
        lag, score = analyze._estimate_lag(samples, samples, rate)
        self.assertEqual(lag, 0)
        self.assertAlmostEqual(score, 1.0, places=6)

    def test_stimulus_set_is_deterministic_and_complete(self) -> None:
        expected = {
            "silence", "impulse", "logsweep", "multitone", "tone_997", "amplitude_staircase",
            "transient", "l_only", "r_only", "antiphase", "asymmetric", "vocal_like",
            "guitar_like", "bass", "drum", "pitch_sweep", "tempo_pulse",
        }
        with tempfile.TemporaryDirectory(prefix="webrc-audio-test-") as temp:
            root = Path(temp)
            left = generate_stimuli.generate(root / "first", 48000)
            right = generate_stimuli.generate(root / "second", 48000)
            self.assertEqual({entry["name"] for entry in left["entries"]}, expected)
            self.assertEqual(
                {entry["name"]: entry["sha256"] for entry in left["entries"]},
                {entry["name"]: entry["sha256"] for entry in right["entries"]},
            )
            self.assertEqual(left["dataset_kind"], "SYNTHETIC_STIMULUS_SET")
            self.assertFalse(left["source_engine_output"])
            self.assertFalse(left["hardware_capture"])

    def test_alignment_reports_known_capture_delay_and_gain(self) -> None:
        with tempfile.TemporaryDirectory(prefix="webrc-audio-test-") as temp:
            root = Path(temp)
            rate = 48000
            reference = np.zeros((rate, 2), dtype=np.float32)
            reference[12000, 0] = 0.8
            reference[21000, 1] = 0.5
            capture = np.zeros_like(reference)
            delay = 37
            capture[delay:] = reference[:-delay] * 0.5
            reference_path, capture_path = root / "ref.wav", root / "capture.wav"
            wavfile.write(reference_path, rate, reference)
            wavfile.write(capture_path, rate, capture)
            result = analyze.analyze_pair(reference_path, capture_path, "impulse", capture_kind="software_baseline")
            metrics = result["metrics"]
            self.assertEqual(metrics["time_alignment"]["value"]["capture_delay_samples"], delay)
            self.assertAlmostEqual(metrics["time_alignment"]["value"]["normalized_correlation"], 1.0, places=4)
            self.assertAlmostEqual(metrics["gain_difference_db"]["value"], -6.0206, places=2)
            self.assertEqual(result["baseline_status"], "SOFTWARE_BASELINE")
            self.assertIsNone(result["source_engine_output"])

    def test_tone_metrics_are_available_and_silence_metrics_explain_absence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="webrc-audio-test-") as temp:
            root = Path(temp)
            rate = 48000
            tone = generate_stimuli.make_stimuli(rate)["tone_997"]
            tone_path = root / "tone.wav"
            wavfile.write(tone_path, rate, np.rint(tone * 32767).astype(np.int16))
            tone_result = analyze.analyze_pair(tone_path, tone_path, "tone_997")
            self.assertEqual(tone_result["metrics"]["thd_reference"]["status"], "available")
            self.assertEqual(tone_result["metrics"]["pitch"]["status"], "available")
            silence_path = root / "silence.wav"
            wavfile.write(silence_path, rate, np.zeros((rate, 2), dtype=np.int16))
            silence_result = analyze.analyze_pair(silence_path, silence_path, "silence")
            self.assertEqual(silence_result["metrics"]["time_alignment"]["status"], "unavailable")
            self.assertIn("silent", silence_result["metrics"]["tail"]["reason"])

    def test_stereo_l_only_reports_crosstalk_and_synthetic_blind_package_hides_ids(self) -> None:
        with tempfile.TemporaryDirectory(prefix="webrc-audio-test-") as temp:
            root = Path(temp)
            stimuli_dir, a_dir, b_dir = root / "stimuli", root / "variant-a", root / "variant-b"
            manifest = generate_stimuli.generate(stimuli_dir, 48000)
            a_dir.mkdir()
            b_dir.mkdir()
            for entry in manifest["entries"]:
                src = stimuli_dir / entry["file"]
                shutil.copyfile(src, a_dir / src.name)
                rate, raw = wavfile.read(src)
                wavfile.write(b_dir / src.name, rate, -raw)
            l_result = analyze.analyze_pair(a_dir / "l_only.wav", a_dir / "l_only.wav", "l_only")
            self.assertEqual(l_result["metrics"]["stereo"]["cross_talk_db"]["status"], "available")
            out_dir, map_path = root / "blind-package", root / "PRIVATE_MAPPING.json"
            public, private = blind_package.build_package(
                stimuli_dir,
                {"synthetic_variant_a": a_dir, "synthetic_variant_b": b_dir},
                out_dir,
                map_path,
                seed=19,
            )
            self.assertEqual(public["audio_jury_status"], "MULTIMODAL_AUDIO_JURY_BLOCKED")
            self.assertFalse(public["identity_mapping_included"])
            self.assertTrue(map_path.is_file())
            self.assertFalse((out_dir / "PRIVATE_MAPPING.json").exists())
            self.assertNotIn("synthetic_variant_a", json.dumps(public))
            self.assertEqual(len(private["trials"]), len(manifest["entries"]))
            self.assertTrue((out_dir / "trial-001" / "A.wav").is_file())

    def test_raw_audio_output_path_cannot_be_inside_repository(self) -> None:
        with self.assertRaises(ValueError):
            generate_stimuli.ensure_external_path(REPO / "bench" / "results", "test audio output")


class HardwareHarnessTests(unittest.TestCase):
    def test_blocked_run_keeps_unknown_fields_null_and_does_not_claim_zero_xruns(self) -> None:
        report = capture_soak._base_report(Path(tempfile.gettempdir()) / "webrc-blocked", 10, None, 0, "inventory only")
        self.assertEqual(report["status"], "BLOCKED")
        self.assertFalse(report["stream_opened"])
        self.assertEqual(report["actual_sample_rate_hz"], "unknown")
        self.assertEqual(report["actual_blocksize_frames"], "unknown")
        self.assertIsNone(report["xrun_evidence"]["input_overflow_callback_count"])
        self.assertIsNone(report["xrun_evidence"]["output_underflow_callback_count"])
        self.assertIn("not zero", report["xrun_evidence"]["interpretation"])

    def test_synthetic_marker_analyzer_recovers_offset_without_hardware_claim(self) -> None:
        with tempfile.TemporaryDirectory(prefix="webrc-hil-test-") as temp:
            root = Path(temp)
            rate = 48000
            probe = capture_soak._make_probe(rate)
            delay = 71
            total = 3 * rate
            capture = np.zeros((total, 2), dtype=np.float32)
            start = rate + delay
            capture[start:start + len(probe)] = probe[:, None]
            capture_path = root / "capture.wav"
            wavfile.write(capture_path, rate, np.rint(capture * 32767).astype(np.int16))
            result = capture_soak._latency_from_capture(capture_path, probe, [rate], rate, 100)
            self.assertEqual(result["status"], "available")
            self.assertEqual(result["markers"][0]["capture_delay_samples"], delay)
            self.assertEqual(result["markers"][0]["detection_status"], "matched")
            # This test exercises only correlation math; it never opens a device or records XRUN evidence.
            self.assertNotIn("capture_kind", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
