#!/usr/bin/env python3
"""Paired Native candidate comparison on the same deterministic heavy callback workload."""
import datetime, hashlib, json, pathlib, statistics, subprocess, sys, os
before, after, destination = sys.argv[1:4]
cpu=int(sys.argv[4]) if len(sys.argv)>4 else None
allowed=sorted(os.sched_getaffinity(0))
if cpu is not None and cpu not in allowed: raise SystemExit("CPU not allowed")
rows=[]
for label in 'ABBA':
    binary=before if label=='A' else after
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    row=json.loads(subprocess.check_output([binary,'48000','64','5','1','5000','playback','2'],preexec_fn=(lambda:os.sched_setaffinity(0,{cpu})) if cpu is not None else None))
    row.update(variant=label,runStartedUtc=started,runFinishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),binarySha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest())
    rows.append(row)
metrics=['meanNs','p50Ns','p95Ns','p99Ns','maxNs']
gains={m:100*(1-statistics.mean(r[m] for r in rows if r['variant']=='B')/statistics.mean(r[m] for r in rows if r['variant']=='A')) for m in metrics}
result=dict(aggregation='Gain is ratio of arithmetic means of per-run statistics; p99 denotes mean(run p99), not pooled callback quantile',allowedAffinity=allowed,requestedChildCpu=cpu,order='ABBA',rows=rows,gainPercent=gains,pcmHashesEqual=len({r['hash'] for r in rows})==1,schedulingScope='Exclusive task-team CPU slot; shared cloud host, not hardware acceptance')
pathlib.Path(destination).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
