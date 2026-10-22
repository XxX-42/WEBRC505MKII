#!/usr/bin/env python3
"""Explicitly build opt-in Native targets and verify their source/object/library binding.
A manifest is local build provenance, not a signed supply-chain attestation.
"""
import argparse,datetime,hashlib,json,pathlib,subprocess
from native_build_dependencies import collect_dependencies
p=argparse.ArgumentParser()
p.add_argument('--cmake',default='cmake')
p.add_argument('--source',required=True,help='engine-cpp source directory')
p.add_argument('--build',required=True)
p.add_argument('--manifest',required=True)
p.add_argument('--verify-only',action='store_true')
a=p.parse_args()
source=pathlib.Path(a.source).resolve(); build=pathlib.Path(a.build).resolve()
cache=(build/'CMakeCache.txt').read_text()
home=next(x.split('=',1)[1] for x in cache.splitlines() if x.startswith('CMAKE_HOME_DIRECTORY:INTERNAL='))
if pathlib.Path(home).resolve()!=source:raise SystemExit('CMake source directory mismatch')
targets=['native_performance_matrix','native_performance_soak','native_preamp_ab_probe','native_catalog_ab_probe','native_catalog_sanity_sweep']
if not a.verify_only:
 subprocess.run([a.cmake,'--build',str(build),'--target',*targets,'-j2'],check=True)
cpp=source/'src/native_preamp_processor.cpp';header=source/'include/native_preamp_processor.hpp'
obj=build/'CMakeFiles/native_dsp_portable.dir/src/native_preamp_processor.cpp.o'
lib=build/'libnative_dsp_portable.a'
make=(build/'CMakeFiles/native_dsp_portable.dir/build.make').read_text()
if str(cpp) not in make:raise SystemExit('PREAMP object build rule does not reference expected source')
files=[cpp,header,obj,lib,*[build/t for t in targets]]
for path in files:
 if not path.is_file():raise SystemExit('Missing artifact: '+str(path))
if obj.stat().st_mtime_ns < max(cpp.stat().st_mtime_ns,header.stat().st_mtime_ns):
 raise SystemExit('PREAMP object is older than source/header')
if lib.stat().st_mtime_ns < obj.stat().st_mtime_ns:
 raise SystemExit('DSP library is older than PREAMP object')
for target in targets:
 if (build/target).stat().st_mtime_ns < lib.stat().st_mtime_ns:
  raise SystemExit('Stale opt-in executable older than DSP library: '+target)
try:
 dependencies = collect_dependencies(source, build, targets)
except ValueError as error:
 raise SystemExit(str(error))
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
result=dict(verifiedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 sourceRoot=str(source),buildRoot=str(build),buildBindingVerified=True,
 dependencyBinding=dependencies,dependencyBindingVersion=1,
 verification='Explicit targets (unless verify-only), CMake home/build-rule source match, recursively linked local source/header <= object <= library <= binary timestamps and SHA256 inventory',
 sourceSha256=sha(cpp),headerSha256=sha(header),binaries={t:sha(build/t) for t in targets},
 artifacts={str(f):dict(sha256=sha(f),mtimeNs=f.stat().st_mtime_ns)for f in files},
 limitation='Local GNU Make portable build binding; timestamps/hashes are not a signed or adversary-resistant attestation')
pathlib.Path(a.manifest).write_text(json.dumps(result,indent=2)+'\n')
print('Verified explicit Native build:',a.manifest)
