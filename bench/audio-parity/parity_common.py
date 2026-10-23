"""Shared utilities for the WebRC audio parity harness."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_external_path(path: Path, label: str = "audio output") -> Path:
    """Resolve an output path and refuse paths inside the repository."""
    resolved = path.expanduser().resolve()
    root = REPO_ROOT.resolve()
    try:
        inside = os.path.commonpath((str(root).casefold(), str(resolved).casefold())) == str(root).casefold()
    except ValueError:
        inside = False
    if inside:
        raise ValueError(f"{label} must stay outside the repository/Vite watch tree: {resolved}")
    return resolved


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "value": None, "reason": reason}


def available(value: Any, **details: Any) -> dict[str, Any]:
    return {"status": "available", "value": value, **details}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)