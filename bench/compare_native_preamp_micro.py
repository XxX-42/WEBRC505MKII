#!/usr/bin/env python3
"""Paired PREAMP-only automation, sine and silence comparisons; no driver claim."""
import argparse,datetime,hashlib,json,os,pathlib,statistics,subprocess
p=argparse.ArgumentParser();p.add_argument('baseline');p.add_argument('candidate');p.add_argument('output');p.add_argument('--cpu',type=int);a=p.parse_args()
allowed=sorted(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else None
if a.cpu is not None and (allowed is None or a.cpu not in allowed):raise SystemExit('Requested CPU not in current allowed affinity')
rows=[]
for signal in ('automation','sine','silence'):
 for order in ('ABBA','BAAB'):
  for variant in order:
   binary=a.baseline if variant=='A' else a.candidate;started=datetime.datetime.now(datetime.timezone.utc).isoformat()
   row=json.loads(subprocess.check_output([binary,signal],preexec_fn=(lambda:os.sched_setaffinity(0,{a.cpu})) if a.cpu is not None else None))
   row.update(signal=signal,order=order,variant=variant,runStartedUtc=started,runFinishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),binarySha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest());rows.append(row)
gains={s:100*(1-statistics.mean(r['meanNs'] for r in rows if r['signal']==s and r['variant']=='B')/statistics.mean(r['meanNs'] for r in rows if r['signal']==s and r['variant']=='A')) for s in ('automation','sine','silence')}
result=dict(aggregation='Gain is ratio of arithmetic means of per-run statistics; p99 denotes mean(run p99), not pooled callback quantile',rows=rows,gainPercent=gains,allowedAffinity=allowed,requestedChildCpu=a.cpu,scope='Task-team exclusive CPU slot, not physical driver acceptance',hashesEqual=all(len({r['hash'] for r in rows if r['signal']==s})==1 for s in ('automation','sine','silence')))
pathlib.Path(a.output).write_text(json.dumps(result,indent=2)+'\n');print(gains,flush=True)
