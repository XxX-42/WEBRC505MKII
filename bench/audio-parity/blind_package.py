"""Create randomized A/B listen packages with a private identity map."""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from parity_common import ensure_external_path, load_json, sha256_file, write_json

DEFAULT_PARENT = Path(tempfile.gettempdir()) / "webrc505-audio-parity" / "blind"


def _parse_variants(values: list[str]) -> dict[str, Path]:
    variants: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"variant must be NAME=DIRECTORY: {value}")
        name, raw_path = value.split("=", 1)
        if not name or name in variants:
            raise ValueError(f"variant names must be non-empty and unique: {name!r}")
        variants[name] = Path(raw_path).resolve()
    if len(variants) < 2:
        raise ValueError("at least two variants are required for blind comparison")
    return variants


def build_package(stimuli_dir: Path, variants: dict[str, Path], out_dir: Path, mapping_path: Path, seed: int | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    out_dir = ensure_external_path(out_dir, "blind package directory")
    mapping_path = ensure_external_path(mapping_path, "private mapping file")
    try:
        if mapping_path.is_relative_to(out_dir):
            raise ValueError("private mapping must be a sibling of, not inside, the shareable blind package")
    except AttributeError:
        if str(mapping_path).casefold().startswith(str(out_dir).casefold() + str(Path.sep).casefold()):
            raise ValueError("private mapping must be a sibling of, not inside, the shareable blind package")
    manifest_path = stimuli_dir / "manifest.json"
    dataset = load_json(manifest_path)
    names = [entry["name"] for entry in dataset.get("entries", [])]
    if not names:
        raise ValueError(f"stimulus manifest has no entries: {manifest_path}")
    for name, directory in variants.items():
        if not directory.is_dir():
            raise ValueError(f"variant directory does not exist: {name}={directory}")
    out_dir.mkdir(parents=True, exist_ok=False)
    rng = secrets.SystemRandom() if seed is None else __import__("random").Random(seed)
    trials: list[dict[str, Any]] = []
    hidden_trials: list[dict[str, Any]] = []
    for trial_no, stimulus_name in enumerate(names, 1):
        stimulus_entry = next(entry for entry in dataset["entries"] if entry["name"] == stimulus_name)
        input_wav = stimuli_dir / stimulus_entry["file"]
        candidate_paths = {name: directory / f"{stimulus_name}.wav" for name, directory in variants.items()}
        missing = [name for name, path in candidate_paths.items() if not path.is_file()]
        if missing:
            raise ValueError(f"missing {stimulus_name}.wav in variant(s): {', '.join(missing)}")
        labels = list(variants)
        rng.shuffle(labels)
        trial_name = f"trial-{trial_no:03d}"
        trial_dir = out_dir / trial_name
        trial_dir.mkdir()
        shutil.copyfile(input_wav, trial_dir / "input.wav")
        public_candidates = []
        private_map = {}
        for label, variant_name in zip((chr(ord("A") + i) for i in range(len(labels))), labels):
            source = candidate_paths[variant_name]
            destination = trial_dir / f"{label}.wav"
            shutil.copyfile(source, destination)
            public_candidates.append({"label": label, "sha256": sha256_file(destination)})
            private_map[label] = {"variant": variant_name, "sha256": sha256_file(source)}
        trials.append({
            "trial": trial_name,
            "stimulus_name": stimulus_name,
            "input_sha256": sha256_file(trial_dir / "input.wav"),
            "candidates": public_candidates,
            "listener_score": None,
        })
        hidden_trials.append({"trial": trial_name, "stimulus_name": stimulus_name, "candidate_identity": private_map})
    public = {
        "schema_version": 1,
        "package_kind": "BLINDED_RANDOMIZED_AUDIO_COMPARISON",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "audio_jury_status": "MULTIMODAL_AUDIO_JURY_BLOCKED",
        "source_engine_output": None,
        "trial_count": len(trials),
        "candidate_count": len(variants),
        "randomization": "candidate labels independently shuffled per stimulus trial",
        "trials": trials,
        "identity_mapping_included": False,
    }
    private = {
        "schema_version": 1,
        "private": True,
        "random_seed": seed,
        "variant_names": list(variants),
        "trials": hidden_trials,
    }
    write_json(out_dir / "package.json", public)
    write_json(mapping_path, private)
    return public, private


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stimuli-dir", type=Path, required=True)
    parser.add_argument("--variant", action="append", required=True, help="NAME=DIRECTORY; supply at least two")
    parser.add_argument("--out", type=Path, default=DEFAULT_PARENT / "package")
    parser.add_argument("--mapping-out", type=Path, help="private identity mapping path; defaults beside the package")
    parser.add_argument("--seed", type=int, help="optional deterministic seed for package construction; not written into the public package")
    args = parser.parse_args()
    try:
        variants = _parse_variants(args.variant)
        mapping = args.mapping_out or args.out.parent / f"{args.out.name}_PRIVATE_MAPPING.json"
        public, private = build_package(args.stimuli_dir.resolve(), variants, args.out, mapping, args.seed)
    except (OSError, ValueError, KeyError, StopIteration) as exc:
        parser.error(str(exc))
    print(json.dumps({"package_directory": str(args.out.resolve()), "private_mapping": str(mapping.resolve()), "trial_count": public["trial_count"], "audio_jury_status": public["audio_jury_status"], "public_package_sha256": sha256_file(args.out.resolve() / "package.json"), "private_mapping_sha256": sha256_file(mapping.resolve())}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
