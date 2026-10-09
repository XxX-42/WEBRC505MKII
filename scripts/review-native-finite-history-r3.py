"""Review the frozen finite-history build, independently of the changing checkout.

Default verifies archived evidence and the saved root CTest log. Use --local to
also verify the original compiler/build inputs and outputs. --run-tests repeats
the complete copied-source CTest suite and implies --local.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
import posixpath
import re
import subprocess

REPO = Path(__file__).resolve().parents[1]
ARCHIVE = REPO / 'bench/results/native-fx-finite-history-r3-delta-20261009T2117Z'
OUT = REPO / 'docs/validation/20261010/native-finite-history-r3-root-review.json'
LOG = REPO / 'docs/validation/20261010/root-native-finite-history-r3-ctest.log'
CORRECTION = REPO / 'bench/results/native-fx-finite-history-r3-tu-digest-correction-20261009T213600Z/translation-unit-source-manifest.corrected.json'


def read(path):
    name = str(path.resolve())
    if os.name == 'nt' and not name.startswith('\\\\?\\'):
        name = '\\\\?\\' + name
    with open(name, 'rb') as stream:
        return stream.read()


def sha(path):
    return hashlib.sha256(read(path)).hexdigest()


def load(path):
    return json.loads(read(path).decode('utf-8-sig'))


def verify(path, row):
    data = read(path)
    assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256'], str(path)


def source_digest(rows):
    return hashlib.sha256('\n'.join(row['path'] + '=' + row['sha256']
        for row in sorted(rows, key=lambda row: row['path'].encode('utf-16-be'))).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', action='store_true')
    parser.add_argument('--run-tests', action='store_true')
    args = parser.parse_args()
    local = args.local or args.run_tests
    index = load(ARCHIVE / 'archive-index.final.v1.json')
    assert len(index['files']) == index['fileCount']
    assert all('.git' not in Path(row['path']).parts for row in index['files'])
    for row in index['files']:
        verify(ARCHIVE / row['path'], row)
    source = load(ARCHIVE / 'source-manifest.json')
    base = load(ARCHIVE / 'build-evidence.json')
    supplement = load(ARCHIVE / 'build-evidence-tu-supplement.json')
    scope = load(ARCHIVE / 'root-scope-supplement.json')
    assert sha(ARCHIVE / supplement['baseBuildEvidence']) == supplement['baseBuildEvidenceSha256']
    assert len(source['files']) == source['fileCount'] == 162
    assert len(source['overlays']) == 8
    assert source_digest(source['files']) == source['sourceSetSha256'] == supplement['sourceSetSha256']
    for row in source['files']:
        verify(ARCHIVE / 'source-snapshot' / row['path'], row)
    assert len(scope['baseCheckoutLineEndingDifferences']) == 9
    assert all(row['onlyCRLFConversion'] for row in scope['baseCheckoutLineEndingDifferences'])
    dependencies = load(ARCHIVE / 'dependency-manifest.json')
    payload = [row for row in dependencies['files'] if '.git' not in Path(row['path']).parts]
    excluded = [row for row in dependencies['files'] if '.git' in Path(row['path']).parts]
    assert len(payload) == 1259 and len(excluded) == 84
    assert source_digest(dependencies['files']) == dependencies['sourceSetSha256']
    old_root = REPO / 'bench/results/native-fx41-copied-closure-20261009T193630570Z'
    old = {row['path']: row for row in load(old_root / 'source-manifest.v2.json')['files']}
    for row in payload:
        verify(ARCHIVE / 'dependency-snapshot' / row['path'], row)
        verify(old_root / 'source-snapshot' / row['path'], row)
        assert old[row['path']]['sha256'] == row['sha256'] and old[row['path']]['bytes'] == row['bytes']
    assert supplement['fetchContentFileCount'] == supplement['fetchContentMatchesPriorAcceptedSnapshot'] == 1259
    assert supplement['fetchContentMismatchPriorSnapshot'] == 0
    build = Path(supplement['toolchain']['buildRoot'])
    outputs = {row['buildRelativePath']: row for row in supplement['archivedBuildOutputs']}
    assert len(outputs) == supplement['archivedBuildOutputCount'] == len(base['outputs']) == 107
    for path, row in outputs.items():
        verify(ARCHIVE / row['archivePath'], row)
        if local:
            verify(build / path, row)
    generated = {row['buildRelativePath']: row for row in scope['generatedBuildEvidence']}
    for path, row in generated.items():
        verify(ARCHIVE / row['archivePath'], row)
        if local:
            verify(build / path, row)
    compiled = re.findall(r'Building CXX object ([^\r\n]+)', read(ARCHIVE / 'native-verify-copied.log').decode('utf-8', errors='replace'))
    compiled = [path.replace('\\', '/').strip() for path in compiled]
    records = supplement['translationUnitRecords']
    assert len(compiled) == len(records) == supplement['compiledObjectRecords'] == 66
    assert sorted(compiled) == sorted(row['objectTarget'] for row in records)
    unique = {}
    for row in records:
        source_row = {'bytes': row['sourceBytes'], 'sha256': row['sourceSha256']}
        verify(ARCHIVE / row['sourceArchivePath'], source_row)
        verify(ARCHIVE / row['copiedSourcePath'], source_row)
        assert outputs[row['objectTarget']]['sha256'] == row['objectSha256']
        rule_dir = row['objectTarget'].split('.dir/')[0] + '.dir'
        rules = read(ARCHIVE / generated[rule_dir + '/build.make']['archivePath']).decode('utf-8-sig')
        expected_rule = row['objectTarget'].replace('/', '\\') + ': ' + row['sourcePath'].replace('/', '\\')
        assert expected_rule in rules, row['objectTarget']
        unique[row['sourceArchivePath']] = row['sourceSha256']
        if local:
            verify(Path(row['sourcePath']), source_row)
    assert len(unique) == supplement['uniqueTranslationUnitCount'] == 64
    correction = load(CORRECTION)
    assert sha(ARCHIVE / correction['originalSupplementPath']) == correction['originalSupplementSha256']
    normalized_tus = {path.replace('\\', '/').lower(): value for path, value in unique.items()}
    assert len(normalized_tus) == correction['translationUnitCount'] == 64
    assert normalized_tus == {row['path']: row['sha256'] for row in correction['records']}
    tu_digest = hashlib.sha256(''.join(path + '|' + normalized_tus[path] + '\n'
        for path in sorted(normalized_tus)).encode()).hexdigest()
    assert tu_digest == correction['translationUnitSourceSetSha256']
    assert supplement['translationUnitSourceSetSha256'] == correction['originalClaimedTranslationUnitSourceSetSha256']
    assert supplement['translationUnitSourceSetSha256'] != tu_digest
    inputs = base['compilerInputs']
    assert len(inputs['depfiles']) == inputs['depfileCount'] == 66
    for row in inputs['depfiles'] + base['compiler']['flagsFiles']:
        assert generated[row['path']]['sha256'] == row['sha256']
    assert len(inputs['inputs']) == inputs['uniqueDependencyPaths'] == 414
    def normalized(path):
        return posixpath.normpath(re.sub('/+', '/', str(path).replace('\\', '/'))).lower()
    cache = read(ARCHIVE / base['cmakeCache']).decode('utf-8-sig')
    original_home = re.search(r'^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$', cache, re.M).group(1).strip()
    original_source_root = original_home.rsplit('/native-mvp/engine-cpp', 1)[0]
    declared_inputs = set()
    for row in inputs['inputs']:
        if row['origin'] == 'copied-source-snapshot':
            path = original_source_root + '/' + row['path']
        elif row['origin'] == 'FetchContent-cache-mirrored':
            path = base['fetchContent']['liveSourceRoot'] + '/' + row['path'].split('/_deps/', 1)[1]
        else:
            path = row['path']
        declared_inputs.add(normalized(path))
    traced_inputs = set()
    for row in inputs['depfiles']:
        data = read(ARCHIVE / generated[row['path']]['archivePath']).decode('utf-8-sig')
        traced_inputs.update(normalized(line.strip()) for line in data.splitlines() if line.strip())
    assert traced_inputs == declared_inputs and len(traced_inputs) == 414, {
        'traceCount': len(traced_inputs), 'declaredCount': len(declared_inputs),
        'extraTrace': sorted(traced_inputs - declared_inputs)[:5],
        'missingTrace': sorted(declared_inputs - traced_inputs)[:5]}
    origin_counts = {}
    for row in inputs['inputs']:
        origin = row['origin']
        origin_counts[origin] = origin_counts.get(origin, 0) + 1
        if origin == 'copied-source-snapshot':
            verify(ARCHIVE / 'source-snapshot' / row['path'], row)
        elif origin == 'FetchContent-cache-mirrored':
            verify(ARCHIVE / 'dependency-snapshot' / row['path'], row)
        else:
            assert origin in ('MSVC-toolchain', 'Windows-SDK'), origin
            if local:
                verify(Path(row['path']), row)
    tools = supplement['toolchain']
    assert tools['compilerId'] == 'MSVC' and tools['compilerVersion'] == '19.29.30159.0'
    if local:
        for row in base['compiler']['tools']:
            verify(Path(row['path']), row)
        assert sha(Path(tools['ctestPath'])) == tools['ctestSha256']
    if args.run_tests:
        result = subprocess.run([tools['ctestPath'], '--test-dir', str(build), '--output-on-failure'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        LOG.write_bytes(result.stdout)
        assert result.returncode == 0, result.stdout.decode(errors='replace')
    text = read(LOG).decode('utf-8', errors='replace')
    assert re.search(r'100% tests passed(?:, 0 tests failed)? out of 28', text)
    tests = re.findall(r'\d+/28 Test\s+#\d+:\s+(.+?)\s+\.+\s+Passed\s+([\d.]+) sec', text)
    assert len(tests) == 28
    for row in index['files']:
        verify(ARCHIVE / row['path'], row)
    if local:
        for path, row in outputs.items():
            verify(build / path, row)
    report = {'schemaVersion': 1, 'reviewedUtc': datetime.now(timezone.utc).isoformat(),
        'archive': ARCHIVE.relative_to(REPO).as_posix(), 'archiveIndexSha256': sha(ARCHIVE / 'archive-index.final.v1.json'),
        'archivedPayloadsVerified': len(index['files']), 'sourceSnapshotFiles': 162,
        'sourceSetSha256': source['sourceSetSha256'], 'overlayFiles': 8,
        'baseCheckoutLineEndingDifferences': scope['baseCheckoutLineEndingDifferences'],
        'fetchContentPayloadsMatchedToPriorAcceptedSnapshot': 1259, 'nestedGitMetadataExcluded': 84,
        'compiledObjects': 66, 'uniqueTranslationUnits': 64, 'buildOutputsVerified': 107,
        'correctedTranslationUnitSourceSetSha256': tu_digest,
        'tuDigestCorrection': {'path': CORRECTION.relative_to(REPO).as_posix(), 'sha256': sha(CORRECTION),
            'preservedOriginalDigestStatus': 'not reproducible; superseded by explicit normalized-path correction'},
        'generatedBuildEvidenceFilesVerified': len(generated), 'compilerHeaderDependenciesVerified': origin_counts,
        'originalBuildAndExternalToolchainChecked': local,
        'rootCTest': {'tests': 28, 'passed': 28, 'failed': 0, 'filtered': False,
            'log': LOG.relative_to(REPO).as_posix(), 'logSha256': sha(LOG),
            'results': [{'name': name, 'seconds': float(seconds)} for name, seconds in tests]},
        'limitations': ['FetchContent source hashes were captured after compilation; prior snapshot equality is corroboration.',
            'Nine base checkout files differ from raw Git blobs only by LF/CRLF conversion; the raw compiled copies are archived.',
            'Original dependency manifest retains hashes of 84 local nested .git metadata files, which are excluded from Git publication.',
            'Original TU supplement has an unreproducible aggregate digest; individual TU hashes are verified and a separate canonical correction is preserved.',
            'Finite-history startup bounds describe required input history, not acoustic latency or recursive-feedback convergence.',
            'This suite does not qualify all 53 FX, real-time performance, 30-minute stress, audio quality, or hardware latency.']}
    OUT.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'rootReview': str(OUT), 'sha256': sha(OUT), 'rootCTest': '28/28 PASS',
        'payloads': len(index['files']), 'compiledObjects': 66, 'originalLocalInputsChecked': local}))


if __name__ == '__main__':
    main()
