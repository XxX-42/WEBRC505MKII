from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, os, re, subprocess

REPO=Path(__file__).resolve().parents[1]
ARCHIVE=REPO/'bench/results/native-fx-startup-warmup-delta-20261009T2011Z'
BASE=REPO/'bench/results/native-fx41-copied-closure-20261009T193630570Z'
OUT=REPO/'docs/validation/20261010/native-startup-warmup-delta-root-review.json'
LOG=REPO/'docs/validation/20261010/root-native-startup-warmup-delta-ctest.log'

def extended(p):
    s=str(p.resolve())
    return '\\\\?\\'+s if os.name=='nt' and not s.startswith('\\\\?\\') else s

def read(p):
    with open(extended(p),'rb') as f: return f.read()

def sha(p): return hashlib.sha256(read(p)).hexdigest()
def j(p): return json.loads(read(p).decode('utf-8-sig'))
def verify(p,r):
    assert len(read(p))==r['bytes'] and sha(p)==r['sha256'],str(p)

def main():
    index=j(ARCHIVE/'archive-index.final.v1.json')
    assert len(index['files'])==index['fileCount']==134
    for r in index['files']: verify(ARCHIVE/r['path'],r)
    closure=j(ARCHIVE/'evidence/compiler-closure-delta.v1.json')
    for pathkey,hashkey in [('baseClosurePath','baseClosureSha256'),
        ('baseSourceManifestPath','baseSourceManifestSha256'),('overlayDeltaPath','overlayDeltaSha256'),
        ('postOverlaySourceManifestPath','postOverlaySourceManifestSha256'),('copyVerificationPath','copyVerificationSha256')]:
        assert sha(REPO/closure[pathkey])==closure[hashkey],pathkey
    base=j(BASE/'source-manifest.v2.json')
    post=j(ARCHIVE/'post-overlay-source-manifest.json')
    delta=j(ARCHIVE/'delta-manifest.json')
    overlay={r['path']:r for r in delta['overlayFiles']}
    basefiles={r['path']:r for r in base['files']}
    postfiles={r['path']:r for r in post['files']}
    assert len(basefiles)==len(postfiles)==1415 and len(overlay)==5 and set(basefiles)==set(postfiles)
    rebuilt={**basefiles,**overlay}
    assert all(rebuilt[rel]['sha256']==r['sha256'] and rebuilt[rel]['bytes']==r['bytes'] for rel,r in postfiles.items())
    source_digest=hashlib.sha256('\n'.join(rel+'='+rebuilt[rel]['sha256'] for rel in sorted(rebuilt,key=lambda x:x.encode('utf-16-be'))).encode()).hexdigest()
    assert source_digest==post['sourceSetSha256']==closure['postOverlaySourceSetSha256']
    for rel,r in basefiles.items(): verify(BASE/'source-snapshot'/rel,r)
    for rel,r in postfiles.items(): verify(ARCHIVE/'delta'/rel if rel in overlay else BASE/'source-snapshot'/rel,r)
    includes=[]
    for rel in overlay:
        old=set(x.strip().decode('utf-8') for x in re.findall(rb'^\s*#\s*include\b[^\r\n]*',read(BASE/'source-snapshot'/rel),re.MULTILINE))
        new=set(x.strip().decode('utf-8') for x in re.findall(rb'^\s*#\s*include\b[^\r\n]*',read(ARCHIVE/'delta'/rel),re.MULTILINE))
        assert not new-old,rel
        includes.append({'path':rel,'includeDirectivesIdentical':old==new,
                         'added':sorted(new-old),'removed':sorted(old-new)})
    tus=closure['compiledTranslationUnits']
    assert len(tus)==closure['compiledTranslationUnitCount']==66
    build=Path(closure['buildRootOriginal'])
    artifacts={r['buildRelativePath']:r for r in closure['buildArtifacts']}
    assert len(artifacts)==closure['buildArtifactCount']==109
    for r in artifacts.values():
        verify(ARCHIVE/r['archiveRelativePath'],r)
        verify(build/r['buildRelativePath'],r)
    for tu in tus:
        r=postfiles[tu['sourceRelativePath']]
        assert r['sha256']==tu['sourceSha256'] and r['bytes']==tu['sourceBytes']
        verify(Path(tu['sourcePath']),r)
        assert artifacts[tu['outputRelativePath']]['sha256']==tu['objectSha256']
    deps=closure['compilerDependencyInputs']
    assert len(deps)==closure['compilerDependencyInputCount']==478
    copied=external=0
    for r in deps:
        verify(Path(r['path']),r)
        if r['kind']=='external-toolchain': external+=1
        else: copied+=1
    assert copied==149 and external==329
    OUT.parent.mkdir(parents=True,exist_ok=True)
    result=subprocess.run([closure['ctestPath'],'--test-dir',str(build),'--output-on-failure'],
                          stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    LOG.write_bytes(result.stdout)
    assert result.returncode==0,result.stdout.decode('utf-8',errors='replace')
    text=result.stdout.decode('utf-8',errors='replace')
    assert re.search(r'100% tests passed(?:, 0 tests failed)? out of 28',text),text
    tests=re.findall(r'\d+/28 Test\s+#\d+:\s+(.+?)\s+\.+\s+Passed\s+([\d.]+) sec',text)
    assert len(tests)==28,tests
    for r in index['files']: verify(ARCHIVE/r['path'],r)
    for r in artifacts.values(): verify(build/r['buildRelativePath'],r)
    report={'schemaVersion':1,'createdUtc':datetime.now(timezone.utc).isoformat(),
        'archive':ARCHIVE.relative_to(REPO).as_posix(),'archiveIndexSha256':sha(ARCHIVE/'archive-index.final.v1.json'),
        'indexedFilesVerifiedBeforeAndAfterRootCTest':134,'baseSourceFilesVerified':1415,
        'overlayFilesVerified':5,'postOverlaySourceSetSha256':source_digest,
        'actualCompiledTranslationUnitsVerified':66,'preservedBuildArtifactsVerifiedBeforeAndAfter':109,
        'inheritedCompilerDependencyCandidatesRehashed':478,'copiedSourceInputCandidates':149,'externalToolchainInputCandidates':329,
        'includeDirectiveComparison':includes,'dependencyGraphMethod':closure['dependencyGraphMethod'],
        'rootCTest':{'tests':28,'passed':28,'failed':0,'filtered':False,'exitCode':result.returncode,
            'log':LOG.relative_to(REPO).as_posix(),'logSha256':sha(LOG),'testResults':[{'name':n,'seconds':float(s)} for n,s in tests]},
        'limitations':['Only API/PREAMP warmup/rate fix is covered; older finite-history FX bounds remain incomplete',
            'Dependency graph inherited from accepted base; no successful fresh include trace in this delta',
            'native_fx_graph.cpp removed preamp_models.hpp; inherited dependency candidates are a conservative base graph rather than a newly measured exact graph',
            'Original source prebuild verification was preserved; root rehash occurs after the producer build',
            'PREAMP fixed alignment and input-history warmup are different quantities',
            'Known FourByTwelve comment label mismatch is preserved; actual 19ms model is EightByTwelve',
            'No hardware, full realtime qualification, 53-FX completion or Gate pass']}
    OUT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'rootReview':str(OUT),'sha256':sha(OUT),'rootTests':28,'passed':28,
        'files':134,'sourceFiles':1415,'translationUnits':66,'dependencyInputs':478},indent=2))

if __name__=='__main__': main()
