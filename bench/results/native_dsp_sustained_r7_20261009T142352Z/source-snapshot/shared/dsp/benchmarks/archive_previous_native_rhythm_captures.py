#!/usr/bin/env python3
"""Preserve the exact TEMP source copies behind earlier rhythm timing records."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def preserve(repo: Path, manifest_path: Path) -> Path:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    timestamp = manifest_path.name.removeprefix("native-rhythm-").removesuffix(".manifest.json")
    snapshot = Path(manifest["snapshotDirectory"])
    if not snapshot.is_dir():
        raise ValueError(f"Missing original TEMP snapshot: {snapshot}")
    result_root = repo / "shared" / "dsp" / "benchmarks" / "results"
    archive = result_root / f"native-rhythm-{timestamp}.snapshot"
    if archive.exists():
        raise ValueError(f"Refusing to overwrite existing archive: {archive}")
    archive.mkdir(parents=True)

    recorded = manifest.get("snapshotFingerprintAfterRun", manifest.get("snapshotFingerprintBeforeBuild", {}))
    files = recorded.get("files", [])
    if not files:
        raise ValueError(f"No source-copy index in {manifest_path}")
    copied = []
    for record in files:
        relative = record["path"].replace("\\", "/")
        source = snapshot / Path(relative)
        actual_hash = sha256(source)
        actual_size = source.stat().st_size
        if actual_hash != record["sha256"] or actual_size != record["bytes"]:
            raise ValueError(f"TEMP source copy differs from recorded post-run fingerprint: {relative}")
        destination = archive / Path(relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied.append({"path": relative, "sha256": actual_hash, "bytes": actual_size})

    for relative in ("compiler-version.txt", "ctest-output.txt", "run-capture.cmd", "build/compile_commands.json"):
        source = snapshot / Path(relative)
        if not source.is_file():
            continue
        destination = archive / "capture" / Path(relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    raw_path = Path(manifest["rawResultPath"])
    raw_hash = sha256(raw_path)
    if raw_hash != manifest["rawResultSha256"]:
        raise ValueError("Old raw-result SHA256 mismatch")
    source_index: dict[str, Any] = {
        "schemaVersion": "webrc-rhythm-source-archive-index-v1",
        "sourceStatus": "post_run_copy_only; consult sourceSnapshotUnchanged before treating as compiled-source proof",
        "sourceSnapshotUnchanged": manifest.get("sourceSnapshotUnchanged"),
        "originalBeforeFingerprint": manifest.get("snapshotFingerprintBeforeBuild"),
        "originalAfterFingerprint": manifest.get("snapshotFingerprintAfterRun"),
        "archivedSourceFiles": copied,
        "rawResultPath": str(raw_path),
        "rawResultSha256": raw_hash,
        "timingRecomputed": manifest.get("timingRecomputed"),
        "threadCpuTimingRecomputed": manifest.get("threadCpuTimingRecomputed"),
        "note": "Archive preserves the exact available TEMP copies and timing evidence. Where pre/post fingerprints differ, the archive is not represented as proof of which version produced the compiled executable.",
    }
    index_path = archive / "capture" / "source-archive-index.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(source_index, indent=2) + "\n", encoding="utf-8")
    print(f"ARCHIVED {len(copied)} source copies: {archive}")
    print(f"SOURCE_UNCHANGED={manifest.get('sourceSnapshotUnchanged')} RAW_SHA256={raw_hash}")
    return archive


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: archive_previous_native_rhythm_captures.py MANIFEST.json [MANIFEST.json ...]")
    repo = Path(__file__).resolve().parents[3]
    for argument in sys.argv[1:]:
        preserve(repo, Path(argument).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
