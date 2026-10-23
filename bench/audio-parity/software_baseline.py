"""Exercise analyzer/package mechanics with synthetic identity and gain fixtures only."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.io import wavfile
import analyze
import blind_package
import generate_stimuli
from parity_common import ensure_external_path, write_json, sha256_file

def run(out: Path) -> dict:
    out = ensure_external_path(out)
    manifest = generate_stimuli.generate(out / 'stimuli', 48000)
    variants = {'synthetic_identity': out / 'identity', 'synthetic_half_gain': out / 'half_gain'}
    results = []
    for path in variants.values():
        path.mkdir(parents=True, exist_ok=True)
    for entry in manifest['entries']:
        source = out / 'stimuli' / entry['file']
        rate, raw = wavfile.read(source)
        for name, directory in variants.items():
            target = directory / entry['file']
            wavfile.write(target, rate, raw if name == 'synthetic_identity' else np.rint(raw.astype(float) * .5).astype(np.int16))
            results.append(analyze.analyze_pair(source, target, entry['name'], capture_kind='software_baseline'))
    public, _ = blind_package.build_package(out / 'stimuli', variants, out / 'blind-package', out / 'PRIVATE_MAPPING.json', seed=20261023)
    report = {'status': 'SOFTWARE_BASELINE', 'hardware_capture': False, 'source_engine_output': False,
              'audio_jury_status': 'MULTIMODAL_AUDIO_JURY_BLOCKED',
              'limitation': 'Synthetic identity/gain fixtures exercise math and packaging only; no engine render, hardware parity, listening judgement or XRUN measurement.',
              'stimulus_count': len(manifest['entries']), 'analysis_count': len(results),
              'stimulus_hashes': {e['name']: e['sha256'] for e in manifest['entries']},
              'public_package_sha256': sha256_file(out / 'blind-package' / 'package.json'),
              'private_mapping_sha256': sha256_file(out / 'PRIVATE_MAPPING.json'),
              'analyses': results}
    write_json(out / 'software-baseline.json', report)
    return report

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--outdir', required=True, type=Path)
    args = parser.parse_args()
    result = run(args.outdir)
    print(json.dumps({k: v for k, v in result.items() if k != 'analyses'}, indent=2))
