#!/usr/bin/env python3
"""Verify a restarted simulation host cannot accept an old generation receipt."""

import http.client
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from native_bridge_http_simulation_test import build_project_archive


def request(base, path, method="GET", body=None, headers=None):
    data = body
    request_headers = dict(headers or {})
    if data is not None:
        request_headers.setdefault("Content-Type", "application/octet-stream")
    req = urllib.request.Request(base + path, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            payload = response.read()
            return response.status, json.loads(payload.decode("utf-8")) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read()
        return error.code, json.loads(payload.decode("utf-8")) if payload else {}


def start_host(binary, port):
    env = os.environ.copy()
    env["WEBRC_NATIVE_BRIDGE_PORT"] = str(port)
    process = subprocess.Popen([binary], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Native host exited early with status {process.returncode}")
        try:
            code, status = request(base, "/v1/status")
            if code == 200 and status.get("hostIncarnationId"):
                return process, base, status
        except (OSError, urllib.error.URLError):
            time.sleep(0.05)
    process.terminate()
    process.wait(timeout=3)
    raise RuntimeError("Native host did not become ready")


def stop_host(process):
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def submit_archive(base, host_id, archive):
    code, started = request(base, "/v1/engine/start", "POST", b"{}", {
        "Content-Type": "application/json", "Origin": "http://localhost:5173",
    })
    if code != 200 or started.get("engineRunning") is not True:
        raise AssertionError(f"simulation engine did not start: {code} {started}")
    _, status = request(base, "/v1/status")
    path = f"/v1/project/import?expectedContentRevision={status['projectContentRevision']}"
    code, accepted = request(base, path, "POST", archive, {
        "X-Native-Host-Incarnation": host_id,
        "Origin": "http://localhost:5173",
    })
    if code != 202:
        raise AssertionError(f"import was not accepted: {code} {accepted}")
    return accepted["generation"]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: native_host_incarnation_restart_test.py <host-binary>")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    binary = os.path.abspath(sys.argv[1])
    archive = build_project_archive([None, None, None, None, None], name="restart incarnation test")
    first = None
    second = None
    try:
        first, base, first_status = start_host(binary, port)
        old_id = first_status["hostIncarnationId"]
        old_generation = submit_archive(base, old_id, archive)
        stop_host(first)
        first = None

        second, base, second_status = start_host(binary, port)
        new_id = second_status["hostIncarnationId"]
        if old_id == new_id:
            raise AssertionError("host incarnation ID was reused after process restart")
        new_generation = submit_archive(base, new_id, archive)
        if old_generation != new_generation:
            raise AssertionError(f"test did not reproduce generation reuse: {old_generation} != {new_generation}")

        code, stale_result = request(base, "/v1/project/import/cancel", "POST", str(old_generation).encode("ascii"), {
            "Content-Type": "text/plain;charset=UTF-8",
            "X-Native-Host-Incarnation": old_id,
            "Origin": "http://localhost:5173",
        })
        if code != 409:
            raise AssertionError(f"stale old-host cancel was not rejected: {code} {stale_result}")
        code, current_status = request(base, f"/v1/project/import/status?generation={new_generation}")
        if code != 200 or current_status.get("hostIncarnationId") != new_id or current_status.get("state") == "cancelled":
            raise AssertionError(f"old host receipt altered the new transaction: {code} {current_status}")
        print("Native host restart incarnation test passed: generation was reused, IDs differed, and the stale cancel was rejected without changing the new transaction.")
    finally:
        if first is not None:
            stop_host(first)
        if second is not None:
            stop_host(second)


if __name__ == "__main__":
    main()
