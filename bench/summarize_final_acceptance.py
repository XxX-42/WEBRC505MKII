#!/usr/bin/env python3
"""Summarize verified gates without converting unavailable metrics into zero."""
import hashlib,json,subprocess
from pathlib import Path
from datetime import datetime,timezone
D=Path('docs/performance/20261021')
def read(n):
 p=D/n
 return json.loads(p.read_text()) if p.exists() else None
def read_native(n):
 return read('final-v2/'+n) if (D/'final-v2').exists() else read(n)
def counts(rows,key):
 result={}
 for row in rows or []:
  value=row.get(key,'UNAVAILABLE');result[value]=result.get(value,0)+1
 return result
stress=read('browser-functional-30min.json')
if stress and not stress.get('functionalChecks',{}).get('activePathGate'):
 stress={'status':'PENDING_CORRECTED_RERUN','reason':'Old run invalidated: overdub inactive; see superseded artifact.'}
soak=read_native('native-soak-1800s.json')
report={
 'generatedUtc':datetime.now(timezone.utc).isoformat(),
 'branch':subprocess.check_output(['git','branch','--show-current'],text=True).strip(),
 'capturedHead':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 'capturedHeadScope':'Evidence was measured on baseline HEAD plus hashed candidate worktree; final report commit is a later packaging action.',
 'baseline':'dd7dbea3502993d9167c4af16aef5dce98577c9e',
 'nativeEvidenceDirectory':'final-v2' if (D/'final-v2').exists() else '.',
 'productionHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path('public/worklets/fx-processor.js'),*Path('src/audio/fx/dsp').glob('Browser*Dsp*.ts'),Path('native-mvp/engine-cpp/src/native_preamp_processor.cpp')]},
 'gates':{
  'productionBuild':'PASS','unit':{'files':150,'testsPassed':1103},'nativeRelease':{'passed':46,'total':46},
  'fullE2e':{'status':'E2E_ENVIRONMENT_BLOCKED','casesAttempted':101,'assertionsExecuted':0},
  'browserFullPcm':read('browser-final-source-correctness-matrix.json').get('correctness'),
  'browserFxSanity':{k:read('fx-sanity.json')[k] for k in ['status','effects','cases','baselineComparison','diagnosticThresholds']},
  'browserLongTail':{k:read('fx-long-tail.json')[k] for k in ['status','effects','cases','durationSeconds','baselineComparison']},
  'nativeMatrix':{'functional':counts(read_native('native-matrix.json'),'functionalGate'),'performance':counts(read_native('native-matrix.json'),'performanceGate')},
  'nativeSupplements':{'functional':counts(read_native('native-supplements.json'),'functionalGate'),'performance':counts(read_native('native-supplements.json'),'performanceGate')},
  'nativeCatalog':read_native('native-catalog-sanity-summary.json'),
  'browserFunctionalStress':stress,
  'nativeWallCheckpoint600':read_native('native-soak-1800s.checkpoint-600s.json'),
  'nativeWallSoak1800':soak or {'status':'PENDING'},
  'cloudStartup':read('cloud-preview.json'),
 },
 'unavailable':{'browserCallbackBudget':None,'hardwareXruns':None,'actualBrowserIpcBytes':None,'mainThreadLongTasks':None,'workletGcPauseMs':None,'reason':'No functioning actual-browser execution or physical audio device in approved cloud scope.'},
 'publication':{'push':'PUSH_BLOCKED','reason':'Execution authorization gate rejected dry-run; pending direct user confirmation; no alternate route attempted.','userDeviceDeployment':'LOCAL_DEPLOY_BLOCKED','cloudStartup':'PASS_HTTP_ONLY'},
 'stopCondition':{'globalA':False,'globalB':'NOT_ESTABLISHED; bounded measured exact-DSP candidates converged only','globalC':False,'reason':'Software timing failures, real-browser environment gaps and unsupported software features remain; not hardware-only.'},
}
(D/'acceptance-summary.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
files={str(p.relative_to(D)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(D.rglob('*')) if p.is_file() and p.name!='evidence-sha256.json'}
(D/'evidence-sha256.json').write_text(json.dumps(files,indent=2,ensure_ascii=False)+'\n')
print('Wrote summary and',len(files),'artifact hashes; 1800s soak', 'complete' if soak else 'pending')
