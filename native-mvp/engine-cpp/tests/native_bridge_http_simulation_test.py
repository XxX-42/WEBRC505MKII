#!/usr/bin/env python3
"""No-hardware HTTP contract test for the explicit simulation host target."""

import json
import http.client
import hashlib
import math
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


HOST_URL = f"http://127.0.0.1:{os.environ.get('WEBRC_NATIVE_BRIDGE_PORT', '17755')}"


def request(path, method="GET", body=None, headers=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request_headers = dict(headers or {})
    if method == "POST":
        request_headers.setdefault("Origin", "http://localhost:5173")
    if data is not None:
        request_headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(
        HOST_URL + path,
        data=data,
        method=method,
        headers=request_headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def request_raw(path, headers=None):
    req = urllib.request.Request(HOST_URL + path, method="GET", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def request_with_headers(path, method="GET", headers=None):
    req = urllib.request.Request(HOST_URL + path, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def request_binary(path, method, body):
    req = urllib.request.Request(
        HOST_URL + path,
        data=json.dumps(body).encode("utf-8"),
        method=method,
        headers={"Content-Type": "text/plain", "Origin": "http://localhost:5173"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def request_project_archive(path, method="POST", body=None, content_type=None):
    headers = {"Origin": "http://localhost:5173"}
    if content_type is not None:
        headers["Content-Type"] = content_type
    # Header validation may reject an invalid import before consuming its large
    # body. urllib closes its connection on sendall's BrokenPipeError and loses
    # the valid HTTP error response. Keep the socket long enough to assert that
    # response; do not retry the mutation or suppress any response assertion.
    address = urllib.parse.urlsplit(HOST_URL)
    connection = http.client.HTTPConnection(address.hostname, address.port, timeout=15)
    try:
        try:
            connection.request(method, path, body=body, headers=headers)
        except BrokenPipeError:
            pass  # getresponse must still succeed, otherwise the test fails.
        response = connection.getresponse()
        payload = response.read()
        return response.status, json.loads(payload.decode("utf-8")) if payload else {}
    finally:
        connection.close()


def build_project_archive(tracks, name="HTTP import test", bpm=120.0):
    payload = bytearray()
    track_manifest = []
    for track in tracks:
        if track is None:
            track_manifest.append(None)
            continue
        channels = track["channels"]
        samples = track["samples"]
        pcm = struct.pack("<" + "f" * len(samples), *samples)
        track_manifest.append({
            "sampleRate": track.get("sampleRate", 48000),
            "frameCount": len(samples) // channels,
            "channels": channels,
            "payloadOffset": len(payload),
            "byteLength": len(pcm),
            "sha256": hashlib.sha256(pcm).hexdigest(),
        })
        payload.extend(pcm)

    manifest = {
        "format": "rc505-project-archive",
        "version": 1,
        "project": {
            "name": name,
            "bpm": bpm,
            "transport": {
                "masterTrackId": None,
                "measureLengthSeconds": 0,
                "masterLoopLengthSamples": 0,
                "timeSignatureNumerator": 4,
                "timeSignatureDenominator": 4,
            },
        },
        "tracks": track_manifest,
    }
    manifest_bytes = json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b"RC505PA\x00" + struct.pack("<I", len(manifest_bytes)) + manifest_bytes + payload


def request_project_import_cancel(generation):
    body = json.dumps({"generation": generation}, separators=(",", ":")).encode("utf-8")
    return request_project_archive(
        "/v1/project/import/cancel", "POST", body, "text/plain")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def test_per_track_catalog_contract():
    path = "/v1/native-fx/catalog-slot"
    status, before = request("/v1/status")
    require(status == 200 and before.get("engineRunning") is False, "per-track contract requires a stopped host")
    legacy_slots = before["nativeFx"]["catalogSlots"]
    for track_id in range(1, 6):
        for slot in "ABCD":
            status, configured = request(path, "POST", {
                "path": "track", "trackId": track_id, "slot": slot, "effectId": "manual_pan",
                "parameters": {"position": -100.0 if track_id == 1 else 100.0}, "bypassed": False,
            })
            require(status == 200, f"per-track {track_id}/{slot} selection rejected: {configured}")
    fx = configured["nativeFx"]
    require(fx.get("perTrackCatalogAvailable") is True, "per-track catalog capability missing")
    banks = fx.get("perTrackCatalogBanks", [])
    require([bank.get("trackId") for bank in banks] == [1, 2, 3, 4, 5], "per-track status target IDs are wrong")
    require(fx["catalogSlots"] == legacy_slots, "per-track selection mutated the legacy shared bank")
    for bank in banks:
        require([slot.get("slot") for slot in bank["slots"]] == list("ABCD"), "per-track status lost A-D order")
        for slot in bank["slots"]:
            require(slot.get("effectId") == "manual_pan" and slot.get("prepared") is True and
                    slot.get("requestedRevision") == slot.get("appliedRevision") and
                    slot.get("processingFaulted") is False and slot.get("controlFaulted") is False,
                    f"per-track stopped processor not prepared/applied: {slot}")
    for invalid in (-1, 6, 1.5, True, "1", None, 2**64):
        status, rejected = request(path, "POST", {
            "path": "track", "trackId": invalid, "slot": "A", "effectId": "manual_pan",
        })
        require(status == 400 and "trackId" in rejected.get("error", ""), f"invalid per-track target accepted: {invalid}")
    status, rejected = request(path, "POST", {"path": "input", "trackId": 1, "slot": "A", "effectId": "dist"})
    require(status == 400, "Input accepted a per-track target")
    for effect in ("beat_shift", "vinyl_flick"):
        status, rejected = request(path, "POST", {"path": "track", "trackId": 1, "slot": "D", "effectId": effect})
        require(status == 409 and "experimental pre-insert" in rejected.get("error", ""),
                f"source-aware transport silently accepted ordered per-track insert placement: {effect}")
    transport = fx.get("sourceAwareLoopTransport", {})
    require(transport.get("experimental") is True and transport.get("stage") == "preInsert" and
            transport.get("orderedInsertPlacementSupported") is False, "source-aware transport limitations not explicit")
    availability = {item["effectId"]: item for item in fx["catalogEffectAvailability"]}
    require(availability["vinyl_flick"].get("perTrackInsert") is False, "VINYL insert restriction not advertised")
    for track_id in (1, 2):
        status, configured = request(path, "POST", {
            "path": "track", "trackId": track_id, "slot": "B", "effectId": "osc_voc_m",
            "parameters": {"midi-channel": 1.0},
        })
        require(status == 200, f"per-track MIDI processor selection failed: {configured}")
    status, started = request("/v1/engine/start", "POST", {})
    require(status == 200 and started["engineRunning"] is True, "per-track bank host did not start")
    status, edited = request(path, "POST", {"path": "track", "trackId": 1, "slot": "A", "effectId": "manual_pan",
        "parameters": {"position": 0.0}, "bypassed": True})
    require(status == 200, f"per-track live parameter edit failed: {edited}")
    desired_revision = edited["nativeFx"]["perTrackCatalogBanks"][0]["slots"][0]["requestedRevision"]
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        status, edited = request("/v1/status")
        applied = edited["nativeFx"]["perTrackCatalogBanks"][0]["slots"][0]
        if applied["appliedRevision"] == desired_revision:
            break
        time.sleep(0.01)
    require(applied["appliedRevision"] == desired_revision and applied["appliedBypassed"] is True,
            "per-track live config was accepted but never acknowledged by the callback")
    require(edited["nativeFx"]["perTrackCatalogBanks"][1]["slots"][0]["bypassed"] is False,
            "per-track live bypass leaked into Track 2")
    status, rejected = request(path, "POST", {"path": "track", "trackId": 1, "slot": "A", "effectId": "dist"})
    require(status == 409 and "Stop Native audio" in rejected.get("error", ""), "live type replacement was silently accepted")
    frame = edited["nativeFx"]["oscVocMidi"]["currentSampleFrame"] + 48000
    for endpoint in ("catalog-midi", "osc-voc-midi"):
        event = {"path": "track", "trackId": 1, "slot": "B", "type": "noteOn", "channel": 1,
                 "note": 60, "velocity": 100, "frame": frame}
        if endpoint == "catalog-midi":
            event["effectId"] = "osc_voc_m"
        status, queued = request("/v1/native-fx/" + endpoint, "POST", event)
        require(status == 200, f"per-track MIDI route rejected: {queued}")
        require(queued["nativeFx"]["perTrackCatalogBanks"][0]["midiSlots"][1]["queuedEvents"] > 0 and
                queued["nativeFx"]["perTrackCatalogBanks"][1]["midiSlots"][1]["queuedEvents"] == 0,
                "per-track MIDI queue leaked across independent banks")
    status, stopped = request("/v1/engine/stop", "POST", {})
    require(status == 200 and stopped["engineRunning"] is False, "per-track host stop failed")
    for track_id in range(1, 6):
        for slot in "ABCD":
            status, cleared = request(path, "POST", {"path": "track", "trackId": track_id, "slot": slot, "effectId": ""})
            require(status == 200, f"per-track clear failed: {cleared}")
    require(cleared["nativeFx"]["catalogSlots"] == legacy_slots, "clearing per-track slots changed the legacy shared bank")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: native_bridge_http_simulation_test.py <native_bridge_host_simulation>")
    process = subprocess.Popen(
        [sys.argv[1]],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    try:
        health = None
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError(f"simulation host exited early with code {process.returncode}")
            try:
                status, health = request("/health")
                if status == 200:
                    break
            except (ConnectionError, TimeoutError, urllib.error.URLError):
                time.sleep(0.05)
        require(health is not None and health.get("ok") is True, "health endpoint did not return ok")

        status, initial_status = request("/v1/status")
        require(status == 200 and initial_status.get("nativeMarkVersion") == 1 and
                initial_status.get("nativeMarks", {}).get("budgetBytes") == 512 * 1024 * 1024,
                "Native MARK capability/version or shared budget status is missing")
        track_one_mark = next((track.get("mark") for track in initial_status.get("nativeTracks", [])
                               if track.get("trackId") == 1), {})
        require(track_one_mark.get("exists") is False and track_one_mark.get("appliedGeneration") == 0,
                "Native MARK status did not initialize as an empty per-track capability")
        status, rejected_mark = request("/v1/transport/mark-set?trackId=1&generation=1", "POST")
        require(status == 409 and "running host" in rejected_mark.get("error", ""),
                "MARK SET did not return a clear failure on a stopped Native host")
        status, after_rejected_mark = request("/v1/status")
        rejected_track_mark = next((track.get("mark") for track in after_rejected_mark.get("nativeTracks", [])
                                    if track.get("trackId") == 1), {})
        require(status == 200 and rejected_track_mark.get("requestedGeneration") == 1 and
                rejected_track_mark.get("appliedGeneration") == 0 and rejected_track_mark.get("exists") is False,
                "Failed MARK SET status advanced applied generation or lost request generation")
        status, malformed_mark = request("/v1/transport/mark-set?trackId=1&generation=1&generation=2", "POST")
        require(status == 400, "Native MARK endpoint accepted duplicate generation query parameters")

        origin = "http://127.0.0.1:4174"
        status, headers, _ = request_with_headers("/health", headers={"Origin": origin})
        require(status == 200 and headers.get("Access-Control-Allow-Origin") == origin and
                headers.get_all("Access-Control-Allow-Origin", []) == [origin],
                "loopback browser origin could not read the Native health route")
        status, headers, _ = request_with_headers("/v1/config/apply", "OPTIONS", {
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        require(status == 204 and headers.get("Access-Control-Allow-Origin") == origin and
                headers.get("Access-Control-Allow-Methods") == "GET, POST" and
                "content-type" in headers.get("Access-Control-Allow-Headers", "").lower(),
                "Native JSON POST did not receive a valid loopback CORS preflight response")
        for disallowed_origin in ("https://attacker.invalid", ""):
            headers_to_send = {"Origin": disallowed_origin} if disallowed_origin else {}
            status, _, rejected_body = request_with_headers("/v1/engine/start", "POST", headers_to_send)
            rejected = json.loads(rejected_body.decode("utf-8")) if rejected_body else {}
            require(status == 403 and "Origin" in rejected.get("error", ""),
                    f"Native engine start did not reject disallowed or missing Origin {disallowed_origin!r}")
        status, rejected_preflight, _ = request_with_headers("/v1/config/apply", "OPTIONS", {
            "Origin": "https://attacker.invalid",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        require(status == 403 and not rejected_preflight.get("Access-Control-Allow-Origin"),
                "Native bridge approved a preflight from a non-allowlisted origin")
        status, state_after_reject = request("/v1/status")
        require(status == 200 and state_after_reject.get("engineRunning") is False,
                "rejected cross-site/missing-Origin writes mutated Native engine state")
        status, headers, _ = request_with_headers("/health", headers={"Origin": "https://attacker.invalid"})
        require(status == 200 and not headers.get("Access-Control-Allow-Origin"),
                "Native bridge exposed a response to a non-loopback origin")

        loop_transport_path = "/v1/native-loop-transport/config"
        loop_transport_config = {
            "trackId": 3,
            "mode": "beatShift",
            "beatOffsetBeats": -0.5,
            "bpm": 127.0,
            "crossfadeMs": 4.0,
            "vinylSpeedPercent": 0.0,
            "motorReturnSeconds": 1.0,
            "brakePercent": 0.0,
            "vinylMixPercent": 100.0,
        }
        status, headers, _ = request_with_headers(loop_transport_path, "OPTIONS", {
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        require(status == 204 and headers.get("Access-Control-Allow-Origin") == "http://localhost:5173" and
                headers.get("Access-Control-Allow-Methods") == "GET, POST" and
                "content-type" in headers.get("Access-Control-Allow-Headers", "").lower(),
                "Native per-track loop transport JSON POST did not receive the approved local CORS preflight")
        status, headers, _ = request_with_headers(loop_transport_path, "OPTIONS", {
            "Origin": "https://attacker.invalid",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        require(status == 403 and not headers.get("Access-Control-Allow-Origin"),
                "Native per-track loop transport approved a foreign-origin preflight")
        status, before_foreign_transport, _ = request_raw("/v1/status")
        require(status == 200, "Native loop-transport pre-mutation status request failed")
        foreign_headers = {"Origin": "https://attacker.invalid", "Content-Type": "application/json"}
        status, foreign_reject = request(loop_transport_path, "POST", loop_transport_config, foreign_headers)
        require(status == 403 and "Origin" in foreign_reject.get("error", ""),
                "Native per-track loop transport accepted a foreign-origin mutation")
        status, after_foreign_transport, _ = request_raw("/v1/status")
        require(status == 200 and after_foreign_transport.get("engineRunning") == before_foreign_transport.get("engineRunning") and
                [track.get("loopTransportStatus") for track in after_foreign_transport.get("nativeTracks", [])] ==
                [track.get("loopTransportStatus") for track in before_foreign_transport.get("nativeTracks", [])],
                "rejected foreign-origin loop-transport write mutated Native state")

        status, devices = request("/v1/devices")
        require(status == 200, "device catalog endpoint failed")
        simulated_inputs = devices.get("inputsByBackend", {}).get("WASAPI", [])
        simulated_outputs = devices.get("outputsByBackend", {}).get("WASAPI", [])
        require(simulated_inputs and simulated_outputs, "simulation endpoints were not listed")
        require("SIMULATION ONLY" in simulated_inputs[0]["name"], "fake endpoint label is not explicit")

        status, configured = request("/v1/config/apply", "POST", {
            "backend": "WASAPI",
            "inputDeviceId": "WASAPI:1",
            "outputDeviceId": "WASAPI:1",
            "sampleRate": 48000,
            "bufferFrames": 64,
            "monitoringEnabled": False,
        })
        require(status == 200, f"simulation config was rejected: {configured}")
        require(configured.get("engineRunning") is False, "config apply should not silently start the simulated engine")
        status, started = request("/v1/engine/start", "POST", {})
        require(status == 200 and started.get("engineRunning") is True, "fake stream did not expose simulated running state")
        status, engine_status = request("/v1/status")
        require(status == 200, "status endpoint failed after start")
        initial_rhythm = engine_status.get("nativeRhythm", {})
        require(initial_rhythm.get("available") is True and
                initial_rhythm.get("swingPercent") == 50 and
                initial_rhythm.get("quantizeGrid") == "1/16" and
                initial_rhythm.get("volume") == 50,
                f"Native rhythm defaults/configuration were not reported: {initial_rhythm}")
        require(engine_status.get("nativeLooperTrackCount") == 5 and
                engine_status.get("nativeLooperMultiTrackImplemented") is True and
                engine_status.get("nativeLooperTracksStereo") is True,
                "Native five-track stereo capability was not serialized")
        require(engine_status.get("nativeLooperMaxRecordSeconds") == 300 and
                engine_status.get("nativeLooperPreallocatedBytes") == 576_000_000 and
                engine_status.get("nativeLooperStorageBudgetBytes") == 768 * 1024 * 1024,
                "Native loop preallocation budget/duration was not reported")
        hq_capability = engine_status.get("nativeHqRenderer", {})
        require(hq_capability.get("available") is True if hq_capability.get("available") else
                hq_capability.get("engines") == [],
                f"Native HQ_RENDER availability was not explicit: {hq_capability}")
        rejected_rate_status, rejected_rate = request("/v1/config/apply", "POST", {
            "backend": "WASAPI",
            "inputDeviceId": "WASAPI:1",
            "outputDeviceId": "WASAPI:1",
            "sampleRate": 96000,
            "bufferFrames": 64,
            "monitoringEnabled": False,
            "nativeLooperStorageBudgetBytes": 768 * 1024 * 1024,
        })
        require(rejected_rate_status == 400 and "larger budget" in rejected_rate.get("error", ""),
                "96 kHz config without the larger loop-storage budget was not explicitly rejected")
        status, after_reject = request("/v1/status")
        require(status == 200 and after_reject.get("engineRunning") is True and
                after_reject.get("sampleRate") == 48000 and
                after_reject.get("nativeLooperMaxRecordSeconds") == 300 and
                after_reject.get("nativeLooperStorageBudgetBytes") == 768 * 1024 * 1024,
                "Rejected over-budget config disrupted the active 48 kHz engine")
        accepted_budget_status, accepted_budget = request("/v1/config/apply", "POST", {
            "backend": "WASAPI",
            "inputDeviceId": "WASAPI:1",
            "outputDeviceId": "WASAPI:1",
            "sampleRate": 48000,
            "bufferFrames": 64,
            "monitoringEnabled": False,
            "nativeLooperStorageBudgetBytes": 1536 * 1024 * 1024,
        })
        require(accepted_budget_status == 200 and
                accepted_budget.get("nativeLooperStorageBudgetBytes") == 1536 * 1024 * 1024,
                "higher loop-storage budget did not round-trip through Native config/status")
        status, stopped_before_transport = request("/v1/engine/stop", "POST", {})
        require(status == 200 and stopped_before_transport.get("engineRunning") is False,
                "Native loop-transport stopped-state setup failed")
        status, configured_loop_transport = request(loop_transport_path, "POST", loop_transport_config)
        require(status == 200, f"valid Native per-track loop-transport config was rejected: {configured_loop_transport}")
        track_three_transport = next((track for track in configured_loop_transport.get("nativeTracks", [])
                                      if track.get("trackId") == 3), {})
        require(track_three_transport.get("loopTransportStatus") == "waitingForLoop",
                f"Native per-track loop-transport status was not serialized for Track 3: {track_three_transport}")
        for invalid_loop_transport in (
            {**loop_transport_config, "trackId": 6},
            {**loop_transport_config, "mode": "unsupported"},
            {**loop_transport_config, "beatOffsetBeats": 4.1},
            {**loop_transport_config, "bpm": 300.1},
            {**loop_transport_config, "vinylMixPercent": 101.0},
        ):
            status, error = request(loop_transport_path, "POST", invalid_loop_transport)
            require(status == 400,
                    f"invalid Native loop-transport config was not rejected before mutation: {invalid_loop_transport}: {error}")
        status, after_invalid_loop_transport = request("/v1/status")
        track_three_after_reject = next((track for track in after_invalid_loop_transport.get("nativeTracks", [])
                                         if track.get("trackId") == 3), {})
        require(status == 200 and track_three_after_reject.get("loopTransportStatus") == "waitingForLoop" and
                track_three_after_reject.get("state") == track_three_transport.get("state"),
                f"rejected Native loop-transport config mutated Track 3 state/status: {track_three_after_reject}")
        status, started = request("/v1/engine/start", "POST", {})
        require(status == 200 and started.get("engineRunning") is True, "simulation engine did not restart after budget update")
        native_tracks = engine_status.get("nativeTracks", [])
        require([track.get("trackId") for track in native_tracks] == [1, 2, 3, 4, 5],
                "Native per-track status did not include five stable 1-based track IDs")
        for invalid_track_id in (0, 6, "bogus"):
            route_value = invalid_track_id if isinstance(invalid_track_id, str) else str(invalid_track_id)
            status, error = request(f"/v1/transport/record?trackId={route_value}", "POST", {})
            require(status == 400 and "trackId" in error.get("error", ""),
                    f"invalid Native track selector {route_value!r} was not rejected")

        rhythm_config = {
            "enabled": True,
            "bpm": 127.3,
            "kitIndex": 16,
            "patternIndex": 229,
            "variation": "D",
            "section": "fill",
            "swingPercent": 75,
            "quantizeGrid": "1/4",
            "volume": 73,
        }
        status, configured_rhythm = request("/v1/native-rhythm/config", "POST", rhythm_config)
        require(status == 200, f"full Native rhythm control config was rejected: {configured_rhythm}")
        rhythm = configured_rhythm.get("nativeRhythm", {})
        require(rhythm.get("enabled") is True and rhythm.get("patternIndex") == 229 and
                rhythm.get("kitIndex") == 16 and rhythm.get("variation") == "D" and
                rhythm.get("section") == "fill" and rhythm.get("swingPercent") == 75 and
                rhythm.get("quantizeGrid") == "1/4" and rhythm.get("volume") == 73,
                f"Native rhythm config/status round trip was incomplete: {rhythm}")
        for field_value, expected in (("swingPercent", 76), ("quantizeGrid", "1/32"), ("volume", 101)):
            status, error = request("/v1/native-rhythm/config", "POST", {field_value: expected})
            require(status == 400 and field_value in error.get("error", ""),
                    f"invalid Native rhythm {field_value}={expected!r} was not rejected")
        status, after_rhythm_reject = request("/v1/status")
        rhythm = after_rhythm_reject.get("nativeRhythm", {})
        require(status == 200 and rhythm.get("patternIndex") == 229 and
                rhythm.get("swingPercent") == 75 and rhythm.get("quantizeGrid") == "1/4" and
                rhythm.get("volume") == 73,
                f"Rejected Native rhythm settings mutated the active config: {rhythm}")

        status, configured = request("/v1/native-fx/phaser", "POST", {
            "enabled": True,
            "stages": 12,
            "rateHz": 3.5,
            "depth": 0.8,
            "feedback": -0.4,
            "wetMix": 0.6,
        })
        require(status == 200, f"valid phaser config was rejected: {configured}")
        phaser = configured.get("nativeFx", {}).get("phaser", {})
        require(phaser.get("enabled") is True, "phaser enable state did not round-trip")
        require(phaser.get("stages") == 12 and phaser.get("algorithm") == "allpassSweep", "phaser config did not round-trip")
        require(abs(phaser.get("rateHz", 0) - 3.5) < 1e-6, "phaser rate did not round-trip")

        status, updated = request("/v1/native-fx/phaser", "POST", {"feedback": 0.2})
        require(status == 200, "partial phaser config update failed")
        phaser = updated.get("nativeFx", {}).get("phaser", {})
        require(abs(phaser.get("feedback", 0) - 0.2) < 1e-6 and phaser.get("stages") == 12, "partial update did not preserve other fields")

        status, error = request("/v1/native-fx/phaser", "POST", {"algorithm": "biPhase"})
        require(status == 409 and "BI-PHASE is unavailable" in error.get("error", ""), "unsupported algorithm was not rejected clearly")
        status, error = request("/v1/native-fx/phaser", "POST", {"feedback": 0.95})
        require(status == 400 and "outside its supported range" in error.get("error", ""), "out-of-range phaser feedback was not rejected")

        # Selecting/replacing a catalog processor is a control-thread action:
        # stop the host before creating AUTO PAN in slot A, then exercise the
        # parameter-only compatibility route while the simulated engine runs.
        status, stopped = request("/v1/engine/stop", "POST", {})
        require(status == 200 and stopped.get("engineRunning") is False,
                "engine stop before catalog-slot selection failed in simulation")
        test_per_track_catalog_contract()
        status, configured = request("/v1/native-fx/auto-pan", "POST", {
            "slot": "A",
            "enabled": True,
            "algorithm": "equalPowerMidSideLfo",
            "rateHz": 4.0,
            "depth": 0.85,
            "waveform": "triangle",
            "wetMix": 0.75,
        })
        require(status == 200, f"valid AUTO PAN config was rejected: {configured}")
        fx = configured.get("nativeFx", {})
        auto_pan = fx.get("autoPan", {})
        expected_catalog_ids = [
            "filter.lpf", "filter.bpf", "filter.hpf", "phaser", "flanger", "dynamics", "dist", "reverb", "gate_reverb",
            "beat_repeat", "beat_scatter", "roll", "freeze", "warp", "tape_echo", "reverse_delay", "reverse_reverb", "fractional_delay", "mod_delay", "panning_delay", "twist", "granular_delay", "auto_pan",
            "manual_pan", "chorus", "tremolo", "ring_mod", "eq", "isolator", "stereo_enhance", "lo_fi", "radio",
            "sustainer", "vibrato", "slow_gear", "pattern_slicer", "step_slicer", "vinyl_flick", "preamp", "synth", "g2b",
            "transpose", "pitch_bend", "hrm_manual", "octave", "vocoder", "osc_voc_m", "osc_bot", "auto_riff", "hrm_auto_m", "robot", "electric", "beat_shift",
        ]
        actual_catalog_ids = fx.get("implementedCatalogEffects")
        require(actual_catalog_ids == expected_catalog_ids,
                f"Native catalog capability list mismatch: expected={expected_catalog_ids!r}; actual={actual_catalog_ids!r}")
        availability = {item.get("effectId"): item for item in fx.get("catalogEffectAvailability", [])}
        require(fx.get("parameterSchemaVersion") == 1,
                "Native parameter descriptor schema version was not published")
        require(len(availability) == 53, f"Native parameter schema should describe 53 catalog effects; got {len(availability)}")
        canonical_parameter_count = sum(len(item.get("parameters", [])) for item in availability.values())
        legacy_alias_count = sum(len(item.get("legacyParameterAliases", [])) for item in availability.values())
        require(canonical_parameter_count == 252 and legacy_alias_count == 2,
                f"Native parameter schema field count mismatch: canonical={canonical_parameter_count}, legacy={legacy_alias_count}")
        phaser_parameters = {item["id"]: item for item in availability["phaser"].get("parameters", [])}
        stages = phaser_parameters.get("stages", {})
        require(stages.get("minimum") == 4.0 and stages.get("maximum") == 12.0 and
                stages.get("defaultValue") == 8.0 and stages.get("discrete") is True and
                stages.get("discreteValues") == [4.0, 8.0, 12.0],
                f"Native PHASER stages descriptor missing exact bounds/choices: {stages}")
        lpf_parameters = {item["id"]: item for item in availability["filter.lpf"].get("parameters", [])}
        q_aliases = {item["id"]: item for item in availability["filter.lpf"].get("legacyParameterAliases", [])}
        require("q" not in lpf_parameters and q_aliases.get("q", {}).get("legacyAlias") is True and
                q_aliases["q"].get("minimum") == 0.5 and q_aliases["q"].get("maximum") == 12.0,
                f"LPF canonical controls or legacy q compatibility alias is wrong: {lpf_parameters}, {q_aliases}")
        require(availability["filter.lpf"].get("parameters") and availability["filter.lpf"].get("track") is True,
                "Native catalog parameter fields were not linked to their route availability")
        require(availability.get("warp", {}).get("sourceIndex") == 42 and
                availability.get("warp", {}).get("input") is True and
                availability.get("warp", {}).get("track") is True and
                availability.get("twist", {}).get("sourceIndex") == 43 and
                availability.get("twist", {}).get("input") is True and
                availability.get("twist", {}).get("track") is True,
                f"WARP/TWIST catalog route capability was not published: "
                f"warp={availability.get('warp')}, twist={availability.get('twist')}")
        require(availability.get("hrm_auto_m", {}).get("sourceIndex") == 19 and
                availability.get("hrm_auto_m", {}).get("input") is True and
                availability.get("hrm_auto_m", {}).get("track") is True,
                f"HRM AUTO catalog availability was not published: {availability.get('hrm_auto_m')}")
        require(availability.get("tape_echo", {}).get("input") is True and
                availability.get("tape_echo", {}).get("track") is True and
                availability.get("granular_delay", {}).get("sourceIndex") == 41 and
                availability.get("granular_delay", {}).get("input") is True and
                availability.get("granular_delay", {}).get("track") is True and
                availability.get("radio", {}).get("sourceIndex") == 8 and
                availability.get("radio", {}).get("input") is True and
                availability.get("radio", {}).get("track") is True and
                availability.get("sustainer", {}).get("sourceIndex") == 11 and
                availability.get("sustainer", {}).get("input") is True and
                availability.get("sustainer", {}).get("track") is True and
                availability.get("vibrato", {}).get("sourceIndex") == 33 and
                availability.get("vibrato", {}).get("input") is True and
                availability.get("vibrato", {}).get("track") is True and
                availability.get("panning_delay", {}).get("sourceIndex") == 37 and
                availability.get("panning_delay", {}).get("input") is True and
                availability.get("panning_delay", {}).get("track") is True and
                availability.get("slow_gear", {}).get("sourceIndex") == 13 and
                availability.get("slow_gear", {}).get("input") is True and
                availability.get("slow_gear", {}).get("track") is True and
                availability.get("pattern_slicer", {}).get("sourceIndex") == 34 and
                availability.get("pattern_slicer", {}).get("input") is True and
                availability.get("pattern_slicer", {}).get("track") is True and
                availability.get("step_slicer", {}).get("sourceIndex") == 35 and
                availability.get("step_slicer", {}).get("input") is True and
                availability.get("step_slicer", {}).get("track") is True and
                availability.get("vinyl_flick", {}).get("sourceIndex") == 53 and
                availability.get("vinyl_flick", {}).get("input") is False and
                availability.get("vinyl_flick", {}).get("track") is True and
                availability.get("preamp", {}).get("sourceIndex") == 23 and
                availability.get("preamp", {}).get("input") is True and
                availability.get("preamp", {}).get("track") is True and
                availability.get("synth", {}).get("sourceIndex") == 6 and
                availability.get("synth", {}).get("input") is True and
                availability.get("synth", {}).get("track") is True and
                availability.get("g2b", {}).get("sourceIndex") == 10 and
                availability.get("g2b", {}).get("input") is True and
                availability.get("g2b", {}).get("track") is True and
                availability.get("osc_voc_m", {}).get("sourceIndex") == 21 and
                availability.get("osc_voc_m", {}).get("input") is True and
                availability.get("osc_voc_m", {}).get("track") is True and
                availability.get("osc_bot", {}).get("sourceIndex") == 22 and
                availability.get("osc_bot", {}).get("input") is True and
                availability.get("osc_bot", {}).get("track") is True and
                availability.get("beat_repeat", {}).get("input") is False and
                availability.get("beat_repeat", {}).get("track") is True and
                availability.get("roll", {}).get("sourceIndex") == 44 and
                availability.get("roll", {}).get("input") is True and
                availability.get("roll", {}).get("track") is True and
                availability.get("freeze", {}).get("sourceIndex") == 45 and
                availability.get("freeze", {}).get("input") is True and
                availability.get("freeze", {}).get("track") is True,
                "Native catalog input/track availability or source index was incorrect")
        require("autoPan" not in fx.get("implementedOutputEffects", []), "AUTO PAN was incorrectly counted as a global output stage")
        require(auto_pan.get("available") is True and auto_pan.get("enabled") is True, "AUTO PAN status did not report active")
        require(auto_pan.get("algorithm") == "equalPowerMidSideLfo" and auto_pan.get("slot") == "A", "AUTO PAN algorithm/slot did not round-trip")
        require(auto_pan.get("waveform") == "triangle" and abs(auto_pan.get("depth", 0) - 0.85) < 1e-6, "AUTO PAN parameters did not round-trip")

        status, started = request("/v1/engine/start", "POST", {})
        require(status == 200 and started.get("engineRunning") is True,
                "engine restart after catalog-slot selection failed in simulation")
        status, updated = request("/v1/native-fx/auto-pan", "POST", {"depth": 0.2})
        require(status == 200, "partial AUTO PAN config update failed")
        auto_pan = updated.get("nativeFx", {}).get("autoPan", {})
        require(abs(auto_pan.get("depth", 0) - 0.2) < 1e-6 and auto_pan.get("waveform") == "triangle", "partial AUTO PAN update did not preserve other parameters")
        status, error = request("/v1/native-fx/auto-pan", "POST", {"algorithm": "rotary"})
        require(status == 409 and "equalPowerMidSideLfo" in error.get("error", ""), "unsupported AUTO PAN algorithm was not rejected clearly")
        status, error = request("/v1/native-fx/auto-pan", "POST", {"rateHz": 25.0})
        require(status == 400 and "outside its supported range" in error.get("error", ""), "out-of-range AUTO PAN rate was not rejected")
        status, error = request("/v1/native-fx/auto-pan", "POST", {"slot": "B"})
        require(status == 409 and "maps to catalog slot A" in error.get("error", ""),
                f"inactive AUTO PAN slot was not rejected: {error}")

        status, configured = request("/v1/native-pitch/config", "POST", {"enabled": True, "semitones": 5.0})
        require(status == 200, f"valid Native LIVE_MONO config was rejected: {configured}")
        pitch = configured.get("nativePitch", {})
        require(pitch.get("enabled") is True and pitch.get("pitchCorrectionImplemented") is True,
                "Native LIVE_MONO status did not report the requested implementation")
        require(pitch.get("trackId") == 0,
                "omitted Native pitch trackId did not preserve the legacy global route")
        require(pitch.get("mode") == "liveMonoKeepPitch" and pitch.get("semitones") == 5.0,
                "Native pitch mode/semitones did not round-trip")
        require(pitch.get("algorithm") == "cleanRoomYinPsola" and pitch.get("latencySamples", 0) > 0,
                "Native LIVE_MONO algorithm/latency provenance was not exposed")
        require(pitch.get("active") is False and pitch.get("fallbackReason") == "notRequested",
                "pitch should stay inactive until a loop is playing")
        status, selected = request("/v1/native-pitch/config", "POST", {
            "enabled": True, "mode": "LIVE_MONO", "semitones": 5.0, "trackId": 2,
        })
        require(status == 200 and selected.get("nativePitch", {}).get("trackId") == 2,
                f"Native pitch target track was not acknowledged: {selected}")
        status, error = request("/v1/native-pitch/config", "POST", {"trackId": 6})
        require(status == 400 and "trackId" in error.get("error", ""),
                "out-of-range Native pitch target was not rejected")
        status, configured = request("/v1/native-pitch/config", "POST", {
            "enabled": True, "mode": "livePolyPhaseVocoder", "semitones": 7.0,
        })
        require(status == 200, f"valid Native LIVE_POLY config was rejected: {configured}")
        pitch = configured.get("nativePitch", {})
        require(pitch.get("mode") == "livePolyPhaseVocoder" and
                pitch.get("algorithm") == "signalsmithStretch132Cheaper" and
                pitch.get("semitones") == 7.0 and pitch.get("latencySamples") == 6720 and
                pitch.get("trackId") == 0,
                "Native LIVE_POLY mode, Signalsmith algorithm, shift, or configured latency did not round-trip")
        status, error = request("/v1/native-pitch/config", "POST", {"mode": "LIVE_WALLA"})
        require(status == 400 and "livePolyPhaseVocoder" in error.get("error", ""),
                "unsupported Native pitch mode was not rejected clearly")
        status, error = request("/v1/native-pitch/config", "POST", {"semitones": 13.0})
        require(status == 400 and "between -12 and +12" in error.get("error", ""),
                "out-of-range Native pitch shift was not rejected")

        status, configured = request("/v1/native-rhythm/config", "POST", {"patternIndex": 22})
        require(status == 200, f"metadata pattern selection was rejected: {configured}")
        rhythm = configured.get("nativeRhythm", {})
        require(rhythm.get("patternCatalogAvailable") is True and rhythm.get("patternIndex") == 22,
                "metadata pattern index/catalog availability did not round-trip")
        require(rhythm.get("beat") == "6/8" and rhythm.get("meterNumerator") == 6 and
                rhythm.get("meterDenominator") == 8, "pattern meter metadata was not exposed")
        require(rhythm.get("eventsCleanRoomProcedural") is True,
                "rhythm event provenance must distinguish procedural audio from metadata")
        status, error = request("/v1/native-rhythm/config", "POST", {"patternIndex": 241})
        require(status == 400 and "1 to 240" in error.get("error", ""),
                "out-of-range rhythm pattern index was not rejected")

        status, stopped = request("/v1/engine/stop", "POST", {})
        require(status == 200 and stopped.get("engineRunning") is False, "engine stop route failed in simulation")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "B",
            "effectId": "flanger",
            "parameters": {
                "delay_ms": 2.75,
                "rate_hz": 1.25,
                "depth": 0.7,
                "feedback": -0.3,
                "wet_mix": 0.8,
            },
        })
        require(status == 200, f"valid Native Flanger catalog-slot config was rejected: {configured}")
        catalog_slots = configured.get("nativeFx", {}).get("catalogSlots", [])
        slot_b = next((slot for slot in catalog_slots if slot.get("slot") == "B"), {})
        require(slot_b.get("effectId") == "flanger" and slot_b.get("bypassed") is False,
                f"Native Flanger was not routed into catalog slot B: {slot_b}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "C",
            "effectId": "flanger",
            "parameters": {"feedback": 1.0},
        })
        require(status == 409 and "Invalid Native catalog FX parameter 'feedback'" in error.get("error", ""),
                "out-of-range Native Flanger catalog parameter was not rejected")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "C",
            "effectId": "dynamics",
            "parameters": {
                "threshold_db": -24.0,
                "ratio": 8.0,
                "knee_db": 4.0,
                "attack_ms": 5.0,
                "release_ms": 150.0,
                "output_gain_db": 1.0,
                "detector": 1.0,
            },
        })
        require(status == 200, f"valid Native Dynamics catalog-slot config was rejected: {configured}")
        catalog_slots = configured.get("nativeFx", {}).get("catalogSlots", [])
        slot_c = next((slot for slot in catalog_slots if slot.get("slot") == "C"), {})
        require(slot_c.get("effectId") == "dynamics" and slot_c.get("bypassed") is False,
                f"Native Dynamics was not routed into catalog slot C: {slot_c}")

        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "D",
            "effectId": "dist",
            "parameters": {"drive_db": 24.0, "mix_percent": 70.0},
        })
        require(status == 200, f"valid Native clean-room distortion config was rejected: {configured}")
        slot_d = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "D"), {})
        require(slot_d.get("effectId") == "dist" and slot_d.get("bypassed") is False,
                f"Native distortion was not routed into catalog slot D: {slot_d}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "A",
            "effectId": "reverb",
            "parameters": {"decay_seconds": 4.0, "damping_cutoff_hz": 10000.0, "wet_mix": 0.45},
        })
        require(status == 200, f"valid Native FDN16 reverb config was rejected: {error}")
        slot_a = next((slot for slot in error.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "A"), {})
        require(slot_a.get("effectId") == "reverb" and slot_a.get("bypassed") is False,
                f"Native FDN16 reverb was not routed into catalog slot A: {slot_a}")

        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "B",
            "effectId": "beat_repeat",
            "parameters": {"bpm": 90.0, "division": 0.25, "decay": 35.0, "direction": 2.0, "mix_percent": 65.0},
        })
        require(status == 200, f"valid Native Beat Repeat catalog-slot config was rejected: {configured}")
        slot_b = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "B"), {})
        require(slot_b.get("effectId") == "beat_repeat" and slot_b.get("bypassed") is False,
                f"Native Beat Repeat was not routed into catalog slot B: {slot_b}")

        roll_parameters = {
            "bpm": 90.0,
            "slice_beats": 0.5,
            "decay_percent": 20.0,
            "pitch_semitones": -12.0,
            "direction": 2.0,
            "mix_percent": 70.0,
        }
        for path, result_key in (("input", "inputCatalogSlots"), ("track", "catalogSlots")):
            for slot_name in ("A", "B", "C", "D"):
                status, routed = request("/v1/native-fx/catalog-slot", "POST", {
                    "path": path,
                    "slot": slot_name,
                    "effectId": "roll",
                    "parameters": roll_parameters,
                })
                require(status == 200, f"Native ROLL {path} {slot_name} route failed: {routed}")
                slots = routed.get("nativeFx", {}).get(result_key, [])
                selected = next((slot for slot in slots if slot.get("slot") == slot_name), {})
                require(selected.get("effectId") == "roll" and selected.get("bypassed") is False,
                        f"Native ROLL was not selected on {path} slot {slot_name}: {selected}")
        freeze_parameters = {
            "capture_ms": 20.0,
            "mode": 0.0,
            "pitch_semitones": -12.0,
            "freeze": 0.0,
            "mix_percent": 80.0,
        }
        for path, result_key in (("input", "inputCatalogSlots"), ("track", "catalogSlots")):
            for slot_name in ("A", "B", "C", "D"):
                status, routed = request("/v1/native-fx/catalog-slot", "POST", {
                    "path": path,
                    "slot": slot_name,
                    "effectId": "freeze",
                    "parameters": freeze_parameters,
                })
                require(status == 200, f"Native FREEZE {path} {slot_name} route failed: {routed}")
                slots = routed.get("nativeFx", {}).get(result_key, [])
                selected = next((slot for slot in slots if slot.get("slot") == slot_name), {})
                require(selected.get("effectId") == "freeze" and selected.get("bypassed") is False,
                        f"Native FREEZE was not selected on {path} slot {slot_name}: {selected}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "A", "effectId": "freeze",
            "parameters": {"mode": 1.0},
        })
        require(status == 409 and "Unsupported discrete Native catalog FX value for parameter 'mode'" in error.get("error", ""),
                f"Native FREEZE spectral mode was not rejected clearly: {error}")

        warp_parameters = {
            "bpm": 120.0,
            "capture_beats": 0.25,
            "smear_percent": 45.0,
            "pitch_semitones": 7.0,
            "feedback_percent": 55.0,
            "freeze": 0.0,
            "mix_percent": 100.0,
        }
        for path, result_key, slot_name in (
            ("input", "inputCatalogSlots", "A"),
            ("track", "catalogSlots", "D"),
        ):
            status, routed = request("/v1/native-fx/catalog-slot", "POST", {
                "path": path,
                "slot": slot_name,
                "effectId": "warp",
                "parameters": warp_parameters,
            })
            require(status == 200, f"Native WARP {path} {slot_name} route failed: {routed}")
            slots = routed.get("nativeFx", {}).get(result_key, [])
            selected = next((slot for slot in slots if slot.get("slot") == slot_name), {})
            require(selected.get("effectId") == "warp" and selected.get("bypassed") is False,
                    f"Native WARP was not selected on {path} slot {slot_name}: {selected}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "D", "effectId": "warp",
            "parameters": {"spectral_mode": 1.0},
        })
        require(status == 409 and "spectral_mode" in error.get("error", ""),
                f"Native WARP unsupported spectral mode was not rejected clearly: {error}")

        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "A", "effectId": "roll",
            "parameters": {"decay_percent": 100.1},
        })
        require(status == 409 and "Invalid Native catalog FX parameter 'decay_percent'" in error.get("error", ""),
                f"out-of-range Native ROLL decay was not rejected: {error}")

        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track",
            "slot": "A",
            "effectId": "panning_delay",
            "parameters": {
                "time_ms": 125.5,
                "feedback_percent": 35.0,
                "pan_percent": -70.0,
                "mix_percent": 80.0,
            },
        })
        require(status == 200, f"valid Native PANNING DELAY Track-path config was rejected: {configured}")
        track_slot_a = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "A"), {})
        require(track_slot_a.get("effectId") == "panning_delay" and track_slot_a.get("bypassed") is False,
                f"Native PANNING DELAY was not routed into the Track A bank: {track_slot_a}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input",
            "slot": "A",
            "effectId": "panning_delay",
            "parameters": {
                "time_ms": 333.25,
                "feedback_percent": 62.0,
                "pan_percent": 55.0,
                "mix_percent": 45.0,
            },
        })
        require(status == 200, f"valid Native PANNING DELAY Input-path config was rejected: {configured}")
        input_slot_a = next((slot for slot in configured.get("nativeFx", {}).get("inputCatalogSlots", []) if slot.get("slot") == "A"), {})
        track_slot_a = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "A"), {})
        require(input_slot_a.get("effectId") == "panning_delay" and track_slot_a.get("effectId") == "panning_delay",
                f"PANNING DELAY did not remain independently selected on Input and Track A banks: input={input_slot_a}, track={track_slot_a}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input",
            "slot": "A",
            "effectId": "panning_delay",
            "parameters": {"pan_percent": 100.1},
        })
        require(status == 409 and "Invalid Native catalog FX parameter 'pan_percent'" in error.get("error", ""),
                f"out-of-range Native PANNING DELAY pan was not rejected: {error}")

        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track",
            "slot": "D",
            "effectId": "vinyl_flick",
            "parameters": {
                "speed_percent": 0.0,
                "motor_return_seconds": 1.5,
                "brake_percent": 35.0,
                "mix_percent": 50.0,
            },
        })
        require(status == 200, f"valid experimental Native VINYL FLICK Track config was rejected: {configured}")
        vinyl_slot_d = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "D"), {})
        require(vinyl_slot_d.get("effectId") == "vinyl_flick" and vinyl_slot_d.get("bypassed") is False,
                f"Native VINYL FLICK was not routed into Track D: {vinyl_slot_d}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "D", "effectId": "vinyl_flick",
            "parameters": {"speed_percent": 0.0},
        })
        require(status == 409 and "not available on the requested input path" in error.get("error", ""),
                f"Native VINYL FLICK was accepted on Input: {error}")
        status, after_input_reject = request("/v1/status")
        require(status == 200, "Native status after rejected VINYL FLICK Input config was unavailable")
        track_slot_d = next((slot for slot in after_input_reject.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "D"), {})
        require(track_slot_d.get("effectId") == "vinyl_flick",
                f"rejected Input config changed the experimental Track D selection: {track_slot_d}")

        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "A", "effectId": "preamp",
            "parameters": {"model": 3.0, "gain": 78.0, "bass": -2.0,
                           "middle": 3.0, "treble": 1.5, "level": -1.0},
        })
        require(status == 200, f"valid Native PREAMP Track config was rejected: {configured}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "A", "effectId": "preamp",
            "parameters": {"model": 1.0, "gain": 32.0, "bass": 2.0,
                           "middle": -1.0, "treble": 3.0, "level": 0.5},
        })
        require(status == 200, f"valid Native PREAMP Input config was rejected: {configured}")
        input_slot_a = next((slot for slot in configured.get("nativeFx", {}).get("inputCatalogSlots", [])
                             if slot.get("slot") == "A"), {})
        track_slot_a = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", [])
                             if slot.get("slot") == "A"), {})
        require(input_slot_a.get("effectId") == "preamp" and track_slot_a.get("effectId") == "preamp",
                f"Native PREAMP did not remain independently selected on Input and Track A banks: "
                f"input={input_slot_a}, track={track_slot_a}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "B", "effectId": "preamp", "parameters": {"model": 1.5},
        })
        require(status == 409 and "Unsupported discrete Native catalog FX value for parameter 'model'" in error.get("error", ""),
                f"invalid Native PREAMP model was not rejected: {error}")

        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "C",
            "effectId": "tape_echo",
            "parameters": {
                "time_ms": 280.0,
                "feedback_percent": 42.0,
                "wow_flutter_percent": 35.0,
                "saturation_percent": 55.0,
                "tone_hz": 4200.0,
                "mix_percent": 60.0,
            },
        })
        require(status == 200, f"valid Native TAPE ECHO catalog-slot config was rejected: {configured}")
        slot_c = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "C"), {})
        require(slot_c.get("effectId") == "tape_echo" and slot_c.get("bypassed") is False,
                f"Native TAPE ECHO was not routed into catalog slot C: {slot_c}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input",
            "slot": "C",
            "effectId": "filter.lpf",
            "parameters": {"cutoff_hz": 2400.0, "q": 0.70710678},
        })
        require(status == 200, f"valid Native Input-path catalog config was rejected: {configured}")
        input_slots = configured.get("nativeFx", {}).get("inputCatalogSlots", [])
        input_slot_c = next((slot for slot in input_slots if slot.get("slot") == "C"), {})
        track_slot_c = next((slot for slot in configured.get("nativeFx", {}).get("catalogSlots", []) if slot.get("slot") == "C"), {})
        require(input_slot_c.get("effectId") == "filter.lpf" and track_slot_c.get("effectId") == "tape_echo",
                f"Input and Track A-D paths did not retain independent slot selection: input={input_slot_c}, track={track_slot_c}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input",
            "slot": "D",
            "effectId": "lo_fi",
            "parameters": {"bit_depth": 8.0, "sample_rate_hz": 8000.0, "filter_hz": 6500.0, "mix_percent": 85.0},
        })
        require(status == 200, f"valid Native LO-FI Input-path config was rejected: {configured}")
        input_slot_d = next((slot for slot in configured.get("nativeFx", {}).get("inputCatalogSlots", []) if slot.get("slot") == "D"), {})
        require(input_slot_d.get("effectId") == "lo_fi" and input_slot_d.get("bypassed") is False,
                f"Native LO-FI did not round-trip through the Input bank: {input_slot_d}")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "mystery",
            "slot": "D",
            "effectId": "filter.lpf",
        })
        require(status == 400 and "path" in error.get("error", ""),
                "unknown Native catalog FX path was not rejected")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input",
            "slot": "D",
            "effectId": "beat_repeat",
        })
        require(status == 409 and "not available on the requested input path" in error.get("error", ""),
                "Track-only Native Beat Repeat was accepted on the Input path")
        status, error = request("/v1/native-fx/catalog-slot", "POST", {
            "slot": "C",
            "effectId": "tape_echo",
            "parameters": {"feedback_percent": 95.1},
        })
        require(status == 409 and "Invalid Native catalog FX parameter 'feedback_percent'" in error.get("error", ""),
                f"out-of-range Native TAPE ECHO feedback was not rejected as expected: status={status}, body={error}")

        status, configured = request("/v1/native-fx/reverb", "POST", {
            "enabled": True,
            "wetMix": 0.4,
            "rt60Seconds": 3.0,
            "dampingCutoffHz": 9000.0,
        })
        require(status == 200, f"global Native FDN16 output config was rejected: {configured}")
        native_fx = configured.get("nativeFx", {})
        require("fdn16Reverb" in native_fx.get("implementedOutputEffects", []),
                "Native output stage did not advertise its FDN16 implementation")
        require(abs(native_fx.get("outputReverbDampingCutoffHz", 0) - 9000.0) < 1e-6,
                "global FDN16 damping control did not round-trip")
        status, error = request("/v1/native-fx/reverb", "POST", {"dampingCutoffHz": 499.0})
        require(status == 400 and "500 to 20000" in error.get("error", ""),
                "out-of-range FDN16 damping cutoff was not rejected")

        status, stopped = request("/v1/engine/stop", "POST", {})
        require(status == 200 and stopped.get("engineRunning") is False,
                "engine stop before Native RADIO simulation routing failed")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "B", "effectId": "radio",
            "parameters": {"band": 1.0, "drive": 25.0, "noise": 0.0, "mix": 100.0},
        })
        require(status == 200, f"Native RADIO Input slot was rejected: {configured}")
        input_slots = configured.get("nativeFx", {}).get("inputCatalogSlots", [])
        input_radio = next((slot for slot in input_slots if slot.get("slot") == "B"), {})
        require(input_radio.get("effectId") == "radio" and input_radio.get("bypassed") is False,
                f"Native RADIO was not available through Input B: {input_radio}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "D", "effectId": "radio",
            "parameters": {"band": 2.0, "drive": 55.0, "noise": 0.0, "mix": 100.0},
        })
        require(status == 200, f"Native RADIO Track slot was rejected: {configured}")
        track_slots = configured.get("nativeFx", {}).get("catalogSlots", [])
        track_radio = next((slot for slot in track_slots if slot.get("slot") == "D"), {})
        require(track_radio.get("effectId") == "radio" and track_radio.get("bypassed") is False,
                f"Native RADIO was not available through Track D: {track_radio}")
        slow_gear_parameters = {
            "attack_ms": 375.0, "sensitivity_percent": 68.0, "mix_percent": 92.0,
        }
        for path, result_key in (("input", "inputCatalogSlots"), ("track", "catalogSlots")):
            for slot_name in ("A", "B", "C", "D"):
                status, routed = request("/v1/native-fx/catalog-slot", "POST", {
                    "path": path, "slot": slot_name, "effectId": "slow_gear",
                    "parameters": slow_gear_parameters,
                })
                require(status == 200, f"Native SLOW GEAR {path.title()} slot {slot_name} was rejected: {routed}")
                slots = routed.get("nativeFx", {}).get(result_key, [])
                selected = next((slot for slot in slots if slot.get("slot") == slot_name), {})
                require(selected.get("effectId") == "slow_gear" and selected.get("bypassed") is False,
                        f"Native SLOW GEAR was not routed through {path.title()} {slot_name}: {selected}")
        status, started = request("/v1/engine/start", "POST", {})
        require(status == 200 and started.get("engineRunning") is True,
                "engine restart before Native HQ snapshot simulation failed")

        # Exercise both the backward-compatible default Track 1 route and an
        # explicitly selected Track 2 over the test-only fake callback source.
        # These bytes are synthetic route data, not device, timing, XRUN, or
        # audio-quality evidence.
        for track_id, selector, record_seconds in ((1, "", 0.30), (2, "?trackId=2", 0.03)):
            status, recording = request(f"/v1/transport/record{selector}", "POST", {})
            require(status == 200, f"simulation recording command for Track {track_id} was rejected: {recording}")
            time.sleep(record_seconds)
            status, stopped = request(f"/v1/transport/stop{selector}", "POST", {})
            require(status == 200, f"simulation recording stop for Track {track_id} was rejected: {stopped}")
            time.sleep(0.10 if track_id == 1 else 0.01)
            status, headers, snapshot = request_raw(
                f"/v1/export/loop-snapshot{selector}",
                {"Origin": "http://localhost:5173"},
            )
            require(status == 200, f"Native Track {track_id} snapshot route failed: HTTP {status} {snapshot[:200]!r}")
            header_values = {key.lower(): value for key, value in headers.items()}
            require(header_values.get("content-type", "").startswith("application/octet-stream"),
                    "snapshot response did not use an octet-stream payload")
            require(header_values.get("access-control-allow-origin") == "http://localhost:5173",
                    "snapshot route did not echo its allowed loopback origin")
            require(headers.get_all("Access-Control-Allow-Origin", []) == ["http://localhost:5173"],
                    "snapshot route emitted duplicate Access-Control-Allow-Origin values")
            require(header_values.get("x-native-loop-sample-rate") == "48000" and
                    header_values.get("x-native-loop-sample-format") == "float32le" and
                    header_values.get("x-native-loop-channels") == "2" and
                    header_values.get("x-native-loop-revision", "").isdigit(),
                    "snapshot metadata headers did not report stereo sample rate/format")
            frame_count = int(header_values.get("x-native-loop-frame-count", "0"))
            require(frame_count > 0 and len(snapshot) == frame_count * 2 * 4,
                    f"Track {track_id} snapshot payload length {len(snapshot)} did not match {frame_count} stereo float32 frames")
            float_samples = struct.unpack(f"<{frame_count * 2}f", snapshot)
            require(all(math.isfinite(sample) for sample in float_samples) and
                    any(abs(sample) > 1e-5 for sample in float_samples),
                    f"Track {track_id} snapshot was not finite non-silent stereo simulation data")
            status, track_status = request("/v1/status")
            require(status == 200, f"status after Track {track_id} recording failed")
            reported_tracks = track_status.get("nativeTracks", [])
            selected_state = next((track.get("state") for track in reported_tracks
                                   if track.get("trackId") == track_id), None)
            require(selected_state == "Stopped", f"Track {track_id} state did not persist after recording: {selected_state}")
            selected_track = next((track for track in reported_tracks if track.get("trackId") == track_id), {})
            require(selected_track.get("contentRevision") == int(header_values["x-native-loop-revision"]),
                    f"Track {track_id} snapshot revision did not match its callback-published status: {selected_track}")

            if track_id == 1:
                track_one = next((track for track in reported_tracks if track.get("trackId") == 1), {})
                history = track_one.get("history", {})
                require(history.get("canUndo") is True and history.get("canRedo") is False,
                        f"Native Track 1 did not publish an undoable PCM history step: {history}")
                original_pcm_digest = hashlib.sha256(snapshot).hexdigest()
                status, undone = request("/v1/transport/undo", "POST", {})
                undone_track = next((track for track in undone.get("nativeTracks", []) if track.get("trackId") == 1), {})
                require(status == 200 and undone_track.get("state") == "Empty" and
                        undone_track.get("contentRevision", 0) > selected_track.get("contentRevision", 0) and
                        undone_track.get("history", {}).get("canUndo") is False and
                        undone_track.get("history", {}).get("canRedo") is True,
                        f"Native Track 1 PCM undo did not restore the prior empty state: {undone_track}")
                status, rejected_undo = request("/v1/transport/undo", "POST", {})
                require(status == 409 and "No Native undo step" in rejected_undo.get("error", ""),
                        f"Native host did not visibly reject a second undo without history: {rejected_undo}")
                status, after_rejected_undo = request("/v1/status")
                still_undone = next((track for track in after_rejected_undo.get("nativeTracks", []) if track.get("trackId") == 1), {})
                require(status == 200 and still_undone.get("state") == "Empty" and
                        still_undone.get("history", {}).get("canRedo") is True,
                        f"A rejected repeated undo changed the acknowledged track state: {still_undone}")
                status, empty_metadata = request("/v1/export/track-metadata")
                require(status == 409 and "finalized, non-empty loop" in empty_metadata.get("error", ""),
                        "Native PCM undo left loop data addressable through the export metadata route")
                status, redone = request("/v1/transport/redo", "POST", {})
                redone_track = next((track for track in redone.get("nativeTracks", []) if track.get("trackId") == 1), {})
                require(status == 200 and redone_track.get("state") == "Stopped" and
                        redone_track.get("contentRevision", 0) > undone_track.get("contentRevision", 0) and
                        redone_track.get("history", {}).get("canUndo") is True and
                        redone_track.get("history", {}).get("canRedo") is False,
                        f"Native Track 1 PCM redo did not restore the completed loop: {redone_track}")
                status, redone_headers, redone_pcm = request_raw("/v1/export/loop-snapshot")
                redone_header_values = {key.lower(): value for key, value in redone_headers.items()}
                require(status == 200 and hashlib.sha256(redone_pcm).hexdigest() == original_pcm_digest and
                        redone_header_values.get("x-native-loop-revision") == str(redone_track.get("contentRevision")),
                        "Native PCM redo did not restore the exact original stereo sample bytes")

            if track_id == 2:
                status, playing = request("/v1/transport/play?trackId=2", "POST", {})
                require(status == 200, f"Track 2 play command was rejected: {playing}")
                time.sleep(0.01)
                status, track_status = request("/v1/status")
                reported_tracks = track_status.get("nativeTracks", [])
                selected_state = next((track.get("state") for track in reported_tracks
                                       if track.get("trackId") == 2), None)
                require(status == 200 and selected_state == "Playing",
                        f"Track 2 play state did not persist: {selected_state}")

                status, overdubbing = request("/v1/transport/overdub-toggle?trackId=2", "POST", {})
                require(status == 200, f"Track 2 overdub command was rejected: {overdubbing}")
                time.sleep(0.01)
                status, track_status = request("/v1/status")
                reported_tracks = track_status.get("nativeTracks", [])
                selected_state = next((track.get("state") for track in reported_tracks
                                       if track.get("trackId") == 2), None)
                require(status == 200 and selected_state == "Overdubbing",
                        f"Track 2 overdub state did not persist: {selected_state}")

                status, stopped = request("/v1/transport/stop?trackId=2", "POST", {})
                require(status == 200, f"Track 2 overdub stop was rejected: {stopped}")
                time.sleep(0.01)
                status, cleared = request("/v1/transport/clear?trackId=2", "POST", {})
                require(status == 200, f"Track 2 clear command was rejected: {cleared}")
                time.sleep(0.01)
                status, track_status = request("/v1/status")
                reported_tracks = track_status.get("nativeTracks", [])
                selected_state = next((track.get("state") for track in reported_tracks
                                       if track.get("trackId") == 2), None)
                require(status == 200 and selected_state == "Empty",
                        f"Track 2 clear state did not persist: {selected_state}")

        status, empty_track_metadata = request("/v1/export/track-metadata?trackId=2")
        require(status == 409 and "finalized, non-empty loop" in empty_track_metadata.get("error", ""),
                "metadata endpoint did not reject an empty selected track after Track 2 was cleared")

        # The simulation-only host feeds a deterministic 440 Hz test oscillator
        # into the real Native looper and HTTP bridge. These checks exercise the
        # metadata-only preflight and offline R2/R3 route end to end. The sample
        # source is synthetic; this is not a physical audio-device test.
        status, metadata = request("/v1/export/track-metadata?trackId=1", headers={"Origin": "http://localhost:5173"})
        require(status == 200 and metadata.get("channels") == 2 and
                metadata.get("sampleRate") == 48000 and metadata.get("frameCount", 0) > 0,
                f"metadata-only route did not report a completed loop: {metadata}")
        status, metadata_headers, metadata_body = request_raw(
            "/v1/export/track-metadata?trackId=1", {"Origin": "http://127.0.0.1:4174"}
        )
        require(status == 200 and metadata_headers.get_all("Access-Control-Allow-Origin", []) == ["http://127.0.0.1:4174"],
                f"metadata route did not emit exactly one CORS origin header: {metadata_headers}")
        require(json.loads(metadata_body.decode("utf-8")) == metadata,
                "metadata route returned different payloads during CORS header validation")
        status, before_hq_status = request("/v1/status")
        track_one = next((track for track in before_hq_status.get("nativeTracks", []) if track.get("trackId") == 1), {})
        require(status == 200 and track_one.get("state") == "Stopped",
                f"Track 1 was not stopped before HQ_RENDER: {track_one}")
        status, metadata_error = request("/v1/export/track-metadata?trackId=6")
        require(status == 400 and "trackId" in metadata_error.get("error", ""),
                "metadata endpoint did not reject an invalid track selector")
        hq_body = {
            "semitones": 12,
            "playbackRate": 1.25,
            "engine": "invalid",
            "format": "pcm16",
            "memoryBudgetBytes": 512 * 1024 * 1024,
        }
        if hq_capability.get("available") is True:
            status, _, invalid_engine = request_binary("/v1/export/hq-render?trackId=1", "POST", hq_body)
            require(status == 400 and b"engine must be R2 or R3" in invalid_engine,
                    "HQ_RENDER silently accepted an unsupported engine")
            status, _, over_budget = request_binary("/v1/export/hq-render?trackId=1", "POST", {
                **hq_body,
                "engine": "R2",
                "memoryBudgetBytes": 64 * 1024 * 1024,
            })
            require(status == 413 and b"exceeds the configured Native memory estimate" in over_budget,
                    "HQ_RENDER did not reject an under-budget render before allocating its snapshot")
            for engine_name in ("R2", "R3"):
                hq_body["engine"] = engine_name
                status, headers, rendered = request_binary("/v1/export/hq-render?trackId=1", "POST", hq_body)
                require(status == 200,
                        f"Native {engine_name} HQ_RENDER failed (metadata={metadata}, track={track_one}): {rendered[:300]!r}")
                frames = int(headers.get("X-Native-Loop-Frame-Count", "0"))
                channels = int(headers.get("X-Native-Loop-Channels", "0"))
                rate = int(headers.get("X-Native-Loop-Sample-Rate", "0"))
                require(headers.get("X-Native-HQ-Engine") == engine_name and
                        headers.get("X-Native-HQ-Latency-Samples") == "0" and
                        channels == 2 and rate == 48000 and
                        frames == math.ceil(metadata["frameCount"] / hq_body["playbackRate"]),
                        f"Native {engine_name} HQ_RENDER metadata mismatch: {dict(headers)}")
                require(len(rendered) == frames * channels * 4,
                        f"Native {engine_name} HQ_RENDER returned truncated float32 PCM")
                pcm = struct.unpack("<" + "f" * (frames * channels), rendered)
                mono = [0.5 * (pcm[i] + pcm[i + 1]) for i in range(0, len(pcm), 2)]
                start = len(mono) // 5
                analysis = mono[start:len(mono) - start]
                def tone_magnitude(frequency):
                    real = 0.0
                    imag = 0.0
                    for index, sample in enumerate(analysis):
                        angle = 2 * math.pi * frequency * index / rate
                        real += sample * math.cos(angle)
                        imag -= sample * math.sin(angle)
                    return math.hypot(real, imag)
                target_magnitude = max(tone_magnitude(frequency) for frequency in range(850, 911, 2))
                source_magnitude = tone_magnitude(440)
                require(target_magnitude > 1.5 * source_magnitude,
                        f"Native {engine_name} render did not shift the simulation tone: target={target_magnitude} source={source_magnitude}")
        else:
            status, _, unavailable = request_binary("/v1/export/hq-render?trackId=1", "POST", {
                **hq_body,
                "engine": "R3",
            })
            require(status == 501 and b"disabled in this build" in unavailable,
                    "Native HQ_RENDER build capability was false but endpoint did not explicitly reject")

        status, error = request("/v1/export/loop-snapshot?trackId=0")
        require(status == 400, f"invalid Native snapshot selector was not rejected: {error}")

        status, stopped = request("/v1/engine/stop", "POST", {})
        require(status == 200 and stopped.get("engineRunning") is False,
                "engine stop before OSC VOC route selection failed")
        osc_parameters = {"waveform": 2.0, "midi-channel": 3.0, "octave": 7.0, "mix": 82.0}
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "A", "effectId": "osc_voc_m", "parameters": osc_parameters,
        })
        require(status == 200, f"OSC VOC Input A selection failed: {configured}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "D", "effectId": "osc_voc_m", "parameters": osc_parameters,
        })
        require(status == 200, f"OSC VOC shared Track D selection failed: {configured}")
        osc_bot_parameters = {
            "bands": 16.0, "waveform": 1.0, "pattern": 3.0,
            "tone": 8000.0, "tempo": 120.0, "mix": 82.0,
        }
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "B", "effectId": "osc_bot", "parameters": osc_bot_parameters,
        })
        require(status == 200, f"OSC BOT clean-room Input B selection failed: {configured}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "C", "effectId": "osc_bot", "parameters": osc_bot_parameters,
        })
        require(status == 200, f"OSC BOT clean-room shared Track C selection failed: {configured}")
        require(any(slot.get("slot") == "B" and slot.get("effectId") == "osc_bot"
                    for slot in configured.get("nativeFx", {}).get("inputCatalogSlots", [])) and
                any(slot.get("slot") == "C" and slot.get("effectId") == "osc_bot"
                    for slot in configured.get("nativeFx", {}).get("catalogSlots", [])),
                f"OSC BOT clean-room route/status did not round-trip: {configured}")
        status, started = request("/v1/engine/start", "POST", {})
        require(status == 200 and started.get("engineRunning") is True,
                "engine restart after OSC VOC selection failed")
        status, clock_status = request("/v1/status")
        midi_status = clock_status.get("nativeFx", {}).get("oscVocMidi", {})
        require(status == 200 and midi_status.get("eventQueueCapacity") == 128 and
                midi_status.get("currentSampleFrame") == clock_status.get("nativeSampleFrame"),
                f"Native OSC VOC MIDI sample-clock status was incomplete: {midi_status}")
        input_a = next((slot for slot in midi_status.get("inputSlots", []) if slot.get("slot") == "A"), {})
        track_d = next((slot for slot in midi_status.get("trackSlots", []) if slot.get("slot") == "D"), {})
        input_b = next((slot for slot in midi_status.get("inputSlots", []) if slot.get("slot") == "B"), {})
        require(input_a.get("selected") is True and track_d.get("selected") is True and
                input_b.get("selected") is False,
                f"OSC VOC MIDI slot status did not preserve path/slot selection: {midi_status}")

        event_frame = int(clock_status.get("nativeSampleFrame", 0)) + 200_000
        for path, slot in (("input", "A"), ("track", "D")):
            for event_type, frame in (("noteOn", event_frame), ("noteOff", event_frame + 2_000)):
                status, queued = request("/v1/native-fx/osc-voc-midi", "POST", {
                    "path": path, "slot": slot, "type": event_type,
                    "channel": 3, "note": 69, "velocity": 100 if event_type == "noteOn" else 0,
                    "frame": frame,
                })
                require(status == 200, f"OSC VOC {path} {slot} absolute-frame event was rejected: {queued}")
                midi_status = queued.get("nativeFx", {}).get("oscVocMidi", {})
        input_a = next((slot for slot in midi_status.get("inputSlots", []) if slot.get("slot") == "A"), {})
        track_d = next((slot for slot in midi_status.get("trackSlots", []) if slot.get("slot") == "D"), {})
        require(input_a.get("queuedEvents") == 2 and track_d.get("queuedEvents") == 2,
                f"OSC VOC events did not queue to exactly their requested slots: input={input_a}, track={track_d}")
        status, error = request("/v1/native-fx/osc-voc-midi", "POST", {
            "path": "input", "slot": "B", "type": "noteOn",
            "channel": 3, "note": 60, "velocity": 100, "frame": event_frame + 4_000,
        })
        require(status == 409 and "not selected" in error.get("error", ""),
                f"MIDI event was not restricted to the selected OSC VOC slot: {error}")
        status, error = request("/v1/native-fx/osc-voc-midi", "POST", {
            "path": "input", "slot": "A", "type": "noteOn",
            "channel": 0, "note": 60, "velocity": 100, "frame": event_frame + 4_000,
        })
        require(status == 400, f"out-of-range MIDI channel was accepted: {error}")
        status, error = request("/v1/native-fx/osc-voc-midi", "POST", {
            "path": "input", "slot": "A", "type": "noteOn",
            "channel": 3, "note": 60, "velocity": 100, "frame": 1.5,
        })
        require(status == 400, f"non-integer absolute MIDI frame was accepted: {error}")
        status, error = request("/v1/native-fx/osc-voc-midi", "POST", {
            "path": "track", "slot": "D", "type": "noteOn",
            "channel": 3, "note": 128, "velocity": 100, "frame": event_frame + 4_000,
        })
        require(status == 400, f"out-of-range MIDI note was accepted: {error}")
        status, current = request("/v1/status")
        current_frame = int(current.get("nativeSampleFrame", 0))
        status, error = request("/v1/native-fx/osc-voc-midi", "POST", {
            "path": "input", "slot": "A", "type": "noteOff",
            "channel": 3, "note": 69, "velocity": 0, "frame": max(0, current_frame - 1),
        })
        require(status == 409 and "late" in error.get("error", ""),
                f"late absolute-frame MIDI event was not rejected: {error}")
        status, after_late = request("/v1/status")
        midi_status = after_late.get("nativeFx", {}).get("oscVocMidi", {})
        input_a = next((slot for slot in midi_status.get("inputSlots", []) if slot.get("slot") == "A"), {})
        require(status == 200 and input_a.get("lateEventCount", 0) >= 1,
                f"late MIDI event diagnostic counter was not published: {input_a}")

        # Project archives are sent as raw bounded v1 bytes. Verify that a
        # rejected archive cannot change revisions, that accepted PCM is not
        # silently skipped, and that the generation is acknowledged only
        # after the callback-boundary full-bank swap.
        status, project_before = request("/v1/status")
        require(status == 200 and project_before.get("engineRunning") is True,
                "project-import route test requires the simulated engine to be running")
        project_revision = project_before.get("projectContentRevision")
        require(isinstance(project_revision, int) and project_revision >= 0 and
                project_before.get("projectContentRevisionSnapshotStable") is True,
                "project-import route did not publish a stable operation-start host revision snapshot")
        project_import_path = f"/v1/project/import?expectedContentRevision={project_revision}"
        revisions_before = {
            track["trackId"]: track["contentRevision"]
            for track in project_before.get("nativeTracks", [])
        }
        mono_frame_count = 262145
        mono_samples = [0.25, -0.5, 0.75] + [0.0] * (mono_frame_count - 3)
        valid_archive = build_project_archive([
            {"channels": 1, "samples": mono_samples},
            {"channels": 2, "samples": [0.125, -0.25, 0.5, 0.75]},
            None, None, None,
        ])
        require(len(valid_archive) > 1024 * 1024,
                "valid project-import fixture must exceed the small control-body cap")
        invalid_archive = valid_archive[:-1] + bytes([valid_archive[-1] ^ 1])
        status, missing_revision = request_project_archive(
            "/v1/project/import", "POST", invalid_archive, "application/octet-stream")
        require(status == 400 and "expectedContentRevision" in missing_revision.get("error", ""),
                f"Native project import accepted a request without its start revision: {missing_revision}")
        status, malformed_revision = request_project_archive(
            "/v1/project/import?expectedContentRevision=stale", "POST", invalid_archive, "application/octet-stream")
        require(status == 400 and "expectedContentRevision" in malformed_revision.get("error", ""),
                f"Native project import accepted a malformed start revision: {malformed_revision}")
        status, duplicate_revision = request_project_archive(
            f"{project_import_path}&expectedContentRevision={project_revision}",
            "POST", invalid_archive, "application/octet-stream")
        require(status == 400 and "expectedContentRevision" in duplicate_revision.get("error", ""),
                f"Native project import accepted duplicate start revisions: {duplicate_revision}")
        status, rejected_archive = request_project_archive(
            project_import_path, "POST", invalid_archive, "application/octet-stream")
        require(status == 400 and rejected_archive.get("ok") is False and
                "hash" in rejected_archive.get("error", "").lower(),
                f"tampered archive was not explicitly rejected: HTTP {status} {rejected_archive}")
        status, after_invalid_archive = request("/v1/status")
        revisions_after_reject = {
            track["trackId"]: track["contentRevision"]
            for track in after_invalid_archive.get("nativeTracks", [])
        }
        require(status == 200 and revisions_after_reject == revisions_before,
                "invalid archive changed Native track revisions")

        status, headers, _ = request_with_headers("/v1/project/import", "OPTIONS", {
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        require(status == 204 and headers.get("Access-Control-Allow-Origin") == "http://localhost:5173" and
                headers.get("Access-Control-Allow-Methods") == "GET, POST" and
                "content-type" in headers.get("Access-Control-Allow-Headers", "").lower(),
                "raw archive POST did not receive the existing allowlisted loopback CORS policy")

        status, accepted = request_project_archive(
            project_import_path, "POST", valid_archive, "application/octet-stream")
        require(status == 202 and accepted.get("ok") is True and accepted.get("generation", 0) > 0,
                f"valid archive was not staged as a generation: HTTP {status} {accepted}")
        generation = accepted["generation"]
        status, pending = request_project_archive(
            f"/v1/project/import/status?generation={generation}", "GET")
        require(status == 200 and pending.get("ok") is True and pending.get("generation") == generation and
                pending.get("state") in ("pending", "claimed", "committed"),
                f"project import status route returned an invalid generation state: {pending}")
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and pending.get("state") not in ("committed", "cancelled"):
            time.sleep(0.005)
            status, pending = request_project_archive(
                f"/v1/project/import/status?generation={generation}", "GET")
        require(status == 200 and pending.get("state") == "committed",
                f"valid project import was not acknowledged as committed: {pending}")

        status, track_one_headers, imported_track = request_raw(
            "/v1/export/loop-snapshot?trackId=1", {"Origin": "http://localhost:5173"})
        require(status == 200 and int(track_one_headers.get("X-Native-Loop-Frame-Count", "0")) == mono_frame_count and
                len(imported_track) == mono_frame_count * 2 * 4,
                "accepted Mono archive track was silently skipped or had the wrong frame count")
        track_one_samples = struct.unpack_from("<6f", imported_track)
        expected_track_one = (0.25, 0.25, -0.5, -0.5, 0.75, 0.75)
        require(all(abs(actual - expected) < 1e-6 for actual, expected in zip(track_one_samples, expected_track_one)),
                f"committed Mono archive PCM did not survive callback import: {track_one_samples}")
        require(struct.unpack_from("<2f", imported_track, len(imported_track) - 8) == (0.0, 0.0),
                "large Mono archive tail samples were not imported")
        status, track_two_headers, imported_track = request_raw(
            "/v1/export/loop-snapshot?trackId=2", {"Origin": "http://localhost:5173"})
        require(status == 200 and int(track_two_headers.get("X-Native-Loop-Frame-Count", "0")) == 2,
                "accepted Stereo archive track was silently skipped or had the wrong frame count")
        track_two_samples = struct.unpack("<4f", imported_track)
        expected_track_two = (0.125, -0.25, 0.5, 0.75)
        require(all(abs(actual - expected) < 1e-6 for actual, expected in zip(track_two_samples, expected_track_two)),
                f"committed Stereo archive PCM did not survive callback import: {track_two_samples}")
        status, after_commit = request("/v1/status")
        revisions_after_commit = {
            track["trackId"]: track["contentRevision"]
            for track in after_commit.get("nativeTracks", [])
        }
        require(status == 200 and revisions_after_commit[1] > revisions_before[1] and
                revisions_after_commit[2] > revisions_before[2],
                "callback-acknowledged import did not increment the imported track content revisions")

        # Cancellation races the 1 ms synthetic callback. Either a pre-claim
        # cancellation is acknowledged, or a claimed/committed generation is
        # explicitly returned as a conflict; neither may be reported as
        # cancelled after the callback has committed.
        empty_archive = build_project_archive([None, None, None, None, None], name="Cancelled HTTP import")
        status, before_cancel_import = request("/v1/status")
        require(status == 200 and isinstance(before_cancel_import.get("projectContentRevision"), int),
                "project-import cancellation route could not read the current start revision")
        status, cancel_candidate = request_project_archive(
            f"/v1/project/import?expectedContentRevision={before_cancel_import['projectContentRevision']}",
            "POST", empty_archive, "application/octet-stream")
        require(status == 202 and cancel_candidate.get("ok") is True,
                f"empty project for cancellation route was not staged: {cancel_candidate}")
        cancel_generation = cancel_candidate["generation"]
        cancel_status, cancel_result = request_project_import_cancel(cancel_generation)
        require((cancel_status == 200 and cancel_result.get("state") == "cancelled") or
                (cancel_status == 409 and cancel_result.get("state") in ("claimed", "committed")),
                f"import cancellation did not report its callback race explicitly: HTTP {cancel_status} {cancel_result}")
        status, cancel_terminal = request_project_archive(
            f"/v1/project/import/status?generation={cancel_generation}", "GET")
        if cancel_terminal.get("state") in ("pending", "claimed"):
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline and cancel_terminal.get("state") not in ("committed", "cancelled"):
                time.sleep(0.005)
                status, cancel_terminal = request_project_archive(
                    f"/v1/project/import/status?generation={cancel_generation}", "GET")
        require(status == 200 and cancel_terminal.get("state") in ("cancelled", "committed"),
                f"cancelled/claimed project generation never reached a terminal status: {cancel_terminal}")
        if cancel_status == 200:
            require(cancel_terminal.get("state") == "cancelled",
                    f"successful cancellation did not remain terminal: {cancel_terminal}")

        status, unknown_generation = request_project_archive(
            "/v1/project/import/status?generation=18446744073709551615", "GET")
        require(status == 404 and unknown_generation.get("ok") is False,
                "unknown import generation was not explicitly rejected")
        status, malformed_generation = request_project_archive(
            "/v1/project/import/status?generation=0", "GET")
        require(status == 400 and malformed_generation.get("ok") is False,
                "zero import generation was not explicitly rejected")

        status, stopped = request("/v1/engine/stop", "POST", {})
        require(status == 200 and stopped.get("engineRunning") is False,
                "engine stop before HRM AUTO catalog selection failed")
        hrm_parameters = {"key": 2.0, "scale": 0.0, "midi-channel": 3.0, "mix_percent": 70.0}
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "input", "slot": "C", "effectId": "hrm_auto_m",
            "parameters": hrm_parameters,
        })
        require(status == 200, f"HRM AUTO Input C selection failed: {configured}")
        status, configured = request("/v1/native-fx/catalog-slot", "POST", {
            "path": "track", "slot": "A", "effectId": "hrm_auto_m",
            "parameters": hrm_parameters,
        })
        require(status == 200, f"HRM AUTO shared Track A selection failed: {configured}")
        status, started = request("/v1/engine/start", "POST", {})
        require(status == 200 and started.get("engineRunning") is True,
                "engine restart after HRM AUTO selection failed")
        status, hrm_status = request("/v1/status")
        catalog_midi = hrm_status.get("nativeFx", {}).get("catalogMidi", {})
        input_c = next((slot for slot in catalog_midi.get("inputSlots", []) if slot.get("slot") == "C"), {})
        track_a = next((slot for slot in catalog_midi.get("trackSlots", []) if slot.get("slot") == "A"), {})
        require(status == 200 and input_c.get("selected") is True and
                input_c.get("effectId") == "hrm_auto_m" and input_c.get("queueCapacity") == 256 and
                track_a.get("selected") is True and track_a.get("effectId") == "hrm_auto_m" and
                track_a.get("queueCapacity") == 256,
                f"HRM AUTO slot status/capacity did not round-trip: {catalog_midi}")
        hrm_frame = int(hrm_status.get("nativeSampleFrame", 0)) + 200_000
        for path, slot in (("input", "C"), ("track", "A")):
            for event_type, frame in (("noteOn", hrm_frame), ("noteOff", hrm_frame + 2_000)):
                status, queued = request("/v1/native-fx/catalog-midi", "POST", {
                    "effectId": "hrm_auto_m", "path": path, "slot": slot,
                    "type": event_type, "channel": 3, "note": 69,
                    "velocity": 100 if event_type == "noteOn" else 0, "frame": frame,
                })
                require(status == 200, f"HRM AUTO {path} {slot} absolute-frame event was rejected: {queued}")
                catalog_midi = queued.get("nativeFx", {}).get("catalogMidi", {})
        input_c = next((slot for slot in catalog_midi.get("inputSlots", []) if slot.get("slot") == "C"), {})
        track_a = next((slot for slot in catalog_midi.get("trackSlots", []) if slot.get("slot") == "A"), {})
        require(input_c.get("queuedEvents") == 2 and track_a.get("queuedEvents") == 2,
                f"HRM AUTO MIDI events did not route to exact slots: input={input_c}, track={track_a}")
        status, error = request("/v1/native-fx/catalog-midi", "POST", {
            "effectId": "hrm_auto_m", "path": "input", "slot": "B", "type": "noteOn",
            "channel": 3, "note": 60, "velocity": 100, "frame": hrm_frame + 4_000,
        })
        require(status == 409 and "not selected" in error.get("error", ""),
                f"HRM AUTO MIDI was not restricted to its exact selected slot: {error}")

        print("Native bridge HTTP simulation passed, including five-track status, selector validation, per-track recording, stereo snapshots, callback-acknowledged project archive import/cancel/status routes, OSC VOC absolute-frame MIDI routing/status, and HRM AUTO exact-slot MIDI route/status. The fake RtAudio callback source is synthetic and is not device, timing, XRUN, or audio-quality evidence.")
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


if __name__ == "__main__":
    main()
