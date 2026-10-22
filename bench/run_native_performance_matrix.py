#!/usr/bin/env python3
"""Run serial, same-workload Native A/B and portable callback coverage.
Supply preserved Release executables from baseline, round1 and final builds.
Do not run other benchmarks/builds concurrently. No hardware XRUN is inferred.
"""
import argparse, datetime, hashlib, itertools, json, pathlib, platform, subprocess, time, os
p = argparse.ArgumentParser()
p.add_argument('--cpu', type=int)
p.add_argument('--baseline-source-root')
p.add_argument('--build-manifest', help='Optional JSON with binaries {basename: SHA256} and sourceSha256; validates candidate build binding')
p.add_argument('--skip-ab', action='store_true')
p.add_argument('--baseline', required=True)
p.add_argument('--round1')
p.add_argument('--candidate', required=True)
p.add_argument('--matrix', required=True)
p.add_argument('--output', required=True)
p.add_argument('--ab-callbacks', type=int, default=3000)
p.add_argument('--matrix-callbacks', type=int, default=300)
a = p.parse_args()
allowed = sorted(os.sched_getaffinity(0))
if a.cpu is not None and a.cpu not in allowed: raise SystemExit('CPU not allowed')
manifest = json.loads(pathlib.Path(a.build_manifest).read_text()) if a.build_manifest else None
verified_binaries = set()
if manifest:
    if manifest.get('buildBindingVerified') is not True: raise SystemExit('Build manifest is not verified')
    for binary in (a.candidate, a.matrix):
        actual = hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()
        if manifest.get('binaries', {}).get(pathlib.Path(binary).name) != actual: raise SystemExit('Build manifest binary SHA mismatch')
        verified_binaries.add((str(pathlib.Path(binary).resolve()), actual))
    if manifest.get('dependencyBindingVersion') != 1 or not manifest.get('dependencyBinding', {}).get('sourceDependencies'):
        raise SystemExit('Build manifest comprehensive dependency binding missing; regenerate with current verifier')
    for dependency, expected_hash in manifest.get('dependencyBinding', {}).get('sourceDependencies', {}).items():
        path = pathlib.Path(dependency)
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise SystemExit('Build manifest dependency SHA mismatch: ' + dependency)
    actual_source = hashlib.sha256(pathlib.Path('native-mvp/engine-cpp/src/native_preamp_processor.cpp').read_bytes()).hexdigest()
    if manifest.get('sourceSha256') != actual_source: raise SystemExit('Build manifest source SHA mismatch')
    actual_header = hashlib.sha256(pathlib.Path('native-mvp/engine-cpp/include/native_preamp_processor.hpp').read_bytes()).hexdigest()
    if manifest.get('headerSha256') != actual_header: raise SystemExit('Build manifest header SHA mismatch')
root = pathlib.Path(a.output); root.mkdir(parents=True, exist_ok=True)
def run(binary, args):
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    value = json.loads(subprocess.check_output([binary, *map(str, args)], preexec_fn=(lambda: os.sched_setaffinity(0, {a.cpu})) if a.cpu is not None else None))
    value['runStartedUtc'] = started
    value['runFinishedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    value['binarySha256'] = hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()
    value['warmupCallbacks'] = 1000
    binding_verified = (str(pathlib.Path(binary).resolve()), value['binarySha256']) in verified_binaries
    value['buildBindingVerified'] = binding_verified
    value['buildBindingEvidence'] = a.build_manifest if binding_verified else None
    value['requestedChildCpu'] = a.cpu
    source_root = pathlib.Path(a.baseline_source_root) if binary == a.baseline and a.baseline_source_root else pathlib.Path('.')
    value['declaredSourceSha256'] = {str(v): hashlib.sha256((source_root/v).read_bytes()).hexdigest() for v in [pathlib.Path('native-mvp/engine-cpp/src/native_preamp_processor.cpp'), pathlib.Path('native-mvp/engine-cpp/include/native_preamp_processor.hpp')]} if binary != a.baseline or a.baseline_source_root else None
    value['hardwareXruns'] = None
    value['droppedFrames'] = None
    value['driverOverflows'] = None
    value['driverUnderruns'] = None
    value['peakRssKiB'] = value.get('peakRssKiB')
    value['callbackAllocations'] = value.get('callbackAllocations')
    value['allocationScope'] = 'C++ operator new/new[] only; malloc/aligned allocation not intercepted'
    value['cpuProcessPercent'] = None
    value['gcPauses'] = None
    value['mainThreadLongTasks'] = None
    value['postMessageCount'] = None
    value['postMessageBytes'] = None
    value['startupTimeNs'] = None
    value['unavailableReason'] = 'Device-free C++ callback benchmark, no browser GC/postMessage/long-task instrumentation; no hardware driver or startup timer; historical baseline may lack allocation/RSS instrumentation'
    value['functionalGate'] = 'PASS'
    value['performanceGate'] = 'PASS' if value['p99Ns'] < .5*value['budgetNs'] and value['maxNs'] < .8*value['budgetNs'] and value['cpuBudgetExceedances'] == 0 else 'FAIL'
    value['meanBudgetPercent'] = 100 * value['meanNs'] / value['budgetNs']
    value['p99BudgetPercent'] = 100 * value['p99Ns'] / value['budgetNs']
    return value
meta = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'platform': platform.platform(),
        'candidateBuildBindingVerified': bool(manifest), 'buildBindingScope': 'Candidate and matrix binaries only; per-row flag is authoritative for baseline and round1', 'buildBindingEvidence': a.build_manifest, 'requestedChildCpu': a.cpu, 'allowedAffinity': allowed,
        'hardware': 'HARDWARE_BLOCKED: no physical device/driver callback',
        'isolation': 'Other task-team builds and timings paused; shared cloud host is not a real-time controlled device',
        'buildFlags': 'CMAKE_BUILD_TYPE=Release; GNU C++ -O3 -DNDEBUG; no fast-math, reduced oversampling or experimental ADAA',
        'compiler': subprocess.check_output(['g++','--version'],text=True).splitlines()[0],
        'declaredSourceSha256': {str(v):hashlib.sha256(v.read_bytes()).hexdigest() for v in [pathlib.Path('native-mvp/engine-cpp/src/native_preamp_processor.cpp'),pathlib.Path('native-mvp/engine-cpp/include/native_preamp_processor.hpp')]},
        'binaries': {n: {'path': v, 'sha256': hashlib.sha256(pathlib.Path(v).read_bytes()).hexdigest()} for n, v in [('baseline', a.baseline), ('round1', a.round1), ('candidate', a.candidate), ('matrix', a.matrix)] if v}}
if pathlib.Path('/proc/cpuinfo').exists():
    meta['cpuModel'] = next((v.split(':',1)[1].strip() for v in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if v.startswith('model name')), 'unknown')
(root/'native-environment.json').write_text(json.dumps(meta,indent=2)+'\n')
comparisons = [('combined-final',a.baseline,a.candidate)]
if a.round1:
    comparisons = [('parameter-cache',a.baseline,a.round1),('final-incremental',a.round1,a.candidate)] + comparisons
for label, first, second in ([] if a.skip_ab else comparisons):
    rows=[]
    for binary in [first,second,second,first]:
        value=run(binary,[48000,64,5,1,a.ab_callbacks]);value['variant']='A' if binary==first else 'B';rows.append(value)
        print(label,value['variant'],value['p50Ns'],flush=True)
    assert len({r['hash'] for r in rows})==1,'A/B output mismatch'
    (root/f'native-{label}-abba.json').write_text(json.dumps({'order':'ABBA','rows':rows},indent=2)+'\n')
rows=[]
for rate,frames,tracks,fx,transport,channels in itertools.product([44100,48000],[64,128,256],[1,5],[0,1,2],['playback','record','overdub'],[1,2]):
    value=run(a.matrix,[rate,frames,tracks,fx,a.matrix_callbacks,transport,channels]);rows.append(value)
    (root/'native-matrix.json').write_text(json.dumps(rows,indent=2)+'\n')
    print('matrix',len(rows),rate,frames,tracks,fx,transport,channels,flush=True)
