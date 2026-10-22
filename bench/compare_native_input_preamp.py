#!/usr/bin/env python3
"""Mono/stereo actual input-bank PREAMP callback A/B, not a kernel benchmark."""
import datetime,hashlib,json,os,pathlib,statistics,subprocess,sys
before,after,out=sys.argv[1:4];rows=[]
for channels in (1,2):
 for order in ('ABBA','BAAB'):
  for label in order:
   binary=before if label=='A' else after
   start=datetime.datetime.now(datetime.timezone.utc).isoformat()
   r=json.loads(subprocess.check_output([binary,'48000','64','1','0','8000','playback',str(channels),'input-preamp-only'],preexec_fn=lambda:os.sched_setaffinity(0,{0})))
   r.update(variant=label,order=order,startedUtc=start,finishedUtc=datetime.datetime.now(datetime.timezone.utc).isoformat(),binarySha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest());rows.append(r)
gains={}
for ch in (1,2):
 gains[str(ch)]={k:100*(1-statistics.mean(r[k] for r in rows if r['inputChannels']==ch and r['variant']=='B')/statistics.mean(r[k] for r in rows if r['inputChannels']==ch and r['variant']=='A')) for k in ('meanNs','p50Ns','p95Ns','p99Ns','maxNs')}
res=dict(rows=rows,gainPercent=gains,pcmHashesEqual=all(len({r['hash'] for r in rows if r['inputChannels']==ch})==1 for ch in (1,2)),scope='CPU0 exclusive task-team window; one Input-bank PREAMP, one playing track without track FX; nonzero inputFxPeak is asserted; no physical driver',aggregation='ratio of arithmetic means of per-run statistics, not pooled callback quantiles')
pathlib.Path(out).write_text(json.dumps(res,indent=2)+'\n');print(gains)
