#!/usr/bin/env python3
"""Run the real-wall paced device-free callback soak and retain provenance."""
import argparse, datetime, hashlib, json, pathlib, subprocess, sys
from native_build_dependencies import collect_dependencies
parser = argparse.ArgumentParser()
parser.add_argument('binary')
parser.add_argument('destination')
parser.add_argument('seconds', nargs='?', default='600')
parser.add_argument('--build-manifest')
args = parser.parse_args()
binary, destination, seconds = args.binary, args.destination, args.seconds
manifest = json.loads(pathlib.Path(args.build_manifest).read_text()) if args.build_manifest else None

def verify_binding():
    if manifest is None:
        return False
    if manifest.get('dependencyBindingVersion') != 1 or not manifest.get('dependencyBinding', {}).get('sourceDependencies'):
        raise ValueError('Missing comprehensive dependency binding')
    if manifest.get('buildBindingVerified') is not True:
        raise ValueError('Unverified build manifest')
    actual = hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()
    if manifest.get('binaries', {}).get(pathlib.Path(binary).name) != actual:
        raise ValueError('Soak executable does not match build manifest')
    dependencies = collect_dependencies(manifest['sourceRoot'], manifest['buildRoot'], list(manifest['binaries']))
    if dependencies != manifest.get('dependencyBinding'):
        raise ValueError('Source/object/library/executable binding changed since manifest verification')
    return True

binding_before = verify_binding()
source = pathlib.Path(__file__).resolve().parents[1] / 'native-mvp/engine-cpp/src/native_preamp_processor.cpp'
source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
print('Native soak started:', started, 'wall seconds:', seconds, flush=True)
checkpoint = str(pathlib.Path(destination).with_suffix('.checkpoint-600s.json'))
run = subprocess.run([binary, seconds, checkpoint], text=True, capture_output=True)
row = json.loads(run.stdout) if run.stdout.strip() else {}
binding_after = verify_binding()
row.update(runStartedUtc=started, runFinishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
           buildBindingVerified=binding_before and binding_after, buildBindingEvidence=args.build_manifest, declaredPreampSourceSha256=source_sha256, requestedWallSeconds=int(seconds), exitCode=run.returncode, stderr=run.stderr,
           binarySha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(),
           functionalGate='PASS' if run.returncode == 0 else 'FAIL',
           schedulingScope='Co-loaded stability run; not isolated performance acceptance',
           allocationScope='C++ operator new/new[] only; malloc/aligned allocations and frees uninstrumented',
           hardwareXruns=None, driverUnderruns=None, gc=None,
           unavailableReason='Device-free Native callback; no physical driver and no JavaScript GC',
           performanceGate='NOT_APPLICABLE_COLOADED_STABILITY_RUN')
pathlib.Path(destination).write_text(json.dumps(row, indent=2)+'\n')
print(json.dumps(row), flush=True)
sys.exit(run.returncode)
