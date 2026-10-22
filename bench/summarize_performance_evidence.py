#!/usr/bin/env python3
"""Summarize recorded evidence only. Never infer hardware or browser PASS."""
import json, statistics, datetime
from pathlib import Path
D=Path('docs/performance/20261021')
rows=[]
for name in ['browser-bypass-isolated-abba','browser-preamp-primitive-abba','browser-preamp-bias-abba','browser-distortion-primitive-abba','browser-distortion-fuzz-constant-abba','browser-preamp-frame-abba','browser-clamp-abba','browser-clamp-phaser-confirmation','browser-delay-clamp-abba','browser-tape-clamp-abba','browser-tape-primitive-abba']:
 p=D/(name+'.json')
 if not p.exists():continue
 data=json.loads(p.read_text())
 for s in data.get('scenarios',[]):
  if name=='browser-delay-clamp-abba' and s['algorithm']=='tape-echo':
   continue  # Unchanged negative control: retained in raw JSON, not an optimization row.
  rows.append(dict(scenario=f"{name}: {s['rate']}Hz/{s['channels']}ch/{s['tracks']} FX instances/{s['algorithm']}/model{s.get('preampModel','n/a')}/dist{s.get('distortionMode','n/a')}",unit=f"ms per {data['blocks']} synchronous VM blocks",baseline=s['baselineMs'],optimized=s['candidateMs'],improvementPercent=s['improvementPercent'],p99=None,max=None,memory=None,drops=None,xruns=None,reason='Kernel batch A/B only; no real browser callback, IPC or hardware instrumentation.',bitExact=s['bitExact'],source=name+'.json',sourceHashes=data.get('sourceHashes')))
p=D/'browser-quantum-distributions.json'
if p.exists():
 data=json.loads(p.read_text())
 if data.get('completed'):
  for case in data['scenarios']:
   a,b=case['distributions']['baseline'],case['distributions']['candidate']
   rows.append(dict(scenario=f"Final combined VM: {case['rate']}Hz/{case['channels']}ch/{case['tracks']} FX instances/{case['algorithm']}",unit='mean ms per synchronous Node VM quantum, NOT actual browser callback',baseline=a['meanMs'],optimized=b['meanMs'],improvementPercent=(a['meanMs']-b['meanMs'])/a['meanMs']*100,p99={'baseline':a['p99Ms'],'candidate':b['p99Ms']},max={'baseline':a['maxMs'],'candidate':b['maxMs']},memory=None,drops=None,xruns=None,reason='Node per-quantum timings only; actual browser callback and per-worklet peak memory unavailable. Whole-process snapshots are in raw passes.',bitExact=None,source=p.name,sourceHashes=data['sourceHashes']))
p=(D/'final-v2/native-combined-final-abba.json') if (D/'final-v2/native-combined-final-abba.json').exists() else D/'native-combined-final-abba.json'
if p.exists():
 data=json.loads(p.read_text()); groups={v:[r for r in data['rows'] if r['variant']==v] for v in ['A','B']}
 # Each callback sample count is equal. These are arithmetic means of per-run statistics,
 # not pooled callback quantiles; raw reports retain all tail observations.
 def med(v,k):
  values=[r[k] for r in groups[v] if r.get(k) is not None]
  return statistics.mean(values) if values else None
 a,b=med('A','meanNs'),med('B','meanNs')
 rows.append(dict(scenario='Native 48kHz/64f/5 stereo tracks/heavy FX playback',unit='ns per simulated callback; mean of run means',baseline=a,optimized=b,improvementPercent=(a-b)/a*100,p99={v:med(v,'p99Ns') for v in groups},max={v:max(r['maxNs'] for r in groups[v]) for v in groups},memory={v:med(v,'peakRssKiB') for v in groups},drops=None,xruns=None,cpuDeadlineExceedances={v:sum(r['cpuBudgetExceedances'] for r in groups[v]) for v in groups},reason='Arithmetic mean of per-run p99, not pooled quantile. Maximum is worst observed across runs. CPU deadline counts are not driver XRUN. Memory is per-process peak RSS where instrumented; missing baseline fields remain null.',bitExact=len({r['hash'] for r in data['rows']})==1,source=str(p.relative_to(D))))
result={'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':rows,'notes':['Browser rows are incremental stages with different source hashes; do not add percentages or claim combined end-to-end improvement.','Null is unavailable, never zero.','Acceptance remains separate from functional correctness. See coverage-boundaries.md and final report.']}
(D/'before-after.json').write_text(json.dumps(result,indent=2)+'\n')
lines=['# Before/after evidence','', '| Scenario | Baseline | Optimized | Improvement | p99 | Max | Memory | Drops/XRUN |','|---|---:|---:|---:|---|---|---|---|']
for r in rows:
 lines.append(f"| {r['scenario']} ({r['unit']}) | {r['baseline']:.6g} | {r['optimized']:.6g} | {r['improvementPercent']:.2f}% | {r['p99'] or 'unavailable'} | {r['max'] or 'unavailable'} | {r['memory'] or 'unavailable'} | unavailable |")
lines+=['']+['- '+x for x in result['notes']]+['','Full raw records, exact source hashes, null reasons and CPU deadline counts are in before-after.json and the linked stage JSON files.']
(D/'before-after.md').write_text('\n'.join(lines)+'\n')
print(f'Wrote {len(rows)} staged evidence rows')
