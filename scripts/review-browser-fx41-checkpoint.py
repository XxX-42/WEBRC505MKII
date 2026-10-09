"""Verify the frozen Browser 41 checkpoint without touching the working tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile


def read(path):
    path = path.resolve()
    if os.name == "nt":
        path = Path(chr(92) * 2 + "?" + chr(92) + str(path))
    return path.read_bytes()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(read(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--revision", default="INDEX")
    args = parser.parse_args()
    archive = args.archive.resolve()
    index = load(archive / "archive-index.json")
    for entry in index["files"]:
        data = read(archive / entry["path"])
        assert len(data) == entry["bytes"], entry["path"]
        assert sha(data) == entry["sha256"], entry["path"]

    manifest = load(archive / "source/public/dsp/webrc-dsp.build.json")
    pin = load(archive / "source/shared/dsp/wasm/browser-build-pin.json")
    wasm = read(archive / "source/public/dsp/webrc-dsp.wasm")
    assert sha(wasm) == manifest["artifact"]["sha256"]
    assert len(wasm) == manifest["artifact"]["byteLength"]
    source_entries = sorted(manifest["sourceFiles"].items())
    canonical = "\n".join(f"{p}={h}" for p, h in source_entries).encode()
    assert sha(canonical) == manifest["sourceSetSha256"]
    assert pin["sourceSetSha256"] == manifest["sourceSetSha256"]
    for path, expected in source_entries:
        assert sha(read(archive / "source" / path)) == expected, path

    overlay = load(archive / "evidence/product-overlay-manifest-v2.json")
    original = read(archive / "evidence/product-overlay-manifest.json")
    assert sha(original) == overlay["original27ManifestSha256"]
    rows = sorted(overlay["overlays"], key=lambda row: row["path"])
    canonical = "".join(f"{r['path']}={r['currentSha256']}\n" for r in rows).encode()
    assert sha(canonical) == overlay["overlayDigestSha256"]
    assert len(rows) == overlay["overlayCount"] == 33
    for row in rows:
        assert sha(read(archive / "source" / row["path"])) == row["currentSha256"]
    base_zip = archive / "evidence/source-head-7b56238.zip"
    assert sha(read(base_zip)) == overlay["baseArchive"]["sha256"]
    overlay_paths = {r["path"] for r in rows}
    with zipfile.ZipFile(base_zip) as base:
        for row in rows:
            old = base.read(row["path"]) if row["path"] in base.namelist() else None
            assert (sha(old) if old is not None else None) == row["baseSha256"]
        for path in index["productPaths"]:
            if path not in overlay_paths:
                assert path in base.namelist(), path
                assert base.read(path) == read(archive / "source" / path), path

    capture = load(archive / "evidence/capture-manifest.json")
    for entry in capture["files"]:
        path = archive / "source" / entry["path"]
        if entry["path"] == "README.md":
            path = archive / "evidence/capture-README.md"
        assert sha(read(path)) == entry["sha256"], entry["path"]
    canonical = "\n".join(f"{e['path']}={e['sha256']}" for e in sorted(capture["files"], key=lambda e: e["path"]))
    assert sha(canonical.encode()) == capture["sourceAssetSetSha256"]

    smoke = load(archive / "evidence/browser-realtime-smoke-20261010.json")
    assert smoke["status"] == "PASS"
    assert smoke["softwareOnly"] and not smoke["hardwareCertified"]
    assert len(smoke["assertions"]) == 74
    assert all(entry["passed"] for entry in smoke["assertions"])
    assert smoke["sharedDspBuild"]["runtimeResponse"]["sha256"] == sha(wasm)
    unit_log = read(archive / "evidence/unit-full-quiet-20261010.log").decode("utf-8")
    assert "Test Files  34 passed (34)" in unit_log
    assert "Tests  223 passed (223)" in unit_log

    result = {
        "result": "VERIFIED",
        "payloadCount": len(index["files"]),
        "productPathCount": len(index["productPaths"]),
        "wasmSourceCount": len(source_entries),
        "overlayCount": len(rows),
        "captureProductFiles": 187,
        "captureExplanationFiles": 1,
        "wasmSha256": sha(wasm),
        "wholeUnitSuite": "34 files / 223 PASS (archived agent execution)",
        "realBrowserSmoke": "74 PASS (archived agent execution)",
        "hardwareCertified": False,
        "fullTaskQualified": False,
    }
    if args.repo:
        process = subprocess.Popen(
            ["git", "-c", "core.longpaths=true", "cat-file", "--batch"],
            cwd=args.repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        )
        raw, normalized = 0, 0
        try:
            for path in index["productPaths"]:
                spec = ":" + path if args.revision == "INDEX" else args.revision + ":" + path
                process.stdin.write((spec + "\n").encode())
                process.stdin.flush()
                header = process.stdout.readline().decode().strip()
                assert not header.endswith(" missing"), spec
                blob = process.stdout.read(int(header.rsplit(" ", 1)[1]))
                assert process.stdout.read(1) == b"\n"
                frozen = read(archive / "source" / path)
                if blob == frozen:
                    raw += 1
                else:
                    assert path not in manifest["sourceFiles"], "WASM input must match raw bytes: " + path
                    assert blob.replace(b"\r\n", b"\n") == frozen.replace(b"\r\n", b"\n"), path
                    normalized += 1
        finally:
            process.stdin.close()
            process.wait()
        assert process.returncode == 0
        result["gitRevision"] = args.revision
        result["gitRawMatches"] = raw
        result["gitEolOnlyMatches"] = normalized
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
