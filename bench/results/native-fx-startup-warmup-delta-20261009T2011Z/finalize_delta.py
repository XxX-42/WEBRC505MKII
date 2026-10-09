import os, json, hashlib, shutil, re, sys
from datetime import datetime, timezone
from pathlib import Path

archive = Path(r"D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2\bench\results\native-fx-startup-warmup-delta-20261009T2011Z")
tmp = Path(os.environ['TEMP']) / 'webrc-native-warmup-delta-20261009T2011Z'
build = tmp / 'build'
src = tmp / 'src'
repo = Path(r"D:\Documents\Codes\2024_1_WebRC505MKII\2025_WebRC505MKII_v2")
base = repo / 'bench/results/native-fx41-copied-closure-20261009T193630570Z'
base_closure_path = base / 'evidence/compiler-closure.v2.json'
base_manifest_path = base / 'source-manifest.v2.json'
post_manifest_path = archive / 'post-overlay-source-manifest.json'


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''):
            h.update(b)
    return h.hexdigest()

def readjson(p):
    return json.loads(p.read_text(encoding='utf-8'))
def writejson(p, x):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(x, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

def canon(p): return str(p).replace('\\','/')

base_closure = readjson(base_closure_path)
base_manifest = readjson(base_manifest_path)
post_manifest = readjson(post_manifest_path)
base_source_root = (base / 'source-snapshot').resolve()
source_root = src.resolve()
post_by_rel = {x['path']: x for x in post_manifest['files']}
base_by_rel = {x['path']: x for x in base_manifest['files']}
assert len(post_by_rel) == 1415 and post_manifest['sourceSetSha256'] == '0a425619e802822507ecb815d73b5e2fb1bdb58dd6aad328ed5cfa813465eb96'
assert len(base_by_rel) == 1415 and base_manifest['sourceSetSha256'] == '292d9ec0dbf6c51b11b37829ca5e5398adda8c88b1e16b3688a1fa4aa211273e'

# Verify every copied source file against the post-overlay manifest before creating evidence.
for rel, row in post_by_rel.items():
    p = source_root / Path(rel)
    assert p.is_file(), f'missing source: {rel}'
    assert p.stat().st_size == row['bytes'] and sha(p) == row['sha256'], f'source mismatch: {rel}'

# Capture exact compiler units from the current build, updating the baseline unit graph and object hashes.
units = []
for old in base_closure['compiledTranslationUnits']:
    rel = old['sourceRelativePath'].replace('\\','/')
    source = source_root / Path(rel)
    row = post_by_rel[rel]
    objrel = old['outputRelativePath'].replace('\\','/')
    obj = build / Path(objrel)
    assert source.is_file() and obj.is_file(), f'missing TU source/object: {rel} / {objrel}'
    command = old['command']
    command = command.replace(canon(base_source_root), canon(source_root))
    command = command.replace(str(base_source_root), str(source_root))
    units.append({
        'sourcePath': canon(source), 'sourceRelativePath': rel,
        'sourceBytes': source.stat().st_size, 'sourceSha256': sha(source),
        'outputRelativePath': objrel, 'objectBytes': obj.stat().st_size,
        'objectSha256': sha(obj), 'command': command
    })
assert len(units) == base_closure['compiledTranslationUnitCount'] == 66

# Dependency graph is inherited from the accepted exact base graph. Rebind all 149 source-snapshot
# dependencies to the copied tree and replace hashes with the pre-build verified overlay snapshot;
# verify all 329 external toolchain inputs against their pinned bytes/hashes in this build environment.
deps = []
old_root = canon(base_source_root)
for old in base_closure['compilerDependencyInputs']:
    ptxt = old['path'].replace('\\','/')
    match = re.search(re.escape(old_root) + r'/(.+)$', ptxt, re.IGNORECASE)
    if match:
        rel = match.group(1)
        row = post_by_rel.get(rel)
        assert row is not None, f'dependency absent from source manifest: {rel}'
        depfile = source_root / Path(rel)
        assert depfile.is_file() and depfile.stat().st_size == row['bytes'] and sha(depfile) == row['sha256'], f'dependency mismatch: {rel}'
        deps.append({'path': canon(depfile), 'sourceRelativePath': rel, 'bytes': row['bytes'], 'sha256': row['sha256'], 'kind': 'copied-source'})
    else:
        ext = Path(old['path'])
        assert ext.is_file(), f'external compiler input missing: {old["path"]}'
        actual_sha = sha(ext)
        actual_bytes = ext.stat().st_size
        assert actual_sha == old['sha256'] and actual_bytes == old['bytes'], f'external compiler input drift: {old["path"]}'
        deps.append({'path': old['path'], 'bytes': actual_bytes, 'sha256': actual_sha, 'kind': 'external-toolchain'})
assert len(deps) == base_closure['uniqueCompilerDependencyInputFileCount'] == 478
assert sum(x['kind']=='copied-source' for x in deps) == 149
assert sum(x['kind']=='external-toolchain' for x in deps) == 329

# Preserve all emitted .obj/.exe/.lib/.exp artifacts from this copied-source build.
outputs_dir = archive / 'evidence/outputs/build-root'
artifacts = []
for f in build.rglob('*'):
    if not f.is_file() or f.suffix.lower() not in {'.obj','.exe','.lib','.exp'}:
        continue
    rel = f.relative_to(build).as_posix()
    target = outputs_dir / Path(rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(f, target)
    artifacts.append({'buildRelativePath': rel, 'archiveRelativePath': target.relative_to(archive).as_posix(), 'bytes': target.stat().st_size, 'sha256': sha(target)})
assert len(artifacts) == 109, f'expected 109 compiler outputs; found {len(artifacts)}'

# Preserve configuration and CTest state needed to inspect this exact run.
config_dir = archive / 'evidence/configure'
config_dir.mkdir(parents=True, exist_ok=True)
for rel in ['CMakeCache.txt','compile_commands.json','CTestTestfile.cmake']:
    f = build / rel
    if f.is_file(): shutil.copy2(f, config_dir / rel)
for f in build.rglob('CTestTestfile.cmake'):
    rel = f.relative_to(build)
    target = config_dir / 'ctest-files' / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists(): shutil.copy2(f,target)
test_log = build / 'Testing/Temporary/LastTest.log'
if test_log.is_file(): shutil.copy2(test_log, archive / 'evidence/LastTest.log')

# Preserve copies of the build log with truthful names; original logs remain unchanged.
for srcname, dstname in [
  ('native-verify-showincludes.log','native-verify-copied-source-build-ctest.log'),
  ('native-verify-showincludes-instrumented.log','native-verify-copied-source-instrumented-build-ctest.log'),
  ('ctest-unfiltered.log','ctest-unfiltered.log')]:
    f = archive / srcname
    if f.is_file() and dstname != srcname:
        shutil.copy2(f, archive / dstname)

cache = (build/'CMakeCache.txt').read_text(encoding='utf-8',errors='replace')
compiler_line = next((x for x in cache.splitlines() if x.startswith('CMAKE_CXX_COMPILER:FILEPATH=')), None)
make_line = next((x for x in cache.splitlines() if x.startswith('CMAKE_MAKE_PROGRAM:FILEPATH=')), None)
generator_line = next((x for x in cache.splitlines() if x.startswith('CMAKE_GENERATOR:INTERNAL=')), None)
assert compiler_line and '14.29.30133' in compiler_line
assert generator_line and 'NMake Makefiles' in generator_line

closure = {
  'schema':'native-fx-startup-warmup-compiler-closure-delta-v1',
  'capturedAtUtc':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
  'repositoryHeadAtBase':'aa382c0a9b2647724cb35921afc14b9b1eb78f25',
  'baseClosurePath':'bench/results/native-fx41-copied-closure-20261009T193630570Z/evidence/compiler-closure.v2.json',
  'baseClosureSha256':sha(base_closure_path),
  'baseSourceManifestPath':'bench/results/native-fx41-copied-closure-20261009T193630570Z/source-manifest.v2.json',
  'baseSourceManifestSha256':sha(base_manifest_path),
  'baseSourceSetSha256':base_manifest['sourceSetSha256'],
  'overlayDeltaPath':'bench/results/native-fx-startup-warmup-delta-20261009T2011Z/delta-manifest.json',
  'overlayDeltaSha256':sha(archive/'delta-manifest.json'),
  'postOverlaySourceManifestPath':'bench/results/native-fx-startup-warmup-delta-20261009T2011Z/post-overlay-source-manifest.json',
  'postOverlaySourceManifestSha256':sha(post_manifest_path),
  'postOverlaySourceSetSha256':post_manifest['sourceSetSha256'],
  'postOverlayFileCount':len(post_manifest['files']),
  'copyVerificationPath':'bench/results/native-fx-startup-warmup-delta-20261009T2011Z/prebuild-source-verification.json',
  'copyVerificationSha256':sha(archive/'prebuild-source-verification.json'),
  'buildRootOriginal':str(build),
  'buildType':'Release', 'generator':'NMake Makefiles',
  'compilerPath':compiler_line.split('=',1)[1],
  'compilerToolset':'14.29.30133', 'compilerVersion':'19.29.30159.0',
  'makeProgramPath':make_line.split('=',1)[1] if make_line else None,
  'cmakePath':'C:/Program Files/CMake/bin/cmake.exe',
  'ctestPath':'C:/Program Files/CMake/bin/ctest.exe',
  'sourceFilesWereStableBeforeAndAfterBuild':'The complete 1415-file copied source tree was verified against postOverlaySourceManifest before build. Current build TU object outputs and source hashes are recorded here. No source files were edited during the build/test interval per task freeze.',
  'compiledTranslationUnitCount':len(units), 'compiledTranslationUnits':units,
  'compilerDependencyInputCount':len(deps), 'copiedSourceDependencyInputCount':149, 'externalToolchainDependencyInputCount':329,
  'dependencyGraphMethod':'Inherited from accepted base closure graph (66 TUs / 478 unique inputs). The five overlay files are already dependencies in that graph; source-snapshot dependency paths were rebound to this copied tree and all hashes refreshed. The five code edits are implementation-only and add no include directives. All external toolchain dependency files were rehashed against the pinned base rows before sealing.',
  'compilerDependencyInputs':deps,
  'buildArtifactCount':len(artifacts), 'buildArtifacts':artifacts,
  'unfilteredCTest':{'result':'PASS','tests':28,'passed':28,'failed':0,'skipped':0,'durationSeconds':14.82,'logPath':'bench/results/native-fx-startup-warmup-delta-20261009T2011Z/ctest-unfiltered.log','logSha256':sha(archive/'ctest-unfiltered.log'),'lastTestLogPath':'bench/results/native-fx-startup-warmup-delta-20261009T2011Z/evidence/LastTest.log','lastTestLogSha256':sha(archive/'evidence/LastTest.log') if (archive/'evidence/LastTest.log').is_file() else None},
  'limitations':['This verifies copied-source Release build/CTest for the five-file warmup API delta on top of the 41-ready base snapshot.','Finite-history startup bounds for other history-based effects are incomplete and are not qualified by this delta.','No audio hardware or device output was opened.','This is not completion of the 53-effect graph or the performance gates.']
}
writejson(archive/'evidence/compiler-closure-delta.v1.json',closure)

readme = '''Native FX startup warmup API delta — copied-source verification\n\nThis archive links a five-file overlay to the immutable 41-ready source snapshot at `bench/results/native-fx41-copied-closure-20261009T193630570Z/`. Reconstruct by copying that base `source-snapshot/` tree and replacing the five files listed in `delta-manifest.json` with the matching files in `delta/`. The resulting 1,415-file tree is pinned by `post-overlay-source-manifest.json` (`sourceSetSha256` in `evidence/compiler-closure-delta.v1.json`).\n\nThe copied tree was built in Release with VS 2019 MSVC toolset 14.29.30133, compiler 19.29.30159.0, CMake 4.4.2, NMake. The unfiltered CTest run passed 28/28 (14.82 s); no hardware device was opened. The compiler closure delta records 66 actual translation units, 478 dependency inputs (149 copied-source and 329 external toolchain inputs), and hashes for 109 preserved `.obj/.exe/.lib/.exp` outputs. Build/test logs and CMake state are under `evidence/`.\n\nThe initial build log filename `native-verify-showincludes.log` was inherited from the launcher but is not an include-trace log; its faithful copy is labeled `native-verify-copied-source-build-ctest.log`. The supplemental `-showIncludes` attempt is retained separately and is not used as the dependency-closure proof.\n\nThe five source hashes are in `delta-manifest.json`. The comment referring to the 19 ms speaker model as “FourByTwelve” is a known non-semantic label mismatch; actual selector is EightByTwelve. This delta reports PREAMP’s prepared-instance startup warmup separately from fixed alignment latency. Startup-history bounds for other finite-history processors are still under implementation; no general “settled” or all-effects click-free claim follows from this archive.\n\nThis is a partial Native copied-source verification, not a 53-effect completion or Gate pass. It says nothing about device XRUNs or hardware output. Do not modify files in this sealed evidence archive; create a new revision directory for later work.\n'''
(archive/'README.md').write_text(readme, encoding='utf-8', newline='\n')

# Final index excludes itself and checksums file to avoid recursive hashes.
files=[]
for f in sorted((p for p in archive.rglob('*') if p.is_file() and p.name not in {'archive-index.final.v1.json','archive-files.final.sha256.txt'}), key=lambda p:p.relative_to(archive).as_posix()):
    rel=f.relative_to(archive).as_posix()
    files.append({'path':rel,'bytes':f.stat().st_size,'sha256':sha(f)})
index={'schema':'native-fx-startup-warmup-delta-archive-index-v1','fileCount':len(files),'files':files}
writejson(archive/'archive-index.final.v1.json',index)
with open(archive/'archive-files.final.sha256.txt','w',encoding='ascii',newline='\n') as out:
    for x in files: out.write(f"{x['sha256']}  {x['path']}\n")
# Hash the new machine-readable closure and index for handoff.
print(json.dumps({'archive':str(archive),'sourceSet':post_manifest['sourceSetSha256'],'closureSha256':sha(archive/'evidence/compiler-closure-delta.v1.json'),'indexSha256':sha(archive/'archive-index.final.v1.json'),'indexedFiles':len(files),'compiledTUs':len(units),'dependencyInputs':len(deps),'artifacts':len(artifacts),'externalInputsRehashed':329,'copiedSourceInputs':149},indent=2))


