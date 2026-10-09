from __future__ import annotations
import hashlib, json, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

archive = Path(__file__).resolve().parent
repo = Path(sys.argv[1]).resolve()
source = archive / 'source'
pre = json.loads((archive / 'source-prebuild.json').read_text(encoding='utf-8-sig'))

def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def entries(folder: Path):
    return [{'path': p.relative_to(folder).as_posix(), 'sha256': sha(p)}
            for p in sorted(folder.rglob('*')) if p.is_file()]

post_entries = entries(source)
pre_entries = pre['sourceFiles']
post_matches = pre_entries == post_entries
live_matches = all(sha(repo / Path(item['path'])) == item['sha256']
                   for item in pre_entries if item['path'] != 'compiler_probe.cpp')
closure_hash = hashlib.sha256(''.join(
    f"{item['path']}\t{item['sha256']}\n" for item in pre_entries
).encode('utf-8')).hexdigest()
compiler_log = (archive / 'logs/compiler-version.log').read_text(encoding='utf-8', errors='replace')
compiler_version = next((line.strip() for line in compiler_log.splitlines()
                         if 'cl.exe:' in line), '').replace('版本', 'version')
linker_version = next((line.strip() for line in compiler_log.splitlines()
                       if 'link.exe:' in line), '').replace('版本', 'version')
test_output = (archive / 'logs/test-output.log').read_text(encoding='utf-8', errors='replace')
summary_match = re.search(r'SUMMARY\s+(\{[^\r\n]+\})', test_output)
metrics_match = re.search(r'METRICS\s+(\{[^\r\n]+\})', test_output)
summary = json.loads(summary_match.group(1)) if summary_match else {'passed': 0, 'failed': -1}
metrics = json.loads(metrics_match.group(1)) if metrics_match else {}
head = subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
branch = subprocess.run(['git', '-C', str(repo), 'branch', '--show-current'], capture_output=True, text=True).stdout.strip()
source_post = {
    'schemaVersion': 1,
    'capturedAfterBuildUtc': datetime.now(timezone.utc).isoformat(),
    'sourceFiles': post_entries,
    'sourcePostBuildMatchesPreBuild': post_matches,
    'sourceCopyStillMatchesLive': live_matches,
}
(archive / 'source-postbuild.json').write_text(json.dumps(source_post, indent=2) + '\n', encoding='utf-8')
readme = f'''# SYNTH / G2B / AUTO RIFF / HRM AUTO standalone source closure

This archive freezes the clean-room standalone implementation of SYNTH (catalog ordinal 6), G2B (10), AUTO RIFF (12), and HRM AUTO(M) (19), together with the exact C++ dependency closure and the executable used for the Release tests.

`source/` is the compiler input copy. `build_release.cmd` compiles only that copy and writes objects, executable, and logs to `build/` and `logs/`. Re-run with the pinned VS2019 Build Tools environment from this folder. The source SHA list is in `source-prebuild.json`; `source-postbuild.json` confirms the copy did not change during the captured build. The source copy matched the live repository at capture: {str(live_matches).lower()}.

Release verification: {summary['passed']} passed, {summary['failed']} failed. The captured executable is `build/synthesis_pitch_fx_tests.exe`; complete stdout and stderr are in `logs/test-output.log` and `logs/test-stderr.log`. The assertions cover separate 220/330 Hz tracking, G2B octave-down projections and distinct modes, all 30 distinct authored eight-slot riff tables plus 120 BPM sample-clock progression and sample-offset phrase changes, C-major harmony and MIDI target override, transactional event rejection, L/R isolation, and no C++ heap new/delete during 64/128/256-frame callback probes. Raw projections and RMS are included in the test log.

The local control curves and the 30 phrase table are clean-room reconstruction choices. They do not claim sample-identical Roland behavior or establish normative internal topology. Pitch analysis is incremental YIN (2048-frame window, 512-frame hop) and does not add fixed audio delay. G2B, AUTO RIFF, and HRM AUTO(M) use streaming TD-PSOLA; its lookahead is reported separately from analysis age. SYNTH has no fixed audio-path delay. This archive has no callback-duration distribution, browser/WASM parity, host-graph, ASan, or hardware result and does not qualify a realtime or final-quality gate.

Repository reference at capture: `{branch}` / `{head}`. Source-closure digest: `{closure_hash}`.
'''
(archive / 'README.md').write_text(readme, encoding='utf-8')
manifest = {
    'schemaVersion': 1,
    'suite': 'synthesis-pitch-fx',
    'status': 'standalone-release-source-snapshot',
    'capturedAtUtc': datetime.now(timezone.utc).isoformat(),
    'repository': '2025_WebRC505MKII_v2',
    'git': {'branch': branch, 'headAtCapture': head},
    'sourceClosureSha256': closure_hash,
    'sourceFiles': pre_entries,
    'sourcePreBuildMatchesLive': bool(pre['sourceCopyMatchesLive'] and live_matches),
    'sourcePostBuildMatchesPreBuild': post_matches,
    'buildScript': {'path': 'build_release.cmd', 'sha256': sha(archive / 'build_release.cmd')},
    'toolchain': {
        'compiler': compiler_version,
        'linker': linker_version,
        'toolset': 'MSVC 14.29.30133, host/target x64',
        'configuration': 'Release',
        'standard': 'C++17',
        'flags': ['/O2', '/EHsc', '/W4', '/permissive-', '/fp:precise'],
        'buildCommand': 'build_release.cmd',
    },
    'test': {
        'executable': 'build/synthesis_pitch_fx_tests.exe',
        'stdout': 'logs/test-output.log',
        'stderr': 'logs/test-stderr.log',
        **summary,
        'metrics': metrics,
        'cppHeapCallbacks': {'allocations': metrics.get('callbackAllocations'), 'frees': metrics.get('callbackFrees'), 'blockFramesProbed': [64, 128, 256]},
    },
    'scope': {
        'processors': [
            {'ordinal': 6, 'id': 'SYNTH', 'implementation': 'stereo incremental-YIN tracking, onset/envelope follower, PolyBLEP saw/sub oscillators, resonant TPT SVF'},
            {'ordinal': 10, 'id': 'G2B', 'implementation': 'dual-mono incremental-YIN, streaming TD-PSOLA octave-down, PolyBLEP square divider, stereo body lowpass, two smoothed modes'},
            {'ordinal': 12, 'id': 'AUTO_RIFF', 'implementation': 'dual-mono incremental-YIN, key-major pitch quantization, 30 distinct authored 8-slot phrases, 32.32 fixed-point eighth-note transport, streaming TD-PSOLA'},
            {'ordinal': 19, 'id': 'HRM_AUTO_M', 'implementation': 'dual-mono incremental-YIN, key-aware diatonic interval voice, streaming TD-PSOLA, optional bounded single MIDI target override, stereo formant/pan/levels'},
        ],
        'notQualified': ['Realtime deadline performance', 'browser/WASM parity', 'Native registry or host graph integration', 'final sound-quality qualification', 'hardware end-to-end verification'],
        'officialTopology': 'UI labels/ranges remain in the separate official contract; internal curves and phrase content are clean-room reconstruction choices.',
    },
}
(archive / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
files = [p for p in sorted(archive.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS.txt']
(archive / 'SHA256SUMS.txt').write_text(''.join(
    f'{sha(p)}  {p.relative_to(archive).as_posix()}\n' for p in files
), encoding='utf-8')
if not (pre['sourceCopyMatchesLive'] and live_matches and post_matches and summary['failed'] == 0):
    raise SystemExit('capture verification failed')
print(json.dumps({'archive': str(archive), 'sourceClosureSha256': closure_hash,
                  'sourceFiles': len(pre_entries), 'copyMatchesLive': live_matches,
                  'postMatchesPre': post_matches, 'passed': summary['passed'],
                  'failed': summary['failed'], 'inventoryFiles': len(files)}, indent=2))
