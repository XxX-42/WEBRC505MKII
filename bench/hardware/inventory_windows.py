"""Inventory present Windows audio/MIDI devices without inventing negotiated formats."""
from __future__ import annotations

import argparse
import ctypes
import json
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "audio-parity"))
from parity_common import write_json

POWERSHELL_PNP = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$items = Get-PnpDevice -PresentOnly | Where-Object {
    $_.Class -match 'AudioEndpoint|Media|Midi' -or
    $_.InstanceId -match '^SWD\\MMDEVAPI\\|^SWD\\MIDISRV\\'
} | Select-Object Class,FriendlyName,Status,InstanceId
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
"""


class MidiCaps(ctypes.Structure):
    _fields_ = [
        ("wMid", ctypes.c_uint16),
        ("wPid", ctypes.c_uint16),
        ("vDriverVersion", ctypes.c_uint32),
        ("szPname", ctypes.c_wchar * 32),
        ("dwSupport", ctypes.c_uint32),
    ]


def _pnp_inventory() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    executable = "powershell.exe" if platform.system() == "Windows" else None
    if executable is None:
        return [], {"status": "unavailable", "reason": "Get-PnpDevice inventory is Windows-only"}
    try:
        completed = subprocess.run([executable, "-NoProfile", "-Command", POWERSHELL_PNP], check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        decoded = json.loads(completed.stdout or "[]")
        devices = decoded if isinstance(decoded, list) else [decoded]
        return devices, {"status": "available", "query": "Get-PnpDevice -PresentOnly"}
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        return [], {"status": "unavailable", "reason": f"PnP enumeration failed: {type(exc).__name__}: {exc}"}


def _winmm_midi() -> dict[str, Any]:
    if platform.system() != "Windows":
        return {"status": "unavailable", "reason": "WinMM MIDI enumeration is Windows-only"}
    try:
        winmm = ctypes.WinDLL("winmm", use_last_error=True)
        winmm.midiInGetNumDevs.restype = ctypes.c_uint
        winmm.midiOutGetNumDevs.restype = ctypes.c_uint
        winmm.midiInGetDevCapsW.argtypes = [ctypes.c_size_t, ctypes.POINTER(MidiCaps), ctypes.c_uint]
        winmm.midiOutGetDevCapsW.argtypes = [ctypes.c_size_t, ctypes.POINTER(MidiCaps), ctypes.c_uint]
        inputs = []
        outputs = []
        for index in range(int(winmm.midiInGetNumDevs())):
            caps = MidiCaps()
            result = winmm.midiInGetDevCapsW(index, ctypes.byref(caps), ctypes.sizeof(caps))
            inputs.append({"index": index, "name": caps.szPname, "query_status": int(result)})
        for index in range(int(winmm.midiOutGetNumDevs())):
            caps = MidiCaps()
            result = winmm.midiOutGetDevCapsW(index, ctypes.byref(caps), ctypes.sizeof(caps))
            outputs.append({"index": index, "name": caps.szPname, "query_status": int(result)})
        return {"status": "available", "api": "Windows Multimedia MIDI (WinMM)", "input_count": len(inputs), "output_count": len(outputs), "inputs": inputs, "outputs": outputs}
    except (AttributeError, OSError) as exc:
        return {"status": "unavailable", "reason": f"WinMM MIDI enumeration failed: {type(exc).__name__}: {exc}"}


def _wasapi_inventory() -> dict[str, Any]:
    try:
        import sounddevice as sd  # optional hardware-only dependency
    except ImportError:
        return {
            "status": "backend_unavailable",
            "reason": "sounddevice is not installed; SWD\\MMDEVAPI PnP endpoints are still listed separately",
            "stream_opened": False,
            "actual_sample_rate_hz": "unknown",
            "actual_buffer_frames": "unknown",
            "devices": [],
        }
    try:
        hostapis = sd.query_hostapis()
        devices = sd.query_devices()
        wasapi_host_indices = {i for i, host in enumerate(hostapis) if "WASAPI" in str(host.get("name", "")).upper()}
        wasapi_devices = []
        for index, item in enumerate(devices):
            if int(item.get("hostapi", -1)) not in wasapi_host_indices:
                continue
            wasapi_devices.append({
                "index": index,
                "name": str(item.get("name", "")),
                "max_input_channels": int(item.get("max_input_channels", 0)),
                "max_output_channels": int(item.get("max_output_channels", 0)),
                "advertised_default_samplerate_hz": item.get("default_samplerate"),
                "hostapi": str(hostapis[int(item["hostapi"])].get("name", "WASAPI")),
            })
        return {
            "status": "available" if wasapi_host_indices else "no_wasapi_hostapi",
            "api": "PortAudio via python-sounddevice",
            "stream_opened": False,
            "devices": wasapi_devices,
            "actual_sample_rate_hz": "unknown",
            "actual_buffer_frames": "unknown",
            "format_note": "advertised_default_samplerate_hz is a device default only; no stream was opened, so negotiated rate and buffer remain unknown",
        }
    except Exception as exc:  # Inventory must report a probe failure without implying a format.
        return {
            "status": "unavailable",
            "reason": f"WASAPI query failed: {type(exc).__name__}: {exc}",
            "stream_opened": False,
            "actual_sample_rate_hz": "unknown",
            "actual_buffer_frames": "unknown",
            "devices": [],
        }


def build_inventory() -> dict[str, Any]:
    devices, pnp_status = _pnp_inventory()
    audio = [d for d in devices if str(d.get("Class", "")).lower() == "audioendpoint"]
    midi_pnp = [d for d in devices if "midi" in str(d.get("Class", "")).lower() or "MIDISRV" in str(d.get("InstanceId", ""))]
    rc505 = [d for d in devices if re.search(r"rc\s*[-_]?\s*505|\bboss\b.{0,24}\b505\b|\broland\b.{0,24}\b505\b", f"{d.get('FriendlyName', '')} {d.get('InstanceId', '')}", re.IGNORECASE)]
    wasapi = _wasapi_inventory()
    return {
        "schema_version": 1,
        "captured_utc": datetime.now(timezone.utc).isoformat(),
        "host": {"platform": platform.platform(), "python": sys.version.split()[0]},
        "inventory_kind": "LIVE_WINDOWS_DEVICE_INVENTORY",
        "pnp_query": pnp_status,
        "audio_endpoints": audio,
        "audio_endpoint_count": len(audio),
        "wasapi": wasapi,
        "midi": {"pnp_endpoints": midi_pnp, "winmm": _winmm_midi()},
        "rc505_device_matches": rc505,
        "hil_gate": {
            "status": "BLOCKED_NO_RC505_PNP_MATCH" if not rc505 else "NOT_RUN_CAPTURE_REQUIRED",
            "reason": "No present PnP friendly name or instance id matched RC-505/Roland/BOSS 505." if not rc505 else "An RC-505-like PnP match exists; physical path and capture still require operator confirmation.",
            "stream_opened": False,
            "actual_sample_rate_hz": "unknown",
            "actual_buffer_frames": "unknown",
            "xrun_evidence": "not_applicable_no_stream_opened",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="optional JSON output path")
    args = parser.parse_args()
    result = build_inventory()
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        write_json(args.out, result)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["pnp_query"]["status"] == "available" else 2


if __name__ == "__main__":
    raise SystemExit(main())