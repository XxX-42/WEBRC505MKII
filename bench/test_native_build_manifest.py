#!/usr/bin/env python3
"""Lightweight manifest rejection and unverified-round1 labelling regression."""
import contextlib,io,json,pathlib,sys,tempfile
from unittest.mock import patch
root=pathlib.Path(__file__).resolve().parents[1]
runner=(root/'bench/run_native_performance_matrix.py').read_text().split('meta =')[0]
manifest_path=pathlib.Path(sys.argv[1]); manifest=json.loads(manifest_path.read_text())
candidate=str(pathlib.Path(manifest['buildRoot'])/'native_performance_matrix')
old=sys.argv[2]
results=[]
with tempfile.TemporaryDirectory(prefix='native-manifest-test-') as temp:
 cases = [('legacy', 'dependencyBindingVersion', None, 'comprehensive dependency binding missing'), ('empty_dependencies', 'dependencyBinding', {}, 'comprehensive dependency binding missing'), ('header','headerSha256','0'*64,'header SHA mismatch'),('unverified','buildBindingVerified',False,'not verified')]
 if manifest.get('dependencyBinding', {}).get('sourceDependencies'):
  binding = dict(manifest['dependencyBinding'])
  dependencies = dict(binding['sourceDependencies'])
  dependencies[next(iter(dependencies))] = '0'*64
  binding['sourceDependencies'] = dependencies
  cases.append(('dependency', 'dependencyBinding', binding, 'dependency SHA mismatch'))
 for name,field,value,expected in cases:
  bad=dict(manifest);bad[field]=value;p=pathlib.Path(temp)/(name+'.json');p.write_text(json.dumps(bad))
  argv=['runner','--baseline',old,'--candidate',candidate,'--matrix',candidate,'--output',temp,'--build-manifest',str(p)]
  with patch.object(sys,'argv',argv):
   try:exec(compile(runner,'runner','exec'),{})
   except SystemExit as error:
    assert expected in str(error);results.append({'case':name,'status':'PASS','rejection':str(error)})
   else:raise AssertionError('Expected preflight rejection')
 argv=['runner','--baseline',old,'--round1',old,'--candidate',candidate,'--matrix',candidate,'--output',temp,'--build-manifest',str(manifest_path)]
 ns={}
 with patch.object(sys,'argv',argv):exec(compile(runner,'runner','exec'),ns)
 # Only exercise metadata labelling; no audio binary or benchmark is executed.
 stub=json.dumps(dict(p99Ns=1,maxNs=1,meanNs=1,budgetNs=100,cpuBudgetExceedances=0)).encode()
 with patch('subprocess.check_output',return_value=stub):
  assert ns['run'](old,[])['buildBindingVerified'] is False
  assert ns['run'](candidate,[])['buildBindingVerified'] is True
 results.append({'case':'unverified round1 remains false; verified candidate true','status':'PASS','scope':'Stub callback payload for metadata only, not performance evidence'})
print(json.dumps(results,indent=2))
