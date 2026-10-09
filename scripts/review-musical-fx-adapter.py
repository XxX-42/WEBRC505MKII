from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
A=ROOT/'shared/dsp/benchmarks/results/musical-fx-adapter-fresh-closure-20261009T203400Z'
OUT=ROOT/'docs/validation/20261010/musical-fx-adapter-root-review.json'
LOG=ROOT/'docs/validation/20261010/root-musical-fx-adapter-test.log'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def j(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def check_index():
    rows=[]
    for line in (A/'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
        if not line.strip():continue
        h,p=line.split(None,1);p=p.strip();f=A/p
        assert f.resolve().is_relative_to(A.resolve()) and sha(f)==h,p
        rows.append(p)
    assert len(rows)==len(set(rows))==54
    return rows
rows=check_index()
before=j(A/'source-hashes-before.json');after=j(A/'source-hashes-after.json')
assert before==after
for r in before['sourceFiles']:
    p=A/r['path'];assert sha(p)==r['sha256'] and p.stat().st_size==r['bytes']
    rel=r['path'].removeprefix('source/')
    assert sha(ROOT/rel)==r['sha256'],rel
m=j(A/'manifest.json');exe=A/m['result']['executable']['path']
assert sha(exe)==m['result']['executable']['sha256']
result=subprocess.run([str(exe)],cwd=A/'build',stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
assert result.returncode==0,result.stdout
assert b'musical_fx_adapter_tests: PASS' in result.stdout
energy=re.search(rb'VOCODER20_CARRIER_LR_ENERGY ([\d.eE+-]+) ([\d.eE+-]+)',result.stdout)
assert energy
left,right=map(float,energy.groups());assert left>1e-5 and right<left*1e-4
OUT.parent.mkdir(parents=True,exist_ok=True);LOG.write_bytes(result.stdout)
check_index()
report={'schemaVersion':1,'createdUtc':datetime.now(timezone.utc).isoformat(),
    'archive':A.relative_to(ROOT).as_posix(),'indexSha256':sha(A/'SHA256SUMS.txt'),
    'indexedFilesVerifiedBeforeAndAfterRootRun':54,'copiedSourceFilesVerified':len(before['sourceFiles']),
    'liveSourceHashesMatchCopiedSource':True,'producerBeforeAfterSourceTreesEqual':True,
    'compiledTranslationUnits':m['translationUnits'],'rootTestExitCode':result.returncode,
    'rootTestLog':LOG.relative_to(ROOT).as_posix(),'rootTestLogSha256':sha(LOG),
    'executableSha256':sha(exe),'carrierEnergy':{'left':left,'right':right},
    'coverageReviewed':m['coverage'],
    'limitations':['Nine standalone adapter kinds only; no factory/Native graph/WASM route is added by this checkpoint',
        'MIDI channel 0 only; external-carrier VOCODER20 ordinary processing deliberately rejects',
        'C++ new/delete instrumentation covers tested callback calls only, not OS heap, locks or browser GC',
        'No callback timing benchmark, full graph stress, official control-schema completeness, musical quality or Gate pass',
        'The archive pins copied product sources and executable but does not capture a full compiler/SDK dependency closure',
        'No-exceptions compilation covers the adapter translation unit, not a complete WASM link']}
OUT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'report':str(OUT),'sha256':sha(OUT),'indexFiles':54,'sources':len(before['sourceFiles']),
    'translationUnits':len(m['translationUnits']),'rootExitCode':result.returncode,'carrierEnergy':[left,right]},indent=2))
