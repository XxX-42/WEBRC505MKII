#!/usr/bin/env python3
"""Ordered PREAMP mono/stereo micro A/B; not a device callback budget."""
import datetime,hashlib,json,os,pathlib,statistics,subprocess,sys
before,after,out=sys.argv[1:4]
rows=[]
for channels in ('mono','stereo'):
 for signal in ('automation','sine','silence'):
  for order in ('ABBA','BAAB'):
   for label in order:
    binary=before if label=='A' else after
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    row=json.loads(subprocess.check_output([binary,signal,channels],preexec_fn=lambda:os.sched_setaffinity(0,{0})))
    row.update(variant=label,channels=channels,order=order,startedUtc=started,finishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),binarySha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest());rows.append(row)
gains={}
for ch in ('mono','stereo'):
 for sig in ('automation','sine','silence'):
  rr=[r for r in rows if r['channels']==ch and r['signal']==sig]
  gains[ch+'_'+sig]=100*(1-statistics.mean(r['meanNs'] for r in rr if r['variant']=='B')/statistics.mean(r['meanNs'] for r in rr if r['variant']=='A'))
result=dict(rows=rows,gainPercent=gains,pcmHashesEqual=all(len({r['hash'] for r in rows if r['channels']==ch and r['signal']==sig})==1 for ch in ('mono','stereo') for sig in ('automation','sine','silence')),aggregation='Ratio of arithmetic mean of per-run meanNs, not p50 or pooled callback quantiles',scope='CPU0 exclusive task-team slot; shared cloud CPU, no physical audio driver claim')
pathlib.Path(out).write_text(json.dumps(result,indent=2)+'\n');print(gains)
