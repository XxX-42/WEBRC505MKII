"""Run isolated device-free Native callback comparisons; never reports hardware XRUNs."""
import argparse
import ctypes
import hashlib
import json
import os
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_manifest(root):
    root = Path(root).resolve()
    engine = root / 'native-mvp' / 'engine-cpp'
    files = [engine / 'CMakeLists.txt']
    files += sorted((engine / 'include').glob('*.hpp'))
    files += sorted((engine / 'src').glob('*.cpp'))
    files += [engine / 'tests' / 'native_benchmark_access.hpp', engine / 'tests' / 'native_performance_matrix.cpp']
    return {path.relative_to(root).as_posix(): sha256(path) for path in files}


def cmake_metadata(cache, root, binary):
    cache = Path(cache).resolve()
    entries = {}
    for line in cache.read_text(encoding='utf-8').splitlines():
        if line.startswith(('#', '//')) or '=' not in line or ':' not in line.split('=', 1)[0]:
            continue
        name, value = line.split('=', 1)
        entries[name.split(':', 1)[0]] = value
    expected_source = (Path(root).resolve() / 'native-mvp' / 'engine-cpp').resolve()
    if Path(entries['CMAKE_HOME_DIRECTORY']).resolve() != expected_source:
        raise ValueError(f'Cache source root does not match {expected_source}')
    if Path(binary).resolve().parent != (cache.parent / 'Release').resolve():
        raise ValueError(f'Executable is not in the cache build Release directory: {binary}')
    keys = ('CMAKE_GENERATOR', 'CMAKE_GENERATOR_PLATFORM', 'CMAKE_CXX_FLAGS', 'CMAKE_CXX_FLAGS_RELEASE',
        'NATIVE_PORTABLE_TESTS_ONLY', 'NATIVE_ENABLE_RUBBERBAND_HQ', 'NATIVE_PREAMP_EXPERIMENTAL_STABLE_ADAA')
    compilers = sorted((cache.parent / 'CMakeFiles').glob('*/CMakeCXXCompiler.cmake'))
    if len(compilers) != 1:
        raise ValueError(f'Expected one CMake compiler definition in {cache.parent}')
    compiler_text = compilers[0].read_text(encoding='utf-8')
    compiler_lines = [line.strip() for line in compiler_text.splitlines() if line.startswith(
        ('set(CMAKE_CXX_COMPILER ', 'set(CMAKE_CXX_COMPILER_ID ', 'set(CMAKE_CXX_COMPILER_VERSION '))]
    return {'settings': {key: entries.get(key, '') for key in keys}, 'compiler': compiler_lines,
        'homeDirectory': str(expected_source), 'cache': str(cache), 'cacheSha256': sha256(cache)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--baseline-source-root', required=True, type=Path)
    parser.add_argument('--candidate-source-root', required=True, type=Path)
    parser.add_argument('--baseline-cache', required=True, type=Path)
    parser.add_argument('--candidate-cache', required=True, type=Path)
    parser.add_argument('--callbacks', type=int, default=10000)
    args = parser.parse_args()
    if args.callbacks < 10000:
        parser.error('at least 10000 measured callbacks are required for P99.9')
    if args.out.exists():
        parser.error('output already exists; select a new receipt path')
    binaries = {'baseline': str(args.baseline.resolve()), 'candidate': str(args.candidate.resolve())}
    roots = {'baseline': args.baseline_source_root, 'candidate': args.candidate_source_root}
    caches = {'baseline': args.baseline_cache, 'candidate': args.candidate_cache}
    build = {name: cmake_metadata(caches[name], roots[name], binary) for name, binary in binaries.items()}
    if build['baseline']['settings'] != build['candidate']['settings'] or build['baseline']['compiler'] != build['candidate']['compiler']:
        raise SystemExit('Generator, compiler, Release flags or feature settings differ; refusing comparison.')
    manifests = {name: source_manifest(root) for name, root in roots.items()}
    baseline_cmake = (args.baseline_source_root / 'native-mvp/engine-cpp/CMakeLists.txt').read_text(encoding='utf-8')
    candidate_cmake = (args.candidate_source_root / 'native-mvp/engine-cpp/CMakeLists.txt').read_text(encoding='utf-8')
    baseline_define = 'target_compile_definitions(native_performance_matrix PRIVATE NATIVE_BENCH_BASELINE_NO_BATCH=1)'
    if baseline_define not in baseline_cmake or baseline_define in candidate_cmake:
        raise SystemExit('Expected the baseline-only benchmark capability guard; refusing comparison.')
    for path in ('native-mvp/engine-cpp/tests/native_benchmark_access.hpp',
            'native-mvp/engine-cpp/tests/native_performance_matrix.cpp'):
        if manifests['baseline'][path] != manifests['candidate'][path]:
            raise SystemExit(f'Benchmark harness differs: {path}')
    affinity = None
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.GetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        kernel.SetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        process = kernel.GetCurrentProcess()
        current, system = ctypes.c_size_t(), ctypes.c_size_t()
        if not kernel.GetProcessAffinityMask(process, ctypes.byref(current), ctypes.byref(system)) or not current.value:
            raise OSError(ctypes.get_last_error(), 'Cannot read benchmark process affinity')
        selected = current.value & -current.value
        if not kernel.SetProcessAffinityMask(process, selected):
            raise OSError(ctypes.get_last_error(), 'Cannot restrict benchmark process affinity')
        affinity = {'allowedMask': current.value, 'selectedMask': selected, 'systemMask': system.value}
    document = {'status': 'IN_PROGRESS', 'platform': platform.platform(), 'pid': os.getpid(),
        'inheritedProcessAffinity': affinity,
        'binarySha256': {name: sha256(path) for name, path in binaries.items()},
        'sourceRoots': {name: str(root.resolve()) for name, root in roots.items()}, 'sourceSha256': manifests,
        'buildMetadata': build,
        'baselineOnlyHarnessDefine': 'NATIVE_BENCH_BASELINE_NO_BATCH=1',
        'callbacksPerRun': args.callbacks, 'warmupCallbacks': 1000, 'hardwareXruns': None,
        'baselineBatchBoundary': 'NOT_SUPPORTED',
        'limitations': ['Elapsed callback time includes OS scheduling and is not a hardware XRUN measurement.',
            'C++ new/new[] interception does not prove absence of every allocator or operating-system lock.',
            'Static ABBA compares the same graph on each binary; batch boundaries exist only on candidate.',
            'The batch workload alternates five-track STOP/PLAY at mid-block; its graph state and two half-blocks differ from static playback, so their difference is not pure segmentation cost.',
            'CMake/source and binary hashes are recorded; object-to-source provenance is not independently attested.'], 'rows': []}
    args.out.parent.mkdir(parents=True, exist_ok=True)

    def write():
        args.out.write_text(json.dumps(document, indent=2), encoding='utf-8')

    write()
    for frames in (64, 128, 256):
        for fx_mode in (0, 2):
            for supplement in ('none', 'live-mono', 'live-mono-short'):
                legs = [('baseline', 'none'), ('candidate', 'none'), ('candidate', 'batch'),
                    ('candidate', 'none'), ('candidate', 'batch'), ('baseline', 'none')]
                for leg, (variant, boundary) in enumerate(legs, 1):
                    cmd = [binaries[variant], '48000', str(frames), '5', str(fx_mode),
                        str(args.callbacks), 'playback', '2', supplement, boundary]
                    started = datetime.now(timezone.utc).isoformat()
                    try:
                        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
                    except subprocess.TimeoutExpired as error:
                        document['rows'].append({'leg': leg, 'variant': variant, 'boundary': boundary, 'command': cmd,
                            'startedUtc': started, 'finishedUtc': datetime.now(timezone.utc).isoformat(),
                            'timedOut': True, 'timeoutSeconds': error.timeout})
                        document['status'] = 'FAILED'
                        write()
                        raise SystemExit(f'Performance case timed out: {cmd}') from error
                    row = {'leg': leg, 'variant': variant, 'boundary': boundary, 'command': cmd,
                        'startedUtc': started, 'finishedUtc': datetime.now(timezone.utc).isoformat(),
                        'exitCode': result.returncode, 'stderr': result.stderr}
                    try:
                        row['measurement'] = json.loads(result.stdout)
                    except json.JSONDecodeError:
                        row['stdout'] = result.stdout
                    document['rows'].append(row)
                    if result.returncode != 0 or 'measurement' not in row:
                        document['status'] = 'FAILED'
                        write()
                        raise SystemExit(f'Performance case failed: {row}')
                    write()
    if manifests != {name: source_manifest(root) for name, root in roots.items()} or any(
            document['binarySha256'][name] != sha256(path) for name, path in binaries.items()):
        document['status'] = 'SOURCE_OR_BINARY_CHANGED'
        write()
        raise SystemExit('Source or binary changed during benchmark; results are not comparable.')
    document['status'] = 'COMPLETE'
    write()


if __name__ == '__main__':
    main()
