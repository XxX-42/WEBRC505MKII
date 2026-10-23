"""Run a WASAPI full-duplex electrical/RC-505 route capture and long-duration soak."""
from __future__ import annotations

import argparse
import json
import math
import queue
import re
import sys
import tempfile
import threading
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from scipy import signal
from scipy.io import wavfile

AUDIO_PARITY = Path(__file__).resolve().parents[1] / "audio-parity"
sys.path.insert(0, str(AUDIO_PARITY))
from parity_common import ensure_external_path, sha256_file, write_json  # noqa: E402
from inventory_windows import build_inventory  # noqa: E402

DEFAULT_OUT = Path(tempfile.gettempdir()) / "webrc505-hil"
VIRTUAL_MARKERS = ("voicemeeter", "vb-audio", "virtual cable", "cable input", "cable output", "software loopback")


def _base_report(outdir: Path, duration_minutes: int | None, sample_rate: int | None, blocksize: int | None, reason: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "capture_kind": "NO_CAPTURE",
        "status": "BLOCKED",
        "blocked_reason": reason,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "target_duration_minutes": duration_minutes,
        "requested_sample_rate_hz": sample_rate if sample_rate is not None else "unknown",
        "actual_sample_rate_hz": "unknown",
        "requested_blocksize_frames": blocksize if blocksize is not None else "driver_default_unknown",
        "actual_blocksize_frames": "unknown",
        "stream_opened": False,
        "captured_frames": 0,
        "captured_seconds": 0.0,
        "raw_audio_written": False,
        "xrun_evidence": {
            "status": "not_applicable_no_stream_opened",
            "input_overflow_callback_count": None,
            "output_underflow_callback_count": None,
            "software_writer_dropped_frames": None,
            "interpretation": "No stream ran; counters are null, not zero measured XRUNs.",
        },
        "latency_measurements": {"status": "unavailable", "reason": "no physical-route audio was captured"},
        "source_engine_output": None,
        "source_engine_note": "not asserted; generated stimuli and identity controls are never labeled as sourceEngine captures",
        "output_directory": str(outdir),
    }


def _write_blocked(outdir: Path, report: dict[str, Any], inventory: dict[str, Any]) -> int:
    outdir.mkdir(parents=True, exist_ok=True)
    write_json(outdir / "inventory.json", inventory)
    write_json(outdir / "capture_status.json", report)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 2


def _make_probe(sample_rate: int) -> np.ndarray:
    count = max(1024, round(0.08 * sample_rate))
    t = np.arange(count, dtype=np.float64) / sample_rate
    sweep = signal.chirp(t, f0=400, f1=min(10000, sample_rate * 0.40), t1=t[-1], method="logarithmic")
    envelope = np.hanning(count)
    return (0.72 * sweep * envelope).astype(np.float32)


def _write_probe(path: Path, probe: np.ndarray, channels: int, sample_rate: int) -> None:
    stereo = np.repeat(probe[:, None], channels, axis=1)
    pcm = np.rint(np.clip(stereo, -1, 1) * 32767).astype("<i2")
    wavfile.write(path, sample_rate, pcm)


def _latency_from_capture(capture_path: Path, probe: np.ndarray, event_frames: list[int], sample_rate: int, search_ms: float) -> dict[str, Any]:
    if not event_frames:
        return {"status": "unavailable", "reason": "no probe markers were emitted"}
    matches = []
    probe_energy = float(np.dot(probe, probe))
    lead = round(min(250.0, search_ms) * sample_rate / 1000.0)
    max_delay = round(search_ms * sample_rate / 1000.0)
    try:
        with wave.open(str(capture_path), "rb") as wav:
            channels = wav.getnchannels()
            total_frames = wav.getnframes()
            if wav.getsampwidth() != 2 or wav.getframerate() != sample_rate:
                return {"status": "unavailable", "reason": "capture encoding/rate differs from the expected PCM16 analysis format"}
            for event_frame in event_frames:
                start = max(0, event_frame - lead)
                end = min(total_frames, event_frame + max_delay + len(probe))
                if end - start < len(probe):
                    continue
                wav.setpos(start)
                raw = wav.readframes(end - start)
                samples = np.frombuffer(raw, dtype="<i2").reshape(-1, channels).astype(np.float64) / 32768.0
                best: tuple[float, int, float, int] | None = None
                for channel in range(channels):
                    x = samples[:, channel] - float(np.mean(samples[:, channel]))
                    corr = signal.correlate(x, probe.astype(np.float64), mode="valid", method="fft")
                    cumulative = np.concatenate(([0.0], np.cumsum(x * x)))
                    local_energy = np.maximum(cumulative[len(probe):] - cumulative[:-len(probe)], 1e-30)
                    denominator = np.sqrt(local_energy * max(probe_energy, 1e-30))
                    energy_floor = max(probe_energy * 1e-12, 1e-15)
                    normalized = np.divide(corr, denominator, out=np.zeros_like(corr), where=local_energy >= energy_floor)
                    normalized = np.clip(normalized, -1.0, 1.0)
                    index = int(np.argmax(np.abs(normalized)))
                    score = float(normalized[index])
                    candidate = (abs(score), index, score, channel)
                    if best is None or candidate[0] > best[0]:
                        best = candidate
                if best is None:
                    continue
                _, index, score, channel = best
                capture_start = start + index
                lag_samples = capture_start - event_frame
                matches.append({
                    "probe_output_frame": event_frame,
                    "capture_match_frame": capture_start,
                    "capture_delay_samples": lag_samples,
                    "capture_delay_ms": lag_samples * 1000.0 / sample_rate,
                    "normalized_correlation": score,
                    "selected_capture_channel": channel,
                    "detection_status": "matched" if abs(score) >= 0.10 else "below_correlation_floor",
                })
    except (OSError, ValueError) as exc:
        return {"status": "unavailable", "reason": f"capture correlation failed: {type(exc).__name__}: {exc}"}
    detected = [item for item in matches if item["detection_status"] == "matched"]
    if not detected:
        return {"status": "unavailable", "reason": "no marker reached the documented normalized-correlation floor of 0.10", "candidate_count": len(matches)}
    delays = np.asarray([item["capture_delay_ms"] for item in detected], dtype=np.float64)
    drift_ppm = None
    if len(detected) >= 2:
        times = np.asarray([item["probe_output_frame"] / sample_rate for item in detected], dtype=np.float64)
        drift_ppm = float(np.polyfit(times, delays / 1000.0, 1)[0] * 1e6)
    return {
        "status": "available",
        "method": "per-marker normalized cross-correlation against the emitted 80 ms chirp; output-to-input capture alignment",
        "marker_count": len(detected),
        "median_delay_ms": float(np.median(delays)),
        "p95_absolute_deviation_from_median_ms": float(np.percentile(np.abs(delays - np.median(delays)), 95)),
        "min_delay_ms": float(np.min(delays)),
        "max_delay_ms": float(np.max(delays)),
        "delay_drift_ppm": drift_ppm,
        "markers": matches,
        "correlation_floor": 0.10,
        "quality_thresholds": "none configured; values are descriptive and require route-specific acceptance criteria",
    }


def _run_capture(args: argparse.Namespace, outdir: Path, inventory: dict[str, Any]) -> int:
    try:
        import sounddevice as sd
    except ImportError:
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "sounddevice WASAPI capture backend is not installed"), inventory)
    try:
        hostapis = sd.query_hostapis()
        devices = sd.query_devices()
        if args.input_device < 0 or args.input_device >= len(devices) or args.output_device < 0 or args.output_device >= len(devices):
            raise IndexError("selected device index is outside the PortAudio device list")
        in_device, out_device = devices[args.input_device], devices[args.output_device]
        in_host = hostapis[int(in_device["hostapi"])]
        out_host = hostapis[int(out_device["hostapi"])]
    except Exception as exc:
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, f"WASAPI device query failed: {type(exc).__name__}: {exc}"), inventory)
    if "WASAPI" not in str(in_host.get("name", "")).upper() or "WASAPI" not in str(out_host.get("name", "")).upper():
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "selected input/output devices are not both WASAPI endpoints"), inventory)
    if int(in_device.get("hostapi", -1)) != int(out_device.get("hostapi", -2)):
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "selected input/output devices do not share one PortAudio host API"), inventory)
    if int(in_device.get("max_input_channels", 0)) < args.channels or int(out_device.get("max_output_channels", 0)) < args.channels:
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, f"selected endpoints do not both support {args.channels} channels"), inventory)
    selected_names = [str(in_device.get("name", "")), str(out_device.get("name", ""))]
    if any(any(marker in name.casefold() for marker in VIRTUAL_MARKERS) for name in selected_names):
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "a selected endpoint is a known virtual audio device; this runner only emits physical-route evidence"), inventory)
    if args.route_mode == "rc505-hardware-insert" and not args.rc505_present_confirmed:
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "RC-505 insert run requires --rc505-present-confirmed"), inventory)

    probe = _make_probe(args.sample_rate)
    probe_path = outdir / "output-probe-reference.wav"
    _write_probe(probe_path, probe, args.channels, args.sample_rate)
    capture_path = outdir / "capture.wav"
    interval_frames = round(args.probe_interval_seconds * args.sample_rate)
    first_marker = args.sample_rate
    event_frames: list[int] = []
    out_frame_cursor = 0
    callback_count = 0
    input_overflow_callbacks = 0
    output_underflow_callbacks = 0
    writer_dropped_frames = 0
    captured_frames = 0
    callback_error: list[str] = []
    write_queue: queue.Queue[np.ndarray | None] = queue.Queue(maxsize=256)
    writer_ready = threading.Event()
    writer_errors: list[str] = []

    def writer() -> None:
        nonlocal captured_frames
        try:
            with wave.open(str(capture_path), "wb") as wav:
                wav.setnchannels(args.channels)
                wav.setsampwidth(2)
                wav.setframerate(args.sample_rate)
                writer_ready.set()
                while True:
                    chunk = write_queue.get()
                    try:
                        if chunk is None:
                            break
                        pcm = np.rint(np.clip(chunk, -1.0, 1.0) * 32767).astype("<i2")
                        wav.writeframesraw(pcm.tobytes())
                        captured_frames += int(len(pcm))
                    finally:
                        write_queue.task_done()
        except Exception as exc:
            writer_errors.append(f"{type(exc).__name__}: {exc}")
            writer_ready.set()

    writer_thread = threading.Thread(target=writer, name="webrc-audio-wav-writer", daemon=True)
    writer_thread.start()
    writer_ready.wait(timeout=5)
    if writer_errors:
        return _write_blocked(outdir, _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, f"could not create capture WAV: {writer_errors[0]}"), inventory)

    def callback(indata: np.ndarray, outdata: np.ndarray, frames: int, time_info: Any, status: Any) -> None:
        nonlocal out_frame_cursor, callback_count, input_overflow_callbacks, output_underflow_callbacks, writer_dropped_frames
        callback_count += 1
        if bool(getattr(status, "input_overflow", False)):
            input_overflow_callbacks += 1
        if bool(getattr(status, "output_underflow", False)):
            output_underflow_callbacks += 1
        outdata.fill(0.0)
        block_start, block_end = out_frame_cursor, out_frame_cursor + frames
        first_event_index = max(0, math.floor((block_start - first_marker) / interval_frames))
        last_event_index = max(first_event_index, math.floor((block_end - 1 - first_marker) / interval_frames))
        for event_index in range(first_event_index, last_event_index + 1):
            event_start = first_marker + event_index * interval_frames
            event_end = event_start + len(probe)
            overlap_start = max(block_start, event_start)
            overlap_end = min(block_end, event_end)
            if overlap_start < overlap_end:
                source_start = overlap_start - event_start
                dest_start = overlap_start - block_start
                length = overlap_end - overlap_start
                outdata[dest_start:dest_start + length, :] = probe[source_start:source_start + length, None]
                if event_start not in event_frames:
                    event_frames.append(event_start)
        out_frame_cursor = block_end
        try:
            write_queue.put_nowait(np.asarray(indata, dtype=np.float32).copy())
        except queue.Full:
            writer_dropped_frames += frames
        except Exception as exc:
            callback_error.append(f"{type(exc).__name__}: {exc}")

    requested = {
        "duration_minutes": args.duration_minutes,
        "sample_rate_hz": args.sample_rate,
        "blocksize_frames": args.blocksize if args.blocksize else "driver_selected",
        "channels": args.channels,
        "route_mode": args.route_mode,
        "route_description": args.route_description,
        "physical_route_operator_attested": True,
        "rc505_present_operator_attested": bool(args.rc505_present_confirmed),
        "selected_input_device": args.input_device,
        "selected_output_device": args.output_device,
        "input_name": selected_names[0],
        "output_name": selected_names[1],
        "hostapi": str(in_host.get("name", "")),
    }
    try:
        extra = sd.WasapiSettings(exclusive=args.exclusive)
        stream = sd.Stream(
            device=(args.input_device, args.output_device),
            samplerate=args.sample_rate,
            blocksize=args.blocksize,
            channels=(args.channels, args.channels),
            dtype="float32",
            latency="high",
            extra_settings=extra,
            callback=callback,
        )
        stream.start()
        actual_rate = float(stream.samplerate)
        actual_block = int(stream.blocksize)
        if abs(actual_rate - args.sample_rate) > 0.01:
            stream.stop()
            stream.close()
            report = _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, f"opened stream rate {actual_rate} Hz differs from required rate {args.sample_rate} Hz")
            return _write_blocked(outdir, report, inventory)
        deadline = time.monotonic() + args.duration_minutes * 60
        next_progress = time.monotonic() + 60
        while time.monotonic() < deadline:
            if callback_error:
                break
            time.sleep(min(1.0, max(0.01, deadline - time.monotonic())))
            if time.monotonic() >= next_progress:
                print(f"capture progress: {captured_frames / actual_rate:.1f}s of {args.duration_minutes * 60}s", flush=True)
                next_progress += 60
        stream.stop()
        stream.close()
        stream_latency = stream.latency
    except Exception as exc:
        try:
            stream.stop()
            stream.close()
        except Exception:
            pass
        report = _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, f"WASAPI stream open/run failed: {type(exc).__name__}: {exc}")
        report["requested_route"] = requested
        return _write_blocked(outdir, report, inventory)
    finally:
        try:
            write_queue.put(None, timeout=10)
            write_queue.join()
            writer_thread.join(timeout=10)
        except queue.Full:
            writer_errors.append("WAV writer queue did not accept stop sentinel")

    latency = _latency_from_capture(capture_path, probe, event_frames, round(actual_rate), args.latency_search_ms) if capture_path.exists() else {"status": "unavailable", "reason": "capture file was not written"}
    status = "CAPTURED_WITH_DROPS_OR_XRUNS" if writer_dropped_frames or input_overflow_callbacks or output_underflow_callbacks or callback_error or writer_errors else "CAPTURED"
    report = {
        "schema_version": 1,
        "capture_kind": "PHYSICAL_ROUTE_CAPTURE_OPERATOR_ATTESTED",
        "status": status,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "requested_route": requested,
        "stream_opened": True,
        "stream_closed": True,
        "actual_sample_rate_hz": actual_rate,
        "actual_blocksize_frames": actual_block,
        "host_reported_latency_seconds": list(stream_latency) if isinstance(stream_latency, (tuple, list)) else stream_latency,
        "host_reported_latency_note": "PortAudio-reported estimate; audio-correlation results are reported separately",
        "callback_count": callback_count,
        "captured_frames": captured_frames,
        "captured_seconds": captured_frames / actual_rate,
        "expected_seconds": args.duration_minutes * 60,
        "raw_audio_written": capture_path.exists(),
        "capture_file": {"basename": capture_path.name, "sha256": sha256_file(capture_path) if capture_path.exists() else None},
        "probe_reference": {"basename": probe_path.name, "sha256": sha256_file(probe_path), "sha256_kind": "synthetic emitted probe, not a hardware capture"},
        "probe_event_count": len(event_frames),
        "xrun_evidence": {
            "status": "measured_from_PortAudio_callback_flags",
            "input_overflow_callback_count": input_overflow_callbacks,
            "output_underflow_callback_count": output_underflow_callbacks,
            "software_writer_dropped_frames": writer_dropped_frames,
            "interpretation": "Counters are observed callbacks/frames in this stream; writer drops are separate from PortAudio XRUN flags.",
        },
        "callback_errors": callback_error,
        "writer_errors": writer_errors,
        "latency_measurements": latency,
        "source_engine_output": None,
        "source_engine_note": "this is a hardware route capture; no sourceEngine software render is claimed",
        "actual_sample_rate_source": "PortAudio opened stream.samplerate",
        "actual_blocksize_source": "PortAudio opened stream.blocksize",
    }
    write_json(outdir / "probe_events.json", {"probe_interval_seconds": args.probe_interval_seconds, "event_output_frames": event_frames})
    write_json(outdir / "capture_status.json", report)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if status == "CAPTURED" else 3


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--duration-minutes", type=int, choices=(10, 30, 60))
    parser.add_argument("--sample-rate", type=int)
    parser.add_argument("--blocksize", type=int, default=0, help="0 asks PortAudio/host to choose; report the opened stream's actual value")
    parser.add_argument("--channels", type=int, choices=(1, 2), default=2)
    parser.add_argument("--route-mode", choices=("electrical-loopback", "rc505-hardware-insert"), default="electrical-loopback")
    parser.add_argument("--route-description", default="")
    parser.add_argument("--physical-route-confirmed", action="store_true")
    parser.add_argument("--rc505-present-confirmed", action="store_true")
    parser.add_argument("--exclusive", action="store_true", help="request WASAPI exclusive mode")
    parser.add_argument("--probe-interval-seconds", type=float, default=10.0)
    parser.add_argument("--latency-search-ms", type=float, default=1000.0)
    parser.add_argument("--outdir", type=Path, default=DEFAULT_OUT / datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    try:
        outdir = ensure_external_path(args.outdir, "hardware capture output directory")
    except ValueError as exc:
        parser.error(str(exc))
    inventory = build_inventory()
    if args.duration_minutes is None:
        report = _base_report(outdir, None, args.sample_rate, args.blocksize, "a 10/30/60-minute duration has not been selected")
        return _write_blocked(outdir, report, inventory)
    if args.input_device is None or args.output_device is None:
        report = _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "WASAPI input and output device indexes have not been selected; inventory only, no capture attempted")
        return _write_blocked(outdir, report, inventory)
    if args.sample_rate is None:
        report = _base_report(outdir, args.duration_minutes, None, args.blocksize, "sample rate must be explicitly requested for a stream; no actual rate is guessed")
        return _write_blocked(outdir, report, inventory)
    if not args.physical_route_confirmed or not args.route_description.strip():
        report = _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "physical signal route requires --physical-route-confirmed and a non-empty --route-description")
        return _write_blocked(outdir, report, inventory)
    if args.route_mode == "rc505-hardware-insert" and not args.rc505_present_confirmed:
        report = _base_report(outdir, args.duration_minutes, args.sample_rate, args.blocksize, "RC-505 insert route requires explicit --rc505-present-confirmed")
        return _write_blocked(outdir, report, inventory)
    if args.probe_interval_seconds <= 0 or args.latency_search_ms <= 0 or args.sample_rate < 8000:
        parser.error("probe interval/search must be positive and sample rate must be at least 8000 Hz")
    outdir.mkdir(parents=True, exist_ok=True)
    return _run_capture(args, outdir, inventory)


if __name__ == "__main__":
    raise SystemExit(main())