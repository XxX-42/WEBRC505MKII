"""Render deterministic inputs through production Browser DSP and Native callback code."""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
import numpy as np
from scipy.io import wavfile
import analyze
import generate_stimuli
from parity_common import REPO_ROOT, ensure_external_path, sha256_file, write_json


def source_hashes(root: Path) -> dict[str, str]:
    patterns = ('native-mvp/engine-cpp/src/*.cpp', 'native-mvp/engine-cpp/include/*.hpp',
                'native-mvp/engine-cpp/tests/support/*', 'src/audio/fx/**/*.ts')
    paths = {path for pattern in patterns for path in root.glob(pattern) if path.is_file()}
    paths.update(root / name for name in ('bench/audio-parity/native_software_probe.cpp',
                 'bench/audio-parity/render_browser.ts', 'native-mvp/engine-cpp/CMakeLists.txt',
                 'native-mvp/engine-cpp/tests/native_alloc_tracker.cpp', 'native-mvp/engine-cpp/tests/native_alloc_tracker.hpp'))
    return {path.relative_to(root).as_posix(): sha256_file(path) for path in sorted(paths)}


def verify_native_manifest(path: Path, root: Path = REPO_ROOT) -> dict:
    value = json.loads(path.read_text(encoding='utf-8'))
    binary = Path(value['binary'])
    if sha256_file(binary) != value['binary_sha256']:
        raise ValueError('Native binary SHA mismatch')
    if value['source_hashes'] != source_hashes(root):
        raise ValueError('Native build source tree changed; rebuild the isolated probe')
    return value


def run_checked(command: list[str], *, timeout: int = 120) -> dict:
    result = subprocess.run(command, cwd=REPO_ROOT, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Renderer/probe failed ({result.returncode}): {result.stderr[-4000:]} {result.stdout[-2000:]}')
    # vite-node may print a preamble, but the last line must be renderer metadata.
    lines = result.stdout.strip().splitlines()
    if not lines:
        raise ValueError('Renderer returned no metadata')
    value = json.loads(lines[-1])
    if value.get('status') != 'SOFTWARE_BASELINE':
        raise ValueError('Unexpected renderer status')
    return value


def validate_render(path: Path, frames: int, channels: int = 2) -> np.ndarray:
    if path.stat().st_size != frames * channels * 4:
        raise ValueError('Renderer output byte length mismatch')
    samples = np.fromfile(path, dtype='<f4').reshape(frames, channels)
    if not np.isfinite(samples).all():
        raise ValueError('Renderer produced non-finite PCM')
    return samples


def run(outdir: Path, native_manifest: Path, mode: str = 'lpf') -> dict:
    outdir = ensure_external_path(outdir)
    native = verify_native_manifest(native_manifest)
    manifest = generate_stimuli.generate(outdir / 'stimuli', 48000)
    vite_node = REPO_ROOT / 'node_modules/vite-node/vite-node.mjs'
    if not vite_node.is_file():
        raise ValueError('Install the repository dependencies before rendering')
    node = os.environ.get('WEBRC_NODE', 'node')
    entries = []
    for stimulus in manifest['entries']:
        source = outdir / 'stimuli' / stimulus['file']
        rate, pcm, _ = analyze.read_wav(source)
        raw = outdir / 'raw' / (stimulus['name'] + '.input.f32')
        raw.parent.mkdir(parents=True, exist_ok=True)
        pcm.astype('<f4').tofile(raw)
        for engine in ('browser', 'native'):
            rendered = raw.with_name(stimulus['name'] + '.' + engine + '.f32')
            command = ([node, str(vite_node), '--script', str(REPO_ROOT / 'bench/audio-parity/render_browser.ts'),
                        str(raw), str(rendered), str(rate), mode] if engine == 'browser' else
                       [native['binary'], 'render', str(raw), str(rendered), str(rate), mode])
            runtime = run_checked(command)
            samples = validate_render(rendered, len(pcm))
            if np.max(np.abs(pcm)) > 0 and np.max(np.abs(samples)) == 0:
                raise ValueError('Non-silent stimulus produced a completely silent render')
            if mode == 'dry' and not np.allclose(samples, pcm, rtol=0, atol=1e-6):
                raise ValueError('Production dry route did not preserve decoded input PCM')
            target = outdir / engine / stimulus['file']
            target.parent.mkdir(parents=True, exist_ok=True)
            wavfile.write(target, rate, samples)
            entries.append({'engine': engine, 'stimulus': stimulus['name'], 'input_path': str(source),
                'input_sha256': sha256_file(source), 'render_path': str(target), 'render_sha256': sha256_file(target),
                'frames': len(samples), 'sample_rate_hz': rate, 'channels': 2, 'encoding':'IEEE_FLOAT32_LE',
                'runtime': runtime, 'analysis': analyze.analyze_pair(source, target, stimulus['name'], capture_kind='software_baseline')})
    comparisons=[analyze.analyze_pair(outdir/'browser'/entry['file'],outdir/'native'/entry['file'],entry['name'],capture_kind='software_baseline')
        for entry in manifest['entries']]
    report = {'status':'SOFTWARE_BASELINE', 'source_engine_output':True, 'hardware_capture':False,
        'mode':mode, 'parameters': {'cutoff_hz':1200, 'resonance_percent':15} if mode == 'lpf' else {},
        'stimulus_count':len(manifest['entries']), 'render_count':len(entries), 'entries':entries,
        'browser_native_comparisons':comparisons,'universal_parity_gate':None,
        'native_build_manifest':str(native_manifest.resolve()), 'native_binary_sha256':native['binary_sha256'],
        'source_hashes':source_hashes(REPO_ROOT), 'audio_jury_status':'MULTIMODAL_AUDIO_JURY_BLOCKED',
        'limitations':['Browser runs production AudioWorklet DSP directly under Node; no AudioContext scheduling or app export.',
            'Native runs production input FX and software monitoring through audioCallback with fake RtAudio; no physical device.',
            'LPF is one explicit production DSP route; this is not complete FX or five-track/Memory end-to-end coverage.',
            'Both renders stop at stimulus length; effect tails beyond that duration are truncated.',
            'No hardware reference, perceived quality judgement, physical latency, XRUN, or final integrated regression claim.']}
    write_json(outdir / 'engine-baseline.json', report)
    return report


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--outdir',required=True,type=Path)
    parser.add_argument('--native-manifest',required=True,type=Path)
    parser.add_argument('--mode',choices=['dry','lpf'],default='lpf')
    args=parser.parse_args()
    value=run(args.outdir,args.native_manifest,args.mode)
    print(json.dumps({'status':value['status'],'stimuli':value['stimulus_count'],'renders':value['render_count'],
        'manifest':str(args.outdir.resolve()/'engine-baseline.json')}))
